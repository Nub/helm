import { useState } from 'react';
import { api } from './api';
import type { Agent, ProjectState } from './api';
import { HostBadges } from './hosts';
import { PreviewTile } from './preview';
import { Checklist, progressLabel } from './project';
import { roleAnchor } from './roles';
import { Clamp, Empty, Icon, Progress, Status, Tag, go, href, modelLabel, useAction , PlainRefs } from './ui';

const FINISHED = ['done', 'closed'];

/**
 * The team as a tree: the Overview's Team section and the Agents tab are this
 * same view. Tapping an agent opens its detailed work in place; transcript and
 * direct messages are deliberately secondary, since the user normally talks to
 * the director, who relays.
 */
export function Team({ s, page = false }: { s: ProjectState; page?: boolean }) {
  const [showFinished, setShowFinished] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const finishedCount = s.agents.filter((a) => FINISHED.includes(a.status)).length;
  // Finished quick helpers never get a row of their own: they collapse into a count under the agent that asked.
  const visible = s.agents.filter((a) => !(a.quick && FINISHED.includes(a.status)) && ((page && showFinished) || !FINISHED.includes(a.status)));
  const ids = new Set(visible.map((a) => a.id));

  // Each agent, then what works under it, then its finished quick helpers folded into one line.
  const rows: { a: Agent; depth: number; done?: Agent[] }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const a of visible) {
      // An agent whose parent is hidden is listed at the top level.
      const top = !a.parent_id || !ids.has(a.parent_id);
      if (parent === null ? top : a.parent_id === parent) {
        rows.push({ a, depth });
        walk(a.id, depth + 1);
        const done = s.agents.filter((h) => h.parent_id === a.id && h.quick && FINISHED.includes(h.status));
        if (done.length) rows.push({ a, depth: depth + 1, done });
      }
    }
  };
  walk(null, 0);

  return (
    <section className={`team ${page ? 'team-page' : ''}`}>
      <div className="section-head">
        {page ? <h1 className="page-title">Agents</h1> : <h2>Team</h2>}
        {page
          ? finishedCount > 0 && (
              <label className="check">
                <input type="checkbox" checked={showFinished} onChange={(e) => setShowFinished(e.target.checked)} /> Show finished ({finishedCount})
              </label>
            )
          : <a href={href('p', s.project.id, 'agents')}>All agents{finishedCount ? ` (${s.agents.length})` : ''}</a>}
      </div>
      {rows.length === 0 && <Empty title="No active agents">Message the director to start work.</Empty>}
      <div className="team-tree">
        {rows.map(({ a, depth, done }) =>
          done ? (
            <QuickDone key={`${a.id}-done`} helpers={done} pid={s.project.id} depth={depth} />
          ) : (
            <AgentRow key={a.id} a={a} s={s} depth={depth} open={open === a.id} onToggle={() => setOpen(open === a.id ? null : a.id)} />
          ),
        )}
      </div>
    </section>
  );
}

function AgentRow({ a, s, depth, open, onToggle }: { a: Agent; s: ProjectState; depth: number; open: boolean; onToggle: () => void }) {
  const role = s.project.structure.roles.find((r) => r.id === a.role_id);
  const task = a.task_id ? s.tasks.find((t) => t.id === a.task_id) : undefined;
  const isRoot = !a.parent_id;
  const finished = FINISHED.includes(a.status);
  const pid = s.project.id;
  // Waiting on its manager: a blocking question or a review request it sent and has no answer to yet.
  // The status line usually says so already (consults.ts sets it); the tag covers the agent having changed it since.
  const pending = (s.consults ?? []).find((c) => c.asker_id === a.id && c.blocking);
  const waiting = pending && !a.status_line.startsWith('Waiting for') ? pending : undefined;
  const manager = waiting && s.agents.find((x) => x.id === waiting.manager_id)?.name;
  const asked = (s.consults ?? []).filter((c) => c.manager_id === a.id).length;
  return (
    <article
      className={`card agent-row ${finished ? 'finished' : ''} ${open ? 'open' : ''} ${a.quick ? 'quick' : ''}`}
      style={{ marginLeft: `calc(var(--indent) * ${Math.min(depth, 3)})` }}
    >
      <button className="agent-row-head" onClick={onToggle} aria-expanded={open}>
        <div className="row">
          <strong className="agent-row-name">{a.name}</strong>
          <span className="spacer" />
          <Status status={a.status} />
        </div>
        <div className="row wrap agent-row-meta">
          <span className="muted small">
            {a.quick ? 'Quick job' : role?.name ?? a.role_id} · {modelLabel(a.model)}
          </span>
          <HostBadges agentId={a.id} s={s} />
        </div>
        {a.status_line && <p className="small agent-row-line"><PlainRefs text={a.status_line} /></p>}
        {(waiting || asked > 0) && (
          <p className="row wrap agent-row-consult">
            {waiting && <Tag tone="tone-warning">{waiting.kind === 'review' ? 'Waiting for review' : 'Waiting for an answer'}{manager ? ` from ${manager}` : ''}</Tag>}
            {asked > 0 && <Tag tone="tone-accent">{asked} {asked === 1 ? 'question' : 'questions'} to answer</Tag>}
          </p>
        )}
        {a.progress !== null && !finished && (
          <div className="overall">
            <Progress value={a.progress} tone={a.status === 'working' ? 'live' : ''} />
            <span className="mono small">{progressLabel(a)}</span>
          </div>
        )}
      </button>
      {/* A quick helper works on its caller's task, which the caller's row already names. */}
      {task && !(a.quick && s.agents.find((p) => p.id === a.parent_id)?.task_id === a.task_id) && (
        <a className="agent-row-task small" href={href('p', pid, 'tasks', task.id)}>
          Task: {task.title}
        </a>
      )}
      {open && <AgentWork a={a} s={s} isRoot={isRoot} />}
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
        <Icon name="check" size={14} /> {helpers.length} quick {helpers.length === 1 ? 'job' : 'jobs'} done
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
      <p className="small">
        Role:{' '}
        <a href={href('p', pid, 'setup', roleAnchor(a.role_id))}>{s.project.structure.roles.find((r) => r.id === a.role_id)?.name ?? a.role_id}</a>
        <span className="muted"> · its purpose, instructions and tools</span>
      </p>
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
              <PreviewTile key={p.id} p={p} onOpen={() => go('p', pid, 'previews', p.id)} />
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
              <Icon name="stop" size={14} /> Stop turn
            </button>
          )}
          {['interrupted', 'error'].includes(a.status) && (
            <button className="btn small" disabled={busy} onClick={() => post('resume')}>
              <Icon name="play" size={14} /> Resume
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
