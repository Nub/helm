import { all, get, newId, now, run, tx } from './db.ts';
import { idleButBusy } from './busy.ts';
import { queueReviewNote } from './merge.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';
import { taskTimes } from './worktime.ts';
import { checkStalls } from './taskwatch.ts';
import { releaseQuiet, releaseStale } from './requests.ts';
import { clockText, spanText, zoneAbbr } from './clock.ts';
import { autoSchedules, checkAtRest, holdsNewWork, isStopped, modeOf, presenceAttr } from './projectmode.ts';
import { runnerOnly } from './role.ts';

/**
 * Sessions: windows of time when the owner was working with the director, detected from what they do through the
 * API (a message, an answer, a task action, a Spec edit, an upload; viewing pages is not activity). A session starts
 * at the first activity when none is open and ends after the idle period without any (ended_at is then the last
 * activity, not when the timer noticed), or at once when the owner says they are stepping away. The stretch between
 * two sessions is an away period: derived, never stored, except for its summary, which lives on the session that
 * ended it. While the owner is away the director carries on alone with agreed work (structure.ts, tools.ts).
 *
 * Everything that happens belongs to the session or away period its timestamp falls in: attribution is time-range
 * queries over the tables that already exist (periodDetail).
 */

export const DEFAULT_IDLE_MINUTES = 30;
/** Tasks the director may create while the owner is away (origin "away"), per away period. HELM_AWAY_TASK_LIMIT. */
export const AWAY_TASK_LIMIT = Number(process.env.HELM_AWAY_TASK_LIMIT ?? 3) || 3;
/** How often an idle director is nudged about a stalled queue while the owner is away. HELM_AWAY_NUDGE_MINUTES. */
export const AWAY_NUDGE_MS = (Number(process.env.HELM_AWAY_NUDGE_MINUTES ?? 20) || 20) * 60_000;
/** Nudges in a row with no task changing state in between before Helm stops nudging (until something moves). */
const MAX_IDLE_NUDGES = 3;

/** The idle period that ends a session, in ms. HELM_SESSION_IDLE_SECONDS overrides every project (for tests). */
export function idleMs(project: Row): number {
  const env = Number(process.env.HELM_SESSION_IDLE_SECONDS ?? 0);
  if (env > 0) return env * 1000;
  return (project.session_idle_minutes ?? DEFAULT_IDLE_MINUTES) * 60_000;
}

type Notify = (projectId: string, text: string) => Promise<void> | void;
// Set at startup in every process that records owner activity: the runner (its session timer) and the web service
// (the API records activity and stepping away). Unset in the web service it would drop the notes silently.
let notify: Notify = () => runnerOnly('a session note to the director before setSessionNotifier');
/** How sessions tell the director things (taskapi.ts tellDirector, set at startup to avoid an import cycle). */
export function setSessionNotifier(fn: Notify) {
  notify = fn;
}
/** A <helm-note> to the project's director. */
export const notifyDirector = (projectId: string, text: string) => notify(projectId, text);

// ---------- formatting ----------

export { clockText };
export function durationText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 && h < 10 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- time ranges ----------

/**
 * A session covers [started_at, ended_at] including its last action (ended_at is that action's time); the away period
 * after it starts just after. Attribution queries take half-open ranges, so these give the bounds to pass.
 */
const sessionTo = (endedAt: number | null, at = now()) => (endedAt ?? at) + 1;
const awayFrom = (endedAt: number) => endedAt + 1;

// ---------- presence ----------

export const openSession = (projectId: string): Row | undefined =>
  get('SELECT * FROM sessions WHERE project_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1', projectId);
const lastClosed = (projectId: string): Row | undefined =>
  get('SELECT * FROM sessions WHERE project_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1', projectId);

export type Presence = { state: 'session' | 'away'; since: number | null; session_id: string | null };

/** Whether the owner is here (a session is open) or away, and since when (null: never had a session). */
export function presence(projectId: string): Presence {
  const open = openSession(projectId);
  if (open) return { state: 'session', since: open.started_at, session_id: open.id };
  const last = lastClosed(projectId);
  return { state: 'away', since: last?.ended_at ?? null, session_id: null };
}

export const isAway = (projectId: string) => !openSession(projectId);

/** The small tag each message to the director carries (runtime.ts sendToAgent). */
export function presenceTag(projectId: string): string {
  const p = presence(projectId);
  // The project's mode while it is not running (projectmode.ts): project="winding down", "at rest" or "stopped".
  const mode = presenceAttr(projectId);
  if (p.state === 'session') return `<presence user="here" session-since="${clockText(p.since!)}" tz="${zoneAbbr(now())}"${mode}/>`;
  return p.since ? `<presence user="away" since="${clockText(p.since)}" for="${durationText(now() - p.since)}" tz="${zoneAbbr(now())}"${mode}/>` : `<presence user="away" tz="${zoneAbbr(now())}"${mode}/>`;
}

