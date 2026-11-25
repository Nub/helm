import { all, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { interruptAgent, rootAgent, sendToAgent } from './agents.ts';
import type { Sender } from './agents.ts';
import { createRequest } from './requests.ts';
import { getSetting } from './settings.ts';
import { isStopped } from './projectmode.ts';
import { activeMs as activeTime, addTaskMessage, getTask, setTaskState, USER } from './tasks.ts';
import { taskTimes } from './worktime.ts';
import { taskTokens, taskWork, workTotal } from './usage.ts';
import { clockText } from './clock.ts';
import { touchProject } from './store.ts';

/**
 * Progress checks: Helm weighs each Active task's progress against the time and tokens spent on it, so agents do not
 * spin in loops unnoticed. Runner side: a timer (startProgressChecks) computes flags per task. A flag never changes the
 * tier. The first flag on a task stops its agents and marks it Re-planning: the director is woken (builder mode too)
 * and must record a new plan with replan_task, which restarts the work with a fresh allowance. The second flag (or no
 * re-plan within REPLAN_MS) is an error: Helm pauses the task and asks the user (Resume once more / Narrow it with the
 * director / Drop). The count (task_progress.strikes) survives re-plans; only the user's Resume resets it.
 *
 * Everything is measured from the task's allowance (task_progress.base_*): it starts when the check first sees the
 * task Active and again after a re-plan or a resume. Tokens are work tokens (usage.ts): new input, output and the
 * subagents' work; cache reads and re-writes of context a session already held are excluded, so a long builder session
 * re-reading its context is not taken for a task spending. The setting "progress_checks" (Setup) turns all of it off;
 * list_progress works either way.
 */

/** Minutes of active time without a worklist item done, at Medium importance, before a task is flagged. */
export const STALL_MIN = 60;
/** Review rounds answered "changes needed", at Medium importance. */
export const REVIEW_ROUNDS = 3;
/** Work tokens above this many times the median of the project's finished tasks of the same importance. */
export const TOKEN_FACTOR = 3;
/** At least this many finished tasks of that importance before the median is used; else TOKEN_FLOOR. */
export const MEDIAN_MIN_SAMPLES = 3;
/** Work tokens flagged at Medium importance when there is no median to compare with. */
export const TOKEN_FLOOR = 3_000_000;
/** Failed turns (agent errors on its agents) since the last progress. */
export const ERROR_REPEATS = 3;
/** The director has this long after a first flag to record a re-plan; past it, the flag counts as the second. */
export const REPLAN_MS = 30 * 60_000;
/** How often the runner checks. */
export const CHECK_MS = 2 * 60_000;

/** High-value work earns more time, tokens and rounds. */
export const IMPORTANCE_SCALE: Record<number, number> = { 1: 0.5, 2: 0.75, 3: 1, 4: 1.5, 5: 2 };
/** Time measured is work time (worktime.ts): never time the task waited on the user; its Active time where unknown. */
const activeMs = (t: Row, at: number) => taskTimes(t, at).workMs ?? activeTime(t, at);
const scaleOf = (importance: number) => IMPORTANCE_SCALE[importance] ?? 1;

export type Metrics = {
  importance: number;
  /** Active time since the allowance started (ms). */
  activeMs: number;
  /** Active time since the last worklist item was done (ms). */
  stillMs: number;
  /** Work tokens since the allowance started (usage.ts), and their parts. */
  tokens: number;
  work?: Work;
  rounds: number;
  errors: number;
  /** The project's median work tokens for finished tasks of this importance, or null. */
  median: number | null;
  /** Something is asked of the user on the task, or a background command of it runs: no movement is expected meanwhile. */
  waitingOnUser: boolean;
};
export type Work = { input: number; output: number; subagents: number };
export type Flag = { key: 'stalled' | 'rounds' | 'tokens' | 'errors'; text: string };

export function limits(importance: number, median: number | null) {
  const s = scaleOf(importance);
  return {
    stallMs: STALL_MIN * s * 60_000,
    rounds: Math.max(2, Math.round(REVIEW_ROUNDS * s)),
    tokens: median != null ? median * TOKEN_FACTOR : TOKEN_FLOOR * s,
    errors: ERROR_REPEATS,
  };
}

const mins = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};
export const tokensText = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Which parts the work tokens are: new input, output, subagents (parts with none left out). */
export const partsText = (w: Work) =>
  ([[w.input, 'new input'], [w.output, 'output'], [w.subagents, 'subagents']] as const).filter(([n]) => n > 0).map(([n, k]) => `${k} ${tokensText(n)}`).join(', ');

