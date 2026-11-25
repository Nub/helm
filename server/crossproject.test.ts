import { SCRATCH } from './testenv.ts';
// Directors across projects (crossproject.ts): message_project makes a discussion in the target and wakes its director;
// replies come back into the same pair; a work request files one user request and nothing reaches the target until
// Allow; Decline tells the sender; create_task naming another project is refused. `node --test server/crossproject.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const { answerInbox } = await import('./answers.ts');
const { discussionView } = await import('./discussions.ts');

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];

function project(name: string) {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, name, SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const p = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(p);
  const tools = helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, director.role_id, null));
  const call = async (tool: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === tool)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  return { p, director, call };
}

const inbound = (agentId: string) => db.all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id", agentId).map((e) => String(JSON.parse(e.data).text ?? ''));
// Not the standing "Requests from" holders (a director's process failing in the test runtime files one).
const discussions = (projectId: string) => db.all("SELECT * FROM tasks WHERE project_id = ? AND kind = 'discussion' AND requests_agent_id IS NULL", projectId);
const tasksOf = (projectId: string) => db.all("SELECT * FROM tasks WHERE project_id = ? AND kind = 'task'", projectId);
const thread = (taskId: string) => db.all('SELECT author, author_name, kind, body FROM task_messages WHERE task_id = ? ORDER BY id', taskId);
const state = async (projectId: string) => (await app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: { cookie } })).json();

test('a message makes a discussion in the target, wakes its director, and the reply comes back into the same pair', async () => {
  const a = project('Alpha');
  const b = project('Bravo');
  const before = inbound(b.director.id).length;
  const sent = await a.call('message_project', { project: 'bravo', subject: 'How do you build the Windows zip?', message: 'Which command makes your Windows zip?' });
  assert.equal(sent.error, false, sent.text);

  // The target has a discussion titled with the subject, marked From Alpha, holding the message.
  const [bSide] = discussions(b.p.id);
  assert.equal(bSide.title, 'How do you build the Windows zip?');
  assert.equal(bSide.status_summary, 'From Alpha');
  assert.ok(thread(bSide.id).some((m) => m.author === 'project' && m.author_name === 'Alpha director' && /Windows zip/.test(m.body)));
  assert.equal(discussionView(bSide).peer?.from, true);
  // Its director was woken with it.
  const woke = inbound(b.director.id).slice(before).join('\n');
  assert.match(woke, new RegExp(`<project-message discussion="${bSide.id}"[^>]*from="Alpha"`));
  // The sender keeps its own side with its message.
  const [aSide] = discussions(a.p.id);
  assert.ok(thread(aSide.id).some((m) => m.author === 'director' && /Windows zip/.test(m.body)));

  // Unread on the target's Home until the user opens it.
  assert.deepEqual((await state(b.p.id)).xthreads.map((t: any) => t.id), [bSide.id]);
  await app.inject({ method: 'GET', url: `/api/tasks/${bSide.id}`, headers: { cookie } });
  assert.deepEqual((await state(b.p.id)).xthreads, []);

  // The reply goes back into Alpha's side, wakes Alpha's director, and shows there as unread.
  const aBefore = inbound(a.director.id).length;
  const reply = await b.call('message_project', { project: 'Alpha', subject: 'ignored when replying', reply_to: bSide.id, message: 'npm run zip:win' });
  assert.equal(reply.error, false, reply.text);
  assert.equal(discussions(a.p.id).length, 1);
  assert.equal(discussions(b.p.id).length, 1);
  assert.ok(thread(aSide.id).some((m) => m.author === 'project' && /zip:win/.test(m.body)));
  assert.match(inbound(a.director.id).slice(aBefore).join('\n'), new RegExp(`<project-message discussion="${aSide.id}"`));
  assert.deepEqual((await state(a.p.id)).xthreads.map((t: any) => t.peer), ['Bravo']);
  // A message never makes the sender's side wait on the user.
  assert.equal(discussionView(discussions(a.p.id)[0]).awaiting, false);

  // A second message on the same subject joins the pair.
  await a.call('message_project', { project: b.p.id, subject: 'How do you build the Windows zip?', message: 'Thanks.' });
  assert.equal(discussions(b.p.id).length, 1);
});

