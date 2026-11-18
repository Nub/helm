import { useRef, useState } from 'react';
import { api } from './api';
import type { PinnedItem, PinnedProposal, ProposalRound, ProposalSummary, ProjectState } from './api';
import { useDragReorder } from './drag';
import { InboxCard } from './inbox';
import { PreviewBody } from './preview';
import { Icon, Markdown, href, useAction } from './ui';

/**
 * The pinned proposal at the very top of a task or discussion (server/pins.ts): the few options the director is
 * asking the user to look at, each at a useful size through the shared preview renderer, the question, and the
 * linked request's answer controls right under them, so choosing is one tap from the top of the page. On the phone
 * three or more options are a swipeable row of cards with position dots, two or fewer a stack; on desktop a grid.
 * Once the user has chosen, the chosen item stays and the rest collapse. Earlier rounds collapse below.
 */

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (ts: number) => {
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? time(ts) : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time(ts)}`;
};

/** The label's short key ("P1" of "P1: two lists and one box"), for "Chosen: P1". */
const short = (label: string) => {
  const head = label.split(/[:—–]/)[0].trim();
  return head.length <= 24 ? head : label.slice(0, 24) + '…';
};

function ItemBody({ it }: { it: PinnedItem }) {
  if (it.preview) return <PreviewBody p={it.preview} />;
  const a = it.attachment!;
  if (a.kind === 'image') {
    return (
      <div className="viewer-media viewer-image">
        <a href={a.url} target="_blank" rel="noreferrer">
          <img src={a.url} alt={a.name} />
        </a>
      </div>
    );
  }
  return (
    <a className="prop-file" href={a.url} target="_blank" rel="noreferrer">
      <Icon name="file" size={18} /> <span className="one-line">{a.name}</span>
    </a>
  );
}

function ItemCard({ it, pid, chosen }: { it: PinnedItem; pid: string; chosen?: boolean }) {
  return (
    <figure className={`prop-card ${chosen ? 'chosen' : ''}`} data-pin={it.pin_id}>
      <figcaption className="prop-label">
        {chosen && <Icon name="check" size={15} />}
        <strong>{it.label}</strong>
        <span className="spacer" />
        {it.preview && (
          <a className="small" href={href('p', pid, 'previews', it.preview.id)}>
            Open
          </a>
        )}
      </figcaption>
      <div className="prop-body">
        <ItemBody it={it} />
      </div>
    </figure>
  );
}

/** The cards: swipeable with dots on the phone when there are three or more, a stack otherwise, a grid on desktop. */
function Cards({ items, pid, chosenId }: { items: PinnedItem[]; pid: string; chosenId?: number | null }) {
  const row = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const swipe = items.length > 2;
  const onScroll = () => {
    const el = row.current;
    const first = el?.firstElementChild as HTMLElement | null;
    if (!el || !first) return;
    const step = first.offsetWidth + parseFloat(getComputedStyle(el).columnGap || '0');
    setAt(Math.max(0, Math.min(items.length - 1, Math.round(el.scrollLeft / step))));
  };
  const goTo = (i: number) => {
    const el = row.current;
    const card = el?.children[i] as HTMLElement | undefined;
    if (el && card) el.scrollTo({ left: card.offsetLeft - el.offsetLeft - parseFloat(getComputedStyle(el).paddingLeft || '0'), behavior: 'smooth' });
  };
  return (
    <>
      <div className={`prop-cards ${swipe ? 'swipe' : 'stack'} n${Math.min(items.length, 4)}`} ref={row} onScroll={swipe ? onScroll : undefined}>
        {items.map((it) => (
          <ItemCard key={it.pin_id} it={it} pid={pid} chosen={chosenId === it.pin_id} />
        ))}
      </div>
      {swipe && (
        <div className="prop-dots" role="tablist" aria-label="Proposals">
          {items.map((it, i) => (
            <button key={it.pin_id} role="tab" aria-selected={i === at} aria-label={it.label} className={i === at ? 'on' : ''} onClick={() => goTo(i)}>
              <span />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** The owner's controls: drag to reorder, rename, unpin. */
function Arrange({ taskId, items, onDone }: { taskId: string; items: PinnedItem[]; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [order, setOrder] = useState(items.map((i) => i.pin_id));
  const box = useRef<HTMLUListElement>(null);
  const toRef = useRef<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const ids = order.map(String);
  const { drag, gripProps, rowProps } = useDragReorder({
    onMove: (id, y) => {
      const rows = [...(box.current?.children ?? [])] as HTMLElement[];
      toRef.current = rows.filter((r, i) => ids[i] !== id && r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2 < y).length;
      setTo(toRef.current);
    },
    onDrop: (id) => {
      const dest = toRef.current;
      toRef.current = null;
      setTo(null);
      const from = ids.indexOf(id);
      if (dest === null || dest === from) return;
      const next = [...order];
      const [m] = next.splice(from, 1);
      next.splice(dest, 0, m);
      setOrder(next);
      void run(() => api(`/api/tasks/${taskId}/pins/order`, { body: { ids: next.map(String), round: items[0]?.round } }));
    },
  });
  const from = drag ? ids.indexOf(drag.id) : -1;
  const byId = new Map(items.map((i) => [i.pin_id, i]));
  return (
    <div className="prop-arrange">
      <ul className={`reorder ${drag ? 'is-dragging' : ''}`} ref={box}>
        {order.map((pinId, i) => {
          const it = byId.get(pinId);
          if (!it) return null;
          const shift = drag && to !== null && drag.id !== String(pinId) ? (from < i && i <= to ? -1 : to <= i && i < from ? 1 : 0) : 0;
          return (
            <li
              key={pinId}
              className={`prop-arrange-row ${drag?.id === String(pinId) ? 'dragging' : ''}`}
              {...rowProps(String(pinId))}
              style={{ transform: drag?.id === String(pinId) ? `translateY(${drag.dy}px)` : shift ? `translateY(calc(${shift} * (100% + 8px)))` : undefined }}
            >
              <button className="drag-handle" aria-label={`Drag to reorder ${it.label}`} {...gripProps(String(pinId))}>
                <svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true" fill="currentColor">
                  {[4, 10, 16].map((y) => [5, 11].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.6" />))}
                </svg>
              </button>
              <input
                className="input"
                defaultValue={it.label}
                aria-label={`Label of ${it.label}`}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  if (v && v !== it.label) void run(() => api(`/api/tasks/${taskId}/pins/${pinId}`, { method: 'PATCH', body: { label: v } }));
                }}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              <button className="btn small quiet" disabled={busy} onClick={() => void run(() => api(`/api/tasks/${taskId}/pins/${pinId}`, { method: 'DELETE' }))}>
                Unpin
              </button>
            </li>
          );
        })}
      </ul>
      <div className="row">
        <span className="muted small">Unpinning keeps the item in the history below.</span>
        <span className="spacer" />
        <button className="btn small" onClick={onDone}>
          Done
        </button>
      </div>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

/** An earlier round, collapsed: small thumbnails with labels and what was chosen. */
function EarlierRound({ r, pid }: { r: ProposalRound; pid: string }) {
  const chosen = r.choice ? r.items.find((i) => i.pin_id === r.choice!.pin_id) : undefined;
  return (
    <div className="prop-earlier-round">
      <span className="small">
        <b>Round {r.round}</b>
        {r.choice ? <> · chosen {chosen ? short(chosen.label) : `“${r.choice.text}”`} · {day(r.choice.at)}</> : r.request?.status === 'open' ? ' · not answered' : ''}
      </span>
      <div className="prop-mini">
        {r.items.map((it) => (
          <a key={it.pin_id} className={`prop-mini-item ${chosen?.pin_id === it.pin_id ? 'chosen' : ''}`} href={it.preview ? href('p', pid, 'previews', it.preview.id) : it.attachment!.url}>
            <Thumb url={thumbUrl(it)} kind={it.preview?.kind ?? it.attachment?.kind ?? ''} />
            <span className="small one-line">{it.label}</span>
          </a>
        ))}
      </div>
    </div>
  );
}

function thumbUrl(it: PinnedItem): string | null {
  if (it.attachment) return it.attachment.kind === 'image' ? it.attachment.url : null;
  const p = it.preview!;
  if (p.kind === 'image' && p.file) return `/artifacts/${p.file}`;
  try {
    if (p.kind === 'compare') return `/artifacts/${JSON.parse(p.content ?? '').after.file}`;
    if (p.kind === 'guide') {
      const s = JSON.parse(p.content ?? '').steps.find((x: { image: { file: string } | null }) => x.image);
      return s ? `/artifacts/${s.image.file}` : null;
    }
  } catch {}
  return null;
}

function Thumb({ url, kind }: { url: string | null; kind: string }) {
  return <span className="prop-thumb">{url ? <img src={url} alt="" loading="lazy" /> : <Icon name={kind === 'link' ? 'external' : 'previews'} size={16} />}</span>;
}

export function ProposalArea({ proposal, taskId, pid, s }: { proposal?: PinnedProposal | null; taskId: string; pid: string; s: ProjectState }) {
  const [arranging, setArranging] = useState(false);
  if (!proposal) return null;
  const { items, request, choice, question, earlier } = proposal;
  const chosen = choice?.pin_id != null ? items.find((i) => i.pin_id === choice.pin_id) : undefined;
  const others = chosen ? items.filter((i) => i !== chosen) : [];
  const shown = chosen ? [chosen] : items;
  const asker = request ? s.agents.find((a) => a.id === request.agent_id)?.name ?? request.agent_name : undefined;
  const waiting = request?.status === 'open';
  return (
    <section className={`card prop-area ${waiting ? 'waiting' : ''} ${choice ? 'decided' : ''}`} aria-label="Proposal">
      <header className="row prop-head">
        <h2 className="now-label">
          Proposal{proposal.round > 1 ? ` · round ${proposal.round}` : ''}
          {waiting && <span className="prop-waiting">decision waiting</span>}
        </h2>
        <span className="spacer" />
        {items.length > 0 && !arranging && (
          <button className="btn small quiet" onClick={() => setArranging(true)}>
            Arrange
          </button>
        )}
      </header>
      {choice && (
        <p className="prop-choice">
          <Icon name="check" size={16} /> <b>Chosen: {chosen ? short(chosen.label) : choice.text}</b> <span className="muted">· {day(choice.at)}</span>
        </p>
      )}
      {arranging ? (
        <Arrange taskId={taskId} items={items} onDone={() => setArranging(false)} />
      ) : (
        shown.length > 0 && <Cards items={shown} pid={pid} chosenId={chosen?.pin_id} />
      )}
      {!arranging && others.length > 0 && (
        <details className="prop-others">
          <summary>
            <Icon name="chevron" size={14} /> Other proposals ({others.length})
          </summary>
          <Cards items={others} pid={pid} />
        </details>
      )}
      {question && <div className="prop-question">{<Markdown text={question} />}</div>}
      {request && waiting && (
        <div className="prop-request" id={`req-${request.id}`}>
          <InboxCard item={request} agentName={asker} hidePreviews />
        </div>
      )}
      {request && request.status === 'dismissed' && <p className="muted small">The question was dismissed.</p>}
      {earlier.length > 0 && (
        <details className="prop-earlier">
          <summary>
            <Icon name="chevron" size={14} /> Earlier proposals ({earlier.length})
          </summary>
          {earlier.map((r) => (
            <EarlierRound key={r.round} r={r} pid={pid} />
          ))}
        </details>
      )}
    </section>
  );
}

/** On a list row: up to three thumbnails and "3 proposals · decision waiting" (or what was chosen). */
export function ProposalStrip({ p }: { p?: ProposalSummary | null }) {
  if (!p || (!p.count && !p.waiting)) return null;
  return (
    <span className="prop-strip small">
      {p.thumbs.length > 0 && (
        <span className="prop-strip-thumbs" aria-hidden="true">
          {p.thumbs.map((t, i) => (
            <Thumb key={i} url={t.url} kind={t.kind} />
          ))}
        </span>
      )}
      <span className={p.waiting ? 'prop-strip-waiting' : 'muted'}>
        {p.count > 0 && `${p.count} ${p.count === 1 ? 'proposal' : 'proposals'}`}
        {p.waiting ? `${p.count ? ' · ' : ''}decision waiting` : p.chosen ? ` · chosen ${short(p.chosen)}` : ''}
      </span>
    </span>
  );
}

/** What the thread needs to offer Pin to top: the task and which items are pinned now (item id → pin id). */
export type PinCtx = { taskId: string; pinned: Map<string, number>; linked: string | null };

export function pinCtx(taskId: string, proposal?: PinnedProposal | null): PinCtx {
  const pinned = new Map<string, number>();
  for (const r of proposal ? [proposal, ...proposal.earlier] : []) for (const i of r.items) if (!pinned.has(i.item_id)) pinned.set(i.item_id, i.pin_id);
  return { taskId, pinned, linked: linkedRequestId(proposal) };
}

/** "Pin to top" on a preview or attachment in the thread; "Pinned" with Unpin once it is. */
export function PinToggle({ ctx, itemId, kind }: { ctx: PinCtx; itemId: string; kind: 'preview' | 'attachment' }) {
  const { busy, error, run } = useAction();
  const pinId = ctx.pinned.get(itemId);
  return (
    <span className="pin-toggle">
      {pinId === undefined ? (
        <button className="btn small quiet" disabled={busy} onClick={() => void run(() => api(`/api/tasks/${ctx.taskId}/pins`, { body: kind === 'preview' ? { preview_id: itemId } : { attachment_id: itemId } }))}>
          <Icon name="pin" size={14} /> Pin to top
        </button>
      ) : (
        <button className="btn small quiet pinned" disabled={busy} onClick={() => void run(() => api(`/api/tasks/${ctx.taskId}/pins/${pinId}`, { method: 'DELETE' }))} title="Pinned at the top of the page. Tap to unpin.">
          <Icon name="pin" size={14} /> Pinned · Unpin
        </button>
      )}
      {error && <span className="error-text small">{error}</span>}
    </span>
  );
}

/** The linked request is answered from the proposal area; elsewhere on the page it would only repeat. */
export const linkedRequestId = (proposal?: PinnedProposal | null): string | null => (proposal?.request?.status === 'open' ? proposal.request.id : null);

