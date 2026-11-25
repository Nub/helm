import { useEffect, useState } from 'react';
import { ShareButton } from './share';
import { clearDraft, useStoredForm, useStoredText } from './drafts';
import { api, useLive } from './api';
import type { Discussion, DiscussionState, ProjectState, Task, TaskDetail, ThreadLink } from './api';
import { Menu, TaskStateTag, focusThreadBox, toThreadLines } from './tasks';
import type { TaskState } from './api';
import { Thread } from './thread';
import { References } from './attachments';
import { TaskSpecBlock } from './spec';
import { SpecEntryCard } from './specdiscuss';
import { SpecWorkBar } from './specwork';
import { Chips, Empty, Icon, Markdown, Sheet, Tag, ago, go, href, useAction , PlainRefs } from './ui';
import { openChat } from './chat';
import { ProposalArea, ProposalStrip, pinCtx } from './proposal';
import { Fold, FoldHead, StickyHead, useFold } from './fold';

/**
 * Discussions: questions, ideas and open topics kept as findable threads. The director
 * files exchanges from the conversation into them; the owner can search them, close
 * or reopen them, start one, and turn one into a task (in place: it leaves this list and
 * its thread becomes the start of the task's history). A quiet one gets a reminder, then goes stale
 * (server/discrevisit.ts); archived ones leave the list except under their filter. The list comes sorted: waiting on
 * the user first, open by activity, stale, closed.
 */

export const DISCUSSION_STATE_LABEL: Record<DiscussionState, string> = { open: 'Open', stale: 'Stale', settled: 'Closed', archived: 'Archived' };

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


function DiscussionRow({ d, pid, full = false, selecting = false, selected = false, onSelect }: { d: Discussion; pid: string; full?: boolean; selecting?: boolean; selected?: boolean; onSelect?: (id: string, start?: boolean) => void }) {
  // Long-press on touch starts selecting with this row (DiscussionsPage).
  const [press, setPress] = useState<number | null>(null);
  // Found by a search after it became a task: still findable, and it opens as the task.
  if (d.kind === 'task') {
    return (
      <a className="card disc-row disc-now-task" href={href('p', pid, 'tasks', d.id)}>
        <div className="task-title-row">
          <h3>{d.title}</h3>
          <Tag tone="disc-became">Now a task</Tag>
          <TaskStateTag state={d.state as unknown as TaskState} />
        </div>
      </a>
    );
  }
  const summary = d.state === 'settled' && d.conclusion ? d.conclusion : d.status_summary;
  // A thread with another project's director (server/crossproject.ts) says who with first.
  const peer = d.peer ? `${d.peer.from ? 'From' : 'With'} ${d.peer.name}` : '';
  const line = peer && summary && summary !== peer ? `${peer} · ${summary}` : summary || peer;
  const startPress = () => onSelect && setPress(window.setTimeout(() => onSelect(d.id, true), 500));
  const endPress = () => {
    if (press) clearTimeout(press);
    setPress(null);
  };
  return (
    <div
      className={`card disc-row disc-${d.state} ${d.awaiting ? 'disc-awaiting' : ''} ${selecting ? 'selecting' : ''} ${selected ? 'selected' : ''}`}
      data-kctx={`discussion:${d.id}`}
      onTouchStart={selecting ? undefined : startPress}
      onTouchEnd={endPress}
      onTouchMove={endPress}
      onClickCapture={(e) => {
        if (!selecting || !onSelect) return;
        e.preventDefault();
        e.stopPropagation();
        onSelect(d.id);
      }}
    >
      {selecting && <input type="checkbox" className="disc-check" checked={selected} readOnly aria-label={`Select ${d.title}`} />}
      <a className="disc-row-link" href={href('p', pid, 'discussions', d.id)}>
        <div className="task-title-row">
          <h3>{d.title}</h3>
          {(full || d.state !== 'open') && d.state !== 'open' && <DiscussionStateTag state={d.state} />}
        </div>
        {(d.awaiting || line) && (
          <p className="small muted disc-line one-line">
            {d.awaiting && <b className="disc-awaiting-word">{line ? 'Waiting on you · ' : 'Waiting on you'}</b>}
            {line && <PlainRefs text={line} strip />}
          </p>
        )}
        <ProposalStrip p={d.proposal} />
      </a>
    </div>
  );
}

