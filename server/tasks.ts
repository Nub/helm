import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { reportsTaskDone } from './reports.ts';
import { applyImportance } from './spec.ts';
import { answerAttachments, attachmentView, listAttachments, messageAttachments, taskAttachmentCount } from './attachments.ts';
import { agentView, inboxView, touchProject, withFeedback } from './store.ts';
import { holderView, needsView } from './requests.ts';
import { watchView } from './taskwatch.ts';
import { findUserAsks } from './userasks.ts';
import { notifyPlanReady, notifyTaskDone, safe } from './notify.ts';
import { proposalSummary, proposalView, renderProposal } from './pins.ts';

/**
 * Tasks: the units of work the user manages. Each has a state, a place in the
 * project's queue, an optional driving agent and goal/design, a status summary,
 * and a thread (task_messages plus the questions, previews and journal entries
 * that carry its task_id).
 */

export const TASK_STATES = ['planning', 'waiting', 'scheduled', 'active', 'paused', 'done', 'dropped'];
export const OPEN_TASK_STATES = ['planning', 'waiting', 'scheduled', 'active', 'paused'];
/** States an agent may create a task in. Planning only moves on when the user approves. */
export const AGENT_CREATE_STATES = ['planning', 'waiting', 'scheduled', 'active'];
/** away: created by the director while the owner was away, for a critical problem it could solve alone (origin_note says what). */
export const TASK_ORIGINS = ['user', 'director', 'doc', 'report', 'away'];

export const STATE_LABEL: Record<string, string> = {
  planning: 'Planning',
  waiting: 'Waiting',
  scheduled: 'Scheduled',
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
  dropped: 'Dropped',
  open: 'Open',
  settled: 'Settled',
};

/**
 * Discussions share the tasks table (kind 'discussion'): a question or idea kept as a
 * findable thread. They are open or settled, never queued, driven or approved.
 */
export const DISCUSSION_STATES = ['open', 'settled'];
export const isDiscussion = (t: Row) => t.kind === 'discussion';
/** "task" or "discussion", for messages. */
export const kindWord = (t: Row) => (isDiscussion(t) ? 'discussion' : 'task');

/** Who did something to a task. `id` is the agent's id when an agent did it. */
export type Author = { author: 'user' | 'director' | 'system'; name: string; id?: string };
export const USER: Author = { author: 'user', name: 'You' };

/** A task or discussion by id, or by an old id that now resolves to it (task_aliases). */
export function getTask(id: string): Row | undefined {
  return get('SELECT * FROM tasks WHERE id = ?', id) ?? get('SELECT t.* FROM task_aliases a JOIN tasks t ON t.id = a.task_id WHERE a.alias_id = ?', id);
}

/** A task on the project by id, or by exact title when that is unambiguous. */
/**
 * Why an agent may not move `task` to `state`, or null if it may. The user owns approval
 * (planning moves on only by Approve or Start) and resuming what they paused. Dropping is
 * always allowed: it is not advancing the work.
 */
export function agentStateChangeError(task: Row, state: string, agentId: string): string | null {
  if (state === task.state || state === 'dropped') return null;
  if (task.state === 'planning') {
    return `${taskRef(task)} is in Planning. Only the user can move it on, by pressing Approve or Start on the dashboard. Discuss it in its thread with task_post and keep the description current with the plan; you may drop it if it is no longer wanted.`;
  }
  if (task.state === 'paused' && ['waiting', 'scheduled', 'active'].includes(state) && task.paused_by !== agentId) {
    const who = !task.paused_by || task.paused_by === 'user' ? 'the user' : `another agent (${get('SELECT name FROM agents WHERE id = ?', task.paused_by)?.name ?? task.paused_by})`;
    return `${taskRef(task)} was paused by ${who}, so only ${who === 'the user' ? 'they' : 'that agent or the user'} can resume it (the user with Resume on the dashboard). Do not work on it; if you think it should resume, say so in its thread with task_post.`;
  }
  return null;
}

/** An open planning task that `title` or `docId` would duplicate, for refusing to start the same work unapproved. */
export function planningTwin(projectId: string, title: string, docId: string | null): Row | undefined {
  return get(
    "SELECT * FROM tasks WHERE project_id = ? AND state = 'planning' AND (lower(trim(title)) = lower(trim(?)) OR (? IS NOT NULL AND doc_id = ?)) ORDER BY position LIMIT 1",
    projectId, title, docId, docId,
  );
}

