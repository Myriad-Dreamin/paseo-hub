import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { isLocalMachine, type MachineTarget } from "./command.ts";

export const remotePaseoBin = "$HOME/.paseo-hub/bin/paseo";

type InstallationState = {
  workspace?: unknown;
  paseoSource?: {
    source?: unknown;
  };
};

export type LocalPaseoInvocation = {
  command: string;
  args: string[];
  cwd: string;
  preview: string;
};

export async function exists(filePath: string) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function getLocalPaseoWrapper(root = process.cwd()) {
  return path.join(root, ".paseo", "bin", process.platform === "win32" ? "paseo.cmd" : "paseo");
}

export function quoteLocalPath(filePath: string) {
  return `"${filePath.replace(/"/g, '\\"')}"`;
}

async function readInstallationState(root: string): Promise<InstallationState | null> {
  try {
    return JSON.parse(await readFile(path.join(root, ".paseo", "installation.json"), "utf8")) as InstallationState;
  } catch {
    return null;
  }
}

async function localGithubInvocation(workspace: string, args: string[]) {
  const cliEntry = path.join(workspace, "packages", "cli", "bin", "paseo");

  if (!(await exists(cliEntry))) {
    return null;
  }

  return {
    command: process.execPath,
    args: ["--disable-warning=DEP0040", cliEntry, ...args],
    cwd: workspace,
    preview: `${quoteLocalPath(cliEntry)} ${args.join(" ")}`
  };
}

export async function resolveLocalPaseoInvocation(root: string, args: string[]): Promise<LocalPaseoInvocation | null> {
  const state = await readInstallationState(root);
  const workspace = typeof state?.workspace === "string" ? state.workspace : "";

  if (state?.paseoSource?.source === "github" && workspace) {
    const invocation = await localGithubInvocation(workspace, args);

    if (invocation) {
      return invocation;
    }
  }

  return localGithubInvocation(path.join(root, ".paseo", "source", "paseo"), args);
}

export function buildPaseoCommand(machine: MachineTarget, args: string) {
  if (isLocalMachine(machine)) {
    return `paseo ${args}`;
  }

  return [
    `if command -v paseo >/dev/null 2>&1; then paseo ${args};`,
    `elif [ -x "$HOME/.paseo-hub/bin/paseo" ]; then "$HOME/.paseo-hub/bin/paseo" ${args};`,
    'else echo "paseo not found in PATH or $HOME/.paseo-hub/bin/paseo" >&2; exit 127;',
    "fi"
  ].join(" ");
}
