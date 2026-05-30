import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type PatchOutcome = {
  filePath: string;
  changed: boolean;
};

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function patchTerminalWorkerWindowsHide(source: string, filePath: string) {
  const isTypeScript = filePath.endsWith(".ts");
  const desiredLine = isTypeScript
    ? "    ...({ windowsHide: true } as { windowsHide?: boolean }),"
    : "    windowsHide: true,";

  if (source.includes(desiredLine.trim())) {
    return { source, changed: false };
  }

  if (isTypeScript && source.includes("windowsHide: true")) {
    return {
      source: source.replace(/\r?\n\s*windowsHide: true,/u, `\n${desiredLine}`),
      changed: true
    };
  }

  if (!isTypeScript && source.includes("windowsHide: true")) {
    return { source, changed: false };
  }

  const anchor = 'stdio: ["ignore", "ignore", "inherit", "ipc"],';

  if (!source.includes(anchor)) {
    throw new Error("Could not find terminal worker fork stdio option");
  }

  return {
    source: source.replace(anchor, `${anchor}\n${desiredLine}`),
    changed: true
  };
}

async function patchFile(filePath: string): Promise<PatchOutcome | null> {
  if (!(await fileExists(filePath))) {
    return null;
  }

  const current = await readFile(filePath, "utf8");
  const patched = patchTerminalWorkerWindowsHide(current, filePath);

  if (patched.changed) {
    await writeFile(filePath, patched.source, "utf8");
  }

  return {
    filePath,
    changed: patched.changed
  };
}

export async function applyLocalPaseoSourcePatches(workspace: string) {
  if (process.platform !== "win32") {
    return [];
  }

  const candidates = [
    path.join(workspace, "packages", "server", "src", "terminal", "worker-terminal-manager.ts"),
    path.join(workspace, "packages", "server", "dist", "server", "terminal", "worker-terminal-manager.js")
  ];
  const outcomes = await Promise.all(candidates.map(patchFile));

  return outcomes.filter((outcome): outcome is PatchOutcome => Boolean(outcome));
}
