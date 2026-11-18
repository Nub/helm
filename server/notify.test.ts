import { SCRATCH } from './testenv.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** What reaches the phone for each kind of event, against a scratch database, with delivery captured. No Claude process starts. */

process.env.HELM_LIVE_UPDATE_REPO = '/nonexistent';
process.env.HELM_LIVE_UPDATE_DIR = join(SCRATCH, 'live');

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const { createRequest } = await import('./requests.ts');
const notify = await import('./notify.ts');
const sessions = await import('./sessions.ts');
const triage = await import('./triage.ts');
const { LIVE } = await import('./liveupdate.ts');

const sent: import('./notify.ts').Payload[] = [];
notify.setDeliver(async (p) => {
  sent.push(p);
});
notify.timing.gatherMs = 40;
notify.timing.windowMs = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settle = () => sleep(80);
const take = () => sent.splice(0);
const DIRECTOR = { author: 'director' as const, name: 'Director', id: 'x' };

function makeProject(name: string) {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, name, tmpdir(), 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  return { project, director };
}
const reset = (extra: Partial<import('./notify.ts').Settings> = {}) => {
  db.run("DELETE FROM notify_state WHERE key = 'settings'");
  if (Object.keys(extra).length) assert.equal(notify.saveSettings(extra), null);
  notify._internal.resetGroups();
  notify._internal.presence.clear();
  take();
};
const newTask = (pid: string, title: string, state = 'active') => tasks.createTask(pid, { title, state, origin: 'user' }, tasks.USER);

const { project: P, director: D } = makeProject('Alpha');
const { project: Q } = makeProject('Beta');

test('a question reaches the phone: project · title, the question in one line, opens its request', async () => {
  reset();
  const t = newTask(P.id, 'Paint the shed');
  const { id } = createRequest({ projectId: P.id, agentId: D.id, kind: 'question', title: 'Which colour?', body: 'Red or\nblue? Blue is cheaper.', importance: 3, blocking: false, task: t });
  assert.equal(sent.length, 0, 'non-blocking waits a moment for company');
  await settle();
  const [p, ...rest] = take();
  assert.equal(rest.length, 0);
  assert.equal(p.title, 'Alpha · Which colour?');
  assert.equal(p.body, 'Red or blue? Blue is cheaper.');
  // The stable request route; the app resolves it through /api/requests/:id/where to the thread, scrolled to it.
  assert.equal(p.url, `#/p/${P.id}/request/${id}`);
  assert.equal(p.urgent, false);
  assert.ok(p.badge >= 1);
});

test('several requests at once: one notification that opens the project home (it shows them one at a time)', async () => {
  reset();
  const t = newTask(P.id, 'Fence');
  createRequest({ projectId: P.id, agentId: D.id, kind: 'question', title: 'Wood or metal?', body: 'x', importance: 3, blocking: false, task: t });
  createRequest({ projectId: P.id, agentId: D.id, kind: 'question', title: 'How tall?', body: 'x', importance: 3, blocking: false, task: t });
  await settle();
  const [p, ...rest] = take();
  assert.equal(rest.length, 0);
  assert.equal(p.title, 'Alpha · 2 things need you');
  assert.equal(p.url, `#/p/${P.id}`);
});

test('quiet hours end with requests from several projects: the Needs you list', async () => {
  const nowD = new Date();
  const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  reset({ quiet: { start: hhmm(new Date(nowD.getTime() - 3600_000)), end: hhmm(new Date(nowD.getTime() + 3600_000)), tz: 'UTC' } });
  createRequest({ projectId: P.id, agentId: D.id, kind: 'question', title: 'One', body: 'x', importance: 3, blocking: false, task: newTask(P.id, 'In Alpha') });
  const QD = runtime.rootAgent(Q);
  const two = createRequest({ projectId: Q.id, agentId: QD.id, kind: 'question', title: 'Two', body: 'x', importance: 3, blocking: false, task: newTask(Q.id, 'In Beta') });
  await settle();
  assert.equal(take().length, 0, 'held');
  assert.equal(notify.saveSettings({ quiet: null }), null);
  notify.tick();
  await settle();
  const [summary] = take();
  assert.equal(summary.body, '2 requests.');
  assert.equal(summary.url, '#/needs');
  // Beta has nothing waiting for the away-summary test.
  db.run("UPDATE inbox SET status = 'dismissed' WHERE id = ?", two.id);
});

test('a blocking request is sent at once, urgent; a permission request never carries the command', () => {
  reset();
  const t = newTask(P.id, 'Deploy');
  createRequest({ projectId: P.id, agentId: D.id, kind: 'permission', title: 'Director wants to use Bash', body: 'rm -rf secret-dir', payload: { summary: 'cat ~/.ssh/id_rsa' }, importance: 4, blocking: true, task: t });
  const [p] = take();
  assert.equal(p.urgent, true);
  assert.equal(p.title, 'Alpha · Director wants to use Bash');
  assert.doesNotMatch(p.body, /rm -rf|ssh/);
});

