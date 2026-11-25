import { all, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { notifyDirector } from './sessions.ts';
import { addTaskMessage, taskRef } from './tasks.ts';
import { isStopped } from './projectmode.ts';

/**
 * Keeps a task's state honest about who is working on it. Nothing else ties an agent finishing to its task: whether an
 * Active task moves on is the director's call (it reviews the work first), and when it forgets, the task would sit
 * Active with nobody on it. So Helm notices, without taking the review away from the director:
 * - its driver finishing (complete_task, or closed) marks the task as awaiting review and stops its clock;
 * - after the director's turn that received that report, if the task is still Active with nobody on it, one note;
 * - an Active task nobody has touched for a while is stalled: flagged on the task and one reminder to the director.
 * A message that sends the agent back to work clears the flag and restarts the clock.
 */

/** Minutes without activity, with nobody on it, after which an Active task counts as stalled. HELM_STALL_MINUTES. */
export const STALL_MS = (Number(process.env.HELM_STALL_MINUTES ?? 15) || 15) * 60_000;

const UNFINISHED = "status NOT IN ('done','closed')";
const rootOf = (projectId: string): Row | undefined =>
  get("SELECT * FROM agents WHERE project_id = ? AND parent_id IS NULL AND status != 'closed' ORDER BY created_at LIMIT 1", projectId);
const SYSTEM = { author: 'system' as const, name: 'Helm' };

/** Agents still on a task (its driver or any spawned for it) that have not finished. */
function onIt(t: Row): Row[] {
  return all(`SELECT * FROM agents WHERE (id = ? OR task_id = ?) AND ${UNFINISHED}`, t.driver_agent_id ?? '', t.id);
}

/** An agent finished (complete_task, or closed): the Active tasks it drives now wait for the director's review. */
export function onAgentFinished(agentId: string) {
  const agent = get('SELECT * FROM agents WHERE id = ?', agentId);
  if (!agent || !agent.parent_id) return;
  const manager = get('SELECT name FROM agents WHERE id = ?', agent.parent_id)?.name ?? 'the director';
  for (const t of all("SELECT * FROM tasks WHERE driver_agent_id = ? AND kind = 'task' AND state = 'active' AND review_since IS NULL", agentId)) {
    const at = now();
    // The clock stops: the time spent waiting for review is not time worked on it. A new stretch starts if the agent is sent back.
    run('UPDATE tasks SET review_since = ?, review_agent = ?, review_noted = 0, active_ms = active_ms + MAX(0, ? - COALESCE(active_since, ?)), active_since = NULL WHERE id = ?', at, agent.name, at, at, t.id);
    addTaskMessage(t, SYSTEM, `${agent.name} finished; waiting for ${manager} to review.`, 'state');
  }
}

/** A message reached an agent: if it had finished its task and the task is still Active, it is back at work on it. */
export function onAgentResumed(agentId: string) {
  for (const t of all("SELECT * FROM tasks WHERE driver_agent_id = ? AND state = 'active' AND review_since IS NOT NULL", agentId)) {
    run('UPDATE tasks SET review_since = NULL, review_agent = NULL, review_noted = 0, active_since = ? WHERE id = ?', now(), t.id);
    addTaskMessage(t, SYSTEM, `${get('SELECT name FROM agents WHERE id = ?', agentId)?.name ?? 'The agent'} is working on it again.`, 'state');
  }
}

/**
 * The director's turn ended with nothing queued. A task whose driver finished before that turn and that is still
 * Active with nobody on it gets one note: settle it. Once per completion; never for tasks the director drives.
 */
export function afterDirectorTurn(director: Row) {
  const tasks = all(
    "SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'active' AND review_since IS NOT NULL AND review_noted = 0 AND (driver_agent_id IS NULL OR driver_agent_id != ?)",
    director.project_id, director.id,
  ).filter((t) => !onIt(t).length);
  // Only completions this director has seen: the report reached it (an inbound event) before the turn's result.
  const seen = tasks.filter((t) => get("SELECT 1 AS x FROM events WHERE agent_id = ? AND kind = 'inbound' AND ts >= ? LIMIT 1", director.id, t.review_since));
  if (!seen.length) return;
  for (const t of seen) run('UPDATE tasks SET review_noted = 1 WHERE id = ?', t.id);
  void notifyDirector(
    director.project_id,
    seen
      .map((t) => `${t.review_agent ?? 'Its driver'} finished ${taskRef(t)}, and it is still Active with nobody working on it.`)
      .join(' ') +
      ` Settle ${seen.length === 1 ? 'it' : 'each'} now: review the result and mark it done with update_task (state done and a status_summary), or say in its thread (task_post) what remains and who will do it, and send that agent or another back to it.`,
  );
}

/** Whether an Active task has stalled: nobody on it, nothing asked of the user, and no activity for STALL_MS. */
export function stallState(t: Row, at = now()): { stalled: boolean; since: number } {
  if (t.kind !== 'task' || t.state !== 'active') return { stalled: false, since: 0 };
  const root = rootOf(t.project_id);
  const agents = all(`SELECT * FROM agents WHERE (id = ? OR task_id = ?)`, t.driver_agent_id ?? '', t.id);
  // The director is on its own task only while it works; idle, it has moved on to other things.
  const onTask = agents.filter((a) => !['done', 'closed', 'interrupted', 'error'].includes(a.status) && (a.id !== root?.id || a.status === 'working' || a.status === 'waiting'));
  if (onTask.length) return { stalled: false, since: 0 };
  if (get("SELECT 1 AS x FROM inbox WHERE task_id = ? AND status = 'open' LIMIT 1", t.id)) return { stalled: false, since: 0 };
  const last = Math.max(t.updated_at, t.review_since ?? 0, ...agents.map((a) => a.updated_at));
  return { stalled: at - last >= STALL_MS, since: last };
}

/** What the task views show: awaiting review after the driver finished, and stalled. */
export function watchView(t: Row): { awaiting_review: boolean; review_agent: string | null; stalled: boolean } {
  const awaiting = t.kind === 'task' && t.state === 'active' && t.review_since != null;
  return { awaiting_review: awaiting, review_agent: awaiting ? t.review_agent : null, stalled: stallState(t).stalled };
}

/** Counts for the project's "needs attention". */
export function attention(projectId: string) {
  const active = all("SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'active'", projectId);
  return { stalled: active.filter((t) => stallState(t).stalled).length, awaiting_review: active.filter((t) => t.review_since != null).length };
}

/** One reminder per task when it becomes stalled (again after any activity on it). Run from the sessions timer. */
export function checkStalls(at = now()) {
  for (const t of all("SELECT t.* FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.archived = 0 AND t.kind = 'task' AND t.state = 'active'")) {
    // Stopped: the user interrupted everything on purpose; nothing is stalled.
    if (isStopped(t.project_id)) continue;
    const st = stallState(t, at);
    if (!st.stalled || (t.stall_noted_at && t.stall_noted_at >= st.since)) continue;
    run('UPDATE tasks SET stall_noted_at = ? WHERE id = ?', at, t.id);
    const root = rootOf(t.project_id);
    const mine = root && t.driver_agent_id === root.id;
    void notifyDirector(
      t.project_id,
      `${taskRef(t)} is Active but nobody has worked on it for ${Math.round((at - st.since) / 60000)} minutes${mine ? ' (you drive it)' : ''}. Either carry it on (yourself or by sending an agent back to it), mark it done with a status summary if it is finished, or pause it and say why in its thread.`,
    );
  }
}
