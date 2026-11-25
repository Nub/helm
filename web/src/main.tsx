import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, closeStream, setUnauthorizedHandler, useLive } from './api';
import type { Meta, ProjectSummary } from './api';
import { HandoffPrompt, HandoffSheet } from './handoff';
import { SystemPage } from './system';
import { InstallEntry } from './install';
import { GlobalHome } from './overview';
import { NotificationsCard, startPush, useAppBadge, usePresence } from './notify';
import { reportZone } from './timezone';
import type { ZoneState } from './timezone';
import type { NeedsAcross } from './needs';
import { AutonomyPicker, PreviewHost } from './more';
import { ErrorBadge, ProjectPage } from './project';
import type { ProjectNav } from './project';
import { openProjectSearch } from './search';
import { KeyboardKeys } from './keyhost';
import { prefetchPages } from './lazy';
import { ProjectReorder } from './projectorder';
import './styles.css';
import { AnnotatorHost } from './annotate';
import { ViewerHost } from './viewer';
import { HelmPage, RunnerBanner, UpdateBanner, SideHelmLink, useVersion } from './update';
import { SwitcherButton, SwitcherHost, lastProject, rememberProject } from './switcher';
import { DiskBanner, useDiskStatus } from './disk';
import type { VersionState } from './update';
import { useRefRefresh } from './refcache';
import { useKeyboardInset } from './keyboard';
import { Empty, Icon, Tag, go, href, useAction, useRoute, useTick } from './ui';
import { MODE_LABEL, ModeChip, ModeSheetHost, holdsWork } from './projectmode';
import type { Mode } from './projectmode';