test('a permission request the director is deciding stays quiet until it falls to the user', async () => {
  reset();
  const t = newTask(P.id, 'Director first');
  const { id } = createRequest({ projectId: P.id, agentId: D.id, kind: 'permission', title: 'Worker wants to use Bash', body: '', importance: 4, blocking: true, task: t, status: 'director' });
  await settle();
  assert.equal(take().length, 0);
  assert.equal(triage.toUser(id, 'The director did not answer in time.'), true);
  const [p] = take();
  assert.equal(p.title, 'Alpha · Worker wants to use Bash');
  assert.equal(p.urgent, true);
});

test('nothing about an item the user has open and visible; a hidden page does not count', async () => {
  reset();
  const t = newTask(P.id, 'Watched');
  notify.notePresence('c1', `#/p/${P.id}/tasks/${t.id}`, true);
  createRequest({ projectId: P.id, agentId: D.id, kind: 'question', title: 'Seen?', body: 'x', importance: 3, blocking: true, task: t });
  assert.equal(take().length, 0);
  notify.notePresence('c1', `#/p/${P.id}/tasks/${t.id}`, false);
  createRequest({ projectId: P.id, agentId: D.id, kind: 'question', title: 'Seen now?', body: 'x', importance: 3, blocking: true, task: t });
  assert.equal(take().length, 1);
});

test('task finished, and a burst of them collapses into one replacing notification', async () => {
  reset();
  const a = newTask(P.id, 'A');
  tasks.setTaskState(a, 'done', DIRECTOR);
  await settle();
  const [first] = take();
  assert.equal(first.title, 'Alpha · Done: A');
  assert.equal(first.url, `#/p/${P.id}/tasks/${a.id}`);
  for (const n of ['B', 'C']) tasks.setTaskState(newTask(P.id, n), 'done', DIRECTOR);
  await settle();
  const after = take();
  assert.equal(after.length, 1, 'B and C go out together');
  assert.equal(after[0].title, 'Alpha · 3 tasks finished');
  assert.equal(after[0].tag, first.tag, 'same tag: it replaces the first on the phone');
  assert.equal(after[0].url, `#/p/${P.id}/tasks/recent`);
  // After the window a new burst starts with a new tag.
  await sleep(notify.timing.windowMs + 50);
  tasks.setTaskState(newTask(P.id, 'D'), 'done', DIRECTOR);
  await settle();
  const [later] = take();
  assert.equal(later.title, 'Alpha · Done: D');
  assert.notEqual(later.tag, first.tag);
});

test('"only with a result to look at": a task without a preview or new summary stays quiet', async () => {
  reset({ doneMode: 'result' });
  tasks.setTaskState(newTask(P.id, 'Quiet one'), 'done', DIRECTOR);
  await settle();
  assert.equal(take().length, 0);
  const t = newTask(P.id, 'With summary');
  await sleep(5);
  tasks.setTaskSummary(t, 'Shipped; screenshots attached.', DIRECTOR);
  tasks.setTaskState(tasks.getTask(t.id)!, 'done', DIRECTOR);
  await settle();
  const [p] = take();
  assert.equal(p.title, 'Alpha · Done: With summary');
  assert.equal(p.body, 'Shipped; screenshots attached.');
});

test('per-project and per-kind switches, and the global mute', async () => {
  reset({ projects: { [Q.id]: { off: true } } });
  tasks.setTaskState(newTask(Q.id, 'Muted project'), 'done', DIRECTOR);
  tasks.setTaskState(newTask(P.id, 'Loud project'), 'done', DIRECTOR);
  await settle();
  assert.deepEqual(take().map((p) => p.title), ['Alpha · Done: Loud project']);

  reset({ kinds: { needs: true, done: false, away: true, update: false, agent: false, disk: true }, projects: { [Q.id]: { kinds: { done: true } } } });
  tasks.setTaskState(newTask(P.id, 'Off by default'), 'done', DIRECTOR);
  tasks.setTaskState(newTask(Q.id, 'On for Beta'), 'done', DIRECTOR);
  await settle();
  assert.deepEqual(take().map((p) => p.title), ['Beta · Done: On for Beta']);

  reset({ muted: true });
  const t = newTask(P.id, 'Muted');
  createRequest({ projectId: P.id, agentId: D.id, kind: 'question', title: 'Muted?', body: 'x', importance: 3, blocking: true, task: t });
  tasks.setTaskState(t, 'done', DIRECTOR);
  await settle();
  assert.equal(take().length, 0);
});

