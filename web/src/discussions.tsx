import { useEffect, useState } from 'react';
import { api } from './api';
import type { Discussion, DiscussionState, ProjectState, Task, TaskDetail, ThreadLink } from './api';
import { Menu, TaskStateTag, toThreadLines } from './tasks';
import type { TaskState } from './api';
import { Thread } from './thread';
import { ClipCount, References } from './attachments';
import { TaskSpecBlock } from './spec';
import { SpecEntryCard } from './specdiscuss';
import { Chips, Empty, Icon, Markdown, Sheet, Tag, ago, go, href, useAction , PlainRefs } from './ui';
import { NeedsGroup, needsResponse } from './needs';
import { ProposalArea, ProposalStrip, pinCtx } from './proposal';

/**
 * Discussions: questions, ideas and open topics kept as findable threads. The director
 * files exchanges from the conversation into them; the owner can search them, settle
 * or reopen them, start one, and turn one into a task (in place: it leaves this list and
 * its thread becomes the start of the task's history). Open ones nobody has touched for
 * the project's cold period show as cold, grouped and collapsed at the bottom.
 */

export const DISCUSSION_STATE_LABEL: Record<DiscussionState, string> = { open: 'Open', settled: 'Settled' };

export function DiscussionStateTag({ state }: { state: DiscussionState }) {
  return <Tag tone={`task-st ds-${state}`}>{DISCUSSION_STATE_LABEL[state]}</Tag>;
}

/** A linked task or discussion as a small chip-like link. */
export function ThreadLinks({ pid, label, links }: { pid: string; label: string; links: ThreadLink[] }) {
  if (!links.length) return null;
  return (
    <div className="thread-links">
      <span className="label">{label}</span>
      {links.map((l) => {
        const isDisc = l.kind ? l.kind === 'discussion' : l.state === 'open' || l.state === 'settled';
        return (
          <a key={l.id} className="thread-link" href={href('p', pid, isDisc ? 'discussions' : 'tasks', l.id)}>
            {isDisc ? <DiscussionStateTag state={l.state as DiscussionState} /> : <TaskStateTag state={l.state as TaskState} />}
            <span>{l.title}</span>
          </a>
        );
      })}
    </div>
  );
}

const daysAgo = (ts: number) => {
  const d = Math.floor((Date.now() - ts) / 86_400_000);
  return d < 1 ? 'today' : d === 1 ? 'a day ago' : `${d} days ago`;
};

function DiscussionRow({ d, pid, full = false }: { d: Discussion; pid: string; full?: boolean }) {
  const { busy, error, run } = useAction();
  const [settled, setSettled] = useState(false);
  // Found by a search after it became a task: still findable, and it opens as the task.
  if (d.kind === 'task') {
    return (
      <a className="card disc-row disc-now-task" href={href('p', pid, 'tasks', d.id)}>
        <div className="task-title-row">
          <h3>{d.title}</h3>
          <Tag tone="disc-became">Now a task</Tag>
          <TaskStateTag state={d.state as unknown as TaskState} />
        </div>
        <span className="muted small">
          Was a discussion · {d.messages} {d.messages === 1 ? 'message' : 'messages'} · {ago(d.updated_at)}
        </span>
      </a>
    );
  }
  const line = d.state === 'settled' && d.conclusion ? d.conclusion : d.status_summary;
  // One tap: settled without a conclusion, the director writes it from the thread.
  const settle = () =>
    void run(async () => {
      await api(`/api/tasks/${d.id}/settle`, { body: {} });
      setSettled(true);
    });
  return (
    <div className={`card disc-row disc-${d.state} ${d.cold ? 'disc-cold' : ''}`}>
      <a className="disc-row-link" href={href('p', pid, 'discussions', d.id)}>
        <div className="task-title-row">
          <h3>{d.title}</h3>
          {d.cold ? <Tag tone="disc-cold-tag">Cold</Tag> : (full || d.state === 'settled') && <DiscussionStateTag state={d.state} />}
        </div>
        {line && <p className={`small disc-line ${full ? '' : 'one-line'}`}>{d.state === 'settled' && d.conclusion ? <b>Concluded: </b> : null}<PlainRefs text={line} strip /></p>}
        <ProposalStrip p={d.proposal} />
        <span className="muted small">
          {d.messages} {d.messages === 1 ? 'message' : 'messages'} · {d.cold ? `last active ${daysAgo(d.last_active)}` : ago(d.updated_at)}
          {d.needs_response > 0 && <span className="task-asks"> · needs response</span>}
          {!!d.attach_count && <> · <ClipCount n={d.attach_count} /></>}
          {d.tasks.length > 0 && <> · led to {d.tasks.length === 1 ? 'a task' : `${d.tasks.length} tasks`}</>}
        </span>
      </a>
      {d.cold && d.state === 'open' && (
        <div className="disc-row-actions">
          <button className="btn small" disabled={busy || settled} onClick={settle}>
            <Icon name="check" size={14} /> {settled ? 'Settled' : 'Settle'}
          </button>
          {error && <span className="error-text small">{error}</span>}
        </div>
      )}
    </div>
  );
}

