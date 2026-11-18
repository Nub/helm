import { useEffect, useState } from 'react';
import { api, useLive } from './api';
import type { Doc, ProjectState, Proposal } from './api';
import { DiffText, docStatusLabel } from './spec';
import { Icon, Markdown, Tag, ago, clock, href, useAction } from './ui';
import { openChat } from './chat';

/**
 * Discussing a Spec entry with the director (server/specdiscuss.ts): the Discuss button and its sheet on the Spec
 * page, the "Discussing" marker, the live entry card at the top of the discussion, the snapshot the thread starts
 * with, and the cards for the edits the director proposes.
 */

const FOCUS_KEY = 'helm-focus-composer';

/** Discussions about an entry, newest link first. */
function discussionsOf(s: ProjectState, docId: string) {
  const ids = s.docLinks
    .filter((l) => l.doc_id === docId && l.relation === 'discusses')
    .map((l) => l.task_id)
    .reverse();
  return ids.map((id) => s.discussions.find((d) => d.id === id)).filter((d): d is ProjectState['discussions'][number] => !!d);
}
export const openDiscussionOf = (s: ProjectState, docId: string) => discussionsOf(s, docId).find((d) => d.kind !== 'task' && d.state === 'open');

/** The entry a discussion is about, if it is one. */
export function entryOfDiscussion(s: ProjectState, discussionId: string): Doc | undefined {
  const link = [...s.docLinks].reverse().find((l) => l.task_id === discussionId && l.relation === 'discusses');
  return link ? s.docs.find((d) => d.id === link.doc_id) : undefined;
}


/**
 * "Discuss" on an entry: opens the chat with the director about it (chat.tsx). Its thread is the entry's planning
 * task while its change is planned, else its open discussion; with neither, the first message starts a discussion.
 */
export function DiscussButton({ d }: { s: ProjectState; d: Doc; director: string }) {
  return (
    <button className="btn quiet" onClick={() => openChat({ kind: 'doc', id: d.id })}>
      <Icon name="discuss" size={15} /> Discuss
    </button>
  );
}

/** On the entry: an open discussion about it, with its message count, linking to it. */
export function DiscussingMarker({ s, d }: { s: ProjectState; d: Doc }) {
  const open = openDiscussionOf(s, d.id);
  if (!open) return null;
  return (
    <a className="spec-discussing small" href={href('p', s.project.id, 'discussions', open.id)} onClick={(e) => e.stopPropagation()}>
      <Icon name="discuss" size={13} /> Discussing · {open.messages} {open.messages === 1 ? 'message' : 'messages'}
    </a>
  );
}

/** Top of a discussion about an entry: the entry as it is now (collapsed to its summary), and a link back to it. */
export function SpecEntryCard({ s, discussionId }: { s: ProjectState; discussionId: string }) {
  const d = entryOfDiscussion(s, discussionId);
  const [open, setOpen] = useState(false);
  // Arriving from Discuss: put the cursor in the reply box.
  useEffect(() => {
    if (sessionStorage.getItem(FOCUS_KEY) !== discussionId) return;
    sessionStorage.removeItem(FOCUS_KEY);
    setTimeout(() => document.querySelector<HTMLTextAreaElement>('.disc-page .convo-dock textarea')?.focus(), 50);
  }, [discussionId]);
  if (!d) return null;
  return (
    <section className={`spec-disc-entry ${open ? 'open' : ''}`}>
      <button className="spec-disc-entry-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={14} />
        <span>
          <span className="label">About the Spec entry · as it is now</span>
          <b>{d.title}</b>
        </span>
      </button>
      {d.summary && <p className="spec-summary small">{d.summary}</p>}
      {open && (
        <div className="spec-disc-entry-body">
          <div className="row wrap">
            <Tag tone={`doc-st st-${d.status}`}>{docStatusLabel(d.status)}</Tag>
            {d.tags.map((t) => (
              <span key={t} className="spec-tag small">
                #{t}
              </span>
            ))}
            <span className="muted small">updated {ago(d.updated_at)}</span>
          </div>
          {d.body ? <Markdown text={d.body} /> : <p className="muted small">No text yet.</p>}
        </div>
      )}
      <a className="small" href={href('p', s.project.id, 'spec', d.id)}>
        Open in the Spec
      </a>
    </section>
  );
}

/** The thread's first item: the entry as it read when the discussion started. */
export function SnapshotCard({ body, ts }: { body: string; ts: number }) {
  let data: { intro: string; title: string; summary: string; body: string; tags: string[]; section: string } | null = null;
  try {
    data = JSON.parse(body);
  } catch {}
  if (!data) return <div className="tl-card">{body}</div>;
  return (
    <details className="tl-card spec-snapshot">
      <summary>
        <span className="msg-meta">
          <b>Helm</b> · {clock(ts)}
        </span>
        <span className="small">{data.intro}</span>
        <b>{data.title}</b>
        {data.summary && <span className="small muted">{data.summary}</span>}
      </summary>
      {data.body ? <Markdown text={data.body} /> : <p className="muted small">No text.</p>}
      {(data.section || data.tags.length > 0) && (
        <p className="muted small">
          {data.section && <>Section {data.section}</>}
          {data.section && data.tags.length > 0 && ' · '}
          {data.tags.length > 0 && data.tags.map((t) => `#${t}`).join(' ')}
        </p>
      )}
    </details>
  );
}

