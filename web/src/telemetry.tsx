import { useState } from 'react';
import { api, useLive } from './api';
import { when } from './time';
import { TierUsageLine, FindingCode, ContextSummaries } from './plan';
import { Chart, Chips, Empty, Icon, RefLinks, href, modelLabel, PageHeader, Row as ItemRow } from './ui';

// The install-wide Telemetry page (server/telemetry.ts): four numbers for the current period against the one before,
// the chosen number's history as one chart, and the slowest and costliest tasks. Filters: project, tier, work mode.

type MetricKey = 'tokens' | 'cycle' | 'director' | 'rate';
type Metric = { key: MetricKey; label: string; value: number | null; prev: number | null; unit: string; better: 'lower' | 'higher'; n: number };
/** work_ms: what the task took (never waiting on you); ship_ms: created to done, its own number. Null: unknown. */
type Row = { task_id: string; project_id: string; project: string; title: string; work_ms: number | null; ship_ms: number | null; tokens: number | null; biggest?: string | null };
type SlowItem = { kind: string; key: string; label: string; ms: number; tasks: number; runs: number };
type Ship = { median: number | null; n: number; shares: { queued: number; working: number; waitingYou: number; review: number } | null };
type Summary = {
  period: 'day' | 'week';
  metrics: Metric[];
  totals: { directing: number; building: number; subagents: number; total: number };
  /** Tokens by model, and how much work (not directing) ran at Deep, with the Deep tasks and their reasons. */
  models: { byModel: { model: string; tier: string; tokens: number }[]; deepShare: number | null };
  deep: { id: string; project_id: string; project: string; title: string; state: string; tier_reason: string }[];
  chart: { labels: string[]; series: Record<MetricKey, (number | null)[]> };
  table: Row[];
  ship?: Ship;
  slowItems?: SlowItem[];
  /** The reset the view counts from (server/telemetryreset.ts), and how many projects have one of their own. */
  reset?: { at: number; who: string; scope: 'project' | 'all' } | null;
  projectsReset?: number;
  projects: { id: string; name: string }[];
  tiers: string[];
  modes: string[];
};

/** "Since 3:12 pm (reset) · Show all time": one muted line when the view counts from a reset, with its toggle. */
function ResetLine({ data, project, allTime, setAllTime }: { data: Summary; project: string; allTime: boolean; setAllTime: (v: boolean) => void }) {
  const r = data.reset;
  const others = !project && !r && (data.projectsReset ?? 0) > 0;
  if (!r && !others) return null;
  return (
    <p className="muted small telemetry-reset">
      <span>{allTime ? 'All time' : r ? `Since ${when(r.at)} (reset${r.scope === 'all' && project ? ' of all projects' : ''})` : `${data.projectsReset} project${data.projectsReset === 1 ? '' : 's'} since their reset`}</span>
      <button type="button" className="link small" aria-pressed={allTime} onClick={() => setAllTime(!allTime)}>
        {allTime ? 'Since reset' : 'Show all time'}
      </button>
    </p>
  );
}

