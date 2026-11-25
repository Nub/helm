import { SCRATCH } from './testenv.ts';
// Builder subagents (subagents.ts): the Agent call check (type, limit, task), rows on the builder's own task, tokens by
// tier, and the overlap rules Helm's dispatch uses (dispatch.ts). `node --test server/subagents.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const sub = await import('./subagents.ts');
const d = await import('./dispatch.ts');
const { setSetting } = await import('./settings.ts');
const { recordTurnUsage } = await import('./usage.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const USER = { author: 'user' as const, name: 'You' };

function setup() {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'fan', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const builder = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  const task = (title: string, state: string, description = `Do ${title}.`) => tasks.createTask(id, { title, state, origin: 'director', description, driver_agent_id: state === 'active' ? builder.id : null } as any, USER);
  const tools = helmTools(builder.id, { send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, 'builder', director.role_id));
  const call = async (n: string, input: Record<string, unknown>) => {
    const r: any = await tools.find((x: any) => x.name === n)!.handler(input, {});
    return { text: r.content[0].text as string, error: !!r.isError };
  };
  return { project, director, builder, task, call };
}
const agent = (id: string) => db.get('SELECT * FROM agents WHERE id = ?', id)!;

test('Agent calls: tier types only, the limit at once, rows on the task, ended by the notification', () => {
  const { builder, task, project } = setup();
  const t = task('Three parts', 'active');
  setSetting(project.id, 'builder_subagents', '3');
  assert.equal(agent(builder.id).task_id, t.id);
  assert.match(sub.agentCallCheck(agent(builder.id), 'tu0', { subagent_type: 'general-purpose', description: 'x', prompt: 'y' })!, /subagent_type/);
  for (const [i, type] of ['light', 'routine', 'skilled'].entries()) assert.equal(sub.agentCallCheck(agent(builder.id), `tu${i + 1}`, { subagent_type: type, description: `Part ${i + 1}`, prompt: 'p' }), null);
  assert.match(sub.agentCallCheck(agent(builder.id), 'tu4', { subagent_type: 'light', description: 'Part 4', prompt: 'p' })!, /limit is 3/);
  const rows = sub.openSubagents(builder.id);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.task_id === t.id));
  // Tokens: each subagent's share on its own row at its tier, the rest the builder's.
  recordTurnUsage(agent(builder.id), { m: { inputTokens: 1000, outputTokens: 0, cacheCreationInputTokens: 0 } }, 'skilled', 'builder', { subagents: rows.map((r) => ({ agent: r, tokens: 200, tier: r.sub_tier })) });
  const byTier = Object.fromEntries(db.all('SELECT tier, SUM(tokens) AS n FROM token_usage WHERE task_id = ? GROUP BY tier', t.id).map((r) => [r.tier, r.n]));
  assert.deepEqual(byTier, { light: 200, routine: 200, skilled: 600 });
  assert.ok(sub.subagentEnded('tu1', 'completed', 'Part 1 done'));
  assert.equal(sub.openSubagents(builder.id).length, 2);
  assert.ok(db.get("SELECT 1 FROM task_messages WHERE task_id = ? AND body LIKE '%Part 1 done%'", t.id));
  setSetting(project.id, 'builder_subagents', '0');
  assert.match(sub.agentCallCheck(agent(builder.id), 'tu5', { subagent_type: 'light', description: 'x', prompt: 'p' })!, /off/);
  sub.endSubagentsOf(builder.id);
  assert.equal(sub.openSubagents(builder.id).length, 0);
});

test('subagent rows never get a session: messages to them are dropped', async () => {
  const { builder, task } = setup();
  task('One part', 'active');
  sub.agentCallCheck(agent(builder.id), 'tz1', { subagent_type: 'light', description: 'Read', prompt: 'p' });
  const row = sub.subagentFor('tz1')!;
  await runtime.sendToAgent(row.id, 'hello', { kind: 'system', name: 'Helm' });
  assert.equal(db.get("SELECT COUNT(*) AS n FROM events WHERE agent_id = ? AND kind = 'inbound'", row.id)?.n, 0);
  sub.recoverSubagents();
  assert.equal(agent(row.id).status, 'closed');
});

test('a subagent row is never an agent elsewhere: limit, areas, list_agents, messages, closing, the progress check; ended, it is closed', async () => {
  const { project, director, builder, task } = setup();
  const t = task('One part', 'active');
  sub.agentCallCheck(agent(builder.id), 'tq1', { subagent_type: 'light', description: 'Read the docs', prompt: 'p' });
  const row = sub.subagentFor('tq1')!;
  assert.equal(row.status, 'working');
  // The project reads Running, and the row is on its task (the card).
  assert.ok(db.get("SELECT 1 FROM agents WHERE project_id = ? AND status = 'working' AND task_id = ?", project.id, t.id));
  // The agent limit: the subagent row is not counted; its builder, between turns with a subagent running, is (busy.ts).
  assert.equal(sub.workingAgents(project.id), agent(builder.id).status === 'idle' ? 1 : db.get("SELECT COUNT(*) AS n FROM agents WHERE id = ? AND status IN ('working','waiting')", builder.id)!.n);
  // The progress check's agents on the task.
  const { agentsOn } = await import('./progress.ts');
  assert.deepEqual(agentsOn(tasks.getTask(t.id)!).map((a) => a.id), [builder.id]);
  // The director's tools.
  const s = structure.defaultStructure();
  const tools = helmTools(director.id, { send: async () => { throw new Error('sent'); }, close: async () => { throw new Error('closed'); }, markComplete: () => {} } as any, toolAccess(s, director.role_id, null));
  const call = async (n: string, input: Record<string, unknown>) => ((await tools.find((x: any) => x.name === n)!.handler(input, {})) as any).content[0].text as string;
  assert.ok(!(await call('list_agents', {})).includes(row.id));
  assert.ok(!(await call('list_agents', { all: true })).includes(row.id));
  assert.match(await call('message_agent', { agent: row.id, message: 'hi' }), /takes no messages/);
  assert.match(await call('close_agent', { agent: row.id }), /ends by itself/);
  // Ended: closed, not done.
  sub.subagentEnded('tq1', 'completed', 'Read.');
  assert.equal(agent(row.id).status, 'closed');
});

