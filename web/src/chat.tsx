import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { api, useAgentEvents, useLive } from './api';
import type { Agent, AgentEvent, Discussion, Doc, InboxItem, Preview, ProjectState, Report, Task, TaskDetail } from './api';
import { AttachButton, dropTarget, pasteInto, sizeLabel, useAttachDraft } from './attachments';
import { AnnotateButton, openAnnotator } from './annotate';
import { HandoffCard } from './handoff';
import { KIND_LABEL, kindTone } from './needs';
import { openDiscussionOf } from './specdiscuss';
import { toThreadLines } from './tasks';
import { ProposalArea, pinCtx } from './proposal';
import { Thread } from './thread';
import type { ThreadLine } from './thread';
import { RequestAnswers } from './home';
import { Icon, Sheet, Tag, href, useAction } from './ui';

/**
 * The chat with the director, opened from wherever the user is (the docked bar on every project page, a triage
 * card, a Spec entry). It is about something: the context chip says what, taken from where it was opened, and the
 * thread shown is that item's own (a task's or discussion's thread; a Spec entry's discussion or planning task; the
 * task a preview, request or report belongs to). General is the director conversation. Sending uses the existing
 * routes (thread message, Spec discussion, conversation) and adds what the user was looking at when that is more
 * specific than the thread (server/chatcontext.ts), so "make this bigger" is unambiguous. Nothing new is stored.
 */

export type ChatCtx = { kind: 'general' } | { kind: 'task' | 'discussion' | 'doc' | 'request' | 'preview' | 'report'; id: string };
export const GENERAL: ChatCtx = { kind: 'general' };

let openGlobal: ((c?: ChatCtx) => void) | null = null;
/** Open the chat; without a context it opens on the page's own (the docked bar's). */
export const openChat = (c?: ChatCtx) => openGlobal?.(c);

const TAG: Record<ChatCtx['kind'], string> = { general: 'General', task: 'Task', discussion: 'Discussion', doc: 'Spec', request: 'Request', preview: 'Preview', report: 'Report' };
const THIS: Record<ChatCtx['kind'], string> = { general: 'General', task: 'This task', discussion: 'This discussion', doc: 'Spec entry', request: 'This request', preview: 'This preview', report: 'This report' };

/** The page's own context, from the route (project.tsx). */
export function routeContext(s: ProjectState, tab: string, sub?: string): ChatCtx {
  if (!sub) return GENERAL;
  if (tab === 'tasks' || tab === 'discussions') {
    if (sub === 'recent' || sub === 'needs') return GENERAL;
    const d = s.discussions.find((x) => x.id === sub);
    return { kind: d && d.kind !== 'task' ? 'discussion' : 'task', id: sub };
  }
  if (tab === 'spec' && s.docs.some((d) => d.id === sub)) return { kind: 'doc', id: sub };
  if (tab === 'previews' && s.previews.some((p) => p.id === sub)) return { kind: 'preview', id: sub };
  if (tab === 'reports' && /^rp_/.test(sub)) return { kind: 'report', id: sub };
  return GENERAL;
}

type Row = Task | Discussion;
type Resolved = {
  ctx: ChatCtx;
  tag: string;
  title: string;
  /** The item's thread, if it has one. */
  thread: Row | null;
  /** A Spec entry with no discussion or planning task yet: the first message starts one. */
  doc?: Doc;
  /** Sent with each message: the item, when it is more specific than the thread it goes to. */
  viewing?: { kind: string; id: string };
  request?: InboxItem;
  preview?: Preview;
};

function allRequests(s: ProjectState): InboxItem[] {
  const seen = new Map<string, InboxItem>();
  for (const t of [...s.tasks, ...s.discussions, ...(s.request_holders ?? [])]) for (const r of t.requests ?? []) seen.set(r.id, r);
  for (const r of s.inbox) if (!seen.has(r.id)) seen.set(r.id, r);
  return [...seen.values()];
}

const findRow = (s: ProjectState, id: string | null | undefined): Row | null => (id ? s.tasks.find((t) => t.id === id) ?? s.discussions.find((d) => d.id === id) ?? s.request_holders?.find((d) => d.id === id) ?? null : null);