export function findTask(projectId: string, ref: string): Row | undefined {
  const byId = getTask(ref);
  if (byId?.project_id === projectId) return byId;
  const byTitle = all('SELECT * FROM tasks WHERE project_id = ? AND title = ?', projectId, ref);
  return byTitle.length === 1 ? byTitle[0] : undefined;
}

/** How a task is named in messages to agents. */
export const taskRef = (t: Row) => `the ${kindWord(t)} "${t.title}" [[${t.id}]]`;

/** `eventId`: the conversation event this message was filed from, if any. */
export function addTaskMessage(task: Row, by: Author, body: string, kind: 'message' | 'state' | 'summary' | 'change' | 'spec' | 'proposal' = 'message', eventId: number | null = null): number {
  const id = tx(() => {
    const res = run('INSERT INTO task_messages (task_id, author, author_name, kind, body, created_at, event_id) VALUES (?,?,?,?,?,?,?)', task.id, by.author, by.name, kind, body, now(), eventId);
    run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), task.id);
    return Number(res.lastInsertRowid);
  });
  touchProject(task.project_id);
  // The director's first post or summary in a task in Planning: the plan is there to approve (server/notify.ts).
  if ((kind === 'message' || kind === 'summary') && by.author === 'director') safe(() => notifyPlanReady(task.id, body));
  return id;
}

export function createTask(
  projectId: string,
  input: { title: string; description?: string; state: string; doc_id?: string | null; driver_agent_id?: string | null; origin: string; origin_note?: string; kind?: 'task' | 'discussion'; status_summary?: string },
  by: Author,
): Row {
  const created = tx(() => {
    const kind = input.kind ?? 'task';
    const id = newId(kind === 'discussion' ? 'disc' : 'task');
    // Only tasks are queued; a discussion keeps position 0.
    const position = kind === 'task' ? (get("SELECT MAX(position) AS p FROM tasks WHERE project_id = ? AND kind = 'task'", projectId)?.p ?? 0) + 1 : 0;
    run(
      'INSERT INTO tasks (id, project_id, kind, title, description, state, position, doc_id, driver_agent_id, origin, origin_note, status_summary, summary_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, projectId, kind, input.title, input.description ?? '', input.state, position, input.doc_id ?? null, input.driver_agent_id ?? null, input.origin, input.origin_note ?? '',
      input.status_summary ?? '', input.status_summary ? now() : null, now(), now(),
    );
    if (kind === 'task') noteTaskState(id, null, input.state);
    const task = getTask(id)!;
    addTaskMessage(task, { author: 'system', name: 'Helm' }, kind === 'task' ? `${by.name} created this task as ${STATE_LABEL[input.state]}.` : `${by.name} started this discussion.`, 'state');
    return getTask(id)!;
  });
  return created;
}

export function setTaskState(task: Row, state: string, by: Author, why = '') {
  if (task.state === state) return;
  // The start of the stretch of work this change ends: "a result to look at" is what was posted since (notify.ts).
  const stretchStart = (get("SELECT MAX(created_at) AS t FROM task_messages WHERE task_id = ? AND kind = 'state'", task.id)?.t as number) ?? task.created_at;
  tx(() => {
    run('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?', state, now(), task.id);
    if (!isDiscussion(task)) noteTaskState(task.id, task.state, state);
    if (state === 'paused') run('UPDATE tasks SET paused_by = ?, paused_from = ? WHERE id = ?', by.author === 'user' ? 'user' : (by.id ?? 'user'), task.state, task.id);
    else run('UPDATE tasks SET paused_by = NULL, paused_from = NULL WHERE id = ?', task.id);
    addTaskMessage(task, { author: 'system', name: 'Helm' }, `${by.name} moved it from ${STATE_LABEL[task.state]} to ${STATE_LABEL[state]}${why ? `: ${why}` : '.'}`, 'state');
    if (state === 'done') {
      const fixed = reportsTaskDone(task.id);
      if (fixed) addTaskMessage(task, { author: 'system', name: 'Helm' }, `Marked ${fixed} linked report${fixed === 1 ? '' : 's'} fixed.`, 'state');
    }
  });
  if (state === 'done') safe(() => notifyTaskDone(getTask(task.id) ?? task, stretchStart));
}

