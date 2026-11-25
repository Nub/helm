import { useEffect, useMemo, useState } from 'react';
import { api, useLive } from './api';
import type { Doc, DocHistory, DocSection, DocSnapshot, EntryChange, LinkedTask, ProjectState, SettingGroup, Task, TaskSpec } from './api';
import { diffTokens, firstSentence, readable, words } from './diff';
import { DiscussionStateTag } from './discussions';
import { Menu, TaskStateTag } from './tasks';
import { ImportanceControl, ImportanceMeter, ImportancePicker, ImportanceTag, LEVEL, TieredList, overText, recentChange } from './importance';
import { Empty, Icon, Markdown, Sheet, Tag, ago, clock, href, importanceName, useAction, useTick } from './ui';
import { ClipCount, References } from './attachments';
import { DiscussButton, DiscussingMarker } from './specdiscuss';
import { SpecWorkButton } from './specwork';
import { MAX_DEPTH, ancestors, buildTree, pathNames, sectionMoveError } from './spectree';
import type { SecNode, SecTree } from './spectree';

/**
 * The Spec: what the project should be, as one document in sections. There is one
 * kind of entry: its summary says what must be true, its text how it works. Each
 * entry collapses to its title, summary, status and tags; its history holds the
 * work and discussions that changed or uphold it and the decisions recorded about
 * it. Editing an entry starts a planning discussion with the director (server/spec.ts).
 */

/** 'goal' and 'design' are older names of an entry, until the server's migration has run. */
export const isEntry = (d: { kind: string }) => d.kind === 'entry' || d.kind === 'goal' || d.kind === 'design';
const FINISHED: Doc['status'][] = ['done', 'dropped'];

export function docStatusLabel(status: Doc['status']): string {
  return { active: 'In progress', proposed: 'Proposed', paused: 'Paused', done: 'Done', dropped: 'Dropped' }[status] ?? status;
}

const FLAG: Record<string, { label: string; tone: string }> = {
  changed: { label: 'Changed · not planned yet', tone: 'tone-warning' },
  planning: { label: 'Plan under discussion', tone: 'tone-accent' },
  not_planned: { label: 'Not planned', tone: 'tone-serious' },
};

const directorOf = (s: ProjectState) =>
  s.agents.find((a) => !a.parent_id && a.status !== 'closed')?.name ?? s.project.structure.roles.find((r) => r.id === s.project.structure.root)?.name ?? 'the director';

const isDiscussion = (t: { kind?: string }) => t.kind === 'discussion';
/** A task or a discussion as the Spec shows it. */
type Linked = { id: string; title: string; state: string; kind?: string; updated_at: number };
const OPEN_ITEM = ['planning', 'waiting', 'scheduled', 'active', 'paused', 'open'];

/** Tasks and discussions linked to an entry in any way, newest first. */
function linkedTasks(s: ProjectState, docId: string): Linked[] {
  const ids = new Set(s.docLinks.filter((l) => l.doc_id === docId).map((l) => l.task_id));
  for (const t of s.tasks) if (t.doc_id === docId) ids.add(t.id);
  const all: Linked[] = [...s.tasks, ...(s.discussions ?? []).map((d) => ({ ...d, kind: 'discussion' }))];
  return all.filter((t) => ids.has(t.id)).sort((a, b) => b.updated_at - a.updated_at);
}

/** Link and state tag for a task or a discussion. */
function LinkedItem({ pid, t }: { pid: string; t: Linked }) {
  return (
    <a href={href('p', pid, isDiscussion(t) ? 'discussions' : 'tasks', t.id)} className="spec-task-link">
      {isDiscussion(t) ? <DiscussionStateTag state={t.state as any} /> : <TaskStateTag state={t.state as any} />} <span>{t.title}</span>
      {isDiscussion(t) && <span className="muted small"> · discussion</span>}
    </a>
  );
}

