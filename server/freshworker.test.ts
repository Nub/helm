import { SCRATCH } from './testenv.ts';
// The brief (freshworker.ts) a fresh builder gets (dispatch.ts), and task_telemetry.ran_fresh with get_telemetry's
// split by it (telemetry.ts). `node --test server/freshworker.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const dispatch = await import('./dispatch.ts');
const fw = await import('./freshworker.ts');
const tel = await import('./telemetry.ts');
const { writeNote } = await import('./knowledge.ts');
const { setTouches } = await import('./subagents.ts');
const { setSetting } = await import('./settings.ts');
const { requestSearchRebuild, buildSearchIndexNow } = await import('./searchindex.ts');

const USER = { author: 'user' as const, name: 'You' };

function setup() {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'fresh', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  db.run("INSERT INTO project_settings (project_id, key, value, updated_at) VALUES (?, 'spec_adherence', 'none', ?)", id, db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const builder = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  const task = (title: string, state: string, description = `Do ${title}.`, extra: Record<string, unknown> = {}) => tasks.createTask(id, { title, state, origin: 'director', description, ...extra } as any, USER);
  return { project, builder, task };
}
const agent = (id: string) => db.get('SELECT * FROM agents WHERE id = ?', id)!;
const inbound = (agentId: string) => db.all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id", agentId).map((e) => String(JSON.parse(e.data).text ?? ''));

test('the brief: description with Done when, touches, its Spec entry, a knowledge note, related past work, the check, the rules; in a fresh builder\'s first message', async () => {
  const { project, builder, task } = setup();
  setSetting(project.id, 'builder_subagents', '2');
  const past = task('Parquet exporter writes the schema twice', 'done', 'The parquet exporter in export/parquet.ts flushes the schema on every batch.');
  const doc = db.newId('doc');
  db.run("INSERT INTO docs (id, project_id, kind, title, summary, body, created_at, updated_at) VALUES (?, ?, 'entry', 'Weekly export', 'Analysts get one parquet file per week.', '', ?, ?)", doc, project.id, db.now(), db.now());
  const note = writeNote(project.id, { name: 'You', agentId: null }, { topic: 'Exporter', title: 'Parquet exporter flushes', text: 'The parquet exporter keeps the schema in export/schema.ts.', paths: [] }, { agent: false });
  assert.ok(!('error' in note), JSON.stringify(note));
  requestSearchRebuild();
  buildSearchIndexNow();
  const own = task('Own task', 'active', 'Edit server/own.ts.', { driver_agent_id: builder.id });
  db.run("UPDATE agents SET task_id = ?, status = 'working' WHERE id = ?", own.id, builder.id);
  const t = task('Parquet exporter schema flush', 'scheduled', '## Features\n- The parquet exporter flushes the schema once per file.\n\n## Done when\n- export/parquet.ts writes one schema per file', { doc_id: doc });
  setTouches(t.id, ['export/parquet.ts']);
  db.run("UPDATE tasks SET check_how = 'npm test -- export' WHERE id = ?", t.id);
  const brief = fw.workerBrief(tasks.getTask(t.id)!);
  for (const part of [fw.BRIEF_START, `Task ${t.id}`, '## Done when', 'Touches: export/parquet.ts', 'Weekly export: Analysts get one parquet file per week.', 'Parquet exporter flushes', `[[${past.id}]]`, 'Check: npm test -- export', 'report the evidence and your recommendation', fw.BRIEF_END]) {
    assert.ok(brief.includes(part), `${part}\n---\n${brief}`);
  }
  // A fresh builder's first message carries the same brief, with the builder's rules.
  const [fresh] = await dispatch.dispatchProject(project.id);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fresh.task_id, t.id);
  const msg = inbound(fresh.id)[0];
  assert.ok(msg.includes(fw.workerBrief(tasks.getTask(t.id)!, dispatch.BUILDER_RULES)), msg);
  assert.match(msg, /^You are Builder A./);
  assert.equal(agent(builder.id).task_id, own.id, 'the standing Builder is not given it');
});

test('ran_fresh: 1 for a task a fresh builder built, 0 for the standing Builder\'s; kept on refresh; get_telemetry splits by it', () => {
  const { project, builder, task } = setup();
  const own = task('Own work', 'active', 'Edit server/a.ts.', { driver_agent_id: builder.id });
  const freshId = db.newId('ag');
  db.run("INSERT INTO agents (id, project_id, parent_id, role_id, name, model, task, status, created_at, updated_at, per_task) VALUES (?,?,?,'builder','Builder A','','','working',?,?,1)", freshId, project.id, builder.parent_id, db.now(), db.now());
  const along = task('Fresh work', 'active', 'Edit server/b.ts.', { driver_agent_id: freshId });
  db.run("UPDATE agents SET task_id = ? WHERE id = ?", own.id, builder.id);
  const sub = db.newId('ag');
  db.run("INSERT INTO agents (id, project_id, parent_id, role_id, name, model, task, status, created_at, updated_at, task_id) VALUES (?,?,?,?,?,?,?,'closed',?,?,?)", sub, project.id, freshId, 'subagent', 'Skilled subagent: b', '', '', db.now(), db.now(), along.id);
  db.run("INSERT INTO token_usage (project_id, agent_id, task_id, tokens, at, who, tier) VALUES (?,?,?,?,?,?,?)", project.id, sub, along.id, 1000, db.now(), 'subagent', 'skilled');
  db.run("INSERT INTO token_usage (project_id, agent_id, task_id, tokens, at, who, tier) VALUES (?,?,?,?,?,?,?)", project.id, builder.id, own.id, 5000, db.now(), 'builder', 'skilled');
  tasks.setTaskState(tasks.getTask(along.id)!, 'done', USER, 'merged');
  tasks.setTaskState(tasks.getTask(own.id)!, 'done', USER, 'done');
  const row = (id: string) => db.get('SELECT ran_fresh, tokens FROM task_telemetry WHERE task_id = ?', id)!;
  assert.equal(row(along.id).ran_fresh, 1);
  assert.equal(row(own.id).ran_fresh, 0);
  // A later refresh (the builder now on another task) keeps how it ran.
  db.run('UPDATE agents SET task_id = NULL WHERE id = ?', builder.id);
  tel.refreshTaskTelemetry(own.id);
  assert.equal(row(own.id).ran_fresh, 0);
  const split = tel.freshSplit({ project: project.id }, 0, Number.MAX_SAFE_INTEGER);
  assert.deepEqual([split.fresh.n, split.fresh.tokens, split.own.n, split.own.tokens], [1, 1000, 1, 5000]);
  const text = tel.telemetryText(project.id);
  assert.match(text, /Fresh builders: 1 task, 1k tokens per task, median work .*Standing Builder: 1 task, 5k tokens per task/);
  assert.match(tel.telemetryCsv({ project: project.id }).split('\r\n')[0], /ran_fresh/);
});
