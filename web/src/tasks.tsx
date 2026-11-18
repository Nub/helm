import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, useLive } from './api';
import type { Agent, Origin, ProjectState, Task, TaskDetail, TaskState, TimelineItem, Attachment } from './api';
import { HostBadges } from './hosts';
import { InboxCard, RequestOutcome } from './inbox';
import { AutoAllowedGroup } from './decisions';
import type { InboxItem } from './api';
import { NeedsGroup, needsResponse } from './needs';
import { DiscussionStateTag } from './discussions';
import type { DiscussionState } from './api';
import { PreviewTile } from './preview';
import { Checklist, progressLabel } from './project';
import { openChat } from './chat';
import { DiscussionView, NewTaskSheet, ThreadLinks } from './discussions';
import { TaskReports } from './reports';
import { Thread } from './thread';
import { ChangeCard, TaskSpecBlock } from './spec';
import { ProposalCard, SnapshotCard } from './specdiscuss';
import { useDragReorder } from './drag';
import { ImportanceControl, ImportancePicker, ImportanceTag, LEVEL, TieredList, recentChange } from './importance';
import type { ThreadLine } from './thread';
import { ClipCount, References } from './attachments';
import { HappeningNow, Latest, NeedsYou, PlanBlock, TaskTiming, WhatChanged } from './tasknow';
import { PinToggle, ProposalArea, ProposalStrip, linkedRequestId, pinCtx } from './proposal';
import type { PinCtx } from './proposal';
import { Chips, Clamp, Empty, Icon, Markdown, Progress, Sheet, Status, Tag, ago, clock, go, href, useAction, PlainRefs } from './ui';
import { withPeriodDividers } from './sessions';
import { QuickDone } from './team';

// ---------- states and actions ----------

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  planning: 'Planning',
  waiting: 'Waiting',
  scheduled: 'Scheduled',
  active: 'Active',
  paused: 'Paused',
  done: 'Done',
  dropped: 'Dropped',
};
const OPEN: TaskState[] = ['planning', 'waiting', 'scheduled', 'active', 'paused'];
const STATE_ORDER: TaskState[] = ['planning', 'active', 'scheduled', 'waiting', 'paused', 'done', 'dropped'];

export function TaskStateTag({ state }: { state: TaskState }) {
  return <Tag tone={`task-st ts-${state}`}>{TASK_STATE_LABEL[state]}</Tag>;
}

type Action = 'approve' | 'start' | 'interrupt' | 'resume' | 'drop';

/** The one-tap action a task offers in its state, if any. */
function primaryAction(state: TaskState): { action: Action; label: string; icon: string; tone: string } | null {
  if (state === 'planning') return { action: 'approve', label: 'Approve', icon: 'check', tone: 'primary' };
  if (state === 'waiting') return { action: 'approve', label: 'Schedule', icon: 'plus', tone: '' };
  if (state === 'scheduled') return { action: 'start', label: 'Start now', icon: 'play', tone: '' };
  if (state === 'active') return { action: 'interrupt', label: 'Interrupt', icon: 'stop', tone: '' };
  if (state === 'paused') return { action: 'resume', label: 'Resume', icon: 'play', tone: 'primary' };
  return null;
}

function useTaskActions(task: Task, onDone?: (state: TaskState) => void) {
  const { busy, error, run } = useAction();
  const act = (action: Action) => {
    if (action === 'drop' && !confirm(`Drop the task “${task.title}”? The director is told to stop any work on it.`)) return;
    void run(async () => {
      await api(`/api/tasks/${task.id}/${action}`, { method: 'POST', body: {} });
      const to: Record<Action, TaskState> = { approve: 'scheduled', start: 'active', interrupt: 'paused', resume: 'active', drop: 'dropped' };
      onDone?.(to[action]);
    });
  };
  const move = (to: 'top' | 'up' | 'down' | 'bottom') => void run(() => api(`/api/tasks/${task.id}/move`, { body: { to } }));
  /** Correct a mis-filing: a task nobody has worked on becomes a discussion, same thread. */
  const toDiscussion = () => {
    if (!confirm(`Move “${task.title}” to the discussions? It stays as a thread you can come back to; nothing will be worked on.`)) return;
    void run(async () => {
      await api(`/api/tasks/${task.id}/to-discussion`, { body: {} });
      go('p', task.project_id, 'discussions', task.id);
    });
  };
  return { busy, error, act, move, toDiscussion };
}

/** Whether a task may still become a discussion: no work has started on it (the server checks agents too). */
/**
 * The agents on a task in display order: the driver first, each agent followed by the quick helpers it has at
 * work; its finished helpers ride along to collapse into one line under it.
 */
function taskAgentRows(driver: Agent | null | undefined, others: Agent[]): { a: Agent; done?: Agent[] }[] {
  const all = [driver, ...others].filter(Boolean) as Agent[];
  const ids = new Set(all.map((a) => a.id));
  const done = (a: Agent) => ['done', 'closed'].includes(a.status);
  const helperOf = (a: Agent, p: Agent) => !!a.quick && a.parent_id === p.id;
  const out: { a: Agent; done?: Agent[] }[] = [];
  for (const a of all) {
    if (a.quick && a.parent_id && ids.has(a.parent_id)) continue;
    out.push({ a });
    for (const h of all) if (helperOf(h, a) && !done(h)) out.push({ a: h });
    const finished = all.filter((h) => helperOf(h, a) && done(h));
    if (finished.length) out.push({ a, done: finished });
  }
  return out;
}

const movable = (t: Task) => (t.state === 'planning' || t.state === 'waiting') && !t.driver_agent_id && !t.tasks?.length;

// ---------- overflow menu ----------

