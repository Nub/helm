import { SCRATCH } from './testenv.ts';
// Discussion first (discussions.ts, tools.ts): task_post conclude and the user's Conclude (closes the discussion with
// that text and wakes the director to plan); create_task refused in a turn started by an open discussion's message;
// a director's set_doc changing an entry's meaning needs wording_only or agreed_in. `node --test server/discussfirst.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const { createDiscussion } = await import('./discussions.ts');
const { addEvent } = await import('./store.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const { recordOwnerActivity } = await import('./sessions.ts');

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const USER = { author: 'user' as const, name: 'You' };

function setup() {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'df', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  recordOwnerActivity(id);
  const tools = helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, director.role_id, null));
  const call = async (name: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  const d = createDiscussion(id, { title: 'How should exports work', origin: 'user' }, USER);
  return { project, director, call, d };
}
const inbound = (agentId: string) => db.all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id", agentId).map((e) => String(JSON.parse(e.data).text ?? ''));

test('task_post conclude shows Conclude; tapping it closes the discussion with that text and wakes the director to plan', async () => {
  const { director, call, d } = setup();
  const plain = await call('task_post', { task: d.id, message: 'One thought.' });
  assert.ok(!plain.error);
  const res = await call('task_post', { task: d.id, message: 'Conclusion: exports are CSV, one per day.', conclude: true });
  assert.ok(!res.error, res.text);
  assert.match(res.text, /Conclude button/);
  const line = tasks.taskTimeline(d.id).filter((i) => i.type === 'message');
  assert.equal(line[0].conclude, undefined);
  assert.equal(line[1].conclude.task, d.id);
  // Only an open discussion takes a conclusion.
  const t = tasks.createTask(d.project_id, { title: 'A task', state: 'waiting', origin: 'director' }, USER);
  assert.equal((await call('task_post', { task: t.id, message: 'x', conclude: true })).error, true);

  const before = inbound(director.id).length;
  const r = await app.inject({ method: 'POST', url: `/api/tasks/${d.id}/conclude`, headers: { cookie }, payload: {} });
  assert.equal(r.statusCode, 200, r.body);
  const now = tasks.getTask(d.id)!;
  assert.equal(now.state, 'settled');
  assert.equal(now.conclusion, 'Conclusion: exports are CSV, one per day.');
  const note = inbound(director.id).slice(before).join('\n');
  assert.match(note, new RegExp(`The user concluded \\[\\[${d.id}\\]\\]: plan the work`));
  assert.match(note, /no planning approval/);
  assert.equal(tasks.taskTimeline(d.id).find((i) => i.key === line[1].key)!.conclude, undefined, 'closed: no button');
  const again = await app.inject({ method: 'POST', url: `/api/tasks/${d.id}/conclude`, headers: { cookie }, payload: {} });
  assert.equal(again.statusCode, 400);
});

