import { test } from 'node:test';
import assert from 'node:assert/strict';

// Drafts (web/src/drafts.ts): kept per place in local storage, gone when emptied or cleared, dropped after 14 days.
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
const d = await import('../src/drafts.ts');
const file = (id: string, age = 0) => ({ id, name: `${id}.png`, mime: 'image/png', kind: 'image', size: 1, url: `/a/${id}`, created_at: Date.now() - age }) as any;

test('a draft is kept per place and comes back', () => {
  d.patchDraft('thread:t1', { text: 'half a thought' });
  d.patchDraft('thread:t2', { text: 'another place' });
  assert.equal(d.readDraft('thread:t1')?.text, 'half a thought');
  assert.equal(d.readDraft('thread:t2')?.text, 'another place');
  assert.equal(d.readDraft('thread:t3'), null);
});

test('emptying the box or clearing removes it', () => {
  d.patchDraft('request:r1', { text: 'a note' });
  d.patchDraft('request:r1', { text: '   ' });
  assert.equal(d.readDraft('request:r1'), null);
  assert.equal(mem.has('helm-draft:request:r1'), false);
  d.patchDraft('request:r2', { text: 'sent soon' });
  d.clearDraft('request:r2');
  assert.equal(d.readDraft('request:r2'), null);
});

test('files and the context come back with the words; context alone is no draft', () => {
  d.patchDraft('chat:p:general:', { extra: { ctx: { kind: 'task', id: 't' } } });
  assert.equal(d.readDraft('chat:p:general:'), null, 'extra alone is not a draft');
  d.patchDraft('chat:p:general:', { files: [file('a'), file('old', 21 * 3600 * 1000)] });
  const got = d.readDraft('chat:p:general:')!;
  assert.deepEqual(got.extra, { ctx: { kind: 'task', id: 't' } });
  assert.deepEqual(d.usableFiles(got).map((a) => a.id), ['a'], 'an upload the server has swept is not restored');
  assert.equal(d.draftGist(got), '2 attached');
  d.patchDraft('chat:p:general:', { text: 'first words of a long message that goes on and on past forty characters' });
  assert.match(d.draftGist(d.readDraft('chat:p:general:')), /^first words of a long message that goes…$/);
});

test('a draft older than 14 days is dropped', () => {
  mem.set('helm-draft:thread:old', JSON.stringify({ text: 'stale', files: [], at: Date.now() - 15 * 24 * 3600 * 1000 }));
  mem.set('helm-draft:thread:fresh', JSON.stringify({ text: 'recent', files: [], at: Date.now() - 13 * 24 * 3600 * 1000 }));
  assert.equal(d.readDraft('thread:old'), null);
  assert.equal(mem.has('helm-draft:thread:old'), false, 'removed when read');
  assert.equal(d.readDraft('thread:fresh')?.text, 'recent');
  // Writing the context of an old draft does not make it young again.
  const at = Date.now() - 10 * 24 * 3600 * 1000;
  mem.set('helm-draft:thread:aging', JSON.stringify({ text: 'x', files: [], at }));
  d.patchDraft('thread:aging', { extra: 1 });
  assert.equal(JSON.parse(mem.get('helm-draft:thread:aging')!).at, at);
});
