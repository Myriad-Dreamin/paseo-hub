import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { isLocalMachine, getSshTarget, type MachineTarget } from "./command.ts";

export type SshForwardState = "off" | "starting" | "running" | "retrying" | "stopped" | "error";

export type SshForwardStatus = {
  state: SshForwardState;
  command: string;
  output: string;
  ok: boolean;
  localPort: number | null;
  remotePort: number | null;
  target: string;
  pid?: number;
  startedAt?: string;
  managed?: "hub" | "external" | "none";
  retryAttempt?: number;
  retryDelayMs?: number | null;
  nextRetryAt?: string;
};

type ForwardSpec = {
  key: string;
  machineId: string;
  target: string;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  bind: string;
  command: string;
};

type ManagedForward = ForwardSpec & {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  startedAt: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | null;
  spawnError?: Error;
};

type ForwardMonitor = {
  spec: ForwardSpec;
  retryAttempt: number;
  retryDelayMs: number | null;
  nextRetryAt?: string;
  retryTimer?: NodeJS.Timeout;
  probeTimer?: NodeJS.Timeout;
  lastStatus?: SshForwardStatus;
  stopped: boolean;
};

type GlobalWithForwards = typeof globalThis & {
  __paseoHubSshForwards?: Map<string, ManagedForward>;
  __paseoHubSshForwardMonitors?: Map<string, ForwardMonitor>;
  __paseoHubSshForwardExitHooks?: boolean;
};

const defaultRemotePort = 6767;
const startupWaitMs = 1200;
const maxLogLength = 8000;
const initialRetryDelayMs = 1000;
const maxRetryDelayMs = 60000;
const externalProbeIntervalMs = 5000;

function globalForwardState() {
  return globalThis as GlobalWithForwards;
}

function forwardMap() {
  const state = globalForwardState();

  if (!state.__paseoHubSshForwards) {
    state.__paseoHubSshForwards = new Map();
  }

  return state.__paseoHubSshForwards;
}

function monitorMap() {
  const state = globalForwardState();

  if (!state.__paseoHubSshForwardMonitors) {
    state.__paseoHubSshForwardMonitors = new Map();
  }

  return state.__paseoHubSshForwardMonitors;
}

function clearTimer(timer: NodeJS.Timeout | undefined) {
  if (timer) {
    clearTimeout(timer);
  }
}

function clearMonitorTimers(monitor: ForwardMonitor) {
  clearTimer(monitor.retryTimer);
  clearTimer(monitor.probeTimer);
  monitor.retryTimer = undefined;
  monitor.probeTimer = undefined;
}

function makeTimer(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return timer;
}

function installForwardExitHooks() {
  const state = globalForwardState();

  if (state.__paseoHubSshForwardExitHooks) {
    return;
  }

  state.__paseoHubSshForwardExitHooks = true;

  const stopAll = () => {
    for (const monitor of monitorMap().values()) {
      monitor.stopped = true;
      clearMonitorTimers(monitor);
    }

    for (const forward of forwardMap().values()) {
      forward.child.kill();
    }

    forwardMap().clear();
    monitorMap().clear();
  };

  process.once("SIGINT", stopAll);
  process.once("SIGTERM", stopAll);
  process.once("exit", stopAll);
}

function isValidPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65535;
}

