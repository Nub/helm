import { useEffect, useRef, useState } from 'react';
import { api, useLive } from './api';
import type { Discussion, InboxItem, Preview, ProjectState, Task } from './api';
import { AttachButton, AttachTray, useAttachDraft } from './attachments';
import { AnnotateButton, openAnnotator } from './annotate';
import { openViewer } from './viewer';
import { ACTION_CHOICES, KIND_LABEL, answerRequest, kindTone, wantsWhat } from './needs';
import { fileUrl, parseCompare, parseGuide } from './preview';
import { HandoffCard } from './handoff';
import { activeMs, duration } from './sessions';
import type { Period } from './sessions';
import { openChat } from './chat';
import type { ChatCtx } from './chat';
import { Icon, Markdown, PlainRefs, Tag, ago, href, useAction, useTick } from './ui';

/**
 * The project home: what needs the user, one large card at a time (requests, plans waiting for approval, tasks
 * stalled or saying they need the user with nothing filed), blocking first, then importance, then age. Swipe or
 * Skip to move on; answering advances. When nothing needs the user: "All clear", with what was done since the last
 * session and what is running now. On desktop the done and running summary sits beside the card.
 */

type Row = Task | Discussion;
type Card =
  | { key: string; kind: 'request'; r: InboxItem; row: Row | null; blocking: boolean; importance: number; at: number }
  | { key: string; kind: 'plan' | 'stalled' | 'unfiled'; row: Task; blocking: boolean; importance: number; at: number };

const OPEN_REQUEST = ['open'];

/** Everything needing the user, most urgent first. */
export function triageCards(s: ProjectState): Card[] {
  // Request holders: the standing "Requests from …" of agents with no task (server/requests.ts).
  const rows: Row[] = [...s.tasks, ...s.discussions.filter((d) => d.kind !== 'task'), ...(s.request_holders ?? [])];
  const cards: Card[] = [];
  const seen = new Set<string>();
  for (const row of rows)
    for (const r of row.requests ?? [])
      if (OPEN_REQUEST.includes(r.status) && !seen.has(r.id)) {
        seen.add(r.id);
        cards.push({ key: r.id, kind: 'request', r, row, blocking: !!r.blocking, importance: r.importance ?? 3, at: r.created_at });
      }
  // Requests on no task or discussion (older ones, or a structure change).
  for (const r of s.inbox)
    if (OPEN_REQUEST.includes(r.status) && !seen.has(r.id)) {
      seen.add(r.id);
      cards.push({ key: r.id, kind: 'request', r, row: null, blocking: !!r.blocking, importance: r.importance ?? 3, at: r.created_at });
    }
  for (const t of s.tasks) {
    if (t.state === 'planning' && !t.needs_response) cards.push({ key: `plan-${t.id}`, kind: 'plan', row: t, blocking: false, importance: t.importance, at: t.updated_at });
    else if (t.waiting_on_user_without_request) cards.push({ key: `unfiled-${t.id}`, kind: 'unfiled', row: t, blocking: false, importance: t.importance, at: t.summary_at ?? t.updated_at });
    else if (t.state === 'active' && t.stalled && !t.needs_response) cards.push({ key: `stalled-${t.id}`, kind: 'stalled', row: t, blocking: false, importance: t.importance, at: t.updated_at });
  }
  return cards.sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.importance - a.importance || a.at - b.at);
}

/** An image to show for a preview: the image itself, a comparison's after side, or a guide's first screenshot. */
export function previewImage(p: Preview | null | undefined): string | null {
  if (!p) return null;
  if (p.kind === 'image' && p.file) return fileUrl(p.file);
  const c = parseCompare(p);
  if (c?.after?.file) return fileUrl(c.after.file);
  const g = parseGuide(p)?.steps.find((x) => x.image)?.image;
  return g?.file ? fileUrl(g.file) : null;
}

const firstLines = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

const rowHref = (row: Row) => href('p', row.project_id, row.kind === 'discussion' ? 'discussions' : 'tasks', row.id);

