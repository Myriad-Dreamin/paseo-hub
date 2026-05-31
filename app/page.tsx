"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";

type InstallStatus = "idle" | "running" | "success" | "error";
type PaseoSource = "npm" | "github";
type MainView = "dashboard" | "machine";
type MachineKind = "local" | "ssh";
type DaemonState = "unknown" | "checking" | "running" | "stopped" | "missing" | "error";
type ForwardState = "off" | "starting" | "running" | "retrying" | "stopped" | "error";

type Machine = {
  id: string;
  name: string;
  host: string;
  kind: MachineKind;
  sshHost: string;
  forward: string;
  daemonForwardPort: number | null;
  paseoInstalled: boolean;
  workspacePath?: string;
};

type PaseoConfig = {
  paseo: {
    source: PaseoSource;
    packageName: string;
    repository: string;
    ref: string;
  };
  machines: Machine[];
};

type ConfigResponse = {
  config: PaseoConfig;
  configPath: string;
};

type InstallStreamEvent =
  | {
      type: "stdout" | "stderr";
      data: string;
    }
  | {
      type: "exit";
      ok: boolean;
      code: number | null;
      signal: string | null;
      message: string;
    }
  | {
      type: "error";
      message: string;
    };

type DaemonStatus = {
  state: DaemonState;
  command?: string;
  output?: string;
  ok?: boolean;
};

type SshForwardStatus = {
  state: ForwardState;
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

type SshHost = {
  alias: string;
  hostName: string;
  user: string;
  port: string;
  display: string;
};

type SshConfigResponse = {
  configPath: string;
  hosts: SshHost[];
  error?: string;
};

type PortSuggestionResponse = {
  start: number;
  port: number;
  occupied: number[];
  error?: string;
};

type MachineDraft = {
  name: string;
  host: string;
  sshHost: string;
  forwardDaemon: boolean;
  daemonForwardPort: string;
  paseoInstalled: boolean;
};

type ForwardDraft = {
  enabled: boolean;
  localPort: string;
};

const fallbackMachine: Machine = {
  id: "localhost",
  name: "localhost",
  host: "127.0.0.1",
  kind: "local",
  sshHost: "",
  forward: "",
  daemonForwardPort: null,
  paseoInstalled: true
};

const fallbackConfig: PaseoConfig = {
  paseo: {
    source: "npm",
    packageName: "paseo",
    repository: "Myriad-Dreamin/paseo",
    ref: "main"
  },
  machines: [fallbackMachine]
};

const emptyDraft: MachineDraft = {
  name: "",
  host: "",
  sshHost: "",
  forwardDaemon: false,
  daemonForwardPort: "",
  paseoInstalled: false
};

const emptyForwardDraft: ForwardDraft = {
  enabled: false,
  localPort: ""
};

const scriptPath = "server-side/paseo/install.ts";

type IconProps = {
  className?: string;
};

function PaseoMark({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <text
        x="1.7"
        y="17.3"
        fill="currentColor"
        fontFamily="Geist, Satoshi, 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif"
        fontSize="21.5"
        fontWeight="760"
        letterSpacing="-1.45"
      >
        p
      </text>
      <rect x="15.2" y="18.6" width="6.2" height="2" rx="1" fill="currentColor" />
    </svg>
  );
}

function MachineGlyph({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <rect x="3.25" y="4.25" width="13.5" height="10.2" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path d="M7.1 17h5.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" opacity="0.72" />
      <path d="M10 14.6V17" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.25" opacity="0.72" />
      <path d="M6.6 7.6h6.8" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.1" opacity="0.42" />
    </svg>
  );
}

function PlusGlyph({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M10 4.8v10.4M4.8 10h10.4" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.55" />
    </svg>
  );
}

function PlayGlyph({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5.2 3.6v8.8L12 8 5.2 3.6Z" fill="currentColor" />
    </svg>
  );
}

function createMachineId(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || `machine-${Date.now()}`
  );
}

function isLocalMachine(machine: Machine) {
  return machine.kind === "local" || machine.id === "localhost" || machine.name === "localhost";
}