function resolve(s: ProjectState, ctx: ChatCtx, report: Report | null): Resolved {
  if (ctx.kind === 'general') return { ctx, tag: 'General', title: 'The director decides where it goes', thread: null };
  const base = { ctx, tag: TAG[ctx.kind] };
  if (ctx.kind === 'task' || ctx.kind === 'discussion') {
    const t = findRow(s, ctx.id);
    const kind = t && (t.kind === 'discussion' ? 'discussion' : 'task');
    return { ...base, tag: kind ? TAG[kind] : base.tag, title: t?.title ?? 'Loading…', thread: t };
  }
  if (ctx.kind === 'doc') {
    const d = s.docs.find((x) => x.id === ctx.id);
    const plan = d?.plan_task_id ? s.tasks.find((t) => t.id === d.plan_task_id && t.state === 'planning') : undefined;
    const disc = d ? openDiscussionOf(s, d.id) : undefined;
    const thread = plan ?? disc ?? null;
    return { ...base, title: d?.title ?? 'Spec entry', thread, doc: thread ? undefined : d, viewing: plan ? { kind: 'doc', id: ctx.id } : undefined };
  }
  if (ctx.kind === 'request') {
    const r = allRequests(s).find((x) => x.id === ctx.id);
    return { ...base, title: r?.title ?? 'Request', thread: findRow(s, r?.task_id), viewing: { kind: 'request', id: ctx.id }, request: r };
  }
  if (ctx.kind === 'preview') {
    const p = s.previews.find((x) => x.id === ctx.id);
    return { ...base, title: p?.title ?? 'Preview', thread: findRow(s, p?.task_id), viewing: { kind: 'preview', id: ctx.id }, preview: p };
  }
  return { ...base, title: report?.title ?? 'Report', thread: findRow(s, report?.task_id), viewing: { kind: 'report', id: ctx.id } };
}

const directorOf = (s: ProjectState): Agent | undefined => s.agents.find((a) => !a.parent_id && a.status !== 'closed') ?? s.agents.find((a) => !a.parent_id);
export const directorName = (s: ProjectState) => directorOf(s)?.name ?? s.project.structure.roles.find((r) => r.id === s.project.structure.root)?.name ?? 'Director';

// ---------- the host: docked bar and sheet ----------

/** On every project page: the docked "Chat with Director" bar, and the sheet it opens. */
export function ChatHost({ s, page }: { s: ProjectState; page: ChatCtx }) {
  const [open, setOpen] = useState<ChatCtx | null>(null);
  const pageKey = `${page.kind}:${'id' in page ? page.id : ''}`;
  useEffect(() => {
    openGlobal = (c) => setOpen(c ?? page);
    return () => {
      openGlobal = null;
    };
  }, [pageKey]);
  // Moving to another page (a link in the thread, Back) closes the chat.
  useEffect(() => () => setOpen(null), [pageKey, location.hash]);
  const running = s.tasks.filter((t) => t.state === 'active').length;
  const name = directorName(s);
  const row = page.kind === 'task' || page.kind === 'discussion' ? findRow(s, page.id) : null;
  const active = row?.kind !== 'discussion' && row?.state === 'active';
  const what = page.kind === 'general' ? '' : page.kind === 'doc' ? s.docs.find((d) => d.id === page.id)?.title : page.kind === 'preview' ? s.previews.find((p) => p.id === page.id)?.title : row?.title;
  return (
    <>
      <div className="chat-dock">
        <button className="chat-dock-open" onClick={() => setOpen(page)} aria-label={`${active ? 'Interject or chat' : 'Chat'} with ${name}${what ? ` about ${what}` : ''}`}>
          <Icon name="discuss" size={19} />
          <span className="chat-dock-text">
            {/* The Interject badge says the rest; on a narrow phone with the badge the name gives way too (styles.css). */}
            <b>
              Chat<span className="chat-dock-with">with {name}</span>
            </b>
            {what && <span className="chat-dock-about">about {what}</span>}
          </span>
          {active && <span className="chat-dock-tag">Interject</span>}
        </button>
        {/* What is running, folded into the bar (no separate strip): opens Work's tasks, active first. */}
        {running > 0 && (
          <a className="chat-dock-running" href={href('p', s.project.id, 'work', 'tasks')} aria-label={`${running} running: open Work`}>
            <span className={`status-dot ${s.agents.some((a) => a.status === 'working') ? 'dot-working pulse' : ''}`} />
            {running} running
          </a>
        )}
      </div>
      {open && <ChatSheet key={JSON.stringify(open)} s={s} initial={open} onClose={() => setOpen(null)} />}
    </>
  );
}

