import { spawn } from 'node:child_process';
import { createWriteStream, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { join, posix } from 'node:path';
import { Readable } from 'node:stream';
import { ARTIFACT_DIR } from './config.ts';
import { all, db, get, newId, now, run } from './db.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';
import { getSetting } from './settings.ts';
import { sendToAgent } from './agents.ts';
import { clockText } from './clock.ts';

/**
 * Work on a host runs in its own clean workspace (no containers, nothing installed on the host):
 *
 * - A workspace per job: a fresh folder under one Helm-owned root on the host (the host's work_root, default
 *   ~/.helm-work), <root>/<project>/<job>-<n>, with src/ (the project's code at a stated commit, from `git archive`
 *   piped over SSH: nothing relies on what the host already has), home/ and tmp/ (empty), out/ (for results).
 * - A build slot instead, when the host declares build folders to keep (work_keep, e.g. `CARGO_TARGET_DIR=target`) and
 *   the project has not turned slots off (setting "build_slots"): one fixed folder per project, <root>/<project>/slot,
 *   reused by every job. Its src/ is reset to the job's commit file by file (unchanged files keep their times, so
 *   incremental builds see only what changed), the kept folders stay, home/, tmp/ and out/ start empty. One job at a
 *   time: a second is refused until the first ends, and its agent is told when the slot frees.
 * - A clean environment: commands run through the workspace's own wrapper (.helm/run, or .helm/run.ps1 on Windows): no
 *   login shell, no profile or rc file, a minimal environment plus what the host entry declares (PATH additions, a
 *   setup line, cache variables, kept folders).
 * - Caches are a choice: a host may declare cache variables (one per line, e.g. CARGO_HOME); each is set to
 *   <root>/cache/<project>/<variable>, shared across runs. Everything else starts empty.
 * - Results come back and the rest goes: endWorkspace copies the named outputs to this machine and removes the
 *   workspace (a slot stays), or keeps it 24 h when the job failed; the daily sweep removes what is left and slots
 *   unused for SLOT_IDLE_MS. Nothing outside the root is ever deleted: every path is checked here (confined) and
 *   again by the remote script, with links resolved or refused, before anything is removed.
 *
 * Platforms (hosts.platform): linux and macos share the bash scripts, written for bash 3.2 and BSD tools (no GNU-only
 * flags, no /run/current-system on macOS); windows gets PowerShell scripts with the same guarantees, sent encoded so
 * cmd.exe or PowerShell as the login shell never parses them.
 *
 * The transport (ssh, or bash for this machine) is one function, replaceable in checks (setTransport).
 */

db.exec(`CREATE TABLE IF NOT EXISTS host_workspaces (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  bytes INTEGER,
  created_at INTEGER NOT NULL,
  ended_at INTEGER,
  removed_at INTEGER,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS host_workspaces_host ON host_workspaces(host_id, state);
CREATE TABLE IF NOT EXISTS slot_waits (
  host_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (host_id, project_id, agent_id)
);`);
const addCol = (table: string, c: string, decl: string) => {
  if ((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((x) => x.name === c)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} ${decl}`);
  } catch (err) {
    // The runner and the web service may both start at once: the other one adding it first is fine.
    if (!/duplicate column/.test(String((err as Error).message))) throw err;
  }
};
for (const [c, decl] of [
  ['work_root', "TEXT NOT NULL DEFAULT '~/.helm-work'"], ['work_env', "TEXT NOT NULL DEFAULT ''"], ['work_setup', "TEXT NOT NULL DEFAULT ''"], ['work_caches', "TEXT NOT NULL DEFAULT ''"],
  // linux, macos or windows: which scripts the host gets.
  ['platform', "TEXT NOT NULL DEFAULT 'linux'"],
  // Build folders a slot keeps between jobs, one per line: `target`, or `CARGO_TARGET_DIR=target` to point a variable at it.
  ['work_keep', "TEXT NOT NULL DEFAULT ''"],
] as const) addCol('hosts', c, decl);
addCol('host_workspaces', 'slot', 'INTEGER NOT NULL DEFAULT 0');

const HOUR = 3600_000;
export const KEEP_FAILED_MS = 24 * HOUR;
/** A slot nobody used for this long is removed by the sweep (its kept build folders can be large). */
export const SLOT_IDLE_MS = 14 * 24 * HOUR;
/** Paths Helm writes into scripts: plain characters only, so nothing in them is shell syntax. */
const SAFE = /^[A-Za-z0-9._/~-]+$/;
export const PLATFORMS = ['linux', 'macos', 'windows'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** The host's platform; this machine's is what Node runs on. */
export function platformOf(host: Row): Platform {
  if (host.is_local) return process.platform === 'darwin' ? 'macos' : 'linux';
  return (PLATFORMS as readonly string[]).includes(host.platform) ? host.platform : 'linux';
}

// ---------- paths: everything stays under the root ----------

/** Why a workspace root cannot be used, or null: absolute or ~/…, at least one folder below / or ~, plain characters. */
export function rootError(root: string): string | null {
  const r = String(root ?? '').trim();
  if (!SAFE.test(r)) return 'The workspace root may use letters, digits, ., _, -, / and a leading ~ only.';
  if (!(r.startsWith('/') || r.startsWith('~/'))) return 'The workspace root starts with / or ~/.';
  const norm = posix.normalize(r.replace(/^~\//, '/HOME/'));
  if (r.split('/').includes('..') || norm.split('/').filter(Boolean).length < 2) return 'The workspace root must be a folder of its own, at least one level down (e.g. ~/.helm-work).';
  if (r.includes('~', 1)) return 'Only a leading ~ is allowed.';
  return null;
}
/** A path in a shell script: ~/ becomes "$HOME"/, the rest is quoted. Only for paths that passed SAFE. */
export const shellPath = (p: string) => (p.startsWith('~/') ? `"$HOME"/'${p.slice(2)}'` : `'${p}'`);
/** The same in PowerShell: ~/ is under $HOME (the user's profile folder on Windows). */
export const psPath = (p: string) => (p.startsWith('~/') ? `(Join-Path $HOME '${p.slice(2)}')` : `'${p}'`);

/** Whether `path` is a workspace or cache folder strictly under `root` (two levels or more), with nothing odd in it. */
export function confined(root: string, path: string): boolean {
  if (rootError(root) || !SAFE.test(path) || path.split('/').includes('..') || path.split('/').includes('.')) return false;
  const r = root.replace(/\/+$/, '');
  if (!path.startsWith(`${r}/`)) return false;
  const rest = path.slice(r.length + 1).split('/').filter(Boolean);
  return rest.length >= 2;
}
const slug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job';
const rootOf = (host: Row) => String(host.work_root || '~/.helm-work').replace(/\/+$/, '');

/** Cache variables a host declares: one name per line (shell variable names only). */
export function cacheVars(text: string): string[] {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(l));
}
/** PATH additions a host declares: one folder per line. */
export function pathAdditions(text: string): string[] {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => SAFE.test(l) && (l.startsWith('/') || l.startsWith('~/')));
}
/** One kept build folder of a slot: a plain relative path inside src/, and the variable pointed at it, if any. */
export type Keep = { path: string; variable: string | null };
const KEEP_LINE = /^(?:([A-Za-z_][A-Za-z0-9_]*)=)?([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/;
/** The build folders a host's slots keep: `target` or `CARGO_TARGET_DIR=target`, one per line. Bad lines are left out. */
export function keepFolders(text: string): Keep[] {
  return String(text ?? '').split('\n').map((l) => l.trim()).map((l) => KEEP_LINE.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .filter((m) => !m[2].split('/').some((s) => s === '.' || s === '..' || s === '.git' || s === '.helm'))
    .map((m) => ({ path: m[2], variable: m[1] ?? null }));
}
/** Whether a line of work_keep is acceptable (for the host form). */
export const keepLineOk = (line: string) => keepFolders(line).length === 1;

// ---------- the transport ----------

export type Transport = (host: Row, script: string, stdin?: NodeJS.ReadableStream | null, stdoutTo?: NodeJS.WritableStream | null) => Promise<{ code: number; out: string; err: string }>;

/** PowerShell's -EncodedCommand: UTF-16LE in base64, so no shell on the way parses the script. */
export const encodePs = (script: string) => Buffer.from(script, 'utf16le').toString('base64');
const PS = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand';
/** Runs the script it is sent on stdin: long scripts go that way, past the command line's length limit. */
const PS_BOOT = '$s = [Console]::In.ReadToEnd(); & ([scriptblock]::Create($s)); exit $LASTEXITCODE';

/**
 * How a script reaches the host. bash hosts: `exec bash --noprofile --norc -c '<script>'` (the login shell only sees a
 * quoted string). Windows hosts: `powershell -NoProfile … -EncodedCommand`, the script itself when stdin carries data
 * (kept short), else a small reader of the script sent on stdin.
 */
export function remoteCommand(host: Row, script: string, hasData: boolean): { command: string; stdin: string | null } {
  if (platformOf(host) === 'windows') return hasData ? { command: `${PS} ${encodePs(script)}`, stdin: null } : { command: `${PS} ${encodePs(PS_BOOT)}`, stdin: script };
  return { command: `exec bash --noprofile --norc -c ${quote(script)}`, stdin: null };
}

/**
 * ssh to the host (bash for this machine), running `script` as remoteCommand says.
 * `extra`: ssh options put before the host (checks pass -F with their own config).
 */
export const sshTransport = (extra: string[] = []): Transport => (host, script, stdin, stdoutTo) =>
  new Promise((resolve) => {
    const remote = remoteCommand(host, script, !!stdin);
    const input = stdin ?? (remote.stdin != null ? Readable.from([remote.stdin]) : null);
    const args = host.is_local
      ? ['--noprofile', '--norc', '-c', script]
      : [...extra, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-T', ...(host.port ? ['-p', String(host.port)] : []), '--', host.ssh_target, remote.command];
    const child = spawn(host.is_local ? 'bash' : 'ssh', args, { stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    if (stdoutTo) child.stdout!.pipe(stdoutTo);
    else child.stdout!.on('data', (d) => (out = (out + d).slice(-20000)));
    child.stderr!.on('data', (d) => (err = (err + d).slice(-8000)));
    if (input && child.stdin) {
      child.stdin.on('error', () => {});
      input.pipe(child.stdin);
    }
    child.on('error', (e) => resolve({ code: 127, out, err: String(e) }));
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
export let transport: Transport = sshTransport();
export function setTransport(t: Transport) {
  transport = t;
}
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------- the bash scripts (linux, macos) ----------

/** A path inside double quotes in a script (SAFE characters only): ~/ becomes $HOME/, expanded when the script runs. */
const dq = (p: string) => `"${p.startsWith('~/') ? `$HOME/${p.slice(2)}` : p}"`;

/** The system folders on PATH besides the host's additions. macOS has no /run/current-system (that is NixOS). */
const systemPath = (platform: Platform) => (platform === 'macos' ? ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'] : ['/run/current-system/sw/bin', '/usr/local/bin', '/usr/bin', '/bin']);
/** macOS has no C.UTF-8 locale on older releases; en_US.UTF-8 is always there. */
const locale = (platform: Platform) => (platform === 'macos' ? 'en_US.UTF-8' : 'C.UTF-8');

/**
 * The run wrapper written into a workspace: `.helm/run "<command>"` runs the command in src/ with env -i (HOME and
 * TMPDIR the workspace's own, PATH the host's additions and the system folders, the declared cache variables and kept
 * folders), under bash with no profile or rc file, after the host's setup line (.helm/setup.sh).
 */
export function wrapperScript(host: Row, projectSlug: string, keep: Keep[] = []): string {
  const platform = platformOf(host);
  const root = rootOf(host);
  const path = [...pathAdditions(host.work_env), ...systemPath(platform)];
  const caches = cacheVars(host.work_caches).map((v) => `${v}=${dq(`${root}/cache/${projectSlug}/${v.toLowerCase()}`)}`);
  const kept = keep.filter((k) => k.variable).map((k) => `${k.variable}="$WS/src/${k.path}"`);
  return [
    '#!/usr/bin/env bash',
    "# Helm's clean runner for this workspace: no login shell, no profile, a minimal environment (server/hostwork.ts).",
    '# Usage: the command on stdin (so the login shell on the host, whatever it is, never parses it):',
    "#   ssh <host> <workspace>/.helm/run <<'EOF'   ...   EOF       (or, locally: .helm/run \"<command>\")",
    'WS="$(cd "$(dirname "$0")/.." && pwd)"',
    'if [ "$#" -eq 0 ]; then CMD="$(cat)"; else CMD="$*"; fi',
    `exec env -i HOME="$WS/home" USER="$(id -un)" LOGNAME="$(id -un)" LANG=${locale(platform)} TERM=dumb TMPDIR="$WS/tmp" PATH=${path.map(dq).join(':').replace(/":"/g, ':')} HELM_WORKSPACE="$WS" HELM_CMD="$CMD" ${[...caches, ...kept].join(' ')} \\`,
    `  bash --noprofile --norc -c 'cd "$HELM_WORKSPACE/src" || exit 1; . "$HELM_WORKSPACE/.helm/setup.sh"; eval "$HELM_CMD"' </dev/null`,
    '',
  ].join('\n');
}

/** Checks every folder on the way is a real folder under the real root (not a symlink a job left), making it if missing. */
const BASH_INROOT = 'inroot() { local d="$1"; if [ -L "$d" ]; then echo "refused: $d is a symlink" >&2; exit 4; fi; mkdir -p "$d"; local r; r="$(cd "$d" && pwd -P)"; case "$r" in "$RR"/*) ;; *) echo "refused: $d is outside the root once links are resolved" >&2; exit 4;; esac; }';

export type Prep = { root: string; pslug: string; ws: string; slot: boolean; wrapper: string; setup: string; caches: string[] };

export function bashPrep(p: Prep): string {
  return [
    'set -e',
    `WS=${shellPath(p.ws)}`,
    // Before writing anything: every folder on the way under the root (the project's, the cache's) must be a real
    // folder under the real root, not a symlink a job left to somewhere else (see bashRemove).
    `ROOT=${shellPath(p.root)}`,
    'mkdir -p "$ROOT"',
    'RR="$(cd "$ROOT" && pwd -P)"',
    BASH_INROOT,
    `inroot "$ROOT"/'${p.pslug}'`,
    ...(p.slot
      ? [
          // The slot is reused: the folders a job may leave anything in start empty again; src/ is reset after the copy.
          'inroot "$WS"',
          'inroot "$WS/.helm"',
          'inroot "$WS/src"',
          'for d in home tmp out .helm/incoming; do rm -rf -- "$WS/$d"; done',
          'mkdir -p "$WS/home" "$WS/tmp" "$WS/out" "$WS/.helm/incoming"',
        ]
      : ['if [ -e "$WS" ] || [ -L "$WS" ]; then echo "exists" >&2; exit 3; fi', 'inroot "$WS"', 'mkdir -p "$WS/src" "$WS/home" "$WS/tmp" "$WS/out" "$WS/.helm"']),
    ...(p.caches.length ? ['inroot "$ROOT/cache"', `inroot "$ROOT/cache/${p.pslug}"`] : []),
    ...p.caches.map((c) => `inroot ${shellPath(c)}`),
    `cat > "$WS/.helm/run" <<'HELM_RUN_EOF'\n${p.wrapper}HELM_RUN_EOF`,
    `cat > "$WS/.helm/setup.sh" <<'HELM_SETUP_EOF'\n${p.setup.replace(/HELM_SETUP_EOF/g, '')}\nHELM_SETUP_EOF`,
    'chmod +x "$WS/.helm/run"',
    'cd "$WS" && pwd',
  ].join('\n');
}

/** find's prune clause for the kept folders (relative to src/), or nothing. */
const pruneClause = (keep: Keep[]) => (keep.length ? `\\( ${keep.map((k) => `-path './${k.path}'`).join(' -o ')} \\) -prune -o ` : '');

/**
 * The code into the workspace from the tar on stdin. A fresh workspace unpacks into src/. A slot unpacks into
 * .helm/incoming (times set to now, so a changed file is always newer than the last build) and then src/ is made
 * exactly the commit: what is not in it goes (kept folders aside), links in src/ go, files that differ or are new are
 * moved in, identical files stay untouched with their old times.
 */
export function bashUnpack(ws: string, slot: boolean, keep: Keep[] = []): string {
  if (!slot) return `tar -xf - -C ${shellPath(ws)}/src`;
  const prune = pruneClause(keep);
  return [
    'set -e',
    `WS=${shellPath(ws)}`,
    'IN="$WS/.helm/incoming"',
    'LIST="$WS/.helm/list"',
    'tar -x -m -f - -C "$IN"',
    'cd "$WS/src"',
    // 1. Out of src/: links, what the commit does not have, and what changes between file and folder.
    `find . -mindepth 1 ${prune}-print0 > "$LIST"`,
    'while IFS= read -r -d "" f; do',
    '  [ -e "$f" ] || [ -L "$f" ] || continue',
    '  if [ -L "$f" ] || { [ ! -e "$IN/$f" ] && [ ! -L "$IN/$f" ]; }; then rm -rf -- "$f"; continue; fi',
    '  if [ -d "$f" ]; then { [ -L "$IN/$f" ] || [ ! -d "$IN/$f" ]; } && rm -rf -- "$f"; continue; fi',
    '  if [ -d "$IN/$f" ] && [ ! -L "$IN/$f" ]; then rm -f -- "$f"; fi',
    'done < "$LIST"',
    // 2. Into src/: new and changed files and links; identical ones (same bytes, same executable bit) stay as they are.
    'cd "$IN"',
    `find . -mindepth 1 ${prune}\\( -type f -o -type l \\) -print0 > "$LIST"`,
    'while IFS= read -r -d "" f; do',
    '  d="$WS/src/$f"',
    '  if [ ! -L "$f" ] && [ -f "$d" ] && [ ! -L "$d" ] && cmp -s "$f" "$d"; then',
    '    a=0; b=0; [ -x "$f" ] && a=1; [ -x "$d" ] && b=1',
    '    [ "$a" = "$b" ] && continue',
    '  fi',
    '  mkdir -p "$(dirname "$d")"',
    '  rm -rf -- "$d"',
    '  mv -f -- "$f" "$d"',
    'done < "$LIST"',
    'cd "$WS"',
    'rm -rf -- "$IN" "$LIST"',
    'mkdir -p "$IN"',
  ].join('\n');
}

/** rm -rf of one folder under the root, checked again on the host with links resolved. */
export function bashRemove(root: string, path: string): string {
  return [
    `ROOT=${shellPath(root)}`,
    `P=${shellPath(path)}`,
    'case "$P" in "$ROOT"/*/*) ;; *) echo "refused" >&2; exit 4;; esac',
    'case "$P" in *..*) echo "refused" >&2; exit 4;; esac',
    // The text says it is under the root; the files must too: a job runs as the same user and could have swapped a
    // folder on the way for a symlink to somewhere else. Resolve the real root and the real parent of P, refuse a
    // symlink at P, and remove only a real directory strictly under the real root.
    '[ -d "$ROOT" ] || exit 0',
    'RR="$(cd "$ROOT" && pwd -P)" || exit 4',
    'if [ -L "$P" ]; then echo "refused: a symlink" >&2; exit 4; fi',
    '[ -e "$P" ] || exit 0',
    'if [ ! -d "$P" ]; then echo "refused: not a folder" >&2; exit 4; fi',
    'PR="$(cd "$(dirname "$P")" && pwd -P)" || exit 4',
    'RP="$PR/$(basename "$P")"',
    'case "$RP" in "$RR"/*/*) ;; *) echo "refused: outside the root once links are resolved" >&2; exit 4;; esac',
    'rm -rf -- "$RP"',
  ].join('\n');
}

/** Folders two levels under the root, not the cache, older than a day: ./<project>/<name>, one per line (BSD find too). */
export const bashStale = (root: string) => `ROOT=${shellPath(root)}; [ -d "$ROOT" ] || exit 0; cd "$ROOT" && find . -mindepth 2 -maxdepth 2 -type d -mmin +1440 ! -path './cache/*' -print`;
export const bashSizes = (paths: string[]) => paths.map((p) => `du -sk ${shellPath(p)} 2>/dev/null | cut -f1 || echo -`).join('\n');
export const bashPack = (ws: string, outputs: string[]) => `cd ${shellPath(ws)} && tar -cf - ${outputs.map((o) => quote(o)).join(' ')}`;

// ---------- the PowerShell scripts (windows) ----------

/**
 * Shared PowerShell functions: Fail (message and exit code), IsLink (a reparse point: symlink or junction), InRoot (walk
 * from the root down a relative path, refusing any link on the way, making missing folders), RemoveTree (delete a
 * folder's contents without ever following a link: a link is removed as itself). Written for Windows PowerShell 5.1
 * and PowerShell 7 alike (no ?? or ?., no $IsWindows).
 */
const PS_LIB = String.raw`$ErrorActionPreference = 'Stop'
function Fail($code, $msg) { [Console]::Error.WriteLine($msg); [Environment]::Exit($code) }
$RP = [IO.FileAttributes]::ReparsePoint
function IsLink($p) { try { return (([IO.File]::GetAttributes($p) -band $RP) -ne 0) } catch { return $false } }
function Exists($p) { return ([IO.File]::Exists($p) -or [IO.Directory]::Exists($p) -or (IsLink $p)) }
function InRoot($base, $rel, $make) {
  $cur = $base
  foreach ($s in $rel.Split('/')) {
    if (-not $s) { continue }
    $cur = [IO.Path]::Combine($cur, $s)
    if (IsLink $cur) { Fail 4 "refused: $cur is a link" }
    if (-not (Exists $cur)) { if ($make) { [void][IO.Directory]::CreateDirectory($cur) } else { return $null } }
    elseif (-not [IO.Directory]::Exists($cur)) { Fail 4 "refused: $cur is not a folder" }
  }
  return $cur
}
function RemoveEntry($e) {
  $a = [IO.File]::GetAttributes($e)
  if (($a -band $RP) -ne 0) { if (($a -band [IO.FileAttributes]::Directory) -ne 0) { [IO.Directory]::Delete($e) } else { [IO.File]::Delete($e) } }
  elseif (($a -band [IO.FileAttributes]::Directory) -ne 0) { RemoveTree $e; [IO.Directory]::Delete($e) }
  else { [IO.File]::SetAttributes($e, [IO.FileAttributes]::Normal); [IO.File]::Delete($e) }
}
function RemoveTree($d) { foreach ($e in [IO.Directory]::GetFileSystemEntries($d)) { RemoveEntry $e } }
`;

/** The root, made if missing, and its full path. */
const psRoot = (root: string) => `$ROOT = ${psPath(root)}\n[void][IO.Directory]::CreateDirectory($ROOT)\n$RR = [IO.Path]::GetFullPath($ROOT)\n`;
const relOf = (root: string, path: string) => path.slice(root.length + 1);
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
/** Writes a file from base64 (UTF-8), so its text is never PowerShell syntax here. */
const psWrite = (target: string, text: string) => `[IO.File]::WriteAllText(${target}, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(text)}')))`;

/**
 * The Windows run wrapper (.helm/run.ps1): the command on stdin (or as arguments) is written to .helm/cmd.ps1 after the
 * host's setup (.helm/setup.ps1), and run by a new PowerShell with -NoProfile, in src/, with an environment built from
 * nothing: the few variables Windows itself needs, HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP and TMP inside the
 * workspace, PATH the host's additions and the system folders, the cache variables and kept folders.
 */
export function psWrapper(host: Row, projectSlug: string, keep: Keep[] = []): string {
  const root = rootOf(host);
  const adds = pathAdditions(host.work_env).map(psPath);
  const caches = cacheVars(host.work_caches).map((v) => `$e['${v}'] = ${psPath(`${root}/cache/${projectSlug}/${v.toLowerCase()}`)}`);
  const kept = keep.filter((k) => k.variable).map((k) => `$e['${k.variable}'] = [IO.Path]::Combine($WS, 'src', '${k.path}')`);
  return [
    "# Helm's clean runner for this workspace: no profile, an environment built from nothing (server/hostwork.ts).",
    "# Usage: ssh <host> powershell -NoProfile -ExecutionPolicy Bypass -File <workspace>/.helm/run.ps1, the command on stdin.",
    "$ErrorActionPreference = 'Stop'",
    '$WS = Split-Path -Parent $PSScriptRoot',
    'if ($args.Count) { $cmd = $args -join " " } else { $cmd = [Console]::In.ReadToEnd() }',
    "$file = [IO.Path]::Combine($WS, '.helm', 'cmd.ps1')",
    // Errors stop the command (a command that does not exist would otherwise be skipped and the run exit 0).
    "[IO.File]::WriteAllText($file, \"`$ErrorActionPreference = 'Stop'`n. ([IO.Path]::Combine(`$env:HELM_WORKSPACE, '.helm', 'setup.ps1'))`n\" + $cmd + \"`nif (`$LASTEXITCODE) { exit `$LASTEXITCODE }`n\")",
    '$psi = New-Object Diagnostics.ProcessStartInfo',
    '$psi.FileName = (Get-Process -Id $PID).Path',
    '$psi.Arguments = \'-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "\' + $file + \'"\'',
    '$psi.UseShellExecute = $false',
    "$psi.WorkingDirectory = [IO.Path]::Combine($WS, 'src')",
    '$e = $psi.EnvironmentVariables',
    '$e.Clear()',
    "foreach ($k in 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData', 'CommonProgramFiles') { $v = [Environment]::GetEnvironmentVariable($k); if ($v) { $e[$k] = $v } }",
    "$H = [IO.Path]::Combine($WS, 'home')",
    "$T = [IO.Path]::Combine($WS, 'tmp')",
    "$e['HOME'] = $H; $e['USERPROFILE'] = $H; $e['APPDATA'] = [IO.Path]::Combine($H, 'AppData', 'Roaming'); $e['LOCALAPPDATA'] = [IO.Path]::Combine($H, 'AppData', 'Local')",
    "$e['TEMP'] = $T; $e['TMP'] = $T; $e['TMPDIR'] = $T; $e['HELM_WORKSPACE'] = $WS",
    '$sys = @()',
    "if ($env:SystemRoot) { $sys = @([IO.Path]::Combine($env:SystemRoot, 'System32'), $env:SystemRoot, [IO.Path]::Combine($env:SystemRoot, 'System32', 'Wbem'), [IO.Path]::Combine($env:SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0'), [IO.Path]::Combine($env:SystemRoot, 'System32', 'OpenSSH')) }",
    // Not Windows (the checks run it with PowerShell 7 on Linux): the usual system folders.
    "if ([IO.Path]::DirectorySeparatorChar -eq '/') { $sys = @('/usr/local/bin', '/usr/bin', '/bin'); foreach ($k in 'LD_LIBRARY_PATH', 'DOTNET_ROOT') { $v = [Environment]::GetEnvironmentVariable($k); if ($v) { $e[$k] = $v } } }",
    `$e['PATH'] = ((@(${adds.join(', ')}) + $sys) | Where-Object { $_ }) -join [IO.Path]::PathSeparator`,
    ...caches,
    ...kept,
    '$p = [Diagnostics.Process]::Start($psi)',
    '$p.WaitForExit()',
    'exit $p.ExitCode',
    '',
  ].join('\n');
}

export function psPrep(p: Prep): string {
  const rel = relOf(p.root, p.ws);
  return [
    PS_LIB,
    psRoot(p.root),
    ...(p.slot
      ? [
          `$WS = InRoot $RR '${rel}' $true`,
          "[void](InRoot $WS '.helm' $true); [void](InRoot $WS 'src' $true)",
          "foreach ($d in 'home', 'tmp', 'out', '.helm/incoming') { $x = InRoot $WS $d $false; if ($x) { RemoveTree $x; [IO.Directory]::Delete($x) } }",
          "foreach ($d in 'home', 'tmp', 'out', '.helm/incoming') { [void](InRoot $WS $d $true) }",
        ]
      : [
          `[void](InRoot $RR '${p.pslug}' $true)`,
          `if (Exists ([IO.Path]::Combine($RR, '${rel}'))) { Fail 3 'exists' }`,
          `$WS = InRoot $RR '${rel}' $true`,
          "foreach ($d in 'src', 'home', 'tmp', 'out', '.helm') { [void](InRoot $WS $d $true) }",
        ]),
    ...p.caches.map((c) => `[void](InRoot $RR '${relOf(p.root, c)}' $true)`),
    psWrite("[IO.Path]::Combine($WS, '.helm', 'run.ps1')", p.wrapper),
    psWrite("[IO.Path]::Combine($WS, '.helm', 'setup.ps1')", p.setup),
    'Write-Output $WS',
  ].join('\n');
}

/** Copies stdin to a file in the workspace, then unpacks it (fresh: into src/; slot: incoming, then the same reset as bashUnpack). */
export function psUnpack(root: string, ws: string, slot: boolean, keep: Keep[] = []): string {
  const head = [
    PS_LIB,
    psRoot(root),
    `$WS = InRoot $RR '${relOf(root, ws)}' $false`,
    "if (-not $WS) { Fail 4 'no workspace' }",
    "$TAR = [IO.Path]::Combine($WS, '.helm', 'code.tar')",
    '$in = [Console]::OpenStandardInput(); $f = [IO.File]::Create($TAR); $in.CopyTo($f); $f.Close()',
  ];
  if (!slot) return [...head, "& tar -x -f $TAR -C ([IO.Path]::Combine($WS, 'src'))", 'if ($LASTEXITCODE) { Fail $LASTEXITCODE "tar failed" }', '[IO.File]::Delete($TAR)'].join('\n');
  return [
    ...head,
    `$KEEP = @(${keep.map((k) => `'${k.path}'`).join(', ')})`,
    "$IN = [IO.Path]::Combine($WS, '.helm', 'incoming'); $S = [IO.Path]::Combine($WS, 'src')",
    '& tar -x -m -f $TAR -C $IN',
    'if ($LASTEXITCODE) { Fail $LASTEXITCODE "tar failed" }',
    '[IO.File]::Delete($TAR)',
    'function Join2($a, $b) { if ($a) { return "$a/$b" } else { return $b } }',
    'function IsDir($p) { return ([IO.Directory]::Exists($p) -and -not (IsLink $p)) }',
    // 1. Out of src/: links, what the commit does not have, what changes between file and folder.
    'function Prune($src, $inc, $rel) {',
    '  foreach ($e in [IO.Directory]::GetFileSystemEntries($src)) {',
    '    $n = [IO.Path]::GetFileName($e); $r = Join2 $rel $n',
    '    if ($KEEP -contains $r) { continue }',
    '    $i = [IO.Path]::Combine($inc, $n)',
    '    if ((IsLink $e) -or -not (Exists $i)) { RemoveEntry $e; continue }',
    '    if (IsDir $e) { if (IsDir $i) { Prune $e $i $r } else { RemoveEntry $e } }',
    '    elseif (IsDir $i) { RemoveEntry $e }',
    '  }',
    '}',
    'function Same($a, $b) {',
    '  if ((IsLink $a) -or (IsLink $b) -or -not [IO.File]::Exists($b)) { return $false }',
    '  if ((New-Object IO.FileInfo $a).Length -ne (New-Object IO.FileInfo $b).Length) { return $false }',
    '  return ((Get-FileHash -LiteralPath $a -Algorithm SHA256).Hash -eq (Get-FileHash -LiteralPath $b -Algorithm SHA256).Hash)',
    '}',
    // 2. Into src/: new and changed files; identical ones stay as they are, with their times.
    'function Fill($inc, $src, $rel) {',
    '  foreach ($e in [IO.Directory]::GetFileSystemEntries($inc)) {',
    '    $n = [IO.Path]::GetFileName($e); $r = Join2 $rel $n',
    '    if ($KEEP -contains $r) { continue }',
    '    $d = [IO.Path]::Combine($src, $n)',
    '    if (IsDir $e) { if (-not (IsDir $d)) { if (Exists $d) { RemoveEntry $d }; [void][IO.Directory]::CreateDirectory($d) }; Fill $e $d $r; continue }',
    '    if (Same $e $d) { continue }',
    '    if (Exists $d) { RemoveEntry $d }',
    '    [IO.File]::Move($e, $d)',
    '  }',
    '}',
    'Prune $S $IN ""',
    'Fill $IN $S ""',
    'RemoveTree $IN',
  ].join('\n');
}

export function psRemove(root: string, path: string): string {
  return [
    PS_LIB,
    `$ROOT = ${psPath(root)}`,
    'if (-not [IO.Directory]::Exists($ROOT)) { exit 0 }',
    '$RR = [IO.Path]::GetFullPath($ROOT)',
    // Every folder from the root down must be a real folder (no symlink or junction a job left); only then is it removed.
    `$P = InRoot $RR '${relOf(root, path)}' $false`,
    'if (-not $P) { exit 0 }',
    'RemoveTree $P',
    '[IO.Directory]::Delete($P)',
  ].join('\n');
}

export const psStale = (root: string) =>
  [
    PS_LIB,
    `$ROOT = ${psPath(root)}`,
    'if (-not [IO.Directory]::Exists($ROOT)) { exit 0 }',
    '$cut = (Get-Date).AddDays(-1)',
    "foreach ($p in [IO.Directory]::GetDirectories($ROOT)) { if ((IsLink $p) -or ([IO.Path]::GetFileName($p) -eq 'cache')) { continue }",
    '  foreach ($w in [IO.Directory]::GetDirectories($p)) { if (-not (IsLink $w) -and [IO.Directory]::GetLastWriteTime($w) -lt $cut) { Write-Output ([IO.Path]::GetFileName($p) + "/" + [IO.Path]::GetFileName($w)) } } }',
  ].join('\n');
export const psSizes = (paths: string[]) =>
  [
    PS_LIB,
    'function Size($d) { $n = 0; foreach ($e in [IO.Directory]::GetFileSystemEntries($d)) { if (IsLink $e) { continue }; if ([IO.Directory]::Exists($e)) { $n += Size $e } else { $n += (New-Object IO.FileInfo $e).Length } }; return $n }',
    ...paths.map((p) => `$p = ${psPath(p)}; if ([IO.Directory]::Exists($p) -and -not (IsLink $p)) { Write-Output ([math]::Ceiling((Size $p) / 1024)) } else { Write-Output '-' }`),
  ].join('\n');
/** The outputs as a tar to a file in the workspace, then its bytes to stdout as they are (no PowerShell text pipeline). */
export const psPack = (root: string, ws: string, outputs: string[]) =>
  [
    PS_LIB,
    psRoot(root),
    `$WS = InRoot $RR '${relOf(root, ws)}' $false`,
    "if (-not $WS) { Fail 4 'no workspace' }",
    "$TAR = [IO.Path]::Combine($WS, '.helm', 'out.tar')",
    `& tar -c -f $TAR -C $WS ${outputs.map((o) => `'${o}'`).join(' ')}`,
    'if ($LASTEXITCODE) { Fail $LASTEXITCODE "tar failed" }',
    '$o = [Console]::OpenStandardOutput(); $f = [IO.File]::OpenRead($TAR); $f.CopyTo($o); $f.Close(); $o.Flush()',
    '[IO.File]::Delete($TAR)',
  ].join('\n');

// ---------- create, end, remove ----------

const git = (cwd: string, args: string[]) =>
  new Promise<{ code: number; out: string }>((resolve) => {
    const c = spawn('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => (out += d));
    c.on('close', (code) => resolve({ code: code ?? 1, out: out.trim() }));
    c.on('error', () => resolve({ code: 127, out: '' }));
  });

/** Whether jobs of this project on this host use its build slot: the host keeps build folders and the project allows it. */
export function usesSlot(host: Row, projectId: string): boolean {
  return keepFolders(host.work_keep).length > 0 && getSetting(projectId, 'build_slots') !== false;
}

/** The slot's current job, if one is running: an active slot row whose agent still works. Stale ones end as failed. */
function slotHolder(hostId: string, projectId: string): Row | undefined {
  for (const w of all("SELECT w.*, a.status AS agent_status, a.name AS agent_name FROM host_workspaces w LEFT JOIN agents a ON a.id = w.agent_id WHERE w.host_id = ? AND w.project_id = ? AND w.slot = 1 AND w.state = 'active' AND w.removed_at IS NULL", hostId, projectId)) {
    if (w.agent_id && ['closed', 'done', 'error'].includes(w.agent_status)) {
      run("UPDATE host_workspaces SET state = 'failed', ended_at = ? WHERE id = ?", now(), w.id);
      continue;
    }
    return w;
  }
  return undefined;
}

/** Agents told when a slot frees (the notice goes through the agents facade; tests replace it). */
let slotNotice = (agentId: string, text: string) => sendToAgent(agentId, text, { kind: 'system', name: 'Helm' }).then(() => {});
export function setSlotNotice(fn: typeof slotNotice) {
  slotNotice = fn;
}
async function slotFreed(hostId: string, projectId: string) {
  const waiting = all('SELECT agent_id FROM slot_waits WHERE host_id = ? AND project_id = ?', hostId, projectId);
  run('DELETE FROM slot_waits WHERE host_id = ? AND project_id = ?', hostId, projectId);
  const host = get('SELECT name FROM hosts WHERE id = ?', hostId);
  for (const w of waiting) await slotNotice(w.agent_id, `<helm-note kind="host">The build slot on ${host?.name ?? 'the host'} is free: call host_workspace again if your job still waits.</helm-note>`).catch(() => {});
}

/**
 * A workspace for a job on a host: the folder (fresh, or the project's build slot), the code at `commit` (default the
 * project's HEAD), the wrapper. `fresh` asks for a fresh folder even where a slot is set. Returns the workspace row, or
 * why not (`busy` when the slot is in use).
 */
export async function createWorkspace(opts: { host: Row; project: Row; taskId?: string | null; agentId?: string | null; job?: string; commit?: string; fresh?: boolean }): Promise<{ workspace: Row } | { error: string; busy?: boolean }> {
  const { host, project } = opts;
  const platform = platformOf(host);
  const root = rootOf(host);
  const re = rootError(root);
  if (re) return { error: `Host ${host.name}: ${re}` };
  const want = opts.commit?.trim() || 'HEAD';
  if (!/^[A-Za-z0-9._/~^-]{1,80}$/.test(want)) return { error: 'Give a commit, branch or tag name.' };
  const commit = await git(project.path, ['rev-parse', '--verify', `${want}^{commit}`]);
  if (commit.code !== 0 || !/^[0-9a-f]{40}$/.test(commit.out)) return { error: `No commit "${want}" in the project's repository.` };
  const pslug = slug(project.name);
  const slot = !opts.fresh && usesSlot(host, project.id);
  const keep = slot ? keepFolders(host.work_keep) : [];
  let name: string;
  if (slot) {
    name = 'slot';
    const holder = slotHolder(host.id, project.id);
    if (holder) {
      if (opts.agentId) run('INSERT OR REPLACE INTO slot_waits (host_id, project_id, agent_id, at) VALUES (?,?,?,?)', host.id, project.id, opts.agentId, now());
      const by = holder.agent_id === opts.agentId ? 'you (end it with host_workspace_end first)' : holder.agent_name ?? 'another job';
      return { busy: true, error: `The build slot on ${host.name} is in use by ${by} since ${clockText(holder.created_at)} (workspace ${holder.id}). One job at a time keeps its build folder intact: Helm tells you when it frees; meanwhile do other work, or pass fresh: true for a separate clean folder (a full build).` };
    }
  } else {
    const job = slug(opts.job || opts.taskId || 'job');
    const n = Number(get('SELECT COUNT(*) AS n FROM host_workspaces WHERE host_id = ? AND project_id = ? AND name LIKE ?', host.id, project.id, `${job}-%`)?.n ?? 0) + 1;
    name = `${job}-${n}`;
  }
  const ws = `${root}/${pslug}/${name}`;
  if (!confined(root, ws)) return { error: 'The workspace path would leave the root.' };
  // Reserved before anything runs on the host, so a second job for the slot sees it at once.
  const id = newId('hws');
  run(
    'INSERT INTO host_workspaces (id, host_id, project_id, task_id, agent_id, name, path, commit_sha, created_at, note, slot) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, host.id, project.id, opts.taskId ?? null, opts.agentId ?? null, name, ws, commit.out, now(), '', slot ? 1 : 0,
  );
  const giveUp = async (error: string) => {
    run('DELETE FROM host_workspaces WHERE id = ?', id);
    if (!slot) await removeTree(host, root, ws);
    else void slotFreed(host.id, project.id);
    return { error };
  };
  const caches = cacheVars(host.work_caches).map((v) => `${root}/cache/${pslug}/${v.toLowerCase()}`);
  const setup = String(host.work_setup ?? '');
  const windows = platform === 'windows';
  const prep: Prep = { root, pslug, ws, slot, setup, caches, wrapper: windows ? psWrapper(host, pslug, keep) : wrapperScript(host, pslug, keep) };
  const made = await transport(host, windows ? psPrep(prep) : bashPrep(prep));
  if (made.code !== 0) {
    run('DELETE FROM host_workspaces WHERE id = ?', id);
    if (slot) void slotFreed(host.id, project.id);
    return { error: `Could not make the workspace on ${host.name}: ${(made.err || made.out).trim().slice(0, 300)}` };
  }
  const abs = made.out.trim().split('\n').pop()?.trim() ?? '';
  // The code: git archive of the commit, unpacked on the host (a slot: src/ reset to it file by file).
  const archive = spawn('git', ['-C', project.path, 'archive', '--format=tar', commit.out], { stdio: ['ignore', 'pipe', 'ignore'] });
  const unpack = await transport(host, windows ? psUnpack(root, ws, slot, keep) : bashUnpack(ws, slot, keep), archive.stdout);
  if (unpack.code !== 0) return giveUp(`Could not copy the code to ${host.name}: ${(unpack.err || unpack.out).trim().slice(0, 300)}`);
  if (slot) run("UPDATE host_workspaces SET removed_at = ? WHERE host_id = ? AND project_id = ? AND slot = 1 AND id != ? AND removed_at IS NULL", now(), host.id, project.id, id);
  run('UPDATE host_workspaces SET note = ? WHERE id = ?', abs, id);
  run('DELETE FROM slot_waits WHERE host_id = ? AND project_id = ? AND agent_id = ?', host.id, project.id, opts.agentId ?? '');
  touchProject(project.id);
  return { workspace: get('SELECT * FROM host_workspaces WHERE id = ?', id)! };
}

/** How an agent runs a command in a workspace, the command on stdin. */
export function runCommand(host: Row, w: Row): string {
  const ssh = host.is_local ? '' : `ssh ${host.port ? `-p ${host.port} ` : ''}${host.ssh_target} `;
  if (platformOf(host) === 'windows') return `${ssh}powershell -NoProfile -ExecutionPolicy Bypass -File "${w.note}\\.helm\\run.ps1" <<'HELM'\n<command>\nHELM`;
  return `${ssh}${w.note}/.helm/run <<'HELM'\n<command>\nHELM`;
}

/** rm -rf of one folder under the root, checked here and again on the host. */
async function removeTree(host: Row, root: string, path: string): Promise<string | null> {
  if (!confined(root, path)) return 'Refused: that path is not under the workspace root.';
  const r = await transport(host, platformOf(host) === 'windows' ? psRemove(root, path) : bashRemove(root, path));
  return r.code === 0 ? null : `Could not remove it: ${(r.err || r.out).trim().slice(0, 200)}`;
}

/** Remove a workspace now (the Hosts page's Remove, or the sweep). A slot in use is not removed. */
export async function removeWorkspace(id: string): Promise<string | null> {
  const w = get('SELECT * FROM host_workspaces WHERE id = ?', id);
  if (!w) return 'No such workspace.';
  if (w.removed_at) return null;
  if (w.slot && w.state === 'active' && slotHolder(w.host_id, w.project_id)?.id === w.id) return 'The build slot is in use by a job; remove it once the job ends.';
  const host = get('SELECT * FROM hosts WHERE id = ?', w.host_id);
  if (!host) return 'Its host is gone.';
  const err = await removeTree(host, rootOf(host), w.path);
  if (err) return err;
  run("UPDATE host_workspaces SET removed_at = ?, state = CASE WHEN state = 'active' THEN 'removed' ELSE state END WHERE id = ?", now(), id);
  touchProject(w.project_id);
  return null;
}

/** Where a job's results are copied on this machine. */
export const resultsDir = (w: Row) => join(ARTIFACT_DIR, 'host-results', w.project_id, w.id);

/**
 * A job ended: its outputs (paths relative to the workspace's src/ or out/) are copied back to resultsDir, then the
 * workspace is removed when it succeeded, or kept KEEP_FAILED_MS when it failed. A slot stays either way, and frees.
 */
export async function endWorkspace(id: string, ok: boolean, outputs: string[] = []): Promise<{ results: string | null; kept: boolean; slot?: boolean } | { error: string }> {
  const w = get('SELECT * FROM host_workspaces WHERE id = ?', id);
  if (!w) return { error: 'No such workspace.' };
  if (w.state !== 'active') return { error: `This workspace already ended (${w.state}).` };
  const host = get('SELECT * FROM hosts WHERE id = ?', w.host_id);
  if (!host) return { error: 'Its host is gone.' };
  for (const o of outputs) if (!SAFE.test(o) || o.startsWith('/') || o.startsWith('~') || o.startsWith('-') || o.split('/').includes('..')) return { error: `Output "${o}" must be a plain path inside the workspace (src/… or out/…).` };
  let results: string | null = null;
  if (outputs.length) {
    results = resultsDir(w);
    mkdirSync(results, { recursive: true });
    // The stream comes from the host, which a job could have shaped: kept to a file, checked, then unpacked (safeUntar).
    const tmp = `${results}.tar`;
    const file = createWriteStream(tmp);
    // Listened for before the copy starts: the file may be closed by the time the transport resolves.
    const closed = new Promise((done) => file.on('close', done));
    const r = await transport(host, platformOf(host) === 'windows' ? psPack(rootOf(host), w.path, outputs) : bashPack(w.path, outputs), null, file);
    await closed;
    if (r.code !== 0) {
      rmSync(tmp, { force: true });
      return { error: `Copying the outputs back failed: ${r.err.trim().slice(0, 300)}` };
    }
    const bad = await safeUntar(tmp, results);
    rmSync(tmp, { force: true });
    if (bad) return { error: `The outputs were not taken: ${bad}` };
  }
  run('UPDATE host_workspaces SET state = ?, ended_at = ? WHERE id = ?', ok ? 'done' : 'failed', now(), id);
  if (w.slot) {
    touchProject(w.project_id);
    await slotFreed(w.host_id, w.project_id);
    return { results, kept: true, slot: true };
  }
  if (ok) {
    const err = await removeWorkspace(id);
    if (err) return { error: err };
  }
  touchProject(w.project_id);
  return { results, kept: !ok };
}

/**
 * Unpack a tar that came from a host into `dest` (empty) safely: refused when any member is a link (symbolic or hard),
 * or anything but a plain file or folder, or has an absolute path or a .. part; unpacked without owners or modes from
 * the archive; then every path under `dest` is checked again (no links, nothing resolving outside it). Returns the
 * reason it was refused, or null.
 */
export async function safeUntar(tarPath: string, dest: string): Promise<string | null> {
  const list = (args: string[]) =>
    new Promise<{ code: number; out: string }>((resolve) => {
      const c = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.on('close', (code) => resolve({ code: code ?? 1, out }));
      c.on('error', () => resolve({ code: 127, out: '' }));
    });
  const names = await list(['-tf', tarPath]);
  const verbose = await list(['-tvf', tarPath]);
  if (names.code !== 0 || verbose.code !== 0) return 'not a readable tar archive';
  const ns = names.out.split('\n').filter(Boolean);
  const types = verbose.out.split('\n').filter(Boolean).map((l) => l[0]);
  if (ns.length !== types.length) return 'the archive could not be listed reliably';
  for (let i = 0; i < ns.length; i++) {
    if (types[i] !== '-' && types[i] !== 'd') return `${ns[i]} is a link or a special file`;
    if (ns[i].startsWith('/') || ns[i].split('/').includes('..')) return `${ns[i]} points outside the results`;
  }
  const x = await list(['-x', '--no-same-owner', '--no-same-permissions', '-f', tarPath, '-C', dest]);
  if (x.code !== 0) return 'unpacking failed';
  const realDest = realpathSync(dest);
  const walk = (dir: string): string | null => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const st = lstatSync(p);
      if (st.isSymbolicLink() || (st.isFile() && st.nlink > 1)) {
        rmSync(p, { force: true });
        return `${p} was a link`;
      }
      if (!realpathSync(p).startsWith(realDest + '/')) return `${p} resolves outside the results`;
      if (st.isDirectory()) {
        const bad = walk(p);
        if (bad) return bad;
      }
    }
    return null;
  };
  return walk(dest);
}

// ---------- the sweep and sizes ----------

/**
 * Daily: workspaces of failed jobs past KEEP_FAILED_MS, and active ones whose agent stopped or that are over three
 * days old, are removed; slots end their stale jobs and are removed after SLOT_IDLE_MS unused; then any folder in a
 * host's root (not the cache) older than a day that Helm no longer tracks. Sizes are measured. Returns how many were
 * removed.
 */
export async function sweepWorkspaces(at = now()): Promise<number> {
  let n = 0;
  const stale = all(
    `SELECT w.* FROM host_workspaces w LEFT JOIN agents a ON a.id = w.agent_id WHERE w.removed_at IS NULL AND w.slot = 0 AND (
       (w.state = 'failed' AND w.ended_at < ?) OR (w.state = 'active' AND (w.created_at < ? OR a.status IN ('closed', 'done', 'error'))))`,
    at - KEEP_FAILED_MS, at - 3 * 24 * HOUR,
  );
  for (const w of stale) if (!(await removeWorkspace(w.id))) n++;
  for (const s of all("SELECT DISTINCT host_id, project_id FROM host_workspaces WHERE slot = 1 AND removed_at IS NULL")) slotHolder(s.host_id, s.project_id);
  for (const w of all("SELECT * FROM host_workspaces WHERE slot = 1 AND removed_at IS NULL AND state != 'active' AND COALESCE(ended_at, created_at) < ?", at - SLOT_IDLE_MS)) if (!(await removeWorkspace(w.id))) n++;
  for (const host of all('SELECT * FROM hosts WHERE id IN (SELECT DISTINCT host_id FROM host_workspaces)')) {
    const root = rootOf(host);
    if (rootError(root)) continue;
    const listed = await transport(host, platformOf(host) === 'windows' ? psStale(root) : bashStale(root));
    if (listed.code !== 0) continue;
    const tracked = new Set(all('SELECT path FROM host_workspaces WHERE host_id = ? AND removed_at IS NULL', host.id).map((r) => String(r.path)));
    for (const rel of listed.out.split('\n').map((l) => l.trim().replace(/^\.\//, '')).filter(Boolean)) {
      const path = `${root}/${rel}`;
      if (tracked.has(path) || !confined(root, path)) continue;
      if (!(await removeTree(host, root, path))) n++;
    }
    await measure(host);
  }
  return n;
}

/** Sizes of a host's kept workspaces and slots (du, or a walk on Windows), stored for the Hosts page. */
export async function measure(host: Row) {
  const ws = all('SELECT id, path FROM host_workspaces WHERE host_id = ? AND removed_at IS NULL', host.id);
  if (!ws.length) return;
  const paths = ws.map((w) => String(w.path));
  const r = await transport(host, platformOf(host) === 'windows' ? psSizes(paths) : bashSizes(paths));
  const sizes = r.out.split('\n').map((l) => l.trim());
  ws.forEach((w, i) => {
    const kb = Number(sizes[i]);
    if (sizes[i] && Number.isFinite(kb)) run('UPDATE host_workspaces SET bytes = ? WHERE id = ?', kb * 1024, w.id);
  });
}

/** The Hosts page's list: each host's kept workspaces and slots. */
export function workspacesView(hostId?: string): Row[] {
  return all(
    `SELECT w.id, w.host_id, w.project_id, p.name AS project, w.task_id, w.name, w.path, w.commit_sha, w.state, w.bytes, w.created_at, w.ended_at, w.slot
       FROM host_workspaces w LEFT JOIN projects p ON p.id = w.project_id WHERE w.removed_at IS NULL ${hostId ? 'AND w.host_id = ?' : ''} ORDER BY w.created_at DESC`,
    ...(hostId ? [hostId] : []),
  );
}

let timer: NodeJS.Timeout | null = null;
export function startWorkspaceSweep() {
  if (timer) return;
  const tick = () => void sweepWorkspaces().catch((err) => console.error('Workspace sweep:', err));
  timer = setInterval(tick, 24 * HOUR);
  timer.unref?.();
  setTimeout(tick, 10 * 60_000).unref?.();
}
export function stopWorkspaceSweep() {
  if (timer) clearInterval(timer);
  timer = null;
}
