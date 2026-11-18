import { all, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';
import { taskAttachmentCount } from './attachments.ts';
import { NOT_HOLDER, holderView, needsView } from './requests.ts';
import { STATE_LABEL, addTaskMessage, noteTaskState, createTask, getTask, hasDiscussionEra, isDiscussion, linkedViews, setTaskSummary } from './tasks.ts';
import type { Author } from './tasks.ts';
import { proposalSummary, renderProposal } from './pins.ts';

/**
 * Discussions: questions, ideas and open topics kept as findable threads. They are
 * rows in the tasks table with kind 'discussion', state open or settled, a one-line
 * summary (status_summary) and, once settled, a conclusion. The director files
 * exchanges from its general conversation into them. Turning one into a task changes the
 * row in place (kind 'task', became_task_at set), so the task's history starts with the
 * discussion; further tasks from it are separate rows linked through discussion_tasks.
 * A task that never started can be moved back to a discussion, also in place.
 */

const HELM: Author = { author: 'system', name: 'Helm' };

/** The server's default for how many quiet days make a discussion cold; HELM_COLD_DAYS overrides it (for testing, fractions allowed). */
export const DEFAULT_COLD_DAYS = Number(process.env.HELM_COLD_DAYS) > 0 ? Number(process.env.HELM_COLD_DAYS) : 14;
export const coldDays = (projectId: string): number => (get('SELECT cold_days FROM projects WHERE id = ?', projectId)?.cold_days as number | null) || DEFAULT_COLD_DAYS;

/**
 * The latest activity of any kind on a thread: a message from either side, a filing, a summary or state change
 * (these all move updated_at), a question or its answer, a preview, a journal entry, an attachment.
 */
function lastActive(d: Row): number {
  const times = [
    d.updated_at,
    get('SELECT MAX(created_at) AS t FROM task_messages WHERE task_id = ?', d.id)?.t,
    get('SELECT MAX(MAX(created_at), COALESCE(MAX(answered_at), 0)) AS t FROM inbox WHERE task_id = ?', d.id)?.t,
    get('SELECT MAX(created_at) AS t FROM previews WHERE task_id = ?', d.id)?.t,
    get('SELECT MAX(ts) AS t FROM journal WHERE task_id = ?', d.id)?.t,
  ];
  if (hasAttachments()) times.push(get('SELECT MAX(created_at) AS t FROM attachments WHERE task_id = ?', d.id)?.t);
  return Math.max(...times.map((t) => Number(t) || 0));
}
let attachmentsTable: boolean | undefined;
function hasAttachments(): boolean {
  if (attachmentsTable === undefined) {
    const cols = all("SELECT name FROM pragma_table_info('attachments')").map((c) => c.name);
    attachmentsTable = cols.includes('task_id') && cols.includes('created_at');
  }
  return attachmentsTable;
}

export function discussionView(d: Row, days = coldDays(d.project_id)): Row {
  const last_active = lastActive(d);
  const last = get("SELECT author, author_name, body, created_at FROM task_messages WHERE task_id = ? AND kind NOT IN ('state', 'spec') ORDER BY id DESC LIMIT 1", d.id);
  const messages = (get("SELECT COUNT(*) AS n FROM task_messages WHERE task_id = ? AND kind = 'message'", d.id)?.n as number) ?? 0;
  const needs = needsView(d.id);
  return {
    ...d,
    last: last ?? null,
    messages,
    ...needs,
    attach_count: taskAttachmentCount(d.id),
    ...linkedViews(d),
    proposal: proposalSummary(d.id),
    holder: holderView(d),
    last_active,
    // Derived, never stored: an open discussion nothing has happened on for the project's cold period. One that
    // needs the user's response is never cold.
    cold: isDiscussion(d) && d.state === 'open' && !needs.needs_response && Date.now() - last_active > days * 86_400_000,
  };
}

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Discussions by latest activity, optionally narrowed by state and a text search over title, summary,
 * conclusion and thread. A search also finds discussions that have since become tasks (kind 'task').
 */
/** Standing request holders with requests pending on the user: shown under Needs you, never as discussions. */
export function requestHolders(projectId: string): Row[] {
  return all("SELECT * FROM tasks WHERE project_id = ? AND requests_agent_id IS NOT NULL AND EXISTS (SELECT 1 FROM inbox i WHERE i.task_id = tasks.id AND i.status = 'open') ORDER BY updated_at DESC", projectId).map((d) => discussionView(d));
}

export function listDiscussions(projectId: string, opts: { q?: string; state?: string; limit?: number } = {}): Row[] {
  const words = (opts.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  // Request holders (an agent's standing requests holder, the old Inbox archive) are not discussions (requests.ts).
  const where = ['project_id = ?', words.length ? "(kind = 'discussion' OR became_task_at IS NOT NULL)" : "kind = 'discussion'", NOT_HOLDER()];
  const params: unknown[] = [projectId];
  if (opts.state === 'open' || opts.state === 'settled') {
    where.push('state = ?');
    params.push(opts.state);
  }
  for (const w of words) {
    // Every word must appear somewhere: title, summary, conclusion, or a message in its thread.
    where.push(
      "(title LIKE ? ESCAPE '\\' OR status_summary LIKE ? ESCAPE '\\' OR conclusion LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM task_messages m WHERE m.task_id = tasks.id AND m.body LIKE ? ESCAPE '\\'))",
    );
    params.push(like(w), like(w), like(w), like(w));
  }
  const limit = Math.max(1, Math.min(opts.limit ?? 500, 500));
  const days = coldDays(projectId);
  return all(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit}`, ...params).map((d) => discussionView(d, days));
}

const oneLine = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const day = (ts: number) => new Date(ts).toISOString().slice(0, 16).replace('T', ' ');

/** Plain-text list for agents. */
export function renderDiscussions(list: Row[], q?: string): string {
  if (!list.length) return q ? `No discussion matches "${q}".` : 'No discussions yet.';
  return list
    .map((d) => {
      if (!isDiscussion(d)) return `- [now a task, ${d.state}] ${d.title} [[${d.id}]]: this discussion became a task; its thread continues as the task's (task_post).`;
      const bits = [`- [${d.cold ? 'open, cold' : d.state}${d.needs_response ? ', needs response' : ''}] ${d.title} [[${d.id}]], last activity ${day(d.last_active ?? d.updated_at)}, ${d.messages} message(s)`];
      if (d.status_summary) bits.push(`  summary: ${oneLine(d.status_summary, 300)}`);
      if (d.state === 'settled' && d.conclusion) bits.push(`  conclusion: ${oneLine(d.conclusion, 300)}`);
      const proposal = renderProposal(d.id);
      if (proposal) bits.push(proposal.replace(/^/gm, '  '));
      if (d.tasks?.length) bits.push(`  led to: ${d.tasks.map((t: Row) => `${t.title} [[${t.id}]] (${t.state})`).join('; ')}`);
      return bits.join('\n');
    })
    .join('\n');
}

