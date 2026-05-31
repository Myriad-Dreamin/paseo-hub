import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isLocalMachine,
  runLocalExecutableCommand,
  runMachineCommand,
  type MachineTarget,
  type RunMachineCommandOptions,
  type RunMachineCommandResult
} from "./command.ts";
import { exists, remotePaseoBin } from "./cli.ts";
import { resolveProxyEnv } from "./proxy.ts";
import { readPaseoHubConfig } from "./config.mjs";
import { applyLocalPaseoSourcePatches } from "./source-patches.ts";

type Machine = MachineTarget & {
  id: string;
  name: string;
  host: string;
  forward: string;
};

type LinkedCli = {
  path: string;
  output: string;
};

const root = process.cwd();
const stateDir = path.join(root, ".paseo");
const logDir = path.join(stateDir, "logs");
const binDir = path.join(stateDir, "bin");
const sourceDir = path.join(stateDir, "source");
const localGithubWorkspace = path.join(sourceDir, "paseo");
const localNpmWorkspace = path.join(stateDir, "npm");
const remoteGithubWorkspace = "$HOME/.paseo-hub/paseo";
const remoteNpmWorkspace = "$HOME/.paseo-hub/npm";
const remoteBin = remotePaseoBin;
const installedAt = new Date().toISOString();
const { config, configPath } = await readPaseoHubConfig();
const machine: Machine = {
  id: process.env.PASEO_MACHINE_ID || "localhost",
  name: process.env.PASEO_MACHINE_NAME || "localhost",
  host: process.env.PASEO_MACHINE_HOST || "127.0.0.1",
  forward: process.env.PASEO_MACHINE_FORWARD || "",
  kind: (process.env.PASEO_MACHINE_KIND as Machine["kind"]) || undefined,
  sshHost: process.env.PASEO_MACHINE_SSH_HOST || "",
  daemonForwardPort: process.env.PASEO_MACHINE_DAEMON_FORWARD_PORT
    ? Number(process.env.PASEO_MACHINE_DAEMON_FORWARD_PORT)
    : null,
  workspacePath: process.env.PASEO_MACHINE_WORKSPACE_PATH || ""
};
const proxy = resolveProxyEnv(process.env);
const commandEnv = proxy.env;
const commandTimeoutMs = Number(process.env.PASEO_INSTALL_COMMAND_TIMEOUT_MS || 1800000);
const daemonWorkspaceFilters = [
  "@getpaseo/highlight",
  "@getpaseo/relay",
  "@getpaseo/server",
  "@getpaseo/cli"
];
const daemonFilterArgs = daemonWorkspaceFilters.map((name) => `--filter ${name}`).join(" ");
const buildCommand = [
  "pnpm --filter @getpaseo/highlight build",
  "pnpm --filter @getpaseo/relay build",
  "pnpm --filter @getpaseo/server build",
  "pnpm --filter @getpaseo/cli build"
].join(" && ");
const trustedPnpmBuildPackages = [
  "@google/genai",
  "esbuild",
  "koffi",
  "lefthook",
  "node-pty",
  "onnxruntime-node",
  "protobufjs"
];
const ignoredPnpmBuildPackages = [
  "core-js",
  "dtrace-provider",
  "electron",
  "electron-winstaller",
  "sharp",
  "unrs-resolver",
  "workerd"
];
const transcript: string[] = [];

function record(stream: NodeJS.WriteStream, text: string) {
  transcript.push(text);
  stream.write(text);
}

function logLine(line = "") {
  record(process.stdout, `${line}\n`);
}

function logErrorLine(line = "") {
  record(process.stderr, `${line}\n`);
}

