import { useEffect, useState } from 'react';
import { FoldHead, useFold } from './fold';
import { api, useLive } from './api';
import type { InboxItem, Task } from './api';
import { Icon, href, useAction } from './ui';
import { InboxCard, ReminderLine } from './inbox';

/**
 * Needs response: a task or discussion with at least one open request (an agent's question, a permission an
 * agent is blocked on, a team change to approve). There is no separate inbox: requests live on the task or
 * discussion they concern and are answered there, from its row in a list or from its thread. Both use the same
 * call, so answering in one place clears it in the other, and a second answer is refused by the server.
 */

/** A row that can need a response: a task or a discussion (Discussion has the same fields for this). */
export type NeedsRow = Pick<Task, 'id' | 'project_id' | 'title' | 'needs_response' | 'needs_blocking' | 'requests' | 'proposal' | 'holder'> & { state: string; kind?: string };

export const needsResponse = (t: { needs_response?: number }) => (t.needs_response ?? 0) > 0;

/** Blocking first, then the row whose oldest request has waited longest. */
export function byUrgency<T extends NeedsRow>(list: T[]): T[] {
  const first = (t: T) => Math.min(...(t.requests ?? []).map((r) => r.created_at), Infinity);
  return [...list].sort((a, b) => Number(!!b.needs_blocking) - Number(!!a.needs_blocking) || first(a) - first(b));
}

/** `attachments`: ids of files uploaded for this request (owner "request:<id>"); a question's answer may be files only. */
export const answerRequest = (id: string, body: { choice?: string; text?: string; dismiss?: boolean; attachments?: string[]; all?: boolean; perform?: boolean }) => api(`/api/requests/${id}/answer`, { body });

/** Labels of a request's inline action (server: reqactions.ts). */
const ACT_LABEL: Record<string, string> = { approve_task: 'Approve', start_task: 'Start now', resume_task: 'Resume', update_helm: 'Update now', restart_agents: 'Restart agents now', cut_release: 'Cut release', publish_release: 'Publish', spec_create: 'Build a Spec', install_tool: 'Install' };
/**
 * A request's inline action, if any: `button` is its own primary button (tapping sends perform and Helm does it);
 * `option` is the option it rides on (choosing that option does it), which is then the primary answer.
 */
export function actOf(r: InboxItem): { button: string | null; option: string | null } | null {
  const a = r.payload.act;
  if (!a || (r.kind !== 'question' && r.kind !== 'action')) return null;
  return a.option ? { button: null, option: a.option } : { button: ACT_LABEL[a.kind] ?? 'Do it', option: null };
}

/** What a request asks the user to provide, for its row: "an image" or "a file", or null. */
export const wantsWhat = (r: InboxItem) => (r.kind !== 'question' || !r.payload.wants ? null : r.payload.wants === 'image' ? 'an image' : 'a file');

/** The paperclip marking a request that asks for a file, beside its one-line summary. */
export function WantsMark({ r }: { r: InboxItem }) {
  const what = wantsWhat(r);
  if (!what) return null;
  return (
    <span className="req-wants" title={`Asks you for ${what}`}>
      <Icon name="clip" size={16} />
      {`Asks for ${what}`}
    </span>
  );
}

const pageOf = (t: { kind?: string }) => (t.kind === 'discussion' ? 'discussions' : 'tasks');
/** The thread of the row, scrolled to one request. */
export const requestHref = (t: { project_id: string; id: string; kind?: string }, requestId: string) => href('p', t.project_id, pageOf(t), t.id, requestId);

export const KIND_LABEL: Record<InboxItem['kind'], string> = { question: 'Decision', action: 'To do', permission: 'Permission', structure: 'Team change', agent_error: 'Stopped' };
export const kindTone = (k: InboxItem['kind']) => (k === 'agent_error' ? 'tone-critical' : k === 'permission' ? 'tone-serious' : k === 'structure' ? 'tone-warning' : k === 'action' ? 'tone-todo' : 'tone-accent');

