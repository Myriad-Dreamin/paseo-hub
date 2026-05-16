import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const installTotalTimeoutMs = Number(process.env.PASEO_INSTALL_TOTAL_TIMEOUT_MS || 3600000);

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

type InstallStreamEvent =
  | {
      type: "stdout" | "stderr";
      data: string;
    }
  | {
      type: "exit";
      ok: boolean;
      code: number | null;
      signal: NodeJS.Signals | null;
      message: string;
    }
  | {
      type: "error";
      message: string;
    };

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

function machineEnv(body: InstallRequest) {
  return {
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
  };
}

export async function POST(request: Request) {
  const scriptPath = path.join(process.cwd(), "server-side", "paseo", "install.ts");
  let body: InstallRequest = {};

  try {
    body = (await request.json()) as InstallRequest;
  } catch {
    body = {};
  }

  let child: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let timedOut = false;

      function write(event: InstallStreamEvent) {
        if (closed) return;
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }

      function close() {
        if (closed) return;
        closed = true;
        controller.close();
      }

      child = spawn(process.execPath, [scriptPath], {
        cwd: process.cwd(),
        env: machineEnv(body),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      });

      timer = installTotalTimeoutMs
        ? setTimeout(() => {
            if (!child || closed) return;
            timedOut = true;
            write({
              type: "error",
              message: `server-side/paseo/install.ts timed out after ${installTotalTimeoutMs}ms`
            });
            killProcessTree(child);
          }, installTotalTimeoutMs)
        : null;

      child.stdout?.on("data", (chunk: Buffer) => {
        write({ type: "stdout", data: chunk.toString() });
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        write({ type: "stderr", data: chunk.toString() });
      });

      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        write({ type: "error", message: error.message });
        close();
      });

      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        const ok = code === 0 && !timedOut;
        const message = ok
          ? "server-side/paseo/install.ts passed"
          : timedOut
            ? "server-side/paseo/install.ts timed out"
            : `server-side/paseo/install.ts failed with exit code ${code ?? "unknown"}`;

        write({
          type: "exit",
          ok,
          code,
          signal,
          message
        });
        close();
      });
    },
    cancel() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (child) killProcessTree(child);
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}
