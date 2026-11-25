import { SCRATCH } from './testenv.ts';
// Quiet discussions (discrevisit.ts): 7 quiet days file one reminder; two unanswered (or two Not now) make it stale;
// activity resets; the list's order; Archive hides it from the default list; the batch endpoint.
// `node --test server/discrevisit.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const disc = await import('./discussions.ts');
const rv = await import('./discrevisit.ts');
const { answerInbox: answerRequest } = await import('./answers.ts');

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const USER = { author: 'user' as const, name: 'You' };
const DAY = 86_400_000;

function setup() {
  const pid = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, 'dr', SCRATCH, 'Build', 'auto', JSON.stringify(structure.defaultStructure()), db.now(), db.now());
  const director = runtime.rootAgent(db.get('SELECT * FROM projects WHERE id = ?', pid)!);
  return { pid, director };
}
/** A discussion whose whole history is `daysAgo` old. */
function quiet(pid: string, title: string, daysAgo: number) {
  const d = disc.createDiscussion(pid, { title, origin: 'user' }, USER);
  const at = Date.now() - daysAgo * DAY;
  db.run('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?', at, at, d.id);
  db.run('UPDATE task_messages SET created_at = ? WHERE task_id = ?', at, d.id);
  return tasks.getTask(d.id)!;
}
const reminders = (id: string) => db.all("SELECT * FROM inbox WHERE task_id = ? AND json_extract(payload, '$.revisit') IS NOT NULL ORDER BY created_at", id);
const state = (id: string) => tasks.getTask(id)!.state;

test('7 quiet days file one reminder; a second after another period; unanswered, it goes stale', () => {
  const { pid } = setup();
  const fresh = quiet(pid, 'Fresh', 2);
  const d = quiet(pid, 'Export formats', 8);
  let now = Date.now();
  rv.checkDiscussions(pid, now);
  assert.equal(reminders(fresh.id).length, 0, 'two quiet days: nothing');
  const r1 = reminders(d.id);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].title, 'Revisit "Export formats"?');
  assert.deepEqual(JSON.parse(r1[0].options).map((o: any) => o.label), ['Continue', 'Close', 'Archive', 'Not now']);
  // The reminder itself is not activity: running again files nothing more.
  rv.checkDiscussions(pid, now);
  assert.equal(reminders(d.id).length, 1);
  // A period later, still unanswered: a second reminder replaces it.
  db.run('UPDATE tasks SET revisit_at = ? WHERE id = ?', now - 8 * DAY, d.id);
  rv.checkDiscussions(pid, now);
  const r2 = reminders(d.id);
  assert.deepEqual(r2.map((r) => r.status), ['withdrawn', 'open']);
  assert.equal(state(d.id), 'open');
  // Another period with the second unanswered: stale, and the reminder withdrawn.
  db.run('UPDATE tasks SET revisit_at = ? WHERE id = ?', now - 8 * DAY, d.id);
  rv.checkDiscussions(pid, now);
  assert.equal(state(d.id), 'stale');
  assert.equal(reminders(d.id).at(-1)!.status, 'withdrawn');
});

test('activity resets: a message withdraws the reminder and starts the clock again; a message opens a stale one', () => {
  const { pid } = setup();
  const d = quiet(pid, 'Logging levels', 9);
  rv.checkDiscussions(pid);
  assert.equal(reminders(d.id).length, 1);
  db.run('UPDATE tasks SET revisit_at = revisit_at - 1000 WHERE id = ?', d.id);
  tasks.addTaskMessage(tasks.getTask(d.id)!, USER, 'Still thinking about this.');
  rv.checkDiscussions(pid);
  assert.equal(reminders(d.id)[0].status, 'withdrawn');
  assert.equal(tasks.getTask(d.id)!.revisit_count, 0);
  rv.checkDiscussions(pid);
  assert.equal(reminders(d.id).length, 1, 'no new reminder: it is not quiet any more');
  // Stale, then the user writes in it: open again.
  rv.batchDiscussions(pid, [d.id], 'stale', USER);
  assert.equal(state(d.id), 'stale');
  tasks.addTaskMessage(tasks.getTask(d.id)!, USER, 'Back to this.');
  assert.equal(state(d.id), 'open');
});

