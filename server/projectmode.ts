import { all, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { addJournal, getAgent, getProject, touchProject } from './store.ts';
import { withBusy } from './busy.ts';
import { clockText } from './clock.ts';
import { notify } from './notify.ts';
import { interruptAgent, rootAgent, sendToAgent } from './agents.ts';

/**
 * A project's mode: whether Helm lets work start in it. Only the user changes it (the API); agents are told and the
 * server enforces it, never the prompt alone.
 *
 * The user picks one of four modes, from most to least automatic (the pill's menu and Setup, both through the API):
 * - running (Autopilot): when the queue is empty, the director schedules the next Waiting task itself.
 * - queue_only (Queue only; the default for new projects): Scheduled tasks run in order, including ones the user
 *   schedules later, but nothing Waiting, Planning or Paused is scheduled or started by the director or Helm, unless
 *   the user's own message in that turn asked for that task. When the queue empties the user is told once.
 * - winding_down (Finish up): what is Active finishes; nothing new starts. No task moves to Active or Scheduled except by the user,
 *   agents are spawned only for an Active task, the director creates only Planning proposals, and Helm's own
 *   "take the next task" nudges, away-mode scheduling, starting work from Act-mode reports and scheduled resumes of
 *   errored agents are held. When nothing is Active and no agent is working it becomes at_rest by itself.
 * - at_rest: a finished Finish up (shown as Finish up, at rest). Same rules; the user was told once and the director wrote a close-out.
 * - stopped (Stopped): every agent was interrupted. No turn starts except the director answering the user's own messages, and
 *   in those turns the tools that start, resume, message or spawn agents, make tasks Active or start background
 *   work are refused. Messages meant for agents are held (held_messages) and delivered on resume.
 *
 * Everything here is database state, so either Helm process may read or change it; what touches running agents
 * (interrupting, sending) goes through the hooks the runtime sets.
 */

export const MODES = ['running', 'queue_only', 'winding_down', 'at_rest', 'stopped'] as const;
export type Mode = (typeof MODES)[number];
export const MODE_LABEL: Record<Mode, string> = { running: 'Autopilot', queue_only: 'Queue only', winding_down: 'Finish up', at_rest: 'Finish up', stopped: 'Stopped' };
/** The four the user chooses from, most automatic first, with the line under each name (the menu and Setup). */
export const MODE_CHOICES = [
  { mode: 'running', label: 'Autopilot', line: 'When the queue empties, the director schedules the next waiting task.' },
  { mode: 'queue_only', label: 'Queue only', line: 'Scheduled tasks run in order. Nothing else is scheduled for you.' },
  { mode: 'winding_down', label: 'Finish up', line: 'What runs finishes. Nothing new starts, not even scheduled tasks.' },
  { mode: 'stopped', label: 'Stopped', line: 'Every agent is interrupted now. Resumable.' },
] as const;
export type ChoiceMode = (typeof MODE_CHOICES)[number]['mode'];
/** New projects start in Queue only (api.ts); a project without a mode column value reads as running. */
export const DEFAULT_MODE: Mode = 'queue_only';

type Sender = { kind: 'agent' | 'user' | 'system'; name: string };
type Hooks = {
  send: (agentId: string, text: string, from: Sender) => Promise<void>;
  interrupt: (agentId: string) => Promise<void>;
  root: (project: Row) => Row;
};
/**
 * How a mode change reaches agents: the agents facade (server/agents.ts), which in the runner (or one process) is the
 * runtime and in the web service hands each message or stop to the runner as a command. Tests replace it; null records
 * the change and sends nothing.
 */
let hooks: Hooks | null = {
  send: (agentId, text, from) => sendToAgent(agentId, text, from),
  interrupt: (agentId) => interruptAgent(agentId),
  root: (project) => rootAgent(project),
};
export function setProjectModeHooks(h: Hooks | null) {
  hooks = h;
}

const modeRow = (projectId: string): Row | undefined => get('SELECT id, name, mode, mode_since, mode_note, mode_data FROM projects WHERE id = ?', projectId);
export function modeOf(projectId: string): Mode {
  const m = modeRow(projectId)?.mode;
  return (MODES as readonly string[]).includes(m) ? (m as Mode) : 'running';
}
const dataOf = (p: Row | undefined): Row => {
  try {
    return JSON.parse(p?.mode_data || '{}');
  } catch {
    return {};
  }
};
/** Nothing new starts, Scheduled tasks included: finishing up, at rest or stopped. */
export const holdsNewWork = (projectId: string) => !['running', 'queue_only'].includes(modeOf(projectId));
/** The director (and Helm's nudges) may schedule Waiting tasks by themselves: Autopilot only. */
export const autoSchedules = (projectId: string) => modeOf(projectId) === 'running';
export const isStopped = (projectId: string) => modeOf(projectId) === 'stopped';
/** For "The project is …": "on Autopilot", "in Queue only", "finishing up", "at rest", "stopped". */
const WORDS: Record<Mode, string> = { running: 'on Autopilot', queue_only: 'in Queue only', winding_down: 'finishing up', at_rest: 'at rest', stopped: 'stopped' };
const word = (m: Mode) => WORDS[m];
export const modeWords = (projectId: string) => WORDS[modeOf(projectId)];

function setMode(projectId: string, mode: Mode, note: string, data: Row) {
  run('UPDATE projects SET mode = ?, mode_since = ?, mode_note = ?, mode_data = ? WHERE id = ?', mode, now(), note, JSON.stringify(data), projectId);
  touchProject(projectId);
}

// ---------- what the dashboard shows ----------

/**
 * An Active task with nobody working on it while the project is not running: it shows as held, not as a running
 * timer (the user stopped it, or it waits on its review while the project winds down).
 */
export function taskHeld(t: Row): boolean {
  if (t.kind !== 'task' || t.state !== 'active' || !holdsNewWork(t.project_id)) return false;
  return !get("SELECT 1 AS x FROM agents WHERE (id = ? OR task_id = ?) AND status IN ('working', 'waiting') LIMIT 1", t.driver_agent_id ?? '', t.id);
}

/** Tasks Active, Scheduled and Waiting, and agents mid-turn: what a change would affect, for the confirmations. */
export function modeCounts(projectId: string) {
  const tasks = (state: string) => all(`SELECT id, title FROM tasks WHERE project_id = ? AND kind = 'task' AND state = ? ORDER BY importance DESC, position`, projectId, state);
  const active = tasks('active');
  const scheduled = tasks('scheduled');
  const waiting = tasks('waiting');
  const working = midTurn(projectId).map((a) => agentLine(a));
  return { active, scheduled: scheduled.length, waiting: waiting.length, queued: scheduled.length, working };
}

/** Agents in the middle of a turn: working, or waiting on a permission answer (not on a question to the user). */
function midTurn(projectId: string): Row[] {
  return all(
    `SELECT * FROM agents WHERE project_id = ? AND status IN ('working', 'waiting')
       AND id NOT IN (SELECT agent_id FROM inbox WHERE status = 'open' AND kind != 'permission' AND blocking = 1 AND agent_id IS NOT NULL)
     ORDER BY parent_id IS NOT NULL, created_at`,
    projectId,
  );
}

function agentLine(a: Row): Row {
  const task = a.task_id ? get('SELECT id, title FROM tasks WHERE id = ?', a.task_id) : undefined;
  return { id: a.id, name: a.name, status: a.status, director: !a.parent_id, task_id: task?.id ?? null, task_title: task?.title ?? null, doing: withBusy(a).status_line ?? '' };
}

/** The mode as the project view carries it, with the counts the Home lines need and the close-out once written. */
export function modeView(projectId: string) {
  const p = modeRow(projectId);
  const mode = (p?.mode ?? 'running') as Mode;
  const data = dataOf(p);
  const view: Row = { mode, label: MODE_LABEL[mode] ?? mode, since: p?.mode_since ?? null, note: p?.mode_note ?? '', data };
  if (mode === 'running') return view;
  view.counts = modeCounts(projectId);
  view.held_messages = Number(get('SELECT COUNT(*) AS n FROM held_messages WHERE project_id = ?', projectId)?.n ?? 0);
  if (mode === 'at_rest' && data.at_rest_at) {
    const c = get("SELECT id, title, body, ts FROM journal WHERE project_id = ? AND kind = 'milestone' AND ts >= ? AND lower(title) LIKE 'close-out%' ORDER BY ts DESC LIMIT 1", projectId, data.at_rest_at);
    if (c) view.closeout = c;
  }
  if (mode === 'stopped') {
    view.interrupted = ((data.interrupted ?? []) as Row[]).map((a) => ({ ...a, now: getAgent(a.id)?.status ?? 'closed' }));
  }
  return view;
}

// ---------- changes, by the user only ----------

const userNote = (note: string) => (note ? ` Their note: "${note.replace(/\s+/g, ' ').slice(0, 300)}".` : '');

/** Finish up: what is Active finishes, nothing new starts. From Autopilot or Queue only. */
export async function windDown(projectId: string, rawNote = ''): Promise<string | null> {
  const p = modeRow(projectId);
  if (!p) return 'No such project.';
  const mode = modeOf(projectId);
  if (mode === 'winding_down' || mode === 'at_rest') return `The project is already ${word(mode)}.`;
  if (mode === 'stopped') return 'The project is stopped. Resume it first; then you can finish up.';
  const note = String(rawNote ?? '').trim().slice(0, 300);
  const c = modeCounts(projectId);
  setMode(projectId, 'winding_down', note, { prev_run: mode, started_at: now(), active_at_start: c.active.map((t) => t.id), queued_at_start: c.scheduled + c.waiting });
  addJournal(projectId, null, 'decision', 'You set the project to Finish up', `${c.active.length} task(s) Active continue to completion; ${c.scheduled} scheduled and ${c.waiting} waiting stay queued.${note ? `\n\nNote: ${note}` : ''}`);
  // Nothing running: at rest at once, with one note to the director rather than two.
  if (await checkAtRest(projectId)) return null;
  await tellDirector(
    projectId,
    `The user set the project to Finish up.${userNote(note)} ${c.active.length ? `Active now: ${c.active.map((t) => `[[${t.id}]]`).join(', ')}. Bring each to completion: review, merge, settle it, clean up and close its agents.` : 'Nothing is Active: settle what is left and close idle agents.'} Start nothing new; the rules are below.`,
  );
  return null;
}

/** Stop all work: every agent mid-turn is interrupted now, and recorded so Resume can restart exactly those. */
export async function stopAll(projectId: string, rawNote = ''): Promise<string | null> {
  const p = modeRow(projectId);
  if (!p) return 'No such project.';
  const prev = modeOf(projectId);
  if (prev === 'stopped') return 'The project is already stopped.';
  const note = String(rawNote ?? '').trim().slice(0, 300);
  const agents = midTurn(projectId);
  // The mode first: what the interruptions produce (reports to managers, notes) is held from here on, not delivered.
  setMode(projectId, 'stopped', note, { prev, prev_since: p.mode_since ?? null, prev_note: p.mode_note ?? '', prev_data: dataOf(p), interrupted: agents.map(agentLine) });
  addJournal(projectId, null, 'decision', 'You stopped all work', `${agents.length ? `Interrupted: ${agents.map((a) => a.name).join(', ')}.` : 'No agent was working.'}${note ? `\n\nNote: ${note}` : ''}`);
  for (const a of agents) await hooks?.interrupt(a.id).catch((err) => console.error(`Could not interrupt ${a.name}:`, err));
  return null;
}

/**
 * Resume. From stopped: the chosen interrupted agents (default all of them) continue, messages held for them are
 * delivered, and the director is told; the project returns to the mode it was in before the stop. From winding down
 * or at rest: back to running, and the director takes up the queue.
 */
export async function resume(projectId: string, agentIds?: unknown, target?: Mode): Promise<string | null> {
  const p = modeRow(projectId);
  if (!p) return 'No such project.';
  const mode = modeOf(projectId);
  const project = getProject(projectId)!;
  if (mode !== 'stopped') {
    // Out of Finish up: to the mode chosen, else the one it was entered from.
    if (mode === 'running' || mode === 'queue_only') return target === 'running' || target === 'queue_only' ? setRunMode(projectId, target) : `The project is already ${word(mode)}.`;
    return setRunMode(projectId, target === 'running' || target === 'queue_only' ? target : dataOf(p).prev_run === 'running' ? 'running' : 'queue_only');
  }
  const data = dataOf(p);
  const recorded = (data.interrupted ?? []) as Row[];
  const wanted = Array.isArray(agentIds) ? new Set(agentIds.map(String)) : null;
  // The director is told of the resume either way, so it always continues; the choice is about the other agents.
  const chosen = recorded.filter((a) => !wanted || wanted.has(a.id) || a.director);
  const left = recorded.filter((a) => !chosen.includes(a));
  const prev: Mode = (MODES as readonly string[]).includes(data.prev) ? data.prev : 'running';
  const back: Mode = target && target !== 'stopped' ? (target === 'winding_down' && prev === 'at_rest' ? 'at_rest' : target) : prev;
  const restore = back === prev && (back === 'winding_down' || back === 'at_rest');
  tx(() => {
    // Back to a Finish up already under way: its tally and note as they were; any other mode starts afresh.
    const fresh = back === 'winding_down' ? { prev_run: prev === 'running' ? 'running' : 'queue_only', started_at: now(), active_at_start: [], queued_at_start: 0 } : {};
    run('UPDATE projects SET mode = ?, mode_since = ?, mode_note = ?, mode_data = ? WHERE id = ?', back, restore ? data.prev_since ?? now() : now(), restore ? data.prev_note ?? '' : '', JSON.stringify(restore ? data.prev_data ?? {} : fresh), projectId);
  });
  touchProject(projectId);
  addJournal(projectId, null, 'decision', 'You resumed work after stopping it', `${chosen.length ? `Resumed: ${chosen.map((a) => a.name).join(', ')}.` : 'No agent resumed.'}${left.length ? ` Left stopped: ${left.map((a) => a.name).join(', ')}.` : ''}`);
  if (!hooks) return null;
  const stoppedAt = clockText(p.mode_since ?? now());
  const root = hooks.root(project);
  const summary = `${chosen.length ? `Resumed: ${chosen.map((a) => `${a.name} [[${a.id}]]`).join(', ')}.` : 'No agent was resumed.'}${left.length ? ` Left stopped, for the user to resume: ${left.map((a) => `${a.name} [[${a.id}]]`).join(', ')}.` : ''}`;
  const after = back === 'running' || back === 'queue_only' ? `The project is ${word(back)}: carry on with the agreed work by its rules.` : `The project is ${word(back)}${restore ? ' again, as before the stop' : ''}.`;
  let toldRoot = false;
  for (const a of chosen) {
    const agent = getAgent(a.id);
    if (!agent || ['done', 'closed'].includes(agent.status)) continue;
    const isRoot = agent.id === root.id;
    const text =
      `<helm-note>The user stopped all work in the project at ${stoppedAt}, which interrupted you${a.doing ? ` while you were: ${a.doing}` : ''}, and has now resumed it. ` +
      `Your conversation is intact, but scratch servers, watchers and other background processes may have stopped. Check your worklist and the state of the files, and continue where you left off.` +
      (isRoot ? ` ${summary} ${after}` : '') +
      '</helm-note>';
    if (isRoot) toldRoot = true;
    await hooks.send(agent.id, text, { kind: 'system', name: 'Helm' }).catch((err) => console.error(`Could not resume ${agent.name}:`, err));
  }
  if (!toldRoot) await tellDirector(projectId, `The user resumed the project after stopping all work at ${stoppedAt}. ${summary} ${after}`);
  return null;
}

/**
 * Autopilot or Queue only, from either of them, Finish up or at rest (Stopped goes through resume). The director is
 * told the new rules; leaving Finish up, it takes up the queue again.
 */
export async function setRunMode(projectId: string, target: 'running' | 'queue_only'): Promise<string | null> {
  const p = modeRow(projectId);
  if (!p) return 'No such project.';
  const from = modeOf(projectId);
  if (from === target) return `The project is already ${word(target)}.`;
  if (from === 'stopped') return resume(projectId, undefined, target);
  setMode(projectId, target, '', target === 'queue_only' ? { queue: queueEmpty(projectId) ? 'told' : 'busy' } : {});
  addJournal(projectId, null, 'decision', `You set the project to ${MODE_LABEL[target]}`, `It was ${MODE_LABEL[from]}.`);
  await tellDirector(
    projectId,
    target === 'running'
      ? `The user set the project to Autopilot. Take up the agreed work in queue order (list_tasks); when the scheduled queue is empty, schedule the next waiting task yourself.`
      : `The user set the project to Queue only. Scheduled tasks run in order${from === 'winding_down' || from === 'at_rest' ? ': take them up again' : ''}; never schedule or start a Waiting, Planning or Paused task yourself unless the user asks for that task. The rules are below.`,
  );
  return null;
}

/** The user's choice from the menu or Setup: one of the four modes (agents: who resumes, when leaving Stopped). */
export async function changeMode(projectId: string, target: unknown, note = '', agents?: unknown): Promise<string | null> {
  if (!MODE_CHOICES.some((c) => c.mode === target)) return `Choose a mode: ${MODE_CHOICES.map((c) => c.mode).join(', ')}.`;
  const to = target as ChoiceMode;
  const from = modeOf(projectId);
  if (to === 'stopped') return stopAll(projectId, note);
  if (from === 'stopped') return resume(projectId, agents, to);
  if (to === 'winding_down') return windDown(projectId, note);
  return setRunMode(projectId, to);
}

async function tellDirector(projectId: string, text: string) {
  const project = getProject(projectId);
  if (!project || !hooks) return;
  await hooks.send(hooks.root(project).id, `<helm-note>${text}</helm-note>`, { kind: 'system', name: 'Helm' }).catch((err) => console.error('Could not tell the director:', err));
}

/**
 * Winding down, nothing Active and no agent working: at rest. The user gets one notification and the Home line;
 * the director writes the close-out. Called whenever an agent's status or a task's state changes, and on the
 * sessions timer. Returns whether it changed the mode.
 */
export async function checkAtRest(projectId: string): Promise<boolean> {
  const p = modeRow(projectId);
  if (p?.mode === 'queue_only') return checkQueueEmpty(p);
  if (!p || p.mode !== 'winding_down') return false;
  if (get("SELECT 1 AS x FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'active' LIMIT 1", projectId)) return false;
  if (midTurn(projectId).length) return false;
  const data = dataOf(p);
  const since = data.started_at ?? p.mode_since ?? 0;
  const finished = all(
    "SELECT DISTINCT t.id, t.title FROM task_states s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ? AND s.state = 'done' AND s.at >= ? AND t.state = 'done' ORDER BY s.at",
    projectId, since,
  );
  const c = modeCounts(projectId);
  const at = now();
  // Claimed in one statement, so two callers (both processes, or a status change racing the timer) do this once.
  const claimed = run("UPDATE projects SET mode = 'at_rest', mode_since = ?, mode_data = ? WHERE id = ? AND mode = 'winding_down'", at, JSON.stringify({ ...data, at_rest_at: at, finished, scheduled: c.scheduled, waiting: c.waiting }), projectId);
  if (!claimed.changes) return false;
  touchProject(projectId);
  const line = restLine(finished.length, c.scheduled, c.waiting);
  addJournal(projectId, null, 'milestone', 'Wind down finished: the project is at rest', line);
  notify({ kind: 'done', projectId, title: `${p.name}: at rest`, body: line, url: `#/p/${projectId}/` });
  await tellDirector(
    projectId,
    `The wind down is complete: nothing is Active and no agent is working, so the project is now at rest. ${line} ` +
      `Write the close-out now with log_journal, kind "milestone", title starting "Close-out:", and a body of a few short lines the user reads before testing: what is ready to test or release (with references), known issues and anything unfinished, and what stays queued. Helm shows it on the project's Home. Then stay idle: nothing new starts until the user resumes.`,
  );
  return true;
}

/** Nothing Active or Scheduled and no agent mid-turn. */
function queueEmpty(projectId: string): boolean {
  if (get("SELECT 1 AS x FROM tasks WHERE project_id = ? AND kind = 'task' AND state IN ('active', 'scheduled') LIMIT 1", projectId)) return false;
  return !midTurn(projectId).length;
}

/**
 * Queue only: when the queue empties (it had work since the mode was set, or since the last time it emptied) the
 * user is told once, "Queue empty; 4 tasks waiting". mode_data.queue is 'busy' while there is work and 'told' once
 * told; claimed in one statement so both processes and the timer tell it once.
 */
function checkQueueEmpty(p: Row): boolean {
  const data = dataOf(p);
  const empty = queueEmpty(p.id);
  const next = empty ? (data.queue === 'busy' ? 'told' : data.queue) : 'busy';
  if (next === data.queue) return false;
  const claimed = run("UPDATE projects SET mode_data = ? WHERE id = ? AND mode = 'queue_only' AND mode_data IS ?", JSON.stringify({ ...data, queue: next }), p.id, p.mode_data ?? null);
  if (!claimed.changes || next !== 'told') return false;
  touchProject(p.id);
  const waiting = Number(get("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'waiting'", p.id)?.n ?? 0);
  const line = `Queue empty; ${waiting} task${waiting === 1 ? '' : 's'} waiting`;
  notify({ kind: 'done', projectId: p.id, title: `${p.name}: ${line}`, body: 'Queue only: schedule what should run next.', url: `#/p/${p.id}/tasks` });
  return true;
}

/**
 * The user started a task anyway while the project is at rest: something runs again, so it is winding down again,
 * and comes back to rest (with a new close-out) when that task settles. The tally starts from now.
 */
export function startedAnyway(projectId: string) {
  const p = modeRow(projectId);
  if (p?.mode !== 'at_rest') return;
  const data = dataOf(p);
  run("UPDATE projects SET mode = 'winding_down', mode_since = ?, mode_data = ? WHERE id = ? AND mode = 'at_rest'", now(), JSON.stringify({ prev_run: data.prev_run, started_at: now(), active_at_start: [], queued_at_start: (data.scheduled ?? 0) + (data.waiting ?? 0) }), projectId);
  touchProject(projectId);
}

export function restLine(finished: number, scheduled: number, waiting: number): string {
  const queued = scheduled + waiting;
  return `${finished} task${finished === 1 ? '' : 's'} finished during the wind down; ${queued ? `${queued} remain${queued === 1 ? 's' : ''} queued (${scheduled} scheduled, ${waiting} waiting)` : 'nothing remains queued'}.`;
}

// ---------- what agents are told ----------

const since = (p: Row) => (p.mode_since ? ` since ${clockText(p.mode_since)}` : '');

/** The rules for the current mode, for the system prompt and the note when it changes. Empty while running. */
export function modeRules(projectId: string, manager: boolean, root: boolean): string {
  const p = modeRow(projectId);
  const mode = modeOf(projectId);
  if (!p || mode === 'running') return '';
  const note = p.mode_note ? ` (their note: "${p.mode_note}")` : '';
  const ask = root ? ' Only the user changes the mode; you cannot. If something must start (a critical fix, say), ask them with ask_user: they can start one task anyway, or change the mode.' : '';
  if (mode === 'queue_only') {
    if (!manager) return '';
    if (!root) return `# The project is in Queue only\nThe user runs only what they scheduled: never schedule or start a Waiting, Planning or Paused task yourself.`;
    return [
      `# The project is in Queue only`,
      `The user set the project to Queue only${since(p)}: Scheduled tasks run in order, including ones the user schedules later, and nothing else is lined up for them.`,
      `- Helm starts builders for Scheduled tasks in queue order as usual.`,
      `- Never move a Waiting, Planning or Paused task to Scheduled or Active, and create new tasks as Waiting (or Planning proposals), not Scheduled or Active. Helm refuses it unless the user's own message in that turn asked for that task. This overrides the rule about scheduling the next waiting task yourself while the user is away.`,
      `- Problems found in review and work from reports become Waiting tasks, for the user to schedule.`,
      `- When the queue is empty, stay idle: Helm tells the user once.${ask}`,
    ].join('\n');
  }
  if (mode === 'stopped') {
    return root
      ? `# The project is stopped\nThe user stopped all work${since(p)}${note}. Every agent working was interrupted, and nothing runs until the user resumes. You run only to answer the user's own messages: read, search, answer, post in threads, file requests, edit the Spec with them and propose work as Planning tasks. Helm starts no builders, and refuses the tools that resume or message agents (message_agent, decide_permission), make a task Active (create_task, update_task), claim hosts, or start background work (subagents, workflows, background commands); messages to other agents wait until the user resumes. Do not work around this. If the user wants work to go on, tell them to choose a mode on the project's status pill (or Resume on its Home).${ask}`
      : `# The project is stopped\nThe user stopped all work${since(p)}. End your turn now; you will be resumed with a note when the user resumes the project.`;
  }
  if (!manager) {
    return `# The project is ${word(mode)}\nThe user set the project to Finish up${note}: finish the task you are on and report as usual, but start nothing else. Subagents for your task are still allowed; new tasks are not.`;
  }
  if (mode === 'at_rest') {
    return `# The project is at rest\nThe user set the project to Finish up${note} and it is now at rest${since(p)}: nothing is Active and nothing new starts until the user changes the mode. Answer the user, keep threads and the Spec current, and propose new work as Planning tasks. Helm starts no builders, and refuses moving tasks to Scheduled or Active, and creating tasks other than Planning proposals.${ask}`;
  }
  return [
    `# The project is finishing up`,
    `The user set the project to Finish up${since(p)}${note}, to test, evaluate or release a stable state. Finish what is running and start nothing new:`,
    `- Tasks already Active continue to completion: their builders finish them. Answer their questions, review what is marked for review, and settle any task left with nobody on it (done with a status summary, or paused with the reason).`,
    `- Start nothing new. Helm starts no builder for Scheduled work, and refuses moving a task to Scheduled or Active and creating tasks other than Planning proposals (create_task state planning).`,
    `- Reports are still triaged, but into Planning tasks or needs-input, never started. New ideas and findings become Planning proposals for later.`,
    `- When nothing is Active and no agent is working, Helm marks the project at rest, tells the user, and asks you for a short close-out.${ask}`,
  ].join('\n');
}

const keyOf = (p: Row | undefined) => `${p?.mode ?? 'running'}@${p?.mode_since ?? 0}`;

/** The system prompt's section for the mode; the agent counts as told about it. */
export function modePromptSection(agent: Row, manager: boolean): string {
  const p = modeRow(agent.project_id);
  run('UPDATE agents SET mode_seen = ? WHERE id = ?', keyOf(p), agent.id);
  return modeRules(agent.project_id, manager, !agent.parent_id);
}

/** A note for a message to an agent that has not been told about the latest mode change; once per change. */
export function modeChangeNote(agent: Row, manager: boolean): string {
  const p = modeRow(agent.project_id);
  const key = keyOf(p);
  const seen = agent.mode_seen ?? 'running@0';
  if (seen === key) return '';
  run('UPDATE agents SET mode_seen = ? WHERE id = ?', key, agent.id);
  const rules = modeRules(agent.project_id, manager, !agent.parent_id);
  if (rules) return `\n<helm-note kind="project-mode">${rules}</helm-note>`;
  // Autopilot, or Queue only for an agent it does not concern: only the director hears that the earlier rules ended.
  if (!manager || agent.parent_id) return '';
  const mode = modeOf(agent.project_id);
  if (seen.startsWith('running@') && mode === 'running') return '';
  const was = seen.startsWith('queue_only@') ? 'Queue only' : 'finishing up or being stopped';
  return `\n<helm-note kind="project-mode">The project is ${word(mode)}: the earlier rules about ${was} no longer apply.${mode === 'running' ? ' When the scheduled queue is empty, schedule the next waiting task yourself again.' : ''}</helm-note>`;
}

/** For the director's <presence> tag: ` project="winding down"` while not running. */
export function presenceAttr(projectId: string): string {
  const m = modeOf(projectId);
  return m === 'running' ? '' : ` project="${m === 'at_rest' ? 'finished up, at rest' : MODE_LABEL[m]}"`;
}

// ---------- held messages (stopped) ----------

/** While stopped, nothing reaches an agent except the user's own messages to the director. */
export function holds(agent: Row, from: Sender): boolean {
  return isStopped(agent.project_id) && !(!agent.parent_id && from.kind === 'user');
}

export function holdMessage(agent: Row, text: string, from: Sender, fileIds: string[], bind: boolean, viewing: unknown) {
  run(
    'INSERT INTO held_messages (project_id, agent_id, text, sender, files, bind, viewing, created_at) VALUES (?,?,?,?,?,?,?,?)',
    agent.project_id, agent.id, text, JSON.stringify(from), JSON.stringify(fileIds), bind ? 1 : 0, viewing ? JSON.stringify(viewing) : null, now(),
  );
  touchProject(agent.project_id);
}

/** The messages held for an agent, oldest first, removed as they are taken (once the project is no longer stopped). */
export function takeHeld(agentId: string): { text: string; from: Sender; files: string[]; bind: boolean; viewing: any }[] {
  return tx(() => {
    const rows = all('SELECT * FROM held_messages WHERE agent_id = ? ORDER BY id', agentId);
    if (rows.length) run(`DELETE FROM held_messages WHERE id IN (${rows.map(() => '?').join(',')})`, ...rows.map((r) => r.id));
    return rows.map((r) => ({ text: r.text, from: JSON.parse(r.sender), files: JSON.parse(r.files), bind: !!r.bind, viewing: r.viewing ? JSON.parse(r.viewing) : null }));
  });
}

// ---------- the gating table ----------

/**
 * Every Helm tool by what it does, so the rules apply by category: a new tool gets a category here (the test fails
 * until it has one), and a tool without one is treated by its name (list_/get_/read_/find/search reads; anything
 * else counts as acting, which is refused while stopped).
 * - read: looks only. record: writes what agents and the user read (threads, Spec, journal, previews, requests,
 *   status, knowledge), or finishes things. tasks: creates tasks or changes their state (decided by its input).
 *   start: starts an agent. message: wakes another agent. host: claims a machine to run work on.
 *   work: finishing work already under way (refreshing a tile, reviewing its scope): on while winding down, off while
 *   stopped. dashboard: set_dashboard, new work when it creates a dashboard (no dashboard named), else work.
 */
export type ToolCategory = 'read' | 'record' | 'tasks' | 'start' | 'message' | 'host' | 'work' | 'dashboard' | 'act';
export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  // read
  list_docs: 'read', list_attachments: 'read', list_tasks: 'read', find: 'read', list_hosts: 'read', read_knowledge: 'read', list_disk: 'read',
  list_importance: 'read', list_discussions: 'read', list_reports: 'read', get_report: 'read', list_toolbox: 'read', list_agents: 'read',
  search_helm: 'read', list_progress: 'read', get_telemetry: 'read', list_watches: 'read',
  // record
  worklist_set: 'record', worklist_update: 'record', report_status: 'record', post_preview: 'record', ask_user: 'record', withdraw_request: 'record', register_artifacts: 'record',
  log_journal: 'record', complete_task: 'record', release_host: 'record', note_knowledge: 'record', edit_knowledge: 'record', ask_manager: 'record',
  request_review: 'record', clean_artifacts: 'record', attach_reference: 'record', set_doc: 'record', propose_doc_edit: 'record', retag: 'record',
  set_section: 'record', set_importance: 'record', task_post: 'record', pin: 'record', create_discussion: 'record', file_exchange: 'record',
  update_discussion: 'record', update_report: 'record', set_phase: 'record', set_summary: 'record', summarize_session: 'record', propose_tool: 'record',
  affects_ack: 'record', set_checks: 'record', set_watch: 'record', run_checks: 'work',
  // close_agent ends work; its task_state is never Active (and the state rule in tasks.ts covers it anyway).
  close_agent: 'record',
  // tasks
  create_task: 'tasks', update_task: 'tasks', convert: 'tasks', replan_task: 'tasks',
  // Merging and recording what stays apart change no task's state toward running (merge.ts).
  merge_tasks: 'record', keep_apart: 'record', propose_consolidation: 'record', post_spec_findings: 'record', propose_spec_entries: 'record',
  // start, message, host
  message_agent: 'message', message_project: 'message', decide_permission: 'message', claim_host: 'host', host_workspace: 'host', host_workspace_end: 'host',
  // dashboards (dashtools.ts)
  list_dashboards: 'read', update_tile: 'work', review_dashboard_scope: 'work', dashboard_lint: 'read', set_tile: 'work', set_dashboard: 'dashboard',
  // releases (releasetools.ts); starting and publishing are request actions the user taps (reqactions.ts)
  list_releases: 'read', set_release_recipe: 'record', set_release_notes: 'record', add_release_artifact: 'work',
  finish_release: 'work', fail_release: 'record', mark_published: 'record', report_test_build: 'work', make_test_build: 'work',
  // the Ideas board (ideastools.ts)
  list_ideas: 'read', add_idea: 'record',
};
export function toolCategory(name: string): ToolCategory {
  return TOOL_CATEGORIES[name] ?? (/^(list|get|read|find|search)(_|$)/.test(name) ? 'read' : 'act');
}

