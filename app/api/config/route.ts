import { readPaseoHubConfig, writePaseoHubConfig } from "../../../server-side/paseo/config.mjs";

export const runtime = "nodejs";

export async function GET() {
  const { config, configPath } = await readPaseoHubConfig();

  return Response.json({
    config,
    configPath
  });
}

export async function POST(request: Request) {
  const config = await request.json();
  const configPath = await writePaseoHubConfig(config);
  const result = await readPaseoHubConfig();

  return Response.json({
    config: result.config,
    configPath
  });
}
