import { all } from './db.ts';
import type { Row } from './db.ts';
import { dispatchWork, interruptAgent, tellDirector } from './agents.ts';
import { onTaskDecision } from './spec.ts';
import { OPEN_TASK_STATES, QUEUE_ORDER, STATE_LABEL, USER, isDiscussion, getTask, setTaskState, taskRef } from './tasks.ts';
import { holdsNewWork, isStopped, modeWords, startedAnyway } from './projectmode.ts';
import { blockedReason } from './waits.ts';

// The user's one-tap task actions (Approve, Start now, Interrupt, Resume, Drop): the task page's buttons
// (taskapi.ts) and a request's inline action (reqactions.ts) both come here, so the rules are the same.

export { modeWords };

/** Where a scheduled task stands in the queue, for notes to the director. */
export function queuePlace(task: Row): string {
  const scheduled = all(`SELECT id FROM tasks WHERE project_id = ? AND state = 'scheduled' ${QUEUE_ORDER}`, task.project_id);
  const i = scheduled.findIndex((t) => t.id === task.id);
  return i < 0 ? '' : ` It is number ${i + 1} of ${scheduled.length} in the scheduled queue.`;
}

/** The user's one-tap task actions: which states they apply to, the new state, and what the director is told. */
export const ACTIONS: Record<string, { from: string[]; to: string; label: string; note: (t: Row) => string }> = {
  // Approve a plan, or Schedule a waiting or paused task: all put it in the queue.
  approve: {
    from: ['planning', 'waiting', 'paused'],
    to: 'scheduled',
    label: 'Approve',
    note: (t) => `The user ${t.was === 'waiting' || t.was === 'paused' ? 'scheduled' : 'approved'} ${taskRef(t)}. It is now Scheduled.${queuePlace(t)} Helm starts a fresh builder for it in queue order.`,
  },
  // Unschedule: back out of the queue to Waiting, agreed but not lined up (Schedule on a Waiting task undoes it).
  unschedule: {
    from: ['scheduled'],
    to: 'waiting',
    label: 'Unschedule',
    note: (t) => `The user unscheduled ${taskRef(t)}. It is Waiting again: agreed, but not in the queue. Leave it until they schedule it.`,
  },
  start: {
    from: ['planning', 'waiting', 'scheduled', 'paused'],
    to: 'active',
    label: 'Start now',
    note: (t) => `The user pressed Start now on ${taskRef(t)}. It is now Active, ahead of the queue: Helm starts a fresh builder for it unless one is on it. Say in its thread if something is missing.`,
  },
  interrupt: {
    from: ['active'],
    to: 'paused',
    label: 'Interrupt',
    note: (t) => `The user interrupted ${taskRef(t)}. It is now Paused. Wind down work on it: stop or redirect the agents working on it, and do not continue it until they resume it.`,
  },
  resume: {
    from: ['paused'],
    to: 'active',
    label: 'Resume',
    note: (t) => `The user resumed ${taskRef(t)}. It is Active again. Pick the work back up where it stopped, or say in its thread what is missing.`,
  },
  drop: {
    from: OPEN_TASK_STATES,
    to: 'dropped',
    label: 'Drop',
    note: (t) => `The user dropped ${taskRef(t)}. Stop any work on it, and close agents that were only working on it.`,
  },
};


/**
 * Do a task action as the user. Starting while the project is winding down, at rest or stopped needs `anyway` (the
 * user confirmed); without it the answer says so with needsConfirm.
 */
export async function taskAction(task: Row, action: string, anyway = false): Promise<{ error?: string; needsConfirm?: boolean }> {
  const a = ACTIONS[action];
  if (!a) return { error: `No task action "${action}".` };
  if (isDiscussion(task)) return { error: `${a.label} applies to tasks; this is a discussion. Turn it into a task first.` };
  const blocked = a.to === 'active' ? blockedReason(task.id) : null;
  if (blocked) return { error: blocked.replace(/\[\[[^\]]+\]\]/g, (m) => getTask(m.slice(2, -2))?.title ? `"${getTask(m.slice(2, -2))!.title}"` : m) };
  if (!a.from.includes(task.state)) return { error: `This task is ${STATE_LABEL[task.state]}; ${a.label} applies to ${a.from.map((s) => STATE_LABEL[s]).join(', ')} tasks.` };
  // Winding down, at rest or stopped (projectmode.ts): starting a task is the user's to do, after a confirmation,
  // and starts only that task. Everything else the user does is never blocked by the mode.
  const held = a.to === 'active' && holdsNewWork(task.project_id);
  if (held && !anyway) {
    return {
      error: isStopped(task.project_id)
        ? 'The project is stopped. Start anyway? The task becomes Active, and work on it begins when you resume the project.'
        : `The project is ${modeWords(task.project_id)}. Start anyway? Only this task starts; the rest of the queue stays held.`,
      needsConfirm: true,
    };
  }
  if (held) startedAnyway(task.project_id);
  setTaskState(task, a.to, USER, held ? `started anyway while the project is ${modeWords(task.project_id)}` : '');
  // A Spec change being planned: Approve or Start settles the edited entries, Drop marks them not planned.
  onTaskDecision(task, action);
  // Interrupt stops the agents working on the task now (not the director, who is told and winds the rest down).
  if (action === 'interrupt') {
    for (const a of all("SELECT id FROM agents WHERE (task_id = ? OR id = ?) AND parent_id IS NOT NULL AND status IN ('working', 'waiting')", task.id, task.driver_agent_id ?? '')) await interruptAgent(a.id).catch(() => {});
  }
  const queued = holdsNewWork(task.project_id) && a.to !== 'paused' && a.to !== 'dropped';
  const modeLine = !queued ? '' : held ? ` The project is ${modeWords(task.project_id)}; the user chose to start this one task anyway, so Helm starts its builder. Nothing else starts.` : ` The project is ${modeWords(task.project_id)}, so it stays queued: do not start it until the user resumes the project.`;
  await tellDirector(task.project_id, a.note({ ...getTask(task.id)!, was: task.state }) + modeLine);
  // Helm starts a fresh builder for work scheduled or started (dispatch.ts).
  if ((a.to === 'scheduled' || a.to === 'active') && !isStopped(task.project_id)) dispatchWork(task.project_id);
  return {};
}
