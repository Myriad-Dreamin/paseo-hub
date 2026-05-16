import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const runtime = "nodejs";

type SshHost = {
  alias: string;
  hostName: string;
  user: string;
  port: string;
  display: string;
};

type HostBlock = {
  aliases: string[];
  hostName: string;
  user: string;
  port: string;
};

function isConcreteHost(alias: string) {
  return alias !== "*" && !alias.includes("*") && !alias.includes("?");
}

function parseSshConfig(raw: string) {
  const blocks: HostBlock[] = [];
  let current: HostBlock | null = null;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.search(/\s/);
    const key = (separator === -1 ? line : line.slice(0, separator)).toLowerCase();
    const value = separator === -1 ? "" : line.slice(separator).trim();

    if (key === "host") {
      current = {
        aliases: value.split(/\s+/).filter(isConcreteHost),
        hostName: "",
        user: "",
        port: ""
      };

      if (current.aliases.length > 0) {
        blocks.push(current);
      }

      continue;
    }

    if (!current) {
      continue;
    }

    if (key === "hostname") {
      current.hostName = value;
    } else if (key === "user") {
      current.user = value;
    } else if (key === "port") {
      current.port = value;
    }
  }

  const hosts: SshHost[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    for (const alias of block.aliases) {
      if (seen.has(alias)) {
        continue;
      }

      seen.add(alias);
      const hostName = block.hostName || alias;
      const user = block.user || "";
      const port = block.port || "";
      const userPrefix = user ? `${user}@` : "";
      const portSuffix = port ? `:${port}` : "";

      hosts.push({
        alias,
        hostName,
        user,
        port,
        display: `${alias} (${userPrefix}${hostName}${portSuffix})`
      });
    }
  }

  return hosts;
}

export async function GET() {
  const configPath = path.join(os.homedir(), ".ssh", "config");

  try {
    const raw = await readFile(configPath, "utf8");

    return Response.json({
      configPath,
      hosts: parseSshConfig(raw)
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
      return Response.json(
        {
          configPath,
          hosts: [],
          error: "Failed to read SSH config"
        },
        { status: 500 }
      );
    }

    return Response.json({
      configPath,
      hosts: []
    });
  }
}
