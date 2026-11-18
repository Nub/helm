import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Clamp, Composer, Markdown, clock , PlainRefs } from './ui';
import { AttachmentList } from './attachments';
import type { Attachment } from './api';

/**
 * A conversation between the user and an agent, as shown in the Overview's
 * director panel and on a task page: the user's messages, the agent's
 * replies, short system rows, anything else inline, a live "working" row
 * and a composer docked underneath.
 */
export type ThreadLine =
  | { type: 'you'; key: string; ts: number; text: string; filed?: { title: string; href: string }[]; note?: string; attachments?: Attachment[]; attachmentAction?: (a: Attachment) => ReactNode; about?: { kind: string; id: string; title: string } }
  | { type: 'reply'; key: string; ts: number; text: string; name: string; ok?: boolean; note?: string }
  | { type: 'system'; key: string; ts: number; text: string; tone?: '' | 'error'; href?: string }
  | { type: 'node'; key: string; ts: number; node: ReactNode };

export function Thread({
  label,
  head,
  lines,
  loaded,
  top,
  after,
  empty,
  working,
  waiting,
  placeholder,
  onSend,
  attachTo,
  className = '',
  composer = true,
  dock,
}: {
  label: string;
  head: ReactNode;
  lines: ThreadLine[];
  loaded: boolean;
  /** Above the first line: "Show earlier" and the like. */
  top?: ReactNode;
  /** After the last line, outside the scroll anchoring: a pointer to what happened elsewhere. */
  after?: ReactNode;
  /** Shown instead of lines when there are none. */
  empty?: ReactNode;
  /** The agent is working: its name and status line. */
  working?: { name: string; line?: string } | null;
  /** The agent waits on the user; the text says where. */
  waiting?: string | null;
  placeholder: string;
  onSend: (text: string, attachments: string[]) => Promise<unknown>;
  /** A project id: the composer then takes files (see Composer). */
  attachTo?: string;
  className?: string;
  /** Off where the page docks its own composer. */
  composer?: boolean;
  /** A composer of the caller's own in place of the standard one (the chat sheet's), given the thread's send. */
  dock?: (send: (text: string, attachments: string[]) => Promise<unknown>) => ReactNode;
}) {
  const [pending, setPending] = useState<{ text: string; seen: number; files: number } | null>(null);
  const [behind, setBehind] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const jump = useRef<HTMLButtonElement>(null);
  const newestReply = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // The sent message has come back as a line: drop the optimistic copy.
  const count = (text: string) => lines.filter((l) => l.type === 'you' && l.text === text).length;
  const delivered = !!pending && count(pending.text) > pending.seen;
  useEffect(() => {
    if (delivered) setPending(null);
  }, [delivered]);

  const busy = !!working || (!!pending && !delivered);
  const last = lines[lines.length - 1];
  const newestReplyKey = [...lines].reverse().find((l) => l.type === 'reply')?.key;
  const lastKey = last?.key ?? '';

  // Start at the newest exchange. A long newest reply is shown from its top, not its end.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !loaded) return;
    if (!pinned.current) {
      setBehind(true);
      return;
    }
    const r = newestReply.current;
    if (last?.type === 'reply' && !busy && r && r.offsetHeight > el.clientHeight * 0.7) {
      // Keep the message it answers in view above it when that fits.
      const asked = r.previousElementSibling as HTMLElement | null;
      const top = asked?.classList.contains('msg-you') && asked.offsetHeight < el.clientHeight * 0.3 ? asked.offsetTop : r.offsetTop;
      el.scrollTop = top - 12;
    } else el.scrollTop = el.scrollHeight;
  }, [loaded, lastKey, busy, !!waiting, !!pending]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // A reader scrolled up into history is not dragged back down by new output.
    pinned.current = atEnd || (last?.type === 'reply' && !!newestReply.current && el.scrollTop >= newestReply.current.offsetTop - 40);
    if (atEnd) setBehind(false);
  };
  // "Newest" sits at the bottom of the visible part of the thread. Where the page scrolls the panel partly under its
  // fixed bars (the docked chat bar, the tab bar) or the keyboard, it is lifted to stay above them, within the panel.
  useEffect(() => {
    if (!behind) return;
    const place = () => {
      const w = body.current;
      const j = jump.current;
      if (!w || !j) return;
      const r = w.getBoundingClientRect();
      const vv = window.visualViewport;
      let limit = vv ? vv.offsetTop + vv.height : innerHeight;
      if (!w.closest('.sheet')) {
        for (const el of document.querySelectorAll<HTMLElement>('.chat-dock, .tabs')) {
          if (getComputedStyle(el).position !== 'fixed') continue;
          const b = el.getBoundingClientRect();
          if (b.height > 0 && b.left < r.right && b.right > r.left && b.top < limit && b.bottom > r.top) limit = b.top;
        }
      }
      const lift = Math.min(Math.max(0, r.bottom - limit), Math.max(0, r.height - j.offsetHeight - 20));
      j.style.setProperty('--lift', `${Math.round(lift)}px`);
    };
    place();
    const vv = window.visualViewport;
    addEventListener('scroll', place, { passive: true });
    addEventListener('resize', place);
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    return () => {
      removeEventListener('scroll', place);
      removeEventListener('resize', place);
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
    };
  }, [behind]);
  const toEnd = () => {
    pinned.current = true;
    setBehind(false);
    box.current?.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' });
  };

  const send = async (text: string, attachments: string[]) => {
    pinned.current = true;
    setPending({ text, seen: count(text), files: attachments.length });
    try {
      await onSend(text, attachments);
    } catch (err) {
      setPending(null);
      throw err;
    }
  };

  const isEmpty = loaded && lines.length === 0 && !pending && !busy;

  return (
    <section className={`card convo ${className}`} aria-label={label}>
      {head && <header className="convo-head">{head}</header>}

      {/* The thread's own scroll box, and the box "Newest" is placed in: the visible thread, not the panel. */}
      <div className="convo-body" ref={body}>
        <div className="convo-thread" ref={box} onScroll={onScroll}>
          {!loaded && <div className="loading">Loading…</div>}
          {top}
          {isEmpty && empty}
          {lines.map((l) => {
            if (l.type === 'you') {
              return (
                <div key={l.key} data-key={l.key} className="msg msg-you">
                  <span className="msg-meta">
                    You · {clock(l.ts)}
                    {l.note && <span className="msg-after"> · {l.note}</span>}
                  </span>
                  {/* Image feedback: the card under it shows the comment and notes; the text is what the agent reads. */}
                  {l.text && !l.attachments?.some((a) => a.annotation?.role === 'marked') && <Clamp text={l.text} lines={8} />}
                  {l.attachments && <AttachmentList items={l.attachments} className="msg-atts" action={l.attachmentAction} />}
                  {l.about && (
                    <span className="msg-about small">
                      About the {l.about.kind === 'doc' ? 'Spec entry' : l.about.kind} <b>{l.about.title}</b>
                    </span>
                  )}
                  {l.filed?.map((f) => (
                    <a key={f.href} className="msg-filed" href={f.href}>
                      Filed under <b>{f.title}</b>
                    </a>
                  ))}
                </div>
              );
            }
            if (l.type === 'reply') {
              const newest = l.key === newestReplyKey;
              return (
                <div key={l.key} data-key={l.key} ref={newest ? newestReply : undefined} className={`msg msg-reply ${l.ok === false ? 'failed' : ''} ${newest ? 'newest' : ''}`}>
                  <span className="msg-meta">
                    <b>{l.name}</b> · {clock(l.ts)}
                    {l.note && <span className="msg-after"> · {l.note}</span>}
                  </span>
                  <Clamp text={l.text} lines={9} initiallyOpen={newest} />
                </div>
              );
            }
            if (l.type === 'system') return <SystemLine key={l.key} dataKey={l.key} text={l.text} ts={l.ts} tone={l.tone ?? ''} href={l.href} />;
            return (
              <div key={l.key} data-key={l.key} className="msg-node">
                {l.node}
              </div>
            );
          })}
          {after}
          {pending && !delivered && (
            <div className="msg msg-you sending">
              <span className="msg-meta">You · sending…</span>
              {pending.text && <Markdown text={pending.text} />}
              {pending.files > 0 && <p className="small">{pending.files} {pending.files === 1 ? 'attachment' : 'attachments'}</p>}
            </div>
          )}
          {busy && (
            <div className="msg-working" role="status">
              <span className="status-dot pulse" />
              <span>
                <b>{working?.name ?? 'Director'}</b> is working
                {working?.line && <span className="msg-working-line"><PlainRefs text={working.line} /></span>}
              </span>
            </div>
          )}
          {waiting && !busy && (
            <div className="msg-working waiting" role="status">
              <span className="status-dot" />
              <span>{waiting}</span>
            </div>
          )}
        </div>
        {behind && (
          <button ref={jump} className="convo-jump btn small" onClick={toEnd}>
            Newest ↓
          </button>
        )}
      </div>

      {dock && <div className="convo-dock">{dock(send)}</div>}
      {composer && !dock && (
        <div className="convo-dock">
          <Composer placeholder={isEmpty && empty ? `${placeholder}…` : placeholder} onSend={send} attachTo={attachTo} />
        </div>
      )}
    </section>
  );
}

/** Time of day for today's rows, the date otherwise: system rows stay one glance wide. */
const shortTime = (ts: number) =>
  new Date(ts).toDateString() === new Date().toDateString() ? new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function SystemLine({ text, ts, tone, href, dataKey }: { text: string; ts: number; tone: string; href?: string; dataKey?: string }) {
  const [open, setOpen] = useState(false);
  if (href) {
    return (
      <a className={`msg-system ${tone}`} href={href} data-key={dataKey}>
        <span className="clamp" style={{ ['--lines' as any]: 2 }}>
          {text}
        </span>
        <time title={clock(ts)}>{shortTime(ts)}</time>
      </a>
    );
  }
  return (
    <button data-key={dataKey} className={`msg-system ${tone} ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open}>
      <span className={open ? '' : 'clamp'} style={{ ['--lines' as any]: 2 }}>
        {text}
      </span>
      <time title={clock(ts)}>{shortTime(ts)}</time>
    </button>
  );
}