// ---------- unread ----------

const seenKey = (pid: string, key: string) => `helm-chat-seen:${pid}:${key}`;
/** Never opened before: what is there counts as seen, so the first open does not show the whole history as new. */
const seenAt = (pid: string, key: string) => {
  const v = localStorage.getItem(seenKey(pid, key));
  if (v === null) localStorage.setItem(seenKey(pid, key), String(Date.now()));
  return Number(v ?? Date.now());
};
const markSeen = (pid: string, key: string, ts: number) => {
  if (ts > seenAt(pid, key)) localStorage.setItem(seenKey(pid, key), String(ts));
};
const unread = (lines: ThreadLine[], since: number) => lines.filter((l) => l.type === 'reply' && l.ts > since).length;

// ---------- the sheet ----------

function ChatSheet({ s, initial, onClose }: { s: ProjectState; initial: ChatCtx; onClose: () => void }) {
  const pid = s.project.id;
  const [ctx, setCtx] = useState<ChatCtx>(initial);
  const reportData = useLive<{ report: Report }>(ctx.kind === 'report' ? `/api/reports/${ctx.id}` : null, (m) => m.type === 'project' && m.projectId === pid);
  const r = resolve(s, ctx, reportData.data?.report ?? null);
  const hasItem = !!r.thread || !!r.doc;
  const [view, setView] = useState<'item' | 'general'>(hasItem ? 'item' : 'general');
  // The context changed under the open sheet (a Spec discussion was just started, or the item has no thread).
  useEffect(() => {
    if (!hasItem && view === 'item') setView('general');
  }, [hasItem, view]);
  const [picking, setPicking] = useState(false);
  const [pause, setPause] = useState(false);
  const name = directorName(s);
  const root = directorOf(s);

  const general = useGeneralLines(s);
  const detail = useLive<TaskDetail>(r.thread ? `/api/tasks/${r.thread.id}` : null, (m) => m.type === 'project' && m.projectId === pid);
  const itemLines = useMemo(() => (detail.data && detail.data.task.id === r.thread?.id ? toThreadLines(detail.data.timeline, s, name, pinCtx(detail.data.task.id, detail.data.proposal)) : []), [detail.data, s, name, r.thread?.id]);
  const showing = view === 'general' ? general.lines : itemLines;
  const key = view === 'general' ? 'general' : r.thread?.id ?? '';
  const lastTs = showing[showing.length - 1]?.ts ?? 0;
  // What the user has seen: marked as each view is shown; the other view's new replies count on its switch.
  const [seenGeneral] = useState(() => seenAt(pid, 'general'));
  useEffect(() => {
    if (key && lastTs) markSeen(pid, key, lastTs);
  }, [key, lastTs, pid]);
  const generalUnread = view === 'general' ? 0 : unread(general.lines, Math.max(seenGeneral, seenAt(pid, 'general')));
  const itemUnread = view === 'item' || !r.thread ? 0 : unread(itemLines, seenAt(pid, r.thread.id));

  const row = r.thread;
  const active = view === 'item' && row?.kind !== 'discussion' && row?.state === 'active';
  const send = async (text: string, attachments: string[]) => {
    const context = r.viewing ?? (view === 'general' && ctx.kind !== 'general' ? { kind: ctx.kind, id: ctx.id } : undefined);
    if (view === 'item' && row) {
      await api(`/api/tasks/${row.id}/message`, { body: { text, attachments, context: r.viewing, interject: active, pause: active && pause } });
      setPause(false);
    } else if (view === 'item' && r.doc) {
      await api(`/api/docs/${r.doc.id}/discuss`, { body: { text, attachments } });
    } else await api(`/api/projects/${pid}/message`, { body: { text, attachments, context } });
  };

  const showItem = view === 'item' && hasItem;
  const working =
    root?.status === 'working'
      ? { name: root.name, line: root.status_line }
      : showItem && row?.driver?.status === 'working'
        ? { name: row.driver.name, line: row.driver.status_line }
        : null;
  const lines = showItem ? (r.doc ? [] : itemLines.slice(-40)) : withApprovals(general.lines.slice(-general.shown), s);
  const fullHref = row ? href('p', pid, row.kind === 'discussion' ? 'discussions' : 'tasks', row.id) : null;

  const head = (
    <div className="chat-head">
      <div className="chat-switch" role="tablist" aria-label="Which thread">
        {hasItem && (
          <button role="tab" aria-selected={view === 'item'} className={view === 'item' ? 'on' : ''} onClick={() => setView('item')}>
            <span className="one-line">{THIS[r.ctx.kind === 'task' && row?.kind === 'discussion' ? 'discussion' : r.ctx.kind]}</span>
            {itemUnread > 0 && <b className="chat-unread">{itemUnread}</b>}
          </button>
        )}
        <button role="tab" aria-selected={view === 'general'} className={view === 'general' ? 'on' : ''} onClick={() => setView('general')}>
          <span className="one-line">General</span>
          {generalUnread > 0 && (
            <b className="chat-unread" aria-label={`${generalUnread} new`}>
              {generalUnread}
            </b>
          )}
        </button>
      </div>
      <button className="icon-btn" onClick={onClose} aria-label="Close the chat">
        <Icon name="close" size={22} />
      </button>
    </div>
  );

  // What the chat is about stays in view above the thread: a request with its answer controls, or the preview.
  // A request linked to pinned proposals is answered from the proposal area, options and all (proposal.tsx).
  const proposal = detail.data && detail.data.task.id === row?.id ? detail.data.proposal : null;
  const proposalHere = !!proposal && proposal.request?.status === 'open' && (!r.request || proposal.request.id === r.request.id);
  const pinned =
    showItem && proposalHere && row ? (
      <div className="chat-pinned">
        <ProposalArea proposal={proposal} taskId={row.id} pid={pid} s={s} />
      </div>
    ) : showItem && (r.request || r.preview) ? (
      <div className="chat-pinned">{r.request ? <RequestContext r={r.request} /> : <PreviewContext p={r.preview!} pid={pid} />}</div>
    ) : null;
  const top = showItem ? (
    <>{row && <ItemLink row={row} hrefTo={fullHref!} count={itemLines.length} shown={lines.length} />}</>
  ) : (
    <>
      {general.hidden > 0 && (
        <div className="convo-earlier">
          <button className="btn small quiet" onClick={general.earlier}>
            Show earlier
          </button>
        </div>
      )}
    </>
  );

  return (
    <Sheet title={`Chat with ${name}`} onClose={onClose} className="chat-sheet" head={head}>
      {pinned}
      <Thread
        className="chat-thread"
        label={view === 'general' ? `Conversation with ${name}` : `Thread of ${r.title}`}
        head={null}
        lines={lines}
        loaded={showItem ? (r.doc ? true : !!detail.data) : general.loaded}
        top={top}
        after={!showItem && general.lines.length > 0 ? <HandoffCard s={s} /> : undefined}
        empty={
          showItem && r.doc ? (
            <DocContext d={r.doc} />
          ) : showItem ? (
            <div className="convo-empty">
              <p>Nothing said here yet. Ask {name} anything about it.</p>
            </div>
          ) : s.handoff?.offer ? (
            <HandoffCard s={s} />
          ) : (
            <div className="convo-empty">
              <h3>What do you want from this project?</h3>
              <p>Tell {name} the outcome you are after, constraints, and what done looks like. Ideas and questions get filed as discussions or tasks; the chip under each message takes you there.</p>
            </div>
          )
        }
        working={working}
        waiting={root?.status === 'waiting' && view === 'general' ? `${name} is waiting on you.` : null}
        placeholder=""
        onSend={send}
        dock={(sendIt) => (
          <ChatComposer
            pid={pid}
            r={r}
            general={view === 'general'}
            name={name}
            active={active}
            pause={pause}
            setPause={setPause}
            target={view === 'item' && row ? row.id : 'director'}
            onPick={() => setPicking(true)}
            onClear={() => {
              setCtx(GENERAL);
              setView('general');
            }}
            onSend={sendIt}
          />
        )}
      />
      {picking && (
        <ContextPicker
          s={s}
          current={ctx}
          onClose={() => setPicking(false)}
          onPick={(c) => {
            setCtx(c);
            setPicking(false);
            const next = resolve(s, c, null);
            setView(next.thread || next.doc || c.kind === 'report' ? 'item' : 'general');
          }}
        />
      )}
    </Sheet>
  );
}

