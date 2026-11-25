import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { all, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { QUEUE_ORDER, addTaskMessage, getTask } from './tasks.ts';
import { openBlockers } from './waits.ts';
import { addJournal, getProject } from './store.ts';
import { batchChecks } from './batchclerk.ts';
import { clockText } from './clock.ts';
import { holdsNewWork, modeWords } from './projectmode.ts';
import { diskLevel } from './disk.ts';
import { BUILDER_PROMPT_TEXT } from './builderprompt.ts';
import { subagentsOn } from './subagents.ts';
import { SKIPPED_NOTE, adherence, strictUnlinked } from './specadherence.ts';

/**
 * Builders (the only way a project runs; team mode and the standing Builder were retired): Helm starts a fresh builder
 * for each task when it is Scheduled or started (dispatch.ts), several side by side when their files do not overlap.
 * Each works in its own worktree, merges, finishes through the gates and is closed. The director is woken for the
 * user's messages, a builder's questions, the review of a task marked for review, a progress check stopping a task
 * (re-plan), and one batch record (journal; batchclerk.ts runs the checks) when nothing is left running or queued, or
 * BATCH_SIZE tasks have finished since the last one.
 *
 * Review is opt-in: only a task marked "Review before it lands" (tasks.risky = 1, by the user or the director) goes
 * through request_review before it lands. Nothing else is reviewed, and Helm never judges it from the text.
 */

export const BUILDER_AREA = 'builder';
export const BATCH_SIZE = 5;

export const BUILDER_PROMPT = BUILDER_PROMPT_TEXT;

/** Every project runs with builders: the Team way of working is gone (its setting too). */
export const builderMode = (_projectId?: string) => true;

/** Marked "Review before it lands" (tasks.risky = 1): the only tasks reviewed before they land. */
export const isRisky = (t: Row): boolean => t.risky === 1;

/** The builder role every project's structure holds (idempotent). Returns whether it changed. */
export function ensureBuilderArea(s: { root: string; roles: Row[] }): boolean {
  if (s.roles.some((r) => r.id === BUILDER_AREA)) return false;
  s.roles.push({ id: BUILDER_AREA, name: 'Builder', model: 'claude-opus-5-5', effort: '', description: 'A fresh builder Helm starts for one task.', prompt: BUILDER_PROMPT, canSpawn: [], tier: 'skilled' });
  return true;
}

/** A builder: one Helm started fresh for a task (per_task), or the standing Builder of before, until it is closed. */
export const isBuilder = (agent: Row | undefined) => !!agent && agent.role_id === BUILDER_AREA && !!agent.parent_id;
export const isFreshBuilder = (agent: Row | undefined) => isBuilder(agent) && !!agent!.per_task;

/** Why no Scheduled task starts now (the project winds down, is stopped, or the disk is too full), or null. */
export function queueHeld(project: Row): string | null {
  if (holdsNewWork(project.id)) return `the project is ${modeWords(project.id)}`;
  return diskLevel() === 'critical' ? 'the disk is nearly full' : null;
}

/**
 * Scheduled tasks that may start, in queue order: those that wait for nothing open and, with Spec adherence Strict,
 * link a Spec entry (specadherence.ts).
 */
export function startableScheduled(projectId: string): Row[] {
  return all(`SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'scheduled' ${QUEUE_ORDER}`, projectId).filter((t) => !openBlockers(t.id).length && !strictUnlinked(t));
}

/** The first of them. */
export const nextScheduled = (projectId: string): Row | undefined => startableScheduled(projectId)[0];

/** Strict: each Scheduled task skipped for want of a linked entry gets one thread line saying so. */
export function noteSkipped(projectId: string) {
  if (adherence(projectId) !== 'strict') return;
  for (const t of all(`SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'scheduled'`, projectId)) {
    if (!strictUnlinked(t)) continue;
    if (get('SELECT body FROM task_messages WHERE task_id = ? ORDER BY id DESC LIMIT 1', t.id)?.body === SKIPPED_NOTE) continue;
    addTaskMessage(t, HELM, SKIPPED_NOTE, 'state');
  }
}

const exec = promisify(execFile);

/** Commits on the main checkout's branch since the task started: "abc1234 subject". */
async function commitsSince(project: Row, since: number): Promise<string[]> {
  try {
    const { stdout } = await exec('git', ['-C', project.path, 'log', `--since=${new Date(since).toISOString()}`, '--format=%h %s', '-n', '20'], { timeout: 10_000 });
    return stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

const HELM = { author: 'system' as const, name: 'Helm' };

/** A builder's task is done: recorded for the next batch record, with its subagents. */
export async function builderTaskDone(agent: Row, t: Row, summary: string) {
  const project = getProject(agent.project_id);
  if (!project) return;
  const commits = await commitsSince(project, t.started_at ?? t.created_at);
  run('INSERT OR REPLACE INTO builder_batch (project_id, task_id, finished_at, commits, result, noted, subagents) VALUES (?,?,?,?,?,0,?)', project.id, t.id, now(), JSON.stringify(commits), summary.trim().slice(0, 400), subagentsOn(t.id));
}

/** Tasks finished since the last batch record. */
export const pendingBatch = (projectId: string) => Number(get('SELECT COUNT(*) AS n FROM builder_batch WHERE project_id = ? AND noted = 0', projectId)?.n ?? 0);

/** One note to the director for the tasks finished since the last one: titles, commits, each check's result. */
export async function batchNote(project: Row): Promise<boolean> {
  const rows = all('SELECT * FROM builder_batch WHERE project_id = ? AND noted = 0 ORDER BY finished_at', project.id);
  if (!rows.length) return false;
  run('UPDATE builder_batch SET noted = 1 WHERE project_id = ? AND noted = 0', project.id);
  const lines = rows.map((r) => {
    const commits = JSON.parse(r.commits || '[]') as string[];
    return `- [[${r.task_id}]] at ${clockText(r.finished_at)}${r.subagents ? ` (${r.subagents} subagent${r.subagents === 1 ? '' : 's'})` : ''}: ${r.result || 'no summary'}${commits.length ? `\n  commits: ${commits.slice(0, 5).join('; ')}${commits.length > 5 ? ` and ${commits.length - 5} more` : ''}` : ''}`;
  });
  const held = queueHeld(project);
  const left = !nextScheduled(project.id) ? 'The queue is empty.' : held ? `The queue is held: ${held}.` : 'More is scheduled; Helm starts its builders.';
  // The full checks for this batch (batchclerk.ts): started here; a failure wakes the director, a pass does the
  // project's step. The batch itself is a journal record: a passing batch wakes no one.
  const checks = await batchChecks(project, rows.map((r) => r.task_id as string));
  const title = `Batch: ${rows.length} task${rows.length === 1 ? '' : 's'} finished by builders`;
  addJournal(project.id, null, 'status', title, `${left}\n${lines.join('\n')}${checks ? `\n${checks}` : ''}`);
  for (const r of rows) {
    const t = getTask(r.task_id);
    if (t) addTaskMessage(t, HELM, 'Recorded in the batch journal entry; the full checks run on it.', 'state');
  }
  return true;
}
