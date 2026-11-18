import { useEffect, useRef, useState } from 'react';
import { api, useStream } from './api';
import { Icon, Tag, ago, href, useAction } from './ui';
import { NotificationsSetup } from './notify';
import { DiskSummary } from './disk';

// Helm's own version and live update (server/liveupdate.ts, nix/live-update.sh): the "Helm <rev>" footer with its
// "Update available" marker, the Helm page with Update now / Roll back, and surviving the restart an update causes.

type Commit = { rev: string; shortRev: string; date: number; subject: string };
export type UpdateStatus = {
  id: string;
  kind: 'update' | 'rollback';
  stage: string;
  message: string;
  log: string;
  fromRev: string;
  toRev: string;
  startedAt: number;
  updatedAt: number;
};
export type VersionInfo = {
  running: { rev: string; shortRev: string; lastModified: number };
  liveUpdate: { ref: string; repo: string } | null;
  available: Commit | null;
  commits: Commit[] | null;
  behind: number;
  error: string | null;
  status: UpdateStatus | null;
  busy: boolean;
  previous: string | null;
  working: { agents: number; projects: number };
};

const short = (rev: string) => (/^[0-9a-f]{12,}/.test(rev) ? rev.slice(0, 7) : rev);
const WATCH = 'helm-update-watch';

/** An update is worth offering: the release ref holds something the running build does not. */
export function updateAvailable(v: VersionInfo | null): boolean {
  if (!v?.liveUpdate || !v.available) return false;
  if (v.commits) return v.commits.length > 0 || v.behind > 0;
  return short(v.available.rev) !== short(v.running.rev.replace(/-dirty$/, ''));
}

export type VersionState = { info: VersionInfo | null; restarting: boolean; reload: () => Promise<void> };

/**
 * The version, refreshed every minute, and every 1.5 s while an update runs. When the server stops answering in the
 * middle of an update it is restarting: show that, wait until it answers again, then reload the page (the web app
 * itself may have changed) so the result is shown by the new version.
 */
export function useVersion(): VersionState {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [restarting, setRestarting] = useState(false);
  const busyRef = useRef(false);
  const restartingRef = useRef(false);
  const stageRef = useRef('');
  const revRef = useRef('');

  const load = async () => {
    try {
      const v = await api<VersionInfo>('/api/version');
      // Back from a restart, or a different server answering than the one this page came from (the gap was too
      // short to notice): load the page again from the server that is running now.
      if (restartingRef.current || (revRef.current && revRef.current !== v.running.rev)) {
        location.reload();
        return;
      }
      revRef.current = v.running.rev;
      setInfo(v);
      busyRef.current = v.busy;
      stageRef.current = v.status?.stage ?? '';
    } catch {
      // Unreachable while an update runs: the restart has begun.
      if (busyRef.current && !restartingRef.current) {
        restartingRef.current = true;
        setRestarting(true);
      }
    }
  };

  useEffect(() => {
    void load();
    // A short tick that decides each time whether a check is due, so pressing Update (which sets busy) speeds the
    // polling up at once instead of after the idle interval.
    let last = Date.now();
    let checking = false;
    const t = window.setInterval(async () => {
      // The restart itself can be over in a second or two: look closely while it happens.
      const every = restartingRef.current || stageRef.current === 'restarting' ? 500 : busyRef.current ? 1500 : 60_000;
      if (checking || Date.now() - last < every) return;
      checking = true;
      last = Date.now();
      try {
        if (restartingRef.current) {
          // /api/health needs no sign-in, so it answers as soon as the new server listens.
          const up = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
          if (up) location.reload();
        } else await load();
      } finally {
        checking = false;
      }
    }, 250);
    return () => clearInterval(t);
  }, []);
  useStream((m) => m.type === 'reconnect' && void load());

  return { info, restarting, reload: load };
}

/** "Helm 1a2b3c4" with an "Update available" marker, for the sidebar foot and the project list. */
export function VersionFooter({ v, className = '' }: { v: VersionState; className?: string }) {
  const info = v.info;
  if (!info) return null;
  const available = updateAvailable(info);
  return (
    <a className={`version-foot ${className}`} href={href('helm')}>
      <span className="mono">Helm {short(info.running.shortRev)}</span>
      {info.busy ? <Tag tone="tone-accent">Updating…</Tag> : available ? <Tag tone="tone-accent">Update available</Tag> : null}
    </a>
  );
}

