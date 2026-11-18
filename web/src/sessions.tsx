import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, useLive } from './api';
import type { ProjectState, Task } from './api';
import type { ThreadLine } from './thread';
import { ClampBox, Empty, Markdown, PlainRefs, href, useAction, useTick } from './ui';

/**
 * Sessions (server/sessions.ts): stretches when the user worked with the director, and the away periods between
 * them when the director carried on alone. Shown in the project's presence bar, on the History page, as dividers
 * in a task's history, and as timing on tasks.
 */

export type Presence = { state: 'session' | 'away'; since: number | null; session_id: string | null; running: number; queued: number; working: number };
export type PeriodCounts = { owner: number; started: number; finished: number; created: number; found: number; previews: number; decisions: number; spec: number; asked: number; open: number };
export type Period = { id: string; kind: 'session' | 'away'; start: number; end: number | null; ended_reason?: string; summary: string; summary_by: string; counts: PeriodCounts };
type TaskBrief = { id: string; title: string; state: string; origin: string; origin_note: string; started_at: number | null; finished_at: number | null; took_ms?: number };
export type PeriodDetail = {
  owner: { ts: number; kind: string; text: string; task_id?: string; title?: string }[];
  tasks_created: TaskBrief[];
  tasks_started: TaskBrief[];
  tasks_finished: TaskBrief[];
  previews: { id: string; kind: string; title: string; task_id: string | null; created_at: number }[];
  journal: { id: number; kind: string; title: string; task_id: string | null; ts: number }[];
  spec_changes: { doc_id: string; title: string; edits: number; by: string }[];
  requests_asked: { id: string; title: string; status: string; task_id: string | null; created_at: number }[];
  requests_open: { id: string; title: string; task_id: string | null }[];
  discussions_opened: { id: string; title: string }[];
};
export type Boundary = { kind: 'session' | 'away'; start: number; end: number | null };

// ---------- formatting ----------