export function ProjectHome({ s }: { s: ProjectState }) {
  useTick();
  // Answered here: hidden at once, before the project refetches (and shown again if sending failed).
  const [answeredKeys, setAnsweredKeys] = useState<string[]>([]);
  const cards = triageCards(s).filter((c) => !answeredKeys.includes(c.key));
  const [skipped, setSkipped] = useState<string[]>([]);
  const ordered = [...cards.filter((c) => !skipped.includes(c.key)), ...skipped.map((k) => cards.find((c) => c.key === k)).filter((c): c is Card => !!c)];
  const [current, setCurrent] = useState<string | null>(null);
  const lastIndex = useRef(0);
  let index = ordered.findIndex((c) => c.key === current);
  if (index < 0) index = Math.min(lastIndex.current, Math.max(0, ordered.length - 1));
  lastIndex.current = index;
  const card = ordered[index];
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  const move = (by: number) => {
    if (ordered.length < 2) return;
    setCurrent(ordered[(index + by + ordered.length) % ordered.length].key);
  };
  const skip = () => {
    if (!card) return;
    const next = ordered[(index + 1) % ordered.length];
    setSkipped((l) => [...l.filter((k) => k !== card.key), card.key]);
    setCurrent(next && next.key !== card.key ? next.key : null);
  };
  const answered = (key: string) => (what: string) => {
    setToast(what);
    if (what.startsWith('Not sent')) {
      setAnsweredKeys((l) => l.filter((k) => k !== key));
      setCurrent(key);
      return;
    }
    // The answered card leaves at once; the one after it takes its place.
    const next = ordered[index + 1] ?? (ordered[0]?.key !== key ? ordered[0] : undefined);
    setAnsweredKeys((l) => [...l, key]);
    setCurrent(next && next.key !== key ? next.key : null);
  };

  return (
    <div className={`home3 ${card ? 'has-cards' : 'all-clear'}`}>
      <h1 className="sr-only">{s.project.name}</h1>
      <div className="home3-main">
        <HandoffCard s={s} />
        {card ? (
          <>
            <TriageCard key={card.key} c={card} n={index + 1} of={ordered.length} s={s} onSkip={skip} onSwipe={move} onAnswered={answered(card.key)} />
          </>
        ) : (
          <AllClear s={s} />
        )}
      </div>
      {card && (
        <aside className="home3-side" aria-label="Done and running">
          <Summary s={s} />
        </aside>
      )}
      {toast && (
        <div className="home3-toast" role="status">
          <Icon name="check" size={18} /> <span className="one-line">{toast}</span>
        </div>
      )}
    </div>
  );
}

// ---------- one card ----------

function useSwipe(onSwipe: (by: number) => void) {
  const start = useRef<{ x: number; y: number; on: boolean } | null>(null);
  const [dx, setDx] = useState(0);
  return {
    dx,
    handlers: {
      onTouchStart: (e: React.TouchEvent) => {
        const t = e.touches[0];
        start.current = { x: t.clientX, y: t.clientY, on: false };
      },
      onTouchMove: (e: React.TouchEvent) => {
        const s = start.current;
        if (!s) return;
        const t = e.touches[0];
        const x = t.clientX - s.x;
        const y = t.clientY - s.y;
        // A horizontal drag moves the card; a vertical one is the page's scroll.
        if (!s.on && Math.abs(x) > 12 && Math.abs(x) > Math.abs(y) * 1.4) s.on = true;
        if (s.on) setDx(x);
      },
      onTouchEnd: () => {
        const s = start.current;
        start.current = null;
        if (s?.on && Math.abs(dx) > 70) onSwipe(dx < 0 ? 1 : -1);
        setDx(0);
      },
      onTouchCancel: () => {
        start.current = null;
        setDx(0);
      },
    },
  };
}

