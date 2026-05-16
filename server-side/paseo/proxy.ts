import { execFileSync } from "node:child_process";

type ProxyResolution = {
  env: NodeJS.ProcessEnv;
  source: "environment" | "windows-system" | "none";
  summary: string;
};

const proxyKeys = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy"
];

function hasProxyEnv(env: NodeJS.ProcessEnv) {
  return proxyKeys.some((key) => Boolean(env[key]));
}

function normalizeProxy(value: string, scheme = "http") {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  if (/^[a-z]+:\/\//i.test(trimmed)) {
    return trimmed;
  }

  return `${scheme}://${trimmed}`;
}

function parseProxyServer(value: string) {
  const parts = value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return null;
  }

  const byScheme = new Map<string, string>();

  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator > -1) {
      byScheme.set(part.slice(0, separator).trim().toLowerCase(), part.slice(separator + 1).trim());
    }
  }

  if (byScheme.size > 0) {
    const http = byScheme.get("http") || byScheme.get("https") || byScheme.get("socks");
    const https = byScheme.get("https") || byScheme.get("http") || byScheme.get("socks");

    return {
      http: http ? normalizeProxy(http, byScheme.has("socks") ? "socks" : "http") : "",
      https: https ? normalizeProxy(https, byScheme.has("socks") ? "socks" : "http") : ""
    };
  }

  const shared = normalizeProxy(parts[0]);
  return {
    http: shared,
    https: shared
  };
}

function queryRegistryValue(name: string) {
  try {
    const output = execFileSync("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
      "/v",
      name
    ], {
      encoding: "utf8",
      windowsHide: true
    });
    const line = output
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.toLowerCase().startsWith(name.toLowerCase()));

    if (!line) {
      return "";
    }

    const parts = line.split(/\s{2,}/);
    return parts[parts.length - 1]?.trim() || "";
  } catch {
    return "";
  }
}

function readWindowsInternetProxy() {
  if (process.platform !== "win32") {
    return null;
  }

  const proxyEnabled = queryRegistryValue("ProxyEnable");
  const enabled = proxyEnabled === "0x1" || proxyEnabled === "1";

  if (!enabled) {
    return null;
  }

  const proxyServer = queryRegistryValue("ProxyServer");
  const parsed = parseProxyServer(proxyServer);

  if (!parsed) {
    return null;
  }

  const proxyOverride = queryRegistryValue("ProxyOverride")
    .replace(/<local>/gi, "localhost,127.0.0.1")
    .replace(/;/g, ",");

  return {
    ...parsed,
    noProxy: proxyOverride
  };
}

function readWindowsWinHttpProxy() {
  if (process.platform !== "win32") {
    return null;
  }

  try {
    const output = execFileSync("netsh", ["winhttp", "show", "proxy"], {
      encoding: "utf8",
      windowsHide: true
    });

    if (/direct access/i.test(output)) {
      return null;
    }

    const proxyLine = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /proxy server/i.test(line));
    const proxyValue = proxyLine?.split(":").slice(1).join(":").trim() || "";
    const parsed = parseProxyServer(proxyValue);

    if (!parsed) {
      return null;
    }

    const bypassLine = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /bypass list/i.test(line));
    const noProxy = bypassLine?.split(":").slice(1).join(":").trim().replace(/;/g, ",") || "";

    return {
      ...parsed,
      noProxy
    };
  } catch {
    return null;
  }
}

function maskProxy(value: string | undefined) {
  if (!value) {
    return "";
  }

  return value.replace(/\/\/([^/@]+)@/, "//***@");
}

export function resolveProxyEnv(baseEnv: NodeJS.ProcessEnv = process.env): ProxyResolution {
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  if (hasProxyEnv(env)) {
    return {
      env,
      source: "environment",
      summary: proxyKeys
        .filter((key) => env[key])
        .map((key) => `${key}=${maskProxy(env[key])}`)
        .join(", ")
    };
  }

  const systemProxy = readWindowsInternetProxy() || readWindowsWinHttpProxy();

  if (!systemProxy) {
    return {
      env,
      source: "none",
      summary: "none"
    };
  }

  env.HTTP_PROXY = systemProxy.http;
  env.HTTPS_PROXY = systemProxy.https || systemProxy.http;
  env.http_proxy = env.HTTP_PROXY;
  env.https_proxy = env.HTTPS_PROXY;

  if (systemProxy.noProxy) {
    env.NO_PROXY = systemProxy.noProxy;
    env.no_proxy = systemProxy.noProxy;
  }

  return {
    env,
    source: "windows-system",
    summary: [
      `HTTP_PROXY=${maskProxy(env.HTTP_PROXY)}`,
      `HTTPS_PROXY=${maskProxy(env.HTTPS_PROXY)}`,
      env.NO_PROXY ? `NO_PROXY=${env.NO_PROXY}` : ""
    ].filter(Boolean).join(", ")
  };
}
