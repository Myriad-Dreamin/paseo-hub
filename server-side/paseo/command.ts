import { spawn, type ChildProcess } from "node:child_process";

export type MachineKind = "local" | "ssh";

export type MachineTarget = {
  id?: string;
  name?: string;
  host?: string;
  forward?: string;
  kind?: MachineKind;
  sshHost?: string;
  daemonForwardPort?: number | null;
  workspacePath?: string;
};

export type RunMachineCommandOptions = {
  cwd?: string;
  remoteCwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  forwardProxyEnv?: boolean;
  useRemoteLoginShell?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export type RunMachineCommandResult = {
  stdout: string;
  stderr: string;
  command: string;
  preview: string;
  mode: MachineKind;
  target: string;
};

const proxyEnvKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy"
];

export function isLocalMachine(machine: MachineTarget = {}) {
  if (machine.kind) {
    return machine.kind === "local";
  }

  const id = machine.id?.trim().toLowerCase();
  const name = machine.name?.trim().toLowerCase();
  const host = machine.host?.trim().toLowerCase();

  return (
    id === "localhost" ||
    name === "localhost" ||
    (!machine.sshHost && (host === "localhost" || host === "127.0.0.1" || host === "::1"))
  );
}

export function getSshTarget(machine: MachineTarget) {
  const target = (machine.sshHost || machine.host || "").trim();

  if (!target) {
    throw new Error("SSH target is missing for remote machine");
  }

  return target;
}

export function getMachineMode(machine: MachineTarget) {
  return isLocalMachine(machine) ? "local" : "ssh";
}

export function buildCommandPreview(machine: MachineTarget, command: string) {
  if (isLocalMachine(machine)) {
    return command;
  }

  return `ssh ${getSshTarget(machine)} ${JSON.stringify(command)}`;
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

function prefixProxyEnv(command: string, env: NodeJS.ProcessEnv) {
  const assignments = proxyEnvKeys
    .filter((key) => env[key])
    .map((key) => `${key}=${quotePosix(String(env[key]))}`);

  if (assignments.length === 0) {
    return command;
  }

  return `env ${assignments.join(" ")} ${command}`;
}

function buildRemoteCommandBody(command: string, options: RunMachineCommandOptions) {
  const env = options.env || process.env;
  const commandWithEnv = options.forwardProxyEnv === false ? command : prefixProxyEnv(command, env);

  if (!options.remoteCwd) {
    return commandWithEnv;
  }

  const remoteCwd = quoteRemotePath(options.remoteCwd);
  return `mkdir -p ${remoteCwd} && cd ${remoteCwd} && ${commandWithEnv}`;
}

function prefixRemotePath(command: string) {
  const pathPrelude = [
    'export PASEO_HUB_BIN="$HOME/.paseo-hub/bin"',
    'export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"',
    'export PATH="$PASEO_HUB_BIN:$PNPM_HOME:$HOME/Library/pnpm:$HOME/.local/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"'
  ].join("; ");

  return `${pathPrelude}; ${command}`;
}

function wrapRemoteLoginShell(command: string, options: RunMachineCommandOptions) {
  if (options.useRemoteLoginShell === false) {
    return command;
  }

  const quotedCommand = quotePosix(command);
  return `[ -n "$SHELL" ] && [ -x "$SHELL" ] && exec "$SHELL" -lic ${quotedCommand} || exec /bin/sh -lc ${quotedCommand}`;
}

function buildRemoteCommand(command: string, options: RunMachineCommandOptions) {
  return wrapRemoteLoginShell(prefixRemotePath(buildRemoteCommandBody(command, options)), options);
}

function killProcessTree(child: ChildProcess) {
  if (!child.pid) {
    child.kill();
    return;
  }

  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }

  const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true
  });

  killer.on("error", () => {
    child.kill();
  });
}

export function runMachineCommand(
  machine: MachineTarget,
  command: string,
  options: RunMachineCommandOptions = {}
): Promise<RunMachineCommandResult> {
  return new Promise((resolve, reject) => {
    const mode = getMachineMode(machine);
    const target = mode === "local" ? "localhost" : getSshTarget(machine);
    const remoteCommand = mode === "local" ? command : buildRemoteCommand(command, options);
    const preview = mode === "local" ? command : buildCommandPreview(machine, buildRemoteCommandBody(command, options));
    const child =
      mode === "local"
        ? spawn(command, {
            cwd: options.cwd,
            env: options.env || process.env,
            shell: true,
            windowsHide: true
          })
        : spawn("ssh", [target, remoteCommand], {
            cwd: options.cwd,
            env: options.env || process.env,
            shell: false,
            windowsHide: true
          });

    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    let timedOut = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killProcessTree(child);
        }, options.timeoutMs)
      : null;

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout.push(text);
      options.onStdout?.(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr.push(text);
      options.onStderr?.(text);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);

      const result: RunMachineCommandResult = {
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        command,
        preview,
        mode,
        target
      };

      if (code === 0 && !timedOut) {
        resolve(result);
        return;
      }

      const error = new Error(
        timedOut ? `${preview} timed out` : `${preview} failed with exit code ${code ?? "unknown"}`
      ) as Error & RunMachineCommandResult;
      Object.assign(error, result);
      reject(error);
    });
  });
}
