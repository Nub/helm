import { execFile, spawn } from 'node:child_process';
import { buildFiles, buildLabel } from './testbuilds.ts';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { bus } from './bus.ts';
import { ARTIFACT_DIR, DATA_DIR } from './config.ts';
import { all, db, get, newId, now, run } from './db.ts';
import type { Row } from './db.ts';
import { LIVE } from './liveupdate.ts';
import { addJournal, getProject } from './store.ts';
import { gb, holdsFor } from './disk.ts';
import { dashboardBytes, fileDir } from './dashboards.ts';

/**
 * Disk tracking: what each project, its worktrees and the folders its agents registered take on disk, and what Helm
 * itself and the machine's shared places (Nix store, live-update builds, /tmp) take.
 *
 * Sizes come from `du`, run in the background one at a time at the lowest CPU and I/O priority, and are cached in
 * disk_sizes with the time they were measured: a page or a tool shows what is known at once with its age, and asks
 * for anything older than STALE_MS to be measured again. Nothing here blocks the server.
 *
 * Agents register what they create (register_artifacts: a worktree, build output, a scratch folder) so it is shown,
 * and, when disposable, removed by clean_artifacts and when the agent is closed. Removal is guarded by
 * checkRemovable(): only real folders strictly inside the project's folder, its `<name>-wt` worktree folder or /tmp,
 * never through a symlink, never anything holding work git would lose.
 */

const exec = promisify(execFile);
const STALE_MS = 6 * 3600 * 1000;
/** The Nix store is big and slow to walk; once a day is plenty. */
const STORE_STALE_MS = 24 * 3600 * 1000;

db.exec(`
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  disposable INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  removed_at INTEGER,
  removed_by TEXT,
  -- Other agents that registered the same folder (JSON array of ids); the first registrant stays the owner.
  users TEXT NOT NULL DEFAULT '[]',
  -- A worktree's branch Helm recorded as created by the owner for it: the only branch ever deleted with it.
  branch TEXT,
  -- For a worktree: the branch it had checked out when registered (a different one later: not the same worktree).
  wt_branch TEXT,
  -- The folder's birth time when registered, and whether it was new then (made in the hour before): a folder the
  -- agent made itself, which may go even when its name is not a usual build-output name.
  birth REAL,
  fresh INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id, removed_at);
CREATE INDEX IF NOT EXISTS artifacts_agent ON artifacts(agent_id);
-- du results: bytes on disk under a path, when measured, or why it failed.
CREATE TABLE IF NOT EXISTS disk_sizes (
  path TEXT PRIMARY KEY,
  bytes INTEGER,
  computed_at INTEGER NOT NULL,
  error TEXT NOT NULL DEFAULT ''
);
`);
// A worktree's fork point from the main checkout's branch when registered: the base for what a task changed in it
// (tilescope.ts), which merge-base alone loses once the branch is merged.
if (!(db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[]).some((c) => c.name === 'base_commit')) db.exec('ALTER TABLE artifacts ADD COLUMN base_commit TEXT');

export const ARTIFACT_KINDS = ['worktree', 'build', 'scratch', 'other'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

// ---------- sizes ----------

/** Tell browsers sizes changed, at most every two seconds (a run of du results is one refetch). */
let publishTimer: ReturnType<typeof setTimeout> | null = null;
export function publishDisk() {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    bus.publish({ type: 'disk' });
  }, 2000);
  publishTimer.unref?.();
}

type Size = { bytes: number | null; computedAt: number | null; error: string; measuring: boolean };

/**
 * Two lanes, each measuring one thing at a time: the Nix store (a walk of many minutes) in its own, so it never holds
 * up the folders a page is waiting for. The temporary folder is measured in one pass (TMP_JOB: du -d1 gives every
 * top-level entry), not one du per entry.
 */
const TMP_JOB = '\0tmp';
type Lane = { queue: string[]; running: string | null };
const lanes = { store: { queue: [], running: null } as Lane, main: { queue: [], running: null } as Lane };
const laneOf = (path: string) => (path === '/nix/store' ? lanes.store : lanes.main);
const pending = (path: string) => {
  const l = laneOf(path);
  return l.running === path || l.queue.includes(path);
};
let niceArgs: string[] | null = null;

/** nice -n 19, and ionice -c 3 (idle I/O) where it exists. */
async function lowPriority(): Promise<string[]> {
  if (niceArgs) return niceArgs;
  try {
    await exec('ionice', ['-c', '3', 'true'], { timeout: 5000 });
    niceArgs = ['nice', '-n', '19', 'ionice', '-c', '3'];
  } catch {
    niceArgs = ['nice', '-n', '19'];
  }
  return niceArgs;
}

/** Test hook: replaces du (path → bytes). */
export const measurer: { du: ((path: string) => Promise<number>) | null } = { du: null };

/** du at the lowest priority: -x this filesystem only, -B1 bytes on disk; `args` adds -s or -d1. Path → bytes. */
async function runDu(args: string[], path: string): Promise<Map<string, number>> {
  const [cmd, ...pre] = await lowPriority();
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...pre, 'du', '-xB1', ...args, '--', path], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30 * 60 * 1000);
    child.on('error', reject);
    // Unreadable parts are skipped (exit 1) but the rest is still counted.
    child.on('close', () => {
      clearTimeout(timer);
      const sizes = new Map<string, number>();
      for (const line of out.split('\n')) {
        const tab = line.indexOf('\t');
        const n = Number(line.slice(0, tab));
        if (tab > 0 && Number.isFinite(n)) sizes.set(line.slice(tab + 1), n);
      }
      if (sizes.size) resolve(sizes);
      else reject(new Error(err.trim().split('\n').pop() || 'du gave no size'));
    });
  });
}

const store = (path: string, bytes: number) =>
  run("INSERT INTO disk_sizes (path, bytes, computed_at, error) VALUES (?,?,?,'') ON CONFLICT(path) DO UPDATE SET bytes = excluded.bytes, computed_at = excluded.computed_at, error = ''", path, bytes, now());

async function measureNow(path: string) {
  if (path === TMP_JOB) {
    const tmp = tmpdir();
    const sizes = measurer.du ? new Map<string, number>() : await runDu(['-d1'], tmp);
    for (const [p, n] of sizes) if (p !== tmp) store(p, n);
    return;
  }
  store(path, measurer.du ? await measurer.du(path) : ((await runDu(['-s'], path)).values().next().value as number));
}

