import { statSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bus } from './bus.ts';
import { DATA_DIR } from './config.ts';
import { all, db, get, run } from './db.ts';
import { clearDiskFull, lastDiskFull, noteDiskFull, onDiskFull, setNearFull } from './safefs.ts';

/**
 * Disk guard. On 2026-11-18 the disk filled (other projects' build folders, /tmp, the Nix store) and took Helm down
 * with it. Every minute this samples free space on the filesystems that hold Helm's data, the projects' folders, the
 * Nix store and /tmp, and compares it with two install-wide thresholds (Helm page, Disk):
 *
 * - warning: one request to the user (a to-do naming the biggest users of space), not filed again while it is open
 *   or until space has recovered and run low again. The request's own notification is the one push.
 * - critical: Helm refuses to start new agents and live-update builds (refusal()), sends one "disk" notification, and
 *   tells the directors of active projects in a <helm-note> to stop builds and clean up. It lifts by itself when space
 *   returns, and the same directors are told.
 *
 * A write that failed for lack of space (server/safefs.ts) counts as critical too, whatever statfs says (a quota or
 * size limit can be hit before the filesystem is full), for FULL_FOR_MS after the last such failure.
 *
 * Each threshold is the smaller of a percentage of the filesystem and an absolute size: on a big disk the absolute
 * size decides (15% of 1 TB is 150 GB, plenty to nag about nothing), on a small one the percentage does (40 GB of a
 * 64 GB disk would be a permanent warning). Defaults: warning below 15% or 40 GB, critical below 5% or 10 GB. 40 GB is
 * a few large builds' worth: enough time to clean up before anything fails. 10 GB still lets Helm, SQLite, git and
 * a Nix garbage collection work while the space is freed. A level is left only once free space is 10% above its
 * threshold, so a disk hovering at the line does not flap.
 */

const FULL_FOR_MS = 10 * 60 * 1000;
const SAMPLE_MS = 60_000;
const GB = 1e9;

export type DiskLevel = 'ok' | 'warning' | 'critical';
const RANK: Record<DiskLevel, number> = { ok: 0, warning: 1, critical: 2 };
const worst = (a: DiskLevel, b: DiskLevel): DiskLevel => (RANK[a] >= RANK[b] ? a : b);

export type DiskSettings = { warnPercent: number; warnGB: number; criticalPercent: number; criticalGB: number };
export const DEFAULT_DISK_SETTINGS: DiskSettings = { warnPercent: 15, warnGB: 40, criticalPercent: 5, criticalGB: 10 };

db.exec(`CREATE TABLE IF NOT EXISTS disk_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`);

