#!/usr/bin/env node
// Task and session statistics for one Helm project, as JSON for dashboard tiles (update_tile data shapes).
//   node scripts/task-stats.mjs <path to helm.db> <project id> [time zone, default UTC]
// Opens the database read-only. "Time" is work time (server/worktime.ts, stored with the task's telemetry): how long
// agents worked on it, never time it waited on the user. Tasks whose work time is unknown are left out of the times.
import { DatabaseSync } from 'node:sqlite';

const [dbPath, projectId, tz = 'UTC'] = process.argv.slice(2);
if (!dbPath || !projectId) {
  console.error('usage: task-stats.mjs <helm.db> <project id> [time zone]');
  process.exit(2);
}
const db = new DatabaseSync(dbPath, { readOnly: true });
// Work time is kept from the Helm that added it on; an older database has none, and active time would count waiting.
// Without them the task figures are left empty (sessions still come out), never filled with active time.
const hasWork = db.prepare('PRAGMA table_info(task_telemetry)').all().some((c) => c.name === 'work_ms');
if (!hasWork) console.error('This database has no work times yet: the task figures are empty until Helm is updated.');
const tasks = db
  .prepare(`SELECT t.id, t.title, t.state, ${hasWork ? 'm.work_ms' : 'NULL AS work_ms'}, t.started_at, t.finished_at FROM tasks t LEFT JOIN task_telemetry m ON m.task_id = t.id WHERE t.project_id = ? AND t.kind = 'task'`)
  .all(projectId);
const done = tasks.filter((t) => t.state === 'done' && t.finished_at && t.work_ms != null && t.work_ms > 0).sort((a, b) => a.finished_at - b.finished_at);
const mins = (ms) => Math.round(ms / 60000);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
// Tasks as Helm references: the dashboard shows each as a link with the task's current title.
const ref = (t) => `[[${t.id}]]`;
const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });

const perDay = new Map();
for (const t of done) perDay.set(day.format(t.finished_at), (perDay.get(day.format(t.finished_at)) ?? 0) + 1);
const recent = done.slice(-15);
const slowest = [...done].sort((a, b) => (b.work_ms ?? 0) - (a.work_ms ?? 0)).slice(0, 5);
const open = tasks.filter((t) => ['active', 'scheduled', 'waiting', 'paused'].includes(t.state)).length;

// Sessions: stretches when the user was working with the director. Length = start to last activity (or to now).
const sessions = db
  .prepare('SELECT started_at, last_activity_at, ended_at FROM sessions WHERE project_id = ? ORDER BY started_at')
  .all(projectId)
  .map((x) => ({ at: x.started_at, ms: (x.ended_at ? x.last_activity_at : Date.now()) - x.started_at }));
const clock = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const avg = sessions.length ? sessions.reduce((n, x) => n + x.ms, 0) / sessions.length : 0;

console.log(
  JSON.stringify(
    {
      sessionAvg: { value: mins(avg), unit: 'min', label: `average over ${sessions.length} sessions · median ${mins(median(sessions.map((x) => x.ms)))} min` },
      sessionLengths: { type: 'bar', unit: 'min', labels: sessions.map((x) => clock.format(x.at)), series: [{ name: 'Length', values: sessions.map((x) => mins(x.ms)) }] },
      median: { value: mins(median(done.map((t) => t.work_ms))), unit: 'min', label: `median over ${done.length} finished tasks`, better: 'lower' },
      finished: { value: done.length, label: `finished · ${open} open` },
      times: { type: 'bar', unit: 'min', labels: recent.map((t) => ref(t)), series: [{ name: 'Work time', values: recent.map((t) => mins(t.work_ms)) }] },
      perDay: { type: 'bar', labels: [...perDay.keys()], series: [{ name: 'Finished', values: [...perDay.values()] }] },
      slowest: { columns: ['Task', 'Time'], rows: slowest.map((t) => [ref(t), mins(t.work_ms) >= 60 ? `${Math.floor(mins(t.work_ms) / 60)} h ${mins(t.work_ms) % 60} min` : `${mins(t.work_ms)} min`]) },
    },
    null,
    1,
  ),
);