/** One call for many discussions (server/discrevisit.ts batchDiscussions). */
export const batchDiscussions = (pid: string, ids: string[], action: 'stale' | 'archive' | 'close' | 'reopen') => api<{ changed: number }>(`/api/projects/${pid}/discussions/batch`, { body: { ids, action } });

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

  // Archived ones are not in the project's list: their filter asks the server.
  const archived = useLive<{ discussions: Discussion[] }>(filter === 'archived' && !query ? `/api/projects/${pid}/discussions?state=archived` : null, (m) => m.type === 'project' && m.projectId === pid);
  const base = query ? found ?? [] : filter === 'archived' ? archived.data?.discussions ?? [] : s.discussions;
  // A search also lists discussions that became tasks; they count under All only. The server sorts the list.
  const list = base.filter((d) => filter === 'all' || (d.kind !== 'task' && d.state === filter));

  // Selection mode: checkboxes, select-all for the filter, and an action bar for one batch call.
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const { busy, error, run } = useAction();
  const selectable = list.filter((d) => d.kind !== 'task').map((d) => d.id);
  const toggle = (id: string, start = false) => {
    if (start) {
      setSelecting(true);
      setPicked([id]);
      return;
    }
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };
  const leave = () => {
    setSelecting(false);
    setPicked([]);
  };
  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !document.querySelector('.sheet-backdrop') && leave();
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [selecting]);
  const act = (action: 'stale' | 'archive' | 'close' | 'reopen') =>
    void run(async () => {
      await batchDiscussions(pid, picked, action);
      leave();
    });
  const all = selectable.length > 0 && selectable.every((id) => picked.includes(id));

  return (
    <section className="discussions-page">
      {!embedded && (
        <a className="back" href={href('p', pid)}>
          <Icon name="back" size={16} /> Home
        </a>
      )}
      <div className="section-head">
        {embedded ? <h2>Discussions</h2> : <h1 className="page-title">Discussions</h1>}
        <span className="row">
          {!selecting && list.length > 0 && (
            <button className="btn small quiet" onClick={() => setSelecting(true)}>
              Select
            </button>
          )}
          <button className="btn small" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> New discussion
          </button>
        </span>
      </div>
      <div className="disc-tools">
        <input type="search" className="disc-search" placeholder="Search discussions" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search discussions" />
        <Chips
          value={filter}
          onChange={setFilter}
          options={[
            { id: 'all', label: 'All' },
            { id: 'open', label: 'Open' },
            { id: 'stale', label: 'Stale' },
            { id: 'settled', label: 'Closed' },
            { id: 'archived', label: 'Archived' },
          ]}
        />
      </div>
      {selecting && (
        <label className="disc-select-all small">
          <input type="checkbox" checked={all} onChange={() => setPicked(all ? [] : selectable)} /> Select all{filter !== 'all' ? ` ${DISCUSSION_STATE_LABEL[filter as DiscussionState].toLowerCase()}` : ''}
        </label>
      )}
      {query && found === null && <div className="loading">Searching…</div>}
      {list.length === 0 && (query ? found !== null : true) && (
        <Empty title={query ? 'Nothing matches' : 'No discussions yet'} />
      )}
      <div className="stack">
        {list.map((d) => (
          <DiscussionRow key={d.id} d={d} pid={pid} full selecting={selecting} selected={picked.includes(d.id)} onSelect={toggle} />
        ))}
      </div>
      {selecting && (
        <div className="disc-bar" role="toolbar" aria-label="Selected discussions">
          <span className="disc-bar-n small">{picked.length} selected</span>
          <button className="btn small" disabled={busy || !picked.length} onClick={() => act('stale')}>
            Mark stale
          </button>
          <button className="btn small" disabled={busy || !picked.length} onClick={() => act('archive')}>
            Archive
          </button>
          <button className="btn small" disabled={busy || !picked.length} onClick={() => act('close')}>
            Close
          </button>
          <button className="btn small" disabled={busy || !picked.length} onClick={() => act('reopen')}>
            Reopen
          </button>
          <span className="spacer" />
          <button className="btn small quiet" onClick={leave}>
            Cancel
          </button>
          {error && <span className="error-text small">{error}</span>}
        </div>
      )}
      {creating && <NewDiscussion pid={pid} onClose={() => setCreating(false)} />}
    </section>
  );
}

// ---------- start one ----------