function TriageCard({ c, n, of, s, onSkip, onSwipe, onAnswered }: { c: Card; n: number; of: number; s: ProjectState; onSkip: () => void; onSwipe: (by: number) => void; onAnswered: (what: string) => void }) {
  const { dx, handlers } = useSwipe(onSwipe);
  const row = c.row;
  const pid = s.project.id;
  const director = s.agents.find((a) => !a.parent_id)?.name ?? 'Director';
  let tag: { label: string; tone: string };
  let who: string;
  let title: string;
  let why = '';
  let md = false;
  let shot: Preview | null = null;
  let chat: ChatCtx;
  if (c.kind === 'request') {
    tag = { label: KIND_LABEL[c.r.kind], tone: kindTone(c.r.kind) };
    who = c.r.agent_name ?? 'An agent';
    title = c.r.title;
    // A question or to-do is markdown: its numbered steps show as a list, not one run-on paragraph.
    why = c.r.kind === 'permission' ? '' : (c.r.body || c.r.payload.recommendation || '').trim();
    md = c.r.kind !== 'permission';
    shot = c.r.previews?.find((p) => previewImage(p)) ?? (previewImage(row?.thumb) ? row!.thumb : null);
    chat = { kind: 'request', id: c.r.id };
  } else {
    const t = c.row;
    tag = c.kind === 'plan' ? { label: 'Plan to approve', tone: 'tone-accent' } : c.kind === 'stalled' ? { label: 'Stalled', tone: 'tone-serious' } : { label: 'Says it needs you', tone: 'tone-serious' };
    who = c.kind === 'plan' ? director : t.driver?.name ?? director;
    title = t.title;
    why = c.kind === 'unfiled' ? `It says: ${t.unfiled_need ?? ''}. Nothing is filed for you to answer.` : c.kind === 'stalled' ? `Active, but nobody has worked on it for a while. ${firstLines(t.status_summary)}` : firstLines(t.status_summary || t.description);
    shot = previewImage(t.thumb) ? t.thumb : null;
    chat = { kind: 'task', id: t.id };
  }
  // The body often opens with the title again.
  const stem = title.replace(/[.…]+$/, '');
  if (stem.length > 12 && why.toLowerCase().startsWith(stem.toLowerCase()) && !why.slice(stem.length).startsWith('\n')) {
    // A title cut short ("…") may end mid-word: drop the rest of that word too.
    why = why.slice(stem.length).replace(/(\.\.\.|…)$/.test(title) ? /^\S*/ : /^/, '').replace(/^[\s.:;,…-]+/, '');
  }
  // A to-do's steps, under its text.
  const steps = c.kind === 'request' && c.r.kind === 'action' ? (c.r.payload.steps ?? '').trim() : '';
  const blocking = c.kind === 'request' && !!c.r.blocking;
  // Pinned proposals the request asks about (proposal.tsx): their thumbnails instead of one screenshot.
  const proposal = c.kind === 'request' && row?.proposal?.waiting && row.proposal.thumbs.length ? row.proposal : null;
  const permission = c.kind === 'request' && c.r.kind === 'permission' ? c.r : null;
  const danger = permission ? permission.payload.danger || permission.payload.triage?.passed || '' : '';
  const openHref = row ? (c.kind === 'request' ? href('p', pid, row.kind === 'discussion' ? 'discussions' : 'tasks', row.id, c.r.id) : rowHref(row)) : c.kind === 'request' && c.r.agent_id ? href('p', pid, 'agents', c.r.agent_id) : null;
  return (
    <article
      className={`card tri3 ${blocking ? 'blocking' : ''}`}
      aria-label={`${tag.label}: ${title}, ${n} of ${of}`}
      style={dx ? { transform: `translateX(${dx}px) rotate(${dx / 60}deg)`, transition: 'none' } : undefined}
      {...handlers}
    >
      <div className="tri3-top">
        <Tag tone={tag.tone}>{tag.label}</Tag>
        {blocking && <Tag tone="tone-warning">Blocking</Tag>}
        <span className="tri3-from one-line">
          {who} · {ago(c.at)}
        </span>
        <a className="tri3-of" href={href('p', pid, 'work', 'needs')} aria-label={`${n} of ${of}: see all`}>
          {n} of {of}
        </a>
      </div>
      {/* The middle shrinks and scrolls inside the card; the answers and the row under them are always in view. */}
      <div className="tri3-body">
        <h2 className="tri3-title">
          <PlainRefs text={title} />
        </h2>
        {row && c.kind === 'request' && row.title !== title && (
          <a className="tri3-in small" href={rowHref(row)}>
            {row.holder ? `From ${row.holder.agent_name}, which has no task · ${row.holder.context}` : `${row.kind === 'discussion' ? 'Discussion' : 'Task'}: ${row.title}`}
          </a>
        )}
        {danger && (
          <p className="tri3-danger">
            <span className="tri3-danger-k">Why it asks you</span> {danger}
          </p>
        )}
        {permission && (permission.payload.input || permission.line) && <pre className="tri3-cmd">{commandOf(permission)}</pre>}
        {proposal ? (
          <div className="tri3-props" role="group" aria-label={`${proposal.count} proposals`}>
            {proposal.thumbs.slice(0, 3).map((t, i, all) => (
              <button
                type="button"
                key={i}
                className="tri3-prop"
                onClick={() => {
                  const shown = all.filter((x) => x.url);
                  if (t.url) openViewer(shown.map((x) => ({ src: x.url!, label: x.label })), shown.indexOf(t));
                  else if (row) location.hash = rowHref(row);
                }}
                aria-label={`${t.label}, full screen`}
              >
                <span className="tri3-prop-img">{t.url ? <img src={t.url} alt="" loading="lazy" /> : <Icon name="previews" size={20} />}</span>
                <span className="tri3-prop-label one-line">{t.label}</span>
              </button>
            ))}
          </div>
        ) : (
          shot && <Shot p={shot} pid={pid} />
        )}
        {why && !md && (
          <p className="tri3-why">
            <PlainRefs text={why} />
          </p>
        )}
        {(why || steps) && md && <Markdown className="tri3-why" text={[why, steps].filter(Boolean).join('\n\n')} />}
      </div>
      <div className="tri3-acts">{c.kind === 'request' ? <RequestAnswers r={c.r} onAnswered={onAnswered} openHref={openHref} /> : <TaskCardActions c={c} onDone={onAnswered} />}</div>
      <div className="tri3-foot">
        <button className="btn quiet" onClick={onSkip} disabled={of < 2}>
          <Icon name="skip" size={16} /> Skip
        </button>
        <button className="btn quiet" onClick={() => openChat(chat)}>
          <Icon name="discuss" size={16} /> Ask
        </button>
        {openHref ? (
          <a className="btn quiet" href={openHref}>
            <Icon name="external" size={16} /> Open
          </a>
        ) : (
          <span />
        )}
      </div>
    </article>
  );
}

