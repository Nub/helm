import { get, run } from './db.ts';
import type { Row } from './db.ts';
import { notify, prefixed } from './notify.ts';
import { touchProject } from './store.ts';

/**
 * The bell on a task (tasks.bell): the user asked to be told when this one finishes. When it becomes Done, or is
 * dropped or paused by Helm, one notification goes out whatever the general settings for finished tasks say, and the
 * bell clears. Set only by the user (taskapi.ts).
 */
export function setBell(taskId: string, on: boolean) {
  const t = get('SELECT project_id FROM tasks WHERE id = ?', taskId);
  if (!t) return;
  run('UPDATE tasks SET bell = ? WHERE id = ?', on ? 1 : 0, taskId);
  touchProject(t.project_id);
}

const WORD: Record<string, string> = { done: 'Done', dropped: 'Dropped', paused: 'Paused' };

/** setTaskState (tasks.ts) after a change: true when the bell rang, so the general "Done" notification is not sent too. */
export function ringBell(task: Row, state: string, byHelm: boolean): boolean {
  if (!(state === 'done' || state === 'dropped' || (state === 'paused' && byHelm))) return false;
  const t = get('SELECT id, project_id, title, status_summary, bell FROM tasks WHERE id = ?', task.id);
  if (!t?.bell) return false;
  run('UPDATE tasks SET bell = 0 WHERE id = ?', t.id);
  const item = `#/p/${t.project_id}/tasks/${t.id}`;
  notify({ kind: 'done', projectId: t.project_id, title: prefixed(t.project_id, `${WORD[state]}: ${t.title}`), body: t.status_summary || '', url: item, item, bell: true });
  return true;
}