function parseForwardLocalPort(forward: string) {
  if (!forward.trim()) {
    return null;
  }

  const readableMatch = forward.match(/(?:localhost|127\.0\.0\.1|\[::1\])\s*:\s*(\d+)/iu);
  const arrowMatch = forward.match(/:(\d+)\s*->/u);
  const sshDashLMatch = forward.match(/(?:^|\s)(\d+):[^:\s]+:\d+(?:\s|$)/u);
  const parsed = Number(readableMatch?.[1] || arrowMatch?.[1] || sshDashLMatch?.[1]);

  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

function getForwardPort(machine: Pick<Machine, "daemonForwardPort" | "forward">) {
  return typeof machine.daemonForwardPort === "number" &&
    Number.isInteger(machine.daemonForwardPort) &&
    machine.daemonForwardPort > 0 &&
    machine.daemonForwardPort <= 65535
    ? machine.daemonForwardPort
    : parseForwardLocalPort(machine.forward || "");
}

function buildMachineForward(machine: Pick<Machine, "sshHost" | "host">, localPort: number) {
  const target = machine.sshHost || machine.host;
  return `localhost:${localPort}->${target}:6767`;
}

function normalizeMachine(machine: Partial<Machine>): Machine {
  const id = machine.id || createMachineId(machine.name || "machine");
  const local =
    machine.kind === "local" ||
    id === "localhost" ||
    machine.name === "localhost" ||
    (!machine.sshHost && (machine.host === "localhost" || machine.host === "127.0.0.1"));
  const sshHost = local ? "" : machine.sshHost || machine.host || id;
  const daemonForwardPort =
    typeof machine.daemonForwardPort === "number" &&
    Number.isInteger(machine.daemonForwardPort) &&
    machine.daemonForwardPort > 0 &&
    machine.daemonForwardPort <= 65535
      ? machine.daemonForwardPort
      : parseForwardLocalPort(machine.forward || "");

  return {
    id,
    name: machine.name || id,
    host: local ? "127.0.0.1" : machine.host || sshHost || id,
    kind: local ? "local" : "ssh",
    sshHost,
    forward: local ? "" : machine.forward || (daemonForwardPort ? buildMachineForward({ sshHost, host: sshHost }, daemonForwardPort) : ""),
    daemonForwardPort: local ? null : daemonForwardPort,
    paseoInstalled: Boolean(machine.paseoInstalled),
    workspacePath: machine.workspacePath || ""
  };
}

function normalizeConfig(config: PaseoConfig): PaseoConfig {
  return {
    ...fallbackConfig,
    ...config,
    paseo: {
      ...fallbackConfig.paseo,
      ...config.paseo
    },
    machines:
      Array.isArray(config.machines) && config.machines.length > 0
        ? config.machines.map(normalizeMachine)
        : [fallbackMachine]
  };
}

function commandTarget(machine: Machine) {
  if (isLocalMachine(machine)) {
    return "local shell";
  }

  return `ssh ${machine.sshHost || machine.host}`;
}

function connectionLabel(machine: Machine) {
  if (isLocalMachine(machine)) {
    return "local";
  }

  const forwardPort = getForwardPort(machine);

  if (forwardPort) {
    return `localhost:${forwardPort} -> ${machine.sshHost || machine.host}:6767`;
  }

  return "direct ssh, no forward";
}

function forwardText(state: ForwardState) {
  if (state === "starting") return "starting";
  if (state === "running") return "running";
  if (state === "retrying") return "retrying";
  if (state === "stopped") return "stopped";
  if (state === "error") return "error";
  return "off";
}

function retryLabel(status: SshForwardStatus) {
  if (status.state !== "retrying" || !status.nextRetryAt) {
    return "";
  }

  const nextRetry = new Date(status.nextRetryAt);

  if (Number.isNaN(nextRetry.getTime())) {
    return "";
  }

  return `retry ${status.retryAttempt || 0} at ${nextRetry.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  })}`;
}

function daemonText(state: DaemonState) {
  if (state === "checking") return "checking";
  if (state === "running") return "running";
  if (state === "stopped") return "stopped";
  if (state === "missing") return "missing";
  if (state === "error") return "error";
  return "unknown";
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();

  if (!text.trim()) {
    throw new Error(`Empty response from ${response.url || "request"} (${response.status})`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    const contentType = response.headers.get("content-type") || "unknown content type";
    const excerpt = text.replace(/\s+/g, " ").trim().slice(0, 240);
    throw new Error(`Expected JSON from ${response.url || "request"} (${response.status}, ${contentType}). ${excerpt}`);
  }
}

function installState(machine: Machine) {
  return machine.paseoInstalled ? "installed" : "missing";
}

export default function Home() {
  const [config, setConfig] = useState<PaseoConfig>(fallbackConfig);
  const [configPath, setConfigPath] = useState("");
  const [activeMachineId, setActiveMachineId] = useState("localhost");
  const [mainView, setMainView] = useState<MainView>("dashboard");
  const [status, setStatus] = useState<InstallStatus>("idle");
  const [message, setMessage] = useState("");
  const [output, setOutput] = useState("");
  const [isAddingMachine, setIsAddingMachine] = useState(false);
  const [pendingMachine, setPendingMachine] = useState<Machine | null>(null);
  const [sshHosts, setSshHosts] = useState<SshHost[]>([]);
  const [sshConfigPath, setSshConfigPath] = useState("");
  const [portSuggestion, setPortSuggestion] = useState<number | null>(null);
  const [formError, setFormError] = useState("");
  const [draft, setDraft] = useState<MachineDraft>(emptyDraft);
  const [daemonStatuses, setDaemonStatuses] = useState<Record<string, DaemonStatus>>({});
  const [forwardStatuses, setForwardStatuses] = useState<Record<string, SshForwardStatus>>({});
  const [forwardDraft, setForwardDraft] = useState<ForwardDraft>(emptyForwardDraft);
  const [forwardMessage, setForwardMessage] = useState("");

  const activeMachine = useMemo(() => {
    return config.machines.find((machine) => machine.id === activeMachineId) || config.machines[0] || fallbackMachine;
  }, [activeMachineId, config.machines]);

  const command = "pnpm install:paseo";

  const sourceFlow = useMemo(() => {
    if (config.paseo.source === "github") {
      return `git clone ${config.paseo.repository}#${config.paseo.ref} -> pnpm install daemon workspaces -> pnpm build daemon -> link`;
    }

    return `pnpm add ${config.paseo.packageName} -> link`;
  }, [config.paseo]);

  const commandPreview = useMemo(() => {
    return command;
  }, []);

  const sourceLabel = useMemo(() => {
    if (config.paseo.source === "github") {
      return `${config.paseo.repository}#${config.paseo.ref}`;
    }

    return config.paseo.packageName;
  }, [config.paseo]);

  const activeDaemon = daemonStatuses[activeMachine.id] || { state: "unknown" as DaemonState };
  const activeForward = forwardStatuses[activeMachine.id] || {
    state: getForwardPort(activeMachine) ? ("stopped" as ForwardState) : ("off" as ForwardState),
    command: "",
    output: "",
    ok: false,
    localPort: getForwardPort(activeMachine),
    remotePort: getForwardPort(activeMachine) ? 6767 : null,
    target: activeMachine.sshHost || activeMachine.host,
    managed: "none",
    retryAttempt: 0,
    retryDelayMs: null
  };
  const runningDaemonCount = config.machines.filter((machine) => daemonStatuses[machine.id]?.state === "running").length;
  const runningForwardCount = config.machines.filter((machine) => forwardStatuses[machine.id]?.state === "running").length;
  const remoteMachineCount = config.machines.filter((machine) => !isLocalMachine(machine)).length;

  const statusText = useMemo(() => {
    if (status === "running") return "running";
    if (status === "success") return "passed";
    if (status === "error") return "failed";
    return activeMachine.paseoInstalled ? "ready" : "missing";
  }, [activeMachine.paseoInstalled, status]);

  useEffect(() => {
    let ignore = false;

    async function loadConfig() {
      const response = await fetch("/api/config");
      const data = (await response.json()) as ConfigResponse;
      const nextConfig = normalizeConfig(data.config);

      if (ignore) return;

      setConfig(nextConfig);
      setConfigPath(data.configPath);
      setActiveMachineId(nextConfig.machines[0]?.id || "localhost");
      setMainView("dashboard");
      ensureForwardStates(nextConfig.machines);
      refreshDaemonStates(nextConfig.machines);
    }

    loadConfig().catch((error) => {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Failed to read config");
    });

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    const forwardPort = getForwardPort(activeMachine);

    setForwardDraft({
      enabled: !isLocalMachine(activeMachine) && Boolean(forwardPort),
      localPort: forwardPort ? String(forwardPort) : ""
    });
    setForwardMessage("");
  }, [activeMachine.id, activeMachine.daemonForwardPort, activeMachine.forward]);

  useEffect(() => {
    if (mainView !== "machine" || isLocalMachine(activeMachine) || getForwardPort(activeMachine) || forwardDraft.localPort) {
      return;
    }

    let ignore = false;

    async function loadForwardPortSuggestion() {
      const response = await fetch("/api/ports/suggest?start=6767");
      const data = (await response.json()) as PortSuggestionResponse;

      if (!ignore && data.port) {
        setForwardDraft((current) => ({
          ...current,
          localPort: current.localPort || String(data.port)
        }));
      }
    }

    loadForwardPortSuggestion().catch(() => undefined);

    return () => {
      ignore = true;
    };
  }, [activeMachine, forwardDraft.localPort, mainView]);

  useEffect(() => {
    if (!isAddingMachine) {
      return;
    }

    let ignore = false;

    async function loadMachineInputs() {
      const [sshResponse, portResponse] = await Promise.all([
        fetch("/api/ssh-config"),
        fetch("/api/ports/suggest?start=6767")
      ]);
      const sshData = (await sshResponse.json()) as SshConfigResponse;
      const portData = (await portResponse.json()) as PortSuggestionResponse;

      if (ignore) return;

      setSshHosts(sshData.hosts || []);
      setSshConfigPath(sshData.configPath || "");

      if (portData.port) {
        setPortSuggestion(portData.port);
        setDraft((current) => ({
          ...current,
          daemonForwardPort: current.daemonForwardPort || String(portData.port)
        }));
      }
    }

    loadMachineInputs().catch((error) => {
      if (ignore) return;
      setFormError(error instanceof Error ? error.message : "Failed to read SSH config");
    });

    return () => {
      ignore = true;
    };
  }, [isAddingMachine]);

  useEffect(() => {
    const machinesWithForward = config.machines.filter((machine) => !isLocalMachine(machine) && getForwardPort(machine));

    if (machinesWithForward.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      machinesWithForward.forEach((machine) => {
        void requestSshForward(machine, "status");
      });
    }, 3000);

    return () => {
      window.clearInterval(timer);
    };
  }, [config.machines]);

  async function refreshDaemonStatus(machine: Machine) {
    setDaemonStatuses((current) => ({
      ...current,
      [machine.id]: {
        ...current[machine.id],
        state: "checking"
      }
    }));

    try {
      const response = await fetch("/api/daemon/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machine })
      });
      const data = await readJsonResponse<DaemonStatus>(response);

      setDaemonStatuses((current) => ({
        ...current,
        [machine.id]: {
          ...data,
          state: data.state || "unknown"
        }
      }));
    } catch (error) {
      setDaemonStatuses((current) => ({
        ...current,
        [machine.id]: {
          state: "error",
          output: error instanceof Error ? error.message : "Failed to check daemon status"
        }
      }));
    }
  }

  function refreshDaemonStates(machines: Machine[]) {
    machines.forEach((machine) => {
      void refreshDaemonStatus(machine);
    });
  }

  function setForwardStatus(machine: Machine, status: SshForwardStatus) {
    setForwardStatuses((current) => ({
      ...current,
      [machine.id]: status
    }));
  }

  async function requestSshForward(machine: Machine, action: "ensure" | "status" | "stop" | "retry") {
    if (isLocalMachine(machine) || (!getForwardPort(machine) && action !== "stop")) {
      const status: SshForwardStatus = {
        state: "off",
        command: "",
        output: isLocalMachine(machine) ? "local machine does not need SSH forward" : "daemon forward is off",
        ok: true,
        localPort: null,
        remotePort: null,
        target: machine.sshHost || machine.host,
        managed: "none",
        retryAttempt: 0,
        retryDelayMs: null
      };
      setForwardStatus(machine, status);
      return status;
    }

    if (action === "ensure" || action === "retry") {
      setForwardStatuses((current) => ({
        ...current,
        [machine.id]: {
          ...(current[machine.id] || {
            command: "",
            output: "",
            ok: false,
            localPort: getForwardPort(machine),
            remotePort: 6767,
            target: machine.sshHost || machine.host,
            managed: "hub",
            retryAttempt: action === "retry" ? 0 : current[machine.id]?.retryAttempt || 0,
            retryDelayMs: action === "retry" ? null : current[machine.id]?.retryDelayMs || null
          }),
          state: "starting"
        }
      }));
    }

    try {
      const response = await fetch("/api/ssh-forward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, machine })
      });
      const data = (await response.json()) as SshForwardStatus;
      setForwardStatus(machine, data);
      return data;
    } catch (error) {
      const status: SshForwardStatus = {
        state: "error",
        command: "",
        output: error instanceof Error ? error.message : "Failed to manage SSH forward",
        ok: false,
        localPort: getForwardPort(machine),
        remotePort: 6767,
        target: machine.sshHost || machine.host,
        managed: "none",
        retryAttempt: 0,
        retryDelayMs: null
      };
      setForwardStatus(machine, status);
      return status;
    }
  }

  function ensureForwardStates(machines: Machine[]) {
    machines.forEach((machine) => {
      void requestSshForward(machine, getForwardPort(machine) ? "ensure" : "status");
    });
  }

  async function saveConfig(nextConfig: PaseoConfig) {
    const normalized = normalizeConfig(nextConfig);
    setConfig(normalized);

    const response = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalized)
    });
    const data = (await response.json()) as ConfigResponse;
    const savedConfig = normalizeConfig(data.config);

    setConfig(savedConfig);
    setConfigPath(data.configPath);
    ensureForwardStates(savedConfig.machines);
    refreshDaemonStates(savedConfig.machines);
    return savedConfig;
  }

  function openAddMachine() {
    setDraft(emptyDraft);
    setFormError("");
    setPendingMachine(null);
    setIsAddingMachine(true);
  }

  function enterMachine(machine: Machine) {
    setIsAddingMachine(false);
    setPendingMachine(null);
    setActiveMachineId(machine.id);
    setMainView("machine");
    void requestSshForward(machine, getForwardPort(machine) ? "ensure" : "status");
    void refreshDaemonStatus(machine);
  }

  async function installPaseo(machine = activeMachine) {
    const initialOutput = `# running ${scriptPath}\n# target ${commandTarget(machine)}\n`;
    let receivedOutput = initialOutput;
    let finalOk = false;
    let finalMessage = "";
    let failureMessage = "";

    function appendOutput(chunk: string) {
      receivedOutput += chunk;
      setOutput((current) => `${current}${chunk}`);
    }

    function handleInstallEvent(event: InstallStreamEvent) {
      if (event.type === "stdout" || event.type === "stderr") {
        appendOutput(event.data);
        return;
      }

      if (event.type === "error") {
        failureMessage = event.message;
        if (!receivedOutput.includes(event.message)) {
          appendOutput(`${receivedOutput.endsWith("\n") ? "" : "\n"}# ${event.message}\n`);
        }
        return;
      }

      if (event.type !== "exit") return;

      finalOk = event.ok;
      finalMessage = event.message;

      if (!event.ok) {
        failureMessage = event.message;
        if (!receivedOutput.includes(event.message)) {
          appendOutput(`${receivedOutput.endsWith("\n") ? "" : "\n"}# ${event.message}\n`);
        }
      }
    }

    function handleInstallLine(line: string) {
      if (!line.trim()) return;

      try {
        handleInstallEvent(JSON.parse(line) as InstallStreamEvent);
      } catch {
        appendOutput(`${line}\n`);
      }
    }

    setStatus("running");
    setMessage(`running ${scriptPath}`);
    setOutput(initialOutput);
    setActiveMachineId(machine.id);
    setMainView("machine");

    try {
      const response = await fetch("/api/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machine })
      });

      if (!response.body) {
        const text = await response.text();
        if (text) {
          appendOutput(text);
        }

        if (!response.ok) {
          throw new Error(text || "Install request failed");
        }

        finalOk = true;
        finalMessage = `${scriptPath} passed`;
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();

          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            lines.forEach(handleInstallLine);
          }

          if (done) break;
        }

        buffer += decoder.decode();
        handleInstallLine(buffer);
      }

      if (!finalOk) {
        throw new Error(failureMessage || finalMessage || "Install request failed");
      }

      const installedMachine = { ...machine, paseoInstalled: true };
      const nextConfig = {
        ...config,
        machines: config.machines.some((item) => item.id === installedMachine.id)
          ? config.machines.map((item) => (item.id === installedMachine.id ? installedMachine : item))
          : [...config.machines, installedMachine]
      };

      setStatus("success");
      setMessage(finalMessage || `${scriptPath} passed`);
      await saveConfig(nextConfig);
      void refreshDaemonStatus(installedMachine);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Install request failed";

      setStatus("error");
      setMessage(errorMessage);

      if (!receivedOutput.includes("# failed")) {
        appendOutput(`${receivedOutput.endsWith("\n") ? "" : "\n"}# failed\n${errorMessage}\n`);
      } else if (!receivedOutput.includes(errorMessage)) {
        appendOutput(`${receivedOutput.endsWith("\n") ? "" : "\n"}${errorMessage}\n`);
      }
    }
  }

  async function restartDaemon(machine = activeMachine) {
    setDaemonStatuses((current) => ({
      ...current,
      [machine.id]: {
        ...current[machine.id],
        state: "checking",
        output: "paseo daemon restart"
      }
    }));

    try {
      const response = await fetch("/api/daemon/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machine })
      });
      const data = await readJsonResponse<DaemonStatus>(response);

      setDaemonStatuses((current) => ({
        ...current,
        [machine.id]: {
          ...data,
          state: data.state || (data.ok === false || !response.ok ? "error" : "running")
        }
      }));

      if (response.ok) {
        void refreshDaemonStatus(machine);
      }
    } catch (error) {
      setDaemonStatuses((current) => ({
        ...current,
        [machine.id]: {
          state: "error",
          output: error instanceof Error ? error.message : "Failed to restart daemon"
        }
      }));
    }
  }

  async function changeSource(source: PaseoSource) {
    await saveConfig({
      ...config,
      paseo: {
        ...config.paseo,
        source,
        repository: "Myriad-Dreamin/paseo",
        ref: "main"
      }
    });
  }

  async function addMachine(machine: Machine) {
    const withoutDuplicate = config.machines.filter((item) => item.id !== machine.id);
    const nextConfig = {
      ...config,
      machines: [...withoutDuplicate, machine]
    };

    setIsAddingMachine(false);
    setPendingMachine(null);
    setActiveMachineId(machine.id);
    setMainView("machine");
    await saveConfig(nextConfig);
  }

  async function submitMachine(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError("");

    const name = draft.name.trim() || draft.sshHost.trim();
    const id = createMachineId(name);
    const local = id === "localhost" || name.toLowerCase() === "localhost";
    const sshTarget = draft.sshHost.trim() || draft.host.trim();

    if (!name) {
      setFormError("Machine name is required.");
      return;
    }

    if (!local && !sshTarget) {
      setFormError("Select an SSH config host or enter an SSH target.");
      return;
    }

    const forwardPort = draft.forwardDaemon ? Number(draft.daemonForwardPort) : null;

    if (draft.forwardDaemon && (!forwardPort || forwardPort < 1 || forwardPort > 65535)) {
      setFormError("Forward port must be a valid TCP port.");
      return;
    }

    const machine = normalizeMachine({
      id,
      name,
      host: local ? "127.0.0.1" : draft.host.trim() || sshTarget,
      kind: local ? "local" : "ssh",
      sshHost: local ? "" : sshTarget,
      forward: local || !forwardPort ? "" : `localhost:${forwardPort}->${sshTarget}:6767`,
      daemonForwardPort: local ? null : forwardPort,
      paseoInstalled: draft.paseoInstalled
    });

    if (!machine.paseoInstalled) {
      setIsAddingMachine(false);
      setPendingMachine(machine);
      return;
    }

    await addMachine(machine);
  }

  function selectSshHost(alias: string) {
    const selected = sshHosts.find((host) => host.alias === alias);

    setDraft((current) => ({
      ...current,
      sshHost: alias,
      host: alias || current.host,
      name: current.name || alias,
      forwardDaemon: alias ? current.forwardDaemon : false,
      daemonForwardPort: current.daemonForwardPort || (portSuggestion ? String(portSuggestion) : "")
    }));

    if (selected && !draft.name) {
      setFormError("");
    }
  }

  async function saveForwardSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setForwardMessage("");

    if (isLocalMachine(activeMachine)) {
      setForwardMessage("local machine does not need SSH forward");
      return;
    }

    const localPort = forwardDraft.enabled ? Number(forwardDraft.localPort) : null;

    if (forwardDraft.enabled && (!localPort || !Number.isInteger(localPort) || localPort < 1 || localPort > 65535)) {
      setForwardMessage("forward port must be a valid TCP port");
      return;
    }

    const updatedMachine = normalizeMachine({
      ...activeMachine,
      forward: forwardDraft.enabled && localPort ? buildMachineForward(activeMachine, localPort) : "",
      daemonForwardPort: forwardDraft.enabled ? localPort : null
    });
    const nextConfig = {
      ...config,
      machines: config.machines.map((machine) => (machine.id === updatedMachine.id ? updatedMachine : machine))
    };

    try {
      setForwardMessage("saving forward config");
      const savedConfig = await saveConfig(nextConfig);
      const savedMachine = savedConfig.machines.find((machine) => machine.id === updatedMachine.id) || updatedMachine;

      setActiveMachineId(savedMachine.id);

      if (forwardDraft.enabled) {
        const status = await requestSshForward(savedMachine, "ensure");
        setForwardMessage(status.ok ? "forward running" : "forward failed");
      } else {
        await requestSshForward(activeMachine, "stop");
        setForwardStatus(savedMachine, {
          state: "off",
          command: "",
          output: "daemon forward is off",
          ok: true,
          localPort: null,
          remotePort: null,
          target: savedMachine.sshHost || savedMachine.host,
          managed: "none",
          retryAttempt: 0,
          retryDelayMs: null
        });
        setForwardMessage("forward off");
      }
    } catch (error) {
      setForwardMessage(error instanceof Error ? error.message : "failed to save forward config");
    }
  }

  async function retrySshForward(machine = activeMachine) {
    setForwardMessage("retrying forward");
    const status = await requestSshForward(machine, "retry");
    setForwardMessage(status.ok ? "forward running" : status.state === "retrying" ? "retry scheduled" : "forward failed");
  }

  async function stopForward(machine = activeMachine) {
    setForwardMessage("stopping forward");
    const status = await requestSshForward(machine, "stop");
    setForwardMessage(status.ok ? "forward stopped" : "forward failed");
  }

  const terminalOutput = useMemo(() => {
    if (status === "running") {
      return `${commandPreview}\n${output || `# running ${scriptPath}\n# target ${commandTarget(activeMachine)}`}`;
    }

    if (status === "success" && output) {
      return `${commandPreview}\n${output}`;
    }

    if (status === "error") {
      const extraMessage = message && !output.includes(message)
        ? `${output.endsWith("\n") ? "" : "\n"}# failed\n${message}`
        : "";

      return `${commandPreview}\n${output}${extraMessage}`;
    }

    return `${commandPreview}\n# waiting\n# target ${commandTarget(activeMachine)}`;
  }, [activeMachine, commandPreview, message, output, status]);

  return (
    <main className={styles.shell}>
      <aside className={styles.sidebar} aria-label="Machines">
        <div className={styles.sidebarHeader}>
          <button className={styles.machineTitle} type="button" onClick={() => setMainView("dashboard")}>
            <PaseoMark className={styles.machineMark} />
            <span>Machines</span>
          </button>
          <button className={styles.addMachineButton} type="button" onClick={openAddMachine} aria-label="Add machine">
            <PlusGlyph className={styles.addIcon} />
          </button>
        </div>

        <nav className={styles.machineList} aria-label="Machines">
          {config.machines.map((machine) => {
            const daemon = daemonStatuses[machine.id]?.state || "unknown";

            return (
              <button
                className={`${styles.machine} ${
                  machine.id === activeMachine.id && mainView === "machine" ? styles.activeMachine : ""
                }`}
                key={machine.id}
                type="button"
                onClick={() => enterMachine(machine)}
              >
                <MachineGlyph className={styles.screenIcon} />
                <span className={styles.machineText}>
                  <span className={styles.machineName}>{machine.name}</span>
                  <span className={styles.forwardLine}>
                    <span>{isLocalMachine(machine) ? "local" : "ssh"}</span>
                    {connectionLabel(machine)}
                  </span>
                </span>
                <span className={styles.machineStatus} data-state={daemon}>
                  {daemonText(daemon)}
                </span>
              </button>
            );
          })}
        </nav>

        {isAddingMachine && (
          <form className={styles.machineForm} onSubmit={submitMachine}>
            <label>
              SSH config
              <select value={draft.sshHost} onChange={(event) => selectSshHost(event.target.value)}>
                <option value="">Manual SSH target</option>
                {sshHosts.map((host) => (
                  <option key={host.alias} value={host.alias}>
                    {host.display}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Name
              <input
                name="name"
                placeholder="workstation"
                value={draft.name}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label>
              SSH target
              <input
                name="host"
                placeholder="host from ~/.ssh/config"
                value={draft.host}
                onChange={(event) => setDraft((current) => ({ ...current, host: event.target.value }))}
              />
            </label>
            <label className={styles.checkboxLine}>
              <input
                checked={draft.forwardDaemon}
                name="forwardDaemon"
                type="checkbox"
                onChange={(event) => setDraft((current) => ({ ...current, forwardDaemon: event.target.checked }))}
              />
              Forward daemon port
            </label>
            <label>
              Local port
              <input
                disabled={!draft.forwardDaemon}
                inputMode="numeric"
                name="daemonForwardPort"
                placeholder={portSuggestion ? String(portSuggestion) : "6767"}
                value={draft.daemonForwardPort}
                onChange={(event) => setDraft((current) => ({ ...current, daemonForwardPort: event.target.value }))}
              />
            </label>
            <p className={styles.formHint}>
              Forward is off by default. Suggested port: {portSuggestion || "checking"}.
            </p>
            <label className={styles.checkboxLine}>
              <input
                checked={draft.paseoInstalled}
                name="paseoInstalled"
                type="checkbox"
                onChange={(event) => setDraft((current) => ({ ...current, paseoInstalled: event.target.checked }))}
              />
              Paseo already installed
            </label>
            {sshConfigPath && <p className={styles.formPath}>{sshConfigPath}</p>}
            {formError && <p className={styles.formError}>{formError}</p>}
            <div className={styles.formActions}>
              <button type="button" onClick={() => setIsAddingMachine(false)}>
                Cancel
              </button>
              <button type="submit">Add</button>
            </div>
          </form>
        )}

        {pendingMachine && (
          <section className={styles.installPrompt} aria-label="Install Paseo on machine">
            <p>{pendingMachine.name} does not report Paseo as installed.</p>
            <code>{commandTarget(pendingMachine)}</code>
            <div className={styles.formActions}>
              <button type="button" onClick={() => addMachine(pendingMachine)}>
                Add only
              </button>
              <button
                type="button"
                onClick={async () => {
                  const machine = pendingMachine;
                  setPendingMachine(null);
                  await installPaseo(machine);
                }}
              >
                Install
              </button>
            </div>
          </section>
        )}
      </aside>

      <section className={styles.workspace}>
        <section className={styles.mainView}>
          {mainView === "dashboard" ? (
            <article className={styles.dashboard} aria-label="Machines dashboard">
              <section className={styles.dashboardLead}>
                <div>
                  <p className={styles.viewKicker}>paseo hub</p>
                  <h1>Machines dashboard</h1>
                </div>
                <button className={styles.primaryAction} type="button" onClick={openAddMachine}>
                  Add machine
                </button>
              </section>

              <section className={styles.stateRail} aria-label="Machine summary">
                <div>
                  <span>machines</span>
                  <strong>{config.machines.length}</strong>
                </div>
                <div>
                  <span>daemon running</span>
                  <strong>{runningDaemonCount}</strong>
                </div>
                <div>
                  <span>ssh forwards</span>
                  <strong>{runningForwardCount}</strong>
                </div>
                <div>
                  <span>ssh targets</span>
                  <strong>{remoteMachineCount}</strong>
                </div>
              </section>

              <section className={styles.machineTable} aria-label="Machine states">
                <div className={styles.tableHead}>
                  <span>machine</span>
                  <span>daemon</span>
                  <span>install</span>
                  <span>connection</span>
                </div>

                {config.machines.map((machine) => {
                  const daemon = daemonStatuses[machine.id]?.state || "unknown";

                  return (
                    <button
                      className={styles.tableRow}
                      key={machine.id}
                      type="button"
                      onClick={() => enterMachine(machine)}
                    >
                      <span className={styles.tableMachine}>
                        <strong>{machine.name}</strong>
                        <code>{commandTarget(machine)}</code>
                      </span>
                      <span className={styles.statePill} data-state={daemon}>
                        {daemonText(daemon)}
                      </span>
                      <span className={styles.statePill} data-state={machine.paseoInstalled ? "running" : "missing"}>
                        {installState(machine)}
                      </span>
                      <code className={styles.tableConnection}>{connectionLabel(machine)}</code>
                    </button>
                  );
                })}
              </section>
            </article>
          ) : (
            <article className={styles.content} id="install">
              <button className={styles.backButton} type="button" onClick={() => setMainView("dashboard")}>
                Machines dashboard
              </button>

              <section className={styles.machineLead}>
                <div>
                  <p className={styles.viewKicker}>{commandTarget(activeMachine)}</p>
                  <h1>{activeMachine.name}</h1>
                </div>
                <button
                  className={styles.primaryAction}
                  type="button"
                  onClick={() => installPaseo()}
                  disabled={status === "running"}
                >
                  <PlayGlyph className={styles.playIcon} />
                  Install Paseo
                </button>
              </section>

              <section className={styles.detailGrid} aria-label="Machine details">
                <div>
                  <span>host</span>
                  <code>{activeMachine.host}</code>
                </div>
                <div>
                  <span>connection</span>
                  <code>{connectionLabel(activeMachine)}</code>
                </div>
                <div>
                  <span>kind</span>
                  <code>{isLocalMachine(activeMachine) ? "local" : "ssh"}</code>
                </div>
                <div>
                  <span>script</span>
                  <code>{scriptPath}</code>
                </div>
              </section>

              <form className={styles.forwardPanel} aria-label="SSH forward" onSubmit={saveForwardSettings}>
                <div className={styles.forwardHead}>
                  <div>
                    <p className={styles.panelLabel}>ssh forward</p>
                    <h2>{forwardText(activeForward.state)}</h2>
                    <code>{activeForward.command || connectionLabel(activeMachine)}</code>
                  </div>
                  <div className={styles.forwardActions}>
                    <button
                      type="button"
                      onClick={() => retrySshForward(activeMachine)}
                      disabled={isLocalMachine(activeMachine) || !getForwardPort(activeMachine) || activeForward.state === "starting"}
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      onClick={() => stopForward(activeMachine)}
                      disabled={isLocalMachine(activeMachine) || activeForward.state === "off" || activeForward.state === "starting"}
                    >
                      Stop
                    </button>
                    <button type="submit" disabled={isLocalMachine(activeMachine)}>
                      Save
                    </button>
                  </div>
                </div>

                <div className={styles.forwardFields}>
                  <label className={styles.checkboxLine}>
                    <input
                      checked={forwardDraft.enabled}
                      disabled={isLocalMachine(activeMachine)}
                      name="forwardEnabled"
                      type="checkbox"
                      onChange={(event) =>
                        setForwardDraft((current) => ({
                          ...current,
                          enabled: event.target.checked,
                          localPort: current.localPort || (portSuggestion ? String(portSuggestion) : "6768")
                        }))
                      }
                    />
                    Auto forward daemon
                  </label>
                  <label>
                    Local port
                    <input
                      disabled={isLocalMachine(activeMachine) || !forwardDraft.enabled}
                      inputMode="numeric"
                      name="forwardLocalPort"
                      placeholder={portSuggestion ? String(portSuggestion) : "6768"}
                      value={forwardDraft.localPort}
                      onChange={(event) => setForwardDraft((current) => ({ ...current, localPort: event.target.value }))}
                    />
                  </label>
                </div>

                {(forwardMessage || retryLabel(activeForward)) && (
                  <p className={styles.forwardMessage}>{forwardMessage || retryLabel(activeForward)}</p>
                )}
                {activeForward.output && (
                  <pre className={styles.forwardOutput}>
                    <code>{activeForward.output}</code>
                  </pre>
                )}
              </form>

              <section className={styles.daemonPanel} aria-label="Paseo daemon">
                <div>
                  <p className={styles.panelLabel}>daemon</p>
                  <h2>{daemonText(activeDaemon.state)}</h2>
                  <code>{activeDaemon.command || `${commandTarget(activeMachine)} paseo daemon status`}</code>
                </div>
                <div className={styles.daemonActions}>
                  <button type="button" onClick={() => refreshDaemonStatus(activeMachine)}>
                    Check
                  </button>
                  <button type="button" onClick={() => restartDaemon(activeMachine)} disabled={activeDaemon.state === "checking"}>
                    Restart
                  </button>
                </div>
                {activeDaemon.output && (
                  <pre className={styles.daemonOutput}>
                    <code>{activeDaemon.output}</code>
                  </pre>
                )}
              </section>

              <section className={styles.configStrip} aria-label="Install target and source">
                <div className={styles.configItem}>
                  <span>source</span>
                  <select
                    aria-label="Paseo source"
                    value={config.paseo.source}
                    onChange={(event) => changeSource(event.target.value as PaseoSource)}
                  >
                    <option value="npm">npm package</option>
                    <option value="github">Myriad-Dreamin/paseo main</option>
                  </select>
                </div>
                <div className={styles.configItem}>
                  <span>flow</span>
                  <strong>{sourceLabel}</strong>
                  <code>{sourceFlow}</code>
                </div>
                <div className={styles.configItem}>
                  <span>config</span>
                  <strong>paseo-hub/config.json</strong>
                  <code>{configPath || "loading"}</code>
                </div>
              </section>

              <section className={styles.scriptRunner} aria-label="Paseo install script">
                <div className={styles.runnerHeader}>
                  <div className={styles.runnerTitle}>
                    <span className={styles.terminalGlyph} aria-hidden="true">
                      &gt;_
                    </span>
                    <span>{commandPreview}</span>
                  </div>

                  <div className={styles.runnerActions}>
                    <span className={styles.installStatus} data-state={status}>
                      <span className={styles.statusDot} />
                      {statusText}
                    </span>
                    <button
                      className={styles.installButton}
                      type="button"
                      onClick={() => installPaseo()}
                      disabled={status === "running"}
                    >
                      <PlayGlyph className={styles.playIcon} />
                      Run
                    </button>
                  </div>
                </div>

                <pre className={styles.outputBlock}>
                  <code>{terminalOutput}</code>
                </pre>
              </section>
            </article>
          )}
        </section>
      </section>
    </main>
  );
}
