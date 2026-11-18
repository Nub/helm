import { useEffect, useState } from 'react';
import { api, useLive } from './api';
import { Icon, Tag, ago, href, useAction, useTick } from './ui';

// Disk guard (server/disk.ts): the banner every page shows when the disk is full or getting there.

export type DiskLevel = 'ok' | 'warning' | 'critical';
export type Filesystem = { dev: number; holds: { label: string; path: string }[]; size: number; free: number; level: DiskLevel; warning: number; critical: number };
export type DiskSettings = { warnPercent: number; warnGB: number; criticalPercent: number; criticalGB: number };
export type DiskStatus = {
  level: DiskLevel;
  full: { at: number; what: string; message: string } | null;
  sampledAt: number;
  filesystems: Filesystem[];
  settings: DiskSettings;
  blocked: boolean;
};

const GB = 1e9;
export const bytes = (n: number) => (n >= 100 * GB ? `${Math.round(n / GB)} GB` : n >= GB ? `${(n / GB).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} kB`);

export function useDiskStatus() {
  const s = useLive<DiskStatus>('/api/disk/status', (m) => m.type === 'disk');
  // Also every minute: a full disk may keep the server from telling browsers anything.
  useEffect(() => {
    const t = window.setInterval(() => void s.reload(), 60_000);
    return () => clearInterval(t);
  }, []);
  return s;
}

/** The filesystem worst off. */
export function worstFs(s: DiskStatus): Filesystem | undefined {
  const rank = { ok: 0, warning: 1, critical: 2 };
  return [...s.filesystems].sort((a, b) => rank[b.level] - rank[a.level] || a.free - b.free)[0];
}

export function DiskBanner({ s }: { s: DiskStatus | null }) {
  if (!s || (s.level === 'ok' && !s.full) || location.hash === href('helm', 'disk')) return null;
  const f = worstFs(s);
  const where = f ? `${bytes(f.free)} free on the disk with ${f.holds.map((h) => h.label).slice(0, 3).join(', ')}${f.holds.length > 3 ? '…' : ''}.` : '';
  const title = s.full ? 'The disk is full' : s.level === 'critical' ? 'The disk is nearly full' : 'Disk space is running low';
  const body = s.full
    ? 'Helm could not save its work. Free some space; it carries on by itself once it can write again.'
    : s.level === 'critical'
      ? `${where} New agents and updates wait until space is freed.`
      : where;
  return (
    <div className={`update-banner disk-banner ${s.full || s.level === 'critical' ? 'bad' : 'warn'}`} role="alert">
      <Icon name="alert" />
      <span>
        <strong>{title}</strong>
        {body && <span className="muted small">{body}</span>}
      </span>
      <a className="btn small quiet" href={href('helm', 'disk')}>
        Details
      </a>
    </div>
  );
}

// ---------- the Disk page (#/helm/disk) ----------

export type UsageEntry = {
  path: string;
  label: string;
  kind: 'project' | 'worktree' | 'artifact' | 'install' | 'tmp';
  bytes: number | null;
  computedAt: number | null;
  measuring: boolean;
  error?: string;
  branch?: string | null;
  merged?: boolean | null;
  clean?: boolean | null;
  artifactKind?: string;
  disposable?: boolean;
  note?: string;
  agent?: string | null;
  stray?: boolean;
  mtime?: number;
};
type ProjectUsage = { id: string; name: string; path: string; total: number; entries: UsageEntry[] };
type Usage = { projects: ProjectUsage[]; install: UsageEntry[]; tmp: UsageEntry[]; tmpTotal: number; generations: { system: number; live: number }; measuring: number };

const LEVEL_TAG: Record<DiskLevel, [string, string]> = { ok: ['', 'OK'], warning: ['tone-warning', 'Low'], critical: ['tone-critical', 'Critical'] };

