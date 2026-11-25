# Helm

Self-hosted dashboard for directing long-lived Claude agent projects from a phone or tablet. See README.md for
what it does and how to run it. This file is what an agent working on Helm itself needs to know.

## Working on this repo

- Node 24+ runs the server's TypeScript directly (type stripping). So in `server/`: no enums, no namespaces,
  no parameter properties; type-only imports must use `import type`; relative imports end in `.ts`.
- Every test and check script imports `server/testenv.ts` first: an agent's shell inherits the live server's `HELM_*`
  environment (data dir, live-update dir, LAN login), and the helper clears all of it and points at scratch data. The
  server also refuses to write the live-update directory under `NODE_ENV=test` or when it is outside its own `HELM_DATA`.
- Check your work with `npm run typecheck`, `npm test` and `npm run build`.
- To try a change, use the project skill `helm-ui-check` (`.claude/skills/helm-ui-check/SKILL.md`): scratch servers
  that cannot touch the live one, logged-in screenshots at 390 px and desktop, phone emulation and a Claude stand-in.
  Do not write your own scratch-server or browser scripts; extend the skill (`npm run check:ui-skill` checks it).
- A running Helm is deployed separately from this checkout (see README, "NixOS" and "Live update"). If you are an agent being run by it: do not edit, restart or redeploy it unless the user asks; restarting it stops every running agent, you included. Deploying is: commit, point the `release` branch at the commit (not master), and the owner presses Update now on the dashboard's Helm page. No agent starts the update. The Update panel and `/api/health` must survive on every commit `release` points at, or the next update has no button and its health check fails. Check packaging changes with `nix build`.
- With `services.helm.split` (the default) a running Helm is two units: `helm.service` (the runner, which holds the
  agents) and `helm-web.service` (the dashboard); restarting the runner stops every agent, restarting the web service
  none. An update whose build has the running runner's hash (lib/helm/runner.json, server/closure.ts) restarts only the
  web service; one that changes the runner's code (anything server/runner-main.ts imports, tools and prompts included)
  restarts it once agents are idle. `npm run check:split` and `bash nix/live-update.check.sh <pre-split rev>` check the
  split and the update paths.
- Machine-specific notes (paths, host names, how this install is deployed) live in `CLAUDE.local.md`, which is not tracked: read it if it exists, and keep such details out of tracked files.
- The Nix package (`nix/package.nix`) only sees files git tracks; new files must be added before `nix build`.
  It reads `package-lock.json` directly, so dependency changes need no hash update. Nothing at runtime may write
  next to the code (it is read-only in the Nix store): all state goes under `HELM_DATA`.

## Layout

- `server/runtime.ts`  agent sessions: start, resume, message routing, permission requests
- `server/tools.ts`    the tools agents use to report to the dashboard (worklist, previews, inbox, journal, spawn)
- `server/structure.ts` team templates and the system prompt each role gets
- `server/api.ts`      HTTP API and the live update stream
- `server/runner.ts`   the runner and the web service as two processes: commands, live updates and heartbeat through the database
- `web/src`            the React app
- `nix/package.nix`    the Nix package; `nix/module.nix` the NixOS module (`services.helm`)
- `docs/screenshots`   the README's pictures (dark theme, from a scratch copy with neutral project names)

## How it fits together

- `server/runner.ts`: Helm runs as one process (`helm`, `helm all`) or as two (`helm runner`, `helm web`; server/main.ts
  starts server/runner-main.ts and/or server/web-main.ts). The web service never loads runtime.ts: the API reaches agents
  through server/agents.ts, which the web service binds to commands in the database (`runner_commands`) and the runner
  to the runtime. The runner's live updates reach the web service through `bus_log`; its heartbeat is `runner_state`.
  Nothing outside the runner's modules may import runtime.ts, and runner-main.ts must not import the API (that would
  put the web side into the runner's hash, and every update would restart agents).
- Skew between the two: an update that does not change the runner's code leaves it running an older build than the
  dashboard, possibly for many updates. A change to what a shared table or column means, or to how the dashboard writes
  rows the runner reads (or the reverse), must therefore touch the runner's closure: bump `SKEW_EPOCH` in
  server/skew.ts, so the update restarts the runner. Example: the nested Spec sections (6f9eff6) changed how section
  rows are parented; the API writes them, the runner's tools read them. Keep write transactions short: the other
  process waits on them with its event loop stopped (server/db.ts tx).

- `server/runtime.ts`: one Claude Agent SDK `query()` per agent, fed by an input queue. The process is closed after
  `idleSeconds` and resumed from `agents.session_id` on the next message. A worker's end-of-turn result is delivered
  to its parent as a message. Permission prompts (`canUseTool`) become inbox items and wait for the answer.
- `server/tools.ts`: the in-process MCP server ("helm") every agent gets: worklist, status, previews, ask_user,
  journal, docs; managers also get spawn/message/close agent, set_doc, set_phase, set_summary.
- `server/structure.ts`: team templates and the system prompt appended for each role.
- `server/lan.ts`: the two ways in without the passphrase, as pure functions of peer address, headers and method used
  by the auth guard in `api.ts`: the local network (`HELM_LAN_NO_LOGIN`, `services.helm.lanNoLogin`) and the proxy's
  sign-in gate (`X-Helm-Signed-In` from loopback, `HELM_TRUST_PROXY_SIGNIN`, `services.helm.nginx.signedInBy`). The
  comments list the threat each check stops (proxied internet visitors, forged headers, DNS rebinding, cross-site
  requests); keep them true. nix/module.nix must set or clear `X-Helm-Signed-In` in every location it proxies.
- `server/store.ts`, `server/db.ts`: SQLite (`node:sqlite`) schema and queries. `touchProject()` is what tells
  browsers to refetch.
- `server/api.ts`: HTTP API, cookie auth from a passphrase, and the server-sent-events stream at `/api/stream`.
- `web/src`: React app. `api.ts` has the types and live-data hooks; `project.tsx` the overview, agents and
  transcript; `more.tsx` previews, history and setup; `inbox.tsx`; `ui.tsx` shared pieces and the chart renderer;
  `styles.css` all styling (light and dark from `prefers-color-scheme`).

## Conventions

- The Agent SDK's API is read from `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, not from memory.
- The UI is used mostly on an iPhone: check any layout change at 390 px wide as well as desktop. Check and screenshot
  in the dark theme only, to save time; cover the light theme only when the change is about theming or colours.
- Chart series colours in `styles.css` (`--series-N`) are a validated colour-blind-safe order; do not reorder them.
- `npm test` checks that `web/src/styles.css` parses with balanced braces; after any rebase or merge that touches it, run the test rather than trusting the merge.
