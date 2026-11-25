import { all, get, now } from './db.ts';
import type { Row } from './db.ts';

/**
 * How long a task took, and how long it took to ship: two different numbers (the user's rule: waiting on them is never
 * time a task took).
 *
 * Work time: the time agents were working on it. Its Active time (tasks.active_ms, which already leaves out a finished
 * task waiting for its review) less every stretch it waited on the user while Active, or on a review it asked for: an
 * open question, to-do, permission or error on it (until answered; a request the director decided is not a wait on
 * the user), a review consult until answered. Planning, the queue and pauses are outside Active already.
 *
 * Time to ship: created to done on the clock (and to live, where a published release carried it), in parts: queued
 * (waiting or scheduled), working (work time), waiting on you (Planning, paused, and the user waits above), review or
 * checks (the rest of its Active time). From the recorded state history and requests; where the history cannot tell
 * (no state changes recorded, but requests to place), the number is null, "unknown", never an estimate.
 */

export type ShipParts = { queuedMs: number; workingMs: number; waitingYouMs: number; reviewMs: number };
export type TaskTimes = {
  /** Work time so far (done: in all), or null when the history cannot tell. */
  workMs: number | null;
  /** While the task works now: the instant from which work time keeps growing (the page adds the time since). */
  workSince: number | null;
  /** Created to done, on the clock; null until done. */
  shipMs: number | null;
  /** Its parts, or null when the history cannot tell. */
  parts: ShipParts | null;
  /** Created to the publishing of the release that carried it, or null. */
  liveMs: number | null;
};

type Span = [number, number];
const merge = (spans: Span[]): Span[] => {
  const s = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Span[] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
};
const total = (spans: Span[]) => merge(spans).reduce((n, [a, b]) => n + b - a, 0);
/** The length of the overlap of two sets of spans. */
const overlap = (x: Span[], y: Span[]) => {
  let n = 0;
  for (const [a, b] of merge(x)) for (const [c, d] of merge(y)) n += Math.max(0, Math.min(b, d) - Math.max(a, c));
  return n;
};

/** The task's states over time, from its creation to `end`: [state, from, to]. Null when nothing was recorded. */
function timeline(t: Row, end: number): [string, number, number][] | null {
  const rows = all('SELECT from_state, state, at FROM task_states WHERE task_id = ? ORDER BY at, id', t.id);
  if (!rows.length) return null;
  const start = Number(t.became_task_at ?? t.created_at);
  const out: [string, number, number][] = [];
  let state = String(rows[0].from_state ?? rows[0].state);
  let from = start;
  for (const r of rows) {
    const at = Math.max(start, Math.min(Number(r.at), end));
    if (at > from) out.push([state, from, at]);
    state = String(r.state);
    from = Math.max(from, at);
  }
  if (end > from) out.push([state, from, end]);
  return out;
}

/** Stretches the task waited on the user (its open requests) or on a review it asked for, up to `end`. */
function waits(t: Row, end: number): { user: Span[]; review: Span[]; openNow: boolean } {
  const user = all(
    "SELECT created_at, COALESCE(answered_at, ?) AS done_at FROM inbox WHERE task_id = ? AND kind IN ('question', 'action', 'permission', 'agent_error') AND status != 'held' AND (decided_by IS NULL OR decided_by = 'user')",
    end, t.id,
  ).map((r): Span => [Number(r.created_at), Math.min(Number(r.done_at), end)]);
  const review = all("SELECT created_at, COALESCE(answered_at, ?) AS done_at FROM consults WHERE task_id = ? AND kind = 'review'", end, t.id).map((r): Span => [Number(r.created_at), Math.min(Number(r.done_at), end)]);
  // Still unanswered: the task waits now.
  const openNow = !!get("SELECT 1 AS x FROM inbox WHERE task_id = ? AND kind IN ('question', 'action', 'permission', 'agent_error') AND status = 'open' AND answered_at IS NULL AND (decided_by IS NULL OR decided_by = 'user') LIMIT 1", t.id)
    || !!get("SELECT 1 AS x FROM consults WHERE task_id = ? AND kind = 'review' AND answered_at IS NULL LIMIT 1", t.id);
  return { user, review, openNow };
}

/** A task's work time, time to ship and its parts, as of `at` (done tasks: at their finish). */
export function taskTimes(t: Row, at = now()): TaskTimes {
  const done = t.state === 'done' && t.finished_at != null;
  // Done or dropped: measured to its finish.
  const ended = (t.state === 'done' || t.state === 'dropped') && t.finished_at != null;
  const end = ended ? Number(t.finished_at) : at;
  const activeTotal = Number(t.active_ms ?? 0) + (t.active_since ? Math.max(0, end - Number(t.active_since)) : 0);
  const line = timeline(t, end);
  const w = waits(t, end);
  const waitsAll = merge([...w.user, ...w.review]);
  const active: Span[] = line ? line.filter(([s]) => s === 'active').map(([, a, b]): Span => [a, b]) : [];
  let workMs: number | null;
  if (line) workMs = Math.max(0, activeTotal - overlap(waitsAll, active));
  // No state history (tasks from before it was kept): known only when nothing waited.
  else workMs = waitsAll.length ? null : activeTotal;
  const workSince = !ended && t.state === 'active' && t.active_since && !w.openNow && workMs != null ? at : null;
  if (!done) return { workMs, workSince, shipMs: null, parts: null, liveMs: null };
  const start = Number(t.became_task_at ?? t.created_at);
  const shipMs = Math.max(0, end - start);
  let parts: ShipParts | null = null;
  if (line && workMs != null) {
    const len = (states: string[]) => line.filter(([s]) => states.includes(s)).reduce((n, [, a, b]) => n + b - a, 0);
    const queuedMs = len(['waiting', 'scheduled']);
    const waitingYouMs = len(['planning', 'paused']) + overlap(w.user, active);
    parts = { queuedMs, workingMs: workMs, waitingYouMs, reviewMs: Math.max(0, shipMs - queuedMs - waitingYouMs - workMs) };
  }
  const rel = get("SELECT MIN(published_at) AS at FROM releases WHERE project_id = ? AND published_at IS NOT NULL AND published_at >= ? AND EXISTS (SELECT 1 FROM json_each(releases.tasks) j WHERE j.value = ?)", t.project_id, end, t.id);
  return { workMs, workSince: null, shipMs, parts, liveMs: rel?.at != null ? Number(rel.at) - start : null };
}

/** "20 min", "4 h 20 min", or "unknown". */
export const durationText = (ms: number | null) => {
  if (ms == null) return 'unknown';
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};

/** "4 h 20 min to ship: queued 0 min · working 20 min · waiting on you 4 h · review or checks 0 min". */
export function shipText(x: TaskTimes): string {
  if (x.shipMs == null) return '';
  const p = x.parts;
  const parts = p ? `: ${[p.queuedMs && `queued ${durationText(p.queuedMs)}`, `working ${durationText(p.workingMs)}`, p.waitingYouMs && `waiting on you ${durationText(p.waitingYouMs)}`, p.reviewMs && `review or checks ${durationText(p.reviewMs)}`].filter(Boolean).join(' · ')}` : '';
  return `${durationText(x.shipMs)} to ship${parts}${x.liveMs != null ? `; live after ${durationText(x.liveMs)}` : ''}`;
}
