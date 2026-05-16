# Paseo Hub Agent Guidelines

## Product Direction

- Build Paseo Hub as a restrained developer workspace, not a marketing page.
- The first screen should be the machines dashboard, showing each machine and its state.
- Keep the UI close to Paseo's dark workbench style: narrow left rail, top repository bar, central main view, and terminal-like output.
- Do not add a right-side tab strip unless there are truly multiple open documents or views.
- The right side does not need a header for now. Keep it as a clean main view.
- Prefer removing UI over adding explanatory surfaces. If a control or panel does not help install, configure, or inspect Paseo, do not add it.

## Visual Design

- Use a dark neutral base with a single blue accent.
- Do not use green as the primary accent.
- Do not use gradients. This includes background gradients, panel gradients, gradient borders, and gradient text.
- Do not use decorative blobs, orbs, bokeh, hero artwork, or stock imagery.
- Avoid card-heavy SaaS layouts. Use 1px borders, dark panels, tab bars, and command blocks.
- Keep radii tight: 4px to 8px for most controls and panels.
- Use monospace for commands, paths, source labels, machine forward values, and terminal output.
- Preserve clear hierarchy through spacing, weight, and contrast, not through oversized headings or color variety.
- The palette should stay cool and consistent. Do not mix warm beige/brown tones or purple/blue AI-gradient styling.

## Interaction Model

- The left side is `Machines`, not `Sessions`.
- Remote machines connect through SSH commands; daemon forwarding is optional.
- The default machine is only `localhost`.
- `localhost` does not need SSH forward and should be shown as a local machine.
- All commands must execute on the selected machine: local shell for `localhost`, SSH for every non-local machine.
- Check Paseo daemon status with `paseo daemon status` and expose a restart action that runs `paseo daemon restart`.
- Clicking a machine opens that machine's detail/install view.
- A machine has:
  - `id`
  - `name`
  - `host`
  - `kind`
  - `sshHost`
  - `forward`
  - `daemonForwardPort`
  - `paseoInstalled`
- Adding a machine must support choosing a registered host from the user's SSH config.
- Adding a machine may still allow manual SSH target entry as a fallback.
- Daemon port forwarding is optional and off by default.
- When adding a remote machine, check local port occupancy starting at `6767` and offer the first free port as the suggested daemon forward port.
- When adding a machine where Paseo is not installed, ask inline whether to install Paseo.
- Do not use `window.alert()` or browser confirm dialogs. Use an inline prompt inside the app.
- Installing Paseo should run through the server-side route and show status plus terminal output in the main thread.
- Loading, success, and error states must be visible in the script runner.

## Paseo Source Configuration

- Paseo source is read from the user local config folder at `paseo-hub/config.json`.
- On Windows, this resolves to `%APPDATA%/paseo-hub/config.json`.
- The app default is npm installation:

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

- For this workspace, configure the local user config to install from GitHub:

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

- The UI may allow switching between npm and `Myriad-Dreamin/paseo@main`, but it must persist changes back to the same local config file.
- Server-side scripts must read the same config as the UI. Do not duplicate source selection logic only in the frontend.

## Implementation Rules

- Use `pnpm`, not npm.
- `pnpm install:paseo` must preserve proxy environment variables and should read the Windows system proxy when proxy env vars are not set.
- Keep the project in TypeScript: `.tsx` for React components and `.ts` for routes.
- Keep `tsconfig.json`; do not reintroduce `jsconfig.json`.
- Server-side install code belongs under `server-side/paseo`.
- The Paseo installer script is `server-side/paseo/install.ts`.
- The installer must perform the real install flow: get Paseo from the configured source, run `pnpm build`, then link the Paseo CLI.
- For non-local machines, the installer must send install, build, link, and daemon commands through SSH.
- Next.js route handlers should stay under `app/api`.
- Do not add third-party UI libraries unless they are already in `package.json` or the user explicitly asks for them.
- Keep generated runtime state out of git:
  - `.paseo`
  - `.next`
  - `node_modules`
  - `.pnpm-store`
  - `.playwright-mcp`

## Verification

- Before finishing UI work, run `pnpm build`.
- Verify the install script with `pnpm install:paseo`.
- For UI changes, check the page in a browser and confirm:
  - no console errors
  - no green accent or gradients
  - default machine is `localhost`
  - source reads from `paseo-hub/config.json`
  - install output includes `# passed` on success