/** Cold discussions, collapsed at the bottom of a list. */
function ColdGroup({ list, pid, full = false }: { list: Discussion[]; pid: string; full?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!list.length) return null;
  return (
    <div className="task-group group-closed disc-cold-group">
      <button className="group-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="chevron" size={14} /> Cold <span className="muted">{list.length}</span>
      </button>
      {open && (
        <div className="stack">
          {list.map((d) => (
            <DiscussionRow key={d.id} d={d} pid={pid} full={full} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- the full list with search ----------

type DiscFilter = 'all' | DiscussionState;

/** `embedded`: a section of the Work page (work.tsx), under its heading. */
export function DiscussionsPage({ s, embedded = false }: { s: ProjectState; embedded?: boolean }) {
  const pid = s.project.id;
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<DiscFilter>('all');
  const [found, setFound] = useState<Discussion[] | null>(null);
  const [creating, setCreating] = useState(false);
  const query = q.trim();

  // Searching includes thread text, so it asks the server; the unfiltered list comes with the project.
  useEffect(() => {
    if (!query) {
      setFound(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api<{ discussions: Discussion[] }>(`/api/projects/${pid}/discussions?q=${encodeURIComponent(query)}`).then((d) => live && setFound(d.discussions));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, pid, s.discussions]);

  const base = query ? found ?? [] : s.discussions;
  // A search also lists discussions that became tasks; they count under All only.
  const list = base.filter((d) => filter === 'all' || (d.kind !== 'task' && d.state === filter));
  const count = (f: DiscFilter) => base.filter((d) => f === 'all' || (d.kind !== 'task' && d.state === f)).length;
  // Searching shows everything that matches in one list; otherwise cold ones wait, collapsed, at the bottom.
  const needs = query ? [] : list.filter((d) => d.kind !== 'task' && needsResponse(d));
  const warm = query ? list : list.filter((d) => !d.cold && !needs.includes(d));
  const cold = query ? [] : list.filter((d) => d.cold);

  return (
    <section className="discussions-page">
      {!embedded && (
        <a className="back" href={href('p', pid)}>
          <Icon name="back" size={16} /> Home
        </a>
      )}
      <div className="section-head">
        {embedded ? <h2>Discussions</h2> : <h1 className="page-title">Discussions</h1>}
        <button className="btn small" onClick={() => setCreating(true)}>
          <Icon name="plus" size={15} /> New discussion
        </button>
      </div>
      <div className="disc-tools">
        <input type="search" className="disc-search" placeholder="Search titles, summaries, conclusions and threads" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search discussions" />
        <Chips
          value={filter}
          onChange={setFilter}
          options={[
            { id: 'all', label: 'All', count: count('all') },
            { id: 'open', label: 'Open', count: count('open') },
            { id: 'settled', label: 'Settled', count: count('settled') },
          ]}
        />
      </div>
      {query && found === null && <div className="loading">Searching…</div>}
      {list.length === 0 && (query ? found !== null : true) && (
        <Empty title={query ? 'Nothing matches' : 'No discussions yet'}>
          {query ? 'Try other words: every word must appear in the title, summary, conclusion or thread.' : 'When you ask the director a question or float an idea, it keeps the exchange here as a thread by topic.'}
        </Empty>
      )}
      <NeedsGroup list={needs} stateTag={(d) => <DiscussionStateTag state={d.state as DiscussionState} />} />
      <div className="stack">
        {warm.map((d) => (
          <DiscussionRow key={d.id} d={d} pid={pid} full />
        ))}
      </div>
      <ColdGroup list={cold} pid={pid} full />
      {creating && <NewDiscussion pid={pid} onClose={() => setCreating(false)} />}
    </section>
  );
}

// ---------- start one ----------

function NewDiscussion({ pid, onClose }: { pid: string; onClose: () => void }) {
  const [form, setForm] = useState({ title: '', text: '' });
  const { busy, error, run } = useAction();
  const save = async () => {
    let id = '';
    const ok = await run(async () => {
      id = (await api<{ id: string }>(`/api/projects/${pid}/discussions`, { body: form })).id;
    });
    if (ok) {
      onClose();
      go('p', pid, 'discussions', id);
    }
  };
  return (
    <Sheet title="New discussion" onClose={onClose}>
      <div className="form">
        <label>
          Topic
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus placeholder="e.g. Running agents from other vendors" />
        </label>
        <label>
          What you want to discuss (markdown)
          <textarea rows={6} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy || !form.title.trim() || !form.text.trim()} onClick={save}>
            Start discussion
          </button>
        </div>
        <p className="muted small">The director answers in the discussion's thread. Nothing is started as work.</p>
      </div>
    </Sheet>
  );
}

// ---------- a discussion's page ----------

/**
 * A request holder opened from History or Needs you: an agent's standing "Requests from …" holder, or the old Inbox
 * archive. Not a discussion: no Settle, no Turn into a task, no reply box; just whose requests these are and the record.
 */
function RequestHolderView({ s, data }: { s: ProjectState; data: TaskDetail }) {
  const pid = s.project.id;
  const t = data.task;
  const root = s.agents.find((a) => !a.parent_id && a.status !== 'closed');
  const lines = toThreadLines(data.timeline, s, root?.name ?? 'Director');
  const waiting = t.needs_response;
  return (
    <section className="task-page disc-page holder-page">
      <a className="back" href={href('p', pid, 'history')}>
        <Icon name="back" size={16} /> History
      </a>
      <header className="card task-head">
        <div className="row wrap">
          <Tag tone={waiting ? 'tone-accent' : ''}>{waiting ? `${waiting} waiting` : 'Nothing waiting'}</Tag>
          <span className="muted small">{t.holder ? 'Requests from an agent with no task' : 'Record of requests answered in the old Inbox'} · updated {ago(t.updated_at)}</span>
        </div>
        <h1 className="page-title">{t.holder ? `Requests from ${t.holder.agent_name}` : t.title}</h1>
        {t.holder ? (
          <p className="muted">
            <a href={href('p', pid, 'agents', t.holder.agent_id)}>{t.holder.agent_name}</a> · {t.holder.context}. Its permission requests are kept here while it has no task; open ones also show under Needs you.
          </p>
        ) : (
          t.conclusion && <Markdown text={t.conclusion} />
        )}
      </header>
      <Thread
        className="task-thread"
        label={`Requests in ${t.title}`}
        head={
          <div className="task-thread-head">
            <h2 className="convo-name">Requests</h2>
          </div>
        }
        lines={lines}
        loaded
        composer={false}
        empty={<div className="convo-empty"><p>No requests.</p></div>}
        placeholder=""
        onSend={async () => {}}
      />
    </section>
  );
}

export function DiscussionView({ s, data }: { s: ProjectState; data: TaskDetail }) {
  if (data.task.holder || data.task.inbox_archive) return <RequestHolderView s={s} data={data} />;
  return <DiscussionPage s={s} data={data} />;
}

function DiscussionPage({ s, data }: { s: ProjectState; data: TaskDetail }) {
  const pid = s.project.id;
  const d = data.task as unknown as Discussion;
  const [sheet, setSheet] = useState<'settle' | 'rename' | 'task' | null>(null);
  const [override, setOverride] = useState<DiscussionState | null>(null);
  useEffect(() => setOverride(null), [data]);
  const { busy, error, run } = useAction();
  const state = override ?? d.state;
  const root = s.agents.find((a) => !a.parent_id && a.status !== 'closed');
  const lines = toThreadLines(data.timeline, s, root?.name ?? 'Director', pinCtx(d.id, data.proposal));
  const working = root?.status === 'working' ? { name: root.name, line: root.status_line } : null;

  const reopen = () =>
    void run(async () => {
      await api(`/api/tasks/${d.id}/reopen`, { body: {} });
      setOverride('open');
    });
  const toTask = () => setSheet('task');
  const more = (
    <>
      <TaskSpecBlock projectId={pid} spec={data.spec} />
      <References projectId={pid} owner={`task:${d.id}`} version={d.attach_count} hint="Screenshots, mockups, recordings or documents for this discussion. Files sent in the thread are listed here too." />
    </>
  );

  return (
    <section className="task-page disc-page">
      <a className="back" href={href('p', pid, 'discussions')}>
        <Icon name="back" size={16} /> Discussions
      </a>

      <header className="card task-head">
        <div className="row wrap">
          <DiscussionStateTag state={state} />
          <span className="muted small">
            Discussion {d.origin === 'user' ? 'you started' : 'kept by the director'} · updated {ago(d.updated_at)}
          </span>
        </div>
        <h1 className="page-title">{d.title}</h1>
        <SpecEntryCard s={s} discussionId={d.id} />
        <div className="row wrap task-actions">
          {state === 'open' ? (
            <button className="btn primary" disabled={busy} onClick={() => setSheet('settle')}>
              <Icon name="check" size={15} /> Settle
            </button>
          ) : (
            <button className="btn" disabled={busy} onClick={reopen}>
              Reopen
            </button>
          )}
          <button className="btn" disabled={busy} onClick={toTask}>
            <Icon name="plus" size={15} /> Turn into a task
          </button>
          <span className="spacer" />
          <Menu label="More actions" items={[{ label: 'Rename', onSelect: () => setSheet('rename') }]} />
        </div>
        {error && <p className="error-text">{error}</p>}

        {state === 'settled' && (
          <div className="task-summary disc-conclusion">
            <span className="label">Conclusion</span>
            {d.conclusion ? <Markdown text={d.conclusion} /> : <p className="muted">Settled. The director is writing the conclusion.</p>}
          </div>
        )}
        <div className={state === 'settled' ? 'disc-where muted' : 'task-summary'}>
          <span className="label">Where it stands{d.summary_at ? ` · ${ago(d.summary_at)}` : ''}</span>
          {d.status_summary ? <Markdown text={d.status_summary} /> : <p className="muted">No summary yet. The director writes a one-line summary as the discussion moves.</p>}
        </div>
        <ThreadLinks pid={pid} label="Led to" links={d.tasks ?? []} />
        {!data.proposal && more}
      </header>

      {/* A pinned proposal sits directly under the summary, above everything else: the options and the question (proposal.tsx). */}
      {data.proposal && (
        <>
          <ProposalArea proposal={data.proposal} taskId={d.id} pid={pid} s={s} />
          <section className="card disc-more">{more}</section>
        </>
      )}

      <Thread
        className="task-thread"
        label={`Thread of ${d.title}`}
        head={
          <div className="task-thread-head">
            <h2 className="convo-name">Thread</h2>
          </div>
        }
        lines={lines}
        loaded
        working={working}
        empty={
          <div className="convo-empty">
            <p>Nothing said here yet.</p>
          </div>
        }
        placeholder="Reply in this discussion"
        onSend={(text, attachments) => api(`/api/tasks/${d.id}/message`, { body: { text, attachments } })}
        attachTo={pid}
      />

      {sheet === 'settle' && <SettleSheet d={d} onClose={() => setSheet(null)} onDone={() => setOverride('settled')} />}
      {sheet === 'rename' && <RenameSheet d={d} onClose={() => setSheet(null)} />}
      {sheet === 'task' && <NewTaskSheet from={d as unknown as Task} onClose={() => setSheet(null)} />}
    </section>
  );
}

function SettleSheet({ d, onClose, onDone }: { d: Discussion; onClose: () => void; onDone: () => void }) {
  const [conclusion, setConclusion] = useState('');
  const { busy, error, run } = useAction();
  const save = async () => {
    const ok = await run(() => api(`/api/tasks/${d.id}/settle`, { body: { conclusion } }));
    if (ok) {
      onDone();
      onClose();
    }
  };
  return (
    <Sheet title="Settle discussion" onClose={onClose}>
      <div className="form">
        <label>
          Conclusion (optional)
          <textarea rows={4} value={conclusion} onChange={(e) => setConclusion(e.target.value)} autoFocus placeholder="Leave empty and the director writes it from the thread" />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={save}>
            Settle
          </button>
        </div>
        <p className="muted small">Settled discussions stay searchable and can be reopened.</p>
      </div>
    </Sheet>
  );
}

function RenameSheet({ d, onClose }: { d: Discussion; onClose: () => void }) {
  const [title, setTitle] = useState(d.title);
  const { busy, error, run } = useAction();
  const save = async () => {
    const ok = await run(() => api(`/api/tasks/${d.id}`, { method: 'PATCH', body: { title } }));
    if (ok) onClose();
  };
  return (
    <Sheet title="Rename discussion" onClose={onClose}>
      <div className="form">
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy || !title.trim()} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * Make a task from a discussion. By default the discussion itself becomes the task (same thread, it leaves the
 * Discussions list); `another`: from a task that was a discussion, a separate task that shows that discussion.
 * Planning by default, so nothing starts until the owner approves.
 */
export function NewTaskSheet({ from, another = false, onClose }: { from: Task; another?: boolean; onClose: () => void }) {
  const [form, setForm] = useState({
    title: another ? '' : from.title,
    description: another ? '' : [from.status_summary, from.conclusion && `Conclusion: ${from.conclusion}`].filter(Boolean).join('\n\n'),
    state: 'planning' as 'planning' | 'waiting',
  });
  const { busy, error, run } = useAction();
  const save = async () => {
    let id = '';
    const ok = await run(async () => {
      id = (await api<{ id: string }>(`/api/tasks/${from.id}/${another ? 'another-task' : 'to-task'}`, { body: form })).id;
    });
    if (ok) {
      onClose();
      go('p', from.project_id, 'tasks', id);
    }
  };
  return (
    <Sheet title={another ? 'Another task from this discussion' : 'Turn into a task'} onClose={onClose}>
      <div className="form">
        <label>
          Title
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} autoFocus={another} />
        </label>
        <label>
          What the work is (markdown)
          <textarea rows={6} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder={another ? 'Leave empty and the director writes it' : ''} />
        </label>
        <div className="radio-cards">
          {(
            [
              ['planning', 'Planning', 'The director writes a plan; nothing starts until you approve it.'],
              ['waiting', 'Waiting', 'Agreed, not lined up yet.'],
            ] as const
          ).map(([id, name, detail]) => (
            <label key={id} className={`radio-card ${form.state === id ? 'on' : ''}`}>
              <input type="radio" name="task-state" checked={form.state === id} onChange={() => setForm({ ...form, state: id })} />
              <strong>{name}</strong>
              <span>{detail}</span>
            </label>
          ))}
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy || !form.title.trim()} onClick={save}>
            {another ? 'Create task' : 'Turn into a task'}
          </button>
        </div>
        <p className="muted small">
          {another
            ? 'A separate task. Its history shows this discussion, and links back here.'
            : 'The discussion itself becomes the task: it leaves the Discussions list, and its thread becomes the start of the task’s history.'}
        </p>
      </div>
    </Sheet>
  );
}
