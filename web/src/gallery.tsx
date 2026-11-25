import { useEffect, useMemo, useState } from 'react';
import { useLive } from './api';
import type { Preview, ProjectState } from './api';
import { PreviewThumb } from './preview';
import { Chips, ago, href, openPreview } from './ui';

/**
 * The Gallery (a project's page, and a section of the global Home for all projects): every preview's latest version,
 * newest-updated first, as tiles with the thumbnail, title, its task and when. Filters by task, by kind and a search;
 * a dot on what is new since the user last looked (kept on this device). Tapping a tile opens the viewer over the
 * page (PreviewHost in more.tsx), with its versions; closing it leaves the page where it was. One column of large
 * tiles on a phone, three or four across on desktop. Data: the project's state (shared cache), or /api/gallery.
 */
export type GalleryItem = Preview & { project_id: string; project_name?: string; task_title?: string | null };

type Kind = 'all' | 'image' | 'compare' | 'chart' | 'page';
const KIND_OF: Record<string, Kind> = { image: 'image', guide: 'image', video: 'image', compare: 'compare', chart: 'chart', html: 'page', markdown: 'page', text: 'page', pdf: 'page', link: 'page' };
const seenKey = (scope: string) => `helm:gallery-seen:${scope}`;

export function Gallery({ items, scope, tasks, showProject = false }: { items: GalleryItem[]; scope: string; tasks?: { id: string; title: string }[]; showProject?: boolean }) {
  const [kind, setKind] = useState<Kind>('all');
  const [task, setTask] = useState('');
  const [q, setQ] = useState('');
  // What the user had seen when the page opened: the dots stay for this visit; the next visit starts from now.
  const [seen] = useState(() => Number(localStorage.getItem(seenKey(scope)) ?? 0));
  useEffect(() => {
    if (items.length) localStorage.setItem(seenKey(scope), String(Math.max(...items.map((p) => p.created_at))));
  }, [items, scope]);
  const sorted = useMemo(() => [...items].sort((a, b) => b.created_at - a.created_at), [items]);
  const needle = q.trim().toLowerCase();
  const shown = sorted.filter(
    (p) =>
      (kind === 'all' || KIND_OF[p.kind] === kind) &&
      (!task || p.task_id === task) &&
      (!needle || `${p.title} ${p.caption ?? ''} ${p.task_title ?? ''} ${p.project_name ?? ''}`.toLowerCase().includes(needle)),
  );
  const count = (k: Kind) => (k === 'all' ? sorted.length : sorted.filter((p) => KIND_OF[p.kind] === k).length);
  const taskList = tasks?.filter((t) => sorted.some((p) => p.task_id === t.id)) ?? [];
  return (
    <div className="gal-root">
      <div className="gallery-tools">
        <input className="gallery-find" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search previews" aria-label="Search previews" />
        {taskList.length > 0 && (
          <select className="gallery-task" value={task} onChange={(e) => setTask(e.target.value)} aria-label="Task">
            <option value="">All tasks</option>
            {taskList.map((t) => (
              <option key={t.id} value={t.id}>
                {t.title}
              </option>
            ))}
          </select>
        )}
      </div>
      <Chips
        value={kind}
        onChange={setKind}
        options={[
          { id: 'all', label: 'All', count: count('all') },
          { id: 'image', label: 'Images', count: count('image') },
          { id: 'compare', label: 'Comparisons', count: count('compare') },
          { id: 'chart', label: 'Charts', count: count('chart') },
          { id: 'page', label: 'Pages', count: count('page') },
        ]}
      />
      {shown.length ? (
        <div className="gallery-grid">
          {shown.map((p) => (
            <Tile key={p.id} p={p} fresh={!!seen && p.created_at > seen} showProject={showProject} />
          ))}
        </div>
      ) : (
        <p className="muted small">{sorted.length ? 'No preview matches.' : 'No previews yet.'}</p>
      )}
    </div>
  );
}

function Tile({ p, fresh, showProject }: { p: GalleryItem; fresh: boolean; showProject: boolean }) {
  return (
    <article className={`gallery-tile ${fresh ? 'fresh' : ''}`}>
      <button type="button" className="gallery-shot" onClick={() => openPreview(p.project_id, p.id)} aria-label={`Open ${p.title}`}>
        <PreviewThumb p={p} />
        {(p.version ?? 1) > 1 && <span className="media-label gallery-version">v{p.version}</span>}
      </button>
      <div className="gallery-txt">
        <button type="button" className="gallery-title" onClick={() => openPreview(p.project_id, p.id)}>
          {fresh && <span className="pv-dot" aria-label="New since you last looked" />}
          <span className="one-line">{p.title}</span>
        </button>
        <span className="muted small one-line">
          {showProject && p.project_name && (
            <>
              <a href={href('p', p.project_id, 'gallery')}>{p.project_name}</a>
              {' · '}
            </>
          )}
          {p.task_id && p.task_title && (
            <>
              <a href={href('p', p.project_id, p.task_id.startsWith('disc_') ? 'discussions' : 'tasks', p.task_id)}>{p.task_title}</a>
              {' · '}
            </>
          )}
          {ago(p.created_at)}
        </span>
      </div>
    </article>
  );
}

/** A project's Gallery page (#/p/<id>/gallery). */
export function GalleryPage({ s }: { s: ProjectState }) {
  const titles = useMemo(() => new Map([...s.tasks, ...s.discussions].map((t) => [t.id, t.title] as const)), [s.tasks, s.discussions]);
  const items = useMemo(() => s.previews.map((p) => ({ ...p, project_id: s.project.id, task_title: p.task_id ? (titles.get(p.task_id) ?? null) : null })), [s.previews, titles, s.project.id]);
  const tasks = useMemo(() => [...titles].map(([id, title]) => ({ id, title })), [titles]);
  return (
    <section className="gallery-page">
      <h1 className="page-title">Gallery</h1>
      <Gallery items={items} scope={s.project.id} tasks={tasks} />
    </section>
  );
}

/** The global Home's Gallery section: the latest previews across every project (/api/gallery). */
export function GlobalGallery() {
  const { data } = useLive<{ items: GalleryItem[] }>('/api/gallery', (m) => m.type === 'project' || m.type === 'projects');
  if (!data) return null;
  return <Gallery items={data.items} scope="all" showProject />;
}

