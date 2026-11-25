import { SCRATCH } from './testenv.ts';
// Telemetry resets (telemetryreset.ts): after a project's reset its views (summary, lists, rework, activity, tokens by
// tier, get_telemetry, the watches) count only what came after; "Show all time" (allTime) ignores it; another project
// is unaffected until all projects are reset; nothing is deleted. `node --test server/telemetryreset.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const tel = await import('./telemetry.ts');
const rs = await import('./telemetryreset.ts');
const rw = await import('./rework.ts');
const { activityView } = await import('./activitystats.ts');
const { tokensByTier } = await import('./usage.ts');
const { BUILTINS } = await import('./watches.ts');
const { userZone } = await import('./clock.ts');
const { recordTurnUsage } = await import('./usage.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const USER = { author: 'user' as const, name: 'You' };
const MIN = 60_000;
db.freezeClock();

function setup(name: string) {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, name, SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const builder = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  const tools = helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, director.role_id, null));
  const call = async (n: string, input: Record<string, unknown>) => ((await tools.find((x: any) => x.name === n)!.handler(input, {})) as any).content[0].text as string;
  /** A task worked for `min` minutes on `tokens` tokens, then done. */
  let total = 0;
  const finish = (title: string, tokens: number, min: number) => {
    const t = tasks.createTask(id, { title, state: 'active', origin: 'director', description: `Do ${title}.`, driver_agent_id: builder.id } as any, USER);
    db.run('UPDATE agents SET task_id = ? WHERE id = ?', t.id, builder.id);
    total += tokens;
    recordTurnUsage(db.get('SELECT * FROM agents WHERE id = ?', builder.id)!, { m: { inputTokens: total, outputTokens: 0, cacheCreationInputTokens: 0 } }, 'skilled', 'builder');
    db.advanceClock(min * MIN);
    tasks.setTaskState(tasks.getTask(t.id)!, 'done', USER);
    return t;
  };
  return { id, finish, call };
}
const count = (sql: string) => Number(db.get(sql)!.n);
const tokensOf = (s: ReturnType<typeof tel.telemetrySummary>) => s.metrics.find((m) => m.key === 'tokens')!.value;

test('a project reset: its views count only what came after; Show all time ignores it; another project is unaffected; nothing deleted', async () => {
  const a = setup('alpha');
  const b = setup('beta');
  const oldA = a.finish('Alpha before', 1000, 30);
  const oldB = b.finish('Beta before', 5000, 20);
  // Activity stored for yesterday (the stored days cannot be split; days before the reset are dropped).
  const tz = userZone();
  for (const p of [a.id, b.id]) db.run("INSERT INTO activity_days (project_id, day, who, tier, category, ms, tokens) VALUES (?, ?, 'builder', 'skilled', 'thinking', ?, 10)", p, tel.dayStart(db.now(), tz, -1), 60 * MIN);
  const before = { tel: count('SELECT COUNT(*) AS n FROM task_telemetry'), usage: count('SELECT COUNT(*) AS n FROM token_usage'), rework: count('SELECT COUNT(*) AS n FROM task_rework'), days: count('SELECT COUNT(*) AS n FROM activity_days') };

  db.advanceClock(MIN);
  rs.recordReset(a.id, 'user');
  db.advanceClock(MIN);
  const newA = a.finish('Alpha after', 3000, 10);

  // The project's numbers and lists: only the task after the reset.
  const sa = tel.telemetrySummary({ project: a.id, period: 'day' });
  assert.equal(tokensOf(sa), 3000);
  assert.equal(sa.metrics.find((m) => m.key === 'cycle')!.value, 10 * MIN);
  assert.ok(sa.table.some((r) => r.task_id === newA.id) && !sa.table.some((r) => r.task_id === oldA.id));
  assert.equal(sa.totals.total, 3000, 'tokens before the reset left out');
  assert.equal(sa.reset?.scope, 'project');
  assert.equal(sa.allTime, false);
  // Show all time: everything.
  const all = tel.telemetrySummary({ project: a.id, period: 'day', allTime: true });
  assert.equal(tokensOf(all), 2000);
  assert.ok(all.table.some((r) => r.task_id === oldA.id));
  assert.ok(tel.telemetryCsv({ project: a.id, allTime: true }).includes('Alpha before'));
  assert.ok(!tel.telemetryCsv({ project: a.id }).includes('Alpha before'));
  // All projects together: each from its own reset (alpha's old task out, beta's in).
  const ids = tel.telemetryRows({}).map((r) => r.task_id);
  assert.ok(ids.includes(oldB.id) && ids.includes(newA.id) && !ids.includes(oldA.id));

  // Rework and repeats.
  const periods = tel.periodsOf('day');
  assert.equal(rw.reworkView(a.id, periods)[0].tasks_n, 1);
  assert.equal(rw.reworkView(a.id, periods, true)[0].tasks_n, 2);
  assert.equal(rw.reworkView(b.id, periods)[0].tasks_n, 1);

  // What agents spend time on: yesterday's stored day is before the reset.
  const actA = activityView({ project: a.id }).find((p) => p.project_id === a.id);
  assert.equal(actA?.activeMs ?? 0, 0);
  assert.equal(activityView({ project: a.id, allTime: true })[0].activeMs, 60 * MIN);
  assert.equal(activityView({ project: b.id })[0].activeMs, 60 * MIN, 'beta not reset');

  // Watches and the director's tool.
  assert.equal(BUILTINS.tokens_per_task.read(a.id, 7), 3000);
  assert.equal(BUILTINS.tokens_per_task.read(b.id, 7), 5000);
  const text = await a.call('get_telemetry', {});
  assert.match(text, /Counted since the user reset Telemetry/);
  assert.ok(text.includes(newA.id) && !text.includes(oldA.id));

  // Tokens by tier on the page: alpha's earlier 1000 out.
  assert.equal(tokensByTier(undefined, false).skilled - tokensByTier(undefined, true).skilled, 1000);

  // Beta untouched by alpha's reset.
  const sb = tel.telemetrySummary({ project: b.id, period: 'day' });
  assert.equal(tokensOf(sb), 5000);
  assert.equal(sb.reset, null);

  // Reset of all projects: beta's earlier task now out too.
  db.advanceClock(MIN);
  rs.recordReset(null, 'user');
  assert.equal(tokensOf(tel.telemetrySummary({ project: b.id, period: 'day' })), null);
  assert.equal(tel.telemetrySummary({ project: b.id, period: 'day' }).reset?.scope, 'all');
  assert.equal(tokensOf(tel.telemetrySummary({ project: b.id, period: 'day', allTime: true })), 5000);

  // Nothing was deleted (alpha's new task added its rows).
  assert.equal(count('SELECT COUNT(*) AS n FROM task_telemetry'), before.tel + 1);
  assert.ok(count('SELECT COUNT(*) AS n FROM token_usage') >= before.usage + 1);
  assert.ok(count('SELECT COUNT(*) AS n FROM task_rework') >= before.rework);
  assert.equal(count('SELECT COUNT(*) AS n FROM activity_days'), before.days);
  assert.equal(count('SELECT COUNT(*) AS n FROM telemetry_resets'), 2);
});
