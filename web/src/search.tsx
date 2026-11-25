import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { ApiError, api } from './api';
import type { ProjectState } from './api';
import { openChat } from './chat';
import { TASK_STATE_LABEL } from './tasks';
import { Icon, Tag, ago, href, useAction } from './ui';
import { bytes } from './disk';
import { dateOnly } from './time';

/**
 * The search at the top of a project's Home (and, on a computer, "/" or Ctrl/Cmd-K on any project page, which opens
 * it as an overlay away from Home). Results come as you type from GET /api/search (server/searchapi.ts, matching and
 * ranking shared with the agents' find tool), grouped by kind. The query, the All projects switch and whether the
 * search is open are kept for the browser tab, so Back from a result returns to Home with them as they were. With
 * nothing typed it shows what the user opened from here lately, then what changed lately.
 */

export type SearchKind = 'task' | 'discussion' | 'doc' | 'chat' | 'preview' | 'report' | 'agent' | 'journal' | 'knowledge' | 'dashboard' | 'history';
/** title_hl and line: a ranked search marks what matched with U+E000 … U+E001 (server/searchapi.ts). */
export type SearchItem = { kind: SearchKind; id: string; project_id: string; project?: string; title: string; title_hl?: string; state: string; ts: number; line: string };
type Group = { kind: SearchKind; total: number; capped: boolean; items: SearchItem[] };
type View = { terms: string[]; ms: number; groups: Group[] };

const GROUP_LABEL: Record<SearchKind, string> = { task: 'Tasks', discussion: 'Discussions', doc: 'Spec entries', chat: 'Chat', preview: 'Previews', report: 'Reports', agent: 'Agents', journal: 'Journal', knowledge: 'Knowledge', dashboard: 'Dashboards', history: 'Agent history' };
const KIND_ICON: Record<SearchKind, string> = { task: 'tasks', discussion: 'discuss', doc: 'spec', chat: 'discuss', preview: 'previews', report: 'reports', agent: 'agents', journal: 'history', knowledge: 'knowledge', dashboard: 'dashboards', history: 'agents' };

/** Where an item lives: its page, for a journal entry Home's Journal scrolled to it, for a chat message the chat at it. */
export function itemHref(i: { kind: SearchKind; id: string; project_id: string }): string {
  // History: the agent's transcript (the id is "<agent>#<event>").
  if (i.kind === 'history') return href('p', i.project_id, 'agents', i.id.split('#')[0]);
  if (i.kind === 'journal') return href('p', i.project_id, 'overview', 'journal', `j${i.id}`);
  // A knowledge note opens Setup's Knowledge section, where every note is shown.
  if (i.kind === 'knowledge') return href('p', i.project_id, 'setup', 'knowledge');
  // A preview: the viewer, over its task (more.tsx PreviewHost).
  const page = { task: 'tasks', discussion: 'discussions', doc: 'spec', chat: 'chat', preview: 'previews', report: 'reports', agent: 'agents', dashboard: 'dashboards' }[i.kind];
  return href('p', i.project_id, page, i.id);
}

/** The same rule as the server's (search.ts searchWords): words of two letters or more. */
const words = (q: string) => q.toLowerCase().split(/\s+/).filter((t) => t.replace(/[%_]/g, '').length > 1);

// ---------- state kept for the tab ----------

export type SearchState = {
  q: string;
  everywhere: boolean;
  open: boolean;
  /** "Show all" of one group. */
  kind: SearchKind | null;
};
const EMPTY: SearchState = { q: '', everywhere: false, open: false, kind: null };
const stateKey = (pid: string, place: string) => `helm-search:${place}:${pid}`;

export function useSearchState(pid: string, place: 'home' | 'overlay') {
  const [st, setSt] = useState<SearchState>(() => {
    if (place === 'overlay') return { ...EMPTY, open: true };
    try {
      return { ...EMPTY, ...JSON.parse(sessionStorage.getItem(stateKey(pid, place)) ?? '{}') };
    } catch {
      return EMPTY;
    }
  });
  useEffect(() => {
    if (place === 'home') sessionStorage.setItem(stateKey(pid, place), JSON.stringify(st));
  }, [st, pid, place]);
  return [st, (patch: Partial<SearchState>) => setSt((o) => ({ ...o, ...patch }))] as const;
}

// ---------- recently opened ----------

type Recent = Omit<SearchItem, 'line' | 'title_hl'>;
const RECENT_KEY = 'helm-search-recent';
const readRecent = (): Recent[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
};
function remember(i: SearchItem | Recent) {
  const { kind, id, project_id, project, title, state } = i;
  const list = [{ kind, id, project_id, project, title, state, ts: Date.now() }, ...readRecent().filter((r) => !(r.kind === kind && r.id === id))];
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 30)));
}

