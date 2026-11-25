import { all, get, now, run } from './db.ts';
import type { Row } from './db.ts';

/**
 * A task's parts: each piece of work folded into it and where it came from. merge_tasks records one per merged task
 * (its title and description; the kept task's own work becomes its first part); a director folding a new ask into a
 * task adds one with update_task add_part. A task with more than one part shows "N parts" by its title, and About
 * lists them with each part's own Features and Done when.
 *
 * Source kinds: self (the task's own first work), task (a merged task), discussion, message (a message in its
 * thread, by task_messages id), note (a drawn note, by attachment id).
 */
export type PartSource = 'self' | 'task' | 'discussion' | 'message' | 'note';

const nextPos = (taskId: string) => Number(get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM task_parts WHERE task_id = ?', taskId)?.p ?? 0);

export const partCount = (taskId: string) => Number(get('SELECT COUNT(*) AS n FROM task_parts WHERE task_id = ?', taskId)?.n ?? 0);

function insertPart(taskId: string, title: string, kind: PartSource, sourceId: string | null, body: string) {
  run('INSERT INTO task_parts (task_id, position, title, source_kind, source_id, body, created_at) VALUES (?,?,?,?,?,?,?)', taskId, nextPos(taskId), title.trim().slice(0, 200), kind, sourceId, body.trim(), now());
}

/** A task about to gain a second part: its own work so far becomes part one (its title and description then). */
export function ensureFirstPart(t: Row) {
  if (partCount(t.id)) return;
  insertPart(t.id, t.title, 'self', t.id, String(t.description ?? ''));
}

/** Merging `from` into `into`: its parts move along, or it becomes one part (its title and description). */
export function mergeParts(into: Row, from: Row) {
  ensureFirstPart(into);
  if (partCount(from.id)) {
    // Its own work was part one of it; now it is a merged task.
    run("UPDATE task_parts SET source_kind = 'task' WHERE task_id = ? AND source_kind = 'self'", from.id);
    const base = nextPos(into.id);
    run('UPDATE task_parts SET task_id = ?, position = position + ? WHERE task_id = ?', into.id, base, from.id);
    return;
  }
  insertPart(into.id, from.title, 'task', from.id, String(from.description ?? ''));
}

/**
 * Where a part named by update_task add_part came from: a task or discussion id, a thread message number on this
 * task, or a drawn note (attachment id). Returns the source, or an error.
 */
export function partSource(task: Row, source: string | undefined): { kind: PartSource; id: string | null } | { error: string } {
  const s = String(source ?? '').trim();
  if (!s) return { kind: 'message', id: null };
  if (/^(task|disc)_[0-9a-f]{10}$/.test(s)) {
    const t = get('SELECT id, kind, project_id FROM tasks WHERE id = ?', s);
    if (!t || t.project_id !== task.project_id) return { error: `No task or discussion ${s} on this project.` };
    return { kind: t.kind === 'discussion' ? 'discussion' : 'task', id: s };
  }
  if (/^att_[0-9a-f]{10}$/.test(s)) {
    if (!get('SELECT 1 AS x FROM attachments WHERE id = ?', s)) return { error: `No attachment ${s}.` };
    return { kind: 'note', id: s };
  }
  if (/^\d+$/.test(s)) {
    if (!get('SELECT 1 AS x FROM task_messages WHERE id = ? AND task_id = ?', Number(s), task.id)) return { error: `No message ${s} in this task's thread.` };
    return { kind: 'message', id: s };
  }
  return { error: 'source is a task or discussion id, a message number in this task\'s thread, or a drawn note (attachment id).' };
}

/** update_task add_part: one more piece of work folded into the task. */
export function addPart(task: Row, title: string, src: { kind: PartSource; id: string | null }, body: string) {
  ensureFirstPart(task);
  insertPart(task.id, title, src.kind, src.id, body);
}

/** The parts as the task page shows them: each with a link and words for its source. */
export function partsView(taskId: string): Row[] {
  return all('SELECT * FROM task_parts WHERE task_id = ? ORDER BY position, id', taskId).map((p) => {
    let source: { label: string; ref: string | null; excerpt?: string } = { label: '', ref: null };
    if (p.source_kind === 'task' || p.source_kind === 'discussion') source = { label: p.source_kind === 'task' ? 'Merged task' : 'Discussion', ref: p.source_id };
    else if (p.source_kind === 'message' && p.source_id) {
      const m = get('SELECT author, author_name, body FROM task_messages WHERE id = ?', Number(p.source_id));
      source = { label: m ? `${m.author === 'user' ? 'Your' : `${m.author_name}'s`} message` : 'A message', ref: null, excerpt: m ? String(m.body).replace(/\s+/g, ' ').slice(0, 160) : undefined };
    } else if (p.source_kind === 'note') source = { label: 'Drawn note', ref: p.source_id };
    else if (p.source_kind === 'self') source = { label: 'The task itself', ref: null };
    return { id: p.id, title: p.title, body: p.body, kind: p.source_kind, source };
  });
}