// ---------- context cards at the top of a thread ----------

function RequestContext({ r }: { r: InboxItem }) {
  const open = r.status === 'open' || r.status === 'director' || r.status === 'check';
  return (
    <div className="chat-ctx-card">
      <div className="chat-ctx-top">
        <Tag tone={kindTone(r.kind)}>{KIND_LABEL[r.kind]}</Tag>
        <span className="muted small one-line">{r.agent_name ?? 'An agent'}</span>
      </div>
      <strong className="chat-ctx-title">{r.title}</strong>
      {open ? <RequestAnswers r={r} compact /> : <p className="muted small">Answered: {r.answer || r.status}</p>}
    </div>
  );
}

function PreviewContext({ p, pid }: { p: Preview; pid: string }) {
  return (
    <a className="chat-ctx-card chat-ctx-row" href={href('p', pid, 'previews', p.id)}>
      {p.file && /\.(png|jpe?g|webp|gif)$/i.test(p.file) && <img src={`/artifacts/${p.file}`} alt="" />}
      <span>
        <Tag tone="tone-accent">Preview</Tag>
        <strong className="chat-ctx-title">{p.title}</strong>
      </span>
    </a>
  );
}

function DocContext({ d }: { d: Doc }) {
  return (
    <div className="chat-ctx-card">
      <div className="chat-ctx-top">
        <Tag tone="tone-spec">Spec</Tag>
        <span className="muted small">no discussion yet</span>
      </div>
      <strong className="chat-ctx-title">{d.title}</strong>
      {d.summary && <p className="small muted">{d.summary}</p>}
      <p className="small">Your first message starts a discussion about this entry with the director. A change it proposes comes back for you to apply.</p>
    </div>
  );
}