const WHY: Record<string, string> = {
  start: 'it starts an agent',
  message: 'it wakes another agent',
  host: 'it claims a machine to run work on',
  work: 'it carries on work, which waits for the resume',
  act: 'it acts beyond answering',
};

function refused(projectId: string, why: string): string {
  const p = modeRow(projectId)!;
  const mode = modeOf(projectId);
  return `Refused: the project is ${word(mode)} (the user ${mode === 'stopped' ? 'stopped all work' : `set it to ${MODE_LABEL[mode]}`}${since(p)}), and ${why}. Only the user can change that, with the mode on the project's status pill; if you think it must happen, ask them with ask_user.`;
}

/**
 * Queue only: the user's own messages in the agent's current turn (since its last result), as typed: the conversation,
 * a thread message or an answer. Answers to other agents, reports and Helm notes are not the user.
 */
function userWordsThisTurn(agentId: string): string[] {
  const last = Number(get("SELECT MAX(id) AS id FROM events WHERE agent_id = ? AND kind = 'result'", agentId)?.id ?? 0);
  return all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' AND id > ? ORDER BY id", agentId, last)
    .map((e) => {
      try {
        const d = JSON.parse(e.data);
        return d.from?.kind === 'user' ? String(d.text ?? '') : null;
      } catch {
        return null;
      }
    })
    .filter((t): t is string => t !== null);
}

