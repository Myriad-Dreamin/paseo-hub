import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isLocalMachine, runLocalExecutableCommand, runMachineCommand, type MachineTarget } from "./command.ts";
import {
  buildPaseoCommand,
  exists,
  getLocalPaseoWrapper,
  quoteLocalPath,
  resolveLocalPaseoInvocation
} from "./cli.ts";
import { applyLocalPaseoSourcePatches } from "./source-patches.ts";

export type DaemonState = "unknown" | "running" | "stopped" | "missing" | "error";

export type DaemonCommandResult = {
  state: DaemonState;
  command: string;
  output: string;
  ok: boolean;
};

type LocalPidInfo = {
  pid?: unknown;
  startedAt?: unknown;
  hostname?: unknown;
  listen?: unknown;
};

type LocalPaseoConfig = {
  listen?: unknown;
};

type InstallationState = {
  workspace?: unknown;
};

const defaultListen = "127.0.0.1:6767";
const restartWaitMs = 6000;
const restartPollMs = 250;

type PaseoListenTarget =
  | {
      type: "tcp";
      host: string;
      port: number;
    }
  | {
      type: "socket" | "pipe";
      path: string;
    };

type PaseoDaemon = {
  start(): Promise<void>;
  stop(): Promise<void>;
  getListenTarget(): PaseoListenTarget | null;
};

type PaseoDaemonConfig = Record<string, unknown> & {
  listen?: string;
  log?: unknown;
  onLifecycleIntent?: (intent: { type: "shutdown" | "restart"; reason?: string }) => void;
  staticDir?: string;
};

type PaseoBootstrapModule = {
  createPaseoDaemon(config: PaseoDaemonConfig, rootLogger: unknown): Promise<PaseoDaemon>;
};

type PaseoConfigModule = {
  loadConfig(paseoHome: string, options?: { env?: NodeJS.ProcessEnv }): PaseoDaemonConfig;
};

type PaseoLoggerModule = {
  createRootLogger(configInput: unknown, options?: { paseoHome?: string; file?: boolean }): unknown;
};

type LocalManagedDaemonState = {
  daemon: PaseoDaemon;
  listen: string;
  startedAt: string;
  workspace: string;
};

type GlobalWithLocalDaemon = typeof globalThis & {
  __paseoHubLocalDaemon?: LocalManagedDaemonState;
  __paseoHubLocalDaemonExitHooks?: boolean;
};

