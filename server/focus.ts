import { all, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { periodsOf, telemetryRows } from './telemetry.ts';
import type { Filter } from './telemetry.ts';
import { reworkRows, unusedSpeed } from './rework.ts';
import type { Speed } from './rework.ts';
import { floorOf, resetInfo, sinceSql } from './telemetryreset.ts';
import { subagentLimit } from './subagentprompt.ts';
import { rootAgent, sendToAgent } from './agents.ts';
import { userZone } from './clock.ts';

/**
 * Focus (the top of the Telemetry page, get_telemetry, a weekly note to each director): where time to ship goes beyond
 * the work itself over the last 7 days (each project from its last reset), ranked by hours lost.
 *
 * Over the done tasks of the period whose parts are known (worktime.ts: queued + working + waiting on you + review =
 * time to ship), the "gap" lines split time to ship minus work time exactly:
 * - waiting in the queue (queued_ms);
 * - waiting on the user by request kind (test on a device, choose a direction, approve, update, answers and to-dos):
 *   each task's wait_you_ms shared out over its requests' open time by kind; what no request covers is Planning or
 *   paused;
 * - review and checks (review_ms).
 * The other lines are inside work time or beside it, so they are ranked with the gap but not part of its sum: rework
 * by kind (rework.ts: redone after done, reviews sent back, failed reruns), agents waiting on commands with nothing in
 * hand (task_telemetry wait_idle_ms), empty parallel slots while independent work was queued (rework.ts unusedSpeed,
 * per project, not on any task's clock), and model time (tasktime.ts, the main line's model kind).
 *
 * Every line: hours, share of all time to ship, the trend against the 7 days before, the top 3 tasks (projects for
 * slots), and its lever: one short line of what would cut it, only when its condition holds.
 */

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** The weekly note goes once per this long per project. */
export const NOTE_EVERY_MS = 7 * DAY;

export type FocusKey =
  | 'queue'
  | 'you:test'
  | 'you:direction'
  | 'you:approve'
  | 'you:update'
  | 'you:other'
  | 'you:held'
  | 'review'
  | 'rework:redo'
  | 'rework:review'
  | 'rework:rerun'
  | 'commands'
  | 'slots'
  | 'model';

export const FOCUS_LABEL: Record<FocusKey, string> = {
  queue: 'Waiting in the queue',
  'you:test': 'Waiting on you: test on a device',
  'you:direction': 'Waiting on you: choose a direction',
  'you:approve': 'Waiting on you: approve',
  'you:update': 'Waiting on you: update',
  'you:other': 'Waiting on you: answers and to-dos',
  'you:held': 'Waiting on you: Planning or paused',
  review: 'Review and checks',
  'rework:redo': 'Rework: redone after done',
  'rework:review': 'Rework: reviews sent back',
  'rework:rerun': 'Rework: failed reruns',
  commands: 'Agents waiting on commands, nothing in hand',
  slots: 'Empty parallel slots while work queued',
  model: 'Model time',
};

/** gap: part of time to ship minus work time; work: inside work time; capacity: beside any task's clock. */
const GROUP: Record<FocusKey, 'gap' | 'work' | 'capacity'> = {
  queue: 'gap',
  'you:test': 'gap',
  'you:direction': 'gap',
  'you:approve': 'gap',
  'you:update': 'gap',
  'you:other': 'gap',
  'you:held': 'gap',
  review: 'gap',
  'rework:redo': 'work',
  'rework:review': 'work',
  'rework:rerun': 'work',
  commands: 'work',
  slots: 'capacity',
  model: 'work',
};

export type FocusTop = { kind: 'task' | 'project'; id: string; title: string; ms: number };
export type FocusLine = {
  key: FocusKey;
  label: string;
  group: 'gap' | 'work' | 'capacity';
  ms: number;
  /** Of all time to ship in the period, percent with one decimal. */
  share: number;
  prevMs: number;
  /** up: more hours lost than the period before (worse); new: none before. */
  trend: { dir: 'up' | 'down' | 'flat' | 'new'; pct: number | null };
  top: FocusTop[];
  lever: string | null;
};
export type Focus = {
  from: number;
  to: number;
  /** The reset the view counts from (null: none). */
  reset: ReturnType<typeof resetInfo>;
  tasks: number;
  shipMs: number;
  workMs: number;
  gapMs: number;
  lines: FocusLine[];
  /** Time to ship per week split into work and each wait, in hours. */
  weeks: { labels: string[]; work: number[]; queued: number[]; waitingYou: number[]; review: number[] };
};

// ---------- what a request asked for ----------

export type RequestClass = 'test' | 'direction' | 'approve' | 'update' | 'other';

const parse = (s: unknown): Row => {
  try {
    const v = JSON.parse(String(s ?? ''));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};

/** Which kind of wait on the user a request is. */
export function requestClass(r: Row): RequestClass {
  const p = parse(r.payload);
  const text = `${r.title ?? ''}\n${r.body ?? ''}`;
  const act = String(p.act?.kind ?? '');
  if (p.test_build || (r.kind === 'action' && /\b(test build|on (your|the|a) (phone|iphone|ipad|device|tablet)|try (it|the build|this build))\b/i.test(text))) return 'test';
  if (act === 'update_helm' || act === 'restart_agents' || /\b(update helm|update now)\b/i.test(String(r.title ?? ''))) return 'update';
  let opts: Row[] = [];
  try {
    const v = JSON.parse(String(r.options ?? '[]'));
    if (Array.isArray(v)) opts = v;
  } catch {
    // no options
  }
  if (r.kind === 'permission' || act || opts.some((o) => /^(approve|yes|go ahead|merge|publish|allow)\b/i.test(String(o?.label ?? '')))) return 'approve';
  if (r.kind === 'question' && opts.length >= 2) return 'direction';
  return 'other';
}

/** The requests that count as waits on the user (worktime.ts waits). */
const WAIT_SQL = "kind IN ('question', 'action', 'permission', 'agent_error') AND status != 'held' AND (decided_by IS NULL OR decided_by = 'user')";

type Span = [number, number];
const union = (spans: Span[]) => {
  const s = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let n = 0;
  let end = -Infinity;
  for (const [a, b] of s) {
    if (b <= end) continue;
    n += b - Math.max(a, end);
    end = b;
  }
  return n;
};

/** A task's wait on the user shared out by request kind; what no request covers is Planning or paused. Sums to `wait`. */
export function splitWait(taskId: string, start: number, end: number, wait: number): Partial<Record<FocusKey, number>> {
  const out: Partial<Record<FocusKey, number>> = {};
  if (wait <= 0) return out;
  const by = new Map<RequestClass, Span[]>();
  for (const r of all(`SELECT kind, title, body, options, payload, created_at, answered_at FROM inbox WHERE task_id = ? AND ${WAIT_SQL}`, taskId)) {
    const span: Span = [Math.max(start, Number(r.created_at)), Math.min(end, Number(r.answered_at ?? end))];
    const c = requestClass(r);
    (by.get(c) ?? by.set(c, []).get(c)!).push(span);
  }
  const each = [...by].map(([c, spans]) => [c, union(spans)] as const).filter(([, ms]) => ms > 0);
  const covered = Math.min(wait, union([...by.values()].flat()));
  const sum = each.reduce((n, [, ms]) => n + ms, 0);
  let given = 0;
  for (const [c, ms] of each) {
    const part = Math.floor((covered * ms) / sum);
    out[`you:${c}` as FocusKey] = part;
    given += part;
  }
  // Rounding left over goes to the biggest kind; the rest of the wait is Planning or paused.
  if (each.length && covered - given > 0) {
    const big = [...each].sort((a, b) => b[1] - a[1])[0][0];
    out[`you:${big}` as FocusKey]! += covered - given;
  }
  if (wait - covered > 0) out['you:held'] = wait - covered;
  return out;
}

// ---------- the measure over one period ----------

type Measure = {
  ms: Map<FocusKey, number>;
  byTask: Map<FocusKey, Map<string, number>>;
  shipMs: number;
  workMs: number;
  tasks: Row[];
  rework: { redo: number; review: number; rerun: number };
  speed: { idleWithWork: number; emptySlot: number; queuedSegs: number; byProject: Map<string, number>; slots: Map<string, number> };
  slowTurns: number;
};

/** The done tasks of [from, to) whose time to ship and its parts are known. */
const shippedRows = (f: Filter, from: number, to: number) =>
  telemetryRows(f, from, to).filter((r) => r.state === 'done' && r.ship_ms != null && r.work_ms != null && r.queued_ms != null && r.wait_you_ms != null && r.review_ms != null);

function measure(f: Filter, from: number, to: number, at: number): Measure {
  const ms = new Map<FocusKey, number>();
  const byTask = new Map<FocusKey, Map<string, number>>();
  const add = (k: FocusKey, taskId: string, v: number) => {
    if (!(v > 0)) return;
    ms.set(k, (ms.get(k) ?? 0) + v);
    const m = byTask.get(k) ?? byTask.set(k, new Map()).get(k)!;
    m.set(taskId, (m.get(taskId) ?? 0) + v);
  };
  const rows = shippedRows(f, from, to);
  let shipMs = 0;
  let workMs = 0;
  for (const r of rows) {
    shipMs += Number(r.ship_ms);
    workMs += Number(r.work_ms);
    add('queue', r.task_id, Number(r.queued_ms));
    add('review', r.task_id, Number(r.review_ms));
    const split = splitWait(r.task_id, Number(r.created_at), Number(r.finished_at), Number(r.wait_you_ms));
    for (const [k, v] of Object.entries(split)) add(k as FocusKey, r.task_id, v!);
    add('commands', r.task_id, Number(r.wait_idle_ms ?? 0));
  }
  const ids = new Set(rows.map((r) => String(r.task_id)));
  // Rework of the same tasks.
  const rework = { redo: 0, review: 0, rerun: 0 };
  if (ids.size) {
    for (const x of reworkRows(f.project ?? null, from, to)) {
      if (!ids.has(x.task_id)) continue;
      add('rework:redo', x.task_id, x.kinds.redo.ms);
      add('rework:review', x.task_id, x.kinds.review.ms);
      add('rework:rerun', x.task_id, x.kinds.rerun.ms);
      rework.redo += x.kinds.redo.n;
      rework.review += x.kinds.review.n;
      rework.rerun += x.kinds.rerun.n;
    }
  }
  // Model time on the main line (tasktime.ts), and its slow turns.
  let slowTurns = 0;
  for (const id of ids) {
    const kept = get('SELECT data FROM task_time WHERE task_id = ?', id);
    if (!kept) continue;
    const x = parse(kept.data);
    add('model', id, Number((x.kinds ?? []).find((k: Row) => k.kind === 'model')?.ms ?? 0));
    slowTurns += Number(x.model?.slow_turns ?? 0);
  }
  // Empty slots and waits with work queued, per project (each from its own floor), up to now.
  const speed = { idleWithWork: 0, emptySlot: 0, queuedSegs: 0, byProject: new Map<string, number>(), slots: new Map<string, number>() };
  const projects = f.project ? all('SELECT id FROM projects WHERE id = ?', f.project) : all('SELECT id FROM projects WHERE archived = 0');
  for (const p of projects) {
    const a = Math.max(from, floorOf(String(p.id), f.allTime));
    const b = Math.min(to, at);
    if (b <= a) continue;
    const s: Speed = unusedSpeed(String(p.id), a, b);
    speed.idleWithWork += s.idle_with_work_ms;
    speed.queuedSegs += s.queued_ms;
    if (s.empty_slot_ms) {
      speed.emptySlot += s.empty_slot_ms;
      speed.byProject.set(String(p.id), s.empty_slot_ms);
    }
    speed.slots.set(String(p.id), subagentLimit(String(p.id)));
  }
  if (speed.emptySlot > 0) ms.set('slots', speed.emptySlot);
  return { ms, byTask, shipMs, workMs, tasks: rows, rework, speed, slowTurns };
}

// ---------- levers ----------

const hoursText = (ms: number) => (ms >= HOUR ? `${(ms / HOUR).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);

/** Requests of a kind that waited (or wait) over a day: open now, or created in the period. */
function longRequests(f: Filter, from: number, to: number, at: number): Map<RequestClass, number> {
  const rows = all(
    `SELECT kind, title, body, options, payload FROM inbox WHERE ${WAIT_SQL} AND (status = 'open' OR answered_at IS NOT NULL) AND ((status = 'open' AND answered_at IS NULL) OR (created_at >= ? AND created_at < ?)) AND COALESCE(answered_at, ?) - created_at > ? ${f.project ? 'AND project_id = ?' : ''}${sinceSql('created_at', 'inbox.project_id', f.allTime)}`,
    from, to, at, DAY, ...(f.project ? [f.project] : []),
  );
  const out = new Map<RequestClass, number>();
  for (const r of rows) {
    const c = requestClass(r);
    out.set(c, (out.get(c) ?? 0) + 1);
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The lever of a line, or null when its condition does not hold. */
function leverOf(k: FocusKey, m: Measure, line: { ms: number; share: number }, long: Map<RequestClass, number>, single: boolean): string | null {
  if (k === 'queue') {
    // Tasks queued while the slots were full (little empty slot time against the queue).
    if (line.ms >= HOUR && line.share >= 10 && m.speed.emptySlot < 0.25 * line.ms) {
      const now_ = single ? [...m.speed.slots.values()][0] : null;
      return `Parallel slots full while tasks queued: raise builder subagents${now_ != null ? ` (now ${now_})` : ''}`;
    }
    return null;
  }
  if (k.startsWith('you:') && k !== 'you:held') {
    const n = long.get(k.slice(4) as RequestClass) ?? 0;
    return n ? `Requests waiting > 1 day: ${n}; answer or defer` : null;
  }
  if (k === 'you:held') {
    const n = m.tasks.filter((r) => (splitWait(r.task_id, Number(r.created_at), Number(r.finished_at), Number(r.wait_you_ms))['you:held'] ?? 0) > DAY).length;
    return n ? `${plural(n, 'task')} in Planning or paused > 1 day: approve, schedule or drop sooner` : null;
  }
  if (k === 'review') {
    const avg = m.tasks.length ? line.ms / m.tasks.length : 0;
    return avg > HOUR ? `Review and checks ${hoursText(avg)} per task: run the full checks once per batch` : null;
  }
  if (k === 'rework:redo') return m.rework.redo ? `Follow-up or reopened tasks after done: ${m.rework.redo}; clearer Done when` : null;
  if (k === 'rework:review') return m.rework.review >= 2 ? `Reviews sent back: ${m.rework.review}; put the Done when checks in the brief` : null;
  if (k === 'rework:rerun') return m.rework.rerun >= 5 ? `Failed commands rerun: ${m.rework.rerun}; write the fix down when one repeats` : null;
  if (k === 'commands') return m.speed.idleWithWork >= 30 * 60_000 ? `Waited on commands ${hoursText(m.speed.idleWithWork)} with independent work queued; take it alongside` : null;
  if (k === 'slots') return line.ms >= HOUR ? 'Slots free while independent work queued: check risky marks and waits' : null;
  if (k === 'model') return m.slowTurns >= 5 ? `Model turns over 2 min: ${m.slowTurns}; smaller steps or a lighter tier` : null;
  return null;
}

// ---------- the view ----------

const trendOf = (ms: number, prev: number): FocusLine['trend'] => {
  if (!prev) return ms ? { dir: 'new', pct: null } : { dir: 'flat', pct: 0 };
  const pct = Math.round(((ms - prev) / prev) * 100);
  return { dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat', pct };
};

/** Focus over the last 7 days (each project from its last reset), against the 7 days before. */
export function focusView(f: Pick<Filter, 'project' | 'allTime'>, at = now(), tz = userZone()): Focus {
  const filter: Filter = { project: f.project ?? null, allTime: !!f.allTime };
  const p = periodsOf('week', at, tz);
  const cur = measure(filter, p.curStart, p.end, at);
  const prev = measure(filter, p.prevStart, p.curStart, at);
  const long = longRequests(filter, p.curStart, p.end, at);
  const single = !!filter.project;
  const titles = (ids: string[]) => new Map(ids.length ? all(`SELECT id, title FROM tasks WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids).map((t) => [String(t.id), String(t.title)]) : []);
  const keys = new Set<FocusKey>([...cur.ms.keys(), ...prev.ms.keys()]);
  const lines: FocusLine[] = [...keys]
    .map((k) => {
      const ms = cur.ms.get(k) ?? 0;
      const share = cur.shipMs > 0 ? Math.round((ms / cur.shipMs) * 1000) / 10 : 0;
      let top: FocusTop[];
      if (k === 'slots') {
        const names = new Map(all('SELECT id, name FROM projects').map((x) => [String(x.id), String(x.name)]));
        top = [...cur.speed.byProject].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, v]) => ({ kind: 'project', id, title: names.get(id) ?? id, ms: v }));
      } else {
        const best = [...(cur.byTask.get(k) ?? new Map<string, number>())].sort((a, b) => b[1] - a[1]).slice(0, 3);
        const t = titles(best.map(([id]) => id));
        top = best.map(([id, v]) => ({ kind: 'task', id, title: t.get(id) ?? id, ms: v }));
      }
      return { key: k, label: FOCUS_LABEL[k], group: GROUP[k], ms, share, prevMs: prev.ms.get(k) ?? 0, trend: trendOf(ms, prev.ms.get(k) ?? 0), top, lever: ms > 0 ? leverOf(k, cur, { ms, share }, long, single) : null };
    })
    .filter((l) => l.ms > 0 || l.prevMs > 0)
    .sort((a, b) => b.ms - a.ms || b.prevMs - a.prevMs);
  // Per week: time to ship split into work and each wait.
  const hist = shippedRows(filter, p.edges[0], p.end);
  const weeks = { labels: p.labels, work: [] as number[], queued: [] as number[], waitingYou: [] as number[], review: [] as number[] };
  p.edges.forEach((a, i) => {
    const b = p.edges[i + 1] ?? p.end;
    const rs = hist.filter((r) => r.finished_at >= a && r.finished_at < b);
    const h = (c: string) => Math.round((rs.reduce((n, r) => n + Number(r[c]), 0) / HOUR) * 10) / 10;
    weeks.work.push(h('work_ms'));
    weeks.queued.push(h('queued_ms'));
    weeks.waitingYou.push(h('wait_you_ms'));
    weeks.review.push(h('review_ms'));
  });
  return {
    from: p.curStart,
    to: p.end,
    reset: filter.allTime ? null : resetInfo(filter.project ?? null),
    tasks: cur.tasks.length,
    shipMs: cur.shipMs,
    workMs: cur.workMs,
    gapMs: cur.shipMs - cur.workMs,
    lines,
    weeks,
  };
}

