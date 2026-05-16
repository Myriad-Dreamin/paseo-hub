import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { isLocalMachine, runLocalExecutableCommand, runMachineCommand, type MachineTarget } from "./command.ts";
import {
  buildPaseoCommand,
  exists,
  getLocalPaseoWrapper,
  quoteLocalPath,
  resolveLocalPaseoInvocation
} from "./cli.ts";

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
let localManagedDaemonChild: ChildProcess | null = null;

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
  const pid = typeof pidInfo?.pid === "number" && Number.isInteger(pidInfo.pid) ? pidInfo.pid : null;
  const listen = normalizeListen(pidInfo?.listen || config?.listen);
  const processRunning = pid !== null && isProcessRunning(pid);
  const reachable = await canConnectToListen(listen);
  const localDaemon = processRunning ? "running" : pid ? "stale_pid" : "stopped";
  const connectedDaemon = reachable === null ? "not_probed" : reachable ? "reachable" : "unreachable";
  const state: DaemonState = processRunning || reachable ? "running" : "stopped";
  const startedAt = typeof pidInfo?.startedAt === "string" ? pidInfo.startedAt : "-";
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
      `Logs              ${logPath}`
    ].join("\n"),
    ok: true
  };
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

async function stopLocalBackendDaemon() {
  const pidInfo = await readJsonFile<LocalPidInfo>(path.join(localPaseoHome(), "paseo.pid"));
  const pid = typeof pidInfo?.pid === "number" && Number.isInteger(pidInfo.pid) ? pidInfo.pid : null;

  if (localManagedDaemonChild && (!pid || localManagedDaemonChild.pid === pid)) {
    killProcessTree(localManagedDaemonChild);
    localManagedDaemonChild = null;
  }

  if (!pid || !isProcessRunning(pid)) {
    return { pid, stopped: false };
  }

  if (process.platform !== "win32") {
    process.kill(pid, "SIGTERM");
    return { pid, stopped: true };
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

  return { pid, stopped: true };
}

async function writeLocalPidFile(pid: number | null, listen: string) {
  if (!pid) {
    throw new Error("Paseo daemon worker did not expose a PID");
  }

  const home = localPaseoHome();
  await mkdir(home, { recursive: true });
  await writeFile(
    path.join(home, "paseo.pid"),
    JSON.stringify({
      pid,
      startedAt: new Date().toISOString(),
      hostname: os.hostname(),
      uid: process.getuid?.() ?? 0,
      listen,
      backendManaged: true
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

async function resolveLocalDaemonWorkerEntry(root: string) {
  const workspace = await resolveLocalPaseoWorkspace(root);
  const candidates = [
    path.join(workspace, "packages", "server", "dist", "server", "server", "daemon-worker.js"),
    path.join(workspace, "packages", "server", "src", "server", "daemon-worker.ts")
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return { workspace, entry: candidate };
    }
  }

  throw new Error(`Paseo daemon worker entry not found under ${workspace}`);
}

function startHiddenLocalWorker(workspace: string, entry: string) {
  const execArgv = entry.endsWith(".ts") ? ["--import", "tsx"] : [];

  return spawn(process.execPath, [...execArgv, entry], {
    cwd: workspace,
    env: process.env,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    windowsHide: true
  });
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
  const { workspace, entry } = await resolveLocalDaemonWorkerEntry(root);
  const child = startHiddenLocalWorker(workspace, entry);

  const startup = await new Promise<{ ok: true; listen: string } | { ok: false; message: string }>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, message: "Paseo daemon worker did not report ready in time" }), 8000);

    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, message: error.message });
    });

    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        message: `Paseo daemon worker exited early with ${signal || `code ${code ?? "unknown"}`}`
      });
    });

    child.on("message", (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "paseo:ready" &&
        "listen" in message &&
        typeof message.listen === "string"
      ) {
        clearTimeout(timer);
        resolve({ ok: true, listen: message.listen });
      }
    });
  });

  if (!startup.ok) {
    killProcessTree(child);
    return {
      state: "error",
      command: "backend daemon restart",
      output: startup.message,
      ok: false
    };
  }

  await writeLocalPidFile(child.pid ?? null, startup.listen);
  localManagedDaemonChild = child;
  child.once("close", () => {
    if (localManagedDaemonChild === child) {
      localManagedDaemonChild = null;
    }
  });

  const status = await waitForLocalDaemonState();
  const transition = stopped.pid
    ? stopped.stopped
      ? `stopped PID ${stopped.pid}`
      : `reused stale PID ${stopped.pid}`
    : "no prior PID";

  return {
    state: status.state,
    command: "backend daemon restart",
    output: [`${transition}`, `started daemon PID ${child.pid ?? "unknown"}`, status.output].join("\n"),
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