/** What a permission would run: the command itself for Bash, else the tool's input, as the request recorded it. */
function commandOf(r: InboxItem): string {
  try {
    const input = JSON.parse(r.payload.input ?? '');
    if (typeof input?.command === 'string') return input.command;
    if (typeof input?.file_path === 'string') return `${r.payload.toolName ?? ''} ${input.file_path}`.trim();
  } catch {}
  return r.line || r.payload.input || '';
}

/**
 * The preview on a card: the whole image fitted in a bounded box; a tall screenshot fills the width from its top
 * and fades out at the bottom. Tapping opens it in the shared zoomable viewer (viewer.tsx).
 */
function Shot({ p, pid }: { p: Preview; pid: string }) {
  const url = previewImage(p)!;
  const [tall, setTall] = useState(false);
  return (
    <button
      type="button"
      className={`tri3-shot ${tall ? 'tall' : ''}`}
      onClick={() => openViewer([{ src: url, label: p.title, actions: <AnnotateButton onClick={() => openAnnotator({ projectId: pid, source: { kind: 'preview', id: p.id, side: '' }, url, title: p.title })} /> }])}
      aria-label={`${p.title}, full screen`}
    >
      <img
        src={url}
        alt=""
        loading="lazy"
        onLoad={(e) => {
          const img = e.currentTarget;
          const box = img.parentElement!.getBoundingClientRect();
          setTall(img.naturalHeight / img.naturalWidth > (box.height || 160) / (box.width || 320));
        }}
      />
    </button>
  );
}

