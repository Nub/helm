import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { getAgent, inboxView, onTouch, touchProject } from './store.ts';
import { notifyRequest, notifyRequests, safe } from './notify.ts';
import { createTask, getTask, taskRef } from './tasks.ts';
import { formatRequestText, splitAction } from './reqformat.ts';
import type { Author } from './tasks.ts';

/**
 * Requests to the user: agents' questions (ask_user), permission requests (the SDK permission callback) and
 * team-change approvals. They are rows in `inbox`, which keeps each request and its answer, and every one has a
 * home: the task or discussion it concerns (inbox.task_id). A task or discussion with at least one open request
 * "needs response"; that is derived from the rows, never stored, so answering or dismissing a request (or Helm
 * dismissing permission requests on restart) clears it by itself.
 *
 * Where a request lands when nothing names a task:
 * - question or action: the asking agent's task; else a new discussion titled from the question.
 * - permission and agent_error: the agent's task; else that agent's standing "Requests from <name>" discussion
 *   (tasks.requests_agent_id), reused while it is open.
 * - structure and any other kind: a new discussion titled from the request.
 */

/** action: something the user must do outside Helm ("To do"), answered Done or Can't / not yet. */
/** agent_error: an agent stopped with an error (agenterrors.ts), answered Resume, Ask the director or Close the agent. */
export type RequestKind = 'question' | 'action' | 'permission' | 'structure' | 'agent_error';

/** The answers an action request takes. */
export const ACTION_CHOICES = ['Done', "Can't / not yet"] as const;

const byAgent = (agent: Row | undefined): Author => (agent ? { author: 'director', name: agent.name, id: agent.id } : { author: 'system', name: 'Helm' });

/**
 * The standing holder of an agent's permission requests while it has no task, created on demand. It is plumbing, not a
 * discussion: it is never listed among discussions (isRequestHolder), its pending requests show under Needs you with
 * the agent's name and what it is doing, and it is settled whenever nothing in it is pending (settleIdleHolders),
 * reopened by the next request.
 */
function standingDiscussion(projectId: string, agent: Row): Row {
  const found = get("SELECT * FROM tasks WHERE requests_agent_id = ? AND kind = 'discussion' ORDER BY created_at DESC LIMIT 1", agent.id);
  if (found) {
    if (found.state !== 'open') run("UPDATE tasks SET state = 'open', updated_at = ? WHERE id = ?", now(), found.id);
    return getTask(found.id)!;
  }
  const d = createTask(projectId, {
    title: `Requests from ${agent.name}`,
    state: 'open',
    origin: 'director',
    kind: 'discussion',
    status_summary: `Permission requests from ${agent.name} while it is not working on a task.`,
  }, byAgent(agent));
  run('UPDATE tasks SET requests_agent_id = ? WHERE id = ?', agent.id, d.id);
  return getTask(d.id)!;
}

/** Holders of requests that are not discussions: an agent's standing requests holder, and the old Inbox archive. */
export const isRequestHolder = (t: Row) => t.requests_agent_id != null || !!t.inbox_archive;
/** SQL condition (on tasks, optionally aliased) leaving request holders out of anything listed as discussions. */
export const NOT_HOLDER = (alias = '') => `${alias}requests_agent_id IS NULL AND ${alias}inbox_archive = 0`;

/** Statuses of a request still waiting on someone (triage.ts PENDING): the user, the director or the check. */
const PENDING_SQL = "('open', 'director', 'check')";

/**
 * Settle every open standing holder with nothing pending in it (quietly: no thread note; the next request reopens it).
 * Runs after every change to a project (store.ts onTouch) and at startup. Returns how many it settled.
 */
export function settleIdleHolders(projectId?: string): number {
  const res = run(
    `UPDATE tasks SET state = 'settled' WHERE requests_agent_id IS NOT NULL AND kind = 'discussion' AND state = 'open' ${projectId ? 'AND project_id = ?' : ''}
       AND NOT EXISTS (SELECT 1 FROM inbox i WHERE i.task_id = tasks.id AND i.status IN ${PENDING_SQL})`,
    ...(projectId ? [projectId] : []),
  );
  return Number(res.changes);
}
onTouch((projectId) => settleIdleHolders(projectId));

