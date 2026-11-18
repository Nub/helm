import { useEffect, useState } from 'react';
import { api } from './api';
import type { InboxItem, Task } from './api';
import { AttachButton, AttachTray, dropTarget, useAttachDraft } from './attachments';
import { Empty, Icon, Tag, ago, href, useAction , PlainRefs } from './ui';
import { ProposalStrip } from './proposal';

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
export const answerRequest = (id: string, body: { choice?: string; text?: string; dismiss?: boolean; attachments?: string[] }) => api(`/api/requests/${id}/answer`, { body });

/** What a request asks the user to provide, for its row: "an image" or "a file", or null. */
export const wantsWhat = (r: InboxItem) => (r.kind !== 'question' || !r.payload.wants ? null : r.payload.wants === 'image' ? 'an image' : 'a file');

/** The paperclip marking a request that asks for a file, beside its one-line summary. */
export function WantsMark({ r }: { r: InboxItem }) {
  const what = wantsWhat(r);
  if (!what) return null;
  return (
    <span className="req-wants" title={`Asks you for ${what}`}>
      <Icon name="clip" size={14} />
      {`Asks for ${what}`}
    </span>
  );
}

const pageOf = (t: { kind?: string }) => (t.kind === 'discussion' ? 'discussions' : 'tasks');
/** The thread of the row, scrolled to one request. */
export const requestHref = (t: { project_id: string; id: string; kind?: string }, requestId: string) => href('p', t.project_id, pageOf(t), t.id, requestId);

export const KIND_LABEL: Record<InboxItem['kind'], string> = { question: 'Decision', action: 'To do', permission: 'Permission', structure: 'Team change' };
export const kindTone = (k: InboxItem['kind']) => (k === 'permission' ? 'tone-serious' : k === 'structure' ? 'tone-warning' : k === 'action' ? 'tone-todo' : 'tone-accent');
/** An action's answers (server: requests.ts ACTION_CHOICES). */
export const ACTION_CHOICES = ['Done', "Can't / not yet"] as const;

/**
 * One open request on a list row: what it is in one line, and its answer controls. A question that asks for a file
 * (wants) leads with Attach; any question takes files dropped on its row. They upload at once, and Send or an option
 * button sends them with the answer. Other answer / Answer open the thread, whose answer box has its own paperclip.
 */
