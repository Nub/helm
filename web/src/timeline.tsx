import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLive } from './api';
import type { ProjectState } from './api';
import { Chart, Chips, Empty, href } from './ui';
import { axisTicks, dateOnly, dateTime, midnight } from './time';

/**
 * The Work page's Timeline (server/timeline.ts): each task as a bar over time (queued light, active solid, waiting on
 * you hatched, done ending in a tick), waits-for as arrows, rows in swimlanes by builder or Spec section, the
 * Scheduled queue projected ahead (dashed), and above it the throughput and flow charts. Names stay put on the left
 * while the bars scroll sideways.
 */

type SegKind = 'queued' | 'active' | 'you';
type TLTask = {
  id: string;
  title: string;
  state: string;
  lane: string;
  section: string;
  start: number;
  end: number | null;
  segments: { kind: SegKind; from: number; to: number }[];
  line: [string, number, number][];
  waits_for: string[];
  work_ms: number | null;
  ship_ms: number | null;
  projected: { from: number; to: number } | null;
};
type TLData = { now: number; from: number; days: number; typical_ms: number; tasks: TLTask[] };

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const ROW = 32;
const LANE = 28;
const AXIS = 30;

type Zoom = 'day' | 'week';
type Group = 'builder' | 'section';
const ZOOM: Record<Zoom, { pxPerHour: number; back: number; ahead: number; tick: number }> = {
  day: { pxPerHour: 90, back: 2 * DAY, ahead: DAY, tick: HOUR },
  week: { pxPerHour: 5, back: 14 * DAY, ahead: 10 * DAY, tick: DAY },
};

const median = (xs: number[]): number => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const hours = (ms: number) => Math.round((ms / HOUR) * 10) / 10;

/** The state a task was in at `t`, or null before it was a task or after its window. */
function stateAt(task: TLTask, t: number): string | null {
  if (t < task.start) return null;
  if (task.end != null && t >= task.end) return task.state;
  for (const [s, a, b] of task.line) if (t >= a && t < b) return s;
  const last = task.line[task.line.length - 1];
  return last && t >= last[2] ? last[0] : null;
}

function Throughput({ data }: { data: TLData }) {
  const today = midnight(data.now);
  const days = Array.from({ length: 14 }, (_, i) => midnight(today, i - 13));
  const done = data.tasks.filter((t) => t.state === 'done' && t.end != null);
  const perDay = days.map((d) => done.filter((t) => t.end! >= d && t.end! < midnight(d, 1)).length);
  const weeks = Array.from({ length: 4 }, (_, i) => midnight(today, 1 - 7 * (4 - i)));
  const inWeek = (w: number) => done.filter((t) => t.end! >= w && t.end! < w + 7 * DAY);
  const workMs = weeks.map((w) => median(inWeek(w).map((t) => t.work_ms ?? NaN)));
  const shipMs = weeks.map((w) => median(inWeek(w).map((t) => t.ship_ms ?? NaN)));
  // Minutes while every median is under two hours, else hours.
  const inMin = Math.max(0, ...[...workMs, ...shipMs].filter(Number.isFinite)) < 2 * HOUR;
  const unitOf = (ms: number) => (inMin ? Math.round(ms / 60_000) : hours(ms));
  // Cumulative flow: how many tasks stood in each state at the end of each day (today: now). Done counts from the first day.
  const ends = days.map((d) => Math.min(midnight(d, 1) - 1, data.now));
  const count = (pick: (s: string | null, t: TLTask) => boolean) => ends.map((e) => data.tasks.filter((t) => pick(stateAt(t, e), t)).length);
  const flow = [
    { name: 'Done', values: count((s, t) => s === 'done' && t.end! >= days[0]) },
    { name: 'Active', values: count((s) => s === 'active') },
    { name: 'Scheduled', values: count((s) => s === 'scheduled') },
    { name: 'Waiting', values: count((s) => s === 'waiting' || s === 'planning' || s === 'paused') },
  ];
  const dayLabels = days.map((d) => dateOnly(d));
  return (
    <div className="tl-charts">
      <section className="tl-chart">
        <h3>Done per day</h3>
        <Chart spec={{ type: 'bar', labels: dayLabels, series: [{ name: 'Done', values: perDay }], unit: 'tasks', title: 'Tasks done per day' }} width={420} height={170} table={false} />
      </section>
      <section className="tl-chart">
        <h3>Median per week, {inMin ? 'minutes' : 'hours'}</h3>
        <Chart spec={{ type: 'line', labels: weeks.map((w) => `wk of ${dateOnly(w)}`), series: [{ name: 'Work time', values: workMs.map(unitOf) }, { name: 'To ship', values: shipMs.map(unitOf) }], unit: inMin ? 'min' : 'h', title: 'Median work time and time to ship per week' }} width={420} height={170} table={false} />
      </section>
      <section className="tl-chart">
        <h3>Flow</h3>
        <Chart spec={{ type: 'area', labels: dayLabels, series: flow, unit: 'tasks', title: 'Cumulative flow: waiting, scheduled, active, done' }} width={420} height={170} table={false} />
      </section>
    </div>
  );
}

