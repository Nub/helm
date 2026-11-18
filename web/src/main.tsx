import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, closeStream, setUnauthorizedHandler, useLive } from './api';
import type { ApprovalPolicy, Meta, ProjectSummary, Structure } from './api';
import { HandoffPrompt, HandoffSheet } from './handoff';
import { HostsPage } from './hosts';
import { InstallEntry } from './install';
import { NeedsYouPage } from './needs';
import { NotificationsCard, startPush, useAppBadge, usePresence } from './notify';
import type { NeedsAcross } from './needs';
import { ApprovalPicker, AutonomyPicker, StructureEditor } from './more';
import { ProjectPage } from './project';
import type { ProjectNav } from './project';
import { ToolboxPage, toolboxRefresh } from './toolbox';
import { ProjectReorder } from './projectorder';
import './styles.css';
import { AnnotatorHost } from './annotate';
import { ViewerHost } from './viewer';
import { HelmPage, UpdateBanner, VersionFooter, useVersion } from './update';
import { DiskBanner, DiskPage, useDiskStatus } from './disk';
import type { VersionState } from './update';
import { useRefRefresh } from './refcache';
import { useKeyboardInset } from './keyboard';
import { Empty, Icon, Progress, Tag, ago, go, href, useAction, useRoute, useTick , PlainRefs } from './ui';

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [access, setAccess] = useState<string | null>(null);
  useEffect(() => {
    setUnauthorizedHandler(() => {
      closeStream();
      setAuthed(false);
    });
    api<{ authed: boolean; via?: string | null; signedInBy?: string | null }>('/api/session')
      .then((d) => {
        setAuthed(d.authed);
        setAccess(d.via === 'lan' ? 'Local network, no sign-in' : d.via === 'sso' ? `Signed in through ${d.signedInBy || 'the sign-in gate'}` : null);
      })
      .catch(() => setAuthed(false));
  }, []);
  if (authed === null) return <div className="loading">Loading…</div>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  return <Shell access={access} />;
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const { busy, error, run } = useAction();
  return (
    <form
      className="login"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api('/api/login', { body: { token } }))) onDone();
      }}
    >
      <img src="/icon.svg" alt="" width={56} height={56} />
      <h1>Helm</h1>
      <p className="muted">Enter the passphrase the server printed when it started.</p>
      <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Passphrase" autoFocus autoComplete="current-password" />
      <button className="btn primary" disabled={busy || !token}>
        Sign in
      </button>
      {error && <p className="error-text">{error}</p>}
    </form>
  );
}

