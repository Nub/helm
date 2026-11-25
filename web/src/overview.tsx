import { useEffect } from 'react';
import type { MouseEvent } from 'react';
import { useLive } from './api';
import type { Preview } from './api';
import { NeedsSections } from './needs';
import { GlobalGallery } from './gallery';
import { PreviewThumb, previewImage } from './preview';
import { Icon, PlainRefs, go, href } from './ui';
import { when } from './time';

/**
 * The global Home (#/home): what needs the user across every project, then one card per project, most recent
 * activity first. Each card says the project's mode, what is running now (with each task's live status line), what
 * finished since the user last looked, anything failed or stuck, and its latest picture; tapping it opens that
 * project's Home. Server: overview.ts (/api/overview). Loads from the shared cache: no page loader.
 */
type OverviewTask = { id: string; title: string; line: string };
type OverviewProject = {
  id: string;
  name: string;
  mode: string;
  activity: number;
  since: number;
  running: OverviewTask[];
  finished: { id: string; title: string; finished_at: number; preview: OverviewPreview | null }[];
  failed: { id: string; title: string; href_kind: 'task' | 'agent' | 'release' }[];
  stuck: OverviewTask[];
  preview: OverviewPreview | null;
  xthreads?: { id: string; title: string; peer: string }[];
};
type OverviewPreview = { id: string; kind: string; title: string; file: string | null; content: string | null };
const asPreview = (pid: string, p: OverviewPreview | null) => (p ? ({ ...p, project_id: pid, caption: '', created_at: 0 } as unknown as Preview) : null);

/** A small picture of a preview (its image, or the drawn thumbnail of a chart or text). */
function Thumb({ pid, p, className }: { pid: string; p: OverviewPreview | null; className: string }) {
  const pv = asPreview(pid, p);
  if (!pv) return null;
  const img = previewImage(pv);
  return <span className={className} aria-hidden="true">{img ? <img src={img} alt="" loading="lazy" /> : <PreviewThumb p={pv} />}</span>;
}
type Overview = { since: number; digest: { done: number; projects: number; running: number; failed: number }; projects: OverviewProject[] };

const MODE_LABEL: Record<string, string> = { running: 'Autopilot', queue_only: 'Queue only', winding_down: 'Finish up', at_rest: 'At rest', stopped: 'Stopped' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Since 9:10 pm: 6 done across 3 projects, 2 running, 1 failed". */
function DigestLine({ o }: { o: Overview }) {
  const d = o.digest;
  const bits = [
    d.done ? `${d.done} done${d.projects > 1 ? ` across ${d.projects} projects` : ''}` : '',
    d.running ? `${d.running} running` : '',
  ].filter(Boolean);
  return (
    <p className="ov-digest">
      <span className="ov-digest-since">Since {when(o.since)}</span>
      <span className="muted">
        {bits.length || d.failed ? ': ' : ': quiet'}
        {bits.join(', ')}
        {d.failed > 0 && (
          <>
            {bits.length ? ', ' : ''}
            <span className="err-text">{d.failed} failed</span>
          </>
        )}
      </span>
    </p>
  );
}

const failHref = (pid: string, f: OverviewProject['failed'][number]) =>
  f.href_kind === 'task' ? href('p', pid, 'tasks', f.id) : f.href_kind === 'agent' ? href('p', pid, 'agents', f.id) : href('p', pid, 'ship', f.id);

function ProjectCard({ p }: { p: OverviewProject }) {
  const home = href('p', p.id, 'overview');
  // The whole card opens the project's Home; its own links go where they say.
  const open = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('a, button')) return;
    go('p', p.id, 'overview');
  };
  // The project's latest picture, unless its finished tasks show their own.
  const showShot = !!p.preview && !p.finished.some((t) => t.preview);
  const xthreads = p.xthreads ?? [];
  const quiet = !p.running.length && !p.finished.length && !p.failed.length && !p.stuck.length && !xthreads.length;
  return (
    <article className="card ov-card" onClick={open}>
      <header className="ov-card-head">
        <a className="ov-card-name one-line" href={home}>
          {p.name}
        </a>
        <span className={`tag status mode-chip mode-${p.mode}`}>{MODE_LABEL[p.mode] ?? p.mode}</span>
      </header>
      {showShot && <Thumb pid={p.id} p={p.preview} className="ov-card-shot" />}
      {(p.failed.length > 0 || p.stuck.length > 0) && (
        <ul className="ov-list">
          {p.failed.map((f) => (
            <li key={f.id}>
              <a className="err-text" href={failHref(p.id, f)}>
                <Icon name="alert" size={16} /> <span className="one-line">{f.title}</span>
              </a>
            </li>
          ))}
          {p.stuck.map((t) => (
            <li key={t.id}>
              <a className="err-text" href={href('p', p.id, 'tasks', t.id)}>
                <Icon name="pause" size={16} /> <span className="one-line">Stuck: {t.title}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {p.running.length > 0 && (
        <ul className="ov-list">
          {p.running.map((t) => (
            <li key={t.id}>
              <a href={href('p', p.id, 'tasks', t.id)}>
                <span className="tag status ts-active" aria-label="Running" />
                <span className="ov-task">
                  <span className="one-line">{t.title}</span>
                  {t.line && (
                    <span className="muted small one-line">
                      <PlainRefs text={t.line} />
                    </span>
                  )}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {/* Replies from other projects' directors not opened yet (server/crossproject.ts). */}
      {xthreads.length > 0 && (
        <ul className="ov-list">
          {xthreads.map((t) => (
            <li key={t.id}>
              <a className="muted" href={href('p', p.id, 'discussions', t.id)}>
                <Icon name="discuss" size={16} /> <span className="one-line">{t.peer} replied: {t.title}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {p.finished.length > 0 && (
        <ul className="ov-list">
          {p.finished.map((t) => (
            <li key={t.id}>
              <a className="ov-done" href={href('p', p.id, 'tasks', t.id)}>
                {t.preview ? <Thumb pid={p.id} p={t.preview} className="ov-thumb" /> : <span className="ov-thumb none"><Icon name="check" size={16} /></span>}
                <span className="ov-task">
                  <span className="one-line">{t.title}</span>
                  <span className="muted small">Done {when(t.finished_at)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {quiet && <p className="muted small">Nothing running or finished since {when(p.since)}</p>}
    </article>
  );
}

export function GlobalHome({ section }: { section?: string }) {
  const { data } = useLive<Overview>('/api/overview', (m) => m.type === 'project' || m.type === 'projects');
  // The old Needs you link lands on the requests.
  useEffect(() => {
    if (section === 'needs' || section === 'gallery') requestAnimationFrame(() => document.getElementById(section)?.scrollIntoView({ block: 'start' }));
  }, [section]);
  return (
    <section className="ov-page">
      <h1 className="sr-only">Home</h1>
      {data && <DigestLine o={data} />}
      <h2 className="ov-h" id="needs">Needs you</h2>
      <NeedsSections />
      {data && data.projects.length > 0 && (
        <>
          <h2 className="ov-h">Projects</h2>
          <div className="ov-grid">
            {data.projects.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        </>
      )}
      <h2 className="ov-h" id="gallery">Gallery</h2>
      <GlobalGallery />
    </section>
  );
}
