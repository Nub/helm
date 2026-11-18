# Helm

A self-hosted dashboard for directing long-lived Claude agent projects from a phone, tablet or desktop.
A top-level agent (Fable by default) plans and delegates to worker agents (Opus by default); each agent has
its own resumable session, worklist, progress bar and transcript. Agents post previews, keep a project
journal, and put decisions and permission requests in your inbox.

Agents run through the Claude Agent SDK using the Claude Code login of the machine Helm runs on.

## Run

    npm install
    npm run build        # builds the web app into web/dist
    npm start            # needs Node 24+ (runs the TypeScript server directly)

The server prints its URL and passphrase. Settings live in `~/.helm/config.json`
(`port`, `token`, `projectsRoot`, `idleSeconds`); data is in `~/.helm/helm.db`, `~/.helm/artifacts` and
`~/.helm/attachments` (files the user attached to Spec entries, tasks and messages).
Environment overrides: `HELM_PORT`, `HELM_HOST`, `HELM_TOKEN`, `HELM_DATA`, `HELM_PROJECTS`, `HELM_CLAUDE_PATH`,
`HELM_DEBUG=1`, `HELM_LAN_NO_LOGIN=1` and `HELM_LAN_ALLOWED_HOSTS` (see below), `HELM_TRUST_PROXY_SIGNIN` (set by the
NixOS module's `nginx.signedInBy`), `HELM_ATTACH_MAX_MB` (largest attachment, default 50; the module's
`attachmentMaxMB`) and `HELM_ATTACH_MAX_FILES` (files per upload request, default 10).

**Local network without the passphrase** (`HELM_LAN_NO_LOGIN=1`, off by default). A request gets in without
signing in only if it comes from a loopback or private address (behind a proxy on loopback: the `X-Real-IP` it
reports; forwarding headers from any other peer disqualify the request), its `Host` is this machine's own name or
address with Helm's port (or is listed in `HELM_LAN_ALLOWED_HOSTS`, comma separated, which stops DNS rebinding),
and it is not a cross-site browser request (`Origin` must match, and is required on POST/PATCH/PUT/DELETE).
Anything else falls back to the passphrase. The home page then says "Local network, no sign-in". It means
anyone on the network, and any program on the machine, can drive agents that run commands as Helm's user: use it
only on a network you trust. The rules and the threat each one addresses are in `server/lan.ts`.

For UI work run `npm run dev` and `npm run dev:web` side by side.

## Layout

- `server/runtime.ts`  agent sessions: start, resume, message routing, permission requests
- `server/tools.ts`    the tools agents use to report to the dashboard (worklist, previews, inbox, journal, spawn)
- `server/structure.ts` team templates and the system prompt each role gets
- `server/api.ts`      HTTP API and the live update stream
- `web/src`            the React app

- `nix/package.nix`    the Nix package; `nix/module.nix` the NixOS module (`services.helm`)

## NixOS

`flake.nix` exposes `packages.<system>.default` (x86_64-linux, aarch64-linux) and `nixosModules.default`.
The package builds the web app and ships the server, `web/dist` and production `node_modules`; `bin/helm` runs
`node server/main.ts`. Dependencies are fetched by their `package-lock.json` integrity hashes (`importNpmLock`),
so there is no `npmDepsHash` to refresh when dependencies change. The SDK's prebuilt Claude binaries are left
out (they don't run on NixOS); Helm uses `HELM_CLAUDE_PATH`.

    # flake inputs
    helm.url = "git+ssh://...";   # or git+file:///path/to/helm
    helm.inputs.nixpkgs.follows = "nixpkgs";

    # configuration
    imports = [ inputs.helm.nixosModules.default ];
    services.helm = {
      enable = true;
      user = "alice";             # agents run as this user, in its home, with its Claude login
      host = "0.0.0.0";           # default 127.0.0.1
      nginx = { enable = true; domain = "helm.example.com"; };
    };

It runs as a system service (`systemctl status helm`, `journalctl -u helm`) as that user, with data in
`~/.helm` by default. Options: `port`, `host`, `dataDir`, `projectsRoot`, `claudePath`, `extraPath` (tools for
agents), `environment`, `openFirewall`, `lanNoLogin` and `lanAllowedHosts` (above), and for the proxy `nginx.signedInBy` (skip the passphrase for
requests that passed the gate in `nginx.locationExtraConfig`: nginx sends `X-Helm-Signed-In: 1` there and clears it
everywhere else, and Helm believes it only from loopback), `nginx.useACMEHost`, `nginx.extraConfig` (server
level, e.g. a CDN's real-IP rules) and `nginx.locationExtraConfig` (e.g. an `auth_request` gate). The proxy
streams `/api/stream` unbuffered and limits `/api/login` to 5 a minute per address. Behind HTTPS the session
cookie is marked `Secure` (from `X-Forwarded-Proto`).

### Live update

With `services.helm.liveUpdate = { enable = true; repo = "/path/to/helm"; }` (`ref` defaults to `release`), Helm
is updated without a system rebuild:

- `helm.service` starts whatever `<dataDir>/live/current` points at, or the packaged build when there is none.
- `systemctl start helm-update` (or **Update now** on the dashboard's Helm page, reached from "Helm <rev>" at the
  foot of the sidebar or project list) builds `git+file://<repo>?ref=<ref>#default` as the service user into
  `<dataDir>/live/generations/gen-N` (nix out-links, so GC roots; the last `keep` = 5 are kept), switches
  `current` to it, restarts Helm, and waits up to `healthTimeout` (60 s) for `/` and `/api/health` to answer with the
  new revision. If they do not, it switches back and restarts again. A failed build restarts nothing; building
  runs beside the live server.
- `systemctl start helm-rollback` (or **Roll back**) switches to the previous build the same way.
- Each stage is written to `<dataDir>/live/status.json`, which the dashboard shows; the page survives the restart
  and reloads itself. `journalctl -u helm-update` has the full story.
- Agents that were mid-turn when a planned update or rollback restarted Helm are resumed with a note once the new
  server is healthy. After a crash, a manual restart or a rolled-back update they stay Stopped.
- A polkit rule lets the service user start exactly those two units and restart `helm.service`, nothing else. That
  means every agent can replace and restart Helm (they could already run any code as that user).
- Changes to the module or the NixOS config (options, nginx, PATH packages) still need `nixos-rebuild switch`. To get
  out of a bad state by hand: `rm <dataDir>/live/current` and restart Helm, which runs the packaged build again.

## Deploying a change

With live update on, point the flake input at a `release` branch of your checkout, so work in progress on the main
branch is never deployed by accident. Deploying is then:

    git branch -f release <commit>
    # then Update now on the dashboard's Helm page, or:
    systemctl start helm-update      # no sudo needed (polkit); follow it with journalctl -fu helm-update

Changes to the module itself (nix/module.nix) or to your NixOS configuration still need a system rebuild, from a
terminal (not from the dashboard: the switch restarts Helm and stops every agent).
