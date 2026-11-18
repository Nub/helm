// References in agent-written text: [[task_0123456789]], [[id|label]], [[page:previews]], and bare ids of those
// shapes as a fallback. Pure functions (no React, no DOM), so refs.test.ts runs them under plain Node.
// The server side (ids, lookup, the find tool) is server/refs.ts.

export const REF_PREFIXES = ['task', 'disc', 'doc', 'pv', 'rp', 'ag', 'att', 'tb', 'host'] as const;
export const PAGES = ['overview', 'tasks', 'discussions', 'spec', 'previews', 'history', 'setup', 'agents', 'reports', 'hosts', 'toolbox', 'helm'] as const;
export type Page = (typeof PAGES)[number];

const ID = `(?:${REF_PREFIXES.join('|')})_[0-9a-f]{10}`;
const PAGE = `page:(?:${PAGES.join('|')})`;
/**
 * 1: id or page of an explicit [[...]], 2: its label, 3: a bare id. A bare id must stand alone: not part of a
 * longer word, a path, a query string or a URL (those characters before it, a word character after it).
 */
const REF_RE = new RegExp(`\\[\\[(${ID}|${PAGE})(?:\\|([^\\]\\n|]{1,120}))?\\]\\]|(?<![\\w/#=.:@%&?-])(${ID})(?![\\w-])`, 'g');

export type RefToken = { id: string; label?: string; explicit: boolean };
export type RefPart = string | RefToken;