export function createDiscussion(projectId: string, input: { title: string; summary?: string; origin: 'user' | 'director' }, by: Author): Row {
  return createTask(projectId, { title: input.title, state: 'open', origin: input.origin, kind: 'discussion', status_summary: input.summary ?? '' }, by);
}

export function settleDiscussion(d: Row, conclusion: string, by: Author) {
  run("UPDATE tasks SET state = 'settled', conclusion = ?, updated_at = ? WHERE id = ?", conclusion, now(), d.id);
  // Proposed Spec edits still waiting in it are closed as not applied (server/specdiscuss.ts).
  run("UPDATE doc_proposals SET status = 'closed', decided_at = ? WHERE discussion_id = ? AND status = 'open'", now(), d.id);
  addTaskMessage(d, HELM, `${by.name} settled this discussion${conclusion ? `. Conclusion: ${conclusion}` : '.'}`, 'state');
}

export function reopenDiscussion(d: Row, by: Author, why = '') {
  run("UPDATE tasks SET state = 'open', updated_at = ? WHERE id = ?", now(), d.id);
  addTaskMessage(d, HELM, `${by.name} reopened this discussion${why ? `: ${why}` : '.'}`, 'state');
}

export { setTaskSummary as setDiscussionSummary };

/** What a task made from a discussion is about, by default: its summary, and its conclusion if settled. */
const defaultDescription = (d: Row) => [d.status_summary, d.conclusion && `Conclusion: ${d.conclusion}`].filter(Boolean).join('\n\n');

