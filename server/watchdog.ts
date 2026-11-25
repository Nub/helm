import { all, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { rootAgent, sendToAgent } from './agents.ts';
import type { Sender } from './agents.ts';
import { createRequest, withdrawRequest } from './requests.ts';
import { getSetting } from './settings.ts';
import { isStopped } from './projectmode.ts';
import { addTaskMessage, getTask, setTaskState, USER } from './tasks.ts';
import { touchProject } from './store.ts';
import { openBlockers } from './waits.ts';
import { workInHand } from './busy.ts';
import { agentsOn, doneCount, workMoved } from './progress.ts';
import { isUserAsk, sentences } from './userasks.ts';
import { turnInbound } from './turns.ts';

/**
 * The watchdog: nothing Active sits idle unseen, and an agent that says it waits on the user has a request open.
 *
 * Every minute (runner, startWatchdog) each Active task is put in one state (activityOf):
 * - working: one of its agents is mid-turn;
 * - busy: between turns with work in hand (busy.ts workInHand: a background command, a host claim, a subagent, a consult);
 * - waiting: a request is open on it, or an agent waits on the user, errored or was stopped, or the director owes a re-plan;
 * - idle: none of these.
 * The time in each between-turn state is kept per task (task_watch idle_ms / waiting_ms / busy_ms) for telemetry.
 * An idle spell of IDLE_MS is a strike: the first wakes the driver, the second tells the director (its last status and
 * message), the third marks the task Stalled with one request to the user (Resume / Drop). Movement (a worklist item
 * done, an edit or commit, a request filed on it) since the last strike clears the count. The step is pure (step), so
 * the replay over past data (server/checks/watchdog-replay.ts) runs the same rule.
 *
 * At the end of a builder's or the director's turn (runtime.ts), text saying it waits on the user with no request open
 * on its task gets one re-prompt in the same turn (waitingTurn); if the next turn still ends without one, Helm files
 * the request itself from that text, marked as filed by Helm.
 */


/** Idle this long with nothing pending is a strike. */
export const IDLE_MS = 3 * 60_000;
/** How often the runner looks. */
export const TICK_MS = 60_000;
/** A gap between looks longer than this (the runner was down) is not counted in the telemetry. */
const MAX_GAP_MS = 3 * TICK_MS;

export type Activity = 'working' | 'busy' | 'waiting' | 'idle';
export type Action = 'wake' | 'director' | 'stall' | null;
export type WatchRow = { state: string; tick_at: number | null; idle_since: number | null; strikes: number; strike_at: number | null; stalled_at: number | null; idle_ms: number; waiting_ms: number; busy_ms: number };

/**
 * One look at a task. Pure: the row before, what the task is doing now, whether it moved since the last strike, and
 * when its agents last did anything (their newest event). Returns the row after and what to do.
 */
export function step(r: WatchRow, st: Activity, at: number, moved: boolean, lastEvent: number): { row: WatchRow; action: Action } {
  const row = { ...r };
  if (row.tick_at != null) {
    const dt = at - row.tick_at;
    if (dt > 0 && dt <= MAX_GAP_MS) {
      if (row.state === 'idle') row.idle_ms += dt;
      else if (row.state === 'waiting') row.waiting_ms += dt;
      else if (row.state === 'busy') row.busy_ms += dt;
    }
  }
  // Moving again clears the count, and a Stalled mark with it.
  if (moved) (row.strikes = 0), (row.stalled_at = null);
  let action: Action = null;
  if (st !== 'idle') row.idle_since = null;
  else {
    // The spell began at the agents' last event, or when the last look saw them working, busy or waiting.
    // Anything they do later (an event) starts it again.
    row.idle_since = Math.max(row.idle_since ?? 0, lastEvent, row.strike_at ?? 0, row.idle_since == null && row.state && row.state !== 'idle' && row.tick_at != null ? row.tick_at : 0);
    if (row.stalled_at == null && at - row.idle_since >= IDLE_MS) {
      row.strikes += 1;
      row.strike_at = at;
      row.idle_since = at;
      action = row.strikes === 1 ? 'wake' : row.strikes === 2 ? 'director' : 'stall';
      if (action === 'stall') row.stalled_at = at;
    }
  }
  row.state = st;
  row.tick_at = at;
  return { row, action };
}

/**
 * What a task is doing now (see the header). Read-only. Never idle while it waits on the user or on other work: any
 * request open on it (Spec cards included), an open blocker (waits_for), or, for a task the director drives, a last
 * thread post of the director's that asks the user something.
 */
export function activityOf(t: Row, agents: Row[] = agentsOn(t)): Activity {
  if (agents.some((a) => a.status === 'working')) return 'working';
  if (agents.some((a) => a.status === 'idle' && workInHand(a))) return 'busy';
  if (get('SELECT 1 AS x FROM running_commands WHERE task_id = ? AND background = 1 AND ended_at IS NULL AND started_at > ? LIMIT 1', t.id, now() - 2 * 3600_000)) return 'busy';
  if (agents.some((a) => ['waiting', 'error', 'interrupted'].includes(a.status))) return 'waiting';
  if (get("SELECT 1 AS x FROM inbox WHERE task_id = ? AND status IN ('open', 'held') LIMIT 1", t.id)) return 'waiting';
  if (openBlockers(t.id).length) return 'waiting';
  if (get('SELECT 1 AS x FROM task_progress WHERE task_id = ? AND replan_due IS NOT NULL', t.id)) return 'waiting';
  if (directorAsked(t)) return 'waiting';
  return 'idle';
}

/** A task the director drives whose last thread post is the director's, asking the user something. */
function directorAsked(t: Row): boolean {
  const root = get('SELECT id FROM agents WHERE project_id = ? AND parent_id IS NULL', t.project_id);
  if (!root || t.driver_agent_id !== root.id) return false;
  const last = get("SELECT author, body FROM task_messages WHERE task_id = ? AND kind IN ('message', 'summary') ORDER BY id DESC LIMIT 1", t.id);
  return !!last && last.author === 'director' && waitingSentence(String(last.body)) != null;
}

/** How the watchdog reaches agents: the agents facade; tests replace it. */
let hooks = {
  send: (agentId: string, text: string, from: Sender) => sendToAgent(agentId, text, from),
};
export function setWatchdogHooks(h: typeof hooks) {
  hooks = h;
}

const HELM = { author: 'system' as const, name: 'Helm' };
const SYSTEM: Sender = { kind: 'system', name: 'Helm' };
const clip = (s: unknown, n: number) => {
  const x = String(s ?? '').replace(/\s+/g, ' ').trim();
  return x.length > n ? `${x.slice(0, n - 1)}…` : x;
};

function rowOf(t: Row): Row {
  const r = get('SELECT * FROM task_watch WHERE task_id = ?', t.id);
  if (r) return r;
  run('INSERT OR IGNORE INTO task_watch (task_id, project_id, done_seen) VALUES (?,?,?)', t.id, t.project_id, doneCount(t));
  return get('SELECT * FROM task_watch WHERE task_id = ?', t.id)!;
}

/** Movement since `since`: a worklist item done, an edit or commit, or a request filed on the task. */
function movedSince(t: Row, r: Row, since: number): boolean {
  const done = doneCount(t);
  if (done !== Number(r.done_seen)) run('UPDATE task_watch SET done_seen = ? WHERE task_id = ?', done, t.id);
  if (done > Number(r.done_seen)) return true;
  if (workMoved(t, since)) return true;
  return !!get("SELECT 1 AS x FROM inbox WHERE task_id = ? AND kind IN ('question', 'action') AND created_at > ? AND payload NOT LIKE '%\"watchdog_stalls\"%' LIMIT 1", t.id, since);
}

const lastEventOf = (agents: Row[]) => {
  if (!agents.length) return 0;
  return Number(get(`SELECT MAX(ts) AS ts FROM events WHERE agent_id IN (${agents.map(() => '?').join(',')})`, ...agents.map((a) => a.id))?.ts ?? 0);
};

/** One look at every Active task of a project. */
export async function watchProject(projectId: string, at = now()) {
  if (!getSetting(projectId, 'progress_checks') || isStopped(projectId)) return;
  const tasks = all("SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'active' AND review_since IS NULL", projectId);
  for (const t of tasks) {
    const agents = agentsOn(t);
    if (!agents.length) continue;
    const r = rowOf(t);
    const st = activityOf(t, agents);
    const since = Math.max(Number(r.strike_at ?? 0), Number(t.started_at ?? 0));
    const moved = Number(r.strikes) > 0 && movedSince(t, r, since);
    const { row, action } = step(r as WatchRow, st, at, moved, Math.max(lastEventOf(agents), Number(t.active_since ?? t.started_at ?? 0)));
    run(
      'UPDATE task_watch SET state = ?, tick_at = ?, idle_since = ?, strikes = ?, strike_at = ?, stalled_at = ?, idle_ms = ?, waiting_ms = ?, busy_ms = ?, wakes = wakes + ? WHERE task_id = ?',
      row.state, row.tick_at, row.idle_since, row.strikes, row.strike_at, row.stalled_at, row.idle_ms, row.waiting_ms, row.busy_ms, action ? 1 : 0, t.id,
    );
    if (action) await act(t, action, r, at).catch((err) => console.error('Watchdog:', err));
    else if (moved && r.stalled_at != null) run('UPDATE task_watch SET stall_user = 0, stall_asked = 0 WHERE task_id = ?', t.id);
  }
  syncStallRequest(projectId);
}

async function act(t: Row, action: Exclude<Action, null>, r: Row, at: number) {
  const project = get('SELECT * FROM projects WHERE id = ?', t.project_id);
  if (!project) return;
  const root = rootAgent(project);
  const driver = t.driver_agent_id ? get("SELECT * FROM agents WHERE id = ? AND status != 'closed'", t.driver_agent_id) : undefined;
  if (action === 'wake') {
    addTaskMessage(t, HELM, 'Watchdog: idle with nothing pending for 3 min; Helm woke its driver.', 'state');
    touchProject(t.project_id);
    if (driver) await hooks.send(driver.id, `<helm-note kind="watchdog">Your task [[${t.id}]] is idle and nothing is waiting: continue, finish with complete_task, or ask the user (ask_user).</helm-note>`, SYSTEM);
    return;
  }
  if (action === 'director') {
    const status = clip(t.status_summary || driver?.status_line || '', 300) || 'none';
    const last = clip(driver?.last_result || get("SELECT body FROM task_messages WHERE task_id = ? AND kind != 'state' ORDER BY id DESC LIMIT 1", t.id)?.body || '', 600) || 'none';
    addTaskMessage(t, HELM, 'Watchdog: still idle after the wake; the director was told.', 'state');
    touchProject(t.project_id);
    await hooks.send(
      root.id,
      `<helm-note kind="watchdog">[[${t.id}]] sat idle twice with nothing pending (no request, no command, no subagent), once after Helm woke its driver.\nLast status: ${status}\nLast message: ${last}\nGet it moving, finish it, or file what it waits on. A third idle spell marks it Stalled and asks the user.</helm-note>`,
      SYSTEM,
    );
    return;
  }
  // Stalled. Put to the user once a day per task; a task stalling again within the day goes to the director.
  if (r.user_stall_at != null && at - Number(r.user_stall_at) < DAY_MS) {
    run('UPDATE task_watch SET stall_user = 0, stall_asked = 0 WHERE task_id = ?', t.id);
    addTaskMessage(t, HELM, 'Watchdog: stalled again within the day; marked Stalled and the director told.', 'state');
    touchProject(t.project_id);
    await hooks.send(root.id, `<helm-note kind="watchdog">[[${t.id}]] stalled again (idle three times with nothing pending) within a day of the user resuming it. Helm did not ask the user again: get it moving, finish it, drop it, or file what it waits on.</helm-note>`, SYSTEM);
    return;
  }
  run('UPDATE task_watch SET stall_user = 1, stall_asked = 0, user_stall_at = ? WHERE task_id = ?', at, t.id);
  addTaskMessage(t, HELM, 'Watchdog: idle a third time with nothing pending; marked Stalled and the user asked.', 'state');
  touchProject(t.project_id);
}

const DAY_MS = 24 * 3600_000;

/** The open "stalled" request of a project, if any. */
const openStallRequest = (projectId: string) =>
  all("SELECT * FROM inbox WHERE project_id = ? AND status IN ('open', 'held') AND kind = 'question' AND payload LIKE '%\"watchdog_stalls\"%'", projectId)[0];

/**
 * One request per project lists every task Stalled and put to the user, with Resume and Drop for each. It is replaced
 * (withdrawn and filed again) when the list changes: a task newly stalled, or one that moved, finished or was answered.
 */
export function syncStallRequest(projectId: string) {
  const stalled = all(
    "SELECT t.*, w.stall_asked FROM task_watch w JOIN tasks t ON t.id = w.task_id WHERE w.project_id = ? AND w.stalled_at IS NOT NULL AND w.stall_user = 1 AND t.state = 'active' ORDER BY w.stalled_at, t.id",
    projectId,
  );
  const open = openStallRequest(projectId);
  const listed: string[] = open ? (JSON.parse(open.payload || '{}').watchdog_stalls ?? []).map((x: Row) => x.id) : [];
  const ids = stalled.map((t) => t.id);
  const same = listed.length === ids.length && listed.every((id, i) => id === ids[i]);
  if (open && same) return;
  if (!open && stalled.every((t) => Number(t.stall_asked) === 1)) return; // answered or dismissed, nothing new
  if (open) withdrawRequest(open.id, ids.length ? 'The list of stalled tasks changed.' : 'No task is stalled any more.');
  if (!ids.length) return;
  const one = stalled.length === 1;
  createRequest({
    projectId,
    agentId: null,
    kind: 'question',
    title: one ? `${clip(stalled[0].title, 90)} stalled` : `${stalled.length} tasks stalled`,
    body: `${one ? 'It' : 'Each'} sat idle three times with nothing pending, after Helm woke its driver and told the director.\n${stalled.map((t) => `- [[${t.id}]]: ${clip(t.status_summary || 'no status', 200)}`).join('\n')}\n\nResume wakes its driver again; Drop drops it.`,
    options: stalled.flatMap((t) => (one ? [{ label: 'Resume' }, { label: 'Drop' }] : [{ label: `Resume: ${clip(t.title, 60)}` }, { label: `Drop: ${clip(t.title, 60)}` }])),
    payload: { watchdog_stalls: stalled.map((t) => ({ id: t.id, title: clip(t.title, 60) })) },
    importance: Math.max(3, ...stalled.map((t) => Number(t.importance ?? 3))),
    blocking: false,
    task: stalled[0],
  });
  run(`UPDATE task_watch SET stall_asked = 1 WHERE task_id IN (${ids.map(() => '?').join(',')})`, ...ids);
}

/**
 * The user answered the stalled request (answers.ts): "Resume" / "Drop" (one task) or "Resume: <title>" / "Drop: <title>".
 * Resume clears the mark and wakes the driver, Drop drops the task; the others listed are asked again in a new request.
 */
export function onWatchdogAnswer(item: Row, choice: string | undefined) {
  const list: Row[] = JSON.parse(item.payload || '{}').watchdog_stalls ?? [];
  if (!list.length || !choice) return;
  const m = /^(Resume|Drop)(?::\s*(.*))?$/.exec(choice.trim());
  const hit = m && (list.length === 1 && !m[2] ? list[0] : list.find((x) => x.title === m[2]));
  const others = list.filter((x) => x !== hit).map((x) => x.id);
  if (others.length) run(`UPDATE task_watch SET stall_asked = 0 WHERE task_id IN (${others.map(() => '?').join(',')})`, ...others);
  const t = hit ? getTask(hit.id) : undefined;
  if (t && t.state === 'active') {
    if (m![1] === 'Drop') setTaskState(t, 'dropped', USER, 'dropped after the watchdog marked it Stalled.');
    else {
      run('UPDATE task_watch SET stalled_at = NULL, stall_user = 0, stall_asked = 0, strikes = 0, strike_at = ?, idle_since = NULL WHERE task_id = ?', now(), t.id);
      if (t.driver_agent_id) void hooks.send(t.driver_agent_id, `<helm-note kind="watchdog">The user resumed [[${t.id}]] after it stalled. Carry on, finish with complete_task, or ask the user (ask_user) what you wait on.</helm-note>`, SYSTEM).catch(() => {});
    }
  }
  syncStallRequest(item.project_id);
  touchProject(item.project_id);
}

/** The Work row's mark: "Stalled: …" while marked, else null. Read-only. */
export function stalledLine(taskId: string): string | null {
  const r = get('SELECT stalled_at FROM task_watch WHERE task_id = ?', taskId);
  return r?.stalled_at != null ? 'Stalled: idle with nothing pending' : null;
}

/** The between-turn time a task spent idle with nothing pending, waiting on a request, and busy on commands (ms). */
export function idleSplit(taskId: string): { idle_none_ms: number | null; idle_request_ms: number | null; idle_busy_ms: number | null } {
  const r = get('SELECT idle_ms, waiting_ms, busy_ms FROM task_watch WHERE task_id = ?', taskId);
  return r ? { idle_none_ms: Number(r.idle_ms), idle_request_ms: Number(r.waiting_ms), idle_busy_ms: Number(r.busy_ms) } : { idle_none_ms: null, idle_request_ms: null, idle_busy_ms: null };
}

// ---------- waiting on the user at the end of a turn ----------

export const WAIT_TAG = '<helm-note kind="waiting">';

/** Phrases that say the writer waits on the reader, beyond userasks.ts: "tell me", "let me know", "your call", "once you…", a question to them. */
const EXTRA = [
  /\b(?:let me know|tell me)\b/i,
  /\byour call\b/i,
  /\bonce you(?:'ve| have)?\s+\w+/i,
  /\b(?:waiting|wait|waits)\s+(?:for|on)\s+(?:you|your|the user)\b/i,
];
/** A question to the reader: ends with "?" and is addressed to them. */
const QUESTION = /\b(?:you|your|should I|shall I|want me|do I|which)\b[^?]*\?\s*$/i;
const NOT_WAITING = /\b(?:nothing|no action|no input|no decision)\b[^.]{0,30}\b(?:needed|required|from you|from the user)\b|\b(?:don't|do not|no need to)\b[^.]{0,20}\b(?:reply|answer|tell me|let me know)\b/i;

/** The first sentence of `text` that says the writer waits on the user, or null. */
export function waitingSentence(text: string): string | null {
  for (const s of sentences(String(text ?? ''))) {
    const plain = s.replace(/`([^`]*)`/g, '$1').replace(/[*_]{1,2}/g, '');
    if (NOT_WAITING.test(plain)) continue;
    if (isUserAsk(plain) || EXTRA.some((p) => p.test(plain)) || QUESTION.test(plain)) return s.length > 300 ? `${s.slice(0, 297)}...` : s;
  }
  return null;
}

/** The Active task an agent's turn is about and drives: a builder's own task, or one the director drives. */
export function drivenTask(agent: Row, aboutTask: string | null = null): Row | null {
  if (agent.parent_id) {
    return get("SELECT * FROM tasks WHERE kind = 'task' AND state = 'active' AND (driver_agent_id = ? OR id = ?) ORDER BY started_at LIMIT 1", agent.id, agent.task_id ?? '') ?? null;
  }
  if (!aboutTask) return null;
  return get("SELECT * FROM tasks WHERE id = ? AND kind = 'task' AND state = 'active' AND driver_agent_id = ?", aboutTask, agent.id) ?? null;
}

/** What it said this turn that the user reads as waiting: its final text, and the status line or summary it set. */
function turnText(agent: Row, t: Row, text: string, since: number): string {
  const parts = [text];
  if (Number(agent.status_at ?? 0) >= since && agent.status_line) parts.push(String(agent.status_line));
  if (Number(t.summary_at ?? 0) >= since && t.status_summary) parts.push(String(t.status_summary));
  return parts.join('\n\n');
}

/** Last sentence noted per agent, for filing it if the next turn still ends without a request (in memory; the note carries it too). */
const noted = new Map<string, { sentence: string; text: string; taskId: string }>();

/**
 * A finished turn of a builder or the director (runtime.ts, ok, not stopped, not finishing): `resultId` is its result
 * event, `aboutTask` the task a director's turn was about. Returns the re-prompt to send now (the agent stays working),
 * or null. On the turn answering a re-prompt, with still no request open, Helm files the question itself.
 */
export function waitingTurn(agent: Row, text: string, resultId: number, aboutTask: string | null = null): string | null {
  const t = drivenTask(agent, aboutTask);
  const inbound = turnInbound(agent.id, resultId);
  const since = Number(get("SELECT ts FROM events WHERE agent_id = ? AND kind = 'result' AND id < ? ORDER BY id DESC LIMIT 1", agent.id, resultId)?.ts ?? inbound[0]?.ts ?? 0);
  const prompted = inbound.some((e) => String(e.data?.text ?? '').startsWith(WAIT_TAG));
  const prev = noted.get(agent.id);
  if (!t) {
    noted.delete(agent.id);
    return null;
  }
  const hasRequest = !!get(`SELECT 1 AS x FROM inbox WHERE task_id = ? AND status IN ('open', 'held') AND kind IN ('question', 'action') LIMIT 1`, t.id)
    || !!get("SELECT 1 AS x FROM inbox WHERE agent_id = ? AND kind IN ('question', 'action') AND created_at >= ? LIMIT 1", agent.id, since);
  const said = waitingSentence(turnText(agent, t, text, since));
  if (prompted) {
    noted.delete(agent.id);
    if (hasRequest || NOT_WAITING.test(text)) return null;
    // The sentence it was asked about: from memory, or (after a restart) from the note it answered.
    const quoted = inbound.map((e) => /waiting on the user \("([\s\S]*?)"\), but no request/.exec(String(e.data?.text ?? ''))?.[1]).find(Boolean) ?? null;
    const sentence = said ?? (prev && prev.taskId === t.id ? prev.sentence : quoted);
    if (!sentence) return null;
    fileForAgent(agent, t, sentence, said ? text : prev?.text ?? text);
    return null;
  }
  if (!said || hasRequest) {
    noted.delete(agent.id);
    return null;
  }
  noted.set(agent.id, { sentence: said, text, taskId: t.id });
  return (
    `${WAIT_TAG}You ended your turn waiting on the user ("${said}"), but no request is open on [[${t.id}]], so the user will not see it. ` +
    `File it now with ask_user (task: ${t.id}): a question with options for a decision, kind "action" with steps for something to do outside Helm. ` +
    `If nothing is needed from the user, say so in one line and carry on. If this turn ends without one, Helm files it from your text.</helm-note>`
  );
}

/** Helm files the question an agent left in prose, on its task, marked as filed by Helm. */
function fileForAgent(agent: Row, t: Row, sentence: string, text: string) {
  createRequest({
    projectId: t.project_id,
    agentId: null,
    kind: 'question',
    title: clip(sentence.replace(/^[-*\s]+/, ''), 110),
    body: `Filed by Helm: ${agent.name} ended its turn waiting on you without filing a request. It wrote:\n\n${String(text).trim().slice(0, 1500).split('\n').map((l) => `> ${l}`).join('\n')}`,
    payload: { filed_by_helm: true, for_agent: agent.id },
    importance: Math.max(3, Number(t.importance ?? 3)),
    blocking: false,
    task: t,
  });
  addTaskMessage(t, HELM, `${agent.name} ended its turn waiting on the user without a request; Helm filed it.`, 'state');
}

// ---------- the timer (runner) ----------

let timer: NodeJS.Timeout | null = null;
let running = false;
export async function watchdogTick(at = now()) {
  if (running) return;
  running = true;
  try {
    for (const p of all('SELECT id FROM projects WHERE archived = 0')) await watchProject(p.id, at).catch((err) => console.error('Watchdog failed:', err));
  } finally {
    running = false;
  }
}
export function startWatchdog() {
  timer = setInterval(() => void watchdogTick(), TICK_MS);
}
export function stopWatchdog() {
  if (timer) clearInterval(timer);
  timer = null;
}