/** Replace the status summary; every summary is also kept in the thread as it was written. */
export function setTaskSummary(task: Row, summary: string, by: Author) {
  tx(() => {
    run('UPDATE tasks SET status_summary = ?, summary_at = ?, updated_at = ? WHERE id = ?', summary, now(), now(), task.id);
    addTaskMessage(task, by, summary, 'summary');
  });
}

/**
 * Record that a task entered `state` (from `from`, null when it was created) and keep its timing current: started_at is
 * the first time it became active, active_ms the time spent active so far (paused, waiting and scheduled stretches
 * excluded), active_since the start of the current active stretch, finished_at when it was done or dropped.
 */
export function noteTaskState(taskId: string, from: string | null, state: string, at = now()) {
  run('INSERT INTO task_states (task_id, from_state, state, at) VALUES (?,?,?,?)', taskId, from, state, at);
  applyTiming(taskId, from, state, at);
}

function applyTiming(taskId: string, from: string | null, state: string, at: number) {
  // Any change of state settles a finished driver's review (taskwatch.ts).
  if (from !== state) run('UPDATE tasks SET review_since = NULL, review_agent = NULL, review_noted = 0 WHERE id = ?', taskId);
  if (from === 'active' && state !== 'active') {
    run('UPDATE tasks SET active_ms = active_ms + MAX(0, ? - COALESCE(active_since, ?)), active_since = NULL WHERE id = ?', at, at, taskId);
  }
  if (state === 'active' && from !== 'active') run('UPDATE tasks SET started_at = COALESCE(started_at, ?), active_since = ? WHERE id = ?', at, at, taskId);
  if (state === 'done' || state === 'dropped') run('UPDATE tasks SET finished_at = ? WHERE id = ?', at, taskId);
  else run('UPDATE tasks SET finished_at = NULL WHERE id = ?', taskId);
}

/** The state a label in a thread's state note names ("Scheduled" → scheduled). */
const STATE_BY_LABEL = Object.fromEntries(TASK_STATES.map((s) => [STATE_LABEL[s], s]));

/**
 * Tasks from before task_states existed: rebuild their state history from the state notes in their threads ("… created
 * this task as Active.", "… moved it from Scheduled to Active …") and derive their timing. Only tasks with no recorded
 * states are touched, so running it again changes nothing. Returns how many tasks it filled in.
 */
export function backfillTaskTiming(): number {
  const tasks = all("SELECT * FROM tasks WHERE kind = 'task' AND NOT EXISTS (SELECT 1 FROM task_states s WHERE s.task_id = tasks.id)");
  tx(() => {
    for (const t of tasks) {
      const steps: { from: string | null; state: string; at: number }[] = [];
      for (const m of all("SELECT body, created_at FROM task_messages WHERE task_id = ? AND kind = 'state' ORDER BY created_at, id", t.id)) {
        const made = /created this task as (\w+)\./.exec(m.body) ?? /^Became a task: .* in (\w+)\.$/.exec(m.body);
        const moved = /moved it from (\w+) to (\w+)/.exec(m.body);
        if (made && STATE_BY_LABEL[made[1]]) steps.push({ from: null, state: STATE_BY_LABEL[made[1]], at: m.created_at });
        else if (moved && STATE_BY_LABEL[moved[1]] && STATE_BY_LABEL[moved[2]]) steps.push({ from: STATE_BY_LABEL[moved[1]], state: STATE_BY_LABEL[moved[2]], at: m.created_at });
      }
      // Nothing to read (or the notes do not end where the task is): it entered its present state when last updated.
      const last = steps[steps.length - 1];
      if (!last || last.state !== t.state) steps.push({ from: last?.state ?? null, state: t.state, at: last ? Math.max(last.at, t.updated_at) : (t.became_task_at ?? t.created_at) });
      run('UPDATE tasks SET started_at = NULL, finished_at = NULL, active_ms = 0, active_since = NULL WHERE id = ?', t.id);
      for (const st of steps) {
        run('INSERT INTO task_states (task_id, from_state, state, at) VALUES (?,?,?,?)', t.id, st.from, st.state, st.at);
        applyTiming(t.id, st.from, st.state, st.at);
      }
    }
  });
  return tasks.length;
}