function NewDiscussion({ pid, onClose }: { pid: string; onClose: () => void }) {
  const [form, setForm, clearForm] = useStoredForm(`new-discussion:${pid}`, { title: '', text: '' });
  const { busy, error, run } = useAction();
  const save = async () => {
    let id = '';
    const ok = await run(async () => {
      id = (await api<{ id: string }>(`/api/projects/${pid}/discussions`, { body: form })).id;
    });
    if (ok) {
      clearForm();
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
 * archive. Not a discussion: no Close, no Turn into a task, no reply box; just whose requests these are and the record.
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

/**
 * Make a task, on the director's proposed conclusion (one button, in the post and the header; it replaced Conclude):
 * closes the discussion with that conclusion, and the director plans the work now.
 */
export function ConcludeButton({ task, message, small = true }: { task: string; message?: number; small?: boolean }) {
  const { busy, error, run } = useAction();
  return (
    <>
      <button className={`btn primary${small ? ' small' : ''}`} disabled={busy} onClick={() => void run(() => api(`/api/tasks/${task}/make-task`, { body: message == null ? {} : { message } }))}>
        <Icon name="tasks" size={16} /> Make a task
      </button>
      {error && <p className="error-text">{error}</p>}
    </>
  );
}

export function DiscussionView({ s, data }: { s: ProjectState; data: TaskDetail }) {
  if (data.task.holder || data.task.inbox_archive) return <RequestHolderView s={s} data={data} />;
  return <DiscussionPage s={s} data={data} />;
}

function DiscussionPage({ s, data }: { s: ProjectState; data: TaskDetail }) {
  const pid = s.project.id;
  const d = data.task as unknown as Discussion;
  const [sheet, setSheet] = useState<'settle' | 'rename' | 'task' | 'make' | null>(null);
  const [override, setOverride] = useState<DiscussionState | null>(null);
  useEffect(() => setOverride(null), [data]);
  const { busy, error, run } = useAction();
  const [threadOpen, toggleThread] = useFold('history', true);
  const state = override ?? d.state;
  const root = s.agents.find((a) => !a.parent_id && a.status !== 'closed');
  const lines = toThreadLines(data.timeline, s, root?.name ?? 'Director', pinCtx(d.id, data.proposal));
  // The director proposed a conclusion (task_post conclude): Conclude in the header uses the latest one.
  const proposed = data.timeline.some((i) => i.type === 'message' && i.conclude);
  const working = root?.status === 'working' ? { name: root.name, line: root.status_line } : null;

  const reopen = () =>
    void run(async () => {
      await api(`/api/tasks/${d.id}/reopen`, { body: {} });
      setOverride('open');
    });
  const toTask = () => setSheet('task');
  // Mark stale or archive by hand (server/discrevisit.ts), from the header's menu.
  const mark = (action: 'stale' | 'archive') =>
    void run(async () => {
      await batchDiscussions(pid, [d.id], action);
      setOverride(action === 'stale' ? 'stale' : 'archived');
    });
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

      <StickyHead
        className="card task-head"
        strip={
          <div className="row title-strip-top">
            <DiscussionStateTag state={state} />
            <strong className="title-strip-title one-line">{d.title}</strong>
            <button className="btn small" onClick={() => focusThreadBox(() => openChat({ kind: 'discussion', id: d.id }))}>
              <Icon name="discuss" size={16} /> Message
            </button>
          </div>
        }
      >
        <div className="row wrap">
          <DiscussionStateTag state={state} />
          <span className="spacer" />
          {data.peer && <span className="muted small">{data.peer.from ? 'From' : 'With'} {data.peer.name} ·</span>}
          <span className="muted small">{ago(d.updated_at)}</span>
          <ShareButton route={href('p', pid, 'discussions', d.id)} title={d.title} />
        </div>
        <h1 className="page-title">{d.title}</h1>
        <SpecEntryCard s={s} discussionId={d.id} />
        <SpecWorkBar s={s} discussionId={d.id} />
        <div className="row wrap task-actions">
          {state === 'open' && proposed ? (
            <>
              {/* With a proposed conclusion: Make a task closes with it and the director plans the task now. */}
              <ConcludeButton task={d.id} small={false} />
              <button className="btn quiet" disabled={busy} onClick={() => setSheet('settle')}>
                Close
              </button>
            </>
          ) : state === 'open' ? (
            <>
              <button className="btn primary" disabled={busy} onClick={() => setSheet('make')}>
                <Icon name="tasks" size={16} /> Make a task
              </button>
              <button className="btn" disabled={busy} onClick={() => setSheet('settle')}>
                Close
              </button>
            </>
          ) : (
            <button className="btn" disabled={busy} onClick={reopen}>
              Reopen
            </button>
          )}
          <span className="spacer" />
          <Menu
            label="More actions"
            items={[
              { label: 'Turn into a task', onSelect: toTask },
              state === 'open' && { label: 'Mark stale', onSelect: () => mark('stale') },
              state !== 'archived' && { label: 'Archive', onSelect: () => mark('archive') },
              { label: 'Rename', onSelect: () => setSheet('rename') },
            ]}
          />
        </div>
        {error && <p className="error-text">{error}</p>}

        {state === 'settled' && (
          <div className="task-summary disc-conclusion">
            <span className="label">Conclusion</span>
            {d.conclusion && <Markdown text={d.conclusion} />}
          </div>
        )}
        {state !== 'settled' && d.status_summary && (
          <div className="task-summary">
            <span className="label">Where it stands</span>
            <Markdown text={d.status_summary} />
          </div>
        )}
        <ThreadLinks pid={pid} label="Led to" links={d.tasks ?? []} />
        <ThreadLinks pid={pid} label="For the task" links={d.about ? [d.about] : []} />
      </StickyHead>

      {/* Its Spec entry and references, collapsed under the title unless the user opened it (fold.tsx). */}
      <Fold kind="about" title="About this discussion" openByDefault={false} className="disc-more" label="About this discussion">
        {more}
      </Fold>
      {/* A pinned proposal, then the latest previews pinned for review (proposal.tsx). */}
      <ProposalArea proposal={data.proposal} review={data.review} taskId={d.id} pid={pid} s={s} />

      {!threadOpen ? (
        <section className="card fold closed task-thread-folded" aria-label={`Thread of ${d.title}`}>
          <FoldHead open={false} onToggle={toggleThread} title="Thread" />
        </section>
      ) : (
      <Thread
        className="task-thread"
        label={`Thread of ${d.title}`}
        head={
          <div className="task-thread-head">
            <FoldHead open onToggle={toggleThread} title="Thread" />
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
        draftKey={`thread:${d.id}`}
      />
      )}

      {sheet === 'make' && <MakeTaskSheet d={d} onClose={() => setSheet(null)} />}
      {sheet === 'settle' && <SettleSheet d={d} onClose={() => setSheet(null)} onDone={() => setOverride('settled')} />}
      {sheet === 'rename' && <RenameSheet d={d} onClose={() => setSheet(null)} />}
      {sheet === 'task' && <NewTaskSheet from={d as unknown as Task} onClose={() => setSheet(null)} />}
    </section>
  );
}

/** Make a task with no proposed conclusion yet: one optional line on what the task should do, for the director. */
function MakeTaskSheet({ d, onClose }: { d: Discussion; onClose: () => void }) {
  const [line, setLine] = useStoredText(`make:${d.id}`);
  const { busy, error, run } = useAction();
  const go = async () => {
    if (await run(() => api(`/api/tasks/${d.id}/make-task`, { body: { line: line.trim() || undefined } }))) {
      clearDraft(`make:${d.id}`);
      onClose();
    }
  };
  return (
    <Sheet title="Make a task" onClose={onClose}>
      <div className="form">
        <label>
          What should the task do? (optional)
          <input value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void go()} autoFocus placeholder="Leave empty and the director works from the thread" />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={go}>
            <Icon name="tasks" size={16} /> Make a task
          </button>
        </div>
      </div>
    </Sheet>
  );
}

function SettleSheet({ d, onClose, onDone }: { d: Discussion; onClose: () => void; onDone: () => void }) {
  const [conclusion, setConclusion] = useStoredText(`settle:${d.id}`);
  const { busy, error, run } = useAction();
  const save = async () => {
    const ok = await run(() => api(`/api/tasks/${d.id}/settle`, { body: { conclusion } }));
    if (ok) {
      clearDraft(`settle:${d.id}`);
      onDone();
      onClose();
    }
  };
  return (
    <Sheet title="Close discussion" onClose={onClose}>
      <div className="form">
        <label>
          Conclusion (optional)
          <textarea rows={4} value={conclusion} onChange={(e) => setConclusion(e.target.value)} autoFocus placeholder="Leave empty and the director writes it from the thread" />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={save}>
            Close
          </button>
        </div>
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
  const [form, setForm, clearForm] = useStoredForm(`discussion-task:${from.id}:${another ? 'another' : 'to'}`, {
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
      clearForm();
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
