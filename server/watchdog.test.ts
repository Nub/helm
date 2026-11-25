import { SCRATCH } from './testenv.ts';
// The watchdog (watchdog.ts): an idle Active task with nothing pending wakes its driver after 3 minutes, then the
// director, then is marked Stalled with one request; busy or waiting tasks are left alone; an agent ending a turn
// waiting on the user without a request is re-prompted, and Helm files the request if the next turn still has none.
// `node --test server/watchdog.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
await import('./commands.ts');
const wd = await import('./watchdog.ts');
const { addEvent } = await import('./store.ts');
const { answerInbox } = await import('./answers.ts');
const { checkLine } = await import('./progress.ts');

const sent: { to: string; text: string }[] = [];
wd.setWatchdogHooks({ send: async (to, text) => void sent.push({ to, text }) });

const MIN = 60_000;
db.freezeClock();
const USER = { author: 'user' as const, name: 'You' };

function setup(driver: 'builder' | 'director' = 'builder') {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'wd', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const builder = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder A', 'Build it.');
  const task = tasks.createTask(id, { title: 'Make the thing', state: 'active', origin: 'user' }, USER);
  const drv = driver === 'builder' ? builder : director;
  db.run('UPDATE tasks SET driver_agent_id = ? WHERE id = ?', drv.id, task.id);
  if (driver === 'builder') db.run("UPDATE agents SET task_id = ?, status = 'idle' WHERE id = ?", task.id, builder.id);
  else db.run("UPDATE agents SET status = 'closed' WHERE id = ?", builder.id);
  db.run("UPDATE agents SET status = 'idle' WHERE id = ?", director.id);
  addEvent(db.get('SELECT * FROM agents WHERE id = ?', drv.id)!, 'result', { ok: true, text: 'Turn done.' });
  sent.length = 0;
  return { project, director, builder, drv, task: tasks.getTask(task.id)!, t0: db.now() };
}
const at = (t0: number, ms: number) => db.advanceClock(t0 + ms - db.now());
const watchAt = async (p: any, t0: number, ms: number) => {
  at(t0, ms);
  await wd.watchProject(p.id);
};
const requests = (taskId: string) => db.all("SELECT * FROM inbox WHERE task_id = ? AND kind = 'question' AND status IN ('open', 'held')", taskId);
const notesTo = (id: string) => sent.filter((s) => s.to === id && s.text.includes('kind="watchdog"'));

test('an idle builder with no request: woken at 3 min, then the director told, then Stalled with one request', async () => {
  const { project, director, builder, task, t0 } = setup();
  await watchAt(project, t0, 1 * MIN);
  await watchAt(project, t0, 2 * MIN);
  assert.equal(sent.length, 0, 'not before 3 minutes');
  await watchAt(project, t0, 3 * MIN);
  assert.equal(notesTo(builder.id).length, 1, 'woken at 3 min');
  assert.match(notesTo(builder.id)[0].text, /idle and nothing is waiting: continue, finish with complete_task, or ask the user \(ask_user\)/);
  for (const m of [4, 5]) await watchAt(project, t0, m * MIN);
  assert.equal(notesTo(director.id).length, 0);
  await watchAt(project, t0, 6 * MIN);
  assert.equal(notesTo(director.id).length, 1, 'the director told after the second idle spell');
  assert.match(notesTo(director.id)[0].text, /Last status: .*\nLast message: /);
  for (const m of [7, 8]) await watchAt(project, t0, m * MIN);
  assert.equal(requests(task.id).length, 0);
  await watchAt(project, t0, 9 * MIN);
  const reqs = requests(task.id);
  assert.equal(reqs.length, 1, 'one request at the third spell');
  assert.equal(reqs[0].title, 'Make the thing stalled');
  assert.deepEqual(JSON.parse(reqs[0].options).map((o: any) => o.label), ['Resume', 'Drop']);
  assert.equal(checkLine(tasks.getTask(task.id)!), 'Stalled: idle with nothing pending');
  for (const m of [12, 15, 30]) await watchAt(project, t0, m * MIN);
  assert.equal(db.all("SELECT 1 FROM inbox WHERE task_id = ? AND kind = 'question'", task.id).length, 1, 'never a second request');
  assert.equal(notesTo(builder.id).length, 1);
  // Resume clears the mark and wakes the driver; the count starts again.
  await answerInbox(reqs[0].id, { choice: 'Resume' });
  assert.equal(checkLine(tasks.getTask(task.id)!), null);
  assert.equal(notesTo(builder.id).length, 2);
  assert.match(notesTo(builder.id)[1].text, /The user resumed/);
  // The idle time was counted.
  const w = db.get('SELECT * FROM task_watch WHERE task_id = ?', task.id)!;
  assert.ok(w.idle_ms >= 8 * MIN && w.idle_ms <= 11 * MIN, 'idle until the request (counted by look)');
  assert.ok(w.waiting_ms >= 3 * MIN, 'then waiting on it');
});

