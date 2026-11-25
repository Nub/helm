import { useState } from 'react';
import { api, useLive } from './api';
import type { InboxItem, ProjectState } from './api';
import { Empty, Icon, Tag, clock, href, useAction, PageHeader } from './ui';
import { timeOfDay } from './time';

/** An always-allow rule the director made for one agent (decide_permission allow_always). */
export type Rule = { id: string; agent_id: string; agent_name: string | null; tool_name: string; rule_content: string | null; reason: string; created_at: number; revoked_at: number | null };

const ruleLabel = (r: Rule) => (r.rule_content ? `${r.tool_name}(${r.rule_content})` : `any ${r.tool_name} call`);

function RuleRow({ r, pid }: { r: Rule; pid: string }) {
  const { busy, error, run } = useAction();
  return (
    <li className={`card decision ${r.revoked_at ? 'revoked' : ''}`}>
      <div className="decision-head">
        <span className="mono rule-text">{ruleLabel(r)}</span>
        {r.revoked_at ? (
          <span className="muted small">Revoked {clock(r.revoked_at)}</span>
        ) : (
          <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/api/projects/${pid}/rules/${r.id}/revoke`, { method: 'POST' }))}>
            Revoke
          </button>
        )}
      </div>
      <p className="small">
        {r.agent_name ?? 'An agent'} may do this without asking · made by Director {clock(r.created_at)}
      </p>
      {r.reason && <p className="small decision-why">{r.reason}</p>}
      {error && <p className="error-text">{error}</p>}
    </li>
  );
}

/**
 * Permission requests decided on the user's behalf (server/triage.ts): in an Unrestricted project, those the danger
 * check did not flag are allowed at once. They show as a collapsed line in the task's thread (consecutive ones
 * grouped) and as a list per project, newest first.
 */

export type Decision = {
  id: string;
  agent_id: string | null;
  agent_name: string | null;
  task_id: string | null;
  task_title: string | null;
  task_kind: string | null;
  title: string;
  answer: string;
  answered_at: number;
  created_at: number;
  decided_by: string;
  decision_reason: string;
  toolName: string;
  summary: string;
  input: string;
};

export const DECIDER: Record<string, string> = { auto: 'Allowed automatically', director: 'Director', check: 'Independent check' };

/** What a decision made for the user says, in a few words. */
export function decisionLabel(d: { decided_by: string | null; answer: string }): string {
  if (d.decided_by === 'auto') return 'Allowed automatically';
  const verb = /^Deny/.test(d.answer) ? 'Denied' : /^Always/.test(d.answer) ? 'Always allowed' : 'Allowed';
  return `${verb} by ${DECIDER[d.decided_by ?? ''] ?? 'Helm'}`;
}

const toolLine = (toolName: string, summary: string) => `${toolName.replace(/^mcp__([^_]+)__/, '$1: ')}${summary ? `: ${summary}` : ''}`;

/** Consecutive requests allowed automatically, in a thread: one collapsed line. */
export function AutoAllowedGroup({ items }: { items: InboxItem[] }) {
  const first = items[0];
  const last = items[items.length - 1];
  const who = [...new Set(items.map((i) => i.agent_name ?? 'An agent'))].join(', ');
  return (
    <details className="tl-auto">
      <summary>
        <Icon name="check" size={16} /> <span>
          {items.length === 1 ? 'Allowed automatically' : `${items.length} commands allowed automatically`}
          <span className="muted"> · {who} · {clock(first.created_at)}{items.length > 1 && last.created_at - first.created_at > 60_000 ? `–${timeOfDay(last.created_at)}` : ''}</span>
        </span>
      </summary>
      <p className="muted small">The project is Unrestricted and these were not on the dangerous list, so Helm allowed them without asking.</p>
      <ul>
        {items.map((i) => (
          <li key={i.id}>
            <details className="tool-input">
              <summary className="mono">{i.line}</summary>
              <pre>{i.payload.input}</pre>
            </details>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Setup's "Decisions made for you": every permission decided on the user's behalf, newest first. */
export function DecisionsPage({ s }: { s: ProjectState }) {
  const pid = s.project.id;
  const { data, error } = useLive<{ decisions: Decision[]; rules?: Rule[] }>(`/api/projects/${pid}/decisions`, (m) => m.type === 'project' && m.projectId === pid);
  const [onlyAllows, setOnlyAllows] = useState(false);
  const list = (data?.decisions ?? []).filter((d) => !onlyAllows || !/^Deny/.test(d.answer));
  return (
    <section className="narrow decisions-page">
      <a className="back" href={href('p', pid, 'setup')}>
        <Icon name="back" size={16} /> Setup
      </a>
      <PageHeader title="Decisions made for you" />
      <p className="muted">
        Permission requests Helm answered without asking you, newest first.{' '}
        {s.project.autonomy === 'full'
          ? 'This project is Unrestricted: anything not on the dangerous list is allowed automatically; the rest still asks you.'
          : s.project.permission_answerer === 'director'
            ? 'The director answers routine requests first; anything on the dangerous list, and anything it is unsure about, comes to you.'
            : 'New requests on this project ask you.'}
      </p>
      {(data?.rules ?? []).length > 0 && (
        <>
          <h2>Always-allow rules the director made</h2>
          <ul className="decision-list">
            {data!.rules!.map((r) => (
              <RuleRow key={r.id} r={r} pid={pid} />
            ))}
          </ul>
          <h2>Decisions</h2>
        </>
      )}
      <label className="check">
        <input type="checkbox" checked={onlyAllows} onChange={(e) => setOnlyAllows(e.target.checked)} /> Only allows
      </label>
      {error && <p className="error-text">{error}</p>}
      {!data && !error && <div className="loading">Loading…</div>}
      {data && list.length === 0 && <Empty title="No decisions yet" />}
      <ul className="decision-list">
        {list.map((d) => (
          <li key={d.id} className="card decision">
            <div className="decision-head">
              <Tag tone={/^Deny/.test(d.answer) ? 'tone-serious' : 'st-done'}>{decisionLabel(d)}</Tag>
              <span className="muted small">{clock(d.answered_at ?? d.created_at)}</span>
            </div>
            <details className="tool-input">
              <summary className="mono">{toolLine(d.toolName, d.summary)}</summary>
              <pre>{d.input}</pre>
            </details>
            <p className="small">
              {d.agent_id ? <a href={href('p', pid, 'agents', d.agent_id)}>{d.agent_name ?? 'An agent'}</a> : 'An agent'}
              {d.task_id && d.task_title && (
                <>
                  {' · '}
                  <a href={href('p', pid, d.task_kind === 'discussion' ? 'discussions' : 'tasks', d.task_id)}>{d.task_title}</a>
                </>
              )}
            </p>
            {d.decision_reason && <p className="small decision-why">{d.decision_reason}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
