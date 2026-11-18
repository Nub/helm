import { useEffect, useMemo, useState } from 'react';
import { api, useLive } from './api';
import type { ApprovalPolicy, JournalEntry, Meta, Preview, ProjectState, Structure } from './api';
import { ProjectHostsSetup } from './hosts';
import { PreviewBody, PreviewTile, fileUrl } from './preview';
import { ReportSourcesSetup } from './reports';
import { ImportanceLimitsCard } from './importance';
import { QUICK_HINT, QuickSettings, RoleFields, TeamView, TemplateSelect, newRole } from './roles';
import { Chips, ClampBox, Composer, Empty, Icon, Markdown, Sheet, Tag, ago, clock, go, href, modelLabel, useAction } from './ui';
import { ProjectToolboxSetup } from './toolbox';
import { InstallEntry } from './install';
import { SessionHistory } from './sessions';
import { NotificationsSetup } from './notify';

// ---------- previews ----------

function PreviewViewer({ p, s, onClose }: { p: Preview; s: ProjectState; onClose: () => void }) {
  const agent = s.agents.find((a) => a.id === p.agent_id);
  const task = p.task_id ? [...s.tasks, ...s.discussions].find((t) => t.id === p.task_id) : undefined;
  const { busy, run } = useAction();
  return (
    <Sheet title={p.title} onClose={onClose} wide>
      <div className="viewer">
        <PreviewBody p={p} />
        {p.caption && <Markdown text={p.caption} />}
        <div className="row wrap muted small">
          <span>
            {agent ? <a href={href('p', s.project.id, 'agents', agent.id)}>{agent.name}</a> : 'You'} · {clock(p.created_at)}
            {task && (
              <>
                {' '}
                · {task.kind === 'discussion' ? 'discussion' : 'task'} <a href={href('p', s.project.id, 'tasks', task.id)}>{task.title}</a>
              </>
            )}
          </span>
          <span className="spacer" />
          {p.file && (
            <a className="btn small quiet" href={fileUrl(p.file)} target="_blank" rel="noreferrer">
              <Icon name="external" size={15} /> Open file
            </a>
          )}
          <button
            className="btn small quiet danger"
            disabled={busy}
            onClick={async () => {
              if (confirm('Remove this preview from the gallery?') && (await run(() => api(`/api/previews/${p.id}`, { method: 'DELETE' })))) onClose();
            }}
          >
            <Icon name="trash" size={15} /> Remove
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export function Previews({ s, openId }: { s: ProjectState; openId?: string }) {
  const [kind, setKind] = useState('all');
  const kinds = useMemo(() => [...new Set(s.previews.map((p) => p.kind))], [s.previews]);
  const list = s.previews.filter((p) => kind === 'all' || p.kind === kind);
  const open = s.previews.find((p) => p.id === openId);
  const label: Record<string, string> = { image: 'Images', video: 'Video', chart: 'Charts', html: 'Pages', markdown: 'Reports', text: 'Text', pdf: 'PDFs', link: 'Links', compare: 'Comparisons', guide: 'Guides' };
  return (
    <section>
      <h1 className="page-title">Previews</h1>
      {kinds.length > 1 && (
        <div className="toolbar">
          <Chips value={kind} onChange={setKind} options={[{ id: 'all', label: 'All', count: s.previews.length }, ...kinds.map((k) => ({ id: k, label: label[k] ?? k, count: s.previews.filter((p) => p.kind === k).length }))]} />
        </div>
      )}
      {list.length === 0 && <Empty title="No previews yet">Screenshots, recordings, charts and reports that agents post appear here.</Empty>}
      <div className="gallery">
        {list.map((p) => (
          <PreviewTile key={p.id} p={p} taskTitle={[...s.tasks, ...s.discussions].find((t) => t.id === p.task_id)?.title} onOpen={() => go('p', s.project.id, 'previews', p.id)} />
        ))}
      </div>
      {open && <PreviewViewer p={open} s={s} onClose={() => go('p', s.project.id, 'previews')} />}
    </section>
  );
}

// ---------- history ----------

/** History: by session and away period (sessions.tsx), or the journal on its own. A link to a journal entry opens the journal. */
export function History({ s, focus }: { s: ProjectState; focus?: string }) {
  // A period ("away_<session>", from an away-summary notification) opens By session at it; anything else is a journal entry.
  const period = focus?.startsWith('away_') ? focus : undefined;
  const [view, setView] = useState<'sessions' | 'journal'>(focus && !period ? 'journal' : 'sessions');
  return (
    <section>
      <h1 className="page-title">History</h1>
      <div className="toolbar">
        <Chips value={view} onChange={setView} options={[{ id: 'sessions', label: 'By session' }, { id: 'journal', label: 'Journal' }]} />
      </div>
      {view === 'sessions' ? <SessionHistory s={s} focus={period} /> : <Journal s={s} focus={focus} />}
      {!!s.request_records?.length && (
        // Holders of requests that are not discussions (server/requests.ts): kept as the record, not listed among discussions.
        <details className="card request-records">
          <summary>Request records ({s.request_records.length})</summary>
          <p className="muted small">Permission requests from agents that had no task, and requests answered in the old Inbox.</p>
          <ul>
            {s.request_records.map((r) => (
              <li key={r.id}>
                <a href={href('p', s.project.id, 'discussions', r.id)}>{r.title}</a>
                {r.state === 'open' && <span className="muted small"> · waiting</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Journal({ s, focus }: { s: ProjectState; focus?: string }) {
  const [kind, setKind] = useState('all');
  // #/p/<id>/history/j<entry id> scrolls to one entry, e.g. from a role's provenance in Setup.
  useEffect(() => {
    if (focus) document.getElementById(focus)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focus]);
  const entries = s.journal.filter((j) => kind === 'all' || j.kind === kind);
  // Entries arrive newest first; group consecutive runs that share a phase.
  const groups: { phase: string; entries: JournalEntry[] }[] = [];
  for (const j of entries) {
    const last = groups[groups.length - 1];
    if (last && last.phase === j.phase) last.entries.push(j);
    else groups.push({ phase: j.phase, entries: [j] });
  }
  const names = Object.fromEntries(s.agents.map((a) => [a.id, a.name]));
  const taskTitles = Object.fromEntries([...s.tasks, ...s.discussions].map((t) => [t.id, t.title]));
  const count = (k: string) => s.journal.filter((j) => j.kind === k).length;

  return (
    <>
      <div className="toolbar">
        <Chips
          value={kind}
          onChange={setKind}
          options={[
            { id: 'all', label: 'All', count: s.journal.length },
            { id: 'milestone', label: 'Milestones', count: count('milestone') },
            { id: 'decision', label: 'Decisions', count: count('decision') },
            { id: 'status', label: 'Status', count: count('status') },
            { id: 'note', label: 'Notes', count: count('note') },
          ]}
        />
      </div>
      <div className="card">
        <Composer placeholder="Add a note to the journal" cta="Add" onSend={(text) => api(`/api/projects/${s.project.id}/journal`, { body: { kind: 'note', title: text.split('\n')[0].slice(0, 140), body: text.split('\n').slice(1).join('\n') } })} />
      </div>
      {groups.length === 0 && <Empty title="No entries" />}
      {groups.map((g, gi) => (
        <div key={gi} className="phase-group">
          <h2 className="phase-title">
            <Tag tone="tone-phase">{g.phase || 'Setup'}</Tag>
            <span className="muted small">
              {clock(g.entries[g.entries.length - 1].ts)} – {clock(g.entries[0].ts)}
            </span>
          </h2>
          <ol className="timeline">
            {g.entries.map((j) => (
              <li key={j.id} id={`j${j.id}`} className={`entry entry-${j.kind} ${focus === `j${j.id}` ? 'focused' : ''}`}>
                <span className="entry-mark" aria-hidden="true" />
                <div className="row wrap">
                  <Tag tone={`jk-${j.kind}`}>{j.kind}</Tag>
                  <span className="muted small">
                    {clock(j.ts)}
                    {j.agent_id && names[j.agent_id] ? ` · ${names[j.agent_id]}` : j.agent_id ? '' : ' · You'}
                    {j.task_id && taskTitles[j.task_id] && (
                      <>
                        {s.discussions.some((d) => d.id === j.task_id) ? ' · discussion ' : ' · task '}
                        <a href={href('p', s.project.id, 'tasks', j.task_id)}>{taskTitles[j.task_id]}</a>
                      </>
                    )}
                  </span>
                </div>
                <h3>{j.title}</h3>
                {j.body && (
                  <ClampBox open={focus === `j${j.id}`}>
                    <Markdown text={j.body} />
                  </ClampBox>
                )}
              </li>
            ))}
          </ol>
        </div>
      ))}
    </>
  );
}

// ---------- setup ----------

export const AUTONOMY = [
  { id: 'supervised', name: 'Supervised', detail: 'Agents ask before edits, commands and network access. Every request lands in your inbox.' },
  { id: 'edits', name: 'Edits allowed', detail: 'File edits go ahead. Shell commands and anything else risky ask first.' },
  { id: 'auto', name: 'Auto', detail: 'A safety classifier approves routine actions and sends you only the ones it is unsure about. Recommended.' },
  { id: 'full', name: 'Unrestricted', detail: 'Nothing asks you, except actions that could destroy data or change the system (deleting outside the project, sudo, force-pushes, credentials…), which always ask. Everything else is allowed and listed under Decisions made for you. The check is a floor, not a guarantee.' },
];

export const ANSWERER = [
  { id: 'user', name: 'You', detail: 'Every permission request that reaches Helm waits for your answer.' },
  {
    id: 'director',
    name: 'Director first',
    detail: 'The director allows routine work inside the project, denies what is off-task and passes anything risky or unclear to you, with its reason. Whatever Helm\'s danger check flags (data loss, system changes, credentials) still comes straight to you.',
  },
];

/** Who answers permission requests (server/triage.ts). */
export function AnswererPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="radio-cards">
      {ANSWERER.map((a) => (
        <label key={a.id} className={`radio-card ${value === a.id ? 'on' : ''}`}>
          <input type="radio" name="answerer" checked={value === a.id} onChange={() => onChange(a.id)} />
          <strong>{a.name}</strong>
          <span>{a.detail}</span>
        </label>
      ))}
    </div>
  );
}

export function AutonomyPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="radio-cards">
      {AUTONOMY.map((a) => (
        <label key={a.id} className={`radio-card ${value === a.id ? 'on' : ''}`}>
          <input type="radio" name="autonomy" checked={value === a.id} onChange={() => onChange(a.id)} />
          <strong>{a.name}</strong>
          <span>{a.detail}</span>
        </label>
      ))}
    </div>
  );
}

export const APPROVAL: { id: ApprovalPolicy; name: string; detail: string }[] = [
  { id: 'none', name: 'Director decides', detail: 'The director reshapes the team on its own and records each change in the journal.' },
  { id: 'cap', name: 'Ask before running more agents at once', detail: 'Raising the limit on agents at once waits for your approval. Other changes go ahead.' },
  { id: 'cap-and-model', name: 'Ask before more agents or pricier models', detail: 'Also asks before moving a role to a more expensive model.' },
  { id: 'all', name: 'Ask before any team change', detail: 'Every change the director proposes lands in your inbox first.' },
];

export function ApprovalPicker({ value, onChange }: { value: ApprovalPolicy; onChange: (v: ApprovalPolicy) => void }) {
  return (
    <div className="radio-cards">
      {APPROVAL.map((a) => (
        <label key={a.id} className={`radio-card ${value === a.id ? 'on' : ''}`}>
          <input type="radio" name="approval" checked={value === a.id} onChange={() => onChange(a.id)} />
          <strong>{a.name}</strong>
          <span>{a.detail}</span>
        </label>
      ))}
    </div>
  );
}

export function StructureEditor({ value, onChange, meta }: { value: Structure; onChange: (s: Structure) => void; meta: Meta | null }) {
  const [openRole, setOpenRole] = useState<string | null>(null);
  const models = meta?.models ?? [];
  const depth = (id: string, seen: string[] = []): number => {
    if (id === value.root) return 0;
    const parent = value.roles.find((r) => r.canSpawn.includes(id) && !seen.includes(r.id));
    return parent ? 1 + depth(parent.id, [...seen, id]) : 1;
  };

  return (
    <div className="structure">
      <div className="team-settings-grid">
        {meta && <TemplateSelect value={value} onChange={onChange} meta={meta} />}
        <label>
          Most agents at once
          <input type="number" min={1} max={50} value={value.maxAgents} onChange={(e) => onChange({ ...value, maxAgents: Number(e.target.value) })} />
        </label>
        <QuickSettings value={value} onChange={onChange} />
      </div>
      {value.quickRole ? <p className="muted small">{QUICK_HINT}</p> : null}

      <div className="stack">
        {value.roles.map((r, i) => {
          const isOpen = openRole === r.id;
          return (
            <div key={i} className="card role" style={{ marginLeft: `calc(var(--indent) * ${Math.min(depth(r.id), 3)})` }}>
              <button className="role-head" onClick={() => setOpenRole(isOpen ? null : r.id)} aria-expanded={isOpen}>
                <div className="row wrap">
                  <strong>{r.name || 'Unnamed role'}</strong>
                  {value.root === r.id && <Tag tone="tone-accent">Top level</Tag>}
                  {value.quickRole === r.id && <Tag tone="tone-phase">Quick helper</Tag>}
                  <span className="muted small">{modelLabel(r.model)}</span>
                  <span className="spacer" />
                  <span className="muted small">{r.canSpawn.length ? `spawns ${r.canSpawn.map((c) => value.roles.find((x) => x.id === c)?.name ?? c).join(', ')}` : 'does not delegate'}</span>
                </div>
                {!isOpen && r.description && <p className="muted small">{r.description}</p>}
              </button>
              {isOpen && <RoleFields value={value} index={i} onChange={onChange} models={models} />}
            </div>
          );
        })}
      </div>
      <button
        className="btn small"
        onClick={() => {
          const { structure, id } = newRole(value);
          onChange(structure);
          setOpenRole(id);
        }}
      >
        <Icon name="plus" size={15} /> Add role
      </button>
    </div>
  );
}

export function Setup({ s, focus }: { s: ProjectState; focus?: string }) {
  const { data: meta } = useLive<Meta>('/api/meta', () => false);
  const [name, setName] = useState(s.project.name);
  const [autonomy, setAutonomy] = useState(s.project.autonomy);
  const [answerer, setAnswerer] = useState<string>(s.project.permission_answerer ?? 'user');
  const [minutes, setMinutes] = useState(s.project.triage_minutes ? String(s.project.triage_minutes) : '');
  const minutesValue = minutes.trim() ? Number(minutes) : null;
  const triageChanged = answerer !== (s.project.permission_answerer ?? 'user') || minutesValue !== (s.project.triage_minutes ?? null);
  const [coldDays, setColdDays] = useState(s.project.cold_days ? String(s.project.cold_days) : '');
  const coldValue = coldDays.trim() ? Number(coldDays) : null;
  const coldChanged = coldValue !== (s.project.cold_days ?? null);
  const [idleMinutes, setIdleMinutes] = useState(s.project.session_idle_minutes ? String(s.project.session_idle_minutes) : '');
  const idleValue = idleMinutes.trim() ? Number(idleMinutes) : null;
  const idleChanged = idleValue !== (s.project.session_idle_minutes ?? null);
  const [structure, setStructure] = useState<Structure>(s.project.structure);
  // The server copy the local structure was taken from. The director can change the
  // structure while this page is open; follow it unless the user has unsaved edits.
  const [base, setBase] = useState<Structure>(s.project.structure);
  const [saved, setSaved] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const server = JSON.stringify(s.project.structure);
  const edited = JSON.stringify(structure) !== JSON.stringify(base);
  const stale = edited && JSON.stringify(base) !== server;
  const dirty = name !== s.project.name || autonomy !== s.project.autonomy || coldChanged || idleChanged || triageChanged || JSON.stringify(structure) !== server;
  const loadLatest = () => {
    setStructure(s.project.structure);
    setBase(s.project.structure);
  };
  useEffect(() => {
    if (!edited && JSON.stringify(base) !== server) loadLatest();
  }, [server]);

  const save = async () => {
    const done = await run(() => api(`/api/projects/${s.project.id}`, { method: 'PATCH', body: { name, autonomy, structure, ...(coldChanged ? { cold_days: coldValue } : {}), ...(idleChanged ? { session_idle_minutes: idleValue } : {}), ...(triageChanged ? { permission_answerer: answerer, triage_minutes: minutesValue } : {}) } }));
    if (done) setBase(structure);
    setSaved(done);
  };

  return (
    <section className="setup">
      <h1 className="page-title">Setup</h1>
      <div className="card form">
        <label>
          Project name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="muted small">
          <Icon name="folder" size={14} /> {s.project.path}
        </p>
        <label>
          Discussions go cold after (days)
          <input type="number" inputMode="numeric" min={1} max={365} value={coldDays} placeholder={`${s.coldDaysDefault ?? 14} (default)`} onChange={(e) => setColdDays(e.target.value)} />
        </label>
        <p className="muted small">An open discussion with no activity for this long is shown as cold, collapsed at the bottom of the Discussions list. Any activity warms it again.</p>
        <label>
          A session ends after (minutes without activity)
          <input type="number" inputMode="numeric" min={5} max={720} value={idleMinutes} placeholder={`${s.idleMinutesDefault ?? 30} (default)`} onChange={(e) => setIdleMinutes(e.target.value)} />
        </label>
        <p className="muted small">While you message the director, answer requests or act on tasks you are in a session. After this long with nothing from you (or when you press I'm stepping away) you are away: the director carries on with the agreed work alone, starts no new work except critical fixes it can make without you, and summarises both for you.</p>
      </div>

      <h2>Importance limits</h2>
      <ImportanceLimitsCard s={s} />

      <h2>How much agents may do without asking</h2>
      <AutonomyPicker value={autonomy} onChange={setAutonomy} />

      <p className="muted small">
        Whatever the level, a request Helm's danger check flags (it could destroy data or change the system) always comes to you, with the reason. <a href={href('p', s.project.id, 'setup', 'decisions')}>Decisions made for you</a> lists the requests Helm answered without asking.
      </p>
      <h2>Who answers permission requests</h2>
      <AnswererPicker value={answerer} onChange={setAnswerer} />
      {answerer === 'director' && (
        <div className="card form">
          <label>
            Comes to you if the director has not decided within (minutes)
            <input type="number" inputMode="numeric" min={1} max={240} value={minutes} placeholder="10 (default)" onChange={(e) => setMinutes(e.target.value)} />
          </label>
          <p className="muted small">The director cannot answer its own requests: an independent check with no tools allows clearly routine ones, and the rest come to you.</p>
        </div>
      )}

      <h2>Team</h2>
      <p className="muted">Each role on this project, in order of who may start whom: what it is for, what Helm gives it, and who holds it now. Agents with different names can share one role; their task is what sets them apart.</p>
      {stale && (
        <div className="needs-banner">
          <span>
            <strong>The team was changed while you were editing</strong>
            <span className="muted small">Saving now would overwrite that change with your version. Load latest discards your unsaved team edits.</span>
          </span>
          <button className="btn small" onClick={loadLatest}>
            Load latest
          </button>
        </div>
      )}
      <TeamView s={s} value={structure} onChange={setStructure} meta={meta} focus={focus} editing={editing} setEditing={setEditing} />

      <h2>Team settings</h2>
      <div className="card form">
        <div className="team-settings-grid">
          {meta && <TemplateSelect value={structure} onChange={setStructure} meta={meta} />}
          <label>
            Most agents at once
            <input type="number" min={1} max={50} value={structure.maxAgents} onChange={(e) => setStructure({ ...structure, maxAgents: Number(e.target.value) })} />
          </label>
          <QuickSettings value={structure} onChange={setStructure} />
        </div>
        {structure.quickRole ? <p className="muted small">{QUICK_HINT}</p> : null}
        <div>
          <button
            className="btn small"
            onClick={() => {
              const { structure: next, id } = newRole(structure);
              setStructure(next);
              setEditing(id);
              setTimeout(() => document.getElementById(`team-role-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 50);
            }}
          >
            <Icon name="plus" size={15} /> Add role
          </button>
        </div>
      </div>

      <h3>When the director changes the team</h3>
      <p className="muted">The director can add, edit and remove roles and change how many agents run at once. Choose what it must ask you about first.</p>
      <ApprovalPicker value={structure.approval ?? 'none'} onChange={(approval) => setStructure({ ...structure, approval })} />

      {/* Docked at the bottom only while there is something to save; otherwise it would cover the page for nothing. */}
      {dirty || busy || error ? (
        <div className="save-bar">
          {error && <p className="error-text">{error}</p>}
          <div className="row">
            <button className="btn primary" disabled={busy || !dirty} onClick={save}>
              Save changes
            </button>
          </div>
        </div>
      ) : (
        saved && <p className="muted small">Saved. Agents pick up changes the next time they start a session.</p>
      )}

      <ProjectHostsSetup s={s} />

      <ProjectToolboxSetup s={s} />
      <ReportSourcesSetup s={s} focus={focus} />

      <InstallEntry place="setup" />
      <NotificationsSetup projectId={s.project.id} projectName={s.project.name} />

      <h2>Archive</h2>
      <div className="card row wrap">
        <p className="muted grow">Archiving stops the project's agents and moves it out of the way. Removing it deletes its Helm history; the folder on disk is never touched.</p>
        <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/projects/${s.project.id}`, { method: 'PATCH', body: { archived: !s.project.archived } }))}>
          {s.project.archived ? 'Restore project' : 'Archive project'}
        </button>
        <button
          className="btn danger quiet"
          disabled={busy}
          onClick={async () => {
            if (confirm(`Remove "${s.project.name}" from Helm? Its agents, history and previews are deleted. The folder stays.`) && (await run(() => api(`/api/projects/${s.project.id}`, { method: 'DELETE' })))) go();
          }}
        >
          Remove from Helm
        </button>
      </div>
    </section>
  );
}
