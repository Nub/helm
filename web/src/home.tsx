import { useCallback, useEffect, useRef, useState } from 'react';
import { lazyNamed, loadDashboards } from './lazy';
const PinnedTiles = lazyNamed<{ s: import('./api').ProjectState }>(loadDashboards, 'PinnedTiles');
import { api, useLive } from './api';
import type { Discussion, InboxItem, Preview, ProjectState, Task } from './api';
import { AttachButton, AttachTray, useAttachDraft } from './attachments';
import { useStoredText } from './drafts';
import { AnnotateButton, openAnnotator } from './annotate';
import { openViewer } from './viewer';
import { ACTION_CHOICES, actOf, ErrorDetails, KIND_LABEL, LimitAll, answerRequest, appliesToAll, errorChoices, kindTone, wantsWhat } from './needs';
import { PreviewThumb, hasThumb, previewImage } from './preview';
export { previewImage };
import { HandoffCard } from './handoff';
import { duration, workText } from './sessions';
import type { Period } from './sessions';
import { openChat } from './chat';
import { InboxCard } from './inbox';
import type { ChatCtx } from './chat';
import { EdgeProgress, Icon, Markdown, PlainRefs, Tag, href, openPreview, useAction, useTick } from './ui';
import { when } from './time';
import { RunningTaskCard } from './tasks';
import { SearchBox, SearchResults, openHomeSearch, useHomeSearchFocus, useSearchState } from './search';
import type { SearchBoxHandle } from './search';
import { ModeBanner } from './projectmode';
import { PlanLine } from './plan';
import { History } from './more';
import { Fold, jumpTo, openFold } from './fold';

