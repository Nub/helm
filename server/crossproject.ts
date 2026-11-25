import { all, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { getProject, touchProject } from './store.ts';
import { addTaskMessage, createTask, getTask, taskRef } from './tasks.ts';
import type { Author } from './tasks.ts';
import { createRequest, repeatedRequest } from './requests.ts';
import { rootAgent, sendToAgent } from './agents.ts';

/**
 * Directors talking across projects (message_project). A conversation is a pair of discussions, one in each project,
 * linked through `project_threads` (one row per side). A message is posted in the sender's side and delivered to the
 * peer's side, which is created on first delivery, titled with the subject and marked "From <sender>"; the peer's
 * director is woken with it in a <project-message> tag. Replies go back the same way into the same pair.
 *
 * A message asking the other project to do work (create, change or schedule a task, or change its code) is a work
 * request: it is posted only in the sender's side, with a request to the user there (Allow / Decline). Nothing reaches
 * the peer until Allow; then it is delivered marked work="allowed" and the peer's director plans it its own way.
 * Decline tells the sender (its <user-answer>). A director never creates tasks or starts agents in another project.
 */

export const ALLOW = 'Allow';
export const DECLINE = 'Decline';

const HELM: Author = { author: 'system', name: 'Helm' };
/** How a message from another project's director shows in a thread: its own author kind, never the local director. */
const fromPeer = (project: Row): Author => ({ author: 'project', name: `${project.name} director` });

/** A project by id or name (case-insensitive), not archived. */
export function resolveProject(ref: string): Row | undefined {
  const r = ref.trim().replace(/^\[\[|\]\]$/g, '');
  return get('SELECT * FROM projects WHERE archived = 0 AND (id = ? OR lower(name) = lower(?)) ORDER BY id = ? DESC LIMIT 1', r, r, r);
}

/** This side's pairing row, if the discussion is a cross-project thread. */
export const threadRow = (taskId: string): Row | undefined => get('SELECT * FROM project_threads WHERE task_id = ?', taskId);

/** For views: who the thread is with, which way it started, and whether a reply is unread. */
export function peerView(taskId: string): { project_id: string; name: string; from: boolean; unread: boolean } | null {
  const r = threadRow(taskId);
  if (!r) return null;
  return {
    project_id: r.peer_project_id,
    name: String(getProject(r.peer_project_id)?.name ?? 'another project'),
    from: !r.started_here,
    unread: !!r.last_in_at && r.last_in_at > (r.seen_at ?? 0),
  };
}

/** Cross-project threads in a project with a message from the peer the user has not opened since. */
export function unreadThreads(projectId: string): { id: string; title: string; peer: string }[] {
  return all(
    `SELECT t.id, t.title, p.name AS peer FROM project_threads r JOIN tasks t ON t.id = r.task_id LEFT JOIN projects p ON p.id = r.peer_project_id
     WHERE r.project_id = ? AND r.last_in_at IS NOT NULL AND r.last_in_at > COALESCE(r.seen_at, 0) ORDER BY r.last_in_at DESC LIMIT 5`,
    projectId,
  ).map((r) => ({ id: String(r.id), title: String(r.title), peer: String(r.peer ?? '') }));
}

/** The user opened the thread: its replies are read. Returns whether anything changed. */
export function markSeen(taskId: string): boolean {
  const r = threadRow(taskId);
  if (!r || !r.last_in_at || r.last_in_at <= (r.seen_at ?? 0)) return false;
  run('UPDATE project_threads SET seen_at = ? WHERE task_id = ?', now(), taskId);
  touchProject(r.project_id);
  return true;
}

/** Open the side again if it was closed or went quiet: a new message is new activity. */
function reopen(t: Row) {
  if (t.kind === 'discussion' && t.state !== 'open') run("UPDATE tasks SET state = 'open', stale_at = NULL WHERE id = ?", t.id);
}

/** The sender's side for a message: the thread replied to, else an open one with the same peer and subject, else a new one. */
function ownSide(from: Row, to: Row, subject: string, replyTo: string | undefined, by: Author): Row | { error: string } {
  if (replyTo) {
    const t = getTask(replyTo.replace(/^\[\[|\]\]$/g, ''));
    const r = t ? threadRow(t.id) : undefined;
    if (!t || t.project_id !== from.id || !r) return { error: `${replyTo} is not a cross-project thread of this project.` };
    if (r.peer_project_id !== to.id) return { error: `${taskRef(t)} is a thread with ${getProject(r.peer_project_id)?.name}, not ${to.name}.` };
    return t;
  }
  const found = get(
    "SELECT t.* FROM project_threads r JOIN tasks t ON t.id = r.task_id WHERE r.project_id = ? AND r.peer_project_id = ? AND t.kind = 'discussion' AND t.state != 'archived' AND lower(t.title) = lower(?) ORDER BY r.created_at DESC LIMIT 1",
    from.id, to.id, subject,
  );
  if (found) return found;
  return tx(() => {
    const t = createTask(from.id, { title: subject, state: 'open', origin: 'director', kind: 'discussion', status_summary: `With ${to.name}` }, by);
    run('INSERT INTO project_threads (task_id, project_id, peer_project_id, started_here, created_at) VALUES (?,?,?,1,?)', t.id, from.id, to.id, now());
    return t;
  });
}

/** The peer's side of a thread, created on first delivery and linked both ways. */
function peerSide(own: Row, from: Row, to: Row): Row {
  const r = threadRow(own.id)!;
  const existing = r.peer_task_id ? getTask(r.peer_task_id) : undefined;
  if (existing) return existing;
  return tx(() => {
    const t = createTask(to.id, { title: own.title, state: 'open', origin: 'director', kind: 'discussion', status_summary: `From ${from.name}` }, HELM);
    run('INSERT INTO project_threads (task_id, project_id, peer_project_id, peer_task_id, started_here, created_at) VALUES (?,?,?,?,0,?)', t.id, to.id, from.id, own.id, now());
    run('UPDATE project_threads SET peer_task_id = ? WHERE task_id = ?', t.id, own.id);
    return t;
  });
}

/** Post a message in the peer's side and wake its director. Returns the peer's side. */
async function deliver(own: Row, from: Row, to: Row, body: string, work: boolean): Promise<Row> {
  const side = peerSide(own, from, to);
  reopen(side);
  addTaskMessage(side, fromPeer(from), body);
  run('UPDATE project_threads SET last_in_at = ? WHERE task_id = ?', now(), side.id);
  touchProject(to.id);
  const title = String(side.title).replace(/"/g, "'");
  const tag = `<project-message discussion="${side.id}" title="${title}" from="${String(from.name).replace(/"/g, "'")}"${work ? ' work="allowed"' : ''}>`;
  const how = work
    ? `The user allowed this work request from ${from.name}. Plan it in this project your own way (create_task here as usual) and answer ${from.name} with message_project reply_to "${side.id}".`
    : `Answer with message_project (project "${from.name}", reply_to "${side.id}"); task_post there only notes it for the user here. Asking ${from.name} to do work needs work: true.`;
  await sendToAgent(rootAgent(to).id, `${tag}\n${body}\n\n(${how})\n</project-message>`, { kind: 'agent', name: `${from.name} director` }, [], false);
  return side;
}

const withLinks = (message: string, links?: string[]) => (links?.length ? `${message.trim()}\n\nLinks:\n${links.map((l) => `- ${l}`).join('\n')}` : message.trim());

/** message_project: talk to another project's director, or ask it for work (through the user). */
export async function messageProject(
  agent: Row,
  input: { project: string; subject: string; message: string; links?: string[]; reply_to?: string; work?: boolean; why?: string },
): Promise<{ text: string; error?: boolean }> {
  const from = getProject(agent.project_id);
  if (!from) return { text: 'No project.', error: true };
  const to = resolveProject(input.project);
  if (!to) {
    const names = all('SELECT name FROM projects WHERE archived = 0 AND id != ? ORDER BY position, created_at', from.id).map((p) => p.name).join(', ');
    return { text: `No project "${input.project}". Projects: ${names || 'none'}.`, error: true };
  }
  if (to.id === from.id) return { text: 'That is this project: use task_post or a discussion here.', error: true };
  if (input.work && !input.why?.trim()) return { text: 'A work request says why (why): the user decides on it.', error: true };
  const by: Author = { author: 'director', name: agent.name, id: agent.id };
  const own = ownSide(from, to, input.subject.trim(), input.reply_to, by);
  if ('error' in own) return { text: own.error, error: true };
  reopen(own);
  const body = withLinks(input.message, input.links);

  if (input.work) {
    const title = `${from.name} asks ${to.name}: ${own.title}`.slice(0, 160);
    const text = `**${from.name}** asks **${to.name}** to do work.\n\n**What:** ${body}\n\n**Why:** ${input.why!.trim()}\n\nAllow: ${to.name}'s director gets it and plans it there its own way. Decline: nothing reaches ${to.name}.`;
    const again = repeatedRequest(own.id, 'question', title, text);
    if (again) return { text: `A work request for this is already open on ${taskRef(own)}: withdraw it first to change it.`, error: true };
    addTaskMessage(own, by, `Work request to ${to.name}, waiting for the user's Allow:\n\n${body}`);
    const { id } = createRequest({
      projectId: from.id, agentId: agent.id, kind: 'question', title, body: text,
      options: [{ label: ALLOW, detail: `${to.name}'s director plans it in ${to.name}` }, { label: DECLINE, detail: `Nothing is sent to ${to.name}` }],
      payload: { recommendation: '', xwork: { from: from.id, to: to.id, own: own.id, body } },
      importance: 3, blocking: false, task: own,
    });
    return { text: `Filed as a work request (request ${id}) on ${taskRef(own)}. Nothing reaches ${to.name} until the user allows it; their answer comes to you.` };
  }

  addTaskMessage(own, by, body);
  const side = await deliver(own, from, to, body, false);
  return { text: `Sent to ${to.name}'s director (their thread ${side.id}); its replies arrive in ${taskRef(own)}.` };
}

/**
 * The user answered a work request (answers.ts). Allow delivers it; Decline, or a note alone (it never allows), leaves
 * the peer untouched. Returns a line added to the sender's <user-answer>, or '' when it is not a work request.
 */
export async function onWorkAnswer(item: Row, choice: string | undefined): Promise<string> {
  const p = JSON.parse(item.payload || '{}').xwork;
  if (!p) return '';
  const own = getTask(p.own);
  const from = getProject(p.from);
  const to = getProject(p.to);
  if (!own || !from || !to) return '\n(The thread or a project is gone: nothing was sent.)';
  if (choice === ALLOW) {
    addTaskMessage(own, HELM, `The user allowed the work request: sent to ${to.name}.`, 'state');
    await deliver(own, from, to, p.body, true);
    return `\nSent to ${to.name}'s director, who plans it there; its replies arrive in ${taskRef(own)}.`;
  }
  addTaskMessage(own, HELM, `The user declined the work request: nothing was sent to ${to.name}.`, 'state');
  return `\nDeclined: nothing was sent to ${to.name}.`;
}

/** Why a director's create_task naming another project is refused, or null. */
export function crossProjectTaskRefusal(projectId: string, named: string | undefined): string | null {
  if (!named?.trim()) return null;
  const p = resolveProject(named);
  if (p && p.id === projectId) return null;
  return `create_task makes tasks in this project only. To ask ${p ? p.name : `"${named}"`} for work, send a work request: message_project with work: true and why; the user decides, and its director plans it there. Nothing was created.`;
}

/**
 * The user's rule: cross-project work starts only with their approval. In a director's turn started by another
 * project's message the user has not allowed (a <project-message> without work="allowed"), making or scheduling work
 * is refused: returns why, or null. A turn that also carries an allowed request may plan it.
 */
export function unapprovedWorkRefusal(agentId: string): string | null {
  const last = get("SELECT MAX(id) AS id FROM events WHERE agent_id = ? AND kind = 'result'", agentId)?.id ?? 0;
  let from: string | null = null;
  for (const e of all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' AND id > ? ORDER BY id", agentId, last)) {
    const head = /^<project-message\b([^>]*)>/.exec(String(JSON.parse(e.data || '{}').text ?? ''))?.[1];
    if (head === undefined) continue;
    if (/\bwork="allowed"/.test(head)) return null;
    from ??= /\bfrom="([^"]*)"/.exec(head)?.[1] ?? 'another project';
  }
  return from
    ? `This came from ${from} without the user's approval: reply asking them to send it as a work request (work: true), or ask your user. Nothing was changed.`
    : null;
}
