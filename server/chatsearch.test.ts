import './testenv.ts';
// The chat with the director in search (searchschema.ts view "chat", rankedsearch.ts, search.ts): what the user said
// and the director's replies are found as kind "chat"; thread messages, notes, final reports of other agents and
// replies that were not dialogue are not; a message filed into a discussion shows there only; chat ranks below tasks.
// Ranked and word matching alike. `node --test server/chatsearch.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import * as db from './db.ts';
import { defaultStructure } from './structure.ts';
import { createTask } from './tasks.ts';
import { renderFind, searchItems, setRankedSearchOn, rankedSearchSetting } from './search.ts';
import * as search from './search.ts';
import { buildSearchIndexNow, requestSearchRebuild } from './searchindex.ts';
import { searchView } from './searchapi.ts';
import { fileExchange } from './discussions.ts';

const P = 'p_chat';
db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', P, 'Chat', tmpdir(), 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
const agent = (id: string, name: string, parent: string | null) =>
  db.run('INSERT INTO agents (id, project_id, parent_id, role_id, name, model, task, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', id, P, parent, 'x', name, 'm', '', 'idle', db.now(), db.now());
agent('ag_dir', 'Director', null);
agent('ag_eng', 'Engineer', 'ag_dir');
const ev = (agentId: string, kind: string, data: object) => Number(db.run('INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES (?,?,?,?,?)', P, agentId, db.now(), kind, JSON.stringify(data)).lastInsertRowid);
const user = (text: string) => ev('ag_dir', 'inbound', { text, from: { kind: 'user', name: 'You' } });
const reply = (text: string, extra: object = {}) => ev('ag_dir', 'result', { ok: true, text, dialogue: true, ...extra });

// Before the index: these are found by the build, the rest below by the triggers.
const said = user('Could the export use parquet instead of CSV?');
const answered = reply('Parquet is fine; I filed it as a discussion.');
requestSearchRebuild();
buildSearchIndexNow();

const chatIds = (q: string) => searchItems(P, q).filter((h) => h.kind === 'chat').map((h) => h.id);

for (const mode of ['ranked', 'words'] as const) {
  test(`${mode}: the user's messages and the director's replies are found as chat`, () => {
    setRankedSearchOn(() => mode === 'ranked');
    try {
      assert.deepEqual(chatIds('parquet').sort(), [String(said), String(answered)].sort());
      assert.equal(search.lastSearchMode, mode);
      const u = searchItems(P, 'csv').find((h) => h.kind === 'chat')!;
      assert.equal(u.title, 'You');
      assert.equal(u.ref, '');
      const r = searchItems(P, 'filed discussion').find((h) => h.kind === 'chat')!;
      assert.equal(r.title, 'Director');
    } finally {
      setRankedSearchOn(rankedSearchSetting);
    }
  });
}

test('not the chat: thread messages and notes sent to the director, non-dialogue or replaced replies, other agents', () => {
  user('<task-message task="task_x" title="T">the albatross is in the thread</task-message>');
  ev('ag_dir', 'inbound', { text: 'albatross from Helm', from: { kind: 'system', name: 'Helm' } });
  reply('albatross routed to a task', { dialogue: false });
  reply('albatross replaced by a shorter one', { replaced: true });
  const report = ev('ag_eng', 'result', { ok: true, text: 'albatross final report' });
  ev('ag_eng', 'inbound', { text: 'albatross to an engineer', from: { kind: 'user', name: 'You' } });
  for (const mode of [true, false]) {
    setRankedSearchOn(() => mode);
    assert.deepEqual(chatIds('albatross'), [], `ranked ${mode}`);
    setRankedSearchOn(rankedSearchSetting);
  }
  // The engineer's final report stays an agent hit.
  assert.ok(searchItems(P, 'albatross').some((h) => h.kind === 'agent' && h.id === 'ag_eng'));
  void report;
  // The director's dialogue replies are no longer its "final reports".
  reply('the pelican is fine');
  assert.deepEqual(searchItems(P, 'pelican').map((h) => h.kind), ['chat']);
});

test('a message filed into a discussion shows once: the discussion', () => {
  const m = user('What about the heron tracker?');
  assert.deepEqual(chatIds('heron'), [String(m)]);
  const d = createTask(P, { title: 'Tracker idea', state: 'open', origin: 'user', kind: 'discussion' } as any, { author: 'user', name: 'You' });
  fileExchange(d, db.get('SELECT * FROM agents WHERE id = ?', 'ag_dir')!, [db.get('SELECT * FROM events WHERE id = ?', m)!], '');
  for (const mode of [true, false]) {
    setRankedSearchOn(() => mode);
    const hits = searchItems(P, 'heron');
    assert.deepEqual(hits.map((h) => `${h.kind}:${h.id}`), [`discussion:${d.id}`], `ranked ${mode}`);
    setRankedSearchOn(rankedSearchSetting);
  }
});

test('chat ranks below tasks and discussions; Home groups it after the Spec; find lists it without a reference', () => {
  user('The ibis importer keeps failing on large files');
  const t = createTask(P, { title: 'Ibis importer', description: 'Fails on large files.', state: 'active', origin: 'user' } as any, { author: 'user', name: 'You' });
  const hits = searchItems(P, 'ibis importer');
  assert.deepEqual(hits.map((h) => h.kind), ['task', 'chat']);
  assert.equal(hits[0].id, t.id);
  const groups = searchView('ibis', P).groups.map((g) => g.kind);
  assert.deepEqual(groups, ['task', 'chat']);
  assert.match(renderFind(P, 'ibis'), /\n- chat · chat · .* · You\n/);
});