const WORD = /[a-z0-9]{4,}/g;
/**
 * Whether the user's own message in this turn asked for this task: it names its id (a link, the thread it came in,
 * the item they were viewing), or most of the title's words. With no task (create_task), any message of theirs.
 */
export function userAskedFor(agentId: string | undefined, task?: Row): boolean {
  if (!agentId) return false;
  const words = userWordsThisTurn(agentId);
  if (!words.length) return false;
  if (!task) return true;
  const text = words.join('\n').toLowerCase();
  if (text.includes(String(task.id).toLowerCase())) return true;
  const title = [...new Set(String(task.title ?? '').toLowerCase().match(WORD) ?? [])];
  return title.length > 0 && title.filter((w) => text.includes(w)).length / title.length >= 0.6;
}

const QUEUE_ONLY_WHY = 'nothing is scheduled or started except what the user schedules: create it as Waiting, or if the user asked for this task, ask them to schedule it (or press Schedule on it)';

/** Whether a Helm tool call is refused in the project's current mode, and why. Null: allowed. */
export function toolRefusal(projectId: string, name: string, input: Row = {}, agentId?: string): string | null {
  const mode = modeOf(projectId);
  if (mode === 'running') return null;
  if (mode === 'queue_only') {
    // A new task lined up or started by the director: only when the user's own message in this turn asked for it.
    if (toolCategory(name) !== 'tasks' || name === 'update_task') return null;
    const state = name === 'convert' ? (input.to === 'task' ? input.state ?? 'planning' : null) : input.state;
    return (state === 'scheduled' || state === 'active') && !userAskedFor(agentId) ? refused(projectId, QUEUE_ONLY_WHY) : null;
  }
  const cat = toolCategory(name);
  const stopped = mode === 'stopped';
  switch (cat) {
    case 'read':
    case 'record':
      return null;
    case 'start':
    case 'message':
    case 'host':
    case 'work':
    case 'act':
      // Winding down, Helm starts no new builders (dispatch.ts); the rest goes on.
      return stopped ? refused(projectId, WHY[cat]) : null;
    case 'dashboard':
      // A new dashboard is new work (it opens an Active task); changing one goes on while winding down.
      if (!input.dashboard) return refused(projectId, 'a new dashboard is new work: propose it as a Planning task instead');
      return stopped ? refused(projectId, WHY.work) : null;
    case 'tasks': {
      // A change of an existing task's state is judged against the task (stateRefusal, from agentStateChangeError):
      // update_task restating the state a task already has is not a change.
      if (name === 'update_task') return null;
      const state = name === 'convert' ? (input.to === 'task' ? input.state ?? 'planning' : null) : input.state;
      if (!state) return null;
      if (state === 'active') return refused(projectId, 'tasks become Active only by the user while it is');
      if (!stopped && state !== 'planning') return refused(projectId, 'new tasks may only be Planning proposals (state planning) until it ends');
      return null;
    }
  }
}

