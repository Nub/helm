import { SCRATCH } from './testenv.ts';
// Telemetry (telemetry.ts): the per-task row written when a task finishes, director turns counted for the task they
// were about, subagent tokens apart, waits, follow-ups, the backfill (tokens unknown), summaries, CSV and the
// director's tool (its own project only). `node --test server/telemetry.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const tel = await import('./telemetry.ts');
const { addEvent } = await import('./store.ts');
const { recordTurnUsage } = await import('./usage.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const USER = { author: 'user' as const, name: 'You' };
const MIN = 60_000;
db.freezeClock();

function setup(name = 'tp') {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, name, SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const builder = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  const task = (title: string, state = 'active', description = `Do ${title}.`) => tasks.createTask(id, { title, state, origin: 'director', description, driver_agent_id: builder.id } as any, USER);
  const tools = helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, director.role_id, null));
  const call = async (n: string, input: Record<string, unknown>) => ((await tools.find((x: any) => x.name === n)!.handler(input, {})) as any).content[0].text as string;
  return { project, director, builder, task, call };
}
const agent = (id: string) => db.get('SELECT * FROM agents WHERE id = ?', id)!;
const mu = (n: number) => ({ m: { inputTokens: n, outputTokens: 0, cacheCreationInputTokens: 0 } });
const row = (taskId: string) => db.get('SELECT * FROM task_telemetry WHERE task_id = ?', taskId)!;

test('finishing a task records its row: tokens split, director turns, waits, review rounds, who and mode', () => {
  const { project, director, builder, task } = setup();
  const t = task('Ship it');
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', t.id, builder.id);
  // The builder's turn, a third of it by an SDK subagent.
  recordTurnUsage(agent(builder.id), mu(900), 'skilled', 'builder', { sub: 300 });
  // A director turn woken by the builder's question about the task: counted for it.
  addEvent(agent(director.id), 'inbound', { from: { kind: 'agent', name: 'Builder' }, text: `<agent-question from="Builder" id="${builder.id}" ref="c1" task="${t.id}">\nWhich way?\n</agent-question>`, dialogue: false, about: null });
  assert.equal(tel.directorTurnTask(director.id), t.id);
  recordTurnUsage(agent(director.id), mu(200), 'deep', 'director', { task: tel.directorTurnTask(director.id) });
  addEvent(agent(director.id), 'result', { ok: true });
  // A long command: 4 minutes.
  addEvent(agent(builder.id), 'tool', { id: 'tu1', name: 'Bash', summary: 'npm test' });
  db.advanceClock(4 * MIN);
  addEvent(agent(builder.id), 'tool_result', { id: 'tu1', error: false, text: 'ok' });
  // A request to the user answered after 10 minutes; one decided automatically does not count.
  db.run("INSERT INTO inbox (id, project_id, agent_id, kind, title, created_at, answered_at, task_id, status) VALUES ('rq1', ?, ?, 'question', 'Q', ?, ?, ?, 'answered')", project.id, builder.id, db.now(), db.now() + 10 * MIN, t.id);
  db.run("INSERT INTO inbox (id, project_id, agent_id, kind, title, created_at, answered_at, task_id, status, decided_by) VALUES ('rq2', ?, ?, 'permission', 'P', ?, ?, ?, 'answered', 'auto')", project.id, builder.id, db.now(), db.now() + 60 * MIN, t.id);
  db.run("INSERT INTO consults (id, project_id, asker_id, manager_id, task_id, kind, question, created_at) VALUES ('cr1', ?, ?, ?, ?, 'review', 'Look', ?)", project.id, builder.id, director.id, t.id, db.now());
  db.advanceClock(20 * MIN);
  tasks.setTaskState(tasks.getTask(t.id)!, 'done', USER);
  const r = row(t.id);
  assert.equal(r.state, 'done');
  assert.equal(r.who, 'builder');
  assert.equal(r.work_mode, 'builder');
  assert.equal(r.tokens, 1100);
  assert.equal(r.tokens_building, 600);
  assert.equal(r.tokens_subagents, 300);
  assert.equal(r.tokens_directing, 200);
  assert.equal(r.director_turns, 1);
  assert.equal(r.wait_commands_ms, 4 * MIN);
  assert.equal(r.wait_user_ms, 10 * MIN);
  assert.equal(r.review_rounds, 1);
  assert.equal(r.active_ms, 24 * MIN);
  assert.equal(r.backfilled, 0);
  // The last turn ends after the finish: the row is brought up to date.
  recordTurnUsage(agent(builder.id), mu(1000), 'skilled', 'builder');
  assert.equal(row(t.id).tokens, 1200);
  // A task created within 7 days naming it is its follow-up.
  db.advanceClock(60 * MIN);
  const fix = task('Fix the thing', 'scheduled', `Follow-up to [[${t.id}]]: it broke.`);
  assert.equal(row(t.id).followup_task_id, fix.id);
});

