import { useEffect, useRef, useState } from 'react';
import { api, useLive } from './api';
import type { ProjectState, Report, ReportSource, ReportStatus, SourceMode, SourcePreview, SourceType } from './api';
import { TaskStateTag } from './tasks';
import { openViewer } from './viewer';
import { Chips, Empty, Icon, Markdown, Sheet, Tag, ago, clock, go, href, useAction } from './ui';

// ---------- shared bits ----------

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
  new: 'New',
  needs_input: 'Needs you',
  in_progress: 'In progress',
  fixed: 'Fixed',
  dismissed: 'Dismissed',
  duplicate: 'Duplicate',
};

export function ReportStatusTag({ status }: { status: ReportStatus }) {
  return <span className={`tag report-st rs-${status}`}>{REPORT_STATUS_LABEL[status]}</span>;
}

const SOURCE_ICON: Record<SourceType, string> = { 'github-issues': 'github', folder: 'folder', command: 'terminal' };

function SourceBadge({ source }: { source: Report['source'] }) {
  if (!source) return null;
  return (
    <span className="source-badge" title={`${source.label}: ${source.name}`}>
      <Icon name={SOURCE_ICON[source.type] ?? 'reports'} size={13} />
      <span className="one-line">{source.name}</span>
    </span>
  );
}

const fileUrl = (file: string) => `/artifacts/${file}`;
const thumbOf = (r: Report) => r.attachments.find((a) => a.kind === 'image');

const MODES: { id: SourceMode; name: string; detail: string }[] = [
  { id: 'act', name: 'Act', detail: 'The director triages each report. One complete enough to fix is started straight away; the rest come to you as questions.' },
  { id: 'triage', name: 'Triage only', detail: 'The director triages and proposes tasks in Planning; nothing starts until you approve. Good for a public repository.' },
  { id: 'collect', name: 'Collect only', detail: 'Reports are listed here and the director is not told. You can send any one to it.' },
];
const MODE_NAME: Record<SourceMode, string> = { act: 'Act', triage: 'Triage only', collect: 'Collect only' };

// ---------- overview line ----------

// ---------- list ----------

type Filter = 'open' | 'needs_input' | 'new' | 'in_progress' | 'closed' | 'all';
const FILTERS: Record<Filter, ReportStatus[] | null> = {
  open: ['new', 'needs_input', 'in_progress'],
  needs_input: ['needs_input'],
  new: ['new'],
  in_progress: ['in_progress'],
  closed: ['fixed', 'dismissed', 'duplicate'],
  all: null,
};

export function ReportsPage({ s, sub }: { s: ProjectState; sub?: string }) {
  if (sub) return <ReportDetail key={sub} s={s} id={sub} />;
  return <ReportList s={s} />;
}