function classifyDaemonOutput(output: string, ok: boolean): DaemonState {
  const localDaemon = readStatusRow(output, "Local Daemon");
  const connectedDaemon = readStatusRow(output, "Connected Daemon");

  if (ok) {
    if (connectedDaemon === "reachable" || localDaemon === "running") {
      return "running";
    }

    if (localDaemon === "stopped" || connectedDaemon === "unreachable") {
      return "stopped";
    }

    if (localDaemon === "stale_pid" || localDaemon === "unresponsive") {
      return "error";
    }

    if (/not running|stopped|inactive|dead/i.test(output)) {
      return "stopped";
    }

    if (/running|started|listening|active|pid|6767/i.test(output)) {
      return "running";
    }

    return "running";
  }

  if (/ssh:|permission denied|could not resolve|connection timed out|no route to host|connection refused/i.test(output)) {
    return "error";
  }

  if (/not recognized|not found|cannot find|no such file|is not installed|command not found/i.test(output)) {
    return "missing";
  }

  if (/not running|stopped|inactive|dead/i.test(output)) {
    return "stopped";
  }

  if (/running|started|listening|active|pid|6767/i.test(output)) {
    return "running";
  }

  return ok ? "running" : "stopped";
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readStatusRow(output: string, key: string) {
  const match = output.match(new RegExp(`^${escapeRegex(key)}\\s{2,}([^\\r\\n]+)`, "im"));
  return match?.[1]?.trim().split(/\s+/)[0]?.toLowerCase() || "";
}

function localPaseoHome() {
  return process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function globalDaemonState() {
  return globalThis as GlobalWithLocalDaemon;
}

function getLocalManagedDaemonState() {
  return globalDaemonState().__paseoHubLocalDaemon ?? null;
}

function setLocalManagedDaemonState(state: LocalManagedDaemonState | null) {
  const globalState = globalDaemonState();

  if (state) {
    globalState.__paseoHubLocalDaemon = state;
    return;
  }

  delete globalState.__paseoHubLocalDaemon;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function normalizeListen(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : defaultListen;
}

function parseTcpListen(listen: string): { host: string; port: number } | null {
  const normalized = listen.trim();

  if (/^\d+$/u.test(normalized)) {
    return { host: "127.0.0.1", port: Number(normalized) };
  }

  const ipv6Match = normalized.match(/^\[([^\]]+)\]:(\d+)$/u);
  if (ipv6Match) {
    return { host: ipv6Match[1], port: Number(ipv6Match[2]) };
  }

  const match = normalized.match(/^([^:]+):(\d+)$/u);
  if (!match) {
    return null;
  }

  return { host: match[1], port: Number(match[2]) };
}

async function canConnectToListen(listen: string) {
  const target = parseTcpListen(listen);

  if (!target || !Number.isFinite(target.port) || target.port <= 0 || target.port > 65535) {
    return null;
  }

  return new Promise<boolean>((resolve) => {
    const socket = net.connect(target);
    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function getLocalBackendDaemonStatus(): Promise<DaemonCommandResult> {
  const home = localPaseoHome();
  const pidPath = path.join(home, "paseo.pid");
  const logPath = path.join(home, "daemon.log");
  const configPath = path.join(home, "config.json");
  const [pidInfo, config] = await Promise.all([
    readJsonFile<LocalPidInfo>(pidPath),
    readJsonFile<LocalPaseoConfig>(configPath)
  ]);
  const managed = getLocalManagedDaemonState();
  const pidFromFile = typeof pidInfo?.pid === "number" && Number.isInteger(pidInfo.pid) ? pidInfo.pid : null;
  const pid = managed ? process.pid : pidFromFile;
  const listen = normalizeListen(pidInfo?.listen || managed?.listen || config?.listen);
  const processRunning = managed !== null || (pid !== null && isProcessRunning(pid));
  const reachable = await canConnectToListen(listen);
  const localDaemon = processRunning ? "running" : pid ? "stale_pid" : "stopped";
  const connectedDaemon = reachable === null ? "not_probed" : reachable ? "reachable" : "unreachable";
  const state: DaemonState = processRunning || reachable ? "running" : "stopped";
  const startedAt = typeof pidInfo?.startedAt === "string" ? pidInfo.startedAt : managed?.startedAt || "-";
  const hostname = typeof pidInfo?.hostname === "string" ? pidInfo.hostname : os.hostname();

  return {
    state,
    command: "backend daemon status",
    output: [
      "KEY               VALUE",
      `Local Daemon      ${localDaemon}`,
      `Connected Daemon  ${connectedDaemon}`,
      `Home              ${home}`,
      `Listen            ${listen}`,
      `Hostname          ${hostname}`,
      `PID               ${pid ?? "-"}`,
      `Started           ${startedAt}`,
      `Managed           ${managed ? "backend_process" : "pid_file"}`,
      `Logs              ${logPath}`
    ].join("\n"),
    ok: true
  };
}

async function killPidTree(pid: number) {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGTERM");
    return;
  }

  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });

    killer.once("close", () => resolve());
    killer.once("error", () => {
      try {
        process.kill(pid);
      } catch {
        // The process may already be gone.
      }
      resolve();
    });
  });
}

async function removeLocalPidFile() {
  await rm(path.join(localPaseoHome(), "paseo.pid"), { force: true });
}

async function stopLocalBackendDaemon() {
  const managed = getLocalManagedDaemonState();

  if (managed) {
    setLocalManagedDaemonState(null);
    await managed.daemon.stop();
    await removeLocalPidFile();
    return { pid: process.pid, stopped: true };
  }

  const pidInfo = await readJsonFile<LocalPidInfo>(path.join(localPaseoHome(), "paseo.pid"));
  const pid = typeof pidInfo?.pid === "number" && Number.isInteger(pidInfo.pid) ? pidInfo.pid : null;

  if (!pid || !isProcessRunning(pid)) {
    if (pid) {
      await removeLocalPidFile();
    }
    return { pid, stopped: false };
  }

  if (pid === process.pid) {
    return { pid, stopped: false };
  }

  await killPidTree(pid);
  await removeLocalPidFile();

  return { pid, stopped: true };
}