function Shell({ access }: { access: string | null }) {
  useTick();
  useRefRefresh();
  useKeyboardInset();
  const route = useRoute();
  const projects = useLive<{ projects: ProjectSummary[] }>('/api/projects', (m) => m.type === 'projects');
  // Everything awaiting the user's response, across projects: the top bar's count and the Needs you page.
  const needs = useLive<NeedsAcross>('/api/needs', (m) => m.type === 'project' || m.type === 'projects');
  const list = projects.data?.projects ?? [];
  const openCount = needs.data?.count ?? 0;
  // Notifications: the service worker and this device's subscription, what the page shows (so Helm does not notify
  // about it), and the app icon's badge.
  useEffect(() => startPush(), []);
  usePresence();
  useAppBadge(openCount);
  // The global Inbox became Needs you; old links land there.
  useEffect(() => {
    if (route[0] === 'inbox') location.replace(href('needs'));
  }, [route[0]]);
  const toolbox = useLive<{ proposed: number }>('/api/toolbox/count', toolboxRefresh);
  const proposed = toolbox.data?.proposed ?? 0;
  const current = route[0] === 'p' ? list.find((p) => p.id === route[1]) : undefined;
  const version = useVersion();
  const disk = useDiskStatus();
  const [handoff, setHandoff] = useState(false);
  // The open project's progress, reported by its page; shown only while that project is open.
  const [projectNav, setProjectNav] = useState<ProjectNav | null>(null);
  const nav = route[0] === 'p' && projectNav?.id === route[1] ? projectNav : null;

  useEffect(() => {
    document.title = `${openCount ? `(${openCount}) ` : ''}${current ? `${current.name} · ` : ''}Helm`;
  }, [openCount, current?.name]);

  let page;
  if (route[0] === 'p' && route[1]) page = <ProjectPage key={route[1]} id={route[1]} tab={route[2] ?? 'overview'} sub={route[3]} focus={route[4]} onNav={setProjectNav} />;
  else if (route[0] === 'needs' || route[0] === 'inbox') page = <NeedsYouPage data={needs.data ?? null} />;
  else if (route[0] === 'new') page = <NewProject />;
  else if (route[0] === 'hosts') page = <HostsPage />;
  else if (route[0] === 'toolbox') page = <ToolboxPage />;
  else if (route[0] === 'helm') page = route[1] === 'disk' ? <DiskPage /> : <HelmPage v={version} />;
  else page = <Home projects={projects.data ? list : null} openCount={openCount} access={access} version={version} onHandoff={() => setHandoff(true)} />;

  return (
    <div className={`shell ${route[0] === 'p' ? 'in-project' : ''}`}>
      <AnnotatorHost />
      <ViewerHost />
      <aside className="sidebar">
        <a className="brand" href={href()}>
          <img src="/icon.svg" alt="" width={26} height={26} /> Helm
        </a>
        <a className={`side-link ${route[0] === 'needs' ? 'on' : ''}`} href={href('needs')}>
          <Icon name="inbox" /> Needs you {openCount > 0 && <b className="badge">{openCount}</b>}
        </a>
        <a className={`side-link ${route.length === 0 ? 'on' : ''}`} href={href()}>
          <Icon name="home" /> All projects
        </a>
        <a className={`side-link ${route[0] === 'hosts' ? 'on' : ''}`} href={href('hosts')}>
          <Icon name="hosts" /> Hosts
        </a>
        <a className={`side-link ${route[0] === 'toolbox' ? 'on' : ''}`} href={href('toolbox')}>
          <Icon name="toolbox" /> Toolbox {proposed > 0 && <b className="badge">{proposed}</b>}
        </a>
        <div className="side-label">Projects</div>
        <ProjectReorder
          items={list.filter((p) => !p.archived)}
          gap={2}
          className="side-projects"
          render={(p, handle) => (
            <div className="side-project">
              {handle}
              <a className={`side-link project-link ${current?.id === p.id ? 'on' : ''}`} href={href('p', p.id, 'overview')} aria-label={`${p.name}${p.working ? ', working now' : ''}${p.openInbox ? `, ${p.openInbox} waiting on you` : ''}`}>
                <span className={`status-dot ${p.working ? 'dot-working pulse' : p.openInbox ? 'dot-waiting' : ''}`} />
                <span className="one-line">{p.name}</span>
                {p.openInbox > 0 && <b className="badge">{p.openInbox}</b>}
              </a>
            </div>
          )}
        />
        <a className={`side-link ${route[0] === 'new' ? 'on' : ''}`} href={href('new')}>
          <Icon name="plus" /> New project
        </a>
        <button className="side-link side-handoff" onClick={() => setHandoff(true)}>
          <Icon name="external" /> Bring in an existing session
        </button>
        <VersionFooter v={version} className="side-version" />
      </aside>

      <header className="topbar">
        {route.length > 0 ? (
          <a className="icon-btn" href={route[0] === 'p' && route[3] ? href('p', route[1], route[2]) : href()} aria-label="Back">
            <Icon name="back" size={22} />
          </a>
        ) : (
          <img src="/icon.svg" alt="" width={28} height={28} />
        )}
        <strong className="one-line">{current?.name ?? (route[0] === 'needs' ? 'Needs you' : route[0] === 'new' ? 'New project' : route[0] === 'hosts' ? 'Hosts' : route[0] === 'toolbox' ? 'Toolbox' : 'Helm')}</strong>
        {nav && nav.progress !== null && <span className="bar-pct mono" aria-hidden="true">{nav.progress}%</span>}
        <span className="spacer" />
        {/* Inside a project, Hosts, Toolbox and Helm are under its More (the top bar keeps back, the name and Needs you). */}
        {!nav && (
          <>
            <a className="icon-btn" href={href('toolbox')} aria-label={`Toolbox, ${proposed} proposed`}>
              <Icon name="toolbox" size={22} />
              {proposed > 0 && <b className="badge">{proposed}</b>}
              <span className="bar-cap" aria-hidden="true">Toolbox</span>
            </a>
            <a className="icon-btn" href={href('hosts')} aria-label="Hosts">
              <Icon name="hosts" size={22} />
              <span className="bar-cap" aria-hidden="true">Hosts</span>
            </a>
          </>
        )}
        <a className="icon-btn" href={href('needs')} aria-label={`Needs you, ${openCount} open ${openCount === 1 ? 'request' : 'requests'}`}>
          <Icon name="inbox" size={22} />
          {openCount > 0 && <b className="badge">{openCount}</b>}
          <span className="bar-cap" aria-hidden="true">Needs you</span>
        </a>
        {/* The project's overall progress, a slim line along the bar's bottom edge on every project page. */}
        {nav && nav.progress !== null && (
          <div className="bar-progress" role="progressbar" aria-label="Project progress" aria-valuenow={nav.progress} aria-valuemin={0} aria-valuemax={100} aria-valuetext={`${nav.progress}%`}>
            <div style={{ width: `${nav.progress}%` }} />
          </div>
        )}
      </header>

      <main className="main">
        <UpdateBanner v={version} />
        <DiskBanner s={disk.data} />
        {page}
      </main>
      {handoff && <HandoffSheet onClose={() => setHandoff(false)} />}
    </div>
  );
}