function formatElapsed(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;

  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function tail(value: string, limit = 4000) {
  return value.length > limit ? value.slice(-limit) : value;
}

function quoteLocalArg(value: string) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function quotePosix(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteRemotePath(value: string) {
  if (value.startsWith("$HOME/") || value === "$HOME") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }

  return quotePosix(value);
}

function isLoopbackProxyUrl(value: string | undefined) {
  if (!value) {
    return false;
  }

  try {
    const { hostname } = new URL(value);
    const normalized = hostname.toLowerCase();
    return normalized === "localhost" || normalized.startsWith("127.") || normalized === "::1" || normalized === "[::1]";
  } catch {
    return false;
  }
}

function shouldForwardProxyEnvToMachine() {
  if (isLocalMachine(machine) || proxy.source !== "windows-system") {
    return true;
  }

  return ![
    commandEnv.HTTP_PROXY,
    commandEnv.HTTPS_PROXY,
    commandEnv.ALL_PROXY,
    commandEnv.http_proxy,
    commandEnv.https_proxy,
    commandEnv.all_proxy
  ].some(isLoopbackProxyUrl);
}

const forwardProxyEnvToMachine = shouldForwardProxyEnvToMachine();
const proxyForwardingSummary = forwardProxyEnvToMachine
  ? "enabled"
  : "disabled for ssh: Windows system proxy resolves to local loopback";

function remoteDirname(value: string) {
  const index = value.lastIndexOf("/");
  return index > 0 ? value.slice(0, index) : ".";
}

function githubRepoUrl(repository: string) {
  const trimmed = repository.trim();

  if (/^(https?:\/\/|git@)/i.test(trimmed)) {
    return trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`;
  }

  return `https://github.com/${trimmed.replace(/\.git$/i, "")}.git`;
}

function commandErrorDetails(error: unknown) {
  const commandError = error as Error & Partial<RunMachineCommandResult>;
  const lines = [commandError.message];

  if (commandError.preview) {
    lines.push(`command: ${commandError.preview}`);
  }

  if (commandError.stdout) {
    lines.push("stdout tail:");
    lines.push(tail(commandError.stdout).trimEnd());
  }

  if (commandError.stderr) {
    lines.push("stderr tail:");
    lines.push(tail(commandError.stderr).trimEnd());
  }

  return lines.filter(Boolean).join("\n");
}

function workspaceForCurrentMachine() {
  if (config.paseo.source === "github") {
    return isLocalMachine(machine) ? localGithubWorkspace : machine.workspacePath || remoteGithubWorkspace;
  }

  return isLocalMachine(machine) ? localNpmWorkspace : machine.workspacePath || remoteNpmWorkspace;
}

async function runStep(
  label: string,
  command: string,
  options: RunMachineCommandOptions = {}
): Promise<RunMachineCommandResult> {
  logLine();
  logLine(`## ${label}`);
  logLine(`$ ${command}`);

  const startedAt = Date.now();
  let lastOutputAt = startedAt;
  const heartbeat = setInterval(() => {
    if (Date.now() - lastOutputAt >= 30000) {
      logLine(`[${label}] still running (${formatElapsed(Date.now() - startedAt)})`);
    }
  }, 30000);
  heartbeat.unref?.();

  try {
    const result = await runMachineCommand(machine, command, {
      cwd: options.cwd || root,
      remoteCwd: options.remoteCwd,
      env: commandEnv,
      timeoutMs: options.timeoutMs || commandTimeoutMs,
      forwardProxyEnv: options.forwardProxyEnv ?? forwardProxyEnvToMachine,
      onStdout: (chunk) => {
        lastOutputAt = Date.now();
        record(process.stdout, chunk);
        options.onStdout?.(chunk);
      },
      onStderr: (chunk) => {
        lastOutputAt = Date.now();
        record(process.stderr, chunk);
        options.onStderr?.(chunk);
      }
    });

    logLine();
    logLine(`# ${label} passed`);
    return result;
  } catch (error) {
    logErrorLine();
    logErrorLine(`# ${label} failed`);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function tryStep(label: string, command: string, options: RunMachineCommandOptions = {}) {
  try {
    return {
      result: await runStep(label, command, options),
      error: null
    };
  } catch (error) {
    logErrorLine(commandErrorDetails(error));
    return {
      result: null,
      error
    };
  }
}

async function prepareLocalGithubSource() {
  const workspace = localGithubWorkspace;
  const gitDir = path.join(workspace, ".git");
  const repoUrl = githubRepoUrl(config.paseo.repository);
  const workspaceArg = quoteLocalArg(workspace);

  await mkdir(path.dirname(workspace), { recursive: true });

  if (await exists(gitDir)) {
    await runStep(
      "fetch Paseo source",
      `git -C ${workspaceArg} fetch --progress --depth 1 origin ${quoteLocalArg(config.paseo.ref)}`
    );
  } else if (await exists(workspace)) {
    throw new Error(`Paseo source workspace exists but is not a git repository: ${workspace}`);
  } else {
    await runStep(
      "clone Paseo source",
      `git clone --progress --depth 1 ${quoteLocalArg(repoUrl)} ${workspaceArg}`
    );
    await runStep(
      "fetch Paseo source",
      `git -C ${workspaceArg} fetch --progress --depth 1 origin ${quoteLocalArg(config.paseo.ref)}`
    );
  }

  await runStep("checkout Paseo source", `git -C ${workspaceArg} checkout --force FETCH_HEAD`);
  return workspace;
}

async function prepareRemoteGithubSource() {
  const workspace = machine.workspacePath || remoteGithubWorkspace;
  const workspacePath = quoteRemotePath(workspace);
  const parentPath = quoteRemotePath(remoteDirname(workspace));
  const repoUrl = quotePosix(githubRepoUrl(config.paseo.repository));
  const ref = quotePosix(config.paseo.ref);
  const command = [
    `if [ -e ${workspacePath} ] && [ ! -d ${workspacePath}/.git ]; then echo ${quotePosix(
      `Paseo source workspace exists but is not a git repository: ${workspace}`
    )} >&2; exit 1; fi`,
    `if [ -d ${workspacePath}/.git ]; then git -C ${workspacePath} fetch --progress --depth 1 origin ${ref}; else mkdir -p ${parentPath} && git clone --progress --depth 1 ${repoUrl} ${workspacePath} && git -C ${workspacePath} fetch --progress --depth 1 origin ${ref}; fi`,
    `git -C ${workspacePath} checkout --force FETCH_HEAD`
  ].join(" && ");

  await runStep("prepare Paseo source", command, {
    cwd: root
  });

  return workspace;
}

async function prepareGithubSource() {
  const workspace = isLocalMachine(machine) ? await prepareLocalGithubSource() : await prepareRemoteGithubSource();

  if (isLocalMachine(machine)) {
    await ensureLocalPnpmWorkspace(workspace);
  } else {
    await ensureRemotePnpmWorkspace(workspace);
  }

  return workspace;
}

function getPackageWorkspaces(pkg: { workspaces?: string[] | { packages?: string[] } }) {
  if (Array.isArray(pkg.workspaces)) {
    return pkg.workspaces;
  }

  if (pkg.workspaces && Array.isArray(pkg.workspaces.packages)) {
    return pkg.workspaces.packages;
  }

  return [];
}

function pnpmWorkspaceYaml(workspaces: string[]) {
  return [
    "packages:",
    ...workspaces.map((item) => `  - ${JSON.stringify(item)}`),
    "",
    "allowBuilds:",
    ...trustedPnpmBuildPackages.map((name) => `  ${JSON.stringify(name)}: true`),
    ...ignoredPnpmBuildPackages.map((name) => `  ${JSON.stringify(name)}: false`)
  ].join("\n") + "\n";
}

async function ensureLocalPnpmWorkspace(workspace: string) {
  const packageJsonPath = path.join(workspace, "package.json");
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    workspaces?: string[] | { packages?: string[] };
  };
  const workspaces = getPackageWorkspaces(pkg);

  if (workspaces.length === 0) {
    return;
  }

  const workspaceFile = path.join(workspace, "pnpm-workspace.yaml");
  await writeFile(workspaceFile, pnpmWorkspaceYaml(workspaces), "utf8");
  logLine(`workspace-file: ${workspaceFile}`);
  logLine(`trusted-builds: ${trustedPnpmBuildPackages.join(", ")}`);
  logLine(`ignored-builds: ${ignoredPnpmBuildPackages.join(", ")}`);
}

async function ensureRemotePnpmWorkspace(workspace: string) {
  const script = [
    "const fs=require('node:fs')",
    "const pkg=JSON.parse(fs.readFileSync('package.json','utf8'))",
    "const ws=Array.isArray(pkg.workspaces)?pkg.workspaces:((pkg.workspaces&&Array.isArray(pkg.workspaces.packages))?pkg.workspaces.packages:[])",
    `const trusted=${JSON.stringify(trustedPnpmBuildPackages)}`,
    `const ignored=${JSON.stringify(ignoredPnpmBuildPackages)}`,
    "if(ws.length){const lines=['packages:',...ws.map((item)=>'  - '+JSON.stringify(item)),'','allowBuilds:',...trusted.map((name)=>'  '+JSON.stringify(name)+': true'),...ignored.map((name)=>'  '+JSON.stringify(name)+': false')];fs.writeFileSync('pnpm-workspace.yaml',lines.join('\\n')+'\\n');console.log('wrote pnpm-workspace.yaml ('+ws.length+' packages, '+trusted.length+' trusted builds, '+ignored.length+' ignored builds)')}"
  ].join(";");

  await runStep("write pnpm workspace file", `node -e ${quotePosix(script)}`, {
    cwd: root,
    remoteCwd: workspace,
    timeoutMs: 60000,
    forwardProxyEnv: false
  });
}

async function prepareLocalNpmWorkspace() {
  await mkdir(localNpmWorkspace, { recursive: true });
  await writeFile(
    path.join(localNpmWorkspace, "package.json"),
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    "utf8"
  );
  return localNpmWorkspace;
}

async function prepareRemoteNpmWorkspace() {
  const workspace = machine.workspacePath || remoteNpmWorkspace;
  const workspacePath = quoteRemotePath(workspace);
  const packageJson = quotePosix(JSON.stringify({ private: true, type: "module" }, null, 2));
  const command = `mkdir -p ${workspacePath} && cd ${workspacePath} && printf '%s\\n' ${packageJson} > package.json`;

  await runStep("prepare npm workspace", command, {
    cwd: root,
    forwardProxyEnv: false
  });

  return workspace;
}

async function prepareNpmWorkspace() {
  return isLocalMachine(machine) ? prepareLocalNpmWorkspace() : prepareRemoteNpmWorkspace();
}

async function ensureRemotePrerequisites() {
  if (isLocalMachine(machine)) {
    return;
  }

  const requiredCommands = config.paseo.source === "github" ? ["git", "node", "pnpm"] : ["node", "pnpm"];
  const checks = requiredCommands.map(
    (command) => `command -v ${command} >/dev/null 2>&1 || missing="$missing ${command}"`
  );
  const versions = requiredCommands.map((command) => `${command} --version`);
  const command = [
    'missing=""',
    ...checks,
    'if [ -n "$missing" ]; then echo "missing remote command(s):$missing" >&2; echo "Install Node.js and pnpm on the remote machine, or make them available in the non-interactive SSH PATH." >&2; exit 127; fi',
    ...versions
  ].join("; ");

  await runStep("check remote toolchain", command, {
    cwd: root,
    timeoutMs: 30000,
    forwardProxyEnv: false
  });
}

function nodeModulesPackagePath(workspace: string, packageName: string) {
  return path.join(workspace, "node_modules", ...packageName.split("/"));
}

function localCliLinkWorkspace(workspace: string) {
  return config.paseo.source === "github"
    ? path.join(workspace, "packages", "cli")
    : nodeModulesPackagePath(workspace, config.paseo.packageName);
}

function remoteCliLinkWorkspace(workspace: string) {
  const suffix =
    config.paseo.source === "github"
      ? "packages/cli"
      : `node_modules/${config.paseo.packageName}`;

  return `${workspace.replace(/\/$/u, "")}/${suffix}`;
}

function localLinkedCliPath() {
  return path.join(binDir, process.platform === "win32" ? "paseo.cmd" : "paseo");
}

function localPnpmLinkCommand(linkWorkspace: string) {
  const pnpmHome = path.join(stateDir, "pnpm");

  if (process.platform === "win32") {
    return [
      `set "PNPM_HOME=${pnpmHome}"`,
      `set "PATH=${binDir};%PATH%"`,
      `pnpm link --global ${quoteLocalArg(linkWorkspace)} --config.global-bin-dir=${quoteLocalArg(binDir)}`
    ].join(" && ");
  }

  return [
    `export PNPM_HOME=${quotePosix(pnpmHome)}`,
    `export PATH=${quotePosix(binDir)}":$PATH"`,
    `pnpm link --global ${quotePosix(linkWorkspace)} --config.global-bin-dir=${quotePosix(binDir)}`
  ].join(" && ");
}

async function linkLocalPaseoCli(workspace: string): Promise<LinkedCli> {
  const linkWorkspace = localCliLinkWorkspace(workspace);
  const result = await runStep("link Paseo CLI", localPnpmLinkCommand(linkWorkspace), {
    cwd: root,
    timeoutMs: 60000,
    forwardProxyEnv: false
  });

  return {
    path: localLinkedCliPath(),
    output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
  };
}

async function linkRemotePaseoCli(workspace: string): Promise<LinkedCli> {
  const linkWorkspace = quoteRemotePath(remoteCliLinkWorkspace(workspace));
  const command = [
    'export PASEO_HUB_BIN="$HOME/.paseo-hub/bin"',
    'export PNPM_HOME="$HOME/.paseo-hub/pnpm"',
    'mkdir -p "$PASEO_HUB_BIN" "$PNPM_HOME"',
    'export PATH="$PASEO_HUB_BIN:$PATH"',
    'PASEO_PNPM_LINK_YES=""',
    'if pnpm help link | grep -q -- "--yes"; then PASEO_PNPM_LINK_YES="--yes"; fi',
    `pnpm link --global ${linkWorkspace} $PASEO_PNPM_LINK_YES --config.global-bin-dir="$PASEO_HUB_BIN"`
  ].join(" && ");

  const result = await runStep("link Paseo CLI", command, {
    cwd: root,
    timeoutMs: 60000,
    forwardProxyEnv: false
  });

  return {
    path: remoteBin,
    output: [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n")
  };
}

async function linkPaseoCli(workspace: string): Promise<LinkedCli> {
  if (isLocalMachine(machine)) {
    return linkLocalPaseoCli(workspace);
  }

  return linkRemotePaseoCli(workspace);
}

async function checkDaemonStatus(linkedCli: LinkedCli, workspace: string) {
  const localCliEntry =
    isLocalMachine(machine) && config.paseo.source === "github"
      ? path.join(workspace, "packages", "cli", "bin", "paseo")
      : "";
  const useLocalCliEntry = Boolean(localCliEntry && (await exists(localCliEntry)));
  const command =
    useLocalCliEntry
      ? `${quoteLocalArg(localCliEntry)} daemon status`
      : isLocalMachine(machine)
        ? `${quoteLocalArg(linkedCli.path)} daemon status`
        : `${quoteRemotePath(linkedCli.path)} daemon status`;

  logLine();
  logLine("## check daemon status");
  logLine(`$ ${command}`);

  try {
    const runOptions = {
      cwd: useLocalCliEntry ? workspace : root,
      env: commandEnv,
      timeoutMs: 10000,
      forwardProxyEnv: false,
      preview: command,
      onStdout: (chunk: string) => record(process.stdout, chunk),
      onStderr: (chunk: string) => record(process.stderr, chunk)
    };
    const result = useLocalCliEntry
      ? await runLocalExecutableCommand(
          process.execPath,
          ["--disable-warning=DEP0040", localCliEntry, "daemon", "status"],
          runOptions
        )
      : await runMachineCommand(machine, command, runOptions);

    logLine();
    logLine("# check daemon status passed");
    return {
      result,
      error: null
    };
  } catch (error) {
    return {
      result: null,
      error
    };
  }
}

async function writeTranscriptLog(extraLines: string[] = []) {
  await mkdir(logDir, { recursive: true });
  await writeFile(
    path.join(logDir, "install.log"),
    `${transcript.join("")}${extraLines.length > 0 ? `${extraLines.join("\n")}\n` : ""}`,
    "utf8"
  );
}

async function main() {
  await mkdir(logDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const workspace = workspaceForCurrentMachine();
  const target = isLocalMachine(machine) ? "localhost" : machine.sshHost || machine.host;
  const installCommand =
    config.paseo.source === "github"
      ? `pnpm install ${daemonFilterArgs} --link-workspace-packages=true`
      : `pnpm add ${config.paseo.packageName}`;

  logLine("paseo install");
  logLine(`workspace: ${workspace}`);
  logLine(`config: ${configPath}`);
  logLine(`source: ${config.paseo.source}`);
  logLine(`proxy: ${proxy.source}`);
  logLine(`proxy-summary: ${proxy.summary}`);
  logLine(`proxy-forwarding: ${proxyForwardingSummary}`);
  logLine(`install-command: ${installCommand}`);
  logLine(`build-command: ${config.paseo.source === "github" ? buildCommand : "skipped for npm package source"}`);
  if (config.paseo.source === "github") {
    logLine(`repository: ${config.paseo.repository}`);
    logLine(`ref: ${config.paseo.ref}`);
  } else {
    logLine(`package: ${config.paseo.packageName}`);
  }
  logLine(`machine: ${machine.name}`);
  logLine(`command-mode: ${isLocalMachine(machine) ? "local" : "ssh"}`);
  logLine(isLocalMachine(machine) ? "connection: local" : `ssh-target: ${target}`);
  logLine(machine.daemonForwardPort ? `daemon-forward-port: ${machine.daemonForwardPort}` : "daemon-forward-port: off");
  logLine(`timeout-ms: ${commandTimeoutMs}`);

  await ensureRemotePrerequisites();

  const sourceWorkspace =
    config.paseo.source === "github" ? await prepareGithubSource() : await prepareNpmWorkspace();

  if (config.paseo.source === "github" && isLocalMachine(machine)) {
    const patchedFiles = await applyLocalPaseoSourcePatches(sourceWorkspace);

    for (const patchedFile of patchedFiles) {
      logLine(
        `${patchedFile.changed ? "patched" : "patch-current"}: ${path.relative(root, patchedFile.filePath)}`
      );
    }
  }

  const installResult =
    config.paseo.source === "github"
      ? await runStep("install dependencies", installCommand, {
          cwd: isLocalMachine(machine) ? sourceWorkspace : root,
          remoteCwd: isLocalMachine(machine) ? undefined : sourceWorkspace
        })
      : await runStep("install Paseo package", installCommand, {
          cwd: isLocalMachine(machine) ? sourceWorkspace : root,
          remoteCwd: isLocalMachine(machine) ? undefined : sourceWorkspace
        });

  const buildResult =
    config.paseo.source === "github"
      ? await runStep("build Paseo daemon", buildCommand, {
          cwd: isLocalMachine(machine) ? sourceWorkspace : root,
          remoteCwd: isLocalMachine(machine) ? undefined : sourceWorkspace
        })
      : null;

  if (!buildResult) {
    logLine();
    logLine("# build skipped: npm package source is expected to provide a prebuilt CLI");
  }

  const linkedCli = await linkPaseoCli(sourceWorkspace);
  logLine(`linked-cli: ${linkedCli.path}`);
  if (linkedCli.output) {
    logLine(linkedCli.output);
  }

  const daemonCheck = await checkDaemonStatus(linkedCli, sourceWorkspace);
  const daemonResult = daemonCheck.result
    ? [daemonCheck.result.stdout.trim(), daemonCheck.result.stderr.trim()].filter(Boolean).join("\n")
    : commandErrorDetails(daemonCheck.error);
  const daemonState = daemonCheck.result ? "checked" : "not-running";

  const state = {
    name: "paseo",
    status: "installed",
    installedAt,
    source: "server-side/paseo/install.ts",
    paseoSource: config.paseo,
    installCommand,
    buildCommand: buildResult ? buildCommand : "",
    linkedCli: linkedCli.path,
    configPath,
    proxy: {
      source: proxy.source,
      summary: proxy.summary,
      forwarding: proxyForwardingSummary
    },
    machine,
    commandMode: isLocalMachine(machine) ? "local" : "ssh",
    workspace: sourceWorkspace,
    daemonState,
    installOutputBytes: installResult.stdout.length + installResult.stderr.length,
    buildOutputBytes: buildResult ? buildResult.stdout.length + buildResult.stderr.length : 0
  };

  await writeFile(
    path.join(stateDir, "installation.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );

  logLine(`daemon-status: ${daemonState}`);
  if (daemonResult) {
    logLine(daemonResult);
  }
  logLine("created: .paseo/installation.json");
  logLine("created: .paseo/logs/install.log");
  logLine("# passed");

  await writeTranscriptLog();
}

try {
  await main();
} catch (error) {
  logErrorLine();
  logErrorLine("# failed");
  logErrorLine(commandErrorDetails(error));

  try {
    await writeTranscriptLog(["# failed", commandErrorDetails(error)]);
  } catch (logError) {
    logErrorLine("failed to write .paseo/logs/install.log");
    logErrorLine(commandErrorDetails(logError));
  }

  process.exitCode = 1;
}
