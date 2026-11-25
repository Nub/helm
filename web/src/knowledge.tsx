import { useEffect, useRef, useState } from 'react';
import { Fold, jumpTo } from './fold';
import { api, useLive } from './api';
import type { KnowledgeNote, KnowledgeState, ProjectState, SettingGroup } from './api';
import { Switch } from './notify';
import { Empty, Icon, Markdown, Progress, href, useAction } from './ui';
import { shortWhen } from './time';

/**
 * Project knowledge (server/knowledge.ts): short notes of durable facts agents learned about the project, given to
 * every new agent. The user reads, adds, edits, confirms and removes them here; the meter shows how much of the
 * budget agents are given. Editing a note is not a Spec change.
 */

const directorOf = (s: ProjectState) =>
  s.agents.find((a) => !a.parent_id && a.status !== 'closed')?.name ?? s.project.structure.roles.find((r) => r.id === s.project.structure.root)?.name ?? 'the director';

const n = (x: number) => x.toLocaleString();

/** Setup's Knowledge section (#/p/<id>/setup/knowledge opens it and scrolls to it). Collapsed until opened. */
export function KnowledgePage({ s, focus }: { s: ProjectState; focus?: string }) {
  useEffect(() => {
    if (focus === 'knowledge') jumpTo('#setup-knowledge', { fold: 'setup-knowledge' });
  }, [focus]);
  return (
    <div id="setup-knowledge">
      <Fold kind="setup-knowledge" title="Knowledge" openByDefault={false} className="flat-fold">
        <KnowledgeNotes s={s} focused={focus === 'knowledge'} />
      </Fold>
    </div>
  );
}

