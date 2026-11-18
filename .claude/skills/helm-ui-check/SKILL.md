---
name: helm-ui-check
description: Check a Helm change in a real browser without touching the live service. Starts and stops a scratch Helm server with a safe environment (own data dir, free port, no live-service variables), takes logged-in screenshots of routes at iPhone and desktop sizes in the dark theme with a layout audit, drives phone emulation (safe areas, home-screen mode, touch, a simulated iOS keyboard), and runs a scripted Claude stand-in so agents, worklists and tasks appear without a real model. Use it whenever you change anything in web/src or the API the UI reads, before you post screenshots or ask for review.
---

# helm-ui-check

Everything you need to see a Helm change working, in four scripts with no npm dependencies (Node 24 and the
Chromium on PATH). Do not write your own scratch server or puppeteer script in /tmp; extend these instead.

Run every command from inside your worktree. `S` below is this folder's `scripts/`:

```bash
S="$(git rev-parse --show-toplevel)/.claude/skills/helm-ui-check/scripts"
```

If `node` is not found, put Helm's Node on PATH first as CLAUDE.md says.

## 1. Start a scratch server

```bash
node "$S/scratch.mjs" start --seed demo            # empty data plus one project "Demo"; Claude disabled
node "$S/scratch.mjs" start --claude fake --seed demo   # with the scripted Claude stand-in (section 4)
node "$S/scratch.mjs" start --copy-db /path/to/helm.db  # a consistent copy of a real database (safe while it is open)
```

