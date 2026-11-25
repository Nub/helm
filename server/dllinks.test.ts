import { SCRATCH } from './testenv.ts';
// Release download links (dllinks.ts): a valid link downloads without a session; expired, revoked, unknown and
// malformed tokens and other methods get 404; nothing but release files is served; only the user (the session) makes
// one, and no agent tool does. `node --test server/dllinks.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';

const db = await import('./db.ts');
const { config, ARTIFACT_DIR } = await import('./config.ts');
const { registerApi } = await import('./api.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const links = await import('./dllinks.ts');
const { helmTools, toolAccess } = await import('./tools.ts');

db.freezeClock();
const app = Fastify();
registerApi(app);
await app.ready();
const login = await app.inject({ method: 'POST', url: '/api/login', payload: { token: config.token } });
const cookie = String(login.headers['set-cookie']).split(';')[0];

function setup(state = 'ready') {
  const pid = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, 'Game', SCRATCH, 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const rid = db.newId('rel');
  db.run('INSERT INTO releases (id, project_id, version, commit_sha, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', rid, pid, '1.4.0', 'abc', state, db.now(), db.now());
  const dir = join(ARTIFACT_DIR, 'releases', pid, rid);
  mkdirSync(dir, { recursive: true });
  const file = (name: string, body: string) => {
    const aid = db.newId('art');
    writeFileSync(join(dir, `${aid}-${name}`), body);
    db.run('INSERT INTO release_artifacts (id, release_id, project_id, name, file, bytes, sha256, created_at) VALUES (?,?,?,?,?,?,?,?)', aid, rid, pid, name.split('.')[0], `releases/${pid}/${rid}/${aid}-${name}`, body.length, 'x', db.now());
    return aid;
  };
  return { pid, rid, a: file('game.zip', 'ZIPDATA'), b: file('notes.txt', 'hello') };
}
const make = (rid: string, body: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/releases/${rid}/links`, headers: { cookie }, payload: body });
const fetchNoCookie = (path: string, method: 'GET' | 'HEAD' | 'POST' = 'GET') => app.inject({ method, url: path });

test('a valid link downloads the one file without a session, as an attachment, and is counted', async () => {
  const { rid, a } = setup();
  const res = await make(rid, { artifact: a, duration: '1h' });
  assert.equal(res.statusCode, 200, res.body);
  const { path, expires_at } = res.json();
  assert.match(path, /^\/dl\/[A-Za-z0-9_-]{43}$/);
  assert.equal(expires_at, db.now() + 3600_000);
  const dl = await fetchNoCookie(path);
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.body, 'ZIPDATA');
  assert.equal(dl.headers['content-disposition'], 'attachment; filename="game.zip"');
  assert.equal(dl.headers['set-cookie'], undefined, 'no cookie is set');
  assert.equal(dl.headers['cache-control'], 'no-store');
  const head = await fetchNoCookie(path, 'HEAD');
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['content-length'], '7');
  const listed = (await app.inject({ method: 'GET', url: `/api/releases/${rid}/links`, headers: { cookie } })).json().links;
  assert.equal(listed[0].uses, 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM download_log WHERE release_id = ?', rid)!.n, 1);
  // Only the hash is stored.
  const token = path.slice(4);
  assert.equal(db.get('SELECT 1 AS x FROM download_links WHERE token_hash = ?', token), undefined);
});

test('all files as one archive: a tar with each file under its name', async () => {
  const { rid } = setup();
  const { path } = (await make(rid, { artifact: null, duration: '15m' })).json();
  const dl = await fetchNoCookie(path);
  assert.equal(dl.statusCode, 200);
  assert.match(String(dl.headers['content-disposition']), /filename="Game-1\.4\.0\.tar"/);
  const raw = dl.rawPayload;
  assert.equal(raw.length, Number(dl.headers['content-length']));
  assert.equal(raw.subarray(0, 8).toString(), 'game.zip');
  assert.equal(raw.subarray(512, 519).toString(), 'ZIPDATA');
  assert.equal(raw.subarray(1024, 1033).toString(), 'notes.txt');
});

test('expired, revoked, unknown and malformed tokens, other methods and other paths are 404', async () => {
  const { rid, a, b } = setup();
  const exp = (await make(rid, { artifact: a, duration: '15m' })).json();
  const rev = (await make(rid, { artifact: b, duration: '7d' })).json();
  assert.equal((await fetchNoCookie(exp.path)).statusCode, 200);
  db.advanceClock(15 * 60_000 + 1);
  assert.equal((await fetchNoCookie(exp.path)).statusCode, 404, 'expired');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/links/${rev.id}`, headers: { cookie } })).statusCode, 200);
  assert.equal((await fetchNoCookie(rev.path)).statusCode, 404, 'revoked');
  assert.equal((await fetchNoCookie(`/dl/${'A'.repeat(43)}`)).statusCode, 404, 'unknown');
  for (const bad of ['/dl/short', '/dl/../../etc/passwd', `/dl/${'A'.repeat(43)}/x`, '/dl/', '/dl']) {
    const r = await fetchNoCookie(bad);
    assert.equal(r.statusCode, 404, bad);
    assert.doesNotMatch(r.body, /<html/i, 'never the app');
  }
  const live = (await make(rid, { artifact: a, duration: '1h' })).json();
  assert.equal((await fetchNoCookie(live.path, 'POST')).statusCode, 404, 'only GET and HEAD');
  // A release taken out of ready (failed, files removed) stops serving.
  db.run("UPDATE releases SET state = 'failed' WHERE id = ?", rid);
  assert.equal((await fetchNoCookie(live.path)).statusCode, 404);
});

test('only the user makes links: the API needs the session, and no agent tool makes or lists one', async () => {
  const { rid, a, pid } = setup();
  assert.equal((await app.inject({ method: 'POST', url: `/api/releases/${rid}/links`, payload: { artifact: a } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: `/api/releases/${rid}/links` })).statusCode, 401);
  const project = db.get('SELECT * FROM projects WHERE id = ?', pid)!;
  const director = runtime.rootAgent(project);
  const s = defaultStructure();
  const names = (helmTools(director.id, { spawn: async () => 'no', send: async () => {}, close: async () => {}, markComplete: () => {} } as any, toolAccess(s, director.role_id, null)) as any[]).map((t) => t.name);
  assert.ok(!names.some((n) => /link|download/i.test(n)), names.filter((n) => /link|download/i.test(n)).join(','));
  // A draft release gets no link; a file not in the release neither.
  const draft = setup('drafting');
  assert.equal((await make(draft.rid, { artifact: draft.a })).statusCode, 400);
  assert.equal((await make(rid, { artifact: draft.a })).statusCode, 400);
});

test('rate limit per address, and daily cleanup of expired and revoked links', async () => {
  const { rid, a } = setup();
  const { path } = (await make(rid, { artifact: a, duration: '7d' })).json();
  const codes: number[] = [];
  for (let i = 0; i < links.RATE_LIMIT + 5; i++) codes.push((await app.inject({ method: 'GET', url: path, remoteAddress: '203.0.113.9' })).statusCode);
  assert.ok(codes.includes(429));
  assert.equal(codes.filter((c) => c === 200).length <= links.RATE_LIMIT, true);
  db.advanceClock(8 * 24 * 3600_000);
  assert.ok(links.cleanLinks() >= 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM download_links WHERE release_id = ?', rid)!.n, 0);
});
