import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const defaultConfig = {
  paseo: {
    source: "npm",
    packageName: "paseo",
    repository: "Myriad-Dreamin/paseo",
    ref: "main"
  },
  machines: [
    {
      id: "localhost",
      name: "localhost",
      host: "127.0.0.1",
      kind: "local",
      sshHost: "",
      forward: "",
      daemonForwardPort: null,
      paseoInstalled: true
    }
  ]
};

export function getConfigDir() {
  if (process.env.PASEO_HUB_CONFIG_DIR) {
    return process.env.PASEO_HUB_CONFIG_DIR;
  }

  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "paseo-hub");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "paseo-hub");
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "paseo-hub");
}

export function getConfigPath() {
  return path.join(getConfigDir(), "config.json");
}

function parseForwardLocalPort(forward) {
  if (typeof forward !== "string" || !forward.trim()) {
    return null;
  }

  const readableMatch = forward.match(/(?:localhost|127\.0\.0\.1|\[::1\])\s*:\s*(\d+)/iu);
  const arrowMatch = forward.match(/:(\d+)\s*->/u);
  const sshDashLMatch = forward.match(/(?:^|\s)(\d+):[^:\s]+:\d+(?:\s|$)/u);
  const parsed = Number(readableMatch?.[1] || arrowMatch?.[1] || sshDashLMatch?.[1]);

  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

function normalizeMachine(machine) {
  const id = machine.id || machine.name || "machine";
  const isLocal =
    machine.kind === "local" ||
    id === "localhost" ||
    machine.name === "localhost" ||
    (!machine.sshHost && (machine.host === "localhost" || machine.host === "127.0.0.1"));
  const sshHost = isLocal ? "" : machine.sshHost || machine.host || id;
  const daemonForwardPort =
    typeof machine.daemonForwardPort === "number" &&
    Number.isInteger(machine.daemonForwardPort) &&
    machine.daemonForwardPort > 0 &&
    machine.daemonForwardPort <= 65535
      ? machine.daemonForwardPort
      : parseForwardLocalPort(machine.forward);

  return {
    id,
    name: machine.name || id,
    host: isLocal ? "127.0.0.1" : machine.host || sshHost || id,
    kind: isLocal ? "local" : "ssh",
    sshHost,
    forward: isLocal ? "" : machine.forward || (daemonForwardPort ? `localhost:${daemonForwardPort}->${sshHost}:6767` : ""),
    daemonForwardPort: isLocal ? null : daemonForwardPort,
    paseoInstalled: Boolean(machine.paseoInstalled),
    workspacePath: machine.workspacePath || ""
  };
}

function normalizeConfig(config) {
  const machines =
    Array.isArray(config.machines) && config.machines.length > 0
      ? config.machines.map(normalizeMachine)
      : defaultConfig.machines;

  return {
    ...defaultConfig,
    ...config,
    paseo: {
      ...defaultConfig.paseo,
      ...config.paseo
    },
    machines
  };
}

export async function readPaseoHubConfig() {
  const configPath = getConfigPath();

  try {
    const raw = await readFile(configPath, "utf8");
    const userConfig = JSON.parse(raw);

    return {
      configPath,
      config: normalizeConfig(userConfig)
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
      throw error;
    }

    return {
      configPath,
      config: defaultConfig
    };
  }
}

export async function writePaseoHubConfig(config) {
  const configPath = getConfigPath();
  const normalizedConfig = normalizeConfig(config);
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(normalizedConfig, null, 2)}\n`, "utf8");
  return configPath;
}
