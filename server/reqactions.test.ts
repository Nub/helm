import { SCRATCH } from './testenv.ts';
// A request's inline action (reqactions.ts): attached by ask_user or by Helm, done only when the user answers
// (answers.ts), through the task page's own code. `node --test server/reqactions.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const { answerInbox } = await import('./answers.ts');
const { releaseHeld } = await import('./requests.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const USER = { author: 'user' as const, name: 'You' };
const rt = { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} };

function setup(asWorker = false) {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'ra', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  const me = asWorker ? runtime.createAgent(project, director, structure.roles.find((r) => r.id !== structure.root && !r.canSpawn.length)!, 'Engineer', 'Build it.') : director;
  const tools = helmTools(me.id, rt as any, toolAccess(JSON.parse(project.structure), me.role_id, me.parent_id));
  const call = async (name: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  const task = (state: string) => tasks.createTask(id, { title: `A ${state} task`, state, origin: 'user' }, USER);
  return { project, call, task };
}
/** The newest request, shown: an agent answered earlier is mid-turn, so its requests are held until the turn ends (requests.ts). */
const lastRequest = (projectId: string) => {
  const r = db.get('SELECT * FROM inbox WHERE project_id = ? ORDER BY rowid DESC LIMIT 1', projectId)!;
  if (r.status === 'held') releaseHeld(r.agent_id);
  return db.get('SELECT * FROM inbox WHERE id = ?', r.id)!;
};
const stateOf = (id: string) => tasks.getTask(id)!.state;
const act = (r: any) => JSON.parse(r.payload).act;

test('an attached task action is stored, not done, until the user taps it; then Helm does it and closes the request', async () => {
  const { project, call, task } = setup();
  for (const [kind, from, to, done] of [
    ['approve_task', 'planning', 'scheduled', 'Approved'],
    ['start_task', 'waiting', 'active', 'Started'],
    ['resume_task', 'paused', 'active', 'Resumed'],
  ] as const) {
    const t = task(from);
    const res = await call('ask_user', { title: `Go ahead with ${t.title}?`, question: 'It is ready.', task: t.id, action: { kind } });
    assert.ok(!res.error, res.text);
    const r = lastRequest(project.id);
    assert.deepEqual(act(r), { kind, target: t.id });
    assert.equal(stateOf(t.id), from, 'the agent only attaches it');
    assert.equal(await answerInbox(r.id, { perform: true }), null);
    // Scheduled, or already Active: Helm starts a fresh builder on scheduled work at once (dispatch.ts).
    assert.ok(to === 'scheduled' ? ['scheduled', 'active'].includes(stateOf(t.id)) : stateOf(t.id) === to, stateOf(t.id));
    const after = db.get('SELECT status, answer FROM inbox WHERE id = ?', r.id)!;
    assert.equal(after.status, 'answered');
    assert.match(after.answer, new RegExp(done));
  }
});

test('a tap that cannot be done says why and leaves the request open', async () => {
  const { project, call, task } = setup();
  const t = task('active');
  await call('ask_user', { title: 'Approve it?', question: 'Plan is in.', task: t.id, action: { kind: 'approve_task' } });
  const r = lastRequest(project.id);
  assert.match((await answerInbox(r.id, { perform: true }))!, /This task is Active; Approve applies to/);
  assert.equal(db.get('SELECT status FROM inbox WHERE id = ?', r.id)!.status, 'open');
  // Update now and Restart agents now go through the Helm page's own code: here live update is off, so it says so.
  for (const kind of ['update_helm', 'restart_agents']) {
    await call('ask_user', { title: 'Update Helm', question: 'The release is ready.', action: { kind } });
    const u = lastRequest(project.id);
    assert.deepEqual(act(u), { kind });
    assert.match((await answerInbox(u.id, { perform: true }))!, /Live update is not enabled/);
    assert.equal(db.get('SELECT status FROM inbox WHERE id = ?', u.id)!.status, 'open');
  }
});

test('ask_user refuses an action it cannot aim, and a to-do with an action is Done once it is done', async () => {
  const { project, call, task } = setup();
  assert.match((await call('ask_user', { title: 'Approve?', question: 'x', action: { kind: 'approve_task' } })).text, /acts on the task the request is about/);
  // A target other than the request's task is not taken: the parameter does not exist, and the task is the request's.
  const other = task('planning');
  const own = task('planning');
  await call('ask_user', { title: 'Approve?', question: 'x', task: own.id, action: { kind: 'approve_task', target: other.id } });
  assert.deepEqual(act(lastRequest(project.id)), { kind: 'approve_task', target: own.id });
  const t = task('waiting');
  await call('ask_user', { kind: 'action', title: 'Start it', question: 'Press Start.', task: t.id, action: { kind: 'start_task' } });
  const r = lastRequest(project.id);
  assert.equal(await answerInbox(r.id, { perform: true }), null);
  assert.equal(stateOf(t.id), 'active');
  assert.match(db.get('SELECT answer FROM inbox WHERE id = ?', r.id)!.answer, /^Done — Started/);
});

test('Helm adds Approve to an approve-like option of a question on a Planning task; only that answer approves', async () => {
  const { project, call, task } = setup();
  const t = task('planning');
  await call('ask_user', { title: 'The plan', question: 'Go?', task: t.id, options: [{ label: 'Approve the plan' }, { label: 'Change it' }] });
  const r = lastRequest(project.id);
  assert.deepEqual(act(r), { kind: 'approve_task', target: t.id, option: 'Approve the plan' });
  assert.equal(await answerInbox(r.id, { choice: 'Change it' }), null);
  assert.equal(stateOf(t.id), 'planning', 'another answer does not approve');
  await call('ask_user', { title: 'The plan, again', question: 'Go now?', task: t.id, options: [{ label: 'Approved' }, { label: 'Not yet' }] });
  const again = lastRequest(project.id);
  assert.equal(await answerInbox(again.id, { choice: 'Approved' }), null);
  // Scheduled, or already Active: Helm starts a fresh builder on scheduled work at once (dispatch.ts).
  assert.ok(['scheduled', 'active'].includes(stateOf(t.id)));
  // Not on a task that is past Planning.
  const s = task('scheduled');
  await call('ask_user', { title: 'Approve?', question: 'x', task: s.id, options: [{ label: 'Approve' }] });
  assert.equal(act(lastRequest(project.id)), undefined);
});

test('only the director attaches Update now and Restart agents now', async () => {
  const { call } = setup(true);
  for (const kind of ['update_helm', 'restart_agents']) {
    const res = await call('ask_user', { title: 'Update Helm', question: 'Ready.', action: { kind } });
    assert.ok(res.error);
    assert.match(res.text, /Only the director attaches .*ask your manager/);
  }
});
