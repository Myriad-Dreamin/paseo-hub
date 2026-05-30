import {
  ensureSshForward,
  getSshForwardStatus,
  retrySshForward,
  stopSshForward,
  type SshForwardStatus
} from "../../../server-side/paseo/forward.ts";
import type { MachineTarget } from "../../../server-side/paseo/command.ts";

export const runtime = "nodejs";

type SshForwardRequest = {
  action?: "ensure" | "status" | "stop" | "retry";
  machine?: MachineTarget;
};

const fallbackStatus: SshForwardStatus = {
  state: "off",
  command: "",
  output: "machine is missing",
  ok: false,
  localPort: null,
  remotePort: null,
  target: ""
};

export async function POST(request: Request) {
  let body: SshForwardRequest = {};

  try {
    body = (await request.json()) as SshForwardRequest;
  } catch {
    body = {};
  }

  if (!body.machine) {
    return Response.json(fallbackStatus, { status: 400 });
  }

  const action = body.action || "status";
  const result =
    action === "ensure"
      ? await ensureSshForward(body.machine)
      : action === "retry"
        ? await retrySshForward(body.machine)
      : action === "stop"
        ? await stopSshForward(body.machine)
        : await getSshForwardStatus(body.machine);

  return Response.json(result, {
    status: result.ok || result.state === "retrying" || result.state === "stopped" || result.state === "off" ? 200 : 500
  });
}