/** An agent_error's answers (server: agenterrors.ts choicesFor): the wait only while the reset is ahead; the director's own has no Ask the director. */
export const WAIT = 'Resume when the limit resets';
// The first is the primary button: while the reset is ahead, waiting for it (resuming now would only hit the limit again).
export const errorChoices = (r: InboxItem) => [...(r.payload.can_wait ? [WAIT, 'Resume'] : ['Resume']), ...(r.payload.root ? [] : ['Ask the director']), 'Close the agent'];
/** Resume and the wait can apply to every agent stopped by the same limit ("all N", default on). */
export const appliesToAll = (c: string) => c === 'Resume' || c === WAIT;

/** The "all N stopped by this limit" checkbox, when more than one agent of the project is stopped by it. */
export function LimitAll({ r, all, setAll }: { r: InboxItem; all: boolean; setAll: (v: boolean) => void }) {
  const n = r.payload.limit_peers ?? 0;
  if (r.kind !== 'agent_error' || n < 2) return null;
  return (
    <label className="check limit-all">
      <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Resume all {n} stopped by this limit
    </label>
  );
}

/** A resume Helm will make when the limit resets, with Cancel (the entry comes back). */
export function ScheduledResume({ agentId, text }: { agentId: string | null; text?: string | null }) {
  const { busy, error, run } = useAction();
  if (!text || !agentId) return null;
  return (
    <p className="scheduled-resume small">
      <Icon name="play" size={16} /> {text}
      <button className="btn small quiet" disabled={busy} onClick={() => run(() => api(`/api/agents/${agentId}/cancel-resume`, { method: 'POST', body: {} }))}>
        Cancel
      </button>
      {error && <span className="error-text">{error}</span>}
    </p>
  );
}

/** What Claude Code said when the agent stopped, behind a disclosure, with how often it has failed in a row. */
export function ErrorDetails({ r, open = false }: { r: InboxItem; open?: boolean }) {
  if (r.kind !== 'agent_error') return null;
  const n = r.payload.count ?? 1;
  return (
    <details className="tool-input err-details" open={open}>
      <summary>Details{n > 1 ? ` · failed ${n} times in a row` : ''}</summary>
      {r.payload.doing && (
        <p className="small">
          <span className="label">Was doing</span> {r.payload.doing}
        </p>
      )}
      <pre>{r.payload.raw || '(Claude Code said nothing more)'}</pre>
    </details>
  );
}
/** An action's answers (server: requests.ts ACTION_CHOICES). */
export const ACTION_CHOICES = ['Done', "Can't / not yet"] as const;

/** Open requests, most important first: blocking, then importance, then the longest waiting. */
export const byImportance = (list: InboxItem[]) => [...list].sort((a, b) => Number(!!b.blocking) - Number(!!a.blocking) || (b.importance ?? 3) - (a.importance ?? 3) || a.created_at - b.created_at);

/** The group pinned at the top of the Tasks and Discussions lists: each open request as its full card (inbox.tsx). */
export function NeedsGroup({ list, title = 'Needs response' }: { list: NeedsRow[]; title?: string }) {
  const requests = byImportance(list.flatMap((t) => (t.requests ?? []).filter((r) => r.status === 'open').map((r) => ({ ...r, task_title: r.task_title ?? (t.holder ? null : t.title), task_kind: r.task_kind ?? (t.kind === 'discussion' ? 'discussion' : 'task') }))));
  if (!requests.length) return null;
  return (
    <div className="task-group group-needs">
      <h3 className="group-title">
        <Icon name="inbox" size={16} /> {title}
      </h3>
      <div className="stack">
        {requests.map((r) => (
          <InboxCard key={r.id} item={r} />
        ))}
      </div>
    </div>
  );
}

/**
 * Opening a thread at a request (from a row's Answer): scroll it into view once the thread has rendered, and
 * mark it briefly. Waits up to a few seconds for the data to load.
 */