/** The page refetches on every project change: a view is kept a minute. */
const cache = new Map<string, { at: number; v: Focus }>();
export function focusCached(f: Pick<Filter, 'project' | 'allTime'>): Focus {
  const key = `${f.project ?? ''}|${f.allTime ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const v = focusView(f);
  if (cache.size > 100) cache.clear();
  cache.set(key, { at: Date.now(), v });
  return v;
}

// ---------- text: get_telemetry and the weekly note ----------

const trendText = (t: FocusLine['trend']) => (t.dir === 'new' ? 'new' : t.dir === 'flat' ? 'same as before' : `${t.dir === 'up' ? '▲' : '▼'} ${Math.abs(t.pct ?? 0)}% on the week before`);
const lineText = (l: FocusLine) =>
  `${l.label}: ${hoursText(l.ms)} (${l.share}% of time to ship; ${trendText(l.trend)})${l.top.length ? `; ${l.top.map((t) => (t.kind === 'task' ? `[[${t.id}]]` : t.title)).join(', ')}` : ''}${l.lever ? `. Lever: ${l.lever}` : ''}`;

/** For get_telemetry: the ranked Focus list of a project. */
export function focusText(projectId: string, at = now()): string {
  const v = focusView({ project: projectId }, at);
  const live = v.lines.filter((l) => l.ms > 0);
  if (!v.tasks || !live.length) return 'Focus (last 7 days): nothing shipped with known times, or nothing lost.';
  return [
    `Focus, last 7 days (${v.tasks} task(s) shipped; time to ship ${hoursText(v.shipMs)}, work ${hoursText(v.workMs)}, beyond the work ${hoursText(v.gapMs)}). Ranked by hours lost; rework, command waits and model time are inside work time, empty slots beside it:`,
    ...live.map((l, i) => `${i + 1}. ${lineText(l)}`),
  ].join('\n');
}

/** The weekly note's text for a project: its top item, or null when nothing shipped or nothing was lost. */
export function focusNote(projectId: string, at = now()): string | null {
  const v = focusView({ project: projectId }, at);
  const top = v.lines.find((l) => l.ms > 0);
  if (!v.tasks || !top) return null;
  return `<helm-note kind="focus">This week's Focus: the biggest drag on time to ship is ${top.label.charAt(0).toLowerCase()}${top.label.slice(1)}, ${lineText(top).slice(top.label.length + 2)}. get_telemetry has the whole ranked list. Act on it if it is worth it; no reply needed.</helm-note>`;
}

