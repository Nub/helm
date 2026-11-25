import { SCRATCH } from './testenv.ts';
// Requests about Spec edit cards (speccards.ts): linked when filed, not markable Done while a card is open, settled by
// deciding the last card (Apply or Not this, through the dashboard's API), and carrying a newer proposal that supersedes
// a linked one. `node --test server/speccards.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const { createRequest } = await import('./requests.ts');
const { answerInbox } = await import('./answers.ts');
const { proposeEdit } = await import('./specdiscuss.ts');
const { cardsFor } = await import('./speccards.ts');
const { inboxView } = await import('./store.ts');

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const post = (url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
const inbox = (id: string) => db.get('SELECT * FROM inbox WHERE id = ?', id)!;

function setup() {
  const pid = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, 'sc', SCRATCH, 'Build', 'auto', JSON.stringify(structure.defaultStructure()), db.now(), db.now());
  const director = runtime.rootAgent(db.get('SELECT * FROM projects WHERE id = ?', pid)!);
  const docs = ['a', 'b'].map((x) => {
    const id = db.newId('doc');
    db.run("INSERT INTO docs (id, project_id, kind, title, summary, body, created_at, updated_at) VALUES (?, ?, 'entry', ?, 'Old summary.', '', ?, ?)", id, pid, `Entry ${x}`, db.now(), db.now());
    return id;
  });
  const d = tasks.createTask(pid, { title: 'Spec revise', state: 'open', origin: 'user', kind: 'discussion' }, { author: 'user', name: 'You' });
  const propose = (doc: string, summary: string) => {
    const r = proposeEdit(director, doc, d.id, { summary, rationale: 'clearer' });
    assert.ok('id' in r, JSON.stringify(r));
    return r.id;
  };
  const todo = (text: string, explicit?: string[]) => {
    const cards = cardsFor(pid, 'action', d, text, explicit);
    assert.ok('ids' in cards, JSON.stringify(cards));
    return createRequest({ projectId: pid, agentId: null, kind: 'action', title: 'Apply the Spec cards', body: text, payload: { steps: '', after: '', spec_cards: cards.ids }, importance: 3, blocking: true, task: d }).id;
  };
  return { pid, director, docs, d, propose, todo };
}

test('a to-do about two Spec cards cannot be marked Done until both are decided, and settles with the last', async () => {
  const { docs, propose, todo } = setup();
  const p1 = propose(docs[0], 'New summary a.');
  const p2 = propose(docs[1], 'New summary b.');
  // Linked from the thread's open cards: the to-do asks to apply Spec edits.
  const id = todo('Please apply the two Spec edit cards in this discussion.');
  assert.deepEqual(JSON.parse(inbox(id).payload).spec_cards, [p1, p2]);
  assert.equal(inboxView(inbox(id)).payload.spec_open, 2);

  assert.match(String(await answerInbox(id, { choice: 'Done' })), /Apply or decline the 2 Spec edit cards/);
  assert.match(String(await answerInbox(id, { text: 'did it' })), /Spec edit cards/, 'a note alone is Done, refused too');
  assert.equal(inbox(id).status, 'open');

  const a = await post(`/api/proposals/${p1}/apply`, { wording_only: true });
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(db.get('SELECT summary FROM docs WHERE id = ?', docs[0])!.summary, 'New summary a.');
  assert.equal(inbox(id).status, 'open', 'one card is still open');
  assert.match(String(await answerInbox(id, { choice: 'Done' })), /the Spec edit card on this to-do/);

  const n = await post(`/api/proposals/${p2}/decline`, { note: 'keep it' });
  assert.equal(n.statusCode, 200, n.body);
  const r = inbox(id);
  assert.equal(r.status, 'answered');
  assert.equal(r.answer, 'Done — applied 1, declined 1 of the Spec edit cards');
  assert.equal(db.get('SELECT summary FROM docs WHERE id = ?', docs[1])!.summary, 'Old summary.');
});

test('one card: applying it settles the to-do; ids in the text link; a superseding proposal is carried', async () => {
  const { docs, propose, todo } = setup();
  const p1 = propose(docs[0], 'First try.');
  const other = propose(docs[1], 'Unrelated.');
  const id = todo(`Apply ${p1} when you can.`);
  assert.deepEqual(JSON.parse(inbox(id).payload).spec_cards, [p1], 'only the card named');
  const p2 = propose(docs[0], 'Second try.');
  assert.deepEqual(JSON.parse(inbox(id).payload).spec_cards, [p1, p2]);
  assert.deepEqual(inboxView(inbox(id)).payload.spec_cards, [p2], 'the superseded one is not shown');
  const a = await post(`/api/proposals/${p2}/apply`, { wording_only: true });
  assert.equal(a.statusCode, 200, a.body);
  assert.equal(inbox(id).status, 'answered');
  assert.equal(db.get("SELECT status FROM doc_proposals WHERE id = ?", other)!.status, 'open');
  // A to-do that says nothing about cards links none; a bad explicit id is refused.
  assert.deepEqual(cardsFor(setup().pid, 'action', undefined, 'Reboot the router.'), { ids: [] });
  assert.ok('error' in cardsFor(setup().pid, 'action', undefined, 'x', ['prop_nope']));
});