async function pump(lane: Lane) {
  if (lane.running) return;
  const path = lane.queue.shift();
  if (!path) return;
  lane.running = path;
  try {
    await measureNow(path);
  } catch (err) {
    try {
      if (path !== TMP_JOB) run('INSERT INTO disk_sizes (path, bytes, computed_at, error) VALUES (?,NULL,?,?) ON CONFLICT(path) DO UPDATE SET computed_at = excluded.computed_at, error = excluded.error', path, now(), String((err as Error).message ?? err).slice(0, 300));
    } catch {}
  } finally {
    lane.running = null;
    publishDisk();
    void pump(lane);
  }
}

/** Measure `path` in the background (unless it is queued or being measured already). */
export function measure(path: string) {
  if (pending(path)) return;
  const lane = laneOf(path);
  lane.queue.push(path);
  void pump(lane);
}

/** What is known of a path's size; queues a new measurement if it is unknown or stale (`refresh`: in any case). */
export function sizeOf(path: string, refresh = false): Size {
  const r = get('SELECT bytes, computed_at, error FROM disk_sizes WHERE path = ?', path);
  const stale = path === '/nix/store' ? STORE_STALE_MS : STALE_MS;
  if (refresh || !r || now() - r.computed_at > stale) measure(path);
  return { bytes: (r?.bytes as number) ?? null, computedAt: (r?.computed_at as number) ?? null, error: (r?.error as string) ?? '', measuring: pending(path) };
}

export function measuring(): number {
  return Object.values(lanes).reduce((n, l) => n + l.queue.length + (l.running ? 1 : 0), 0);
}

// ---------- the project's places ----------

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const strictlyInside = (path: string, root: string) => path !== root && inside(path, root);
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  // No optional locks: a status from the Disk page must not take index.lock in a worktree an agent is working in.
  return (await exec('git', ['-C', cwd, ...args], { timeout: 20_000, maxBuffer: 4 << 20, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })).stdout;
}

export type Worktree = { path: string; branch: string | null; head: string; main: boolean };