const noteKey = (projectId: string) => `focus_note:${projectId}`;

/** One pass: each project not noted in the last week gets its note (when it has one). Returns the projects noted. */
export async function sendFocusNotes(send: (projectId: string, text: string) => Promise<void>, at = now()): Promise<string[]> {
  const sent: string[] = [];
  for (const p of all('SELECT id FROM projects WHERE archived = 0')) {
    const last = Number(get('SELECT value FROM telemetry_state WHERE key = ?', noteKey(p.id))?.value ?? 0);
    if (last && at - last < NOTE_EVERY_MS) continue;
    // Checked: once a week whether or not there was anything to say.
    run('INSERT OR REPLACE INTO telemetry_state (key, value) VALUES (?, ?)', noteKey(p.id), String(at));
    try {
      const text = focusNote(String(p.id), at);
      if (!text) continue;
      await send(String(p.id), text);
      sent.push(String(p.id));
    } catch (err) {
      console.warn(`focus note: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    }
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;
/** Runner: check every hour (the first an hour after start), so each project's note goes once a week. */
export function startFocusNotes() {
  if (timer) return;
  const tell = async (projectId: string, text: string) => {
    const project = get('SELECT * FROM projects WHERE id = ?', projectId);
    if (project) await sendToAgent(rootAgent(project).id, text, { kind: 'system', name: 'Helm' });
  };
  timer = setInterval(() => void sendFocusNotes(tell).catch((err) => console.error('Focus notes:', err)), HOUR);
  timer.unref?.();
}
export function stopFocusNotes() {
  if (timer) clearInterval(timer);
  timer = null;
}