/** Who a holder's requests are from, for Needs you: the agent's name and what it is doing (its task, else its role). */
export function holderView(t: Row): Row | null {
  if (t.requests_agent_id == null) return null;
  const a = get('SELECT id, name, role_id, task_id, status FROM agents WHERE id = ?', t.requests_agent_id);
  if (!a) return { agent_id: t.requests_agent_id, agent_name: String(t.title).replace(/^Requests from /, ''), context: '' };
  const task = a.task_id ? get('SELECT id, title FROM tasks WHERE id = ?', a.task_id) : undefined;
  const role = get('SELECT structure FROM projects WHERE id = ?', t.project_id);
  let roleName = a.role_id;
  try {
    roleName = JSON.parse(role?.structure ?? '{}').roles?.find((r: Row) => r.id === a.role_id)?.name ?? a.role_id;
  } catch {}
  return { agent_id: a.id, agent_name: a.name, task_id: task?.id ?? null, context: task ? `working on ${task.title}` : `${roleName}, no task` };
}

/** Where a request belongs: the task named, else as described above. Creates a discussion when needed. */
/** `askedAt`: for an old request given a home later, the agent's task counts only if it existed by then. */
export function homeFor(projectId: string, agent: Row | undefined, kind: string, title: string, named?: Row, askedAt?: number): Row {
  if (named) return named;
  const own = agent?.task_id ? getTask(agent.task_id) : undefined;
  const then = !own || askedAt === undefined || own.created_at <= askedAt;
  if (own && then && own.project_id === projectId && (kind === 'question' || kind === 'action' || kind === 'permission' || kind === 'agent_error')) return own;
  if ((kind === 'permission' || kind === 'agent_error') && agent) return standingDiscussion(projectId, agent);
  return createTask(projectId, { title: title.slice(0, 160), state: 'open', origin: 'director', kind: 'discussion' }, byAgent(agent));
}

/** File a request in its home. Returns the new inbox id and the home. */
export function createRequest(input: {
  projectId: string;
  agentId: string | null;
  kind: RequestKind;
  title: string;
  body: string;
  options?: unknown[];
  payload?: Record<string, unknown>;
  importance: number;
  blocking: boolean;
  task?: Row;
  /** 'open' (the user answers), or for a permission request triage hands to the director ('director') or the independent check ('check'). */
  status?: 'open' | 'director' | 'check';
  /** No phone notification of its own (the disk guard sent one already). */
  silent?: boolean;
}): { id: string; home: Row; held: boolean } {
  let held = false;
  const out = tx(() => {
    const agent = input.agentId ? getAgent(input.agentId) : undefined;
    const home = homeFor(input.projectId, agent, input.kind, input.title, input.task);
    const id = newId('in');
    // Filed by an agent in the middle of its turn: held until the turn ends (releaseHeld), so the user sees only the
    // final form, in one notification. Permission prompts and agent errors stop work and are never held.
    held = !!agent && agent.status === 'working' && HOLDABLE.includes(input.kind) && (input.status ?? 'open') === 'open';
    run(
      'INSERT INTO inbox (id, project_id, agent_id, kind, title, body, options, payload, importance, blocking, created_at, task_id, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, input.projectId, input.agentId, input.kind, input.title, input.body,
      JSON.stringify(input.options ?? []), JSON.stringify(input.payload ?? {}), input.importance, input.blocking ? 1 : 0, now(), home.id, held ? 'held' : input.status ?? 'open',
    );
    // New activity: it sorts up among discussions. A discussion's revisit reminder is not activity (discrevisit.ts).
    if (!(input.payload as Row | undefined)?.revisit) run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), home.id);
    return { id, home };
  });
  touchProject(input.projectId);
  // A phone notification (server/notify.ts); asynchronous, and it cannot fail the request. A held one is notified
  // when it is released, with the rest of its turn's.
  if (!input.silent && !held) safe(() => requestNotices.one(out.id));
  return { ...out, held };
}

/** How requests reach the phone (notify.ts); tests replace these. */
export const requestNotices = { one: (id: string) => notifyRequest(id), many: (ids: string[]) => notifyRequests(ids) };

/** Kinds held until the filing agent's turn ends: what the user answers in their own time. */
const HOLDABLE: string[] = ['question', 'action', 'structure'];

/**
 * The agent's turn ended: its held requests are shown now, as they are (their time is when they were shown), with one
 * phone notification for the lot. Returns their ids.
 */
