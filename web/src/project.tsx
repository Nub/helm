import { SwitcherButton } from './switcher';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api, useAgentEvents, useLive } from './api';
import type { Agent, AgentEvent, ProjectState } from './api';
import { InboxCard } from './inbox';
import { requestHref, useFocusRequest } from './needs';
import { HostBadges } from './hosts';
import { Setup } from './more';
import { SpecPage } from './spec';
import { TaskPage } from './tasks';
import { Team } from './team';
import { lazyNamed, loadDashboards, loadIdeas, loadReleases, loadReports, loadToolbox } from './lazy';
import type { ProjectState as PS } from './api';
// Pages and pieces loaded on first use (lazy.tsx): each its own chunk.
const PageLoading = <div className="loading">Loading…</div>;
const ReportsPage = lazyNamed<{ s: PS; sub?: string }>(loadReports, 'ReportsPage', PageLoading);
const DashboardsPage = lazyNamed<{ s: PS; sub?: string }>(loadDashboards, 'DashboardsPage', PageLoading);
const IdeasPage = lazyNamed<{ s: PS }>(loadIdeas, 'IdeasPage', PageLoading);
import { GalleryPage } from './gallery';
const ShipPage = lazyNamed<{ s: PS; sub?: string; helm?: import('react').ReactNode }>(loadReleases, 'ShipPage', PageLoading);
const AgentToolboxLine = lazyNamed<{ agent: import('./api').Agent }>(loadToolbox, 'AgentToolboxLine');
import { AttachmentList } from './attachments';
import { seedRefs } from './refcache';
import { ChatHost, focusChatAt, routeContext } from './chat';
import { ProjectHome, triageCards } from './home';
import { SearchShortcut } from './search';
import { WorkPage, workFilter } from './work';
import { Clamp, Composer, Empty, Icon, Markdown, Progress, Sheet, Status, Tag, clock, href, modelLabel, runLabel, useAction, useTick, PlainRefs } from './ui';
import { DecisionsPage } from './decisions';
import { ModeChip, StoppedBar } from './projectmode';
import { tokensText } from './usage.ts';
import { HelmUpdate } from './update';
import type { VersionState } from './update';

/**
 * A project's pages. On a phone the bottom bar is Home, Work, Spec and More (a sheet with the rest and the
 * install-wide pages); every page belongs to exactly one of the four. On desktop the sticky row shows the same
 * grouping with More's project pages laid out after a divider. The docked chat bar (chat.tsx) is on every page.
 */
const MAIN = [
  { id: 'overview', label: 'Home', icon: 'home' },
  { id: 'work', label: 'Work', icon: 'tasks' },
  { id: 'spec', label: 'Spec', icon: 'spec' },
  // Shown only while the project's Dashboards setting is on (or it has dashboards, or one is open).
  { id: 'dashboards', label: 'Dashboards', icon: 'dashboards' },
];
const MORE = [
  { id: 'ideas', label: 'Ideas' },
  { id: 'gallery', label: 'Gallery' },
  { id: 'ship', label: 'Ship' },
  { id: 'agents', label: 'Agents' },
  { id: 'reports', label: 'Reports' },
  { id: 'setup', label: 'Setup' },
];
/**
 * Pages folded into others, and where their old links land: Knowledge into Setup, the History journal into Home,
 * Watches into System (with this project), Previews onto their tasks (a link with an id is the viewer, more.tsx
 * PreviewHost; without one, Home, where search finds them).
 */
export function movedPage(id: string, tab: string, sub?: string): string | null {
  if (tab === 'knowledge') return href('p', id, 'setup', 'knowledge');
  if (tab === 'history') return sub ? href('p', id, 'overview', 'journal', sub) : href('p', id, 'overview', 'journal');
  if (tab === 'watches') return href('system', 'watches', id);
  if (tab === 'previews' && !sub) return href('p', id, 'gallery');
  // Releases is a section of Ship (with test builds, and Helm's update for Helm's own project).
  if (tab === 'releases') return sub ? href('p', id, 'ship', sub) : href('p', id, 'ship');
  return null;
}
/** Which bottom-bar entry a page belongs to. */
const sectionOf = (tab: string) => (tab === 'overview' ? 'overview' : tab === 'work' || tab === 'tasks' || tab === 'discussions' ? 'work' : tab === 'spec' || tab === 'dashboards' ? tab : 'more');

