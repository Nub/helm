import { all, db, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { activity, commandKind } from './activity.ts';
import type { Category, Span } from './activity.ts';
import { commandGroup, commandText } from './commandgroups.ts';
import { taskTimes } from './worktime.ts';
import { hostFreeWaitMs } from './commands.ts';
import { sinceSql } from './telemetryreset.ts';

/**
 * Per task: where its time went, down to the model's time and each tool and command (the user's ask: "running test
 * x, rendering scene y, compiling"). Built from the transcripts of the task's agents in the task's Active stretches by
 * the same gap rules as the project view (activity.ts onSpan), so every second is charged once:
 *
 * - waiting for the model (thinking and writing), each tool by kind (reading, searching, editing, Helm's tools, web,
 *   subagents), each command by what it is (commandgroups.ts: its intent, from the agent's description when it gave one)
 *   with its runs, failed runs, re-runs and how much of it the agent sat idle on, and idle within a turn;
 * - "other": the task's work time (worktime.ts) the transcript does not account for (between turns, gaps too long to
 *   charge), never spread over the rest; the items and "other" add up to the work time;
 * - outside the work time: waiting on the user, on review, in the queue, and on a host being free.
 *
 * The task's driver is the main line; other agents and subagents ran alongside, so their items are listed as
 * "alongside" and not added into the sum. Kept per task in task_time (so it outlives history being reduced): computed
 * when a task finishes, backfilled once for finished tasks whose history exists, live for an Active task.
 */

db.exec(`CREATE TABLE IF NOT EXISTS task_time (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  data TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_time_project ON task_time(project_id);`);

export const KINDS: Record<string, string> = {
  model: 'Waiting for the model',
  compile: 'Compiling and building',
  test: 'Running tests',
  run: 'Running and rendering',
  git: 'Git',
  script: 'Scripts',
  command: 'Other commands',
  files: 'Reading, searching, editing',
  helm: "Helm's tools",
  web: 'Web',
  subagents: 'Subagents',
  tools: 'Other tools',
  idle: 'Idle within a turn',
  other: 'Not attributed',
};

export type Run = { at: number; ms: number; failed: boolean };
export type TimeItem = { kind: string; key: string; label: string; ms: number; idle_ms: number; runs: Run[]; failed: number; alongside: boolean };
export type TaskTime = {
  task_id: string;
  work_ms: number | null;
  /** What the transcripts account for on the main line; other_ms is the rest of the work time. */
  measured_ms: number;
  other_ms: number;
  items: TimeItem[];
  kinds: { kind: string; label: string; ms: number }[];
  outside: { waiting_you_ms: number; review_ms: number; queued_ms: number; host_free_ms: number };
  model: { turns: number; slow_turns: number; tokens: number };
  computed_at: number;
};

/** A run of the model longer than this is marked slow. */
export const SLOW_TURN_MS = 2 * 60_000;
const MAX_RUNS = 100;

const CMD_KIND: Partial<Record<Category, string>> = { cmd_build: 'compile', cmd_test: 'test', cmd_run: 'run', cmd_git: 'git', cmd_script: 'script', cmd_other: 'command' };
const FILE_LABEL: Partial<Record<Category, string>> = { reading: 'Reading files', searching: 'Searching the code', editing: 'Editing files' };

/** Which item a span is part of: its kind, a key that groups like with like, and its label. */
function itemOf(s: Span): { kind: string; key: string; label: string } {
  if (s.category === 'thinking') return { kind: 'model', key: 'model', label: 'Waiting for the model (thinking and writing)' };
  if (FILE_LABEL[s.category]) return { kind: 'files', key: s.category, label: FILE_LABEL[s.category]! };
  if (s.category === 'helm') {
    const name = String(s.tool ?? '').replace(/^mcp__helm__/, '');
    return { kind: 'helm', key: `helm:${name}`, label: `Helm: ${name || 'a tool'}` };
  }
  if (s.category === 'subagents') return { kind: 'subagents', key: 'subagents', label: 'Subagents (while the driver waited)' };
  if (s.category === 'idle') return { kind: 'idle', key: 'idle', label: 'Idle within a turn' };
  if (s.category === 'other_tools') {
    const name = String(s.tool ?? 'a tool');
    return /^(WebSearch|WebFetch)$/.test(name) ? { kind: 'web', key: `web:${name}`, label: name === 'WebSearch' ? 'Searching the web' : 'Reading web pages' } : { kind: 'tools', key: `tool:${name}`, label: name.replace(/^mcp__/, '').replace(/__/g, ': ') };
  }
  // A command (and its waits, already charged to what a wait loop waited on).
  const command = commandText(s.command ?? '');
  const g = commandGroup(command);
  const cat = s.category === 'cmd_wait' ? commandKind(command) : s.category;
  const kind = CMD_KIND[cat] ?? (g.key === 'wait loop' ? 'command' : 'command');
  return { kind, key: `cmd:${g.key}`, label: g.intent };
}

/** The task's Active stretches (its state history), else started to finished. */
function windows(t: Row, end: number): [number, number][] {
  const rows = all('SELECT state, at FROM task_states WHERE task_id = ? ORDER BY at, id', t.id);
  const out: [number, number][] = [];
  let from: number | null = null;
  for (const r of rows) {
    if (r.state === 'active' && from === null) from = Number(r.at);
    else if (r.state !== 'active' && from !== null) {
      out.push([from, Number(r.at)]);
      from = null;
    }
  }
  if (from !== null) out.push([from, end]);
  if (!out.length && t.started_at) out.push([Number(t.started_at), end]);
  return out;
}

/** Compute a task's breakdown from what the database holds now. */
export function computeTaskTime(t: Row, at = now()): TaskTime {
  const end = t.finished_at != null && (t.state === 'done' || t.state === 'dropped') ? Number(t.finished_at) : at;
  // Its agents: the driver, agents and subagents on it, and any whose turns were counted for it; never the director.
  const agents = all(
    `SELECT id, parent_id FROM agents WHERE parent_id IS NOT NULL AND (id = ? OR task_id = ? OR id IN (SELECT DISTINCT agent_id FROM token_usage WHERE task_id = ?))`,
    t.driver_agent_id ?? '', t.id, t.id,
  );
  const ids = new Set(agents.map((a) => String(a.id)));
  const spans: Span[] = [];
  for (const [a, b] of windows(t, end)) if (b > a && ids.size) activity(all, t.project_id, a, b + 1, () => 0, () => 'x', undefined, { agents: ids, onSpan: (s) => spans.push(s) });
  // The main line: the driver, else the agent with the most measured time.
  const per = new Map<string, number>();
  for (const s of spans) if (s.category !== 'waiting_user') per.set(s.agent_id, (per.get(s.agent_id) ?? 0) + s.ms);
  const main = t.driver_agent_id && per.has(t.driver_agent_id) ? t.driver_agent_id : [...per].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
  const items = new Map<string, TimeItem & { calls: Map<string, Run> }>();
  let turns = 0;
  let slow = 0;
  for (const s of spans) {
    if (s.category === 'waiting_user') continue;
    const it = itemOf(s);
    const alongside = s.agent_id !== main;
    const key = `${alongside ? 'a:' : ''}${it.key}`;
    const item = items.get(key) ?? items.set(key, { ...it, ms: 0, idle_ms: 0, runs: [], failed: 0, alongside, calls: new Map() }).get(key)!;
    item.ms += s.ms;
    if (s.category === 'cmd_wait' || s.category === 'idle') item.idle_ms += s.ms;
    // One run per tool call (its parts add up), or per stretch of the model's time.
    const runKey = s.category === 'thinking' ? `t:${s.agent_id}:${s.at}` : `${s.agent_id}:${s.call ?? s.at}`;
    const r = item.calls.get(runKey) ?? item.calls.set(runKey, { at: s.at - s.ms, ms: 0, failed: false }).get(runKey)!;
    r.ms += s.ms;
    r.at = Math.min(r.at, s.at - s.ms);
    r.failed ||= s.failed;
    if (s.category === 'thinking' && !alongside) {
      turns++;
      if (s.ms >= SLOW_TURN_MS) slow++;
    }
  }
  const list: TimeItem[] = [...items.values()]
    .map(({ calls, ...i }) => {
      const runs = [...calls.values()].sort((a, b) => a.at - b.at);
      return { ...i, runs: runs.length > MAX_RUNS ? [...runs].sort((a, b) => b.ms - a.ms).slice(0, MAX_RUNS).sort((a, b) => a.at - b.at) : runs, failed: runs.filter((r) => r.failed).length };
    })
    .sort((a, b) => Number(a.alongside) - Number(b.alongside) || b.ms - a.ms);
  const measured = list.filter((i) => !i.alongside).reduce((n, i) => n + i.ms, 0);
  const times = taskTimes(t, at);
  const work = times.workMs;
  const other = work == null ? 0 : Math.max(0, work - measured);
  if (other > 0) list.push({ kind: 'other', key: 'other', label: 'Not attributed (between turns, or not in the transcript)', ms: other, idle_ms: 0, runs: [], failed: 0, alongside: false });
  const kinds = Object.keys(KINDS)
    .map((k) => ({ kind: k, label: KINDS[k], ms: list.filter((i) => i.kind === k && !i.alongside).reduce((n, i) => n + i.ms, 0) }))
    .filter((k) => k.ms > 0)
    .sort((a, b) => b.ms - a.ms);
  const p = times.parts;
  return {
    task_id: t.id,
    work_ms: work,
    measured_ms: measured,
    other_ms: other,
    items: list,
    kinds,
    outside: { waiting_you_ms: p?.waitingYouMs ?? 0, review_ms: p?.reviewMs ?? 0, queued_ms: p?.queuedMs ?? 0, host_free_ms: hostFreeWaitMs(t.id) },
    model: { turns, slow_turns: slow, tokens: Number(get('SELECT COALESCE(SUM(tokens), 0) AS n FROM token_usage WHERE task_id = ?', t.id)?.n ?? 0) },
    computed_at: at,
  };
}

/** Keep a finished task's breakdown (task_time). Never throws: it must not break a finish. */
export function recordTaskTime(taskId: string) {
  try {
    const t = get("SELECT * FROM tasks WHERE id = ? AND kind = 'task'", taskId);
    if (!t || !t.started_at) return;
    const x = computeTaskTime(t);
    run('INSERT OR REPLACE INTO task_time (task_id, project_id, data, computed_at) VALUES (?,?,?,?)', t.id, t.project_id, JSON.stringify(x), x.computed_at);
  } catch (err) {
    console.warn(`task time: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
  }
}

/** A task's breakdown: kept for a finished one, computed now for one still open. */
export function taskTime(taskId: string): TaskTime | null {
  const t = get("SELECT * FROM tasks WHERE id = ? AND kind = 'task'", taskId);
  if (!t || !t.started_at) return null;
  if (t.state === 'done' || t.state === 'dropped') {
    const kept = get('SELECT data FROM task_time WHERE task_id = ?', t.id);
    if (kept) return JSON.parse(kept.data);
  }
  return computeTaskTime(t);
}

/** Once, in small steps: finished tasks with history and no kept breakdown get one. Returns how many it filled. */
export function backfillTaskTime(limit = 50): number {
  const rows = all(
    "SELECT t.id FROM tasks t WHERE t.kind = 'task' AND t.state IN ('done', 'dropped') AND t.started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_time x WHERE x.task_id = t.id) ORDER BY t.finished_at DESC LIMIT ?",
    limit,
  );
  for (const r of rows) recordTaskTime(r.id);
  return rows.length;
}

/** "42 min · mostly compiling": the header of the task page's card. */
export function headline(x: TaskTime): string {
  const big = x.items.find((i) => !i.alongside && i.kind !== 'other') ?? x.items[0];
  const work = x.work_ms ?? x.measured_ms;
  const m = Math.round(work / 60_000);
  const dur = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
  return big ? `${dur} · mostly ${big.label.charAt(0).toLowerCase()}${big.label.slice(1)}` : dur;
}

const mins = (ms: number) => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

/** The five things that took longest, in a sentence. */
export function topSentence(x: TaskTime): string {
  return x.items
    .filter((i) => !i.alongside && i.kind !== 'other')
    .slice(0, 5)
    .map((i) => `${i.label}: ${mins(i.ms)}${i.runs.length > 1 && i.kind !== 'model' ? ` over ${i.runs.length} runs` : ''}${i.failed ? ` (${i.failed} failed)` : ''}`)
    .join('; ');
}

/** For the director (get_telemetry task): the whole breakdown as lines. */
export function taskTimeText(x: TaskTime): string {
  const lines = [
    `Work time ${x.work_ms == null ? 'unknown' : mins(x.work_ms)}; the transcript accounts for ${mins(x.measured_ms)}${x.other_ms ? `, ${mins(x.other_ms)} not attributed` : ''}.`,
    `Biggest: ${topSentence(x) || 'nothing measured'}.`,
    `Model: ${x.model.turns} stretches, ${x.model.slow_turns} over ${SLOW_TURN_MS / 60_000} min; ${Math.round(x.model.tokens / 1000)}k tokens.`,
    ...x.items.map((i) => `- ${i.alongside ? '(alongside) ' : ''}${KINDS[i.kind]} · ${i.label}: ${mins(i.ms)}${i.runs.length > 1 ? `, ${i.runs.length} runs` : ''}${i.failed ? `, ${i.failed} failed` : ''}${i.idle_ms ? `, ${mins(i.idle_ms)} idle on it` : ''}`),
    `Outside the work time: waiting on you ${mins(x.outside.waiting_you_ms)}, review ${mins(x.outside.review_ms)}, queued ${mins(x.outside.queued_ms)}, a host free while a heavy job waited ${mins(x.outside.host_free_ms)}.`,
  ];
  return lines.join('\n');
}

/** Across a project's tasks finished in [from, to): which items cost the most (by key), and in how many tasks. */
export function slowestItems(projectId: string | null, from: number, to: number, limit = 10, allTime = false): { kind: string; key: string; label: string; ms: number; tasks: number; runs: number }[] {
  const rows = all(
    `SELECT x.data FROM task_time x JOIN tasks t ON t.id = x.task_id WHERE t.finished_at >= ? AND t.finished_at < ? ${projectId ? 'AND x.project_id = ?' : ''}${sinceSql('t.finished_at', 'x.project_id', allTime)}`,
    from, to, ...(projectId ? [projectId] : []),
  );
  const sum = new Map<string, { kind: string; key: string; label: string; ms: number; tasks: number; runs: number }>();
  for (const r of rows) {
    const x = JSON.parse(r.data) as TaskTime;
    for (const i of x.items) {
      if (i.kind === 'other' || i.kind === 'idle') continue;
      const s = sum.get(i.key) ?? sum.set(i.key, { kind: i.kind, key: i.key, label: i.label, ms: 0, tasks: 0, runs: 0 }).get(i.key)!;
      s.ms += i.ms;
      s.tasks++;
      s.runs += i.runs.length;
    }
  }
  return [...sum.values()].sort((a, b) => b.ms - a.ms).slice(0, limit);
}

/** A finished task's biggest item, for the slowest-tasks table. */
export function biggestOf(taskId: string): string | null {
  const kept = get('SELECT data FROM task_time WHERE task_id = ?', taskId);
  if (!kept) return null;
  const x = JSON.parse(kept.data) as TaskTime;
  const big = x.items.find((i) => !i.alongside && i.kind !== 'other');
  return big ? `${big.label} (${mins(big.ms)})` : null;
}

let timer: NodeJS.Timeout | null = null;
/** Runner: fill finished tasks' breakdowns a few at a time, every minute until none are left. */
export function startTaskTimeBackfill() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      if (!backfillTaskTime(20) && timer) {
        clearInterval(timer);
        timer = null;
      }
    } catch (err) {
      console.error('Task time backfill:', err);
    }
  }, 60_000);
  timer.unref?.();
}