export function Menu({ label, items, badge, caption }: { label: string; items: ({ label: string; onSelect: () => void; danger?: boolean } | false)[]; badge?: number; caption?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener('pointerdown', close);
    addEventListener('keydown', close);
    return () => {
      removeEventListener('pointerdown', close);
      removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button className="icon-btn" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
        {!!badge && <b className="badge">{badge}</b>}
        {caption && <span className="bar-cap" aria-hidden="true">{caption}</span>}
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.filter(Boolean).map((it) => {
            const i = it as { label: string; onSelect: () => void; danger?: boolean };
            return (
              <button
                key={i.label}
                role="menuitem"
                className={i.danger ? 'danger' : ''}
                onClick={() => {
                  setOpen(false);
                  i.onSelect();
                }}
              >
                {i.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- the Overview's Tasks section ----------

type TaskSort = 'queue' | 'importance' | 'state' | 'updated' | 'needs';
const GROUPS: { id: string; title: string; states: TaskState[] }[] = [
  { id: 'planning', title: 'Needs you: planning', states: ['planning'] },
  { id: 'active', title: 'Active', states: ['active'] },
  { id: 'scheduled', title: 'Scheduled', states: ['scheduled'] },
  { id: 'waiting', title: 'Waiting', states: ['waiting'] },
  { id: 'paused', title: 'Paused', states: ['paused'] },
];

/** `embedded`: a section of the Work page (work.tsx), under its heading. */
export function TasksSection({ s, page = false, initialSort = 'queue', embedded = false }: { s: ProjectState; page?: boolean; initialSort?: TaskSort; embedded?: boolean }) {
  const [sort, setSort] = useState<TaskSort>(initialSort);
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  // Optimistic state and queue order until the project refetches.
  const [stateOverride, setStateOverride] = useState<Record<string, TaskState>>({});
  const [order, setOrder] = useState<string[] | null>(null);
  useEffect(() => {
    setStateOverride({});
    setOrder(null);
  }, [s.tasks]);

  const tasks = useMemo(() => {
    const list = s.tasks.map((t) => (stateOverride[t.id] ? { ...t, state: stateOverride[t.id] } : t));
    if (order) list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    return list;
  }, [s.tasks, stateOverride, order]);
  // Needs response is pinned at the top whatever the order, and those rows are not repeated below it
  // (Priorities shows the whole queue). Done or dropped tasks can still have a request open on them.
  const needs = tasks.filter(needsResponse);
  const rest = sort === 'importance' ? tasks : tasks.filter((t) => !needsResponse(t));
  const open = rest.filter((t) => OPEN.includes(t.state));
  const closed = rest.filter((t) => !OPEN.includes(t.state)).sort((a, b) => b.updated_at - a.updated_at);
  // The Needs-response filter (and where the old Inbox tab leads): discussions awaiting a response are listed too.
  const discNeeds = sort === 'needs' ? [...s.discussions.filter((d) => d.kind !== 'task'), ...(s.request_holders ?? [])].filter(needsResponse) : [];
  const setState = (id: string) => (state: TaskState) => setStateOverride((o) => ({ ...o, [id]: state }));

  const row = (t: Task, reorder?: ReorderProps) => <TaskRow key={t.id} t={t} s={s} onEdit={() => setEditing(t)} onState={setState(t.id)} reorder={reorder} showReason={sort === 'importance'} />;

  const moveScheduled = (ids: string[], id: string, to: number) => {
    const without = ids.filter((x) => x !== id);
    const target = without[to];
    const all = tasks.map((t) => t.id).filter((x) => x !== id);
    // Place it in the whole queue just before the task it now precedes, or after the last scheduled one.
    const at = target ? all.indexOf(target) : all.indexOf(without[without.length - 1]) + 1;
    all.splice(at, 0, id);
    setOrder(all);
    void api(`/api/tasks/${id}/move`, { body: target ? { before: target } : { after: without[without.length - 1] } }).catch(() => setOrder(null));
  };

  return (
    <section className={`tasks ${page ? 'tasks-page' : ''}`}>
      <div className="section-head">
        {page && !embedded ? <h1 className="page-title">Tasks</h1> : <h2>{initialSort === 'needs' ? 'Needs response' : 'Tasks'}</h2>}
        <button className="btn small" onClick={() => setEditing('new')}>
          <Icon name="plus" size={15} /> Add task
        </button>
      </div>
      {tasks.length > 0 && (
        <div className="toolbar">
          <label className="sort">
            Order
            <select value={sort} onChange={(e) => setSort(e.target.value as TaskSort)}>
              <option value="queue">Queue order</option>
              <option value="importance">Priorities</option>
              <option value="state">State</option>
              <option value="updated">Recently updated</option>
              <option value="needs">Needs response only</option>
            </select>
          </label>
        </div>
      )}
      <NeedsGroup list={needs} stateTag={(t) => <TaskStateTag state={t.state as TaskState} />} />
      {sort === 'needs' && <NeedsGroup list={discNeeds} title="Discussions needing response" stateTag={(d) => <DiscussionStateTag state={d.state as DiscussionState} />} />}
      {sort === 'needs' && !needs.length && !discNeeds.length && <Empty title="Nothing needs your response">When an agent asks you something or needs a permission, the task or discussion it concerns shows here with the answer controls.</Empty>}
      {sort === 'needs' && (
        <p className="muted small decisions-link">
          <a href={href('p', s.project.id, 'setup', 'decisions')}>Decisions made for you</a>: permission requests Helm answered without asking.
        </p>
      )}
      {tasks.length === 0 && sort !== 'needs' && (
        <Empty title="No tasks yet">Tasks are the units of work: what is happening now, what is lined up, and what waits to be scheduled. The director adds them as it breaks work down; you can add your own.</Empty>
      )}

      {sort === 'queue' &&
        GROUPS.map((g) => {
          const list = open.filter((t) => g.states.includes(t.state));
          if (!list.length) return null;
          return (
            <div key={g.id} className={`task-group group-${g.id}`}>
              <h3 className="group-title">
                {g.title} <span className="muted">{list.length}</span>
              </h3>
              {g.id === 'scheduled' ? <ReorderList tasks={list} render={row} onMove={moveScheduled} /> : <div className="stack">{list.map((t) => row(t))}</div>}
            </div>
          );
        })}
      {sort === 'importance' && (
        <div className="task-priorities">
          <p className="muted small">The queue order: most important tier first, then position. Drag a row to reorder (on a phone, press and hold it); drop it past a tier line to change its level. What you place is pinned.</p>
          <TieredList
            items={open.filter((t) => t.kind !== 'discussion').map((t) => ({ id: t.id, level: t.importance, pinned: !!t.importance_pinned, t }))}
            label={(l) => (
              <h3 className="group-title">
                {LEVEL[l]}{' '}
                <span className="muted">
                  {l === 5 ? `${s.taskBudget.critical.count} of ${s.taskBudget.critical.cap}` : l === 4 ? `${s.taskBudget.high.count} of ${s.taskBudget.high.cap}` : open.filter((t) => t.importance === l && t.kind !== 'discussion').length}
                </span>
              </h3>
            )}
            render={(i) => (
              <a className="prio-task" href={href('p', s.project.id, 'tasks', i.t.id)}>
                <span className="row wrap">
                  <b>{i.t.title}</b>
                  <TaskStateTag state={i.t.state} />
                  {i.pinned && <Icon name="pin" size={12} />}
                  <ImportanceTag level={i.t.importance} change={recentChange(s, i.t.id)} compact onlyMove />
                </span>
                {i.t.importance_reason && <span className="muted small one-line">{i.t.importance_reason}</span>}
              </a>
            )}
          />
        </div>
      )}
      {sort === 'state' && <div className="stack">{[...open].sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)).map((t) => row(t))}</div>}
      {sort === 'updated' && <div className="stack">{[...open].sort((a, b) => b.updated_at - a.updated_at).map((t) => row(t))}</div>}

      {closed.length > 0 && sort !== 'needs' && (
        <div className="task-group group-closed">
          <button className="group-toggle" onClick={() => setShowClosed(!showClosed)} aria-expanded={showClosed}>
            <Icon name="chevron" size={14} /> Done and dropped <span className="muted">{closed.length}</span>
          </button>
          {showClosed && <div className="stack">{closed.map((t) => row(t))}</div>}
        </div>
      )}
      {editing && <TaskEditor s={s} task={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

// ---------- drag to reorder (touch and mouse), with menu moves as the fallback ----------

type ReorderProps = { handle: ReactNode; dragging: boolean; offset: number };

function ReorderList({ tasks, render, onMove }: { tasks: Task[]; render: (t: Task, r: ReorderProps) => ReactNode; onMove: (ids: string[], id: string, to: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const ids = tasks.map((t) => t.id);
  const toRef = useRef<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  // Where the dragged row would land: the number of other rows whose middle is above the pointer.
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
      if (dest !== null && dest !== ids.indexOf(id)) onMove(ids, id, dest);
    },
  });
  const from = drag ? ids.indexOf(drag.id) : -1;

  return (
    <div className={`stack reorder ${drag ? 'is-dragging' : ''}`} ref={box}>
      {tasks.map((t, i) => {
        // Rows between the old and new place shift by one slot to show where it will land.
        const shift = drag && to !== null && drag.id !== t.id ? (from < i && i <= to ? -1 : to <= i && i < from ? 1 : 0) : 0;
        return (
          <div key={t.id} className="reorder-item" {...rowProps(t.id)} style={{ transform: drag?.id === t.id ? `translateY(${drag.dy}px)` : shift ? `translateY(calc(${shift} * (100% + 12px)))` : undefined }}>
            {render(t, {
              dragging: drag?.id === t.id,
              offset: shift,
              handle: (
                <button className="drag-handle" aria-label={`Drag to reorder ${t.title}`} {...gripProps(t.id)}>
                  <svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true" fill="currentColor">
                    {[4, 10, 16].map((y) => [5, 11].map((x) => <circle key={`${x}${y}`} cx={x} cy={y} r="1.6" />))}
                  </svg>
                </button>
              ),
            })}
          </div>
        );
      })}
    </div>
  );
}

// ---------- one task row ----------

function DriverLine({ driver, live, s }: { driver: Task['driver']; live?: Agent; s: ProjectState }) {
  if (!driver) return null;
  const a = live ?? driver;
  return (
    <div className="task-driver">
      <div className="row">
        <span className="task-driver-name">{a.name}</span>
        <Status status={a.status} />
        <HostBadges agentId={a.id} s={s} />
        <span className="spacer" />
        {a.progress !== null && <span className="mono small muted">{progressLabel(a as Agent)}</span>}
      </div>
      {a.status_line && <p className="muted small one-line"><PlainRefs text={a.status_line} /></p>}
      {a.progress !== null && <Progress value={a.progress} tone={a.status === 'working' ? 'live' : ''} />}
    </div>
  );
}

/** Who wrote the thread's newest message and what, as markdown; shown as one plain line (PlainRefs strip). */
function lastLine(t: Task): string | null {
  if (!t.last) return null;
  const who = t.last.author === 'user' ? 'You' : t.last.author_name;
  return `${who}: ${t.last.body}`;
}

function TaskRow({ t, s, onEdit, onState, reorder, showReason = false }: { t: Task; s: ProjectState; onEdit: () => void; onState: (st: TaskState) => void; reorder?: ReorderProps; showReason?: boolean }) {
  const { busy, error, act, move, toDiscussion } = useTaskActions(t, onState);
  const primary = primaryAction(t.state);
  const live = s.agents.find((a) => a.id === t.driver?.id);
  const isOpen = OPEN.includes(t.state);
  const link = href('p', s.project.id, 'tasks', t.id);
  const last = lastLine(t);

  return (
    <article className={`card task task-${t.state} ${reorder?.dragging ? 'dragging' : ''}`}>
      <div className="task-top">
        {reorder?.handle}
        <a className="task-link" href={link}>
          <div className="task-title-row">
            <h3>
              {t.title}
              <ClipCount n={t.attach_count} />
            </h3>
            <TaskStateTag state={t.state} />
          </div>
          {t.kind !== 'discussion' && (
            <span className="task-imp small">
              <ImportancePicker id={t.id} level={t.importance} pinned={!!t.importance_pinned} change={recentChange(s, t.id)} compact />
              {showReason && t.importance_reason && <span className="muted one-line"> {t.importance_reason}</span>}
            </span>
          )}
          {t.doc && (
            <span className="task-doc small">
              <Tag tone="tone-spec">Spec</Tag> {t.doc.title}
            </span>
          )}
          {t.needs_response > 0 && (
            <span className="task-asks small">
              Needs response: {t.needs_response} {t.needs_response === 1 ? 'request' : 'requests'}
            </span>
          )}
          <ProposalStrip p={t.proposal} />
          {t.kind !== 'discussion' && <TaskTiming t={t} />}
          {last && <p className="task-last small one-line"><PlainRefs text={last} strip /></p>}
        </a>
        {t.thumb && t.thumb.kind === 'image' && t.thumb.file && (
          <a className="task-thumb" href={link} aria-hidden="true" tabIndex={-1}>
            <img src={`/artifacts/${t.thumb.file}`} alt="" loading="lazy" />
          </a>
        )}
      </div>
      {t.waiting_on_user_without_request && <UnfiledNeed t={t} compact />}
      {isOpen && <DriverLine driver={t.driver} live={live} s={s} />}
      <div className="row task-actions">
        {primary && (
          <button className={`btn ${primary.tone}`} disabled={busy} onClick={() => act(primary.action)}>
            <Icon name={primary.icon} size={15} /> {primary.label}
          </button>
        )}
        <span className="spacer" />
        {!isOpen && <span className="muted small">{ago(t.updated_at)}</span>}
        <Menu
          label={`More actions for ${t.title}`}
          items={[
            { label: 'Edit', onSelect: onEdit },
            (t.state === 'planning' || t.state === 'waiting') && { label: 'Start now', onSelect: () => act('start') },
            isOpen && { label: 'Move up', onSelect: () => move('up') },
            isOpen && { label: 'Move down', onSelect: () => move('down') },
            isOpen && { label: 'Move to top', onSelect: () => move('top') },
            { label: 'Open thread', onSelect: () => go('p', s.project.id, 'tasks', t.id) },
            movable(t) && { label: 'Move to discussions', onSelect: toDiscussion },
            isOpen && { label: 'Drop', onSelect: () => act('drop'), danger: true },
          ]}
        />
      </div>
      {error && <p className="error-text">{error}</p>}
    </article>
  );
}

/**
 * The task says it needs the user (its status summary, the director's last post, or needs_from_user) but no request is
 * open, so nothing shows under Needs response. One tap asks the director to file it or correct the task.
 */
function UnfiledNeed({ t, compact = false }: { t: Task; compact?: boolean }) {
  const { busy, error, run } = useAction();
  const [asked, setAsked] = useState(false);
  return (
    <div className={`unfiled-need ${compact ? 'compact' : ''}`} title={compact && t.unfiled_need ? `It says: ${t.unfiled_need}` : undefined}>
      <span className="unfiled-head">
        <Icon name="inbox" size={14} /> {compact ? 'Says it needs you, nothing filed' : 'Says it needs you, but nothing was filed'}
      </span>
      {!compact && t.unfiled_need && <q className="small one-line">{t.unfiled_need}</q>}
      <button className={`btn ${compact ? 'quiet small-btn' : 'req-btn'}`} disabled={busy || asked} onClick={() => void run(async () => { await api(`/api/tasks/${t.id}/ask-needs`, { method: 'POST' }); setAsked(true); })}>
        {asked ? 'Asked the director' : compact ? 'Ask the director' : 'Ask the director what it needs'}
      </button>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

// ---------- add / edit ----------

function TaskEditor({ s, task, onClose }: { s: ProjectState; task: Task | null; onClose: () => void }) {
  const [form, setForm] = useState({ title: task?.title ?? '', description: task?.description ?? '', doc_id: task?.doc_id ?? '', scheduled: false });
  const { busy, error, run } = useAction();
  const docs = s.docs.filter((d) => d.kind === 'entry' || d.kind === 'goal' || d.kind === 'design');
  const save = async () => {
    const body = { title: form.title, description: form.description, doc_id: form.doc_id || null, scheduled: form.scheduled };
    const done = await run(() => (task ? api(`/api/tasks/${task.id}`, { method: 'PATCH', body }) : api(`/api/projects/${s.project.id}/tasks`, { body })));
    if (done) onClose();
  };
  return (
    <Sheet title={task ? 'Edit task' : 'New task'} onClose={onClose}>
      <div className="form">
        <label>
          Title
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus={!task} />
        </label>
        <label>
          What it is and what done looks like (markdown)
          <textarea rows={8} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>
        {docs.length > 0 && (
          <label>
            Spec entry it implements
            <select value={form.doc_id} onChange={(e) => setForm({ ...form, doc_id: e.target.value })}>
              <option value="">None</option>
              {docs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {!task && (
          <label className="check">
            <input type="checkbox" checked={form.scheduled} onChange={(e) => setForm({ ...form, scheduled: e.target.checked })} /> Put it in the queue now (Scheduled); otherwise it waits
          </label>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy || !form.title.trim()} onClick={save}>
            {task ? 'Save' : 'Add task'}
          </button>
        </div>
        <p className="muted small">
          {task
            ? task.state === 'active'
              ? 'This task is active, so the director is told what changed.'
              : 'The director reads the change when it next picks up this task.'
            : 'The director is told about the new task.'}
        </p>
      </div>
    </Sheet>
  );
}

// ---------- a task's own page ----------

type Filter = 'all' | 'conversation' | 'previews' | 'decisions';

function matches(i: TimelineItem, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'previews') return i.type === 'preview';
  if (f === 'decisions') return (i.type === 'journal' && i.kind === 'decision') || ['question', 'answer', 'consult'].includes(i.type);
  return ['message', 'summary', 'state', 'change', 'question', 'answer', 'consult'].includes(i.type);
}

/** The page a row belongs on: a discussion's, or a task's (a discussion that became a task lives there now). */
const pageOf = (kind?: string) => (kind === 'discussion' ? 'discussions' : 'tasks');

export function TaskPage({ s, taskId, tab }: { s: ProjectState; taskId: string; tab: string }) {
  const pid = s.project.id;
  const { data, error } = useLive<TaskDetail>(`/api/tasks/${taskId}`, (m) => m.type === 'project' && m.projectId === pid);
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState(false);
  const [another, setAnother] = useState(false);
  // Which discussion blocks the reader opened or closed; unset means the default (collapsed when long).
  const [eraOpen, setEraOpen] = useState<Record<string, boolean>>({});
  const toggleEra = (id: string, open: boolean) => setEraOpen((m) => ({ ...m, [id]: open }));
  const [override, setOverride] = useState<TaskState | null>(null);
  // What changed → its place in the history: show everything, then scroll the entry into view and mark it.
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const jump = (key: string) => {
    setFilter('all');
    setJumpTo(key);
  };
  useEffect(() => {
    if (!jumpTo) return;
    const el = document.querySelector(`.task-thread [data-key="${jumpTo}"]`);
    setJumpTo(null);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('jumped');
    setTimeout(() => el.classList.remove('jumped'), 2200);
  }, [jumpTo]);
  useEffect(() => setOverride(null), [data]);
  // Old URLs keep working: a discussion that became a task, or an old task id merged into one, goes to where it is now.
  const canonical = data && (data.task.id !== taskId || pageOf(data.task.kind) !== tab) ? href('p', pid, pageOf(data.task.kind), data.task.id) : null;
  useEffect(() => {
    if (canonical) location.replace(canonical);
  }, [canonical]);

  if (error && !data) return <Empty title="Could not load this task">{error}</Empty>;
  if (!data || canonical) return <div className="loading">Loading…</div>;
  // Discussions share the id space and the thread; they get their own page.
  if (data.task.kind === 'discussion') return <DiscussionView s={s} data={data} />;
  const t = override ? { ...data.task, state: override } : data.task;
  const root = s.agents.find((a) => !a.parent_id && a.status !== 'closed');
  const driver = s.agents.find((a) => a.id === t.driver?.id) ?? (t.driver as Agent | null);
  const others = data.agents.filter((a) => a.id !== t.driver?.id).map((a) => s.agents.find((x) => x.id === a.id) ?? a);

  // The history: a discussion this task came from (read-only, from its own row), then this row's discussion era
  // if it was a discussion itself, then the task's own entries. Filters apply inside the discussion blocks too.
  const shown = (items: TimelineItem[]) => items.filter((i) => matches(i, filter));
  const became = t.became_task_at ?? null;
  const directorName = root?.name ?? 'Director';
  const lines = [
    ...(data.origins ?? []).flatMap((o) => eraLines({ id: `o-${o.id}`, items: shown(o.timeline), all: o.timeline, origin: o, pid, s, directorName, open: eraOpen[`o-${o.id}`], toggle: toggleEra })),
    ...(became ? eraLines({ id: 'own', items: shown(data.timeline.filter((i) => i.ts < became)), all: data.timeline.filter((i) => i.ts < became), pid, s, directorName, open: eraOpen.own, toggle: toggleEra }) : []),
    ...withPeriodDividers(toThreadLines(shown(became ? data.timeline.filter((i) => i.ts >= became) : data.timeline), s, directorName, pinCtx(t.id, data.proposal)), data.periods),
  ];
  const count = (f: Filter) => data.timeline.filter((i) => matches(i, f)).length + (data.origins ?? []).reduce((n, o) => n + o.timeline.filter((i) => matches(i, f)).length, 0);
  const working = root?.status === 'working' ? { name: root.name, line: root.status_line } : driver?.status === 'working' ? { name: driver.name, line: driver.status_line } : null;
  // Everyone on the task, with live status from the project state.
  const liveAgents = [driver, ...others].filter((a): a is Agent => !!a);
  const closed = t.state === 'done' || t.state === 'dropped';
  // Open tasks reply through the chat (its docked bar, and the button under the history); a closed one keeps the history's own composer.
  const docked = !closed;

  return (
    <section className="task-page">
      <a className="back" href={href('p', pid, 'work', 'tasks')}>
        <Icon name="back" size={16} /> Work
      </a>

      {/* The Now area (tasknow.tsx): header, Needs you, Happening now, Latest, What changed. */}
      <header className="card task-head">
        <div className="row wrap task-head-meta">
          <TaskStateTag state={t.state} />
          {t.kind !== 'discussion' && <ImportancePicker id={t.id} level={t.importance} pinned={!!t.importance_pinned} change={recentChange(s, t.id)} compact />}
          <TaskTiming t={t} />
          {!t.started_at && <span className="muted small">updated {ago(t.updated_at)}</span>}
        </div>
        {t.origin === 'away' && t.origin_note && <p className="found-note small"><span className="found-tag">Found while away</span> {t.origin_note}</p>}
        <h1 className="page-title">{t.title}</h1>
        {driver && OPEN.includes(t.state) && (
          <div className="row task-head-driver">
            <span className="label">Driver</span>
            <a href={href('p', pid, 'agents', driver.id)}>{driver.name}</a>
            <Status status={driver.status} />
            {driver.progress !== null && driver.progress !== undefined && <span className="mono small muted">{progressLabel(driver as Agent)}</span>}
          </div>
        )}
        <TaskHeadActions t={t} onEdit={() => setEditing(true)} onAnother={became ? () => setAnother(true) : undefined} onState={setOverride} canBeDiscussion={!data.agents.length} />
      </header>

      {/* A planning task leads with its plan: the requests on it are about the plan. */}
      {t.state === 'planning' && <PlanBlock text={t.description} />}
      {/* The pinned proposal: the options the director asks the user to look at, with the question to choose (proposal.tsx). */}
      <ProposalArea proposal={data.proposal} taskId={t.id} pid={pid} s={s} />
      {t.needs_from_user && <NeedsFromYou t={t} pid={pid} />}
      {t.waiting_on_user_without_request && <UnfiledNeed t={t} />}
      <NeedsYou t={t} s={s} except={linkedRequestId(data.proposal)} />
      {t.state === 'active' && <HappeningNow agents={liveAgents} driverId={driver?.id} pid={pid} />}
      {/* Pinned previews are already at the top. */}
      <Latest t={t} latest={data.latest.filter((p) => !pinCtx(t.id, data.proposal).pinned.has(p.id))} pid={pid} final={closed} />
      <WhatChanged changes={data.changes ?? []} onJump={jump} />

      {data.reports && <TaskReports reports={data.reports} pid={pid} />}

      <section className="card task-about">
        <div className="section-head">
          <h2>About this task</h2>
          <button className="btn small quiet" onClick={() => setEditing(true)}>
            <Icon name="edit" size={15} /> Edit
          </button>
        </div>
        <p className="muted small">
          {t.origin === 'user' ? 'Added by you' : t.origin === 'doc' ? (t.state === 'planning' || data.timeline.some((x) => x.type === 'change') ? 'From your Spec edit' : 'Lined up from a goal') : t.origin === 'report' ? 'From a report' : 'Added by the director'} · updated {ago(t.updated_at)}
        </p>
        {t.state === 'planning' ? <p className="muted small">The plan is at the top of the page.</p> : t.description ? <Markdown text={t.description} /> : <p className="muted">No description yet.</p>}
        <ThreadLinks pid={pid} label="From the discussion" links={t.discussions ?? []} />
        <ThreadLinks pid={pid} label="Also led to" links={t.tasks ?? []} />
        {t.kind !== 'discussion' && (
          <div className="task-importance">
            <span className="label">Importance</span>
            <ImportanceControl id={t.id} level={t.importance} reason={t.importance_reason} pinned={!!t.importance_pinned} what="task" />
          </div>
        )}
        <References projectId={pid} owner={`task:${t.id}`} version={t.attach_count} hint="Screenshots, mockups, recordings or documents for this task. Files sent in its history are listed here too." />
        {t.doc && (
          <p className="task-doc">
            <Tag tone="tone-spec">Spec</Tag> {t.doc.title}
          </p>
        )}
        {(driver || others.length > 0) && (
          <div className="task-agents">
            <span className="label">Agents on it</span>
            {taskAgentRows(driver, others).map(({ a, done }) =>
              done ? (
                <QuickDone key={`${a.id}-done`} helpers={done} pid={pid} depth={1} />
              ) : (
              <details key={a.id} className={`task-agent ${a.quick ? 'quick' : ''}`} open={a.id === driver?.id && OPEN.includes(t.state)}>
                <summary>
                  <a href={href('p', pid, 'agents', a.id)}>{a.name}</a>
                  {a.id === driver?.id && <span className="muted small"> · driver</span>}
                  {a.quick ? <span className="muted small"> · quick job</span> : null}
                  <span className="spacer" />
                  <Status status={a.status} />
                  <HostBadges agentId={a.id} s={s} />
                </summary>
                {a.checklist?.length ? <Checklist agent={a} /> : a.quick ? <Clamp text={a.task} lines={3} /> : <p className="muted small">No worklist yet.</p>}
              </details>
              ),
            )}
          </div>
        )}
      </section>

      <TaskSpecBlock projectId={pid} spec={data.spec} />

      <Thread
        className="task-thread"
        label={`History of ${t.title}`}
        head={
          <div className="task-thread-head">
            <h2 className="convo-name">History</h2>
            <Chips
              value={filter}
              onChange={setFilter}
              options={[
                { id: 'all', label: 'All', count: count('all') },
                { id: 'conversation', label: 'Conversation', count: count('conversation') },
                { id: 'previews', label: 'Previews', count: count('previews') },
                { id: 'decisions', label: 'Decisions', count: count('decisions') },
              ]}
            />
          </div>
        }
        lines={lines}
        loaded
        working={filter === 'all' || filter === 'conversation' ? working : null}
        composer={!docked}
        empty={<div className="convo-empty">{filter === 'all' ? <p>Nothing said about this task yet. Ask the director anything about it here.</p> : <p>Nothing of this kind yet.</p>}</div>}
        placeholder="Message about this task"
        onSend={(text, attachments) => api(`/api/tasks/${t.id}/message`, { body: { text, attachments } })}
        attachTo={pid}
      />
      {docked && (
        // Replies and interjections go through the chat (chat.tsx), opened here on this task.
        <button className="btn task-chat-btn" onClick={() => openChat()}>
          <Icon name="discuss" size={18} /> {t.state === 'active' ? `Interject or reply to ${directorName}` : 'Reply about this task'}
        </button>
      )}

      {editing && <TaskEditor s={s} task={t} onClose={() => setEditing(false)} />}
      {another && <NewTaskSheet from={t} another onClose={() => setAnother(false)} />}
    </section>
  );
}

/** Entries before which a discussion block starts collapsed. */
const ERA_OPEN_UP_TO = 6;

/**
 * A marked block of discussion-era history inside a task's thread: a header that opens and closes it (with
 * the message count), its entries as ordinary thread lines, and a closing marker. `origin`: the block is
 * another row's discussion, shown read-only with a link to it.
 */
function eraLines({ id, items, all, origin, pid, s, directorName, open, toggle }: {
  id: string;
  items: TimelineItem[];
  all: TimelineItem[];
  origin?: Origin;
  pid: string;
  s: ProjectState;
  directorName: string;
  open: boolean | undefined;
  toggle: (id: string, open: boolean) => void;
}): ThreadLine[] {
  if (!all.length) return [];
  const isOpen = open ?? all.length <= ERA_OPEN_UP_TO;
  const messages = all.filter((i) => i.type === 'message').length;
  const ts = all[0].ts;
  const head: ThreadLine = {
    type: 'node',
    key: `era-${id}-head`,
    ts,
    node: (
      <div className={`era-head ${isOpen ? 'open' : ''}`}>
        <button className="era-toggle" aria-expanded={isOpen} onClick={() => toggle(id, !isOpen)}>
          <Icon name="chevron" size={16} />
          <span className="era-title">{origin ? <>Discussion this task came from</> : <>Discussion, before this became a task</>}</span>
          <span className="era-count muted small">
            {messages} {messages === 1 ? 'message' : 'messages'}
            {items.length !== all.length && ` · ${items.length} shown`}
            {isOpen ? '' : ' · Show'}
          </span>
        </button>
        {origin && (
          <a className="era-origin small" href={href('p', pid, origin.kind === 'discussion' ? 'discussions' : 'tasks', origin.id)}>
            {origin.title}
          </a>
        )}
      </div>
    ),
  };
  if (!isOpen) return [head];
  const body = toThreadLines(items, s, directorName).map((l) => ({ ...l, key: `era-${id}-${l.key}` }));
  const foot: ThreadLine = {
    type: 'node',
    key: `era-${id}-foot`,
    ts: all[all.length - 1].ts,
    node: (
      <div className="era-foot">
        <span>End of the discussion</span>
        <button className="btn small quiet" onClick={() => toggle(id, false)}>
          Collapse
        </button>
      </div>
    ),
  };
  return [head, ...body, foot];
}

function TaskHeadActions({ t, onEdit, onAnother, onState, canBeDiscussion }: { t: Task; onEdit: () => void; onAnother?: () => void; onState: (s: TaskState) => void; canBeDiscussion: boolean }) {
  const { busy, error, act, move, toDiscussion } = useTaskActions(t, onState);
  const primary = primaryAction(t.state);
  const isOpen = OPEN.includes(t.state);
  return (
    <>
      <div className="row wrap task-actions">
        {primary && (
          <button className={`btn ${primary.tone}`} disabled={busy} onClick={() => act(primary.action)}>
            <Icon name={primary.icon} size={15} /> {primary.label}
          </button>
        )}
        {(t.state === 'planning' || t.state === 'waiting') && (
          <button className="btn" disabled={busy} onClick={() => act('start')}>
            <Icon name="play" size={15} /> Start now
          </button>
        )}
        <button className="btn quiet" onClick={onEdit}>
          <Icon name="edit" size={15} /> Edit
        </button>
        <span className="spacer" />
        <Menu
          label="More actions"
          items={[
            isOpen && { label: 'Move up', onSelect: () => move('up') },
            isOpen && { label: 'Move down', onSelect: () => move('down') },
            isOpen && { label: 'Move to top', onSelect: () => move('top') },
            !!onAnother && { label: 'Create another task from this', onSelect: onAnother },
            canBeDiscussion && movable(t) && { label: 'Move to discussions', onSelect: toDiscussion },
            isOpen && { label: 'Drop', onSelect: () => act('drop'), danger: true },
          ]}
        />
      </div>
      {error && <p className="error-text">{error}</p>}
    </>
  );
}

/** A task's timeline as thread lines: conversation as bubbles, the rest as inline cards. */
/** pin: offer Pin to top on previews and attachments (the owner's control of the pinned proposal). */
export function toThreadLines(items: TimelineItem[], s: ProjectState, directorName: string, pin?: PinCtx): ThreadLine[] {
  const pid = s.project.id;
  // Requests allowed automatically (Unrestricted, not flagged) pile up: consecutive ones become one collapsed line.
  const autoOf = (i: TimelineItem) => (i.type === 'question' && i.request?.decided_by === 'auto' ? i.request : null);
  const lines: ThreadLine[] = [];
  let run: InboxItem[] = [];
  const flush = () => {
    if (run.length) lines.push({ type: 'node', key: `auto-${run[0].id}`, ts: run[0].created_at, node: <AutoAllowedGroup items={run} /> });
    run = [];
  };
  for (const i of items) {
    const auto = autoOf(i);
    if (auto) {
      run.push(auto);
      continue;
    }
    flush();
    lines.push(threadLine(i, s, directorName, pid, pin));
  }
  flush();
  return lines;
}

function threadLine(i: TimelineItem, s: ProjectState, directorName: string, pid: string, pin?: PinCtx): ThreadLine {
  const attachmentAction = pin ? (a: Attachment) => <PinToggle ctx={pin} itemId={a.id} kind="attachment" /> : undefined;
  return ((i): ThreadLine => {
    if (i.type === 'message') {
      if (i.author === 'user') return { type: 'you', key: i.key, ts: i.ts, text: i.body, attachments: i.attachments, note: i.interject ? 'interjection' : undefined, attachmentAction };
      return { type: 'reply', key: i.key, ts: i.ts, text: i.body, name: i.name || directorName };
    }
    if (i.type === 'state') return { type: 'system', key: i.key, ts: i.ts, text: i.body };
    if (i.type === 'change') return { type: 'node', key: i.key, ts: i.ts, node: <ChangeCard body={i.body} ts={i.ts} projectId={pid} /> };
    // A discussion about a Spec entry: the entry as it read at the start, and the edits the director proposed (specdiscuss.tsx).
    if (i.type === 'spec') return { type: 'node', key: i.key, ts: i.ts, node: <SnapshotCard body={i.body} ts={i.ts} /> };
    if (i.type === 'proposal') return { type: 'node', key: i.key, ts: i.ts, node: <ProposalCard body={i.body} ts={i.ts} projectId={pid} /> };
    if (i.type === 'summary') {
      return {
        type: 'node',
        key: i.key,
        ts: i.ts,
        node: (
          <div className="tl-card tl-summary">
            <span className="msg-meta">
              <b>{i.name}</b> · status update · {clock(i.ts)}
            </span>
            <Markdown text={i.body} />
          </div>
        ),
      };
    }
    if (i.type === 'answer') {
      // Files sent with it show under it; an answer of files only has no words to repeat (the server notes "(sent a file)").
      const files = i.attachments?.length ? i.attachments : undefined;
      const body = i.status === 'dismissed' ? '_Dismissed_' : files && /^\(sent (a file|\d+ files)\)$/.test(i.body) ? '' : i.body;
      return { type: 'you', key: i.key, ts: i.ts, text: `**Re: ${i.title}**${body ? `\n\n${body}` : ''}`, attachments: files, attachmentAction };
    }
    if (i.type === 'question') {
      // Any request to the user: a question, a permission or a team change. Open, it has its answer controls
      // (the same action as on the list row); handled, it shows what was asked and the outcome.
      const item = i.request ?? s.inbox.find((x) => x.id === i.inbox_id);
      if (!item) return { type: 'system', key: i.key, ts: i.ts, text: 'A question was asked here.' };
      const asker = s.agents.find((a) => a.id === item.agent_id)?.name ?? item.agent_name;
      // The question of the pinned proposal is answered at the top of the page; here it only points there.
      if (pin?.linked === item.id) {
        return {
          type: 'node',
          key: i.key,
          ts: i.ts,
          node: (
            <div id={`req-hist-${item.id}`} className="tl-card tl-linked-req">
              <span className="msg-meta">
                <b>{asker ?? 'An agent'}</b> asked you · {clock(i.ts)}
              </span>
              <strong>{item.title}</strong>
              <button className="btn small quiet" onClick={() => document.querySelector('.prop-area')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
                <Icon name="top" size={14} /> Answer it in the proposal at the top
              </button>
            </div>
          ),
        };
      }
      return {
        type: 'node',
        key: i.key,
        ts: i.ts,
        node: (
          <div id={`req-${item.id}`} className="req-anchor">
            {['open', 'director', 'check'].includes(item.status) ? <InboxCard item={item} agentName={asker} /> : <RequestOutcome item={item} asker={asker} />}
          </div>
        ),
      };
    }
    if (i.type === 'consult') return { type: 'node', key: i.key, ts: i.ts, node: <ConsultCard c={i} /> };
    if (i.type === 'preview') {
      const tile = <PreviewTile p={i.preview} onOpen={() => go('p', pid, 'previews', i.preview.id)} />;
      if (!pin) return { type: 'node', key: i.key, ts: i.ts, node: tile };
      return {
        type: 'node',
        key: i.key,
        ts: i.ts,
        node: (
          <div className="tl-preview">
            {tile}
            <PinToggle ctx={pin} itemId={i.preview.id} kind="preview" />
          </div>
        ),
      };
    }
    const j = i as Extract<TimelineItem, { type: 'journal' }>;
    return {
      type: 'node',
      key: i.key,
      ts: i.ts,
      node: (
        <div className={`tl-card tl-journal jk-${j.kind}`}>
          <span className="msg-meta">
            <Tag tone={`jk-${j.kind}`}>{j.kind}</Tag> {j.name} · {clock(i.ts)}
          </span>
          <strong>{j.title}</strong>
          {j.body && <Markdown text={j.body} />}
        </div>
      ),
    };
  })(i);
}

/** An agent's question or review request to its manager, with the answer once given: one compact row. */
function ConsultCard({ c }: { c: Extract<TimelineItem, { type: 'consult' }> }) {
  const [open, setOpen] = useState(false);
  const review = c.kind === 'review';
  const outcome =
    c.status === 'open'
      ? 'waiting for an answer'
      : c.status === 'dropped'
        ? 'not answered'
        : review
          ? c.verdict === 'accepted' ? 'accepted' : c.verdict === 'changes_needed' ? 'changes needed' : 'answered'
          : 'answered';
  return (
    <div role="button" tabIndex={0} className={`tl-card tl-consult ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} onKeyDown={(e) => e.key === 'Enter' && setOpen(!open)} aria-expanded={open}>
      <span className="msg-meta">
        <b>{c.asker}</b> asked {c.manager}{review ? ' for review' : ''} · {clock(c.ts)}{' '}
        <Tag tone={c.status === 'open' ? 'tone-warning' : c.verdict === 'changes_needed' ? 'tone-serious' : 'st-done'}>{outcome}</Tag>
      </span>
      <div className={open ? '' : 'clamp'} style={{ ['--lines' as any]: 2 }}>
        <Markdown text={c.question} />
      </div>
      {c.status === 'answered' && (
        <div className="tl-consult-answer">
          <span className="msg-meta">
            <b>{c.manager}</b> answered{c.answered_at ? ` · ${clock(c.answered_at)}` : ''}
          </span>
          <div className={open ? '' : 'clamp'} style={{ ['--lines' as any]: 3 }}>
            <Markdown text={c.answer} />
          </div>
        </div>
      )}
    </div>
  );
}

/** "Needs from you": what the director says the task needs (update_task needs_from_user), tied to its request. */
function NeedsFromYou({ t, pid }: { t: Task; pid: string }) {
  const req = t.requests.find((r) => r.id === t.needs_request_id);
  return (
    <div className="needs-from-you">
      <span className="label">Needs from you</span>
      <Markdown text={t.needs_from_user ?? ''} />
      {req ? (
        <a href={href('p', pid, 'tasks', t.id, req.id)}>{req.kind === 'action' ? 'To do' : 'Answer'} →</a>
      ) : (
        <span className="muted small">(no request open)</span>
      )}
    </div>
  );
}