/** The flags a task's figures earn. Pure. */
export function flagsFor(m: Metrics): Flag[] {
  const l = limits(m.importance, m.median);
  const out: Flag[] = [];
  if (!m.waitingOnUser && m.stillMs >= l.stallMs) out.push({ key: 'stalled', text: `no worklist item done in ${mins(m.stillMs)} of active time` });
  if (m.rounds >= l.rounds) out.push({ key: 'rounds', text: `${m.rounds} review rounds with changes needed` });
  if (m.tokens >= l.tokens) {
    const vs = m.median != null ? ` vs median ${tokensText(Math.round(m.median))} (${(m.tokens / m.median).toFixed(1)}×) of finished tasks at this importance` : ', far above the usual';
    out.push({ key: 'tokens', text: `work tokens ${tokensText(m.tokens)}${m.work ? ` (${partsText(m.work)})` : ''}${vs}` });
  }
  if (m.errors >= l.errors) out.push({ key: 'errors', text: `${m.errors} failed turns since the last progress` });
  return out;
}

/** How the check reaches agents: the agents facade (server/agents.ts); tests replace it. */
let hooks = {
  send: (agentId: string, text: string, from: Sender) => sendToAgent(agentId, text, from),
  interrupt: (agentId: string) => interruptAgent(agentId),
};
export function setProgressHooks(h: typeof hooks) {
  hooks = h;
}

// ---------- reading a task's figures ----------

/** The task's check row, created (allowance starting now) the first time it is seen. */
function stateOf(t: Row, at: number): Row {
  const row = get('SELECT * FROM task_progress WHERE task_id = ?', t.id);
  if (row) return row;
  const done = doneCount(t);
  run(
    'INSERT OR IGNORE INTO task_progress (task_id, project_id, base_at, base_ms, base_tokens, done_seen, moved_at, moved_ms, noted, flag_text, hard_at, base_work_in, base_work_out, base_work_sub) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)',
    t.id, t.project_id, at, activeMs(t, at), taskTokens(t.id), done, at, activeMs(t, at), '[]', '', ...baseWork(t.id),
  );
  return get('SELECT * FROM task_progress WHERE task_id = ?', t.id)!;
}

/** Start a fresh allowance: flags cleared, time and tokens measured from now. The flag count (strikes) is kept. */
export function resetAllowance(t: Row, at = now()) {
  const row = stateOf(t, at);
  const act = activeMs(t, at);
  run(
    "UPDATE task_progress SET base_at = ?, base_ms = ?, base_tokens = ?, done_seen = ?, moved_at = ?, moved_ms = ?, noted = '[]', flag_text = '', replan_due = NULL, base_work_in = ?, base_work_out = ?, base_work_sub = ? WHERE task_id = ?",
    at, act, taskTokens(t.id), doneCount(t), at, act, ...baseWork(t.id), row.task_id,
  );
}
const baseWork = (taskId: string) => {
  const w = taskWork(taskId);
  return [w.input, w.output, w.subagents];
};
/** The work tokens spent since the allowance started, by part. */
function workSince(t: Row, row: Row): Work {
  const w = taskWork(t.id);
  return { input: Math.max(0, w.input - row.base_work_in), output: Math.max(0, w.output - row.base_work_out), subagents: Math.max(0, w.subagents - row.base_work_sub) };
}

export const agentsOn = (t: Row) => all("SELECT * FROM agents WHERE (id = ? OR task_id = ?) AND status != 'closed' AND role_id != 'subagent'", t.driver_agent_id ?? '', t.id);
export function doneCount(t: Row): number {
  return Number(get("SELECT COUNT(*) AS n FROM checklist WHERE state = 'done' AND agent_id IN (SELECT id FROM agents WHERE id = ? OR task_id = ?)", t.driver_agent_id ?? '', t.id)?.n ?? 0);
}