test('Drop on the Stalled request drops the task', async () => {
  const { project, task, t0 } = setup();
  for (const m of [1, 3, 6, 9]) await watchAt(project, t0, m * MIN);
  await answerInbox(requests(task.id)[0].id, { choice: 'Drop' });
  assert.equal(tasks.getTask(task.id)!.state, 'dropped');
});

test('a busy agent (a background command running) is never woken; its time counts as busy', async () => {
  const { project, builder, task, t0 } = setup();
  db.run("INSERT INTO running_commands (id, project_id, agent_id, session_agent_id, task_id, command, background, started_at) VALUES (?,?,?,?,?,?,1,?)", 'cmd1', project.id, builder.id, builder.id, task.id, 'npm run build', db.now());
  for (let m = 1; m <= 20; m++) await watchAt(project, t0, m * MIN);
  assert.equal(sent.length, 0);
  const w = db.get('SELECT * FROM task_watch WHERE task_id = ?', task.id)!;
  assert.equal(w.strikes, 0);
  assert.equal(w.busy_ms, 19 * MIN);
  // It ends: the idle spell starts then, not at the builder's last event.
  db.run('UPDATE running_commands SET ended_at = ? WHERE id = ?', db.now(), 'cmd1');
  for (const m of [21, 22]) await watchAt(project, t0, m * MIN);
  assert.equal(sent.length, 0);
  await watchAt(project, t0, 23 * MIN);
  assert.equal(notesTo(builder.id).length, 1);
});

test('mid-turn or waiting on a request is not idle', async () => {
  const { project, builder, task, t0 } = setup();
  db.run("UPDATE agents SET status = 'working' WHERE id = ?", builder.id);
  for (let m = 1; m <= 6; m++) await watchAt(project, t0, m * MIN);
  db.run("UPDATE agents SET status = 'idle' WHERE id = ?", builder.id);
  db.run("INSERT INTO inbox (id, project_id, agent_id, kind, title, body, options, payload, importance, blocking, created_at, task_id, status) VALUES ('in_wd1', ?, ?, 'question', 'Which one?', '', '[]', '{}', 3, 0, ?, ?, 'open')", project.id, builder.id, db.now(), task.id);
  for (let m = 7; m <= 20; m++) await watchAt(project, t0, m * MIN);
  assert.equal(sent.length, 0);
  assert.equal(db.get('SELECT waiting_ms FROM task_watch WHERE task_id = ?', task.id)!.waiting_ms, 13 * MIN);
});

test('movement after a wake clears the count', async () => {
  const { project, director, builder, task, t0 } = setup();
  for (const m of [1, 3]) await watchAt(project, t0, m * MIN);
  assert.equal(notesTo(builder.id).length, 1);
  at(t0, 4 * MIN);
  addEvent(builder, 'tool', { id: 'e1', name: 'Edit', summary: 'server/x.ts' });
  for (const m of [5, 6]) await watchAt(project, t0, m * MIN);
  assert.equal(notesTo(builder.id).length, 1, 'the spell starts again at the edit');
  await watchAt(project, t0, 7 * MIN);
  assert.equal(notesTo(director.id).length, 0, 'it moved: a wake again, not the director');
  assert.equal(notesTo(builder.id).length, 2);
});

test('a task the director drives gets the same check', async () => {
  const { project, director, t0 } = setup('director');
  for (const m of [1, 3]) await watchAt(project, t0, m * MIN);
  assert.equal(notesTo(director.id).length, 1);
  await watchAt(project, t0, 6 * MIN);
  assert.equal(notesTo(director.id).length, 2);
});

