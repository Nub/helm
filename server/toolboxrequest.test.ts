import { SCRATCH } from './testenv.ts';
// A tool proposal reaches Needs you as a request with Install and Decline (toolbox.ts fileProposalRequest): Install
// installs for every project through the request's action, Decline declines the item; one that needs credentials
// carries Decline only. `node --test server/toolboxrequest.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const { answerInbox } = await import('./answers.ts');
const { proposeFromAgent, getItem } = await import('./toolbox.ts');

function setup() {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'tb', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  return { project, director: runtime.rootAgent(project) };
}
const proposal = (name: string, extra: Record<string, unknown> = {}) => ({
  kind: 'mcp_http', name, source_type: 'http_url', source: `https://tools.example/${name}/mcp`, summary: 'Reads library docs.', problem: 'Agents guess at APIs.',
  evidence: 'Three repeated errors on one API.', install_effect: 'One MCP server for every project.', access: 'Network, read only.', risks: 'Remote service sees queries.',
  recommendation: 'install', recommendation_reason: 'It removed the guessing in a trial.', auth: 'none', ...extra,
}) as any;
const requestFor = (itemId: string) => db.get("SELECT * FROM inbox WHERE payload LIKE ?", `%"toolbox":"${itemId}"%`)!;

test('a proposal files a request with Install and Decline; Install installs it', async () => {
  const { director } = setup();
  const res = proposeFromAgent(director, proposal('docs-reader'));
  assert.ok(!res.error, res.text);
  assert.match(res.text, /Needs you/);
  const item = db.get("SELECT * FROM toolbox_items WHERE name = 'docs-reader'")!;
  const req = requestFor(item.id);
  assert.equal(req.kind, 'question');
  assert.deepEqual(JSON.parse(req.options).map((o: any) => o.label), ['Install', 'Decline']);
  assert.match(req.body, /Evidence: Three repeated errors/);
  assert.deepEqual(JSON.parse(req.payload).act, { kind: 'install_tool', target: item.id, option: 'Install' });
  assert.equal(await answerInbox(req.id, { choice: 'Install' }), null);
  assert.equal(getItem(item.id)!.status, 'installed');
  assert.equal(db.get('SELECT status FROM inbox WHERE id = ?', req.id)!.status, 'answered');
});

test('Decline declines the item with the note; a proposal needing credentials offers Decline only', async () => {
  const { director } = setup();
  proposeFromAgent(director, proposal('search-api'));
  const item = db.get("SELECT * FROM toolbox_items WHERE name = 'search-api'")!;
  assert.equal(await answerInbox(requestFor(item.id).id, { choice: 'Decline', text: 'Not needed.' }), null);
  const after = getItem(item.id)!;
  assert.equal(after.status, 'declined');
  assert.equal(after.decided_note, 'Not needed.');

  proposeFromAgent(director, proposal('private-api', { auth: 'bearer token', secrets: [{ name: 'API_KEY', where: 'header' }] }));
  const secret = db.get("SELECT * FROM toolbox_items WHERE name = 'private-api'")!;
  const req = requestFor(secret.id);
  assert.deepEqual(JSON.parse(req.options).map((o: any) => o.label), ['Decline']);
  assert.match(req.body, /System › Tools \(it needs credentials\)/);
  assert.equal(JSON.parse(req.payload).act, undefined);
});