function parsePort(value: unknown) {
  if (isValidPort(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const parsed = Number(value.trim());
  return isValidPort(parsed) ? parsed : null;
}

function parseForwardLocalPort(forward: unknown) {
  if (typeof forward !== "string" || !forward.trim()) {
    return null;
  }

  const normalized = forward.trim();
  const readableMatch = normalized.match(/(?:localhost|127\.0\.0\.1|\[::1\])\s*:\s*(\d+)/iu);
  const arrowMatch = normalized.match(/:(\d+)\s*->/u);
  const sshDashLMatch = normalized.match(/(?:^|\s)(\d+):[^:\s]+:\d+(?:\s|$)/u);
  const port = parsePort(readableMatch?.[1] || arrowMatch?.[1] || sshDashLMatch?.[1]);

  return port;
}

function parseForwardRemotePort(forward: unknown) {
  if (typeof forward !== "string" || !forward.trim()) {
    return null;
  }

  const normalized = forward.trim();
  const arrowMatch = normalized.match(/->[^:\s]+:(\d+)/u);
  const sshDashLMatch = normalized.match(/(?:^|\s)\d+:[^:\s]+:(\d+)(?:\s|$)/u);
  const port = parsePort(arrowMatch?.[1] || sshDashLMatch?.[1]);

  return port;
}

function configuredForwardPort(machine: MachineTarget) {
  return parsePort(machine.daemonForwardPort) || parseForwardLocalPort(machine.forward);
}

function getMachineId(machine: MachineTarget, target: string) {
  return (machine.id || machine.name || target).trim() || target;
}

function buildSshForwardSpec(machine: MachineTarget): ForwardSpec | null {
  if (isLocalMachine(machine)) {
    return null;
  }

  const localPort = configuredForwardPort(machine);

  if (!localPort) {
    return null;
  }

  const target = getSshTarget(machine);
  const machineId = getMachineId(machine, target);
  const localHost = "127.0.0.1";
  const remoteHost = "127.0.0.1";
  const remotePort = parseForwardRemotePort(machine.forward) || defaultRemotePort;
  const bind = `${localHost}:${localPort}:${remoteHost}:${remotePort}`;
  const command = `ssh -N -L ${bind} ${target}`;

  return {
    key: `${machineId}:${localPort}`,
    machineId,
    target,
    localHost,
    localPort,
    remoteHost,
    remotePort,
    bind,
    command
  };
}

function appendLog(log: string[], chunk: Buffer) {
  log.push(chunk.toString());

  while (log.join("").length > maxLogLength) {
    log.shift();
  }
}

function isForwardAlive(forward: ManagedForward) {
  return forward.spawnError === undefined && forward.exitCode === undefined && forward.exitSignal === undefined;
}

function outputForForward(forward: ManagedForward) {
  const details = [
    "KEY          VALUE",
    `State        ${isForwardAlive(forward) ? "running" : "stopped"}`,
    `Local        ${forward.localHost}:${forward.localPort}`,
    `Remote       ${forward.remoteHost}:${forward.remotePort}`,
    `SSH target   ${forward.target}`,
    `PID          ${forward.child.pid ?? "-"}`,
    `Started      ${forward.startedAt}`
  ];
  const processOutput = [forward.stdout.join("").trim(), forward.stderr.join("").trim()].filter(Boolean).join("\n");
  const exitReason = forward.exitSignal || `code ${forward.exitCode ?? "unknown"}`;
  const exit = forward.spawnError
    ? forward.spawnError.message
    : forward.exitCode !== undefined || forward.exitSignal !== undefined
      ? `ssh exited with ${exitReason}`
      : "";

  return [details.join("\n"), processOutput, exit].filter(Boolean).join("\n\n");
}

function statusFromSpec(
  spec: ForwardSpec,
  state: SshForwardState,
  output: string,
  ok: boolean,
  managed: SshForwardStatus["managed"] = "none"
): SshForwardStatus {
  return {
    state,
    command: spec.command,
    output,
    ok,
    localPort: spec.localPort,
    remotePort: spec.remotePort,
    target: spec.target,
    managed
  };
}

function decorateStatus(status: SshForwardStatus, monitor: ForwardMonitor) {
  const nextStatus = {
    ...status,
    retryAttempt: monitor.retryAttempt,
    retryDelayMs: monitor.retryDelayMs,
    nextRetryAt: monitor.nextRetryAt
  };

  monitor.lastStatus = nextStatus;
  return nextStatus;
}

function retryDelayForAttempt(attempt: number) {
  return Math.min(initialRetryDelayMs * 2 ** Math.max(0, attempt - 1), maxRetryDelayMs);
}

function resetRetryState(monitor: ForwardMonitor) {
  clearTimer(monitor.retryTimer);
  monitor.retryTimer = undefined;
  monitor.retryAttempt = 0;
  monitor.retryDelayMs = null;
  monitor.nextRetryAt = undefined;
}

function externalForwardStatus(spec: ForwardSpec, monitor?: ForwardMonitor): SshForwardStatus {
  const status = statusFromSpec(
    spec,
    "running",
    [
      "KEY          VALUE",
      "State        running",
      `Local        ${spec.localHost}:${spec.localPort}`,
      `Remote       ${spec.remoteHost}:${spec.remotePort}`,
      `SSH target   ${spec.target}`,
      "Managed      external",
      "Note         local port is already accepting connections"
    ].join("\n"),
    true,
    "external"
  );

  return monitor ? decorateStatus(status, monitor) : status;
}

function retryingStatus(spec: ForwardSpec, monitor: ForwardMonitor, reason: string): SshForwardStatus {
  return decorateStatus(
    statusFromSpec(
      spec,
      "retrying",
      [
        "KEY          VALUE",
        "State        retrying",
        `Local        ${spec.localHost}:${spec.localPort}`,
        `Remote       ${spec.remoteHost}:${spec.remotePort}`,
        `SSH target   ${spec.target}`,
        "Managed      hub",
        `Retry        ${monitor.retryAttempt}`,
        `Delay        ${monitor.retryDelayMs ?? 0}ms`,
        `Next Retry   ${monitor.nextRetryAt || "-"}`,
        `Reason       ${reason || "ssh forward is down"}`
      ].join("\n"),
      false,
      "hub"
    ),
    monitor
  );
}

function ensureMonitor(spec: ForwardSpec) {
  const map = monitorMap();
  const existing = map.get(spec.key);

  if (existing) {
    existing.spec = spec;
    existing.stopped = false;
    return existing;
  }

  const monitor: ForwardMonitor = {
    spec,
    retryAttempt: 0,
    retryDelayMs: null,
    stopped: false
  };

  map.set(spec.key, monitor);
  return monitor;
}

function statusFromManaged(forward: ManagedForward, monitor?: ForwardMonitor): SshForwardStatus {
  const running = isForwardAlive(forward);

  const status: SshForwardStatus = {
    state: running ? "running" : forward.spawnError ? "error" : "stopped",
    command: forward.command,
    output: outputForForward(forward),
    ok: running,
    localPort: forward.localPort,
    remotePort: forward.remotePort,
    target: forward.target,
    pid: forward.child.pid,
    startedAt: forward.startedAt,
    managed: "hub"
  };

  return monitor ? decorateStatus(status, monitor) : status;
}

function canConnectToLocalPort(spec: ForwardSpec) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({
      host: spec.localHost,
      port: spec.localPort
    });
    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(600);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function offStatus(machine: MachineTarget): SshForwardStatus {
  const target = isLocalMachine(machine) ? "localhost" : machine.sshHost || machine.host || "";

  return {
    state: "off",
    command: "",
    output: isLocalMachine(machine) ? "local machine does not need SSH forward" : "daemon forward is off",
    ok: true,
    localPort: null,
    remotePort: null,
    target,
    managed: "none",
    retryAttempt: 0,
    retryDelayMs: null
  };
}

function scheduleRetry(monitor: ForwardMonitor, reason: string) {
  if (monitor.stopped) {
    return monitor.lastStatus || statusFromSpec(monitor.spec, "stopped", "SSH forward is stopped", true, "none");
  }

  clearMonitorTimers(monitor);
  monitor.retryAttempt += 1;
  monitor.retryDelayMs = retryDelayForAttempt(monitor.retryAttempt);
  monitor.nextRetryAt = new Date(Date.now() + monitor.retryDelayMs).toISOString();

  const status = retryingStatus(monitor.spec, monitor, reason);
  monitor.retryTimer = makeTimer(() => {
    monitor.retryTimer = undefined;
    void attemptSshForward(monitor, { resetBackoff: false });
  }, monitor.retryDelayMs);

  return status;
}

function scheduleExternalProbe(monitor: ForwardMonitor) {
  if (monitor.stopped) {
    return;
  }

  clearTimer(monitor.probeTimer);
  monitor.probeTimer = makeTimer(() => {
    monitor.probeTimer = undefined;

    if (monitor.stopped || forwardMap().has(monitor.spec.key)) {
      return;
    }

    void canConnectToLocalPort(monitor.spec).then((reachable) => {
      if (monitor.stopped || forwardMap().has(monitor.spec.key)) {
        return;
      }

      if (reachable) {
        decorateStatus(externalForwardStatus(monitor.spec), monitor);
        scheduleExternalProbe(monitor);
        return;
      }

      scheduleRetry(monitor, "external local port probe failed");
    });
  }, externalProbeIntervalMs);
}

function waitForStartup(forward: ManagedForward) {
  return new Promise<SshForwardStatus>((resolve) => {
    let settled = false;

    const finish = (status: SshForwardStatus) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(status);
    };

    const timer = setTimeout(() => {
      finish(statusFromManaged(forward));
    }, startupWaitMs);

    forward.child.once("error", (error) => {
      forward.spawnError = error;
      finish(statusFromManaged(forward));
    });

    forward.child.once("exit", (code, signal) => {
      forward.exitCode = code;
      forward.exitSignal = signal;
      finish(statusFromManaged(forward));
    });
  });
}

async function killProcessTree(child: ChildProcess) {
  if (!child.pid) {
    child.kill();
    return;
  }

  if (process.platform !== "win32") {
    child.kill("SIGTERM");
    return;
  }

  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true
    });

    killer.once("close", () => resolve());
    killer.once("error", () => {
      child.kill();
      resolve();
    });
  });
}

