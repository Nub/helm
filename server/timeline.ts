import { all, now } from './db.ts';
import type { Row } from './db.ts';
import { QUEUE_ORDER } from './tasks.ts';
import { sectionTree, pathNames } from './sections.ts';
import { taskTimes } from './worktime.ts';

/**
 * The Work page's Timeline (web/src/timeline.tsx): each task as a bar over time, built from its recorded state history
 * (task_states) and the stretches it waited on the user, with waits-for links, its builder and Spec section, and the
 * Scheduled queue projected ahead from typical work times. The throughput and flow charts are drawn from the same rows.
 *
 * Web side only (the API imports it, the runner does not): it reads what worktime.ts reads and changes nothing.
 */

/** queued: Waiting or Scheduled; active: Active and working; you: waiting on the user (Planning, Paused, or an open request while Active). */
export type SegKind = 'queued' | 'active' | 'you';
export type Seg = { kind: SegKind; from: number; to: number };
type Span = [number, number];
export type StatePiece = [string, number, number];

/** The states a task was in, [state, from, to], from `start` to `end`, from its task_states rows (ordered by time). */
export function stateLine(rows: { from_state?: string | null; state?: string; at?: number }[], start: number, end: number): StatePiece[] {
  if (!rows.length) return [];
  const out: StatePiece[] = [];
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

const KIND: Record<string, SegKind | undefined> = { waiting: 'queued', scheduled: 'queued', planning: 'you', paused: 'you', active: 'active' };

/**
 * A bar's segments from its state line and the stretches it waited on the user: Waiting and Scheduled are queued,
 * Planning and Paused are waiting on you, Active is active except where a request to the user was open. Done and
 * dropped end the bar. Touching segments of one kind are joined.
 */
export function barSegments(line: StatePiece[], userWaits: Span[]): Seg[] {
  const out: Seg[] = [];
  const push = (kind: SegKind, from: number, to: number) => {
    if (to <= from) return;
    const last = out[out.length - 1];
    if (last && last.kind === kind && last.to >= from) last.to = Math.max(last.to, to);
    else out.push({ kind, from, to });
  };
  const waits = [...userWaits].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  for (const [state, a, b] of line) {
    const kind = KIND[state];
    if (!kind) continue;
    if (kind !== 'active') {
      push(kind, a, b);
      continue;
    }
    let at = a;
    for (const [wa, wb] of waits) {
      if (wb <= at || wa >= b) continue;
      push('active', at, Math.max(at, wa));
      push('you', Math.max(at, wa), Math.min(b, wb));
      at = Math.min(b, wb);
    }
    push('active', at, b);
  }
  return out;
}

/** Wall-clock time Active (work plus any waits inside it), the measure the projection uses. */
const activeWall = (line: StatePiece[]) => line.filter(([s]) => s === 'active').reduce((n, [, a, b]) => n + b - a, 0);

export const median = (xs: number[]): number | null => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export type Slot = { lane: string; free: number };
/**
 * Where the Scheduled queue lands: in queue order, each task goes to the builder that frees first (after the tasks it
 * waits for), for `typical` ms. Returns task id -> [from, to, lane]. Blockers that are not projected (Waiting, Paused)
 * hold a task back only when they are projected themselves.
 */
export function projectQueue(queue: { id: string; waits: string[] }[], slots: Slot[], typical: number, ends: Map<string, number>): Map<string, [number, number, string]> {
  const out = new Map<string, [number, number, string]>();
  const free = slots.map((s) => ({ ...s }));
  for (const t of queue) {
    free.sort((a, b) => a.free - b.free);
    const slot = free[0];
    const after = Math.max(slot.free, ...t.waits.map((w) => ends.get(w) ?? 0));
    const to = after + typical;
    out.set(t.id, [after, to, slot.lane]);
    ends.set(t.id, to);
    slot.free = to;
  }
  return out;
}

const DAY = 24 * 3600_000;
const DEFAULT_TYPICAL = 3600_000;
const OPEN = "('planning', 'waiting', 'scheduled', 'active', 'paused')";

export type TimelineTask = {
  id: string;
  title: string;
  state: string;
  lane: string;
  section: string;
  start: number;
  end: number | null;
  segments: Seg[];
  line: StatePiece[];
  waits_for: string[];
  work_ms: number | null;
  ship_ms: number | null;
  projected: { from: number; to: number } | null;
};

/** The project's tasks over the last `days` (and every open one), with bars, lanes, sections and the projection. */
export function projectTimeline(projectId: string, days = 28, at = now()) {
  const from = at - days * DAY;
  const rows = all(
    `SELECT t.*, a.name AS driver_name FROM tasks t LEFT JOIN agents a ON a.id = t.driver_agent_id
     WHERE t.project_id = ? AND t.kind = 'task' AND t.merged_into IS NULL
       AND (t.state IN ${OPEN} OR COALESCE(t.finished_at, t.updated_at) >= ?) ${QUEUE_ORDER.replace(/\b(importance|position|created_at)\b/g, 't.$1')}`,
    projectId, from,
  );
  const ids = rows.map((r) => r.id);
  const inIds = ids.map(() => '?').join(',') || "''";
  const states = new Map<string, Row[]>();
  for (const r of all(`SELECT task_id, from_state, state, at FROM task_states WHERE task_id IN (${inIds}) ORDER BY at, id`, ...ids)) states.set(r.task_id, [...(states.get(r.task_id) ?? []), r]);
  const waitsBy = new Map<string, Span[]>();
  for (const r of all(
    `SELECT task_id, created_at, COALESCE(answered_at, ?) AS done_at FROM inbox WHERE task_id IN (${inIds}) AND kind IN ('question', 'action', 'permission', 'agent_error') AND status != 'held' AND (decided_by IS NULL OR decided_by = 'user')`,
    at, ...ids,
  )) waitsBy.set(r.task_id, [...(waitsBy.get(r.task_id) ?? []), [Number(r.created_at), Number(r.done_at)]]);
  const waitsFor = new Map<string, string[]>();
  for (const r of all(`SELECT task_id, waits_for FROM task_waits WHERE task_id IN (${inIds}) ORDER BY created_at, rowid`, ...ids)) waitsFor.set(r.task_id, [...(waitsFor.get(r.task_id) ?? []), r.waits_for]);
  // The top-level Spec section of the first entry each task implements.
  const tree = sectionTree(projectId);
  const sectionOf = new Map<string, string>();
  for (const r of all(`SELECT l.task_id, d.section_id FROM doc_links l JOIN docs d ON d.id = l.doc_id WHERE l.relation = 'implements' AND l.task_id IN (${inIds}) ORDER BY l.id`, ...ids)) {
    if (sectionOf.has(r.task_id) || !r.section_id) continue;
    const top = pathNames(tree, r.section_id)[0];
    if (top) sectionOf.set(r.task_id, top);
  }

  const tasks: TimelineTask[] = rows.map((t) => {
    const start = Number(t.became_task_at ?? t.created_at);
    const ended = (t.state === 'done' || t.state === 'dropped') && t.finished_at != null;
    const end = ended ? Number(t.finished_at) : at;
    let line = stateLine(states.get(t.id) ?? [], start, end);
    // No history recorded (older tasks): queued until it started, Active from then.
    if (!line.length) {
      const s = t.started_at != null ? Math.min(Math.max(Number(t.started_at), start), end) : null;
      const now0 = ended || t.state === 'active' ? 'active' : t.state;
      line = s != null ? ([['waiting', start, s], ['active', s, end]] as StatePiece[]).filter(([, a, b]) => b > a) : ([[now0, start, end]] as StatePiece[]);
    }
    const tm = t.state === 'done' ? taskTimes(t, at) : null;
    return {
      id: t.id,
      title: t.title,
      state: t.state,
      lane: t.driver_name ? String(t.driver_name) : '',
      section: sectionOf.get(t.id) ?? '',
      start,
      end: ended ? end : null,
      segments: barSegments(line, waitsBy.get(t.id) ?? []),
      line,
      waits_for: waitsFor.get(t.id) ?? [],
      work_ms: tm?.workMs ?? null,
      ship_ms: tm?.shipMs ?? null,
      projected: null,
    };
  });

  // Typical Active wall time: the median of the last 40 finished tasks of the project (an hour when there are none).
  const done = tasks.filter((t) => t.state === 'done' && t.end != null).sort((a, b) => b.end! - a.end!).slice(0, 40);
  const typical = Math.max(5 * 60_000, median(done.map((t) => activeWall(t.line)).filter((x) => x > 0)) ?? DEFAULT_TYPICAL);
  // Active tasks run to their typical length (at least a little past now); builders free then.
  const ends = new Map<string, number>();
  const slots: Slot[] = [];
  for (const t of tasks.filter((x) => x.state === 'active')) {
    const firstActive = t.line.find(([s]) => s === 'active')?.[1] ?? t.start;
    const to = Math.max(firstActive + typical, at + 15 * 60_000);
    t.projected = { from: at, to };
    ends.set(t.id, to);
    if (/^builder/i.test(t.lane)) slots.push({ lane: t.lane || 'Builder', free: to });
  }
  if (!slots.length) slots.push({ lane: 'Builder', free: at });
  const queue = tasks.filter((t) => t.state === 'scheduled');
  const proj = projectQueue(queue.map((t) => ({ id: t.id, waits: t.waits_for })), slots, typical, ends);
  for (const t of queue) {
    const p = proj.get(t.id);
    if (!p) continue;
    t.projected = { from: p[0], to: p[1] };
    if (!t.lane) t.lane = p[2];
  }
  return { now: at, from, days, typical_ms: typical, tasks };
}
