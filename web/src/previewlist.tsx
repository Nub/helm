import { useEffect, useMemo, useState } from 'react';
import { useLive } from './api';
import type { Preview, ProjectState } from './api';
import { PreviewBody } from './preview';
import { Fold } from './fold';
import { Icon, Markdown, ago, openPreview } from './ui';

/**
 * A task's Previews section (the task page, in place of For review): one card per preview, showing its latest version,
 * with its earlier versions a tap away (‹ v3 of 5 ›; server/store.ts previewVersions). Newest-updated first; a dot on
 * those updated since the user last looked at this task's previews (kept on this device). Two side by side on wider
 * screens, one per row on a phone, full width with little chrome there.
 */
export type PreviewVersion = Preview & { version: number; agent_name: string | null; commit_sha: string | null };

const seenKey = (taskId: string) => `helm:previews-seen:${taskId}`;

export function TaskPreviews({ s, taskId, exclude = [] }: { s: ProjectState; taskId: string; exclude?: string[] }) {
  const list = useMemo(
    () => s.previews.filter((p) => p.task_id === taskId && !exclude.includes(p.id)).sort((a, b) => b.created_at - a.created_at),
    [s.previews, taskId, exclude.join(',')],
  );
  // What the user had seen when the page opened: the dots stay for this visit, the next visit starts from now.
  const [seen] = useState(() => Number(localStorage.getItem(seenKey(taskId)) ?? 0));
  useEffect(() => {
    if (list.length) localStorage.setItem(seenKey(taskId), String(Math.max(...list.map((p) => p.created_at))));
  }, [list, taskId]);
  if (!list.length) return null;
  return (
    <Fold kind="task-previews" title={`Previews · ${list.length}`} className="task-previews" label="Previews">
      <div className="pv-grid">
        {list.map((p) => (
          <PreviewCard key={p.id} p={p} pid={s.project.id} fresh={!!seen && p.created_at > seen} />
        ))}
      </div>
    </Fold>
  );
}

/**
 * Stepping through a preview's versions: the version shown (the latest until the user steps back) and the ‹ vN of M ›
 * control. Earlier versions load only when the user steps back to one.
 */
export function useVersions(p: Preview & { version?: number }, pid: string): { shown: Preview; loading: boolean; switcher: React.ReactNode } {
  const count = p.version ?? 1;
  const [at, setAt] = useState<number | null>(null);
  const { data } = useLive<{ versions: PreviewVersion[] }>(at !== null && count > 1 ? `/api/previews/${p.id}/versions` : null, (m) => m.type === 'project' && m.projectId === pid);
  // A new version arriving brings it back to the latest.
  useEffect(() => setAt(null), [count]);
  const v = at !== null ? data?.versions.find((x) => x.version === at) : undefined;
  const shown: Preview = v ? { ...p, kind: v.kind, title: v.title, caption: v.caption, file: v.file, content: v.content, created_at: v.created_at, feedback: undefined } : p;
  const n = at ?? count;
  const switcher =
    count > 1 ? (
      <span className="pv-versions">
        <button type="button" className="icon-btn" disabled={n <= 1} onClick={() => setAt(n - 1)} aria-label="Earlier version">
          <Icon name="back" size={16} />
        </button>
        <span className="muted small mono">
          v{n} of {count}
        </span>
        <button type="button" className="icon-btn" disabled={n >= count} onClick={() => setAt(n + 1 >= count ? null : n + 1)} aria-label="Later version">
          <Icon name="chevron" size={16} />
        </button>
      </span>
    ) : null;
  return { shown, loading: at !== null && !v, switcher };
}

/** One preview: its latest version, the switcher through its versions, and a tap on the title to open it in the viewer. */
function PreviewCard({ p, pid, fresh }: { p: Preview & { version?: number }; pid: string; fresh: boolean }) {
  const { shown, loading, switcher } = useVersions(p, pid);
  return (
    <article className={`pv-card ${fresh ? 'fresh' : ''}`}>
      <header className="pv-card-head">
        {fresh && <span className="pv-dot" aria-label="Updated since you last looked" />}
        <button type="button" className="pv-card-title one-line" onClick={() => openPreview(pid, p.id)} title="Open">
          {shown.title}
        </button>
        {switcher}
      </header>
      <div className="pv-card-body">{loading ? <div className="loading small">Loading…</div> : <PreviewBody p={shown} />}</div>
      {shown.caption && <Markdown className="pv-card-caption small" text={shown.caption} />}
      <p className="muted small pv-card-meta">{ago(shown.created_at)}</p>
    </article>
  );
}