/**
 * Median work tokens of the project's finished tasks of an importance, or null with too few. Counted as the allowance
 * is (usage.ts taskWork). Tasks recorded before the split (their tokens in full: a higher median, never a false flag)
 * count only while fewer than MEDIAN_MIN_SAMPLES finished tasks have it throughout.
 */
export function medianTokens(projectId: string, importance: number): number | null {
  const ws = all("SELECT id FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'done' AND importance = ?", projectId, importance)
    .map((r) => taskWork(r.id))
    .filter((w) => workTotal(w) > 0);
  const full = ws.filter((w) => w.full);
  const xs = (full.length >= MEDIAN_MIN_SAMPLES ? full : ws).map(workTotal).sort((a, b) => a - b);
  if (xs.length < MEDIAN_MIN_SAMPLES) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** Tool calls that are work moving: a file written or edited, or a commit (the agent's own Bash call). */
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const COMMIT_RE = /\bgit\b[^|;&]*\b(commit|merge|cherry-pick|rebase)\b/;

/** Whether the task's agents (their subagents included) edited a file or committed after `since`. Read-only. */
export function workMoved(t: Row, since: number): boolean {
  const ids = [...agentsOn(t).map((a) => a.id), ...all("SELECT id FROM agents WHERE task_id = ? AND role_id = 'subagent'", t.id).map((a) => a.id)];
  if (!ids.length) return false;
  const ph = ids.map(() => '?').join(',');
  const edits = EDIT_TOOLS.map(() => '?').join(',');
  if (get(`SELECT 1 AS x FROM events WHERE agent_id IN (${ph}) AND kind = 'tool' AND ts > ? AND json_extract(data, '$.name') IN (${edits}) LIMIT 1`, ...ids, since, ...EDIT_TOOLS)) return true;
  return all(`SELECT json_extract(data, '$.input') AS input, json_extract(data, '$.summary') AS summary FROM events WHERE agent_id IN (${ph}) AND kind = 'tool' AND ts > ? AND json_extract(data, '$.name') = 'Bash'`, ...ids, since)
    .some((e) => COMMIT_RE.test(String(e.input ?? e.summary ?? '')));
}

/**
 * Bring the row up to date and read the figures. Movement (what clears "stalled"): a worklist item done, a file edited
 * or a commit by the task's agents, or a background command of the task running.
 */
function measure(t: Row, at: number): { row: Row; m: Metrics } {
  let row = stateOf(t, at);
  if (row.base_work_in == null) {
    // A row from before work tokens: the token part of its allowance starts now.
    const [i, o, s] = baseWork(t.id);
    run('UPDATE task_progress SET base_work_in = ?, base_work_out = ?, base_work_sub = ? WHERE task_id = ?', i, o, s, t.id);
    row = { ...row, base_work_in: i, base_work_out: o, base_work_sub: s };
  }
  const done = doneCount(t);
  const act = activeMs(t, at);
  // A command of the task running in the background: the agent is waiting on it, which is not being stuck. The stall
  // clock starts again when it ends (commands.ts).
  const waitingOnCommand = !!get('SELECT 1 AS x FROM running_commands WHERE task_id = ? AND background = 1 AND ended_at IS NULL AND started_at > ? LIMIT 1', t.id, at - 2 * 3600_000);
  if (done > row.done_seen || waitingOnCommand || workMoved(t, Math.max(row.moved_at, row.base_at))) {
    const seen = Math.max(done, row.done_seen);
    run('UPDATE task_progress SET done_seen = ?, moved_at = ?, moved_ms = ? WHERE task_id = ?', seen, at, act, t.id);
    row = { ...row, done_seen: seen, moved_at: at, moved_ms: act };
  } else if (done < row.done_seen) {
    run('UPDATE task_progress SET done_seen = ? WHERE task_id = ?', done, t.id); // a new worklist: not progress by itself
  }
  const since = Math.max(row.moved_at, row.base_at);
  const agentIds = agentsOn(t).map((a) => a.id);
  const ph = agentIds.map(() => '?').join(',') || "''";
  const errors = all(`SELECT payload FROM inbox WHERE kind = 'agent_error' AND agent_id IN (${ph}) AND created_at >= ?`, ...agentIds, since)
    .reduce((n, r) => n + (Number(JSON.parse(r.payload || '{}').count) || 1), 0);
  const work = workSince(t, row);
  const m: Metrics = {
    importance: t.importance ?? 3,
    activeMs: Math.max(0, act - row.base_ms),
    stillMs: Math.max(0, act - Math.max(row.moved_ms, row.base_ms)),
    tokens: workTotal(work),
    work,
    rounds: Number(get("SELECT COUNT(*) AS n FROM consults WHERE task_id = ? AND kind = 'review' AND verdict = 'changes_needed' AND answered_at >= ?", t.id, row.base_at)?.n ?? 0),
    errors,
    median: medianTokens(t.project_id, t.importance ?? 3),
    waitingOnUser: waitingOnCommand || !!get("SELECT 1 AS x FROM inbox WHERE task_id = ? AND status = 'open' AND kind IN ('question', 'action', 'agent_error') LIMIT 1", t.id),
  };
  return { row, m };
}

const activeTasks = (projectId: string) =>
  all("SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'active' AND review_since IS NULL ORDER BY importance DESC, position", projectId);

export type ProgressLine = { task: Row; m: Metrics; flags: Flag[] };

/** Every Active task's figures and flags. Brings the check rows up to date. */
export function progressLines(projectId: string, at = now()): ProgressLine[] {
  return activeTasks(projectId).map((t) => {
    const { m } = measure(t, at);
    return { task: t, m, flags: flagsFor(m) };
  });
}

const LEVEL = ['', 'Minor', 'Low', 'Medium', 'High', 'Critical'];
/** The table the director reads (list_progress and the note). */
export function progressTable(lines: ProgressLine[]): string {
  const head = '| Task | Active | Work tokens | Importance | Flags |\n|---|---|---|---|---|';
  return [head, ...lines.map(({ task, m, flags }) => `| [[${task.id}]] | ${mins(m.activeMs)} | ${tokensText(m.tokens)} | ${LEVEL[m.importance] ?? m.importance} | ${flags.map((f) => f.text).join('; ') || '-'} |`)].join('\n');
}

// ---------- the check ----------

const HELM = { author: 'system' as const, name: 'Helm' };

/** One pass over a project: a first flag stops the work for a re-plan, a second pauses it for the user. */
export async function checkProject(projectId: string, at = now()) {
  if (!getSetting(projectId, 'progress_checks') || isStopped(projectId)) return;
  // A task resumed from Paused since its allowance started (by the user, or the director that paused it) starts afresh.
  for (const r of all(
    "SELECT p.task_id FROM task_progress p JOIN tasks t ON t.id = p.task_id WHERE p.project_id = ? AND t.state = 'active' AND EXISTS (SELECT 1 FROM task_states s WHERE s.task_id = p.task_id AND s.from_state = 'paused' AND s.state = 'active' AND s.at > p.base_at)",
    projectId,
  )) resetAllowance(getTask(r.task_id)!, at);
  for (const line of progressLines(projectId, at)) {
    const t = line.task;
    const row = get('SELECT * FROM task_progress WHERE task_id = ?', t.id)!;
    if (row.replan_due != null) {
      // Waiting for the director's re-plan: past the deadline it is the second flag; until then nothing works on it.
      if (at >= row.replan_due) await errorPause(line, row, at, `no re-plan within ${mins(REPLAN_MS)} of the first flag`);
      else await stopAgents(t);
      continue;
    }
    const noted: string[] = JSON.parse(row.noted || '[]');
    const keys = line.flags.map((f) => f.key);
    const text = line.flags.map((f) => f.text).join('; ');
    // A flag that cleared (the worklist moved) may count again later.
    const kept = noted.filter((k) => keys.includes(k as Flag['key']));
    const added = keys.filter((k) => !noted.includes(k));
    if (added.length || kept.length !== noted.length || text !== row.flag_text) {
      run('UPDATE task_progress SET noted = ?, flag_text = ? WHERE task_id = ?', JSON.stringify([...kept, ...added]), text, t.id);
      touchProject(projectId);
    }
    if (!added.length) continue;
    const why = line.flags.filter((f) => added.includes(f.key)).map((f) => f.text).join('; ');
    if (Number(row.strikes) >= 1) await errorPause(line, row, at, why);
    else await firstFlag(line, at, why);
  }
}

/** The task's agents other than the director: what the check stops. */
async function stopAgents(t: Row) {
  const root = rootAgent(get('SELECT * FROM projects WHERE id = ?', t.project_id)!);
  for (const a of agentsOn(t)) if (a.id !== root.id && a.status === 'working') await hooks.interrupt(a.id).catch(() => {});
}

/** The last few things the task's driver did, for the director's note. */
function lastActions(t: Row): string {
  if (!t.driver_agent_id) return '';
  const xs = all("SELECT data FROM events WHERE agent_id = ? AND kind = 'tool' ORDER BY id DESC LIMIT 5", t.driver_agent_id).reverse().map((e) => {
    try {
      const d = JSON.parse(e.data);
      return `- ${d.name}: ${String(d.summary ?? '').slice(0, 120)}`;
    } catch {
      return '';
    }
  }).filter(Boolean);
  return xs.length ? `\nIts last actions:\n${xs.join('\n')}` : '';
}

/** The first flag: stop the agents, mark it Re-planning, and wake the director (in builder mode too). */
async function firstFlag(line: ProgressLine, at: number, why: string) {
  const t = line.task;
  tx(() => {
    run('UPDATE task_progress SET strikes = 1, flags_total = flags_total + 1, first_flag = ?, replan_due = ? WHERE task_id = ?', why, at + REPLAN_MS, t.id);
    addTaskMessage(t, HELM, `Progress check: ${why}. Helm stopped its agents; the director re-plans it before work resumes.`);
  });
  touchProject(t.project_id);
  await stopAgents(t);
  const project = get('SELECT * FROM projects WHERE id = ?', t.project_id);
  if (!project) return;
  const text =
    `Progress check: Helm stopped the work on [[${t.id}]] (${why}) after ${mins(line.m.activeMs)} and ${tokensText(line.m.tokens)} work tokens.\n${progressTable([line])}${lastActions(t)}\n` +
    `Look at what went wrong, then record a new plan with replan_task (what was wrong, the new approach, a narrower scope or a split if needed): it restarts the work with that plan. ` +
    `Nothing resumes until you do. A second flag on this task, or no re-plan by ${clockText(at + REPLAN_MS)}, pauses it and alerts the user.`;
  await hooks.send(rootAgent(project).id, `<helm-note kind="progress">${text}</helm-note>`, { kind: 'system', name: 'Helm' }).catch(() => {});
}

/** The second flag: an error. The task is paused, its agents stopped, and the user asked once, with a notification. */
async function errorPause({ task }: ProgressLine, row: Row, at: number, why: string) {
  const t = getTask(task.id);
  if (!t || t.state !== 'active') return;
  run('UPDATE task_progress SET strikes = strikes + 1, flags_total = flags_total + 1, replan_due = NULL, hard_at = ? WHERE task_id = ?', at, t.id);
  setTaskState(t, 'paused', HELM, `progress check, second flag: ${why}.`);
  const root = rootAgent(get('SELECT * FROM projects WHERE id = ?', t.project_id)!);
  for (const a of agentsOn(t)) if (a.id !== root.id && ['working', 'waiting'].includes(a.status)) await hooks.interrupt(a.id).catch(() => {});
  const total = `${mins(activeMs(t, at))} and ${tokensText(taskTokens(t.id))} tokens in total`;
  const body = [
    `Helm stopped "${t.title}" a second time and paused it.`,
    `- First flag: ${row.first_flag || 'unknown'}`,
    `- Re-plan: ${row.replan_note || 'none recorded'}`,
    `- Second flag: ${why}`,
    `- Spent: ${total}`,
    `Resume gives it one more fresh allowance and resets the count.`,
  ].join('\n');
  createRequest({
    projectId: t.project_id,
    agentId: null,
    kind: 'question',
    title: `Stopped twice: ${t.title}`,
    body,
    options: [{ label: 'Resume once more' }, { label: 'Narrow it with the director' }, { label: 'Drop' }],
    payload: { progress_pause: t.id },
    importance: Math.max(4, t.importance ?? 3),
    blocking: true,
    task: t,
  });
  await hooks.send(root.id, `<helm-note kind="progress">Helm paused [[${t.id}]] after a second progress flag (${why}; ${total}) and asked the user what to do. Leave it paused until they answer.</helm-note>`, { kind: 'system', name: 'Helm' }).catch(() => {});
}

/**
 * The user answered the second-flag request (answers.ts): Resume makes it Active again with a fresh allowance and
 * resets the count, Drop drops it, Narrow leaves it paused for the director. The answer then reaches the director.
 */
export function onProgressAnswer(item: Row, choice: string | undefined) {
  const taskId = JSON.parse(item.payload || '{}').progress_pause;
  const t = taskId ? getTask(taskId) : undefined;
  if (!t || t.state !== 'paused') return;
  if (choice === 'Resume once more' || choice === 'Resume') {
    setTaskState(t, 'active', USER, 'resumed after the progress check.');
    resetAllowance(getTask(t.id)!);
    run("UPDATE task_progress SET strikes = 0, first_flag = '', replan_note = '' WHERE task_id = ?", t.id);
  } else if (choice === 'Drop') setTaskState(t, 'dropped', USER, 'dropped after the progress check.');
}

/**
 * The director's re-plan after a first flag (replan_task): recorded in the thread, the allowance starts again, and
 * the task's driver is restarted with the plan. Refused unless the task is waiting for one.
 */
export async function replanTask(t: Row, by: { name: string; id: string }, plan: { wrong: string; approach: string; scope?: string }): Promise<string | null> {
  const row = get('SELECT * FROM task_progress WHERE task_id = ?', t.id);
  if (!row || row.replan_due == null) return `[[${t.id}]] is not waiting for a re-plan: replan_task follows a progress check's first flag.`;
  const lines = [`What was wrong: ${plan.wrong}`, `New approach: ${plan.approach}`, ...(plan.scope ? [`Scope: ${plan.scope}`] : [])];
  tx(() => {
    addTaskMessage(t, { author: 'director', name: by.name, id: by.id }, `Re-plan after the progress check.\n${lines.map((l) => `- ${l}`).join('\n')}`);
    resetAllowance(t);
    run('UPDATE task_progress SET replans_total = replans_total + 1, replan_note = ? WHERE task_id = ?', `${plan.approach}${plan.scope ? ` (scope: ${plan.scope})` : ''}`.slice(0, 600), t.id);
  });
  touchProject(t.project_id);
  const driver = t.driver_agent_id ? get("SELECT * FROM agents WHERE id = ? AND status != 'closed'", t.driver_agent_id) : undefined;
  if (driver && driver.id !== by.id) {
    await hooks.send(driver.id, `<helm-note kind="progress">The progress check stopped your work on [[${t.id}]]; the director re-planned it. Start again from this plan:\n${lines.join('\n')}</helm-note>`, { kind: 'system', name: 'Helm' }).catch(() => {});
  }
  return null;
}

/**
 * What a task row shows: Re-planning while the director owes a plan, why it is flagged, "Re-planned once" after a
 * re-plan, or null (also with the setting off, so no stale marker stays). Read-only.
 */
export function checkLine(t: Row): string | null {
  if (t.kind !== 'task' || !['active', 'paused'].includes(t.state) || !getSetting(t.project_id, 'progress_checks')) return null;
  // Marked Stalled by the watchdog (watchdog.ts): idle three times with nothing pending, the user asked.
  if (t.state === 'active' && get('SELECT stalled_at FROM task_watch WHERE task_id = ? AND stalled_at IS NOT NULL', t.id)) return 'Stalled: idle with nothing pending';
  const r = get('SELECT flag_text, strikes, replan_due FROM task_progress WHERE task_id = ?', t.id);
  if (!r) return null;
  if (r.replan_due != null) return `Re-planning: ${r.flag_text}`;
  const parts = [r.strikes > 0 ? 'Re-planned once' : '', String(r.flag_text || '')].filter(Boolean);
  return parts.length ? parts.join('; ') : null;
}

// ---------- the timer (runner) ----------

let timer: NodeJS.Timeout | null = null;
let busy = false;
export async function progressTick(at = now()) {
  if (busy) return;
  busy = true;
  try {
    for (const p of all('SELECT id FROM projects WHERE archived = 0')) await checkProject(p.id, at).catch((err) => console.error('Progress check failed:', err));
  } finally {
    busy = false;
  }
}
export function startProgressChecks() {
  timer = setInterval(() => void progressTick(), CHECK_MS);
}
export function stopProgressChecks() {
  if (timer) clearInterval(timer);
  timer = null;
}