test('quiet hours hold everything but blocking requests, then send one summary', async () => {
  const hhmm = (d: Date) => d.toISOString().slice(11, 16);
  const nowD = new Date();
  reset({ quiet: { start: hhmm(new Date(nowD.getTime() - 3600_000)), end: hhmm(new Date(nowD.getTime() + 3600_000)), tz: 'UTC' } });
  assert.equal(notify.inQuietHours(notify.getSettings()), true);
  notify.tick();
  const t = newTask(P.id, 'Night work');
  tasks.setTaskState(t, 'done', DIRECTOR);
  createRequest({ projectId: P.id, agentId: D.id, kind: 'question', title: 'Can wait?', body: 'x', importance: 3, blocking: false, task: t });
  createRequest({ projectId: P.id, agentId: D.id, kind: 'question', title: 'Urgent', body: 'x', importance: 3, blocking: true, task: t });
  await settle();
  assert.deepEqual(take().map((p) => p.title), ['Alpha · Urgent']);
  // What is held is in the database, so a restart or an update during quiet hours keeps it.
  assert.equal(notify._internal.held().length, 2);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM notify_held')!.n, 2);
  // Quiet hours end.
  assert.equal(notify.saveSettings({ quiet: null }), null);
  notify.tick();
  await settle();
  const [summary, ...rest] = take();
  assert.equal(rest.length, 0);
  assert.equal(notify._internal.held().length, 0, 'sent once, then cleared');
  assert.equal(summary.title, 'While quiet hours were on');
  assert.equal(summary.body, '1 task finished, 1 request.');
  assert.equal(summary.url, `#/p/${P.id}`, 'requests from one project: its home');
  // Overnight ranges wrap midnight.
  assert.equal(notify.inQuietHours({ ...notify.DEFAULT_SETTINGS, quiet: { start: '22:00', end: '07:00', tz: 'UTC' } }, Date.parse('2026-01-01T23:30:00Z')), true);
  assert.equal(notify.inQuietHours({ ...notify.DEFAULT_SETTINGS, quiet: { start: '22:00', end: '07:00', tz: 'UTC' } }, Date.parse('2026-01-01T12:00:00Z')), false);
  assert.equal(notify.inQuietHours({ ...notify.DEFAULT_SETTINGS, quiet: { start: '22:00', end: '07:00', tz: 'America/Los_Angeles' } }, Date.parse('2026-01-01T07:00:00Z')), true, '23:00 in LA');
});

test('a plan to approve is notified when the director first writes it, not when the task enters Planning', async () => {
  reset();
  const mine = tasks.createTask(P.id, { title: 'Mine', state: 'planning', origin: 'user' }, tasks.USER);
  const t = tasks.createTask(P.id, { title: 'Refactor', state: 'planning', origin: 'director' }, DIRECTOR);
  await settle();
  assert.equal(take().length, 0, 'nothing to read yet');
  tasks.addTaskMessage(t, tasks.USER, 'What would you change?');
  await settle();
  assert.equal(take().length, 0, "the user's own message is not a plan");
  tasks.addTaskMessage(t, DIRECTOR, 'Plan:\n1. Split the module.\n2. Move the tests.');
  await settle();
  const [p, ...rest] = take();
  assert.equal(rest.length, 0);
  assert.equal(p.title, 'Alpha · Plan to approve: Refactor');
  assert.equal(p.body, 'Plan: 1. Split the module. 2. Move the tests.');
  assert.equal(p.url, `#/p/${P.id}/tasks/${t.id}`);
  tasks.addTaskMessage(t, DIRECTOR, 'Revised plan.');
  tasks.setTaskSummary(tasks.getTask(t.id)!, 'Plan revised.', DIRECTOR);
  await settle();
  assert.equal(take().length, 0, 'once per task');
  // A planning task the user created: the director's status summary is its plan. (A new burst, for a clear title.)
  notify._internal.resetGroups();
  tasks.setTaskSummary(mine, 'Plan: add a settings page.', DIRECTOR);
  await settle();
  assert.deepEqual(take().map((x) => x.title), ['Alpha · Plan to approve: Mine']);
  // Not in Planning: a post is just a post.
  tasks.addTaskMessage(newTask(P.id, 'Active one'), DIRECTOR, 'Progress.');
  await settle();
  assert.equal(take().length, 0);
});

