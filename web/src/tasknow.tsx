import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, useStream } from './api';
import type { Agent, AgentEvent, ProjectState, Task, TaskChange, TaskDetail } from './api';
import { InboxCard } from './inbox';
import { PreviewBody } from './preview';
import { Icon, Markdown, Status, ago, href, useTick , PlainRefs } from './ui';

/**
 * The top of a task's page: what is happening now, so the user can step in while it happens. In order: open
 * requests (Needs you), the agents working on it this moment (Happening now), the newest status summary and
 * preview (Latest), and the last few notable changes (What changed). The header and the chat's docked bar
 * are separate pieces used by TaskPage (tasks.tsx). Everything here keeps a fixed shape so live updates do not
 * move the page under the reader's thumb.
 */

// ---------- timing ----------

/** "2 h 5 min", "12 min", "under a minute". */
export function duration(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/**
 * Running time while active ("started 14:02 · running 37 min"), what it took once done, and whether its driver finished
 * and it awaits review or it has stalled: one component in sessions.tsx, shared with the task rows.
 */
export { TaskTiming } from './sessions';

// ---------- Needs you ----------

/** except: the request answered from the pinned proposal above (proposal.tsx), not repeated here. */
export function NeedsYou({ t, s, except }: { t: Task; s: ProjectState; except?: string | null }) {
  const open = (t.requests ?? []).filter((r) => r.status === 'open' && r.id !== except);
  if (!open.length) return null;
  return (
    <section className="now-needs" aria-label="Needs you">
      <h2 className="now-label">Needs you</h2>
      {open.map((r) => (
        <InboxCard key={r.id} item={r} agentName={s.agents.find((a) => a.id === r.agent_id)?.name} />
      ))}
    </section>
  );
}

// ---------- Happening now ----------

/** The project directory and home prefix are noise in a one-line action. */
const shortPath = (p: string) => {
  const parts = String(p).split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : String(p);
};

/** A tool call in human terms: what the agent is doing with it, from the summary the transcript shows. */
export function actionText(e: AgentEvent): string {
  const d = e.data ?? {};
  const raw = String(d.name ?? '');
  const name = raw.startsWith('mcp__helm__') ? raw.slice('mcp__helm__'.length) : raw.replace(/^mcp__[^_]+__/, '');
  const sum = String(d.summary ?? '').trim();
  const of = (verb: string, what = sum) => (what ? `${verb} ${what}` : verb);
  switch (name) {
    case 'Bash':
      return of('Running', sum && `\`${sum}\``);
    case 'Read':
      return of('Reading', shortPath(sum));
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return of('Editing', shortPath(sum));
    case 'Write':
      return of('Writing', shortPath(sum));
    case 'Grep':
    case 'Glob':
      return of('Searching for', sum);
    case 'WebSearch':
      return of('Searching the web for', sum);
    case 'WebFetch':
      return of('Reading', sum);
    case 'Agent':
    case 'Task':
      return of('Handing off:', sum);
    case 'TodoWrite':
      return 'Updating its notes';
    case 'worklist_set':
    case 'worklist_update':
      return 'Updating its worklist';
    case 'report_status':
      return of('Status:', sum);
    case 'post_preview':
      return of('Posting a preview:', sum);
    case 'log_journal':
      return of('Writing to the journal:', sum);
    case 'ask_user':
      return of('Asking you:', sum);
    case 'ask_manager':
      return 'Asking its manager';
    case 'request_review':
      return 'Asking for review';
    case 'message_agent':
      return of('Messaging', sum);
    case 'spawn_agent':
      return of('Starting an agent:', sum);
    case 'task_post':
      return 'Writing in the task thread';
    case 'update_task':
      return 'Updating the task';
    case 'complete_task':
      return 'Finishing up';
    default:
      return of(`Using ${name}`, sum && `· ${sum}`);
  }
}

/** Calls the row already shows as its step and status line. */
const QUIET = ['mcp__helm__report_status', 'mcp__helm__worklist_set', 'mcp__helm__worklist_update'];
/** How many actions each agent's line shows. */
const ACTIONS_SHOWN = 2;
/** At most one re-render per agent row in this interval, however fast events arrive. */
const FLUSH_MS = 1500;

/** The last few tool calls of each of `ids`, live, with updates throttled. */
function useRecentActions(ids: string[]): Record<string, AgentEvent[]> {
  const [actions, setActions] = useState<Record<string, AgentEvent[]>>({});
  const buffer = useRef<Record<string, AgentEvent[]>>({});
  const timer = useRef<number | null>(null);
  const key = ids.join(',');

  useEffect(() => {
    let live = true;
    for (const id of ids) {
      api<{ events: AgentEvent[] }>(`/api/agents/${id}/events?limit=40`)
        .then((d) => live && push(id, d.events))
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [key]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const push = (id: string, events: AgentEvent[]) => {
    const tools = events.filter((e) => e.kind === 'tool' && !QUIET.includes(String(e.data?.name)));
    if (!tools.length) return;
    buffer.current[id] = [...(buffer.current[id] ?? []), ...tools];
    if (timer.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const add = buffer.current;
      buffer.current = {};
      setActions((cur) => {
        const next = { ...cur };
        for (const [aid, evs] of Object.entries(add)) {
          const seen = new Map([...(cur[aid] ?? []), ...evs].map((e) => [e.id, e]));
          next[aid] = [...seen.values()].sort((a, b) => a.id - b.id).slice(-ACTIONS_SHOWN);
        }
        return next;
      });
    }, FLUSH_MS);
  };

  useStream((m) => {
    if (m.type === 'event' && ids.includes(m.agentId) && m.event.kind === 'tool') push(m.agentId, [m.event]);
  });
  return actions;
}

const BUSY = ['working', 'waiting'];

/** One line per agent working on the task: its worklist step, status line and last actions. Fixed height per row. */
export function HappeningNow({ agents, driverId, pid }: { agents: Agent[]; driverId?: string | null; pid: string }) {
  const working = agents.filter((a) => BUSY.includes(a.status));
  const actions = useRecentActions(working.map((a) => a.id));
  if (!working.length) return null;
  // The driver first, then the others in the order they joined; a quick helper right after the agent that asked.
  const sorted = [...working].sort((a, b) => Number(b.id === driverId) - Number(a.id === driverId));
  const caller = (h: Agent) => (h.quick ? sorted.find((a) => a.id === h.parent_id) : undefined);
  const list = sorted.filter((a) => !caller(a)).flatMap((a) => [a, ...sorted.filter((h) => caller(h)?.id === a.id)]);
  return (
    <section className="card now-live" aria-label="Happening now">
      <h2 className="now-label">
        <span className="status-dot dot-working pulse" /> Happening now
      </h2>
      {list.map((a) => {
        // The step in hand: the newest one marked doing (an added step is usually what it just switched to), else the next to do.
        const items = (a.checklist ?? []).filter((i) => i.state !== 'dropped');
        const step = [...items].reverse().find((i) => i.state === 'doing') ?? items.find((i) => i.state === 'todo');
        const total = items.length;
        const at = step ? items.indexOf(step) : 0;
        const recent = [...(actions[a.id] ?? [])].reverse();
        return (
          <div key={a.id} className={`now-agent ${a.quick ? 'quick' : ''}`}>
            <div className="row now-agent-head">
              <a className="now-agent-name" href={href('p', pid, 'agents', a.id)}>
                {a.name}
              </a>
              <Status status={a.status} />
              <span className="spacer" />
              <a className="small now-transcript" href={href('p', pid, 'agents', a.id)}>
                Transcript
              </a>
            </div>
            {a.quick && !step ? null : (
              <p className="now-line" title={step?.text}>
                <span className="now-key">Step{total ? ` ${at + 1}/${total}` : ''}</span> {step ? <PlainRefs text={step.text} /> : <span className="muted">No worklist</span>}
              </p>
            )}
            <p className="now-line muted" title={a.status_line ?? ''}>
              {a.quick ? `Quick job${caller(a) ? ` for ${caller(a)!.name}` : ''}` : null}
              {a.quick && a.status_line ? ' · ' : null}
              {a.status_line ? <PlainRefs text={a.status_line} /> : a.quick ? null : ' '}
            </p>
            <ul className="now-actions">
              {Array.from({ length: ACTIONS_SHOWN }, (_, i) => {
                const e = recent[i];
                return (
                  <li key={i} className={`now-line mono-ish ${i === 0 ? 'newest' : ''}`} title={e ? actionText(e) : ''}>
                    {e ? actionText(e) : ' '}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

// ---------- Latest ----------

/** The newest status summary with its age, beside the newest preview (stacked on the phone). */
export function Latest({ t, latest, pid, final = false }: { t: Task; latest: TaskDetail['latest']; pid: string; final?: boolean }) {
  const shown = final ? latest : latest.slice(-1);
  const more = latest.length - shown.length;
  if (!t.status_summary && !shown.length) return null;
  return (
    <section className={`now-latest ${shown.length ? 'with-preview' : ''}`} aria-label="Latest">
      <div className="card now-summary">
        <span className="now-label">
          {final ? 'Final status' : 'Latest status'}
          {t.summary_at ? ` · ${ago(t.summary_at)}` : ''}
        </span>
        {t.status_summary ? <Markdown text={t.status_summary} /> : <p className="muted">No status written yet.</p>}
      </div>
      {shown.length > 0 && (
        <div className="now-previews">
          {shown.map((p) => (
            <figure key={p.id} className="card task-latest-item now-preview">
              <PreviewBody p={p} />
              <figcaption>
                <div className="row">
                  <strong>{p.title}</strong>
                  <span className="muted small">{ago(p.created_at)}</span>
                  <span className="spacer" />
                  <a className="small" href={href('p', pid, 'previews', p.id)}>
                    Open
                  </a>
                </div>
                {more > 0 && <p className="muted small">and {more} more posted with it, in the history below</p>}
              </figcaption>
            </figure>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- What changed ----------

const CHANGE_ICON: Record<string, string> = {
  state: 'play',
  importance: 'top',
  spec: 'spec',
  decision: 'check',
  milestone: 'check',
  preview: 'previews',
  question: 'inbox',
  answer: 'return',
  review: 'check',
  interject: 'discuss',
};

export function WhatChanged({ changes, onJump }: { changes: TaskChange[]; onJump: (key: string) => void }) {
  useTick(60000);
  if (!changes.length) return null;
  return (
    <section className="card now-changes" aria-label="What changed">
      <h2 className="now-label">What changed</h2>
      <ul>
        {changes.map((c) => (
          <li key={c.key}>
            <button className={`now-change ch-${c.kind}`} onClick={() => onJump(c.key)}>
              <Icon name={CHANGE_ICON[c.kind] ?? 'history'} size={15} />
              <span className="now-change-text">{c.text}</span>
              <span className="now-change-ts muted small">{ago(c.ts)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A labelled block of the plan (a planning task leads with it, above Approve's effects). */
export function PlanBlock({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <section className="card now-plan" aria-label="The plan">
      <h2 className="now-label">The plan</h2>
      {text ? <Markdown text={text} /> : <p className="muted">No plan written yet. The director writes it into the description.</p>}
      {children}
    </section>
  );
}