function countLabel(tasks: { kind?: string }[]): string {
  const d = tasks.filter(isDiscussion).length;
  const t = tasks.length - d;
  return [t && `${t} ${t === 1 ? 'task' : 'tasks'}`, d && `${d} ${d === 1 ? 'discussion' : 'discussions'}`].filter(Boolean).join(', ');
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------- diffs ----------

/** Words removed and added, with long unchanged stretches folded to a little context. */
export function DiffText({ before, after }: { before: string; after: string }) {
  const ops = useMemo(() => readable(diffTokens(words(before), words(after))), [before, after]);
  const CONTEXT = 14;
  return (
    <div className="diff">
      {ops.map((o, i) => {
        if (o.op === '-') return <del key={i}>{o.text}</del>;
        if (o.op === '+') return <ins key={i}>{o.text}</ins>;
        const w = words(o.text);
        const first = i === 0;
        const last = i === ops.length - 1;
        if (w.length <= CONTEXT * 2 + 4) return <span key={i}>{o.text}</span>;
        const head = first ? '' : w.slice(0, CONTEXT).join('');
        const tail = last ? '' : w.slice(-CONTEXT).join('');
        return (
          <span key={i}>
            {head}
            <span className="diff-gap"> … </span>
            {tail}
          </span>
        );
      })}
    </div>
  );
}

const FIELD_LABEL = { title: 'Title', summary: 'Summary', body: 'Text' } as const;

/** Before and after of one entry, field by field. */
export function SnapshotDiff({ before, after, isNew }: { before: DocSnapshot; after: DocSnapshot | null; isNew: boolean }) {
  if (!after) return <p className="muted small">The entry has since been removed.</p>;
  if (isNew) {
    return (
      <div className="diff-fields">
        <p className="muted small">New entry.</p>
        {after.summary && <p className="spec-summary">{after.summary}</p>}
        {after.body && <Markdown text={after.body} className="diff-new" />}
      </div>
    );
  }
  const fields = (['title', 'summary', 'body'] as const).filter((f) => before[f] !== after[f]);
  if (!fields.length) return <p className="muted small">Only its section, tags or attachment changed.</p>;
  return (
    <div className="diff-fields">
      {fields.map((f) => (
        <div key={f}>
          <span className="label">{FIELD_LABEL[f]}</span>
          <DiffText before={before[f]} after={after[f]} />
        </div>
      ))}
    </div>
  );
}

/** The first message of a Spec-change planning task (and later additions): what the owner changed. */
export function ChangeCard({ body, ts, projectId }: { body: string; ts: number; projectId: string }) {
  let data: { intro: string; entries: EntryChange[] } | null = null;
  try {
    data = JSON.parse(body);
  } catch {}
  if (!data) return <div className="tl-card">{body}</div>;
  return (
    <div className="tl-card tl-change">
      <span className="msg-meta">
        <b>Helm</b> · Spec change · {clock(ts)}
      </span>
      <strong>{data.intro}</strong>
      {data.entries.length === 0 && <p className="muted small">The edits cancel out: the text is back to what it was.</p>}
      {data.entries.map((e) => {
        const before = { title: '', summary: '', body: '' };
        const after = { title: e.title, summary: '', body: '' };
        for (const f of e.fields) {
          before[f.field] = f.before;
          after[f.field] = f.after;
        }
        if (!e.fields.some((f) => f.field === 'title')) before.title = e.title;
        return (
          <div key={e.doc_id} className="change-entry">
            <a className="change-entry-head" href={href('p', projectId, 'spec', e.doc_id)}>
              <Tag tone="tone-spec">Spec</Tag> <b>{e.title}</b>
            </a>
            <SnapshotDiff before={before} after={after} isNew={e.isNew} />
          </div>
        );
      })}
    </div>
  );
}

/** On a task page: the entries it implements and the Spec changes it led to. */
export function TaskSpecBlock({ projectId, spec }: { projectId: string; spec?: TaskSpec }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!spec || (!spec.implements.length && !spec.changes.length)) return null;
  return (
    <section className="card task-spec">
      <h2>Spec</h2>
      {spec.implements.length > 0 && (
        <div className="task-spec-group">
          {spec.implements.map((d) => (
            <a key={d.id} className="task-spec-entry" href={href('p', projectId, 'spec', d.id)}>
              <b>{d.title}</b>
            </a>
          ))}
        </div>
      )}
      {spec.changes.length > 0 && (
        <div className="task-spec-group">
          <span className="label">Changed the Spec</span>
          {spec.changes.map((c) => (
            <div key={c.doc.id} className="task-spec-change">
              <button className="task-spec-entry" onClick={() => setOpen(open === c.doc.id ? null : c.doc.id)} aria-expanded={open === c.doc.id}>
                <Icon name="chevron" size={16} />
                <span>
                  <b>{c.doc.title}</b>
                  <span className="muted small">
                    {' '}
                    {c.isNew ? 'added' : 'edited'} by {c.by || 'someone'} · {ago(c.at)}
                  </span>
                </span>
              </button>
              {open === c.doc.id && <SnapshotDiff before={c.before} after={c.after} isNew={c.isNew} />}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- the Spec page ----------

type Editing = { doc: Doc | null; section_id?: string | null };
/** What is being moved with the Move to… sheet or dragged: an entry or a section (with everything in it). */
type Moving = { kind: 'doc' | 'sec'; id: string };

function useOpenSet(key: string, initial: () => string[]) {
  const [set, setSet] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) return new Set(JSON.parse(raw));
    } catch {}
    return new Set(initial());
  });
  const update = (fn: (s: Set<string>) => void) =>
    setSet((cur) => {
      const next = new Set(cur);
      fn(next);
      try {
        localStorage.setItem(key, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  return [set, update] as const;
}

const sortEntries = (a: Doc, b: Doc) =>
  Number(FINISHED.includes(a.status)) - Number(FINISHED.includes(b.status)) ||
  b.importance - a.importance ||
  (a.importance_rank ?? 1e9) - (b.importance_rank ?? 1e9) ||
  a.title.localeCompare(b.title);

/** How the Spec page orders entries. Sections is the reading order; the others are one flat list (Priority keeps its tiers). */
type SortKey = 'sections' | 'priority' | 'updated' | 'status' | 'title';
const SORTS: { id: SortKey; label: string }[] = [
  { id: 'sections', label: 'Sections' },
  { id: 'priority', label: 'Priority' },
  { id: 'updated', label: 'Updated' },
  { id: 'status', label: 'Status' },
  { id: 'title', label: 'Title' },
];
const STATUS_ORDER: Doc['status'][] = ['active', 'proposed', 'paused', 'done', 'dropped'];
const byPriority = (a: Doc, b: Doc) => b.importance - a.importance || (a.importance_rank ?? 1e9) - (b.importance_rank ?? 1e9) || b.updated_at - a.updated_at;
const SORT_CMP: Record<Exclude<SortKey, 'sections'>, (a: Doc, b: Doc) => number> = {
  priority: byPriority,
  updated: (a, b) => b.updated_at - a.updated_at,
  status: (a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || byPriority(a, b),
  title: (a, b) => a.title.localeCompare(b.title),
};

/** The chosen sort, remembered per project on this device. */
function useSpecSort(pid: string): [SortKey, (k: SortKey) => void] {
  const key = `helm.spec.sort.${pid}`;
  const read = (): SortKey => {
    const v = localStorage.getItem(key);
    return SORTS.some((x) => x.id === v) ? (v as SortKey) : 'sections';
  };
  const [sort, setSort] = useState<SortKey>(read);
  useEffect(() => setSort(read()), [key]);
  return [
    sort,
    (k) => {
      localStorage.setItem(key, k);
      setSort(k);
    },
  ];
}

/** One page (the default: purpose, then each section with one line per entry) or the full page; remembered on this device. */
type SpecView = 'page' | 'full';
function useSpecView(): [SpecView, (v: SpecView) => void] {
  const key = 'helm.spec.view';
  const [view, setView] = useState<SpecView>(() => {
    try {
      return localStorage.getItem(key) === 'full' ? 'full' : 'page';
    } catch {
      return 'page';
    }
  });
  return [
    view,
    (v) => {
      try {
        localStorage.setItem(key, v);
      } catch {}
      setView(v);
    },
  ];
}

/**
 * The one-page view: the project's purpose, then every section (sub-sections nested in their chapter) with each entry
 * as its title and one-line summary. Tapping an entry opens its text in place; "Full entry" opens it in the full view.
 */
/** A section's heading in the one-page view: a chapter title, not the app's small-caps label. */
const headStyle = (depth: number): React.CSSProperties => ({
  margin: 0,
  font: `600 ${depth === 1 ? 'var(--fs-l)' : 'var(--fs-m)'}/1.25 var(--serif)`,
  letterSpacing: 0,
  textTransform: 'none',
  color: depth === 1 ? 'var(--text)' : 'var(--text-2)',
});

function OnePage({ s, tree, loose, looseName, open, onToggle, onFull }: { s: ProjectState; tree: SecTree; loose: Doc[]; looseName: string; open: Set<string>; onToggle: (id: string) => void; onFull: (d: Doc) => void }) {
  const row = (d: Doc) => {
    const isOpen = open.has(d.id);
    const summary = d.summary || firstSentence(d.body);
    return (
      <li key={d.id} id={`doc-${d.id}`} style={{ opacity: FINISHED.includes(d.status) ? 0.7 : undefined }}>
        <button className="spec-entry-head" aria-expanded={isOpen} onClick={() => onToggle(d.id)} style={{ display: 'block', padding: 'var(--sp-1) 0' }}>
          <strong>{d.title}</strong>
          {summary && <span className="spec-summary"> — {summary}</span>}
          {d.status !== 'active' && <span className="muted small"> · {docStatusLabel(d.status)}</span>}
        </button>
        {isOpen && (
          <div style={{ padding: 'var(--sp-1) 0 var(--sp-2) var(--sp-3)', borderLeft: '2px solid var(--line-strong)' }}>
            {d.body ? <Markdown text={d.body} /> : <p className="muted small">No text yet.</p>}
            <button className="btn quiet small" onClick={() => onFull(d)}>
              Full entry
            </button>
          </div>
        )}
      </li>
    );
  };
  const list = (docs: Doc[]) =>
    docs.length > 0 && (
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--sp-1)' }}>{docs.map(row)}</ul>
    );
  const section = (n: SecNode): React.ReactNode => {
    const H = n.depth === 1 ? 'h2' : n.depth === 2 ? 'h3' : 'h4';
    const body = (
      <>
        <H style={headStyle(n.depth)}>{n.sec.name}</H>
        {n.sec.description && <p className="muted small">{n.sec.description}</p>}
        {list(n.entries)}
        {n.kids.map(section)}
      </>
    );
    return n.depth === 1 ? (
      <section key={n.sec.id} id={`sec-${n.sec.id}`} className="card" style={{ display: 'grid', gap: 'var(--sp-2)' }}>
        {body}
      </section>
    ) : (
      <section key={n.sec.id} id={`sec-${n.sec.id}`} style={{ display: 'grid', gap: 'var(--sp-2)', paddingLeft: 'var(--sp-3)', marginTop: 'var(--sp-2)' }}>
        {body}
      </section>
    );
  };
  return (
    <div style={{ display: 'grid', gap: 'var(--sp-3)' }}>
      {s.project.description && (
        <section className="card" style={{ display: 'grid', gap: 'var(--sp-1)' }}>
          <span className="label">Purpose</span>
          <p>{s.project.description}</p>
        </section>
      )}
      {tree.roots.map(section)}
      {loose.length > 0 && (
        <section id={`sec-${NONE}`} className="card" style={{ display: 'grid', gap: 'var(--sp-2)' }}>
          <h2 style={headStyle(1)}>{looseName}</h2>
          {list(loose)}
        </section>
      )}
    </div>
  );
}

const NONE = '__none';
/** Drag and drop needs a mouse or trackpad; on a touch screen, Move to… does the same. */
const finePointer = () => typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;

/** The project's Spec adherence (Setup › Planning; server/specadherence.ts), under the page title, linking to Setup. */
function AdherenceLink({ pid }: { pid: string }) {
  const { data } = useLive<{ groups: SettingGroup[] }>(`/api/projects/${pid}/settings`, (m) => m.type === 'project' && m.projectId === pid);
  const x = data?.groups.flatMap((g) => g.settings).find((g) => g.key === 'spec_adherence');
  if (!x) return null;
  const label = (x.choices?.find((c) => c.value === x.value)?.label ?? String(x.value)).replace(/ \(default\)$/, '');
  return (
    <a className="muted small" style={{ gridColumn: '1 / -1', justifySelf: 'start' }} href={href('p', pid, 'setup', 'agent-context')}>
      Spec adherence: {label}
    </a>
  );
}

export function SpecPage({ s, focus }: { s: ProjectState; focus?: string }) {
  const pid = s.project.id;
  const director = directorOf(s);
  const [query, setQuery] = useState('');
  // Tags to filter by (entries with any of them), picked in the Tags sheet and shown as removable chips on one line.
  const [picked, setPicked] = useState<string[]>([]);
  const [tagsOpen, setTagsOpen] = useState(false);
  // On a phone the Priority sort's explanation folds into one line.
  const [aboutOpen, setAboutOpen] = useState(false);
  const wide = typeof window !== 'undefined' && window.matchMedia('(min-width: 900px)').matches;
  // Open and closed per section, on this device. A first visit on a wide screen opens the top level; deeper levels
  // start closed everywhere.
  const [openSecs, updateSecs] = useOpenSet(`helm.spec.sections.${pid}`, () => (wide ? [...s.sections.filter((x) => !x.parent_id).map((x) => x.id), NONE] : []));
  const [openDocs, setOpenDocs] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const [moving, setMoving] = useState<Moving | null>(null);
  const [drag, setDrag] = useState<Moving | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const moveAction = useAction();
  const [sort, setSort] = useSpecSort(pid);
  const [view, setView] = useSpecView();
  const [warnings, setWarnings] = useState<string[]>([]);
  const canDrag = useMemo(finePointer, []);

  // One kind of entry; anything else (a decision or note on a server not yet migrated) is not shown here.
  const docs = useMemo(() => s.docs.filter(isEntry), [s.docs]);
  const byId = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs]);
  const allTags = useMemo(() => {
    const n = new Map<string, number>();
    for (const d of docs) for (const t of d.tags) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [docs]);

  const q = query.trim().toLowerCase();
  const filtering = !!q || picked.length > 0;
  const toggleTag = (t: string) => setPicked((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  const addTag = (t: string) => setPicked((cur) => (cur.includes(t) ? cur : [...cur, t]));
  const visible = (d: Doc) => (!picked.length || d.tags.some((t) => picked.includes(t))) && (!q || `${d.title}\n${d.summary}\n${d.body}`.toLowerCase().includes(q));

  const tree = useMemo(() => buildTree(s.sections, docs, sortEntries), [docs, s.sections]);
  const loose = useMemo(() => docs.filter((d) => !d.section_id || !tree.byId.has(d.section_id)).sort(sortEntries), [docs, tree]);
  const looseName = s.sections.length ? 'No section yet' : 'Entries';
  const crumb = (d: Doc) => pathNames(tree, d.section_id).join(' › ');

  const openPath = (id: string) => updateSecs((set) => [id, ...ancestors(tree, id)].forEach((x) => set.add(x)));
  // Arriving at #/p/:id/spec/<section or entry>: open it (and the sections around it) and bring it into view.
  useEffect(() => {
    if (!focus) return;
    const target = byId.get(focus) ?? null;
    const secId = target ? (target.section_id && tree.byId.has(target.section_id) ? target.section_id : NONE) : tree.byId.has(focus) ? focus : null;
    if (secId) openPath(secId);
    if (target) setOpenDocs((cur) => new Set(cur).add(target.id));
    requestAnimationFrame(() => document.getElementById(target ? `doc-${target.id}` : `sec-${focus}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const unsorted = docs.filter((d) => !d.section_id || !d.summary).length;
  const toggleDoc = (id: string) =>
    setOpenDocs((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const toggleSec = (id: string) => updateSecs((set) => (set.has(id) ? set.delete(id) : set.add(id)));
  const jump = (id: string) => {
    openPath(id);
    requestAnimationFrame(() => document.getElementById(`sec-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  };

  /** Move an entry into a section (null: none), or a section under another (null: the top level). */
  const move = async (what: Moving, to: string | null) => {
    const ok = await moveAction.run(() =>
      what.kind === 'doc' ? api(`/api/docs/${what.id}`, { method: 'PATCH', body: { section_id: to } }) : api(`/api/sections/${what.id}`, { method: 'PATCH', body: { parent_id: to } }),
    );
    // Show where it went.
    if (ok && to) openPath(to);
    return ok;
  };
  /** Why the thing being dragged cannot go into `to` (a section id, or null), or null when it can. */
  const dropError = (what: Moving, to: string | null): string | null => {
    if (what.kind === 'sec') return sectionMoveError(tree, what.id, to);
    const d = byId.get(what.id);
    return (d?.section_id ?? null) === to ? 'It is already there.' : null;
  };
  /** Drag handlers for a drop target: a section's header, the no-section group, or the top-level strip. */
  const dropTarget = (to: string | null, key: string) =>
    drag
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (dropError(drag, to)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (dropOn !== key) setDropOn(key);
          },
          onDragLeave: () => dropOn === key && setDropOn(null),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            const what = drag;
            setDrag(null);
            setDropOn(null);
            if (!dropError(what, to)) void move(what, to);
          },
        }
      : {};
  const dragSource = (what: Moving, label: string) =>
    canDrag && sort === 'sections' && !filtering
      ? {
          draggable: true,
          onDragStart: (e: React.DragEvent) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', label);
            const card = (e.currentTarget as HTMLElement).closest(what.kind === 'doc' ? '.spec-entry' : '.spec-chapter-head');
            if (card) e.dataTransfer.setDragImage(card, 20, 20);
            setDrag(what);
          },
          onDragEnd: () => {
            setDrag(null);
            setDropOn(null);
          },
        }
      : null;

  // Search and tag filters show matches outside their place: one list in reading order, each with its section path.
  const readingOrder = useMemo(() => [...tree.order.flatMap((n) => n.entries), ...loose], [tree, loose]);
  const matches = filtering ? readingOrder.filter(visible) : [];
  const flat = sort === 'sections' ? [] : docs.filter(visible).sort(SORT_CMP[sort]);
  // The contents column only in the reading order, and only when there is more than one chapter to jump between.
  const toc = sort === 'sections' && !filtering && tree.roots.length + (loose.length ? 1 : 0) > 1;
  const entry = (d: Doc, outside = sort !== 'sections' || filtering) => (
    <Entry
      key={d.id}
      s={s}
      d={d}
      open={openDocs.has(d.id)}
      onToggle={() => toggleDoc(d.id)}
      onEdit={(x) => setEditing(x)}
      onTag={addTag}
      onMove={() => setMoving({ kind: 'doc', id: d.id })}
      grip={dragSource({ kind: 'doc', id: d.id }, d.title)}
      director={director}
      section={outside ? crumb(d) : undefined}
    />
  );
  const finished = (d: Doc) => FINISHED.includes(d.status);
  const caps: Record<number, string> = { 5: `${s.budget.critical.count} of ${s.budget.critical.cap}`, 4: `${s.budget.high.count} of ${s.budget.high.cap}` };
  const over = s.budget.critical.over || s.budget.high.over;

  /** A section with its entries and subsections; the top level is a chapter, deeper ones nest on a thin rail. */
  const sectionView = (n: SecNode): React.ReactNode => {
    const id = n.sec.id;
    const isOpen = openSecs.has(id);
    const H = n.depth === 1 ? 'h2' : n.depth === 2 ? 'h3' : 'h4';
    const grip = dragSource({ kind: 'sec', id }, n.sec.name);
    const blocked = drag ? dropError(drag, id) : null;
    return (
      <section key={id} id={`sec-${id}`} className={`spec-chapter depth-${n.depth} ${n.depth > 1 ? 'spec-sub' : ''} ${isOpen ? 'open' : ''}`}>
        {n.depth > 1 && (
          // Where you are when scrolled deep on a phone: the parent path, each part a jump to that section. One line,
          // cut from the left when long (rtl outside, ltr inside), so the nearest parent stays readable.
          <nav className="spec-crumb small" aria-label={`${n.sec.name} is in`}>
            <span className="spec-crumb-in">
              {[...ancestors(tree, id)].reverse().map((a, i) => (
                <span key={a}>
                  {i > 0 && <span aria-hidden="true"> › </span>}
                  <button className="link" onClick={() => jump(a)}>
                    {tree.byId.get(a)?.sec.name}
                  </button>
                </span>
              ))}
            </span>
          </nav>
        )}
        <div className={`spec-chapter-row ${dropOn === id ? 'drop-on' : ''} ${drag && blocked ? 'drop-no' : ''}`} {...dropTarget(id, id)} title={drag && blocked && blocked !== 'It is already there.' ? blocked : undefined}>
          <button className="spec-chapter-head" aria-expanded={isOpen} onClick={() => toggleSec(id)}>
            <Icon name="chevron" size={n.depth === 1 ? 16 : 14} />
            <span className="spec-chapter-name">
              <H>{n.sec.name}</H>
              {n.sec.description && <span className="spec-chapter-desc">{n.sec.description}</span>}
            </span>
            {n.flagged > 0 && (
              <span className="spec-chapter-counts">
                <Tag tone="tone-warning spec-flag">{n.flagged} edited by you</Tag>
              </span>
            )}
          </button>
          {grip && (
            <span className="drag-handle spec-grip" {...grip} title="Drag into another section, or to the top level" aria-hidden="true">
              ⠿
            </span>
          )}
        </div>
        {isOpen && (
          <div className="spec-chapter-body">
            {n.entries.map((d) => entry(d))}
            {n.kids.length > 0 && <div className="spec-subs">{n.kids.map(sectionView)}</div>}
            <div className="row wrap spec-section-foot">
              <button className="btn small quiet spec-add-here" onClick={() => setEditing({ doc: null, section_id: id })}>
                <Icon name="plus" size={16} /> Add to {n.sec.name}
              </button>
              <button className="btn small quiet" onClick={() => setMoving({ kind: 'sec', id })}>
                Move section…
              </button>
            </div>
          </div>
        )}
      </section>
    );
  };
  const tocItem = (n: SecNode): React.ReactNode => (
    <div key={n.sec.id} className={`spec-toc-node depth-${n.depth}`}>
      <button onClick={() => jump(n.sec.id)}>
        <span>{n.sec.name}</span>
        <span className="muted">{n.total}</span>
      </button>
      {n.kids.length > 0 && openSecs.has(n.sec.id) && n.kids.map(tocItem)}
    </div>
  );

  /** From the one-page view to this entry, open, in the full view. */
  const toFull = (d: Doc) => {
    setView('full');
    setOpenDocs((cur) => new Set(cur).add(d.id));
    if (d.section_id && tree.byId.has(d.section_id)) openPath(d.section_id);
    else updateSecs((set) => set.add(NONE));
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(`doc-${d.id}`)?.scrollIntoView({ block: 'start' })));
  };

  return (
    <section className="spec-page">
      <div className="spec-title">
        <h1 className="page-title">Spec</h1>
        <div className="row spec-title-actions">
          <SpecWorkButton s={s} />
          <button className="btn small" onClick={() => setEditing({ doc: null })}>
            <Icon name="plus" size={16} /> Add
          </button>
          <Menu label="More Spec actions" items={[{ label: 'Edit sections', onSelect: () => setSectionsOpen(true) }]} />
        </div>
        {docs.length > 0 && (
          // A div: the page's old intro paragraph rule (.spec-title p) hides paragraphs here on a phone.
          <div className="muted small" style={{ gridColumn: '1 / -1' }}>
            {plural(docs.length, 'entry', 'entries')} in {plural(s.sections.length, 'section')}
            {' · '}
            <button className="link" aria-pressed={view === 'full'} onClick={() => setView(view === 'page' ? 'full' : 'page')} title={view === 'page' ? 'Every entry with its tools' : 'The Spec on one page'}>
              {view === 'page' ? 'Full view' : 'One page'}
            </button>
          </div>
        )}
        <AdherenceLink pid={pid} />
      </div>

      {view === 'page' ? (
        <>
          <PendingBanner s={s} director={director} />
          {docs.length === 0 ? <Empty title="The Spec is empty" /> : <OnePage s={s} tree={tree} loose={loose} looseName={looseName} open={openDocs} onToggle={toggleDoc} onFull={toFull} />}
        </>
      ) : (
      <>
      {docs.length > 0 &&
        (sort === 'priority' || over ? (
          <ImportanceMeter budget={s.budget} onOpen={sort === 'priority' ? undefined : () => setSort('priority')} />
        ) : null)}
      <PendingBanner s={s} director={director} />
      {(unsorted > 0 || s.budget.critical.over || s.budget.high.over) && docs.length > 0 && <OrganiseBanner s={s} director={director} unsorted={unsorted} />}

      <div className="spec-tools">
        <div className="spec-tools-row">
          <input className="spec-search" type="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the Spec" />
          <label className="spec-sort">
            <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort the Spec">
              {SORTS.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
          {allTags.length > 0 && (
            <button className={`btn small spec-tags-toggle ${picked.length ? 'on' : ''}`} aria-haspopup="dialog" aria-expanded={tagsOpen} onClick={() => setTagsOpen(true)}>
              Tags{picked.length > 0 && <span className="badge">{picked.length}</span>} <span aria-hidden="true">▾</span>
            </button>
          )}
        </div>
        {picked.length > 0 && (
          <div className="spec-picked" role="group" aria-label="Filtering by these tags">
            {picked.map((t) => (
              <button key={t} className="chip on" onClick={() => toggleTag(t)} aria-label={`Stop filtering by ${t}`} title={`Stop filtering by ${t}`}>
                #{t} <span aria-hidden="true">×</span>
              </button>
            ))}
            <button className="link spec-picked-clear" onClick={() => setPicked([])}>
              Clear all
            </button>
          </div>
        )}
        {filtering && (
          <p className="muted small">
            {plural(sort === 'sections' ? matches.length : flat.length, 'match', 'matches')}
            {picked.length > 0 && ` with ${picked.length === 1 ? 'this tag' : 'any of these tags'}`}
            {/* The tags have their own Clear all above; this one is for the search words. */}
            {q && (
              <>
                {' · '}
                <button className="link" onClick={() => setQuery('')}>
                  Clear search
                </button>
              </>
            )}
          </p>
        )}
        {tagsOpen && <TagPicker tags={allTags} picked={picked} onToggle={toggleTag} onClear={() => setPicked([])} onClose={() => setTagsOpen(false)} />}
      </div>

      <div className={`spec-layout ${toc ? 'with-toc' : ''}`}>
        {toc && (
          <nav className="spec-toc" aria-label="Sections">
            <span className="label">Contents</span>
            {tree.roots.map(tocItem)}
            {loose.length > 0 && (
              <div className="spec-toc-node depth-1">
                <button onClick={() => jump(NONE)}>
                  <span>{looseName}</span>
                  <span className="muted">{loose.length}</span>
                </button>
              </div>
            )}
          </nav>
        )}
        <div className="spec-chapters">
          {moveAction.error && <p className="error-text spec-move-error">{moveAction.error}</p>}
          {docs.length === 0 && <Empty title="The Spec is empty" />}
          {filtering && (sort === 'sections' ? matches.length === 0 : flat.length === 0) && <Empty title="Nothing matches" />}
          {sort === 'priority' && flat.length > 0 && (
            <div className="spec-by-priority">
              <p className={`muted small spec-prio-about ${aboutOpen ? 'open' : ''}`} onClick={() => setAboutOpen(!aboutOpen)}>Open entries, most important first. Drag an entry by its handle to reorder (on a phone, press and hold it); drop it past a tier line to change its level. What you place is pinned: the director may suggest a change but not make it.</p>
              {warnings.length > 0 && <p className="imp-warning small">{overText(warnings[0])}</p>}
              <TieredList
                items={flat.filter((d) => !finished(d)).map((d) => ({ id: d.id, level: d.importance, pinned: !!d.importance_pinned, doc: d }))}
                onWarnings={setWarnings}
                // A whole entry card per row: only its header picks it up, so its text can be selected and scrolled.
                holdFrom=".spec-entry-head"
                label={(l) => (
                  <h3 className={`prio-level-head ${(l === 5 && s.budget.critical.over) || (l === 4 && s.budget.high.over) ? 'over' : ''}`}>
                    {LEVEL[l]} <span className="muted small">{caps[l] ?? ''}</span>
                  </h3>
                )}
                render={(i) => entry(i.doc)}
              />
              {flat.some(finished) && (
                <div className="spec-flat">
                  <h3 className="prio-level-head">Done and dropped</h3>
                  {flat.filter(finished).map((d) => entry(d))}
                </div>
              )}
            </div>
          )}
          {sort !== 'sections' && sort !== 'priority' && <div className="spec-flat">{flat.map((d) => entry(d))}</div>}
          {sort === 'sections' && filtering && <div className="spec-flat">{matches.map((d) => entry(d))}</div>}
          {sort === 'sections' && !filtering && (
            <>
              {drag?.kind === 'sec' && (
                <div className={`spec-drop-top ${dropOn === 'top' ? 'drop-on' : ''} ${dropError(drag, null) ? 'drop-no' : ''}`} {...dropTarget(null, 'top')}>
                  {dropError(drag, null) === 'It is already there.' ? 'Drop on a section to put it inside' : (dropError(drag, null) ?? 'Drop here for the top level')}
                </div>
              )}
              {tree.roots.map(sectionView)}
              {loose.length > 0 || drag?.kind === 'doc' ? (
                <section id={`sec-${NONE}`} className={`spec-chapter ${openSecs.has(NONE) ? 'open' : ''}`}>
                  <div className={`spec-chapter-row ${dropOn === NONE ? 'drop-on' : ''}`} {...dropTarget(null, NONE)}>
                    <button className="spec-chapter-head" aria-expanded={openSecs.has(NONE)} onClick={() => toggleSec(NONE)}>
                      <Icon name="chevron" size={16} />
                      <span className="spec-chapter-name">
                        <h2>{looseName}</h2>
                      </span>
                    </button>
                  </div>
                  {openSecs.has(NONE) && <div className="spec-chapter-body">{loose.map((d) => entry(d))}</div>}
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
      </>
      )}

      {editing && <SpecEditor s={s} tree={tree} editing={editing} director={director} onClose={() => setEditing(null)} />}
      {sectionsOpen && <SectionsSheet s={s} tree={tree} onMove={(id) => setMoving({ kind: 'sec', id })} onClose={() => setSectionsOpen(false)} />}
      {moving && <MoveSheet tree={tree} what={moving} doc={moving.kind === 'doc' ? byId.get(moving.id) : undefined} dropError={dropError} onMove={move} onClose={() => setMoving(null)} />}
    </section>
  );
}

/**
 * Move to…: the way to move an entry or a section without dragging (and the only one on a phone). Every section is
 * listed as the outline; the places a move would be refused (too deep, inside itself, a name already there) are
 * greyed with the reason.
 */
function MoveSheet({
  tree,
  what,
  doc,
  dropError,
  onMove,
  onClose,
}: {
  tree: SecTree;
  what: Moving;
  doc?: Doc;
  dropError: (what: Moving, to: string | null) => string | null;
  onMove: (what: Moving, to: string | null) => Promise<boolean>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const name = what.kind === 'doc' ? (doc?.title ?? 'entry') : (tree.byId.get(what.id)?.sec.name ?? 'section');
  const current = what.kind === 'doc' ? (doc?.section_id ?? null) : (tree.byId.get(what.id)?.sec.parent_id ?? null);
  const go = async (to: string | null) => {
    setBusy(true);
    const ok = await onMove(what, to);
    setBusy(false);
    if (ok) onClose();
  };
  const option = (to: string | null, label: string, depth: number, sub?: string) => {
    const err = dropError(what, to);
    const here = to === current;
    return (
      <li key={to ?? NONE}>
        <button className={`move-option depth-${depth} ${here ? 'here' : ''}`} disabled={busy || !!err} onClick={() => go(to)}>
          <span className="move-option-name">{label}</span>
          {here ? <span className="muted small">here now</span> : err ? <span className="muted small">{err}</span> : sub ? <span className="muted small">{sub}</span> : null}
        </button>
      </li>
    );
  };
  return (
    <Sheet title={`Move “${name}”`} onClose={onClose} className="move-sheet">
      <p className="muted small">
        {what.kind === 'doc'
          ? 'Into which section? Moving is organisation: it does not start a planning discussion.'
          : `Inside which section, with everything in it? At most ${MAX_DEPTH} levels. Moving is organisation: it does not start a planning discussion.`}
      </p>
      <ul className="move-list">
        {what.kind === 'sec' ? option(null, 'Top level', 0) : option(null, 'No section', 0)}
        {tree.order.map((n) => option(n.sec.id, n.sec.name, n.depth, plural(n.total, 'entry', 'entries')))}
      </ul>
    </Sheet>
  );
}

function PendingBanner({ s, director }: { s: ProjectState; director: string }) {
  useTick(5000);
  if (!s.pending.count || !s.pending.dueAt) return null;
  const left = Math.max(0, Math.round((s.pending.dueAt - Date.now()) / 1000));
  const when = left <= 5 ? 'any moment now' : left < 90 ? `in about ${left} seconds` : `in about ${Math.round(left / 60)} minutes`;
  return (
    <div className="spec-banner pending">
      <Icon name="edit" size={16} />
      <p>
        Your edits to {plural(s.pending.count, 'entry', 'entries')} go to {director} as one planning discussion {when}. More edits join it and restart the wait.
      </p>
    </div>
  );
}

function OrganiseBanner({ s, director, unsorted }: { s: ProjectState; director: string; unsorted: number }) {
  const { busy, error, run } = useAction();
  const [sent, setSent] = useState(false);
  const over = s.budget.critical.over || s.budget.high.over;
  const what = [
    unsorted && `${plural(unsorted, 'entry', 'entries')} without a section or summary`,
    over && `more Critical or High entries than the limit allows`,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <div className="spec-banner organise">
      <p>{what.charAt(0).toUpperCase() + what.slice(1)}.</p>
      {sent ? (
        <p className="doc-told">
          <Icon name="check" size={16} /> Sent to {director}. Its reply is in the chat with {director}, under General.
        </p>
      ) : (
        <button className="btn small" disabled={busy} onClick={async () => (await run(() => api(`/api/projects/${s.project.id}/spec/organise`, { body: {} }))) && setSent(true)}>
          Ask {director} to organise the Spec
        </button>
      )}
      {!sent && (
        <p className="muted small">It sorts entries into sections, writes summaries and tags, and merges entries that describe the same subject.</p>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

// ---------- an entry ----------

function Summary({ d }: { d: Doc }) {
  if (d.summary) return <p className="spec-summary">{d.summary}</p>;
  const first = firstSentence(d.body);
  return (
    <p className="spec-summary">
      {first || <span className="muted">No text yet.</span>} <span className="no-summary">no summary yet</span>
    </p>
  );
}

/**
 * The tag filter's list: every tag in the project with how many entries carry it, most used first, a search box
 * and a checkbox per tag. However many tags a project has, the page itself only shows the Tags button and the
 * chosen ones.
 */
function TagPicker({ tags, picked, onToggle, onClear, onClose }: { tags: [string, number][]; picked: string[]; onToggle: (t: string) => void; onClear: () => void; onClose: () => void }) {
  const [find, setFind] = useState('');
  const f = find.trim().toLowerCase().replace(/^#/, '');
  const shown = f ? tags.filter(([t]) => t.includes(f)) : tags;
  // A mouse gets the cursor in the search box; a phone does not get its keyboard thrown up unasked.
  const fine = typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;
  return (
    <Sheet title="Filter by tags" onClose={onClose} className="tag-picker">
      <input
        className="tag-picker-find"
        type="search"
        placeholder={`Search ${tags.length} tags`}
        value={find}
        autoFocus={fine}
        onChange={(e) => setFind(e.target.value)}
        onKeyDown={(e) => {
          // Enter picks the first match and empties the box for the next one.
          if (e.key === 'Enter' && f && shown.length) {
            e.preventDefault();
            onToggle(shown[0][0]);
            setFind('');
          }
        }}
        aria-label="Search tags"
      />
      <div className="row tag-picker-head muted small">
        <span>{picked.length ? `${picked.length} chosen: entries with any of them` : 'Most used first'}</span>
        {picked.length > 0 && (
          <button className="link" onClick={onClear}>
            Clear all
          </button>
        )}
      </div>
      <ul className="tag-picker-list" aria-label="Tags">
        {shown.map(([t, n]) => (
          <li key={t}>
            <label className={picked.includes(t) ? 'on' : ''}>
              <input type="checkbox" checked={picked.includes(t)} onChange={() => onToggle(t)} />
              <span className="tag-picker-name">#{t}</span>
              <span className="chip-count">{n}</span>
            </label>
          </li>
        ))}
        {!shown.length && <li className="muted small tag-picker-none">No tag contains “{find.trim()}”.</li>}
      </ul>
      <div className="tag-picker-foot">
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

function Tags({ tags, onTag }: { tags: string[]; onTag: (t: string) => void }) {
  if (!tags.length) return null;
  return (
    <span className="spec-tags">
      {tags.map((t) => (
        <button key={t} className="tag tone-blue mono spec-tag-link" onClick={() => onTag(t)} title={`Show entries tagged ${t}`}>
          #{t}
        </button>
      ))}
    </span>
  );
}

function Entry({
  s,
  d,
  open,
  onToggle,
  onEdit,
  onTag,
  onMove,
  grip,
  director,
  section,
}: {
  s: ProjectState;
  d: Doc;
  open: boolean;
  onToggle: () => void;
  onEdit: (e: Editing) => void;
  onTag: (t: string) => void;
  /** Open Move to… for this entry. */
  onMove: () => void;
  /** Drag props for its handle, when it can be dragged (a mouse, the Sections order, no filter). */
  grip?: Record<string, unknown> | null;
  director: string;
  /** Outside its place (search, tags, other sorts): the path of its section, "Combat › Weapons". */
  section?: string;
}) {
  const pid = s.project.id;
  const linked = linkedTasks(s, d.id);
  const openTasks = linked.filter((t) => OPEN_ITEM.includes(t.state));
  const flag = d.spec_state ? FLAG[d.spec_state] : null;
  const planTask = d.plan_task_id ? s.tasks.find((t) => t.id === d.plan_task_id) : undefined;
  const { busy, error, run } = useAction();
  const [told, setTold] = useState('');

  const act = async (action: 'begin' | 'stop') => {
    if (await run(() => api(`/api/docs/${d.id}/${action}`, { body: {} }))) setTold(action === 'begin' ? `${director} was told to start on it.` : `${director} was told to wind it down.`);
  };
  const remove = async () => {
    if (!confirm(`Remove the entry “${d.title}”?${d.status === 'active' ? ` ${director} will be told to stop work on it.` : ''}`)) return;
    await run(() => api(`/api/docs/${d.id}`, { method: 'DELETE' }));
  };
  const revert = async () => {
    if (!confirm(`Revert your edit to “${d.title}”? It goes back to how it was before you changed it${d.spec_state === 'planning' ? `, and ${director} is told to drop it from the plan` : ''}. If you added it, it is removed.`)) return;
    await run(() => api(`/api/docs/${d.id}/revert`, { body: {} }));
  };

  return (
    <article id={`doc-${d.id}`} className={`card spec-entry doc-${d.status} imp-edge-${d.importance} ${open ? 'open' : ''}`}>
      <button className="spec-entry-head" onClick={onToggle} aria-expanded={open}>
        <span className="row wrap spec-entry-tags">
          <Tag tone={`doc-st st-${d.status}`}>{docStatusLabel(d.status)}</Tag>
          {flag && <Tag tone={`${flag.tone} spec-flag`}>{flag.label}</Tag>}
        </span>
        <h3>{d.title}</h3>
        <Summary d={d} />
      </button>
      <div className="spec-entry-meta">
        {grip && (
          <span className="drag-handle spec-grip" {...grip} title="Drag into a section" aria-hidden="true">
            ⠿
          </span>
        )}
        {section !== undefined && (
          <span className="spec-entry-section small" title={section ? `In ${section}` : 'Not in a section'}>
            {section || 'No section'}
          </span>
        )}
        <ImportancePicker id={d.id} level={d.importance} pinned={!!d.importance_pinned} change={recentChange(s, d.id)} />
        <Tags tags={d.tags} onTag={onTag} />
        {!open && <ClipCount n={d.attach_count} />}
        <DiscussingMarker s={s} d={d} />
        {linked.length > 0 && (
          <span className="spec-linked muted small">
            {countLabel(linked)}
            {openTasks[0] && (
              <>
                {' · '}
                <LinkedItem pid={pid} t={openTasks[0]} />
              </>
            )}
          </span>
        )}
      </div>
      {d.spec_state === 'not_planned' && (
        <div className="spec-flag-row">
          <span className="small">You dropped the plan for your edit, so the project was not changed to match it.</span>
          <button className="btn small" disabled={busy} onClick={revert}>
            Revert my edit
          </button>
        </div>
      )}
      {(d.spec_state === 'planning' || d.spec_state === 'changed') && (
        <div className="spec-flag-row">
          {planTask ? (
            <a className="small" href={href('p', pid, 'tasks', planTask.id)}>
              Open the planning discussion: {planTask.title}
            </a>
          ) : (
            <span className="small">Your edit goes to {director} as a planning discussion after a quiet moment.</span>
          )}
          <button className="btn small quiet" disabled={busy} onClick={revert}>
            Revert my edit
          </button>
        </div>
      )}
      {open && (
        <div className="spec-entry-body">
          {d.body ? <Markdown text={d.body} /> : <p className="muted">No text yet.</p>}
          {<ImportanceControl id={d.id} level={d.importance} reason={d.importance_reason} pinned={!!d.importance_pinned} what="entry" />}
          <p className="muted small">
            Written by {d.author} · updated {ago(d.updated_at)}
          </p>
          {/* Attachments (web/src/attachments.tsx), keyed on the entry. */}
          <References projectId={pid} owner={`doc:${d.id}`} version={d.attach_count} />
          {openTasks.length > 0 && (
            <div className="spec-entry-tasks">
              <span className="label">Work on it now</span>
              {openTasks.map((t) => (
                <LinkedItem key={t.id} pid={pid} t={t} />
              ))}
            </div>
          )}
          <div className="row wrap doc-foot">
            {(d.status === 'proposed' || d.status === 'paused') && (
              <button className={`btn ${d.status === 'proposed' ? 'primary' : ''}`} disabled={busy} onClick={() => act('begin')}>
                <Icon name="play" size={16} /> {d.status === 'paused' ? 'Resume' : 'Begin'}
              </button>
            )}
            {d.status === 'active' && (
              <button className="btn" disabled={busy} onClick={() => act('stop')}>
                <Icon name="stop" size={16} /> Stop
              </button>
            )}
            <button className="btn quiet" disabled={busy} onClick={() => onEdit({ doc: d })}>
              <Icon name="edit" size={16} /> Edit
            </button>
            <DiscussButton s={s} d={d} director={director} />
            <button className="btn quiet" disabled={busy} onClick={onMove}>
              Move…
            </button>
            <span className="spacer" />
            <button className="icon-btn doc-remove" disabled={busy} onClick={remove} aria-label={`Remove ${d.title}`} title="Remove">
              <Icon name="trash" size={20} />
            </button>
          </div>
          {error && <p className="error-text">{error}</p>}
          {told && !error && (
            <p className="doc-told">
              <Icon name="check" size={16} /> {told}
            </p>
          )}
        </div>
      )}
      {error && !open && <p className="error-text">{error}</p>}
      <EntryHistory s={s} d={d} count={linked.length} />
    </article>
  );
}

/** "History": the tasks and discussions that changed this entry (with diffs) and every task that implements it. */
function EntryHistory({ s, d, count }: { s: ProjectState; d: Doc; count: number }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="spec-history" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <Icon name="chevron" size={16} /> History
        {(count > 0 || d.record_count > 0) && (
          <span className="muted"> · {[count > 0 && countLabel(linkedTasks(s, d.id)), d.record_count > 0 && plural(d.record_count, 'decision or note', 'decisions and notes')].filter(Boolean).join(', ')}</span>
        )}
      </summary>
      {open && <EntryHistoryBody s={s} d={d} />}
    </details>
  );
}

function EntryHistoryBody({ s, d }: { s: ProjectState; d: Doc }) {
  const pid = s.project.id;
  const { data, error } = useLive<DocHistory>(`/api/docs/${d.id}/history`, (m) => m.type === 'project' && m.projectId === pid);
  const [openChange, setOpenChange] = useState<string | null>(null);
  if (error) return <p className="error-text">{error}</p>;
  if (!data) return <p className="muted small">Loading…</p>;
  const name = (t: LinkedTask) => (
    <LinkedItem pid={pid} t={t} />
  );
  const ownEdits = data.revisions.filter((r) => r.op !== 'delete');
  return (
    <div className="spec-history-body">
      {data.changes.length > 0 && (
        <div>
          <span className="label">Changed by</span>
          <ul className="spec-history-list">
            {data.changes.map((c) => (
              <li key={c.task.id}>
                <div className="row wrap">
                  {name(c.task)}
                  <span className="muted small">
                    {c.isNew ? 'added it' : 'edited it'} · {c.by} · {ago(c.at)}
                  </span>
                  <button className="link" onClick={() => setOpenChange(openChange === c.task.id ? null : c.task.id)}>
                    {openChange === c.task.id ? 'Hide changes' : 'Show changes'}
                  </button>
                </div>
                {openChange === c.task.id && <SnapshotDiff before={c.before} after={c.after} isNew={c.isNew} />}
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!data.discussions?.length && (
        <div>
          <span className="label">Discussed in</span>
          <ul className="spec-history-list">
            {data.discussions.map((t) => (
              <li key={t.id} className="row wrap">
                {name(t)}
                <span className="muted small">
                  {plural(t.messages, 'message')} · {ago(t.updated_at)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.implements.length > 0 && (
        <div>
          <span className="label">Work that upholds it</span>
          <ul className="spec-history-list">
            {data.implements.map((t) => (
              <li key={t.id} className="row wrap">
                {name(t)}
                <span className="muted small">{ago(t.updated_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.importance.length > 0 && (
        <div>
          <span className="label">Importance</span>
          <ul className="spec-history-list">
            {data.importance.map((c, i) => (
              <li key={i} className="small">
                <b>
                  {LEVEL[c.old_level]} → {LEVEL[c.new_level]}
                </b>{' '}
                by {c.author_name} · {ago(c.created_at)}
                {c.reason && <span className="muted"> — {c.reason}</span>}
                {c.cause_title && <span className="muted"> (prompted by “{c.cause_title}”)</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.records.length > 0 && (
        <div>
          <span className="label">Decisions and notes</span>
          <ul className="spec-history-list spec-records">
            {data.records.map((r) => (
              <li key={r.key}>
                <details>
                  <summary>
                    <Tag tone={r.kind === 'decision' ? 'kind-decision' : ''}>{r.kind === 'decision' ? 'Decision' : 'Note'}</Tag> <b>{r.title}</b>
                    <span className="muted small">
                      {' '}
                      · {r.author} · {clock(r.at)}
                      {r.task && <> · from {r.task.kind === 'discussion' ? 'the discussion' : 'the task'} “{r.task.title}”</>}
                    </span>
                  </summary>
                  {r.summary && <p className="spec-summary">{r.summary}</p>}
                  {r.body ? <Markdown text={r.body} /> : null}
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!data.changes.length && !data.implements.length && !data.records.length && !data.discussions?.length && <p className="muted small">No task or discussion has changed or implemented this entry yet.</p>}
      <p className="muted small">
        {plural(ownEdits.length, 'recorded edit')}, most recent by {ownEdits[0]?.author_name || 'nobody'}
        {ownEdits[0] && ` (${clock(ownEdits[0].created_at)})`}.
      </p>
    </div>
  );
}

// ---------- editing ----------

function SpecEditor({ s, tree, editing, director, onClose }: { s: ProjectState; tree: SecTree; editing: Editing; director: string; onClose: () => void }) {
  const doc = editing.doc;
  const [form, setForm] = useState({
    title: doc?.title ?? '',
    summary: doc?.summary ?? '',
    body: doc?.body ?? '',
    importance: doc?.importance ?? 3,
    importance_reason: doc?.importance_reason ?? '',
    status: doc?.status ?? (doc ? 'active' : 'proposed'),
    section_id: doc ? (doc.section_id ?? '') : (editing.section_id ?? ''),
    newSection: '',
    tags: (doc?.tags ?? []).join(', '),
    wording_only: false,
  });
  const { busy, error, run } = useAction();
  const steer = true;
  const tagList = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
  // The project's most used tags first: reusing one keeps the vocabulary small.
  const counts = new Map<string, number>();
  for (const d of s.docs) for (const t of d.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  const known = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t)
    .filter((t) => !tagList.includes(t))
    .slice(0, 14);
  const contentChanged = !doc || doc.title !== form.title.trim() || doc.summary !== form.summary.trim() || doc.body !== form.body;
  const quiet = Math.max(1, Math.round(s.quietSeconds / 60));
  // Critical and High are limited; the owner may go over, but should know.
  const lvl = form.importance === 5 ? s.budget.critical : form.importance === 4 ? s.budget.high : null;
  const holds = !!doc && doc.importance === form.importance && !FINISHED.includes(doc.status);
  const budgetNote =
    lvl && !holds && lvl.holders.length >= lvl.cap
      ? `${importanceName(form.importance)} is at its limit for this project (${lvl.count} of ${lvl.cap}: ${lvl.holders.map((h) => h.title).join('; ')}). You can still save; consider lowering one of them.`
      : '';

  const save = async () => {
    const body: Record<string, unknown> = {
      title: form.title,
      summary: form.summary,
      body: form.body,
      importance: form.importance,
      importance_reason: form.importance_reason,
      status: form.status,
      tags: tagList,
      wording_only: form.wording_only,
    };
    if (form.section_id === '__new') body.section = form.newSection;
    else body.section_id = form.section_id || null;
    if (await run(() => (doc ? api(`/api/docs/${doc.id}`, { method: 'PATCH', body }) : api(`/api/projects/${s.project.id}/docs`, { body })))) onClose();
  };

  return (
    <Sheet title={doc ? 'Edit entry' : 'Add to the Spec'} onClose={onClose} wide>
      <div className="form">
        <div className="row wrap">
          {
            <label>
              Section
              <select value={form.section_id} onChange={(e) => setForm({ ...form, section_id: e.target.value })}>
                <option value="">No section</option>
                {tree.order.map((n) => (
                  <option key={n.sec.id} value={n.sec.id}>
                    {pathNames(tree, n.sec.id).join(' › ')}
                  </option>
                ))}
                <option value="__new">New section…</option>
              </select>
            </label>
          }
        </div>
        {steer && form.section_id === '__new' && (
          <label>
            New section <span className="muted small">a name, or a path such as Combat / Weapons</span>
            <input value={form.newSection} onChange={(e) => setForm({ ...form, newSection: e.target.value })} placeholder="e.g. Dashboard" />
          </label>
        )}
        <label>
          Title
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus={!doc} />
        </label>
        <label>
          Summary <span className="muted small">one or two sentences, shown when collapsed · {form.summary.length}/320</span>
          <textarea rows={2} maxLength={320} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} placeholder="What this says should be true, in a sentence that stands on its own." />
        </label>
        <label>
          Text (markdown) <span className="muted small">the intended result, not progress</span>
          <textarea rows={9} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        </label>
        <label>
          Tags <span className="muted small">comma separated, up to three, reusing the project's</span>
          <input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="ios, security" />
        </label>
        {known.length > 0 && (
          <div className="spec-tag-suggest">
            {known.map((t) => (
              <button key={t} className="tag tone-blue mono spec-tag-link" onClick={() => setForm({ ...form, tags: [...tagList, t].join(', ') })}>
                + #{t}
              </button>
            ))}
          </div>
        )}
        <div className="row wrap">
          <label>
            Importance
            <select value={form.importance} onChange={(e) => setForm({ ...form, importance: Number(e.target.value) })}>
              {[5, 4, 3, 2, 1].map((n) => (
                <option key={n} value={n}>
                  {importanceName(n)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Status
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Doc['status'] })}>
              {(['proposed', 'active', 'paused', 'done', 'dropped'] as const).map((st) => (
                <option key={st} value={st}>
                  {docStatusLabel(st)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {steer && form.importance >= 4 && (
          <label>
            Why {importanceName(form.importance)} <span className="muted small">what fails or waits without it</span>
            <input value={form.importance_reason} onChange={(e) => setForm({ ...form, importance_reason: e.target.value })} />
          </label>
        )}
        {steer && budgetNote && <p className="imp-warning small">{budgetNote}</p>}
        {steer && (
          <label className="check">
            <input type="checkbox" checked={form.wording_only} onChange={(e) => setForm({ ...form, wording_only: e.target.checked })} /> Wording only: a fix that does not change what the project should be
          </label>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy || !form.title.trim() || (form.section_id === '__new' && !form.newSection.trim())} onClick={save}>
            Save
          </button>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
        <p className="muted small spec-save-note">
          {steer && contentChanged && !form.wording_only
            ? `Changing the title, summary or text of an entry starts a planning discussion: after ${quiet} quiet minute${quiet === 1 ? '' : 's'}, ${director} gets what changed in a new Planning task and replies there with a plan. Nothing is started until you approve it.`
            : `Saved without telling ${director}. Agents read the Spec before they start work.`}
        </p>
      </div>
    </Sheet>
  );
}

function SectionsSheet({ s, tree, onMove, onClose }: { s: ProjectState; tree: SecTree; onMove: (id: string) => void; onClose: () => void }) {
  const { busy, error, run } = useAction();
  const [drafts, setDrafts] = useState<Record<string, { name: string; description: string }>>({});
  const [fresh, setFresh] = useState({ name: '', description: '', parent_id: '' });
  // Up and down move a section among its siblings.
  const shift = (n: SecNode, by: number) => {
    const sibs = n.sec.parent_id && tree.byId.has(n.sec.parent_id) ? tree.byId.get(n.sec.parent_id)!.kids : tree.roots;
    const i = sibs.indexOf(n);
    void run(() => api(`/api/sections/${n.sec.id}`, { method: 'PATCH', body: { position: i + 1 + by } }));
  };
  const sibs = (n: SecNode) => (n.sec.parent_id && tree.byId.has(n.sec.parent_id) ? tree.byId.get(n.sec.parent_id)!.kids : tree.roots);
  return (
    <Sheet title="Sections" onClose={onClose}>
      <div className="form">
        <p className="muted small">Chapters of the Spec, in reading order, up to {MAX_DEPTH} levels deep. Removing one moves its entries and subsections up a level.</p>
        {tree.order.map((n) => {
          const sec = n.sec;
          const dr = drafts[sec.id] ?? { name: sec.name, description: sec.description };
          const dirty = dr.name !== sec.name || dr.description !== sec.description;
          const i = sibs(n).indexOf(n);
          return (
            <fieldset key={sec.id} className={`section-row depth-${n.depth}`}>
              <legend>
                {pathNames(tree, sec.id).join(' › ')} · {plural(n.total, 'entry', 'entries')}
              </legend>
              <input value={dr.name} onChange={(e) => setDrafts({ ...drafts, [sec.id]: { ...dr, name: e.target.value } })} aria-label="Name" />
              <input value={dr.description} placeholder="One line: what this part covers" onChange={(e) => setDrafts({ ...drafts, [sec.id]: { ...dr, description: e.target.value } })} aria-label="Description" />
              <div className="row wrap">
                <button className="btn small" disabled={busy || !dirty || !dr.name.trim()} onClick={() => run(() => api(`/api/sections/${sec.id}`, { method: 'PATCH', body: dr }))}>
                  Save
                </button>
                <button className="btn small quiet" disabled={busy || i === 0} onClick={() => shift(n, -1)} aria-label="Move up">
                  ↑
                </button>
                <button className="btn small quiet" disabled={busy || i === sibs(n).length - 1} onClick={() => shift(n, 1)} aria-label="Move down">
                  ↓
                </button>
                <button className="btn small quiet" disabled={busy} onClick={() => onMove(sec.id)}>
                  Move…
                </button>
                <span className="spacer" />
                <button className="btn small danger quiet" disabled={busy} onClick={() => confirm(`Remove the section “${sec.name}”? ${n.total || n.kids.length ? 'What is in it moves up a level.' : ''}`) && run(() => api(`/api/sections/${sec.id}`, { method: 'DELETE' }))}>
                  Remove
                </button>
              </div>
            </fieldset>
          );
        })}
        <fieldset className="section-row">
          <legend>New section</legend>
          <input value={fresh.name} placeholder="Name, e.g. Deployment" onChange={(e) => setFresh({ ...fresh, name: e.target.value })} />
          <input value={fresh.description} placeholder="One line: what this part covers" onChange={(e) => setFresh({ ...fresh, description: e.target.value })} />
          <label>
            Inside
            <select value={fresh.parent_id} onChange={(e) => setFresh({ ...fresh, parent_id: e.target.value })}>
              <option value="">Top level</option>
              {tree.order
                .filter((n) => n.depth < MAX_DEPTH)
                .map((n) => (
                  <option key={n.sec.id} value={n.sec.id}>
                    {pathNames(tree, n.sec.id).join(' › ')}
                  </option>
                ))}
            </select>
          </label>
          <div className="row">
            <button
              className="btn small primary"
              disabled={busy || !fresh.name.trim()}
              onClick={async () => (await run(() => api(`/api/projects/${s.project.id}/sections`, { body: { ...fresh, parent_id: fresh.parent_id || null } }))) && setFresh({ name: '', description: '', parent_id: '' })}
            >
              Add section
            </button>
          </div>
        </fieldset>
        {error && <p className="error-text">{error}</p>}
      </div>
    </Sheet>
  );
}
