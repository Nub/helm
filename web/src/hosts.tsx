import { useEffect, useState } from 'react';
import { ApiError, api, useLive } from './api';
import type { Host, HostClaim, HostUsed, HostWorkspace, ProjectState } from './api';
import { Clamp, Empty, Icon, Progress, Sheet, Tag, href, useAction, PageHeader } from './ui';
import { Menu } from './tasks';
import { fullDateTime } from './time';

type HostsData = { hosts: Host[]; projects: { id: string; name: string }[]; workspaces?: HostWorkspace[] };

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

/** "16.8 of 32 GB". */
const gb = (n: number) => (n >= 100e9 ? Math.round(n / 1e9).toString() : (n / 1e9).toFixed(1).replace(/\.0$/, ''));
const usedText = (u: HostUsed | null) => (u ? `${gb(u.used)} of ${gb(u.total)} GB` : '—');
const usedPct = (u: HostUsed | null) => (u && u.total > 0 ? Math.round((u.used / u.total) * 100) : null);

/** One thin meter: label, bar, value on the right; amber from 85 %, red from 95 %. */
function Meter({ label, pct, text, title }: { label: string; pct: number | null; text: string; title?: string }) {
  const tone = pct == null ? '' : pct >= 95 ? 'crit' : pct >= 85 ? 'warn' : '';
  return (
    <div className={`host-meter ${tone}`} title={title}>
      <span className="muted small host-meter-l">{label}</span>
      <span className="host-meter-bar">
        <span style={{ width: `${pct ?? 0}%` }} />
      </span>
      <span className="mono small host-meter-v">{text}</span>
    </div>
  );
}

