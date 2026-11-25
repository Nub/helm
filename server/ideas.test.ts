import { SCRATCH } from './testenv.ts';
// The Ideas board (ideas.ts, ideasapi.ts, ideastools.ts): cards, frames that hold and move them, link previews, image
// uploads, Discuss on a frame, and the director's list_ideas / add_idea. `node --test server/ideas.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const structure = await import('./structure.ts');
const agents = await import('./agents.ts');
const ideas = await import('./ideas.ts');
const attachments = await import('./attachments.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

const sent: { to: string; text: string; files: any[] }[] = [];
agents.bindAgentOps('test', {
  send: async (to: string, text: string, _from: unknown, files?: any[]) => {
    sent.push({ to, text, files: files ?? [] });
  },
  close: async () => {},
  interrupt: async () => {},
  restartForProjects: () => {},
  resolvePermission: () => {},
  liveAgentIds: () => new Set(),
} as any);

const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];
const call = async (method: string, url: string, payload?: unknown) => {
  const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { cookie } });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};

// A 1×1 PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function project() {
  const pid = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, 'ideas', SCRATCH, 'Build', 'auto', JSON.stringify(structure.defaultStructure()), db.now(), db.now());
  return db.get('SELECT * FROM projects WHERE id = ?', pid)!;
}