export function releaseHeld(agentId: string): string[] {
  const rows = all("SELECT id, project_id FROM inbox WHERE agent_id = ? AND status = 'held' ORDER BY created_at", agentId);
  if (!rows.length) return [];
  const at = now();
  tx(() => {
    for (const r of rows) run("UPDATE inbox SET status = 'open', created_at = ? WHERE id = ? AND status = 'held'", at, r.id);
  });
  for (const p of new Set(rows.map((r) => r.project_id as string))) touchProject(p);
  const ids = rows.map((r) => r.id as string);
  safe(() => requestNotices.many(ids));
  return ids;
}

/** Held requests untouched this long are final: shown even while the agent's turn goes on (a director's runs long). */
export const QUIET_MS = 3 * 60_000;

/** An agent's held requests none of which was filed, replaced or withdrawn for QUIET_MS: shown now. Timer side. */
export function releaseQuiet(at = now()): number {
  const agents = all("SELECT agent_id FROM inbox WHERE status = 'held' GROUP BY agent_id HAVING MAX(created_at) <= ?", at - QUIET_MS);
  let n = 0;
  for (const a of agents) n += releaseHeld(a.agent_id).length;
  return n;
}

/** Held requests whose agent is no longer mid-turn (its process ended without a result): shown now. Timer side. */
export function releaseStale(): number {
  const agents = all("SELECT DISTINCT i.agent_id FROM inbox i LEFT JOIN agents a ON a.id = i.agent_id WHERE i.status = 'held' AND (a.id IS NULL OR a.status != 'working')");
  let n = 0;
  for (const a of agents) n += releaseHeld(a.agent_id).length;
  return n;
}

/**
 * Withdraw a request: one not shown yet is dropped as if never filed; one shown is closed as withdrawn with the
 * reason (the thread shows it). A shown request never changes: to change one, withdraw it and file a new one.
 * Returns an error, or null.
 */
export function withdrawRequest(id: string, reason: string): string | null {
  const r = get('SELECT * FROM inbox WHERE id = ?', id);
  if (!r) return `No request ${id}.`;
  if (r.status === 'held') {
    tx(() => {
      run('DELETE FROM inbox WHERE id = ?', id);
      // A withdrawal touches the agent's other held requests: the quiet spell starts again (releaseQuiet).
      run("UPDATE inbox SET created_at = ? WHERE agent_id = ? AND status = 'held'", now(), r.agent_id);
      needsAnswered(id);
      run('UPDATE proposal_rounds SET request_id = NULL WHERE request_id = ?', id);
    });
    return null;
  }
  // Answered "not now" with a reminder pending (reminders.ts): withdrawing it cancels the reminder.
  if (r.status !== 'open') {
    const rem = get("SELECT id FROM request_reminders WHERE request_id = ? AND status = 'pending'", id);
    if (!rem) return `Request ${id} is already ${r.status}.`;
    run("UPDATE request_reminders SET status = 'cancelled', reason = ?, done_at = ? WHERE id = ?", `withdrawn: ${reason}`.slice(0, 200), now(), rem.id);
    touchProject(r.project_id);
    return null;
  }
  tx(() => {
    run("UPDATE inbox SET status = 'withdrawn', answer = ?, answered_at = ? WHERE id = ? AND status = 'open'", reason.replace(/\s+/g, ' ').trim().slice(0, 200), now(), id);
    needsAnswered(id);
  });
  touchProject(r.project_id);
  return null;
}

/** An open or held request on the task that a new one would repeat: the same kind and title, or the same text. */
export function repeatedRequest(taskId: string, kind: string, title: string, body: string): Row | undefined {
  return get(
    "SELECT * FROM inbox WHERE task_id = ? AND kind = ? AND status IN ('open', 'held') AND (lower(trim(title)) = lower(trim(?)) OR trim(body) = trim(?)) LIMIT 1",
    taskId, kind, title, body,
  );
}

/** For the agent: where its request landed. */
export const landedOn = (home: Row) => `It is on ${taskRef(home)}; the user sees and answers it there.`;

// ---------- needs response, derived ----------

/** A task or discussion's open requests, blocking first, then most important, then oldest. */
export function openRequests(taskId: string): Row[] {
  return all(
    "SELECT inbox.*, agents.name AS agent_name FROM inbox LEFT JOIN agents ON agents.id = inbox.agent_id WHERE inbox.task_id = ? AND inbox.status = 'open' ORDER BY inbox.blocking DESC, inbox.importance DESC, inbox.created_at",
    taskId,
  ).map(inboxView);
}

