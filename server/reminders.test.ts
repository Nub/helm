import { SCRATCH } from './testenv.ts';
// "Not now" on a request schedules a reminder that asks again (reminders.ts). `node --test server/reminders.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const rem = await import('./reminders.ts');
const { createRequest, withdrawRequest } = await import('./requests.ts');
const { answerInbox } = await import('./answers.ts');

const MIN = 60_000;
const HOUR = 60 * MIN;
const USER = { author: 'user' as const, name: 'You' };
db.freezeClock();

function setup() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'rem', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const task = tasks.createTask(id, { title: 'Play the parry fix', state: 'active', origin: 'user' }, USER);
  return { project, director, task: tasks.getTask(task.id)! };
}
const todo = (p: any, t: any) =>
  createRequest({ projectId: p.id, agentId: null, kind: 'action', title: 'Play the parry fix and say how it feels', body: 'It needs your hands.', payload: { steps: '1. Build it\n2. Play a duel' }, importance: 3, blocking: false, task: t }).id;
const question = (p: any, t: any, options: unknown[], payload: Record<string, unknown> = {}) =>
  createRequest({ projectId: p.id, agentId: null, kind: 'question', title: 'Which look ships?', body: 'Pick one.', options, payload, importance: 3, blocking: false, task: t }).id;
const session = (p: any, at: number) => db.run('INSERT INTO sessions (id, project_id, started_at, last_activity_at) VALUES (?,?,?,?)', db.newId('ses'), p.id, at, at);
const open = (t: any) => db.all("SELECT * FROM inbox WHERE task_id = ? AND status = 'open' ORDER BY created_at", t.id);
const reminderOf = (id: string) => db.get('SELECT * FROM request_reminders WHERE request_id = ?', id);

test("a to-do answered Can't / not yet is asked again at the next session 3 h or more later, as a new request", async () => {
  const { project, task } = setup();
  const id = todo(project, task);
  const t0 = db.now();
  assert.equal(await answerInbox(id, { choice: "Can't / not yet" }), null);
  assert.equal(db.get('SELECT status FROM inbox WHERE id = ?', id)!.status, 'answered');
  assert.equal(reminderOf(id)!.status, 'pending');
  assert.equal(open(task).length, 0);
  // A session an hour later is too soon; nothing yet.
  session(project, t0 + HOUR);
  db.advanceClock(HOUR);
  assert.equal(await rem.sendDueReminders(), 0);
  // The next one, 4 h later: asked again, the same ask, marked with when it was first asked; the old one stays closed.
  session(project, t0 + 4 * HOUR);
  db.advanceClock(3 * HOUR);
  assert.equal(await rem.sendDueReminders(), 1);
  const [again] = open(task);
  assert.equal(again.title, 'Play the parry fix and say how it feels');
  assert.equal(again.body, 'It needs your hands.');
  const p = JSON.parse(again.payload);
  assert.equal(p.steps, '1. Build it\n2. Play a duel');
  assert.deepEqual(p.asked_again, { root: id, first_at: t0, count: 1 });
  assert.equal(db.get('SELECT status FROM inbox WHERE id = ?', id)!.status, 'answered');
  assert.equal(reminderOf(id)!.status, 'sent');
  assert.equal(await rem.sendDueReminders(), 0, 'once');
});

test('a deferring option (labelled Not now, or marked defer) is asked again with the same options; the user can pick the time', async () => {
  const { project, task } = setup();
  const options = [{ label: 'Ship the warm look' }, { label: 'Not now', detail: 'Ask me again later' }];
  const id = question(project, task, options);
  await answerInbox(id, { choice: 'Not now' });
  const r = reminderOf(id)!;
  assert.equal(rem.setReminder(r.id, 'hour'), null);
  db.advanceClock(59 * MIN);
  assert.equal(await rem.sendDueReminders(), 0);
  db.advanceClock(2 * MIN);
  assert.equal(await rem.sendDueReminders(), 1);
  assert.deepEqual(JSON.parse(open(task)[0].options), options);
  // Marked by the asker, whatever its label; an ordinary option defers nothing.
  const marked = question(project, task, [{ label: 'Wait for the art', defer: true }, { label: 'Go' }]);
  await answerInbox(marked, { choice: 'Wait for the art' });
  assert.equal(reminderOf(marked)!.status, 'pending');
  const plain = question(project, task, [{ label: 'Go' }, { label: 'Stop' }]);
  await answerInbox(plain, { choice: 'Stop' });
  assert.equal(reminderOf(plain), undefined);
  // Don't remind.
  assert.equal(rem.setReminder(reminderOf(marked)!.id, 'never'), null);
  assert.equal(reminderOf(marked)!.status, 'cancelled');
});

test('not asked again when its task is done or the release it would publish is already live; withdrawing cancels it', async () => {
  const a = setup();
  const id = todo(a.project, a.task);
  await answerInbox(id, { choice: "Can't / not yet" });
  rem.setReminder(reminderOf(id)!.id, 'hour');
  tasks.setTaskState(tasks.getTask(a.task.id)!, 'done', USER);
  db.advanceClock(2 * HOUR);
  assert.equal(await rem.sendDueReminders(), 0);
  assert.equal(reminderOf(id)!.status, 'skipped');
  assert.match(reminderOf(id)!.reason, /task is done/);

  const b = setup();
  const rid = db.newId('rel');
  db.run("INSERT INTO releases (id, project_id, version, commit_sha, state, created_at, updated_at) VALUES (?,?,?,?,'ready',?,?)", rid, b.project.id, '1.0.0', 'abc', db.now(), db.now());
  const pub = question(b.project, b.task, [{ label: 'Publish' }, { label: 'Later' }], { act: { kind: 'publish_release', target: rid, option: 'Publish' } });
  await answerInbox(pub, { choice: 'Later' });
  rem.setReminder(reminderOf(pub)!.id, 'hour');
  db.run("UPDATE releases SET state = 'published', published_at = ? WHERE id = ?", db.now(), rid);
  db.advanceClock(2 * HOUR);
  assert.equal(await rem.sendDueReminders(), 0);
  assert.match(reminderOf(pub)!.reason, /already published/);

  const c = setup();
  const w = todo(c.project, c.task);
  await answerInbox(w, { choice: "Can't / not yet" });
  assert.equal(withdrawRequest(w, 'no longer needed'), null);
  assert.equal(reminderOf(w)!.status, 'cancelled');
});

test('deferred three times: the reminders stop', async () => {
  const { project, task } = setup();
  let id = todo(project, task);
  for (let i = 1; i <= 2; i++) {
    await answerInbox(id, { choice: "Can't / not yet" });
    rem.setReminder(reminderOf(id)!.id, 'hour');
    db.advanceClock(2 * HOUR);
    assert.equal(await rem.sendDueReminders(), 1);
    id = open(task)[0].id;
    assert.equal(JSON.parse(open(task)[0].payload).asked_again.count, i);
  }
  await answerInbox(id, { choice: "Can't / not yet" });
  assert.equal(reminderOf(id)!.status, 'stopped');
  db.advanceClock(30 * HOUR);
  session(project, db.now());
  assert.equal(await rem.sendDueReminders(), 0);
  assert.equal(open(task).length, 0);
});