test('parallel classification: disjoint files start beside it, overlap waits with the file, a shared Spec entry alone does not block', () => {
  const { builder, task } = setup();
  const own = task('Change the exporter', 'active', 'Edit src/export.ts.');
  const overlap = task('Exporter flags', 'scheduled', 'Also edit src/export.ts.');
  const disjoint = task('Change the logger', 'scheduled', 'Edit src/log.ts.');
  const sameDoc = task('Exporter docs page', 'scheduled', 'Edit web/src/docs.tsx.');
  db.run("UPDATE tasks SET doc_id = 'doc_shared01' WHERE id IN (?, ?)", own.id, sameDoc.id);
  assert.equal(d.overlapRefusal(tasks.getTask(disjoint.id)!, [tasks.getTask(own.id)!]), null);
  assert.match(d.overlapRefusal(tasks.getTask(overlap.id)!, [tasks.getTask(own.id)!])!, /both touch src\/export\.ts: it waits/);
  assert.equal(d.overlapRefusal(tasks.getTask(sameDoc.id)!, [tasks.getTask(own.id)!]), null);
  // The task page's hint says the same.
  assert.equal(d.parallelHint(tasks.getTask(disjoint.id)!), 'Starts with its own builder.');
  assert.equal(d.parallelHint(tasks.getTask(overlap.id)!), `Waits: [[${own.id}]] also touches src/export.ts.`);
  assert.equal(d.parallelHint(tasks.getTask(own.id)!), null, 'only Scheduled tasks get a hint');
});

test('touches: disjoint lists run side by side, overlapping globs wait, broad folders in the text never block, no paths runs alone', async () => {
  const { builder, task, director, project } = setup();
  const own = task('Home page', 'active', 'Rework the home page.');
  sub.setTouches(own.id, ['web/src/home.tsx']);
  void builder;
  const get = (id: string) => tasks.getTask(id);
  // Disjoint touches: alongside.
  const apart = task('Server limits', 'scheduled', 'Limits.');
  const dt = helmTools(director.id, { send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(project.structure ? JSON.parse(project.structure) : structure.defaultStructure(), director.role_id, null));
  const r: any = await dt.find((x: any) => x.name === 'update_task')!.handler({ task: apart.id, touches: ['./server/limits.ts', 'server/limits.ts'] }, {});
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(sub.touchesOf(get(apart.id)!), ['server/limits.ts']);
  assert.equal(d.overlapRefusal(get(apart.id)!, [get(own.id)!]), null);
  // An overlapping glob: serial.
  const glob = task('All the pages', 'scheduled', 'Pages.');
  sub.setTouches(glob.id, ['web/src/*.tsx']);
  assert.match(d.overlapRefusal(get(glob.id)!, [get(own.id)!])!, /both touch web\/src\/\*\.tsx/);
  // No touches: the text's paths, broad folders left out. A bare web/src next to a file still runs alongside...
  const broad = task('Logger', 'scheduled', 'Somewhere in web/src: edit web/src/log.tsx.');
  assert.equal(d.overlapRefusal(get(broad.id)!, [get(own.id)!]), null);
  // ...and a task naming only broad folders names no files: serial, and the hint says to add touches.
  const vague = task('Polish', 'scheduled', 'Polish things in web/src and server.');
  assert.match(d.overlapRefusal(get(vague.id)!, [get(own.id)!])!, /names no files/);
  assert.equal(d.parallelHint(get(vague.id)!), 'Runs alone: no files named. Add touches.');
  assert.ok(sub.pathsOverlap('web/src/home.tsx', 'web/src/*.tsx'));
  assert.ok(sub.pathsOverlap('server/**', 'server/a/b.ts'));
  assert.ok(!sub.pathsOverlap('web/src/*.tsx', 'web/src/sub/x.tsx'));
  assert.ok(!sub.pathsOverlap('server/a.ts', 'server/ab.ts'));
});

test('a subagent row goes to its builder\'s own task, whatever its description names', async () => {
  const { builder, task } = setup();
  const own = task('Own work', 'active', 'Edit src/own.ts.');
  const other = task('Other work', 'scheduled', 'Edit src/other.ts.');
  sub.agentCallCheck(agent(builder.id), 'da1', { subagent_type: 'skilled', description: `${other.id} telemetry`, prompt: 'p', isolation: 'worktree' });
  assert.equal(sub.subagentFor('da1')!.task_id, own.id);
});
