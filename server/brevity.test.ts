import { SCRATCH } from './testenv.ts';
// Short output (brevity.ts): the budget check (ask once, then deliver as written and count), held reports and
// rewritten replies, clean caps, and the setting.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const { defaultStructure, buildSystemPrompt } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const store = await import('./store.ts');
const br = await import('./brevity.ts');
const { setSetting, settingsView } = await import('./settings.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const { createTask } = await import('./tasks.ts');

function makeProject() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'br', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  const role = structure.roles.find((r) => r.id !== structure.root && !r.canSpawn.length)!;
  const worker = runtime.createAgent(project, director, role, 'Engineer', 'Build it.');
  return { project, director, worker, structure, role };
}

const sent: { to: string; text: string }[] = [];
const rt = { spawn: async () => 'no', send: async (to: string, text: string) => void sent.push({ to, text }), close: async () => {}, markComplete: () => {} };
function toolsFor(agent: any) {
  const project = db.get('SELECT * FROM projects WHERE id = ?', agent.project_id)!;
  const tools = helmTools(agent.id, rt as any, toolAccess(JSON.parse(project.structure), agent.role_id, agent.parent_id));
  return async (name: string, input: Record<string, unknown>) => {
    const t = tools.find((x: any) => x.name === name)!;
    const res: any = await t.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
}
const agentRow = (id: string) => db.get('SELECT * FROM agents WHERE id = ?', id)!;
const resultData = (id: number) => JSON.parse(db.get('SELECT data FROM events WHERE id = ?', id)!.data);
const long = (n: number) => Array.from({ length: n }, (_, i) => `- Point ${i + 1}: the server checks the input and records it.`).join('\n');

test('measure and the budgets', () => {
  assert.deepEqual(br.measure('  one\n\n two \n'), { chars: 9, lines: 2 });
  assert.equal(br.over('Done. All checks pass.', 'report'), null);
  assert.ok(br.over('x'.repeat(601), 'report'));
  assert.ok(br.over(Array(9).fill('a').join('\n'), 'report'), 'nine lines is over eight');
  assert.equal(br.over(Array(8).fill('a').join('\n\n'), 'report'), null, 'blank lines do not count');
  assert.ok(br.over('x'.repeat(501), 'reply'));
  assert.equal(br.over('x'.repeat(501), 'report'), null);
});

test('cutClean cuts at a sentence end, else a word break, and never loses the start', () => {
  const s = 'First sentence here. Second sentence is a bit longer. Third one runs past the limit for sure.';
  assert.deepEqual(br.cutClean(s, 60), { text: 'First sentence here. Second sentence is a bit longer.', cut: true });
  assert.deepEqual(br.cutClean('short', 60), { text: 'short', cut: false });
  const words = br.cutClean('alpha beta gamma delta epsilon zeta eta theta', 30);
  assert.equal(words.cut, true);
  assert.ok(words.text.endsWith('…') && words.text.length <= 30, words.text);
  assert.ok(!/\S…$/.test(words.text.replace(/\w+…$/, '')) && 'alpha beta gamma delta epsilon zeta eta theta'.startsWith(words.text.slice(0, -1)), 'cut at a word break');
  // A sentence end too early (under half the limit) is not used: the word break keeps more.
  assert.ok(br.cutClean('Hi. ' + 'word '.repeat(40), 60).text.length > 40);
});

test('review request and question: asked once to cut, the second attempt is sent as written and counted', async () => {
  const { worker, director } = makeProject();
  const call = toolsFor(worker);
  const review = { summary: long(12), where: 'branch x', verified: 'npm test' };
  const first = await call('request_review', review);
  assert.equal(first.error, true);
  assert.match(first.text, /Not sent: your review request is .* the budget is 600 characters and 8 lines/);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM consults WHERE asker_id = ?", worker.id)!.n, 0, 'nothing filed');
  assert.equal(sent.filter((m) => m.to === director.id).length, 0, 'nothing delivered');
  const second = await call('request_review', review);
  assert.equal(second.error, false, second.text);
  const c = db.get('SELECT question FROM consults WHERE asker_id = ?', worker.id)!;
  assert.ok(c.question.includes(long(12)), 'delivered as written, nothing lost or split');
  assert.equal(agentRow(worker.id).brevity_over, 1);

  // A short question goes straight through; a long one is asked about once (its own kind).
  assert.equal((await call('ask_manager', { question: 'Which port?' })).error, false);
  assert.equal((await call('ask_manager', { question: long(15) })).error, true);
  assert.equal((await call('ask_manager', { question: 'Shorter: which of A or B?' })).error, false, 'a short retry goes through');
  assert.equal(agentRow(worker.id).brevity_over, 1, 'not counted: it was cut');
});

test('director thread posts are budgeted; status summaries and journal entries are cut cleanly', async () => {
  const { project, director } = makeProject();
  const call = toolsFor(director);
  const t = createTask(project.id, { title: 'A task', state: 'active', origin: 'user' }, { author: 'user', name: 'You' } as any);
  assert.equal((await call('task_post', { task: t.id, message: long(10) })).error, true);
  assert.equal((await call('task_post', { task: t.id, message: long(10) })).error, false);
  const summary = 'It works end to end. '.repeat(40);
  const res = await call('update_task', { task: t.id, status_summary: summary });
  assert.match(res.text, /status_summary was over 600 characters and was cut at a sentence end/);
  const saved = db.get('SELECT status_summary FROM tasks WHERE id = ?', t.id)!.status_summary as string;
  assert.ok(saved.length <= 600 && saved.endsWith('end to end.'), saved);
  const j = await call('log_journal', { kind: 'note', title: 'A title that goes on. '.repeat(10), body: 'Short body.' });
  assert.match(j.text, /title was over 140 characters/);
  const row = db.get('SELECT title, body FROM journal WHERE project_id = ? ORDER BY id DESC', project.id)!;
  assert.ok(row.title.length <= 140 && row.title.endsWith('goes on.'));
  assert.equal(row.body, 'Short body.');
});

test("a worker's over-budget report is held, its rewrite delivered; a failed rewrite delivers the first", () => {
  const { worker } = makeProject();
  const w = agentRow(worker.id);
  const r1 = store.addEvent(w, 'result', { ok: true, text: long(20) });
  const first = br.workerTurn(w, r1, long(20), true);
  assert.ok('note' in first && first.note.startsWith(br.NOTE_TAG) && /not delivered/.test(first.note));
  assert.equal(resultData(r1).brevity, 'asked');
  // The note starts the next turn; its reply is delivered in place of the held report.
  store.addEvent(w, 'inbound', { from: { kind: 'system', name: 'Helm' }, text: (first as any).note });
  const r2 = store.addEvent(w, 'result', { ok: true, text: 'Merged as abc123. Tests pass.' });
  assert.deepEqual(br.workerTurn(w, r2, 'Merged as abc123. Tests pass.', true), { deliver: 'Merged as abc123. Tests pass.' });
  assert.equal(resultData(r1).brevity, 'replaced');
  assert.equal(agentRow(worker.id).brevity_over, 0);

  // Over again on the rewrite: delivered as written, counted.
  const r3 = store.addEvent(w, 'result', { ok: true, text: long(20) });
  const n3 = br.workerTurn(w, r3, long(20), true) as { note: string };
  store.addEvent(w, 'inbound', { from: { kind: 'system', name: 'Helm' }, text: n3.note });
  const r4 = store.addEvent(w, 'result', { ok: true, text: long(18) });
  assert.deepEqual(br.workerTurn(w, r4, long(18), true), { deliver: long(18) });
  assert.equal(agentRow(worker.id).brevity_over, 1);

  // The rewrite turn failed: the first report goes, so nothing is lost.
  const r5 = store.addEvent(w, 'result', { ok: true, text: long(30) });
  const n5 = br.workerTurn(w, r5, long(30), true) as { note: string };
  store.addEvent(w, 'inbound', { from: { kind: 'system', name: 'Helm' }, text: n5.note });
  const r6 = store.addEvent(w, 'result', { ok: false, text: 'Turn ended early (error_during_execution).' });
  assert.deepEqual(br.workerTurn(w, r6, 'Turn ended early', false), { deliver: long(30) });

  // A turn not started by the note is a new report, checked afresh.
  const r7 = store.addEvent(w, 'result', { ok: true, text: 'Short.' });
  assert.deepEqual(br.workerTurn(w, r7, 'Short.', true), { deliver: 'Short.' });
});

test("the director's long reply: one note, the rewrite replaces it in the conversation and the thread", () => {
  const { project, director } = makeProject();
  const d = agentRow(director.id);
  const r1 = store.addEvent(d, 'result', { ok: true, text: long(12), dialogue: true, routed: null });
  const note = br.directorReply(d, r1, long(12), { dialogue: true, routed: null });
  assert.ok(note && /Rewrite it shorter/.test(note));
  store.addEvent(d, 'inbound', { from: { kind: 'system', name: 'Helm' }, text: note! });
  const held = br.heldResult(d)!;
  assert.equal(held.id, r1);
  assert.deepEqual(br.replaceReply(d, held, 'Yes: it is done.', true), { dialogue: true, routed: null });
  assert.equal(resultData(r1).replaced, true);
  const { inDialogue } = await_turns;
  assert.equal(inDialogue(d.id, { kind: 'result', id: r1, data: resultData(r1) }), false, 'hidden from the conversation');

  // Routed into a thread: the post is rewritten in place.
  const t = createTask(project.id, { title: 'T', state: 'active', origin: 'user' }, { author: 'user', name: 'You' } as any);
  const { addTaskMessage } = tasksMod;
  const msg = addTaskMessage(t, { author: 'director', name: d.name }, long(12));
  const r2 = store.addEvent(d, 'result', { ok: true, text: long(12), dialogue: false, routed: t.id });
  const note2 = br.directorReply(d, r2, long(12), { dialogue: false, routed: t.id, message: msg })!;
  store.addEvent(d, 'inbound', { from: { kind: 'system', name: 'Helm' }, text: note2 });
  assert.deepEqual(br.replaceReply(d, br.heldResult(d)!, 'Shorter.', true), { dialogue: false, routed: t.id });
  assert.equal(db.get('SELECT body FROM task_messages WHERE id = ?', msg)!.body, 'Shorter.');

  // Replies nobody sees are not checked.
  const r3 = store.addEvent(d, 'result', { ok: true, text: long(12) });
  assert.equal(br.directorReply(d, r3, long(12), { dialogue: false, routed: null }), null);
});

test('the setting: short by default, full turns every budget off; the prompt carries the rule only when short', async () => {
  const { project, worker, structure, role, director } = makeProject();
  assert.ok(settingsView(project.id)[0].settings.some((s: any) => s.key === 'brevity' && s.value === true));
  const prompt = () => buildSystemPrompt(project, structure, role, agentRow(worker.id), agentRow(director.id));
  assert.match(prompt(), /# Keep it short[\s\S]*Do not add detail in case it is wanted: you will be asked\./);
  setSetting(project.id, 'brevity', false);
  assert.doesNotMatch(prompt(), /# Keep it short/);
  const w = agentRow(worker.id);
  const r = store.addEvent(w, 'result', { ok: true, text: long(30) });
  assert.deepEqual(br.workerTurn(w, r, long(30), true), { deliver: long(30) });
  assert.equal((await toolsFor(worker)('ask_manager', { question: long(20) })).error, false);
  setSetting(project.id, 'brevity', true);
});

const await_turns = await import('./turns.ts');
const tasksMod = await import('./tasks.ts');

test('detail the reader asked for: sent in full, recorded, not counted', async () => {
  assert.deepEqual(br.stripDetail('[detail requested]\nThe list:\n1'), { text: 'The list:\n1', detail: true });
  assert.deepEqual(br.stripDetail('No mark here.'), { text: 'No mark here.', detail: false });
  const { worker, director } = makeProject();
  const w = agentRow(worker.id);
  // First attempt already marked: no note.
  const r1 = store.addEvent(w, 'result', { ok: true, text: long(20) });
  assert.deepEqual(br.workerTurn(w, r1, long(20), true, true), { deliver: long(20) });
  // Marked on the resend after a note.
  const r2 = store.addEvent(w, 'result', { ok: true, text: long(20) });
  const n = br.workerTurn(w, r2, long(20), true) as { note: string };
  assert.match(n.note, /start your reply with the line \[detail requested\]/);
  store.addEvent(w, 'inbound', { from: { kind: 'system', name: 'Helm' }, text: n.note });
  const r3 = store.addEvent(w, 'result', { ok: true, text: long(20) });
  assert.deepEqual(br.workerTurn(w, r3, long(20), true, true), { deliver: long(20) });
  // Tools: detail_requested goes through at once.
  assert.equal((await toolsFor(worker)('ask_manager', { question: long(15), detail_requested: true })).error, false);
  const row = agentRow(worker.id);
  assert.equal(row.brevity_over, 0);
  assert.equal(row.brevity_detail, 3);
  // The director: a marked long reply gets no note.
  const d = agentRow(director.id);
  const r4 = store.addEvent(d, 'result', { ok: true, text: long(12), dialogue: true });
  assert.equal(br.directorReply(d, r4, long(12), { dialogue: true, routed: null }, true), null);
});