/**
 * The project home: what needs the user, one large card at a time (requests, plans waiting for approval, tasks
 * stalled or saying they need the user with nothing filed), blocking first, then importance, then age. Swipe or
 * Skip to move on; answering advances. When nothing needs the user: "All clear", with what was done since the last
 * session and what is running now. On desktop the done and running summary sits beside the card.
 *
 * Above them, the project's search (search.tsx): a slim field, the card a little shorter for it. On a short phone with a
 * card showing it folds into the top bar's Search (main.tsx), so the card keeps its answers above the docked bars;
 * while the search is open, its results take the place of the cards.
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

const firstLines = (text: string) =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

const rowHref = (row: Row) => href('p', row.project_id, row.kind === 'discussion' ? 'discussions' : 'tasks', row.id);

/** `journal`: opened at #/p/<id>/overview/journal[/<entry or period>] (the old History page's links). */
export function ProjectHome({ s, journal }: { s: ProjectState; journal?: string }) {
  useTick();
  useEffect(() => {
    // With an entry or period the section scrolls to it itself (more.tsx History); else to the section.
    if (journal) openFold('home-journal');
    else if (journal !== undefined) jumpTo('#home-journal', { fold: 'home-journal' });
  }, [journal]);
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

  // Nothing waiting on the user in a project with work: the running tasks in detail where a card would be.
  const calm = !card && !!(s.tasks.length || s.discussions.length || s.docs.length);
  const [search, setSearch] = useSearchState(s.project.id, 'home');
  const box = useRef<SearchBoxHandle>(null);
  const openSearch = useCallback(() => openHomeSearch(setSearch, box.current), []);
  useHomeSearchFocus(openSearch);

  return (
    <div className={`home3 ${search.open ? 'searching' : card ? 'has-cards' : calm ? 'calm' : 'all-clear'}`}>
      <h1 className="sr-only">{s.project.name}</h1>
      <SearchBox ref={box} st={search} set={setSearch} />
      {search.open ? (
        <SearchResults s={s} st={search} set={setSearch} />
      ) : (
        <>
          <div className="home3-main">
            <ModeBanner s={s} />
            <HandoffCard s={s} />
            <Digest s={s} needs={cards.length} />
            <CrossThreads s={s} />
            {card ? (
              <>
                {card.kind === 'request' ? (
                  <HomeRequest key={card.key} c={card} n={index + 1} of={ordered.length} s={s} onMove={move} onGo={(i) => setCurrent(ordered[i]?.key ?? null)} onAnswered={answered(card.key)} />
                ) : (
                  <TriageCard key={card.key} c={card} n={index + 1} of={ordered.length} s={s} onSkip={skip} onSwipe={move} onAnswered={answered(card.key)} />
                )}
              </>
            ) : calm ? (
              <>
                {/* On a phone the session line and Step away lead; on desktop they are in the side column. */}
                <div className="sess3 calm-sess">
                  <SessionLine s={s} />
                  <StepAway s={s} />
                </div>
                <RunningNow s={s} />
              </>
            ) : (
              <AllClear s={s} />
            )}
            {/* Below the card (never pushing its answers under the bars) or All clear: tiles pinned from a dashboard. */}
            <PinnedTiles s={s} />
            <PlanLine />
          </div>
          {(card || calm) && (
            <aside className="home3-side" aria-label="Done and running">
              <Summary s={s} />
              <div className="sess3">
                <SessionLine s={s} />
                <StepAway s={s} />
              </div>
            </aside>
          )}
          {/* The project's journal (and its sessions), collapsed at the bottom: what the History page was. */}
          <div id="home-journal" className="home3-journal">
            <Fold kind="home-journal" title="Journal" openByDefault={false} className="flat-fold">
              <History s={s} focus={journal || undefined} />
            </Fold>
          </div>
        </>
      )}
      {toast && (
        <div className="home3-toast" role="status">
          <Icon name="check" size={20} /> <span className="one-line">{toast}</span>
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

/** The dots a pager shows: all of them up to MAX_DOTS, else a window around the current one whose edge dots shrink. */
const MAX_DOTS = 7;
export function pagerDots(n: number, of: number): { index: number; small: boolean }[] {
  if (of <= MAX_DOTS) return Array.from({ length: of }, (_, index) => ({ index, small: false }));
  const start = Math.min(Math.max(0, n - 1 - Math.floor(MAX_DOTS / 2)), of - MAX_DOTS);
  return Array.from({ length: MAX_DOTS }, (_, i) => {
    const index = start + i;
    return { index, small: (i === 0 && start > 0) || (i === MAX_DOTS - 1 && start + MAX_DOTS < of) };
  });
}

/** A carousel pager under the card: ‹, a dot per request (the current one elongated, tappable), ›. Arrow keys on desktop. */
function Pager({ n, of, onMove, onGo }: { n: number; of: number; onMove: (by: number) => void; onGo: (index: number) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || t?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      if (e.key === 'ArrowLeft') onMove(-1);
      else if (e.key === 'ArrowRight') onMove(1);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [onMove]);
  return (
    <nav className="pager" aria-label={`Request ${n} of ${of}`}>
      <button className="pager-arrow" onClick={() => onMove(-1)} aria-label="Previous request">
        <Icon name="chevron" size={20} />
      </button>
      <span className="pager-dots">
        {pagerDots(n, of).map((d) => (
          <button key={d.index} className={`pager-dot ${d.index === n - 1 ? 'on' : ''} ${d.small ? 'small' : ''}`} onClick={() => onGo(d.index)} aria-label={`Request ${d.index + 1} of ${of}`} aria-current={d.index === n - 1 ? 'true' : undefined}>
            <span />
          </button>
        ))}
      </span>
      <button className="pager-arrow next" onClick={() => onMove(1)} aria-label="Next request">
        <Icon name="chevron" size={20} />
      </button>
    </nav>
  );
}

/**
 * A request on Home: its one full card (inbox.tsx), as on Needs you and in its thread, never cut down (Open, Ask and
 * Dismiss are in it); under it a pager through the waiting requests. Answering moves on to the next card.
 */
function HomeRequest({ c, n, of, s, onMove, onGo, onAnswered }: { c: Extract<Card, { kind: 'request' }>; n: number; of: number; s: ProjectState; onMove: (by: number) => void; onGo: (index: number) => void; onAnswered: (what: string) => void }) {
  const { dx, handlers } = useSwipe(onMove);
  const row = c.row;
  const pid = s.project.id;
  const item = row ? { ...c.r, task_title: c.r.task_title ?? (row.holder ? null : row.title), task_kind: c.r.task_kind ?? (row.kind === 'discussion' ? 'discussion' : 'task') } : c.r;
  const openHref = row ? href('p', pid, row.kind === 'discussion' ? 'discussions' : 'tasks', row.id, c.r.id) : c.r.agent_id ? href('p', pid, 'agents', c.r.agent_id) : null;
  return (
    <div className="home-req" style={dx ? { transform: `translateX(${dx}px)`, transition: 'none' } : undefined} {...handlers}>
      <InboxCard item={item} onAnswered={onAnswered} openHref={openHref} />
      {of > 1 && <Pager n={n} of={of} onMove={onMove} onGo={onGo} />}
    </div>
  );
}

/** A task that needs the user without a request filed: a plan to approve, a stalled task, a need nobody filed. */
function TriageCard({ c, n, of, s, onSkip, onSwipe, onAnswered }: { c: Extract<Card, { kind: 'plan' | 'stalled' | 'unfiled' }>; n: number; of: number; s: ProjectState; onSkip: () => void; onSwipe: (by: number) => void; onAnswered: (what: string) => void }) {
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
  {
    const t = c.row;
    tag = c.kind === 'plan' ? { label: 'Plan to approve', tone: 'tone-accent' } : c.kind === 'stalled' ? { label: 'Stalled', tone: 'tone-serious' } : { label: 'Says it needs you', tone: 'tone-serious' };
    who = c.kind === 'plan' ? director : t.driver?.name ?? director;
    title = t.title;
    why = c.kind === 'unfiled' ? `It says: ${t.unfiled_need ?? ''}. Nothing is filed for you to answer.` : c.kind === 'stalled' ? `Active, but nobody has worked on it for a while. ${firstLines(t.status_summary)}` : firstLines(t.status_summary || t.description);
    shot = hasThumb(t.thumb) ? t.thumb : null;
    chat = { kind: 'task', id: t.id };
  }
  // The body often opens with the title again.
  const stem = title.replace(/[.…]+$/, '');
  if (stem.length > 12 && why.toLowerCase().startsWith(stem.toLowerCase()) && !why.slice(stem.length).startsWith('\n')) {
    // A title cut short ("…") may end mid-word: drop the rest of that word too.
    why = why.slice(stem.length).replace(/(\.\.\.|…)$/.test(title) ? /^\S*/ : /^/, '').replace(/^[\s.:;,…-]+/, '');
  }
  const blocking = false;
  const openHref = rowHref(row);
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
        <span className="tri3-from one-line">{who}</span>
        {of > 1 && (
          <a className="tri3-of" href={href('p', pid, 'work', 'needs')} aria-label={`${n} of ${of}: see all`}>
            {n} of {of}
          </a>
        )}
      </div>
      {/* The middle shrinks and scrolls inside the card; the answers and the row under them are always in view. */}
      <div className="tri3-body">
        <h2 className="tri3-title">
          <PlainRefs text={title} />
        </h2>
        {shot && <Shot p={shot} pid={pid} />}
        {why && !md && (
          <p className="tri3-why">
            <PlainRefs text={why} />
          </p>
        )}
        {why && md && <Markdown className="tri3-why" text={why} />}
      </div>
      <div className="tri3-acts">
        <TaskCardActions c={c} onDone={onAnswered} />
      </div>
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

/**
 * The preview on a card: the whole image fitted in a bounded box; a tall screenshot fills the width from its top
 * and fades out at the bottom. Tapping opens it in the shared zoomable viewer (viewer.tsx).
 */
function Shot({ p, pid }: { p: Preview; pid: string }) {
  const url = previewImage(p);
  const [tall, setTall] = useState(false);
  // A chart or a text preview: its thumbnail, opening the preview.
  if (!url) return (
    <button type="button" className="tri3-shot" onClick={() => openPreview(pid, p.id)} aria-label={`Open ${p.title}`}>
      <PreviewThumb p={p} />
    </button>
  );
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
            <Icon name="check" size={16} /> Approve the plan
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
          <Icon name="discuss" size={16} /> Ask the director about it
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
  // What is typed and the files attached are kept per request until it is answered (drafts.ts; shared with its card).
  const draftKey = `request:${r.id}`;
  const [text, setText] = useStoredText(draftKey);
  const [other, setOther] = useState(() => !!text.trim());
  const [all, setAll] = useState(true);
  const question = r.kind === 'question' || r.kind === 'action';
  const draft = useAttachDraft(question ? r.project_id : undefined, `request:${r.id}`, draftKey);
  const files = draft.ready.map((a) => a.id);
  const hold = busy || draft.uploading;
  const answer = async (body: { choice?: string; text?: string; all?: boolean; perform?: boolean }, said: string) => {
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
  // A request's inline action (Approve, Update now…): its own button leads, or the option it rides on is the main one.
  const act = actOf(r);
  const recommended = act?.option ? r.options.findIndex((o) => o.label === act.option) : act?.button ? -2 : r.payload.recommendation ? r.options.findIndex((o) => r.payload.recommendation!.toLowerCase().startsWith(o.label.toLowerCase())) : -1;
  const btn = (label: string, cls: string, body: { choice?: string; text?: string; perform?: boolean }) => (
    <button key={label} className={`btn ${cls}`} disabled={hold} onClick={() => answer(body, label)}>
      {label}
    </button>
  );
  const stacked = r.options.length <= 3;
  return (
    <div className={`req-answers ${compact ? 'compact' : ''} ${r.options.length > 4 ? 'many' : ''}`}>
      {act?.button && btn(act.button, 'primary wide', { perform: true })}
      {r.kind === 'permission' && (
        <>
          {btn('Allow once', 'primary wide', { choice: 'Allow' })}
          {r.payload.canAlways && btn('Always allow', '', { choice: 'Always allow' })}
          {btn('Deny', r.payload.canAlways ? 'danger' : 'danger wide', { choice: 'Deny' })}
        </>
      )}
      {r.kind === 'agent_error' &&
        errorChoices(r).map((c, i) =>
          c === 'Close the agent' ? (
            <button key={c} className="btn quiet" disabled={hold} onClick={() => confirm(`Close ${r.agent_name ?? 'this agent'}? Its history stays.`) && answer({ choice: c }, c)}>
              {c}
            </button>
          ) : (
            btn(c, i === 0 ? 'primary wide' : appliesToAll(c) ? 'wide' : '', { choice: c, ...(appliesToAll(c) && all && (r.payload.limit_peers ?? 0) > 1 ? { all: true } : {}) })
          ),
        )}
      {r.kind === 'agent_error' && (
        <div className="wide">
          <LimitAll r={r} all={all} setAll={setAll} />
        </div>
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
          {btn(files.length ? `Done, send ${files.length > 1 ? `${files.length} files` : 'file'}` : 'Done', act ? '' : 'primary wide', { choice: 'Done' })}
          {btn(ACTION_CHOICES[1], '', { choice: ACTION_CHOICES[1] })}
        </>
      )}
      {r.kind === 'question' && (
        <>
          {wants && !files.length && (
            <AttachButton draft={draft} className="btn primary wide" label="Attach photos or files">
              <Icon name="clip" size={16} /> Attach {wantsWhat(r)}
            </AttachButton>
          )}
          {files.length > 0 && btn(`Send ${files.length > 1 ? `${files.length} files` : 'file'}`, 'primary wide', {})}
          {r.options.map((o, i) => btn(o.label, `${!wants && !files.length && (recommended !== -1 ? i === recommended : i === 0) ? 'primary' : ''} ${stacked ? 'wide' : ''}`, { choice: o.label }))}
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
          <button className={`btn quiet ${r.kind === 'action' ? '' : 'wide'}`} onClick={() => setOther(true)}>
            {r.kind === 'action' ? 'Add a note…' : 'Other answer…'}
          </button>
        ))}
      {error && <p className="error-text small wide">{error}</p>}
    </div>
  );
}

// ---------- when nothing needs the user ----------


/** Home's digest (server/digest.ts): since when, the tasks finished and the releases failed since then. */
type DigestData = { since: number; finished: { id: string; title: string; finished_at: number }[]; failed: { kind: 'release'; id: string; title: string; at: number }[] };

function useSessions(s: ProjectState) {
  const pid = s.project.id;
  return useLive<{ periods: Period[]; digest?: DigestData }>(`/api/projects/${pid}/sessions?limit=6`, (m) => m.type === 'project' && m.projectId === pid).data;
}
const usePeriods = (s: ProjectState): Period[] | undefined => useSessions(s)?.periods;

/**
 * "Since you were last here", at the top of Home: one line with what failed, what needs the user, what finished and
 * what is running. The finished tasks themselves are Done (Summary), with their previews.
 */
function Digest({ s, needs }: { s: ProjectState; needs: number }) {
  const d = useSessions(s)?.digest;
  if (!d) return null;
  const running = s.tasks.filter((t) => t.state === 'active').length;
  // Agents stopped with an error now, and releases that failed since then.
  const failed = s.agents.filter((a) => a.status === 'error').length + d.failed.length;
  return (
    <section className="digest" aria-label="Since you were last here">
      <div className="digest-head">
        <span className="digest-since">Since {when(d.since)}</span>
        <span className="digest-counts muted small">
          {failed > 0 && <span className="err-text">{failed} failed</span>}
          {needs > 0 && <span className="digest-needs">{needs} {needs === 1 ? 'needs' : 'need'} you</span>}
          {d.finished.length > 0 && <span>{d.finished.length} done</span>}
          {running > 0 && <span>{running} running</span>}
          {!d.finished.length && !running && !needs && !failed && <span>quiet</span>}
        </span>
      </div>
    </section>
  );
}

/** Threads with other projects' directors holding a reply not opened yet: one quiet line each (server/crossproject.ts). */
function CrossThreads({ s }: { s: ProjectState }) {
  const list = s.xthreads ?? [];
  if (!list.length) return null;
  return (
    <ul className="xthreads" aria-label="Replies from other projects">
      {list.map((t) => (
        <li key={t.id}>
          <a className="muted small" href={href('p', s.project.id, 'discussions', t.id)}>
            <Icon name="discuss" size={14} /> <span className="one-line">{t.peer} replied: {t.title}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** The session or away period going on now, as one muted line that opens it in History. */
function SessionLine({ s }: { s: ProjectState }) {
  const periods = usePeriods(s);
  const now = periods?.find((x) => x.end == null);
  if (!now) return null;
  // What happened is the digest's (Digest, at the top of Home); this line is only the session itself.
  const text = [`${now.kind === 'session' ? 'Session' : 'Away'} since ${when(now.start)}`, duration(Date.now() - now.start)].join(' · ');
  return (
    <a className="sess3-line muted small" href={href('p', s.project.id, 'overview', 'journal', now.id)} title="Open in the journal">
      <span className="one-line">{text}</span>
    </a>
  );
}

/** Since when "done" counts: the end of the last session (so a new session shows what happened while away), else the start of this one. */
function useSince(s: ProjectState): { since: number; label: string } {
  const periods = usePeriods(s);
  const data = periods && { periods };
  const p = s.presence;
  const lastEnded = data?.periods.find((x) => x.kind === 'session' && x.end != null);
  if (p?.state === 'away' && p.since) return { since: p.since, label: `since ${when(p.since)}` };
  if (lastEnded?.end) return { since: lastEnded.end, label: `since ${when(lastEnded.end)}` };
  if (p?.since) return { since: p.since, label: 'this session' };
  return { since: Date.now() - 24 * 3600_000, label: 'in the last day' };
}

function Summary({ s }: { s: ProjectState }) {
  const { since, label } = useSince(s);
  const finished = s.tasks.filter((t) => t.state === 'done').sort((a, b) => (b.finished_at ?? b.updated_at) - (a.finished_at ?? a.updated_at));
  const recent = finished.filter((t) => (t.finished_at ?? t.updated_at) >= since);
  // Nothing new since then: the last few finished anyway, so the card still says where the project got to.
  const done = recent.length ? recent : finished.slice(0, 3);
  // Not running: a task whose driver stopped with an error (it is on the card above and on Agents).
  const running = s.tasks.filter((t) => t.state === 'active' && t.driver?.status !== 'error');
  return (
    <div className="home3-summary">
      {running.length > 0 && (
      <section className="home3-running">
        <h2 className="home3-h">Running</h2>
        {(
          <ul className="home3-list">
            {running.map((t) => {
              const step = t.driver?.checklist?.find((i) => i.state === 'doing')?.text ?? t.driver?.status_line ?? '';
              return (
                <li key={t.id}>
                  <a href={href('p', t.project_id, 'tasks', t.id)}>
                    <span className={`home3-thumb run ${t.driver?.status === 'working' ? 'working' : ''}`}>
                      <span className={`status-dot ${t.driver?.status === 'working' ? 'dot-working pulse' : t.driver?.status === 'error' ? 'dot-error' : ''}`} />
                    </span>
                    <span className="home3-txt">
                      <span className="home3-t">{t.title}</span>
                      <span className={`home3-meta one-line ${t.driver?.status === 'error' ? 'err-text' : ''}`}>{t.driver?.status === 'error' ? 'Stopped with an error' : t.stalled ? 'Stalled' : t.held ? 'Held' : t.awaiting_review ? 'Awaiting review' : step || `Running ${workText(t)}`}</span>
                    </span>
                  </a>
                  <EdgeProgress value={t.driver?.progress} live={t.driver?.status === 'working'} />
                </li>
              );
            })}
          </ul>
        )}
      </section>
      )}
      <section>
        <h2 className="home3-h">
          {recent.length && label === 'this session' ? 'Done this session' : <>Done <span className="muted">{recent.length ? label : 'recently'}</span></>}
        </h2>
        {done.length > 0 && (
          <ul className="home3-list">
            {done.slice(0, 3).map((t) => (
              <li key={t.id}>
                <a href={href('p', t.project_id, 'tasks', t.id)}>
                  <span className="home3-thumb">{hasThumb(t.thumb) ? <PreviewThumb p={t.thumb} /> : <Icon name="check" size={20} />}</span>
                  <span className="home3-txt">
                    <span className="home3-t">{t.title}</span>
                    <span className="home3-meta">
                      took {workText(t)}
                      {t.finished_at ? ` · ${when(t.finished_at)}` : ''}
                    </span>
                  </span>
                </a>
              </li>
            ))}
            {done.length > 3 && (
              <li>
                <a className="home3-more" href={href('p', s.project.id, 'work', 'recent')}>
                  and {done.length - 3} more <Icon name="chevron" size={16} />
                </a>
              </li>
            )}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Nothing waiting on the user: each running task in detail (its agents and what each is doing now, the step, progress,
 * the latest preview and thread line), else the next scheduled tasks, else one muted line.
 */
function RunningNow({ s }: { s: ProjectState }) {
  const running = s.tasks.filter((t) => t.state === 'active');
  if (!running.length) {
    const next = s.tasks.filter((t) => t.state === 'scheduled').slice(0, 3);
    if (!next.length) return <p className="muted small calm-none">Nothing running</p>;
    return (
      <section className="calm-next">
        <h2 className="home3-h">Next</h2>
        <ul className="home3-list">
          {next.map((t) => (
            <li key={t.id}>
              <a className="one-line" href={href('p', t.project_id, 'tasks', t.id)}>
                {t.title}
              </a>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  return (
    <>
      <h2 className="home3-h run3-h">
        <span className={`status-dot ${running.some((t) => t.driver?.status === 'working') ? 'dot-working pulse' : ''}`} /> Running
      </h2>
      {running.map((t) => (
        <RunningTaskCard key={t.id} s={s} t={t} />
      ))}
    </>
  );
}

/** Ending the session by hand ("I'm stepping away"): only on Home, so the other pages carry no session bar. */
function StepAway({ s }: { s: ProjectState }) {
  const { busy, run } = useAction();
  if (s.presence?.state !== 'session') return null;
  return (
    <button className="btn small quiet step-away" title="End the session now and let the director carry on alone" disabled={busy} onClick={() => run(() => api(`/api/projects/${s.project.id}/away`, { method: 'POST' }))}>
      Step away
    </button>
  );
}

function AllClear({ s }: { s: ProjectState }) {
  // A new project: nothing to clear yet; the first thing is to tell the director what it is for.
  if (!s.tasks.length && !s.discussions.length && !s.docs.length) {
    return (
      <article className="card clear3 start3">
        <h2 className="clear3-title">What do you want from this project?</h2>
        <p className="muted">Tell the director the outcome you are after, any constraints, and what done looks like. It writes the Spec, builds the team and reports back.</p>
        <button className="btn primary big3" onClick={() => openChat({ kind: 'general' })}>
          <Icon name="discuss" size={20} /> Chat with the director
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
        <h2>All clear</h2>
        <div className="sess3">
          <SessionLine s={s} />
          <StepAway s={s} />
        </div>
      </div>
      <Summary s={s} />
    </article>
  );
}
