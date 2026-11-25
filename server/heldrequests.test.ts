import { SCRATCH } from './testenv.ts';
// Requests reach the user only when finished (requests.ts): held until the agent's turn ends, frozen once shown
// (withdraw or replace), repeats refused, one notification per turn. `node --test server/heldrequests.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const req = await import('./requests.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const { projectState } = await import('./store.ts');

const USER = { author: 'user' as const, name: 'You' };
const notices: string[][] = [];
req.requestNotices.one = (id) => void notices.push([id]);
req.requestNotices.many = (ids) => void notices.push(ids);

function setup() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'held', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  db.run("INSERT INTO project_settings (project_id, key, value, updated_at) VALUES (?, 'spec_adherence', 'none', ?)", id, db.now()); // tests of other rules: no Spec links needed (specadherence.ts)
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id !== structure.root && !r.canSpawn.length)!;
  const a = runtime.createAgent(project, director, role, 'Engineer', 'Build it.');
  const task = tasks.createTask(id, { title: 'Export', state: 'active', origin: 'user' }, USER);
  db.run("UPDATE agents SET task_id = ?, status = 'working' WHERE id = ?", task.id, a.id);
  const tools = helmTools(a.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(structure, a.role_id, a.parent_id));
  const call = async (name: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  notices.length = 0;
  return { project, a, task, call };
}
const idOf = (text: string) => /request (in_[0-9a-f]+)/.exec(text)![1];
const status = (id: string) => db.get('SELECT status FROM inbox WHERE id = ?', id)?.status;

test('held until the turn ends: not shown or notified mid-turn; then all at once, in one notification', async () => {
  const { project, a, task, call } = setup();
  const r1 = await call('ask_user', { title: 'Parquet or CSV?', question: 'Which format should the export use?', options: [{ label: 'Parquet' }, { label: 'CSV' }] });
  assert.match(r1.text, /shown to the user when your turn ends/);
  const r2 = await call('ask_user', { kind: 'action', title: 'Add the bucket key', question: 'The export needs write access.', steps: '1. Open the console\n2. Add the key' });
  const [q, todo] = [idOf(r1.text), idOf(r2.text)];
  assert.equal(status(q), 'held');
  assert.equal(req.openRequests(task.id).length, 0, 'not on the task yet');
  assert.ok(!projectState(project.id)!.inbox.some((i: any) => i.id === q), 'not in what the page reads');
  assert.ok(!tasks.taskTimeline(task.id).some((i) => i.inbox_id === q), 'not in the thread');
  assert.equal(notices.length, 0, 'no notification mid-turn');
  // The turn ends.
  assert.deepEqual(req.releaseHeld(a.id).sort(), [q, todo].sort());
  assert.equal(req.openRequests(task.id).length, 2);
  assert.deepEqual(notices.map((n) => [...n].sort()), [[q, todo].sort()], 'one notification for the turn');
  // Not working: shown at once, as before.
  db.run("UPDATE agents SET status = 'idle' WHERE id = ?", a.id);
  const r3 = await call('ask_user', { title: 'Retention?', question: 'How long to keep exports?' });
  assert.equal(status(idOf(r3.text)), 'open');
  assert.equal(notices.length, 2);
});

test('withdrawn mid-turn: never shown, never notified; a turn cut short is released by the timer', async () => {
  const { a, call } = setup();
  const r = await call('ask_user', { title: 'Old wording', question: 'Which bucket?' });
  const id = idOf(r.text);
  const w = await call('withdraw_request', { request: id, reason: 'Asked badly.' });
  assert.match(w.text, /before the user saw it/);
  assert.equal(status(id), undefined);
  assert.deepEqual(req.releaseHeld(a.id), []);
  assert.equal(notices.length, 0);
  // A process that ended without a result: released once the agent is no longer working.
  const r2 = await call('ask_user', { title: 'Which region?', question: 'Which region should the bucket be in?' });
  assert.equal(req.releaseStale(), 0, 'still working: kept');
  db.run("UPDATE agents SET status = 'error' WHERE id = ?", a.id);
  assert.equal(req.releaseStale(), 1);
  assert.equal(status(idOf(r2.text)), 'open');
});