const FINISHED = ['done', 'closed'];

export function overallProgress(agents: Agent[]): number | null {
  const measured = agents.filter((a) => !FINISHED.includes(a.status) && a.progress !== null);
  if (!measured.length) return null;
  return Math.round(measured.reduce((n, a) => n + (a.progress ?? 0), 0) / measured.length);
}

/** What the shell's top bar shows of the open project: its progress. */
export type ProjectNav = { id: string; progress: number | null };

/**
 * The desktop's sticky project row (name, progress, tabs) must never overflow. It tries the roomiest
 * form first and steps down until it fits: every tab with icon and label (0), More's pages folded into a labelled
 * More with the page shown kept as its own tab (1), tighter (2), labels without icons (3).
 * Below 900 px the row is the phone's bottom bar and this does nothing.
 */
function useFitRow() {
  const ref = useRef<HTMLElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el || innerWidth < 900) return;
    // Its height, for what sticks under it (the task page's title strip).
    document.documentElement.style.setProperty('--project-row', `${el.offsetHeight}px`);
    for (const level of ['0', '1', '2', '3']) {
      el.dataset.fit = level;
      if (el.scrollWidth <= el.clientWidth) break;
    }
  };
  useLayoutEffect(fit);
  useEffect(() => {
    const ro = new ResizeObserver(fit);
    if (ref.current) ro.observe(ref.current);
    addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      removeEventListener('resize', fit);
    };
  }, [ref.current]);
  return ref;
}