/** What the user opened from the search in this project, then what changed lately, without repeats. */
function recentItems(s: ProjectState): { opened: Recent[]; changed: Recent[] } {
  const pid = s.project.id;
  const opened = readRecent()
    .filter((r) => r.project_id === pid)
    .slice(0, 5);
  const seen = new Set(opened.map((r) => `${r.kind}:${r.id}`));
  const all: Recent[] = [
    ...s.tasks.map((t) => ({ kind: 'task' as const, id: t.id, project_id: pid, title: t.title, state: t.state, ts: t.updated_at })),
    ...s.discussions.filter((d) => d.kind !== 'task').map((d) => ({ kind: 'discussion' as const, id: d.id, project_id: pid, title: d.title, state: d.state, ts: d.updated_at })),
    ...s.docs.map((d) => ({ kind: 'doc' as const, id: d.id, project_id: pid, title: d.title, state: d.status, ts: d.updated_at })),
    ...s.previews.map((p) => ({ kind: 'preview' as const, id: p.id, project_id: pid, title: p.title, state: p.kind, ts: p.created_at })),
  ];
  const changed = all
    .filter((r) => !seen.has(`${r.kind}:${r.id}`))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 6);
  return { opened, changed };
}

// ---------- fetching ----------

/** Results for the query, fetched a moment after typing stops; a newer query cancels the one in flight. */
function useResults(q: string, pid: string, everywhere: boolean, kind: SearchKind | null) {
  const [res, setRes] = useState<{ view: View | null; error: string; loading: boolean }>({ view: null, error: '', loading: false });
  const has = words(q).length > 0;
  useEffect(() => {
    if (!has) {
      setRes({ view: null, error: '', loading: false });
      return;
    }
    const ctl = new AbortController();
    setRes((r) => ({ ...r, loading: true }));
    const timer = setTimeout(async () => {
      const qs = new URLSearchParams({ q: q.trim() });
      if (everywhere) qs.set('all', '1');
      else qs.set('project', pid);
      if (kind) qs.set('kind', kind);
      try {
        const r = await fetch(`/api/search?${qs}`, { signal: ctl.signal, credentials: 'same-origin' });
        const data = await r.json().catch(() => null);
        if (!r.ok) throw new ApiError(data?.error ?? `Search failed (${r.status})`, r.status);
        setRes({ view: data, error: '', loading: false });
      } catch (err: any) {
        if (!ctl.signal.aborted) setRes({ view: null, error: err.message ?? 'Search failed', loading: false });
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [q, pid, everywhere, kind, has]);
  return { ...res, has };
}

// ---------- pieces ----------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MARKS = /[\uE000\uE001]/;

/** The text with what matched marked: the server's marks when it sent them (ranked search), else the search words. */
function Hl({ text, terms }: { text: string; terms: string[] }) {
  if (MARKS.test(text)) {
    // "a\uE000b\uE001c" splits into a, b, c: every second part was marked.
    const parts = text.split(/\uE000|\uE001/);
    return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
  }
  if (!terms.length || !text) return <>{text}</>;
  const parts = text.split(new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi'));
  return <>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

function StateChip({ kind, state }: { kind: SearchKind; state: string }) {
  // A chat message's group says what it is.
  if (!state || kind === 'chat') return null;
  if (kind === 'task' && state in TASK_STATE_LABEL) return <Tag tone={`task-st ts-${state}`}>{TASK_STATE_LABEL[state as keyof typeof TASK_STATE_LABEL]}</Tag>;
  if (kind === 'discussion') return <Tag tone={`task-st ds-${state}`}>{state === 'settled' ? 'Closed' : 'Open'}</Tag>;
  return <Tag>{state.replace(/_/g, ' ')}</Tag>;
}

function Row({ i, terms, onOpen }: { i: SearchItem | Recent; terms: string[]; onOpen?: () => void }) {
  const line = 'line' in i ? i.line : '';
  return (
    <li>
      <a
        className="hs-row"
        href={itemHref(i)}
        onClick={() => {
          remember(i);
          onOpen?.();
        }}
      >
        <span className="hs-ico">
          <Icon name={KIND_ICON[i.kind]} size={20} />
        </span>
        <span className="hs-txt">
          <span className="hs-top">
            <span className="hs-t">
              <Hl text={'title_hl' in i && i.title_hl ? i.title_hl : i.title} terms={terms} />
            </span>
            <span className="hs-age">{ago(i.ts)}</span>
          </span>
          <span className="hs-sub">
            <StateChip kind={i.kind} state={i.state} />
            {i.project && <span className="hs-proj">{i.project}</span>}
            {line && (
              <span className="hs-line">
                <Hl text={line} terms={terms} />
              </span>
            )}
          </span>
        </span>
      </a>
    </li>
  );
}

// ---------- the field and its results ----------

export type SearchBoxHandle = { focus: () => void };

/** The field: the search icon, the box, clear, and Cancel while the search is open. */
export const SearchBox = forwardRef<SearchBoxHandle, { st: SearchState; set: (p: Partial<SearchState>) => void; onCancel?: () => void }>(function SearchBox({ st, set, onCancel }, ref) {
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);
  const cancel = () => {
    set({ q: '', open: false, kind: null });
    input.current?.blur();
    onCancel?.();
  };
  return (
    <div className={`hs-box ${st.open ? 'open' : ''}`} role="search">
      <label className="hs-field">
        <Icon name="search" size={20} />
        <input
          ref={input}
          type="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={st.q}
          placeholder="Search this project"
          aria-label="Search this project"
          onFocus={() => !st.open && set({ open: true })}
          onChange={(e) => set({ q: e.target.value, kind: null, open: true })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              cancel();
            }
            if (e.key === 'Enter') input.current?.blur();
          }}
        />
        {st.q && (
          <button type="button" className="hs-clear" onClick={() => (set({ q: '', kind: null }), input.current?.focus())} aria-label="Clear the search">
            <Icon name="close" size={16} />
          </button>
        )}
      </label>
      {st.open && (
        <button type="button" className="btn quiet hs-cancel" onClick={cancel}>
          Cancel
        </button>
      )}
    </div>
  );
});

/** Under the field while the search is open: the All projects switch, then recent items or the results. */
export function SearchResults({ s, st, set, onOpen }: { s: ProjectState; st: SearchState; set: (p: Partial<SearchState>) => void; onOpen?: () => void }) {
  const pid = s.project.id;
  const { view, error, loading, has } = useResults(st.q, pid, st.everywhere, st.kind);
  const terms = view?.terms ?? [];
  const groups = view?.groups ?? [];
  const director = s.agents.find((a) => !a.parent_id)?.name ?? 'the director';
  return (
    <div className="hs-results" aria-busy={loading}>
      <div className="hs-scope">
        <button type="button" className={`chip ${st.everywhere ? '' : 'on'}`} aria-pressed={!st.everywhere} onClick={() => set({ everywhere: false, kind: null })}>
          This project
        </button>
        <button type="button" className={`chip ${st.everywhere ? 'on' : ''}`} aria-pressed={st.everywhere} onClick={() => set({ everywhere: true, kind: null })}>
          All projects
        </button>
        <span className="hs-status muted small" role="status">
          {loading ? 'Searching…' : view && has ? `${groups.reduce((n, g) => n + g.total, 0)}${groups.some((g) => g.capped) ? '+' : ''} found` : ''}
        </span>
      </div>
      {!has ? (
        <Recents s={s} onOpen={onOpen} />
      ) : error ? (
        <p className="error-text small">{error}</p>
      ) : view && !groups.length ? (
        <div className="hs-none">
          <p>
            Nothing {st.everywhere ? 'in any project' : 'in this project'} matches “{st.q.trim()}”.
          </p>
          <div className="hs-none-acts">
            {!st.everywhere && (
              <button type="button" className="btn" onClick={() => set({ everywhere: true })}>
                Search all projects
              </button>
            )}
            <button type="button" className="btn primary" onClick={() => openChat({ kind: 'general' }, { draft: `Can you find “${st.q.trim()}”? ` })}>
              <Icon name="discuss" size={16} /> Ask {director}
            </button>
          </div>
        </div>
      ) : (
        <>
          {st.kind && (
            <button type="button" className="btn quiet hs-back" onClick={() => set({ kind: null })}>
              <Icon name="back" size={16} /> All results
            </button>
          )}
          {groups.map((g) => (
            <section key={g.kind} className="hs-group" aria-label={GROUP_LABEL[g.kind]}>
              <h3 className="hs-h">
                {GROUP_LABEL[g.kind]} <span className="muted">{g.total}{g.capped ? '+' : ''}</span>
              </h3>
              <ul className="hs-list">
                {g.items.map((i) => (
                  <Row key={`${i.kind}:${i.id}`} i={i} terms={terms} onOpen={onOpen} />
                ))}
              </ul>
              {!st.kind && g.total > g.items.length && (
                <button type="button" className="btn quiet hs-all" onClick={() => set({ kind: g.kind })}>
                  Show all {g.total}
                  {g.capped ? '+' : ''} <Icon name="chevron" size={16} />
                </button>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function Recents({ s, onOpen }: { s: ProjectState; onOpen?: () => void }) {
  const { opened, changed } = recentItems(s);
  return (
    <>
      {opened.length > 0 && (
        <section className="hs-group" aria-label="Opened lately">
          <h3 className="hs-h">Opened lately</h3>
          <ul className="hs-list">
            {opened.map((i) => (
              <Row key={`${i.kind}:${i.id}`} i={i} terms={[]} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      )}
      {changed.length > 0 && (
        <section className="hs-group" aria-label="Changed lately">
          <h3 className="hs-h">Changed lately</h3>
          <ul className="hs-list">
            {changed.map((i) => (
              <Row key={`${i.kind}:${i.id}`} i={i} terms={[]} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// ---------- "/" and Ctrl/Cmd-K ----------

let focusHome: (() => void) | null = null;
let openOverlay: (() => void) | null = null;
/** The top bar's Search on a phone: Home's field when on Home, else the overlay. */
export function openProjectSearch() {
  if (focusHome) focusHome();
  else openOverlay?.();
}
/** Home registers how to focus its field, so the shortcut uses it there instead of the overlay. */
export function useHomeSearchFocus(fn: () => void) {
  useEffect(() => {
    focusHome = fn;
    return () => {
      if (focusHome === fn) focusHome = null;
    };
  }, [fn]);
}
/** Open the search on Home: show the field (it may be folded behind a card on a phone) and focus it in the same tap. */
export function openHomeSearch(set: (p: Partial<SearchState>) => void, box: SearchBoxHandle | null) {
  flushSync(() => set({ open: true }));
  box?.focus();
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

/**
 * On every project page: "/" (outside a text box) or Ctrl/Cmd-K focuses Home's search, or opens it over the page; so
 * does the top bar's Search on a phone (main.tsx).
 */
export function SearchShortcut({ s }: { s: ProjectState }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    openOverlay = () => setOpen(true);
    return () => {
      openOverlay = null;
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
      const slash = e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target);
      if (!k && !slash) return;
      if (document.querySelector('.sheet-backdrop, .viewer') && !open) return;
      e.preventDefault();
      if (focusHome) focusHome();
      else setOpen(true);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);
  // Leaving the page (a result, Back) closes it.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    addEventListener('hashchange', close);
    return () => removeEventListener('hashchange', close);
  }, [open]);
  return open ? <SearchOverlay s={s} onClose={() => setOpen(false)} /> : null;
}

function SearchOverlay({ s, onClose }: { s: ProjectState; onClose: () => void }) {
  const [st, set] = useSearchState(s.project.id, 'overlay');
  const box = useRef<SearchBoxHandle>(null);
  useEffect(() => box.current?.focus(), []);
  useEffect(() => {
    if (!st.open) onClose();
  }, [st.open]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="hs-overlay-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="hs-overlay" role="dialog" aria-label="Search">
        <SearchBox ref={box} st={st} set={set} />
        <SearchResults s={s} st={st} set={set} onOpen={onClose} />
      </div>
    </div>
  );
}

// ---------- the index behind it (Helm page) ----------

type Bench = { measured_at: string; factor: number; query_ms: { p95: number }; history_ms: { p95: number } };
type IndexStatus = { ready: boolean; history?: boolean; rows: number; building: boolean; sources: number; done: number; bytes: number | null; speed?: { live: { p95: number; n: number } | null; bench: Bench | null } };

/**
 * The ranked search's full-text index (server/searchindex.ts) on the Helm page: ready or how far its build is, its
 * size, and Rebuild for when results look wrong. Searches use word matching while it builds.
 */
export function SearchIndexCard() {
  const [st, setSt] = useState<IndexStatus | null>(null);
  const { busy, error, run } = useAction();
  useEffect(() => {
    let live = true;
    const load = () => api<IndexStatus>('/api/search/index').then((s) => live && setSt(s), () => {});
    load();
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  if (!st) return null;
  return (
    <>
      <h2>Search index</h2>
      <div className="card search-index-card">
        <p className="small">
          {st.ready ? (
            <>
              Ready · {st.rows.toLocaleString()} {st.rows === 1 ? 'item' : 'items'}
              {st.bytes != null && <> · {bytes(st.bytes)}</>}
            </>
          ) : (
            <>
              Building ({st.done} of {st.sources} kinds of item). Searches match words as typed until it is done.
            </>
          )}
        </p>
        {st.speed && (st.speed.live || st.speed.bench) && (
          <p className="muted small">
            {st.speed.live ? `Answers in ${st.speed.live.p95} ms (95% of the last ${st.speed.live.n} searches)` : ''}
            {st.speed.live && st.speed.bench ? ' · ' : ''}
            {st.speed.bench ? `${st.speed.bench.query_ms.p95} ms at ${st.speed.bench.factor}× today's data (measured ${dateOnly(Date.parse(`${st.speed.bench.measured_at}T12:00:00Z`))})` : ''}
            {st.ready && st.history === false ? ' · agent history still being added' : ''}
          </p>
        )}
        <button className="btn" disabled={busy || !st.ready} onClick={() => run(async () => setSt(await api<IndexStatus>('/api/search/index/rebuild', { method: 'POST' })))}>
          Rebuild
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>
    </>
  );
}