export function useFocusRequest(id?: string) {
  useEffect(() => {
    if (!id) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = document.getElementById(`req-${id}`);
      if (el || ++tries > 40) clearInterval(timer);
      if (!el) return;
      // Land on the top of the request, under the sticky bars: the reader reads the title and text first, then
      // answers. (Centring the answer controls put a long request's title out of view.)
      el.style.scrollMarginTop = '124px';
      el.scrollIntoView({ block: 'start' });
      el.classList.add('req-focus');
      setTimeout(() => el.classList.remove('req-focus'), 2500);
      el.querySelector<HTMLElement>('textarea, button')?.focus({ preventScroll: true });
    }, 100);
    return () => clearInterval(timer);
  }, [id]);
}

export type NeedsAcross = { projects: { id: string; name: string; items: NeedsRow[] }[]; count: number };

/** A request answered "not now" whose reminder is pending (server/reminders.ts pendingReminders). */
type Deferred = { id: string; request_id: string; project_id: string; project_name: string; title: string; task_id: string | null; due_at: number | null; due_text: string };

/** "2 deferred, next tomorrow": one muted line on Needs you, opening the list with when each comes and Change. */
function DeferredLine({ list }: { list: Deferred[] }) {
  const [open, setOpen] = useState(false);
  if (!list.length) return null;
  return (
    <div className="deferred">
      <button className="deferred-toggle muted small" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={16} /> {list.length} deferred, next {list[0].due_text.replace(/^next /, "")}
      </button>
      {open && (
        <ul className="deferred-list">
          {list.map((d) => (
            <li key={d.id}>
              <ReminderLine
                r={{ id: d.id, due_text: d.due_text, due_at: null }}
                title={<a className="one-line" href={d.task_id ? href('p', d.project_id, d.task_id.startsWith('disc_') ? 'discussions' : 'tasks', d.task_id, d.request_id) : href('p', d.project_id, 'work', 'needs')}>{d.title}</a>}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One project's open requests as a section outside the cards: its name and count in a header that folds the section
 * (remembered on this device), then the cards, most important first.
 */
function ProjectSection({ id, name, items }: { id: string; name: string; items: InboxItem[] }) {
  const [open, toggle] = useFold(`needs:${id}`, true);
  return (
    <section className={`needs-project ${open ? 'open' : 'closed'}`} aria-label={name}>
      <FoldHead
        open={open}
        onToggle={toggle}
        title={
          <>
            {name} <span className="needs-count">{items.length}</span>
          </>
        }
      />
      {open && (
        <div className="stack">
          {items.map((r) => (
            <InboxCard key={r.id} item={r} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Every open request in every project, a section per project (projects with nothing open are not listed), each
 * request its full card titled with its task, most important first (requests on no task, such as a watch's command
 * to approve, included). The server orders it (api.ts /api/inbox); a project's section is where its first request
 * stands, so the most important lead. The top of the global Home (overview.tsx). Nothing while it first loads: the
 * shared cache fills it on the next visit at once.
 */
export function NeedsSections() {
  const { data } = useLive<{ items: InboxItem[]; deferred?: Deferred[] }>('/api/inbox', (m) => m.type === 'project' || m.type === 'projects');
  const groups = new Map<string, { name: string; items: InboxItem[] }>();
  for (const r of data?.items ?? []) {
    const g = groups.get(r.project_id) ?? { name: r.project_name ?? 'Project', items: [] };
    g.items.push(r);
    groups.set(r.project_id, g);
  }
  return (
    <section className="needs-page" aria-label="Needs you">
      <DeferredLine list={data?.deferred ?? []} />
      {data && data.items.length === 0 && <p className="muted small needs-none">Nothing needs you</p>}
      {[...groups].map(([id, g]) => (
        <ProjectSection key={id} id={id} name={g.name} items={g.items} />
      ))}
    </section>
  );
}
