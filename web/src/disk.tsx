import { useEffect, useState } from 'react';
import { api, useLive } from './api';
import { Icon, Sheet, Tag, href, useAction, useTick, PageHeader } from './ui';
import { dateTime } from './time';

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
  if (!s || (s.level === 'ok' && !s.full) || location.hash.startsWith(href('system'))) return null;
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
      <a className="btn small quiet" href={href('system', 'disk')}>
        Details
      </a>
    </div>
  );
}

// ---------- the Disk section of System (#/system/disk) ----------

export type UsageEntry = {
  path: string;
  label: string;
  kind: 'project' | 'worktree' | 'artifact' | 'install' | 'tmp' | 'dashboards' | 'release';
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
  /** A release's files (kind release): removable from the Disk page, the release's record kept. */
  releaseId?: string;
  testBuildId?: string;
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
    </div>
  );
}

function measured(e: UsageEntry): string {
  if (e.bytes === null) return e.measuring ? 'measuring…' : e.error ? 'unknown' : 'not measured';
  return bytes(e.bytes);
}

function EntryRow({ e, onChanged }: { e: UsageEntry; onChanged?: () => void }) {
  const { busy, run } = useAction();
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
        {e.testBuildId && onChanged && (
          <button className="btn small quiet" disabled={busy} onClick={() => confirm(`Delete the ${e.label}? Its record stays, with Rebuild.`) && run(async () => (await api(`/api/test-builds/${e.testBuildId}/files`, { method: 'DELETE' }), onChanged()))}>
            Delete
          </button>
        )}
        {e.releaseId && onChanged && (
          <button className="btn small quiet" disabled={busy} onClick={() => confirm(`Remove the files of ${e.label.replace(/ files$/, "")}? Its change log and record stay.`) && run(async () => (await api(`/api/releases/${e.releaseId}/files`, { method: 'DELETE' }), onChanged()))}>
            Remove
          </button>
        )}
      </div>
      {/* One line: what state it is in and who made it. */}
      {(tags.length > 0 || e.agent) && <p className={`small one-line ${tags.some(([t]) => t === 'tone-serious' || t === 'tone-warning') ? 'err-text' : 'muted'}`}>{[...tags.map(([, t]) => t), e.agent && `by ${e.agent}`].filter(Boolean).join(' · ')}</p>}
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

type CleanItem = { path: string; what: string; bytes: number | null; kind: 'folder' | 'testbuild'; build?: string };
type CleanPlan = { remove: CleanItem[]; skipped: { path: string; reason: string }[]; total: number };

/**
 * A project's Clean up (server/diskclean.ts): the button opens what would go, by clean_artifacts' rules (disposable
 * build and scratch folders, merged clean worktrees, test-build files past their keep time) with sizes and the total,
 * and what stays with why; Remove takes exactly those. The result replaces the list.
 */
function CleanUp({ pid, name, onDone }: { pid: string; name: string; onDone: () => void }) {
  const [plan, setPlan] = useState<CleanPlan | null>(null);
  const [done, setDone] = useState<CleanPlan | null>(null);
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  const start = () => {
    setOpen(true);
    setPlan(null);
    setDone(null);
    void run(async () => setPlan(await api<CleanPlan>(`/api/projects/${pid}/disk/clean`, { body: {} })));
  };
  const confirm = () =>
    run(async () => {
      const r = await api<CleanPlan>(`/api/projects/${pid}/disk/clean`, {
        body: { confirm: { paths: plan!.remove.filter((i) => i.kind === 'folder').map((i) => i.path), builds: plan!.remove.filter((i) => i.build).map((i) => i.build) } },
      });
      setDone(r);
      onDone();
    });
  const shown = done ?? plan;
  return (
    <>
      <button type="button" className="btn small quiet" onClick={start}>
        Clean up
      </button>
      {open && (
        <Sheet title={done ? `Cleaned up ${name}` : `Clean up ${name}`} onClose={() => setOpen(false)}>
          {!shown && <p className="muted small">{busy ? 'Checking what can go…' : ''}</p>}
          {shown && (
            <div className="disk-clean">
              <p className="disk-clean-total">
                {shown.remove.length
                  ? `${done ? 'Removed' : 'Would remove'} ${shown.remove.length} ${shown.remove.length === 1 ? 'item' : 'items'}, ${bytes(shown.total)}`
                  : done ? 'Nothing was removed' : 'Nothing to remove'}
              </p>
              {shown.remove.length > 0 && (
                <ul className="disk-clean-list">
                  {shown.remove.map((i) => (
                    <li key={i.path}>
                      <span className="disk-clean-path mono small">{i.path}</span>
                      <span className="muted small">
                        {i.what}
                        {i.bytes != null ? ` · ${bytes(i.bytes)}` : ' · not measured yet'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {shown.skipped.length > 0 && (
                <>
                  <h3 className="disk-clean-h">{done ? 'Skipped' : 'Stays'}</h3>
                  <ul className="disk-clean-list">
                    {shown.skipped.map((i) => (
                      <li key={i.path}>
                        <span className="disk-clean-path mono small">{i.path}</span>
                        <span className="muted small">{i.reason}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {error && <p className="error-text small">{error}</p>}
              <div className="row disk-clean-acts">
                {!done && plan && plan.remove.length > 0 && (
                  <button type="button" className="btn primary" disabled={busy} onClick={confirm}>
                    Remove {bytes(plan.total)}
                  </button>
                )}
                <button type="button" className="btn quiet" onClick={() => setOpen(false)}>
                  {done || !plan?.remove.length ? 'Close' : 'Cancel'}
                </button>
              </div>
            </div>
          )}
        </Sheet>
      )}
    </>
  );
}

export function DiskPage() {
  const d = useLive<{ status: DiskStatus; usage: Usage; history?: HistoryState }>('/api/disk', (m) => m.type === 'disk');
  const { busy, run } = useAction();
  useTick();
  if (!d.data) return d.error ? <p className="error-text">{d.error}</p> : <div className="loading">Loading…</div>;
  const { status: s, usage: u } = d.data;
  const projects = [...u.projects].sort((a, b) => b.total - a.total);
  const tmpTop = u.tmp.filter((e) => e.bytes !== null).slice(0, 8);
  return (
    <section className="narrow disk-page">
      <PageHeader title="Disk">
        <button className="btn small" disabled={busy} onClick={() => run(async () => (await api('/api/disk/refresh', { method: 'POST' }), d.reload()))}>
          Measure again
        </button>
      </PageHeader>
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

      <h2>Projects</h2>
      {projects.map((p) => (
        <div key={p.id} className="card disk-project">
          <div className="row">
            <a className="one-line" href={href('p', p.id, 'overview')}>
              <strong>{p.name}</strong>
            </a>
            <span className="spacer" />
            <b className="mono">{bytes(p.total)}</b>
            <CleanUp pid={p.id} name={p.name} onDone={d.reload} />
          </div>
          <ul className="disk-rows">
            {[...p.entries].sort(bySize).map((e) => (
              <EntryRow key={e.path} e={e} onChanged={d.reload} />
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
      {d.data.history && <HistoryLine h={d.data.history} />}
      <h2>Temporary files</h2>
      <p className="muted small">
        {bytes(u.tmpTotal)} in all; the largest:
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

/** Agents' history (server/historyreduce.ts): its size in the database and its index, and the last daily reduction. */
type HistoryState = { events: number; bytes: number; indexBytes: number | null; last: { at: number; results: number; calls: number; bytesBefore: number; bytesAfter: number } | null };
function HistoryLine({ h }: { h: HistoryState }) {
  const last = h.last;
  return (
    <>
      <h2>Agent history</h2>
      <div className="card">
        <ul className="disk-rows">
          <li className="row">
            <span className="grow">
              Transcripts
              <span className="muted small one-line">
                {last ? `Last reduced ${dateTime(last.at)}${last.bytesBefore > last.bytesAfter ? `, ${bytes(last.bytesBefore - last.bytesAfter)} freed` : ', nothing old enough'}` : 'Not reduced yet'}
              </span>
            </span>
            <b className="mono">{bytes(h.bytes + (h.indexBytes ?? 0))}</b>
          </li>
        </ul>
      </div>
    </>
  );
}

/** The Disk line on the Helm page. */
export function DiskSummary() {
  const s = useDiskStatus().data;
  if (!s) return null;
  const f = worstFs(s);
  return (
    <a className="card disk-summary" href={href('system', 'disk')}>
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
