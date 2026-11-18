import { all, get } from './db.ts';
import type { Row } from './db.ts';

// References: how agents name Helm items so the dashboard can show them as links. An agent writes
// [[task_0123456789]] (or [[id|label]], or [[page:previews]]); the web app (web/src/refs.ts) turns it into a chip
// with the item's current title and state. This file resolves ids for that chip and accepts the same form
// wherever a tool takes an id.

/** Prefixes of the ids newId() makes for items a reference can name. */
export const REF_PREFIXES = ['task', 'disc', 'doc', 'pv', 'rp', 'ag', 'att', 'tb', 'host'] as const;
export const REF_ID = new RegExp(`^(?:${REF_PREFIXES.join('|')})_[0-9a-f]{10}$`);

/** The reference an agent can paste: [[id]]. */
export const ref = (id: string) => `[[${id}]]`;

/** "[[task_x]]", "[[task_x|label]]" or "task_x" -> "task_x"; anything else is returned unchanged. */
export function unref(s: string): string {
  const m = /^\s*\[\[([a-z]+_[0-9a-f]{10})(?:\|[^\]]*)?\]\]\s*$/.exec(s);
  return m ? m[1] : s;
}

/** Tool parameters that name an item. Only these are unwrapped: free text (bodies, summaries, answers) is kept as written. */
const ID_KEYS = new Set(['id', 'ids', 'task', 'for_task', 'discussion', 'doc', 'docs', 'entry', 'preview', 'previews', 'report', 'duplicate_of', 'agent', 'driver', 'because', 'before', 'after', 'update_of', 'host']);

/** Tool input with id parameters given as [[id]] (agents copy them from results) replaced by the id. */
export function unrefInput<T>(v: T, key = ''): T {
  if (typeof v === 'string') return (ID_KEYS.has(key) ? unref(v) : v) as T;
  if (Array.isArray(v)) return v.map((x) => unrefInput(x, key)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unrefInput(x, k)])) as T;
  return v;
}

export type RefKind = 'task' | 'discussion' | 'doc' | 'preview' | 'report' | 'agent' | 'attachment' | 'toolbox' | 'host';
export type RefInfo = {
  id: string;
  kind: RefKind;
  title: string;
  /** The item's state where it has one (task state, discussion open/settled, Spec status, report status, agent status). */
  state: string;
  /** The project it belongs to; null for install-wide items (Toolbox, hosts). */
  project_id: string | null;
  project_name: string | null;
  /** Where tapping it goes: an in-app route (#/p/...) or, for a lone file, its URL. */
  href: string;
  /** A small image for previews and attachments that have one. */
  thumb: string | null;
};

const route = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join("/")}`;
const projectName = (id: string | null) => (id ? (get('SELECT name FROM projects WHERE id = ?', id)?.name ?? null) : null);

function previewThumb(p: Row): string | null {
  if (p.kind === 'image' && p.file) return `/artifacts/${p.file}`;
  if (p.kind === 'compare' || p.kind === 'guide') {
    try {
      const c = JSON.parse(p.content ?? '');
      const f = p.kind === 'compare' ? c.after?.file : c.steps?.find((s: Row) => s.image)?.image?.file;
      return f ? `/artifacts/${f}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** One id to what a chip shows, or null when nothing has that id. Old task ids (aliases) resolve to their task. */
export function resolveRef(id: string): RefInfo | null {
  const base = (kind: RefKind, r: Row, title: string, state: string, href: string, thumb: string | null = null): RefInfo => ({
    id: r.id, kind, title, state, project_id: r.project_id ?? null, project_name: projectName(r.project_id ?? null), href, thumb,
  });
  const prefix = id.split('_')[0];
  if (prefix === 'task' || prefix === 'disc') {
    const t = get('SELECT * FROM tasks WHERE id = ?', id) ?? get('SELECT t.* FROM task_aliases a JOIN tasks t ON t.id = a.task_id WHERE a.alias_id = ?', id);
    if (!t) return null;
    const disc = t.kind === 'discussion';
    return { ...base(disc ? 'discussion' : 'task', t, t.title, t.state, route('p', t.project_id, disc ? 'discussions' : 'tasks', t.id)), id };
  }
  if (prefix === 'doc') {
    const d = get('SELECT id, project_id, title, status FROM docs WHERE id = ?', id);
    return d ? base('doc', d, d.title, d.status, route('p', d.project_id, 'spec', d.id)) : null;
  }
  if (prefix === 'pv') {
    const p = get('SELECT * FROM previews WHERE id = ?', id);
    return p ? base('preview', p, p.title, '', route('p', p.project_id, 'previews', p.id), previewThumb(p)) : null;
  }
  if (prefix === 'rp') {
    const r = get('SELECT id, project_id, title, status FROM reports WHERE id = ?', id);
    return r ? base('report', r, r.title, r.status, route('p', r.project_id, 'reports', r.id)) : null;
  }
  if (prefix === 'ag') {
    const a = get('SELECT id, project_id, name, status FROM agents WHERE id = ?', id);
    return a ? base('agent', a, a.name, a.status, route('p', a.project_id, 'agents', a.id)) : null;
  }
  if (prefix === 'att') {
    const a = get('SELECT id, project_id, owner_kind, owner_id, name, kind FROM attachments WHERE id = ?', id);
    if (!a) return null;
    // Open the item it is attached to, where it is shown with its context; a lone file opens by itself.
    const taskId =
      a.owner_kind === 'task' ? a.owner_id
      : a.owner_kind === 'message' ? get('SELECT task_id FROM task_messages WHERE id = ?', Number(a.owner_id))?.task_id
      : a.owner_kind === 'inbox' ? get('SELECT task_id FROM inbox WHERE id = ?', a.owner_id)?.task_id
      : null;
    const owner = a.owner_kind === 'doc' ? route('p', a.project_id, 'spec', a.owner_id) : taskId ? resolveRef(taskId)?.href : null;
    return base('attachment', a, a.name, '', owner ?? `/api/attachments/${a.id}/file`, a.kind === 'image' ? `/api/attachments/${a.id}/file` : null);
  }
  if (prefix === 'tb') {
    const t = get('SELECT id, name, status FROM toolbox_items WHERE id = ?', id);
    return t ? base('toolbox', t, t.name, t.status, route('toolbox')) : null;
  }
  if (prefix === 'host') {
    const h = get('SELECT id, name, check_state FROM hosts WHERE id = ?', id);
    return h ? base('host', h, h.name, h.check_state, route('hosts')) : null;
  }
  return null;
}

/** GET /api/refs?ids=a,b: each well-formed id to its chip info or null. Unknown shapes are left out. */
export function resolveRefs(ids: string[]): Record<string, RefInfo | null> {
  const out: Record<string, RefInfo | null> = {};
  for (const id of [...new Set(ids)].slice(0, 200)) if (REF_ID.test(id)) out[id] = resolveRef(id);
  return out;
}