test('a work request files one user request; nothing reaches the target until Allow', async () => {
  const a = project('Charlie');
  const b = project('Delta');
  const before = inbound(b.director.id).length;
  const noWhy = await a.call('message_project', { project: 'Delta', subject: 'Ship a Linux build', message: 'Please add a Linux build task.', work: true });
  assert.equal(noWhy.error, true);
  const res = await a.call('message_project', { project: 'Delta', subject: 'Ship a Linux build', message: 'Please add a Linux build task.', work: true, why: 'Our installer needs it.' });
  assert.equal(res.error, false, res.text);

  // One request, on the sender's side, naming both projects, with Allow and Decline.
  const reqs = db.all("SELECT * FROM inbox WHERE project_id IN (?, ?) AND payload LIKE '%xwork%'", a.p.id, b.p.id);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].project_id, a.p.id);
  assert.match(reqs[0].title, /Charlie asks Delta/);
  assert.deepEqual(JSON.parse(reqs[0].options).map((o: any) => o.label), ['Allow', 'Decline']);
  // Nothing in the target: no discussion, no task, no wake.
  assert.equal(discussions(b.p.id).length, 0);
  assert.equal(tasksOf(b.p.id).length, 0);
  assert.equal(inbound(b.director.id).length, before);

  // Allow: delivered marked work="allowed", and the sender is told.
  db.run("UPDATE inbox SET status = 'open' WHERE id = ?", reqs[0].id);
  const aBefore = inbound(a.director.id).length;
  assert.equal(await answerInbox(reqs[0].id, { choice: 'Allow' }), null);
  const [bSide] = discussions(b.p.id);
  assert.ok(bSide);
  assert.match(inbound(b.director.id).slice(before).join('\n'), /<project-message [^>]*work="allowed"/);
  assert.match(inbound(a.director.id).slice(aBefore).join('\n'), /Allow[\s\S]*Sent to Delta's director/);
});

test('Decline tells the sender and sends nothing', async () => {
  const a = project('Echo');
  const b = project('Foxtrot');
  const before = inbound(b.director.id).length;
  await a.call('message_project', { project: 'Foxtrot', subject: 'Change your API', message: 'Rename /v1 to /v2.', work: true, why: 'We migrate.' });
  const req = db.get("SELECT * FROM inbox WHERE project_id = ? AND payload LIKE '%xwork%'", a.p.id)!;
  db.run("UPDATE inbox SET status = 'open' WHERE id = ?", req.id);
  const aBefore = inbound(a.director.id).length;
  assert.equal(await answerInbox(req.id, { choice: 'Decline' }), null);
  assert.match(inbound(a.director.id).slice(aBefore).join('\n'), /<user-answer[^>]*>\nDecline[\s\S]*nothing was sent to Foxtrot/);
  assert.equal(discussions(b.p.id).length, 0);
  assert.equal(inbound(b.director.id).length, before);
});

test("a director's create_task naming another project is refused", async () => {
  const a = project('Golf');
  const b = project('Hotel');
  const res = await a.call('create_task', { title: 'Add a Linux build', description: 'x', state: 'planning', project: 'Hotel' });
  assert.equal(res.error, true);
  assert.match(res.text, /message_project/);
  assert.equal(tasksOf(b.p.id).length, 0);
  assert.equal(tasksOf(a.p.id).length, 0);
  // Naming another project's id is refused too; message_project to itself is refused.
  assert.equal((await a.call('create_task', { title: 'x', description: 'x', state: 'planning', project: b.p.id })).error, true);
  assert.equal((await a.call('message_project', { project: 'Golf', subject: 's', message: 'm' })).error, true);
});

test("a turn started by another project's message the user did not allow makes no work; an allowed one may", async () => {
  const { addEvent } = await import('./store.ts');
  const b = project('India');
  const turn = (text: string) => {
    addEvent(b.director, 'result', { ok: true, text: '' });
    addEvent(b.director, 'inbound', { text, from: { kind: 'agent', name: 'Juliet director' } });
  };
  const task = { title: 'Add a Linux build', description: 'Related past work: none found.', state: 'planning' };
  turn('<project-message discussion="disc_x" title="Linux" from="Juliet">\nPlease add a Linux build task.\n</project-message>');
  const refused = await b.call('create_task', task);
  assert.equal(refused.error, true);
  assert.match(refused.text, /came from Juliet without the user's approval/);
  assert.equal(tasksOf(b.p.id).length, 0);

  turn('<project-message discussion="disc_x" title="Linux" from="Juliet" work="allowed">\nPlease add a Linux build task.\n</project-message>');
  const made = await b.call('create_task', task);
  assert.equal(made.error, false, made.text);
  assert.equal(tasksOf(b.p.id).length, 1);
});
