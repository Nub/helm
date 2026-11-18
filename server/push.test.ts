import './testenv.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The Web Push sender against a local mock push service that does what Apple's, Google's and Mozilla's do with a
 * request: checks the VAPID JWT (ES256 signature against k=, aud, exp, sub) and the headers, and the "browser" side
 * decrypts the body with its own keys (RFC 8291), written here independently of server/push.ts.
 */

process.env.HELM_PUSH_ALLOW_HTTP = '1';
const push = await import('./push.ts');
const db = await import('./db.ts');

const b64u = (b: Buffer) => b.toString('base64url');

/** A browser's subscription keys. */
function browser() {
  const ecdh = createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, pub, auth, keys: { p256dh: b64u(pub), auth: b64u(auth) } };
}

/** The receiving side of RFC 8291 / RFC 8188 for a single record. */
function decrypt(body: Buffer, b: ReturnType<typeof browser>): string {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const shared = b.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', shared, b.auth, Buffer.concat([Buffer.from('WebPush: info\0'), b.pub, asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return plain.subarray(0, -1).toString();
}

/** What a push service checks in the Authorization header. Returns the claims. */
function checkVapid(req: IncomingMessage, origin: string) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(String(req.headers.authorization));
  assert.ok(m, 'vapid authorization header');
  const [h, c, s] = m[1].split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { typ: 'JWT', alg: 'ES256' });
  const raw = Buffer.from(m[2], 'base64url');
  assert.equal(raw.length, 65);
  assert.equal(m[2], push.vapidPublicKey());
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), 'ES256 signature');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(claims.aud, origin);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600, 'exp within 24h');
  assert.match(claims.sub, /^(mailto:|https:)/);
  return claims;
}

type Seen = { status: number; body: Buffer; req: IncomingMessage };
async function mockService(answer: (n: number) => number | [number, Record<string, string>]) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const a = answer(seen.length);
      const [status, headers] = Array.isArray(a) ? a : [a, {}];
      seen.push({ status, body: Buffer.concat(chunks), req });
      res.writeHead(status, headers).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { seen, origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test('keys are made once and kept 0600 under the data directory', () => {
  const k = push.vapidPublicKey();
  assert.equal(push.vapidPublicKey(), k);
  const mode = statSync(join(process.env.HELM_DATA!, 'push', 'vapid.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('a push is VAPID-signed and decrypts to the payload with the subscription keys', async () => {
  const svc = await mockService(() => 201);
  const b = browser();
  const row = push.saveSubscription({ endpoint: `${svc.origin}/push/abc`, keys: b.keys }, 'https://helm.example.org', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1');
  assert.equal(row.label, 'iPhone');
  const payload = { title: 'Proj · Which colour?', body: 'Pick one', url: '#/p/x/tasks/y', tag: 't', badge: 2, urgent: true, ts: 1 };
  const r = await push.sendPush(row, payload, { urgency: 'high', ttl: 60, topic: 'needs:x' });
  assert.equal(r.ok, true);
  const got = svc.seen[0];
  const claims = checkVapid(got.req, svc.origin);
  assert.equal(claims.sub, 'https://helm.example.org');
  assert.equal(got.req.headers['content-encoding'], 'aes128gcm');
  assert.equal(got.req.headers.ttl, '60');
  assert.equal(got.req.headers.urgency, 'high');
  assert.match(String(got.req.headers.topic), /^[A-Za-z0-9_-]{32}$/);
  assert.equal(got.req.headers.topic, push.pushTopic('needs:x'));
  assert.deepEqual(JSON.parse(decrypt(got.body, b)), payload);
  assert.ok(db.get('SELECT last_success_at FROM push_subscriptions WHERE id = ?', row.id)!.last_success_at);
  svc.close();
});

test('410 and 404 remove the subscription', async () => {
  for (const code of [410, 404]) {
    const svc = await mockService(() => code);
    const row = push.saveSubscription({ endpoint: `${svc.origin}/gone/${code}`, keys: browser().keys }, '', 'Chrome/130');
    const r = await push.sendPush(row, { title: 'x' }, {}, [10, 10]);
    assert.equal(r.ok, false);
    assert.equal(svc.seen.length, 1, 'no retry');
    assert.equal(db.get('SELECT id FROM push_subscriptions WHERE id = ?', row.id), undefined);
    svc.close();
  }
});

test('429 and 5xx are retried a bounded number of times, then the error is recorded', async () => {
  const flaky = await mockService((n) => (n === 0 ? [429, { 'retry-after': '0' }] : n === 1 ? 503 : 201));
  const row = push.saveSubscription({ endpoint: `${flaky.origin}/flaky`, keys: browser().keys }, '', '');
  assert.equal((await push.sendPush(row, { title: 'x' }, {}, [10, 10])).ok, true);
  assert.equal(flaky.seen.length, 3);
  flaky.close();

  const down = await mockService(() => 500);
  const row2 = push.saveSubscription({ endpoint: `${down.origin}/down`, keys: browser().keys }, '', '');
  const r = await push.sendPush(row2, { title: 'x' }, {}, [10, 10]);
  assert.equal(r.ok, false);
  assert.equal(down.seen.length, 3, 'one try and two retries');
  assert.match(db.get('SELECT last_error FROM push_subscriptions WHERE id = ?', row2.id)!.last_error, /^500 from/);
  down.close();
});

test('400 is not retried; an unreachable service is recorded, not thrown', async () => {
  const svc = await mockService(() => 400);
  const row = push.saveSubscription({ endpoint: `${svc.origin}/bad`, keys: browser().keys }, '', '');
  assert.equal((await push.sendPush(row, { title: 'x' }, {}, [10, 10])).ok, false);
  assert.equal(svc.seen.length, 1);
  svc.close();
  const dead = push.saveSubscription({ endpoint: 'http://127.0.0.1:9/none', keys: browser().keys }, '', '');
  const r = await push.sendPush(dead, { title: 'x' }, {}, [10]);
  assert.equal(r.ok, false);
  assert.match(db.get('SELECT last_error FROM push_subscriptions WHERE id = ?', dead.id)!.last_error, /Could not reach/);
});

test('a moved subscription keeps its row, name and switch', () => {
  const a = push.saveSubscription({ endpoint: 'https://push.example/old', keys: browser().keys }, '', 'Chrome/130 Linux');
  db.run("UPDATE push_subscriptions SET label = 'Desk', enabled = 0 WHERE id = ?", a.id);
  const b = push.saveSubscription({ endpoint: 'https://push.example/new', keys: browser().keys }, '', '', 'https://push.example/old');
  assert.equal(b.id, a.id);
  assert.equal(b.label, 'Desk');
  assert.equal(b.enabled, 0);
  assert.equal(b.endpoint, 'https://push.example/new');
});

test('only http(s) push service URLs; payloads over one record are refused', () => {
  assert.equal(push.validEndpoint('file:///etc/passwd'), false);
  assert.equal(push.validEndpoint('https://web.push.apple.com/abc'), true);
  assert.throws(() => push.encryptPayload(Buffer.alloc(push.MAX_PAYLOAD + 1), browser().keys.p256dh, browser().keys.auth), /too large/);
});
