import { SCRATCH } from './testenv.ts';
// Spec work (specwork.ts): Review, Revise and Create from the Spec page each open their discussion and wake the director
// with that mode's brief; a Review posts findings per section and stops between sections when the user asks; picked
// findings start a Revise; proposed entries are accepted (written as the user's) or dropped; bringing in a folder with
// code and no Spec files the one question, whose Build a Spec starts Create. `node --test server/specwork.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const work = await import('./specwork.ts');
const { answerInbox } = await import('./answers.ts');

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const post = (url: string, payload: unknown = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as any });
const inbound = (agentId: string) => db.all("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id", agentId).map((e) => String(JSON.parse(e.data).text ?? ''));

function project(withSpec: boolean) {
  const pid = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, 'sw', SCRATCH, 'Build', 'auto', JSON.stringify(structure.defaultStructure()), db.now(), db.now());
  const director = runtime.rootAgent(db.get('SELECT * FROM projects WHERE id = ?', pid)!);
  if (withSpec) {
    db.run('INSERT INTO doc_sections (id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)', `sec_a${pid}`, pid, 'Exports', db.now(), db.now());
    db.run('INSERT INTO doc_sections (id, project_id, name, position, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)', `sec_b${pid}`, pid, 'Imports', db.now(), db.now());
    db.run("INSERT INTO docs (id, project_id, kind, title, summary, body, section_id, created_at, updated_at) VALUES (?, ?, 'entry', 'Daily exports', 'Exports run once a day.', '', ?, ?, ?)", `doc_a${pid}`, pid, `sec_a${pid}`, db.now(), db.now());
    db.run("INSERT INTO docs (id, project_id, kind, title, summary, body, section_id, created_at, updated_at) VALUES (?, ?, 'entry', 'CSV import', 'CSV files are read.', '', ?, ?, ?)", `doc_b${pid}`, pid, `sec_b${pid}`, db.now(), db.now());
  }
  return { pid, director };
}

