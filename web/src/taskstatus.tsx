import type { Agent, Task, TaskDetail } from './api';
import { Clamp, Icon, href, openPreview, useTick } from './ui';
import { Fold, jumpTo } from './fold';
import { PreviewThumb, hasThumb } from './preview';
import { duration, workMs } from './sessions';
import { compactNumber } from './usage.ts';

/**
 * The task page's Status section, under the header card: what is happening on this task right now, and only on it
 * (server/tasks.ts taskDetail gives an agent running it alongside only this task's worklist). Each agent with its
 * status line and the call it is in, with its running time; subagents and commands for this task; its worklist as a
 * stepper; the newest preview; a count of Done when linking to About; and time against similar tasks. It refetches on
 * this task's agents' events (tasks.tsx TaskPage). Where it stands and the Done when list itself are in About.
 */
export type TaskStatusData = {
  done_when: { text: string; done: boolean }[];
  median: { work_ms: number | null; tokens: number | null; n: number; basis: 'similar' | 'recent' } | null;
  tile: { tile: string; title: string; value: number; unit: string } | null;
};

const ENDED = ['done', 'dropped'];
const since = (ts: number) => duration(Math.max(0, Date.now() - ts));

export function TaskStatus({ t, data, pid }: { t: Task; data: TaskDetail; pid: string }) {
  const ended = ENDED.includes(t.state);
  const crew = ended ? [] : data.agents.filter((a) => a.status !== 'closed' && a.status !== 'done' && (a.on_task || a.role_id === 'subagent' || a.checklist?.length || a.status_line));
  const commands = ended ? [] : (data.commands ?? []);
  // Seconds tick while something runs, so its time moves; else once a minute.
  useTick(crew.some((a) => a.current_tool) || commands.length ? 1000 : 60_000);
  const st = data.status;
  const shot = !ended && hasThumb(t.thumb);
  const work = workMs(t);
  const med = st?.median;
  const showTime = !ended && work != null && !!med?.work_ms;
  const doneWhen = st?.done_when ?? [];
  if (ended || (!crew.length && !commands.length && !doneWhen.length && !shot && !st?.tile && !showTime)) return null;
  return (
    <Fold kind="task-status" title="Status" className="tstat">
      {crew.map((a) => (
        <AgentNow key={a.id} a={a} pid={pid} />
      ))}
      {commands.map((c) => (
        <p key={c.id} className="small ts-cmd">
          <span className="muted">{since(c.started_at)}{c.host_name ? ` · ${c.host_name}` : ''} · </span>
          <span className="one-line mono">{c.label || c.command}</span>
        </p>
      ))}
      {doneWhen.length > 0 && (
        <button type="button" className="btn bare ts-donewhen small" onClick={() => jumpTo('.task-about', { fold: 'about' })}>
          {doneWhen.filter((d) => d.done).length} of {doneWhen.length} done when <Icon name="chevron" size={16} />
        </button>
      )}
      {(shot || st?.tile) && (
        <div className="ts-evidence">
          {shot && t.thumb && (
            <button type="button" className="ts-shot" onClick={() => openPreview(pid, t.thumb!.id)} aria-label={`Open the latest preview: ${t.thumb.title}`}>
              <PreviewThumb p={t.thumb} />
            </button>
          )}
          <span className="ts-evidence-txt">
            {shot && t.thumb && <span className="one-line small">{t.thumb.title}</span>}
            {st?.tile && (
              <span className="small">
                <span className="muted">{st.tile.title}</span> <b className="mono">{compactNumber(st.tile.value)}</b>
                {st.tile.unit && <span className="muted"> {st.tile.unit}</span>}
              </span>
            )}
          </span>
        </div>
      )}
      {showTime && <TimeBar work={work!} median={med!.work_ms!} tokens={t.tokens ?? null} medianTokens={med!.tokens} basis={med!.basis} />}
    </Fold>
  );
}

