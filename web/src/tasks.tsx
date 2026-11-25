import { useEffect, useMemo, useRef, useState } from 'react';
import { isFinished, isSubagent } from './agentlists';
import { ShareButton } from './share';
import { TaskTestBuilds } from './testbuilds';
import { ConsolidateButton, ConsolidationCard } from './consolidate';
import { EntriesCard, FindingsCard } from './specwork';
import { useStoredForm } from './drafts';
import type { ReactNode } from 'react';
import { ApiError, api, prefetch, useLive } from './api';
import type { Agent, Origin, Preview, ProjectState, TaskPart, Task, TaskDetail, TaskState, TimelineItem, Attachment } from './api';
import { InboxCard, RequestOutcome } from './inbox';
import { TaskTimeCard } from './tasktime';
import { AutoAllowedGroup } from './decisions';
import type { InboxItem } from './api';
import { NeedsGroup, needsResponse } from './needs';
import { PreviewThumb, PreviewTile, hasThumb } from './preview';
import { Checklist } from './project';
import { openChat } from './chat';
import { ConcludeButton, DiscussionView, NewTaskSheet, ThreadLinks } from './discussions';
import { lazyNamed, loadReleases, loadReports } from './lazy';
const RecipeProposalCard = lazyNamed<{ body: string; s: ProjectState }>(loadReleases, 'RecipeProposalCard');
const TaskReports = lazyNamed<{ reports: import('./api').Report[]; pid: string; inline?: boolean }>(loadReports, 'TaskReports');
import { TaskScopeBlock } from './dashscope';
import { Thread } from './thread';
import { ChangeCard, TaskSpecBlock } from './spec';
import { ProposalCard, SnapshotCard } from './specdiscuss';
import { useDragReorder } from './drag';
import { ImportancePicker, ImportanceTag, LEVEL, TieredList, recentChange } from './importance';
import type { ThreadLine } from './thread';
import { ClipCount, References } from './attachments';
import { NeedsYou, PlanBlock, TaskAgents, TaskCommands, TaskTiming } from './tasknow';
import { TaskPreviews } from './previewlist';
import { PinToggle, ProposalArea, ProposalStrip, linkedRequestId, pinCtx } from './proposal';
import { Fold, FoldHead, StickyHead, jumpTo, useFold } from './fold';
import type { PinCtx } from './proposal';
import { Chips, Clamp, EdgeProgress, Empty, Icon, Markdown, Sheet, Status, Tag, ago, clock, go, href, modelLabel, useAction, PlainRefs, openPreview } from './ui';
import { RunTimer, withPeriodDividers } from './sessions';
import { QuickDone } from './team';
import { tokensText } from './usage.ts';
import { when } from './time';
import { TaskStanding, TaskStatus } from './taskstatus';

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

type Action = 'approve' | 'start' | 'interrupt' | 'resume' | 'drop' | 'unschedule';

/** The one-tap action a task offers in its state, if any. */
function primaryAction(state: TaskState): { action: Action; label: string; icon: string; tone: string } | null {
  if (state === 'planning') return { action: 'approve', label: 'Approve', icon: 'check', tone: 'primary' };
  if (state === 'waiting') return { action: 'approve', label: 'Schedule', icon: 'plus', tone: '' };
  if (state === 'scheduled') return { action: 'start', label: 'Start now', icon: 'play', tone: '' };
  if (state === 'active') return { action: 'interrupt', label: 'Interrupt', icon: 'stop', tone: '' };
  if (state === 'paused') return { action: 'resume', label: 'Resume', icon: 'play', tone: 'primary' };
  return null;
}

/**
 * The control beside the bell on a Work row, one tap and no confirmation (undone by the same control): Pause an Active
 * task (it stops its agents) and Resume a Paused one; Start now on a Scheduled task (Unschedule is in its menu) and
 * Schedule a Waiting one.
 */
function quickAction(state: TaskState): { action: Action; label: string; icon: string } | null {
  if (state === 'active') return { action: 'interrupt', label: 'Pause', icon: 'pause' };
  if (state === 'paused') return { action: 'resume', label: 'Resume', icon: 'play' };
  if (state === 'scheduled') return { action: 'start', label: 'Start now', icon: 'play' };
  if (state === 'waiting') return { action: 'approve', label: 'Schedule', icon: 'plus' };
  return null;
}