/** What the header shows: presence plus, while away, how much the director has running and queued. */
export function presenceView(projectId: string) {
  const p = presence(projectId);
  const n = (sql: string) => Number(get(sql, projectId)?.n ?? 0);
  return {
    ...p,
    running: n("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'active'"),
    queued: n("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'scheduled'"),
    // Agents between turns with work in hand count too (busy.ts), as the agent views show them.
    working: n("SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND status = 'working'") + idleButBusy(projectId),
  };
}

// ---------- detecting activity ----------

/**
 * The owner did something in the project at `at`. Opens a session if none is open (closing a stale one first: the
 * timer may not have run yet), else extends it.
 */
export function recordOwnerActivity(projectId: string, at = now()) {
  const project = get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) return;
  let open = openSession(projectId);
  if (open && at - open.last_activity_at >= idleMs(project)) {
    endSession(open, 'idle', open.last_activity_at);
    open = undefined;
  }
  run('UPDATE projects SET last_owner_activity_at = ? WHERE id = ?', at, projectId);
  if (open) {
    run('UPDATE sessions SET last_activity_at = ?, actions = actions + 1 WHERE id = ?', Math.max(at, open.last_activity_at), open.id);
    return;
  }
  const prev = lastClosed(projectId);
  const id = newId('ses');
  run('INSERT INTO sessions (id, project_id, started_at, last_activity_at, actions) VALUES (?,?,?,?,1)', id, projectId, at, at);
  run('UPDATE projects SET away_nudges = 0, away_nudged_at = NULL WHERE id = ?', projectId);
  touchProject(projectId);
  if (prev) onReturn(projectId, id, prev.ended_at, at);
}

/** The owner's action finished being handled: the open session lasts at least until now. */
export function extendSession(projectId: string, at = now()) {
  run('UPDATE sessions SET last_activity_at = MAX(last_activity_at, ?) WHERE project_id = ? AND ended_at IS NULL', at, projectId);
}

/** The owner pressed "I'm stepping away": the open session ends now. Returns false when none was open. */
export function stepAway(projectId: string): boolean {
  const open = openSession(projectId);
  if (!open) return false;
  endSession(open, 'stepped_away', Math.max(now(), open.last_activity_at));
  return true;
}

/** Exported for the tests. */
export function endSession(s: Row, reason: 'idle' | 'stepped_away', endedAt: number) {
  // Only once: the runner's session timer and the web service's API can both find the same session to end.
  if (!Number(run('UPDATE sessions SET ended_at = ?, ended_reason = ? WHERE id = ? AND ended_at IS NULL', endedAt, reason, s.id).changes)) return;
  run('UPDATE projects SET away_nudges = 0, away_nudged_at = ? WHERE id = ?', endedAt, s.project_id);
  const detail = periodDetail(s.project_id, s.started_at, sessionTo(endedAt));
  const trivial = s.actions <= 1;
  // A plain line now, so the list never shows an empty session; the director's summary replaces it.
  run("UPDATE sessions SET summary = ?, summary_by = 'auto', summary_at = ? WHERE id = ?", autoSessionLine(detail), now(), s.id);
  touchProject(s.project_id);
  const work = queuedWork(s.project_id);
  const how = reason === 'stepped_away' ? `The user said they are stepping away (${clockText(endedAt)})` : `The user has been inactive since ${clockText(endedAt)}, so their session (from ${clockText(s.started_at)}) has ended`;
  const mode = modeOf(s.project_id);
  const carry = holdsNewWork(s.project_id)
    ? `The project is ${mode === 'stopped' ? 'stopped: nothing runs until the user resumes it' : mode === 'at_rest' ? 'at rest: nothing new starts' : 'finishing up: finish what is Active, start nothing new'}.`
    : mode === 'queue_only'
    ? work.total ? `You are working alone now. ${work.text} The project is in Queue only: take scheduled tasks in order and schedule nothing yourself.` : 'The project is in Queue only and nothing is scheduled: stay idle.'
    : work.total
    ? `You are working alone now: follow the rules for working while the user is away. ${work.text} Keep the agreed work moving in queue order.`
    : 'Nothing agreed is waiting to be done, so unless something already running needs you, there is nothing to start: stay idle.';
  // A session with one trivial action and nothing queued is not worth a turn: the next message's presence tag says it.
  if (trivial && !work.total) return;
  void notify(
    s.project_id,
    `${how}. ${trivial ? '' : `Write a short summary of that session with summarize_session (period "session"): what the user asked and decided, what was started and finished, and what is waiting on them; a few sentences they can skim next time. Summarise this session only (${spanText(s.started_at, endedAt)}); what Helm recorded in it:\n${factsText(detail)}\n`}${carry}`,
  );
}