async function upload(pid: string, x: number, y: number) {
  const boundary = '----helmtest';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const r = await app.inject({ method: 'POST', url: `/api/projects/${pid}/ideas/images?x=${x}&y=${y}`, payload: body, headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().cards[0];
}

/** A fetch that serves a page with Open Graph tags and its image. */
const fakeFetch = (async (u: URL | string) => {
  const url = String(u);
  if (url.startsWith('https://example.org/post')) {
    return new Response(`<html><head><title>Fallback</title><meta property="og:title" content="A &amp; B: the post"><meta content="/img.png" property="og:image"><meta property="og:site_name" content="Example"></head></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (url === 'https://example.org/img.png') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
  return new Response('nope', { status: 404 });
}) as typeof fetch;

test('notes and links: add, edit, move, resize, delete; a link gets its title and image', async () => {
  const p = project();
  const note = (await call('POST', `/api/projects/${p.id}/ideas/cards`, { kind: 'note', text: '# Hello\nworld', x: 10, y: 20 })).body;
  assert.equal(note.kind, 'note');
  assert.deepEqual([note.x, note.y], [10, 20]);
  const edited = (await call('PATCH', `/api/ideas/cards/${note.id}`, { text: 'changed', x: 50, y: 60, w: 300, h: 200 })).body;
  assert.deepEqual([edited.text, edited.x, edited.y, edited.w, edited.h], ['changed', 50, 60, 300, 200]);
  assert.equal((await call('PATCH', `/api/ideas/cards/${note.id}`, { w: 5 })).body.w, 80, 'a card has a minimum size');

  assert.equal((await call('POST', `/api/projects/${p.id}/ideas/cards`, { kind: 'link', url: 'javascript:alert(1)' })).status, 400);
  const link = (await call('POST', `/api/projects/${p.id}/ideas/cards`, { kind: 'link', url: 'example.org/post', x: 400, y: 0 })).body;
  assert.equal(link.url, 'https://example.org/post');
  assert.equal(link.text, 'https://example.org/post', 'the address until the preview arrives');
  const after = (await ideas.fetchLinkPreview(link.id, fakeFetch))!;
  assert.equal(after.text, 'A & B: the post');
  assert.equal(after.site, 'Example');
  const img = attachments.getAttachment(after.image_id)!;
  assert.equal(img.kind, 'image');
  assert.equal(img.owner_id, link.id);

  const board = (await call('GET', `/api/projects/${p.id}/ideas`)).body;
  assert.equal(board.cards.length, 2);
  assert.ok(board.cards.find((c: any) => c.id === link.id).image.url, 'the board shows the preview image');

  assert.equal((await call('DELETE', `/api/ideas/cards/${link.id}`)).status, 200);
  assert.equal(attachments.getAttachment(img.id), undefined, 'its preview image goes with it');
  assert.ok(!existsSync(attachments.attachmentPath(img)));
  assert.equal((await call('GET', `/api/projects/${p.id}/ideas`)).body.cards.length, 1);
});

test('the meta parser reads Open Graph, Twitter and <title>, in any attribute order', () => {
  const a = ideas.parseLinkMeta(`<title> Plain  title </title>`, 'https://x.test/a/b');
  assert.deepEqual(a, { title: 'Plain title', site: null, image: null });
  const b = ideas.parseLinkMeta(`<meta name='twitter:image' content='pic.jpg'><meta name="twitter:title" content="Tw">`, 'https://x.test/a/b');
  assert.deepEqual(b, { title: 'Tw', site: null, image: 'https://x.test/a/pic.jpg' });
});

test('image cards: an uploaded image becomes a card, deleting it removes the file', async () => {
  const p = project();
  const card = await upload(p.id, 100, 120);
  assert.equal(card.kind, 'image');
  assert.deepEqual([card.x, card.y], [100, 120]);
  assert.equal(card.image.kind, 'image');
  const a = attachments.getAttachment(card.image.id)!;
  assert.equal(a.owner_kind, 'idea');
  assert.equal(a.owner_id, card.id);
  await call('DELETE', `/api/ideas/cards/${card.id}`);
  assert.equal(attachments.getAttachment(a.id), undefined);
});

test('frames: a card dropped in belongs to it, moving the frame moves its cards, deleting it leaves them', async () => {
  const p = project();
  const frame = (await call('POST', `/api/projects/${p.id}/ideas/frames`, { name: 'Onboarding', x: 0, y: 0, w: 600, h: 400 })).body;
  const inside = (await call('POST', `/api/projects/${p.id}/ideas/cards`, { kind: 'note', text: 'in', x: 20, y: 40 })).body;
  const outside = (await call('POST', `/api/projects/${p.id}/ideas/cards`, { kind: 'note', text: 'out', x: 900, y: 40 })).body;
  assert.equal(inside.frame_id, frame.id);
  assert.equal(outside.frame_id, null);
  // Dropped into the frame: it joins.
  assert.equal((await call('PATCH', `/api/ideas/cards/${outside.id}`, { x: 300, y: 200 })).body.frame_id, frame.id);
  // Dragged out: it leaves.
  assert.equal((await call('PATCH', `/api/ideas/cards/${outside.id}`, { x: 1200, y: 200 })).body.frame_id, null);
  // A smaller frame inside the first takes the cards over its area.
  const inner = (await call('POST', `/api/projects/${p.id}/ideas/frames`, { name: 'Inner', x: 10, y: 30, w: 260, h: 200 })).body;
  assert.equal(ideas.getCard(inside.id)!.frame_id, inner.id);
  await call('DELETE', `/api/ideas/frames/${inner.id}`);
  assert.equal(ideas.getCard(inside.id)!.frame_id, frame.id);

  const moved = (await call('PATCH', `/api/ideas/frames/${frame.id}`, { x: 1000, y: 500, name: 'Renamed' })).body;
  assert.equal(moved.name, 'Renamed');
  const c = ideas.getCard(inside.id)!;
  assert.deepEqual([c.x, c.y, c.frame_id], [1020, 540, frame.id], 'its card moved with it');
  assert.deepEqual([ideas.getCard(outside.id)!.x, ideas.getCard(outside.id)!.y], [1200, 200], 'a card outside did not');

  await call('DELETE', `/api/ideas/frames/${frame.id}`);
  const left = ideas.getCard(inside.id)!;
  assert.deepEqual([left.x, left.y, left.frame_id], [1020, 540, null]);
});

test('Discuss on a frame starts a discussion holding its cards, images attached, and the frame links to it', async () => {
  const p = project();
  const frame = (await call('POST', `/api/projects/${p.id}/ideas/frames`, { name: 'Pricing page', x: 0, y: 0, w: 800, h: 600 })).body;
  assert.equal((await call('POST', `/api/ideas/frames/${frame.id}/discuss`)).status, 400, 'an empty frame has nothing to discuss');
  await call('POST', `/api/projects/${p.id}/ideas/cards`, { kind: 'note', text: 'Three tiers, monthly and yearly', x: 20, y: 40 });
  const link = (await call('POST', `/api/projects/${p.id}/ideas/cards`, { kind: 'link', url: 'https://example.org/post', x: 300, y: 40 })).body;
  await ideas.fetchLinkPreview(link.id, fakeFetch);
  await upload(p.id, 20, 300);
  await call('POST', `/api/projects/${p.id}/ideas/cards`, { kind: 'note', text: 'not in the frame', x: 2000, y: 0 });

  sent.length = 0;
  const r = await call('POST', `/api/ideas/frames/${frame.id}/discuss`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.existing, false);
  const d = db.get('SELECT * FROM tasks WHERE id = ?', r.body.id)!;
  assert.equal(d.kind, 'discussion');
  assert.equal(d.title, 'Pricing page');
  const msg = db.get("SELECT * FROM task_messages WHERE task_id = ? AND kind = 'message'", d.id)!;
  assert.equal(msg.author, 'user');
  assert.match(msg.body, /Three tiers/);
  assert.match(msg.body, /\[A & B: the post\]\(https:\/\/example\.org\/post\) \(Example\)/);
  assert.match(msg.body, /Image: photo\.png/);
  assert.doesNotMatch(msg.body, /not in the frame/);
  const files = attachments.listAttachments('message', String(msg.id));
  assert.equal(files.length, 1);
  assert.equal(files[0].kind, 'image');
  assert.ok(existsSync(attachments.attachmentPath(files[0])));
  // Delivered to the director as a new discussion, with the image.
  const director = agents.rootAgent(p);
  const toDirector = sent.find((s) => s.to === director.id)!;
  assert.match(toDirector.text, new RegExp(`<discussion-message discussion="${d.id}" title="Pricing page" new="true">`));
  assert.equal(toDirector.files.length, 1);
  // The frame links to it, and Discuss again opens the same one.
  const board = (await call('GET', `/api/projects/${p.id}/ideas`)).body;
  assert.equal(board.frames[0].discussion.id, d.id);
  const again = await call('POST', `/api/ideas/frames/${frame.id}/discuss`);
  assert.deepEqual(again.body, { id: d.id, existing: true });
});

test('the director lists the board and adds notes, links and images, into frames by name', async () => {
  const p = project();
  const director = agents.rootAgent(p);
  const ts = helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(JSON.parse(p.structure), director.role_id, director.parent_id));
  const run = async (name: string, input: Record<string, unknown>) => {
    const t = ts.find((x: any) => x.name === name);
    assert.ok(t, `${name} is a director tool`);
    const res: any = await t.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  assert.match((await run('list_ideas', {})).text, /empty/);
  const a = await run('add_idea', { kind: 'note', text: 'Dark mode first', frame: 'Look and feel' });
  assert.ok(!a.error, a.text);
  assert.match(a.text, /New frame "Look and feel"/);
  const b = await run('add_idea', { kind: 'note', text: 'Bigger tap targets', frame: 'look and feel' });
  assert.ok(!b.error, b.text);
  assert.doesNotMatch(b.text, /New frame/);
  const frame = ideas.findFrame(p.id, 'Look and feel')!;
  const cards = db.all('SELECT * FROM idea_cards WHERE project_id = ? ORDER BY created_at', p.id);
  assert.ok(cards.every((c) => c.frame_id === frame.id && c.author === 'director'));
  assert.ok(cards[1].y > cards[0].y, 'the second goes under the first');
  assert.ok(ideas.getFrame(frame.id)!.h >= cards[1].y + cards[1].h - frame.y, 'the frame grew to hold them');
  assert.ok((await run('add_idea', { kind: 'note', text: 'x', frame: 'if_0000000000' })).error);
  assert.ok((await run('add_idea', { kind: 'link', url: 'ftp://nope' })).error);

  // Helm's data folder is off limits to agents: the file is in /tmp, as an agent's screenshot would be.
  const dir = mkdtempSync(join(tmpdir(), 'helm-ideas-test-'));
  try {
    writeFileSync(join(dir, 'mock.png'), PNG);
    const img = await run('add_idea', { kind: 'image', path: join(dir, 'mock.png') });
    assert.ok(!img.error, img.text);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const listed = (await run('list_ideas', {})).text;
  assert.match(listed, /Frame "Look and feel"/);
  assert.match(listed, /Dark mode first/);
  assert.match(listed, /In no frame:\n- ic_\w+ image .*mock\.png/);
});
