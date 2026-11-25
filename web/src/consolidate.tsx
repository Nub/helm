import { api, useLive } from './api';
import type { ProjectState } from './api';
import { Icon, Markdown, Tag, clock, useAction } from './ui';
import { openChat } from './chat';

/**
 * Consolidate tasks (server/merge.ts): the Work page's button opens a discussion with the director about the tasks
 * that are not running, and each change it proposes is a card here: merge into one, run back to back, or make one wait
 * for another, with the gain in one line. Applying does it; the discussion settles once every card is decided.
 */

type Consolidation = { id: string; kind: 'merge' | 'adjacent' | 'wait'; gain: string; status: 'open' | 'applied' | 'declined'; result: string; agent_name: string; created_at: number; tasks: { id: string; title: string; state: string }[] };

const KIND: Record<Consolidation['kind'], string> = { merge: 'Merge into one', adjacent: 'Run back to back', wait: 'Wait for' };

/** The Work page's button, beside Add task. */
export function ConsolidateButton({ pid }: { pid: string }) {
  const { busy, error, run } = useAction();
  return (
    <>
      <button
        className="btn small quiet"
        disabled={busy}
        onClick={() => void run(async () => openChat({ kind: 'discussion', id: (await api<{ discussion_id: string }>(`/api/projects/${pid}/consolidate`, { method: 'POST' })).discussion_id }))}
      >
        Consolidate tasks
      </button>
      {error && <span className="error-text small">{error}</span>}
    </>
  );
}

/** A proposal in the discussion's thread: the message body is {"id": …}. */
export function ConsolidationCard({ body, s }: { body: string; s: ProjectState }) {
  let id = '';
  try {
    id = JSON.parse(body).id;
  } catch {}
  const pid = s.project.id;
  const { data, error } = useLive<Consolidation>(id ? `/api/consolidations/${id}` : null, (m) => m.type === 'project' && m.projectId === pid);
  const act = useAction();
  if (error) return <div className="tl-card error-text small">{error}</div>;
  if (!data) return <div className="tl-card muted small">Loading the proposal…</div>;
  const open = data.status === 'open';
  const [first, second] = data.tasks;
  const what =
    data.kind === 'merge'
      ? `Keep [[${first?.id}]], merge in ${data.tasks.slice(1).map((t) => `[[${t.id}]]`).join(', ')}`
      : data.kind === 'adjacent'
        ? data.tasks.map((t) => `[[${t.id}]]`).join(' → ')
        : `[[${first?.id}]] waits for [[${second?.id}]]`;
  return (
    <div className={`tl-card consolidation ${open ? '' : 'prop-dim'}`}>
      <span className="msg-meta">
        <b>{data.agent_name || 'Director'}</b> · proposed · {clock(data.created_at)}
      </span>
      <p className="small">
        <Tag tone={open ? 'tone-accent' : 'tone-todo'}>{open ? KIND[data.kind] : data.status === 'applied' ? 'Applied' : 'Declined'}</Tag> {data.gain}
      </p>
      <Markdown className="small" text={what} />
      {data.result && <p className="muted small">{data.result.replace(/\[\[[^\]]+\]\]/g, '').trim() ? <Markdown className="inline-md" text={data.result} /> : null}</p>}
      {open && (
        <div className="row wrap">
          <button className="btn small primary" disabled={act.busy} onClick={() => void act.run(() => api(`/api/consolidations/${data.id}/apply`, { method: 'POST' }))}>
            <Icon name="check" size={16} /> Apply
          </button>
          <button className="btn small quiet" disabled={act.busy} onClick={() => void act.run(() => api(`/api/consolidations/${data.id}/decline`, { method: 'POST' }))}>
            Not this
          </button>
        </div>
      )}
      {act.error && <p className="error-text small">{act.error}</p>}
    </div>
  );
}