const dayTime = (ts: number) => new Date(ts).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 && h < 10 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** "Tue 19:10–21:40", or "Tue 19:10 – Wed 01:20" across midnight; an open end is "now". */
export function span(start: number, end: number | null): string {
  if (end == null) return `${dayTime(start)} – now`;
  return sameDay(start, end) ? `${dayTime(start)}–${time(end)}` : `${dayTime(start)} – ${dayTime(end)}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- presence ----------

/** One line under the project tabs: in session, or away and what the director is doing; with "I'm stepping away". */
export function PresenceBar({ s }: { s: ProjectState }) {
  const p = s.presence;
  const { busy, run } = useAction();
  if (!p) return null;
  if (p.state === 'session') {
    return (
      <div className="presence presence-here" role="status">
        <span className="presence-dot" />
        <span className="grow">
          <b>In session</b>
          {p.since && <span className="muted"> since {time(p.since)}</span>}
        </span>
        <button className="btn small quiet" title="I'm stepping away: end the session now and let the director carry on alone" disabled={busy} onClick={() => run(() => api(`/api/projects/${s.project.id}/away`, { method: 'POST' }))}>
          Step away
        </button>
      </div>
    );
  }
  const doing = p.running || p.queued ? `Director working: ${p.running} running, ${p.queued} queued` : 'Director idle: nothing queued';
  return (
    <div className="presence presence-away" role="status">
      <span className="presence-dot" />
      <span className="grow">
        <b>Away{p.since ? ` since ${sameDay(p.since, Date.now()) ? time(p.since) : dayTime(p.since)}` : ''}</b>
        <span className="muted"> · {doing}</span>
      </span>
    </div>
  );
}

// ---------- task timing ----------

type Timed = Pick<Task, 'state' | 'awaiting_review' | 'review_agent' | 'stalled'> & { started_at?: number | null; finished_at?: number | null; active_ms?: number | null; active_since?: number | null };

/** Active time so far, including the current stretch. */
export const activeMs = (t: Timed, at = Date.now()) => (t.active_ms ?? 0) + (t.active_since ? Math.max(0, at - t.active_since) : 0);

/** "started 14:02 · running 37 min" on active tasks, "took 1 h 12 min" on done ones; ticks while shown. */
export function TaskTiming({ t, className = '' }: { t: Timed; className?: string }) {
  useTick(t.active_since ? 30_000 : 600_000);
  if (t.state === 'active' && t.awaiting_review) {
    return <span className={`task-timing task-review small ${className}`}>Finished by {t.review_agent ?? 'its agent'} · awaiting review{t.started_at ? ` · took ${duration(activeMs(t))}` : ''}</span>;
  }
  if (t.state === 'active' && t.stalled) return <span className={`task-timing task-stalled small ${className}`}>Stalled: nobody is working on this</span>;
  if (!t.started_at) return null;
  const at = (ts: number) => (sameDay(ts, Date.now()) ? time(ts) : dayTime(ts));
  let text: string;
  if (t.state === 'done') text = `took ${duration(activeMs(t))}`;
  else if (t.state === 'active') text = `started ${at(t.started_at)} · running ${duration(activeMs(t))}`;
  else if (t.state === 'dropped') return null;
  else text = `started ${at(t.started_at)} · ${duration(activeMs(t))} active so far`;
  return <span className={`task-timing small ${className}`}>{text}</span>;
}

// ---------- dividers in a task's history ----------

const contains = (b: Boundary, ts: number) => (b.kind === 'session' ? ts >= b.start && ts <= (b.end ?? Infinity) : ts > b.start && ts < (b.end ?? Infinity));
export const boundaryLabel = (b: Boundary) =>
  b.kind === 'session' ? `Session · ${span(b.start, b.end)}` : `Away · ${duration((b.end ?? Date.now()) - b.start)}${b.end == null ? ', so far' : ''}`;

/** Thin dividers where a task's history crosses from one session or away period into the next. */
export function withPeriodDividers(lines: ThreadLine[], periods: Boundary[] | undefined): ThreadLine[] {
  if (!periods?.length) return lines;
  const out: ThreadLine[] = [];
  let current: Boundary | undefined;
  for (const l of lines) {
    const b = periods.find((p) => contains(p, l.ts));
    if (b && b !== current) {
      out.push({ type: 'node', key: `div-${b.kind}-${b.start}`, ts: l.ts, node: <div className={`period-divider divider-${b.kind}`}><span>{boundaryLabel(b)}</span></div> });
      current = b;
    }
    out.push(l);
  }
  return out;
}

// ---------- the History page ----------

function Counts({ c, kind }: { c: PeriodCounts; kind: Period['kind'] }) {
  const bits = [
    kind === 'session' && c.owner > 0 && plural(c.owner, 'action'),
    c.finished > 0 && `${c.finished} finished`,
    c.started > 0 && `${c.started} started`,
    c.found > 0 && `${c.found} found while away`,
    c.previews > 0 && plural(c.previews, 'preview'),
    c.decisions > 0 && plural(c.decisions, 'decision'),
    c.spec > 0 && `${plural(c.spec, 'Spec entry', 'Spec entries')} changed`,
    c.open > 0 && `${c.open} still open`,
  ].filter(Boolean) as string[];
  if (!bits.length) return <p className="period-counts muted small">Nothing recorded</p>;
  return (
    <p className="period-counts small">
      {bits.map((b, i) => (
        <span key={i} className={b.includes('still open') ? 'needs' : ''}>
          {b}
        </span>
      ))}
    </p>
  );
}

function PeriodItems({ pid, period, s }: { pid: string; period: Period; s: ProjectState }) {
  const { data, error } = useLive<Period & { detail: PeriodDetail }>(`/api/projects/${pid}/sessions/${period.id}`, (m) => m.type === 'project' && m.projectId === pid && period.end == null);
  if (error) return <p className="error-text">{error}</p>;
  if (!data) return <div className="loading">Loading…</div>;
  const d = data.detail;
  const task = (id: string | null | undefined, title?: string) =>
    id ? <a href={href('p', pid, s.discussions.some((x) => x.id === id) ? 'discussions' : 'tasks', id)}>{title ?? s.tasks.find((t) => t.id === id)?.title ?? 'task'}</a> : null;
  const groups: { title: string; items: ReactNode[] }[] = [
    {
      title: period.kind === 'session' ? 'You asked and decided' : 'What you did',
      items: d.owner.map((o, i) => (
        <li key={`o${i}`}>
          <ClampBox lines={3}>
            <span className="muted small">{time(o.ts)}</span> {o.kind === 'thread' || o.kind === 'task' ? <>{task(o.task_id, o.title)}: </> : o.kind === 'answer' ? 'Answered ' : ''}
            <PlainRefs text={o.kind === 'task' ? o.text.replace(/^You (\w)/, (_m, c: string) => c.toUpperCase()) : o.text} />
          </ClampBox>
        </li>
      )),
    },
    { title: 'Finished', items: d.tasks_finished.map((t) => <li key={t.id}>{task(t.id, t.title)} <span className="muted small">took {duration(t.took_ms ?? 0)}</span></li>) },
    { title: 'Started', items: d.tasks_started.map((t) => <li key={t.id}>{task(t.id, t.title)}</li>) },
    {
      title: 'From reports',
      items: d.tasks_created.filter((t) => t.origin === 'report').map((t) => <li key={t.id}>{task(t.id, t.title)} {t.origin_note && <span className="muted small">{t.origin_note}</span>}</li>),
    },
    {
      title: 'New tasks',
      items: d.tasks_created.filter((t) => t.origin !== 'report').map((t) => (
        <li key={t.id}>
          {task(t.id, t.title)} {t.origin === 'away' && <span className="found-tag small">found while away</span>}
          {t.origin === 'away' && t.origin_note && <span className="muted small"> {t.origin_note}</span>}
        </li>
      )),
    },
    { title: 'Waiting on you', items: d.requests_open.map((r) => <li key={r.id}>{r.title} {r.task_id && <>· {task(r.task_id)}</>}</li>) },
    { title: 'Decisions and milestones', items: d.journal.map((j) => <li key={j.id}><span className="muted small">{j.kind}</span> <a href={href('p', pid, 'history', `j${j.id}`)}>{j.title}</a></li>) },
    { title: 'Spec changes', items: d.spec_changes.map((c) => <li key={c.doc_id}><a href={href('p', pid, 'spec', c.doc_id)}>{c.title}</a> <span className="muted small">{plural(c.edits, 'edit')} by {c.by}</span></li>) },
    { title: 'Previews', items: d.previews.map((p) => <li key={p.id}><a href={href('p', pid, 'previews', p.id)}>{p.title}</a></li>) },
    { title: 'Discussions opened', items: d.discussions_opened.map((x) => <li key={x.id}>{task(x.id, x.title)}</li>) },
  ].filter((g) => g.items.length);
  if (!groups.length) return <p className="muted small">Nothing else to show.</p>;
  return (
    <div className="period-items">
      {groups.map((g) => (
        <div key={g.title}>
          <h4>{g.title}</h4>
          <ul>{g.items.slice(0, 40)}</ul>
          {g.items.length > 40 && <p className="muted small">and {g.items.length - 40} more</p>}
        </div>
      ))}
    </div>
  );
}

/** History grouped by session and away period, newest first, each with its summary and counts, expandable. */
export function SessionHistory({ s, focus }: { s: ProjectState; focus?: string }) {
  const pid = s.project.id;
  const { data, error } = useLive<{ periods: Period[] }>(`/api/projects/${pid}/sessions`, (m) => m.type === 'project' && m.projectId === pid);
  const [open, setOpen] = useState<Record<string, boolean>>(focus ? { [focus]: true } : {});
  useTick();
  // Opened at one period (an away summary's notification): show it open, in view, marked briefly.
  const found = !!focus && !!data?.periods.some((p) => p.id === focus);
  useEffect(() => {
    if (!focus || !found) return;
    setOpen((o) => ({ ...o, [focus]: true }));
    const el = document.getElementById(`period-${focus}`);
    el?.scrollIntoView({ block: 'start' });
    el?.classList.add('period-focus');
    const t = setTimeout(() => el?.classList.remove('period-focus'), 2500);
    return () => clearTimeout(t);
  }, [focus, found]);
  if (error) return <Empty title="Could not load sessions">{error}</Empty>;
  if (!data) return <div className="loading">Loading…</div>;
  if (!data.periods.length) return <Empty title="No sessions yet">A session starts when you next do something here: send a message, answer a request or act on a task.</Empty>;
  return (
    <ol className="periods">
      {data.periods.map((p) => {
        const isOpen = !!open[p.id];
        const label = p.kind === 'session' ? 'Session' : 'Away';
        const len = duration((p.end ?? Date.now()) - p.start);
        return (
          <li key={p.id} id={`period-${p.id}`} className={`period period-${p.kind} ${p.end == null ? 'period-now' : ''}`}>
            <button className="period-head" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [p.id]: !isOpen }))}>
              <span className="period-kind">{label}</span>
              <span className="period-when">
                {span(p.start, p.end)} <span className="muted">· {len}</span>
              </span>
              <span className="period-chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
            </button>
            {p.summary && p.summary_by === 'auto' ? (
              // A plain automatic line already says what the counts would.
              <p className="period-summary muted"><PlainRefs text={p.summary} />{p.counts.open > 0 && <span className="needs"> {p.counts.open} still open.</span>}</p>
            ) : p.summary ? (
              <ClampBox className={`period-summary ${p.summary_by === 'auto' ? 'muted' : ''}`} lines={6}>
                <Markdown text={p.summary} />
              </ClampBox>
            ) : (
              <p className="period-summary muted small">{p.end == null ? (p.kind === 'session' ? 'In progress.' : 'The director is working alone; its summary comes when you are back.') : 'No summary.'}</p>
            )}
            {!(p.summary && p.summary_by === 'auto') && <Counts c={p.counts} kind={p.kind} />}
            {isOpen && <PeriodItems pid={pid} period={p} s={s} />}
          </li>
        );
      })}
    </ol>
  );
}
