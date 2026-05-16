import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { isLocalMachine, type MachineTarget } from "./command.ts";

export const remotePaseoBin = "$HOME/.paseo-hub/bin/paseo";

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