const tokensText = (n: number | null) => (n == null ? '–' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const durText = (ms: number | null) => {
  if (ms == null) return '–';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
/** Narrower still for the table's three number columns: whole hours from 10 h ("28h"). */
const cellDur = (ms: number) => (ms >= 10 * 3600_000 ? `${Math.round(ms / 3600_000)}h` : shortDur(ms));
/** Compact for the table's narrow column: "1h 26m", "36m". */
const shortDur = (ms: number) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const valueText = (k: MetricKey, v: number | null) => (v == null ? '–' : k === 'tokens' ? tokensText(v) : k === 'cycle' ? shortDur(v) : k === 'director' ? `${v}%` : `${v}`);
/** The chart's numbers: tokens in thousands, cycle time in minutes. */
const chartValue = (k: MetricKey, v: number | null) => (v == null ? NaN : k === 'tokens' ? Math.round(v / 1000) : k === 'cycle' ? Math.round(v / 60000) : v);
const chartUnit: Record<MetricKey, string> = { tokens: 'k tokens', cycle: 'min', director: '%', rate: 'tasks/h' };

/** Change against the period before, coloured by whether it is better. */
function Trend({ m }: { m: Metric }) {
  if (m.value == null || m.prev == null || m.prev === 0) return <span className="muted">{m.key === 'director' ? (m.n ? 'of all tokens' : 'no tokens') : m.n ? `${m.n} task${m.n === 1 ? '' : 's'}` : 'no tasks'}</span>;
  const pct = Math.round(((m.value - m.prev) / m.prev) * 100);
  if (!pct) return <span className="muted">same as before</span>;
  const good = (pct < 0) === (m.better === 'lower');
  return (
    <span className={good ? 'good' : 'bad'}>
      {pct > 0 ? '▲' : '▼'} {Math.abs(pct)}%
    </span>
  );
}

export function TelemetryPage() {
  const [period, setPeriod] = useState<'day' | 'week'>('day');
  const [project, setProject] = useState('');
  const [tier, setTier] = useState('');
  const [mode, setMode] = useState('');
  const [metric, setMetric] = useState<MetricKey>('tokens');
  // The slowest table sorts by work time unless the user picks time to ship.
  const [sortBy, setSortBy] = useState<'work' | 'ship'>('work');
  // Show all time: this view ignores the reset (server/telemetryreset.ts); nothing is stored.
  const [allTime, setAllTime] = useState(false);
  const all: Record<string, string> = allTime ? { all: '1' } : {};
  const q = new URLSearchParams({ period, ...(project ? { project } : {}), ...(tier ? { tier } : {}), ...(mode ? { mode } : {}), ...all }).toString();
  const { data, error } = useLive<Summary>(`/api/telemetry?${q}`, (m) => m.type === 'project' || m.type === 'projects');
  const csv = `/api/telemetry.csv?${new URLSearchParams({ ...(project ? { project } : {}), ...(tier ? { tier } : {}), ...(mode ? { mode } : {}), ...all })}`;
  const sel = data?.metrics.find((m) => m.key === metric);
  const projectName = data?.projects.find((p) => p.id === project)?.name ?? 'this project';
  const reset = () => {
    if (!confirm(project ? `Reset Telemetry for ${projectName}? Its views start fresh from now; nothing is deleted.` : 'Reset Telemetry for all projects? Every view starts fresh from now; nothing is deleted.')) return;
    void api('/api/telemetry/reset', { body: project ? { project } : {} })
      .then(() => setAllTime(false))
      .catch((e) => alert(String(e?.message ?? e)));
  };

  return (
    <section className="telemetry-page">
      <PageHeader title="Telemetry">
        <span className="telemetry-actions">
          <button type="button" className="btn small quiet" onClick={reset}>
            Reset view
          </button>
          <a className="btn small" href={csv} download>
            CSV
          </a>
        </span>
      </PageHeader>
      <div className="telemetry-filters">
        <Chips value={period} onChange={setPeriod} options={[{ id: 'day', label: 'Today' }, { id: 'week', label: '7 days' }]} />
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          <option value="">All projects</option>
          {data?.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select value={tier} onChange={(e) => setTier(e.target.value)} aria-label="Tier">
          <option value="">Any tier</option>
          {data?.tiers.map((t) => (
            <option key={t} value={t}>
              {t === 'none' ? 'No tier' : t[0].toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="Work mode">
          <option value="">Any mode</option>
          {data?.modes.map((m) => (
            <option key={m} value={m}>
              {m[0].toUpperCase() + m.slice(1)}
            </option>
          ))}
        </select>
      </div>

      {error && !data && <Empty title="Could not load telemetry">{error}</Empty>}
      {!data && !error && <div className="loading">Loading…</div>}
      {data && (
        <>
          <ResetLine data={data} project={project} allTime={allTime} setAllTime={setAllTime} />
          <FocusSection project={project} allTime={allTime} />
          <div className="telemetry-numbers">
            {data.metrics.map((m) => (
              <button key={m.key} type="button" className={`card telemetry-number ${m.key === metric ? 'on' : ''}`} aria-pressed={m.key === metric} onClick={() => setMetric(m.key)}>
                <span className="muted small">{m.label}</span>
                <b>{valueText(m.key, m.value)}</b>
                <span className="small">
                  <Trend m={m} />
                </span>
              </button>
            ))}
          </div>

          {data.totals.total > 0 && (
            <p className="muted small telemetry-totals">
              Tokens: {[[data.totals.directing, 'directing'], [data.totals.building, 'building'], [data.totals.subagents, 'subagents']].filter(([n]) => Number(n) > 0).map(([n, w]) => `${tokensText(Number(n))} ${w}`).join(' · ')}
            </p>
          )}
          {data.models.byModel.length > 0 && (
            <p className="muted small telemetry-totals">
              By model: {data.models.byModel.map((m) => `${m.model === 'unknown' ? 'before tiers' : modelLabel(m.model)} ${tokensText(m.tokens)}`).join(' · ')}
              {data.models.deepShare != null && (
                <>
                  {' · '}
                  <span className={data.models.deepShare > 10 ? 'bad' : ''}>work on Fable {data.models.deepShare}%</span>
                </>
              )}
            </p>
          )}

          {data.ship && data.ship.median != null && (
            <p className="muted small telemetry-totals">
              Time to ship: median {shortDur(data.ship.median)}
              {data.ship.shares && ` · queued ${data.ship.shares.queued}% · working ${data.ship.shares.working}% · waiting on you ${data.ship.shares.waitingYou}% · review ${data.ship.shares.review}%`}
            </p>
          )}

          {sel && data.chart.series[metric].some((v) => v != null) ? (
            <div className="card telemetry-chart">
              <span className="muted small">
                {sel.label} ({chartUnit[metric]}), per {period === 'day' ? 'day' : 'week'}
              </span>
              <Chart spec={{ type: 'bar', labels: data.chart.labels, unit: chartUnit[metric], series: [{ name: sel.label, values: data.chart.series[metric].map((v) => chartValue(metric, v)) }] }} />
            </div>
          ) : (
            <Empty title={`No ${sel?.label.toLowerCase() ?? 'figures'} in the last ${period === 'day' ? '14 days' : '8 weeks'}`} />
          )}

          {data.deep.length > 0 && (
            <div className="card telemetry-table">
              <table>
                <thead>
                  <tr>
                    <th>Tasks at Deep (Fable)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.deep.map((t) => (
                    <tr key={t.id}>
                      <td>
                        <a href={href('p', t.project_id, 'tasks', t.id)} className="one-line">
                          {t.title}
                        </a>
                        <span className="muted small one-line">{t.tier_reason || 'no reason given'}{project ? '' : ` · ${t.project}`}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {data.table.length > 0 && (
            <div className="card telemetry-table">
              <table>
                <thead>
                  <tr>
                    <th>Slow or costly</th>
                    <th className="num">
                      <button className={`th-sort ${sortBy === 'work' ? 'on' : ''}`} onClick={() => setSortBy('work')} aria-pressed={sortBy === 'work'}>
                        Work
                      </button>
                    </th>
                    <th className="num">
                      <button className={`th-sort ${sortBy === 'ship' ? 'on' : ''}`} onClick={() => setSortBy('ship')} aria-pressed={sortBy === 'ship'}>
                        Ship
                      </button>
                    </th>
                    <th className="num">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {[...data.table].sort((a, b) => (b[sortBy === 'work' ? 'work_ms' : 'ship_ms'] ?? -1) - (a[sortBy === 'work' ? 'work_ms' : 'ship_ms'] ?? -1)).map((r) => (
                    <tr key={r.task_id}>
                      <td>
                        <a href={href('p', r.project_id, 'tasks', r.task_id)} className="one-line">
                          {r.title}
                        </a>
                        {/* Where most of its time went (server/tasktime.ts); the task page shows the whole breakdown. */}
                        {(!project || r.biggest) && <span className="muted small one-line">{[project ? '' : r.project, r.biggest ?? ''].filter(Boolean).join(' · ')}</span>}
                      </td>
                      <td className="num">{r.work_ms == null ? '?' : cellDur(r.work_ms)}</td>
                      <td className="num muted">{r.ship_ms == null ? '?' : cellDur(r.ship_ms)}</td>
                      <td className="num">{tokensText(r.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {data?.slowItems && data.slowItems.length > 0 && (
        <div className="card telemetry-table">
          <table>
            <thead>
              <tr>
                <th>What makes tasks slow</th>
                <th className="num">Time</th>
                <th className="num">Tasks</th>
              </tr>
            </thead>
            <tbody>
              {data.slowItems.map((i) => (
                <tr key={i.key}>
                  <td>
                    <span className="one-line">{i.label}</span>
                    <span className="muted small one-line">{i.runs} runs</span>
                  </td>
                  <td className="num">{cellDur(i.ms)}</td>
                  <td className="num">{i.tasks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ReworkSection project={project} period={period} allTime={allTime} />
      <ActivitySection project={project} tier={tier} allTime={allTime} />
      <TierUsageLine src={`/api/telemetry/extra${allTime ? '?all=1' : ''}`} />
      <FindingCode src={`/api/telemetry/extra${allTime ? '?all=1' : ''}`} />
      <ContextSummaries />
    </section>
  );
}

// ---------- Focus: what holds throughput back (server/focus.ts) ----------

type FocusLine = {
  key: string;
  label: string;
  group: 'gap' | 'work' | 'capacity';
  ms: number;
  share: number;
  prevMs: number;
  trend: { dir: 'up' | 'down' | 'flat' | 'new'; pct: number | null };
  top: { kind: 'task' | 'project'; id: string; title: string; ms: number }[];
  lever: string | null;
};
type Focus = {
  from: number;
  tasks: number;
  shipMs: number;
  workMs: number;
  gapMs: number;
  reset: { at: number } | null;
  lines: FocusLine[];
  weeks: { labels: string[]; work: number[]; queued: number[]; waitingYou: number[]; review: number[] };
};

/** More hours lost than the week before is worse. */
function FocusTrend({ t }: { t: FocusLine['trend'] }) {
  if (t.dir === 'new') return <>new: none the week before</>;
  if (t.dir === 'flat' || t.pct == null) return <>same as the week before</>;
  return (
    <>
      <span className={t.dir === 'up' ? 'bad' : 'good'}>
        {t.dir === 'up' ? '▲' : '▼'} {Math.abs(t.pct)}%
      </span>{' '}
      on the week before
    </>
  );
}

/**
 * Where time to ship goes beyond the work itself over the last 7 days (each project from its last reset), ranked by
 * hours lost: each line's hours and share of time to ship, its trend, the top tasks behind it and its lever (shown only
 * when its condition holds); and a stacked bar per week of time to ship split into work and each wait.
 */
function FocusSection({ project, allTime }: { project: string; allTime: boolean }) {
  const q = new URLSearchParams({ ...(project ? { project } : {}), ...(allTime ? { all: '1' } : {}) }).toString();
  const { data } = useLive<Focus>(`/api/telemetry/focus?${q}`, (m) => m.type === 'projects');
  const weeks = data?.weeks;
  const anyWeek = !!weeks && [weeks.work, weeks.queued, weeks.waitingYou, weeks.review].some((s) => s.some((v) => v > 0));
  return (
    <>
      <div className="section-head act-head">
        <h2>Focus</h2>
      </div>
      {data && !data.lines.length && <Empty title="Nothing shipped in the last 7 days" />}
      {data && data.lines.length > 0 && (
        <>
          <p className="muted small focus-sum">
            Last 7 days{data.reset && data.reset.at > data.from ? ` since the reset ${when(data.reset.at)}` : ''}: {data.tasks} task{data.tasks === 1 ? '' : 's'} shipped · time to ship {hours(data.shipMs)}, work {hours(data.workMs)}, beyond the work {hours(data.gapMs)}
          </p>
          <div className="card focus-list">
            {data.lines.map((l) => (
              <ItemRow
                key={l.key}
                title={l.label}
                end={
                  <span className="focus-num">
                    <b>{hours(l.ms)}</b>
                    <span className="muted small">{l.share}%</span>
                  </span>
                }
                line={
                  <>
                    <span className="focus-meta">
                      <FocusTrend t={l.trend} />
                    </span>
                    {l.top.map((t) => (
                      <span key={t.id} className="one-line">
                        {t.kind === 'task' ? <RefLinks text={`[[${t.id}]]`} /> : <a href={href('p', t.id)}>{t.title}</a>} <span className="muted">{hours(t.ms)}</span>
                      </span>
                    ))}
                    {l.lever && <span className="focus-lever">{l.lever}</span>}
                  </>
                }
              />
            ))}
          </div>
          <p className="muted small">Share of time to ship. Rework, command waits and model time are inside the work; empty slots are beside it.</p>
        </>
      )}
      {weeks && anyWeek && (
        <div className="card telemetry-chart">
          <span className="muted small">Time to ship per week (h)</span>
          <Chart
            spec={{
              type: 'stacked',
              labels: weeks.labels,
              unit: 'h',
              series: [
                { name: 'Work', values: weeks.work },
                { name: 'Queue', values: weeks.queued },
                { name: 'Waiting on you', values: weeks.waitingYou },
                { name: 'Review and checks', values: weeks.review },
              ],
            }}
            table={false}
            width={480}
          />
        </div>
      )}
    </>
  );
}

// ---------- what agents spend their time on (server/activitystats.ts) ----------

type CategoryRow = { category: string; label: string; ms: number; share: number; prevMs: number; tokens: number };
type CommandRow = { group: string; intent: string; example: string; waitedMs: number; filledMs: number; runs: number; avgMs: number; maxMs: number; share: number };
type ProjectActivity = { project_id: string; name: string; activeMs: number; prevActiveMs: number; categories: CategoryRow[]; top: string[]; tokens: number; commands?: CommandRow[]; commandsTop?: string };

/** The bar's few groups (the table has every category): each a colour from the validated series order. */
const GROUPS: { label: string; of: (c: string) => boolean }[] = [
  { label: 'Thinking and writing', of: (c) => c === 'thinking' },
  { label: 'Reading and searching', of: (c) => c === 'reading' || c === 'searching' },
  { label: 'Editing', of: (c) => c === 'editing' },
  { label: 'Commands', of: (c) => c.startsWith('cmd_') && c !== 'cmd_wait' },
  { label: 'Waiting on commands', of: (c) => c === 'cmd_wait' },
  { label: 'Helm, other tools, subagents', of: (c) => c === 'helm' || c === 'other_tools' || c === 'subagents' || c === 'waiting_user' || c === 'idle' },
];
const hours = (ms: number) => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);
const short = (ms: number) => (ms >= 60_000 ? hours(ms) : `${Math.round(ms / 1000)} s`);

/**
 * The commands behind "waiting on commands" (server/activitystats.ts commandRows), biggest wait first: what each is for,
 * the time waited with nothing else in hand and its share, the command as run, runs, average and longest; a tap shows
 * one example in full and the background time other work filled.
 */
function CommandList({ rows, top }: { rows: CommandRow[]; top: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="act-cmds">
      {top && <p className="small act-cmds-top">{top}</p>}
      <ul>
        {rows.map((c) => (
          <li key={c.group}>
            <button className={`act-cmd ${open === c.group ? 'open' : ''}`} onClick={() => setOpen(open === c.group ? null : c.group)} aria-expanded={open === c.group}>
              <span className="act-cmd-main">
                <span className="one-line">{c.intent}</span>
                <span className="mono small num">
                  {short(c.waitedMs)} · {c.share}%
                </span>
              </span>
              <span className="muted small one-line">
                <span className="mono">{c.group}</span> · {c.runs} {c.runs === 1 ? 'run' : 'runs'}
                {c.runs ? ` · avg ${short(c.avgMs)} · max ${short(c.maxMs)}` : ''}
              </span>
            </button>
            {open === c.group && (
              <div className="act-cmd-more small">
                <p className="muted">
                  Waited with nothing else in hand: {short(c.waitedMs)}
                  {c.filledMs ? `; other work filled ${short(c.filledMs)} more` : '; no other work alongside'}.
                </p>
                {c.example && <pre className="mono">{c.example}</pre>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StackBar({ label, rows, total, prev }: { label: string; rows: CategoryRow[]; total: number; prev: boolean }) {
  return (
    <div className="act-bar-row">
      <span className="muted small">{label}</span>
      <div className="act-bar" role="img" aria-label={`${label}: ${GROUPS.map((g) => `${g.label} ${hours(rows.filter((r) => g.of(r.category)).reduce((n, r) => n + (prev ? r.prevMs : r.ms), 0))}`).join(', ')}`}>
        {GROUPS.map((g, i) => {
          const ms = rows.filter((r) => g.of(r.category)).reduce((n, r) => n + (prev ? r.prevMs : r.ms), 0);
          return total > 0 && ms > 0 ? <span key={g.label} style={{ width: `${(ms / total) * 100}%`, background: `var(--series-${i + 1})` }} title={`${g.label}: ${hours(ms)}`} /> : null;
        })}
      </div>
      <span className="mono small">{hours(total)}</span>
    </div>
  );
}

/**
 * Per project (never summed across projects unless the user asks): agents' active time by what they were doing, this
 * week against last, as two stacked bars and a table; the three biggest named in a line. Filters: who, and the page's tier.
 */
function ActivitySection({ project, tier, allTime }: { project: string; tier: string; allTime: boolean }) {
  const [who, setWho] = useState('');
  const [combine, setCombine] = useState(false);
  const q = new URLSearchParams({ ...(project ? { project } : {}), ...(tier ? { tier } : {}), ...(who ? { who } : {}), ...(combine && !project ? { combine: '1' } : {}), ...(allTime ? { all: '1' } : {}) }).toString();
  const { data } = useLive<{ projects: ProjectActivity[] }>(`/api/telemetry/activity?${q}`, (m) => m.type === 'projects');
  const [openWait, setOpenWait] = useState<Record<string, boolean>>({});
  return (
    <>
      <div className="section-head act-head">
        <h2>What agents spend time on</h2>
      </div>
      <div className="telemetry-filters">
        <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Who">
          <option value="">Everyone</option>
          <option value="director">Director</option>
          <option value="builder">Builder</option>
          <option value="agent">Area agents</option>
          <option value="subagent">Subagents</option>
          <option value="helper">Helpers</option>
        </select>
        {!project && (
          <label className="row small act-combine">
            <input type="checkbox" checked={combine} onChange={(e) => setCombine(e.target.checked)} /> All projects together
          </label>
        )}
      </div>
      <p className="muted small act-legend">
        {GROUPS.map((g, i) => (
          <span key={g.label}>
            <i style={{ background: `var(--series-${i + 1})` }} /> {g.label}
          </span>
        ))}
      </p>
      {!data?.projects.length && <Empty title="Nothing recorded in the last two weeks" />}
      {data?.projects.map((p) => (
        <div key={p.project_id} className="card act-project">
          <strong>{p.name}</strong>
          <span className="muted small">Biggest: {p.top.join(', ') || '–'}</span>
          <StackBar label="This week" rows={p.categories} total={p.activeMs} prev={false} />
          <StackBar label="Last week" rows={p.categories} total={p.prevActiveMs} prev />
          <table className="act-table small">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th className="num">Time</th>
                  <th className="num">Share</th>
                  <th className="num">Change</th>
                </tr>
              </thead>
              <tbody>
                {[...p.categories].sort((a, b) => b.ms - a.ms).map((c) => {
                  const d = c.ms - c.prevMs;
                  // "Waiting on commands" opens into the commands behind it.
                  const cmds = c.category === 'cmd_wait' && p.commands?.length ? p.commands : null;
                  const isOpen = !!openWait[p.project_id];
                  return [
                    <tr key={c.category}>
                      <td>
                        {cmds ? (
                          <button className={`act-wait-toggle ${isOpen ? 'open' : ''}`} onClick={() => setOpenWait((o) => ({ ...o, [p.project_id]: !o[p.project_id] }))} aria-expanded={isOpen}>
                            <Icon name="chevron" size={16} /> {c.label}
                          </button>
                        ) : (
                          c.label
                        )}
                      </td>
                      <td className="num mono">{hours(c.ms)}</td>
                      <td className="num mono">{c.share}%</td>
                      <td className="num mono muted">{c.prevMs ? `${d >= 0 ? '+' : '−'}${hours(Math.abs(d))}` : '–'}</td>
                    </tr>,
                    cmds && isOpen ? (
                      <tr key="cmd_wait_list" className="act-cmds-row">
                        <td colSpan={4}>
                          <CommandList rows={cmds} top={p.commandsTop ?? ''} />
                        </td>
                      </tr>
                    ) : null,
                  ];
                })}
              </tbody>
            </table>
          <p className="muted small">Agent time over the last 7 days against the 7 before. Tokens by kind (in get_telemetry) are an estimate.</p>
        </div>
      ))}
    </>
  );
}

// ---------- rework, repeats and unused speed (server/rework.ts) ----------

type ReworkKind = { kind: string; label: string; n: number; ms: number };
type Repeat = {
  sig: string;
  text: string;
  count: number;
  tasks: { id: string; title: string }[];
  agents: number;
  self: boolean;
  known: boolean;
  by: { kind: 'knowledge' | 'task'; id: string; title: string } | null;
  knownHits: number;
  given: number;
  top2: number;
};
type Speed = { idle_ms: number; idle_with_work_ms: number; empty_slot_ms: number | null; slots: number | null; queued_ms: number; host_free_ms: number; heavy_queued: number };
type ProjectRework = {
  project_id: string;
  name: string;
  share: number | null;
  prev: number | null;
  tasks_n: number;
  kinds: ReworkKind[];
  chart: { labels: string[]; values: (number | null)[] };
  top: { task_id: string; title: string; share: number | null; rework_ms: number; biggest: string }[];
  repeats: Repeat[];
  speed: Speed;
};

/** Whether the answer to a repeated error was written down when it hit again, in a few words. */
function RepeatVerdict({ r }: { r: Repeat }) {
  if (r.self) return <span className="tag">says the fix</span>;
  if (!r.known || !r.by) return <span className="tag tone-warning">not known</span>;
  return (
    <span className="tag st-done" title={`Given ${r.given} of ${r.knownHits}; search top 2 ${r.top2} of ${r.knownHits}`}>
      known
    </span>
  );
}

/**
 * Per project: the share of work time spent redoing work (failed commands rerun, edits rewritten, reverts, reviews
 * sent back, reopened tasks), its history, and where it went; errors that hit two or more tasks, each with whether its
 * answer was already written down; and the speed left unused (waits with independent work queued, empty slots, hosts).
 */
function ReworkSection({ project, period, allTime }: { project: string; period: 'day' | 'week'; allTime: boolean }) {
  const q = new URLSearchParams({ period, ...(project ? { project } : {}), ...(allTime ? { all: '1' } : {}) }).toString();
  const { data } = useLive<{ projects: ProjectRework[] }>(`/api/telemetry/rework?${q}`, (m) => m.type === 'projects');
  const span = period === 'day' ? 'today' : 'the last 7 days';
  return (
    <>
      <div className="section-head act-head">
        <h2>Rework</h2>
      </div>
      {data && !data.projects.length && <Empty title="No finished tasks in the period" />}
      {data?.projects.map((p) => (
        <div key={p.project_id} className="card act-project rework-card">
          <strong>{p.name}</strong>
          <span className="small">
            <b>{p.share == null ? '–' : `${p.share}%`}</b> <span className="muted">of work time {span}, {p.tasks_n} task{p.tasks_n === 1 ? '' : 's'}{p.prev != null ? ` (before ${p.prev}%)` : ''}</span>
          </span>
          {p.chart.values.some((v) => v != null) && <Chart spec={{ type: 'bar', labels: p.chart.labels, unit: '%', series: [{ name: 'Rework', values: p.chart.values.map((v) => (v == null ? NaN : v)) }] }} table={false} width={480} />}
          {p.kinds.length > 0 && <p className="muted small">{p.kinds.map((k) => `${k.label} ${k.n}${k.ms >= 60_000 ? ` (${short(k.ms)})` : ''}`).join(' · ')}</p>}
          {p.top.map((t) => (
            <a key={t.task_id} href={href('p', p.project_id, 'tasks', t.task_id)} className="rework-task small">
              <span className="one-line">{t.title}</span>
              <span className="muted one-line">
                {t.share ?? '?'}% · {short(t.rework_ms)} · {t.biggest.toLowerCase()}
              </span>
            </a>
          ))}
          <p className="muted small">
            Unused speed: waited on commands {short(p.speed.idle_ms)}, {short(p.speed.idle_with_work_ms)} of it with independent work queued
            {p.speed.empty_slot_ms != null ? `; empty slots while work queued ${short(p.speed.empty_slot_ms)} (of ${p.speed.slots})` : ''}
            {p.speed.heavy_queued ? `; a host free while ${p.speed.heavy_queued} heavy job${p.speed.heavy_queued === 1 ? '' : 's'} queued ${short(p.speed.host_free_ms)}` : ''}.
          </p>
        </div>
      ))}
      <div className="section-head act-head">
        <h2>Repeats</h2>
      </div>
      {data && !data.projects.some((p) => p.repeats.length) && <Empty title="No error hit two tasks" />}
      {data?.projects
        .filter((p) => p.repeats.length)
        .map((p) => (
          <div key={p.project_id} className="card telemetry-table">
            <table>
              <thead>
                <tr>
                  <th>{p.name}: same error, several tasks</th>
                  <th className="num">Tasks</th>
                </tr>
              </thead>
              <tbody>
                {p.repeats.map((r) => (
                  <tr key={r.sig}>
                    <td>
                      <span className="mono small one-line" title={r.text}>
                        {r.text}
                      </span>
                      <span className="small one-line rework-verdict">
                        <RepeatVerdict r={r} />{' '}
                        <span className="muted">
                          {r.count}× by {r.agents} agent{r.agents === 1 ? '' : 's'}
                          {!r.self && r.known && r.by ? ` · ${r.by.kind === 'knowledge' ? 'note' : 'task'} "${r.by.title}" · given ${r.given}/${r.knownHits} · search top 2 ${r.top2}/${r.knownHits}` : ''}
                        </span>
                      </span>
                    </td>
                    <td className="num">{r.tasks.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </>
  );
}
