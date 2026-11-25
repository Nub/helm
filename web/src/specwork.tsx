import { useState } from 'react';
import { api, useLive } from './api';
import type { ProjectState, SpecWork } from './api';
import { Icon, Markdown, Sheet, Tag, clock, useAction } from './ui';
import { openChat } from './chat';
import { buildTree, pathNames } from './spectree';

/**
 * Spec work (server/specwork.ts): the Spec page's button and its three processes, each a discussion with the director
 * that goes section by section; the bar at the top of such a discussion (where it stands, Stop or Continue); and the
 * cards it posts: Review findings (pick some to start a Revise) and proposed new entries (Accept or Drop).
 */

type Mode = SpecWork['mode'];
const MODES: { id: Mode; label: string; line: string }[] = [
  { id: 'review', label: 'Review', line: 'Check the Spec against the project, a section at a time. Changes nothing.' },
  { id: 'revise', label: 'Revise', line: 'Restructure or reword it with the director; you apply each change.' },
  { id: 'create', label: 'Create', line: 'Build entries from the code, part by part; you accept or drop each.' },
];
const NAME: Record<Mode, string> = { review: 'Review', revise: 'Revise', create: 'Create' };

/** "Spec work" on the Spec page: Review, Revise or Create, each opening (or resuming) its discussion. */
export function SpecWorkButton({ s }: { s: ProjectState }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn small quiet" onClick={() => setOpen(true)}>
        Spec work
      </button>
      {open && <SpecWorkSheet s={s} onClose={() => setOpen(false)} />}
    </>
  );
}