type Line = { kind: 'lane'; label: string } | { kind: 'task'; t: TLTask };

function laneOrder(a: string, b: string) {
  const rank = (x: string) => (x.startsWith('Builder') ? 0 : x.startsWith('No ') || x === 'Not started' ? 2 : 1);
  return rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true });
}

export function TimelineView({ s }: { s: ProjectState }) {
  const pid = s.project.id;
  const { data, error } = useLive<TLData>(`/api/projects/${pid}/timeline?days=28`, (m) => m.type === 'project' && m.projectId === pid);
  const [zoom, setZoom] = useState<Zoom>('week');
  const [group, setGroup] = useState<Group>('builder');
  const scroller = useRef<HTMLDivElement>(null);

  const z = ZOOM[zoom];
  const view = useMemo(() => {
    if (!data) return null;
    const start = data.now - z.back;
    const shown = data.tasks.filter((t) => t.end == null || t.end >= start);
    const lastProjected = Math.max(data.now, ...shown.map((t) => t.projected?.to ?? 0));
    const end = Math.min(data.now + z.ahead, lastProjected) + z.tick / 2;
    const laneOf = (t: TLTask) => (group === 'builder' ? t.lane || 'Not started' : t.section || 'No Spec entry');
    const lanes = new Map<string, TLTask[]>();
    for (const t of shown) lanes.set(laneOf(t), [...(lanes.get(laneOf(t)) ?? []), t]);
    // Newest first in each lane: what comes next (projected) at the top, then what runs now, then what finished.
    const key = (t: TLTask) => (t.state === 'scheduled' && t.projected ? t.projected.from : t.start);
    const lines: Line[] = [];
    for (const label of [...lanes.keys()].sort(laneOrder)) {
      lines.push({ kind: 'lane', label });
      for (const t of lanes.get(label)!.sort((a, b) => key(b) - key(a))) lines.push({ kind: 'task', t });
    }
    const ys = new Map<string, number>();
    let y = AXIS;
    for (const l of lines) {
      if (l.kind === 'task') ys.set(l.t.id, y);
      y += l.kind === 'lane' ? LANE : ROW;
    }
    return { start, end, lines, ys, height: y + 6 };
  }, [data, z, group]);

  // Open at now, with the projection in sight.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !view || !data) return;
    const xNow = ((data.now - view.start) / HOUR) * z.pxPerHour;
    el.scrollLeft = Math.max(0, xNow - el.clientWidth * 0.6);
  }, [view?.start, zoom, !!data]);

  const [, tick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(i);
  }, []);

  if (error) return <Empty title="Timeline unavailable">{String(error)}</Empty>;
  if (!data || !view) return <p className="muted">Loading the timeline…</p>;
  if (!data.tasks.length) return <Empty title="No tasks in the last four weeks" />;

  const x = (ts: number) => ((Math.max(view.start, ts) - view.start) / HOUR) * z.pxPerHour;
  const W = Math.ceil(x(view.end)) + 8;
  const ticks = axisTicks(view.start, view.end, zoom === 'week' ? 'day' : 'hour');
  const barEnd = (t: TLTask) => t.end ?? data.now;
  const mid = (id: string) => (view.ys.get(id) ?? 0) + ROW / 2;
  const arrows = data.tasks.flatMap((t) =>
    t.waits_for
      .filter((b) => view.ys.has(b) && view.ys.has(t.id))
      .map((b) => {
        const blocker = data.tasks.find((x) => x.id === b)!;
        const x1 = x(blocker.projected?.to ?? barEnd(blocker));
        const startWork = t.segments.find((g) => g.kind === 'active')?.from ?? t.projected?.from ?? t.start;
        const x2 = Math.max(x(startWork), x1 + 6);
        const y1 = mid(b);
        const y2 = mid(t.id) + (y1 < mid(t.id) ? -6 : 6);
        return { key: `${b}-${t.id}`, d: `M${x1},${y1} C${x1 + 24},${y1} ${x2 - 24},${y2} ${x2},${y2}` };
      }),
  );

  return (
    <div className="tl-view">
      <Throughput data={data} />
      <div className="tl-controls">
        <Chips value={zoom} onChange={setZoom} options={[{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }]} />
        <Chips value={group} onChange={setGroup} options={[{ id: 'builder', label: 'Builders' }, { id: 'section', label: 'Spec sections' }]} />
      </div>
      <p className="tl-legend muted small">
        <span><i className="tl-key tl-queued" />Queued</span>
        <span><i className="tl-key tl-active" />Active</span>
        <span><i className="tl-key tl-you" />Waiting on you</span>
        <span><i className="tl-key tl-projected" />Projected</span>
        <span>✓ Done</span>
      </p>
      <div className="tl-body">
        <div className="tl-names" style={{ height: view.height }}>
          <div style={{ height: AXIS }} />
          {view.lines.map((l) =>
            l.kind === 'lane' ? (
              <div key={`lane-${l.label}`} className="tl-lane-name" style={{ height: LANE }}>{l.label}</div>
            ) : (
              <a key={l.t.id} className={`tl-name tl-name-${l.t.state}`} style={{ height: ROW }} href={href('p', pid, 'tasks', l.t.id)} title={l.t.title}>
                {l.t.title}
              </a>
            ),
          )}
        </div>
        <div className="tl-scroll" ref={scroller}>
          <svg width={W} height={view.height} className="tl-svg" role="img" aria-label="Task timeline">
            <defs>
              <pattern id="tl-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" className="tl-hatch-bg" />
                <line x1="0" y1="0" x2="0" y2="6" className="tl-hatch-line" />
              </pattern>
              <marker id="tl-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" className="tl-arrowhead" />
              </marker>
            </defs>
            {(() => {
              let y = AXIS;
              return view.lines.map((l) => {
                const top = y;
                y += l.kind === 'lane' ? LANE : ROW;
                return l.kind === 'lane' ? <rect key={`lb-${l.label}`} x={0} y={top} width={W} height={LANE} className="tl-lane-band" /> : null;
              });
            })()}
            {ticks.map(({ t, label, major }) => (
              <g key={t}>
                <line x1={x(t)} x2={x(t)} y1={AXIS - 6} y2={view.height} className={major ? 'tl-grid' : 'tl-grid tl-grid-minor'} />
                <text x={x(t) + 4} y={AXIS - 12} className="tl-tick">
                  {label}
                </text>
              </g>
            ))}
            {view.lines.map((l) => {
              if (l.kind !== 'task') return null;
              const t = l.t;
              const y = view.ys.get(t.id)! + 7;
              const h = ROW - 14;
              const tip = `${t.title}\n${dateTime(t.start)} to ${t.end ? dateTime(t.end) : 'now'}${t.projected ? `\nProjected to ${dateTime(t.projected.to)}` : ''}`;
              return (
                <a key={t.id} href={href('p', pid, 'tasks', t.id)} className="tl-bar">
                  <title>{tip}</title>
                  {/* A wide clear target, so a short bar is still easy to tap. */}
                  <rect x={0} y={y - 7} width={W} height={ROW} className="tl-hit" />
                  {t.segments
                    .filter((g) => g.to > view.start)
                    .map((g, i) => (
                      <rect key={i} x={x(g.from)} y={y} width={Math.max(2, x(g.to) - x(g.from))} height={h} rx={2} className={`tl-seg tl-${g.kind}`} />
                    ))}
                  {t.projected && <rect x={x(t.projected.from)} y={y + 0.5} width={Math.max(3, x(t.projected.to) - x(t.projected.from))} height={h - 1} rx={2} className="tl-seg tl-projected" />}
                  {t.state === 'done' && t.end != null && <path d={`M${x(t.end) + 3},${y + h / 2} l3,4 l6,-8`} className="tl-tick-done" />}
                  {t.state === 'dropped' && t.end != null && <path d={`M${x(t.end) + 3},${y + 3} l7,${h - 6} m0,-${h - 6} l-7,${h - 6}`} className="tl-dropped" />}
                </a>
              );
            })}
            {arrows.map((a) => <path key={a.key} d={a.d} className="tl-wait" markerEnd="url(#tl-arrow)" />)}
            <line x1={x(Date.now())} x2={x(Date.now())} y1={AXIS - 6} y2={view.height} className="tl-now" />
            <text x={x(Date.now()) + 3} y={AXIS - 1} className="tl-now-label">now</text>
          </svg>
        </div>
      </div>
      <p className="muted small">Projected from a typical {hours(data.typical_ms)} h per task (the median of recent ones), in queue order.</p>
    </div>
  );
}