/** `version`: Helm's own version and update (update.tsx), shown in Ship for Helm's own project. */
export function ProjectPage({ id, tab, sub, focus, onNav, version }: { id: string; tab: string; sub?: string; focus?: string; onNav?: (n: ProjectNav | null) => void; version?: VersionState }) {
  useTick();
  // The Inbox tab is gone: its old links open Work filtered to Needs response.
  useEffect(() => {
    if (tab === 'inbox') location.replace(href('p', id, 'work', 'needs'));
    const moved = movedPage(id, tab, sub);
    if (moved) location.replace(moved);
  }, [tab, id, sub]);
  useFocusRequest(focus);
  // A chat message (a search hit, #/p/<project>/chat/<event id>): Home, with the chat open at it (chat.tsx).
  useEffect(() => {
    if (tab !== 'chat' || !sub) return;
    focusChatAt(id, sub);
    location.replace(href('p', id));
  }, [tab, sub, id]);
  // A notification's stable route to a request (#/p/<project>/request/<id>): find where it is shown now and replace
  // this history entry with that page, scrolled to it. Gone: the project's Needs response list. A phone just woken
  // may be offline for a moment, so other failures are retried for a while first; signed out, the sign-in shows and
  // this runs again after it.
  useEffect(() => {
    if (tab !== 'request' || !sub) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fallback = () => live && location.replace(href('p', id, 'work', 'needs'));
    const resolve = (tries: number) =>
      api<{ project_id: string; task_id: string | null; home_kind: 'task' | 'discussion' | null }>(`/api/requests/${encodeURIComponent(sub)}/where`)
        .then((w) => {
          if (live) location.replace(w.task_id ? requestHref({ project_id: w.project_id, id: w.task_id, kind: w.home_kind ?? 'task' }, sub) : href('p', id, 'work', 'needs'));
        })
        .catch((e) => {
          const status = e instanceof ApiError ? e.status : 0;
          if (status === 401) return;
          if (status === 404 || tries >= 8) return fallback();
          if (live) timer = setTimeout(() => resolve(tries + 1), 1500);
        });
    void resolve(0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tab, sub, id]);
  const { data, error } = useLive<ProjectState>(`/api/projects/${id}`, (m) => m.type === 'project' && m.projectId === id);
  // Reference chips in this project show its items from this state, current as it changes.
  useMemo(() => data && seedRefs(data, false), [data]);
  useEffect(() => {
    if (data) seedRefs(data);
  }, [data]);
  const active = tab || 'overview';
  const progress = data ? overallProgress(data.agents) : null;
  useEffect(() => {
    if (data) onNav?.({ id: data.project.id, progress });
  }, [data?.project.id, progress]);
  useEffect(() => () => onNav?.(null), []);
  const rowRef = useFitRow();
  const [more, setMore] = useState(false);
  useEffect(() => setMore(false), [active, sub]);
  if (error && !data) return <Empty title="Could not load this project">{error}</Empty>;
  if (!data) return <div className="loading">Loading…</div>;
  const reportCount = data.reports.new + data.reports.needs_input;
  // Agents stopped with an error (server/agenterrors.ts): a red badge on Agents, and on More on the phone.
  const errored = data.agents.filter((a) => a.status === 'error').length;
  const section = sectionOf(active);
  const needs = triageCards(data).length;
  const detail = (active === 'tasks' || active === 'discussions') && !!sub && sub !== 'recent' && sub !== 'needs';
  const moreTabs = MORE.filter((t) => (t.id !== 'reports' || data.reports.sources > 0 || data.reports.total > 0 || active === 'reports') && (t.id !== 'ship' || data.own_helm || data.releases?.on !== false || (data.releases?.count ?? 0) > 0 || active === 'ship'));
  const mainTabs = MAIN.filter((t) => t.id !== 'dashboards' || data.dashboards?.on !== false || (data.dashboards?.count ?? 0) > 0 || active === 'dashboards');

  return (
    <div className={`project page-${active}`}>
      <nav className="tabs" aria-label="Project sections" ref={rowRef}>
        {/* Desktop only: the project's name and progress stay in view on every page. */}
        <div className="tabs-project">
          <SwitcherButton name={data.project.name} />
          <ModeChip projectId={data.project.id} mode={data.mode?.mode} working={data.agents.filter((a) => a.status === 'working').length} queued={data.tasks.filter((t) => t.state === 'scheduled' || t.state === 'active').length} />
          {progress !== null && (
            <span className="tabs-progress">
              <Progress value={progress} />
              <span className="mono small">{progress}%</span>
            </span>
          )}
        </div>
        {mainTabs.map((t) => {
          const on = section === t.id;
          return (
            <a key={t.id} href={href('p', id, t.id)} className={on ? 'tab on' : 'tab'} aria-current={on ? 'page' : undefined} aria-label={t.id === 'overview' && needs ? `Home, ${needs} ${needs === 1 ? 'thing needs' : 'things need'} you` : undefined}>
              <span className="tab-icon">
                <Icon name={t.icon} size={20} />
                {t.id === 'overview' && needs > 0 && <b className="badge">{needs > 99 ? '99+' : needs}</b>}
              </span>
              <span className="tab-label">{t.label}</span>
            </a>
          );
        })}
        {/* Desktop: More's project pages in the row itself. */}
        <span className="tab-divider" aria-hidden="true" />
        {moreTabs.map((t) => (
          <a key={t.id} href={href('p', id, t.id)} className={`tab tab-wide ${active === t.id ? 'on' : ''}`} aria-current={active === t.id ? 'page' : undefined}>
            <span className="tab-icon">
              <Icon name={t.id} size={20} />
              {t.id === 'reports' && reportCount > 0 && <b className="badge">{reportCount > 99 ? '99+' : reportCount}</b>}
              {t.id === 'agents' && errored > 0 && <ErrorBadge n={errored} />}
            </span>
            <span className="tab-label">{t.label}</span>
          </a>
        ))}
        {/* Phone: More opens a sheet. */}
        <button className={`tab tab-more ${section === 'more' ? 'on' : ''}`} onClick={() => setMore(true)} aria-haspopup="dialog" aria-label={errored ? `More, ${errored} ${errored === 1 ? 'agent' : 'agents'} stopped with an error` : undefined} aria-current={section === 'more' ? 'page' : undefined}>
          <span className="tab-icon">
            <Icon name="more" size={20} />
            {errored > 0 ? <ErrorBadge n={errored} /> : reportCount > 0 && <b className="badge">{reportCount > 99 ? '99+' : reportCount}</b>}
          </span>
          <span className="tab-label">More</span>
        </button>
      </nav>
      {active !== 'overview' && data.mode?.mode === 'stopped' && <StoppedBar s={data} />}
      <div className="project-body">
        {active === 'overview' && <ProjectHome s={data} journal={sub === 'journal' ? (focus ?? '') : undefined} />}
        {active === 'request' && <div className="loading">Opening the request…</div>}
        {active === 'chat' && <div className="loading">Opening the chat…</div>}
        {active === 'spec' && <SpecPage s={data} focus={sub} />}
        {(active === 'work' || active === 'tasks' || active === 'discussions') &&
          (detail ? <TaskPage key={sub} s={data} taskId={sub!} tab={active === 'discussions' ? 'discussions' : 'tasks'} /> : <WorkPage s={data} filter={workFilter(active, sub)} recent={sub === 'recent'} />)}
        {active === 'agents' && (sub ? <AgentDetail s={data} agentId={sub} /> : <Team s={data} page />)}
        {active === 'reports' && <ReportsPage s={data} sub={sub} />}
        {active === 'dashboards' && <DashboardsPage s={data} sub={sub} />}
        {active === 'ship' && <ShipPage s={data} sub={sub} helm={data.own_helm && version ? <HelmUpdate v={version} /> : null} />}
        {active === 'previews' && <div className="loading">Opening the preview…</div>}
        {active === 'gallery' && <GalleryPage s={data} />}
        {active === 'ideas' && <IdeasPage s={data} />}
        {active === 'setup' && (sub === 'decisions' ? <DecisionsPage s={data} /> : <Setup s={data} focus={sub} />)}
      </div>
      {/* An agent's page has its own composer to that agent; the director's chat bar would cover it. */}
      {!(active === 'agents' && sub) && <ChatHost s={data} page={routeContext(data, active, sub)} />}
      <SearchShortcut s={data} />
      {more && <MoreSheet s={data} tabs={moreTabs} active={active} reportCount={reportCount} errored={errored} onClose={() => setMore(false)} />}
    </div>
  );
}

/** How many agents stopped with an error: the badge, in red, with a label for screen readers. */
export function ErrorBadge({ n }: { n: number }) {
  return (
    <b className="badge badge-error" title={`${n} ${n === 1 ? 'agent' : 'agents'} stopped with an error`}>
      {n > 99 ? '99+' : n}
    </b>
  );
}

/** The phone's More: the project's other pages, then the install-wide ones. */
function MoreSheet({ s, tabs, active, reportCount, errored, onClose }: { s: ProjectState; tabs: typeof MORE; active: string; reportCount: number; errored: number; onClose: () => void }) {
  const id = s.project.id;
  return (
    <Sheet title="More" onClose={onClose}>
      <ul className="more-list">
        {tabs.map((t) => (
          <li key={t.id}>
            <a className={active === t.id ? 'on' : ''} href={href('p', id, t.id)} onClick={onClose}>
              <Icon name={t.id} size={20} /> <span>{t.label}</span>
              {t.id === 'reports' && reportCount > 0 && <b className="badge">{reportCount}</b>}
              {t.id === 'agents' && errored > 0 && <ErrorBadge n={errored} />}
              <Icon name="chevron" size={16} />
            </a>
          </li>
        ))}
      </ul>
      <h3 className="more-label">Across projects</h3>
      <ul className="more-list">
        <li>
          <a href={href('system')} onClick={onClose}>
            <Icon name="hosts" size={20} /> <span>System</span>
            <Icon name="chevron" size={16} />
          </a>
        </li>
        <li>
          <a href={href('helm')} onClick={onClose}>
            <img src="/icon.svg" alt="" width={20} height={20} /> <span>Helm: version and updates</span>
            <Icon name="chevron" size={16} />
          </a>
        </li>
      </ul>
    </Sheet>
  );
}

// ---------- agents ----------

export function Checklist({ agent }: { agent: Agent }) {
  const items = agent.checklist.filter((i) => i.state !== 'dropped');
  if (!agent.checklist.length) return <p className="muted small">No worklist yet.</p>;
  return (
    <ul className="checklist">
      {agent.checklist.map((i) => (
        <li key={i.id} className={`item item-${i.state}`}>
          <span className="box" aria-hidden="true">
            {i.state === 'done' && <Icon name="check" size={16} />}
          </span>
          <span className="item-text">{i.text}</span>
          {['doing', 'blocked', 'dropped'].includes(i.state) && <span className={`item-state st-${i.state}`}>{i.state === 'doing' ? 'in progress' : i.state}</span>}
        </li>
      ))}
      <li className="sr-only">{items.filter((i) => i.state === 'done').length} of {items.length} done</li>
    </ul>
  );
}

export function progressLabel(a: Agent): string {
  const live = a.checklist.filter((i) => i.state !== 'dropped');
  if (live.length) return `${live.filter((i) => i.state === 'done').length} of ${live.length}`;
  return a.progress !== null ? `${a.progress}%` : '';
}


// ---------- one agent ----------

function AgentDetail({ s, agentId }: { s: ProjectState; agentId: string }) {
  const agent = s.agents.find((a) => a.id === agentId);
  const { busy, error, run } = useAction();
  if (!agent) return <Empty title="No such agent" />;
  const role = s.project.structure.roles.find((r) => r.id === agent.role_id);
  const parent = s.agents.find((a) => a.id === agent.parent_id);
  const open = s.inbox.filter((i) => i.status === 'open' && i.agent_id === agent.id);
  const post = (action: string) => run(() => api(`/api/agents/${agent.id}/${action}`, { method: 'POST', body: {} }));

  return (
    <section className="agent-detail">
      <a className="back" href={href('p', s.project.id, 'agents')}>
        <Icon name="back" size={16} /> Agents
      </a>
      <header className="card">
        <div className="row wrap">
          <h1 className="page-title">{agent.name}</h1>
          <span className="spacer" />
          <Status status={agent.status} />
        </div>
        <p className="muted small">
          {role?.name ?? agent.role_id} · {runLabel(agent) || modelLabel(agent.model)}
          {agent.task_id && agent.parent_id && (
            <>
              {' '}
              · on <a href={href('p', s.project.id, 'tasks', agent.task_id)}>{s.tasks.find((t) => t.id === agent.task_id)?.title ?? agent.task_id}</a>
            </>
          )}
          {parent && (
            <>
              {' '}
              · reports to <a href={href('p', s.project.id, 'agents', parent.id)}>{parent.name}</a>
            </>
          )}
          {tokensText(agent.tokens) && <> · {tokensText(agent.tokens)}</>}
        </p>
        <HostBadges agentId={agent.id} s={s} />
        <AgentToolboxLine agent={agent} />
        {agent.status_line && <p className="status-line"><PlainRefs text={agent.status_line} /></p>}
        {agent.progress !== null && (
          <div className="overall">
            <Progress value={agent.progress} tone={agent.status === 'working' ? 'live' : ''} />
            <span className="mono small">{progressLabel(agent)}</span>
          </div>
        )}
        <Checklist agent={agent} />
        {agent.task && (
          <details className="task">
            <summary>Assigned task</summary>
            <Markdown text={agent.task} />
          </details>
        )}
        <div className="row wrap actions">
          {['working', 'waiting'].includes(agent.status) && (
            <button className="btn" disabled={busy} onClick={() => post('stop')}>
              <Icon name="stop" size={16} /> Stop turn
            </button>
          )}
          {['interrupted', 'error'].includes(agent.status) && (
            <button className="btn" disabled={busy} onClick={() => post('resume')}>
              <Icon name="play" size={16} /> Resume
            </button>
          )}
          {agent.status !== 'closed' && agent.parent_id && (
            <button className="btn quiet" disabled={busy} onClick={() => confirm(`Close ${agent.name}? Its history stays.`) && post('close')}>
              Close agent
            </button>
          )}
        </div>
        {error && <p className="error-text">{error}</p>}
      </header>

      {open.map((i) => (
        <InboxCard key={i.id} item={i} agentName={agent.name} />
      ))}

      <Transcript agentId={agent.id} working={agent.status === 'working'} />

      <div className="sticky-composer">
        <Composer placeholder={`Message ${agent.name}`} onSend={(text, attachments) => api(`/api/agents/${agent.id}/message`, { body: { text, attachments } })} attachTo={agent.project_id} draftKey={`agent:${agent.id}`} />
      </div>
    </section>
  );
}

function Transcript({ agentId, working }: { agentId: string; working: boolean }) {
  const { events, loaded, more, loadOlder } = useAgentEvents(agentId);
  const [showTools, setShowTools] = useState(true);
  const end = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const onScroll = () => {
      pinned.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
    };
    addEventListener('scroll', onScroll, { passive: true });
    return () => removeEventListener('scroll', onScroll);
  }, []);
  // Follow new output only while the reader is already at the bottom.
  const lastId = events[events.length - 1]?.id;
  useEffect(() => {
    if (loaded && pinned.current) end.current?.scrollIntoView({ block: 'end' });
  }, [lastId, loaded]);

  const results = useMemo(() => {
    const map = new Map<string, AgentEvent>();
    for (const e of events) if (e.kind === 'tool_result') map.set(e.data.id, e);
    return map;
  }, [events]);

  return (
    <section className="transcript">
      <div className="section-head">
        <h2>Transcript</h2>
        <label className="check">
          <input type="checkbox" checked={showTools} onChange={(e) => setShowTools(e.target.checked)} /> Tool calls
        </label>
      </div>
      {!loaded && <div className="loading">Loading…</div>}
      {loaded && more && (
        <button className="btn small quiet" onClick={loadOlder}>
          Load earlier
        </button>
      )}
      {loaded && events.length === 0 && <Empty title="Nothing yet" />}
      {events.map((e) => (
        <EventRow key={e.id} e={e} result={e.kind === 'tool' ? results.get(e.data.id) : undefined} showTools={showTools} />
      ))}
      {working && (
        <div className="thinking">
          <span className="status-dot pulse" /> Working…
        </div>
      )}
      <div ref={end} />
    </section>
  );
}

