import type { Agent } from './api';

/** An agent that has ended: closed, or a standing agent marked done. */
export const isFinished = (a: Pick<Agent, 'status'>) => a.status === 'closed' || a.status === 'done';

/** A builder's SDK subagent (server/subagents.ts): shown on the task it works for, never as an agent of its own. */
export const isSubagent = (a: Pick<Agent, 'role_id'>) => a.role_id === 'subagent';

/**
 * The Agents page's two lists: the agents running now (the director, the Builder, an area agent while it works) and
 * the past ones, newest first. Builder subagents are in neither.
 */
export function agentLists(agents: Agent[]): { open: Agent[]; past: Agent[] } {
  const mine = agents.filter((a) => !isSubagent(a));
  return {
    open: mine.filter((a) => !isFinished(a)),
    past: mine.filter(isFinished).sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at),
  };
}

/** Past agents matching a search (name, brief or result) and a task ('' for any). */
export function filterPast(past: Agent[], query: string, taskId: string): Agent[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return past.filter((a) => {
    if (taskId && a.task_id !== taskId) return false;
    const text = `${a.name} ${a.task} ${a.last_result}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** The tasks past agents worked on, most agents first: the task filter's options. */
export function pastTasks(past: Agent[]): { id: string; count: number }[] {
  const n = new Map<string, number>();
  for (const a of past) if (a.task_id) n.set(a.task_id, (n.get(a.task_id) ?? 0) + 1);
  return [...n].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count);
}
