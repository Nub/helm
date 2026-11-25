import './testenv.ts';
// Size limits on what agents write into the Spec (server/speclimits.ts): set_doc, propose_doc_edit,
// propose_spec_entries and set_section refuse an over-long summary or text, a ninth entry in a section without
// sub-sections and a sub-section in a section of fewer than eight entries, each with the limit in the reason; the
// user's own edits through the API pass. `node --test server/speclimits.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const L = await import('./speclimits.ts');
const T = await import('./sections.ts');
const { helmTools } = await import('./tools.ts');

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const send = (method: 'POST' | 'PATCH', url: string, payload: unknown) => app.inject({ method, url, headers: { cookie }, payload: payload as any });

function setup() {
  const pid = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at, sessions_backfilled) VALUES (?,?,?,?,?,?,?,?,1)', pid, 'Limits', tmpdir(), 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const director = runtime.rootAgent(db.get('SELECT * FROM projects WHERE id = ?', pid)!);
  const rt = { spawn: async () => 'x', send: async () => {}, close: async () => {}, markComplete: () => {} };
  const list = helmTools(director.id, rt as any, { manager: true, root: true, consult: false }) as any[];
  const call = async (name: string, args: any) => {
    const r = await list.find((t) => t.name === name)!.handler(args, {});
    return { text: r.content.map((c: any) => c.text).join('\n'), error: !!r.isError };
  };
  return { pid, call };
}
const fill = (pid: string, ref: string, n: number) => {
  const sec = T.ensureSectionPath(pid, ref) as { id: string };
  for (let i = 0; i < n; i++)
    db.run("INSERT INTO docs (id, project_id, kind, title, summary, body, section_id, created_at, updated_at) VALUES (?, ?, 'entry', ?, 'It holds.', '', ?, ?, ?)", db.newId('doc'), pid, `${ref} ${i}`, sec.id, db.now(), db.now());
  return sec.id;
};
const LONG = Array.from({ length: 35 }, (_, i) => `word${i}`).join(' ') + '.';
const TWO = 'Exports run daily. They are kept for a week.';
const BODY = Array.from({ length: 9 }, (_, i) => `- point ${i}`).join('\n');