async function writeLocalPidFile(pid: number, listen: string, startedAt: string) {
  if (!pid) {
    throw new Error("Paseo backend process did not expose a PID");
  }

  const home = localPaseoHome();
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, "paseo.pid"),
    JSON.stringify({
      pid,
      startedAt,
      hostname: os.hostname(),
      uid: process.getuid?.() ?? 0,
      listen,
      backendManaged: true,
      backendMode: "in-process"
    }),
    "utf8"
  );
}

async function resolveLocalPaseoWorkspace(root: string) {
  const state = await readJsonFile<InstallationState>(path.join(root, ".paseo", "installation.json"));
  const workspace = typeof state?.workspace === "string" ? state.workspace : "";
  const fallback = path.join(root, ".paseo", "source", "paseo");
  return workspace || fallback;
}

async function resolveLocalDaemonServerDir(root: string) {
  const workspace = await resolveLocalPaseoWorkspace(root);
  const serverDir = path.join(workspace, "packages", "server", "dist", "server", "server");

  if (await exists(path.join(serverDir, "bootstrap.js"))) {
    return { workspace, serverDir };
  }

  throw new Error(`Built Paseo daemon server files not found under ${workspace}. Run pnpm install:paseo first.`);
}

async function importLocalDaemonModules(serverDir: string) {
  const [bootstrap, config, logger] = await Promise.all([
    import(/* webpackIgnore: true */ pathToFileURL(path.join(serverDir, "bootstrap.js")).href) as Promise<PaseoBootstrapModule>,
    import(/* webpackIgnore: true */ pathToFileURL(path.join(serverDir, "config.js")).href) as Promise<PaseoConfigModule>,
    import(/* webpackIgnore: true */ pathToFileURL(path.join(serverDir, "logger.js")).href) as Promise<PaseoLoggerModule>
  ]);

  return { bootstrap, config, logger };
}

function formatPaseoListenTarget(listenTarget: PaseoListenTarget | null) {
  if (!listenTarget) {
    return "";
  }

  if (listenTarget.type === "tcp") {
    return `${listenTarget.host}:${listenTarget.port}`;
  }

  return listenTarget.path;
}

function daemonLogConfig(configLog: unknown) {
  const base = typeof configLog === "object" && configLog !== null ? (configLog as Record<string, unknown>) : {};

  return {
    log: {
      ...base,
      file:
        typeof base.file === "object" && base.file !== null
          ? base.file
          : {
              level: "info",
              path: "daemon.log"
            }
    }
  };
}