/** Splits plain text (not markdown: callers skip code and links) into text and references. */
export function splitRefs(text: string): RefPart[] {
  const out: RefPart[] = [];
  let at = 0;
  for (const m of text.matchAll(REF_RE)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    const label = m[2]?.trim();
    out.push(m[3] ? { id: m[3], explicit: false } : { id: m[1], ...(label ? { label } : {}), explicit: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Item ids a text names (pages left out), for looking them up before rendering. May include ids in code. */
export function refIds(text: string): string[] {
  if (!text || !/_[0-9a-f]{10}/.test(text)) return [];
  return [...new Set(splitRefs(text).flatMap((p) => (typeof p === 'string' || p.id.startsWith('page:') ? [] : [p.id])))];
}

/** What a chip shows; mirrors RefInfo in server/refs.ts. */
export type RefInfo = {
  id: string;
  kind: 'task' | 'discussion' | 'doc' | 'preview' | 'report' | 'agent' | 'attachment' | 'toolbox' | 'host';
  title: string;
  state: string;
  project_id: string | null;
  project_name: string | null;
  href: string;
  thumb: string | null;
};
/** undefined: not looked up yet; null: no such item. */
export type Resolve = (id: string) => RefInfo | null | undefined;

const PAGE_LABEL: Record<Page, string> = {
  overview: 'Overview', tasks: 'Tasks', discussions: 'Discussions', spec: 'Spec', previews: 'Previews', history: 'History', setup: 'Setup',
  agents: 'Agents', reports: 'Reports', hosts: 'Hosts', toolbox: 'Toolbox', helm: 'Helm updates',
};
/** Pages outside any project. */
const GLOBAL_PAGES: Page[] = ['hosts', 'toolbox', 'helm'];

export function pageHref(page: Page, projectId: string | null): string | null {
  if (GLOBAL_PAGES.includes(page)) return `#/${page}`;
  return projectId ? `#/p/${encodeURIComponent(projectId)}/${page}` : null;
}

const KIND_WORD: Record<string, string> = {
  task: 'Task', disc: 'Discussion', doc: 'Spec entry', pv: 'Preview', rp: 'Report', ag: 'Agent', att: 'File', tb: 'Toolbox item', host: 'Host',
};
export const kindWord = (id: string) => KIND_WORD[id.split('_')[0]] ?? 'Item';

export function stateLabel(state: string): string {
  if (!state) return '';
  const s = state.replace(/_/g, ' ');
  return s[0].toUpperCase() + s.slice(1);
}

/** The words a reference stands for in a single line of plain text: its title, else its label, else the id. */
export function plainRefs(text: string, resolve: Resolve): string {
  if (!text.includes('[[') && !/_[0-9a-f]{10}/.test(text)) return text;
  return splitRefs(text)
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p.id.startsWith('page:')) return p.label ?? PAGE_LABEL[p.id.slice(5) as Page];
      const r = resolve(p.id);
      return p.label ?? (r ? r.title : p.explicit && r === undefined ? kindWord(p.id) : p.id);
    })
    .join('');
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Icon per kind: names in ui.tsx's icon set. */
export const KIND_ICON: Record<string, string> = {
  task: 'tasks', discussion: 'discuss', doc: 'spec', preview: 'previews', report: 'reports', agent: 'agents', attachment: 'file', toolbox: 'toolbox', host: 'hosts',
  overview: 'overview', tasks: 'tasks', discussions: 'discuss', spec: 'spec', previews: 'previews', history: 'history', setup: 'setup', agents: 'agents', reports: 'reports',
  hosts: 'hosts', helm: 'home',
};
const PREFIX_KIND: Record<string, string> = { task: 'task', disc: 'discussion', doc: 'doc', pv: 'preview', rp: 'report', ag: 'agent', att: 'attachment', tb: 'toolbox', host: 'host' };

export type ChipEnv = { resolve: Resolve; projectId: string | null; icon: (name: string) => string };

/** HTML for one reference: a link chip, or a plain "not found" span. Every value from outside is escaped. */
export function chipHtml(t: RefToken, env: ChipEnv): string {
  const icon = (k: string) => env.icon(KIND_ICON[k] ?? 'file');
  if (t.id.startsWith('page:')) {
    const page = t.id.slice(5) as Page;
    const label = t.label ?? PAGE_LABEL[page];
    const href = pageHref(page, env.projectId);
    if (!href) return `<span class="ref ref-page">${icon(page)}<span class="ref-t">${esc(label)}</span></span>`;
    return `<a class="ref ref-page" href="${esc(href)}">${icon(page)}<span class="ref-t">${esc(label)}</span></a>`;
  }
  const r = env.resolve(t.id);
  if (r === undefined) {
    // Still loading: the kind, not the raw id.
    return `<span class="ref ref-loading" data-ref="${esc(t.id)}">${icon(PREFIX_KIND[t.id.split('_')[0]])}<span class="ref-t">${esc(t.label ?? kindWord(t.id))}</span></span>`;
  }
  if (r === null) return `<span class="ref ref-missing" title="Not found in Helm">${esc(t.label ?? t.id)}</span>`;
  const other = r.project_id && env.projectId && r.project_id !== env.projectId ? r.project_name : null;
  const state = stateLabel(r.state);
  const lead = r.thumb ? `<img class="ref-img" src="${esc(r.thumb)}" alt="" loading="lazy">` : icon(r.kind);
  const title = t.label ?? r.title;
  return (
    `<a class="ref ref-${r.kind}${r.state ? ` st-${esc(r.state)}` : ''}" href="${esc(r.href)}" title="${esc(`${kindWord(t.id)}: ${r.title}${other ? ` (${other})` : ''}`)}">` +
    lead +
    `<span class="ref-t">${esc(title)}</span>` +
    (state ? `<span class="ref-s">${esc(state)}</span>` : '') +
    (other ? `<span class="ref-p">${esc(other)}</span>` : '') +
    `</a>`
  );
}

/** Text (already HTML-escaped) with its references turned into chips. */
export function refsToHtml(escapedText: string, env: ChipEnv): string {
  if (!escapedText.includes('[[') && !/_[0-9a-f]{10}/.test(escapedText)) return escapedText;
  // Labels arrive escaped; unescape them so chipHtml escapes once.
  const unesc = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e as string]!);
  const parts = splitRefs(escapedText);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (typeof p === 'string') {
      out += p;
      continue;
    }
    const chip = chipHtml(p.label ? { ...p, label: unesc(p.label) } : p, env);
    // Punctuation right after a chip stays on its line instead of wrapping alone to the next.
    const next = parts[i + 1];
    const punct = typeof next === 'string' ? /^[.,;:!?)\]]+/.exec(next)?.[0] : undefined;
    if (punct) {
      out += `<span class="ref-wrap">${chip}${punct}</span>`;
      parts[i + 1] = (next as string).slice(punct.length);
    } else out += chip;
  }
  return out;
}