test('counting: sentences, words and points', () => {
  assert.equal(L.sentences('Exports run daily, e.g. at noon.'), 1);
  assert.equal(L.sentences(TWO), 2);
  assert.equal(L.bodyItems('Intro line\ncontinued.\n\n- a\n  more of a\n- b\n\n```\nx\n\ny\n```\n\n## Head\n| a | b |\n| - | - |'), 5);
  assert.equal(L.summaryError('Exports run once a day.'), null);
  assert.match(L.summaryError(LONG)!, /35 words; a summary is one sentence of at most 30 words/);
  assert.match(L.summaryError(TWO)!, /2 sentences; a summary is one sentence/);
  assert.match(L.bodyError(BODY)!, /9 bullets or paragraphs; an entry's text has at most 8/);
  assert.equal(L.bodyError(BODY.split('\n').slice(0, 8).join('\n')), null);
});

test('set_doc refuses each limit with the reason; within the limits it writes', async () => {
  const { pid, call } = setup();
  fill(pid, 'Full', 8);
  fill(pid, 'Small', 3);
  let r = await call('set_doc', { title: 'A', summary: LONG, section: 'Small' });
  assert.ok(r.error);
  assert.match(r.text, /at most 30 words/);
  r = await call('set_doc', { title: 'A', summary: TWO, section: 'Small' });
  assert.match(r.text, /one sentence/);
  r = await call('set_doc', { title: 'A', summary: 'It works.', body: BODY, section: 'Small' });
  assert.match(r.text, /at most 8/);
  r = await call('set_doc', { title: 'A', summary: 'It works.', section: 'Full' });
  assert.ok(r.error);
  assert.match(r.text, /"Full" would hold 9 entries; a section without sub-sections holds at most 8/);
  r = await call('set_doc', { title: 'A', summary: 'It works.', section: 'Small / Deeper' });
  assert.ok(r.error);
  assert.match(r.text, /"Small" would hold 4 entries; a section gets sub-sections only once it holds 8/);
  assert.equal(T.findSection(pid, 'Deeper'), undefined, 'nothing was created');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM docs WHERE project_id = ? AND title = 'A'", pid)!.n, 0);
  // Within the limits: a sub-section of the full section, and an entry in the small one.
  r = await call('set_doc', { title: 'A', summary: 'It works.', section: 'Full / Part' });
  assert.equal(r.error, false, r.text);
  r = await call('set_doc', { title: 'B', summary: 'It works too.', body: '- one\n- two', section: 'Small' });
  assert.equal(r.error, false, r.text);
  // Re-saving an entry in an over-full section it is already in is not refused (no change of place).
  const old = fill(pid, 'Legacy', 10);
  const one = db.get('SELECT id FROM docs WHERE section_id = ? LIMIT 1', old)!.id;
  r = await call('set_doc', { id: one, section: 'Legacy', status: 'active' });
  assert.equal(r.error, false, r.text);
});

test('set_section refuses a sub-section of a small section', async () => {
  const { pid, call } = setup();
  fill(pid, 'Small', 2);
  let r = await call('set_section', { name: 'Sub', parent: 'Small' });
  assert.ok(r.error);
  assert.match(r.text, /gets sub-sections only once it holds 8/);
  r = await call('set_section', { name: 'Small / Sub' });
  assert.ok(r.error);
  fill(pid, 'Big', 8);
  r = await call('set_section', { name: 'Sub', parent: 'Big' });
  assert.equal(r.error, false, r.text);
  assert.equal((await call('set_section', { name: 'Top level' })).error, false);
});

test('propose_doc_edit refuses over-limit text and moves', async () => {
  const { pid, call } = setup();
  fill(pid, 'Full', 8);
  fill(pid, 'Small', 1);
  const doc = db.get("SELECT id FROM docs WHERE project_id = ? AND title = 'Small 0'", pid)!.id;
  let r = await call('propose_doc_edit', { entry: doc, discussion: 'disc_none', summary: LONG, rationale: 'x' });
  assert.ok(r.error);
  assert.match(r.text, /proposed summary is 35 words; .*at most 30 words/);
  r = await call('propose_doc_edit', { entry: doc, discussion: 'disc_none', body: BODY, rationale: 'x' });
  assert.match(r.text, /proposed text has 9 bullets or paragraphs/);
  r = await call('propose_doc_edit', { entry: doc, discussion: 'disc_none', section: 'Full', rationale: 'x' });
  assert.match(r.text, /holds at most 8/);
  // Within the limits it gets as far as the discussion check.
  r = await call('propose_doc_edit', { entry: doc, discussion: 'disc_none', summary: 'It holds firmly.', rationale: 'x' });
  assert.match(r.text, /No discussion/);
});

test('propose_spec_entries refuses an over-limit entry or batch', async () => {
  const { pid, call } = setup();
  fill(pid, 'Seven', 7);
  const res = await send('POST', `/api/projects/${pid}/spec-work`, { mode: 'create' });
  assert.equal(res.statusCode, 200, res.body);
  const disc = res.json().id;
  const entry = (over: object = {}) => ({ title: 'E', summary: 'It is so.', section: 'Seven', ...over });
  let r = await call('propose_spec_entries', { discussion: disc, entries: [entry({ summary: TWO })] });
  assert.ok(r.error);
  assert.match(r.text, /summary of "E" is 2 sentences/);
  r = await call('propose_spec_entries', { discussion: disc, entries: [entry({ body: BODY })] });
  assert.match(r.text, /text of "E" has 9 bullets/);
  // Two more would make nine in Seven.
  r = await call('propose_spec_entries', { discussion: disc, entries: [entry(), entry({ title: 'F' })] });
  assert.match(r.text, /"Seven" would hold 9 entries/);
  // A new section with a sub-section straight away is refused; one that fills first is not.
  r = await call('propose_spec_entries', { discussion: disc, entries: [entry({ section: 'New / Sub' })] });
  assert.match(r.text, /"New" would hold 1 entry; a section gets sub-sections only once it holds 8/);
  r = await call('propose_spec_entries', { discussion: disc, entries: [entry(), entry({ title: 'G', section: 'Seven / Part' })] });
  assert.equal(r.error, false, r.text);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM spec_items WHERE discussion_id = ?', disc)!.n, 2);
});

test("the user's own edits through the API are never refused", async () => {
  const { pid } = setup();
  const full = fill(pid, 'Full', 8);
  let r = await send('POST', `/api/projects/${pid}/docs`, { title: 'Mine', summary: `${TWO} ${LONG}`, body: BODY, section_id: full });
  assert.equal(r.statusCode, 200, r.body);
  r = await send('POST', `/api/projects/${pid}/docs`, { title: 'Deep', summary: 'x', section: 'Lonely / Deep' });
  assert.equal(r.statusCode, 200, r.body);
  r = await send('PATCH', `/api/docs/${r.json().id}`, { summary: LONG, body: BODY });
  assert.equal(r.statusCode, 200, r.body);
  const small = fill(pid, 'Small', 1);
  r = await send('POST', `/api/projects/${pid}/sections`, { name: 'Sub', parent_id: small });
  assert.equal(r.statusCode, 200, r.body);
});