function FsCard({ f }: { f: Filesystem }) {
  const used = f.size ? Math.min(100, Math.max(0, ((f.size - f.free) / f.size) * 100)) : 0;
  const mark = (b: number) => `${Math.min(100, Math.max(0, ((f.size - b) / f.size) * 100))}%`;
  return (
    <div className={`card disk-fs ${f.level}`}>
      <div className="row wrap">
        <strong>{bytes(f.free)} free</strong>
        <span className="muted small">of {bytes(f.size)}</span>
        <span className="spacer" />
        {f.level !== 'ok' && <Tag tone={LEVEL_TAG[f.level][0]}>{LEVEL_TAG[f.level][1]}</Tag>}
      </div>
      <div className="disk-meter" role="meter" aria-valuenow={Math.round(used)} aria-valuemin={0} aria-valuemax={100} aria-label={`${Math.round(used)}% used`}>
        <div className="disk-meter-fill" style={{ width: `${used}%` }} />
        <span className="disk-mark warn" style={{ left: mark(f.warning) }} title={`Warning below ${bytes(f.warning)} free`} />
        <span className="disk-mark crit" style={{ left: mark(f.critical) }} title={`Critical below ${bytes(f.critical)} free`} />
      </div>
      <p className="muted small disk-holds">
        Holds {f.holds.map((h) => h.label).join(', ')}. Warning below {bytes(f.warning)} free, critical below {bytes(f.critical)}.
      </p>
    </div>
  );
}

function measured(e: UsageEntry): string {
  if (e.bytes === null) return e.measuring ? 'measuring…' : e.error ? 'unknown' : 'not measured';
  return bytes(e.bytes);
}

function EntryRow({ e }: { e: UsageEntry }) {
  const tags: [string, string][] = [];
  if (e.kind === 'worktree') {
    if (e.stray) tags.push(['tone-warning', 'not a git worktree']);
    else {
      if (e.clean === false) tags.push(['tone-serious', 'uncommitted']);
      if (e.merged === false) tags.push(['', 'not merged']);
      if (e.merged && e.clean) tags.push(['st-done', 'merged, clean']);
    }
  }
  if (e.artifactKind) tags.push([e.disposable ? 'st-done' : '', `${e.artifactKind}${e.disposable ? ', disposable' : ''}`]);
  return (
    <li className="disk-row">
      <div className="disk-row-head">
        <span className="one-line">{e.label}</span>
        <b className="mono small">{measured(e)}</b>
      </div>
      <div className="disk-row-sub">
        <span className="mono small muted one-line" title={e.path}>
          {e.path}
        </span>
      </div>
      {(tags.length > 0 || e.agent || e.note || e.computedAt) && (
        <div className="disk-row-tags">
          {tags.map(([tone, t]) => (
            <Tag key={t} tone={tone}>
              {t}
            </Tag>
          ))}
          {e.agent && <span className="muted small">by {e.agent}</span>}
          {e.note && <span className="muted small one-line">{e.note}</span>}
          <span className="spacer" />
          {e.computedAt && e.kind !== 'tmp' && <span className="muted small">{e.measuring ? 'measuring again' : ago(e.computedAt)}</span>}
          {e.kind === 'tmp' && e.mtime && <span className="muted small">changed {ago(e.mtime)}</span>}
        </div>
      )}
    </li>
  );
}

const bySize = (a: UsageEntry, b: UsageEntry) => (b.bytes ?? -1) - (a.bytes ?? -1);

