import { all } from './db.ts';
import type { Row } from './db.ts';
import { relatedHits } from './related.ts';

/**
 * A task's References (About on its page): the Spec entries it implements (and those its "Spec for" discussion is
 * linked to), then related work, best first: what it waits for and what waits for it, tasks merged into it, the
 * discussions it came from or that look for its entry, its reports, and what related.ts finds by search (similar tasks,
 * concluded discussions, decisions). Computed on read: the search takes about 4 ms on a real project.
 */
export const REFERENCES_MAX = 8;

/**
 * Kept per task in the process that serves the page, for CACHE_MS or until the task changes (updated_at): the search
 * would otherwise add about 5 ms to every task page load. A related item added elsewhere shows within CACHE_MS.
 */
export const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { key: number; at: number; value: { spec: string[]; related: string[] } }>();

export function taskReferences(t: Row): { spec: string[]; related: string[] } {
  const hit = cache.get(t.id);
  if (hit && hit.key === t.updated_at && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = computeReferences(t);
  if (cache.size > 500) cache.clear();
  cache.set(t.id, { key: t.updated_at, at: Date.now(), value });
  return value;
}

function computeReferences(t: Row): { spec: string[]; related: string[] } {
  const ids = (rows: Row[]) => rows.map((r) => String(r.id));
  const spec = [
    ...(t.doc_id ? [String(t.doc_id)] : []),
    ...ids(all("SELECT doc_id AS id FROM doc_links WHERE task_id = ? AND relation = 'implements' ORDER BY id", t.id)),
    ...ids(all("SELECT DISTINCT l.doc_id AS id FROM doc_links l JOIN tasks d ON d.id = l.task_id WHERE d.about_task = ?", t.id)),
  ];
  const known = [
    ...ids(all('SELECT waits_for AS id FROM task_waits WHERE task_id = ? ORDER BY created_at', t.id)),
    ...ids(all('SELECT task_id AS id FROM task_waits WHERE waits_for = ? ORDER BY created_at', t.id)),
    ...ids(all('SELECT id FROM tasks WHERE merged_into = ? ORDER BY updated_at', t.id)),
    ...ids(all('SELECT discussion_id AS id FROM discussion_tasks WHERE task_id = ? ORDER BY created_at', t.id)),
    ...ids(all("SELECT id FROM tasks WHERE about_task = ? AND kind = 'discussion' ORDER BY created_at", t.id)),
    ...ids(all('SELECT id FROM reports WHERE task_id = ? ORDER BY created_at', t.id)),
  ];
  const found = relatedHits(t, REFERENCES_MAX).map((h) => String(h.kind === 'decision' ? (h.row.task_id ?? h.row.doc_id ?? '') : h.row.id));
  const uniqueSpec = [...new Set(spec)];
  const related = [...new Set([...known, ...found])].filter((id) => id && id !== t.id && !uniqueSpec.includes(id)).slice(0, REFERENCES_MAX);
  return { spec: uniqueSpec, related };
}