function SpecWorkSheet({ s, onClose }: { s: ProjectState; onClose: () => void }) {
  const empty = !s.docs.length;
  const [mode, setMode] = useState<Mode>(empty ? 'create' : 'review');
  const [section, setSection] = useState('');
  const [ask, setAsk] = useState('');
  const { busy, error, run } = useAction();
  const tree = buildTree(s.sections, s.docs, () => 0);
  const running = (s.specWork ?? []).find((w) => w.mode === mode);
  const start = () =>
    run(async () => {
      const r = await api<{ id: string }>(`/api/projects/${s.project.id}/spec-work`, { body: { mode, section, ask } });
      onClose();
      openChat({ kind: 'discussion', id: r.id });
    });
  return (
    <Sheet title="Spec work" onClose={onClose} className="spec-work-sheet">
      <ul className="move-list">
        {MODES.map((m) => {
          const disabled = m.id === 'review' && empty;
          return (
            <li key={m.id}>
              <button className={`move-option spec-work-option ${mode === m.id ? 'here' : ''}`} aria-pressed={mode === m.id} disabled={disabled} onClick={() => setMode(m.id)}>
                <b>{m.label}</b>
                <span className="muted small">{disabled ? 'The Spec has no entries yet.' : m.line}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {running ? (
        <div className="row wrap spec-work-go">
          <span className="muted small">{progressText(running)}</span>
          <span className="spacer" />
          <button
            className="btn primary"
            onClick={() => {
              onClose();
              openChat({ kind: 'discussion', id: running.discussion_id });
            }}
          >
            Open it
          </button>
        </div>
      ) : (
        <div className="form spec-work-form">
          {mode !== 'create' && s.sections.length > 0 && (
            <label>
              Section
              <select value={section} onChange={(e) => setSection(e.target.value)}>
                <option value="">The whole Spec</option>
                {tree.order.map((n) => (
                  <option key={n.sec.id} value={n.sec.id}>
                    {pathNames(tree, n.sec.id).join(' › ')}
                  </option>
                ))}
              </select>
            </label>
          )}
          {mode !== 'review' && (
            <label>
              {mode === 'revise' ? 'What should change?' : 'Anything the director should know?'}
              <textarea rows={3} value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={mode === 'revise' ? 'Too many sections, too much detail, one part to tidy…' : 'Optional'} />
            </label>
          )}
          <div className="row">
            <span className="spacer" />
            <button className="btn primary" disabled={busy} onClick={() => void start()}>
              Start {NAME[mode]}
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-text small">{error}</p>}
    </Sheet>
  );
}

const progressText = (w: SpecWork) =>
  `${NAME[w.mode]} open${w.total != null ? ` · ${w.done} of ${w.total} sections` : ''}${w.stop ? ' · stopped' : ''}`;

/** Top of a Spec work discussion: where it stands, and Stop after this section or Continue. */
export function SpecWorkBar({ s, discussionId }: { s: ProjectState; discussionId: string }) {
  const w = (s.specWork ?? []).find((x) => x.discussion_id === discussionId);
  const { busy, error, run } = useAction();
  if (!w) return null;
  return (
    <div className="spec-work-bar">
      <span className="small">{progressText(w)}</span>
      <span className="spacer" />
      <button className="btn small quiet" disabled={busy} onClick={() => void run(() => api(`/api/spec-work/${discussionId}/${w.stop ? 'continue' : 'stop'}`, { method: 'POST' }))}>
        {w.stop ? 'Continue' : 'Stop after this section'}
      </button>
      {error && <span className="error-text small">{error}</span>}
    </div>
  );
}

type Item = {
  id: string;
  kind: 'match' | 'gap' | 'disagree' | 'entry';
  text: string;
  doc_id: string | null;
  doc_title: string | null;
  entry: { title: string; summary: string; body: string; section: string; tags: string[] } | null;
  status: 'open' | 'picked' | 'accepted' | 'dropped';
  result: string | null;
};
type Card = { message_id: number; discussion_id: string; kind: 'findings' | 'entries'; section: string; author_name: string; created_at: number; items: Item[] };

const KIND: Record<string, { label: string; tone: string }> = {
  match: { label: 'Matches', tone: '' },
  gap: { label: 'Gap', tone: 'tone-warning' },
  disagree: { label: 'Disagrees', tone: 'tone-accent' },
};

function useCard(key: string, pid: string) {
  return useLive<Card>(key ? `/api/spec-cards/${key}` : null, (m) => m.type === 'project' && m.projectId === pid);
}

/** A Review's findings for one section. Gaps and disagreements can be picked to start a Revise from them. */
export function FindingsCard({ messageKey, s }: { messageKey: string; s: ProjectState }) {
  const pid = s.project.id;
  const { data, error } = useCard(messageKey.replace(/^m/, ''), pid);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const act = useAction();
  if (error) return <div className="tl-card error-text small">{error}</div>;
  if (!data) return <div className="tl-card muted small">Loading findings…</div>;
  const toggle = (id: string) => setPicked((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set([...p, id])));
  const revise = () =>
    act.run(async () => {
      const r = await api<{ id: string }>(`/api/projects/${pid}/spec-work`, { body: { mode: 'revise', findings: [...picked] } });
      setPicked(new Set());
      openChat({ kind: 'discussion', id: r.id });
    });
  return (
    <div className="tl-card spec-findings">
      <span className="msg-meta">
        <b>{data.author_name || 'Director'}</b> · Review · {clock(data.created_at)}
      </span>
      <b className="spec-findings-section">{data.section}</b>
      <ul className="spec-findings-list">
        {data.items.map((i) => {
          const pickable = i.kind !== 'match' && i.status === 'open';
          const k = KIND[i.kind] ?? KIND.match;
          return (
            <li key={i.id} className={`spec-finding kind-${i.kind}`}>
              {pickable ? (
                <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} aria-label="Pick for a Revise" />
              ) : (
                <span className="spec-finding-pad" aria-hidden="true" />
              )}
              <span className="spec-finding-text small">
                <Tag tone={k.tone}>{k.label}</Tag> <Markdown className="inline-md" text={i.text + (i.doc_id ? ` [[${i.doc_id}]]` : '') + (i.status === 'picked' && i.result ? ` · in [[${i.result}]]` : '')} />
              </span>
            </li>
          );
        })}
      </ul>
      {picked.size > 0 && (
        <div className="row">
          <button className="btn small primary" disabled={act.busy} onClick={() => void revise()}>
            Revise {picked.size === 1 ? 'this' : `these ${picked.size}`}
          </button>
        </div>
      )}
      {act.error && <p className="error-text small">{act.error}</p>}
    </div>
  );
}

/** Proposed new entries (Create, or a Revise's splits and gaps): Accept writes one as yours, Drop leaves it out. */
export function EntriesCard({ messageKey, s }: { messageKey: string; s: ProjectState }) {
  const pid = s.project.id;
  const { data, error } = useCard(messageKey.replace(/^m/, ''), pid);
  const act = useAction();
  if (error) return <div className="tl-card error-text small">{error}</div>;
  if (!data) return <div className="tl-card muted small">Loading proposed entries…</div>;
  return (
    <div className="tl-card spec-proposed">
      <span className="msg-meta">
        <b>{data.author_name || 'Director'}</b> · proposed {data.items.length === 1 ? 'an entry' : `${data.items.length} entries`} · {clock(data.created_at)}
      </span>
      {data.items.map((i) => {
        const e = i.entry!;
        const open = i.status === 'open';
        return (
          <section key={i.id} className={`spec-proposed-entry ${open ? '' : 'prop-dim'}`}>
            <span className="small muted">{e.section}</span>
            <b>{e.title}</b>
            <span className="small">{e.summary}</span>
            {e.body && (
              <details className="small">
                <summary>Text</summary>
                <Markdown text={e.body} />
              </details>
            )}
            {open ? (
              <div className="row wrap">
                <button className="btn small primary" disabled={act.busy} onClick={() => void act.run(() => api(`/api/spec-items/${i.id}/accept`, { method: 'POST' }))}>
                  <Icon name="check" size={16} /> Accept
                </button>
                <button className="btn small quiet" disabled={act.busy} onClick={() => void act.run(() => api(`/api/spec-items/${i.id}/drop`, { method: 'POST' }))}>
                  Drop
                </button>
              </div>
            ) : (
              <span className="small">
                <Tag tone={i.status === 'accepted' ? 'tone-applied' : ''}>{i.status === 'accepted' ? 'Accepted' : 'Dropped'}</Tag>
                {i.doc_id && <Markdown className="inline-md" text={` [[${i.doc_id}]]`} />}
              </span>
            )}
          </section>
        );
      })}
      {act.error && <p className="error-text small">{act.error}</p>}
    </div>
  );
}