/** One agent on this task now: its name and status line, the call it is in with its time, and its worklist for this task. */
function AgentNow({ a, pid }: { a: Agent; pid: string }) {
  const sub = a.role_id === 'subagent';
  // The server sends this task's line (an agent running it alongside: its line for this task).
  const line = a.status_line;
  const items = (a.checklist ?? []).filter((i) => i.state !== 'dropped');
  return (
    <div className="ts-agent">
      <p className="small ts-agent-head">
        <a href={href('p', pid, 'agents', a.id)}>{a.name}</a>
        {sub && <span className="muted"> · subagent</span>}
        {line && <span className="muted"> · {line}</span>}
      </p>
      {a.current_tool && (
        <p className="small ts-tool">
          <span className="mono">{a.current_tool.name}</span>
          <span className="muted"> · {since(a.current_tool.since)}</span>
          {a.current_tool.summary && <span className="one-line mono muted"> · {a.current_tool.summary}</span>}
        </p>
      )}
      {items.length > 0 && <Stepper a={a} named={false} />}
    </div>
  );
}

/**
 * About's top (task page): where the task stands (its status summary), then the one Done when list, ticked as the
 * agents meet items (report_status done_when).
 */
export function TaskStanding({ t, doneWhen }: { t: Task; doneWhen: { text: string; done: boolean }[] }) {
  if (!t.status_summary && !doneWhen.length) return null;
  const ended = ENDED.includes(t.state);
  return (
    <div className="ts-standing">
      {t.status_summary && (
        <div className="ts-block">
          <span className="label">{ended ? 'Final status' : 'Where it stands'}</span>
          <Clamp text={t.status_summary} lines={3} />
        </div>
      )}
      {doneWhen.length > 0 && (
        <div className="ts-block">
          <span className="label">
            Done when <span className="muted">{doneWhen.filter((d) => d.done).length} of {doneWhen.length}</span>
          </span>
          <ul className="ts-done">
            {doneWhen.map((d, i) => (
              <li key={i} className={d.done ? 'met' : ''}>
                <span className="ts-box" aria-label={d.done ? 'Met' : 'Not yet'}>{d.done && <Icon name="check" size={16} />}</span>
                <span>{d.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One agent's worklist: a dot per step (done, current, to do), the current step named, and the %. */
function Stepper({ a, named }: { a: Agent; named: boolean }) {
  const items = a.checklist.filter((i) => i.state !== 'dropped');
  const done = items.filter((i) => i.state === 'done').length;
  const pct = a.progress ?? (items.length ? Math.round((done / items.length) * 100) : 0);
  const now = items.find((i) => i.state === 'doing') ?? items.find((i) => i.state === 'blocked') ?? items.find((i) => i.state === 'todo');
  return (
    <div className="ts-step">
      <div className="ts-step-row">
        <span className="ts-dots" aria-label={`${done} of ${items.length} steps done`}>
          {items.map((i) => (
            <span key={i.id} className={`ts-dot ${i.state}`} />
          ))}
        </span>
        <span className="mono small ts-pct">{pct}%</span>
      </div>
      {now && (
        <p className="small one-line ts-now">
          {named && <b>{a.name}: </b>}
          {now.state === 'todo' ? <span className="muted">Next: </span> : now.state === 'blocked' ? <span className="err-text">Blocked: </span> : null}
          {now.text}
        </p>
      )}
    </div>
  );
}

/** Work time against the median of similar finished tasks: the bar's tick is the median, so past it reads as running long. */
function TimeBar({ work, median, tokens, medianTokens, basis }: { work: number; median: number; tokens: number | null; medianTokens: number | null; basis: 'similar' | 'recent' }) {
  const ratio = work / median;
  // Twice the median fills the bar; the median sits at the middle.
  const fill = Math.min(100, Math.round(ratio * 50));
  const of = basis === 'similar' ? 'similar tasks' : 'recent tasks';
  return (
    <div className="ts-block">
      <span className="label">Time and cost</span>
      <div className={`ts-time ${ratio > 1.5 ? 'long' : ''}`} role="img" aria-label={`${duration(work)} so far; ${of} took ${duration(median)}`}>
        <div style={{ width: `${fill}%` }} />
        <span className="ts-median" />
      </div>
      <p className="muted small ts-time-txt">
        {duration(work)}
        {tokens ? ` · ${compactNumber(tokens)} tokens` : ''} · {of}: {duration(median)}
        {medianTokens ? `, ${compactNumber(medianTokens)} tokens` : ''}
      </p>
    </div>
  );
}