/** What a row of the Tasks or Discussions list shows about requests waiting on the user. */
export function needsView(taskId: string): { needs_response: number; needs_blocking: boolean; requests: Row[] } {
  const requests = openRequests(taskId);
  return { needs_response: requests.length, needs_blocking: requests.some((r) => r.blocking), requests };
}

/**
 * Give every request a home, at startup, for rows from before requests had to have one or whose task was
 * deleted; an old id that is now an alias moves to the row it resolves to. Open requests get a home as a new
 * one would (the agent's task only if it existed when they were asked). Answered and dismissed ones, which only
 * the old Inbox showed, go to one settled discussion per project, "Earlier requests", so their history stays
 * readable: the agent's task now may be unrelated to what was asked then.
 * Idempotent (a homed row is not picked again), one transaction.
 */
export function homeRequests(): { open: number; handled: number; moved: number; discussions: number } {
  // Requests allowed automatically (triage.ts) by an agent with no task stay without a home: they are only a record.
  const rows = all("SELECT * FROM inbox WHERE (task_id IS NULL OR task_id NOT IN (SELECT id FROM tasks)) AND (decided_by IS NULL OR decided_by != 'auto') ORDER BY created_at");
  const counts = { open: 0, handled: 0, moved: 0, discussions: 0 };
  if (!rows.length) return counts;
  const before = (get("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'discussion'")?.n as number) ?? 0;
  tx(() => {
    for (const r of rows) {
      const aliased = r.task_id ? getTask(r.task_id) : undefined;
      if (aliased && aliased.project_id === r.project_id) {
        run('UPDATE inbox SET task_id = ? WHERE id = ?', aliased.id, r.id);
        counts.moved++;
        continue;
      }
      const agent = r.agent_id ? getAgent(r.agent_id) : undefined;
      if (r.status !== 'open') {
        const home = archiveFor(r.project_id, r.created_at);
        run('UPDATE inbox SET task_id = ? WHERE id = ?', home.id, r.id);
        // The archive dates from its requests, so it does not jump to the top of the Discussions list.
        run('UPDATE tasks SET updated_at = MAX(updated_at, ?) WHERE id = ?', Math.max(r.answered_at ?? 0, r.created_at), home.id);
        counts.handled++;
        continue;
      }
      const home = homeFor(r.project_id, agent, r.kind, r.title, undefined, r.created_at);
      run('UPDATE inbox SET task_id = ? WHERE id = ?', home.id, r.id);
      // The discussion was made for this request: it dates from it, so the thread reads in order.
      if (home.created_at > r.created_at && home.kind === 'discussion' && !home.requests_agent_id) {
        run('UPDATE tasks SET created_at = ? WHERE id = ?', r.created_at, home.id);
        run("UPDATE task_messages SET created_at = ? WHERE task_id = ? AND kind = 'state'", r.created_at - 1, home.id);
      }
      counts.open++;
    }
  });
  counts.discussions = ((get("SELECT COUNT(*) AS n FROM tasks WHERE kind = 'discussion'")?.n as number) ?? 0) - before;
  return counts;
}

/** The project's settled discussion holding requests answered in the old Inbox, created on first use. */
function archiveFor(projectId: string, since: number): Row {
  const found = get('SELECT * FROM tasks WHERE project_id = ? AND inbox_archive = 1 ORDER BY created_at LIMIT 1', projectId);
  if (found) return found;
  const conclusion = 'Requests to you that were answered or dismissed in the Inbox before requests were kept on the task or discussion they concern. Kept here as the record of what was asked and decided.';
  const d = createTask(projectId, { title: 'Earlier requests (from the Inbox)', state: 'settled', origin: 'director', kind: 'discussion', status_summary: '' }, { author: 'system', name: 'Helm' });
  run('UPDATE tasks SET inbox_archive = 1, conclusion = ?, created_at = ?, updated_at = ? WHERE id = ?', conclusion, since - 1, since - 1, d.id);
  run("UPDATE task_messages SET created_at = ?, body = ? WHERE task_id = ? AND kind = 'state'", since - 1, 'Helm gathered here the requests answered in the old Inbox, from before each request was kept on its task or discussion.', d.id);
  return getTask(d.id)!;
}

/**
 * Tasks and discussions with open requests in every project not archived (or one project), each with its
 * requests: the cross-project "Needs you" list. `view` renders a row as its own list does.
 */
