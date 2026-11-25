import { all, db, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { activityText } from './activitystats.ts';
import { taskTimes } from './worktime.ts';
import { biggestOf, recordTaskTime, slowestItems } from './tasktime.ts';
import { getTiers } from './tiers.ts';
import { userZone } from './clock.ts';
import { getChoice } from './settings.ts';
import { eventTrigger, turnInbound } from './turns.ts';
import { onTaskUsage } from './usage.ts';
import { hostFreeWaitMs, idleWaitMs } from './commands.ts';
import { idleSplit } from './watchdog.ts';
import { recordRework, reworkRows } from './rework.ts';
import type { Periods } from './rework.ts';
import { projectsReset, resetInfo, sinceSql } from './telemetryreset.ts';

/**
 * Telemetry: one row per finished task, kept in its own table (task_telemetry) so it outlives the history it was
 * read from, and the summaries the Telemetry page (install-wide, the user's only) and a director's `telemetry` tool
 * (its own project only) show.
 *
 * Tokens per task come from token_usage (usage.ts): building is the task's own agents, directing the director's
 * turns about it (a turn is about the task its inbound message names, see turnTask), subagents the quick helpers and
 * the SDK subagents an agent started. A task with no token rows at all has tokens unknown (NULL): tokens were not
 * recorded before usage.ts existed, and those tasks are left out of token figures rather than counted as zero.
 */

db.exec(`CREATE TABLE IF NOT EXISTS task_telemetry (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  tier TEXT,
  work_mode TEXT,
  who TEXT,
  agents_n INTEGER NOT NULL DEFAULT 0,
  helpers_n INTEGER NOT NULL DEFAULT 0,
  subagents_n INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER,
  tokens_directing INTEGER,
  tokens_building INTEGER,
  tokens_subagents INTEGER,
  active_ms INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER NOT NULL,
  wait_user_ms INTEGER NOT NULL DEFAULT 0,
  wait_commands_ms INTEGER NOT NULL DEFAULT 0,
  review_rounds INTEGER NOT NULL DEFAULT 0,
  director_turns INTEGER NOT NULL DEFAULT 0,
  followup_task_id TEXT,
  backfilled INTEGER NOT NULL DEFAULT 0,
  recorded_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_telemetry_finished ON task_telemetry(finished_at);
CREATE TABLE IF NOT EXISTS telemetry_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

// Work time and time to ship (worktime.ts): null where the history cannot tell.
// ran_fresh: 1 when a fresh builder built the task (dispatch.ts), 0 when the standing Builder did in its own context, null otherwise.
// The watchdog's split of between-turn time (watchdog.ts): idle with nothing pending, waiting on a request, busy on commands.
for (const c of ['work_ms', 'ship_ms', 'queued_ms', 'wait_you_ms', 'review_ms', 'live_ms', 'ran_fresh', 'idle_none_ms', 'idle_request_ms', 'idle_busy_ms']) {
  if (!(db.prepare('PRAGMA table_info(task_telemetry)').all() as { name: string }[]).some((x) => x.name === c)) {
    try {
      db.exec(`ALTER TABLE task_telemetry ADD COLUMN ${c} INTEGER`);
    } catch (err) {
      if (!/duplicate column/.test(String((err as Error).message))) throw err;
    }
  }
}
// Waiting that could have been work (commands.ts): commands running with nothing else in hand, and a host of the
// project sitting free while a heavy job of the task queued.
// Progress checks (progress.ts): flags raised on the task and re-plans recorded after them.
for (const c of ['wait_idle_ms', 'host_free_wait_ms', 'progress_flags', 'replans', 'check_not_run']) {
  // The runner and the web service may both start at once: the other one adding it first is fine.
  if (!(db.prepare('PRAGMA table_info(task_telemetry)').all() as { name: string }[]).some((x) => x.name === c)) {
    try {
      db.exec(`ALTER TABLE task_telemetry ADD COLUMN ${c} INTEGER NOT NULL DEFAULT 0`);
    } catch (err) {
      if (!/duplicate column/.test(String((err as Error).message))) throw err;
    }
  }
}

/** A follow-up task names a finished one within this long of its finish. */
export const FOLLOWUP_MS = 7 * 24 * 3600_000;

// ---------- which task a director turn was about ----------

const TASK_ID = /^task_[0-9a-f]+$/;
/**
 * The task a turn's inbound messages were about: the first that names one (turns.ts `about`), else a consult's
 * task="…" attribute, else the task of the agent whose report or question it is (id="ag_…").
 */
export function taskOfInbound(events: Row[]): string | null {
  for (const e of events) {
    const data = e.data;
    const about = eventTrigger(data).about;
    if (about && TASK_ID.test(about)) return about;
    const text = String(data.text ?? '');
    const head = /^<([a-z-]+)\s([^>]*)>/.exec(text.replace(/^<presence[^>]*>\s*/, ''));
    if (!head) continue;
    const task = /\btask="(task_[0-9a-f]+)"/.exec(head[2])?.[1];
    if (task) return task;
    const agentId = /\bid="(ag_[0-9a-f]+)"/.exec(head[2])?.[1];
    const t = agentId ? get('SELECT task_id FROM agents WHERE id = ?', agentId)?.task_id : null;
    if (t && TASK_ID.test(t)) return t;
  }
  return null;
}

/** The task the director's turn now ending was about (runner side, before its result event is added). */
export const directorTurnTask = (agentId: string) => taskOfInbound(turnInbound(agentId, Number.MAX_SAFE_INTEGER));

// ---------- the row ----------

/** Total time covered by intervals, overlaps counted once. */
export function unionMs(spans: [number, number][]): number {
  const s = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of s) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

/**
 * The work mode a task finished in: the project's mode when it finishes now. For a task finished before telemetry
 * (backfill) the mode then is not recorded: builder if a builder worked on it or handed it on, else team (the only
 * mode before builder mode existed).
 */
function modeOf(t: Row, backfill: boolean, builderWorked: boolean): string {
  if (!backfill) return 'builder';
  return builderWorked || get('SELECT 1 FROM builder_batch WHERE task_id = ?', t.id) ? 'builder' : 'team';
}

/** A finished task's work time and time to ship, as task_telemetry columns (null where unknown). */
function timesCols(t: Row): Row {
  const x = taskTimes(t);
  // A dropped task shipped nothing: its work time counts, no time to ship.
  return {
    work_ms: x.workMs,
    ship_ms: x.shipMs,
    queued_ms: x.parts?.queuedMs ?? null,
    wait_you_ms: x.parts?.waitingYouMs ?? null,
    review_ms: x.parts?.reviewMs ?? null,
    live_ms: x.liveMs,
  };
}

/** Compute a finished task's row from what the database holds now. */
export function telemetryRow(t: Row, backfill = false): Row {
  const end = Number(t.finished_at ?? now());
  const start = Number(t.started_at ?? t.created_at);
  const usage = all(
    `SELECT u.agent_id, u.who, u.tokens, a.parent_id, a.quick, a.role_id FROM token_usage u LEFT JOIN agents a ON a.id = u.agent_id WHERE u.task_id = ?`,
    t.id,
  );
  let directing = 0, building = 0, subagents = 0, directorTurns = 0;
  for (const u of usage) {
    const n = Number(u.tokens);
    if (u.who === 'director' || (u.who == null && u.parent_id == null && u.role_id != null)) {
      directing += n;
      directorTurns++;
    } else if (u.who === 'subagent' || u.quick) subagents += n;
    else building += n;
  }
  const known = usage.length > 0;
  // The agents that worked on it: its driver, any agent whose turns were counted for it, agents now on it.
  const agents = all(
    `SELECT id, parent_id, quick, role_id FROM agents WHERE parent_id IS NOT NULL AND (id = ? OR task_id = ? OR id IN (SELECT agent_id FROM token_usage WHERE task_id = ?))`,
    t.driver_agent_id ?? '', t.id, t.id,
  );
  // A builder's SDK subagents have rows of their own (subagents.ts): counted as subagents, not workers.
  const subRows = agents.filter((a) => a.role_id === 'subagent');
  const workers = agents.filter((a) => !a.quick && a.role_id !== 'subagent');
  const helpers = agents.filter((a) => a.quick);
  const who = workers.some((a) => a.role_id === 'builder') ? 'builder' : workers.length ? 'area' : directing ? 'director' : 'none';
  // SDK subagents and long commands, from the workers' transcripts while the task ran.
  let subagentsN = 0;
  const commandSpans: [number, number][] = [];
  for (const a of agents.filter((x) => x.role_id !== 'subagent')) {
    const open = new Map<string, number>();
    for (const e of all("SELECT ts, kind, data FROM events WHERE agent_id = ? AND ts >= ? AND ts <= ? AND kind IN ('tool', 'tool_result') ORDER BY id", a.id, start, end)) {
      let d: Row;
      try {
        d = JSON.parse(e.data);
      } catch {
        continue;
      }
      if (e.kind === 'tool') {
        if (d.name === 'Agent' || d.name === 'Task') subagentsN++;
        if (d.name === 'Bash' && d.id) open.set(d.id, e.ts);
      } else if (open.has(d.id)) {
        commandSpans.push([open.get(d.id)!, e.ts]);
        open.delete(d.id);
      }
    }
  }
  const userSpans = all(
    "SELECT created_at, COALESCE(answered_at, ?) AS answered_at FROM inbox WHERE task_id = ? AND (decided_by IS NULL OR decided_by = 'user')",
    end, t.id,
  ).map((r): [number, number] => [Math.max(Number(r.created_at), Number(t.created_at)), Math.min(Number(r.answered_at), end)]);
  return {
    task_id: t.id,
    project_id: t.project_id,
    title: t.title,
    state: t.state,
    tier: t.tier ?? null,
    work_mode: modeOf(t, backfill, who === 'builder'),
    who,
    agents_n: workers.length,
    helpers_n: helpers.length,
    // A builder's subagents are rows; its Agent calls in the window may be for other tasks it took alongside.
    subagents_n: subRows.length || (who === 'builder' ? 0 : subagentsN),
    tokens: known ? directing + building + subagents : null,
    tokens_directing: known ? directing : null,
    tokens_building: known ? building : null,
    tokens_subagents: known ? subagents : null,
    active_ms: Number(t.active_ms ?? 0),
    created_at: Number(t.became_task_at ?? t.created_at),
    started_at: t.started_at ?? null,
    finished_at: end,
    wait_user_ms: unionMs(userSpans),
    wait_commands_ms: unionMs(commandSpans),
    wait_idle_ms: idleWaitMs(t.id, end),
    host_free_wait_ms: hostFreeWaitMs(t.id),
    review_rounds: Number(get("SELECT COUNT(*) AS n FROM consults WHERE task_id = ? AND kind = 'review'", t.id)?.n ?? 0),
    director_turns: directorTurns,
    ...timesCols(t),
    progress_flags: Number(get('SELECT flags_total AS n FROM task_progress WHERE task_id = ?', t.id)?.n ?? 0),
    replans: Number(get('SELECT replans_total AS n FROM task_progress WHERE task_id = ?', t.id)?.n ?? 0),
    // Finished with its check not run (gates.ts check_not_run): how often the escape is used.
    check_not_run: t.check_not_run ? 1 : 0,
    ran_fresh: backfill || who !== 'builder' ? null : ranFresh(t),
    followup_task_id: followupOf(t.id, end),
    ...idleSplit(t.id),
  };
}

/**
 * Whether a fresh builder built a builder's task (dispatch.ts: one started for that task alone, agents.per_task), or the
 * standing Builder that held the queue before, in its own long context. Subagents on parts of it do not change that.
 */
function ranFresh(t: Row): 0 | 1 {
  const driver = t.driver_agent_id ? get('SELECT per_task FROM agents WHERE id = ?', t.driver_agent_id) : undefined;
  return driver?.per_task ? 1 : 0;
}

const COLS = [
  'task_id', 'project_id', 'title', 'state', 'tier', 'work_mode', 'who', 'agents_n', 'helpers_n', 'subagents_n', 'tokens', 'tokens_directing', 'tokens_building',
  'tokens_subagents', 'active_ms', 'created_at', 'started_at', 'finished_at', 'wait_user_ms', 'wait_commands_ms', 'wait_idle_ms', 'host_free_wait_ms', 'review_rounds', 'director_turns', 'followup_task_id',
  'progress_flags', 'replans', 'work_ms', 'ship_ms', 'queued_ms', 'wait_you_ms', 'review_ms', 'live_ms', 'check_not_run', 'ran_fresh',
  'idle_none_ms', 'idle_request_ms', 'idle_busy_ms',
];
function store(r: Row, backfilled: boolean) {
  run(
    `INSERT OR REPLACE INTO task_telemetry (${COLS.join(', ')}, backfilled, recorded_at) VALUES (${COLS.map(() => '?').join(', ')}, ?, ?)`,
    ...COLS.map((c) => r[c]), backfilled ? 1 : 0, now(),
  );
}

/** A task reached done or dropped: record (or re-record) its row. Never throws: telemetry must not break a finish. */
export function recordTaskTelemetry(taskId: string, refresh = false) {
  try {
    const t = get("SELECT * FROM tasks WHERE id = ? AND kind = 'task'", taskId);
    if (!t || (t.state !== 'done' && t.state !== 'dropped')) return;
    // A refresh keeps a backfilled row backfilled; finishing (again) records it afresh.
    const old = refresh ? get('SELECT backfilled, ran_fresh FROM task_telemetry WHERE task_id = ?', taskId) : undefined;
    const backfilled = !!old?.backfilled;
    const row = telemetryRow(t, backfilled);
    // How it ran is what held when it finished: by a refresh the builder has moved on to another task.
    if (old) row.ran_fresh = old.ran_fresh ?? null;
    store(row, backfilled);
    // Where its time went, and its rework and errors, kept with it (tasktime.ts, rework.ts).
    recordTaskTime(taskId);
    if (!refresh) recordRework(taskId);
  } catch (err) {
    console.warn(`telemetry: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
}

/** Tokens were recorded for a task: if it already has a row (it finished), bring the row up to date. */
export function refreshTaskTelemetry(taskId: string) {
  if (get('SELECT 1 FROM task_telemetry WHERE task_id = ?', taskId)) recordTaskTelemetry(taskId, true);
}

onTaskUsage(refreshTaskTelemetry);

// ---------- follow-ups ----------

const named = (text: string) => new Set([...String(text).matchAll(/task_[0-9a-f]{10}\b/g)].map((m) => m[0]));

/** The first task created within FOLLOWUP_MS after `finishedAt` that names this one. */
function followupOf(taskId: string, finishedAt: number): string | null {
  for (const t of all("SELECT id, title, description FROM tasks WHERE kind = 'task' AND id != ? AND created_at >= ? AND created_at <= ? AND (title LIKE ? OR description LIKE ?) ORDER BY created_at", taskId, finishedAt, finishedAt + FOLLOWUP_MS, `%${taskId}%`, `%${taskId}%`)) {
    if (named(`${t.title} ${t.description}`).has(taskId)) return String(t.id);
  }
  return null;
}

/** A task was created: mark the finished tasks it names (within FOLLOWUP_MS of their finish) as followed up. */
export function noteFollowups(task: Row) {
  try {
    for (const id of named(`${task.title} ${task.description ?? ''}`)) {
      if (id === task.id) continue;
      run('UPDATE task_telemetry SET followup_task_id = ? WHERE task_id = ? AND followup_task_id IS NULL AND finished_at <= ? AND finished_at >= ?', task.id, id, task.created_at, Number(task.created_at) - FOLLOWUP_MS);
    }
  } catch (err) {
    console.warn(`telemetry: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
}

// ---------- backfill ----------

/**
 * Once: director turns recorded before turns were attributed get the task their inbound messages named, and every
 * task finished before telemetry existed gets its row from what the database holds (tokens unknown where none were
 * recorded). Idempotent: later runs only add rows for finished tasks that have none.
 */
export function backfillTelemetry(): { attributed: number; rows: number } {
  let attributed = 0;
  if (!get("SELECT 1 FROM telemetry_state WHERE key = 'director_turns_attributed'")) {
    tx(() => {
      const rows = all(
        `SELECT u.id, u.agent_id, u.at FROM token_usage u JOIN agents a ON a.id = u.agent_id WHERE u.task_id IS NULL AND a.parent_id IS NULL ORDER BY u.id`,
      );
      for (const u of rows) {
        // The turn's result event: the last one of the agent at or just before the usage row.
        const res = get("SELECT id FROM events WHERE agent_id = ? AND kind = 'result' AND ts <= ? ORDER BY id DESC LIMIT 1", u.agent_id, Number(u.at) + 1000);
        const nextRes = res ? Number(res.id) : Number.MAX_SAFE_INTEGER;
        const task = taskOfInbound(turnInbound(u.agent_id, nextRes));
        if (task && get('SELECT 1 FROM tasks WHERE id = ?', task)) {
          run('UPDATE token_usage SET task_id = ? WHERE id = ?', task, u.id);
          attributed++;
        }
      }
      run("INSERT OR REPLACE INTO telemetry_state (key, value) VALUES ('director_turns_attributed', ?)", String(now()));
    });
  }
  // Once: work time and time to ship for rows recorded before they were kept (only those columns change).
  if (!get("SELECT 1 FROM telemetry_state WHERE key = 'work_times'")) {
    tx(() => {
      for (const r of all('SELECT task_id FROM task_telemetry')) {
        const t = get('SELECT * FROM tasks WHERE id = ?', r.task_id);
        if (!t) continue;
        const c = timesCols(t);
        run('UPDATE task_telemetry SET work_ms = ?, ship_ms = ?, queued_ms = ?, wait_you_ms = ?, review_ms = ?, live_ms = ? WHERE task_id = ?', c.work_ms, c.ship_ms, c.queued_ms, c.wait_you_ms, c.review_ms, c.live_ms, r.task_id);
      }
      run("INSERT OR REPLACE INTO telemetry_state (key, value) VALUES ('work_times', ?)", String(now()));
    });
  }
  const missing = all("SELECT * FROM tasks WHERE kind = 'task' AND state IN ('done', 'dropped') AND finished_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_telemetry m WHERE m.task_id = tasks.id)");
  tx(() => {
    for (const t of missing) store(telemetryRow(t, true), true);
  });
  return { attributed, rows: missing.length };
}

// ---------- summaries ----------

/** allTime: ignore the reset (telemetryreset.ts) for this view; otherwise each project counts from its last reset. */
export type Filter = { project?: string | null; tier?: string | null; mode?: string | null; period?: 'day' | 'week'; allTime?: boolean };
export type MetricKey = 'tokens' | 'cycle' | 'director' | 'rate';
export type Metric = { key: MetricKey; label: string; value: number | null; prev: number | null; unit: string; better: 'lower' | 'higher'; n: number };
export type Summary = {
  period: 'day' | 'week';
  zone: string;
  metrics: Metric[];
  /** The current period's tokens by who spent them (the director's share is over the total). */
  totals: TokenTotals;
  /** The current period's tokens by model, Deep's share of work tokens, and the Deep tasks with their reasons. */
  models: ReturnType<typeof modelUse>;
  deep: Row[];
  chart: { labels: string[]; series: Record<MetricKey, (number | null)[]> };
  table: Row[];
  /** Time to ship, under its own name: the period's median and the shares of all of it (queued, working, waiting on you, review). */
  slowItems: ReturnType<typeof slowestItems>;
  ship: { median: number | null; n: number; shares: { queued: number; working: number; waitingYou: number; review: number } | null };
  /** The current period's builder tasks split by how they ran: a fresh builder per task, or the standing Builder. */
  fresh: FreshSplit;
  /** The reset the view counts from (null: none), whether it ignores it (Show all time), and how many projects have their own. */
  reset: ReturnType<typeof resetInfo>;
  allTime: boolean;
  projectsReset: number;
  projects: { id: string; name: string }[];
  tiers: string[];
  modes: string[];
};

const HOUR = 3600_000;

/** Offset of `tz` from UTC at `ms` (ms to add to UTC to get the wall clock). */
function offsetAt(ms: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(ms)) {
    if (x.type !== 'literal') p[x.type] = Number(x.value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
/** Local midnight (in `tz`) of the day `ms` falls in, `days` days later (may be negative). */
export function dayStart(ms: number, tz: string, days = 0): number {
  const wall = ms + offsetAt(ms, tz);
  const d = new Date(wall);
  const midnightWall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days);
  let t = midnightWall - offsetAt(midnightWall, tz);
  t = midnightWall - offsetAt(t, tz); // across a DST change the offset at midnight itself is the one that counts
  return t;
}

/** The periods the page shows: today or the last 7 days, the one before, and the history's buckets (14 days, 8 weeks). */
export function periodsOf(period: 'day' | 'week', at = now(), tz = userZone()): Periods {
  const step = period === 'day' ? 1 : 7;
  const buckets = period === 'day' ? 14 : 8;
  const curStart = period === 'day' ? dayStart(at, tz) : dayStart(at, tz, -6);
  const edges: number[] = [];
  for (let i = buckets - 1; i >= 0; i--) edges.push(dayStart(curStart, tz, -i * step));
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
  return { period, edges, end: dayStart(curStart, tz, step), curStart, prevStart: dayStart(curStart, tz, -step), labels: edges.map((e) => fmt.format(e)) };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export type TokenTotals = { directing: number; building: number; subagents: number; total: number };

/**
 * All tokens recorded in [from, to) by who spent them, whether or not they belong to a task: the director's turns
 * with the user, planning and batch reviews are most of its tokens and belong to none. `who` (usage.ts) says it; a
 * row from before `who` was recorded counts as the director's when its agent has no parent. The tier filter applies
 * (token_usage keeps the tier); the work-mode filter does not (token_usage has no mode).
 */
export function tokenTotals(f: Filter, from: number, to: number): TokenTotals {
  const where = ['u.at >= ?', 'u.at < ?'];
  const args: unknown[] = [from, to];
  if (f.project) (where.push('u.project_id = ?'), args.push(f.project));
  if (f.tier) (where.push("COALESCE(u.tier, 'none') = ?"), args.push(f.tier));
  const r = get(
    `SELECT
       COALESCE(SUM(CASE WHEN u.who = 'director' OR (u.who IS NULL AND a.parent_id IS NULL) THEN u.tokens END), 0) AS directing,
       COALESCE(SUM(CASE WHEN u.who = 'subagent' OR a.quick = 1 THEN u.tokens END), 0) AS subagents,
       COALESCE(SUM(u.tokens), 0) AS total
     FROM token_usage u LEFT JOIN agents a ON a.id = u.agent_id WHERE ${where.join(' AND ')}${sinceSql('u.at', 'u.project_id', f.allTime)}`,
    ...args,
  )!;
  const directing = Number(r.directing);
  const subagents = Number(r.subagents);
  const total = Number(r.total);
  return { directing, subagents, building: Math.max(0, total - directing - subagents), total };
}

/**
 * Where the tokens of [from, to) went by model (each tier's model now; rows from before tiers were recorded as
 * "unknown"), and the share of work tokens (everything but the director's) that ran at Deep (Fable): Deep is meant
 * for directing, so work on it is the exception to watch.
 */
export function modelUse(f: Filter, from: number, to: number): { byModel: { model: string; tier: string; tokens: number }[]; deepWork: number; work: number; deepShare: number | null } {
  const where = ['u.at >= ?', 'u.at < ?'];
  const args: unknown[] = [from, to];
  if (f.project) (where.push('u.project_id = ?'), args.push(f.project));
  const rows = all(
    `SELECT COALESCE(u.tier, 'none') AS tier,
            SUM(u.tokens) AS tokens,
            SUM(CASE WHEN u.who = 'director' OR (u.who IS NULL AND a.parent_id IS NULL) THEN 0 ELSE u.tokens END) AS work
       FROM token_usage u LEFT JOIN agents a ON a.id = u.agent_id WHERE ${where.join(' AND ')}${sinceSql('u.at', 'u.project_id', f.allTime)} GROUP BY 1`,
    ...args,
  );
  const model = (tier: string) => getTiers().find((t) => t.id === tier)?.model ?? 'unknown';
  const merged = new Map<string, { model: string; tier: string; tokens: number }>();
  for (const r of rows) {
    const m = model(String(r.tier));
    const cur = merged.get(m) ?? { model: m, tier: String(r.tier), tokens: 0 };
    cur.tokens += Number(r.tokens);
    merged.set(m, cur);
  }
  const work = rows.reduce((n, r) => n + Number(r.work), 0);
  const deepWork = Number(rows.find((r) => r.tier === 'deep')?.work ?? 0);
  return { byModel: [...merged.values()].sort((a, b) => b.tokens - a.tokens), deepWork, work, deepShare: work > 0 ? Math.round((deepWork / work) * 1000) / 10 : null };
}

/** Tasks at Deep that ran in [from, to) (or run now), with the reason they were given it. */
export function deepTasks(f: Filter, from: number, to: number): Row[] {
  return all(
    `SELECT t.id, t.project_id, p.name AS project, t.title, t.state, t.tier_reason FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.kind = 'task' AND t.tier = 'deep' AND t.started_at IS NOT NULL AND t.started_at < ? AND COALESCE(t.finished_at, ?) >= ? ${f.project ? 'AND t.project_id = ?' : ''}${sinceSql('t.started_at', 't.project_id', f.allTime)}
      ORDER BY t.started_at DESC LIMIT 20`,
    to, to, from, ...(f.project ? [f.project] : []),
  );
}

/** The four numbers over a set of rows (accepted = done; dropped tasks count nowhere) and the period's token totals. */
export function metricsOf(rows: Row[], totals?: TokenTotals): Record<MetricKey, { value: number | null; n: number }> {
  const done = rows.filter((r) => r.state === 'done');
  const known = done.filter((r) => r.tokens != null);
  const tokens = known.reduce((n, r) => n + Number(r.tokens), 0);
  // Work time, never waiting on the user (worktime.ts); tasks whose work time is unknown are left out of both.
  const worked = done.filter((r) => r.work_ms != null);
  const workH = worked.reduce((n, r) => n + Number(r.work_ms), 0) / HOUR;
  return {
    tokens: { value: known.length ? Math.round(tokens / known.length) : null, n: known.length },
    cycle: { value: median(worked.map((r) => Number(r.work_ms))), n: worked.length },
    // All the director's tokens in the period over all tokens in it, not only those of finished tasks (tokenTotals).
    director: { value: totals && totals.total > 0 ? Math.round((totals.directing / totals.total) * 1000) / 10 : null, n: totals?.total ?? 0 },
    rate: { value: workH > 0 ? Math.round((worked.length / workH) * 100) / 100 : null, n: worked.length },
  };
}

const META: Record<MetricKey, { label: string; unit: string; better: 'lower' | 'higher' }> = {
  tokens: { label: 'Tokens per task', unit: 'tokens', better: 'lower' },
  cycle: { label: 'Median work time', unit: 'ms', better: 'lower' },
  director: { label: 'Director share of all tokens', unit: '%', better: 'lower' },
  rate: { label: 'Tasks per work hour', unit: '/h', better: 'higher' },
};
export const METRIC_KEYS = Object.keys(META) as MetricKey[];

/** Rows matching a filter (all projects unless one is named), oldest first. */
export function telemetryRows(f: Filter, from = 0, to = Number.MAX_SAFE_INTEGER): Row[] {
  const where = ['finished_at >= ?', 'finished_at < ?'];
  const args: unknown[] = [from, to];
  if (f.project) (where.push('project_id = ?'), args.push(f.project));
  if (f.tier) (where.push("COALESCE(tier, 'none') = ?"), args.push(f.tier));
  if (f.mode) (where.push('work_mode = ?'), args.push(f.mode));
  return all(`SELECT * FROM task_telemetry WHERE ${where.join(' AND ')}${sinceSql('finished_at', 'task_telemetry.project_id', f.allTime)} ORDER BY finished_at`, ...args);
}

/**
 * The page's view: the four numbers for the current period (today, or the last 7 days) against the one before, each
 * one's history (14 days, or 8 weeks) for the chart, and the slowest and costliest tasks over that history.
 */
export function telemetrySummary(f: Filter, at = now(), tz = userZone()): Summary {
  const period = f.period === 'week' ? 'week' : 'day';
  const step = period === 'day' ? 1 : 7;
  const buckets = period === 'day' ? 14 : 8;
  const curStart = period === 'day' ? dayStart(at, tz) : dayStart(at, tz, -6);
  const edges: number[] = [];
  for (let i = buckets - 1; i >= 0; i--) edges.push(dayStart(curStart, tz, -i * step));
  const end = dayStart(curStart, tz, step);
  const rows = telemetryRows(f, edges[0], end);
  const inRange = (a: number, b: number) => rows.filter((r) => r.finished_at >= a && r.finished_at < b);
  const totals = tokenTotals(f, curStart, end);
  const cur = metricsOf(inRange(curStart, end), totals);
  const prevRows = telemetryRows(f, dayStart(curStart, tz, -step), curStart);
  const prev = metricsOf(prevRows, tokenTotals(f, dayStart(curStart, tz, -step), curStart));
  const series = Object.fromEntries(METRIC_KEYS.map((k) => [k, [] as (number | null)[]])) as Record<MetricKey, (number | null)[]>;
  const labels: string[] = [];
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
  edges.forEach((a, i) => {
    const b = i + 1 < edges.length ? edges[i + 1] : end;
    const m = metricsOf(inRange(a, b), tokenTotals(f, a, b));
    for (const k of METRIC_KEYS) series[k].push(m[k].value);
    labels.push(fmt.format(a));
  });
  const names = new Map(all('SELECT id, name FROM projects').map((p) => [String(p.id), String(p.name)]));
  const done = rows.filter((r) => r.state === 'done');
  // The slowest by work time and the costliest; each with its work time and, under its own name, its time to ship.
  const workOf = (r: Row) => (r.work_ms == null ? -1 : Number(r.work_ms));
  const slow = [...done].sort((a, b) => workOf(b) - workOf(a)).slice(0, 5);
  const costly = done.filter((r) => r.tokens != null).sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  const table = [...new Map([...slow, ...costly].map((r) => [r.task_id, r])).values()]
    .sort((a, b) => workOf(b) - workOf(a))
    .map((r) => ({ task_id: r.task_id, project_id: r.project_id, project: names.get(r.project_id) ?? r.project_id, title: r.title, work_ms: r.work_ms, ship_ms: r.ship_ms, tokens: r.tokens, biggest: biggestOf(r.task_id) }));
  // Time to ship over the period's finished tasks: the median, and where all of it went.
  const curDone = inRange(curStart, end).filter((r) => r.state === 'done');
  const shipped = curDone.filter((r) => r.ship_ms != null && r.wait_you_ms != null);
  const sum = (k: string) => shipped.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  const all_ = sum('ship_ms');
  const ship = {
    median: median(curDone.filter((r) => r.ship_ms != null).map((r) => Number(r.ship_ms))),
    n: curDone.length,
    shares: all_ > 0 ? { queued: Math.round((sum('queued_ms') / all_) * 100), working: Math.round((sum('work_ms') / all_) * 100), waitingYou: Math.round((sum('wait_you_ms') / all_) * 100), review: Math.round((sum('review_ms') / all_) * 100) } : null,
  };
  return {
    period,
    zone: tz,
    metrics: METRIC_KEYS.map((k) => ({ key: k, ...META[k], value: cur[k].value, prev: prev[k].value, n: cur[k].n })),
    totals,
    models: modelUse(f, curStart, end),
    deep: deepTasks(f, curStart, end),
    chart: { labels, series },
    table,
    ship,
    // What makes tasks slow (tasktime.ts): the items that cost the most across the period's finished tasks.
    slowItems: slowestItems(f.project ?? null, edges[0], end, 10, !!f.allTime),
    fresh: freshSplit(f, curStart, end),
    reset: resetInfo(f.project ?? null),
    allTime: !!f.allTime,
    projectsReset: projectsReset(),
    projects: all('SELECT DISTINCT m.project_id AS id, p.name FROM task_telemetry m JOIN projects p ON p.id = m.project_id ORDER BY p.name').map((r) => ({ id: String(r.id), name: String(r.name) })),
    tiers: all("SELECT DISTINCT COALESCE(tier, 'none') AS t FROM task_telemetry ORDER BY t").map((r) => String(r.t)),
    modes: all('SELECT DISTINCT work_mode AS m FROM task_telemetry WHERE work_mode IS NOT NULL ORDER BY m').map((r) => String(r.m)),
  };
}

// ---------- fresh builders vs the standing Builder ----------

/** One side of the split: tasks, tokens per task, median work time, rework events and review rounds per task. */
export type FreshGroup = { n: number; tokens: number | null; work_ms: number | null; rework: number | null; review_rounds: number | null };
export type FreshSplit = { fresh: FreshGroup; own: FreshGroup };

/** The done builder tasks of [from, to) split by task_telemetry.ran_fresh (rows where it is null are in neither). */
export function freshSplit(f: Filter, from: number, to: number): FreshSplit {
  const rows = telemetryRows(f, from, to).filter((r) => r.state === 'done' && r.ran_fresh != null);
  const ids = new Set(rows.map((r) => String(r.task_id)));
  const rework = new Map<string, number>();
  if (ids.size) {
    for (const x of reworkRows(f.project ?? null, from, to)) {
      if (ids.has(x.task_id)) rework.set(x.task_id, Object.values(x.kinds).reduce((n, k) => n + k.n, 0));
    }
  }
  const per = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const group = (rs: Row[]): FreshGroup => {
    const known = rs.filter((r) => r.tokens != null);
    return {
      n: rs.length,
      tokens: known.length ? Math.round(known.reduce((n, r) => n + Number(r.tokens), 0) / known.length) : null,
      work_ms: median(rs.filter((r) => r.work_ms != null).map((r) => Number(r.work_ms))),
      rework: per(rs.map((r) => rework.get(String(r.task_id)) ?? 0)),
      review_rounds: per(rs.map((r) => Number(r.review_rounds ?? 0))),
    };
  };
  return { fresh: group(rows.filter((r) => r.ran_fresh === 1)), own: group(rows.filter((r) => r.ran_fresh === 0)) };
}

/** The split as one line: fresh first, then own; '' when no task ran fresh. */
export function freshSplitText(x: FreshSplit): string {
  if (!x.fresh.n) return '';
  const side = (g: FreshGroup) =>
    `${g.n} task${g.n === 1 ? '' : 's'}, ${g.tokens == null ? 'tokens unknown' : `${tokensShort(g.tokens)} tokens`} per task, median work ${durText(g.work_ms)}, rework ${g.rework ?? 0} and review rounds ${g.review_rounds ?? 0} per task`;
  return `Fresh builders: ${side(x.fresh)}. Standing Builder: ${x.own.n ? side(x.own) : 'none'}.`;
}

// ---------- export and the director's text ----------

const csvCell = (v: unknown) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const iso = (ms: unknown) => (ms == null ? '' : new Date(Number(ms)).toISOString());

/** Every row matching the filter as CSV (times ISO in UTC, durations in minutes, tokens blank when unknown). */
export function telemetryCsv(f: Filter): string {
  const names = new Map(all('SELECT id, name FROM projects').map((p) => [String(p.id), String(p.name)]));
  const head = ['task_id', 'project', 'title', 'state', 'tier', 'work_mode', 'who', 'agents', 'helpers', 'subagents', 'tokens', 'tokens_directing_this_task', 'tokens_building', 'tokens_subagents', 'active_min', 'created', 'started', 'finished', 'cycle_min', 'wait_user_min', 'wait_commands_min', 'wait_idle_min', 'host_free_wait_min', 'review_rounds', 'director_turns', 'followup_task_id', 'progress_flags', 'replans', 'work_min', 'ship_min', 'queued_min', 'waiting_on_you_min', 'review_min', 'live_min', 'ran_fresh', 'idle_nothing_pending_min', 'idle_on_request_min', 'idle_busy_commands_min', 'backfilled'];
  const min = (ms: unknown) => (ms == null ? '' : Math.round(Number(ms) / 600) / 100);
  const lines = telemetryRows(f).map((r) =>
    [r.task_id, names.get(r.project_id) ?? r.project_id, r.title, r.state, r.tier, r.work_mode, r.who, r.agents_n, r.helpers_n, r.subagents_n, r.tokens, r.tokens_directing, r.tokens_building, r.tokens_subagents, min(r.active_ms), iso(r.created_at), iso(r.started_at), iso(r.finished_at), min(r.finished_at - r.created_at), min(r.wait_user_ms), min(r.wait_commands_ms), min(r.wait_idle_ms), min(r.host_free_wait_ms), r.review_rounds, r.director_turns, r.followup_task_id, r.progress_flags, r.replans, min(r.work_ms), min(r.ship_ms), min(r.queued_ms), min(r.wait_you_ms), min(r.review_ms), min(r.live_ms), r.ran_fresh, min(r.idle_none_ms), min(r.idle_request_ms), min(r.idle_busy_ms), r.backfilled]
      .map(csvCell)
      .join(','),
  );
  return [head.join(','), ...lines].join('\r\n') + '\r\n';
}

export const tokensShort = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
export const durText = (ms: number | null) => {
  if (ms == null) return '–';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
export function metricText(m: { key: MetricKey; value: number | null }): string {
  if (m.value == null) return '–';
  if (m.key === 'tokens') return m.value >= 1e6 ? `${(m.value / 1e6).toFixed(2)}M` : `${Math.round(m.value / 1000)}k`;
  if (m.key === 'cycle') return durText(m.value);
  if (m.key === 'director') return `${m.value}%`;
  return `${m.value}`;
}

/** Between-turn time of finished tasks, as the watchdog measured it (watchdog.ts), or '' when none was measured. */
export function idleText(rows: Row[]): string {
  const seen = rows.filter((r) => r.idle_none_ms != null);
  if (!seen.length) return '';
  const sum = (k: string) => seen.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  return `Idle between turns (watchdog, ${seen.length} task(s)): nothing pending ${durText(sum('idle_none_ms'))}, waiting on a request ${durText(sum('idle_request_ms'))}, busy on commands ${durText(sum('idle_busy_ms'))}.`;
}

/** The director's tool: its own project's numbers for today and the last 7 days, and the slowest and costliest tasks. */
export function telemetryText(projectId: string, f: Omit<Filter, 'project' | 'period'> = {}): string {
  const out: string[] = [];
  const reset = resetInfo(projectId);
  if (reset) out.push(`Counted since the user reset Telemetry${reset.scope === 'all' ? ' for all projects' : ''} at ${new Date(reset.at).toISOString()}; nothing before it is in these figures.`, '');
  out.push(activityText(projectId), '');
  for (const period of ['day', 'week'] as const) {
    const s = telemetrySummary({ ...f, project: projectId, period });
    out.push(`${period === 'day' ? 'Today' : 'Last 7 days'} (before: ${period === 'day' ? 'yesterday' : 'the 7 days before'}):`);
    for (const m of s.metrics) out.push(`- ${m.label}: ${metricText(m)} (before ${metricText({ key: m.key, value: m.prev })}; ${m.key === 'director' ? `${tokensShort(s.totals.total)} tokens in all` : `${m.n} task(s)`})`);
    out.push(`  By model: ${s.models.byModel.map((m) => `${m.model} ${tokensShort(m.tokens)}`).join(', ') || 'none'}. Work tokens at Deep: ${s.models.deepShare ?? 0}%.${s.deep.length ? ` Deep tasks: ${s.deep.map((t) => `[[${t.id}]] (${t.tier_reason || 'no reason'})`).join('; ')}.` : ''}`);
    out.push(`  Tokens: ${tokensShort(s.totals.directing)} directing, ${tokensShort(s.totals.building)} building, ${tokensShort(s.totals.subagents)} subagents. A task's own row (get_telemetry's table, the CSV) keeps "directing this task", the director's turns attributed to it.`);
    const fr = freshSplitText(s.fresh);
    if (fr) out.push(`  ${fr}`);
    const pp = periodsOf(period);
    const idle = idleText(telemetryRows({ ...f, project: projectId }, pp.curStart, pp.end));
    if (idle) out.push(`  ${idle}`);
    const sh = s.ship;
    out.push(`  Time to ship (created to done, a separate number): median ${sh.median == null ? 'none' : durText(sh.median)}${sh.shares ? `; of all of it queued ${sh.shares.queued}%, working ${sh.shares.working}%, waiting on the user ${sh.shares.waitingYou}%, review or checks ${sh.shares.review}%` : ''}.`);
    if (period === 'week') {
      out.push('Slowest (by work time) and costliest tasks, last 8 weeks:');
      for (const r of s.table) out.push(`- [[${r.task_id}]]: took ${r.work_ms == null ? 'unknown' : durText(r.work_ms)} of work, ${r.ship_ms == null ? 'unknown' : durText(r.ship_ms)} to ship, tokens ${r.tokens == null ? 'unknown' : r.tokens}`);
    }
  }
  return out.join('\n');
}
