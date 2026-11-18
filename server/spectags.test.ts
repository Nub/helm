import './testenv.ts';
// The Spec's tag vocabulary: the three-tag limit on agents' writes and retag across entries. `node --test server/spectags.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const spec = await import('./spec.ts');

const AGENT = { author: 'agent' as const, name: 'Director' };
const USER = { author: 'user' as const, name: 'You' };

function makeProject() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'Tags', tmpdir(), 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  return id;
}
function save(pid: string, existing: string | null, input: Record<string, unknown>, by: typeof AGENT | typeof USER = AGENT) {
  const row = existing ? spec.getDoc(existing)! : null;
  return spec.saveDoc(pid, row as any, { summary: 'What must be true.', ...input } as any, by);
}
const tagsOf = (id: string) => spec.parseTags(spec.getDoc(id)!.tags);
const revs = (id: string) => db.all('SELECT * FROM doc_revisions WHERE doc_id = ?', id).length;

test('an agent may give an entry at most three tags, and is told the tags in use', () => {
  const pid = makeProject();
  const a = save(pid, null, { title: 'A', tags: ['ios', 'security'] });
  assert.ok('id' in a);
  const b = save(pid, null, { title: 'B', tags: ['ios', 'deploy', 'cost'] });
  assert.ok('id' in b);
  const c = save(pid, null, { title: 'C', tags: ['ios', 'deploy', 'cost', 'extra'] });
  assert.ok('error' in c);
  assert.match(c.error, /At most 3 tags/);
  assert.match(c.error, /ios \(2\)/, 'names the existing tags with counts');
  assert.equal(db.get("SELECT COUNT(*) AS n FROM docs WHERE project_id = ? AND title = 'C'", pid)!.n, 0, 'nothing created');
  // Normalised first: "#iOS" and "ios" are one tag, so this is three.
  assert.ok('id' in save(pid, null, { title: 'D', tags: ['#iOS', 'ios', 'deploy', 'cost'] }));
});

test('entries from before the limit keep their tags; an edit may keep or trim them but not add', () => {
  const pid = makeProject();
  // Written by the user (not limited), standing in for an entry from before the limit.
  const old = save(pid, null, { title: 'Old', tags: ['a', 'b', 'c', 'd', 'e'] }, USER);
  assert.ok('id' in old);
  const id = old.id;
  assert.deepEqual(tagsOf(id), ['a', 'b', 'c', 'd', 'e']);
  // An agent's edit that leaves tags alone, or sends them back unchanged, or trims them, works.
  assert.ok('id' in save(pid, id, { body: 'New text.' }));
  assert.ok('id' in save(pid, id, { tags: ['a', 'b', 'c', 'd', 'e'] }));
  assert.ok('id' in save(pid, id, { tags: ['a', 'b', 'c', 'd'] }));
  assert.deepEqual(tagsOf(id), ['a', 'b', 'c', 'd']);
  // Adding a new tag while over the limit is refused.
  const add = save(pid, id, { tags: ['a', 'b', 'c', 'd', 'f'] });
  assert.ok('error' in add);
  assert.deepEqual(tagsOf(id), ['a', 'b', 'c', 'd']);
  // The user is not limited.
  assert.ok('id' in save(pid, id, { tags: ['a', 'b', 'c', 'd', 'f'] }, USER));
});

test('retag renames, merges and removes across entries in one go, recorded as revisions, no planning task', () => {
  const pid = makeProject();
  const ids = [
    save(pid, null, { title: 'One', tags: ['sector', 'combat'] }),
    save(pid, null, { title: 'Two', tags: ['sectors', 'sector'] }),
    save(pid, null, { title: 'Three', tags: ['ui'] }),
  ].map((r) => ('id' in r ? r.id : assert.fail(r.error)));
  const before = ids.map(revs);

  // Merge two near-synonyms into one: an entry that had both ends with it once.
  const m = spec.retagDocs(pid, ['sectors', '#Sector'], 'sector', AGENT);
  assert.deepEqual(m, { changed: 1, to: 'sector' });
  assert.deepEqual(tagsOf(ids[0]), ['sector', 'combat'], 'unchanged entry untouched');
  assert.deepEqual(tagsOf(ids[1]), ['sector']);
  assert.deepEqual(ids.map(revs), [before[0], before[1] + 1, before[2]], 'one revision for the one entry that changed');

  // Rename.
  assert.deepEqual(spec.retagDocs(pid, ['sector'], 'world', AGENT), { changed: 2, to: 'world' });
  assert.deepEqual(tagsOf(ids[0]), ['world', 'combat']);
  assert.deepEqual(tagsOf(ids[1]), ['world']);

  // Remove.
  assert.deepEqual(spec.retagDocs(pid, ['world'], null, AGENT), { changed: 2, to: null });
  assert.deepEqual(tagsOf(ids[0]), ['combat']);
  assert.deepEqual(tagsOf(ids[1]), []);
  assert.deepEqual(spec.tagCounts(pid), [['combat', 1], ['ui', 1]]);

  // A tag no entry has is an error that lists the tags in use; nothing changes.
  const none = spec.retagDocs(pid, ['nope'], 'x', AGENT);
  assert.ok('error' in none && /combat \(1\)/.test(none.error));

  // Tags are not content: even the user's tag-only edit opens no pending change, and retag never does.
  assert.ok('id' in save(pid, ids[2], { tags: ['ui', 'hud'] }, USER));
  spec.retagDocs(pid, ['hud'], 'ui', USER);
  for (const id of ids) assert.equal(spec.getDoc(id)!.spec_state, '', `${id} has no pending change`);
});

test('list_docs ends with the tags in use and the limit', () => {
  const pid = makeProject();
  save(pid, null, { title: 'One', tags: ['ios'] });
  save(pid, null, { title: 'Two', tags: ['ios', 'cost'] });
  assert.match(spec.renderSpec(pid), /Tags in use \(reuse these; at most 3 per entry\): ios \(2\), cost \(1\)\./);
});