function Settings({ s, onSaved }: { s: DiskSettings; onSaved: () => void }) {
  const [v, setV] = useState(s);
  const { busy, error, run } = useAction();
  useEffect(() => setV(s), [s.warnGB, s.warnPercent, s.criticalGB, s.criticalPercent]);
  const changed = JSON.stringify(v) !== JSON.stringify(s);
  const field = (k: keyof DiskSettings, unit: string) => (
    <label className="disk-field">
      <input type="number" inputMode="decimal" min={0} step="any" value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />
      <span className="muted small">{unit}</span>
    </label>
  );
  return (
    <div className="card disk-settings">
      <p className="small">
        A disk is at a level when its free space is below <b>the smaller</b> of the percentage and the size: on a big disk the size decides, on a small one the percentage.
      </p>
      <div className="disk-settings-row">
        <span>Warning below</span>
        {field('warnPercent', '%')}
        <span className="muted small">or</span>
        {field('warnGB', 'GB')}
      </div>
      <p className="muted small">Files one to-do for you naming what takes the space.</p>
      <div className="disk-settings-row">
        <span>Critical below</span>
        {field('criticalPercent', '%')}
        <span className="muted small">or</span>
        {field('criticalGB', 'GB')}
      </div>
      <p className="muted small">Helm stops starting agents and updates, tells the directors to stop builds and clean up, and notifies you. It lifts by itself when space returns.</p>
      <div className="row wrap">
        <button className="btn primary" disabled={!changed || busy} onClick={() => run(async () => (await api('/api/disk/settings', { method: 'PUT', body: v }), onSaved()))}>
          Save
        </button>
        {changed && (
          <button className="btn quiet" onClick={() => setV(s)}>
            Cancel
          </button>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

export function DiskPage() {
  const d = useLive<{ status: DiskStatus; usage: Usage }>('/api/disk', (m) => m.type === 'disk');
  const { busy, run } = useAction();
  useTick();
  if (!d.data) return d.error ? <p className="error-text">{d.error}</p> : <div className="loading">Loading…</div>;
  const { status: s, usage: u } = d.data;
  const projects = [...u.projects].sort((a, b) => b.total - a.total);
  const tmpTop = u.tmp.filter((e) => e.bytes !== null).slice(0, 8);
  return (
    <section className="narrow disk-page">
      <div className="section-head">
        <h1 className="page-title">Disk</h1>
        <button className="btn small" disabled={busy} onClick={() => run(async () => (await api('/api/disk/refresh', { method: 'POST' }), d.reload()))}>
          Measure again
        </button>
      </div>
      {s.full && (
        <div className="update-banner bad" role="alert">
          <Icon name="alert" />
          <span>
            <strong>The disk is full</strong>
            <span className="muted small">
              {s.full.what}: {s.full.message}
            </span>
          </span>
        </div>
      )}
      {s.blocked && !s.full && (
        <div className="update-banner bad" role="alert">
          <Icon name="alert" />
          <span>
            <strong>New agents and updates are on hold</strong>
            <span className="muted small">Free space is below the critical level. Directors were told to stop builds and clean up; this lifts by itself when space returns.</span>
          </span>
        </div>
      )}
      {s.filesystems.map((f) => (
        <FsCard key={f.dev} f={f} />
      ))}
      {u.measuring > 0 && <p className="muted small">Measuring {u.measuring} {u.measuring === 1 ? 'folder' : 'folders'} in the background…</p>}

      <h2>Projects</h2>
      {projects.map((p) => (
        <div key={p.id} className="card disk-project">
          <div className="row">
            <a className="one-line" href={href('p', p.id, 'overview')}>
              <strong>{p.name}</strong>
            </a>
            <span className="spacer" />
            <b className="mono">{bytes(p.total)}</b>
          </div>
          <ul className="disk-rows">
            {[...p.entries].sort(bySize).map((e) => (
              <EntryRow key={e.path} e={e} />
            ))}
          </ul>
        </div>
      ))}

      <h2>Shared</h2>
      <div className="card">
        <ul className="disk-rows">
          {u.install.map((e) => (
            <EntryRow key={e.path} e={e} />
          ))}
        </ul>
      </div>
      <h2>Temporary files</h2>
      <p className="muted small">
        {bytes(u.tmpTotal)} in {u.tmp.length} {u.tmp.length === 1 ? 'entry' : 'entries'} owned by Helm's user. The largest:
      </p>
      <div className="card">
        <ul className="disk-rows">
          {tmpTop.map((e) => (
            <EntryRow key={e.path} e={e} />
          ))}
        </ul>
      </div>

      <h2>Levels</h2>
      <Settings s={s.settings} onSaved={() => void d.reload()} />
    </section>
  );
}

/** The Disk line on the Helm page. */
export function DiskSummary() {
  const s = useDiskStatus().data;
  if (!s) return null;
  const f = worstFs(s);
  return (
    <a className="card disk-summary" href={href('helm', 'disk')}>
      <Icon name="disk" />
      <span>
        <strong>Disk</strong>
        <span className="muted small">{f ? `${bytes(f.free)} free of ${bytes(f.size)}` : 'Not measured yet'}</span>
      </span>
      {s.level !== 'ok' && <Tag tone={LEVEL_TAG[s.level][0]}>{LEVEL_TAG[s.level][1]}</Tag>}
      <Icon name="chevron" />
    </a>
  );
}
