import { all, db, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { userZone } from './clock.ts';
import { dayStart } from './telemetry.ts';
import { runningTier } from './store.ts';
import { CATEGORIES, CATEGORY_LABEL, activity, whoOf } from './activity.ts';
import type { Category, CommandEvent } from './activity.ts';
import { commandGroup, commandText } from './commandgroups.ts';
import { floors } from './telemetryreset.ts';

/**
 * What agents spend their time and tokens on (activity.ts), kept per project and day in activity_days, so it outlives
 * the history it was read from (historyreduce.ts drops old tool results). Rows: day, who (director, builder, agent,
 * helper, subagent), tier, category, active ms, estimated tokens. The runner refreshes today and yesterday every half
 * hour and backfills every earlier day once from the transcripts that exist.
 */

db.exec(`CREATE TABLE IF NOT EXISTS activity_days (
  project_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  who TEXT NOT NULL,
  tier TEXT NOT NULL,
  category TEXT NOT NULL,
  ms INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  PRIMARY KEY (project_id, day, who, tier, category)
);
CREATE TABLE IF NOT EXISTS activity_state (project_id TEXT PRIMARY KEY, backfilled INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL);
-- "Waiting on commands" by command (commandgroups.ts): per day, who, tier and command group, the time waited on it with
-- nothing else in hand (waited_ms, of which waited_bg_ms on background runs), its background run time (bg_run_ms: the
-- rest of it other work filled), its runs, the agents' most common description of it that day, and an example.
CREATE TABLE IF NOT EXISTS activity_commands (
  project_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  who TEXT NOT NULL,
  tier TEXT NOT NULL,
  grp TEXT NOT NULL,
  waited_ms INTEGER NOT NULL DEFAULT 0,
  waited_bg_ms INTEGER NOT NULL DEFAULT 0,
  bg_run_ms INTEGER NOT NULL DEFAULT 0,
  runs INTEGER NOT NULL DEFAULT 0,
  run_ms INTEGER NOT NULL DEFAULT 0,
  max_ms INTEGER NOT NULL DEFAULT 0,
  intent TEXT NOT NULL DEFAULT '',
  intent_n INTEGER NOT NULL DEFAULT 0,
  derived TEXT NOT NULL DEFAULT '',
  example TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, day, who, tier, grp)
);`);
// Days measured before per-command waits were kept are measured again once (refreshAllActivity).
if (!(db.prepare('PRAGMA table_info(activity_state)').all() as { name: string }[]).some((c) => c.name === 'commands')) {
  try {
    db.exec('ALTER TABLE activity_state ADD COLUMN commands INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    if (!/duplicate column/.test(String((err as Error).message))) throw err;
  }
}

const DAY = 86_400_000;
/**
 * How waits are charged to commands, as a version: a project measured with an older one has all its days measured
 * again once. 2: waits go to the background run or subagent waited on, not the next quick command (task_11ca06b799).
 */
export const COMMANDS_VERSION = 2;

/** The tier an agent worked at at `ts`: the director Deep, a helper Light, a subagent its own, else the task it drove then. */
function tierAt(projectId: string) {
  const drives = new Map<string, Row[]>();
  for (const t of all("SELECT driver_agent_id, tier, started_at, finished_at FROM tasks WHERE project_id = ? AND kind = 'task' AND driver_agent_id IS NOT NULL AND started_at IS NOT NULL", projectId)) {
    (drives.get(t.driver_agent_id) ?? drives.set(t.driver_agent_id, []).get(t.driver_agent_id)!).push(t);
  }
  const fallback = new Map<string, string>();
  return (a: Row, ts: number): string => {
    if (!a.parent_id) return 'deep';
    if (a.role_id === 'subagent') return String(a.sub_tier ?? 'light');
    if (a.quick) return 'light';
    const t = drives.get(a.id)?.find((x) => x.started_at <= ts && (x.finished_at ?? Infinity) >= ts && x.tier);
    if (t) return String(t.tier);
    if (!fallback.has(a.id)) {
      const full = get('SELECT * FROM agents WHERE id = ?', a.id);
      fallback.set(a.id, full ? runningTier(full).run_tier : 'skilled');
    }
    return fallback.get(a.id)!;
  };
}

type DayRow = { day: number; who: string; tier: string; category: Category; ms: number; tokens: number };
type Measured = { rows: DayRow[]; cmds: Row[] };

/** Measure [from, to) of a project and replace its stored days in that range. */
export function refreshActivity(projectId: string, from: number, to: number, tz = userZone()) {
  const m = measureActivity(projectId, from, to, tz);
  tx(() => {
    run('DELETE FROM activity_days WHERE project_id = ? AND day >= ? AND day < ?', projectId, dayStart(from, tz), to);
    for (const r of m.rows) run('INSERT OR REPLACE INTO activity_days (project_id, day, who, tier, category, ms, tokens) VALUES (?,?,?,?,?,?,?)', projectId, r.day, r.who, r.tier, r.category, Math.round(r.ms), r.tokens);
    run('DELETE FROM activity_commands WHERE project_id = ? AND day >= ? AND day < ?', projectId, dayStart(from, tz), to);
    for (const r of m.cmds) {
      run(
        'INSERT OR REPLACE INTO activity_commands (project_id, day, who, tier, grp, waited_ms, waited_bg_ms, bg_run_ms, runs, run_ms, max_ms, intent, intent_n, derived, example) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        projectId, r.day, r.who, r.tier, r.grp, r.waited_ms, r.waited_bg_ms, r.bg_run_ms, r.runs, r.run_ms, r.max_ms, r.intent, r.intent_n, r.derived, r.example,
      );
    }
    run('INSERT INTO activity_state (project_id, backfilled, at) VALUES (?, 0, ?) ON CONFLICT(project_id) DO UPDATE SET at = excluded.at', projectId, now());
  });
}

/** [from, to) of a project measured from its transcripts, as the rows activity_days and activity_commands keep. */
function measureActivity(projectId: string, from: number, to: number, tz: string): Measured {
  const tiers = tierAt(projectId);
  type Cmd = { day: number; who: string; tier: string; grp: string; waited: number; waitedBg: number; bgRun: number; runs: number; runMs: number; maxMs: number; intents: Map<string, { n: number; ms: number }>; derived: string; example: string };
  const cmds = new Map<string, Cmd>();
  const onCommand = (c: CommandEvent) => {
    const g = commandGroup(c.command);
    const day = dayStart(c.ts, tz);
    const who = whoOf(c.agent);
    const tier = tiers(c.agent, c.ts);
    const key = `${day}|${who}|${tier}|${g.key}`;
    let r = cmds.get(key);
    if (!r) cmds.set(key, (r = { day, who, tier, grp: g.key, waited: 0, waitedBg: 0, bgRun: 0, runs: 0, runMs: 0, maxMs: 0, intents: new Map(), derived: g.intent, example: '' }));
    const d = c.description.trim();
    const vote = d ? r.intents.get(d) ?? r.intents.set(d, { n: 0, ms: 0 }).get(d)! : null;
    if (c.waitedMs) {
      r.waited += c.waitedMs;
      if (c.background) r.waitedBg += c.waitedMs;
      if (vote) vote.ms += c.waitedMs;
    }
    if (c.runMs != null) {
      r.runs++;
      r.runMs += c.runMs;
      r.maxMs = Math.max(r.maxMs, c.runMs);
      if (c.background) r.bgRun += c.runMs;
      if (vote) vote.n++;
      const text = commandText(c.command);
      if (text.length > r.example.length && text.length <= 2000) r.example = text;
      else if (!r.example) r.example = text.slice(0, 2000);
    }
  };
  const buckets = activity(all, projectId, from, to, (ts) => dayStart(ts, tz), tiers, onCommand);
  const rows = new Map<string, { day: number; who: string; tier: string; category: Category; ms: number; tokens: number }>();
  for (const b of buckets) {
    for (const c of CATEGORIES) {
      const v = b.split[c];
      if (!v.ms && !v.tokens) continue;
      const key = `${b.day}|${b.who}|${b.tier}|${c}`;
      const r = rows.get(key) ?? { day: b.day, who: b.who, tier: b.tier, category: c, ms: 0, tokens: 0 };
      r.ms += v.ms;
      r.tokens += v.tokens;
      rows.set(key, r);
    }
  }
  return {
    rows: [...rows.values()],
    cmds: [...cmds.values()].map((r) => {
      // The day's most common description; between equals, the one most waited on.
      const [intent, v] = [...r.intents].sort((a, b) => b[1].n - a[1].n || b[1].ms - a[1].ms)[0] ?? ['', { n: 0 }];
      return { project_id: projectId, day: r.day, who: r.who, tier: r.tier, grp: r.grp, waited_ms: Math.round(r.waited), waited_bg_ms: Math.round(r.waitedBg), bg_run_ms: Math.round(r.bgRun), runs: r.runs, run_ms: Math.round(r.runMs), max_ms: Math.round(r.maxMs), intent: intent.slice(0, 200), intent_n: v.n, derived: r.derived, example: r.example };
    }),
  };
}

/**
 * A Telemetry reset (telemetryreset.ts) partway through a day: that day's part after it, measured now (the stored days
 * cannot be split). Kept a few minutes per project and reset: the measure reads the day's events.
 */
const partCache = new Map<string, { at: number; v: Measured }>();
function afterReset(projectId: string, floor: number, tz: string): Measured {
  const key = `${projectId}|${floor}`;
  const hit = partCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
  const v = measureActivity(projectId, floor, Math.min(dayStart(floor, tz, 1), now() + 1), tz);
  if (partCache.size > 50) partCache.clear();
  partCache.set(key, { at: Date.now(), v });
  return v;
}

/**
 * Stored day rows (each with project_id and day) cut at each project's Telemetry reset: whole days before it dropped,
 * the day it fell in replaced by its part after the reset (`part`, filtered by who and tier). Unchanged under allTime.
 */
function sinceReset(stored: Row[], part: (projectId: string, floor: number) => Row[], f: { project: string | null; who: string | null; tier: string | null }, from: number, end: number, allTime: boolean, tz: string): Row[] {
  if (allTime) return stored;
  const fl = floors();
  if (!fl.size) return stored;
  const out = stored.filter((r) => Number(r.day) >= (fl.get(String(r.project_id)) ?? 0));
  const live = new Set(all('SELECT id FROM projects WHERE archived = 0').map((p) => String(p.id)));
  for (const [pid, floor] of fl) {
    const day = dayStart(floor, tz);
    if (day === floor || day < from || day >= end || (f.project && f.project !== pid) || !live.has(pid)) continue;
    out.push(...part(pid, floor).filter((r) => (!f.who || r.who === f.who) && (!f.tier || r.tier === f.tier)));
  }
  return out;
}

/** Every project: all days once (backfill), then today and yesterday. */
export function refreshAllActivity(at = now(), tz = userZone()) {
  for (const p of all('SELECT id FROM projects WHERE archived = 0')) {
    const st = get('SELECT backfilled, commands FROM activity_state WHERE project_id = ?', p.id);
    if (!st?.backfilled || Number(st.commands ?? 0) < COMMANDS_VERSION) {
      const first = Number(get('SELECT MIN(ts) AS t FROM events WHERE project_id = ?', p.id)?.t ?? at);
      refreshActivity(p.id, dayStart(first, tz), at + 1, tz);
      run('UPDATE activity_state SET backfilled = 1, commands = ? WHERE project_id = ?', COMMANDS_VERSION, p.id);
    } else refreshActivity(p.id, dayStart(at, tz, -1), at + 1, tz);
  }
}

export type CategoryRow = { category: Category; label: string; ms: number; share: number; prevMs: number; tokens: number };
/** One command group behind "waiting on commands": waited with nothing in hand, and the background time other work filled. */
export type CommandRow = { group: string; intent: string; example: string; waitedMs: number; filledMs: number; runs: number; avgMs: number; maxMs: number; share: number };
export type ProjectActivity = { project_id: string; name: string; activeMs: number; prevActiveMs: number; categories: CategoryRow[]; top: string[]; tokens: number; commands: CommandRow[]; commandsTop: string };

const mins = (ms: number) => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** The command groups of the last 7 days for a project (or all with null), biggest wait first. */
export function commandRows(projectId: string | null, from: number, end: number, who: string | null, tier: string | null, allTime = false, tz = userZone()): CommandRow[] {
  const where = ['day >= ?', 'day < ?'];
  const args: unknown[] = [from, end];
  if (projectId) (where.push('c.project_id = ?'), args.push(projectId));
  if (who) (where.push('who = ?'), args.push(who));
  if (tier) (where.push('tier = ?'), args.push(tier));
  const stored = all(`SELECT c.* FROM activity_commands c JOIN projects p ON p.id = c.project_id WHERE p.archived = 0 AND ${where.join(' AND ')}`, ...args);
  const rows = sinceReset(stored, (pid, f) => afterReset(pid, f, tz).cmds, { project: projectId, who, tier }, from, end, allTime, tz);
  const groups = new Map<string, { waited: number; waitedBg: number; bgRun: number; runs: number; runMs: number; maxMs: number; intents: Map<string, number>; derived: string; example: string }>();
  for (const r of rows) {
    const g = groups.get(r.grp) ?? { waited: 0, waitedBg: 0, bgRun: 0, runs: 0, runMs: 0, maxMs: 0, intents: new Map(), derived: String(r.derived), example: '' };
    g.waited += Number(r.waited_ms);
    g.waitedBg += Number(r.waited_bg_ms);
    g.bgRun += Number(r.bg_run_ms);
    g.runs += Number(r.runs);
    g.runMs += Number(r.run_ms);
    g.maxMs = Math.max(g.maxMs, Number(r.max_ms));
    if (r.intent) g.intents.set(String(r.intent), (g.intents.get(String(r.intent)) ?? 0) + Number(r.intent_n));
    if (String(r.example).length > g.example.length) g.example = String(r.example);
    groups.set(String(r.grp), g);
  }
  const total = [...groups.values()].reduce((n, g) => n + g.waited, 0);
  return [...groups]
    .map(([group, g]) => ({
      group,
      intent: intentOf(g.intents, g.runs, g.derived),
      example: g.example,
      waitedMs: g.waited,
      // A wait loop run in the background is itself a wait, not a run other work filled.
      filledMs: group === 'wait loop' ? 0 : Math.max(0, g.bgRun - g.waitedBg),
      runs: g.runs,
      avgMs: g.runs ? Math.round(g.runMs / g.runs) : 0,
      maxMs: g.maxMs,
      share: total ? Math.round((g.waited / total) * 1000) / 10 : 0,
    }))
    .filter((c) => c.waitedMs > 0)
    .sort((a, b) => b.waitedMs - a.waitedMs);
}

/**
 * A group's intent: the agents' most common description of it, when it speaks for the group (given at least twice,
 * or the group ran three times or fewer); else the one derived from the command (a single description among many
 * runs describes that run, not the group).
 */
function intentOf(intents: Map<string, number>, runs: number, derived: string): string {
  const [best, n] = [...intents].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  return best && (n >= 2 || runs <= 3) ? best : derived;
}

/** "Most of the waiting was to X (12 min), Y (8 min) and Z (3 min)." */
export function commandsTop(rows: CommandRow[]): string {
  const top = rows.slice(0, 3).map((r) => `${r.intent.charAt(0).toLowerCase()}${r.intent.slice(1)} (${mins(r.waitedMs)})`);
  if (!top.length) return '';
  const list = top.length === 1 ? top[0] : `${top.slice(0, -1).join(', ')} and ${top[top.length - 1]}`;
  return `Most of the waiting was to ${list}.`;
}

/**
 * The split of the last 7 days (and the 7 before) for each project, or one, from the stored days; filters: who, tier.
 * With combine, one entry for all projects together (the user's choice: projects differ widely).
 */
export function activityView(opts: { project?: string | null; who?: string | null; tier?: string | null; combine?: boolean; allTime?: boolean }, at = now(), tz = userZone()): ProjectActivity[] {
  const end = dayStart(at, tz, 1);
  const from = dayStart(at, tz, -6);
  const prevFrom = dayStart(at, tz, -13);
  const where = ['day >= ?', 'day < ?'];
  const args: unknown[] = [prevFrom, end];
  if (opts.project) (where.push('a.project_id = ?'), args.push(opts.project));
  if (opts.who) (where.push('who = ?'), args.push(opts.who));
  if (opts.tier) (where.push('tier = ?'), args.push(opts.tier));
  const stored = all(`SELECT a.project_id, day, who, tier, category, SUM(ms) AS ms, SUM(tokens) AS tokens FROM activity_days a JOIN projects p ON p.id = a.project_id WHERE p.archived = 0 AND ${where.join(' AND ')} GROUP BY 1, 2, 3, 4, 5`, ...args);
  const names = new Map(all('SELECT id, name FROM projects').map((p) => [String(p.id), String(p.name)]));
  const rows = sinceReset(stored, (pid, f) => afterReset(pid, f, tz).rows.map((r) => ({ ...r, project_id: pid })), { project: opts.project ?? null, who: opts.who ?? null, tier: opts.tier ?? null }, prevFrom, end, !!opts.allTime, tz)
    .map((r): Row => ({ ...r, name: names.get(String(r.project_id)) ?? r.project_id, cur: Number(r.day) >= from }));
  const groups = new Map<string, { name: string; rows: Row[] }>();
  for (const r of rows) {
    const key = opts.combine ? 'all' : String(r.project_id);
    const g = groups.get(key) ?? { name: opts.combine ? 'All projects' : String(r.name), rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  return [...groups].map(([id, g]) => {
    const cur = (c: string) => g.rows.filter((r) => r.cur && r.category === c).reduce((n, r) => n + Number(r.ms), 0);
    const prev = (c: string) => g.rows.filter((r) => !r.cur && r.category === c).reduce((n, r) => n + Number(r.ms), 0);
    const tok = (c: string) => g.rows.filter((r) => r.cur && r.category === c).reduce((n, r) => n + Number(r.tokens), 0);
    const activeMs = CATEGORIES.reduce((n, c) => n + cur(c), 0);
    const prevActiveMs = CATEGORIES.reduce((n, c) => n + prev(c), 0);
    const categories = CATEGORIES.map((c) => ({ category: c, label: CATEGORY_LABEL[c], ms: cur(c), share: activeMs ? Math.round((cur(c) / activeMs) * 1000) / 10 : 0, prevMs: prev(c), tokens: tok(c) })).filter((c) => c.ms || c.prevMs);
    const top = [...categories].sort((a, b) => b.ms - a.ms).slice(0, 3).filter((c) => c.ms > 0).map((c) => `${c.label.toLowerCase()} ${c.share}%`);
    const commands = commandRows(opts.combine ? null : id, from, end, opts.who ?? null, opts.tier ?? null, !!opts.allTime, tz);
    return { project_id: id, name: g.name, activeMs, prevActiveMs, categories, top, tokens: categories.reduce((n, c) => n + c.tokens, 0), commands, commandsTop: commandsTop(commands) };
  }).sort((a, b) => b.activeMs - a.activeMs);
}

/** For the director's tool: its own project's split as lines. */
export function activityText(projectId: string): string {
  const [p] = activityView({ project: projectId });
  if (!p) return 'What agents spent time on: nothing recorded in the last 7 days.';
  const h = (ms: number) => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);
  return [
    `What agents spent time on, last 7 days (${h(p.activeMs)} of agent time; before: ${h(p.prevActiveMs)}). Biggest: ${p.top.join(', ')}.`,
    ...p.categories.filter((c) => c.ms).sort((a, b) => b.ms - a.ms).map((c) => `- ${c.label}: ${h(c.ms)}, ${c.share}% (before ${h(c.prevMs)}; ~${Math.round(c.tokens / 1000)}k tokens, estimated)`),
    ...(p.commands.length
      ? [
          `Waiting on commands, by command (top ten). ${p.commandsTop}`,
          ...p.commands.slice(0, 10).map((c) => `- ${c.intent} (\`${c.group}\`): waited ${mins(c.waitedMs)} with nothing else in hand, ${c.share}%${c.filledMs ? `; other work filled ${mins(c.filledMs)}` : ''}; ${c.runs} runs, average ${mins(c.avgMs)}, longest ${mins(c.maxMs)}`),
        ]
      : []),
  ].join('\n');
}

let timer: NodeJS.Timeout | null = null;
export function startActivity() {
  if (timer) return;
  const tick = () => {
    try {
      refreshAllActivity();
    } catch (err) {
      console.error('Activity measure:', err);
    }
  };
  timer = setInterval(tick, 30 * 60_000);
  timer.unref?.();
  setTimeout(tick, 4 * 60_000).unref?.();
}
export function stopActivity() {
  if (timer) clearInterval(timer);
  timer = null;
}
