import { useState } from 'react';
import { api } from './api';
import type { Agent, ProjectState } from './api';
import { PreviewTile } from './preview';
import { Checklist } from './project';
import { ScheduledResume } from './needs';
import { Fold } from './fold';
import { agentLists, filterPast, pastTasks } from './agentlists';
import { Clamp, EdgeProgress, Empty, Icon, Status, go, href, modelLabel, runLabel, useAction , PlainRefs, openPreview } from './ui';

const FINISHED = ['done', 'closed'];

/**
 * The team as a tree: the Overview's Team section and the Agents tab are this
 * same view. Tapping an agent opens its detailed work in place; transcript and
 * direct messages are deliberately secondary, since the user normally talks to
 * the director, who relays.
 */
export function Team({ s, page = false }: { s: ProjectState; page?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  // Only the agents running now; past ones fold away below, and builder subagents show on their tasks (agentlists.ts).
  const { open: visible, past } = agentLists(s.agents);
  const ids = new Set(visible.map((a) => a.id));

  // Each agent, then what works under it. Agents stopped with an error come first, at the top level, each with what
  // works under it (agenterrors).
  const rows: { a: Agent; depth: number }[] = [];
  const errored = (a: Agent) => a.status === 'error';
  const walk = (parent: string | null, depth: number) => {
    for (const a of visible) {
      if (errored(a)) continue;
      // An agent whose parent is hidden is listed at the top level.
      const top = !a.parent_id || !ids.has(a.parent_id);
      if (parent === null ? top : a.parent_id === parent) {
        rows.push({ a, depth });
        walk(a.id, depth + 1);
      }
    }
  };
  for (const a of visible.filter(errored)) {
    rows.push({ a, depth: 0 });
    walk(a.id, 1);
  }
  walk(null, 0);

  return (
    <section className={`team ${page ? 'team-page' : ''}`}>
      <div className="section-head">
        {page ? <h1 className="page-title">Agents</h1> : <h2>Team</h2>}
        {!page && <a href={href('p', s.project.id, 'agents')}>All agents</a>}
      </div>
      {rows.length === 0 && <Empty title="No active agents" />}
      <div className="team-tree">
        {rows.map(({ a, depth }) => (
          <AgentRow key={a.id} a={a} s={s} depth={depth} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} />
        ))}
      </div>
      {page && past.length > 0 && <PastAgents s={s} past={past} open={open} setOpen={setOpen} />}
    </section>
  );
}

/** Agents that have ended, collapsed by default, with a search and a filter by task. */
function PastAgents({ s, past, open, setOpen }: { s: ProjectState; past: Agent[]; open: string | null; setOpen: (id: string | null) => void }) {
  const [q, setQ] = useState('');
  const [task, setTask] = useState('');
  const shown = filterPast(past, q, task);
  const title = (id: string) => s.tasks.find((t) => t.id === id)?.title ?? id;
  return (
    <Fold kind="past-agents" title="Past agents" note={String(past.length)} openByDefault={false} className="past-agents" label="Past agents">
      <div className="past-agents-tools">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search past agents" aria-label="Search past agents" />
        <select value={task} onChange={(e) => setTask(e.target.value)} aria-label="Filter by task">
          <option value="">All tasks</option>
          {pastTasks(past).map((t) => (
            <option key={t.id} value={t.id}>
              {title(t.id)} ({t.count})
            </option>
          ))}
        </select>
      </div>
      {shown.length === 0 && <p className="muted small">No past agents match.</p>}
      <div className="team-tree">
        {shown.slice(0, 100).map((a) => (
          <AgentRow key={a.id} a={a} s={s} depth={0} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} />
        ))}
      </div>
      {shown.length > 100 && <p className="muted small">{shown.length - 100} more: search or pick a task to narrow them.</p>}
    </Fold>
  );
}

function AgentRow({ a, s, depth, open, onToggle }: { a: Agent; s: ProjectState; depth: number; open: boolean; onToggle: () => void }) {
  const task = a.task_id ? s.tasks.find((t) => t.id === a.task_id) : undefined;
  const isRoot = !a.parent_id;
  const finished = FINISHED.includes(a.status);
  const pid = s.project.id;
  // Waiting on its manager: a blocking question or a review request it sent and has no answer to yet.
  // The status line usually says so already (consults.ts sets it); the tag covers the agent having changed it since.
  const pending = (s.consults ?? []).find((c) => c.asker_id === a.id && c.blocking);
  const waiting = pending && !a.status_line.startsWith('Waiting for') ? pending : undefined;
  // Stopped with an error: what went wrong in one line (its open entry under Needs you), and Resume on the row.
  const err = a.status === 'error' ? s.inbox.find((i) => i.agent_id === a.id && i.kind === 'agent_error' && i.status === 'open') : undefined;
  const resume = useAction();
  return (
    <article
      className={`card agent-row ${a.status === 'error' ? 'errored' : ''} ${finished ? 'finished' : ''} ${open ? 'open' : ''} ${a.quick ? 'quick' : ''}`}
      style={{ marginLeft: `calc(var(--indent) * ${Math.min(depth, 3)})` }}
    >
      <button className="agent-row-head" onClick={onToggle} aria-expanded={open}>
        <div className="row">
          <strong className="agent-row-name">{a.name}</strong>
          {/* A builder is shown with its task (Helm starts one per task, dispatch.ts). */}
          {task && !isRoot && <span className="muted small one-line agent-row-for">{task.title}</span>}
          <span className="spacer" />
          <Status status={a.status} />
        </div>
        {/* One line: what went wrong, else what it is doing. */}
        {err ? (
          <p className="small agent-row-error one-line">{err.payload.plain ?? err.title}</p>
        ) : (
          <p className="small muted agent-row-line">
            {runLabel(a) && <span className="agent-run">{runLabel(a)}</span>}
            {(a.status_line || waiting) && (
              <span className="agent-run-status one-line">{a.status_line ? <PlainRefs text={a.status_line} strip /> : waiting!.kind === 'review' ? 'Waiting for review' : 'Waiting for an answer'}</span>
            )}
          </p>
        )}
      </button>
      {a.status === 'error' && !open && a.resume_text && (
        <div className="agent-row-fix">
          <ScheduledResume agentId={a.id} text={a.resume_text} />
        </div>
      )}
      {a.status === 'error' && !open && !a.resume_text && (
        <div className="agent-row-fix">
          <button className="btn small primary" disabled={resume.busy} onClick={() => resume.run(() => api(`/api/agents/${a.id}/resume`, { method: 'POST', body: {} }))}>
            <Icon name="play" size={16} /> Resume
          </button>
          {err?.task_id && (
            <a className="btn small quiet" href={href('p', pid, err.task_id === task?.id ? 'tasks' : 'discussions', err.task_id, err.id)}>
              Details
            </a>
          )}
          {resume.error && <p className="error-text small">{resume.error}</p>}
        </div>
      )}
      {open && <AgentWork a={a} s={s} isRoot={isRoot} />}
      {!finished && <EdgeProgress value={a.progress} live={a.status === 'working'} />}
    </article>
  );
}