function TaskCardActions({ c, onDone }: { c: Extract<Card, { kind: 'plan' | 'stalled' | 'unfiled' }>; onDone: (what: string) => void }) {
  const { busy, error, run } = useAction();
  const t = c.row;
  return (
    <div className="req-answers">
      {c.kind === 'plan' && (
        <>
          <button className="btn primary wide" disabled={busy} onClick={async () => (await run(() => api(`/api/tasks/${t.id}/approve`, { method: 'POST', body: {} }))) && onDone(`Approved “${t.title}”`)}>
            <Icon name="check" size={17} /> Approve the plan
          </button>
          <a className="btn wide" href={href('p', t.project_id, 'tasks', t.id)}>
            Read the plan
          </a>
        </>
      )}
      {c.kind === 'unfiled' && (
        <button className="btn primary wide" disabled={busy} onClick={async () => (await run(() => api(`/api/tasks/${t.id}/ask-needs`, { body: {} }))) && onDone('Asked the director to file what it needs')}>
          Ask the director what it needs
        </button>
      )}
      {c.kind === 'stalled' && (
        <button className="btn primary wide" onClick={() => openChat({ kind: 'task', id: t.id })}>
          <Icon name="discuss" size={17} /> Ask the director about it
        </button>
      )}
      {error && <p className="error-text small wide">{error}</p>}
    </div>
  );
}

/**
 * A request's answer controls in a compact two-column grid: the main answer full width, the others side by side
 * (options: up to three stacked, more as a grid). On the home's card and at the top of the chat. Same call as
 * everywhere else (answerRequest), so answering here clears it in its thread too.
 */