function useTaskActions(task: Task, onDone?: (state: TaskState) => void) {
  const { busy, error, run } = useAction();
  const act = (action: Action) => {
    if (action === 'drop' && !confirm(`Drop the task “${task.title}”? The director is told to stop any work on it.`)) return;
    void run(async () => {
      try {
        await api(`/api/tasks/${task.id}/${action}`, { method: 'POST', body: {} });
      } catch (err) {
        // Winding down, at rest or stopped (server/projectmode.ts): starting a task asks first, and starts only it.
        if (!(err instanceof ApiError && err.data?.needsConfirm)) throw err;
        if (!confirm(err.message)) return;
        await api(`/api/tasks/${task.id}/${action}`, { method: 'POST', body: { anyway: true } });
      }
      const to: Record<Action, TaskState> = { approve: 'scheduled', start: 'active', interrupt: 'paused', resume: 'active', drop: 'dropped', unschedule: 'waiting' };
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

const TIMELINE_KEY = 'helm.work.timeline';
const TimelineView = lazyNamed<{ s: ProjectState }>(() => import('./timeline'), 'TimelineView');

/** `embedded`: a section of the Work page (work.tsx), under its heading. */
export function TasksSection({ s, page = false, initialSort = 'queue', embedded = false }: { s: ProjectState; page?: boolean; initialSort?: TaskSort; embedded?: boolean }) {
  const [sort, setSort] = useState<TaskSort>(initialSort);
  const [showClosed, setShowClosed] = useState(false);
  // The Timeline (timeline.tsx) instead of the list, on the Work page; remembered on this device.
  const canTimeline = page && initialSort !== 'needs';
  const [timelineOn, setTimelineOn] = useState(() => localStorage.getItem(TIMELINE_KEY) === '1');
  const timeline = canTimeline && timelineOn;
  const showTimeline = (on: boolean) => {
    setTimelineOn(on);
    localStorage.setItem(TIMELINE_KEY, on ? '1' : '0');
  };
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
  // Dragging a Scheduled row (by its handle) into the Active section starts it, as Start now does.
  const [dragging, setDragging] = useState(false);
  const [overActive, setOverActive] = useState(false);
  const startTask = (id: string) => {
    const act = async (anyway: boolean) => api(`/api/tasks/${id}/start`, { method: 'POST', body: anyway ? { anyway: true } : {} });
    setStateOverride((o) => ({ ...o, [id]: 'active' }));
    void act(false)
      .catch(async (err) => {
        // Winding down, at rest or stopped: starting a task asks first, and starts only it.
        if (!(err instanceof ApiError && err.data?.needsConfirm) || !confirm(err.message)) throw err;
        await act(true);
      })
      .catch(() => setStateOverride((o) => { const n = { ...o }; delete n[id]; return n; }));
  };
  const setState = (id: string) => (state: TaskState) => setStateOverride((o) => ({ ...o, [id]: state }));

  const row = (t: Task, reorder?: ReorderProps) => <TaskRow key={t.id} t={t} s={s} onEdit={() => setEditing(t)} onState={setState(t.id)} reorder={reorder} showState={sort !== 'queue'} />;

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
      {/* One row: the order on the left, Add on the right. */}
      <div className="section-head tasks-head">
        {page && !embedded && <h1 className="page-title">Tasks</h1>}
        {canTimeline && (
          <Chips value={timeline ? 'timeline' : 'list'} onChange={(v) => showTimeline(v === 'timeline')} options={[{ id: 'list', label: 'List' }, { id: 'timeline', label: 'Timeline' }]} />
        )}
        {tasks.length > 0 && !timeline && (
          <label className="sort">
            <select aria-label="Order" value={sort} onChange={(e) => setSort(e.target.value as TaskSort)}>
              <option value="queue">Queue order</option>
              <option value="importance">Priorities</option>
              <option value="state">State</option>
              <option value="updated">Recently updated</option>
              <option value="needs">Needs response only</option>
            </select>
          </label>
        )}
        <span className="spacer" />
        {/* A discussion with the director about merging, ordering or chaining the tasks not running (consolidate.tsx). */}
        <ConsolidateButton pid={s.project.id} />
        <button className="btn small" onClick={() => setEditing('new')}>
          <Icon name="plus" size={16} /> Add task
        </button>
      </div>
      {timeline ? <TimelineView s={s} /> : <>
      <NeedsGroup list={needs} />
      {sort === 'needs' && <NeedsGroup list={discNeeds} title="Discussions needing response" />}
      {sort === 'needs' && !needs.length && !discNeeds.length && <Empty title="Nothing needs you" />}
      {sort === 'needs' && (
        <p className="muted small decisions-link">
          <a href={href('p', s.project.id, 'setup', 'decisions')}>Decisions made for you</a>
        </p>
      )}
      {tasks.length === 0 && sort !== 'needs' && (
        <Empty title="No tasks yet" />
      )}

      {sort === 'queue' &&
        GROUPS.map((g) => {
          // Within a group, tasks waiting on others go after the ready ones (a stable sort keeps the queue order).
          const list = open.filter((t) => g.states.includes(t.state)).sort((a, b) => Number(blocked(a)) - Number(blocked(b)));
          // While a Scheduled row is dragged, an empty Active section shows as the place to drop it.
          if (!list.length && !(g.id === 'active' && dragging)) return null;
          return (
            <div key={g.id} className={`task-group group-${g.id} ${g.id === 'active' && dragging ? 'drop-target' : ''} ${g.id === 'active' && overActive ? 'drop-over' : ''}`}>
              <h3 className="group-title">
                {g.title}
              </h3>
              {g.id === 'scheduled' ? <ReorderList tasks={list} render={row} onMove={moveScheduled} onDragging={setDragging} onOverActive={setOverActive} onActivate={startTask} /> : <div className="stack">{list.map((t) => row(t))}</div>}
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
                  {i.pinned && <Icon name="pin" size={16} />}
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
            <Icon name="chevron" size={16} /> Done and dropped <span className="muted">{closed.length}</span>
          </button>
          {showClosed && <div className="stack">{closed.map((t) => row(t))}</div>}
        </div>
      )}
      </>}
      {editing && <TaskEditor s={s} task={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </section>
  );
}

// ---------- drag to reorder (touch and mouse), with menu moves as the fallback ----------

type ReorderProps = { handle: ReactNode; dragging: boolean; offset: number };

function ReorderList({ tasks, render, onMove, onDragging, onOverActive, onActivate }: { tasks: Task[]; render: (t: Task, r: ReorderProps) => ReactNode; onMove: (ids: string[], id: string, to: number) => void; onDragging?: (on: boolean) => void; onOverActive?: (on: boolean) => void; onActivate?: (id: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const ids = tasks.map((t) => t.id);
  const toRef = useRef<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const overRef = useRef(false);
  // Is the pointer inside the Active section (the drop target for starting the task)?
  const inActive = (y: number) => {
    const r = box.current?.closest('.tasks')?.querySelector('.group-active')?.getBoundingClientRect();
    return !!r && y >= r.top && y <= r.bottom;
  };
  // Where the dragged row would land: the number of other rows whose middle is above the pointer.
  const { drag, gripProps, rowProps } = useDragReorder({
    onMove: (id, y) => {
      const rows = [...(box.current?.children ?? [])] as HTMLElement[];
      toRef.current = rows.filter((r, i) => ids[i] !== id && r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2 < y).length;
      setTo(toRef.current);
      const over = !!onActivate && inActive(y);
      if (over !== overRef.current) {
        overRef.current = over;
        onOverActive?.(over);
      }
    },
    onDrop: (id) => {
      const dest = toRef.current;
      toRef.current = null;
      setTo(null);
      const over = overRef.current;
      overRef.current = false;
      onOverActive?.(false);
      if (over && onActivate) return onActivate(id);
      if (dest !== null && dest !== ids.indexOf(id)) onMove(ids, id, dest);
    },
  });
  const from = drag ? ids.indexOf(drag.id) : -1;
  const isDragging = !!drag;
  useEffect(() => {
    onDragging?.(isDragging);
  }, [isDragging]);

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

function TaskRow({ t, s, onEdit, onState, reorder, showState = true }: { t: Task; s: ProjectState; onEdit: () => void; onState: (st: TaskState) => void; reorder?: ReorderProps; showState?: boolean }) {
  const { busy, error, act, move, toDiscussion } = useTaskActions(t, onState);
  const primary = primaryAction(t.state);
  const [waitsOpen, setWaitsOpen] = useState(false);
  // The agent named on the row: one working on the task (an engineer the driver started, often), else the driver.
  const live = s.agents.find((a) => (a.id === t.driver?.id || a.task_id === t.id) && (a.status === 'working' || a.status === 'waiting')) ?? s.agents.find((a) => a.id === t.driver?.id);
  const isOpen = OPEN.includes(t.state);
  const link = href('p', s.project.id, 'tasks', t.id);
  // One meta line under the title, the same on every row: priority, reports, what it waits for, running time.
  // (No excerpt of the thread or the agent's status: that is in the task.)
  const quick = t.kind !== 'discussion' ? quickAction(t.state) : null;
  const merged = t.merged_into ? `Merged into ${t.merged_into_title ?? 'another task'}` : '';
  const fromReports = t.report_count ? `From ${t.report_count} ${t.report_count === 1 ? 'report' : 'reports'}` : '';
  const flag = t.kind !== 'discussion' && t.state === 'active' && (t.stalled || t.awaiting_review);
  // Done: a muted check before the title and "Done · time" in the meta line, instead of the state badge on the right.
  const done = t.state === 'done' && !t.merged_into;

  return (
    <article className={`card task task-${t.state} ${reorder?.dragging ? 'dragging' : ''}`} data-kctx={`task:${t.id}`} data-kpreview={t.thumb ? `${t.project_id}/${t.thumb.id}` : undefined}>
      <div className="task-top">
        {reorder?.handle}
        <a className="task-link" href={link} onPointerEnter={() => prefetch(`/api/tasks/${t.id}`)} onTouchStart={() => prefetch(`/api/tasks/${t.id}`)}>
          <div className="task-title-row">
            <h3>
              {done && <span className="task-done-check"><Icon name="check" size={16} /></span>}
              {t.title}
              <ClipCount n={t.attach_count} />
            </h3>
            {t.merged_into ? <Tag tone="task-st ts-dropped">Merged</Tag> : !blocked(t) && !done && (showState || !isOpen) && <TaskStateTag state={t.state} />}
          </div>
          {(t.kind !== 'discussion' || done) && (
            <div className="task-meta small">
              {done && <span className="muted">Done{t.finished_at ? ` · ${when(t.finished_at)}` : ''}</span>}
              {/* Priority stays on every row; tap it to change, or drag in Priority order. */}
              {t.kind !== 'discussion' && <ImportanceButton t={t} />}
              {merged && <span className="muted">{merged}</span>}
              {fromReports && <span className="muted">{fromReports}</span>}
              {/* What it waits for (instead of its state), or what waits on it. */}
              {isOpen && <WaitsLine t={t} pid={s.project.id} only={blocked(t) ? 'waits' : 'blocks'} />}
              {flag ? <TaskTiming t={t} /> : t.state === 'active' ? <RunTimer t={t} check={t.check} /> : null}
            </div>
          )}
          <ProposalStrip p={t.proposal} />
        </a>
        {/* The latest previews show as the thumbnails above (ProposalStrip); the menu, and under it how long it has run. */}
        <div className="task-side">
        <div className="task-side-top">
        {/* Bell, the one-tap control and the menu: three slots of one width, so they line up on every row. */}
        <span className="task-slot"><BellButton t={t} /></span>
        <span className="task-slot">
          {quick && (
            <button className={`icon-btn task-quick ${quick.action === 'start' ? 'start' : ''}`} disabled={busy} aria-label={`${quick.label}: ${t.title}`} title={quick.label} onClick={(e) => (e.preventDefault(), e.stopPropagation(), act(quick.action))}>
              <Icon name={quick.icon} size={20} />
            </button>
          )}
        </span>
        <Menu
          label={`More actions for ${t.title}`}
          items={[
            // A Scheduled row shows Start now as its own button; its menu has Unschedule instead.
            primary && t.state !== 'scheduled' ? { label: primary.label, onSelect: () => act(primary.action) } : false,
            t.state === 'scheduled' && t.kind !== 'discussion' && { label: 'Unschedule', onSelect: () => act('unschedule') },
            t.state === 'paused' && t.kind !== 'discussion' && { label: 'Schedule', onSelect: () => act('approve') },
            { label: 'Edit', onSelect: onEdit },
            isOpen && t.kind !== 'discussion' && { label: 'Waits for…', onSelect: () => setWaitsOpen(true) },
            (t.state === 'planning' || t.state === 'waiting') && !blocked(t) && { label: 'Start now', onSelect: () => act('start') },
            isOpen && { label: 'Move up', onSelect: () => move('up') },
            isOpen && { label: 'Move down', onSelect: () => move('down') },
            isOpen && { label: 'Move to top', onSelect: () => move('top') },
            movable(t) && { label: 'Move to discussions', onSelect: toDiscussion },
            isOpen && { label: 'Drop', onSelect: () => act('drop'), danger: true },
          ]}
        />
        </div>
        </div>
      </div>
      {waitsOpen && <WaitsPicker t={t} s={s} onClose={() => setWaitsOpen(false)} />}
      {t.waiting_on_user_without_request && <UnfiledNeed t={t} compact />}
      {error && <p className="error-text">{error}</p>}
      {isOpen && <EdgeProgress value={(live ?? t.driver)?.progress} live={(live ?? t.driver)?.status === 'working'} />}
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
        <Icon name="inbox" size={16} /> {compact ? 'Says it needs you, nothing filed' : 'Says it needs you, but nothing was filed'}
      </span>
      {!compact && t.unfiled_need && <q className="small one-line">{t.unfiled_need}</q>}
      <button className={`btn ${compact ? 'quiet small' : ''}`} disabled={busy || asked} onClick={() => void run(async () => { await api(`/api/tasks/${t.id}/ask-needs`, { method: 'POST' }); setAsked(true); })}>
        {asked ? 'Asked the director' : compact ? 'Ask the director' : 'Ask the director what it needs'}
      </button>
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

// ---------- add / edit ----------

function TaskEditor({ s, task, onClose }: { s: ProjectState; task: Task | null; onClose: () => void }) {
  // A task being written or edited keeps what is typed until it is saved (drafts.ts).
  const draftKey = task ? `task-edit:${task.id}` : `new-task:${s.project.id}`;
  const [form, setForm, clearForm] = useStoredForm(draftKey, { title: task?.title ?? '', description: task?.description ?? '', doc_id: task?.doc_id ?? '', scheduled: false });
  const { busy, error, run } = useAction();
  const docs = s.docs.filter((d) => d.kind === 'entry' || d.kind === 'goal' || d.kind === 'design');
  const save = async () => {
    const body = { title: form.title, description: form.description, doc_id: form.doc_id || null, scheduled: form.scheduled };
    const done = await run(() => (task ? api(`/api/tasks/${task.id}`, { method: 'PATCH', body }) : api(`/api/projects/${s.project.id}/tasks`, { body })));
    if (done) {
      clearForm();
      onClose();
    }
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

/** The latest status summary's first line: one muted line on the title card and its strip. */
function statusLineOf(t: Task) {
  return t.status_summary ? (
    <p className="task-head-status muted small one-line" title={t.status_summary}>
      <PlainRefs text={t.status_summary.split('\n')[0]} strip />
    </p>
  ) : null;
}

/**
 * What the task's title card holds, shared by the task page and Home's running cards: state, importance, running time and
 * share; the title; the status line; its agents with what each is doing now; the commands running; and Interrupt /
 * Interject / Edit, the bell and the menu. `shot`: the latest preview as a large panel on the card's right (above the
 * rest on a phone), which Home turns on.
 */
export function TaskHeadBody({ t, pid, agents, driverId, commands, reportCount = 0, shot, titleHref, onState, onEdit, onWaits, onAnother, canBeDiscussion }: { t: Task; pid: string; agents: Agent[]; driverId?: string | null; commands?: TaskDetail['commands']; reportCount?: number; shot?: Preview | null; titleHref?: string; onState: (s: TaskState) => void; onEdit: () => void; onWaits?: () => void; onAnother?: () => void; canBeDiscussion: boolean }) {
  const statusLine = statusLineOf(t);
  const picture = hasThumb(shot);
  const main = (
    <>
        <div className="row task-head-meta">
          <TaskStateTag state={t.state} />
          {t.kind !== 'discussion' && <ImportanceButton t={t} />}
          <span className="spacer" />
          {/* One line, right-aligned: "took 47 min · 2 min ago"; " ago" goes first when the row is narrow (styles.css). */}
          <span className="muted small task-head-when">
            <TaskTiming t={t} />
            {t.started_at && t.state !== 'dropped' ? ' · ' : ''}
            {ago(t.updated_at).replace(/ ago$/, '')}
            {/ ago$/.test(ago(t.updated_at)) && <span className="task-head-ago"> ago</span>}
          </span>
          <ShareButton route={href('p', pid, 'tasks', t.id)} title={t.title} />
        </div>
        {t.origin === 'away' && t.origin_note && <p className="found-note small"><span className="tag tone-warning">Found while away</span> {t.origin_note}</p>}
        <h1 className="page-title">
          {titleHref ? (
            <a className="head-title-link" href={titleHref}>
              {t.title}
            </a>
          ) : (
            t.title
          )}
        </h1>
        {/* The progress check's reason, spelled out: a phone has no hover (server/progress.ts). */}
        {t.check && <p className="task-head-check small one-line" title={t.check}><span className="task-check">Check:</span> {t.check}</p>}
        {statusLine}
        {/* The reports it is for: one muted line; they are listed in About. */}
        {reportCount > 0 && (
          <button type="button" className="task-head-reports muted small" onClick={() => jumpTo('.task-about', { fold: 'about' })}>
            From {reportCount} {reportCount === 1 ? 'report' : 'reports'}
          </button>
        )}
        {OPEN.includes(t.state) && <TaskAgents agents={agents} driverId={driverId} pid={pid} />}
        {OPEN.includes(t.state) && <TaskCommands commands={commands} />}
    </>
  );
  const actions = <TaskHeadActions t={t} tokens={tokensText(t.tokens)} onWaits={onWaits} onEdit={onEdit} onAnother={onAnother} onState={onState} canBeDiscussion={canBeDiscussion} />;
  return shot && picture ? (
    <>
        {shot && picture && (
          <button type="button" className="task-head-shot" onClick={() => openPreview(pid, shot.id)} aria-label={`Open the latest preview: ${shot.title}`}>
            <PreviewThumb p={shot} />
          </button>
        )}
      <div className="task-head-main">{main}</div>
      {/* The actions run along the card's whole bottom, under the text and the preview. */}
      <div className="task-head-foot">{actions}</div>
    </>
  ) : (
    <>
      {main}
      {actions}
    </>
  );
}

/**
 * A running task on Home: the task page's title card itself (TaskHeadBody), so Share, the importance, Interrupt,
 * Interject, Edit, the bell and the menu come with it, with the latest preview as a large panel on its right.
 */
export function RunningTaskCard({ s, t: row }: { s: ProjectState; t: Task }) {
  const pid = s.project.id;
  const [editing, setEditing] = useState(false);
  const [waitsOpen, setWaitsOpen] = useState(false);
  const [another, setAnother] = useState(false);
  const [override, setOverride] = useState<TaskState | null>(null);
  useEffect(() => setOverride(null), [row.state, row.updated_at]);
  const t = override ? { ...row, state: override } : row;
  const agents = s.agents.filter((a) => a.task_id === t.id || a.id === t.driver?.id);
  const shot = hasThumb(t.thumb) ? t.thumb : null;
  return (
    <>
      {/* The title is a link and the card's empty space opens the task too; buttons, links, the preview panel and the menus keep their own taps. */}
      <header
        className={`card task-head home-run ${shot ? 'with-shot' : ''}`}
        data-kctx={`task:${t.id}`}
        data-kpreview={shot ? `${t.project_id}/${shot.id}` : undefined}
        onClick={(e) => {
          if (e.defaultPrevented || (e.target as HTMLElement).closest('a, button, input, textarea, select, summary, [role="menu"], [role="dialog"]')) return;
          go('p', pid, 'tasks', t.id);
        }}
      >
        <TaskHeadBody t={t} pid={pid} agents={agents} driverId={t.driver?.id} shot={shot} titleHref={href('p', pid, 'tasks', t.id)} onWaits={() => setWaitsOpen(true)} onEdit={() => setEditing(true)} onAnother={t.became_task_at ? () => setAnother(true) : undefined} onState={setOverride} canBeDiscussion={!agents.length} />
      </header>
      {editing && <TaskEditor s={s} task={t} onClose={() => setEditing(false)} />}
      {waitsOpen && <WaitsPicker t={t} s={s} onClose={() => setWaitsOpen(false)} />}
      {another && <NewTaskSheet from={t} another onClose={() => setAnother(false)} />}
    </>
  );
}

export function TaskPage({ s, taskId, tab }: { s: ProjectState; taskId: string; tab: string }) {
  const pid = s.project.id;
  // Live: the project's changes, and every event of an agent on this task (its Status shows the call in progress).
  const onTask = useRef<Set<string>>(new Set());
  const { data, error } = useLive<TaskDetail>(`/api/tasks/${taskId}`, (m) => (m.type === 'project' && m.projectId === pid) || (m.type === 'event' && onTask.current.has(m.agentId)));
  onTask.current = new Set((data?.agents ?? []).filter((a) => a.on_task || a.role_id === 'subagent').map((a) => a.id));
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState(false);
  const [waitsOpen, setWaitsOpen] = useState(false);
  const [another, setAnother] = useState(false);
  // Which discussion blocks the reader opened or closed; unset means the default (collapsed when long).
  const [eraOpen, setEraOpen] = useState<Record<string, boolean>>({});
  const toggleEra = (id: string, open: boolean) => setEraOpen((m) => ({ ...m, [id]: open }));
  const [override, setOverride] = useState<TaskState | null>(null);
  useEffect(() => setOverride(null), [data]);
  const [histOpen, toggleHist] = useFold('history', true);
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
  const working = root?.status === 'working' ? { name: root.name, line: root.status_line } : driver?.status === 'working' ? { name: driver.name, line: driver.status_line } : null;
  // Everyone on the task, with live status from the project state.
  const liveAgents = [driver, ...others].filter((a): a is Agent => !!a);
  const closed = t.state === 'done' || t.state === 'dropped';
  // Open tasks reply through the chat (Interject or Message on the title card, and the docked bar); a closed one keeps the history's own composer.
  const docked = !closed;
  // The latest status summary: one muted line on the title card and its strip (the whole text is in the History).
  const statusLine = statusLineOf(t);
  // Every agent on the task and what each is doing now (tasknow.tsx); the strip keeps the first working one.
  const driverLine = OPEN.includes(t.state) && <TaskAgents agents={liveAgents} driverId={driver?.id} pid={pid} />;
  const stripAgent = OPEN.includes(t.state) && <TaskAgents agents={liveAgents} driverId={driver?.id} pid={pid} max={1} />;
  // Jumps to the page's sections that exist, on the strip once the title card is scrolled away: one line, sideways if needed.
  const hasReview = !!data.proposal || !!data.review?.items?.length || !!t.needs_from_user || !!t.waiting_on_user_without_request || (t.requests ?? []).some((r) => r.status === 'open');
  const jumps = (
    <nav className="title-strip-jumps" aria-label="Jump to">
      {hasReview && (
        <button type="button" onClick={() => jumpTo('.prop-area, .needs-from-you, .unfiled-need, .now-needs')}>
          Review
        </button>
      )}
      <button type="button" onClick={() => jumpTo('.task-thread, .task-thread-folded', { fold: 'history' })}>
        History
      </button>
      <button type="button" onClick={() => jumpTo('.task-about', { fold: 'about' })}>
        About
      </button>
      <button type="button" onClick={() => jumpTo('.task-thread', { fold: 'history', end: true })}>
        Latest
      </button>
    </nav>
  );

  return (
    <section className="task-page">
      <a className="back" href={href('p', pid, 'work', 'tasks')}>
        <Icon name="back" size={16} /> Work
      </a>

      {/* The title card; once scrolled away, a compact strip of it stays under the top bar (fold.tsx). */}
      <StickyHead
        className="card task-head"
        strip={
          <>
            <div className="row title-strip-top">
              <TaskStateTag state={t.state} />
              <strong className="title-strip-title one-line">{t.title}</strong>
              <ChatButton t={t} compact />
            </div>
            {statusLine}
            {stripAgent}
            {jumps}
          </>
        }
      >
        <TaskHeadBody t={t} pid={pid} agents={liveAgents} driverId={driver?.id} commands={data.commands} reportCount={data.reports?.length ?? 0} onWaits={() => setWaitsOpen(true)} onEdit={() => setEditing(true)} onAnother={became ? () => setAnother(true) : undefined} onState={setOverride} canBeDiscussion={!data.agents.length} />
      </StickyHead>

      {/* Where it stands at a glance: worklist, latest status, Done when, evidence, time against similar tasks. */}
      <TaskStatus t={t} data={data} pid={pid} />

      {/* About this task: right under the title, collapsed unless the user opened it (remembered on this device). */}
      <Fold kind="about" title="About this task" openByDefault={false} className="task-about" label="About this task">
        {/* Several parts: each with its source and its own Features and Done when, the merged picture in one place. */}
        {/* The details kept off the rows and the header: its tier, parts and waits. */}
        {/* Where it stands, then the one Done when list, ticked as items are met (Status only counts it). */}
        <TaskStanding t={t} doneWhen={data.status?.done_when ?? []} />
        <TaskDetails t={t} pid={pid} parts={data.parts?.length ?? 0} parallel={data.parallel} />
        {(data.parts?.length ?? 0) > 1 ? <TaskParts parts={data.parts!} /> : t.state === 'planning' ? <p className="muted small">The plan is at the top of the page.</p> : t.description ? <TaskDescription text={t.description} /> : <p className="muted">No description yet.</p>}
        {/* Its Spec entries and related work as links (server/taskrefs.ts); the Spec card keeps only what it changed. */}
        <TaskRefs refs={data.references} />
        {data.reports && <TaskReports reports={data.reports} pid={pid} inline />}
        <TaskTestBuilds builds={data.test_builds} pid={pid} />
        <ThreadLinks pid={pid} label="From the discussion" links={t.discussions ?? []} />
        <ThreadLinks pid={pid} label="Also led to" links={t.tasks ?? []} />
        <References projectId={pid} owner={`task:${t.id}`} version={t.attach_count} title="Files" />
        {(driver || others.length > 0) && (
          <div className="task-agents">
            <span className="label">Agents on it</span>
            {/* A finished subagent shows in the History only (its end is posted there, server/subagents.ts). */}
            {taskAgentRows(driver, others.filter((a) => !(isSubagent(a) && isFinished(a)))).map(({ a, done }) =>
              done ? (
                <QuickDone key={`${a.id}-done`} helpers={done} pid={pid} depth={1} />
              ) : (
              <details key={a.id} className={`task-agent ${a.quick ? 'quick' : ''}`} open={a.id === driver?.id && OPEN.includes(t.state) && !isFinished(a)}>
                <summary>
                  <a href={href('p', pid, 'agents', a.id)}>{a.name}</a>
                  {a.id === driver?.id && <span className="muted small"> · driver</span>}
                  {a.quick ? <span className="muted small"> · quick job</span> : null}
                  <span className="spacer" />
                  {isFinished(a) ? <span className="muted small">finished</span> : <Status status={a.status} />}
                </summary>
                {a.checklist?.length ? <Checklist agent={a} /> : a.quick ? <Clamp text={a.task} lines={3} /> : <p className="muted small">No worklist yet.</p>}
              </details>
              ),
            )}
          </div>
        )}
        <TaskSpecBlock projectId={pid} spec={data.references && data.spec ? { ...data.spec, implements: [] } : data.spec} />
        <NoSpecLine t={t} spec={data.spec} pid={pid} />
        {/* Time to ship, under its own name: created to done on the clock, and where it went (server/worktime.ts). */}
        {t.ship_text && <p className="muted small task-ship">{t.ship_text.charAt(0).toUpperCase() + t.ship_text.slice(1)}</p>}
      </Fold>

      {/* A planning task leads with its plan: the requests on it are about the plan. */}
      {t.state === 'planning' && <PlanBlock text={t.description} />}
      {/* The pinned proposal: the options the director asks the user to look at, with the question to choose (proposal.tsx). */}
      {/* With the latest previews, pinned by Helm itself (server/pins.ts autoPin). */}
      <ProposalArea proposal={data.proposal} taskId={t.id} pid={pid} s={s} />
      {/* Every preview of the task, its latest version first (previewlist.tsx); the pinned proposal's options stay above. */}
      <TaskPreviews s={s} taskId={t.id} exclude={(data.proposal?.items ?? []).map((i) => i.item_id)} />
      {t.needs_from_user && <NeedsFromYou t={t} pid={pid} />}
      {t.waiting_on_user_without_request && <UnfiledNeed t={t} />}
      <NeedsYou t={t} s={s} except={linkedRequestId(data.proposal)} />

      {data.dashboard && (
        <a className="card task-dashboard-link" href={href('p', pid, 'dashboards', data.dashboard.id)}>
          <Icon name="dashboards" size={20} /> <span className="one-line">Dashboard: {data.dashboard.title}</span>
          <Tag tone={data.dashboard.state === 'ready' ? 'st-done' : 'tone-warning'}>{data.dashboard.state === 'ready' ? 'Ready' : 'Being built'}</Tag>
        </a>
      )}
      {!histOpen ? (
        <section className="card fold closed task-thread-folded" aria-label={`History of ${t.title}`}>
          <FoldHead open={false} onToggle={toggleHist} title="History" />
        </section>
      ) : (
      <Thread
        className="task-thread"
        label={`History of ${t.title}`}
        head={
          <div className="task-thread-head">
            <FoldHead open onToggle={toggleHist} title="History" />
            <Chips
              value={filter}
              onChange={setFilter}
              options={[
                { id: 'all', label: 'All' },
                { id: 'conversation', label: 'Conversation' },
                { id: 'previews', label: 'Previews' },
                { id: 'decisions', label: 'Decisions' },
              ]}
            />
          </div>
        }
        lines={lines}
        loaded
        working={filter === 'all' || filter === 'conversation' ? working : null}
        // The message box under the newest entry, always: Send asks without changing the work; while an agent works on
        // the task, Interject beside it stops the work to re-evaluate (server: taskapi.ts sendThreadMessage).
        second={t.state === 'active' && liveAgents.some((a) => a.status === 'working' || a.status === 'waiting') ? { label: 'Interject', empty: true, onSend: (text, attachments) => api(`/api/tasks/${t.id}/message`, { body: { text, attachments, interject: true } }) } : undefined}
        empty={<div className="convo-empty">{filter === 'all' ? <p>Nothing said about this task yet. Ask the director anything about it here.</p> : <p>Nothing of this kind yet.</p>}</div>}
        placeholder={closed ? 'Message about this task' : 'Ask or tell the director about this task'}
        onSend={(text, attachments) => api(`/api/tasks/${t.id}/message`, { body: { text, attachments } })}
        attachTo={pid}
        draftKey={`thread:${t.id}`}
      />
      )}

      {/* The bottom of the page: History, then where the time went, then the dashboard tiles the task affected. */}
      {t.kind !== 'discussion' && t.started_at && <TaskTimeCard taskId={t.id} />}
      {data.dashboards && <TaskScopeBlock scope={data.dashboards} pid={pid} />}

      {editing && <TaskEditor s={s} task={t} onClose={() => setEditing(false)} />}
      {waitsOpen && <WaitsPicker t={t} s={s} onClose={() => setWaitsOpen(false)} />}
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
/**
 * A description written as "## Features" and "## Done when" (the director's convention) shows as those two parts,
 * with any text before them first; one without them shows as written.
 */
export function splitDescription(text: string): { lead: string; parts: { label: string; body: string }[] } | null {
  const heads = [...text.matchAll(/^#{1,3}\s*(Features|Done when)\s*:?\s*$/gim)];
  if (!heads.length) return null;
  const parts = heads.map((h, i) => ({
    label: /^f/i.test(h[1]) ? 'Features' : 'Done when',
    body: text.slice(h.index! + h[0].length, i + 1 < heads.length ? heads[i + 1].index : undefined).trim(),
  }));
  return { lead: text.slice(0, heads[0].index).trim(), parts: parts.filter((p) => p.body) };
}

function TaskDescription({ text }: { text: string }) {
  const split = splitDescription(text);
  if (!split) return <Markdown text={text} />;
  return (
    <div className="task-desc">
      {split.lead && <Markdown text={split.lead} />}
      {split.parts.map((p, i) => (
        <div key={i} className="task-refs-group">
          <span className="label">{p.label}</span>
          <Markdown text={p.body} />
        </div>
      ))}
    </div>
  );
}

const touchList = (v?: string): string[] => {
  try {
    const l = JSON.parse(v ?? '[]');
    return Array.isArray(l) ? l.map(String) : [];
  } catch {
    return [];
  }
};

/** In About: the task's tier and the director's reason, how many parts it has, and what it waits for or blocks. */
function TaskDetails({ t, pid, parts, parallel }: { t: Task; pid: string; parts: number; parallel?: string | null }) {
  // parallel: whether the builder can run it alongside its work, or why it stays serial (server/subagents.ts parallelHint).
  const touches = touchList(t.touches);
  const bits = [parts > 1 ? `${parts} parts` : '', touches.length ? `Touches ${touches.join(', ')}` : '', parallel ?? ''].filter(Boolean);
  return (
    <div className="task-details">
      {t.kind !== 'discussion' && <TierPicker t={t} />}
      {bits.map((b) => (
        <p key={b} className="muted small task-tier">
          <PlainRefs text={b} />
        </p>
      ))}
      <WaitsLine t={t} pid={pid} full />
    </div>
  );
}

type TierRow = { id: string; name: string; model: string; effort: string };

/**
 * About's tier line as a button: it opens the four tiers in place, each with its model and effort (server/tiers.ts).
 * The user's pick is pinned (agents cannot change it) and the agent on the task takes it at its next turn.
 */
function TierPicker({ t, startOpen = false, onDone }: { t: Task; startOpen?: boolean; onDone?: () => void }) {
  const [open, setOpen] = useState(startOpen);
  const label = t.tier ? `${TIER_LABEL[t.tier] ?? t.tier} tier` : 'No tier yet';
  return (
    <div className="tier-pick">
      <p className="muted small task-tier">
        <button className="btn bare small" aria-expanded={open} aria-label={`${label}. Change`} onClick={() => setOpen(!open)}>
          {label} ▾
        </button>
        {t.tier_reason && <span> · {t.tier_pinned ? 'set by you' : <PlainRefs text={t.tier_reason} />}</span>}
      </p>
      {open && (
        <TierChoices
          t={t}
          onDone={() => {
            setOpen(false);
            onDone?.();
          }}
        />
      )}
    </div>
  );
}

function TierChoices({ t, onDone }: { t: Task; onDone: () => void }) {
  const { data } = useLive<{ tiers: TierRow[] }>('/api/tiers', (m) => m.type === 'projects');
  const { busy, error, run } = useAction();
  if (!data) return <p className="muted small">Loading the tiers…</p>;
  const pick = async (id: string) => {
    if (id === t.tier && t.tier_pinned) return onDone();
    if (await run(() => api(`/api/tasks/${t.id}/tier`, { body: { tier: id } }))) onDone();
  };
  return (
    <div className="tier-choices" role="group" aria-label="Set the tier">
      {data.tiers.map((x) => (
        <button key={x.id} className={`btn small ${x.id === t.tier ? 'on' : 'quiet'}`} disabled={busy} onClick={() => void pick(x.id)}>
          {x.name} — {modelLabel(x.model)}
          {x.effort ? `, ${x.effort}` : ''}
        </button>
      ))}
      <span className="muted small">Agents cannot change the tier you set.</span>
      {error && <span className="error-text small">{error}</span>}
    </div>
  );
}

/** The tier picker from the task's menu. */
function TierSheet({ t, onClose }: { t: Task; onClose: () => void }) {
  return (
    <Sheet title="Tier" onClose={onClose}>
      <TierPicker t={t} startOpen onDone={onClose} />
    </Sheet>
  );
}

/** The priority tag as a button: one tap opens the importance picker (rows, the title card). */
function ImportanceButton({ t }: { t: Task }) {
  // Tap the tag: the levels open in place (the picker stops the tap from opening the row).
  return <ImportancePicker id={t.id} level={t.importance} pinned={!!t.importance_pinned} compact />;
}

/** The importance level, from the task's menu, the priority tag, or dragging in Priority order. */
function ImportanceSheet({ t, onClose }: { t: Task; onClose: () => void }) {
  return (
    <Sheet title="Importance" onClose={onClose}>
      <ImportancePicker id={t.id} level={t.importance} pinned={!!t.importance_pinned} startOpen />
    </Sheet>
  );
}

/** About's Parts list: each piece of work folded in, its source, and its own Features and Done when. */
function TaskParts({ parts }: { parts: TaskPart[] }) {
  return (
    <div className="task-parts">
      <span className="label">Parts</span>
      <ol className="task-parts-list">
        {parts.map((p) => (
          <li key={p.id}>
            <details open={parts.length <= 4}>
              <summary>
                <b>{p.title}</b>
                <span className="muted small task-part-src">
                  {p.source.label}
                  {p.source.ref && (
                    <>
                      {' '}
                      <Markdown className="inline-md" text={`[[${p.source.ref}]]`} />
                    </>
                  )}
                </span>
              </summary>
              {p.source.excerpt && <p className="muted small task-part-quote">“{p.source.excerpt}”</p>}
              {p.body ? <TaskDescription text={p.body} /> : null}
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A task's Spec entries and related work: one link per line, each showing the item's title and state. */
function TaskRefs({ refs }: { refs?: TaskDetail['references'] }) {
  if (!refs || (!refs.spec.length && !refs.related.length)) return null;
  const group = (label: string, ids: string[]) =>
    ids.length > 0 && (
      <div className="task-refs-group">
        <span className="label">{label}</span>
        <Markdown text={ids.map((id) => `[[${id}]]`).join('\n\n')} />
      </div>
    );
  return (
    <div className="task-refs">
      <span className="label task-refs-title">References</span>
      {group('Spec', refs.spec)}
      {group('Related work', refs.related)}
    </div>
  );
}

/** A task implementing no Spec entry: one muted line, and Discuss opens (or reuses) the discussion about which entry it belongs to. */
function NoSpecLine({ t, spec, pid }: { t: Task; spec: TaskDetail['spec']; pid: string }) {
  const { busy, error, run } = useAction();
  if (spec?.implements.length || t.doc_id || ['done', 'dropped'].includes(t.state) || t.merged_into) return null;
  const discuss = () =>
    void run(async () => {
      const r = await api<{ id: string }>(`/api/tasks/${t.id}/spec-discussion`, { body: {} });
      go('p', pid, 'discussions', r.id);
    });
  return (
    <div className="task-nospec">
      <span className="muted small">No Spec entry</span>
      <button className="btn small" disabled={busy} onClick={discuss}>
        <Icon name="discuss" size={16} /> Discuss
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

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
          <span className="era-title">{origin?.merged ? <>Merged from</> : origin ? <>Discussion this task came from</> : <>Discussion, before this became a task</>}</span>
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

/**
 * The way to talk to the director about this task, on the title card and its strip: Interject while it is active (the
 * chat opens on this task in interject mode, with Pause the work), Message otherwise. A closed task is answered in its
 * history's own composer.
 */
const TIER_LABEL: Record<string, string> = { light: 'Light', routine: 'Routine', skilled: 'Skilled', deep: 'Deep' };

const blocked = (t: Task) => OPEN.includes(t.state) && !!t.waits_for?.length;

/**
 * What a task waits for and what waits for it (server/waits.ts), as muted links. `full` (About): "Waits for <task>, <task>"
 * and "Blocks <task>". Compact (a row's meta line): "Waits for <task>" or "Waits for 2 tasks", and "Then: N tasks", each
 * linked to the first of them.
 */
function WaitsLine({ t, pid, full = false, only }: { t: Task; pid: string; full?: boolean; only?: 'waits' | 'blocks' }) {
  const link = (x: { id: string }, text: string) => (
    <a href={href('p', pid, 'tasks', x.id)} onClick={(e) => e.stopPropagation()}>
      {text}
    </a>
  );
  const count = (n: number) => `${n} ${n === 1 ? 'task' : 'tasks'}`;
  const part = (label: string, list: { id: string; title: string }[] | undefined, counted = false) =>
    !list?.length ? null : (
      <span>
        {label}{' '}
        {!full && (counted || list.length > 1)
          ? link(list[0], count(list.length))
          : list.map((x, i) => (
              <span key={x.id}>
                {i > 0 && ', '}
                {link(x, x.title)}
              </span>
            ))}
      </span>
    );
  const w = only === 'blocks' ? null : part('Waits for', t.waits_for);
  const b = only === 'waits' ? null : full ? part('Blocks', t.blocks) : part('Then:', t.blocks, true);
  if (!w && !b) return null;
  const El = full ? 'p' : 'span';
  return (
    <El className="task-waits muted small one-line">
      {w}
      {w && b && ' · '}
      {b}
    </El>
  );
}

/** The user sets what a task waits for: open tasks of the project, ticked. */
function WaitsPicker({ t, s, onClose }: { t: Task; s: ProjectState; onClose: () => void }) {
  const [ids, setIds] = useState<string[]>((t.waits_for ?? []).map((x) => x.id));
  const { busy, error, run } = useAction();
  const options = s.tasks.filter((x) => x.id !== t.id && x.kind !== 'discussion' && OPEN.includes(x.state));
  const toggle = (id: string) => setIds((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  return (
    <Sheet title="Waits for" onClose={onClose}>
      <div className="waits-pick">
        {options.map((x) => (
          <label key={x.id} className="waits-option">
            <input type="checkbox" checked={ids.includes(x.id)} onChange={() => toggle(x.id)} />
            <span className="one-line">{x.title}</span>
          </label>
        ))}
        {!options.length && <p className="muted small">No other open tasks.</p>}
      </div>
      {error && <p className="error-text small">{error}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={async () => (await run(() => api(`/api/tasks/${t.id}/waits`, { body: { ids } }))) && onClose()}>
          Save
        </button>
      </div>
    </Sheet>
  );
}

/** The bell: one notification when this open task finishes, then it clears (server/bell.ts). Filled when on. */
function BellButton({ t }: { t: Task }) {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => setOn(null), [t.bell]);
  if (t.kind === 'discussion' || !OPEN.includes(t.state)) return null;
  const lit = on ?? !!t.bell;
  const flip = () => {
    setOn(!lit);
    api(`/api/tasks/${t.id}/bell`, { body: { on: !lit } }).catch(() => setOn(null));
  };
  return (
    <button className={`icon-btn task-bell ${lit ? 'on' : ''}`} aria-pressed={lit} aria-label={lit ? 'Bell on: you will be told when it finishes. Turn off' : 'Tell me when it finishes'} title={lit ? 'You will be told when it finishes' : 'Tell me when it finishes'} onClick={(e) => (e.preventDefault(), e.stopPropagation(), flip())}>
      <Icon name="bell" size={20} />
    </button>
  );
}

/** Takes the user to the message box at the end of the History (scrolled into view and focused); the chat if the History is folded. */
export function focusThreadBox(open: () => void) {
  const box = document.querySelector<HTMLTextAreaElement>('.task-thread .composer textarea');
  if (!box) return open();
  box.scrollIntoView({ block: 'center', behavior: 'smooth' });
  box.focus({ preventScroll: true });
}

function ChatButton({ t, compact = false }: { t: Task; compact?: boolean }) {
  if (t.state === 'done' || t.state === 'dropped') return null;
  const active = t.state === 'active';
  return (
    <button className={`btn ${active ? 'primary' : ''} ${compact ? 'small' : ''}`} onClick={() => focusThreadBox(() => openChat({ kind: 'task', id: t.id }))}>
      <Icon name="discuss" size={16} /> {active ? 'Interject' : 'Message'}
    </button>
  );
}

function TaskHeadActions({ t, tokens, onEdit, onAnother, onState, canBeDiscussion, onWaits }: { t: Task; tokens: string | null; onWaits?: () => void; onEdit: () => void; onAnother?: () => void; onState: (s: TaskState) => void; canBeDiscussion: boolean }) {
  const { busy, error, act, move, toDiscussion } = useTaskActions(t, onState);
  // A running task has one control, Interject (it stops the work; empty, it just stops): no separate Interrupt.
  const primary = t.state === 'active' ? null : primaryAction(t.state);
  const [importance, setImportance] = useState(false);
  const [tier, setTier] = useState(false);
  const isOpen = OPEN.includes(t.state);
  return (
    <>
      <div className="row wrap task-actions">
        {primary && (
          <button className={`btn ${primary.tone}`} disabled={busy} onClick={() => act(primary.action)}>
            <Icon name={primary.icon} size={16} /> {primary.label}
          </button>
        )}
        {(t.state === 'planning' || t.state === 'waiting') && !blocked(t) && (
          <button className="btn" disabled={busy} onClick={() => act('start')}>
            <Icon name="play" size={16} /> Start now
          </button>
        )}
        <ChatButton t={t} />
        <button className="btn quiet" onClick={onEdit}>
          <Icon name="edit" size={16} /> Edit
        </button>
        <span className="spacer" />
        {/* Tokens its agents used (server/usage.ts), muted, beside the menu. */}
        {tokens && <span className="muted small task-head-tokens">{tokens}</span>}
        <BellButton t={t} />
        <Menu
          label="More actions"
          items={[
            t.state === 'scheduled' && { label: 'Unschedule', onSelect: () => act('unschedule') },
            t.state === 'paused' && { label: 'Schedule', onSelect: () => act('approve') },
            t.kind !== 'discussion' && { label: 'Importance…', onSelect: () => setImportance(true) },
            t.kind !== 'discussion' && { label: 'Tier…', onSelect: () => setTier(true) },
            // Review is opt-in (server/builder.ts isRisky): only a task marked here is reviewed before it lands.
            isOpen && t.kind !== 'discussion' && { label: t.risky === 1 ? '✓ Review before it lands' : 'Review before it lands', onSelect: () => void api(`/api/tasks/${t.id}/review`, { body: { on: t.risky !== 1 } }).catch(() => {}) },
            isOpen && { label: 'Move up', onSelect: () => move('up') },
            isOpen && { label: 'Move down', onSelect: () => move('down') },
            isOpen && { label: 'Move to top', onSelect: () => move('top') },
            isOpen && t.kind !== 'discussion' && !!onWaits && { label: 'Waits for…', onSelect: onWaits },
            !!onAnother && { label: 'Create another task from this', onSelect: onAnother },
            canBeDiscussion && movable(t) && { label: 'Move to discussions', onSelect: toDiscussion },
            isOpen && { label: 'Drop', onSelect: () => act('drop'), danger: true },
          ]}
        />
      </div>
      {importance && <ImportanceSheet t={t} onClose={() => setImportance(false)} />}
      {tier && <TierSheet t={t} onClose={() => setTier(false)} />}
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
      // A proposed conclusion in an open discussion: Conclude closes it with this text and the director plans the work.
      return { type: 'reply', key: i.key, ts: i.ts, text: i.body, name: i.name || directorName, action: i.conclude ? <ConcludeButton task={i.conclude.task} message={i.conclude.message} /> : undefined };
    }
    if (i.type === 'state') return { type: 'system', key: i.key, ts: i.ts, text: i.body };
    if (i.type === 'change') return { type: 'node', key: i.key, ts: i.ts, node: <ChangeCard body={i.body} ts={i.ts} projectId={pid} /> };
    // A discussion about a Spec entry: the entry as it read at the start, and the edits the director proposed (specdiscuss.tsx).
    if (i.type === 'spec') return { type: 'node', key: i.key, ts: i.ts, node: <SnapshotCard body={i.body} ts={i.ts} /> };
    if (i.type === 'proposal') return { type: 'node', key: i.key, ts: i.ts, node: <ProposalCard body={i.body} ts={i.ts} projectId={pid} /> };
    // A release recipe the director proposed (releases.tsx): Apply, Change or Not this.
    if (i.type === 'recipe') return { type: 'node', key: i.key, ts: i.ts, node: <RecipeProposalCard body={i.body} s={s} /> };
    // A change the director proposes in a Consolidate tasks discussion: Apply or Not this.
    // Spec work (specwork.tsx): a Review's findings for a section, and proposed new entries.
    if (i.type === 'findings') return { type: 'node', key: i.key, ts: i.ts, node: <FindingsCard messageKey={i.key} s={s} /> };
    if (i.type === 'entries') return { type: 'node', key: i.key, ts: i.ts, node: <EntriesCard messageKey={i.key} s={s} /> };
    if (i.type === 'consolidate') return { type: 'node', key: i.key, ts: i.ts, node: <ConsolidationCard body={i.body} s={s} /> };
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
                <Icon name="top" size={16} /> Answer it in the proposal at the top
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
            {['open', 'director', 'check'].includes(item.status) ? <InboxCard item={item} agentName={asker} context={false} /> : <RequestOutcome item={item} asker={asker} />}
          </div>
        ),
      };
    }
    if (i.type === 'consult') return { type: 'node', key: i.key, ts: i.ts, node: <ConsultCard c={i} /> };
    if (i.type === 'preview') {
      const tile = <PreviewTile p={i.preview} onOpen={() => openPreview(pid, i.preview.id)} />;
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
