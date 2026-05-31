# Paseo Hub

Paseo Hub is a local developer workspace for installing, configuring, and inspecting [Paseo](https://paseo.sh) across local and SSH-connected machines.

## Get Started

```sh
pnpm install
pnpm dev
```

Open the local Next.js URL printed by the dev server. The default machine is `localhost`; add remote machines from the app when you need to run Paseo over SSH.

## Installation

Install or update the Paseo CLI through the project installer:

```sh
pnpm install:paseo
```

Build Paseo Hub for production:

```sh
pnpm build
pnpm start
```

On Windows, Paseo Hub also includes startup helpers. They install a Task Scheduler entry that starts Paseo Hub when the current Windows user logs in, so `paseo`, `ssh`, and `pnpm` run under the same user profile:

```sh
pnpm service:install
pnpm service:start
pnpm service:status
```

`pnpm service:install` no longer creates a Windows Service or asks for a service account password. If an older `PaseoHub` Windows Service exists, disable or delete it from an elevated PowerShell session with `sc.exe stop PaseoHub` and `sc.exe delete PaseoHub`.

## Configuration

Paseo Hub reads its local settings from `paseo-hub/config.json` in the user config directory.

On Windows, the file is:

```txt
%APPDATA%/paseo-hub/config.json
```

The default Paseo source is npm:

```json
{
  "paseo": {
    "source": "npm",
    "packageName": "paseo",
    "repository": "Myriad-Dreamin/paseo",
    "ref": "main"
  }
}
```

To install Paseo from GitHub instead, set `"source"` to `"github"` and keep the repository and ref values you want.

See [config.md](config.md) for the full configuration reference.

## Acknowledgement

Thanks to [Paseo](https://paseo.sh) and the people building it.
