import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, useStream } from './api';
import type { Agent, AgentEvent, ProjectState, RunningCommand, Task, TaskDetail } from './api';
import { InboxCard } from './inbox';
import { Fold } from './fold';
import { Markdown, Status, ago, href, PlainRefs, useTick } from './ui';

/**
 * The top of a task's page: what is happening now, so the user can step in while it happens. In order: open
 * requests (Needs you), the agents working on it this moment (Happening now), the newest status summary
 * (Latest), and the last few notable changes (What changed). The header and the chat's docked bar
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
 * Running time while active ("started 2:02 pm · running 37 min"), what it took once done, and whether its driver finished
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
        <InboxCard key={r.id} item={r} agentName={s.agents.find((a) => a.id === r.agent_id)?.name} context={false} />
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
    case 'Bash': {
      // The plain words the agent gave the command, else the command without its leading "cd somewhere &&".
      const said = /"description":\s*"((?:[^"\\]|\\.)*)"/.exec(String(d.input ?? ''))?.[1];
      if (said) return said.replace(/\\(.)/g, '$1');
      const cmd = sum.replace(/^cd \S+\s*&&\s*/, '');
      return of('Running', cmd && `\`${cmd}\``);
    }
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
/** How many recent actions are kept per agent. */
const ACTIONS_SHOWN = 5;
/** At most one re-render per agent row in this interval, however fast events arrive. */
const FLUSH_MS = 1500;

/** The last few tool calls (`keep`) of each of `ids`, live, with updates throttled. */
export function useRecentActions(ids: string[], keep = ACTIONS_SHOWN): Record<string, AgentEvent[]> {
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
          next[aid] = [...seen.values()].sort((a, b) => a.id - b.id).slice(-keep);
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

/** How many actions open under an agent's line on the title card. */
const ACTIONS_ON_TAP = 5;

/**
 * Every unfinished agent on the task, one per line, working ones first (then the driver): name, state, and for a
 * working one what it is doing this moment, from its newest tool call ("Editing …/web/src/tasks.tsx · 2 min"), with
 * its last five on tap. `max`: the title strip shows the first line only.
 */
export function TaskAgents({ agents, driverId, pid, max }: { agents: Agent[]; driverId?: string | null; pid: string; max?: number }) {
  const on = agents.filter((a) => a.status !== 'closed' && a.status !== 'done');
  const busy = (a: Agent) => BUSY.includes(a.status);
  const sorted = [...on].sort((a, b) => Number(busy(b)) - Number(busy(a)) || Number(b.id === driverId) - Number(a.id === driverId));
  const shown = sorted.slice(0, max ?? sorted.length);
  const actions = useRecentActions(shown.filter(busy).map((a) => a.id), ACTIONS_ON_TAP);
  useTick(30_000);
  if (!shown.length) return null;
  return (
    <div className="task-crew small">
      {shown.map((a) => {
        const recent = busy(a) ? [...(actions[a.id] ?? [])].reverse() : [];
        const now = recent[0];
        // Between turns with work in hand (server/busy.ts): what it waits on, not its last tool call.
        const line = a.busy_between_turns ? a.status_line : now ? actionText(now) : '';
        // How long since that action began, on the name's row so a long action never cuts it off.
        const since = now ? duration(Date.now() - now.ts).replace('under a minute', 'just now') : '';
        const head = (
          <>
            <a href={href('p', pid, 'agents', a.id)} onClick={(e) => e.stopPropagation()}>
              {a.name}
            </a>
            <Status status={a.status} />
            {since && <span className="muted">{since}</span>}
          </>
        );
        const nowLine = line && <span className="task-agent-now one-line" title={line}>{line}</span>;
        return recent.length > 1 && max === undefined ? (
          <details key={a.id} className="task-agent-line">
            <summary>
              <span className="row">{head}</span>
              {nowLine}
            </summary>
            <ul className="task-agent-recent">
              {recent.slice(1).map((e) => (
                <li key={e.id} className="one-line muted" title={actionText(e)}>
                  {actionText(e)} · {ago(e.ts)}
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <div key={a.id} className="task-agent-line">
            <span className="row">{head}</span>
            {nowLine}
          </div>
        );
      })}
    </div>
  );
}

/** The commands running for the task now, one per line: what it is, the host of a heavy job, and how long so far. */
export function TaskCommands({ commands }: { commands?: RunningCommand[] }) {
  useTick(15_000);
  if (!commands?.length) return null;
  return (
    <ul className="task-commands small">
      {commands.map((c) => {
        const what = c.label || c.command.replace(/^cd \S+\s*&&\s*/, '');
        const took = duration(Date.now() - c.started_at).replace('under a minute', 'just started');
        return (
          <li key={c.id} title={c.command}>
            <span className="one-line">{what}</span>
            <span className="muted">
              {c.host_name ? `${c.host_name} · ` : ''}
              {took}
              {c.expected_ms && c.expected_ms >= 60_000 ? ` of ~${Math.round(c.expected_ms / 60_000)} min` : ''}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------- Latest ----------

/** The newest status summary with its age. Previews are not repeated here: the latest ones are pinned under For review. */
export function Latest({ t, final = false }: { t: Task; final?: boolean }) {
  if (!t.status_summary) return null;
  return (
    <Fold kind="status" title={`${final ? 'Final status' : 'Latest status'}${t.summary_at ? ` · ${ago(t.summary_at)}` : ''}`} className="now-summary" label="Latest status">
      <Markdown text={t.status_summary} />
    </Fold>
  );
}

// ---------- What changed ----------

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