test('backfill: finished tasks get rows once, tokens unknown where none were recorded; old director turns get their task', () => {
  const { director, task } = setup();
  const old = task('Old work');
  tasks.setTaskState(tasks.getTask(old.id)!, 'done', USER);
  db.run('DELETE FROM task_telemetry WHERE task_id = ?', old.id); // as if it finished before telemetry existed
  // A director turn from before attribution: no task on its usage row, its inbound names the task.
  addEvent(agent(director.id), 'inbound', { from: { kind: 'system', name: 'Helm' }, text: `<helm-note>[[${old.id}]] is done.</helm-note>`, dialogue: false, about: old.id });
  db.run("INSERT INTO token_usage (project_id, agent_id, task_id, tokens, at, who) VALUES (?, ?, NULL, 50, ?, 'director')", director.project_id, director.id, db.now());
  db.advanceClock(1000);
  addEvent(agent(director.id), 'result', { ok: true });
  const unknown = task('Before tokens');
  tasks.setTaskState(tasks.getTask(unknown.id)!, 'done', USER);
  db.run('DELETE FROM task_telemetry WHERE task_id = ?', unknown.id);
  db.run("DELETE FROM telemetry_state WHERE key = 'director_turns_attributed'");
  const res = tel.backfillTelemetry();
  assert.ok(res.rows >= 2 && res.attributed >= 1, JSON.stringify(res));
  assert.equal(row(old.id).tokens_directing, 50);
  assert.equal(row(old.id).backfilled, 1);
  assert.equal(row(unknown.id).tokens, null, 'no tokens recorded: unknown, not zero');
  assert.equal(tel.backfillTelemetry().rows, 0, 'idempotent');
});

test('summary, CSV and the director tool: per project, unknown tokens left out, other projects never shown', async () => {
  const a = setup('alpha');
  const b = setup('beta');
  const ta = a.task('Alpha task');
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', ta.id, a.builder.id);
  recordTurnUsage(agent(a.builder.id), mu(1000), 'skilled', 'builder');
  db.advanceClock(30 * MIN);
  tasks.setTaskState(tasks.getTask(ta.id)!, 'done', USER);
  const tb = b.task('Beta secret task');
  db.advanceClock(10 * MIN);
  tasks.setTaskState(tasks.getTask(tb.id)!, 'done', USER);

  const sa = tel.telemetrySummary({ project: a.project.id, period: 'day' });
  const tokens = sa.metrics.find((m) => m.key === 'tokens')!;
  assert.equal(tokens.value, 1000);
  assert.equal(sa.metrics.find((m) => m.key === 'cycle')!.value, 30 * MIN);
  assert.equal(sa.metrics.find((m) => m.key === 'rate')!.value, 2); // one task in 30 min of active time
  assert.equal(sa.chart.labels.length, 14);
  assert.ok(sa.table.some((r) => r.task_id === ta.id) && !sa.table.some((r) => r.task_id === tb.id));
  const sb = tel.telemetrySummary({ project: b.project.id, period: 'week' });
  assert.equal(sb.metrics.find((m) => m.key === 'tokens')!.value, null, 'tokens unknown: no figure');
  assert.equal(sb.chart.labels.length, 8);
  assert.equal(tel.telemetrySummary({ project: a.project.id, mode: 'team' }).metrics.find((m) => m.key === 'cycle')!.n, 0, 'mode filter');

  const csv = tel.telemetryCsv({ project: b.project.id });
  assert.match(csv.split('\r\n')[0], /^task_id,project,title,state,tier,work_mode/);
  assert.ok(csv.includes('Beta secret task') && !csv.includes('Alpha task'));

  const text = await a.call('get_telemetry', {});
  assert.match(text, /Tokens per task: 1k/);
  assert.ok(text.includes(ta.id) && !text.includes(tb.id), 'only its own project');
});