// ---------- home ----------

/** Whether the desktop layout (sidebar) is showing: matches the 900 px breakpoint in styles.css. */
function useWide() {
  const q = '(min-width: 900px)';
  const [wide, setWide] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

function Home({ projects, openCount, access, version, onHandoff }: { projects: ProjectSummary[] | null; openCount: number; access: string | null; version: VersionState; onHandoff: () => void }) {
  const wide = useWide();
  if (!projects) return <div className="loading">Loading…</div>;
  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);
  return (
    <section className="home">
      <div className="section-head">
        <h1 className="page-title">Projects</h1>
        <a className="btn primary" href={href('new')}>
          <Icon name="plus" size={16} /> New project
        </a>
      </div>
      {openCount > 0 && (
        <a className="needs-banner" href={href('needs')}>
          <Icon name="inbox" />
          <span>
            <strong>
              {openCount} {openCount === 1 ? 'request is' : 'requests are'} waiting on you
            </strong>
            <span className="muted small">Answering them unblocks the agents that asked.</span>
          </span>
          <Icon name="chevron" />
        </a>
      )}
      {active.length === 0 && (
        <Empty title="No projects yet">
          Start one from scratch, point Helm at a folder you already have, or clone a repository. <a href={href('new')}>Create a project</a>
        </Empty>
      )}
      {/* On a phone or tablet this is the list to reorder; on desktop the sidebar is. */}
      <ProjectReorder
        items={active}
        gap={14}
        className="project-grid project-order"
        disabled={wide}
        render={(p, handle) => (
          <div className="project-slot">
            <ProjectCard p={p} />
            {handle}
          </div>
        )}
      />
      {archived.length > 0 && (
        <details className="handled-list">
          <summary>Archived ({archived.length})</summary>
          <div className="project-grid">
            {archived.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </div>
        </details>
      )}
      <NotificationsCard />
      <InstallEntry place="home" />
      <div className="home-foot">
        <button className="btn small quiet" onClick={onHandoff}>
          Bring in an existing session
        </button>
        <VersionFooter v={version} />
        {access && <p className="muted small">{access}</p>}
      </div>
    </section>
  );
}

function ProjectCard({ p }: { p: ProjectSummary }) {
  return (
    <a className="card project-card" href={href('p', p.id, 'overview')}>
      <div className="row wrap">
        <Tag tone="tone-phase">{p.phase}</Tag>
        {p.openInbox > 0 && <Tag tone="tone-warning">{p.openInbox} waiting on you</Tag>}
        {!!p.unfiledNeeds && <Tag tone="tone-serious">{p.unfiledNeeds} {p.unfiledNeeds === 1 ? 'says' : 'say'} it needs you, nothing filed</Tag>}
        <span className="spacer" />
        <span className="muted small">{ago(p.updated_at)}</span>
      </div>
      <h2 className="project-name">{p.name}</h2>
      <p className="muted clamp" style={{ ['--lines' as any]: 2 }}>
        {p.description || p.path}
      </p>
      {p.progress !== null && (
        <div className="overall">
          <Progress value={p.progress} tone={p.working ? 'live' : ''} />
          <span className="mono small">{p.progress}%</span>
        </div>
      )}
      <p className="small one-line">
        <span className={`status-dot ${p.working ? 'dot-working pulse' : ''}`} /> {p.working ? `${p.working} of ${p.agents} working` : `${p.agents} ${p.agents === 1 ? 'agent' : 'agents'}, none working`}
        {p.statusLine && <span className="muted"> · <PlainRefs text={p.statusLine} /></span>}
      </p>
    </a>
  );
}

// ---------- new project ----------

type FsListing = { path: string; parent: string | null; git: boolean; dirs: { name: string; path: string; git: boolean }[] };

function FolderPicker({ value, onChange, start }: { value: string; onChange: (p: string) => void; start: string }) {
  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState('');
  const load = (path: string) =>
    api<FsListing>(`/api/fs?path=${encodeURIComponent(path)}`)
      .then((l) => {
        setListing(l);
        setError('');
        onChange(l.path);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load(value || start);
  }, []);
  return (
    <div className="folder-picker">
      <div className="row">
        <input value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void load(value))} spellCheck={false} />
        <button type="button" className="btn small" onClick={() => load(value)}>
          Go
        </button>
      </div>
      {error && <p className="error-text">{error}</p>}
      {listing && (
        <ul className="folder-list">
          {listing.parent && (
            <li>
              <button type="button" onClick={() => load(listing.parent!)}>
                <Icon name="back" size={15} /> Up one level
              </button>
            </li>
          )}
          {listing.dirs.map((d) => (
            <li key={d.path}>
              <button type="button" onClick={() => load(d.path)}>
                <Icon name="folder" size={15} /> <span className="one-line">{d.name}</span>
                {d.git && <Tag>git</Tag>}
              </button>
            </li>
          ))}
          {listing.dirs.length === 0 && <li className="muted small pad">No folders inside.</li>}
        </ul>
      )}
      {listing && (
        <p className="small">
          Selected: <span className="mono">{listing.path}</span> {listing.git && <Tag>git repository</Tag>}
        </p>
      )}
    </div>
  );
}