/** What a period held, as lines for the director to summarise from (so it summarises that period, not the last thing it remembers). */
function factsText(d: PeriodDetail): string {
  const lines = [
    ...d.owner.slice(0, 15).map((o) => `- ${clockText(o.ts)} the user: ${o.kind === 'thread' || o.kind === 'task' ? `[${o.title}] ` : o.kind === 'answer' ? 'answered ' : ''}${o.text.replace(/\s+/g, ' ').slice(0, 160)}`),
    d.owner.length > 15 ? `- and ${d.owner.length - 15} more actions by the user` : '',
    ...d.tasks_created.map((t) => `- task created${t.origin === 'away' ? ' (found while away)' : t.origin === 'report' ? ' from a report' : ''}: "${t.title}" (${t.state} now)`),
    ...d.tasks_started.map((t) => `- task started: "${t.title}"`),
    ...d.tasks_finished.map((t) => `- task finished: "${t.title}"`),
    ...d.requests_open.map((r) => `- still waiting on the user: "${r.title}"`),
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : '- nothing recorded beyond the user being active';
}

/** The owner is back after an away period: ask the director for its summary, unless nothing happened. */
function onReturn(projectId: string, sessionId: string, from: number, at: number) {
  const detail = periodDetail(projectId, awayFrom(from), at);
  run("UPDATE sessions SET away_summary = ?, away_summary_by = 'auto', away_summary_at = ? WHERE id = ?", autoAwayLine(detail), now(), sessionId);
  if (agentCount(detail) === 0) return;
  void notify(
    projectId,
    `The user is back (session started ${clockText(at)}) after being away since ${clockText(from)} (${durationText(at - from)}). The rules for working with the user present apply again. After you have dealt with anything they sent, write the away-period summary with summarize_session (period "away"): what you finished alone, anything you found and fixed, reports you took on, what needs them. A few sentences they can skim. What Helm recorded while they were away:\n${factsText(detail)}`,
  );
}

/** Close sessions whose idle period has passed (also at boot, so a restart neither loses nor stretches one) and nudge stalled queues. */
export function sessionTick(at = now()) {
  for (const s of all('SELECT s.*, p.session_idle_minutes FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.ended_at IS NULL')) {
    if (at - s.last_activity_at >= idleMs(s)) endSession(s, 'idle', s.last_activity_at);
  }
  for (const p of all('SELECT * FROM projects WHERE archived = 0')) {
    maybeNudge(p, at);
    // A wind down whose last work ended without a status change noticing it (projectmode.ts).
    // Queue only: the queue that emptied without a status change noticing it, told once.
    if (p.mode === 'winding_down' || p.mode === 'queue_only') void checkAtRest(p.id).catch(() => {});
    // Tasks not running that look like the same or adjoining work: one note to the director when that set changed, at
    // most once a day (merge.ts). Not while the project is stopped.
    if (!isStopped(p.id)) {
      const review = queueReviewNote(p.id, at);
      if (review) void notify(p.id, review);
    }
  }
  checkStalls(at);
  // Requests held for a turn that ended without a result (the process died): shown now (requests.ts).
  releaseStale();
  releaseQuiet(at);
}

let timer: NodeJS.Timeout | null = null;
export function startSessionTimer() {
  sessionTick();
  timer = setInterval(() => sessionTick(), 30_000);
}
export function stopSessionTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---------- carrying on while away ----------

/**
 * Agreed work that could be picked up: scheduled, waiting and active tasks with no open request to the user. Waiting
 * ones only on Autopilot: in Queue only the director never lines them up.
 */
function queuedWork(projectId: string): { total: number; text: string } {
  const rows = all(
    `SELECT state, COUNT(*) AS n FROM tasks t WHERE project_id = ? AND kind = 'task' AND state IN ('active','scheduled'${autoSchedules(projectId) ? ",'waiting'" : ''})
       AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.task_id = t.id AND i.status = 'open') GROUP BY state`,
    projectId,
  );
  const by = Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
  const parts = [by.active && `${by.active} active`, by.scheduled && `${by.scheduled} scheduled`, by.waiting && `${by.waiting} waiting`].filter(Boolean);
  const total = (by.active ?? 0) + (by.scheduled ?? 0) + (by.waiting ?? 0);
  return { total, text: total ? `Tasks not blocked on the user: ${parts.join(', ')} (list_tasks).` : '' };
}

/**
 * While the owner is away, a queue with work and nobody working could stall silently: nudge the director, at most every
 * AWAY_NUDGE_MS, and stop after a few nudges that changed nothing until a task moves again. Never during a session.
 */
function maybeNudge(project: Row, at: number) {
  if (openSession(project.id)) return;
  // Finishing up, at rest or stopped: nothing new is taken from the queue (projectmode.ts). Queue only counts no Waiting work.
  if (holdsNewWork(project.id)) return;
  const since = Math.max(project.away_nudged_at ?? 0, lastClosed(project.id)?.ended_at ?? 0);
  if (!since || at - since < AWAY_NUDGE_MS) return;
  const root = get("SELECT * FROM agents WHERE project_id = ? AND parent_id IS NULL AND status != 'closed' ORDER BY created_at LIMIT 1", project.id);
  if (!root || root.status === 'working' || root.status === 'waiting') return;
  if (get("SELECT 1 AS x FROM agents WHERE project_id = ? AND status = 'working' LIMIT 1", project.id)) return;
  const work = queuedWork(project.id);
  if (!work.total) return;
  // Something moved since the last nudge: the director is not stuck, start counting again.
  const moved = project.away_nudged_at && get('SELECT 1 AS x FROM task_states s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ? AND s.at > ? LIMIT 1', project.id, project.away_nudged_at);
  const nudges = moved ? 0 : project.away_nudges;
  if (nudges >= MAX_IDLE_NUDGES) return;
  run('UPDATE projects SET away_nudged_at = ?, away_nudges = ? WHERE id = ?', at, nudges + 1, project.id);
  void notify(
    project.id,
    `The user is still away and nothing is running. ${work.text} Take the next one in queue order${autoSchedules(project.id) ? ' (schedule a waiting task yourself if the scheduled queue is empty)' : ''}, or, if each is blocked on the user, make sure that is asked on the task and stay idle.`,
  );
}

/** Tasks the director created while the owner was away in the current away period (create_task's limit). */
export function awayTasksCreated(projectId: string): number {
  const since = presence(projectId).since ?? 0;
  return Number(get("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND origin = 'away' AND created_at >= ?", projectId, since)?.n ?? 0);
}

// ---------- attribution ----------

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** A message to the director as the user typed it, without the tags Helm wraps around answers and thread messages. */
const plainText = (t: string) => t.replace(/<presence[^>]*\/>\s*/g, '').trim();

/**
 * What happened in [from, to): what the owner asked or decided, tasks created, started and finished (with time taken),
 * previews, decisions, Spec changes, requests asked (and which are still open), discussions opened and settled.
 */
export function periodDetail(projectId: string, from: number, to: number) {
  const owner: Row[] = [];
  for (const e of all("SELECT id, ts, data FROM events WHERE project_id = ? AND ts >= ? AND ts < ? AND kind = 'inbound' ORDER BY ts", projectId, from, to)) {
    const d = JSON.parse(e.data);
    if (d.from?.kind !== 'user') continue;
    const text = plainText(String(d.text ?? ''));
    // Answers and thread messages are listed from their own tables below.
    if (/^<(user-answer|task-message|discussion-message)\b/.test(text)) continue;
    owner.push({ ts: e.ts, kind: 'message', text: clip(text) });
  }
  for (const m of all(
    "SELECT m.created_at, m.body, m.kind, t.id AS task_id, t.title, t.kind AS tkind FROM task_messages m JOIN tasks t ON t.id = m.task_id WHERE t.project_id = ? AND m.created_at >= ? AND m.created_at < ? AND (m.author = 'user' OR (m.kind = 'state' AND m.body LIKE 'You %')) ORDER BY m.created_at",
    projectId, from, to,
  )) {
    owner.push({ ts: m.created_at, kind: m.kind === 'state' ? 'task' : 'thread', text: clip(m.body), task_id: m.task_id, title: m.title });
  }
  for (const i of all(
    "SELECT id, title, answer, answered_at, task_id, kind FROM inbox WHERE project_id = ? AND answered_at >= ? AND answered_at < ? AND (status = 'answered' OR answer = 'Dismissed') ORDER BY answered_at",
    projectId, from, to,
  )) {
    owner.push({ ts: i.answered_at, kind: 'answer', text: clip(`${i.title}: ${i.answer}`), task_id: i.task_id, title: i.title });
  }
  for (const r of all(
    "SELECT r.created_at, r.doc_id, r.op, COALESCE(d.title, r.title) AS title FROM doc_revisions r LEFT JOIN docs d ON d.id = r.doc_id WHERE r.project_id = ? AND r.created_at >= ? AND r.created_at < ? AND r.author = 'user' ORDER BY r.created_at",
    projectId, from, to,
  )) {
    owner.push({ ts: r.created_at, kind: 'spec', text: `${r.op === 'create' ? 'Added' : r.op === 'delete' ? 'Removed' : 'Edited'} the Spec entry "${r.title}"`, doc_id: r.doc_id });
  }
  for (const p of all(
    "SELECT p.decided_at, p.status, p.doc_id, COALESCE(d.title, '') AS title FROM doc_proposals p LEFT JOIN docs d ON d.id = p.doc_id WHERE p.project_id = ? AND p.decided_at >= ? AND p.decided_at < ? AND p.status IN ('applied','declined')",
    projectId, from, to,
  )) {
    owner.push({ ts: p.decided_at, kind: 'spec', text: `${p.status === 'applied' ? 'Applied' : 'Declined'} a proposed edit to "${p.title}"`, doc_id: p.doc_id });
  }
  owner.sort((a, b) => a.ts - b.ts);

  const taskCols = 'id, project_id, title, state, origin, origin_note, started_at, finished_at, active_ms, active_since, created_at, became_task_at';
  const range = [projectId, from, to];
  const created = all(`SELECT ${taskCols} FROM tasks WHERE project_id = ? AND kind = 'task' AND created_at >= ? AND created_at < ? ORDER BY created_at`, ...range);
  const started = all(`SELECT ${taskCols} FROM tasks WHERE project_id = ? AND kind = 'task' AND started_at >= ? AND started_at < ? ORDER BY started_at`, ...range);
  const finished = all(`SELECT ${taskCols} FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'done' AND finished_at >= ? AND finished_at < ? ORDER BY finished_at`, ...range).map(
    // What it took: work time, never time it waited on the user (worktime.ts); null when unknown.
    (t): Row => ({ ...t, took_ms: taskTimes(t).workMs }),
  );
  const stateChanges = Number(get('SELECT COUNT(*) AS n FROM task_states s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ? AND s.at >= ? AND s.at < ?', ...range)?.n ?? 0);
  const previews = all('SELECT id, kind, title, task_id, agent_id, created_at FROM previews WHERE project_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at', ...range);
  const journal = all("SELECT id, kind, title, body, task_id, doc_id, agent_id, ts FROM journal WHERE project_id = ? AND ts >= ? AND ts < ? AND kind IN ('decision','milestone') ORDER BY ts", ...range);
  const spec = all(
    `SELECT r.doc_id, COALESCE(d.title, MAX(r.title)) AS title, COUNT(*) AS edits, MIN(r.op) AS op, GROUP_CONCAT(DISTINCT r.author_name) AS by
       FROM doc_revisions r LEFT JOIN docs d ON d.id = r.doc_id WHERE r.project_id = ? AND r.created_at >= ? AND r.created_at < ? GROUP BY r.doc_id ORDER BY MIN(r.created_at)`,
    ...range,
  );
  const requests = all('SELECT id, kind, title, status, task_id, created_at, answered_at FROM inbox WHERE project_id = ? AND created_at >= ? AND created_at < ? ORDER BY created_at', ...range);
  const discussionsOpened = all("SELECT id, title, state, created_at FROM tasks WHERE project_id = ? AND kind = 'discussion' AND inbox_archive = 0 AND requests_agent_id IS NULL AND created_at >= ? AND created_at < ? ORDER BY created_at", ...range);
  const discussionsSettled = all(
    "SELECT t.id, t.title, m.created_at FROM task_messages m JOIN tasks t ON t.id = m.task_id WHERE t.project_id = ? AND m.created_at >= ? AND m.created_at < ? AND m.kind = 'state' AND (m.body LIKE '%closed this discussion%' OR m.body LIKE '%settled this discussion%') ORDER BY m.created_at",
    ...range,
  );
  return {
    from,
    to,
    owner,
    tasks_created: created,
    tasks_started: started,
    tasks_finished: finished,
    state_changes: stateChanges,
    previews,
    journal,
    spec_changes: spec,
    requests_asked: requests,
    requests_open: requests.filter((r) => r.status === 'open'),
    discussions_opened: discussionsOpened,
    discussions_settled: discussionsSettled,
  };
}
export type PeriodDetail = ReturnType<typeof periodDetail>;


/** Anything agents did: if zero, an away period has nothing to summarise. */
const agentCount = (d: PeriodDetail) =>
  d.tasks_created.length + d.tasks_started.length + d.tasks_finished.length + d.previews.length + d.journal.length + d.spec_changes.length + d.requests_asked.length + d.state_changes;

export function headline(d: PeriodDetail) {
  return {
    owner: d.owner.length,
    started: d.tasks_started.length,
    finished: d.tasks_finished.length,
    created: d.tasks_created.length,
    found: d.tasks_created.filter((t) => t.origin === 'away').length,
    previews: d.previews.length,
    decisions: d.journal.filter((j) => j.kind === 'decision').length,
    spec: d.spec_changes.length,
    asked: d.requests_asked.length,
    open: d.requests_open.length,
  };
}

/** A plain line for a session nobody summarised (or not worth a turn to). */
export function autoSessionLine(d: PeriodDetail): string {
  const k = (kind: string) => d.owner.filter((o) => o.kind === kind).length;
  const said = [
    k('message') && plural(k('message'), 'message') + ' to the director',
    k('thread') && plural(k('thread'), 'message') + ' in threads',
    k('answer') && plural(k('answer'), 'request') + ' answered',
    k('task') && plural(k('task'), 'task action'),
    k('spec') && plural(k('spec'), 'Spec change'),
  ].filter(Boolean);
  const work = [d.tasks_started.length && `${d.tasks_started.length} started`, d.tasks_finished.length && `${d.tasks_finished.length} finished`].filter(Boolean);
  return `${said.length ? said.join(', ') : 'No recorded actions'}.${work.length ? ` Tasks: ${work.join(', ')}.` : ''}`;
}

/** A plain line for an away period with nothing worth a turn. */
export function autoAwayLine(d: PeriodDetail): string {
  if (!agentCount(d)) return 'Quiet: nothing was started or finished.';
  const bits = [
    d.tasks_finished.length && `${plural(d.tasks_finished.length, 'task')} finished`,
    d.tasks_started.length && `${d.tasks_started.length} started`,
    d.tasks_created.filter((t) => t.origin === 'away').length && `${plural(d.tasks_created.filter((t) => t.origin === 'away').length, 'problem')} found and taken on`,
    d.tasks_created.filter((t) => t.origin === 'report').length && `${plural(d.tasks_created.filter((t) => t.origin === 'report').length, 'report')} taken on`,
    d.previews.length && plural(d.previews.length, 'preview'),
  ].filter(Boolean);
  return bits.length ? `${bits.join(', ')}.` : 'Some housekeeping; nothing started or finished.';
}

// ---------- listing ----------

export type Period = {
  id: string;
  kind: 'session' | 'away';
  start: number;
  /** null: still going on. */
  end: number | null;
  ended_reason?: string;
  summary: string;
  summary_by: string;
  counts: ReturnType<typeof headline>;
};

/** Sessions and the away periods between them, newest first. An away period's id is "away_" + the session that began it. */
export function listPeriods(projectId: string, opts: { before?: number; limit?: number } = {}): Period[] {
  const limit = Math.min(opts.limit ?? 40, 200);
  const sessions = all(
    `SELECT * FROM sessions WHERE project_id = ? ${opts.before ? 'AND started_at < ?' : ''} ORDER BY started_at DESC LIMIT ?`,
    ...(opts.before ? [projectId, opts.before, limit + 1] : [projectId, limit + 1]),
  );
  const out: Period[] = [];
  const at = now();
  for (let i = 0; i < Math.min(sessions.length, limit); i++) {
    const s = sessions[i];
    const newer = i > 0 ? sessions[i - 1] : get('SELECT * FROM sessions WHERE project_id = ? AND started_at > ? ORDER BY started_at LIMIT 1', projectId, s.started_at);
    if (s.ended_at != null) {
      const end = newer?.started_at ?? null;
      out.push({
        id: `away_${s.id}`, kind: 'away', start: s.ended_at, end,
        summary: newer?.away_summary ?? '', summary_by: newer?.away_summary_by ?? '',
        counts: headline(periodDetail(projectId, awayFrom(s.ended_at), end ?? at)),
      });
    }
    out.push({
      id: s.id, kind: 'session', start: s.started_at, end: s.ended_at, ended_reason: s.ended_reason,
      summary: s.summary, summary_by: s.summary_by,
      counts: headline(periodDetail(projectId, s.started_at, sessionTo(s.ended_at, at))),
    });
  }
  return out;
}

/** One period by id, with everything in it. */
export function getPeriod(projectId: string, id: string): (Period & { detail: PeriodDetail }) | null {
  const away = id.startsWith('away_');
  const s = get('SELECT * FROM sessions WHERE id = ? AND project_id = ?', away ? id.slice(5) : id, projectId);
  if (!s || (away && s.ended_at == null)) return null;
  const at = now();
  if (!away) {
    const detail = periodDetail(projectId, s.started_at, sessionTo(s.ended_at, at));
    return { id, kind: 'session', start: s.started_at, end: s.ended_at, ended_reason: s.ended_reason, summary: s.summary, summary_by: s.summary_by, counts: headline(detail), detail };
  }
  const next = get('SELECT * FROM sessions WHERE project_id = ? AND started_at >= ? AND id != ? ORDER BY started_at LIMIT 1', projectId, s.ended_at, s.id);
  const detail = periodDetail(projectId, awayFrom(s.ended_at), next?.started_at ?? at);
  return { id, kind: 'away', start: s.ended_at, end: next?.started_at ?? null, summary: next?.away_summary ?? '', summary_by: next?.away_summary_by ?? '', counts: headline(detail), detail };
}

/** Session and away boundaries overlapping [from, to], oldest first, for dividers in a task's history. */
export function boundaries(projectId: string, from: number, to: number): { kind: 'session' | 'away'; start: number; end: number | null }[] {
  const rows = all('SELECT started_at, ended_at FROM sessions WHERE project_id = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at', projectId, to, from);
  const before = get('SELECT started_at, ended_at FROM sessions WHERE project_id = ? AND ended_at < ? ORDER BY ended_at DESC LIMIT 1', projectId, from);
  const after = get('SELECT started_at FROM sessions WHERE project_id = ? AND started_at > ? ORDER BY started_at LIMIT 1', projectId, to);
  const out: { kind: 'session' | 'away'; start: number; end: number | null }[] = [];
  let prevEnd: number | null = before?.ended_at ?? null;
  for (const r of rows) {
    if (prevEnd != null) out.push({ kind: 'away', start: prevEnd, end: r.started_at });
    out.push({ kind: 'session', start: r.started_at, end: r.ended_at });
    prevEnd = r.ended_at;
  }
  if (prevEnd != null) out.push({ kind: 'away', start: prevEnd, end: after?.started_at ?? null });
  return out.filter((p) => (p.end ?? Infinity) >= from && p.start <= to);
}

// ---------- summaries ----------

/** The director's summary of the last ended session, or of the away period that ended at the open (or last) session. */
export function writeSummary(projectId: string, period: 'session' | 'away', summary: string, id?: string): string {
  if (period === 'session') {
    const s = id ? get('SELECT * FROM sessions WHERE id = ? AND project_id = ?', id, projectId) : lastClosed(projectId);
    if (!s) return 'There is no ended session to summarise.';
    run("UPDATE sessions SET summary = ?, summary_by = 'director', summary_at = ? WHERE id = ?", summary, now(), s.id);
    touchProject(projectId);
    return `Saved the summary of the session ${spanText(s.started_at, s.ended_at ?? now())}.`;
  }
  const s = id
    ? get('SELECT * FROM sessions WHERE id = ? AND project_id = ?', id.replace(/^away_/, ''), projectId)
    : get('SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC LIMIT 1', projectId);
  // An away id names the session that began it; its summary is kept on the session that ended it.
  const target = id?.startsWith('away_') && s ? get('SELECT * FROM sessions WHERE project_id = ? AND started_at >= ? AND id != ? ORDER BY started_at LIMIT 1', projectId, s.ended_at ?? Infinity, s.id) : s;
  const prev = target && get('SELECT ended_at FROM sessions WHERE project_id = ? AND ended_at IS NOT NULL AND ended_at <= ? ORDER BY ended_at DESC LIMIT 1', projectId, target.started_at);
  if (!target || !prev) return 'There is no ended away period to summarise: the user has not come back since they left. Write it when you are told they are back.';
  run("UPDATE sessions SET away_summary = ?, away_summary_by = 'director', away_summary_at = ? WHERE id = ?", summary, now(), target.id);
  touchProject(projectId);
  return `Saved the summary of the away period ${spanText(prev.ended_at, target.started_at)}.`;
}

// ---------- which requests are the owner's activity ----------

/** Paths the owner uses that are not activity in a project: global settings, dry runs, and stepping away itself. */
const NOT_ACTIVITY = [/^\/api\/projects\/:id\/away$/, /^\/api\/projects\/:id\/report-sources\/preview$/, /^\/api\/projects\/:id\/previews$/, /^\/api\/login$/, /^\/api\/version\//, /^\/api\/hosts/, /^\/api\/toolbox\/(?!:id\/projects\/:projectId)/];
const TABLE_BY_SEGMENT: Record<string, string[]> = {
  tasks: ['tasks'],
  docs: ['docs'],
  proposals: ['doc_proposals'],
  sections: ['doc_sections'],
  importance: ['tasks', 'docs'],
  'report-sources': ['report_sources'],
  reports: ['reports'],
  attachments: ['attachments'],
  agents: ['agents'],
  requests: ['inbox'],
  inbox: ['inbox'],
  previews: ['previews'],
};

/** The project a mutating API request acts in, or null when it is not owner activity in a project. */
export function activityProject(method: string, route: string | undefined, params: Record<string, string>): string | null {
  if (!route || ['GET', 'HEAD', 'OPTIONS'].includes(method)) return null;
  if (!route.startsWith('/api/') || NOT_ACTIVITY.some((re) => re.test(route))) return null;
  if (params.projectId) return params.projectId;
  const m = /^\/api\/([a-z-]+)\/:id\b/.exec(route);
  if (!m || !params.id) return null;
  if (m[1] === 'projects') return get('SELECT id FROM projects WHERE id = ?', params.id) ? params.id : null;
  for (const table of TABLE_BY_SEGMENT[m[1]] ?? []) {
    const row = get(`SELECT project_id FROM ${table} WHERE id = ?`, params.id);
    if (row?.project_id) return row.project_id;
  }
  return null;
}

// ---------- backfill ----------

/** Every time the owner did something in a project, from data kept before sessions existed. */
function pastActivity(projectId: string): number[] {
  const times = (sql: string) => all(sql, projectId).map((r) => Number(r.t));
  return [
    ...times("SELECT ts AS t FROM events WHERE project_id = ? AND kind = 'inbound' AND json_extract(data, '$.from.kind') = 'user'"),
    ...times("SELECT m.created_at AS t FROM task_messages m JOIN tasks t ON t.id = m.task_id WHERE t.project_id = ? AND (m.author = 'user' OR (m.kind = 'state' AND m.body LIKE 'You %'))"),
    ...times("SELECT answered_at AS t FROM inbox WHERE project_id = ? AND answered_at IS NOT NULL AND (status = 'answered' OR answer = 'Dismissed')"),
    ...times("SELECT created_at AS t FROM doc_revisions WHERE project_id = ? AND author = 'user'"),
    ...times("SELECT created_at AS t FROM importance_changes WHERE project_id = ? AND author = 'user'"),
    ...times("SELECT decided_at AS t FROM doc_proposals WHERE project_id = ? AND decided_at IS NOT NULL AND status IN ('applied','declined')"),
    ...times("SELECT created_at AS t FROM attachments WHERE project_id = ? AND uploader = 'user'"),
    ...times('SELECT ts AS t FROM journal WHERE project_id = ? AND agent_id IS NULL'),
  ]
    .filter((t) => Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
}

/**
 * Group the owner's past activity into sessions, once per project (projects.sessions_backfilled), so history is grouped
 * from the first day. Sessions and away periods get plain automatic summaries; the director is told nothing. A last
 * session still within the idle period stays open.
 */
export function backfillSessions(at = now()): { project: string; sessions: number }[] {
  const out: { project: string; sessions: number }[] = [];
  for (const p of all('SELECT * FROM projects WHERE sessions_backfilled = 0')) {
    const idle = idleMs(p);
    const times = pastActivity(p.id).filter((t) => t <= at);
    const groups: { start: number; last: number; n: number }[] = [];
    for (const t of times) {
      const g = groups[groups.length - 1];
      if (g && t - g.last < idle) {
        g.last = t;
        g.n++;
      } else groups.push({ start: t, last: t, n: 1 });
    }
    tx(() => {
      // Only sessions before the first live one are made; a rerun after a failure starts clean.
      run('DELETE FROM sessions WHERE project_id = ? AND backfilled = 1', p.id);
      const firstLive = get('SELECT MIN(started_at) AS t FROM sessions WHERE project_id = ?', p.id)?.t ?? Infinity;
      let prevEnd: number | null = null;
      let made = 0;
      for (const [i, g] of groups.entries()) {
        if (g.start >= firstLive) break;
        const open = i === groups.length - 1 && at - g.last < idle && firstLive === Infinity;
        const end = open ? null : g.last;
        const id = newId('ses');
        const d = periodDetail(p.id, g.start, sessionTo(end, at));
        const away = prevEnd != null ? autoAwayLine(periodDetail(p.id, awayFrom(prevEnd), g.start)) : '';
        run(
          `INSERT INTO sessions (id, project_id, started_at, last_activity_at, ended_at, ended_reason, actions, summary, summary_by, summary_at, away_summary, away_summary_by, away_summary_at, backfilled)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1)`,
          id, p.id, g.start, g.last, end, end == null ? '' : 'idle', g.n, end == null ? '' : autoSessionLine(d), end == null ? '' : 'auto', end == null ? null : at,
          away, away ? 'auto' : '', away ? at : null,
        );
        prevEnd = end;
        made++;
      }
      run('UPDATE projects SET sessions_backfilled = 1, last_owner_activity_at = COALESCE(last_owner_activity_at, ?) WHERE id = ?', times[times.length - 1] ?? null, p.id);
      out.push({ project: p.name, sessions: made });
    });
  }
  return out;
}