test('away summary: the queue worked through while the user is away (sessions), once per away period', async () => {
  reset();
  db.run("UPDATE agents SET status = 'idle'");
  db.run("UPDATE tasks SET state = 'done' WHERE state IN ('scheduled')");
  // The user's last session in Beta has just ended: they are away from now.
  const ended = Date.now();
  await sleep(5);
  const sesId = db.newId('ses');
  db.run("INSERT INTO sessions (id, project_id, started_at, last_activity_at, ended_at, ended_reason, actions) VALUES (?,?,?,?,?,'idle',1)", sesId, Q.id, ended - 600_000, ended, ended);
  notify.tick();
  notify.tick();
  await settle();
  assert.equal(take().length, 0, 'nothing finished while away yet');
  tasks.setTaskState(newTask(Q.id, 'Overnight'), 'done', DIRECTOR);
  await settle();
  take();
  notify.tick();
  await settle();
  assert.equal(take().length, 0, 'one quiet check is not enough');
  notify.tick();
  await settle();
  const away = take();
  assert.deepEqual(away.map((p) => p.title), ['Beta · Work has stopped while you were away']);
  assert.equal(away[0].body, '1 task finished, nothing waits on you.');
  // History, at this away period (its id is away_<the session it follows>).
  assert.equal(away[0].url, `#/p/${Q.id}/history/away_${sesId}`);
  notify.tick();
  notify.tick();
  await settle();
  assert.equal(take().length, 0, 'not again in the same away period');
  // Back: a session opens; finishing work while they are here sends no away summary.
  sessions.recordOwnerActivity(Q.id);
  tasks.setTaskState(newTask(Q.id, 'Daytime'), 'done', DIRECTOR);
  await settle();
  take();
  notify.tick();
  notify.tick();
  await settle();
  assert.equal(take().length, 0);
  // Away again, and something finishes: a new summary.
  db.run('UPDATE sessions SET ended_at = ?, last_activity_at = ? WHERE project_id = ? AND ended_at IS NULL', Date.now(), Date.now(), Q.id);
  await sleep(5);
  tasks.setTaskState(newTask(Q.id, 'Evening'), 'done', DIRECTOR);
  await settle();
  take();
  notify.tick();
  notify.tick();
  await settle();
  assert.deepEqual(take().map((p) => p.body), ['1 task finished, nothing waits on you.']);
});

test('stalled and failed agents, and the update result: off by default, on when switched on', async () => {
  reset();
  const { director: A } = makeProject('Gamma');
  db.run("UPDATE agents SET status = 'working', updated_at = ? WHERE id = ?", Date.now() - 3600_000, A.id);
  notify.tick();
  await settle();
  assert.equal(take().length, 0);

  reset({ kinds: { needs: true, done: true, away: false, update: true, agent: true, disk: true } });
  db.run("UPDATE agents SET status = 'working', updated_at = ? WHERE id = ?", Date.now() - 3600_000, A.id);
  notify.tick();
  await settle();
  assert.deepEqual(take().map((p) => p.title), ['Gamma · Director seems stalled']);
  notify.tick();
  await settle();
  assert.equal(take().length, 0, 'once per stall');

  notify.notifyAgentFailed(db.get('SELECT * FROM agents WHERE id = ?', A.id)!);
  await settle();
  const [failed] = take();
  // Within a minute of the stall notice, it replaces that one with a count.
  assert.equal(failed.title, 'Gamma · 2 agent problems');
  assert.equal(failed.url, `#/p/${A.project_id}/agents`);

  assert.ok(LIVE.dir.startsWith(SCRATCH), 'the update status file is the scratch one');
  mkdirSync(LIVE.dir, { recursive: true });
  writeFileSync(join(LIVE.dir, 'status.json'), JSON.stringify({ id: 'u1', kind: 'update', stage: 'healthy', message: 'Healthy.', log: 'secret log', fromRev: 'a'.repeat(40), toRev: 'b'.repeat(40), startedAt: Date.now(), updatedAt: Date.now() }));
  notify.tick();
  await settle();
  const [upd] = take();
  assert.equal(upd.title, 'Helm updated to bbbbbbb');
  assert.equal(upd.url, '#/helm');
  notify.tick();
  await settle();
  assert.equal(take().length, 0, 'each update once');
  db.run("UPDATE agents SET status = 'idle'");
});

test('settings are validated', () => {
  assert.match(notify.saveSettings({ quiet: { start: '25:00', end: '07:00', tz: 'UTC' } })!, /HH:MM/);
  assert.match(notify.saveSettings({ quiet: { start: '22:00', end: '07:00', tz: 'Mars/Base' } })!, /time zone/);
  assert.equal(notify.saveSettings({ projects: { nope: { off: true } } }), null);
  assert.equal(notify.getSettings().projects.nope, undefined);
});

test('tests never write an update directory, and a server writes only its own', async () => {
  const lu = await import('./liveupdate.ts');
  assert.equal(lu.liveOwned(), true, 'the scratch live dir is inside the scratch HELM_DATA');
  assert.equal(lu.liveWritable(), false, 'NODE_ENV=test');
  assert.match((await lu.startLiveUpdate('update'))!, /not inside its data directory/);
});