/** How long a task has been worked on: active time so far, including the current stretch. */
export function activeMs(t: Row, at = now()): number {
  return (t.active_ms ?? 0) + (t.active_since ? Math.max(0, at - t.active_since) : 0);
}

/** "started 14:02 · running 37 min" / "took 1 h 12 min", for agents. */
export function timingText(t: Row): string {
  const dur = (ms: number) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  const at = (ts: number) => new Date(ts).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  if (t.state === 'done' && t.started_at) return `started ${at(t.started_at)}, took ${dur(activeMs(t))} of active time`;
  if (t.state === 'active' && t.started_at) return `started ${at(t.started_at)}, running ${dur(activeMs(t))}`;
  if (t.started_at) return `started ${at(t.started_at)}, ${dur(activeMs(t))} active so far`;
  return '';
}

export type Move = 'top' | 'bottom' | 'up' | 'down' | { before: string } | { after: string };

/** The queue: importance tier first, then position within the tier. One order for the user and the director. */
export const QUEUE_ORDER = 'ORDER BY importance DESC, position, created_at';
const LEVEL = ['', 'Minor', 'Low', 'Medium', 'High', 'Critical'];

/**
 * Reorder the queue, which is sorted by importance tier, then position. Up and
 * down swap with the nearest task in the same state, since that is the group
 * the user sees; top and bottom go to the top or bottom of the task's tier.
 * When the user moves a task past a tier boundary it takes that tier; either
 * way their placement is pinned (agents may not move it or change its level).
 * Agents stay within a tier: changing tier is set_importance's job.
 */
export function moveTask(task: Row, move: Move, actor: 'user' | 'agent' = 'agent'): string | null {
  if (actor === 'agent' && task.importance_pinned) {
    return `The user placed ${taskRef(task)} themselves, so its place and importance are pinned. If you think it should move, say so with your reason in its thread (task_post).`;
  }
  const list = all(`SELECT id, state, importance FROM tasks WHERE project_id = ? AND kind = 'task' ${QUEUE_ORDER}`, task.project_id);
  const from = list.findIndex((t) => t.id === task.id);
  const [me] = list.splice(from, 1);
  const tierStart = () => { const i = list.findIndex((t) => t.importance <= me.importance); return i < 0 ? list.length : i; };
  const tierEnd = () => { const i = list.findIndex((t) => t.importance < me.importance); return i < 0 ? list.length : i; };
  let to: number;
  if (move === 'top') to = tierStart();
  else if (move === 'bottom') to = tierEnd();
  else if (move === 'up' || move === 'down') {
    const same = list.map((t, i) => ({ t, i })).filter(({ t }) => t.state === me.state);
    const neighbour = move === 'up' ? same.filter(({ i }) => i < from).pop() : same.find(({ i }) => i >= from);
    if (!neighbour) return null;
    to = move === 'up' ? neighbour.i : neighbour.i + 1;
  } else {
    const ref = 'before' in move ? move.before : move.after;
    const i = list.findIndex((t) => t.id === ref);
    if (i < 0) return `No task ${ref} on this project.`;
    to = 'before' in move ? i : i + 1;
  }
  // The tier its new neighbours imply: below a lower-tier task it drops to that tier, above a higher one it rises.
  const prev = list[to - 1];
  const next = list[to];
  const tier = prev && prev.importance < me.importance ? prev.importance : next && next.importance > me.importance ? next.importance : me.importance;
  if (tier !== me.importance && actor === 'agent') {
    return `That would move ${taskRef(task)} into the ${LEVEL[tier]} tier. The queue is ordered by importance first; to change its tier, use set_importance with a reason.`;
  }
  list.splice(to, 0, me);
  tx(() => {
    list.forEach((t, i) => run('UPDATE tasks SET position = ? WHERE id = ?', i + 1, t.id));
    if (actor === 'user') {
      if (tier !== me.importance) applyImportance(task.project_id, 'task', getTask(task.id)!, tier, task.importance_reason ?? '', { author: 'user', name: 'You' });
      run('UPDATE tasks SET importance_pinned = 1 WHERE id = ?', task.id);
    }
    run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), task.id);
  });
  touchProject(task.project_id);
  return null;
}

// ---------- views ----------

export function previewRow(p: Row): Row {
  return withFeedback({ id: p.id, project_id: p.project_id, kind: p.kind, title: p.title, caption: p.caption, file: p.file, content: p.content, agent_id: p.agent_id, task_id: p.task_id, created_at: p.created_at });
}