/** While the server restarts, and once after an update this browser started, on every page. */
export function UpdateBanner({ v }: { v: VersionState }) {
  const [watching, setWatching] = useState(() => sessionStorage.getItem(WATCH));
  if (v.restarting) {
    return (
      <div className="update-banner" role="status">
        <span className="spinner" aria-hidden="true" />
        <span>
          <strong>Restarting Helm…</strong>
          <span className="muted small">This page reloads by itself when the new version answers.</span>
        </span>
      </div>
    );
  }
  const s = v.info?.status;
  if (!s || !watching || s.id !== watching || v.info?.busy || location.hash === href('helm')) return null;
  const ok = s.stage === 'healthy' || s.stage === 'unchanged';
  return (
    <div className={`update-banner ${ok ? 'ok' : 'bad'}`} role="status">
      <Icon name={ok ? 'check' : 'close'} />
      <span>
        <strong>{resultTitle(s)}</strong>
        <span className="muted small">{s.message}</span>
      </span>
      <a className="btn small quiet" href={href('helm')}>
        Details
      </a>
      <button
        className="icon-btn"
        aria-label="Dismiss"
        onClick={() => {
          sessionStorage.removeItem(WATCH);
          setWatching(null);
        }}
      >
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}

function resultTitle(s: UpdateStatus): string {
  if (s.stage === 'healthy') return s.kind === 'rollback' ? `Rolled back to ${short(s.toRev)}` : `Updated to ${short(s.toRev)}`;
  if (s.stage === 'unchanged') return 'Already up to date';
  if (s.stage === 'rolled-back') return `Update to ${short(s.toRev)} rolled back`;
  if (s.stage === 'failed') return s.kind === 'rollback' ? 'Rollback failed' : 'Update failed';
  return s.message;
}

const STEPS: Record<'update' | 'rollback', [string, string][]> = {
  update: [
    ['requested', 'Requested'],
    ['building', 'Building'],
    ['built', 'Built'],
    ['restarting', 'Restarting'],
    ['checking', 'Health check'],
    ['healthy', 'Running'],
  ],
  rollback: [
    ['requested', 'Requested'],
    ['restarting', 'Restarting'],
    ['checking', 'Health check'],
    ['healthy', 'Running'],
  ],
};

function Stages({ s }: { s: UpdateStatus }) {
  const steps = STEPS[s.kind] ?? STEPS.update;
  const failedAt = s.stage === 'failed' ? (s.toRev ? 'restarting' : s.kind === 'update' ? 'building' : 'requested') : s.stage === 'rolled-back' || s.stage === 'rolling-back' ? 'checking' : null;
  const at = steps.findIndex(([id]) => id === (failedAt ?? (s.stage === 'unchanged' ? 'built' : s.stage)));
  return (
    <ol className="stages">
      {steps.map(([id, label], i) => {
        const state = failedAt && i === at ? 'bad' : i < at || (i === at && (s.stage === 'healthy' || s.stage === 'unchanged')) ? 'done' : i === at ? 'now' : '';
        return (
          <li key={id} className={state}>
            <span className="stage-mark" aria-hidden="true">
              {state === 'done' ? <Icon name="check" size={13} /> : state === 'bad' ? <Icon name="close" size={13} /> : null}
            </span>
            {label}
          </li>
        );
      })}
    </ol>
  );
}

export function HelmPage({ v }: { v: VersionState }) {
  const info = v.info;
  const [confirm, setConfirm] = useState<'update' | 'rollback' | null>(null);
  const { busy, error, run } = useAction();
  if (!info) return <div className="loading">Loading…</div>;
  const s = info.status;
  const available = updateAvailable(info);
  const start = (kind: 'update' | 'rollback') =>
    run(async () => {
      const next = await api<VersionInfo>(`/api/version/${kind}`, { method: 'POST' });
      sessionStorage.setItem(WATCH, next.status?.id ?? '');
      setConfirm(null);
      await v.reload();
    });

  return (
    <section className="narrow helm-page">
      <h1 className="page-title">Helm</h1>

      <div className="card version-card">
        <div className="kv">
          <span className="muted small">Running</span>
          <span>
            <b className="mono">{short(info.running.shortRev)}</b>
            {info.running.lastModified > 0 && <span className="muted small"> · committed {ago(info.running.lastModified * 1000)}</span>}
          </span>
        </div>
        {info.liveUpdate && info.available && (
          <div className="kv">
            <span className="muted small">
              Available on <span className="mono">{info.liveUpdate.ref}</span>
            </span>
            <span>
              <b className="mono">{info.available.shortRev}</b>
              <span className="muted small"> · committed {ago(info.available.date * 1000)}</span>
            </span>
          </div>
        )}
        {info.previous && (
          <div className="kv">
            <span className="muted small">Previous</span>
            <span className="mono">{short(info.previous)}</span>
          </div>
        )}
      </div>

      {!info.liveUpdate && (
        <p className="muted">
          Live update is off on this server. Updating Helm means rebuilding the system; turn on <span className="mono">services.helm.liveUpdate</span> to update from here.
        </p>
      )}
      {info.error && <p className="error-text">{info.error}</p>}

      {s && (s.stage !== 'requested' || info.busy) && (
        <div className={`card update-progress ${info.busy ? 'live' : s.stage === 'healthy' || s.stage === 'unchanged' ? 'ok' : 'bad'}`}>
          <div className="row wrap">
            <strong>{info.busy ? (s.kind === 'rollback' ? 'Rolling back' : 'Updating') : resultTitle(s)}</strong>
            <span className="spacer" />
            <span className="muted small">{ago(s.updatedAt)}</span>
          </div>
          <Stages s={s} />
          <p className="small">{s.message}</p>
          {s.log && (
            <details>
              <summary className="small">Log</summary>
              <pre>{s.log}</pre>
            </details>
          )}
        </div>
      )}

      {info.liveUpdate && (
        <>
          <h2>{available ? 'What the update brings' : 'Up to date'}</h2>
          {info.behind > 0 && (
            <p className="small">
              The running build has {info.behind} {info.behind === 1 ? 'commit' : 'commits'} that <span className="mono">{info.liveUpdate.ref}</span> no longer has (the branch was moved back). Updating switches to what the branch holds now.
            </p>
          )}
          {info.commits && info.commits.length > 0 && (
            <ul className="commit-list card">
              {info.commits.map((c) => (
                <li key={c.rev}>
                  <span className="mono small muted">{c.shortRev}</span>
                  <span>{c.subject}</span>
                </li>
              ))}
            </ul>
          )}
          {!info.commits && available && <p className="muted small">The running build's revision is not in the repository, so the commits in between cannot be listed.</p>}
          {!available && !info.busy && <p className="muted small">The running build is what {info.liveUpdate.ref} holds.</p>}

          {confirm ? (
            <div className="card confirm-update">
              <strong>{confirm === 'update' ? 'Update and restart Helm?' : `Roll back to ${short(info.previous ?? '')}?`}</strong>
              <p className="small">
                Helm restarts, which interrupts every running agent in every project
                {info.working.agents > 0 ? (
                  <>
                    : <b>
                      {info.working.agents} {info.working.agents === 1 ? 'agent is' : 'agents are'} working now
                    </b>{' '}
                    in {info.working.projects} {info.working.projects === 1 ? 'project' : 'projects'}. They are resumed automatically once the new version is up, but
                    builds, test servers and other commands they had running are lost.
                  </>
                ) : (
                  <>. No agent is working right now.</>
                )}{' '}
                {confirm === 'update' && 'If the new version does not come up healthy within a minute, Helm switches back by itself.'}
              </p>
              <div className="row wrap">
                <button className="btn primary" disabled={busy} onClick={() => start(confirm)}>
                  {confirm === 'update' ? 'Update and restart' : 'Roll back and restart'}
                </button>
                <button className="btn quiet" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="row wrap update-actions">
              <button className="btn primary" disabled={info.busy || !available} onClick={() => setConfirm('update')}>
                Update now
              </button>
              {info.previous && (
                <button className="btn" disabled={info.busy} onClick={() => setConfirm('rollback')}>
                  Roll back to {short(info.previous)}
                </button>
              )}
            </div>
          )}
          {error && <p className="error-text">{error}</p>}
        </>
      )}

      <h2>Disk</h2>
      <DiskSummary />

      <NotificationsSetup />
    </section>
  );
}