function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [access, setAccess] = useState<string | null>(null);
  useEffect(() => {
    setUnauthorizedHandler(() => {
      closeStream();
      setAuthed(false);
    });
    api<{ authed: boolean; via?: string | null; signedInBy?: string | null; timeZone?: ZoneState }>('/api/session')
      .then((d) => {
        setAuthed(d.authed);
        if (d.authed) reportZone(d.timeZone);
        setAccess(d.via === 'lan' ? 'Local network, no sign-in' : d.via === 'sso' ? `Signed in through ${d.signedInBy || 'the sign-in gate'}` : null);
      })
      .catch(() => setAuthed(false));
  }, []);
  if (authed === null) return <div className="loading">Loading…</div>;
  if (!authed)
    return (
      <Login
        onDone={() => {
          setAuthed(true);
          api<{ timeZone?: ZoneState }>('/api/session').then((d) => reportZone(d.timeZone), () => {});
        }}
      />
    );
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
  // The lazy pages' chunks, fetched once the app is idle (lazy.tsx), so the first switch to one is instant.
  useEffect(() => prefetchPages(), []);
  usePresence();
  useAppBadge(openCount);
  // The global Inbox became Needs you, and Needs you the top of the global Home; old links land on its requests.
  useEffect(() => {
    if (route[0] === 'inbox' || route[0] === 'needs') location.replace(href('home', 'needs'));
    // Hosts, Telemetry and Disk became sections of System.
    else if (route[0] === 'hosts' || route[0] === 'telemetry') location.replace(href('system', route[0]));
    // The Toolbox became System › Tools.
    else if (route[0] === 'toolbox') location.replace(href('system', 'tools'));
    else if (route[0] === 'helm' && route[1] === 'disk') location.replace(href('system', 'disk'));
  }, [route[0], route[1]]);
  const current = route[0] === 'p' ? list.find((p) => p.id === route[1]) : undefined;
  // The project Helm opens on next time (Landing).
  useEffect(() => {
    if (route[0] === 'p' && route[1]) rememberProject(route[1]);
  }, [route[0], route[1]]);
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
  if (route[0] === 'p' && route[1]) page = <ProjectPage key={route[1]} id={route[1]} tab={route[2] ?? 'overview'} sub={route[3]} focus={route[4]} onNav={setProjectNav} version={version} />;
  else if (route[0] === 'home') page = <GlobalHome section={route[1]} />;
  else if (route[0] === 'needs' || route[0] === 'inbox') page = null;
  else if (route[0] === 'new') page = <NewProject />;
  else if (route[0] === 'system') page = <SystemPage section={route[1]} project={route[2]} />;
  else if (route[0] === 'hosts' || route[0] === 'telemetry') page = null;
  else if (route[0] === 'toolbox') page = null;
  else if (route[0] === 'helm')
    page =
      route[1] === 'disk' ? null : (
        <>
          <HelmPage v={version} />
          {/* This device's notifications and install, once on the All projects page. */}
          <section className="helm-device">
            <NotificationsCard />
            <InstallEntry place="home" />
            {access && <p className="muted small">{access}</p>}
          </section>
        </>
      );
  else page = <Landing projects={list} loaded={!!projects.data} />;

  return (
    <div className={`shell ${route[0] === 'p' ? 'in-project' : ''}`}>
      <AnnotatorHost />
      <ViewerHost />
      <PreviewHost />
      <aside className="sidebar">
        <a className="brand" href={href()}>
          <img src="/icon.svg" alt="" width={26} height={26} /> Helm
        </a>
        <a className={`side-link ${route[0] === 'home' ? 'on' : ''}`} href={href('home')}>
          <Icon name="home" /> Home {openCount > 0 && <b className="badge">{openCount}</b>}
        </a>
        <a className={`side-link ${route[0] === 'system' ? 'on' : ''}`} href={href('system')}>
          <Icon name="hosts" /> System
        </a>
        <div className="side-label">Projects</div>
        <ProjectReorder
          items={list.filter((p) => !p.archived)}
          gap={2}
          className="side-projects"
          render={(p, handle) => (
            <div className="side-project">
              {handle}
              <a className={`side-link project-link ${current?.id === p.id ? 'on' : ''}`} href={href('p', p.id, 'overview')} aria-label={`${p.name}${p.working ? ', working now' : ''}${p.openInbox ? `, ${p.openInbox} waiting on you` : ''}${p.errored ? `, ${p.errored} stopped with an error` : ''}`}>
                <span className={`status-dot ${p.working ? 'dot-working pulse' : p.errored ? 'dot-error' : p.openInbox ? 'dot-waiting' : ''}`} />
                <span className="one-line">{p.name}</span>
                {holdsWork(p.mode) && <span className={`tag mode-chip mode-${p.mode} mini`} title={MODE_LABEL[p.mode as Mode]}><span className="mode-dot" aria-hidden="true" /></span>}
                {!!p.errored && <ErrorBadge n={p.errored} />}
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
        <SideHelmLink v={version} on={route[0] === 'helm'} />
      </aside>

      <header className="topbar">
        {route.length > 0 && !(route[0] === 'p' && !route[3]) ? (
          <a className="icon-btn" href={route[0] === 'p' && route[3] ? href('p', route[1], route[2]) : href()} aria-label="Back">
            <Icon name="back" size={20} />
          </a>
        ) : (
          <img src="/icon.svg" alt="" width={28} height={28} />
        )}
        {current ? <SwitcherButton name={current.name} /> : <strong className="one-line">{(route[0] === 'home' ? 'Home' : route[0] === 'new' ? 'New project' : route[0] === 'system' ? 'System' : route[0] === 'toolbox' ? 'Toolbox' : 'Helm')}</strong>}
        <span className="spacer" />
        {nav && nav.progress !== null && <span className="bar-pct mono" aria-hidden="true">{nav.progress}%</span>}
        {/* In a project, right-aligned beside Needs you: its mode and what it is doing, the menu that changes it (projectmode.tsx). */}
        {nav && current && <ModeChip projectId={current.id} mode={current.mode} working={current.working} queued={current.queued} className="bar-mode" />}
        {/* Inside a project, Hosts and Helm are under its More (the top bar keeps back, the name and Needs you). */}
        {/* Not the page you are on: its button would only crowd out the page's name on a phone. */}
        {!nav && (
          <>
            {route[0] !== 'system' && <a className="icon-btn" href={href('system')} aria-label="System">
              <Icon name="hosts" size={20} />
              <span className="bar-cap" aria-hidden="true">System</span>
            </a>}
          </>
        )}
        {/* In a project: its search (search.tsx). On Home it shows only where Home's own field is folded away (styles.css). */}
        {nav && (
          <button type="button" className="icon-btn bar-search" onClick={openProjectSearch} aria-label="Search this project">
            <Icon name="search" size={20} />
            <span className="bar-cap" aria-hidden="true">Search</span>
          </button>
        )}
        {route[0] !== 'home' && <a className="icon-btn" href={href('home')} aria-label={`Needs you, ${openCount} open ${openCount === 1 ? 'request' : 'requests'}`}>
          <Icon name="inbox" size={20} />
          {openCount > 0 && <b className="badge">{openCount}</b>}
          <span className="bar-cap" aria-hidden="true">Needs you</span>
        </a>}
        {/* The project's overall progress, a slim line along the bar's bottom edge on every project page. */}
        {nav && nav.progress !== null && (
          <div className="bar-progress" role="progressbar" aria-label="Project progress" aria-valuenow={nav.progress} aria-valuemin={0} aria-valuemax={100} aria-valuetext={`${nav.progress}%`}>
            <div style={{ width: `${nav.progress}%` }} />
          </div>
        )}
      </header>

      <ModeSheetHost />
      <KeyboardKeys />
      <main className="main">
        <UpdateBanner v={version} />
        <DiskBanner s={disk.data} />
        {!version.restarting && <RunnerBanner />}
        {page}
      </main>
      {handoff && <HandoffSheet onClose={() => setHandoff(false)} />}
      <SwitcherHost projects={list} current={current?.id} onHandoff={() => setHandoff(true)} />
    </div>
  );
}

// ---------- landing ----------

/**
 * Helm opens on the last project opened on this device (the first one if none): the project switcher in the top bar
 * replaced the All projects page. With no project yet: a start.
 */
function Landing({ projects, loaded }: { projects: ProjectSummary[]; loaded: boolean }) {
  const active = projects.filter((p) => !p.archived);
  const last = lastProject();
  const target = active.find((p) => p.id === last) ?? active[0];
  useEffect(() => {
    if (target) location.replace(href('p', target.id, 'overview'));
  }, [target?.id]);
  if (!loaded || target) return <div className="loading">Loading…</div>;
  return (
    <section className="home">
      <Empty title="No projects yet">
        <a href={href('new')}>Create a project</a>
      </Empty>
    </section>
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
                <Icon name="back" size={16} /> Up one level
              </button>
            </li>
          )}
          {listing.dirs.map((d) => (
            <li key={d.path}>
              <button type="button" onClick={() => load(d.path)}>
                <Icon name="folder" size={16} /> <span className="one-line">{d.name}</span>
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
  const [autonomy, setAutonomy] = useState('auto');
  const { busy, error, run } = useAction();

  const create = () =>
    run(async () => {
      const { id } = await api<{ id: string }>('/api/projects', { body: { mode, name, path, gitUrl, brief, autonomy } });
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
