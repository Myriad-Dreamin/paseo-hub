# Configuration

Paseo Hub stores its user configuration as JSON. The UI and server-side installer both read the same file through `server-side/paseo/config.mjs`.

## Config File

By default, the file is named `config.json` inside the `paseo-hub` user config directory.

| Platform | Path |
| --- | --- |
| Windows | `%APPDATA%/paseo-hub/config.json` |
| macOS | `~/Library/Application Support/paseo-hub/config.json` |
| Linux | `$XDG_CONFIG_HOME/paseo-hub/config.json`, or `~/.config/paseo-hub/config.json` when `XDG_CONFIG_HOME` is unset |

Set `PASEO_HUB_CONFIG_DIR` to override the config directory. Paseo Hub will read and write `<PASEO_HUB_CONFIG_DIR>/config.json`.

## Default Config

When no config file exists, Paseo Hub uses this default:

```json
{
  "paseo": {
    "source": "npm",
    "packageName": "paseo",
    "repository": "Myriad-Dreamin/paseo",
    "ref": "main"
  },
  "machines": [
    {
      "id": "localhost",
      "name": "localhost",
      "host": "127.0.0.1",
      "kind": "local",
      "sshHost": "",
      "forward": "",
      "daemonForwardPort": null,
      "paseoInstalled": true
    }
  ]
}
```

## Top-Level Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `paseo` | object | npm source config | Controls where the Paseo CLI is installed from. |
| `machines` | array | `localhost` machine | Machines that Paseo Hub can inspect, install to, and run commands on. |

## Paseo Source Settings

These settings live under the `paseo` object.

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `source` | `"npm"` or `"github"` | `"npm"` | Selects the install flow. `"npm"` installs a package. `"github"` clones a repository, builds it, and links the CLI. |
| `packageName` | string | `"paseo"` | Package installed by `pnpm add` when `source` is `"npm"`. Ignored by the GitHub flow. |
| `repository` | string | `"Myriad-Dreamin/paseo"` | Repository used when `source` is `"github"`. Accepts `owner/repo`, `https://...`, or `git@...` forms. |
| `ref` | string | `"main"` | Git ref fetched and checked out when `source` is `"github"`. Use a branch, tag, or commit ref accepted by `git fetch origin <ref>`. |

Npm source example:

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

GitHub source example:

```json
{
  "paseo": {
    "source": "github",
    "packageName": "paseo",
    "repository": "Myriad-Dreamin/paseo",
    "ref": "main"
  }
}
```

## Machine Settings

Each item in `machines` is normalized before it is used. Missing values are filled from related fields where possible.

| Setting | Type | Default / Normalization | Description |
| --- | --- | --- | --- |
| `id` | string | `name`, or `"machine"` if no name exists | Stable machine key. Keep it unique across `machines`. |
| `name` | string | `id` | Display name shown in the machine list and detail view. |
| `host` | string | Local machines become `"127.0.0.1"`; remote machines use `host`, then `sshHost`, then `id` | Human-readable host and fallback SSH target. |
| `kind` | `"local"` or `"ssh"` | Inferred from localhost-like values when missing | Selects command mode. Local machines use the local shell. SSH machines run commands through `ssh`. |
| `sshHost` | string | `""` for local; otherwise `sshHost`, `host`, or `id` | SSH target for remote machines. This can be an SSH config alias, `user@host`, or another target accepted by `ssh`. |
| `forward` | string | `""`, or `localhost:<port>-><sshHost>:6767` when `daemonForwardPort` is set | Optional daemon forwarding description. Empty means forwarding is off. |
| `daemonForwardPort` | number or `null` | `null` for local; parsed from `forward` for remote when omitted | Local TCP port used for SSH daemon forwarding. Valid range is `1` to `65535`; `null` disables forwarding. |
| `paseoInstalled` | boolean | `false` when omitted; default `localhost` is `true` | Whether the app should treat Paseo as already installed on the machine. Installation success sets this to `true`. |
| `workspacePath` | string | `""` | Optional remote install workspace override. Used for SSH machines; local installs use the project `.paseo` state directory. |

### Local Machine

`localhost` is the default and does not use SSH forwarding:

```json
{
  "id": "localhost",
  "name": "localhost",
  "host": "127.0.0.1",
  "kind": "local",
  "sshHost": "",
  "forward": "",
  "daemonForwardPort": null,
  "paseoInstalled": true
}
```

### SSH Machine

Remote machines run commands over SSH. Daemon forwarding is optional and off when `daemonForwardPort` is `null`.

```json
{
  "id": "build-box",
  "name": "build-box",
  "host": "build-box",
  "kind": "ssh",
  "sshHost": "build-box",
  "forward": "localhost:6767->build-box:6767",
  "daemonForwardPort": 6767,
  "paseoInstalled": false,
  "workspacePath": "$HOME/.paseo-hub/paseo"
}
```

Forward strings are parsed for local and remote ports. Paseo Hub writes the readable form:

```txt
localhost:<localPort>-><sshTarget>:6767
```

It also recognizes SSH `-L` style port text such as:

```txt
6767:127.0.0.1:6767
```

When a forward is started, Paseo Hub runs:

```sh
ssh -N -L 127.0.0.1:<localPort>:127.0.0.1:<remotePort> <sshHost>
```

If `daemonForwardPort` is set, it takes precedence for the local port. If the remote port is not parsed from `forward`, Paseo Hub uses `6767`.

## Install Workspaces

`workspacePath` only affects SSH machines. If it is empty, Paseo Hub uses these workspaces:

| Source | Local workspace | SSH workspace |
| --- | --- | --- |
| `github` | `.paseo/source/paseo` | `$HOME/.paseo-hub/paseo` |
| `npm` | `.paseo/npm` | `$HOME/.paseo-hub/npm` |

## Normalization Rules

- If `machines` is missing or empty, Paseo Hub falls back to the single `localhost` machine.
- A machine is treated as local when `kind` is `"local"`, `id` is `"localhost"`, `name` is `"localhost"`, or it has no `sshHost` and `host` is `"localhost"` or `"127.0.0.1"`.
- Local machines are normalized to `host: "127.0.0.1"`, `sshHost: ""`, `forward: ""`, and `daemonForwardPort: null`.
- Remote machines use `sshHost || host || id` as the SSH target.
- Invalid `daemonForwardPort` values are ignored unless a valid local port can be parsed from `forward`.
- Saving config through the app rewrites the file with normalized values and two-space JSON formatting.