async function stopManagedForward(key: string, forward: ManagedForward) {
  forwardMap().delete(key);

  if (!isForwardAlive(forward)) {
    return statusFromManaged(forward);
  }

  await killProcessTree(forward.child);
  forward.exitSignal = "SIGTERM";

  return {
    ...statusFromManaged(forward),
    state: "stopped" as const,
    ok: true
  };
}

async function stopChangedForwards(spec: ForwardSpec) {
  const map = forwardMap();
  const monitors = monitorMap();
  const stops: Promise<SshForwardStatus>[] = [];

  for (const [key, forward] of map) {
    if (forward.machineId === spec.machineId && key !== spec.key) {
      const monitor = monitors.get(key);

      if (monitor) {
        monitor.stopped = true;
        clearMonitorTimers(monitor);
        monitors.delete(key);
      }

      stops.push(stopManagedForward(key, forward));
    }
  }

  for (const [key, monitor] of monitors) {
    if (monitor.spec.machineId === spec.machineId && key !== spec.key) {
      monitor.stopped = true;
      clearMonitorTimers(monitor);
      monitors.delete(key);
    }
  }

  await Promise.all(stops);
}

function startForward(spec: ForwardSpec) {
  installForwardExitHooks();

  const args = [
    "-N",
    "-L",
    spec.bind,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    spec.target
  ];
  const child = spawn("ssh", args, {
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const forward: ManagedForward = {
    ...spec,
    child,
    stdout: [],
    stderr: [],
    startedAt: new Date().toISOString()
  };

  child.stdout?.on("data", (chunk: Buffer) => appendLog(forward.stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendLog(forward.stderr, chunk));
  child.once("error", (error) => {
    forward.spawnError = error;
  });
  child.once("exit", (code, signal) => {
    forward.exitCode = code;
    forward.exitSignal = signal;
  });
  child.once("close", () => {
    const current = forwardMap().get(spec.key);

    if (current === forward) {
      forwardMap().delete(spec.key);
      const monitor = monitorMap().get(spec.key);

      if (monitor && !monitor.stopped) {
        scheduleRetry(monitor, outputForForward(forward));
      }
    }
  });

  forwardMap().set(spec.key, forward);
  return forward;
}

async function attemptSshForward(monitor: ForwardMonitor, options: { resetBackoff: boolean }) {
  const spec = monitor.spec;
  monitor.stopped = false;

  if (options.resetBackoff) {
    resetRetryState(monitor);
  } else {
    clearTimer(monitor.retryTimer);
    monitor.retryTimer = undefined;
  }

  clearTimer(monitor.probeTimer);
  monitor.probeTimer = undefined;

  const existing = forwardMap().get(spec.key);

  if (existing && isForwardAlive(existing)) {
    resetRetryState(monitor);
    return statusFromManaged(existing, monitor);
  }

  if (existing) {
    forwardMap().delete(spec.key);
  }

  if (await canConnectToLocalPort(spec)) {
    resetRetryState(monitor);
    const status = externalForwardStatus(spec, monitor);
    scheduleExternalProbe(monitor);
    return status;
  }

  decorateStatus(statusFromSpec(spec, "starting", "starting SSH forward", false, "hub"), monitor);

  try {
    const forward = startForward(spec);
    const startupStatus = await waitForStartup(forward);

    if (startupStatus.state === "running") {
      resetRetryState(monitor);
      return statusFromManaged(forward, monitor);
    }

    forwardMap().delete(spec.key);
    return scheduleRetry(monitor, startupStatus.output || "ssh forward exited during startup");
  } catch (error) {
    forwardMap().delete(spec.key);
    return scheduleRetry(monitor, error instanceof Error ? error.message : "Failed to start SSH forward");
  }
}

export async function ensureSshForward(machine: MachineTarget): Promise<SshForwardStatus> {
  const spec = buildSshForwardSpec(machine);

  if (!spec) {
    return offStatus(machine);
  }

  await stopChangedForwards(spec);
  const monitor = ensureMonitor(spec);

  const existing = forwardMap().get(spec.key);

  if (existing && isForwardAlive(existing)) {
    return statusFromManaged(existing, monitor);
  }

  if (monitor.retryTimer && monitor.lastStatus) {
    return decorateStatus(monitor.lastStatus, monitor);
  }

  if (existing) {
    forwardMap().delete(spec.key);
  }

  return attemptSshForward(monitor, { resetBackoff: false });
}

export async function retrySshForward(machine: MachineTarget): Promise<SshForwardStatus> {
  const spec = buildSshForwardSpec(machine);

  if (!spec) {
    return offStatus(machine);
  }

  await stopChangedForwards(spec);
  const monitor = ensureMonitor(spec);
  return attemptSshForward(monitor, { resetBackoff: true });
}

export async function getSshForwardStatus(machine: MachineTarget): Promise<SshForwardStatus> {
  const spec = buildSshForwardSpec(machine);

  if (!spec) {
    return offStatus(machine);
  }

  const monitor = monitorMap().get(spec.key);
  const existing = forwardMap().get(spec.key);

  if (existing) {
    return statusFromManaged(existing, monitor);
  }

  if (monitor?.retryTimer && monitor.lastStatus) {
    return decorateStatus(monitor.lastStatus, monitor);
  }

  if (await canConnectToLocalPort(spec)) {
    if (monitor) {
      const status = externalForwardStatus(spec, monitor);
      scheduleExternalProbe(monitor);
      return status;
    }

    return externalForwardStatus(spec);
  }

  if (monitor && !monitor.stopped) {
    return scheduleRetry(monitor, "SSH forward is configured but not running");
  }

  return statusFromSpec(spec, "stopped", "SSH forward is configured but not running", false, "none");
}

export async function stopSshForward(machine: MachineTarget): Promise<SshForwardStatus> {
  const spec = buildSshForwardSpec(machine);

  if (!spec) {
    return offStatus(machine);
  }

  const map = forwardMap();
  const monitors = monitorMap();
  const monitor = monitors.get(spec.key);
  const existing = map.get(spec.key);

  if (monitor) {
    monitor.stopped = true;
    clearMonitorTimers(monitor);
    monitors.delete(spec.key);
  }

  if (!existing) {
    if (await canConnectToLocalPort(spec)) {
      return statusFromSpec(
        spec,
        "running",
        "Local port is still listening, but it was not started by Paseo Hub.",
        false,
        "external"
      );
    }

    return statusFromSpec(spec, "stopped", "SSH forward is already stopped", true, "none");
  }

  return stopManagedForward(spec.key, existing);
}