function KnowledgeNotes({ s, focused }: { s: ProjectState; focused: boolean }) {
  const pid = s.project.id;
  const { data, error } = useLive<KnowledgeState>(`/api/projects/${pid}/knowledge`, (m) => m.type === 'project' && m.projectId === pid);
  // Setup's sections above load at their own pace and push this one down: scroll to it again once they have.
  useEffect(() => {
    if (!focused || !data) return;
    const t = setTimeout(() => document.getElementById('setup-knowledge')?.scrollIntoView({ block: 'start' }), 400);
    return () => clearTimeout(t);
  }, [focused, !!data]);
  const [adding, setAdding] = useState(false);
  // When the user had last opened this page before now: notes agents wrote since are marked for a human glance.
  const [since, setSince] = useState<number | undefined>(undefined);
  useEffect(() => {
    api<{ before: number | null }>(`/api/projects/${pid}/knowledge/viewed`, { body: {} })
      .then((r) => setSince(r.before ?? 0))
      .catch(() => setSince(undefined));
  }, [pid]);
  if (error && !data) return <Empty title="Could not load knowledge">{error}</Empty>;
  if (!data) return <div className="loading">Loading…</div>;
  const director = directorOf(s);
  const fresh = since === undefined ? 0 : data.notes.filter((x) => freshness(x, since)).length;
  const topics: string[] = [];
  for (const note of data.notes) if (!topics.includes(note.topic)) topics.push(note.topic);

  return (
    <section className="knowledge-page">
      {!adding && (
        <div className="kn-review">
          {data.notes.length > 0 && <Seed pid={pid} director={director} label={`Ask ${director} to review`} quiet />}
          <button className="btn small" onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Add note
          </button>
        </div>
      )}
      {!data.enabled && (
        <a className="needs-banner" href={href('p', pid, 'setup', 'agent-context')}>
          <span>
            <strong>Project knowledge is off</strong>
            <span className="muted small">Turn it on in Setup.</span>
          </span>
        </a>
      )}
      {data.notes.length > 0 && <Budget data={data} />}
      {fresh > 0 && (
        <p className="small kn-fresh-line">
          <span className="kn-fresh">New</span> {fresh} {fresh === 1 ? 'note' : 'notes'} changed since you last looked.
        </p>
      )}
      {adding && <NoteEditor pid={pid} data={data} onDone={() => setAdding(false)} />}
      {!data.notes.length && !adding ? (
        <div className="empty kn-empty">
          <strong>No notes yet</strong>
          <Seed pid={pid} director={director} label={`Ask ${director} to write the first page`} />
        </div>
      ) : (
        topics.map((t) => (
          <div key={t} className="kn-topic">
            <h3>{t}</h3>
            <ul className="kn-list">
              {data.notes
                .filter((x) => x.topic === t)
                .map((x) => (
                  <NoteRow key={x.id} note={x} pid={pid} data={data} fresh={since === undefined ? null : freshness(x, since)} />
                ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

/** How much of the page every new agent is given; the rest reaches agents whose task it matches (server/knowledge.ts). */
function Budget({ data }: { data: KnowledgeState }) {
  const rest = data.notes.filter((x) => !x.included).length;
  return (
    <div className="kn-budget">
      <div className="row">
        <span className="small">
          <strong className="mono">{n(data.used)}</strong> of <span className="mono">{n(data.budget)}</span> characters per agent
        </span>
        <span className="muted small">{data.notes.length} {data.notes.length === 1 ? 'note' : 'notes'}</span>
      </div>
      <Progress value={Math.min(100, Math.round((data.used / data.budget) * 100))} />
      {rest > 0 && (
        <p className="small muted kn-over">
          {rest} more {rest === 1 ? 'goes' : 'go'} only to agents whose task {rest === 1 ? 'it matches' : 'they match'}.
        </p>
      )}
    </div>
  );
}

function Seed({ pid, director, label, quiet = false }: { pid: string; director: string; label: string; quiet?: boolean }) {
  const { busy, error, run } = useAction();
  const [sent, setSent] = useState(false);
  if (sent)
    return (
      <p className="doc-told small">
        <Icon name="check" size={16} /> Sent to {director}. Its reply is in the chat with {director}.
      </p>
    );
  return (
    <>
      <button className={`btn small ${quiet ? 'quiet' : ''}`} disabled={busy} onClick={async () => (await run(() => api(`/api/projects/${pid}/knowledge/seed`, { body: {} }))) && setSent(true)}>
        {label}
      </button>
      {error && <p className="error-text">{error}</p>}
    </>
  );
}

/** Added or changed by an agent after `since`. */
function freshness(n: KnowledgeNote, since: number): 'New' | 'Changed' | null {
  if (n.added_by_agent && n.created_at > since) return 'New';
  if (n.changed_by_agent && n.updated_at > since) return 'Changed';
  return null;
}

function NoteRow({ note, pid, data, fresh }: { note: KnowledgeNote; pid: string; data: KnowledgeState; fresh: 'New' | 'Changed' | null }) {
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();
  if (editing) return <li className="kn-note editing"><NoteEditor pid={pid} data={data} note={note} onDone={() => setEditing(false)} /></li>;
  const changed = note.updated_by !== note.added_by || note.updated_at !== note.created_at;
  return (
    <li className="kn-note">
      <div className="kn-head">
        <h3>{note.title}</h3>
        {fresh && <span className="kn-fresh" title="Added or changed by an agent since you last looked">{fresh}</span>}
        {!note.included && <span className="tag kn-tag-out" title="Given only to agents whose task it matches">When relevant</span>}
      </div>
      <Markdown text={note.body} className="kn-body" />
      {note.paths.length > 0 && (
        <div className="kn-paths">
          {note.paths.map((p) => (
            <code key={p}>{p}</code>
          ))}
        </div>
      )}
      <p className="muted small kn-meta">
        {note.added_by}, {shortWhen(note.created_at)}
        {changed && ` · changed by ${note.updated_by}, ${shortWhen(note.updated_at)}`}
        {' · '}
        {note.confirmed ? (
          <span className="kn-confirmed">
            <Icon name="check" size={16} /> confirmed by {note.confirmed_by}
          </span>
        ) : (
          'unconfirmed'
        )}
      </p>
      <div className="kn-actions">
        <button className="btn small quiet" onClick={() => setEditing(true)}>
          Edit
        </button>
        {!note.confirmed && (
          <button className="btn small quiet" disabled={busy} onClick={() => run(() => api(`/api/knowledge/${note.id}`, { method: 'PATCH', body: { confirm: true } }))}>
            Confirm
          </button>
        )}
        <button
          className="btn small quiet danger"
          disabled={busy}
          onClick={() => {
            if (confirm(`Remove "${note.title}" from the knowledge page?`)) void run(() => api(`/api/knowledge/${note.id}`, { method: 'DELETE' }));
          }}
        >
          Remove
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
    </li>
  );
}

function NoteEditor({ pid, data, note, onDone }: { pid: string; data: KnowledgeState; note?: KnowledgeNote; onDone: () => void }) {
  const [topic, setTopic] = useState(note?.topic ?? data.topics[0]);
  const [title, setTitle] = useState(note?.title ?? '');
  const [text, setText] = useState(note?.body ?? '');
  const [paths, setPaths] = useState((note?.paths ?? []).join('\n'));
  const { busy, error, run } = useAction();
  const lim = data.limits;
  const known = [...new Set([...data.topics, ...data.notes.map((x) => x.topic)])];
  const lines = text.trim() ? text.trim().split('\n').filter((l) => l.trim()).length : 0;
  const tooLong = text.trim().length > lim.text || lines > lim.lines;
  const save = async () => {
    const body = { topic, title, text, paths: paths.split('\n').map((p) => p.trim()).filter(Boolean) };
    const done = await run(() => (note ? api(`/api/knowledge/${note.id}`, { method: 'PATCH', body }) : api(`/api/projects/${pid}/knowledge`, { body })));
    if (done) onDone();
  };
  return (
    <div className="card form kn-editor">
      <label>
        Topic
        <input list="kn-topics" value={topic} maxLength={32} onChange={(e) => setTopic(e.target.value)} />
        <datalist id="kn-topics">
          {known.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </label>
      <label>
        Title
        <input value={title} maxLength={lim.title} placeholder="Run the server tests" onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Text
        <textarea rows={4} value={text} placeholder="One fact, in 1 to 6 lines. Commands in `backticks`." onChange={(e) => setText(e.target.value)} />
        <span className={`small ${tooLong ? 'error-text' : 'muted'}`}>
          {text.trim().length} / {lim.text} characters · {lines} / {lim.lines} lines
        </span>
      </label>
      <label>
        Files it concerns <span className="muted small">(optional, one per line)</span>
        <textarea rows={2} value={paths} placeholder="server/runtime.ts" onChange={(e) => setPaths(e.target.value)} />
      </label>
      <p className="muted small">No secrets: notes are shown to every agent. Say where a secret is kept, not its value.</p>
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button className="btn primary small" disabled={busy || !topic.trim() || !title.trim() || !text.trim() || tooLong} onClick={save}>
          {note ? 'Save' : 'Add note'}
        </button>
        <button className="btn small quiet" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Setup's per-project switches (server/settings.ts), drawn from what the server declares: one heading per group
 * ("Agent context"), one switch (or, for a choice, a menu) per setting. A new setting needs no change here. Each switch saves at once.
 */
export function ProjectSettingsSetup({ s, focus }: { s: ProjectState; focus?: string }) {
  const pid = s.project.id;
  const { data } = useLive<{ groups: SettingGroup[] }>(`/api/projects/${pid}/settings`, (m) => m.type === 'project' && m.projectId === pid);
  const { error, run } = useAction();
  const [pending, setPending] = useState<Record<string, boolean | string>>({});
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus === 'agent-context' && data) ref.current?.scrollIntoView({ block: 'start' });
  }, [focus, !!data]);
  if (!data) return null;
  const set = async (key: string, value: boolean | string) => {
    setPending((p) => ({ ...p, [key]: value }));
    await run(() => api(`/api/projects/${pid}/settings`, { method: 'PATCH', body: { [key]: value } }));
    setPending((p) => {
      const { [key]: _, ...rest } = p;
      return rest;
    });
  };
  return (
    <div ref={ref} className="project-settings">
      {data.groups.map((g) => (
        <div key={g.id} id={`settings-${g.id}`}>
          <h2>{g.title}</h2>
          <div className="card settings-card">
            {g.settings.map((x) => (
              <div key={x.key} className="setting-item">
                {x.choices ? (
                  <label className="switch-row setting-choice">
                    <span className="switch-text">
                      <span>{x.label}</span>
                    </span>
                    <select value={String(pending[x.key] ?? x.value)} onChange={(e) => void set(x.key, e.target.value)}>
                      {x.choices.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <Switch label={x.label} checked={!!(pending[x.key] ?? x.value)} onChange={(v) => void set(x.key, v)} />
                )}
                {x.key === 'knowledge' && (
                  <a className="small" href={href('p', pid, 'setup', 'knowledge')}>
                    Open the notes
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}