test('day boundaries follow the zone', () => {
  const at = Date.UTC(2026, 10, 19, 5, 0); // 9 pm on Nov 18 in Los Angeles
  assert.equal(tel.dayStart(at, 'America/Los_Angeles'), Date.UTC(2026, 10, 18, 8, 0));
  assert.equal(tel.dayStart(at, 'UTC'), Date.UTC(2026, 10, 19, 0, 0));
  assert.equal(tel.dayStart(Date.UTC(2026, 10, 2, 12), 'America/Los_Angeles', -1), Date.UTC(2026, 10, 1, 7, 0), 'across the DST change');
  assert.equal(tel.unionMs([[0, 10], [5, 20], [30, 40]]), 30);
});

test('the director share counts all of the director\'s tokens, including turns on no task', () => {
  const p = setup('share');
  const t = p.task('Share task');
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', t.id, p.builder.id);
  recordTurnUsage(agent(p.builder.id), mu(2000), 'skilled', 'builder'); // building, on the task
  recordTurnUsage(agent(p.builder.id), mu(1000 + 2000), 'skilled', 'builder', { sub: 500 }); // +1000: 500 building, 500 subagents
  // Director turns: one on the task, three on no task (the user, planning, a batch review).
  recordTurnUsage(agent(p.director.id), mu(400), 'deep', 'director', { task: t.id });
  recordTurnUsage(agent(p.director.id), mu(400 + 3000), 'deep', 'director', { task: null });
  recordTurnUsage(agent(p.director.id), mu(3400 + 2000), 'deep', 'director', { task: null });
  recordTurnUsage(agent(p.director.id), mu(5400 + 1000), 'deep', 'director', { task: null });
  db.advanceClock(5 * MIN);
  tasks.setTaskState(tasks.getTask(t.id)!, 'done', USER);
  const totals = tel.tokenTotals({ project: p.project.id }, 0, db.now() + 1);
  assert.deepEqual(totals, { directing: 6400, building: 2500, subagents: 500, total: 9400 });
  const s = tel.telemetrySummary({ project: p.project.id, period: 'day' });
  const share = s.metrics.find((m) => m.key === 'director')!;
  assert.equal(share.value, 68.1, '6400 of 9400, not the 400 tied to the task');
  assert.equal(share.label, 'Director share of all tokens');
  assert.deepEqual(s.totals, totals);
  // The task's own row keeps what was attributed to it.
  assert.equal(row(t.id).tokens_directing, 400);
  // Another project's tokens are not in it; the tier filter applies.
  assert.equal(tel.tokenTotals({ project: p.project.id, tier: 'deep' }, 0, db.now() + 1).total, 6400);
  assert.match(tel.telemetryText(p.project.id), /Director share of all tokens: 68\.1% \(before –; 9k tokens in all\)/);
  assert.match(tel.telemetryText(p.project.id), /Tokens: 6k directing, 3k building, 500 subagents/);
});