/** The most recent preview(s) of a task: the last one and any posted with it (within two minutes). */
export function latestPreviews(taskId: string): Row[] {
  const recent = all('SELECT * FROM previews WHERE task_id = ? ORDER BY created_at DESC LIMIT 6', taskId);
  if (!recent.length) return [];
  return recent.filter((p) => recent[0].created_at - p.created_at < 2 * 60 * 1000).reverse().map(previewRow);
}

/** A task row with what the Overview shows about it. */
export function taskView(t: Row): Row {
  const driver = t.driver_agent_id ? get('SELECT * FROM agents WHERE id = ?', t.driver_agent_id) : undefined;
  const doc = t.doc_id ? get('SELECT id, kind, title, status FROM docs WHERE id = ?', t.doc_id) : undefined;
  // Every goal or design the task implements: the main one (mirrored into doc_links) and any others.
  const docs = all("SELECT id, kind, title, status FROM docs WHERE id IN (SELECT doc_id FROM doc_links WHERE task_id = ? AND relation = 'implements')", t.id);
  const last = get("SELECT author, author_name, body, created_at FROM task_messages WHERE task_id = ? AND kind != 'state' ORDER BY id DESC LIMIT 1", t.id);
  const thumb = get('SELECT * FROM previews WHERE task_id = ? ORDER BY created_at DESC LIMIT 1', t.id);
  const needs = needsView(t.id);
  return {
    ...t,
    driver: driver ? (({ id, name, status, status_line, progress, checklist }) => ({ id, name, status, status_line, progress, checklist }))(agentView(driver)) : null,
    doc: doc ?? null,
    docs,
    last: last ?? null,
    thumb: thumb ? previewRow(thumb) : null,
    ...needs,
    ...unfiledNeed(t, needs.needs_response),
    attach_count: taskAttachmentCount(t.id),
    ...watchView(t),
    ...linkedViews(t),
    proposal: proposalSummary(t.id),
    holder: holderView(t),
  };
}

/**
 * A task that says it needs the user but has no open request: its status summary or the director's last post in its
 * thread asks something of the user (userasks.ts), or needs_from_user is set, while the task is active, waiting or
 * paused. Nothing shows under Needs response for it, so the row flags it. Derived, never stored.
 */
export function unfiledNeed(t: Row, openRequests: number): { waiting_on_user_without_request: boolean; unfiled_need: string | null } {
  const none = { waiting_on_user_without_request: false, unfiled_need: null };
  if (openRequests > 0 || !['active', 'waiting', 'paused'].includes(t.state)) return none;
  const post = get("SELECT body FROM task_messages WHERE task_id = ? AND author = 'director' AND kind = 'message' ORDER BY id DESC LIMIT 1", t.id)?.body ?? '';
  const said = t.needs_from_user || findUserAsks(t.status_summary ?? '')[0] || findUserAsks(post)[0];
  return said ? { waiting_on_user_without_request: true, unfiled_need: said } : none;
}

export function listTasks(projectId: string): Row[] {
  return all(`SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' ${QUEUE_ORDER}`, projectId).map(taskView);
}

/**
 * Separate tasks made from a discussion (discussion_tasks), beyond the one it became in place:
 * `discussions` are the rows a task came from (a discussion, or a task that was one), `tasks` the
 * tasks made from this row.
 */
export function linkedViews(t: Row): { discussions: Row[]; tasks: Row[] } {
  return {
    tasks: all('SELECT t.id, t.title, t.state, t.kind FROM discussion_tasks l JOIN tasks t ON t.id = l.task_id WHERE l.discussion_id = ? ORDER BY l.created_at', t.id),
    discussions: all('SELECT d.id, d.title, d.state, d.kind FROM discussion_tasks l JOIN tasks d ON d.id = l.discussion_id WHERE l.task_id = ? ORDER BY l.created_at', t.id),
  };
}

/** Whether a row was a discussion before (part of) its history: a discussion, or a task that became one in place. */
export const hasDiscussionEra = (t: Row) => isDiscussion(t) || t.became_task_at != null;

