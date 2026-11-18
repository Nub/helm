#!/usr/bin/env node
// Scratch Helm servers for checking a change: never the live data, never the live service's environment.
//
//   node scratch.mjs start  [--name N] [--repo DIR] [--port P] [--lan] [--claude none|fake|PATH]
//                           [--seed empty|demo] [--copy-db FILE] [--fresh] [--build]
//   node scratch.mjs stop   [--name N]      (idempotent; kills only the process it started)
//   node scratch.mjs status [--name N]      (prints the instance as JSON; exit 1 if not running)
//   node scratch.mjs list                   (every instance this user has, running or not)
//   node scratch.mjs env    [--name N]      (shell exports for the instance: HUC_URL, HUC_TOKEN, HUC_DIR ...)
//
// Each instance lives in <tmp>/helm-ui-check-<uid>/<name>/: data/, projects/, server.log, instance.json.
// The name defaults to the basename of the git worktree you are in, so parallel agents do not collide.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, openSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo, homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(tmpdir(), `helm-ui-check-${userInfo().uid}`);

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, v] = a.slice(2).split('=', 2);
    if (v !== undefined) out[k] = v;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) out[k] = argv[++i];
    else out[k] = true;
  }
  return out;
}

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function repoOf(dir) {
  try { return git(dir, ['rev-parse', '--show-toplevel']); } catch { return null; }
}
export function defaultName() {
  const r = repoOf(process.cwd());
  return (r ? basename(r) : 'default').replace(/[^A-Za-z0-9_.-]/g, '-');
}
const instDir = (name) => join(ROOT, name);
export function readInstance(name) {
  const f = join(instDir(name), 'instance.json');
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
}

/** True only if pid is alive and is the server we started (its environment names our data dir). */
function ours(inst) {
  if (!inst?.pid) return false;
  try {
    process.kill(inst.pid, 0);
  } catch {
    return false;
  }
  try {
    const env = readFileSync(`/proc/${inst.pid}/environ`, 'utf8').split('\0');
    return env.includes(`HELM_DATA=${inst.data}`);
  } catch {
    return false;
  }
}

/** The live service's data directories: a scratch server must never use or sit inside them. */
function liveDataDirs() {
  const dirs = new Set([resolve(homedir(), '.helm')]);
  if (process.env.HELM_DATA) dirs.add(resolve(process.env.HELM_DATA));
  return [...dirs];
}

function freePort(host) {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, host, () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
}
function portFree(port, host) {
  return new Promise((res) => {
    const s = createServer();
    s.once('error', () => res(false));
    s.listen(port, host, () => s.close(() => res(true)));
  });
}

async function health(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`${url}api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Log in with the token and return the cookie header value. */
export async function login(url, token) {
  const r = await fetch(`${url}api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  if (!r.ok) throw new Error(`login failed: HTTP ${r.status}`);
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}