/**
 * Quick helpers an agent used that have finished, as one line ("3 quick jobs done") that opens
 * to each job's brief and report. Shared by the team tree and the task page.
 */
export function QuickDone({ helpers, pid, depth = 0 }: { helpers: Agent[]; pid: string; depth?: number }) {
  if (!helpers.length) return null;
  return (
    <details className="quick-done" style={{ marginLeft: `calc(var(--indent) * ${Math.min(depth, 3)})` }}>
      <summary className="small">
        <Icon name="check" size={16} /> {helpers.length} quick {helpers.length === 1 ? 'job' : 'jobs'} done
      </summary>
      <ul className="quick-done-list">
        {helpers.map((h) => (
          <li key={h.id}>
            <div className="row wrap">
              <a href={href('p', pid, 'agents', h.id)}>{h.name}</a>
              <span className="muted small">{modelLabel(h.model)}</span>
              <span className="spacer" />
              <Status status={h.status} />
            </div>
            <div className="small">{h.last_result ? <Clamp text={h.last_result} lines={4} /> : <p className="muted">No report.</p>}</div>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** An agent's detailed work, shown when its row is expanded. */
function AgentWork({ a, s, isRoot }: { a: Agent; s: ProjectState; isRoot: boolean }) {
  const pid = s.project.id;
  const previews = s.previews.filter((p) => p.agent_id === a.id).slice(0, 4);
  const children = s.agents.filter((c) => c.parent_id === a.id);
  const { busy, error, run } = useAction();
  const post = (action: string) => run(() => api(`/api/agents/${a.id}/${action}`, { method: 'POST', body: {} }));

  return (
    <div className="agent-work">
      <div className="agent-work-block">
        <span className="label">Worklist</span>
        <Checklist agent={a} />
      </div>
      {a.task && (
        <div className="agent-work-block">
          <span className="label">Brief</span>
          <Clamp text={a.task} lines={5} />
        </div>
      )}
      {a.last_result && (
        <div className="agent-work-block">
          <span className="label">Latest report</span>
          <Clamp text={a.last_result} lines={6} />
        </div>
      )}
      {previews.length > 0 && (
        <div className="agent-work-block">
          <span className="label">Recent previews</span>
          <div className="preview-strip">
            {previews.map((p) => (
              <PreviewTile key={p.id} p={p} onOpen={() => openPreview(pid, p.id)} />
            ))}
          </div>
        </div>
      )}
      {children.length > 0 && (
        <div className="agent-work-block">
          <span className="label">Manages</span>
          <p className="small">
            {children.map((c, i) => (
              <span key={c.id}>
                {i > 0 && ', '}
                {c.name} <span className="muted">({c.status})</span>
              </span>
            ))}
          </p>
        </div>
      )}

      <div className="agent-work-foot">
        <div className="row wrap">
          {['working', 'waiting'].includes(a.status) && (
            <button className="btn small" disabled={busy} onClick={() => post('stop')}>
              <Icon name="stop" size={16} /> Stop turn
            </button>
          )}
          {['interrupted', 'error'].includes(a.status) && (
            <button className="btn small" disabled={busy} onClick={() => post('resume')}>
              <Icon name="play" size={16} /> Resume
            </button>
          )}
          {!isRoot && a.status !== 'closed' && (
            <button className="btn small quiet" disabled={busy} onClick={() => confirm(`Close ${a.name}? Its history stays.`) && post('close')}>
              Close agent
            </button>
          )}
          <span className="spacer" />
          <a className="btn small quiet" href={href('p', pid, 'agents', a.id)}>
            Open transcript
          </a>
          {isRoot ? (
            <a className="btn small quiet" href={href('p', pid)}>
              Talk in the conversation
            </a>
          ) : (
            <a className="btn small quiet" href={href('p', pid, 'agents', a.id)}>
              Message this agent directly
            </a>
          )}
        </div>
        {error && <p className="error-text">{error}</p>}
        <p className="muted small">
          {isRoot
            ? 'This is the director: you talk with it in the chat, from the bar at the foot of every project page.'
            : 'Normally you talk to the director, who relays. Message an agent directly only when that is quicker.'}
        </p>
      </div>
    </div>
  );
}