const CONSULT_IN = /^<(agent-question|review-request|manager-answer)([^>]*)>\n?([\s\S]*?)\n?<\/\1>\s*$/;
const VERDICT: Record<string, string> = { accepted: 'accepted', changes_needed: 'changes needed' };

/** Questions and reviews between an agent and its manager (server/consults.ts), as their own rows. */
function ConsultRow({ e, result }: { e: AgentEvent; result?: AgentEvent }) {
  const d = e.data;
  if (e.kind === 'inbound') {
    const m = CONSULT_IN.exec(String(d.text ?? ''));
    if (!m) return null;
    const verdict = /verdict="([^"]*)"/.exec(m[2])?.[1];
    const label =
      m[1] === 'agent-question' ? `Question from ${d.from?.name}` : m[1] === 'review-request' ? `Review request from ${d.from?.name}` : `Answer from ${d.from?.name}`;
    // The closing line telling the manager how to answer is for the agent, not the reader.
    const body = m[3].replace(/^It is about the (task|discussion) [^\n]*\n\n/, '').replace(/\n\n(Answer with message_agent|Review it yourself or spawn a reviewer)[\s\S]*$/, '');
    return (
      <div className={`ev consult ${m[1] === 'manager-answer' ? 'answer' : 'ask'}`}>
        <span className="label">
          {label}
          {/blocking="true"/.test(m[2]) && m[1] === 'agent-question' && ' · blocking'} · {clock(e.ts)}
        </span>
        {verdict && <Tag tone={verdict === 'accepted' ? 'st-done' : 'tone-warning'}>{VERDICT[verdict] ?? verdict}</Tag>}
        <Clamp text={body.replace(/^Review (accepted|changes needed|answered)\.\n\n/, '')} lines={6} />
      </div>
    );
  }
  let input: any = {};
  try {
    input = JSON.parse(d.input);
  } catch {
    // Clipped; the summary still says enough.
  }
  const name = String(d.name).slice('mcp__helm__'.length);
  const label = name === 'ask_manager' ? `Asked its manager${input.blocking ? ' · blocking' : ''}` : name === 'request_review' ? 'Asked for review' : `Answered ${/Delivered to "([^"]+)"/.exec(String(result?.data.text ?? ''))?.[1] ?? input.agent ?? ''}`;
  const text = name === 'ask_manager' ? input.question : name === 'request_review' ? [input.summary, input.where && `Where: ${input.where}`].filter(Boolean).join('\n\n') : input.message;
  return (
    <div className="ev consult sent">
      <span className="label">
        {label} · {clock(e.ts)}
      </span>
      {input.verdict && <Tag tone={input.verdict === 'accepted' ? 'st-done' : 'tone-warning'}>{VERDICT[input.verdict] ?? input.verdict}</Tag>}
      <Clamp text={String(text ?? d.summary ?? '')} lines={6} />
    </div>
  );
}