function ReportList({ s }: { s: ProjectState }) {
  const pid = s.project.id;
  const { data, error } = useLive<{ reports: Report[]; sources: ReportSource[] }>(`/api/projects/${pid}/reports`, (m) => m.type === 'project' && m.projectId === pid);
  const [filter, setFilter] = useState<Filter>('open');
  const [source, setSource] = useState('');
  const [limit, setLimit] = useState(60);
  if (error && !data) return <Empty title="Could not load reports">{error}</Empty>;
  if (!data) return <div className="loading">Loading…</div>;
  const bySource = data.reports.filter((r) => !source || r.source_id === source);
  const count = (f: Filter) => bySource.filter((r) => !FILTERS[f] || FILTERS[f]!.includes(r.status)).length;
  const shown = bySource.filter((r) => !FILTERS[filter] || FILTERS[filter]!.includes(r.status));
  const failing = data.sources.filter((x) => x.last_error);

  return (
    <section className="reports-page">
      <div className="section-head">
        <h1 className="page-title">Reports</h1>
        <a className="btn small quiet" href={href('p', pid, 'setup', 'reports')}>
          <Icon name="setup" size={15} /> Sources
        </a>
      </div>
      {!data.sources.length ? (
        <Empty title="No report sources yet">
          Connect GitHub issues, a folder of notes or a command in <a href={href('p', pid, 'setup', 'reports')}>Setup</a>. New reports then show up here and the director triages them.
        </Empty>
      ) : (
        <>
          {failing.map((x) => (
            <a key={x.id} className="needs-banner source-failing" href={href('p', pid, 'setup', 'reports')}>
              <span>
                <strong>{x.name} could not be read</strong>
                <span className="muted small">{x.last_error}</span>
              </span>
            </a>
          ))}
          <div className="toolbar reports-toolbar">
            <Chips
              value={filter}
              onChange={setFilter}
              options={[
                { id: 'open', label: 'Open', count: count('open') },
                { id: 'needs_input', label: 'Needs you', count: count('needs_input') },
                { id: 'new', label: 'New', count: count('new') },
                { id: 'in_progress', label: 'In progress', count: count('in_progress') },
                { id: 'closed', label: 'Closed', count: count('closed') },
                { id: 'all', label: 'All', count: count('all') },
              ]}
            />
            {data.sources.length > 1 && (
              <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
                <option value="">All sources</option>
                {data.sources.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {shown.length ? (
            <ul className="report-list">
              {shown.slice(0, limit).map((r) => (
                <ReportRow key={r.id} r={r} pid={pid} />
              ))}
              {shown.length > limit && (
                <li>
                  <button className="btn quiet show-more" onClick={() => setLimit(limit + 100)}>
                    Show more ({shown.length - limit})
                  </button>
                </li>
              )}
            </ul>
          ) : (
            <Empty title={filter === 'open' ? 'Nothing open' : 'No reports here'}>{filter === 'open' && data.reports.length ? 'Every report has been dealt with.' : null}</Empty>
          )}
        </>
      )}
    </section>
  );
}

function ReportRow({ r, pid }: { r: Report; pid: string }) {
  const thumb = thumbOf(r);
  return (
    <li>
      <a className="report-row card" href={href('p', pid, 'reports', r.id)}>
        <div className={`report-thumb ${thumb ? '' : 'none'}`}>{thumb ? <img src={fileUrl(thumb.file)} alt="" loading="lazy" /> : <Icon name={SOURCE_ICON[r.source?.type ?? 'folder']} size={20} />}</div>
        <div className="report-main">
          <strong className="report-title">{r.title}</strong>
          <div className="report-meta">
            <ReportStatusTag status={r.status} />
            <SourceBadge source={r.source} />
            <span className="muted small">{ago(r.source_created_at ?? r.created_at)}</span>
          </div>
          {r.task && (
            <span className="report-task small">
              <Icon name="check" size={13} /> <span className="one-line">{r.task.title}</span>
            </span>
          )}
        </div>
      </a>
    </li>
  );
}

// ---------- one report ----------

function fieldValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (!Array.isArray(v) && Object.values(v as object).every((x) => typeof x !== 'object')) {
      return Object.entries(v as object)
        .map(([k, x]) => `${k} ${x}`)
        .join(', ');
    }
    return JSON.stringify(v);
  }
  return String(v);
}

function ReportDetail({ s, id }: { s: ProjectState; id: string }) {
  const pid = s.project.id;
  const { data, error } = useLive<{ report: Report }>(`/api/reports/${id}`, (m) => m.type === 'project' && m.projectId === pid);
  const { busy, error: actionError, run } = useAction();
  const [asking, setAsking] = useState(false);
  if (error && !data) return <Empty title="Could not load this report">{error}</Empty>;
  if (!data) return <div className="loading">Loading…</div>;
  const r = data.report;
  const closed = ['fixed', 'dismissed', 'duplicate'].includes(r.status);
  const fields = Object.entries(r.fields);
  const images = r.attachments.filter((a) => a.kind === 'image');
  const files = r.attachments.filter((a) => a.kind !== 'image');
  const directorName = s.agents.find((a) => !a.parent_id && a.status !== 'closed')?.name ?? 'the director';

  return (
    <section className="report-page">
      <a className="back" href={href('p', pid, 'reports')}>
        <Icon name="back" size={16} /> Reports
      </a>
      <header className="card report-head">
        <div className="row wrap">
          <ReportStatusTag status={r.status} />
          <SourceBadge source={r.source} />
          <span className="muted small">
            {r.author ? `${r.author} · ` : ''}
            {clock(r.source_created_at ?? r.created_at)}
            {r.changed_at !== r.created_at ? ` · updated ${ago(r.changed_at)}` : ''}
          </span>
        </div>
        <h1 className="page-title">{r.title}</h1>
        <div className="row wrap report-actions">
          {!r.task && (
            <button className="btn small" disabled={busy} onClick={() => run(async () => go('p', pid, 'tasks', (await api<{ id: string }>(`/api/reports/${r.id}/task`, { body: {} })).id))}>
              <Icon name="plus" size={15} /> Create task
            </button>
          )}
          <button className="btn small" disabled={busy} onClick={() => setAsking(true)}>
            <Icon name="send" size={15} /> <span className="btn-label">Ask {directorName} to look</span>
          </button>
          {closed ? (
            <button className="btn small quiet" disabled={busy} onClick={() => run(() => api(`/api/reports/${r.id}/status`, { body: { status: 'new' } }))}>
              Reopen
            </button>
          ) : (
            <button
              className="btn small quiet"
              disabled={busy}
              onClick={() => {
                const note = prompt('Dismiss this report. Reason (optional):');
                if (note !== null) void run(() => api(`/api/reports/${r.id}/status`, { body: { status: 'dismissed', note: note ? `Dismissed by you: ${note}` : 'Dismissed by you.' } }));
              }}
            >
              Dismiss
            </button>
          )}
          {r.url && (
            <a className="btn small quiet" href={r.url} target="_blank" rel="noreferrer noopener">
              <Icon name="external" size={15} /> Open at source
            </a>
          )}
        </div>
        {actionError && <p className="error-text">{actionError}</p>}
        {(r.triage_note || r.task || r.duplicate) && (
          <div className="report-triage">
            {r.triage_note && (
              <div>
                <span className="label">Triage</span>
                <Markdown text={r.triage_note} />
              </div>
            )}
            {r.task && (
              <a className="report-link" href={href('p', pid, 'tasks', r.task.id)}>
                <TaskStateTag state={r.task.state} /> <span className="one-line">{r.task.title}</span>
              </a>
            )}
            {r.duplicate && (
              <a className="report-link" href={href('p', pid, 'reports', r.duplicate.id)}>
                <span className="muted small">Duplicate of</span> <span className="one-line">{r.duplicate.title}</span>
              </a>
            )}
          </div>
        )}
      </header>

      {images.map((a) => (
        <figure key={a.file} className="card report-shot">
          <button type="button" className="zv-open" onClick={() => openViewer(images.map((x) => ({ src: fileUrl(x.file), label: x.name })), images.indexOf(a))} aria-label={`${a.name}, full screen`}>
            <img src={fileUrl(a.file)} alt={a.name} />
          </button>
          <figcaption className="muted small">{a.name}</figcaption>
        </figure>
      ))}

      {fields.length > 0 && (
        <section className="card">
          <table className="report-fields">
            <tbody>
              {fields.map(([k, v]) => (
                <tr key={k}>
                  <th>{k}</th>
                  <td className="mono">{fieldValue(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card report-body">{r.body.trim() ? <Markdown text={r.body} /> : <p className="muted">No text.</p>}</section>

      {files.length > 0 && (
        <section className="card">
          <span className="label">Files</span>
          <ul className="report-files">
            {files.map((a) => (
              <li key={a.file}>
                <a href={fileUrl(a.file)} target="_blank" rel="noreferrer">
                  {a.name}
                </a>{' '}
                <span className="muted small">{Math.max(1, Math.round(a.size / 1024))} KB</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="muted small report-foot">
        {r.source?.label} · {r.source ? MODE_NAME[r.source.mode] : ''} · id at source <span className="mono">{r.external_id}</span>
      </p>

      {asking && (
        <AskSheet
          name={directorName}
          onClose={() => setAsking(false)}
          onSend={async (text) => {
            await api(`/api/reports/${r.id}/ask`, { body: { text } });
            setAsking(false);
          }}
        />
      )}
    </section>
  );
}

function AskSheet({ name, onClose, onSend }: { name: string; onClose: () => void; onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Sheet title={`Ask ${name} to look at this`} onClose={onClose}>
      <div className="form">
        <label>
          Anything to add (optional)
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. this one matters for the next build" />
        </label>
        <button className="btn primary" disabled={busy} onClick={() => run(() => onSend(text))}>
          Send to {name}
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>
    </Sheet>
  );
}

// ---------- on a task page ----------

export function TaskReports({ reports, pid }: { reports: Report[]; pid: string }) {
  if (!reports.length) return null;
  return (
    <section className="card task-reports">
      <div className="section-head">
        <h2>
          {reports.length === 1 ? 'Report' : `${reports.length} reports`} behind this task
        </h2>
      </div>
      <ul className="report-list compact">
        {reports.map((r) => (
          <ReportRow key={r.id} r={r} pid={pid} />
        ))}
      </ul>
    </section>
  );
}

// ---------- Setup ----------

const INTERVALS = [
  { s: 60, label: 'Every minute' },
  { s: 300, label: 'Every 5 minutes' },
  { s: 900, label: 'Every 15 minutes' },
  { s: 3600, label: 'Every hour' },
  { s: 21600, label: 'Every 6 hours' },
  { s: 86400, label: 'Once a day' },
];
const TYPE_LABEL: Record<SourceType, string> = { 'github-issues': 'GitHub issues', folder: 'Notes folder', command: 'Command' };

export function ReportSourcesSetup({ s, focus }: { s: ProjectState; focus?: string }) {
  const pid = s.project.id;
  const { data } = useLive<{ sources: ReportSource[]; defaultGlob: string }>(`/api/projects/${pid}/report-sources`, (m) => m.type === 'project' && m.projectId === pid);
  const [editing, setEditing] = useState<ReportSource | { type: SourceType } | null>(null);
  const { busy, error, run } = useAction();
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus === 'reports' && data) ref.current?.scrollIntoView({ block: 'start' });
  }, [focus, !!data]);

  return (
    <>
      <h2 id="report-sources" ref={ref}>
        Report sources
      </h2>
      <p className="muted">Where this project's bug reports and feedback come from. Helm checks each one on its interval, lists what it finds under Reports, and tells the director, who triages them.</p>
      {data?.sources.map((x) => (
        <div key={x.id} className={`card source-card ${x.enabled ? '' : 'off'}`}>
          <div className="row wrap">
            <Icon name={SOURCE_ICON[x.type]} size={18} />
            <strong className="grow one-line">{x.name}</strong>
            <Tag tone={x.mode === 'act' ? 'tone-accent' : ''}>{MODE_NAME[x.mode]}</Tag>
            {!x.enabled && <Tag>Off</Tag>}
          </div>
          <p className="muted small source-where">
            {x.label}: <span className="mono">{x.where}</span>
          </p>
          <p className="small">
            {x.polling ? (
              <span className="source-polling">Checking now…</span>
            ) : x.last_poll_at ? (
              <>
                Checked {ago(x.last_poll_at)} · {INTERVALS.find((i) => i.s === x.interval_seconds)?.label.toLowerCase() ?? `every ${Math.round(x.interval_seconds / 60)} min`}
              </>
            ) : (
              'Not checked yet'
            )}
            {' · '}
            <a href={href('p', pid, 'reports')}>
              {x.reports} report{x.reports === 1 ? '' : 's'}
            </a>
            {x.new + x.needs_input > 0 && ` (${x.new + x.needs_input} open)`}
          </p>
          {x.quiet_imported > 0 && (
            <p className="muted small">
              {x.quiet_imported} report{x.quiet_imported === 1 ? '' : 's'} already there when it was added came in without telling the director. Open one and use Ask to have it triaged.
            </p>
          )}
          {x.last_error && <p className="error-text small">{x.last_error}</p>}
          <div className="row wrap">
            <button className="btn small" disabled={busy || x.polling || !x.enabled} onClick={() => run(() => api(`/api/report-sources/${x.id}/poll`, { body: {} }))}>
              Check now
            </button>
            <button className="btn small quiet" onClick={() => setEditing(x)}>
              <Icon name="edit" size={15} /> Edit
            </button>
            <button className="btn small quiet" disabled={busy} onClick={() => run(() => api(`/api/report-sources/${x.id}`, { method: 'PATCH', body: { enabled: !x.enabled } }))}>
              {x.enabled ? 'Turn off' : 'Turn on'}
            </button>
          </div>
        </div>
      ))}
      {error && <p className="error-text">{error}</p>}
      <div className="card row wrap add-sources">
        <span className="muted small grow">Add a source:</span>
        {(Object.keys(TYPE_LABEL) as SourceType[]).map((t) => (
          <button key={t} className="btn small" onClick={() => setEditing({ type: t })}>
            <Icon name={SOURCE_ICON[t]} size={15} /> {TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      {editing && <SourceForm pid={pid} initial={editing} defaultGlob={data?.defaultGlob ?? ''} onClose={() => setEditing(null)} />}
    </>
  );
}

function SourceForm({ pid, initial, defaultGlob, onClose }: { pid: string; initial: ReportSource | { type: SourceType }; defaultGlob: string; onClose: () => void }) {
  const existing = 'id' in initial ? initial : null;
  const type = initial.type;
  const [name, setName] = useState(existing?.name ?? '');
  const [mode, setModeState] = useState<SourceMode>(existing?.mode ?? (type === 'github-issues' ? 'triage' : 'act'));
  // Whether the owner picked the mode; until then a new GitHub source follows the repository's visibility.
  const [modeChosen, setModeChosen] = useState(!!existing);
  const setMode = (m: SourceMode) => {
    setModeChosen(true);
    setModeState(m);
  };
  const [visibility, setVisibility] = useState<{ visibility: 'public' | 'private' | 'internal' | null; error?: string } | null>(null);
  const [interval, setIntervalS] = useState(existing?.interval_seconds ?? 300);
  const [config, setConfig] = useState<Record<string, any>>(() => {
    const c = existing?.config ?? {};
    if (type === 'github-issues') return { repo: c.repo ?? '', labels: (c.labels ?? []).join(', '), state: c.state ?? 'open', comments: c.comments !== false };
    if (type === 'folder') return { path: c.path ?? '', glob: c.glob ?? defaultGlob, layout: c.layout ?? 'auto', titleKey: c.titleKey ?? '', bodyKey: c.bodyKey ?? '', imageKey: c.imageKey ?? '' };
    return { command: c.command ?? '', timeoutSeconds: c.timeoutSeconds ?? 60 };
  });
  const set = (k: string, v: unknown) => setConfig((c) => ({ ...c, [k]: v }));
  const { busy, error, run } = useAction();
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const seq = useRef(0);

  const runPreview = async () => {
    const n = ++seq.current;
    setPreviewing(true);
    try {
      const p = await api<SourcePreview>(`/api/projects/${pid}/report-sources/preview`, { body: { type, config } });
      if (n === seq.current) setPreview(p);
    } catch (err: any) {
      if (n === seq.current) setPreview({ error: err.message });
    } finally {
      if (n === seq.current) setPreviewing(false);
    }
  };
  // A folder is cheap to read, so its preview follows the form as you type; the others run on request.
  const configKey = JSON.stringify(config);
  useEffect(() => {
    if (type !== 'github-issues' || existing || !String(config.repo ?? '').includes('/')) return setVisibility(null);
    let live = true;
    const t = setTimeout(async () => {
      const v = await api<{ visibility: 'public' | 'private' | 'internal' | null; error?: string }>(`/api/report-sources/github-visibility?repo=${encodeURIComponent(config.repo)}`).catch((err) => ({ visibility: null, error: err.message }));
      if (!live) return;
      setVisibility(v);
      if (!modeChosen) setModeState(v.visibility === 'private' || v.visibility === 'internal' ? 'act' : 'triage');
    }, 600);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [type, config.repo]);
  useEffect(() => {
    if (type !== 'folder' || !config.path) return;
    const t = setTimeout(runPreview, 500);
    return () => clearTimeout(t);
  }, [configKey]);

  const save = () =>
    run(async () => {
      const body = { type, name, mode, interval_seconds: interval, config };
      if (existing) await api(`/api/report-sources/${existing.id}`, { method: 'PATCH', body });
      else await api(`/api/projects/${pid}/report-sources`, { body });
      onClose();
    });

  return (
    <Sheet title={`${existing ? 'Edit' : 'Add'} source: ${TYPE_LABEL[type]}`} onClose={onClose} wide>
      <div className="form source-form">
        {type === 'github-issues' && (
          <>
            <label>
              Repository
              <input value={config.repo} onChange={(e) => set('repo', e.target.value)} placeholder="owner/name" autoCapitalize="off" autoCorrect="off" />
            </label>
            <div className="row wrap">
              <label>
                Only issues labelled (any of, comma separated)
                <input value={config.labels} onChange={(e) => set('labels', e.target.value)} placeholder="bug, feedback" autoCapitalize="off" />
              </label>
              <label className="narrow">
                State
                <select value={config.state} onChange={(e) => set('state', e.target.value)}>
                  <option value="open">Open</option>
                  <option value="closed">Closed</option>
                  <option value="all">All</option>
                </select>
              </label>
            </div>
            <label className="check">
              <input type="checkbox" checked={config.comments} onChange={(e) => set('comments', e.target.checked)} /> Include comments
            </label>
            <p className="muted small">Read with the GitHub CLI login of the user Helm runs as. Helm only reads: it never comments on or closes issues.</p>
          </>
        )}
        {type === 'folder' && (
          <>
            <label>
              Folder
              <input value={config.path} onChange={(e) => set('path', e.target.value)} placeholder="/home/you/game/notes, or a path inside the project" autoCapitalize="off" autoCorrect="off" />
            </label>
            <div className="row wrap">
              <label>
                Note files
                <input className="mono" value={config.glob} onChange={(e) => set('glob', e.target.value)} autoCapitalize="off" autoCorrect="off" />
              </label>
              <label className="narrow">
                Layout
                <select value={config.layout} onChange={(e) => set('layout', e.target.value)}>
                  <option value="auto">Work it out</option>
                  <option value="file">Notes side by side</option>
                  <option value="folder">One folder per note</option>
                </select>
              </label>
            </div>
            <details className="source-keys" open={!!(config.titleKey || config.bodyKey || config.imageKey)}>
              <summary className="small">Field names (if the preview picks the wrong ones)</summary>
              <div className="row wrap">
                <label>
                  Title
                  <input value={config.titleKey} onChange={(e) => set('titleKey', e.target.value)} placeholder="title" autoCapitalize="off" />
                </label>
                <label>
                  Text
                  <input value={config.bodyKey} onChange={(e) => set('bodyKey', e.target.value)} placeholder="description" autoCapitalize="off" />
                </label>
                <label>
                  Screenshot
                  <input value={config.imageKey} onChange={(e) => set('imageKey', e.target.value)} placeholder="screenshot" autoCapitalize="off" />
                </label>
              </div>
            </details>
            <p className="muted small">Each note is one file: JSON or TOML (keys become fields), markdown (front matter becomes fields) or plain text. Its screenshot is the file named in a screenshot field, an image with the same name, or the images in its own folder.</p>
          </>
        )}
        {type === 'command' && (
          <>
            <label>
              Command
              <input className="mono" value={config.command} onChange={(e) => set('command', e.target.value)} placeholder="./tools/export-reports --since-last" autoCapitalize="off" autoCorrect="off" />
            </label>
            <label className="narrow">
              Time limit (seconds)
              <input type="number" min={5} max={600} value={config.timeoutSeconds} onChange={(e) => set('timeoutSeconds', Number(e.target.value))} />
            </label>
            <p className="muted small">
              Runs in the project folder without a shell. It prints one JSON object per line: <span className="mono">{'{"id", "title", "body", "fields", "attachments", "url", "updated"}'}</span>.
            </p>
          </>
        )}

        <SourcePreviewPanel type={type} preview={preview} busy={previewing} onRun={runPreview} canRun={type === 'folder' ? !!config.path : type === 'github-issues' ? !!config.repo : !!config.command} />

        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={type === 'github-issues' ? config.repo || 'GitHub issues' : type === 'folder' ? 'Game notes' : 'Command'} />
        </label>
        <div className="mode-pick">
          <span className="label">What the director does with new reports</span>
          {visibility && <p className="muted small">{visibilityNote(visibility)}</p>}
          <div className="radio-cards">
            {MODES.map((m) => (
              <label key={m.id} className={`radio-card ${mode === m.id ? 'on' : ''}`}>
                <input type="radio" name="mode" checked={mode === m.id} onChange={() => setMode(m.id)} />
                <strong>{m.name}</strong>
                <span>{m.detail}</span>
              </label>
            ))}
          </div>
        </div>
        <label className="narrow">
          Check
          <select value={interval} onChange={(e) => setIntervalS(Number(e.target.value))}>
            {INTERVALS.map((i) => (
              <option key={i.s} value={i.s}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={save}>
            {existing ? 'Save' : 'Add source'}
          </button>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <span className="spacer" />
          {existing && (
            <button
              className="btn quiet danger"
              disabled={busy}
              onClick={() => {
                if (confirm(`Remove "${existing.name}"? Its ${existing.reports} report${existing.reports === 1 ? '' : 's'} and their screenshots are removed from Helm too. Nothing at the source changes.`))
                  void run(async () => {
                    await api(`/api/report-sources/${existing.id}`, { method: 'DELETE' });
                    onClose();
                  });
              }}
            >
              <Icon name="trash" size={15} /> Remove
            </button>
          )}
        </div>
      </div>
    </Sheet>
  );
}

function visibilityNote(v: { visibility: 'public' | 'private' | 'internal' | null; error?: string }): string {
  if (v.visibility === 'public') return 'Public repository: anyone can file issues, so the director proposes work and waits for you. Change it if you want.';
  if (v.visibility) return `${v.visibility === 'internal' ? 'Internal' : 'Private'} repository: only people with access can file issues, so the director acts on complete reports. Change it if you want.`;
  return `Could not tell whether this repository is public${v.error ? ` (${v.error.replace(/\.$/, '')})` : ''}, so the director proposes work and waits for you. Change it if you want.`;
}

function SourcePreviewPanel({ type, preview, busy, onRun, canRun }: { type: SourceType; preview: SourcePreview | null; busy: boolean; onRun: () => void; canRun: boolean }) {
  return (
    <div className="source-preview">
      <div className="row">
        <span className="label grow">{type === 'folder' ? 'How the newest notes read' : 'Test'}</span>
        {busy && <span className="muted small">Reading…</span>}
        {type !== 'folder' && (
          <button className="btn small" disabled={busy || !canRun} onClick={onRun}>
            {type === 'command' ? 'Run it once' : 'Fetch a few'}
          </button>
        )}
      </div>
      {!preview ? (
        <p className="muted small">{type === 'folder' ? 'Give the folder to see the first few notes as Helm reads them.' : 'Nothing is stored by a test.'}</p>
      ) : preview.error ? (
        <p className="error-text small">{preview.error}</p>
      ) : (
        <>
          <p className="muted small">
            {preview.total} {type === 'github-issues' ? 'issue' : type === 'folder' ? 'note file' : 'report'}
            {preview.total === 1 ? '' : 's'} found{preview.items!.length < (preview.total ?? 0) ? `, showing the newest ${preview.items!.length}` : ''}.
          </p>
          {preview.items!.map((it) => (
            <div key={it.id} className="preview-item">
              <div className="row">
                <strong className="grow one-line">{it.title || <span className="muted">(no title)</span>}</strong>
                <span className="mono muted small one-line preview-id">{it.id}</span>
              </div>
              {it.body && <p className="small preview-body">{it.body.slice(0, 220)}</p>}
              {Object.keys(it.fields).length > 0 && (
                <div className="preview-fields">
                  {Object.entries(it.fields)
                    .slice(0, 8)
                    .map(([k, v]) => (
                      <span key={k} className="mono small">
                        <b>{k}</b> {fieldValue(v).slice(0, 60)}
                      </span>
                    ))}
                </div>
              )}
              {type === 'folder' && (
                <p className="small">
                  <Icon name="previews" size={13} /> {it.images.length ? it.images.join(', ') : <span className="muted">no screenshot</span>}
                </p>
              )}
              {it.warnings.map((w, i) => (
                <p key={i} className="warn-text small">
                  {w}
                </p>
              ))}
            </div>
          ))}
          {preview.skipped!.map((x, i) => (
            <p key={i} className="warn-text small">
              {x}
            </p>
          ))}
        </>
      )}
    </div>
  );
}