/** CPU, RAM, each GPU and its VRAM, and the disk of the Helm root, from the last sample (server/hoststats.ts). */
function Meters({ h }: { h: Host }) {
  if (h.check_state !== 'online') return null;
  const s = h.stats;
  const one = h.load ? h.load.split(' ')[0] : '';
  return (
    <div className="host-meters">
      <Meter label="CPU" pct={s?.cpu ?? null} text={s?.cpu != null ? `${s.cpu}%${one ? ` · load ${one}` : ''}` : one ? `load ${one}` : '—'} title={h.load ? `Load averages (1, 5, 15 min): ${h.load}${h.cpus ? ` on ${h.cpus} cores` : ''}` : undefined} />
      <Meter label="RAM" pct={usedPct(s?.mem ?? null)} text={usedText(s?.mem ?? null)} />
      {(s?.gpus ?? []).map((g, i) => (
        <div key={i} className="host-meter-pair">
          <Meter label={(s?.gpus.length ?? 0) > 1 ? `GPU ${i + 1}` : 'GPU'} pct={g.util} text={g.util != null ? `${g.util}%` : '—'} />
          <Meter label="VRAM" pct={usedPct(g.mem)} text={usedText(g.mem)} />
        </div>
      ))}
      <Meter label="Disk" pct={usedPct(s?.disk ?? null)} text={usedText(s?.disk ?? null)} title="The volume of the Helm work root (or home)" />
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
      <span className="mono small muted claim-time" title={`Since ${fullDateTime(c.created_at)}`}>
        {heldFor(c.created_at)}
      </span>
    </li>
  );
}

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.round(b / 1e3)} kB`);

/** A host's kept job workspaces and build slots (server/hostwork.ts): size and age, with Remove (only ever inside Helm's root there). */
function Workspaces({ list }: { list: HostWorkspace[] }) {
  const { busy, error, run } = useAction();
  if (!list.length) return null;
  return (
    <>
      <ul className="host-workspaces">
        {list.map((w) => (
          <li key={w.id} className="row">
            <span className="grow">
              <span className="one-line mono small">{w.slot ? 'Build slot' : w.name}</span>
              <span className="muted small one-line">
                {w.project ?? 'project'} · {w.state === 'active' ? 'in use' : w.slot ? 'kept' : w.state === 'failed' ? 'failed, kept a day' : w.state} · {heldFor(w.ended_at ?? w.created_at)}
                {w.bytes != null ? ` · ${size(w.bytes)}` : ''}
              </span>
            </span>
            <button
              className="btn small quiet"
              disabled={busy || (!!w.slot && w.state === 'active')}
              onClick={() => confirm(w.slot ? `Remove the build slot of ${w.project ?? 'this project'}? Its kept build output goes; the next job builds from scratch.` : `Remove the workspace ${w.name}? Its files on the host go.`) && run(() => api(`/api/host-workspaces/${w.id}`, { method: 'DELETE' }))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error-text small">{error}</p>}
    </>
  );
}

function HostCard({ h, onEdit, workspaces = [] }: { h: Host; onEdit: () => void; workspaces?: HostWorkspace[] }) {
  const { error, run } = useAction();
  const busyNow = h.claims.length > 0;
  return (
    <article className={`card host-card ${busyNow ? 'host-busy' : ''}`}>
      <header className="host-head">
        <div className="row host-head-row">
          <div className="row wrap grow">
            <h3 className="host-name">{h.name}</h3>
            {h.is_local ? <Tag tone="plain">This machine</Tag> : null}
            {h.exclusive ? <Tag tone="tone-accent plain">One at a time</Tag> : null}
          </div>
          <HostState h={h} />
          <Menu
            label={`More actions for ${h.name}`}
            items={[{ label: 'Edit', onSelect: onEdit }, !h.is_local && !h.checking && { label: 'Check now', onSelect: () => void run(() => api(`/api/hosts/${h.id}/check`, { body: {} })) }]}
          />
        </div>
        {h.purpose && <p className="host-purpose muted small one-line" title={h.purpose}>{h.purpose}</p>}
        {h.notes && <Clamp text={h.notes} lines={1} />}
      </header>

      <Meters h={h} />

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

      {h.claims.length > 0 && (
        <ul className="claim-list">
          {h.claims.map((c) => (
            <ClaimRow key={c.id} c={c} />
          ))}
        </ul>
      )}
      <Workspaces list={workspaces} />
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
  const [workRoot, setWorkRoot] = useState(host?.work_root ?? '~/.helm-work');
  const [workEnv, setWorkEnv] = useState(host?.work_env ?? '');
  const [workSetup, setWorkSetup] = useState(host?.work_setup ?? '');
  const [workCaches, setWorkCaches] = useState(host?.work_caches ?? '');
  const [workKeep, setWorkKeep] = useState(host?.work_keep ?? '');
  const [platform, setPlatform] = useState(host?.platform ?? 'linux');
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
        work_root: workRoot,
        work_env: workEnv,
        work_setup: workSetup,
        work_caches: workCaches,
        work_keep: workKeep,
        ...(local ? {} : { ssh_target: target.trim(), port: port.trim() || null, platform }),
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
            <label className="host-platform">
              System
              <select value={platform} onChange={(e) => setPlatform(e.target.value as typeof platform)}>
                <option value="linux">Linux</option>
                <option value="macos">macOS</option>
                <option value="windows">Windows</option>
              </select>
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
        <fieldset>
          <legend>Clean workspaces</legend>
          <p className="muted small">Each job gets a fresh folder under this root, with the project's code and no login profile: only what is set here reaches it.</p>
          <label>
            Root on the host
            <input className="mono" value={workRoot} onChange={(e) => setWorkRoot(e.target.value)} placeholder="~/.helm-work" autoCapitalize="off" spellCheck={false} />
          </label>
          <label>
            Add to PATH <span className="muted">(one folder per line)</span>
            <textarea className="mono" rows={2} value={workEnv} onChange={(e) => setWorkEnv(e.target.value)} placeholder="~/.cargo/bin" spellCheck={false} />
          </label>
          <label>
            Setup line <span className="muted">(run before each command)</span>
            <input className="mono" value={workSetup} onChange={(e) => setWorkSetup(e.target.value)} placeholder="source /opt/toolchain/env.sh" spellCheck={false} />
          </label>
          <label>
            Shared caches <span className="muted">(variables, one per line)</span>
            <textarea className="mono" rows={2} value={workCaches} onChange={(e) => setWorkCaches(e.target.value)} placeholder="CARGO_HOME" spellCheck={false} />
          </label>
          <label>
            Build folders kept between jobs <span className="muted">(one per line; each project gets one reused folder)</span>
            <textarea className="mono" rows={2} value={workKeep} onChange={(e) => setWorkKeep(e.target.value)} placeholder="CARGO_TARGET_DIR=target" spellCheck={false} />
          </label>
        </fieldset>
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
              <Icon name="trash" size={16} /> Remove
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
  // Live meters while this page is open and visible: a sample about every 15 s (server/hosts.ts sampleForPage). Nothing
  // samples for it on the server, so closing or hiding the page stops it.
  useEffect(() => {
    const tick = () => document.visibilityState === 'visible' && void api('/api/hosts/sample', { body: {} }).catch(() => {});
    tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, []);
  const [editing, setEditing] = useState<Host | 'new' | null>(null);
  if (error && !data) return <Empty title="Could not load hosts">{error}</Empty>;
  if (!data) return <div className="loading">Loading…</div>;
  const remote = data.hosts.filter((h) => !h.is_local);

  return (
    <section className="hosts-page">
      <PageHeader title="Hosts">
        <button className="btn small" onClick={() => setEditing('new')}>
          <Icon name="plus" size={16} /> Add host
        </button>
      </PageHeader>

      {remote.length === 0 && (
        <Empty title="Only this machine so far" />
      )}

      <div className="host-grid">
        {data.hosts.map((h) => (
          <HostCard key={h.id} h={h} onEdit={() => setEditing(h)} workspaces={(data.workspaces ?? []).filter((w) => w.host_id === h.id)} />
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
      <p className="small">
        <a href={href('system', 'hosts')}>All hosts</a>
      </p>
      <div className="card">
        <ul className="setup-hosts">
          {s.hosts.map((h) => (
            <li key={h.id} className="row wrap">
              <span className="grow">
                <strong>{h.name}</strong> {h.exclusive ? <Tag tone="tone-accent plain">One at a time</Tag> : null}
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
            <Icon name="plus" size={16} /> New host
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
        <span className="tag plain host-claim" title={`Runs on ${home.name}`}>
          <Icon name="hosts" size={16} />
          <span className="host-claim-name">{home.name}</span>
        </span>
      </span>
    );
  }
  return (
    <span className="host-badges">
      {held.map(({ h, c }) => (
        <span key={c.id} className="tag plain tone-blue host-claim" title={`On ${h.name}: ${c.activity}`}>
          <Icon name="hosts" size={16} />
          <span className="host-claim-name">{h.name}</span>
        </span>
      ))}
    </span>
  );
}