test('each mode opens its discussion and wakes the director with its brief; an open one is resumed', async () => {
  const { pid, director } = project(true);
  for (const [mode, brief] of [
    ['review', /Spec Review[\s\S]*Exports \(sec_a[\s\S]*Imports \(sec_b[\s\S]*post_spec_findings/],
    ['revise', /Spec Revise[\s\S]*They want: fewer sections[\s\S]*propose_doc_edit[\s\S]*propose_spec_entries/],
    ['create', /Spec Create[\s\S]*propose_spec_entries/],
  ] as const) {
    const before = inbound(director.id).length;
    const r = await post(`/api/projects/${pid}/spec-work`, { mode, ask: mode === 'revise' ? 'fewer sections' : '' });
    assert.equal(r.statusCode, 200, r.body);
    const { id, created } = r.json();
    assert.equal(created, true);
    const d = tasks.getTask(id)!;
    assert.deepEqual([d.kind, d.state], ['discussion', 'open']);
    const sent = inbound(director.id).slice(before);
    assert.equal(sent.length, 1);
    assert.match(sent[0], new RegExp(`<discussion-message discussion="${id}"[^>]*spec-work="${mode}"`));
    assert.match(sent[0], brief);
    // The thread shows only the user's words, not the brief.
    const words = db.get("SELECT body FROM task_messages WHERE task_id = ? AND author = 'user'", id)!.body;
    assert.doesNotMatch(words, /spec-work/);
    if (mode === 'review') {
      const again = await post(`/api/projects/${pid}/spec-work`, { mode });
      assert.deepEqual(again.json(), { id, created: false });
      assert.equal(inbound(director.id).length - before, 1, 'resuming does not wake the director again');
    }
  }
  const state = (await app.inject({ url: `/api/projects/${pid}`, headers: { cookie } })).json();
  assert.deepEqual(state.specWork.map((w: any) => w.mode).sort(), ['create', 'review', 'revise']);
});

test('Review posts findings per section, stops between sections on Stop, and picked findings start a Revise', async () => {
  const { pid, director } = project(true);
  const { id } = (await post(`/api/projects/${pid}/spec-work`, { mode: 'review' })).json();
  const agent = db.get('SELECT * FROM agents WHERE id = ?', director.id)!;

  const r1 = work.postFindings(agent, id, 'Exports', [
    { kind: 'match', text: 'Exports run daily from cron.', doc: `doc_a${pid}` },
    { kind: 'gap', text: 'Exports also write JSON; the Spec says nothing.' },
  ]);
  assert.ok('text' in r1, JSON.stringify(r1));
  assert.match(r1.text, /1 of 2 sections done\. Next: Imports/);
  const card = db.get("SELECT id FROM task_messages WHERE task_id = ? AND kind = 'findings'", id)!;
  const view = (await app.inject({ url: `/api/spec-cards/${card.id}`, headers: { cookie } })).json();
  assert.equal(view.section, 'Exports');
  assert.deepEqual(view.items.map((i: any) => i.kind), ['match', 'gap']);

  // The user stops it: the next post says to end there, and the bar shows it.
  assert.equal((await post(`/api/spec-work/${id}/stop`)).statusCode, 200);
  assert.match(inbound(director.id).at(-1)!, /stop after the current section/);
  const r2 = work.postFindings(agent, id, 'Imports', [{ kind: 'disagree', text: 'The Spec says CSV; the code reads TSV (server/import.ts).', doc: `doc_b${pid}` }]);
  assert.ok('text' in r2);
  assert.match(r2.text, /stop here: end your turn/);
  assert.equal((await post(`/api/spec-work/${id}/continue`)).statusCode, 200);
  assert.match(inbound(director.id).at(-1)!, /continue/);
  assert.match((work.postFindings(agent, id, 'Imports', [{ kind: 'match', text: 'ok' }]) as any).text, /All 2 sections are done/);

  // Findings are refused outside a Review, and for an unknown section.
  assert.ok('error' in work.postFindings(agent, id, 'Nowhere', [{ kind: 'gap', text: 'x' }]));

  // Picking a gap and a disagreement starts a new Revise from them.
  const picked = db.all("SELECT id FROM spec_items WHERE discussion_id = ? AND kind IN ('gap','disagree')", id).map((r) => r.id);
  const before = inbound(director.id).length;
  const rv = await post(`/api/projects/${pid}/spec-work`, { mode: 'revise', findings: picked });
  assert.equal(rv.statusCode, 200, rv.body);
  const revise = rv.json().id;
  assert.notEqual(revise, id);
  assert.match(inbound(director.id).slice(before).join('\n'), /spec-work="revise">\nRevise the Spec from these 2 Review findings[\s\S]*- Gap \(Exports\): Exports also write JSON[\s\S]*- Disagrees \(Imports\)/);
  assert.deepEqual(db.all('SELECT DISTINCT status, result FROM spec_items WHERE id IN (?, ?)', ...picked).map((r) => [r.status, r.result]), [['picked', revise]]);
});

test('Create: proposed entries are accepted (written as the user\'s, no planning) or dropped', async () => {
  const { pid, director } = project(false);
  // No entries: Review is refused.
  assert.equal((await post(`/api/projects/${pid}/spec-work`, { mode: 'review' })).statusCode, 400);
  const { id } = (await post(`/api/projects/${pid}/spec-work`, { mode: 'create' })).json();
  const agent = db.get('SELECT * FROM agents WHERE id = ?', director.id)!;
  const r = work.proposeEntries(agent, id, [
    { title: 'Runs as a CLI', summary: 'One command runs it.', body: 'npm start', section: 'Command line' },
    { title: 'Plugins', summary: 'Plugins load from a folder.', section: 'Extending' },
  ]);
  assert.ok('text' in r, JSON.stringify(r));
  const [a, b] = db.all("SELECT * FROM spec_items WHERE discussion_id = ? AND kind = 'entry' ORDER BY rowid", id);
  assert.equal((await post(`/api/spec-items/${a.id}/accept`)).statusCode, 200);
  assert.equal((await post(`/api/spec-items/${b.id}/drop`)).statusCode, 200);
  assert.equal((await post(`/api/spec-items/${a.id}/accept`)).statusCode, 409);
  const doc = db.get('SELECT * FROM docs WHERE project_id = ?', pid)!;
  assert.equal(doc.title, 'Runs as a CLI');
  assert.equal(db.get('SELECT name FROM doc_sections WHERE id = ?', doc.section_id)!.name, 'Command line');
  assert.equal(db.all("SELECT 1 FROM tasks WHERE project_id = ? AND kind = 'task'", pid).length, 0, 'no planning task');
  assert.match((work.proposeEntries(agent, id, [{ title: 'X', summary: 'Y', section: 'Z' }]) as any).text, /1 accepted, 1 dropped, 1 not decided/);
});

test('bringing in a folder with code and no Spec files the one question; Build a Spec starts Create', async () => {
  const dir = join(SCRATCH, `import-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'main.go'), 'package main\n');
  const r = await post('/api/projects', { mode: 'existing', path: dir });
  assert.equal(r.statusCode, 200, r.body);
  const pid = r.json().id;
  const q = db.all("SELECT * FROM inbox WHERE project_id = ? AND title = 'Build a Spec from the code?'", pid);
  assert.equal(q.length, 1);
  assert.match(q[0].body, /agents plan against/);
  const director = runtime.rootAgent(db.get('SELECT * FROM projects WHERE id = ?', pid)!);
  const err = await answerInbox(q[0].id, { choice: 'Build a Spec' });
  assert.equal(err, null);
  const w = db.get("SELECT * FROM spec_work WHERE project_id = ? AND mode = 'create'", pid);
  assert.ok(w, 'Create started');
  assert.ok(inbound(director.id).some((t) => t.includes('spec-work="create"')));

  // An empty folder asks nothing.
  const empty = join(SCRATCH, `empty-${Date.now()}`);
  mkdirSync(empty, { recursive: true });
  const r2 = await post('/api/projects', { mode: 'existing', path: empty });
  assert.equal(db.all("SELECT 1 FROM inbox WHERE project_id = ? AND title = 'Build a Spec from the code?'", r2.json().id).length, 0);
});

test('a bare "stop" or "continue" typed in the thread stops or continues it', async () => {
  const { pid } = project(true);
  const { id } = (await post(`/api/projects/${pid}/spec-work`, { mode: 'review' })).json();
  const send = (text: string) => post(`/api/tasks/${id}/message`, { text });
  const r = await send('Stop.');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(work.getSpecWork(id)!.stop, 1);
  await send('why does it say that?');
  assert.equal(work.getSpecWork(id)!.stop, 1);
  await send('continue');
  assert.equal(work.getSpecWork(id)!.stop, 0);
});