/** The discussion-era part of a row's timeline: all of a discussion's, or a converted task's before it became one. */
export function discussionEra(t: Row): Row[] {
  if (isDiscussion(t)) return taskTimeline(t.id);
  if (t.became_task_at == null) return [];
  return taskTimeline(t.id).filter((i) => i.ts < t.became_task_at);
}

/**
 * Everything about a task in time order: thread messages, state changes and
 * status summaries, questions and their answers, agents' questions to their managers,
 * previews and journal entries.
 */
export function taskTimeline(taskId: string): Row[] {
  const items: Row[] = [];
  const files = messageAttachments(taskId);
  const answerFiles = answerAttachments(taskId);
  for (const m of all('SELECT * FROM task_messages WHERE task_id = ? ORDER BY id', taskId)) {
    items.push({ key: `m${m.id}`, ts: m.created_at, type: m.kind, author: m.author, name: m.author_name, body: m.body, filed: m.event_id != null, interject: !!m.interject, attachments: files.get(m.id) ?? (m.event_id != null ? listAttachments('event', String(m.event_id)).map(attachmentView) : []) });
  }
  // Requests to the user (questions, permissions, team changes), each with its answer or outcome. A question's answer
  // is also the user's turn in the conversation, so it shows as their message.
  for (const i of all('SELECT inbox.*, agents.name AS agent_name FROM inbox LEFT JOIN agents ON agents.id = inbox.agent_id WHERE inbox.task_id = ?', taskId)) {
    items.push({ key: `q${i.id}`, ts: i.created_at, type: 'question', inbox_id: i.id, request: inboxView(i) });
    if (i.answered_at && (i.kind === 'question' || i.kind === 'action')) items.push({ key: `a${i.id}`, ts: i.answered_at, type: 'answer', title: i.title, status: i.status, body: i.answer, attachments: answerFiles.get(i.id) ?? [] });
  }
  // Questions and review requests between agents working on it (consults.ts), each as one row with its answer.
  for (const c of all('SELECT c.*, a.name AS asker_name, m.name AS manager_name FROM consults c LEFT JOIN agents a ON a.id = c.asker_id LEFT JOIN agents m ON m.id = c.manager_id WHERE c.task_id = ?', taskId)) {
    items.push({
      key: `c${c.id}`, ts: c.created_at, type: 'consult', kind: c.kind, asker: c.asker_name ?? 'An agent', manager: c.manager_name ?? 'its manager',
      question: c.question, status: c.status, answer: c.answer, verdict: c.verdict, answered_at: c.answered_at,
    });
  }
  for (const p of all('SELECT * FROM previews WHERE task_id = ?', taskId)) {
    items.push({ key: `p${p.id}`, ts: p.created_at, type: 'preview', preview: previewRow(p) });
  }
  for (const j of all('SELECT journal.*, agents.name AS agent_name FROM journal LEFT JOIN agents ON agents.id = journal.agent_id WHERE journal.task_id = ?', taskId)) {
    items.push({ key: `j${j.id}`, ts: j.ts, type: 'journal', kind: j.kind, title: j.title, body: j.body, name: j.agent_name ?? 'You' });
  }
  return items.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
}

export function taskDetail(taskId: string) {
  const t = getTask(taskId);
  if (!t) return null;
  const agents = all('SELECT * FROM agents WHERE task_id = ? OR id = ? ORDER BY created_at', t.id, t.driver_agent_id ?? '').map(agentView);
  // A task made separately from a discussion shows that discussion inline, read-only, from the origin row.
  const origins = isDiscussion(t)
    ? []
    : linkedViews(t).discussions.map((o) => {
        const row = getTask(o.id)!;
        return { id: row.id, title: row.title, kind: row.kind, state: row.state, timeline: discussionEra(row) };
      });
  const timeline = taskTimeline(t.id);
  return { task: taskView(t), agents, latest: latestPreviews(t.id), proposal: proposalView(t.id), timeline, origins, changes: recentChanges(timeline, t.became_task_at ?? 0) };
}

/** One line in a task's "What changed": `key` is the history entry it jumps to. */
export type Change = { key: string; ts: number; kind: string; text: string };

