import { get } from './db.ts';

/**
 * What the user was looking at when they wrote in the chat with the director (web/src/chat.tsx): a request, a
 * preview, a report, a task, a discussion or a Spec entry. The message itself is routed as before (thread message,
 * Spec discussion, general conversation); this adds a machine-readable block the director reads with it, so "make
 * this bigger" names its object. It is appended to what the director receives and is not stored in the thread.
 */

/** The resolved context: the block the director reads, and the reference kept on the user's message for display. */
export type Viewing = { block: string; ref: { kind: string; id: string; title: string } };

const TABLE: Record<string, { table: string; label: string }> = {
  request: { table: 'inbox', label: 'request' },
  preview: { table: 'previews', label: 'preview' },
  report: { table: 'reports', label: 'report' },
  task: { table: 'tasks', label: 'task' },
  discussion: { table: 'tasks', label: 'discussion' },
  doc: { table: 'docs', label: 'Spec entry' },
};

const attr = (s: string) => s.replace(/["<>\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

/** The block for one item of this project, or null when the context is missing, unknown or belongs elsewhere. */
export function contextBlock(projectId: string, raw: unknown): Viewing | null {
  if (!raw || typeof raw !== 'object') return null;
  const kind = String((raw as any).kind ?? '');
  const id = String((raw as any).id ?? '');
  const t = TABLE[kind];
  if (!t || !/^[a-z]+_[0-9a-f]+$/.test(id)) return null;
  const row = get(`SELECT title FROM ${t.table} WHERE id = ? AND project_id = ?`, id, projectId);
  if (!row) return null;
  const title = attr(String(row.title ?? ''));
  const block = `\n<viewing kind="${kind}" id="${id}" title="${title}">The user wrote this while looking at the ${t.label} [[${id}]]; "this" and "it" mean that ${t.label}.</viewing>`;
  return { block, ref: { kind, id, title } };
}