/** Copy a Helm database consistently (works while another server has it open in WAL mode). */
function copyDb(from, toDir) {
  const src = resolve(from);
  if (!existsSync(src)) throw new Error(`No database at ${src}`);
  mkdirSync(toDir, { recursive: true });
  const dst = join(toDir, basename(src));
  for (const f of [dst, `${dst}-wal`, `${dst}-shm`]) rmSync(f, { force: true });
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${dst.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  return dst;
}

async function start(o) {
  const name = String(o.name ?? defaultName());
  const dir = instDir(name);
  const prev = readInstance(name);
  if (ours(prev)) {
    console.log(JSON.stringify({ ...prev, note: 'already running' }, null, 2));
    return;
  }
  const repo = resolve(String(o.repo ?? repoOf(process.cwd()) ?? process.cwd()));
  if (!existsSync(join(repo, 'server', 'main.ts'))) throw new Error(`${repo} is not a Helm checkout (no server/main.ts). Pass --repo.`);
  const data = join(dir, 'data');
  const projects = join(dir, 'projects');
  for (const live of liveDataDirs()) {
    if (data === live || data.startsWith(live + '/') || live.startsWith(data + '/')) throw new Error(`Refusing: ${data} overlaps the live data dir ${live}`);
  }
  if (o.fresh) rmSync(dir, { recursive: true, force: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(projects, { recursive: true });

  if (o['copy-db']) {
    const from = resolve(String(o['copy-db']));
    if (existsSync(join(data, basename(from))) && !o.fresh) console.error(`replacing ${basename(from)} in ${data}`);
    copyDb(from, data);
  }

  if (o.build || !existsSync(join(repo, 'web', 'dist', 'index.html'))) {
    console.error('building web/dist ...');
    execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: ['ignore', 'ignore', 'inherit'] });
  }

  const lan = Boolean(o.lan);
  const host = lan ? '0.0.0.0' : '127.0.0.1';
  let port = o.port ? Number(o.port) : await freePort(host);
  if (o.port && !(await portFree(port, host))) throw new Error(`Port ${port} is in use. Omit --port to pick a free one.`);

  const claudeOpt = String(o['claude'] ?? 'none');
  const claude = claudeOpt === 'none' ? '/bin/false' : claudeOpt === 'fake' ? join(HERE, 'fake-claude.mjs') : resolve(claudeOpt);
  const token = prev?.token ?? `huc-${Math.random().toString(36).slice(2, 10)}`;

  // Built from nothing: no variable of the live service (HELM_*, live update, LAN, proxy sign-in) leaks in.
  const env = {
    PATH: process.env.PATH ?? '/run/current-system/sw/bin',
    HOME: homedir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    NODE_ENV: 'test', // liveupdate.ts then refuses to write any live-update directory (as server/testenv.ts does)
    HELM_DATA: data,
    HELM_PROJECTS: projects,
    HELM_PORT: String(port),
    HELM_HOST: host,
    HELM_TOKEN: token,
    HELM_CLAUDE_PATH: claude,
    HELM_CLAUDE_HOME: join(dir, 'claude-home'),
    HELM_FAKE_DIR: join(dir, 'fake'),
  };
  if (process.env.TZ) env.TZ = process.env.TZ;
  for (const extra of [].concat(o.env ?? [])) {
    const [k, ...v] = String(extra).split('=');
    if (/^(HELM_DATA|HELM_LIVE_UPDATE_|HELM_LAN_NO_LOGIN|HELM_TRUST_PROXY_SIGNIN)/.test(k)) throw new Error(`--env ${k} is not allowed on a scratch server`);
    env[k] = v.join('=');
  }
  mkdirSync(env.HELM_CLAUDE_HOME, { recursive: true });
  mkdirSync(env.HELM_FAKE_DIR, { recursive: true });

  const logFile = join(dir, 'server.log');
  const fd = openSync(logFile, 'a');
  const child = spawn(process.execPath, ['server/main.ts'], { cwd: repo, env, detached: true, stdio: ['ignore', fd, fd] });
  child.unref();

  const url = `http://127.0.0.1:${port}/`;
  const inst = { name, pid: child.pid, port, host, url, token, repo, dir, data, projects, log: logFile, claude, started: new Date().toISOString() };
  writeFileSync(join(dir, 'instance.json'), JSON.stringify(inst, null, 2));
  if (!(await health(url, 30000))) {
    await stop({ name, quiet: true });
    throw new Error(`Server did not become healthy in 30 s. Last log lines:\n${tail(logFile, 20)}`);
  }
  inst.cookie = await login(url, token);
  writeFileSync(join(dir, 'instance.json'), JSON.stringify(inst, null, 2));

  const headers = { cookie: inst.cookie, 'content-type': 'application/json' };
  const existing = (await (await fetch(`${url}api/projects`, { headers })).json()).projects ?? [];
  if (existing.length) inst.project = existing[0].id;
  else if (o.seed === 'demo') {
    const r = await fetch(`${url}api/projects`, { method: 'POST', headers, body: JSON.stringify({ mode: 'new', name: 'Demo' }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) console.error(`seed failed: ${JSON.stringify(j)}`);
    else inst.project = j.id;
  }
  writeFileSync(join(dir, 'instance.json'), JSON.stringify(inst, null, 2));
  console.log(JSON.stringify(inst, null, 2));
}

function tail(file, n) {
  try { return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).join('\n'); } catch { return ''; }
}

async function stop(o) {
  const name = String(o.name ?? defaultName());
  const inst = readInstance(name);
  const say = (s) => { if (!o.quiet) console.log(s); };
  if (!inst) say(`no instance "${name}"`);
  else if (!ours(inst)) say(`"${name}" is not running`);
  else {
    // The server and anything it spawned (fake agents) share the process group we created.
    try { process.kill(-inst.pid, 'SIGTERM'); } catch { try { process.kill(inst.pid, 'SIGTERM'); } catch { /* gone */ } }
    for (let i = 0; i < 40 && ours(inst); i++) await new Promise((r) => setTimeout(r, 100));
    if (ours(inst)) try { process.kill(-inst.pid, 'SIGKILL'); } catch { /* gone */ }
    say(`stopped "${name}" (pid ${inst.pid})${o.purge ? '' : `; data kept in ${inst.dir}. Add --purge to remove it.`}`);
  }
  // Only ever our own folder under ROOT, and only once nothing of ours runs from it.
  if (o.purge && !ours(inst) && existsSync(instDir(name))) {
    rmSync(instDir(name), { recursive: true, force: true });
    say(`removed ${instDir(name)}`);
  }
}

function list() {
  if (!existsSync(ROOT)) return console.log('[]');
  const rows = readdirSync(ROOT).map((n) => readInstance(n)).filter(Boolean).map((i) => ({ name: i.name, running: ours(i), url: i.url, pid: i.pid, repo: i.repo, started: i.started }));
  console.log(JSON.stringify(rows, null, 2));
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'start') return start(o);
  if (cmd === 'stop') return stop(o);
  if (cmd === 'list') return list();
  if (cmd === 'status' || cmd === 'env') {
    const name = String(o.name ?? defaultName());
    const inst = readInstance(name);
    const running = ours(inst);
    if (cmd === 'env') {
      if (!running) { console.error(`"${name}" is not running`); process.exit(1); }
      console.log(`export HUC_NAME='${inst.name}' HUC_URL='${inst.url}' HUC_TOKEN='${inst.token}' HUC_DIR='${inst.dir}' HUC_LOG='${inst.log}'`);
      return;
    }
    console.log(JSON.stringify(inst ? { ...inst, running, log_tail: tail(inst.log, 5) } : { name, running: false }, null, 2));
    if (!running) process.exit(1);
    return;
  }
  console.error('usage: scratch.mjs start|stop|status|list|env [--name N] (see SKILL.md)');
  process.exit(2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
}