/** The worktrees git knows for the project (main one first), plus folders in `<project>-wt/` git does not know. */
export async function worktreesOf(projectPath: string): Promise<{ known: Worktree[]; stray: string[] }> {
  const known: Worktree[] = [];
  try {
    // -z: fields end in NUL, so a newline in a path cannot fake an entry.
    let cur: Partial<Worktree> | null = null;
    for (const field of (await git(projectPath, 'worktree', 'list', '--porcelain', '-z')).split('\0')) {
      if (field.startsWith('worktree ')) {
        if (cur?.path) known.push(cur as Worktree);
        cur = { path: field.slice(9), branch: null, head: '', main: false };
      } else if (cur && field.startsWith('HEAD ')) cur.head = field.slice(5);
      else if (cur && field.startsWith('branch ')) cur.branch = field.slice(7).replace(/^refs\/heads\//, '');
    }
    if (cur?.path) known.push(cur as Worktree);
    if (known[0]) known[0].main = true;
  } catch {}
  const stray: string[] = [];
  const wtDir = `${projectPath.replace(/\/+$/, '')}-wt`;
  try {
    const knownReal = new Set(known.map((w) => real(w.path)));
    for (const e of readdirSync(wtDir, { withFileTypes: true })) {
      const p = join(wtDir, e.name);
      if (e.isDirectory() && !knownReal.has(real(p))) stray.push(p);
    }
  } catch {}
  return { known, stray };
}

/** Clean: no changes to tracked files and no untracked files git does not ignore. */
async function isClean(dir: string): Promise<boolean> {
  return (await git(dir, 'status', '--porcelain', '--untracked-files=normal')).trim() === '';
}

/** The worktree's commit is in the main worktree's branch (merged, or never moved from it). */
async function isMerged(projectPath: string, head: string, mainHead: string): Promise<boolean> {
  try {
    await git(projectPath, 'merge-base', '--is-ancestor', head, mainHead);
    return true;
  } catch {
    return false;
  }
}

// ---------- what may be removed ----------

/** A folder untouched for this long, whose owner is still working, is left alone. */
export const limits = { recentMs: 60 * 60 * 1000 };
/** A folder born less than this before it was registered counts as made by the registering agent. */
const FRESH_MS = 60 * 60 * 1000;
/** Usual names of build output and caches: what may go from inside a checkout. */
export const BUILD_SHAPES = ['target', 'build', 'dist', 'out', 'node_modules', '.cache', 'result', '__pycache__'];
/** Names that hold data, never build output. */
const DATA_NAME = /^(data|db|database|databases|backups?|storage|uploads|secrets?|\.ssh|\.gnupg)$/i;
/** Files that hold secrets or configuration. */
const SECRET_FILE = /^\.env(\..*)?$|^\.envrc$|\.(pem|key|kdbx)$|^id_(rsa|ed25519|ecdsa)$/i;
/** Folders in /tmp that belong to running programs, not to work. */
const SYSTEM_TMP = /^(tmux-|ssh-|\.X11|\.ICE|systemd-private-|claude-|cc-socks|nix-|user\/|pulse-|dbus-|runtime-)/;
const PROTECTED_BRANCHES = ['main', 'master', 'release', 'trunk', 'develop'];
const FINISHED_AGENT = ['done', 'closed'];

export type RemoveCheck =
  | { ok: true; path: string; how: 'rm' | 'worktree'; deleteBranch: string | null; keptBranch?: string }
  | { ok: false; path: string; reason: string; stale?: boolean };

/** Unfinished agents among those who registered `r`, or something inside it, or a folder holding it (any project). */
function liveUsers(r: string, except?: string): string[] {
  const names: string[] = [];
  for (const a of all('SELECT path, agent_id, users FROM artifacts WHERE removed_at IS NULL')) {
    if (!inside(a.path, r) && !inside(r, a.path)) continue;
    for (const id of [a.agent_id, ...JSON.parse(a.users || '[]')]) {
      if (!id || id === except) continue;
      const ag = get('SELECT name, status FROM agents WHERE id = ?', id);
      if (ag && !FINISHED_AGENT.includes(ag.status) && !names.includes(ag.name)) names.push(ag.name);
    }
  }
  return names;
}

/** A running process of this user whose working folder is `r` or inside it. */
function processIn(r: string): number | null {
  let pids: string[] = [];
  try {
    pids = readdirSync('/proc').filter((n) => /^\d+$/.test(n));
  } catch {
    return null;
  }
  for (const pid of pids) {
    try {
      if (inside(readlinkSync(`/proc/${pid}/cwd`), r)) return Number(pid);
    } catch {}
  }
  return null;
}

/** The newest sign of work in a folder: its own times and, for a worktree, its index, HEAD and last commit. */
async function lastActivity(r: string, worktree: boolean): Promise<number> {
  let t = 0;
  const bump = (p: string) => {
    try {
      const st = lstatSync(p);
      t = Math.max(t, st.mtimeMs, st.ctimeMs, st.birthtimeMs || 0);
    } catch {}
  };
  bump(r);
  if (worktree) {
    try {
      const gitdir = /^gitdir: (.*)$/m.exec(readFileSync(join(r, '.git'), 'utf8'))?.[1]?.trim();
      if (gitdir) for (const f of ['index', 'HEAD', join('logs', 'HEAD')]) bump(join(gitdir, f));
    } catch {}
    try {
      t = Math.max(t, Number((await git(r, 'log', '-1', '--format=%ct')).trim()) * 1000 || 0);
    } catch {}
  }
  return t;
}

/** Walk the whole tree (not following symlinks, skipping node_modules for repositories and secrets): the first repository, secret file, data folder or socket found. */
async function scanTree(root: string, isWorktreeRoot: boolean): Promise<{ problem: string | null; newest: number }> {
  const stack = [root];
  let seen = 0;
  let newest = 0;
  const done = (problem: string | null) => ({ problem, newest });
  while (stack.length) {
    const dir = stack.pop()!;
    const bump = (path: string) => {
      try {
        const st = lstatSync(path);
        newest = Math.max(newest, st.mtimeMs, st.ctimeMs);
      } catch {}
    };
    bump(dir);
    let d;
    try {
      d = await opendir(dir);
    } catch {
      continue;
    }
    const names: string[] = [];
    for await (const e of d) {
      if (++seen > 2_000_000) return done(`${root} has too many files to check`);
      const p = join(dir, e.name);
      names.push(e.name);
      if (e.isSocket()) return done(`a socket (${p}): a running program uses it`);
      // Files too: a file rewritten in place changes no folder's times.
      if (!e.isDirectory()) bump(p);
      if (e.isSymbolicLink()) continue;
      if (e.isFile() && SECRET_FILE.test(e.name)) return done(`a secrets or settings file (${p})`);
      if (e.isDirectory()) {
        if (DATA_NAME.test(e.name)) return done(`a data folder (${p})`);
        if (e.name === 'node_modules') continue;
        if (e.name === '.git' && !(isWorktreeRoot && dir === root)) return done(`a git repository (${dir})`);
        stack.push(p);
      } else if (e.name === '.git' && !(isWorktreeRoot && dir === root)) return done(`a git repository or worktree (${dir})`);
    }
    // A bare repository: HEAD beside objects/ and refs/.
    if (names.includes('HEAD') && names.includes('objects') && names.includes('refs')) return done(`a bare git repository (${dir})`);
  }
  return done(null);
}

/** The repository's default branch: origin's HEAD, else what the main checkout has. */
async function defaultBranch(projectPath: string, mainBranch: string | null): Promise<string | null> {
  try {
    return (await git(projectPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).trim().replace(/^origin\//, '');
  } catch {
    return mainBranch;
  }
}

/** Why a branch must stay, or null when Helm may delete it (after its worktree is removed). */
async function branchMustStay(projectPath: string, branch: string, known: Worktree[], worktreePath: string): Promise<string | null> {
  const main = known.find((w) => w.main);
  if (PROTECTED_BRANCHES.includes(branch)) return `${branch} is a protected name`;
  if (branch === main?.branch) return `${branch} is the main checkout's branch`;
  if (branch === (await defaultBranch(projectPath, main?.branch ?? null))) return `${branch} is the default branch`;
  if (known.some((w) => w.branch === branch && real(w.path) !== real(worktreePath))) return `${branch} is checked out elsewhere`;
  try {
    await git(projectPath, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`);
    return `${branch} has an upstream`;
  } catch {}
  return null;
}

/**
 * For a finished owner (done or closed): the last time it was itself active (its last text, tool call or end of
 * turn), else null. Not its close time: another agent may have used the folder while the owner sat idle before it
 * was closed. Nothing recorded: null (the one-hour rule applies).
 */
function ownerLastActive(agentId: string | null | undefined): number | null {
  if (!agentId) return null;
  const ag = get('SELECT status, active_at FROM agents WHERE id = ?', agentId);
  if (!ag || !FINISHED_AGENT.includes(ag.status)) return null;
  return (ag.active_at as number) ?? null;
}

export type RemoveContext = {
  /** The registered artifact for this path, if any. */
  artifact?: Row | null;
  /** The manager named this path in clean_artifacts (needed for a worktree nobody registered). */
  explicit?: boolean;
  /** Ignore this agent as a user (it is the one being closed). */
  closing?: string;
};

/**
 * Whether Helm may remove `path` for `project`. Only a real folder (not a file), reached without symlinks, strictly
 * inside the project's folder, its `<project>-wt` folder or the temporary folder, and:
 * - not Helm's data, not a .git folder, not holding, inside or being any other project's folder;
 * - not registered (it, or anything in or around it) by an agent still working, not any process's working folder,
 *   and, unless its owner has finished, untouched for an hour;
 * - holding no repository (bare or nested), secrets file, data folder or socket anywhere inside;
 * - a worktree: registered as one (or named by the manager), clean, and its commit in the main checkout's branch; its
 *   branch is deleted only when Helm recorded the owner creating it for this worktree and it is not protected;
 * - anything else: registered as build or scratch; in /tmp not a program's folder; inside a checkout, ignored by git,
 *   with no tracked or untracked files, and named like build output or made by the agent itself.
 */
export async function checkRemovable(path: string, project: Row, ctx: RemoveContext = {}): Promise<RemoveCheck> {
  const no = (reason: string): RemoveCheck => ({ ok: false, path, reason });
  if (typeof path !== 'string' || !path) return no('no path given');
  if (!isAbsolute(path)) return no('not an absolute path');
  if (path.split('/').includes('..') || path.includes('\0')) return no('the path has ".." in it');
  const p = normalize(path).replace(/(.)\/+$/, '$1');
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return no('it does not exist (already removed?)');
  }
  if (st.isSymbolicLink()) return no('it is a symlink; Helm removes only real folders');
  const r = real(p);
  if (r !== p) return no(`it is reached through a symlink (it is really ${r})`);
  if (!st.isDirectory()) return no('it is not a folder; Helm removes only folders');
  const own = real(String(project.path).replace(/\/+$/, ''));
  const wtRoot = real(`${String(project.path).replace(/\/+$/, '')}-wt`);
  const tmp = real(tmpdir());
  if (![own, wtRoot, tmp].some((root) => strictlyInside(r, root))) return no("it is outside the project's folder, its worktree folder and /tmp");
  if (inside(own, r)) return no('it holds the project folder itself');
  const data = real(DATA_DIR);
  if (inside(r, data) || inside(data, r)) return no("it is or holds Helm's data");
  if (r.split('/').includes('.git')) return no("it is inside a repository's .git folder");
  for (const q of all('SELECT name, path FROM projects WHERE id != ?', project.id)) {
    const qr = real(String(q.path).replace(/\/+$/, ''));
    if (inside(qr, r)) return no('it is or holds the folder of another project');
    // Inside another project's folder: refused, registered or not, unless that folder holds this whole project (a
    // project nested in another may still clean its own folder).
    if (inside(r, qr) && !inside(own, qr)) return no('it is inside the folder of another project');
  }

  // In use.
  const a = ctx.artifact ?? null;
  const users = liveUsers(r, ctx.closing);
  if (users.length) return no(`it is in use by ${users.join(', ')}, not finished yet`);
  const pid = processIn(r);
  if (pid) return no(`a running program (pid ${pid}) works in it`);
  const { known } = await worktreesOf(project.path);
  const wt = known.find((w) => real(w.path) === r);
  // Nothing inside that is work, secrets or a program's.
  if (DATA_NAME.test(basename(r))) return no('it is a data folder');
  // The folder that was registered, not another one made at the same path since (same birth time; for a worktree,
  // the same branch checked out).
  if (a?.id && a.birth && st.birthtimeMs && Math.abs(st.birthtimeMs - a.birth) >= 1) return { ok: false, path, reason: 'it is not the folder that was registered (it was made again since); its registration is dropped', stale: true };
  if (a?.id && wt && a.wt_branch && wt.branch !== a.wt_branch) return { ok: false, path, reason: `it is not the worktree that was registered (it has ${wt.branch ?? 'no branch'} checked out, not ${a.wt_branch}); its registration is dropped`, stale: true };
  const scan = await scanTree(r, !!wt);
  if (scan.problem) return no(scan.problem.startsWith('a git repository') || scan.problem.startsWith('a bare git')
    ? `it holds ${scan.problem}. Helm never removes a repository: check it has nothing uncommitted or unpushed (git -C <that folder> status; git -C <that folder> log --branches --not --remotes), then remove ${r} by hand with rm -rf`
    : `it holds ${scan.problem}; remove it by hand once that is safe`);
  // The hour is waived only for a finished owner, and only when nothing (no file, no folder) changed after the owner
  // was last active itself: another agent may have used the folder without registering it, even before the owner
  // was closed.
  const newest = Math.max(scan.newest, await lastActivity(r, !!wt));
  const lastActive = ownerLastActive(a?.agent_id);
  const quiet = lastActive !== null && newest <= lastActive;
  if (!quiet && Date.now() - newest < limits.recentMs) return no(lastActive !== null ? 'it changed after its owner last worked, less than an hour ago: someone else may be using it' : 'it was created or changed in the last hour and its owner has not finished');

  if (wt) {
    if (wt.main) return no('it is the main checkout');
    if (a?.kind !== 'worktree' && !ctx.explicit) return no('a worktree nobody registered is removed only when named in paths');
    try {
      if (!(await isClean(r))) return no('the worktree has uncommitted changes or untracked files');
    } catch (err) {
      return no(`git status failed: ${(err as Error).message.split('\n')[0]}`);
    }
    const main = known.find((w) => w.main);
    if (!main || !wt.head || !(await isMerged(project.path, wt.head, main.head))) {
      return no(
        `its branch ${wt.branch ?? '(detached)'} is not merged into ${main?.branch ?? 'the main branch'} (a squash or rebase merge does not count: git cannot see it). ` +
          `If its work is in ${main?.branch ?? 'the main branch'}, remove it by hand: git -C ${project.path} worktree remove ${r}${wt.branch ? ` && git -C ${project.path} branch -D ${wt.branch}` : ''}`,
      );
    }
    let deleteBranch: string | null = null;
    let keptBranch: string | undefined;
    if (wt.branch) {
      const stay = a?.branch !== wt.branch ? 'Helm did not record it being created for this worktree' : await branchMustStay(project.path, wt.branch, known, r);
      if (stay) keptBranch = `${wt.branch} (${stay})`;
      else deleteBranch = wt.branch;
    }
    return { ok: true, path: r, how: 'worktree', deleteBranch, keptBranch };
  }
  if (known.some((w) => strictlyInside(real(w.path), r))) return no('it holds a worktree of the project');

  if (!a || !['build', 'scratch'].includes(a.kind)) return no('only folders registered as build or scratch output are removed');
  if (strictlyInside(r, tmp) && !strictlyInside(r, own) && !strictlyInside(r, wtRoot)) {
    if (SYSTEM_TMP.test(r.slice(tmp.length + 1))) return no("it belongs to a running program's session, not to work");
    return { ok: true, path: r, how: 'rm', deleteBranch: null };
  }
  // Inside the project's folder or one of its worktrees: only ignored build output.
  let top = '';
  try {
    top = (await git(r, 'rev-parse', '--show-toplevel')).trim();
  } catch {}
  if (!top) return no('it is in a project folder that is not a git checkout, so Helm cannot tell build output from work');
  try {
    const rel = r.slice(real(top).length + 1) || '.';
    if ((await git(top, 'ls-files', '--', rel)).trim()) return no('git tracks files in it: it is work, not build output');
    if ((await git(top, 'status', '--porcelain', '--untracked-files=all', '--', rel)).trim()) return no('it holds untracked files git does not ignore');
    try {
      await git(top, 'check-ignore', '-q', '--', rel);
    } catch {
      return no('git does not ignore it');
    }
  } catch (err) {
    return no(`git failed: ${(err as Error).message.split('\n')[0]}`);
  }
  const madeByAgent = !!a.fresh && a.birth !== null && Math.abs((st.birthtimeMs || 0) - a.birth) < 1;
  // It, or a folder it is in, is named like build output (build/, or build/release/ inside it).
  const shaped = r.slice(real(top).length + 1).split('/').some((seg) => BUILD_SHAPES.includes(seg));
  if (!shaped && !madeByAgent) return no(`its name is not a usual build-output folder (${BUILD_SHAPES.join(', ')}) and Helm did not see the agent create it`);
  return { ok: true, path: r, how: 'rm', deleteBranch: null };
}

/** Remove what checkRemovable allowed: `git worktree remove` (and its recorded branch) for a worktree, else rm -rf on this filesystem. */
async function remove(c: Extract<RemoveCheck, { ok: true }>, projectPath: string): Promise<void> {
  // Checked again at the last moment: still a real folder at the same real path.
  const st = lstatSync(c.path);
  if (st.isSymbolicLink() || !st.isDirectory() || real(c.path) !== c.path) throw new Error('it changed since it was checked (a symlink now?)');
  if (c.how === 'worktree') {
    await git(projectPath, 'worktree', 'remove', c.path);
    // -d, not -D: only a branch git also considers merged.
    if (c.deleteBranch) await git(projectPath, 'branch', '-d', c.deleteBranch).catch(() => {});
    return;
  }
  await removePinned(c.path);
}

/**
 * rm -rf of `path` with its parent pinned: the shell enters the parent without following symlinks (cd -P), checks it
 * is where it should be, and removes the entry by name from there. A parent swapped for a symlink after the check is
 * refused instead of followed; the entry itself, if swapped for a symlink, is removed as a link (rm never follows it).
 */
export async function removePinned(path: string): Promise<void> {
  const parent = dirname(path);
  const name = basename(path);
  if (!name || name === '.' || name === '..' || name.includes('/')) throw new Error(`not a removable name: ${name}`);
  const script = 'cd -P -- "$1" && [ "$(pwd -P)" = "$1" ] && exec rm -rf --one-file-system -- "./$2"';
  await new Promise<void>((resolve, reject) => {
    const child = spawn('sh', ['-c', script, 'helm-rm', parent, name], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err = (err + d).slice(-1000)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `rm exited ${code}`))));
  });
}

// ---------- registered artifacts ----------

/**
 * Why `branch` is not one the agent created for a worktree born at `birth`, or null when it is: the branch's oldest
 * reflog entry must be its creation ("branch: Created from ...") no earlier than the worktree (two seconds' slack:
 * git worktree add -b creates the branch just before the folder; reflog times are whole seconds). No reflog: not provably the agent's.
 */
async function branchNotNew(projectPath: string, branch: string, birth: number): Promise<string | null> {
  let lines: string[];
  try {
    lines = (await git(projectPath, 'reflog', 'show', '--date=unix', '--format=%gd%x09%gs', `refs/heads/${branch}`, '--')).trim().split('\n').filter(Boolean);
  } catch {
    return `${branch} has no history of being created (no reflog)`;
  }
  const oldest = lines[lines.length - 1] ?? '';
  const at = Number(/@\{(\d+)\}/.exec(oldest)?.[1]);
  if (!/\tbranch: Created from /.test(oldest) || !Number.isFinite(at)) return `${branch} has no history of being created (no reflog entry for it)`;
  if (at * 1000 < birth - 2000) return `${branch} existed before the worktree was made`;
  return null;
}

export async function registerArtifact(
  project: Row,
  agentId: string | null,
  input: { path: string; kind: ArtifactKind; disposable: boolean; note?: string; branch?: string },
): Promise<{ id: string; text: string } | { error: string }> {
  if (!isAbsolute(input.path)) return { error: 'Give an absolute path.' };
  if (input.path.split('/').includes('..')) return { error: 'Give the path without "..".' };
  const p = normalize(input.path).replace(/(.)\/+$/, '$1');
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return { error: `${p} does not exist. Register a folder once it is created.` };
  }
  if (!st.isDirectory()) return { error: `${p} is not a folder. Register the folder that holds it.` };
  if (p === '/' || p === real(project.path) || p === dirname(real(project.path))) return { error: `${p} is not something an agent created.` };
  const notes: string[] = [];
  // The branch is recorded as the agent's own only for a new worktree that has it checked out and may be deleted.
  let branch: string | null = null;
  if (input.branch) {
    const { known } = await worktreesOf(project.path);
    const wt = known.find((w) => real(w.path) === real(p));
    const fresh = Date.now() - (st.birthtimeMs || st.ctimeMs) < FRESH_MS;
    const stay = !wt || wt.main
      ? 'it is not one of the project\'s worktrees'
      : wt.branch !== input.branch
        ? `the worktree has ${wt.branch ?? 'no branch'} checked out`
        : !fresh
          ? 'the worktree is more than an hour old'
          : ((await branchMustStay(project.path, input.branch, known, p)) ?? (await branchNotNew(project.path, input.branch, st.birthtimeMs || st.ctimeMs)));
    if (input.kind !== 'worktree') notes.push('A branch is recorded only for kind worktree.');
    else if (stay) notes.push(`Branch ${input.branch} not recorded as yours: ${stay}. It will be kept when the worktree is removed.`);
    else branch = input.branch;
  }
  let existing = get('SELECT * FROM artifacts WHERE project_id = ? AND path = ? AND removed_at IS NULL', project.id, p);
  // A folder made again at a registered path is a new one: the old registration goes.
  if (existing?.birth && st.birthtimeMs && Math.abs(existing.birth - st.birthtimeMs) >= 1) {
    run("UPDATE artifacts SET removed_at = ?, removed_by = 'replaced' WHERE id = ?", now(), existing.id);
    existing = undefined;
  }
  const wtNow = input.kind === 'worktree' ? (await worktreesOf(project.path)).known.find((w) => real(w.path) === real(p)) : undefined;
  let id: string;
  if (existing) {
    id = existing.id;
    // The first registrant stays the owner; others are recorded as users, so cleanup waits for all of them.
    if (agentId && agentId !== existing.agent_id) {
      const users = new Set<string>(JSON.parse(existing.users || '[]'));
      users.add(agentId);
      run('UPDATE artifacts SET users = ? WHERE id = ?', JSON.stringify([...users]), id);
      notes.push(`It was registered before by another agent, which stays its owner; you are recorded as using it too.`);
    } else {
      run('UPDATE artifacts SET kind = ?, disposable = ?, note = ?, branch = COALESCE(?, branch) WHERE id = ?', input.kind, input.disposable ? 1 : 0, input.note ?? existing.note, branch, id);
    }
  } else {
    id = newId('art');
    const fresh = Date.now() - (st.birthtimeMs || st.ctimeMs) < FRESH_MS ? 1 : 0;
    run(
      'INSERT INTO artifacts (id, project_id, agent_id, path, kind, disposable, note, created_at, branch, birth, fresh, wt_branch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, project.id, agentId, p, input.kind, input.disposable ? 1 : 0, input.note ?? '', now(), branch, st.birthtimeMs || null, fresh, wtNow?.branch ?? null,
    );
  }
  if (wtNow && !wtNow.main && wtNow.head) {
    const main = (await worktreesOf(project.path)).known.find((w) => w.main);
    const base = main?.head ? (await git(project.path, 'merge-base', wtNow.head, main.head).catch(() => '')).trim() : '';
    if (base) run('UPDATE artifacts SET base_commit = COALESCE(base_commit, ?) WHERE id = ?', base, id);
  }
  measure(p);
  publishDisk();
  const roots = [real(project.path), real(`${project.path}-wt`), real(tmpdir())];
  const removable = roots.some((root) => strictlyInside(real(p), root));
  return {
    id,
    text:
      [
        `${existing ? 'Updated' : 'Registered'} ${p} (${input.kind}, ${input.disposable ? 'disposable' : 'kept'}${branch ? `, branch ${branch} recorded as yours` : ''}).`,
        removable
          ? input.disposable || input.kind === 'worktree'
            ? 'When you are closed, Helm removes it if it is a disposable scratch folder or a merged, clean worktree and nothing in it would be lost; your manager can remove it earlier with clean_artifacts.'
            : ''
          : "It is outside the project's folder, its worktree folder and /tmp: Helm shows its size but never removes it. Remove it yourself when it is no longer needed.",
        ...notes,
      ]
        .filter(Boolean)
        .join(' '),
  };
}

export function artifactsOf(projectId: string): Row[] {
  return all('SELECT * FROM artifacts WHERE project_id = ? AND removed_at IS NULL ORDER BY created_at', projectId);
}

export type CleanResult = { removed: { path: string; bytes: number | null; what: string }[]; refused: { path: string; reason: string }[] };

/**
 * Remove what is safe to remove for a project: its registered disposable folders and registered worktrees (checked
 * by checkRemovable), or only `paths` among them; a worktree nobody registered only when named in `paths`. `agentId`
 * limits it to what that agent owns (closing it). Every removal is journaled.
 */
type CleanOpts = { paths?: string[]; agentId?: string; by: string; byAgentId?: string | null; dryRun?: boolean; kinds?: ArtifactKind[] };

/** One cleanup at a time per project (closing an agent and a sweep can overlap): each sees what the last one left. */
const cleaning = new Map<string, Promise<unknown>>();
export function cleanArtifacts(projectId: string, opts: CleanOpts): Promise<CleanResult> {
  const before = cleaning.get(projectId) ?? Promise.resolve();
  const next = before.catch(() => {}).then(() => cleanNow(projectId, opts));
  cleaning.set(projectId, next);
  void next.finally(() => {
    if (cleaning.get(projectId) === next) cleaning.delete(projectId);
  }).catch(() => {});
  return next;
}

async function cleanNow(projectId: string, opts: CleanOpts): Promise<CleanResult> {
  const project = getProject(projectId);
  const out: CleanResult = { removed: [], refused: [] };
  if (!project) return out;
  type Candidate = { path: string; what: string; artifact?: Row; explicit?: boolean };
  const candidates: Candidate[] = [];
  const wanted = opts.paths?.map((p) => normalize(p).replace(/(.)\/+$/, '$1'));
  for (const a of artifactsOf(projectId)) {
    if (opts.agentId && a.agent_id !== opts.agentId && !JSON.parse(a.users || '[]').includes(opts.agentId)) continue;
    if (opts.kinds && !opts.kinds.includes(a.kind)) continue;
    if (!a.disposable && a.kind !== 'worktree') continue;
    candidates.push({ path: a.path, what: `${a.kind}${a.note ? ` (${a.note})` : ''}`, artifact: a, explicit: !!wanted?.includes(a.path) });
  }
  if (wanted && !opts.agentId) {
    const { known } = await worktreesOf(project.path);
    for (const w of known) {
      if (w.main || candidates.some((c) => real(c.path) === real(w.path)) || !wanted.includes(normalize(w.path))) continue;
      candidates.push({ path: w.path, what: `worktree${w.branch ? ` of ${w.branch}` : ''}`, explicit: true });
    }
  }
  for (const c of candidates) {
    if (wanted && !wanted.includes(c.path)) continue;
    // Cleaning up after a closed agent: if it was started again meanwhile, its folders are in use again.
    if (opts.agentId && !FINISHED_AGENT.includes(get('SELECT status FROM agents WHERE id = ?', opts.agentId)?.status)) break;
    const check = await checkRemovable(c.path, project, { artifact: c.artifact, explicit: c.explicit, closing: opts.agentId });
    if (!check.ok) {
      // Registered and already gone: just mark it. Not the folder that was registered: drop the registration.
      if (c.artifact && !existsSync(c.path) && !opts.dryRun) run('UPDATE artifacts SET removed_at = ?, removed_by = ? WHERE id = ?', now(), 'gone', c.artifact.id);
      else {
        if (check.stale && c.artifact && !opts.dryRun) run("UPDATE artifacts SET removed_at = ?, removed_by = 'replaced' WHERE id = ?", now(), c.artifact.id);
        out.refused.push({ path: c.path, reason: check.reason });
      }
      continue;
    }
    const bytes = sizeOf(c.path).bytes;
    const what = `${c.what}${check.deleteBranch ? `; branch ${check.deleteBranch} deleted` : check.keptBranch ? `; branch ${check.keptBranch} kept` : ''}`;
    if (opts.dryRun) {
      out.removed.push({ path: c.path, bytes, what });
      continue;
    }
    try {
      if (!existsSync(check.path)) continue;
      await remove(check, project.path);
      if (existsSync(check.path)) throw new Error('it is still there after removing');
      out.removed.push({ path: c.path, bytes, what });
      run('UPDATE artifacts SET removed_at = ?, removed_by = ? WHERE project_id = ? AND path = ? AND removed_at IS NULL', now(), opts.by, projectId, c.path);
      run('DELETE FROM disk_sizes WHERE path = ?', c.path);
    } catch (err) {
      out.refused.push({ path: c.path, reason: `removing it failed: ${String((err as Error).message).split('\n')[0]}` });
    }
  }
  for (const p of wanted ?? []) {
    if (!candidates.some((c) => c.path === p)) out.refused.push({ path: p, reason: 'not a disposable folder registered in this project, nor one of its worktrees' });
  }
  if (!opts.dryRun && out.removed.length) {
    const total = out.removed.reduce((n, r) => n + (r.bytes ?? 0), 0);
    addJournal(
      projectId,
      opts.byAgentId ?? null,
      'note',
      `Removed ${out.removed.length} ${out.removed.length === 1 ? 'folder' : 'folders'}${total ? ` (${gb(total)})` : ''} to free disk space`,
      `${opts.by}:\n\n${out.removed.map((r) => `- \`${r.path}\`: ${r.what}${r.bytes !== null ? `, ${gb(r.bytes)}` : ''}`).join('\n')}`,
    );
    publishDisk();
  }
  return out;
}

// ---------- the whole picture ----------

export type UsageEntry = {
  path: string;
  label: string;
  kind: 'project' | 'worktree' | 'artifact' | 'install' | 'tmp' | 'dashboards' | 'release' | 'testbuild';
  bytes: number | null;
  computedAt: number | null;
  measuring: boolean;
  error?: string;
  /** Worktrees: branch, whether merged and clean (null: unknown). Artifacts: kind, disposable, note, who. */
  branch?: string | null;
  merged?: boolean | null;
  clean?: boolean | null;
  artifactKind?: string;
  disposable?: boolean;
  note?: string;
  agent?: string | null;
  stray?: boolean;
  mtime?: number;
  /** A release's files (kind release): removable from the Disk page, the release's record kept. */
  releaseId?: string;
  /** A test build's files (kind testbuild): removable from the Disk page, its record kept. */
  testBuildId?: string;
};

const entry = (path: string, label: string, kind: UsageEntry['kind'], refresh: boolean, extra: Partial<UsageEntry> = {}): UsageEntry => {
  const s = sizeOf(path, refresh);
  return { path, label, kind, bytes: s.bytes, computedAt: s.computedAt, measuring: s.measuring, ...(s.error ? { error: s.error } : {}), ...extra };
};

export async function projectUsage(project: Row, refresh = false): Promise<{ id: string; name: string; path: string; total: number; entries: UsageEntry[] }> {
  const entries: UsageEntry[] = [entry(project.path, 'Project folder', 'project', refresh)];
  const { known, stray } = await worktreesOf(project.path);
  const main = known.find((w) => w.main);
  for (const w of known) {
    if (w.main) continue;
    let clean: boolean | null = null;
    let merged: boolean | null = null;
    try {
      clean = await isClean(w.path);
    } catch {}
    if (main && w.head) merged = await isMerged(project.path, w.head, main.head);
    entries.push(entry(w.path, basename(w.path), 'worktree', refresh, { branch: w.branch, clean, merged }));
  }
  for (const p of stray) entries.push(entry(p, basename(p), 'worktree', refresh, { stray: true }));
  const names = new Map(all('SELECT id, name FROM agents WHERE project_id = ?', project.id).map((a) => [a.id, a.name]));
  for (const a of artifactsOf(project.id)) {
    if (entries.some((e) => e.path === a.path)) {
      Object.assign(entries.find((e) => e.path === a.path)!, { artifactKind: a.kind, disposable: !!a.disposable, note: a.note, agent: names.get(a.agent_id) ?? null });
      continue;
    }
    if (!existsSync(a.path)) continue;
    entries.push(entry(a.path, basename(a.path), 'artifact', refresh, { artifactKind: a.kind, disposable: !!a.disposable, note: a.note, agent: names.get(a.agent_id) ?? null }));
  }
  // Dashboard images and pages, kept in Helm's data folder and counted from what each refresh recorded (no du).
  const dash = dashboardBytes(project.id);
  if (dash) entries.push({ path: fileDir(project.id), label: 'Dashboard images and pages', kind: 'dashboards', bytes: dash, computedAt: now(), measuring: false, note: 'history kept per tile, trimmed as tiles refresh' });
  // Release files (releases.ts), per release, newest first: an old release's can be removed, its record kept.
  for (const r of all('SELECT r.id, r.version, SUM(a.bytes) AS n FROM releases r JOIN release_artifacts a ON a.release_id = r.id WHERE r.project_id = ? AND a.file IS NOT NULL GROUP BY r.id ORDER BY r.created_at DESC', project.id)) {
    entries.push({ path: join(ARTIFACT_DIR, 'releases', project.id, r.id), label: `Release ${r.version} files`, kind: 'release', bytes: r.n, computedAt: now(), measuring: false, releaseId: r.id });
  }
  // Test builds' files (testbuilds.ts), per build: removable here, the record kept.
  for (const { build, bytes } of buildFiles(project.id)) {
    entries.push({ path: join(ARTIFACT_DIR, 'recipe-tests', project.id, build.id), label: `${buildLabel(build)} files`, kind: 'testbuild', bytes, computedAt: now(), measuring: false, testBuildId: build.id });
  }
  // Registered folders inside the project folder are counted in it already.
  const total = entries.filter((e) => !(e.kind === 'artifact' && inside(e.path, project.path))).reduce((n, e) => n + (e.bytes ?? 0), 0);
  return { id: project.id, name: project.name, path: project.path, total, entries };
}

let lastTmpJob = 0;

/** Top-level entries of the temporary folder owned by Helm's user, biggest first (sizes from one du pass). */
function tmpEntries(refresh: boolean): UsageEntry[] {
  const tmp = tmpdir();
  const uid = userInfo().uid;
  const out: UsageEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(tmp);
  } catch {}
  for (const name of names) {
    const p = join(tmp, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.uid !== uid || st.isSymbolicLink()) continue;
    const r = get('SELECT bytes, computed_at FROM disk_sizes WHERE path = ?', p);
    const bytes = st.isDirectory() ? ((r?.bytes as number) ?? null) : st.size;
    out.push({ path: p, label: name, kind: 'tmp', bytes, computedAt: st.isDirectory() ? ((r?.computed_at as number) ?? null) : now(), measuring: st.isDirectory() && pending(TMP_JOB), mtime: st.mtimeMs, ...(st.isDirectory() ? { stray: true } : {}) });
  }
  // One du pass over the whole folder when asked, or when a folder is unmeasured or stale (at most every ten minutes).
  if (refresh || (out.some((e) => e.stray && now() - (e.computedAt ?? 0) > STALE_MS) && Date.now() - lastTmpJob > 10 * 60 * 1000)) {
    lastTmpJob = Date.now();
    measure(TMP_JOB);
  }
  for (const e of out) delete e.stray;
  return out.sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
}

/** Generations Nix keeps for the system profile (each a GC root), and the live-update builds Helm keeps. */
function generations(): { system: number; live: number } {
  const count = (dir: string, re: RegExp) => {
    try {
      return readdirSync(dir).filter((n) => re.test(n)).length;
    } catch {
      return 0;
    }
  };
  return { system: count('/nix/var/nix/profiles', /^system-\d+-link$/), live: count(join(LIVE.dir, 'generations'), /^gen-\d+$/) };
}

/** refresh: measure everything again; the Nix store too only when store is set (a walk of many minutes: Measure again, not the guard). */
export async function diskUsage(refresh = false, store = refresh) {
  const projects = [];
  for (const p of all('SELECT * FROM projects WHERE archived = 0 ORDER BY name')) projects.push(await projectUsage(p, refresh));
  const gens = generations();
  const install: UsageEntry[] = [entry(DATA_DIR, 'Helm data', 'install', refresh)];
  if (existsSync('/nix/store')) install.push(entry('/nix/store', 'Nix store', 'install', refresh && store, { note: `${gens.system} system generation${gens.system === 1 ? '' : 's'}${gens.live ? `, ${gens.live} live-update build${gens.live === 1 ? '' : 's'}` : ''} kept` }));
  const tmp = tmpEntries(refresh);
  return { projects, install, tmp, tmpTotal: tmp.reduce((n, e) => n + (e.bytes ?? 0), 0), generations: gens, measuring: measuring() };
}

/** The biggest users of space in words, biggest first, and the project most of it belongs to (for the guard). */
export function biggestUsers(): { lines: string[]; projectId: string | null } {
  type Item = { label: string; bytes: number; projectId: string | null };
  const items: Item[] = [];
  for (const p of all('SELECT * FROM projects WHERE archived = 0')) {
    const own = [p.path, ...artifactsOf(p.id).filter((a) => !inside(a.path, p.path)).map((a) => a.path)];
    let wt = 0;
    for (const r of all("SELECT path, bytes FROM disk_sizes WHERE path LIKE ? AND bytes IS NOT NULL", `${String(p.path).replace(/\/+$/, '')}-wt/%`)) wt += r.bytes;
    for (const path of own) {
      const r = get('SELECT bytes FROM disk_sizes WHERE path = ?', path);
      if (r?.bytes) items.push({ label: `${p.name}: ${path}`, bytes: r.bytes, projectId: p.id });
    }
    if (wt) items.push({ label: `${p.name}: worktrees in ${p.path}-wt`, bytes: wt, projectId: p.id });
  }
  for (const path of ['/nix/store', DATA_DIR]) {
    const r = get('SELECT bytes FROM disk_sizes WHERE path = ?', path);
    if (r?.bytes) items.push({ label: path === DATA_DIR ? `Helm data (${path})` : 'Nix store', bytes: r.bytes, projectId: null });
  }
  const tmpRoot = tmpdir();
  for (const r of all("SELECT path, bytes FROM disk_sizes WHERE path LIKE ? AND bytes > 1000000000 ORDER BY bytes DESC LIMIT 5", `${tmpRoot}/%`)) items.push({ label: r.path, bytes: r.bytes, projectId: null });
  items.sort((a, b) => b.bytes - a.bytes);
  const top = items.slice(0, 6);
  // Measure everything again in the background, so the next look is current.
  void diskUsage(true, false).catch(() => {});
  return { lines: top.map((i) => `${i.label}: ${gb(i.bytes)}`), projectId: top.find((i) => i.projectId)?.projectId ?? null };
}

// ---------- for agents (list_disk) ----------

const age = (at: number | null) => {
  if (!at) return 'not measured yet';
  const m = Math.round((now() - at) / 60000);
  return m < 1 ? 'just measured' : m < 60 ? `measured ${m} min ago` : m < 48 * 60 ? `measured ${Math.round(m / 60)} h ago` : `measured ${Math.round(m / 1440)} days ago`;
};
const size = (e: UsageEntry) => (e.bytes !== null ? `${gb(e.bytes)} (${age(e.computedAt)}${e.measuring ? ', measuring again' : ''})` : e.measuring ? 'measuring…' : e.error ? `unknown: ${e.error}` : 'unknown');

export async function renderDisk(project: Row, filesystems: { holds: { label: string }[]; size: number; free: number; level: string }[]): Promise<string> {
  const u = await projectUsage(project);
  const lines = ['Free space:'];
  for (const f of filesystems) lines.push(`- ${gb(f.free)} free of ${gb(f.size)} (${f.level}) on the disk holding ${holdsFor(f.holds, project.name)}`);
  lines.push('', `This project (${u.path}):`);
  for (const e of u.entries) {
    let what = '';
    if (e.kind === 'worktree') {
      what = e.stray ? 'a folder in the worktree folder git does not know' : `worktree of ${e.branch ?? '(detached)'}; ${e.clean === false ? 'uncommitted changes' : e.clean ? 'clean' : 'state unknown'}, ${e.merged ? 'merged' : e.merged === false ? 'not merged' : 'merge unknown'}`;
    } else if (e.kind === 'artifact') what = 'registered';
    if (e.artifactKind) what += `${what ? '; ' : ''}${e.artifactKind}, ${e.disposable ? 'disposable' : 'kept'}${e.agent ? `, by ${e.agent}` : ''}${e.note ? `: ${e.note}` : ''}`;
    lines.push(`- ${e.path}: ${size(e)}${what ? `. ${what}` : ''}`);
  }
  lines.push(
    '',
    'clean_artifacts removes the disposable registered folders and the worktrees that are merged and clean; it refuses anything else. Sizes are measured in the background: a size marked "measuring" is updated in a few minutes.',
  );
  return lines.join('\n');
}