function ItemLink({ row, hrefTo, count, shown }: { row: Row; hrefTo: string; count: number; shown: number }) {
  return (
    <a className="chat-item-link small" href={hrefTo}>
      {count > shown ? `${count - shown} earlier entries · ` : ''}Open “{row.title}”
      <Icon name="chevron" size={14} />
    </a>
  );
}

// ---------- the composer ----------

function ChatComposer({
  pid,
  r,
  general,
  name,
  active,
  pause,
  setPause,
  target,
  onPick,
  onClear,
  onSend,
}: {
  pid: string;
  r: Resolved;
  general: boolean;
  name: string;
  active: boolean;
  pause: boolean;
  setPause: (v: boolean) => void;
  target: string;
  onPick: () => void;
  onClear: () => void;
  onSend: (text: string, attachments: string[]) => Promise<unknown>;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const draft = useAttachDraft(pid);
  const canSend = (!!text.trim() || draft.ready.length > 0) && !busy && !draft.uploading;
  // Opened from the docked bar: the box takes focus so the keyboard comes up (on iOS only from the same tap).
  useLayoutEffect(() => {
    if (matchMedia('(min-width: 900px)').matches) ref.current?.focus();
  }, []);
  const send = async () => {
    if (!canSend) return;
    const t = text.trim();
    const files = draft.ready;
    setBusy(true);
    setError('');
    setText('');
    if (ref.current) ref.current.style.height = '';
    try {
      await onSend(t, files.map((a) => a.id));
      draft.clear();
    } catch (err: any) {
      setText(t);
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const placeholder = general ? (r.ctx.kind === 'general' ? `Message ${name}…` : `Message ${name} about this…`) : active ? `Tell ${name}…` : r.doc ? 'Start a discussion…' : `Ask about this ${r.tag.toLowerCase()}…`;
  return (
    <div className={`chat-composer ${over ? 'drop-over' : ''}`} {...dropTarget(draft, setOver)}>
      <div className="chat-context">
        <span className="chat-context-label">About</span>
        <span className="chat-chip">
          <span className="chat-chip-tag">{r.tag}</span>
          {r.ctx.kind !== 'general' && <span className="chat-chip-title">{r.title}</span>}
          {r.ctx.kind !== 'general' && (
            <button className="chat-chip-x" onClick={onClear} aria-label="Remove the context: General">
              <Icon name="close" size={14} />
            </button>
          )}
        </span>
        <button className="chat-change" onClick={onPick}>
          Change <Icon name="chevron" size={13} />
        </button>
      </div>
      {active && (
        <label className="check chat-pause">
          <input type="checkbox" checked={pause} onChange={(e) => setPause(e.target.checked)} /> Pause the work while you read this
        </label>
      )}
      {draft.items.length > 0 && (
        <div className="chat-tray">
          {draft.items.map((p) => (
            <div key={p.key} className="chat-pending">
              <span className="chat-pending-thumb">
                {p.thumb ? <img src={p.thumb} alt="" /> : <Icon name="file" size={20} />}
                {!p.att && !p.error && <span className="chat-pending-progress" style={{ width: `${Math.round(p.progress * 100)}%` }} />}
              </span>
              <span className="chat-pending-name small">
                <span className="one-line">{p.name}</span>
                <span className="muted">{p.error || sizeLabel(p.size)}</span>
              </span>
              {p.att?.kind === 'image' && (
                <AnnotateButton
                  className="chat-annotate"
                  onClick={() =>
                    openAnnotator({ projectId: pid, source: { kind: 'attachment', id: p.att!.id }, url: p.att!.url, title: p.att!.name, to: target, onSent: () => draft.drop(p.key) })
                  }
                />
              )}
              <button className="icon-btn" onClick={() => draft.drop(p.key)} aria-label={`Remove ${p.name}`}>
                <Icon name="close" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="chat-input">
        <AttachButton draft={draft} className="icon-btn chat-attach" label="Attach photos or files" />
        <textarea
          ref={ref}
          value={text}
          rows={1}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
          }}
          onPaste={pasteInto(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
          }}
        />
        <button className="btn primary chat-send" disabled={!canSend} onClick={send} aria-label={active ? 'Interject' : 'Send'}>
          <Icon name="send" size={18} />
        </button>
      </div>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

// ---------- picking the context ----------

type Option = { ctx: ChatCtx; tag: string; title: string };

function ContextPicker({ s, current, onPick, onClose }: { s: ProjectState; current: ChatCtx; onPick: (c: ChatCtx) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const all = useMemo<Option[]>(() => {
    const byRecent = <T extends { updated_at: number }>(l: T[]) => [...l].sort((a, b) => b.updated_at - a.updated_at);
    return [
      ...byRecent(s.tasks.filter((t) => !['done', 'dropped'].includes(t.state))).map((t) => ({ ctx: { kind: 'task', id: t.id } as ChatCtx, tag: 'Task', title: t.title })),
      ...byRecent(s.discussions.filter((d) => d.kind !== 'task' && d.state === 'open')).map((d) => ({ ctx: { kind: 'discussion', id: d.id } as ChatCtx, tag: 'Discussion', title: d.title })),
      ...allRequests(s).filter((r) => r.status === 'open').map((r) => ({ ctx: { kind: 'request', id: r.id } as ChatCtx, tag: 'Request', title: r.title })),
      ...byRecent(s.docs.filter((d) => ['entry', 'goal', 'design'].includes(d.kind))).map((d) => ({ ctx: { kind: 'doc', id: d.id } as ChatCtx, tag: 'Spec', title: d.title })),
      ...[...s.previews].sort((a, b) => b.created_at - a.created_at).map((p) => ({ ctx: { kind: 'preview', id: p.id } as ChatCtx, tag: 'Preview', title: p.title })),
      ...byRecent(s.tasks.filter((t) => ['done', 'dropped'].includes(t.state))).map((t) => ({ ctx: { kind: 'task', id: t.id } as ChatCtx, tag: 'Task', title: t.title })),
    ];
  }, [s]);
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const recent = (tag: string, n: number) => all.filter((o) => o.tag === tag).slice(0, n);
  const list = words.length ? all.filter((o) => words.every((w) => o.title.toLowerCase().includes(w))).slice(0, 40) : [...recent('Request', 3), ...recent('Task', 4), ...recent('Discussion', 3), ...recent('Preview', 2), ...recent('Spec', 2)];
  const same = (c: ChatCtx) => c.kind === current.kind && ('id' in c ? c.id : '') === ('id' in current ? current.id : '');
  return (
    <div className="chat-picker" role="dialog" aria-label="What is this about?">
      <div className="chat-picker-head">
        <h3>What is this about?</h3>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" size={20} />
        </button>
      </div>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tasks, discussions, Spec, previews" aria-label="Search" />
      <ul className="chat-picker-list">
        {!words.length && <PickRow o={{ ctx: GENERAL, tag: 'General', title: 'The director decides where it goes' }} on={same(GENERAL)} onPick={onPick} />}
        {list.map((o) => (
          <PickRow key={`${o.ctx.kind}:${'id' in o.ctx ? o.ctx.id : ''}`} o={o} on={same(o.ctx)} onPick={onPick} />
        ))}
        {words.length > 0 && !list.length && <li className="muted small pad">Nothing matches.</li>}
      </ul>
    </div>
  );
}

function PickRow({ o, on, onPick }: { o: Option; on: boolean; onPick: (c: ChatCtx) => void }) {
  return (
    <li>
      <button className={on ? 'on' : ''} onClick={() => onPick(o.ctx)}>
        <span className="chat-pick-tag">{o.tag}</span>
        <span className="one-line">{o.title}</span>
        {on && <Icon name="check" size={16} />}
      </button>
    </li>
  );
}

// ---------- the director conversation (General) ----------

const WRAPPED = /^<(agent-report|user-answer|helm-note|task-message|discussion-message|toolbox-question)([^>]*)>\n?([\s\S]*?)\n?<\/\1>\s*$/;
type Filed = { title: string; href: string; id: string; kind: string };

/** Turn the director's events into the exchange the user reads: what they said, what it answered, and short system rows. */
function toLines(events: AgentEvent[], name: string, projectId: string, filed: Map<number, Filed[]>): ThreadLine[] {
  const lines: ThreadLine[] = [];
  let reportFrom: string[] = [];
  for (const e of events) {
    const d = e.data;
    const base = { key: String(e.id), ts: e.ts };
    if (e.kind === 'inbound') {
      const text = String(d.text ?? '');
      const m = WRAPPED.exec(text);
      if (d.from?.kind === 'agent' || m?.[1] === 'agent-report') {
        // Not shown; the reply that follows says what it was answering.
        if (d.from?.name && !reportFrom.includes(d.from.name)) reportFrom.push(d.from.name);
      } else if (m?.[1] === 'user-answer') {
        const request = /request="([^"]*)"/.exec(m[2])?.[1];
        lines.push({ type: 'system', ...base, text: `You answered${request ? ` “${request}”` : ''}: ${m[3].trim()}` });
      } else if (m?.[1] === 'task-message') {
        // Said in a task's thread; it lives there, this row links to it.
        const task = /task="([^"]*)"/.exec(m[2])?.[1];
        const title = /title="([^"]*)"/.exec(m[2])?.[1];
        lines.push({ type: 'system', ...base, text: `You, in the task “${title ?? task}”: ${m[3].trim()}`, href: task ? href('p', projectId, 'tasks', task) : undefined });
      } else if (m?.[1] === 'toolbox-question') {
        const item = /name="([^"]*)"/.exec(m[2])?.[1];
        const question = m[3].split('\n\nAnswer with propose_tool')[0].trim();
        lines.push({ type: 'system', ...base, text: `You asked about the Toolbox item “${item ?? ''}”: ${question}`, href: href('toolbox') });
      } else if (m?.[1] === 'discussion-message') {
        const disc = /discussion="([^"]*)"/.exec(m[2])?.[1];
        const title = /title="([^"]*)"/.exec(m[2])?.[1];
        const verb = /new="true"/.test(m[2]) ? 'started the discussion' : 'in the discussion';
        lines.push({ type: 'system', ...base, text: `You ${verb} “${title ?? disc}”: ${m[3].split('\n\n<spec-entry')[0].trim()}`, href: disc ? href('p', projectId, 'discussions', disc) : undefined });
      } else if (m?.[1] === 'helm-note' || d.from?.kind === 'system') {
        const note = (m ? m[3] : text).trim().replace(/^The user /, 'You ').replace(/ \(id [^)]+\)| \[\[(?:task|disc)_[0-9a-f]+\]\]/g, '');
        const task = /(?:\(id |\[\[)((?:task|disc)_[0-9a-f]+)(?:\)|\]\])/.exec(m ? m[3] : text)?.[1];
        lines.push({ type: 'system', ...base, text: `Helm told ${name}: ${note}`, href: task ? href('p', projectId, 'tasks', task) : undefined });
      } else {
        lines.push({ type: 'you', ...base, text, filed: filed.get(e.id), attachments: d.attachments, about: d.viewing });
      }
    } else if (e.kind === 'result') {
      const text = String(d.text ?? '').trim();
      if (text || !d.ok) lines.push({ type: 'reply', ...base, name, text: text || 'The turn ended without a reply.', ok: !!d.ok, note: reportFrom.length ? `after ${reportFrom.join(', ')}’s report` : undefined });
      reportFrom = [];
    } else if (e.kind === 'note') {
      lines.push({ type: 'system', ...base, text: String(d.text ?? '') });
    } else if (e.kind === 'error') {
      lines.push({ type: 'system', ...base, text: String(d.message ?? 'Error'), tone: 'error' });
    }
  }
  return lines;
}