const firstLine = (s: string, max = 160) => {
  const line = String(s ?? '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/**
 * What counts as a notable change on a task, the one place to tune it: state and importance changes and other
 * Helm rows, Spec changes and proposed edits, decisions and milestones in the journal, new previews, requests to
 * the user and their answers, the user's interjections and managers' review verdicts. Routine chatter is left
 * out: ordinary thread messages, status summaries (shown on their own), status and note journal entries, and
 * agents' questions to their managers, and the "created this task" line.
 */
export function notableChange(i: Row): Change | null {
  const c = (kind: string, text: string, ts = i.ts, key = i.key): Change => ({ key, ts, kind, text: firstLine(text) });
  switch (i.type) {
    case 'state':
      // "X created this task as …" is always the oldest line and says nothing new.
      if (/ created this (task|discussion)/.test(i.body)) return null;
      return c(/importance/.test(i.body) ? 'importance' : 'state', i.body);
    case 'change':
      return c('spec', 'Changed the Spec');
    case 'proposal':
      return c('spec', 'Proposed an edit to the Spec');
    case 'message':
      return i.author === 'user' && i.interject ? c('interject', `You interjected: ${i.body}`) : null;
    case 'journal':
      return i.kind === 'decision' || i.kind === 'milestone' ? c(i.kind, `${i.kind === 'decision' ? 'Decision' : 'Milestone'}: ${i.title}`) : null;
    case 'preview':
      return c('preview', `New preview: ${i.preview.title}`);
    case 'question':
      return c('question', `${i.request?.agent_name ?? 'An agent'} asked you: ${i.request?.line || i.request?.title || 'a question'}`);
    case 'answer':
      return c('answer', `You ${i.status === 'dismissed' ? 'dismissed' : 'answered'}: ${i.title}`);
    case 'consult':
      if (i.kind !== 'review' || i.status !== 'answered' || !i.answered_at) return null;
      return c('review', `${i.manager} reviewed ${i.asker}'s work: ${i.verdict === 'accepted' ? 'accepted' : i.verdict === 'changes_needed' ? 'changes needed' : 'answered'}`, i.answered_at);
    default:
      return null;
  }
}

/** The newest notable changes since `since` (when a discussion became this task), newest first. */
export function recentChanges(timeline: Row[], since = 0, limit = 6): Change[] {
  return timeline
    .filter((i) => i.ts >= since)
    .map(notableChange)
    .filter((x): x is Change => !!x)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);
}

/** Plain-text list of tasks for agents. */
export function renderTasks(projectId: string): string {
  const tasks = listTasks(projectId);
  if (!tasks.length) return 'No tasks yet.';
  return tasks
    .map((t, i) => {
      const level = ['', 'Minor', 'Low', 'Medium', 'High', 'Critical'][t.importance] ?? '';
      const bits = [`${i + 1}. [${t.state}] ${t.title} ([[${t.id}]]${level && t.kind !== 'discussion' ? `, importance ${level}${t.importance_pinned ? ' pinned by the user' : ''}` : ''})`];
      if (t.importance_reason && t.importance >= 4) bits.push(`   why ${level}: ${t.importance_reason}`);
      const timing = timingText(t);
      if (timing) bits.push(`   timing: ${timing}`);
      if (t.origin === 'away') bits.push(`   found while the user was away: ${t.origin_note}`);
      if (t.driver) bits.push(`   driver: ${t.driver.name} (${t.driver.status})`);
      if (t.doc) bits.push(`   implements: ${t.doc.title} [[${t.doc.id}]]`);
      if (t.status_summary) bits.push(`   status: ${t.status_summary.replace(/\s+/g, ' ').slice(0, 300)}`);
      if (t.awaiting_review) bits.push(`   ${t.review_agent} finished it; awaiting your review: settle it (done with a status summary, or send it back)`);
      else if (t.stalled) bits.push('   stalled: nobody is working on it');
      if (t.needs_response) bits.push(`   needs response: ${t.needs_response} open request(s) to the user`);
      const proposal = renderProposal(t.id);
      if (proposal) bits.push(proposal.replace(/^/gm, '   '));
      return bits.join('\n');
    })
    .join('\n');
}

/** How many of a project's tasks say they need the user with nothing filed (see unfiledNeed). */
export function unfiledNeedsCount(projectId: string): number {
  return all("SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' AND state IN ('active', 'waiting', 'paused')", projectId).filter(
    (t) => unfiledNeed(t, Number(get("SELECT COUNT(*) AS n FROM inbox WHERE task_id = ? AND status = 'open'", t.id)?.n ?? 0)).waiting_on_user_without_request,
  ).length;
}