export function RequestAnswers({ r, compact = false, onAnswered, openHref }: { r: InboxItem; compact?: boolean; onAnswered?: (what: string) => void; openHref?: string | null }) {
  const { busy, error, run } = useAction();
  const [other, setOther] = useState(false);
  const [text, setText] = useState('');
  const question = r.kind === 'question' || r.kind === 'action';
  const draft = useAttachDraft(question ? r.project_id : undefined, `request:${r.id}`);
  const files = draft.ready.map((a) => a.id);
  const hold = busy || draft.uploading;
  const answer = async (body: { choice?: string; text?: string }, said: string) => {
    const send = () => answerRequest(r.id, files.length ? { ...body, attachments: files } : body);
    // On the home card the next card comes up at once; the server can take a second (it wakes the agent).
    if (onAnswered) {
      onAnswered(`Answered “${said}”`);
      return send().then(
        () => draft.clear(),
        (err) => onAnswered(`Not sent: ${err.message}. The request is still open.`),
      );
    }
    if (await run(send)) draft.clear();
  };
  const wants = !!wantsWhat(r);
  const recommended = r.payload.recommendation ? r.options.findIndex((o) => r.payload.recommendation!.toLowerCase().startsWith(o.label.toLowerCase())) : -1;
  const btn = (label: string, cls: string, body: { choice?: string; text?: string }) => (
    <button key={label} className={`btn ${cls}`} disabled={hold} onClick={() => answer(body, label)}>
      {label}
    </button>
  );
  const stacked = r.options.length <= 3;
  return (
    <div className={`req-answers ${compact ? 'compact' : ''} ${r.options.length > 4 ? 'many' : ''}`}>
      {r.kind === 'permission' && (
        <>
          {btn('Allow once', 'primary wide', { choice: 'Allow' })}
          {r.payload.canAlways && btn('Always allow', '', { choice: 'Always allow' })}
          {btn('Deny', r.payload.canAlways ? 'danger' : 'danger wide', { choice: 'Deny' })}
        </>
      )}
      {r.kind === 'structure' && (
        <>
          {btn('Approve', 'primary wide', { choice: 'Approve' })}
          {btn('Deny', openHref ? 'danger' : 'danger wide', { choice: 'Deny' })}
          {openHref && (
            <a className="btn quiet" href={openHref}>
              Details
            </a>
          )}
        </>
      )}
      {r.kind === 'action' && (
        <>
          {btn(files.length ? `Done, send ${files.length > 1 ? `${files.length} files` : 'file'}` : 'Done', 'primary wide', { choice: 'Done' })}
          {btn(ACTION_CHOICES[1], '', { choice: ACTION_CHOICES[1] })}
        </>
      )}
      {r.kind === 'question' && (
        <>
          {wants && !files.length && (
            <AttachButton draft={draft} className="btn primary wide" label="Attach photos or files">
              <Icon name="clip" size={17} /> Attach {wantsWhat(r)}
            </AttachButton>
          )}
          {files.length > 0 && btn(`Send ${files.length > 1 ? `${files.length} files` : 'file'}`, 'primary wide', {})}
          {r.options.map((o, i) => btn(o.label, `${!wants && !files.length && (recommended >= 0 ? i === recommended : i === 0) ? 'primary' : ''} ${stacked ? 'wide' : ''}`, { choice: o.label }))}
        </>
      )}
      {question && draft.items.length > 0 && (
        <div className="wide">
          <AttachTray items={draft.items} onRemove={draft.drop} />
        </div>
      )}
      {question &&
        (other || (r.kind === 'question' && !r.options.length && !wants) ? (
          <div className="req-other wide">
            <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={r.kind === 'action' ? 'Add a note' : 'Your answer'} aria-label="Your answer" />
            <div className="req-other-row">
              <AttachButton draft={draft} className="icon-btn" label="Attach photos or files" />
              <button className="btn primary" disabled={hold || (!text.trim() && !files.length)} onClick={() => answer({ text: text.trim() }, text.trim().slice(0, 40) || 'files')}>
                <Icon name="send" size={16} /> Send
              </button>
            </div>
          </div>
        ) : (
          <button className={`btn quiet req-other-btn ${r.kind === 'action' ? '' : 'wide'}`} onClick={() => setOther(true)}>
            {r.kind === 'action' ? 'Add a note…' : 'Other answer…'}
          </button>
        ))}
      {error && <p className="error-text small wide">{error}</p>}
    </div>
  );
}

// ---------- when nothing needs the user ----------

const clockTime = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const when = (ts: number) => (new Date(ts).toDateString() === new Date().toDateString() ? clockTime(ts) : new Date(ts).toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));

/** Since when "done" counts: the end of the last session (so a new session shows what happened while away), else the start of this one. */
function useSince(s: ProjectState): { since: number; label: string } {
  const pid = s.project.id;
  const { data } = useLive<{ periods: Period[] }>(`/api/projects/${pid}/sessions?limit=6`, (m) => m.type === 'project' && m.projectId === pid);
  const p = s.presence;
  const lastEnded = data?.periods.find((x) => x.kind === 'session' && x.end != null);
  if (p?.state === 'away' && p.since) return { since: p.since, label: `since you left at ${when(p.since)}` };
  if (lastEnded?.end) return { since: lastEnded.end, label: `since your last session ended at ${when(lastEnded.end)}` };
  if (p?.since) return { since: p.since, label: 'this session' };
  return { since: Date.now() - 24 * 3600_000, label: 'in the last day' };
}