test('frozen once shown: a repeat is refused; replaces withdraws the old one with a reason in the thread', async () => {
  const { a, task, call } = setup();
  const r = await call('ask_user', { title: 'Parquet or CSV?', question: 'Which format should the export use?' });
  const old = idOf(r.text);
  req.releaseHeld(a.id);
  // The same ask again (same title, or the same text): refused, nothing filed.
  const again = await call('ask_user', { title: 'parquet or csv?', question: 'Something else.' });
  assert.ok(again.error);
  assert.match(again.text, new RegExp(`already open .* replaces "${old}"`));
  const same = await call('ask_user', { title: 'Format', question: 'Which format should the export use?' });
  assert.ok(same.error);
  // Changing it: the new one replaces the old, which is closed as withdrawn (never left beside it).
  const rep = await call('ask_user', { title: 'Parquet or CSV?', question: 'Which format should the export use? Parquet is faster.', replaces: old });
  assert.ok(!rep.error, rep.text);
  assert.equal(status(old), 'withdrawn');
  const tl = tasks.taskTimeline(task.id);
  assert.ok(tl.some((i) => i.inbox_id === old && i.request.status === 'withdrawn' && i.request.answer === 'Replaced by a newer request.'));
  assert.ok(!tl.some((i) => i.key === `a${old}`), 'a withdrawal is not shown as the user\'s answer');
  // Answering a withdrawn one is refused.
  const { answerInbox } = await import('./answers.ts');
  assert.match((await answerInbox(old, { choice: 'Parquet' }))!, /Already answered/);
  // Only the agent's own requests can be withdrawn.
  const other = req.createRequest({ projectId: task.project_id, agentId: null, kind: 'question', title: 'Helm asks', body: 'x', importance: 3, blocking: false, task });
  assert.ok((await call('withdraw_request', { request: other.id, reason: 'no' })).error);
});

test('released after three quiet minutes, even mid-turn; a withdrawal restarts the wait', async () => {
  const { a, call } = setup();
  const r1 = await call('ask_user', { title: 'Bucket region?', question: 'Which region?' });
  db.advanceClock(2 * 60_000);
  const r2 = await call('ask_user', { title: 'Bucket name?', question: 'Which name?' });
  db.advanceClock(2 * 60_000);
  req.releaseQuiet();
  assert.equal(status(idOf(r1.text)), 'held', 'the newest is two minutes old: not yet');
  const r3 = await call('ask_user', { title: 'Scratch', question: 'Not needed.' });
  db.advanceClock(2 * 60_000);
  await call('withdraw_request', { request: idOf(r3.text), reason: 'Not needed.' });
  db.advanceClock(2 * 60_000);
  req.releaseQuiet();
  assert.equal(status(idOf(r1.text)), 'held', 'the withdrawal two minutes ago restarted the wait');
  db.advanceClock(req.QUIET_MS);
  req.releaseQuiet();
  assert.equal(status(idOf(r1.text)), 'open');
  assert.equal(status(idOf(r2.text)), 'open');
  assert.equal(notices.filter((n) => n.includes(idOf(r1.text))).length, 1, 'one notification for both');
  assert.ok(notices.find((n) => n.includes(idOf(r1.text)))!.includes(idOf(r2.text)));
  assert.equal(db.get('SELECT status FROM agents WHERE id = ?', a.id)!.status, 'working', 'still mid-turn');
});

test('created Active with a driver (create_task): the driver files its work under it', async () => {
  const { project, a } = setup();
  const director = db.get('SELECT * FROM agents WHERE project_id = ? AND parent_id IS NULL', project.id)!;
  const dt = helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(defaultStructure(), director.role_id, null));
  const res: any = await dt.find((x: any) => x.name === 'create_task')!.handler({ title: 'Next for the engineer', description: 'x', state: 'active', driver: a.id, origin: 'away', found_because: 'The build broke.', check: 'npm test' }, {});
  assert.ok(!res.isError, res.content[0].text);
  const t = db.get("SELECT id FROM tasks WHERE title = 'Next for the engineer'")!.id;
  assert.equal(db.get('SELECT task_id FROM agents WHERE id = ?', a.id)!.task_id, t);
});

test('permission prompts and agent errors are never held', () => {
  const { a, task } = setup();
  const p = req.createRequest({ projectId: task.project_id, agentId: a.id, kind: 'permission', title: 'Bash', body: 'rm', importance: 4, blocking: true, task });
  const e = req.createRequest({ projectId: task.project_id, agentId: a.id, kind: 'agent_error', title: 'Stopped', body: 'x', importance: 4, blocking: false, task });
  assert.equal(status(p.id), 'open');
  assert.equal(status(e.id), 'open');
  assert.equal(notices.length, 2);
});
