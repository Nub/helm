import { useState } from 'react';
import { ApiError, api, useLive } from './api';
import type { Host, HostClaim, ProjectState } from './api';
import { Empty, Icon, Markdown, Progress, Sheet, Tag, ago, href, useAction } from './ui';

type HostsData = { hosts: Host[]; projects: { id: string; name: string }[] };

const sshCommand = (h: Host) => `ssh ${h.port ? `-p ${h.port} ` : ''}${h.ssh_target}`;
const testCommand = (h: Host) => `ssh -o BatchMode=yes ${h.port ? `-p ${h.port} ` : ''}${h.ssh_target} true`;

/** "12 min", "3 h": how long a claim has been held. */
function heldFor(ts: number): string {
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'just now';
  if (m < 90) return `${m} min`;
  if (m < 60 * 36) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} d`;
}

const STATE: Record<Host['check_state'], { label: string; cls: string }> = {
  online: { label: 'Online', cls: 'hs-online' },
  offline: { label: 'Offline', cls: 'hs-offline' },
  login: { label: 'Login fails', cls: 'hs-login' },
  unknown: { label: 'Not checked', cls: 'hs-unknown' },
};

export function HostState({ h }: { h: Host }) {
  const st = h.checking && h.check_state === 'unknown' ? { label: 'Checking…', cls: 'hs-unknown' } : (STATE[h.check_state] ?? STATE.unknown);
  return (
    <span className={`host-state ${st.cls}`}>
      <span className="status-dot" />
      {st.label}
    </span>
  );
}

/** Load average against core count, as a small meter. */
function Load({ h }: { h: Host }) {
  if (h.check_state !== 'online' || !h.load) return null;
  const one = Number(h.load.split(' ')[0]);
  const pct = h.cpus ? Math.min(100, Math.round((one / h.cpus) * 100)) : null;
  return (
    <div className="host-load" title={`Load averages (1, 5, 15 min): ${h.load}`}>
      <span className="muted small">Load</span>
      {pct !== null && <Progress value={pct} tone={pct >= 90 ? 'hot' : ''} />}
      <span className="mono small">
        {one.toFixed(2)}
        {h.cpus ? ` / ${h.cpus} cores` : ''}
      </span>
    </div>
  );
}

function ClaimRow({ c, showProject = true }: { c: HostClaim; showProject?: boolean }) {
  return (
    <li className="claim-row">
      <span className="status-dot dot-working" />
      <span className="claim-text">
        <a href={href('p', c.project_id, 'agents', c.agent_id)}>
          <strong>{c.agent_name}</strong>
        </a>
        {showProject && (
          <>
            {' '}
            <span className="muted">in</span> <a href={href('p', c.project_id, 'overview')}>{c.project_name}</a>
          </>
        )}
        <span className="claim-activity">{c.activity}</span>
      </span>
      <span className="mono small muted claim-time" title={`Since ${new Date(c.created_at).toLocaleString()}`}>
        {heldFor(c.created_at)}
      </span>
    </li>
  );
}

function HostCard({ h, onEdit }: { h: Host; onEdit: () => void }) {
  const { busy, error, run } = useAction();
  const busyNow = h.claims.length > 0;
  return (
    <article className={`card host-card ${busyNow ? 'host-busy' : ''}`}>
      <header className="host-head">
        <div className="row wrap">
          <h3 className="host-name">{h.name}</h3>
          {h.is_local ? <Tag tone="host-tag">This machine</Tag> : null}
          {h.exclusive ? <Tag tone="tone-accent host-tag">One at a time</Tag> : null}
          <span className="spacer" />
          <HostState h={h} />
        </div>
        {!h.is_local && <p className="mono small muted one-line">{sshCommand(h)}</p>}
        {h.purpose && <p className="host-purpose">{h.purpose}</p>}
      </header>

      <Load h={h} />

      {h.check_state === 'login' && (
        <div className="host-problem">
          <p>
            Helm reaches {h.name} but cannot log in: {h.check_error}
          </p>
          <p className="small">
            Helm uses the SSH keys and <span className="mono">~/.ssh/config</span> of the user it runs as. Test from that account with <code>{testCommand(h)}</code>
            {/host key/i.test(h.check_error) ? '. If the host key is new, run it once without BatchMode to accept the key.' : '.'}
          </p>
        </div>
      )}
      {h.check_state === 'offline' && (
        <div className="host-problem">
          <p>Unreachable: {h.check_error}</p>
        </div>
      )}

      {h.notes.trim() && (
        <details className="host-notes">
          <summary>Notes for agents</summary>
          <Markdown text={h.notes} />
        </details>
      )}

      <div className="host-now">
        <p className="host-sub">On it now</p>
        {h.claims.length ? (
          <ul className="claim-list">
            {h.claims.map((c) => (
              <ClaimRow key={c.id} c={c} />
            ))}
          </ul>
        ) : (
          <p className="muted small">Nobody. Idle.</p>
        )}
      </div>

      <footer className="host-foot">
        <span className="small host-projects">
          {h.is_local ? (
            <span className="muted">Every project</span>
          ) : h.projects.length ? (
            <>
              <span className="muted">Used by </span>
              {h.projects.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && ', '}
                  <a href={href('p', p.id, 'overview')}>{p.name}</a>
                </span>
              ))}
            </>
          ) : (
            <span className="muted">Not attached to a project</span>
          )}
        </span>
        <span className="host-actions">
          {!h.is_local && (
            <span className="muted small" title={h.checked_at ? new Date(h.checked_at).toLocaleString() : ''}>
              {h.checking ? 'checking…' : h.checked_at ? `checked ${ago(h.checked_at)}` : ''}
            </span>
          )}
          {!h.is_local && (
            <button className="btn small quiet" disabled={busy || h.checking} onClick={() => run(() => api(`/api/hosts/${h.id}/check`, { body: {} }))}>
              Check now
            </button>
          )}
          <button className="btn small" onClick={onEdit}>
            <Icon name="edit" size={14} /> Edit
          </button>
        </span>
      </footer>
      {error && <p className="error-text">{error}</p>}
    </article>
  );
}

/** Add or edit a host. With projectId, a new host is attached to that project. */
export function HostForm({ host, projects, projectId, onClose }: { host: Host | null; projects?: { id: string; name: string }[]; projectId?: string; onClose: () => void }) {
  const [name, setName] = useState(host?.name ?? '');
  const [target, setTarget] = useState(host?.ssh_target ?? '');
  const [port, setPort] = useState(host?.port ? String(host.port) : '');
  const [purpose, setPurpose] = useState(host?.purpose ?? '');
  const [notes, setNotes] = useState(host?.notes ?? '');
  const [exclusive, setExclusive] = useState(!!host?.exclusive);
  const [attached, setAttached] = useState<string[]>(host ? host.projects.map((p) => p.id) : projectId ? [projectId] : []);
  const { busy, error, run } = useAction();
  const local = !!host?.is_local;
  const toggle = (id: string) => setAttached(attached.includes(id) ? attached.filter((x) => x !== id) : [...attached, id]);

  const save = () =>
    run(async () => {
      const body = {
        name,
        purpose,
        notes,
        exclusive,
        ...(local ? {} : { ssh_target: target.trim(), port: port.trim() || null }),
      };
      let id = host?.id;
      if (id) await api(`/api/hosts/${id}`, { method: 'PATCH', body });
      else
        id = (
          await api<{ id: string }>('/api/hosts', {
            body: { ...body, projectId },
          })
        ).id;
      if (projects && !local) {
        const before = host ? host.projects.map((p) => p.id) : projectId ? [projectId] : [];
        for (const p of attached.filter((p) => !before.includes(p))) await api(`/api/projects/${p}/hosts`, { body: { hostId: id } });
        for (const p of before.filter((p) => !attached.includes(p))) await api(`/api/projects/${p}/hosts/${id}`, { method: 'DELETE' });
      }
      onClose();
    });

  const remove = () =>
    run(async () => {
      if (!host || !confirm(`Remove ${host.name} from Helm? Projects lose access to it in Helm; nothing on the machine is touched.`)) return;
      try {
        await api(`/api/hosts/${host.id}`, { method: 'DELETE' });
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 409 || !confirm(`${err.message}`)) throw err;
        await api(`/api/hosts/${host.id}?confirm=1`, { method: 'DELETE' });
      }
      onClose();
    });

  return (
    <Sheet title={host ? `Edit ${host.name}` : 'Add a host'} onClose={onClose}>
      <div className="form">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="buildbox" autoCapitalize="off" />
        </label>
        {local ? (
          <p className="muted small">This is the machine Helm and its agents run on. It is available to every project and needs no SSH.</p>
        ) : (
          <div className="row wrap host-address">
            <label className="grow">
              SSH address
              <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="user@buildbox.local or an ssh config alias" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            </label>
            <label className="host-port">
              Port
              <input value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="22" inputMode="numeric" />
            </label>
          </div>
        )}
        <label>
          What it is for <span className="muted">(one line)</span>
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Has the GPU; iPad attached on USB" maxLength={160} />
        </label>
        <label>
          Notes for agents <span className="muted">(markdown)</span>
          <textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Where repositories live, how to run the device tests, what not to touch." />
        </label>
        <label className="check">
          <input type="checkbox" checked={exclusive} onChange={(e) => setExclusive(e.target.checked)} /> One agent at a time (a single test device, a licence)
        </label>
        {projects && !local && projects.length > 0 && (
          <fieldset>
            <legend>Projects that can use it</legend>
            {projects.map((p) => (
              <label key={p.id} className="check">
                <input type="checkbox" checked={attached.includes(p.id)} onChange={() => toggle(p.id)} /> {p.name}
              </label>
            ))}
          </fieldset>
        )}
        {!local && <p className="muted small">Helm connects with the SSH keys of the account it runs as and stores no passwords.</p>}
        {error && <p className="error-text">{error}</p>}
        <div className="row wrap">
          <button className="btn primary" disabled={busy || !name.trim() || (!local && !target.trim())} onClick={save}>
            {host ? 'Save' : 'Add host'}
          </button>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <span className="spacer" />
          {host && !local && (
            <button className="btn danger quiet" disabled={busy} onClick={remove}>
              <Icon name="trash" size={15} /> Remove
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

// ---------- the Hosts page ----------

export function HostsPage() {
  const { data, error } = useLive<HostsData>('/api/hosts', (m) => m.type === 'hosts' || m.type === 'projects');
  const [editing, setEditing] = useState<Host | 'new' | null>(null);
  if (error && !data) return <Empty title="Could not load hosts">{error}</Empty>;
  if (!data) return <div className="loading">Loading…</div>;
  const remote = data.hosts.filter((h) => !h.is_local);
  const inUse = data.hosts.filter((h) => h.claims.length).length;
  const down = remote.filter((h) => h.check_state === 'offline' || h.check_state === 'login').length;

  return (
    <section className="hosts-page">
      <div className="section-head">
        <div>
          <h1 className="page-title">Hosts</h1>
          <p className="muted small">
            {data.hosts.length} {data.hosts.length === 1 ? 'machine' : 'machines'} · {inUse} in use
            {down > 0 ? ` · ${down} need attention` : ''}
          </p>
        </div>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Icon name="plus" size={16} /> Add host
        </button>
      </div>

      {remote.length === 0 && (
        <Empty title="Only this machine so far">
          Hosts are other machines your projects can use: a build box, a machine with a GPU, a phone or tablet attached for testing. Agents keep running here and work on them over SSH, claiming a host
          with a line saying what they are doing so you can see who is on which machine. Helm uses the SSH keys and <span className="mono">~/.ssh/config</span> of the account it runs as and stores no
          passwords. Before adding one, check that this works from that account: <code>ssh -o BatchMode=yes user@host true</code>
        </Empty>
      )}

      <div className="host-grid">
        {data.hosts.map((h) => (
          <HostCard key={h.id} h={h} onEdit={() => setEditing(h)} />
        ))}
      </div>

      {editing && <HostForm host={editing === 'new' ? null : editing} projects={data.projects} onClose={() => setEditing(null)} />}
    </section>
  );
}

// ---------- inside a project ----------

/** Setup section: attach and detach hosts, add a new one. */
export function ProjectHostsSetup({ s }: { s: ProjectState }) {
  const { data } = useLive<HostsData>('/api/hosts', (m) => m.type === 'hosts');
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState('');
  const { busy, error, run } = useAction();
  const attachedIds = new Set(s.hosts.map((h) => h.id));
  const available = (data?.hosts ?? []).filter((h) => !h.is_local && !attachedIds.has(h.id));
  const pid = s.project.id;

  return (
    <>
      <h2>Hosts</h2>
      <p className="muted">
        Other machines this project's agents may use over SSH. Hosts are shared across projects; manage them all on the <a href={href('hosts')}>Hosts page</a>.
      </p>
      <div className="card">
        <ul className="setup-hosts">
          {s.hosts.map((h) => (
            <li key={h.id} className="row wrap">
              <span className="grow">
                <strong>{h.name}</strong> {h.exclusive ? <Tag tone="tone-accent host-tag">One at a time</Tag> : null}
                <span className="muted small one-line">{h.is_local ? 'This machine, always available' : `${sshCommand(h)}${h.purpose ? ` · ${h.purpose}` : ''}`}</span>
              </span>
              <HostState h={h} />
              {!h.is_local && (
                <button
                  className="btn small quiet"
                  disabled={busy}
                  onClick={() =>
                    (!h.claims.some((c) => c.project_id === pid) || confirm(`Agents of this project are using ${h.name}. Detaching drops their claims.`)) &&
                    run(() =>
                      api(`/api/projects/${pid}/hosts/${h.id}`, {
                        method: 'DELETE',
                      }),
                    )
                  }
                >
                  Detach
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="row wrap setup-hosts-add">
          {available.length > 0 && (
            <>
              <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Host to attach">
                <option value="">Attach an existing host…</option>
                {available.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                    {h.purpose ? ` — ${h.purpose}` : ''}
                  </option>
                ))}
              </select>
              <button
                className="btn small"
                disabled={!pick || busy}
                onClick={async () =>
                  (await run(() =>
                    api(`/api/projects/${pid}/hosts`, {
                      body: { hostId: pick },
                    }),
                  )) && setPick('')
                }
              >
                Attach
              </button>
            </>
          )}
          <span className="spacer" />
          <button className="btn small" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> New host
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>
      {adding && <HostForm host={null} projectId={pid} onClose={() => setAdding(false)} />}
    </>
  );
}

/**
 * The host or hosts an agent is on right now: the ones it has claimed, or the
 * machine it runs on (this one) when it holds none. For agent cards, the team
 * list, the agent page and task rows.
 */
export function HostBadges({ agentId, s }: { agentId: string; s: ProjectState }) {
  const held = s.hosts.flatMap((h) => h.claims.filter((c) => c.agent_id === agentId).map((c) => ({ h, c })));
  if (!held.length) {
    const agent = s.agents.find((a) => a.id === agentId);
    const home = s.hosts.find((h) => (agent?.run_host_id ? h.id === agent.run_host_id : h.is_local));
    if (!home) return null;
    return (
      <span className="host-badges">
        <span className="host-badge" title={`Runs on ${home.name}`}>
          <Icon name="hosts" size={12} />
          <span className="host-badge-name">{home.name}</span>
        </span>
      </span>
    );
  }
  return (
    <span className="host-badges">
      {held.map(({ h, c }) => (
        <span key={c.id} className="host-badge held" title={`On ${h.name}: ${c.activity}`}>
          <Icon name="hosts" size={12} />
          <span className="host-badge-name">{h.name}</span>
        </span>
      ))}
    </span>
  );
}