export function needingResponse(view: (t: Row) => Row, projectId?: string): { projects: Row[]; count: number } {
  const rows = all(
    `SELECT t.*, MAX(i.blocking) AS b, MIN(i.created_at) AS first_at FROM tasks t JOIN inbox i ON i.task_id = t.id JOIN projects p ON p.id = t.project_id
     WHERE i.status = 'open' AND p.archived = 0 ${projectId ? 'AND p.id = ?' : ''} GROUP BY t.id ORDER BY b DESC, first_at`,
    ...(projectId ? [projectId] : []),
  );
  const projects = new Map<string, Row>();
  let count = 0;
  for (const r of rows) {
    const { b: _b, first_at: _f, ...t } = r;
    const v = view(t);
    count += v.needs_response;
    let p = projects.get(t.project_id);
    if (!p) {
      p = { id: t.project_id, name: get('SELECT name FROM projects WHERE id = ?', t.project_id)?.name ?? '', items: [] };
      projects.set(t.project_id, p);
    }
    p.items.push(v);
  }
  // Projects in the user's order (requests within each stay most urgent first).
  const order = new Map(all('SELECT id FROM projects ORDER BY position, created_at').map((p, i) => [p.id, i]));
  return { projects: [...projects.values()].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)), count };
}

// ---------- what a task needs from the user (update_task needs_from_user) ----------

/** A task's open requests the user answers in words or by doing: questions and to-dos, newest first. */
const openAsks = (taskId: string) => all("SELECT * FROM inbox WHERE task_id = ? AND status IN ('open', 'held') AND kind IN ('question', 'action') ORDER BY created_at DESC", taskId);

/**
 * Record what a task needs from the user and make sure a request carries it: with a question or to-do already open
 * on the task, that one is tied to it (nothing is duplicated); otherwise one is filed from the text: a question when it
 * ends with a question mark or options are given, else a to-do. "" clears it. Returns a line for the agent.
 */
export function fileNeeds(task: Row, agentId: string, text: string, options?: { label: string; detail?: string }[]): string {
  const need = text.trim();
  if (!need) {
    run('UPDATE tasks SET needs_from_user = NULL, needs_request_id = NULL WHERE id = ?', task.id);
    return 'Cleared what the task needs from the user. Open requests on it stay open; dismiss nothing on their behalf.';
  }
  const open = openAsks(task.id);
  if (open.length) {
    run('UPDATE tasks SET needs_from_user = ?, needs_request_id = ? WHERE id = ?', need, open[0].id, task.id);
    return `Recorded what the task needs from the user. The request already open on it ("${open[0].title}") carries it; nothing new was filed.`;
  }
  const question = need.endsWith('?') || !!options?.length;
  // Steps numbered inline ("try these: (1) … (2) …") become a numbered list: a to-do's go in its steps, under the lead.
  const { body, steps } = question ? { body: formatRequestText(need), steps: '' } : splitAction(need, '');
  const first = body.split(/(?<=[.!?])\s+|\n/)[0].replace(/^(?:needs? from (?:you|the user)|needed from (?:you|the user))\s*:\s*/i, '').replace(/:$/, '');
  const title = first.length > 120 ? `${first.slice(0, 117)}...` : first;
  const { id } = createRequest({
    projectId: task.project_id, agentId, kind: question ? 'question' : 'action', title, body, options: question ? options ?? [] : [],
    payload: { recommendation: '', from_needs: true, ...(question ? {} : { steps, after: '' }) },
    importance: 3, blocking: !question, task,
  });
  // With the steps split off into the to-do, the task's line is the lead alone.
  run('UPDATE tasks SET needs_from_user = ?, needs_request_id = ? WHERE id = ?', steps ? body : need, id, task.id);
  return `Filed it as a ${question ? 'question' : 'to-do'} on ${taskRef(task)} (request ${id}), so it shows under Needs response. ${steps ? 'Its numbered steps were moved into the to-do as a list. ' : ''}Next time a request has more than one step, file it with ask_user kind "action" and steps as a numbered list instead.`;
}

/** A request was answered or dismissed: the task it carried a need for no longer needs it. */
export function needsAnswered(requestId: string) {
  run('UPDATE tasks SET needs_from_user = NULL, needs_request_id = NULL WHERE needs_request_id = ?', requestId);
}
