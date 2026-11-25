import { useEffect, useState } from 'react';
import { useVersions } from './previewlist';
import { ModeChoices, openModeSheet } from './projectmode';
import { api, useLive } from './api';
import type { JournalEntry, Preview, ProjectState } from './api';
import { ProjectHostsSetup } from './hosts';
import { AccountsSetup } from './accounts';
import { PreviewBody, fileUrl } from './preview';
import { ImportanceLimitsCard } from './importance';
import { AreasTeam } from './areas';
import { Chips, ClampBox, Composer, Empty, Icon, Markdown, PREVIEW_EVENT, Sheet, Tag, clock, closePreview, go, href, modelLabel, openPreview, previewHash, previewInHash, useAction, useRoute, PageHeader } from './ui';
import { InstallEntry } from './install';
import { SessionHistory } from './sessions';
import { NotificationsSetup } from './notify';
import { TimeZoneSetup } from './timezone';
import { KnowledgePage, ProjectSettingsSetup } from './knowledge';
import { lazyNamed, loadReleases, loadReports, loadToolbox } from './lazy';
const ReportSourcesSetup = lazyNamed<{ s: import('./api').ProjectState; focus?: string }>(loadReports, 'ReportSourcesSetup');
const ProjectToolboxSetup = lazyNamed<{ s: import('./api').ProjectState }>(loadToolbox, 'ProjectToolboxSetup');
const ReleaseRecipeSetup = lazyNamed<{ s: import('./api').ProjectState }>(loadReleases, 'ReleaseRecipeSetup');

// ---------- previews ----------

function PreviewViewer({ p, s, onClose }: { p: Preview; s: ProjectState; onClose: () => void }) {
  const agent = s.agents.find((a) => a.id === p.agent_id);
  const task = p.task_id ? [...s.tasks, ...s.discussions].find((t) => t.id === p.task_id) : undefined;
  const { busy, run } = useAction();
  // Its versions, a step away (previewlist.tsx): the latest shows first.
  const { shown, loading, switcher } = useVersions(p, s.project.id);
  return (
    <Sheet title={shown.title} onClose={onClose} wide swipeDown>
      <div className="viewer">
        {switcher && <div className="row viewer-versions">{switcher}</div>}
        {loading ? <div className="loading small">Loading…</div> : <PreviewBody p={shown} />}
        {shown.caption && <Markdown text={shown.caption} />}
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
              <Icon name="external" size={16} /> Open file
            </a>
          )}
          <button
            className="btn small quiet danger"
            disabled={busy}
            onClick={async () => {
              if (confirm('Remove this preview from the gallery?') && (await run(() => api(`/api/previews/${p.id}`, { method: 'DELETE' })))) onClose();
            }}
          >
            <Icon name="trash" size={16} /> Remove
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/**
 * The preview viewer, over whatever page is open (mounted once by the app shell). Every Open on a preview goes through
 * openPreview (ui.tsx), and so does a click on any link to "#/p/<id>/previews/<id>". A shared link of that form lands
 * on the preview's task (or Home) with the viewer open over it.
 */
export function PreviewHost() {
  const [at, setAt] = useState(previewInHash);
  const route = useRoute();
  const legacy = route[0] === 'p' && route[2] === 'previews' && route[3] ? { pid: route[1], id: route[3] } : null;
  useEffect(() => {
    const f = () =>
      setAt((cur) => {
        const next = previewInHash();
        return next?.pid === cur?.pid && next?.id === cur?.id ? cur : next;
      });
    addEventListener('hashchange', f);
    addEventListener('popstate', f);
    addEventListener(PREVIEW_EVENT, f);
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]');
      const m = a && !a.getAttribute('target') ? /^#\/p\/([^/?]+)\/previews\/([^/?]+)$/.exec(a.getAttribute('href')!) : null;
      if (!m) return;
      e.preventDefault();
      openPreview(decodeURIComponent(m[1]), decodeURIComponent(m[2]));
    };
    document.addEventListener('click', onClick);
    return () => {
      removeEventListener('hashchange', f);
      removeEventListener('popstate', f);
      removeEventListener(PREVIEW_EVENT, f);
      document.removeEventListener('click', onClick);
    };
  }, []);
  const want = at ?? legacy;
  const { data: s, error } = useLive<ProjectState>(want ? `/api/projects/${want.pid}` : null, (m) => m.type === 'project' && m.projectId === want?.pid);
  // An old id grouped into a preview as an earlier version opens that preview (server/store.ts previewAliases).
  const p = s && want && s.project.id === want.pid ? s.previews.find((x) => x.id === want.id || x.id === s.preview_aliases?.[want.id]) : undefined;
  // A link to a preview by id (the old Previews page): the same viewer, over the preview's task when it has one, else Home.
  useEffect(() => {
    if (!legacy || !s || s.project.id !== legacy.pid) return;
    const task = p?.task_id ? [...s.tasks, ...s.discussions].find((t) => t.id === p.task_id) : undefined;
    const base = task ? href('p', legacy.pid, task.kind === 'discussion' ? 'discussions' : 'tasks', task.id) : href('p', legacy.pid, 'overview');
    location.replace(p ? previewHash(base, legacy.pid, legacy.id) : base);
  }, [legacy?.pid, legacy?.id, s, p]);
  // Removed, or never there: nothing to show.
  useEffect(() => {
    if (at && ((s && s.project.id === at.pid && !p) || error)) closePreview();
  }, [at, s, p, error]);
  if (!at || !p || !s) return null;
  return <PreviewViewer key={p.id} p={p} s={s} onClose={closePreview} />;
}

