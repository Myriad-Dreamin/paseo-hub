import { isLocalMachine, runMachineCommand, type MachineTarget } from "./command.ts";
import { buildPaseoCommand, exists, getLocalPaseoWrapper, quoteLocalPath } from "./cli.ts";

export type DaemonState = "unknown" | "running" | "stopped" | "missing" | "error";

export type DaemonCommandResult = {
  state: DaemonState;
  command: string;
  output: string;
  ok: boolean;
};

function classifyDaemonOutput(output: string, ok: boolean): DaemonState {
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

async function runPaseoCommand(machine: MachineTarget, action: "status" | "restart") {
  const root = process.cwd();
  const localWrapper = getLocalPaseoWrapper(root);
  const primaryCommand = buildPaseoCommand(machine, `daemon ${action}`);

  try {
    return await runMachineCommand(machine, primaryCommand, {
      cwd: root,
      timeoutMs: action === "restart" ? 60000 : 30000,
      forwardProxyEnv: false
    });
  } catch (error) {
    if (!isLocalMachine(machine) || !(await exists(localWrapper))) {
      throw error;
    }

    return runMachineCommand(machine, `${quoteLocalPath(localWrapper)} daemon ${action}`, {
      cwd: root,
      timeoutMs: action === "restart" ? 60000 : 30000,
      forwardProxyEnv: false
    });
  }
}

export async function getDaemonStatus(machine: MachineTarget): Promise<DaemonCommandResult> {
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