test('create_task in a turn started by an open discussion is refused; after a result, or once it is closed, it is not', async () => {
  const { director, call, d } = setup();
  addEvent(director, 'inbound', { text: `<discussion-message discussion="${d.id}" title="${d.title}">\nShould we add JSON too?\n</discussion-message>`, from: { kind: 'user', name: 'You' } });
  const refused = await call('create_task', { title: 'JSON exports', description: 'x', state: 'waiting' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /conclude it first/);
  assert.equal(db.get("SELECT 1 AS x FROM tasks WHERE title = 'JSON exports'"), undefined);
  // A later turn started by the user in the main conversation.
  addEvent(director, 'result', { text: 'Answered in the thread.', ok: true });
  addEvent(director, 'inbound', { text: 'Fix the typo on the login page.', from: { kind: 'user', name: 'You' } });
  const ok = await call('create_task', { title: 'Login typo', description: 'x', state: 'waiting' });
  assert.ok(!ok.error, ok.text);
  // A turn started in the discussion after the user closed it: allowed.
  addEvent(director, 'result', { text: '', ok: true });
  addEvent(director, 'inbound', { text: `<discussion-message discussion="${d.id}" title="${d.title}">\nGo.\n</discussion-message>`, from: { kind: 'user', name: 'You' } });
  db.run("UPDATE tasks SET state = 'settled' WHERE id = ?", d.id);
  assert.ok(!(await call('create_task', { title: 'CSV exports', description: 'x', state: 'waiting' })).error);
});

test("a director's set_doc changing an entry's meaning needs wording_only or agreed_in; new entries are unaffected", async () => {
  const { call, d } = setup();
  const made = await call('set_doc', { title: 'Exports', summary: 'Exports are CSV.', body: 'One file per day.', because: 'none' });
  assert.ok(!made.error, made.text);
  const id = /\[\[(doc_[0-9a-f]+)\]\]/.exec(made.text)![1];
  const refused = await call('set_doc', { id, summary: 'Exports are JSON.', because: 'none' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /use propose_doc_edit/);
  assert.equal(db.get('SELECT summary FROM docs WHERE id = ?', id)!.summary, 'Exports are CSV.');
  assert.ok(!(await call('set_doc', { id, body: 'One CSV file per day.', wording_only: true, because: 'none' })).error);
  const agreed = await call('set_doc', { id, summary: 'Exports are JSON.', agreed_in: d.id });
  assert.ok(!agreed.error, agreed.text);
  assert.match(agreed.text, new RegExp(`change from .*\\[\\[${d.id}\\]\\]`));
  assert.equal(db.get('SELECT summary FROM docs WHERE id = ?', id)!.summary, 'Exports are JSON.');
  // Organisation (tags, importance) is not a change of meaning.
  assert.ok(!(await call('set_doc', { id, tags: ['data'], because: 'none' })).error);
});

test('Make a task closes the discussion with the proposed conclusion (else its summary, else the user\'s line) and wakes the director to plan', async () => {
  const { director, call, d } = setup();
  const post = (id: string, body = {}) => app.inject({ method: 'POST', url: `/api/tasks/${id}/make-task`, headers: { cookie }, payload: body });
  // A proposed conclusion: used as the conclusion.
  await call('task_post', { task: d.id, message: 'Conclusion: exports are CSV, one per day.', conclude: true });
  const before = inbound(director.id).length;
  const r = await post(d.id);
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([tasks.getTask(d.id)!.state, tasks.getTask(d.id)!.conclusion], ['settled', 'Conclusion: exports are CSV, one per day.']);
  const note = inbound(director.id).slice(before).join('\n');
  assert.match(note, new RegExp(`The user made a task of \\[\\[${d.id}\\]\\] now: plan it`));
  assert.match(note, /convert to task/);
  assert.equal((await post(d.id)).statusCode, 400, 'already closed');

  // No proposal: the summary is the conclusion.
  const second = createDiscussion(d.project_id, { title: 'Second topic', summary: 'Keep it to one file.', origin: 'user' }, USER);
  assert.equal((await post(second.id)).statusCode, 200);
  assert.equal(tasks.getTask(second.id)!.conclusion, 'Keep it to one file.');

  // Neither: the user's one line is passed to the director and becomes the conclusion.
  const third = createDiscussion(d.project_id, { title: 'Third topic', origin: 'user' }, USER);
  const b3 = inbound(director.id).length;
  assert.equal((await post(third.id, { line: 'Add a JSON export' })).statusCode, 200);
  assert.equal(tasks.getTask(third.id)!.conclusion, 'Add a JSON export');
  assert.match(inbound(director.id).slice(b3).join('\n'), /What the user says the task should do: Add a JSON export/);
});

test('Make a task on a proposed conclusion\'s post does what Conclude did: closes with that text and wakes the director', async () => {
  const { director, call, d } = setup();
  await call('task_post', { task: d.id, message: 'Conclusion: exports are CSV, one per day.', conclude: true });
  await call('task_post', { task: d.id, message: 'Something else.' });
  const mid = tasks.taskTimeline(d.id).find((i) => i.type === 'message' && i.conclude)!.conclude.message;
  const before = inbound(director.id).length;
  const r = await app.inject({ method: 'POST', url: `/api/tasks/${d.id}/make-task`, headers: { cookie }, payload: { message: mid } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual([tasks.getTask(d.id)!.state, tasks.getTask(d.id)!.conclusion], ['settled', 'Conclusion: exports are CSV, one per day.']);
  assert.match(inbound(director.id).slice(before).join('\n'), new RegExp(`made a task of \\[\\[${d.id}\\]\\] now: plan it`));
  const other = createDiscussion(d.project_id, { title: 'No proposal', origin: 'user' }, USER);
  assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${other.id}/make-task`, headers: { cookie }, payload: { message: 999999 } })).statusCode, 400);
});

test('Interject with no message on a running task just stops it: the task pauses and the director is told', async () => {
  const { director, d } = setup();
  const t = tasks.createTask(d.project_id, { title: 'Running', state: 'active', origin: 'user' }, USER);
  const before = inbound(director.id).length;
  const r = await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/message`, headers: { cookie }, payload: { text: '', interject: true } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { ok: true, interject: true, paused: true });
  assert.equal(tasks.getTask(t.id)!.state, 'paused');
  assert.match(inbound(director.id).slice(before).join('\n'), /interrupted/);
  // An empty Send (not Interject) is still refused; with a message, Interject pauses and carries it.
  const t2 = tasks.createTask(d.project_id, { title: 'Running 2', state: 'active', origin: 'user' }, USER);
  assert.equal((await app.inject({ method: 'POST', url: `/api/tasks/${t2.id}/message`, headers: { cookie }, payload: { text: '' } })).statusCode, 400);
  const r2 = await app.inject({ method: 'POST', url: `/api/tasks/${t2.id}/message`, headers: { cookie }, payload: { text: 'Use CSV instead.', interject: true } });
  assert.deepEqual(r2.json(), { ok: true, interject: true, paused: true });
  assert.equal(tasks.getTask(t2.id)!.state, 'paused');
});