function Summary({ s }: { s: ProjectState }) {
  const { since, label } = useSince(s);
  const finished = s.tasks.filter((t) => t.state === 'done').sort((a, b) => (b.finished_at ?? b.updated_at) - (a.finished_at ?? a.updated_at));
  const recent = finished.filter((t) => (t.finished_at ?? t.updated_at) >= since);
  // Nothing new since then: the last few finished anyway, so the card still says where the project got to.
  const done = recent.length ? recent : finished.slice(0, 3);
  const running = s.tasks.filter((t) => t.state === 'active');
  return (
    <div className="home3-summary">
      <section>
        <h2 className="home3-h">
          Done <span className="muted">{recent.length ? label : 'most recently'}</span>
        </h2>
        {!recent.length && <p className="muted small">Nothing finished {label === 'this session' ? 'yet this session' : label}.</p>}
        {done.length > 0 && (
          <ul className="home3-list">
            {done.slice(0, 3).map((t) => (
              <li key={t.id}>
                <a href={href('p', t.project_id, 'tasks', t.id)}>
                  <span className="home3-thumb">{previewImage(t.thumb) ? <img src={previewImage(t.thumb)!} alt="" loading="lazy" /> : <Icon name="check" size={20} />}</span>
                  <span className="home3-txt">
                    <span className="home3-t">{t.title}</span>
                    <span className="home3-meta">
                      took {duration(activeMs(t))}
                      {t.finished_at ? ` · ${when(t.finished_at)}` : ''}
                    </span>
                  </span>
                </a>
              </li>
            ))}
            {done.length > 3 && (
              <li>
                <a className="home3-more" href={href('p', s.project.id, 'history')}>
                  and {done.length - 3} more <Icon name="chevron" size={14} />
                </a>
              </li>
            )}
          </ul>
        )}
      </section>
      <section>
        <h2 className="home3-h">
          Running now <span className="muted">{running.length || ''}</span>
        </h2>
        {running.length === 0 ? (
          <p className="muted small">Nothing is running.</p>
        ) : (
          <ul className="home3-list">
            {running.map((t) => {
              const step = t.driver?.checklist?.find((i) => i.state === 'doing')?.text ?? t.driver?.status_line ?? '';
              return (
                <li key={t.id}>
                  <a href={href('p', t.project_id, 'tasks', t.id)}>
                    <span className={`home3-thumb run ${t.driver?.status === 'working' ? 'working' : ''}`}>
                      <span className={`status-dot ${t.driver?.status === 'working' ? 'dot-working pulse' : ''}`} />
                    </span>
                    <span className="home3-txt">
                      <span className="home3-t">{t.title}</span>
                      <span className="home3-meta one-line">
                        {t.driver?.name ?? 'No driver'}
                        {step && ` · ${step}`}
                      </span>
                      <span className="home3-meta">{t.stalled ? 'stalled' : t.awaiting_review ? 'awaiting review' : `running ${duration(activeMs(t))}`}</span>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function AllClear({ s }: { s: ProjectState }) {
  const p = s.presence;
  // A new project: nothing to clear yet; the first thing is to tell the director what it is for.
  if (!s.tasks.length && !s.discussions.length && !s.docs.length) {
    return (
      <article className="card clear3 start3">
        <h2 className="clear3-title">What do you want from this project?</h2>
        <p className="muted">Tell the director the outcome you are after, any constraints, and what done looks like. It writes the Spec, builds the team and reports back.</p>
        <button className="btn primary big3" onClick={() => openChat({ kind: 'general' })}>
          <Icon name="discuss" size={18} /> Chat with the director
        </button>
      </article>
    );
  }
  return (
    <article className="card clear3">
      <div className="clear3-head">
        <span className="clear3-ok">
          <Icon name="check" size={24} />
        </span>
        <div>
          <h2>All clear</h2>
          <p className="muted small">
            Nothing needs you.{' '}
            {p?.state === 'session' ? `In session${p.since ? ` since ${when(p.since)}` : ''}.` : p?.state === 'away' ? `Away${p.since ? ` since ${when(p.since)}` : ''}; the director carries on.` : ''}
          </p>
        </div>
      </div>
      <Summary s={s} />
    </article>
  );
}