const FIELD = { title: 'Title', summary: 'Summary', body: 'Text', tags: 'Tags', section: 'Section' } as const;
const STATUS: Record<Proposal['status'], { label: string; tone: string }> = {
  open: { label: 'Proposed', tone: 'tone-accent' },
  applied: { label: 'Applied', tone: 'tone-applied' },
  declined: { label: 'Not applied', tone: '' },
  superseded: { label: 'Superseded', tone: '' },
  closed: { label: 'Closed', tone: '' },
};

/** A proposed edit in the thread: the before/after and, while open, the owner's choice. */
export function ProposalCard({ body, ts, projectId }: { body: string; ts: number; projectId: string }) {
  let id = '';
  try {
    id = JSON.parse(body).id;
  } catch {}
  const { data: p, error: loadError } = useLive<Proposal>(id ? `/api/proposals/${id}` : null, (m) => m.type === 'project' && m.projectId === projectId);
  const { busy, error, run } = useAction();
  const [declining, setDeclining] = useState(false);
  const [note, setNote] = useState('');
  if (loadError) return <div className="tl-card error-text">{loadError}</div>;
  if (!p) return <div className="tl-card muted small">Loading the proposed edit…</div>;
  const st = STATUS[p.status] ?? STATUS.closed;
  const live = p.status === 'open';
  const apply = (wording_only: boolean) => void run(() => api(`/api/proposals/${p.id}/apply`, { body: { wording_only } }));
  const decline = () => void run(() => api(`/api/proposals/${p.id}/decline`, { body: { note } }));
  return (
    <div className={`tl-card tl-proposal prop-${p.status}`}>
      <span className="msg-meta">
        <b>{p.author_name}</b> · proposed edit · {clock(ts)}
      </span>
      <div className="row wrap prop-head">
        <Tag tone={st.tone}>{st.label}</Tag>
        <a href={href('p', projectId, 'spec', p.doc_id)}>
          <b>{p.doc_title}</b>
        </a>
      </div>
      {p.rationale && <p className="small prop-why">{p.rationale}</p>}
      <div className={`diff-fields ${live ? '' : 'prop-dim'}`}>
        {p.fields.map((f) => (
          <div key={f.field}>
            <span className="label">{FIELD[f.field]}</span>
            {f.field === 'title' || f.field === 'summary' || f.field === 'body' ? (
              <DiffText before={f.before} after={f.after} />
            ) : (
              <div className="diff">
                {f.before && <del>{f.before}</del>} {f.after ? <ins>{f.after}</ins> : <span className="muted">(none)</span>}
              </div>
            )}
          </div>
        ))}
      </div>
      {live && p.stale.length > 0 && (
        <div className="prop-stale small">
          <b>The entry changed since this was proposed</b>, so it no longer applies cleanly. Changed underneath:
          {p.stale.map((f) => (
            <div key={f.field}>
              <span className="label">{FIELD[f.field]}</span>
              <DiffText before={f.was} after={f.now} />
            </div>
          ))}
          Ask for a fresh proposal in the thread, or decline this one.
        </div>
      )}
      {live && !p.doc_exists && <p className="small muted">The entry has been removed.</p>}
      {p.status === 'applied' && (
        <p className="small muted">
          You applied it{p.wording_only ? ' as wording only' : ''} · {p.decided_at ? ago(p.decided_at) : ''}
        </p>
      )}
      {p.status === 'declined' && <p className="small muted">You declined it{p.note ? `: ${p.note}` : '.'}</p>}
      {p.status === 'superseded' && <p className="small muted">A newer proposal for this entry replaced it.</p>}
      {p.status === 'closed' && <p className="small muted">The discussion was settled before it was applied.</p>}
      {live && !declining && (
        <div className="row wrap prop-actions">
          <button className="btn primary small" disabled={busy || p.stale.length > 0 || !p.doc_exists} onClick={() => apply(false)}>
            <Icon name="check" size={14} /> Apply
          </button>
          <button
            className="btn small"
            disabled={busy || p.stale.length > 0 || !p.doc_exists}
            onClick={() => apply(true)}
            title="Apply without a planning task: the meaning is unchanged"
          >
            Apply as wording only
          </button>
          <button className="btn quiet small" disabled={busy} onClick={() => setDeclining(true)}>
            Not this
          </button>
        </div>
      )}
      {live && declining && (
        <div className="prop-decline">
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} autoFocus placeholder="What is wrong with it? (optional, goes to the director)" />
          <div className="row wrap prop-actions">
            <button className="btn small" disabled={busy} onClick={decline}>
              Decline
            </button>
            <button className="btn quiet small" disabled={busy} onClick={() => setDeclining(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}