test('answers: Not now twice makes it stale; Archive archives; Continue and Close wake the director', async () => {
  const { pid, director } = setup();
  const inbound = () => db.all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id", director.id).map((e) => String(JSON.parse(e.data).text ?? ''));
  const a = quiet(pid, 'A', 8);
  const b = quiet(pid, 'B', 8);
  const c = quiet(pid, 'C', 8);
  rv.checkDiscussions(pid);
  const ask = (d: any) => reminders(d.id).at(-1)!.id;
  assert.equal(await answerRequest(ask(a), { choice: 'Not now' }), null);
  assert.equal(state(a.id), 'open');
  assert.equal(db.all("SELECT 1 FROM request_reminders WHERE request_id = ?", reminders(a.id)[0].id).length, 0, 'not the generic deferral');
  db.run('UPDATE tasks SET revisit_at = ? WHERE id = ?', Date.now() - 8 * DAY, a.id);
  rv.checkDiscussions(pid);
  await answerRequest(ask(a), { choice: 'Not now' });
  assert.equal(state(a.id), 'stale');
  await answerRequest(ask(b), { choice: 'Archive' });
  assert.equal(state(b.id), 'archived');
  const before = inbound().length;
  await answerRequest(ask(c), { choice: 'Continue' });
  assert.match(inbound().slice(before).join('\n'), new RegExp(`continue \\[\\[${c.id}\\]\\].*one-line recap`));
});

test('the list: waiting on the user first, then open by activity, stale, closed; archived hidden unless asked for', async () => {
  const { pid, director } = setup();
  const older = quiet(pid, 'Open, older', 3);
  const newer = quiet(pid, 'Open, newer', 1);
  const waiting = quiet(pid, 'Director asked', 5);
  tasks.addTaskMessage(tasks.getTask(waiting.id)!, { author: 'director', name: 'Director', id: director.id } as any, 'Which format do you want?');
  const stale = quiet(pid, 'Stale one', 1);
  rv.batchDiscussions(pid, [stale.id], 'stale', USER);
  const closed = quiet(pid, 'Closed one', 0);
  rv.batchDiscussions(pid, [closed.id], 'close', USER);
  const archived = quiet(pid, 'Archived one', 0);
  rv.batchDiscussions(pid, [archived.id], 'archive', USER);
  const titles = disc.listDiscussions(pid).map((d) => d.title);
  assert.deepEqual(titles, ['Director asked', 'Open, newer', 'Open, older', 'Stale one', 'Closed one']);
  assert.deepEqual(disc.listDiscussions(pid, { state: 'archived' }).map((d) => d.title), ['Archived one']);
  assert.ok(disc.listDiscussions(pid, { q: 'Archived' }).some((d) => d.id === archived.id), 'a search finds it');
  assert.equal(tasks.getTask(closed.id)!.conclusion, 'Closed in bulk');
  void older;
  void newer;
});

test('the batch endpoint: one call for many; a closed one takes its proposed conclusion', async () => {
  const { pid } = setup();
  const x = quiet(pid, 'X', 1);
  const y = quiet(pid, 'Y', 1);
  tasks.addTaskMessage(tasks.getTask(y.id)!, { author: 'director', name: 'Director' } as any, 'Proposed: CSV only.');
  db.run("UPDATE task_messages SET conclude = 1 WHERE task_id = ? AND body = 'Proposed: CSV only.'", y.id);
  const post = (body: unknown) => app.inject({ method: 'POST', url: `/api/projects/${pid}/discussions/batch`, headers: { cookie }, payload: body as any });
  const r = await post({ ids: [x.id, y.id], action: 'close' });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { changed: 2 });
  assert.deepEqual([tasks.getTask(x.id)!.conclusion, tasks.getTask(y.id)!.conclusion], ['Closed in bulk', 'Proposed: CSV only.']);
  assert.deepEqual((await post({ ids: [x.id, y.id], action: 'reopen' })).json(), { changed: 2 });
  assert.deepEqual([state(x.id), state(y.id)], ['open', 'open']);
  assert.deepEqual((await post({ ids: [x.id], action: 'archive' })).json(), { changed: 1 });
  assert.equal((await post({ ids: [x.id], action: 'explode' })).statusCode, 400);
  assert.equal((await post({ ids: [] })).statusCode, 400);
});