test('waiting phrases', () => {
  for (const s of [
    'Both versions are built. Waiting for you to pick one.',
    'Tell me which layout you prefer.',
    'Let me know which one to keep.',
    'Which one should I keep, A or B?',
    'Your call on the colour.',
    'Once you approve it, I will merge.',
    'Should I merge it now?',
  ]) assert.ok(wd.waitingSentence(s), s);
  for (const s of ['Merged and done. Tests pass.', 'Nothing is needed from you.', 'Is the cache warm? Yes, after the first run.', 'Done; no input needed from the user.']) assert.equal(wd.waitingSentence(s), null, s);
});

/** One finished turn of an agent: its inbound message and its result, as runtime.ts records them. */
function turn(agent: any, inbound: string, result: string) {
  addEvent(agent, 'inbound', { text: inbound, from: 'Helm' });
  return addEvent(agent, 'result', { ok: true, text: result });
}

test('an agent ending "waiting for you to pick" with no request is re-prompted; if the next turn ends without one, Helm files it', () => {
  const { builder, task } = setup();
  const text = 'I built two layouts on the branch. Waiting for you to pick one.';
  const note = wd.waitingTurn(builder, text, turn(builder, 'Start.', text));
  assert.ok(note && note.startsWith(wd.WAIT_TAG), 're-prompted');
  assert.match(note!, /Waiting for you to pick one/);
  assert.match(note!, new RegExp(`ask_user \\(task: ${task.id}\\)`));
  assert.equal(requests(task.id).length, 0);
  // The next turn ends still without a request: Helm files it, on the task, marked filed by Helm.
  const after = wd.waitingTurn(builder, 'Okay.', turn(builder, note!, 'Okay.'));
  assert.equal(after, null);
  const reqs = requests(task.id);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].title, 'Waiting for you to pick one.');
  assert.equal(JSON.parse(reqs[0].payload).filed_by_helm, true);
  assert.match(reqs[0].body, /^Filed by Helm: Builder A ended its turn waiting on you/);
});

test('the re-prompt answered with a request, or "nothing needed", files nothing; a request already open means no re-prompt', () => {
  const { project, builder, task } = setup();
  const text = 'Tell me which one to keep.';
  const note = wd.waitingTurn(builder, text, turn(builder, 'Start.', text))!;
  assert.ok(note);
  db.run("INSERT INTO inbox (id, project_id, agent_id, kind, title, body, options, payload, importance, blocking, created_at, task_id, status) VALUES ('in_wd2', ?, ?, 'question', 'Which one?', '', '[]', '{}', 3, 0, ?, ?, 'open')", project.id, builder.id, db.now(), task.id);
  assert.equal(wd.waitingTurn(builder, 'Filed it.', turn(builder, note, 'Filed it.')), null);
  assert.equal(requests(task.id).length, 1, 'only its own request');
  assert.equal(wd.waitingTurn(builder, 'Let me know which one.', turn(builder, 'More.', 'Let me know which one.')), null, 'a request is open');

  const b = setup();
  const n2 = wd.waitingTurn(b.builder, text, turn(b.builder, 'Start.', text))!;
  assert.equal(wd.waitingTurn(b.builder, 'Nothing is needed from the user; carrying on.', turn(b.builder, n2, 'Nothing is needed from the user; carrying on.')), null);
  assert.equal(requests(b.task.id).length, 0);
});

test('a plain finished turn is not re-prompted', () => {
  const { builder } = setup();
  assert.equal(wd.waitingTurn(builder, 'Merged; the check passes.', turn(builder, 'Start.', 'Merged; the check passes.')), null);
});

const ask = (p: any, taskId: string, kind = 'question', payload = '{}') =>
  db.run("INSERT INTO inbox (id, project_id, agent_id, kind, title, body, options, payload, importance, blocking, created_at, task_id, status) VALUES (?, ?, NULL, ?, 'x', '', '[]', ?, 3, 0, ?, ?, 'open')", db.newId('in'), p.id, kind, payload, db.now(), taskId);

