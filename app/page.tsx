"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import styles from "./page.module.css";

type InstallStatus = "idle" | "running" | "success" | "error";
type PaseoSource = "npm" | "github";
type MainView = "dashboard" | "machine";
type MachineKind = "local" | "ssh";
type DaemonState = "unknown" | "checking" | "running" | "stopped" | "missing" | "error";

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

type InstallResponse = {
  message?: string;
  output?: string;
  error?: string;
};

type DaemonStatus = {
  state: DaemonState;
  command?: string;
  output?: string;
  ok?: boolean;
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

function normalizeMachine(machine: Partial<Machine>): Machine {
  const id = machine.id || createMachineId(machine.name || "machine");
  const local =
    machine.kind === "local" ||
    id === "localhost" ||
    machine.name === "localhost" ||
    (!machine.sshHost && (machine.host === "localhost" || machine.host === "127.0.0.1"));

  return {
    id,
    name: machine.name || id,
    host: local ? "127.0.0.1" : machine.host || machine.sshHost || id,
    kind: local ? "local" : "ssh",
    sshHost: local ? "" : machine.sshHost || machine.host || id,
    forward: local ? "" : machine.forward || "",
    daemonForwardPort: typeof machine.daemonForwardPort === "number" ? machine.daemonForwardPort : null,
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

  if (machine.daemonForwardPort) {
    return `localhost:${machine.daemonForwardPort} -> 6767`;
  }

  return "direct ssh, no forward";
}

function daemonText(state: DaemonState) {
  if (state === "checking") return "checking";
  if (state === "running") return "running";
  if (state === "stopped") return "stopped";
  if (state === "missing") return "missing";
  if (state === "error") return "error";
  return "unknown";
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

  const activeMachine = useMemo(() => {
    return config.machines.find((machine) => machine.id === activeMachineId) || config.machines[0] || fallbackMachine;
  }, [activeMachineId, config.machines]);

  const command = useMemo(() => {
    if (config.paseo.source === "github") {
      return `pnpm add github:${config.paseo.repository}#${config.paseo.ref}`;
    }

    return `pnpm add ${config.paseo.packageName}`;
  }, [config.paseo]);

  const commandPreview = useMemo(() => {
    if (isLocalMachine(activeMachine)) {
      return command;
    }

    return `ssh ${activeMachine.sshHost || activeMachine.host} "${command}"`;
  }, [activeMachine, command]);

  const sourceLabel = useMemo(() => {
    if (config.paseo.source === "github") {
      return `${config.paseo.repository}#${config.paseo.ref}`;
    }

    return config.paseo.packageName;
  }, [config.paseo]);

  const activeDaemon = daemonStatuses[activeMachine.id] || { state: "unknown" as DaemonState };
  const runningDaemonCount = config.machines.filter((machine) => daemonStatuses[machine.id]?.state === "running").length;
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
      const data = (await response.json()) as DaemonStatus;

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
    void refreshDaemonStatus(machine);
  }

  async function installPaseo(machine = activeMachine) {
    setStatus("running");
    setMessage(`running ${scriptPath}`);
    setOutput("");
    setActiveMachineId(machine.id);
    setMainView("machine");

    try {
      const response = await fetch("/api/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ machine })
      });
      const data = (await response.json()) as InstallResponse;

      if (!response.ok) {
        setOutput(data.output || "");
        throw new Error(data.error || "Install request failed");
      }

      const installedMachine = { ...machine, paseoInstalled: true };
      const nextConfig = {
        ...config,
        machines: config.machines.some((item) => item.id === installedMachine.id)
          ? config.machines.map((item) => (item.id === installedMachine.id ? installedMachine : item))
          : [...config.machines, installedMachine]
      };

      setStatus("success");
      setMessage(data.message || `${scriptPath} passed`);
      setOutput(data.output || "# passed");
      await saveConfig(nextConfig);
      void refreshDaemonStatus(installedMachine);
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Install request failed");
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
      const data = (await response.json()) as DaemonStatus;

      setDaemonStatuses((current) => ({
        ...current,
        [machine.id]: {
          ...data,
          state: data.state || (response.ok ? "running" : "error")
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

  const terminalOutput = useMemo(() => {
    if (status === "running") {
      return `${commandPreview}\n# running ${scriptPath}\n# target ${commandTarget(activeMachine)}`;
    }

    if (status === "success" && output) {
      return `${commandPreview}\n${output}`;
    }

    if (status === "error") {
      return `${commandPreview}\n# failed\n${message}${output ? `\n${output}` : ""}`;
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
                  <span>package</span>
                  <strong>{sourceLabel}</strong>
                  <code>{command}</code>
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
