import net from "node:net";

export const runtime = "nodejs";

function isPortFree(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "127.0.0.1");
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const start = Number(url.searchParams.get("start") || 6767);
  const from = Number.isFinite(start) && start > 0 ? start : 6767;
  const occupied: number[] = [];

  for (let port = from; port < from + 100; port += 1) {
    if (await isPortFree(port)) {
      return Response.json({
        start: from,
        port,
        occupied
      });
    }

    occupied.push(port);
  }

  return Response.json(
    {
      start: from,
      error: "No free local port found from 6767 to 6866",
      occupied
    },
    { status: 500 }
  );
}
