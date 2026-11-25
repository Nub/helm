import { SCRATCH } from './testenv.ts';
// A note on its own settles a request like a button (answers.ts): every kind closes as answered with the note and the
// agent receives it; anything further is a new request. `node --test server/notesettle.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const req = await import('./requests.ts');
const { answerInbox, noteChoice } = await import('./answers.ts');
const errs = await import('./agenterrors.ts');
const { setWatch, setWatchHooks, onWatchAnswer } = await import('./watches.ts');

const USER = { author: 'user' as const, name: 'You' };
const sent: { to: string; text: string }[] = [];
errs.setAgentErrorHooks({ send: async (to, text) => void sent.push({ to, text }), close: async () => {}, root: (p) => runtime.rootAgent(p) });
setWatchHooks({ tell: () => {}, ask: () => {} });

function setup() {
  const id = db.newId('pr');
  const s = defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'ns', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const worker = runtime.createAgent(project, director, s.roles.find((r) => r.id !== s.root)!, 'Engineer', 'x');
  const task = tasks.createTask(id, { title: 'T', state: 'active', origin: 'user', description: '' }, USER);
  return { project, director, worker, task };
}
const item = (id: string) => db.get('SELECT * FROM inbox WHERE id = ?', id)!;
/** The messages the agent has been sent (its transcript's inbound events). */
const inbound = (agentId: string) => db.all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id", agentId).map((e) => String(JSON.parse(e.data).text));

test('what a note alone stands for', () => {
  assert.equal(noteChoice('action'), 'Done');
  assert.equal(noteChoice('permission'), 'Deny');
  assert.equal(noteChoice('structure'), 'Deny');
  assert.equal(noteChoice('question'), undefined);
});

test('a text-only answer closes a question and reaches the agent', async () => {
  const { project, director, task } = setup();
  const q = req.createRequest({ projectId: project.id, agentId: director.id, kind: 'question', title: 'Which colour?', body: 'Pick.', options: [{ label: 'Red' }, { label: 'Blue' }], importance: 3, blocking: false, task });
  req.releaseHeld(director.id);
  assert.equal(await answerInbox(q.id, { text: 'Green, actually.' }), null);
  assert.equal(item(q.id).status, 'answered');
  assert.equal(item(q.id).answer, 'Green, actually.');
  assert.ok(inbound(director.id).some((t) => t.includes('Green, actually.') && t.includes('Which colour?')));
  assert.match((await answerInbox(q.id, { text: 'again' }))!, /^Already answered/, 'closed: a second note is refused; more comes as a new request');
});

test('a text-only answer to a to-do counts as Done with the note, and reaches the agent', async () => {
  const { project, director, task } = setup();
  const a = req.createRequest({ projectId: project.id, agentId: director.id, kind: 'action', title: 'Plug in the board', body: 'Do it.', payload: { steps: '1. Plug it in' }, importance: 3, blocking: false, task });
  req.releaseHeld(director.id);
  assert.equal(await answerInbox(a.id, { text: 'Plugged in, the light is green.' }), null);
  assert.equal(item(a.id).status, 'answered');
  assert.equal(item(a.id).answer, 'Done — Plugged in, the light is green.');
  assert.ok(inbound(director.id).some((t) => t.includes('kind="to-do"') && t.includes('Done — Plugged in')));
  // "Can't / not yet" is still its own choice.
  const b = req.createRequest({ projectId: project.id, agentId: director.id, kind: 'action', title: 'Reboot it', body: 'Do it.', payload: { steps: '1. Reboot' }, importance: 3, blocking: false, task });
  req.releaseHeld(director.id);
  await answerInbox(b.id, { choice: "Can't / not yet", text: 'Later today.' });
  assert.equal(item(b.id).answer, "Can't / not yet — Later today.");
});

test('a text-only answer to a permission request denies it with the note as the reason, and settles it', async () => {
  const { project, worker, task } = setup();
  const p = req.createRequest({ projectId: project.id, agentId: worker.id, kind: 'permission', title: 'Engineer wants to use Bash', body: 'rm -rf build', payload: { toolName: 'Bash', input: '{}', summary: 'rm -rf build' }, importance: 4, blocking: true, task });
  assert.equal(await answerInbox(p.id, { text: 'Not that folder.' }), null);
  assert.equal(item(p.id).status, 'answered');
  assert.match(item(p.id).answer, /^Deny — Not that folder\./);
});

test('a text-only answer to an agent\'s error resumes it with the note and closes the entry', async () => {
  const { project, worker, task } = setup();
  const e = req.createRequest({ projectId: project.id, agentId: worker.id, kind: 'agent_error', title: 'Engineer stopped: it crashed', body: 'x', payload: { error_kind: 'crash', plain: 'It crashed.' }, importance: 4, blocking: false, task });
  req.releaseHeld(worker.id);
  sent.length = 0;
  assert.equal(await answerInbox(e.id, { text: 'Try the other folder.' }), null);
  assert.equal(item(e.id).status, 'answered');
  assert.match(item(e.id).answer, /^Resume — Try the other folder\./);
  assert.ok(sent.some((m) => m.to === worker.id && m.text.includes("The user's note: Try the other folder.")));
});

test('a note alone never approves a watch\'s command: the request closes and the watch stays unapproved', async () => {
  const { project, director } = setup();
  const res = setWatch(project.id, { name: 'W', measure: { kind: 'command', command: 'echo 5' }, op: 'above', value: 1 }, 'Director') as any;
  const w = db.get('SELECT * FROM watches WHERE id = ?', res.watch.id)!;
  assert.equal(await answerInbox(w.approval_request, { text: 'Looks fine to me.' }), null);
  assert.equal(item(w.approval_request).status, 'answered');
  assert.equal(db.get('SELECT state FROM watches WHERE id = ?', w.id)!.state, 'paused');
  void onWatchAnswer; void director;
});

test('empty answers are still refused', async () => {
  const { project, director, task } = setup();
  const a = req.createRequest({ projectId: project.id, agentId: director.id, kind: 'action', title: 'Do', body: '', payload: { steps: '1.' }, importance: 3, blocking: false, task });
  req.releaseHeld(director.id);
  assert.match((await answerInbox(a.id, { text: '   ' }))!, /Choose Done/);
});