function installLocalDaemonExitHooks() {
  const globalState = globalDaemonState();

  if (globalState.__paseoHubLocalDaemonExitHooks) {
    return;
  }

  globalState.__paseoHubLocalDaemonExitHooks = true;

  const stop = () => {
    const managed = getLocalManagedDaemonState();

    if (!managed) {
      return;
    }

    setLocalManagedDaemonState(null);
    void managed.daemon.stop().catch(() => undefined);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("exit", () => {
    setLocalManagedDaemonState(null);
  });
}

async function startLocalInProcessDaemon(workspace: string, serverDir: string) {
  const modules = await importLocalDaemonModules(serverDir);
  const paseoHome = localPaseoHome();
  const config = modules.config.loadConfig(paseoHome, {
    env: {
      ...process.env,
      PASEO_HOME: paseoHome
    }
  });

  config.staticDir = path.join(workspace, "public");
  config.onLifecycleIntent = (intent) => {
    if (intent.type === "shutdown") {
      void stopLocalBackendDaemon().catch(() => undefined);
      return;
    }

    void restartLocalBackendDaemon().catch(() => undefined);
  };

  const logger = modules.logger.createRootLogger(daemonLogConfig(config.log), { paseoHome });
  const daemon = await modules.bootstrap.createPaseoDaemon(config, logger);

  await daemon.start();

  const listen = normalizeListen(formatPaseoListenTarget(daemon.getListenTarget()) || config.listen);
  const startedAt = new Date().toISOString();

  setLocalManagedDaemonState({ daemon, listen, startedAt, workspace });
  installLocalDaemonExitHooks();
  await writeLocalPidFile(process.pid, listen, startedAt);

  return { listen, startedAt };
}

async function waitForLocalDaemonState() {
  const deadline = Date.now() + restartWaitMs;
  let latest = await getLocalBackendDaemonStatus();

  while (Date.now() < deadline) {
    if (latest.state === "running") {
      return latest;
    }

    await sleep(restartPollMs);
    latest = await getLocalBackendDaemonStatus();
  }

  return latest;
}

async function restartLocalBackendDaemon(): Promise<DaemonCommandResult> {
  const root = process.cwd();
  const stopped = await stopLocalBackendDaemon();
  const { workspace, serverDir } = await resolveLocalDaemonServerDir(root);
  await applyLocalPaseoSourcePatches(workspace);
  const started = await startLocalInProcessDaemon(workspace, serverDir);

  const status = await waitForLocalDaemonState();
  const transition = stopped.pid
    ? stopped.stopped
      ? `stopped PID ${stopped.pid}`
      : `reused stale PID ${stopped.pid}`
    : "no prior PID";

  return {
    state: status.state,
    command: "backend daemon restart",
    output: [
      `${transition}`,
      `started daemon in backend PID ${process.pid}`,
      `listen ${started.listen}`,
      status.output
    ].join("\n"),
    ok: status.state === "running"
  };
}

async function runPaseoCommand(machine: MachineTarget, action: "status" | "restart") {
  const root = process.cwd();
  const localWrapper = getLocalPaseoWrapper(root);
  const args = ["daemon", action];
  const primaryCommand = buildPaseoCommand(machine, `daemon ${action}`);
  const timeoutMs = action === "restart" ? 60000 : 30000;

  if (isLocalMachine(machine)) {
    const invocation = await resolveLocalPaseoInvocation(root, args);

    if (invocation) {
      return runLocalExecutableCommand(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        timeoutMs,
        forwardProxyEnv: false,
        preview: invocation.preview
      });
    }

    if (await exists(localWrapper)) {
      return runMachineCommand(machine, `${quoteLocalPath(localWrapper)} daemon ${action}`, {
        cwd: root,
        timeoutMs,
        forwardProxyEnv: false
      });
    }
  }

  try {
    return await runMachineCommand(machine, primaryCommand, {
      cwd: root,
      timeoutMs,
      forwardProxyEnv: false
    });
  } catch (error) {
    if (!isLocalMachine(machine) || !(await exists(localWrapper))) {
      throw error;
    }

    return runMachineCommand(machine, `${quoteLocalPath(localWrapper)} daemon ${action}`, {
      cwd: root,
      timeoutMs,
      forwardProxyEnv: false
    });
  }
}

export async function getDaemonStatus(machine: MachineTarget): Promise<DaemonCommandResult> {
  if (isLocalMachine(machine)) {
    return getLocalBackendDaemonStatus();
  }

  try {
    const result = await runPaseoCommand(machine, "status");
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");

    return {
      state: classifyDaemonOutput(output, true),
      command: result.preview,
      output,
      ok: true
    };
  } catch (error) {
    const statusError = error as Error & { stdout?: string; stderr?: string; preview?: string };
    const output = [statusError.message, statusError.stdout, statusError.stderr].filter(Boolean).join("\n");

    return {
      state: classifyDaemonOutput(output, false),
      command: statusError.preview || "paseo daemon status",
      output,
      ok: false
    };
  }
}

export async function restartDaemon(machine: MachineTarget): Promise<DaemonCommandResult> {
  if (isLocalMachine(machine)) {
    return restartLocalBackendDaemon();
  }

  try {
    const result = await runPaseoCommand(machine, "restart");
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");

    return {
      state: classifyDaemonOutput(output, true),
      command: result.preview,
      output,
      ok: true
    };
  } catch (error) {
    const restartError = error as Error & { stdout?: string; stderr?: string; preview?: string };
    const output = [restartError.message, restartError.stdout, restartError.stderr].filter(Boolean).join("\n");

    return {
      state: classifyDaemonOutput(output, false),
      command: restartError.preview || "paseo daemon restart",
      output,
      ok: false
    };
  }
}