function NewProject() {
  const { data: meta } = useLive<Meta>('/api/meta', () => false);
  const [mode, setMode] = useState<'new' | 'existing' | 'clone'>('new');
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [brief, setBrief] = useState('');
  const [templateId, setTemplateId] = useState('director-crew');
  const [autonomy, setAutonomy] = useState('auto');
  const [custom, setCustom] = useState<Structure | null>(null);
  const [approval, setApproval] = useState<ApprovalPolicy>('none');
  const { busy, error, run } = useAction();

  const template = meta?.templates.find((t) => t.id === templateId);
  const create = () =>
    run(async () => {
      const { id } = await api<{ id: string }>('/api/projects', { body: { mode, name, path, gitUrl, brief, templateId, autonomy, approval } });
      if (custom) await api(`/api/projects/${id}`, { method: 'PATCH', body: { structure: { ...custom, approval } } });
      go('p', id, 'overview');
    });
  const ready = mode === 'new' ? !!name.trim() : mode === 'existing' ? !!path : !!gitUrl.trim();

  return (
    <section className="narrow new-project">
      <h1 className="page-title">New project</h1>

      <div className="segmented" role="tablist">
        {(
          [
            ['new', 'Start fresh'],
            ['existing', 'Existing folder'],
            ['clone', 'Clone a repository'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={mode === id} className={mode === id ? 'on' : ''} onClick={() => setMode(id)}>
            {label}
          </button>
        ))}
      </div>

      <HandoffDetails />

      <div className="card form">
        {mode === 'existing' && meta && (
          <label>
            Folder on this machine
            <FolderPicker value={path} onChange={setPath} start={meta.home} />
          </label>
        )}
        {mode === 'clone' && (
          <label>
            Repository URL
            <input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/you/repo.git" spellCheck={false} autoCapitalize="off" />
          </label>
        )}
        <label>
          Name {mode !== 'new' && <span className="muted">(optional, defaults to the folder name)</span>}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {mode !== 'existing' && meta && (
          <p className="muted small">
            Created under <span className="mono">{meta.projectsRoot}</span>
          </p>
        )}
        <label>
          Brief for the director <span className="muted">(optional; you can send it later)</span>
          <textarea rows={6} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What should this project achieve? What matters most, what is out of scope, how will you know it is done?" />
        </label>
      </div>

      <h2>Team</h2>
      <div className="radio-cards">
        {meta?.templates.map((t) => (
          <label key={t.id} className={`radio-card ${templateId === t.id && !custom ? 'on' : ''}`}>
            <input
              type="radio"
              name="template"
              checked={templateId === t.id && !custom}
              onChange={() => {
                setTemplateId(t.id);
                setCustom(null);
              }}
            />
            <strong>{t.name}</strong>
            <span>{t.description}</span>
          </label>
        ))}
      </div>
      {template && (
        <details className="handled-list" onToggle={(e) => (e.target as HTMLDetailsElement).open && !custom && setCustom(structuredClone(template.structure))}>
          <summary>Customize roles, models and who can delegate</summary>
          {custom && <StructureEditor value={custom} onChange={setCustom} meta={meta} />}
        </details>
      )}

      <h2>When the director changes the team</h2>
      <ApprovalPicker value={approval} onChange={setApproval} />

      <h2>How much agents may do without asking</h2>
      <AutonomyPicker value={autonomy} onChange={setAutonomy} />

      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button className="btn primary" disabled={busy || !ready} onClick={create}>
          {busy ? (mode === 'clone' ? 'Cloning…' : 'Creating…') : brief.trim() ? 'Create and start' : 'Create project'}
        </button>
        <a className="btn quiet" href={href()}>
          Cancel
        </a>
      </div>
    </section>
  );
}

/** On the new-project form: how to bring a session from another tool, collapsed until wanted. */
function HandoffDetails() {
  const [open, setOpen] = useState(false);
  return (
    <details className="handled-list handoff-details" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>Moving an existing session into Helm?</summary>
      {open && <HandoffPrompt />}
    </details>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