/**
 * Turn a discussion into a task in place: same row and id, so the thread, previews, journal, questions and
 * links stay. The discussion's summary and conclusion stay in the timeline (before became_task_at); the task
 * starts with no status summary.
 */
export function discussionToTask(d: Row, input: { state: 'planning' | 'waiting'; title?: string; description?: string; origin: 'user' | 'director' | 'doc' }, by: Author): Row {
  tx(() => {
    const at = now();
    const kept = (kind: string, body: string) => !!get('SELECT 1 AS x FROM task_messages WHERE task_id = ? AND kind = ? AND instr(body, ?) > 0', d.id, kind, body);
    if (d.status_summary && !kept('summary', d.status_summary)) {
      run("INSERT INTO task_messages (task_id, author, author_name, kind, body, created_at) VALUES (?, 'system', 'Helm', 'summary', ?, ?)", d.id, d.status_summary, at - 1);
    }
    if (d.conclusion && !kept('state', d.conclusion)) {
      run("INSERT INTO task_messages (task_id, author, author_name, kind, body, created_at) VALUES (?, 'system', 'Helm', 'state', ?, ?)", d.id, `Conclusion: ${d.conclusion}`, at - 1);
    }
    const position = (get("SELECT MAX(position) AS p FROM tasks WHERE project_id = ? AND kind = 'task'", d.project_id)?.p ?? 0) + 1;
    run(
      "UPDATE tasks SET kind = 'task', state = ?, title = ?, description = ?, position = ?, origin = ?, status_summary = '', summary_at = NULL, became_task_at = ?, updated_at = ? WHERE id = ?",
      input.state, input.title?.trim() || d.title, (input.description ?? defaultDescription(d)).trim(), position, input.origin, at, at, d.id,
    );
    noteTaskState(d.id, null, input.state, at);
    run("INSERT INTO task_messages (task_id, author, author_name, kind, body, created_at) VALUES (?, 'system', 'Helm', 'state', ?, ?)",
      d.id, `Became a task: ${by.name} turned this ${STATE_LABEL[d.state]?.toLowerCase() ?? ''} discussion into a task, in ${STATE_LABEL[input.state]}.`, at);
  });
  touchProject(d.project_id);
  return getTask(d.id)!;
}

/**
 * One more task from a discussion that already became a task: a separate row that references it and shows its
 * discussion inline. A discussion is converted in place first, so it never stays open with tasks hanging off it.
 */
export function anotherTaskFrom(o: Row, input: { state: 'planning' | 'waiting'; title: string; description?: string; origin: 'user' | 'director' }, by: Author): Row {
  return tx(() => {
    const task = createTask(o.project_id, { title: input.title, description: (input.description ?? defaultDescription(o)).trim(), state: input.state, origin: input.origin }, by);
    run('INSERT OR IGNORE INTO discussion_tasks (discussion_id, task_id, created_at) VALUES (?,?,?)', o.id, task.id, now());
    addTaskMessage(task, HELM, `Came from the discussion "${o.title}".`, 'state');
    addTaskMessage(o, HELM, `${by.name} made another task from this discussion: "${task.title}" (${STATE_LABEL[input.state]}).`, 'state');
    return getTask(task.id)!;
  });
}

export const canMakeAnotherTask = (t: Row) => !isDiscussion(t) && hasDiscussionEra(t);

/** Why a task cannot become a discussion, or null if it can: only before any work started on it. */
export function cannotBecomeDiscussion(t: Row): string | null {
  if (isDiscussion(t)) return 'It is already a discussion.';
  if (!['planning', 'waiting'].includes(t.state)) return `Work on it has started or ended (it is ${STATE_LABEL[t.state]}); only a Planning or Waiting task can become a discussion.`;
  if (t.driver_agent_id || get('SELECT 1 AS x FROM agents WHERE task_id = ? LIMIT 1', t.id)) return 'An agent has been assigned to it, so work has started.';
  // A discussion is either a discussion or the task it became; it never stays one with tasks hanging off it.
  if (linkedViews(t).tasks.length) return 'Other tasks were made from its discussion; it stays a task so they keep pointing at work, not at an open topic.';
  return null;
}