- It prints the instance as JSON: `url`, `token`, `cookie`, `pid`, `dir`, `log`, and `project` (the first project's id).
- The name defaults to your worktree's folder name, so agents in different worktrees never collide. Pass `--name N`
  for a second server of your own. State lives in `<tmp>/helm-ui-check-<uid>/<name>/` (data, projects, server.log).
- The server runs **your worktree's code** (`--repo DIR` to change) and builds `web/dist` first if it is missing.
  After changing web code, rebuild (`npm run build`, or `start --build`) and reload: no restart needed.
  After changing server code, `stop` then `start` (the data is kept).
- Its environment is built from nothing: only PATH, HOME, LANG and its own `HELM_*`. Nothing from the live service
  leaks in (`HELM_DATA`, `HELM_LAN_NO_LOGIN`, `HELM_TRUST_PROXY_SIGNIN`, live-update variables). It refuses a data dir
  that overlaps the live one, binds 127.0.0.1 on a free port (`--lan --port 9000` to reach it from a phone on the
  home network; 9000 is open in the firewall), and `--claude none` (the default) means agents fail to start
  instead of spending real model time.
- `--fresh` wipes this instance's data first. `--env K=V` adds a variable (e.g. `HELM_DEBUG=1`).
- Starting a running instance is a no-op that prints it again.

```bash
node "$S/scratch.mjs" status          # JSON with running true/false and the last log lines; exit 1 if not running
node "$S/scratch.mjs" list            # all your instances
eval "$(node "$S/scratch.mjs" env)"   # HUC_URL, HUC_TOKEN, HUC_DIR, HUC_LOG for curl and your own scripts
node "$S/scratch.mjs" stop            # kills only the process group it started (checked by PID and data dir); idempotent
node "$S/scratch.mjs" stop --purge    # and removes its data. Do this when your task is done.
```

## 2. Screenshots at phone and desktop size

```bash
node "$S/shoot.mjs" --routes '#/,#/p/{project},#/p/{project}/spec' --devices phone,desktop
```

- Logged in with the instance's cookie, dark theme (`--theme light` only when the work is about theming).
- `{project}` becomes the first project's id. Routes are the hash routes of the app (`#/p/<id>/tasks/<task id>` ...).
- One JSON line per shot: `file`, `errors` (page exceptions and console errors; exit code 1 if any) and `audit`:
  horizontal overflow, elements wider than the screen, inputs under 16 px (iOS zooms on focus), tap targets under
  32 px, fixed and sticky layers. Read the audit as well as the picture.
- Devices: `phone` (390x844, the size CLAUDE.md asks for), `iphone15` (393x852), `promax` (430x932), `se` (375x667),
  `ipad` (820x1180), `desktop` (1280x900; reports a mouse, so `(pointer: fine)` features such as drag handles show). Phones render at their real pixel ratio, in home-screen mode with the
  notch and home-indicator safe areas applied.
- `--out DIR` (default `<instance>/shots`), `--full` for the whole page, `--wait MS` after load, `--no-audit`.
- For a before/after: take the "before" from the base commit in another worktree with `--name before`, the "after"
  from yours, same routes and devices, then post_preview kind "compare".

## 3. Phone interaction: taps, swipes, the keyboard

For anything beyond a still picture, write a short script against `browser.mjs`:

```bash
eval "$(node "$S/scratch.mjs" env)"
cat > "$HUC_DIR/phone.mjs" <<EOF
import { launch } from '$S/browser.mjs';
import { readInstance, defaultName } from '$S/scratch.mjs';
const inst = readInstance(process.env.HUC_NAME ?? defaultName());
const b = await launch();
const p = await b.page({ device: 'phone', base: inst.url, cookie: inst.cookie });
await p.go('#/p/' + inst.project);
console.log(await p.keyboard('textarea'));   // tap the field, raise a 336 px iOS keyboard, report what is visible
await p.type('Hello');                        // real input events
await p.shot(inst.dir + '/shots/keyboard.png');
await p.hideKeyboard();
await p.swipe(195, 700, 200);                 // finger drag: scrolls, and touchmove handlers see it
await p.tap('nav.tabs a[href\$="/spec"]');   // touch tap (touch events, then the click)
console.log(await p.audit(), p.errors);
await b.close();
EOF
node "$HUC_DIR/phone.mjs"
```

Page methods: `go(route)`, `waitFor(selector)`, `shot(path, {full})`, `tap(sel)`, `click(sel)`, `type(text)`,
`press('Enter')`, `swipe(x, y0, y1)`, `keyboard(sel, height)`, `hideKeyboard()`, `audit()`, `eval(fn, ...args)`,
`front()` (bring the tab forward: the others get visibilitychange to hidden), `back()` (the Back button; a page in the
back/forward cache returns with pageshow persisted), `send(cdpMethod, params)` for anything else, and `errors`.
`go()` also takes an absolute `http:`, `data:` or `about:` URL (a stand-in for another site or a sign-in gate). `b.page()` options: `device`, `theme`, `standalone`
(home-screen mode, default on for phones), `keyboard` (the simulated keyboard, default on for phones).

`keyboard()` reports `fieldVisible`, the send button's position and whether it is visible, `fieldFontPx`, and what
covers the field. The simulated keyboard shrinks `visualViewport` and leaves the layout viewport alone, as iOS does,
and scrolls the focused field above it.

**What this is not.** It is Chromium (Blink) with an iPhone's size, user agent, safe areas and touch: it catches
layout, overflow, tap-target, keyboard-band and touch-handler problems. It is not WebKit: Safari-only rendering,
`100vh`/`dvh` toolbar behaviour, rubber-band scrolling, the real keyboard's accessory bar, `position: fixed` during
keyboard scroll, and `display-mode: standalone` (not emulated; `navigator.standalone` is) still need a real iPhone.
When a change depends on those, say so in your report and ask for a check on the phone.

**Notifications.** `b.grant(url, ['notifications'])` allows them without a prompt; the app's own Enable button then
subscribes through Chromium's real push service, and the server's pushes really arrive. `b.worker(url)` attaches to
the origin's newest service worker: `(await b.worker(url)).eval(fn)` runs in it, e.g. list
`self.registration.getNotifications()`, or tap one by dispatching `new NotificationEvent('notificationclick', { notification })`
(override `ev.waitUntil` to await it). Stub `self.clients.matchAll` / `openWindow` there to act out iOS, where a
Home Screen app's worker may find no window and open start_url.

## 4. The Claude stand-in

`start --claude fake` points the server at `fake-claude.mjs`, which speaks the Agent SDK's stream-json protocol and
calls Helm's MCP tools for real, so tasks, worklists, previews, journal entries and transcripts appear as with a real
agent, at no cost. Drive it by messaging the director:

```bash
eval "$(node "$S/scratch.mjs" env)"
C=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$HUC_DIR/instance.json')).cookie)")
PR=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$HUC_DIR/instance.json')).project)")
curl -s -H "cookie: $C" -H 'content-type: application/json' -d '{"text":"DEMO: start the work."}' "${HUC_URL}api/projects/$PR/message"
```

- `DEMO ...`: the director creates an active task, spawns "Login engineer", logs a decision. The engineer works a
  five-step worklist with Read/Edit/Bash calls in its transcript (about 3.5 s per call), posts a preview and completes.
- `PLAN ...`: the director creates a planning task and asks the user a question (shows on Needs you).
- An interjection on the task is relayed to the engineer, which handles it first; a paused task makes it stop.
- Anything else: the director answers "Noted.". `--env FAKE_SPEED=0.2` makes it five times faster.
- Its log is `$HUC_DIR/fake/log.txt`. To script other behaviour, copy it and pass `--claude /path/to/your-copy.mjs`.

## When you are done

`node "$S/scratch.mjs" stop --purge`, and post the screenshots you took with post_preview.
