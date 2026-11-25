import { all, db, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';

/**
 * A task that waits for other tasks (task_waits): set by agents (create_task / update_task `waits_for`) or by the
 * user (the task's menu). The waiting task shows "Waits for …" and each blocker "Blocks …", both linked; it cannot
 * become Active while a blocker is open (tasks.ts agentStateChangeError, taskactions.ts); when the last blocker is
 * done the director is told it is ready (tasks.ts setTaskState). No cycles.
 */
db.exec(`CREATE TABLE IF NOT EXISTS task_waits (
  task_id TEXT NOT NULL,
  waits_for TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, waits_for)
)`);
db.exec('CREATE INDEX IF NOT EXISTS task_waits_for ON task_waits (waits_for)');

const OPEN = "('planning', 'waiting', 'scheduled', 'active', 'paused')";
const ref = (t: Row) => `[[${t.id}]]`;

/** Every task `id` waits for, directly or through others. */
function upstream(id: string, seen = new Set<string>()): Set<string> {
  for (const r of all('SELECT waits_for FROM task_waits WHERE task_id = ?', id)) {
    if (!seen.has(r.waits_for)) {
      seen.add(r.waits_for);
      upstream(r.waits_for, seen);
    }
  }
  return seen;
}

/** Replace what `taskId` waits for. Returns an error and changes nothing when an id is not a task of its project or it would make a cycle. */
export function setWaits(taskId: string, ids: string[]): string | null {
  const task = get('SELECT id, project_id, kind FROM tasks WHERE id = ?', taskId);
  if (!task) return 'No such task.';
  const want = [...new Set(ids.map((x) => x.trim()).filter(Boolean))];
  for (const id of want) {
    if (id === taskId) return 'A task cannot wait for itself.';
    const t = get('SELECT id, project_id, kind FROM tasks WHERE id = ?', id);
    if (!t || t.project_id !== task.project_id || t.kind !== 'task') return `No task ${id} on this project to wait for.`;
    if (upstream(id).has(taskId)) return `${ref(t)} already waits for ${ref(task)} (directly or through others), so waiting for it would be a cycle.`;
  }
  tx(() => {
    run('DELETE FROM task_waits WHERE task_id = ?', taskId);
    for (const id of want) run('INSERT INTO task_waits (task_id, waits_for, created_at) VALUES (?, ?, ?)', taskId, id, now());
  });
  touchProject(task.project_id);
  return null;
}

/** The tasks it waits for that are not done yet. */
export function openBlockers(taskId: string): Row[] {
  return all(`SELECT t.id, t.title, t.state FROM task_waits w JOIN tasks t ON t.id = w.waits_for WHERE w.task_id = ? AND t.state IN ${OPEN} ORDER BY w.created_at, w.rowid`, taskId);
}

/** Why it cannot start yet, or null. */
export function blockedReason(taskId: string): string | null {
  const open = openBlockers(taskId);
  if (!open.length) return null;
  return `It waits for ${open.map(ref).join(', ')}, which ${open.length === 1 ? 'is' : 'are'} not done yet. Start it once ${open.length === 1 ? 'that is' : 'they are'} done, or change what it waits for.`;
}

/** For the task's view (tasks.ts taskView): what it waits for that is still open, and the open tasks it blocks. */
export function waitsView(taskId: string): { waits_for: Row[]; blocks: Row[] } {
  return {
    waits_for: openBlockers(taskId),
    blocks: all(`SELECT t.id, t.title, t.state FROM task_waits w JOIN tasks t ON t.id = w.task_id WHERE w.waits_for = ? AND t.state IN ${OPEN} ORDER BY w.created_at, w.rowid`, taskId),
  };
}

/** A blocker finished: the open tasks it was the last open blocker of, for "ready" notes. */
export function nowReady(doneId: string): Row[] {
  return all(`SELECT t.id, t.title, t.project_id FROM task_waits w JOIN tasks t ON t.id = w.task_id WHERE w.waits_for = ? AND t.state IN ${OPEN}`, doneId).filter((t) => !openBlockers(t.id).length);
}
