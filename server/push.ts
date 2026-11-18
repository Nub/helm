import { createECDH, createHash, createPrivateKey, createCipheriv, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { all, db, get, newId, now, run } from './db.ts';
import type { Row } from './db.ts';
import { writeFileAtomic } from './safefs.ts';

/**
 * Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm, RFC 8188) and VAPID (RFC 8292), on node:crypto
 * alone: no dependency to package, and the whole protocol is the hundred lines below.
 *
 * - The VAPID key pair is made once and kept in <data>/push/vapid.json (0600). It never leaves this machine: browsers
 *   get only the public key, as applicationServerKey, and push services check our signature against it.
 * - A subscription is a push service URL (Apple's web.push.apple.com, FCM, Mozilla autopush) and the browser's
 *   keys. 404/410 from the service mean the subscription is gone: the row is deleted. 429 and 5xx are retried a
 *   bounded number of times. Every outcome is written to the row (last success, last error) for Setup to show.
 * - Payloads are encrypted for the one device; still, callers put only titles and one-line summaries in them.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_success_at INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  last_error_at INTEGER
);
`);

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

// ---------- VAPID keys ----------

type Vapid = { publicKey: string; privateJwk: Record<string, string> };
const VAPID_DIR = join(DATA_DIR, 'push');
const VAPID_FILE = join(VAPID_DIR, 'vapid.json');
let vapid: { publicRaw: Buffer; key: KeyObject } | null = null;

function loadVapid() {
  if (vapid) return vapid;
  let v: Vapid;
  if (existsSync(VAPID_FILE)) {
    v = JSON.parse(readFileSync(VAPID_FILE, 'utf8'));
  } else {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pub = publicKey.export({ format: 'jwk' });
    const raw = Buffer.concat([Buffer.from([4]), fromB64u(pub.x!), fromB64u(pub.y!)]);
    v = { publicKey: b64u(raw), privateJwk: privateKey.export({ format: 'jwk' }) as Record<string, string> };
    mkdirSync(VAPID_DIR, { recursive: true, mode: 0o700 });
    writeFileAtomic(VAPID_FILE, JSON.stringify(v) + '\n', { mode: 0o600, ifChanged: false });
  }
  // Tighten whatever an older file or a umask left.
  try {
    chmodSync(VAPID_FILE, 0o600);
  } catch {}
  vapid = { publicRaw: fromB64u(v.publicKey), key: createPrivateKey({ key: v.privateJwk as any, format: 'jwk' }) };
  return vapid;
}

/** The applicationServerKey browsers subscribe with (uncompressed P-256 point, base64url). */
export function vapidPublicKey(): string {
  return b64u(loadVapid().publicRaw);
}

/** Contact the push services may use (Apple requires one). The origin the subscription was made on, if https. */
function contact(origin: string): string {
  if (process.env.HELM_PUSH_CONTACT) return process.env.HELM_PUSH_CONTACT;
  return /^https:\/\//.test(origin) ? origin : 'mailto:helm-push@example.invalid';
}

/** The VAPID Authorization header for one push service (aud is its origin), valid 12 hours. */
export function vapidAuth(endpoint: string, origin: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const v = loadVapid();
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: contact(origin) })));
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key: v.key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${b64u(v.publicRaw)}`;
}

// ---------- payload encryption (RFC 8291) ----------

const RECORD_SIZE = 4096;
/** Largest plaintext one aes128gcm record can carry: record size less the 16-byte tag and the delimiter. */
export const MAX_PAYLOAD = RECORD_SIZE - 16 - 1 - 86;

/** Encrypt `plaintext` for a subscription's keys. Returns the request body. */
export function encryptPayload(plaintext: Buffer, p256dh: string, auth: string): Buffer {
  const uaPublic = fromB64u(p256dh);
  const authSecret = fromB64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('Bad subscription key (p256dh)');
  if (authSecret.length !== 16) throw new Error('Bad subscription secret (auth)');
  if (plaintext.length > MAX_PAYLOAD) throw new Error(`Payload too large (${plaintext.length} bytes)`);
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // One record, so it is the last: delimiter 0x02, no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// ---------- subscriptions ----------

export type SubscriptionInput = { endpoint: string; keys: { p256dh: string; auth: string } };

/** A readable device name from a user agent: "iPhone", "iPad", "Chrome on Mac"… The user can rename it. */
export function deviceLabel(ua: string): string {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile\//.test(ua))) return 'iPad';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** Only https push service URLs, so this cannot be pointed at a service inside the network. */
export function validEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' || (process.env.HELM_PUSH_ALLOW_HTTP === '1' && u.protocol === 'http:');
  } catch {
    return false;
  }
}

/** Add or refresh this device's subscription; an existing row (same endpoint, or `replaces`) keeps its label and switch. */
export function saveSubscription(sub: SubscriptionInput, origin: string, userAgent: string, replaces?: string): Row {
  const old = get('SELECT * FROM push_subscriptions WHERE endpoint = ?', sub.endpoint) ?? (replaces ? get('SELECT * FROM push_subscriptions WHERE endpoint = ?', replaces) : undefined);
  if (old) {
    run('UPDATE push_subscriptions SET endpoint = ?, p256dh = ?, auth = ?, origin = ?, user_agent = ?, last_error = \'\', last_error_at = NULL WHERE id = ?', sub.endpoint, sub.keys.p256dh, sub.keys.auth, origin || old.origin, userAgent || old.user_agent, old.id);
    return get('SELECT * FROM push_subscriptions WHERE id = ?', old.id)!;
  }
  const id = newId('push');
  run(
    'INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, origin, label, user_agent, created_at) VALUES (?,?,?,?,?,?,?,?)',
    id, sub.endpoint, sub.keys.p256dh, sub.keys.auth, origin, deviceLabel(userAgent), userAgent, now(),
  );
  return get('SELECT * FROM push_subscriptions WHERE id = ?', id)!;
}

export const listSubscriptions = () => all('SELECT * FROM push_subscriptions ORDER BY created_at');

/** What the UI may see of a subscription: never its keys. The endpoint only as its service's host. */
export function subscriptionView(r: Row): Row {
  let service = '';
  try {
    service = new URL(r.endpoint).host;
  } catch {}
  return {
    id: r.id, label: r.label, origin: r.origin, enabled: !!r.enabled, service, created_at: r.created_at,
    last_success_at: r.last_success_at, last_error: r.last_error, last_error_at: r.last_error_at,
  };
}

// ---------- sending ----------

export type PushOptions = {
  /** Seconds the push service keeps it for an offline device. */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Replaces an undelivered message with the same topic at the push service (≤ 32 base64url characters). */
  topic?: string;
};

export type SendResult = { ok: true; status: number } | { ok: false; status: number; error: string; gone: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Attempts for 429 and 5xx, with these waits between them (Retry-After wins, up to a minute). */
export const RETRY_WAITS = [2000, 10000];

/** Send one push to one subscription row. Never throws; records the outcome on the row; deletes it if gone. */
export async function sendPush(sub: Row, payload: unknown, opts: PushOptions = {}, waits = RETRY_WAITS): Promise<SendResult> {
  let result: SendResult = { ok: false, status: 0, error: 'not sent', gone: false };
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    result = await sendOnce(sub, payload, opts);
    if (result.ok || result.gone) break;
    const retryable = result.status === 0 || result.status === 429 || result.status >= 500;
    if (!retryable || attempt === waits.length) break;
    await sleep((result as any).retryAfter ?? waits[attempt]);
  }
  if (result.ok) run("UPDATE push_subscriptions SET last_success_at = ?, last_error = '', last_error_at = NULL WHERE id = ?", now(), sub.id);
  else if (result.gone) run('DELETE FROM push_subscriptions WHERE id = ?', sub.id);
  else run('UPDATE push_subscriptions SET last_error = ?, last_error_at = ? WHERE id = ?', result.error.slice(0, 300), now(), sub.id);
  return result;
}

/**
 * The Topic header for a notification tag: exactly 32 base64url characters (24 bytes of the tag's SHA-256). Apple's
 * push service answered 400 BadWebPushTopic to a tag merely stripped to letters and digits, so the topic is always a
 * well-formed base64url value of the full allowed length; the same tag always gives the same topic.
 */
export const pushTopic = (tag: string) => createHash('sha256').update(tag).digest().subarray(0, 24).toString('base64url');

async function sendOnce(sub: Row, payload: unknown, opts: PushOptions): Promise<SendResult & { retryAfter?: number }> {
  let body: Buffer;
  try {
    body = encryptPayload(Buffer.from(JSON.stringify(payload)), sub.p256dh, sub.auth);
  } catch (err: any) {
    return { ok: false, status: 0, error: String(err?.message ?? err), gone: false };
  }
  const headers: Record<string, string> = {
    authorization: vapidAuth(sub.endpoint, sub.origin),
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(opts.ttl ?? 24 * 3600),
    urgency: opts.urgency ?? 'normal',
  };
  if (opts.topic) headers.topic = pushTopic(opts.topic);
  try {
    const post = () => fetch(sub.endpoint, { method: 'POST', headers, body: new Uint8Array(body), signal: AbortSignal.timeout(15000), redirect: 'error' });
    const errorText = async (r: Response) => (r.ok ? '' : (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200));
    let res = await post();
    let text = await errorText(res);
    // A push service that still refuses the topic (Apple: 400 BadWebPushTopic) gets the message without one:
    // delivered and not collapsed beats not delivered.
    if (res.status === 400 && headers.topic && /topic/i.test(text)) {
      delete headers.topic;
      res = await post();
      text = await errorText(res);
    }
    const status = res.status;
    if (status >= 200 && status < 300) return { ok: true, status };
    const ra = Number(res.headers.get('retry-after'));
    return {
      ok: false, status, gone: status === 404 || status === 410,
      error: `${status} from ${new URL(sub.endpoint).host}${text ? `: ${text}` : ''}`,
      ...(ra > 0 ? { retryAfter: Math.min(ra, 60) * 1000 } : {}),
    };
  } catch (err: any) {
    return { ok: false, status: 0, error: `Could not reach ${new URL(sub.endpoint).host}: ${err?.cause?.code ?? err?.message ?? err}`, gone: false };
  }
}