const PAGE = 16;

function useGeneralLines(s: ProjectState) {
  const projectId = s.project.id;
  const root = directorOf(s);
  const name = directorName(s);
  const { events, loaded, more, loadOlder } = useAgentEvents(root?.id ?? null, 'conversation');
  const filed = useMemo(() => {
    const map = new Map<number, Filed[]>();
    for (const f of s.filed ?? []) {
      const list = map.get(f.event_id) ?? [];
      list.push({ title: f.title, href: href('p', projectId, f.kind === 'discussion' ? 'discussions' : 'tasks', f.id), id: f.id, kind: f.kind });
      map.set(f.event_id, list);
    }
    return map;
  }, [s.filed, projectId]);
  const lines = useMemo(() => toLines(events, name, projectId, filed), [events, name, projectId, filed]);
  const [shown, setShown] = useState(PAGE);
  const hidden = Math.max(0, lines.length - shown) + (more && loaded && lines.length ? 1 : 0);
  const earlier = async () => {
    if (lines.length - shown < PAGE && more) await loadOlder();
    setShown((n) => n + PAGE);
  };
  return { lines, loaded, shown, hidden, earlier };
}

/** After a reply that filed or names a planning task: its Approve control, so the plan can be approved without leaving the chat. */
function withApprovals(lines: ThreadLine[], s: ProjectState): ThreadLine[] {
  const out: ThreadLine[] = [];
  let waiting: Task[] = [];
  const done = new Set<string>();
  const flush = () => {
    for (const t of waiting) if (!done.has(t.id)) out.push({ type: 'node', key: `approve-${t.id}`, ts: t.updated_at, node: <ApproveCard t={t} /> }), done.add(t.id);
    waiting = [];
  };
  for (const l of lines) {
    if (l.type === 'you' && l.filed) {
      for (const f of l.filed) {
        const t = s.tasks.find((x) => x.id === f.href.split('/').pop() && x.state === 'planning');
        if (t) waiting.push(t);
      }
    }
    out.push(l);
    if (l.type === 'reply') {
      // A plan the director wrote up in answer (it names the planning task as a reference): approvable here too.
      for (const m of l.text.matchAll(/\[\[(task_[0-9a-f]+)\]\]/g)) {
        const t = s.tasks.find((x) => x.id === m[1] && x.state === 'planning');
        if (t && !waiting.includes(t)) waiting.push(t);
      }
      flush();
    }
  }
  flush();
  return out;
}

function ApproveCard({ t }: { t: Task }) {
  const { busy, error, run } = useAction();
  return (
    <div className="chat-approve">
      <span className="chat-approve-k">Plan waiting for your go-ahead</span>
      <strong>{t.title}</strong>
      <div className="chat-approve-acts">
        <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/tasks/${t.id}/approve`, { method: 'POST', body: {} }))}>
          <Icon name="check" size={16} /> Approve
        </button>
        <a className="btn" href={href('p', t.project_id, 'tasks', t.id)}>
          Read the plan
        </a>
      </div>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}


