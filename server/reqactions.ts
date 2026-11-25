import type { Row } from './db.ts';
import { getTask, isDiscussion } from './tasks.ts';
import { taskAction } from './taskactions.ts';
import { restartAgents, startLiveUpdate } from './liveupdate.ts';
import { installItem } from './toolbox.ts';
import { beginSpecWork } from './specwork.ts';
import { confirmPublish, findRelease, latestPublishable, releasesOn, startRelease } from './releases.ts';

/**
 * A request's inline action (ask_user's `action`, or added by Helm): one thing Helm does when the user taps it on the
 * request (Home's card, Needs you, the task page), instead of sending them elsewhere to press it. Agents only attach
 * it; it runs from the user's answer (answers.ts), through the same code as the dashboard's own buttons, so every rule
 * about what only the user may do still holds.
 */
export const REQUEST_ACTIONS = {
  approve_task: { label: 'Approve', task: true },
  start_task: { label: 'Start now', task: true },
  resume_task: { label: 'Resume', task: true },
  update_helm: { label: 'Update now', task: false },
  restart_agents: { label: 'Restart agents now', task: false },
  // Releases (releases.ts): only the user's tap starts a release or lets one be published.
  cut_release: { label: 'Cut release', task: false },
  publish_release: { label: 'Publish', task: false },
  // Helm's question when a project with no Spec is brought in (specwork.ts): starts Create.
  spec_create: { label: 'Build a Spec', task: false },
  // A Toolbox proposal's Install (toolbox.ts fileProposalRequest): for every project, as the System › Tools button does.
  install_tool: { label: 'Install', task: false },
} as const;
export type RequestActionKind = keyof typeof REQUEST_ACTIONS;
export const REQUEST_ACTION_KINDS = Object.keys(REQUEST_ACTIONS) as RequestActionKind[];

/** Stored in the request's payload as `act`. `option`: the request's own option that performs it (an approve-like answer). */
export type RequestAction = { kind: RequestActionKind; target?: string; option?: string };

const TASK_ACTION: Record<string, string> = { approve_task: 'approve', start_task: 'start', resume_task: 'resume' };

/** The label of its button: the option it rides on, else the action's own. */
export const actionLabel = (a: RequestAction) => a.option ?? REQUEST_ACTIONS[a.kind].label;

/**
 * Checks an action an agent attaches. A task action acts on the task the request is about, never another, so its
 * button says what it does; Update now and Restart agents now reach every project, so only a director attaches them.
 */
export function checkAction(a: { kind: string; release?: string }, projectId: string, taskId: string | null, director: boolean): { act: RequestAction } | { error: string } {
  const spec = REQUEST_ACTIONS[a.kind as RequestActionKind];
  if (!spec) return { error: `action.kind must be one of ${REQUEST_ACTION_KINDS.join(', ')}.` };
  if (a.kind === 'cut_release' || a.kind === 'publish_release') {
    if (!director) return { error: `Only the director attaches ${a.kind}: ask your manager (ask_manager) to file it.` };
    if (!releasesOn(projectId)) return { error: 'Releases are off for this project (Setup › Agent context).' };
    if (a.kind === 'cut_release') return { act: { kind: 'cut_release', target: projectId } };
    const r = a.release ? findRelease(projectId, a.release) : latestPublishable(projectId);
    if (!r) return { error: a.release ? `No release ${a.release} on this project (list_releases).` : 'No ready release with publish instructions to publish: pass release.' };
    return { act: { kind: 'publish_release', target: r.id } };
  }
  if (a.kind === 'spec_create') return director ? { act: { kind: 'spec_create', target: projectId } } : { error: 'Only the director attaches spec_create.' };
  if (!spec.task) return director ? { act: { kind: a.kind as RequestActionKind } } : { error: `Only the director attaches ${a.kind}: ask your manager (ask_manager) to file it.` };
  const task = taskId ? getTask(taskId) : undefined;
  if (!task || task.project_id !== projectId) return { error: `action ${a.kind} acts on the task the request is about: pass task (a task, not a discussion).` };
  return { act: { kind: a.kind as RequestActionKind, target: task.id } };
}

/** Do it, as the user who tapped it. Returns what happened in a few words, or why it could not be done. */
export async function performAction(a: RequestAction): Promise<{ done: string } | { error: string }> {
  if (REQUEST_ACTIONS[a.kind]?.task) {
    const task = a.target ? getTask(a.target) : undefined;
    if (!task) return { error: 'That task no longer exists.' };
    const res = await taskAction(task, TASK_ACTION[a.kind]);
    if (res.error) return { error: res.needsConfirm ? `${res.error.split('.')[0]}: start it from the task.` : res.error };
    return { done: { approve_task: 'Approved', start_task: 'Started', resume_task: 'Resumed' }[a.kind as string]! };
  }
  if (a.kind === 'update_helm') {
    const error = await startLiveUpdate('update');
    return error ? { error } : { done: 'Update started' };
  }
  if (a.kind === 'cut_release') {
    // The same start as the Releases page's Cut release button; an open release is returned, not doubled.
    const res = await startRelease(a.target ?? '', {});
    return 'error' in res ? { error: res.error } : { done: res.existing ? `Release ${res.release.version} was already being made` : `Release ${res.release.version} started` };
  }
  if (a.kind === 'publish_release') {
    const e = confirmPublish(a.target ?? '');
    return e ? { error: e } : { done: 'Publishing' };
  }
  if (a.kind === 'spec_create') {
    const res = await beginSpecWork(a.target ?? '', 'create');
    return 'error' in res ? { error: res.error } : { done: res.created ? 'Create started' : 'Create was already open' };
  }
  if (a.kind === 'install_tool') {
    const error = installItem(a.target ?? '', { scope: 'all' });
    return error ? { error } : { done: 'Installing' };
  }
  if (a.kind === 'restart_agents') {
    const error = await restartAgents();
    return error ? { error } : { done: 'Agents restarting' };
  }
  return { error: 'Unknown action.' };
}

/** Helm's own: a question about a Planning task with an approve-like option gets Approve on that option. */
export function impliedAction(task: Row | null | undefined, options: { label: string }[]): RequestAction | null {
  if (!task || isDiscussion(task) || task.state !== 'planning') return null;
  const o = options.find((x) => /^\s*(approve|approved|yes,? approve)\b/i.test(x.label));
  return o ? { kind: 'approve_task', target: task.id, option: o.label } : null;
}