function readState<T>(key: string, fallback: T): T {
  const r = get('SELECT value FROM disk_state WHERE key = ?', key);
  if (!r) return fallback;
  try {
    return JSON.parse(r.value);
  } catch {
    return fallback;
  }
}
function writeState(key: string, value: unknown) {
  run('INSERT INTO disk_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

export function getDiskSettings(): DiskSettings {
  return { ...DEFAULT_DISK_SETTINGS, ...readState<Partial<DiskSettings>>('settings', {}) };
}

/** Validate and store; returns an error message for a bad value. */
export function saveDiskSettings(input: unknown): string | null {
  const s = input as Partial<DiskSettings>;
  if (!s || typeof s !== 'object') return 'Settings must be an object';
  const out = getDiskSettings();
  for (const k of ['warnPercent', 'warnGB', 'criticalPercent', 'criticalGB'] as const) {
    if (s[k] === undefined) continue;
    const v = Number(s[k]);
    if (!Number.isFinite(v) || v < 0) return `${k} must be a number of 0 or more`;
    if (k.endsWith('Percent') && v > 90) return 'A percentage above 90 would warn all the time';
    out[k] = Math.round(v * 10) / 10;
  }
  if (out.criticalPercent > out.warnPercent || out.criticalGB > out.warnGB) return 'The critical level must be below the warning level';
  writeState('settings', out);
  void tick();
  return null;
}

/** Bytes below which a filesystem of `size` bytes is at warning / critical. */
export function thresholds(size: number, s: DiskSettings) {
  return {
    warning: Math.min((size * s.warnPercent) / 100, s.warnGB * GB),
    critical: Math.min((size * s.criticalPercent) / 100, s.criticalGB * GB),
  };
}

/** The level for `free` bytes, given the level before (a level is left only once free is 10% above its threshold). */
export function levelFor(free: number, size: number, s: DiskSettings, prev: DiskLevel = 'ok'): DiskLevel {
  const t = thresholds(size, s);
  if (free < t.critical) return 'critical';
  if (prev === 'critical' && free < t.critical * 1.1) return 'critical';
  if (free < t.warning) return 'warning';
  if (prev !== 'ok' && free < t.warning * 1.1) return 'warning';
  return 'ok';
}

// ---------- sampling ----------

export type Filesystem = {
  /** Device id (st_dev), what tells filesystems apart. */
  dev: number;
  /** What lives on it, e.g. "Helm data", "Nix store", a project's name. */
  holds: { label: string; path: string }[];
  size: number;
  /** Bytes an unprivileged user can still write. */
  free: number;
  level: DiskLevel;
  warning: number;
  critical: number;
};

/** What to watch: Helm's data, each active project's folder, the Nix store and the temporary folder. */
function watched(): { label: string; path: string }[] {
  const out = [{ label: 'Helm data', path: DATA_DIR }];
  for (const p of all('SELECT name, path FROM projects WHERE archived = 0 ORDER BY name')) out.push({ label: p.name as string, path: p.path as string });
  out.push({ label: 'Nix store', path: '/nix/store' }, { label: 'Temporary files', path: tmpdir() });
  return out;
}

/**
 * HELM_DISK_FAKE_FREE ("8G", "500M", "3%"): pretend every filesystem has that much free. For screenshots and checks
 * of the warning and critical states on a scratch server; the live service never sets it.
 */
function fakeFree(size: number): number | null {
  const v = (process.env.HELM_DISK_FAKE_FREE ?? '').trim();
  const m = /^(\d+(?:\.\d+)?)\s*([GMK%]?)B?$/i.exec(v);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toUpperCase();
  return unit === '%' ? (size * n) / 100 : n * (unit === 'G' ? GB : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1);
}

let current: { at: number; filesystems: Filesystem[] } = { at: 0, filesystems: [] };

export function sample(prev: Filesystem[] = current.filesystems, settings = getDiskSettings()): Filesystem[] {
  const byDev = new Map<number, Filesystem>();
  for (const w of watched()) {
    let dev: number;
    let size: number;
    let free: number;
    try {
      dev = statSync(w.path).dev;
      const existing = byDev.get(dev);
      if (existing) {
        existing.holds.push(w);
        continue;
      }
      const f = statfsSync(w.path);
      size = f.blocks * f.bsize;
      free = fakeFree(size) ?? f.bavail * f.bsize;
    } catch {
      continue; // a project folder that is gone, no Nix store
    }
    const before = prev.find((p) => p.dev === dev)?.level ?? 'ok';
    byDev.set(dev, { dev, holds: [w], size, free, level: levelFor(free, size, settings, before), ...thresholds(size, settings) });
  }
  return [...byDev.values()];
}

// ---------- status ----------

function recentFull() {
  const f = lastDiskFull();
  if (f && Date.now() - f.at > FULL_FOR_MS) {
    clearDiskFull();
    return null;
  }
  return f;
}

export type DiskStatus = {
  level: DiskLevel;
  full: { at: number; what: string; message: string } | null;
  sampledAt: number;
  filesystems: Filesystem[];
  settings: DiskSettings;
  /** Whether new agents and live-update builds are refused now. */
  blocked: boolean;
};

export function diskLevel(): DiskLevel {
  return current.filesystems.reduce<DiskLevel>((l, f) => worst(l, f.level), recentFull() ? 'critical' : 'ok');
}

export function diskStatus(): DiskStatus {
  const level = diskLevel();
  return { level, full: recentFull(), sampledAt: current.at, filesystems: current.filesystems, settings: getDiskSettings(), blocked: level === 'critical' };
}

/** The part of the status /api/health carries: it needs no sign-in, so only the level and whether a write failed. */
export function healthDisk() {
  return { level: diskLevel(), full: !!recentFull() };
}

export const gb = (n: number) => (n >= 100 * GB ? `${Math.round(n / GB)} GB` : n >= GB ? `${(n / GB).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

const SHARED = ['Helm data', 'Nix store', 'Temporary files'];

/** What a filesystem holds, for one project's agents (`own`: its name): other projects are counted, not named. Without `own`, everything by name. */
export function holdsFor(holds: { label: string }[], own?: string): string {
  if (own === undefined) return holds.map((h) => h.label).join(', ');
  const others = holds.filter((h) => h.label !== own && !SHARED.includes(h.label)).length;
  return [
    ...(holds.some((h) => h.label === own) ? ['this project'] : []),
    ...(others ? [`${others} other project${others === 1 ? '' : 's'}`] : []),
    ...holds.filter((h) => SHARED.includes(h.label)).map((h) => h.label),
  ].join(', ');
}

/** The filesystem worst off, in words: "6.2 GB free of 983 GB on the disk holding Helm data, Nix store". */
function worstLine(own?: string): string {
  const f = [...current.filesystems].sort((a, b) => RANK[b.level] - RANK[a.level] || a.free - b.free)[0];
  const full = recentFull();
  if (!f || (full && f.level === 'ok')) return full ? 'a write failed for lack of space' : 'free space is low';
  return `${gb(f.free)} free of ${gb(f.size)} on the disk holding ${holdsFor(f.holds, own)}`;
}

/** Why something that needs space is refused now, or null when it is not. `own`: the asking project's name (agents see no other project's). */
export function refusal(what: string, own?: string): string | null {
  if (diskLevel() !== 'critical') return null;
  return (
    `Not started: the disk is nearly full (${worstLine(own)}), so Helm does not start ${what} until space is freed. ` +
    'Stop builds, remove build output, merged worktrees and scratch folders (list_disk and clean_artifacts show and remove what agents registered), then try again. This lifts by itself once space returns.'
  );
}

/** At or near the critical level now (for safefs: is an SQLite I/O error a full disk?). Samples once if nothing has been sampled yet. */
export function nearFull(): boolean {
  if (!current.at) {
    try {
      current = { at: Date.now(), filesystems: sample() };
    } catch {}
  }
  return current.filesystems.some((f) => f.level === 'critical' || f.free < f.critical * 1.5);
}
setNearFull(nearFull);

// ---------- what happens at each level ----------

export type GuardHooks = {
  /** Send a <helm-note> to a project's director. */
  tellDirector: (projectId: string, text: string) => Promise<void>;
  /** File the warning to-do; returns the request id. `silent`: no notification of its own (the critical push was sent). */
  fileRequest: (projectId: string, title: string, body: string, steps: string, silent: boolean) => string | null;
  /** Whether a request is still open. */
  requestOpen: (id: string) => boolean;
  /** A phone notification. */
  notify: (title: string, body: string) => void;
  /** The biggest users of space, in words, biggest first (server/diskusage.ts), and the project most of it belongs to. */
  biggest: () => { lines: string[]; projectId: string | null };
};

let hooks: GuardHooks | null = null;
export function setGuardHooks(h: GuardHooks) {
  hooks = h;
}

type Episode = { level: DiskLevel; requestId: string | null; told: string[] };

/**
 * The current episode, kept in memory first: on a full disk saving it fails, and it must still not be lost (or the
 * next sample would act again). Read from the database once, at the first change after a start.
 */
let episode: Episode | null = null;
function loadEpisode(): Episode {
  if (!episode) {
    try {
      episode = readState<Episode>('episode', { level: 'ok', requestId: null, told: [] });
    } catch {
      episode = { level: 'ok', requestId: null, told: [] };
    }
  }
  return episode;
}

/** Directors to tell: projects not archived with an agent not finished, active in the last week. */
function activeProjects(): string[] {
  return all(
    "SELECT DISTINCT p.id FROM projects p JOIN agents a ON a.project_id = p.id WHERE p.archived = 0 AND a.status NOT IN ('done', 'closed') AND p.updated_at > ?",
    Date.now() - 7 * 24 * 3600 * 1000,
  ).map((r) => r.id as string);
}

function requestProject(preferred: string | null): string | null {
  if (preferred && get('SELECT id FROM projects WHERE id = ? AND archived = 0', preferred)) return preferred;
  return (get('SELECT id FROM projects WHERE archived = 0 ORDER BY updated_at DESC LIMIT 1')?.id as string) ?? null;
}

/** One step of acting on a level: a failure (a full disk) is logged and does not stop the others. */
async function step(what: string, fn: () => unknown) {
  try {
    await fn();
  } catch (err) {
    noteDiskFull(err, `disk guard: ${what}`);
    console.error(`Disk guard: could not ${what}:`, (err as Error)?.message ?? err);
  }
}

const projectName = (id: string) => {
  try {
    return (get('SELECT name FROM projects WHERE id = ?', id)?.name as string) ?? '';
  } catch {
    return '';
  }
};

/**
 * Act on a change of level. The push goes first (it needs no disk), then the to-do, the directors' notes and saving
 * the episode, each on its own: one failing write cannot silence or repeat the others. Going straight from ok to
 * critical sends one push (the critical one; the to-do is filed without its own). Exported for the tests.
 */
export async function onLevel(level: DiskLevel) {
  if (!hooks) return;
  const h = hooks;
  const ep = loadEpisode();
  if (level === ep.level) return;
  const was = ep.level;
  ep.level = level;
  const line = worstLine();
  const toCritical = level === 'critical' && was !== 'critical';

  if (toCritical) await step('send the notification', () => h.notify('Disk nearly full', `${line}. Helm is not starting new agents or updates until space is freed.`));

  let big: { lines: string[]; projectId: string | null } = { lines: [], projectId: null };
  if (level !== 'ok' && was === 'ok') await step('list the biggest users', () => (big = h.biggest()));

  if (level !== 'ok' && was === 'ok') {
    let open = false;
    await step('check the open to-do', () => (open = !!ep.requestId && h.requestOpen(ep.requestId)));
    if (!open) {
      await step('file the to-do', () => {
        const pid = requestProject(big.projectId);
        if (!pid) return;
        const users = big.lines.length ? `\n\nThe biggest users of space:\n\n${big.lines.map((l) => `- ${l}`).join('\n')}` : '';
        ep.requestId = h.fileRequest(
          pid,
          current.filesystems.length ? `Free disk space: ${gb(Math.min(...current.filesystems.map((f) => f.free)))} left` : 'Free disk space: the disk is full',
          `Disk space is running low: ${line}. At ${level === 'critical' ? 'this level' : 'the critical level'} Helm stops starting new agents and updates until space is freed.${users}`,
          [
            '1. Open Disk on the Helm page to see what uses the space.',
            '2. Ask the directors to clean up, or remove old build folders and worktrees yourself.',
            '3. Collect Nix garbage:\n\n```\nnix-collect-garbage --delete-older-than 14d\n```',
          ].join('\n'),
          toCritical,
        );
      });
    }
  }

  if (toCritical) {
    await step('list active projects', () => (ep.told = activeProjects()));
    for (const pid of ep.told) {
      await step('tell a director', () =>
        h.tellDirector(
          pid,
          `The disk is nearly full (${worstLine(projectName(pid))}). Helm will not start new agents or live-update builds until space is freed. ` +
            'Tell your agents to stop builds now and clean up: remove build output, merged and clean worktrees and scratch folders in /tmp (list_disk shows what this project uses, clean_artifacts removes what is safe to remove). Do not start large builds until this lifts; Helm tells you when it does.',
        ),
      );
    }
  } else if (was === 'critical' && level !== 'critical') {
    for (const pid of ep.told) {
      await step('tell a director', () => h.tellDirector(pid, `Disk space is back above the critical level (${worstLine(projectName(pid))}). Helm starts new agents and builds again. Keep cleaning up after builds.`));
    }
    ep.told = [];
  }
  await step('save the episode', () => writeState('episode', ep));
}

// ---------- the timer ----------

let timer: ReturnType<typeof setInterval> | null = null;

export async function tick() {
  try {
    const before = diskLevel();
    current = { at: Date.now(), filesystems: sample() };
    const level = diskLevel();
    if (level !== before || current.filesystems.some((f) => f.level !== 'ok')) bus.publish({ type: 'disk' });
    await onLevel(level);
  } catch (err) {
    if (!noteDiskFull(err, 'the disk guard')) console.error('Disk guard:', err);
  }
}

export function startDiskGuard() {
  void tick();
  timer = setInterval(() => void tick(), SAMPLE_MS);
}
export function stopDiskGuard() {
  if (timer) clearInterval(timer);
  timer = null;
}

onDiskFull(() => {
  bus.publish({ type: 'disk' });
  void onLevel(diskLevel()).catch(() => {});
});

export const _internal = { setCurrent: (fs: Filesystem[]) => (current = { at: Date.now(), filesystems: fs }), episode: () => readState<Episode>('episode', { level: 'ok', requestId: null, told: [] }), forgetEpisode: () => (episode = null) };
