import { all, get } from './db.ts';
import type { Row } from './db.ts';
import { getChoice } from './settings.ts';

/**
 * Spec adherence (a per-project setting, Setup › Planning): how strictly work must follow the Spec.
 * - strict: a task is scheduled or started only when it links a Spec entry it implements; a conflict goes to the user.
 * - loose (default): the same link is needed, but the director may write a one-line entry in the same planning step,
 *   and a quick fix from the main conversation that changes nothing an entry says may skip it (create_task quick_fix).
 * - none: no checks.
 * Checked by create_task / update_task (tools.ts) and by Helm's dispatch of builders (builder.ts, dispatch.ts).
 */
export type Adherence = 'strict' | 'loose' | 'none';

export const adherence = (projectId: string): Adherence => getChoice(projectId, 'spec_adherence') as Adherence;

/** The thread line create_task writes for a quick fix; its presence lets the task be scheduled or started unlinked in Loose. */
export const QUICK_FIX_NOTE = 'Quick fix: changes nothing a Spec entry says, so it links none (Spec adherence Loose).';

/** The Spec entries a task implements: tasks.doc_id and doc_links 'implements'. */
export function linkedEntries(taskId: string): string[] {
  return all("SELECT DISTINCT doc_id FROM doc_links WHERE task_id = ? AND relation = 'implements' UNION SELECT doc_id FROM tasks WHERE id = ? AND doc_id IS NOT NULL", taskId, taskId).map((r) => String(r.doc_id));
}

export const isQuickFix = (taskId: string): boolean => !!get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND body = ? LIMIT 1", taskId, QUICK_FIX_NOTE);

/** Why quick_fix is not allowed here, or null. */
export function quickFixError(projectId: string, isDirector: boolean): string | null {
  const mode = adherence(projectId);
  if (mode === 'strict') return 'quick_fix is not allowed: Spec adherence is Strict, so every scheduled or started task links the Spec entry it implements. Link one (doc), or propose the entry with propose_doc_edit and link it once the user applies it. Nothing was changed.';
  if (mode === 'none') return null;
  if (!isDirector) return 'quick_fix is for the director\'s quick fixes from the main conversation. Link the Spec entry it implements (doc). Nothing was changed.';
  return null;
}

/**
 * Why a task may not go to `state` (scheduled or active) with these linked entries, or null. `quickFix`: marked a quick
 * fix (only counts in Loose).
 */
export function adherenceError(projectId: string, state: string, linked: number, quickFix: boolean): string | null {
  if (state !== 'scheduled' && state !== 'active') return null;
  const mode = adherence(projectId);
  if (mode === 'none' || linked > 0) return null;
  const verb = state === 'active' ? 'started' : 'scheduled';
  if (mode === 'strict') {
    return `Spec adherence is Strict: a task is ${verb} only when it links the Spec entry it implements (doc or docs). Link the entry (list_docs shows them). If no entry covers it, propose one with propose_doc_edit and link it once the user applies it; if the plan conflicts with an entry, stop and ask the user: change the Spec or redesign the task. Nothing was changed.`;
  }
  if (quickFix) return null;
  return `Spec adherence is Loose: a task is ${verb} only when it links the Spec entry it implements (doc or docs). Link the entry (list_docs shows them), or, if none covers it, write a one-line entry with set_doc now and link it. A quick fix from the main conversation that changes nothing an entry says may pass quick_fix: true. Nothing was changed.`;
}

/** Strict only: a Scheduled task the builder's hand-off skips because it links no entry. */
/** The origin note of a task Helm made for a build the user tapped (buildtask.ts): it implements no Spec entry. */
export const HELM_WORK_NOTE = 'Made by Helm for work the user asked for';

export function strictUnlinked(t: Row): boolean {
  return adherence(t.project_id) === 'strict' && t.origin_note !== HELM_WORK_NOTE && linkedEntries(t.id).length === 0;
}

/** The thread line for a task the hand-off skipped. */
export const SKIPPED_NOTE = 'Skipped by the builder: Spec adherence is Strict and this task links no Spec entry. Link the entry it implements (update_task doc) and it is taken in queue order.';
