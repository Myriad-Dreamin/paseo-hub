import { restartDaemon } from "../../../../server-side/paseo/daemon.ts";
import type { MachineTarget } from "../../../../server-side/paseo/command.ts";

export const runtime = "nodejs";

type DaemonRequest = {
  machine?: MachineTarget;
};

function errorStatus(message: string) {
  return {
    state: "error",
    command: "paseo daemon restart",
    output: message,
    ok: false
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export async function POST(request: Request) {
  let body: DaemonRequest = {};

  try {
    body = (await request.json()) as DaemonRequest;
  } catch {
    body = {};
  }

  try {
    const result = await withTimeout(
      restartDaemon(body.machine || { id: "localhost", name: "localhost", host: "127.0.0.1" }),
      20000,
      "paseo daemon restart timed out after 20000ms"
    );

    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to restart daemon";

    return Response.json(errorStatus(message));
  }
}
