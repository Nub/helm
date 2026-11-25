import { SCRATCH } from './testenv.ts';
// Helm's rules as gates (gates.ts) and the status Helm derives (busy.ts toolLine, donewhen.ts taskProgress): each gate
// refuses with what to do and lets the call through once that is done; an agent that never reports shows a line from
// its current tool and a progress from its ticks and worklist. `node --test server/gates.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const { agentView } = await import('./store.ts');
const { setSetting } = await import('./settings.ts');
const { recordOwnerActivity } = await import('./sessions.ts');
const { requestSearchRebuild, buildSearchIndexNow } = await import('./searchindex.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const gates = await import('./gates.ts');

const USER = { author: 'user' as const, name: 'You' };

function setup() {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'gates', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  assert.equal(setSetting(id, 'spec_adherence', 'none'), null);
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  recordOwnerActivity(id);
  const builder = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  const rt = { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any;
  const caller = (agentId: string, role: string, parent: string | null) => {
    const tools = helmTools(agentId, rt, toolAccess(s, role, parent));
    return async (name: string, input: Record<string, unknown>) => {
      const r: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
      return { text: r.content[0].text as string, error: !!r.isError };
    };
  };
  /** An Active task the builder works on. */
  const work = (fields: Record<string, unknown>) => {
    const t = tasks.createTask(id, { title: 'Work', state: 'active', origin: 'director', description: 'x', driver_agent_id: builder.id, ...fields } as any, USER);
    db.run("UPDATE agents SET task_id = ?, status = 'working' WHERE id = ?", t.id, builder.id);
    if (fields.check_how) db.run('UPDATE tasks SET check_how = ? WHERE id = ?', fields.check_how, t.id);
    if (fields.touches) db.run('UPDATE tasks SET touches = ? WHERE id = ?', JSON.stringify(fields.touches), t.id);
    return tasks.getTask(t.id)!;
  };
  let n = 0;
  /** A tool call the agent made (and its result unless open), `ago` ms back. */
  const toolEvent = (agentId: string, name: string, input: Record<string, unknown>, opts: { open?: boolean; ago?: number; error?: boolean } = {}) => {
    const callId = `tu_${++n}_${Date.now()}`;
    const ts = db.now() - (opts.ago ?? 0);
    db.run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES (?,?,?,'tool',?)", id, agentId, ts, JSON.stringify({ id: callId, name, summary: String(input.command ?? input.file_path ?? ''), input: JSON.stringify(input), sub: false }));
    if (!opts.open) db.run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES (?,?,?,'tool_result',?)", id, agentId, ts, JSON.stringify({ id: callId, text: opts.error ? 'Error: ENOENT: no such file or directory, open dist/app.js' : 'ok', error: !!opts.error }));
    return callId;
  };
  return { id, project, director, builder, work, toolEvent, asBuilder: caller(builder.id, 'builder', director.role_id), asDirector: caller(director.id, director.role_id, null) };
}

const DONE = { summary: 'Done.', nothing_to_record: true };

test('complete_task is refused until the named check has run on the task; then it goes', async () => {
  const { builder, work, toolEvent, asBuilder } = setup();
  const t = work({ check_how: 'Run `node --test server/x.test.ts` and `npm run typecheck`.' });
  assert.deepEqual(gates.checkCommands(t.check_how), ['node --test server/x.test.ts', 'npm run typecheck']);
  const r1 = await asBuilder('complete_task', DONE);
  assert.equal(r1.error, true);
  assert.match(r1.text, /Run its check: `node --test server\/x\.test\.ts`, `npm run typecheck`/);
  assert.equal(tasks.getTask(t.id)!.state, 'active');
  // One ran (as part of a chain, beside another suite): only the other is still asked for.
  toolEvent(builder.id, 'Bash', { command: 'cd /w && node --test server/y.test.ts server/x.test.ts' });
  const r2 = await asBuilder('complete_task', DONE);
  assert.equal(r2.error, true);
  assert.doesNotMatch(r2.text, /x\.test/);
  assert.match(r2.text, /npm run typecheck/);
  toolEvent(builder.id, 'Bash', { command: 'npm run typecheck 2>&1 | tail -5' });
  const r3 = await asBuilder('complete_task', DONE);
  assert.equal(r3.error, false, r3.text);
  assert.match(r3.text, /Marked complete/);
});

test('a check that cannot run here passes with check_not_run: the why goes in the thread and on the task', async () => {
  const { work, asBuilder } = setup();
  const t = work({ check_how: 'Run `bash nix/live-update.check.sh <rev>` (40 min, on the build host).' });
  const r1 = await asBuilder('complete_task', DONE);
  assert.equal(r1.error, true);
  assert.match(r1.text, /or pass check_not_run/);
  const r2 = await asBuilder('complete_task', { ...DONE, check_not_run: 'It runs 40 minutes on the build host; the director runs it per batch.' });
  assert.equal(r2.error, false, r2.text);
  assert.equal(tasks.getTask(t.id)!.check_not_run, 'It runs 40 minutes on the build host; the director runs it per batch.');
  assert.ok(db.get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND body LIKE 'Check not run: %'", t.id), 'posted in the thread');
});

test('a check that asks for screenshots, or a UI task, needs a preview posted on the task', async () => {
  const { work, asBuilder } = setup();
  work({ check_how: 'A before/after screenshot at 390 px.' });
  const r1 = await asBuilder('complete_task', DONE);
  assert.equal(r1.error, true);
  assert.match(r1.text, /Post a preview on it .*asks for screenshots/);
  assert.equal((await asBuilder('post_preview', { title: 'After', kind: 'markdown', content: 'shot' })).error, false);
  assert.equal((await asBuilder('complete_task', DONE)).error, false);

  const ui = setup();
  const t = ui.work({ touches: ['web/src/home.tsx', 'server/api.ts'] });
  assert.ok(gates.isUiTask(t));
  const r2 = await ui.asBuilder('complete_task', DONE);
  assert.equal(r2.error, true);
  assert.match(r2.text, /changes the web app \(web\/src\)/);
  await ui.asBuilder('post_preview', { title: 'Home at 390 px', kind: 'markdown', content: 'shot' });
  assert.equal((await ui.asBuilder('complete_task', DONE)).error, false);
});

test('every Done when item is ticked or explained in unmet before complete_task goes', async () => {
  const { work, asBuilder } = setup();
  work({ description: 'Do it.\n\n## Done when\n- the export runs\n- the docs say so\n- a benchmark' });
  const r1 = await asBuilder('complete_task', DONE);
  assert.equal(r1.error, true);
  assert.match(r1.text, /"Done when" items not ticked: 1\. the export runs; 2\. the docs say so; 3\. a benchmark/);
  assert.match(r1.text, /unmet/);
  assert.equal((await asBuilder('report_status', { status: 'Ticking', done_when: [1, 2] })).error, false);
  const r2 = await asBuilder('complete_task', DONE);
  assert.equal(r2.error, true);
  assert.match(r2.text, /3\. a benchmark/);
  assert.doesNotMatch(r2.text, /1\. the export/);
  // An explanation needs its why.
  assert.equal((await asBuilder('complete_task', { ...DONE, unmet: [{ item: 3, why: ' ' }] })).error, true);
  const r3 = await asBuilder('complete_task', { ...DONE, unmet: [{ item: 3, why: 'No benchmark machine here; filed as a follow-up.' }] });
  assert.equal(r3.error, false, r3.text);
});

test('an error got past on the task needs a knowledge note, or no_note_why', async () => {
  const { builder, work, toolEvent, asBuilder } = setup();
  work({});
  toolEvent(builder.id, 'Bash', { command: 'node dist/app.js' }, { error: true });
  toolEvent(builder.id, 'Bash', { command: 'npm run build && node dist/app.js' });
  const r1 = await asBuilder('complete_task', DONE);
  assert.equal(r1.error, true);
  assert.match(r1.text, /You got past "[^"]*ENOENT[^"]*" on this task: record the error and the fix with note_knowledge, or pass no_note_why/);
  const r2 = await asBuilder('complete_task', { ...DONE, no_note_why: 'A typo of mine, nothing the next agent meets.' });
  assert.equal(r2.error, false, r2.text);

  // Or the note itself.
  const again = setup();
  again.work({});
  again.toolEvent(again.builder.id, 'Bash', { command: 'node dist/app.js' }, { error: true });
  again.toolEvent(again.builder.id, 'Bash', { command: 'npm run build && node dist/app.js' });
  assert.equal((await again.asBuilder('complete_task', DONE)).error, true);
  const note = await again.asBuilder('note_knowledge', { topic: 'pitfalls', title: 'Build before running the app', text: 'dist/app.js exists only after `npm run build`.' });
  assert.equal(note.error, false, note.text);
  assert.equal((await again.asBuilder('complete_task', DONE)).error, false);
});

test('a task goes to Scheduled only with what it touches', async () => {
  const { asDirector, id } = setup();
  const r1 = await asDirector('create_task', { title: 'Queue me', description: 'Related past work: none found.', state: 'scheduled' });
  assert.equal(r1.error, true);
  assert.match(r1.text, /lists what it touches: pass touches/);
  assert.equal(db.get('SELECT id FROM tasks WHERE project_id = ? AND title = ?', id, 'Queue me'), undefined);
  const r2 = await asDirector('create_task', { title: 'Queue me', description: 'Related past work: none found.', state: 'scheduled', touches: ['server/x.ts'] });
  assert.equal(r2.error, false, r2.text);
  // update_task to Scheduled: the task's own list counts; without one it is refused until given.
  assert.equal((await asDirector('create_task', { title: 'Later', description: 'none found', state: 'waiting' })).error, false);
  const later = db.get('SELECT id FROM tasks WHERE project_id = ? AND title = ?', id, 'Later')!;
  assert.match((await asDirector('update_task', { task: later.id, state: 'scheduled' })).text, /lists what it touches/);
  assert.equal((await asDirector('update_task', { task: later.id, state: 'scheduled', touches: ['web/src/a.tsx'] })).error, false);
});

test("the director's new task names related past work Helm finds, or says none was found", async () => {
  const { asDirector, id } = setup();
  const prior = tasks.createTask(id, { title: 'Kestrel sync retries forever', description: 'Kestrel sync retries forever on a timeout.', state: 'done', origin: 'user' } as any, USER);
  requestSearchRebuild();
  buildSearchIndexNow();
  const input = { title: 'Kestrel sync timeout', state: 'planning' };
  const r1 = await asDirector('create_task', { ...input, description: 'Kestrel sync gives up too late after a timeout.' });
  assert.equal(r1.error, true);
  assert.match(r1.text, /Name related past work/);
  assert.match(r1.text, new RegExp(`\\[\\[${prior.id}\\]\\]`));
  assert.match(r1.text, /none found/);
  // A quick fix is exempt; a reference or "none found" lets it through.
  assert.equal((await asDirector('create_task', { ...input, description: 'Kestrel sync gives up too late after a timeout. Related past work: none found.' })).error, false);
  assert.equal((await asDirector('create_task', { ...input, title: 'Kestrel sync timeout 2', description: `Kestrel sync gives up too late after a timeout; follows [[${prior.id}]].` })).error, false);
});

test('an agent that never reports shows a line from its current tool, and progress from its ticks and worklist', async () => {
  const { builder, work, toolEvent, asBuilder } = setup();
  const t = work({ description: 'Do it.\n\n## Done when\n- one\n- two' });
  const view = () => agentView(db.get('SELECT * FROM agents WHERE id = ?', builder.id)!);
  // A release build running for three minutes.
  toolEvent(builder.id, 'Bash', { command: 'cd /w && cargo build --release' }, { open: true, ago: 180_000 });
  assert.equal(view().status_line, 'Build in release mode · 3 min');
  assert.equal(tasks.taskView(tasks.getTask(t.id)!).driver.status_line, 'Build in release mode · 3 min');
  // A foreground subagent: what it waits on.
  toolEvent(builder.id, 'Agent', { description: 'Survey the exporters', prompt: 'p', subagent_type: 'light' }, { open: true });
  assert.match(view().status_line, /^Waiting on subagent: Survey the exporters · \d+ s$/);
  // A report_status made after the call started wins; a newer call takes over again.
  db.run('UPDATE agents SET status_at = ? WHERE id = ?', db.now() + 1, builder.id);
  db.run("UPDATE agents SET status_line = 'Reading the exporter code' WHERE id = ?", builder.id);
  assert.equal(view().status_line, 'Reading the exporter code');
  db.run('UPDATE agents SET status_at = ? WHERE id = ?', db.now() - 60_000, builder.id);
  assert.match(view().status_line, /^Waiting on subagent/);

  // Progress: no worklist and no ticks yet is 0 of the Done when list; ticks and a worklist weigh in together.
  assert.equal(view().progress, 0);
  assert.equal((await asBuilder('worklist_set', { items: [{ text: 'a', state: 'done' }, { text: 'b', state: 'done' }] })).error, false);
  assert.equal(view().progress, 50);
  tasks.getTask(t.id);
  assert.equal((await asBuilder('report_status', { status: 'Half there', done_when: [1] })).error, false);
  assert.equal(view().progress, 75);
  assert.equal(tasks.taskView(tasks.getTask(t.id)!).driver.progress, 75);
  // Without a Done when list, the worklist alone.
  const plain = setup();
  plain.work({});
  await plain.asBuilder('worklist_set', { items: [{ text: 'a', state: 'done' }, { text: 'b' }] });
  assert.equal(agentView(db.get('SELECT * FROM agents WHERE id = ?', plain.builder.id)!).progress, 50);
});
