import { getDaemonStatus } from "../../../../server-side/paseo/daemon.ts";
import type { MachineTarget } from "../../../../server-side/paseo/command.ts";

export const runtime = "nodejs";

type DaemonRequest = {
  machine?: MachineTarget;
};

export async function POST(request: Request) {
  let body: DaemonRequest = {};

  try {
    body = (await request.json()) as DaemonRequest;
  } catch {
    body = {};
  }

  const status = await getDaemonStatus(body.machine || { id: "localhost", name: "localhost", host: "127.0.0.1" });

  return Response.json(status);
}