const isConsult = (e: AgentEvent) =>
  (e.kind === 'inbound' && CONSULT_IN.test(String(e.data.text ?? ''))) ||
  (e.kind === 'tool' && ['mcp__helm__ask_manager', 'mcp__helm__request_review'].includes(e.data.name)) ||
  (e.kind === 'tool' && e.data.name === 'mcp__helm__message_agent' && /"reply_to"/.test(String(e.data.input)));

function EventRow({ e, result, showTools }: { e: AgentEvent; result?: AgentEvent; showTools: boolean }) {
  const d = e.data;
  if (isConsult(e)) return <ConsultRow e={e} result={result} />;
  if (e.kind === 'inbound') {
    const fromUser = d.from?.kind === 'user';
    const text = String(d.text).replace(/^<(agent-report|user-answer|helm-note)[^>]*>\n?/, '').replace(/\n?<\/(agent-report|user-answer|helm-note)>$/, '');
    return (
      <div className={`ev inbound ${fromUser ? 'from-user' : 'from-agent'}`}>
        <span className="label">
          {fromUser ? 'You' : d.from?.name} · {clock(e.ts)}
        </span>
        <Clamp text={text} lines={fromUser ? 12 : 5} />
        {d.attachments && <AttachmentList items={d.attachments} className="msg-atts" />}
      </div>
    );
  }
  if (e.kind === 'text') {
    return (
      <div className={`ev said ${d.sub ? 'sub' : ''}`}>
        <Clamp text={String(d.text ?? '')} lines={12} />
      </div>
    );
  }
  if (e.kind === 'tool') {
    if (!showTools) return null;
    const helm = String(d.name).startsWith('mcp__helm__');
    const name = helm ? String(d.name).slice('mcp__helm__'.length) : d.name;
    return (
      <details className={`ev tool ${helm ? 'helm' : ''} ${result?.data.error ? 'failed' : ''}`}>
        <summary>
          <span className="tool-name">{name}</span>
          {/* The same "cd <worktree> &&" opens most commands: the line shows what runs after it. */}
          <span className="tool-summary">{String(d.summary ?? '').replace(/^cd\s+\S+\s*&&\s*/, '')}</span>
          {result?.data.error && <Tag tone="tone-critical">failed</Tag>}
        </summary>
        <pre>{d.input}</pre>
        {result && <pre className="tool-out">{result.data.text || '(no output)'}</pre>}
      </details>
    );
  }
  if (e.kind === 'result') {
    return (
      <div className={`ev turn-end ${d.ok ? '' : 'failed'}`}>
        <span>
          {d.ok ? 'Turn finished' : 'Turn ended early'} · {clock(e.ts)}
          {typeof d.ms === 'number' && ` · ${d.ms > 90000 ? `${Math.round(d.ms / 60000)} min` : `${Math.round(d.ms / 1000)} s`}`}
        </span>
        {!d.ok && d.text && <p>{d.text}</p>}
      </div>
    );
  }
  if (e.kind === 'error') return <div className="ev error-text">{d.message}</div>;
  if (e.kind === 'note') return <div className="ev turn-end">{d.text}</div>;
  return null;
}
