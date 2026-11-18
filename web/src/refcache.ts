import { useEffect, useState } from 'react';
import { api, useStream } from './api';
import type { Preview, ProjectState } from './api';
import type { RefInfo } from './refs';

// What reference chips show, by id. The open project's state fills it as it loads and changes (seedRefs); other
// ids are looked up in batches with GET /api/refs and looked up again when their project changes.

const cache = new Map<string, RefInfo | null>();
/** Ids kept current by seedRefs, so a change to their project needs no lookup. */
const seeded = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const f of listeners) f();
};

const wanted = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
function request(ids: Iterable<string>, delay = 30) {
  for (const id of ids) wanted.add(id);
  if (!wanted.size || timer) return;
  timer = setTimeout(async () => {
    timer = null;
    const batch = [...wanted].slice(0, 200);
    for (const id of batch) wanted.delete(id);
    try {
      const got = await api<Record<string, RefInfo | null>>(`/api/refs?ids=${batch.map(encodeURIComponent).join(',')}`);
      for (const id of batch) cache.set(id, got[id] ?? null);
    } catch {
      // Offline or signed out: they stay loading until the next change asks again.
    }
    changed();
    if (wanted.size) request([], 0);
  }, delay);
}

export const lookupRef = (id: string): RefInfo | null | undefined => cache.get(id);

/** Seeded while rendering, not yet announced. */
let dirty = false;
const route = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join('/')}`;
function previewThumb(p: Preview): string | null {
  if (p.kind === 'image' && p.file) return `/artifacts/${p.file}`;
  if (p.kind === 'compare' || p.kind === 'guide') {
    try {
      const c = JSON.parse(p.content ?? '');
      const f = p.kind === 'compare' ? c.after?.file : c.steps?.find((s: any) => s.image)?.image?.file;
      return f ? `/artifacts/${f}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Fill the cache from a project's state, so its own items show at once and stay current. Called while rendering
 * (notify false: the page's children render after it with the cache filled), then from an effect to tell the rest.
 */
export function seedRefs(s: ProjectState, notify = true) {
  const pid = s.project.id;
  const base = { project_id: pid, project_name: s.project.name, thumb: null };
  const put = (r: RefInfo) => {
    const old = cache.get(r.id);
    if (!old || old.title !== r.title || old.state !== r.state || old.thumb !== r.thumb || old.href !== r.href) {
      cache.set(r.id, r);
      seeded.add(r.id);
      return true;
    }
    seeded.add(r.id);
    return false;
  };
  let any = false;
  for (const t of [...s.tasks, ...s.discussions]) {
    const disc = (t as any).kind === 'discussion';
    any = put({ ...base, id: t.id, kind: disc ? 'discussion' : 'task', title: t.title, state: t.state, href: route('p', pid, disc ? 'discussions' : 'tasks', t.id) }) || any;
  }
  for (const d of s.docs) any = put({ ...base, id: d.id, kind: 'doc', title: d.title, state: d.status, href: route('p', pid, 'spec', d.id) }) || any;
  for (const p of s.previews) any = put({ ...base, id: p.id, kind: 'preview', title: p.title, state: '', href: route('p', pid, 'previews', p.id), thumb: previewThumb(p) }) || any;
  for (const a of s.agents) any = put({ ...base, id: a.id, kind: 'agent', title: a.name, state: a.status, href: route('p', pid, 'agents', a.id) }) || any;
  dirty ||= any;
  if (dirty && notify) {
    dirty = false;
    changed();
  }
}

/** Re-render when any of `ids` resolves or changes; looks up the ones not known yet. */
export function useRefs(ids: string[]): number {
  const [, set] = useState(0);
  const key = ids.join(',');
  useEffect(() => {
    if (!ids.length) return;
    const missing = ids.filter((id) => !cache.has(id));
    if (missing.length) request(missing);
    const f = () => set(version);
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, [key]);
  return ids.length ? version : 0;
}

/** Mount once: when a project changes, look up again the ids of its items the cache holds (and the not-found ones). */
export function useRefRefresh() {
  useStream((m) => {
    if (m.type !== 'project' && m.type !== 'reconnect') return;
    const again = [...cache].filter(([id, r]) => !seeded.has(id) && ( r === null || m.type === 'reconnect' || r.project_id === m.projectId || r.project_id === null)).map(([id]) => id);
    if (again.length) request(again, 800);
  });
}
