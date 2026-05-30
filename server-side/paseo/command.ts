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
  preview?: string;
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
  const exportStatements = proxyEnvKeys
    .filter((key) => env[key])
    .map((key) => `export ${key}=${quotePosix(String(env[key]))}`);

  if (exportStatements.length === 0) {
    return command;
  }

  return `${exportStatements.join("; ")}; ${command}`;
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

function prefixRemoteEnvironment(command: string) {
  const environmentPrelude = [
    'export PASEO_HUB_BIN="$HOME/.paseo-hub/bin"',
    'export PNPM_HOME="${PNPM_HOME:-$HOME/.local/share/pnpm}"',
    'if [ -n "${ZSH_VERSION:-}" ]; then unsetopt nomatch 2>/dev/null || true; fi',
    'paseo_prepend_path() { [ -d "$1" ] || return 0; case ":$PATH:" in *":$1:"*) return 0 ;; *) PATH="$1:$PATH" ;; esac; }',
    [
      'paseo_add_required_paths() {',
      'for paseo_bin_dir in "$PASEO_HUB_BIN"; do',
      'paseo_prepend_path "$paseo_bin_dir";',
      'done;',
      '}'
    ].join(" "),
    [
      'paseo_add_tool_fallback_paths() {',
      'for paseo_bin_dir in "$PNPM_HOME" "$HOME/Library/pnpm" "$HOME/.local/bin" "$HOME/bin" "$HOME/.volta/bin" "$HOME/.asdf/shims" "$HOME/.mise/shims" "$HOME/.local/share/mise/shims" "$HOME/.nodenv/shims" "$HOME/.npm-global/bin" "$HOME/.npm-packages/bin" /opt/homebrew/bin /usr/local/bin; do',
      'paseo_prepend_path "$paseo_bin_dir";',
      'done;',
      'for paseo_bin_dir in "$HOME/.nvm/versions/node"/*/bin "$HOME/.fnm/node-versions"/*/installation/bin "$HOME/.local/share/fnm/node-versions"/*/installation/bin /opt/node/*/bin /opt/node/node-*/bin; do',
      'paseo_prepend_path "$paseo_bin_dir";',
      'done;',
      '}'
    ].join(" "),
    [
      'paseo_import_interactive_env() {',
      '[ -n "${SHELL:-}" ] && [ -x "$SHELL" ] || return 0;',
      'paseo_env_file="${TMPDIR:-/tmp}/paseo-hub-env.$$";',
      '("$SHELL" -lic \'printf "%s\\n" __PASEO_ENV_BEGIN__; env; printf "%s\\n" __PASEO_ENV_END__\' > "$paseo_env_file" 2>/dev/null) &',
      'paseo_env_pid=$!;',
      'paseo_env_wait=0;',
      'while kill -0 "$paseo_env_pid" 2>/dev/null; do',
      'if [ "$paseo_env_wait" -ge 8 ]; then kill "$paseo_env_pid" 2>/dev/null || true; break; fi;',
      'sleep 1;',
      'paseo_env_wait=$((paseo_env_wait + 1));',
      'done;',
      'wait "$paseo_env_pid" 2>/dev/null || true;',
      'paseo_env_started=0;',
      'while IFS= read -r paseo_env_line; do',
      'if [ "$paseo_env_line" = "__PASEO_ENV_BEGIN__" ]; then paseo_env_started=1; continue; fi;',
      'if [ "$paseo_env_line" = "__PASEO_ENV_END__" ]; then break; fi;',
      '[ "$paseo_env_started" = 1 ] || continue;',
      'case "$paseo_env_line" in',
      'PATH=*|PNPM_HOME=*|COREPACK_HOME=*|NVM_DIR=*|FNM_DIR=*|VOLTA_HOME=*|ASDF_DIR=*|MISE_DIR=*|MISE_DATA_DIR=*|npm_config_prefix=*) export "$paseo_env_line" ;;',
      'esac;',
      'done < "$paseo_env_file";',
      'rm -f "$paseo_env_file";',
      '}'
    ].join(" "),
    'if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then paseo_import_interactive_env; fi',
    'paseo_add_required_paths',
    'if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then paseo_add_tool_fallback_paths; fi',
    'if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then pnpm() { corepack pnpm "$@"; }; fi',
    "export PATH"
  ].join("; ");

  return `${environmentPrelude}; ${command}`;
}

function wrapRemoteLoginShell(command: string, options: RunMachineCommandOptions) {
  if (options.useRemoteLoginShell === false) {
    return command;
  }

  const quotedCommand = quotePosix(command);
  return `exec /bin/sh -c ${quotedCommand}`;
}

function buildRemoteCommand(command: string, options: RunMachineCommandOptions) {
  return wrapRemoteLoginShell(prefixRemoteEnvironment(buildRemoteCommandBody(command, options)), options);
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

function collectChildProcessResult(
  child: ChildProcess,
  resultBase: Omit<RunMachineCommandResult, "stdout" | "stderr">,
  options: RunMachineCommandOptions = {}
): Promise<RunMachineCommandResult> {
  return new Promise((resolve, reject) => {
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

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout.push(text);
      options.onStdout?.(text);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
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
        ...resultBase,
        stdout: stdout.join(""),
        stderr: stderr.join("")
      };

      if (code === 0 && !timedOut) {
        resolve(result);
        return;
      }

      const error = new Error(
        timedOut ? `${result.preview} timed out` : `${result.preview} failed with exit code ${code ?? "unknown"}`
      ) as Error & RunMachineCommandResult;
      Object.assign(error, result);
      reject(error);
    });
  });
}

function previewCommand(command: string, args: string[]) {
  return [command, ...args]
    .map((part) => (/[\s"]/u.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(" ");
}

export function runLocalExecutableCommand(
  command: string,
  args: string[],
  options: RunMachineCommandOptions = {}
): Promise<RunMachineCommandResult> {
  const preview = options.preview || previewCommand(command, args);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    shell: false,
    windowsHide: true
  });

  return collectChildProcessResult(
    child,
    {
      command: preview,
      preview,
      mode: "local",
      target: "localhost"
    },
    options
  );
}

export function runMachineCommand(
  machine: MachineTarget,
  command: string,
  options: RunMachineCommandOptions = {}
): Promise<RunMachineCommandResult> {
  const mode = getMachineMode(machine);
  const target = mode === "local" ? "localhost" : getSshTarget(machine);
  const remoteCommand = mode === "local" ? command : buildRemoteCommand(command, options);
  const preview =
    options.preview || (mode === "local" ? command : buildCommandPreview(machine, buildRemoteCommandBody(command, options)));
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

  return collectChildProcessResult(
    child,
    {
      command,
      preview,
      mode,
      target
    },
    options
  );
}