export function RequestLine({ r, row }: { r: InboxItem; row: NeedsRow }) {
  const { busy, error, run } = useAction();
  // Questions and to-dos take files: dropped on the row, or attached as the request asks (wants).
  const question = r.kind === 'question' || r.kind === 'action';
  const draft = useAttachDraft(question ? r.project_id : undefined, `request:${r.id}`);
  const [over, setOver] = useState(false);
  const files = draft.ready.map((a) => a.id);
  const answer = (body: { choice?: string; text?: string }) =>
    void run(async () => {
      await answerRequest(r.id, files.length ? { ...body, attachments: files } : body);
      draft.clear();
    });
  const wants = !!wantsWhat(r);
  const hasFiles = draft.items.length > 0;
  const hold = busy || draft.uploading;
  const open = () => {
    location.hash = requestHref(row, r.id);
  };
  const who = r.agent_name ?? 'An agent';
  return (
    <div className={`req-line ${r.blocking ? 'req-blocking' : ''} ${over ? 'drop-over' : ''}`} {...(question ? dropTarget(draft, setOver) : {})}>
      <div className="req-what">
        <Tag tone={kindTone(r.kind)}>{KIND_LABEL[r.kind]}</Tag>
        {!!r.blocking && <Tag tone="tone-warning">Blocking {who}</Tag>}
        <WantsMark r={r} />
        {r.payload.danger && <span className="req-danger small">{r.payload.danger}</span>}
        {/* A discussion started for this request already carries its title. */}
        {(r.line || r.title) !== row.title && (
          // A permission shows up to three wrapped lines of its command, so it can be allowed without opening the thread.
          <a className={`req-text ${r.kind === 'permission' ? 'mono req-cmd' : ''}`} href={requestHref(row, r.id)} title={r.line}>
            <PlainRefs text={r.line || r.title} />
          </a>
        )}
      </div>
      <div className="req-actions">
        {r.kind === 'permission' && (
          <>
            <button className="btn primary req-btn" disabled={busy} onClick={() => answer({ choice: 'Allow' })}>
              Allow once
            </button>
            {r.payload.canAlways && (
              <button className="btn req-btn" disabled={busy} onClick={() => answer({ choice: 'Always allow' })}>
                Always allow
              </button>
            )}
            <button className="btn danger req-btn" disabled={busy} onClick={() => answer({ choice: 'Deny' })}>
              Deny
            </button>
          </>
        )}
        {r.kind === 'structure' && (
          <>
            <button className="btn primary req-btn" disabled={busy} onClick={() => answer({ choice: 'Approve' })}>
              Approve
            </button>
            <button className="btn danger req-btn" disabled={busy} onClick={() => answer({ choice: 'Deny' })}>
              Deny
            </button>
            <button className="btn quiet req-btn" onClick={open}>
              Details
            </button>
          </>
        )}
        {r.kind === 'action' && (
          <>
            <button className="btn primary req-btn" disabled={hold} onClick={() => answer({ choice: 'Done' })}>
              <Icon name="check" size={15} /> {hasFiles ? `Done, send ${files.length > 1 ? `${files.length} files` : 'file'}` : 'Done'}
            </button>
            <button className="btn req-btn" disabled={hold} onClick={() => answer({ choice: ACTION_CHOICES[1] })}>
              {ACTION_CHOICES[1]}
            </button>
            <button className="btn quiet req-btn" onClick={open}>
              {r.payload.steps ? 'Steps' : 'Details'}
            </button>
          </>
        )}
        {r.kind === 'question' && (
          <>
            {hasFiles && (
              <button className="btn primary req-btn" disabled={hold || !files.length} onClick={() => answer({})}>
                {draft.uploading ? 'Uploading' : `Send ${files.length > 1 ? `${files.length} files` : 'file'}`}
              </button>
            )}
            {wants && !hasFiles && (
              <AttachButton draft={draft} className="btn primary req-btn req-attach" label="Attach photos or files">
                <Icon name="clip" size={16} /> Attach
              </AttachButton>
            )}
            {r.options.map((o) => (
              <button key={o.label} className="btn req-btn req-option" disabled={hold} title={hasFiles ? `${o.detail ? `${o.detail}. ` : ''}Sends the files with it.` : o.detail} onClick={() => answer({ choice: o.label })}>
                {o.label}
              </button>
            ))}
            {/* Otherwise the paperclip is in the thread's answer box (Other answer / Answer), so option rows keep their height. */}
            {hasFiles && <AttachButton draft={draft} className="btn quiet req-btn req-clip" label="Attach more" />}
            <button className={`btn req-btn ${wants || hasFiles || r.options.length ? 'quiet' : 'primary'}`} onClick={open}>
              {wants ? 'Answer in words instead' : r.options.length ? 'Other answer' : 'Answer'}
            </button>
          </>
        )}
      </div>
      {question && <AttachTray items={draft.items} onRemove={draft.drop} />}
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

/** A task or discussion that needs a response, with each of its open requests and their controls. */
export function NeedsItem({ t, projectName, stateTag }: { t: NeedsRow; projectName?: string; stateTag?: React.ReactNode }) {
  const link = href('p', t.project_id, pageOf(t), t.id);
  return (
    <article className={`card needs-item ${t.needs_blocking ? 'blocking' : ''}`}>
      {t.holder ? (
        // Requests from an agent with no task: its name and what it is doing, not the holder's title.
        <a className="needs-head" href={href('p', t.project_id, 'agents', t.holder.agent_id)}>
          <h3>{t.holder.agent_name}</h3>
          <span className="muted small">{t.holder.context}</span>
        </a>
      ) : (
        <a className="needs-head" href={link}>
          <h3>{t.title}</h3>
          {stateTag}
        </a>
      )}
      {projectName && <span className="muted small">{projectName}</span>}
      <ProposalStrip p={t.proposal} />
      <div className="needs-reqs">
        {(t.requests ?? []).map((r) => (
          <RequestLine key={r.id} r={r} row={t} />
        ))}
      </div>
      <span className="muted small needs-age">
        {t.holder ? 'Request from an agent' : t.kind === 'discussion' ? 'Discussion' : 'Task'} · asked {ago(Math.min(...(t.requests ?? []).map((r) => r.created_at)))}
      </span>
    </article>
  );
}

/** The group pinned at the top of the Tasks and Discussions lists. */
export function NeedsGroup({ list, stateTag, title = 'Needs response' }: { list: NeedsRow[]; stateTag?: (t: NeedsRow) => React.ReactNode; title?: string }) {
  if (!list.length) return null;
  const count = list.reduce((n, t) => n + (t.needs_response ?? 0), 0);
  return (
    <div className="task-group group-needs">
      <h3 className="group-title">
        <Icon name="inbox" size={15} /> {title} <span className="muted">{count}</span>
      </h3>
      <div className="stack">
        {byUrgency(list).map((t) => (
          <NeedsItem key={t.id} t={t} stateTag={stateTag?.(t)} />
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

/** The top bar's "Needs you": every task and discussion awaiting a response, in all projects, by project. */
export function NeedsYouPage({ data }: { data: NeedsAcross | null }) {
  return (
    <section className="narrow needs-page">
      <h1 className="page-title">Needs you</h1>
      <p className="muted">Tasks and discussions waiting on your response in every project, blocking ones first. Answer here or in the thread.</p>
      {!data && <div className="loading">Loading…</div>}
      {data && data.projects.length === 0 && <Empty title="Nothing needs your response">When an agent asks you something or needs a permission, the task or discussion it concerns shows here.</Empty>}
      {data?.projects.map((p) => (
        <div key={p.id} className="task-group needs-project">
          <h2 className="group-title">
            <a href={href('p', p.id, 'tasks', 'needs')}>{p.name}</a> <span className="muted">{p.items.reduce((n, t) => n + (t.needs_response ?? 0), 0)}</span>
            <a className="decisions-link small" href={href('p', p.id, 'setup', 'decisions')}>Decisions made for you</a>
          </h2>
          <div className="stack">
            {p.items.map((t) => (
              <NeedsItem key={t.id} t={t} stateTag={<Tag tone="task-st">{t.kind === 'discussion' ? (t.state === 'settled' ? 'Settled' : 'Discussion') : STATE[t.state] ?? t.state}</Tag>} />
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}

const STATE: Record<string, string> = { planning: 'Planning', waiting: 'Waiting', scheduled: 'Scheduled', active: 'Active', paused: 'Paused', done: 'Done', dropped: 'Dropped' };

