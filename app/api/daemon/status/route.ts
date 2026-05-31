import { getDaemonStatus } from "../../../../server-side/paseo/daemon.ts";
import type { MachineTarget } from "../../../../server-side/paseo/command.ts";

export const runtime = "nodejs";

type DaemonRequest = {
  machine?: MachineTarget;
};

function errorStatus(message: string) {
  return {
    state: "error",
    command: "paseo daemon status",
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
    const status = await withTimeout(
      getDaemonStatus(body.machine || { id: "localhost", name: "localhost", host: "127.0.0.1" }),
      10000,
      "paseo daemon status timed out after 10000ms"
    );

    return Response.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to check daemon status";

    return Response.json(errorStatus(message));
  }
}