/**
 * A task state change by an agent (update_task, close_agent): Active, and Scheduled while finishing up, are refused;
 * in Queue only, a Waiting, Planning or Paused task lined up or started, unless the user asked for it this turn.
 */
export function stateRefusal(projectId: string, state: string, task?: Row, agentId?: string): string | null {
  const mode = modeOf(projectId);
  if (mode === 'running') return null;
  if (mode === 'queue_only') {
    if (state !== 'scheduled' && state !== 'active') return null;
    if (!task || task.state === 'scheduled' || task.state === 'active') return null;
    return userAskedFor(agentId, task) ? null : refused(projectId, QUEUE_ONLY_WHY);
  }
  if (state === 'active') return refused(projectId, 'tasks become Active only by the user while it is');
  if (state === 'scheduled' && mode !== 'stopped') return refused(projectId, 'nothing new is lined up: tasks are not moved to Scheduled');
  return null;
}

/** Built-in tools that start background work: refused while stopped (the director only answers). */
const BACKGROUND_BUILTINS = ['Agent', 'Task', 'Workflow', 'Monitor', 'CronCreate', 'ScheduleWakeup', 'RemoteTrigger', 'SendToProject'];
export function builtinRefusal(projectId: string, name: string, input: Row = {}): string | null {
  if (!isStopped(projectId)) return null;
  if (BACKGROUND_BUILTINS.includes(name)) return refused(projectId, 'it starts background work');
  if (name === 'Bash' && input?.run_in_background) return refused(projectId, 'background commands are long work; run it in the foreground if it is quick, or not at all');
  return null;
}