/** Move a task that never started into the discussions, in place: same id, same thread. */
export function taskToDiscussion(t: Row, by: Author) {
  run("UPDATE tasks SET kind = 'discussion', state = 'open', position = 0, driver_agent_id = NULL, became_task_at = NULL, updated_at = ? WHERE id = ?", now(), t.id);
  addTaskMessage(getTask(t.id)!, HELM, `${by.name} moved this from the tasks to the discussions (it was ${STATE_LABEL[t.state]}).`, 'state');
}

// ---------- filing an exchange from the general conversation ----------

const TAGGED = /^<(agent-report|user-answer|helm-note|task-message|discussion-message|toolbox-question)[\s>]/;

/** A message the user typed in the general conversation (not a reply in a thread, an answer to a request or a note). */
export function isPlainUserMessage(e: Row): boolean {
  if (e.kind !== 'inbound') return false;
  const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
  return data?.from?.kind === 'user' && !TAGGED.test(String(data.text ?? ''));
}

/**
 * The user messages an exchange answers: by default those that arrived since the agent's
 * last end-of-turn reply; or the given conversation event ids.
 */
export function userMessagesFor(agentId: string, eventIds?: number[]): { events: Row[]; error?: string } {
  if (eventIds?.length) {
    const events = eventIds.map((id) => get('SELECT * FROM events WHERE id = ? AND agent_id = ?', id, agentId));
    const bad = eventIds.filter((_, i) => !events[i] || !isPlainUserMessage(events[i]!));
    if (bad.length) return { events: [], error: `Event id ${bad.join(', ')} is not a message the user sent you in the general conversation. ${recentUserMessages(agentId)}` };
    return { events: (events as Row[]).sort((a, b) => a.id - b.id) };
  }
  const lastReply = get("SELECT MAX(id) AS id FROM events WHERE agent_id = ? AND kind = 'result'", agentId)?.id ?? 0;
  const events = all("SELECT * FROM events WHERE agent_id = ? AND kind = 'inbound' AND id > ? ORDER BY id", agentId, lastReply).filter(isPlainUserMessage);
  if (!events.length) return { events: [], error: `The user has sent you nothing in the general conversation since your last reply. To file an earlier message, pass its event id. ${recentUserMessages(agentId)}` };
  return { events };
}

function recentUserMessages(agentId: string): string {
  const recent = all("SELECT * FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id DESC LIMIT 60", agentId).filter(isPlainUserMessage).slice(0, 8);
  if (!recent.length) return '';
  return `Recent user messages:\n${recent.map((e) => `- event ${e.id} (${day(e.ts)}): ${oneLine(JSON.parse(e.data).text, 160)}`).join('\n')}`;
}

/** Copy the user's message(s) and the agent's answer into a discussion's thread. */
export function fileExchange(d: Row, agent: Row, events: Row[], answer: string): { filed: number; skipped: number } {
  let filed = 0;
  let skipped = 0;
  for (const e of events) {
    if (get('SELECT 1 AS x FROM task_messages WHERE task_id = ? AND event_id = ?', d.id, e.id)) {
      skipped++;
      continue;
    }
    const text = String(JSON.parse(e.data).text ?? '');
    // Keep the original time so the thread reads in order.
    run("INSERT INTO task_messages (task_id, author, author_name, kind, body, created_at, event_id) VALUES (?, 'user', 'You', 'message', ?, ?, ?)", d.id, text, e.ts, e.id);
    filed++;
  }
  if (answer.trim()) addTaskMessage(d, { author: 'director', name: agent.name }, answer.trim());
  run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), d.id);
  touchProject(d.project_id);
  return { filed, skipped };
}

/** For the conversation panel: which of the user's messages were filed under which discussion. */
export function filedLinks(projectId: string): Row[] {
  return all(
    "SELECT m.event_id, t.id, t.title, t.kind FROM task_messages m JOIN tasks t ON t.id = m.task_id WHERE t.project_id = ? AND m.event_id IS NOT NULL ORDER BY m.event_id DESC LIMIT 1000",
    projectId,
  );
}
