import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const installTotalTimeoutMs = Number(process.env.PASEO_INSTALL_TOTAL_TIMEOUT_MS || 3600000);
const installMaxBuffer = Number(process.env.PASEO_INSTALL_MAX_BUFFER || 50 * 1024 * 1024);

export const runtime = "nodejs";

type InstallRequest = {
  machine?: {
    id?: string;
    name?: string;
    host?: string;
    forward?: string;
    kind?: "local" | "ssh";
    sshHost?: string;
    daemonForwardPort?: number | null;
    workspacePath?: string;
  };
};

export async function POST(request: Request) {
  const scriptPath = path.join(process.cwd(), "server-side", "paseo", "install.ts");
  let body: InstallRequest = {};

  try {
    body = (await request.json()) as InstallRequest;
  } catch {
    body = {};
  }

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PASEO_MACHINE_ID: body.machine?.id || "localhost",
        PASEO_MACHINE_NAME: body.machine?.name || "localhost",
        PASEO_MACHINE_HOST: body.machine?.host || "127.0.0.1",
        PASEO_MACHINE_FORWARD: body.machine?.forward || "",
        PASEO_MACHINE_KIND: body.machine?.kind || "",
        PASEO_MACHINE_SSH_HOST: body.machine?.sshHost || "",
        PASEO_MACHINE_DAEMON_FORWARD_PORT: body.machine?.daemonForwardPort
          ? String(body.machine.daemonForwardPort)
          : "",
        PASEO_MACHINE_WORKSPACE_PATH: body.machine?.workspacePath || ""
      },
      timeout: installTotalTimeoutMs,
      maxBuffer: installMaxBuffer,
      windowsHide: true
    });

    return Response.json({
      message: "server-side/paseo/install.ts passed",
      output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
    });
  } catch (error) {
    const installError = error as Error & {
      stdout?: string;
      stderr?: string;
    };

    return Response.json(
      {
        error: installError.message,
        output: [installError.stdout, installError.stderr].filter(Boolean).join("\n")
      },
      { status: 500 }
    );
  }
}