// ---------- history ----------

/** Home's Journal section: the journal (the same kind filters), or by session and away period (sessions.tsx). A link to a period opens By session at it. */
export function History({ s, focus }: { s: ProjectState; focus?: string }) {
  // A period ("away_<session>" from an away-summary notification, or a session "ses_..." from Home) opens By session at it; anything else is a journal entry.
  const period = focus?.startsWith('away_') || focus?.startsWith('ses_') ? focus : undefined;
  const [view, setView] = useState<'sessions' | 'journal'>(period ? 'sessions' : 'journal');
  return (
    <div className="journal-section">
      <div className="toolbar">
        <Chips value={view} onChange={setView} options={[{ id: 'journal', label: 'Journal' }, { id: 'sessions', label: 'By session' }]} />
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
    </div>
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

  return (
    <>
      <div className="toolbar">
        <Chips
          value={kind}
          onChange={setKind}
          options={[
            { id: 'all', label: 'All' },
            { id: 'milestone', label: 'Milestones' },
            { id: 'decision', label: 'Decisions' },
            { id: 'status', label: 'Status' },
            { id: 'note', label: 'Notes' },
          ]}
        />
      </div>
      <div className="card">
        <Composer placeholder="Add a note to the journal" cta="Add" draftKey={`journal:${s.project.id}`} onSend={(text) => api(`/api/projects/${s.project.id}/journal`, { body: { kind: 'note', title: text.split('\n')[0].slice(0, 140), body: text.split('\n').slice(1).join('\n') } })} />
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
  { id: 'supervised', name: 'Supervised', detail: 'Asks before edits, commands and network.' },
  { id: 'edits', name: 'Edits allowed', detail: 'Edits go ahead; commands ask.' },
  { id: 'auto', name: 'Auto', detail: 'A classifier approves routine actions. Recommended.' },
  { id: 'full', name: 'Unrestricted', detail: 'Only dangerous actions ask.' },
];

export const ANSWERER = [
  { id: 'user', name: 'You', detail: 'Every request waits for you.' },
  {
    id: 'director',
    name: 'Director first',
    detail: 'Routine ones decided for you; risky ones come to you.',
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

export function Setup({ s, focus }: { s: ProjectState; focus?: string }) {
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
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const dirty = name !== s.project.name || autonomy !== s.project.autonomy || coldChanged || idleChanged || triageChanged;

  const save = async () => {
    const done = await run(() => api(`/api/projects/${s.project.id}`, { method: 'PATCH', body: { name, autonomy, ...(coldChanged ? { cold_days: coldValue } : {}), ...(idleChanged ? { session_idle_minutes: idleValue } : {}), ...(triageChanged ? { permission_answerer: answerer, triage_minutes: minutesValue } : {}) } }));
    setSaved(done);
  };

  return (
    <section className="setup">
      <PageHeader title="Setup" />
      {/* The same four choices as the mode pill's menu (projectmode.tsx), confirmed in its sheet. */}
      <h2>Mode</h2>
      <ModeChoices mode={s.mode?.mode ?? 'running'} onPick={(m) => openModeSheet(s.project.id, m)} name="setup-mode" />

      <div className="card form">
        <label>
          Project name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="muted small">
          <Icon name="folder" size={16} /> {s.project.path}
        </p>
        <label>
          A session ends after (minutes without activity)
          <input type="number" inputMode="numeric" min={5} max={720} value={idleMinutes} placeholder={`${s.idleMinutesDefault ?? 30} (default)`} onChange={(e) => setIdleMinutes(e.target.value)} />
        </label>
      </div>

      <h2>Importance limits</h2>
      <ImportanceLimitsCard s={s} />

      <h2>Autonomy</h2>
      <AutonomyPicker value={autonomy} onChange={setAutonomy} />

      <p className="small">
        <a href={href('p', s.project.id, 'setup', 'decisions')}>Decisions made for you</a>
      </p>
      <h2>Who answers permissions</h2>
      <AnswererPicker value={answerer} onChange={setAnswerer} />
      {answerer === 'director' && (
        <div className="card form">
          <label>
            Comes to you if the director has not decided within (minutes)
            <input type="number" inputMode="numeric" min={1} max={240} value={minutes} placeholder="10 (default)" onChange={(e) => setMinutes(e.target.value)} />
          </label>
        </div>
      )}

      {/* Builders at once, subagents per builder and the tiers (areas.tsx); each is saved as soon as it changes. */}
      <AreasTeam s={s} />

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
        saved && <p className="muted small">Saved.</p>
      )}

      <ProjectSettingsSetup s={s} focus={focus} />
      <KnowledgePage s={s} focus={focus} />

      <AccountsSetup s={s} />
      <ProjectHostsSetup s={s} />

      <ProjectToolboxSetup s={s} />
      <ReportSourcesSetup s={s} focus={focus} />
      <ReleaseRecipeSetup s={s} />

      <InstallEntry place="setup" />
      <NotificationsSetup projectId={s.project.id} projectName={s.project.name} />
      <TimeZoneSetup />

      <h2>Archive</h2>
      <div className="card row wrap">
        <span className="grow" />
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