test('never idle: a request of any kind on it, an open blocker, or the director asking the user in its thread', async () => {
  // A request of another kind (a Spec edit card's to-do, say).
  const a = setup();
  ask(a.project, a.task.id, 'spec_card');
  for (let m = 1; m <= 12; m++) await watchAt(a.project, a.t0, m * MIN);
  assert.equal(sent.length, 0, 'any open request');
  // An open blocker.
  const b = setup();
  const up = tasks.createTask(b.project.id, { title: 'Upstream', state: 'scheduled', origin: 'user' }, USER);
  db.run('INSERT INTO task_waits (task_id, waits_for, created_at) VALUES (?,?,?)', b.task.id, up.id, db.now());
  for (let m = 1; m <= 12; m++) await watchAt(b.project, b.t0, m * MIN);
  assert.equal(sent.length, 0, 'an open blocker');
  db.run("UPDATE tasks SET state = 'done' WHERE id = ?", up.id);
  for (let m = 13; m <= 16; m++) await watchAt(b.project, b.t0, m * MIN);
  assert.equal(notesTo(b.builder.id).length, 1, 'idle once the blocker is done');
  // The director's own task, its last post a question to the user.
  const c = setup('director');
  tasks.addTaskMessage(c.task, { author: 'director', name: 'Director', id: c.director.id }, 'Two ways to do this. Which one should I take?');
  for (let m = 1; m <= 12; m++) await watchAt(c.project, c.t0, m * MIN);
  assert.equal(notesTo(c.director.id).length, 0, 'waiting on the user in its thread');
});

test('one Stalled request per project lists every stalled task, and is replaced as the list changes', async () => {
  const { project, task, t0 } = setup();
  const two = tasks.createTask(project.id, { title: 'Second thing', state: 'active', origin: 'user' }, USER);
  const b2 = runtime.createAgent(project, runtime.rootAgent(project), structure.defaultStructure().roles.find((r) => r.id === 'builder')!, 'Builder B', 'Build it.');
  db.run('UPDATE tasks SET driver_agent_id = ? WHERE id = ?', b2.id, two.id);
  db.run("UPDATE agents SET task_id = ?, status = 'idle' WHERE id = ?", two.id, b2.id);
  for (const m of [1, 3, 6, 9]) await watchAt(project, t0, m * MIN);
  const stalls = () => db.all("SELECT * FROM inbox WHERE project_id = ? AND payload LIKE '%watchdog_stalls%' ORDER BY created_at, rowid", project.id);
  const open = () => stalls().filter((r) => r.status === 'open');
  assert.equal(stalls().length, 1, 'one request for both');
  assert.equal(open()[0].title, '2 tasks stalled');
  assert.deepEqual(JSON.parse(open()[0].options).map((o: any) => o.label).sort(), ['Drop: Make the thing', 'Drop: Second thing', 'Resume: Make the thing', 'Resume: Second thing']);
  for (const m of [12, 15, 20]) await watchAt(project, t0, m * MIN);
  assert.equal(stalls().length, 1, 'not filed again while nothing changes');
  // Resume one: the request is answered and a new one lists the other.
  await answerInbox(open()[0].id, { choice: 'Resume: Make the thing' });
  assert.equal(open().length, 1);
  assert.equal(open()[0].title, 'Second thing stalled');
  assert.equal(checkLine(tasks.getTask(task.id)!), null);
  // The other moves on its own: the request is withdrawn.
  at(t0, 21 * MIN);
  addEvent(b2, 'tool', { id: 'e2', name: 'Write', summary: 'a.ts' });
  await watchAt(project, t0, 22 * MIN);
  assert.equal(open().length, 0);
  assert.equal(stalls().at(-1)!.status, 'withdrawn');
});

test('a task stalling again within the day goes to the director, not the user', async () => {
  const { project, director, task, t0 } = setup();
  for (const m of [1, 3, 6, 9]) await watchAt(project, t0, m * MIN);
  await answerInbox(requests(task.id)[0].id, { choice: 'Resume' });
  sent.length = 0;
  for (const m of [10, 13, 16, 19]) await watchAt(project, t0, m * MIN);
  assert.equal(requests(task.id).length, 0, 'no second request today');
  assert.equal(checkLine(tasks.getTask(task.id)!), 'Stalled: idle with nothing pending');
  assert.ok(notesTo(director.id).some((n) => /stalled again/.test(n.text)));
});
