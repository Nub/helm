import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ARTIFACT_DIR } from './config.ts';
import { all, db, get, newId, now, run } from './db.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';

/**
 * Expiring download links for a release's files, made by the user on the Releases page and usable by anyone who has
 * one, without signing in (the user shares them).
 *
 * - A link is 32 random bytes (base64url, 43 characters), shown once; only its SHA-256 is stored, with the release, one
 *   file (or all of them as one archive), the expiry, the uses and when it was revoked.
 * - GET or HEAD /dl/<token> serves that file as an attachment, its name from the release record. Anything else, an
 *   unknown, malformed, expired or revoked token, a release no longer ready or published, a file removed: the same
 *   404 as any unknown address. No cookie is read or set; nothing but release files can be reached (the path comes
 *   from release_artifacts, never from the request, and is checked to lie under the release folder).
 * - Rate-limited per address (RATE_LIMIT a minute), every download logged on the release (download_log) by the link's
 *   id, never its token: Helm's server has no request log (Fastify's logger is off) and nginx keeps none for /dl/.
 * - Only the user creates or revokes one: the page's API, behind the session like the rest of /api (api.ts guard);
 *   no agent tool. Expired and revoked links are removed daily with their log.
 *
 * The auth guard (api.ts) guards /api/ and /artifacts/ only; /dl/ is deliberately outside it. Behind the reverse
 * proxy, nix/module.nix gives /dl/ a location of its own without the sign-in gate.
 */

db.exec(`CREATE TABLE IF NOT EXISTS download_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  release_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  artifact_id TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS download_links_release ON download_links(release_id);
CREATE TABLE IF NOT EXISTS download_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  address TEXT NOT NULL DEFAULT ''
);`);
// A link to a test build's file (testbuilds.ts): kind 'test', release_id the build, artifact_id its recipe_tests row.
try {
  db.exec("ALTER TABLE download_links ADD COLUMN kind TEXT NOT NULL DEFAULT 'release'");
} catch {}

const MIN = 60_000;
/** How long a link may last: the page's choices. */
export const DURATIONS: Record<string, number> = { '15m': 15 * MIN, '1h': 60 * MIN, '1d': 24 * 60 * MIN, '7d': 7 * 24 * 60 * MIN };
export const DEFAULT_DURATION = '1h';
export const RATE_LIMIT = 30;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

const SERVABLE = ['ready', 'published'];

/** A release's files that can be served now. */
function servable(releaseId: string): Row[] {
  return all('SELECT * FROM release_artifacts WHERE release_id = ? AND file IS NOT NULL ORDER BY created_at', releaseId).filter((a) => fileOf(a) !== null);
}
/** An artifact's file on disk, only if it lies under the releases folder and exists. */
function fileOf(a: Row): string | null {
  if (!a.file) return null;
  const root = resolve(ARTIFACT_DIR, 'releases');
  const p = resolve(ARTIFACT_DIR, String(a.file));
  if (!p.startsWith(root + '/') || !existsSync(p)) return null;
  return statSync(p).isFile() ? p : null;
}
/** The name a download is saved under: the release record's file name (without Helm's id prefix). */
const nameOf = (a: Row) => basename(String(a.file)).replace(/^[^-]+-/, '').replace(/["\\\r\n]/g, '_') || `${a.name}`;

/** A test build's file on disk, only under the recipe-tests folder and only while the build keeps it. */
function testFileOf(fileId: string, buildId: string): { path: string; name: string } | null {
  const f = get('SELECT * FROM recipe_tests WHERE id = ? AND build_id = ? AND file IS NOT NULL', fileId, buildId);
  if (!f) return null;
  const root = resolve(ARTIFACT_DIR, 'recipe-tests');
  const p = resolve(ARTIFACT_DIR, String(f.file));
  if (!p.startsWith(root + '/') || !existsSync(p) || !statSync(p).isFile()) return null;
  return { path: p, name: basename(p).replace(/["\\\r\n]/g, '_') };
}

/** The user makes a link to one file of a test build. */
export function createTestLink(buildId: string, fileId: string, duration: string = DEFAULT_DURATION): { token: string; link: Row } | { error: string } {
  const b = get('SELECT * FROM test_builds WHERE id = ?', buildId);
  if (!b || b.state === 'removed') return { error: 'That test build has no files any more.' };
  const ms = DURATIONS[duration];
  if (!ms) return { error: `How long: ${Object.keys(DURATIONS).join(', ')}.` };
  if (!testFileOf(fileId, buildId)) return { error: 'That file is not in this test build (or was removed).' };
  const token = randomBytes(32).toString('base64url');
  const id = newId('dl');
  run("INSERT INTO download_links (id, token_hash, release_id, project_id, artifact_id, expires_at, created_at, kind) VALUES (?,?,?,?,?,?,?,'test')", id, hash(token), b.id, b.project_id, fileId, now() + ms, now());
  touchProject(b.project_id);
  return { token, link: get('SELECT * FROM download_links WHERE id = ?', id)! };
}

/**
 * For the signed-in Download on the Releases page (releaseapi.ts): a ready or published release's files that can be
 * served, one (`artifactId`) or all, each with its real name; the archive's name for all. Null: nothing to serve.
 */
export function releaseDownload(releaseId: string, artifactId: string | null): { files: { path: string; name: string; bytes: number }[]; name: string } | null {
  const r = get('SELECT * FROM releases WHERE id = ?', releaseId);
  if (!r || !SERVABLE.includes(r.state)) return null;
  const files = servable(r.id)
    .filter((a) => artifactId === null || a.id === artifactId)
    .map((a) => ({ path: fileOf(a)!, name: nameOf(a), bytes: statSync(fileOf(a)!).size }));
  if (!files.length) return null;
  const project = get('SELECT name FROM projects WHERE id = ?', r.project_id)?.name ?? 'release';
  return { files, name: artifactId ? files[0].name : `${String(project).replace(/[^A-Za-z0-9._-]+/g, '-')}-${String(r.version).replace(/[^A-Za-z0-9._-]+/g, '-')}.tar` };
}

/** The user makes a link. Returns the token (shown once) or why not. */
export function createLink(releaseId: string, artifactId: string | null, duration: string = DEFAULT_DURATION): { token: string; link: Row } | { error: string } {
  const r = get('SELECT * FROM releases WHERE id = ?', releaseId);
  if (!r) return { error: 'No such release.' };
  if (!SERVABLE.includes(r.state)) return { error: `Release ${r.version} is ${r.state}: links are for a ready or published release.` };
  const ms = DURATIONS[duration];
  if (!ms) return { error: `How long: ${Object.keys(DURATIONS).join(', ')}.` };
  const files = servable(r.id);
  if (artifactId !== null) {
    if (!files.some((a) => a.id === artifactId)) return { error: 'That file is not in this release (or was removed).' };
  } else if (files.length < 2) return { error: 'An archive of all files is for a release with several files.' };
  const token = randomBytes(32).toString('base64url');
  const id = newId('dl');
  run('INSERT INTO download_links (id, token_hash, release_id, project_id, artifact_id, expires_at, created_at) VALUES (?,?,?,?,?,?,?)', id, hash(token), r.id, r.project_id, artifactId, now() + ms, now());
  touchProject(r.project_id);
  return { token, link: get('SELECT * FROM download_links WHERE id = ?', id)! };
}

export function revokeLink(id: string): string | null {
  const l = get('SELECT * FROM download_links WHERE id = ?', id);
  if (!l) return 'No such link.';
  run('UPDATE download_links SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?', now(), id);
  touchProject(l.project_id);
  return null;
}

/** A release's live links (not expired, not revoked), for the page; the token itself is never shown again. */
export function linksView(releaseId: string): Row[] {
  return all('SELECT id, artifact_id, expires_at, created_at, uses, last_used_at, kind FROM download_links WHERE release_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC', releaseId, now()).map((l) => ({
    ...l,
    file: l.kind === 'test' ? (get('SELECT artifact FROM recipe_tests WHERE id = ?', l.artifact_id)?.artifact ?? 'removed file') : l.artifact_id ? (get('SELECT name FROM release_artifacts WHERE id = ?', l.artifact_id)?.name ?? 'removed file') : 'All files (.tar)',
  }));
}

/** What a token gives now: the files and the download name, or null for anything that should be a plain 404. */
export function resolveToken(token: string): { link: Row; files: { path: string; name: string; bytes: number }[]; name: string } | null {
  if (typeof token !== 'string' || !TOKEN.test(token)) return null;
  const link = get('SELECT * FROM download_links WHERE token_hash = ?', hash(token));
  if (!link || link.revoked_at || link.expires_at <= now()) return null;
  // A test build's file: one file, served while the build keeps it.
  if (link.kind === 'test') {
    const f = link.artifact_id ? testFileOf(link.artifact_id, link.release_id) : null;
    return f ? { link, files: [{ path: f.path, name: f.name, bytes: statSync(f.path).size }], name: f.name } : null;
  }
  const r = get('SELECT * FROM releases WHERE id = ?', link.release_id);
  if (!r || !SERVABLE.includes(r.state)) return null;
  const files = servable(r.id)
    .filter((a) => link.artifact_id === null || a.id === link.artifact_id)
    .map((a) => ({ path: fileOf(a)!, name: nameOf(a), bytes: statSync(fileOf(a)!).size }));
  if (!files.length || (link.artifact_id !== null && files.length !== 1)) return null;
  const project = get('SELECT name FROM projects WHERE id = ?', r.project_id)?.name ?? 'release';
  const name = link.artifact_id ? files[0].name : `${String(project).replace(/[^A-Za-z0-9._-]+/g, '-')}-${String(r.version).replace(/[^A-Za-z0-9._-]+/g, '-')}.tar`;
  return { link, files, name };
}

// ---------- the archive of all files: a plain ustar stream, its length known up front ----------

function tarHeader(name: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(512, 0);
  h.write(name.slice(0, 99), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
  h.write('        ', 148);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
export const tarLength = (files: { bytes: number }[]) => files.reduce((n, f) => n + 512 + Math.ceil(f.bytes / 512) * 512, 0) + 1024;
export function tarStream(files: { path: string; name: string; bytes: number }[]): PassThrough {
  const out = new PassThrough();
  (async () => {
    for (const f of files) {
      out.write(tarHeader(f.name, f.bytes, Date.now()));
      await new Promise<void>((done, fail) => {
        const s = createReadStream(f.path);
        s.on('error', fail);
        s.on('end', () => done());
        s.pipe(out, { end: false });
      });
      const pad = (512 - (f.bytes % 512)) % 512;
      if (pad) out.write(Buffer.alloc(pad, 0));
    }
    out.end(Buffer.alloc(1024, 0));
  })().catch((err) => out.destroy(err));
  return out;
}

// ---------- the route ----------

/** Requests per address in the current minute (this process). */
const hits = new Map<string, { minute: number; n: number }>();
function limited(address: string): boolean {
  const minute = Math.floor(Date.now() / MIN);
  const h = hits.get(address);
  if (!h || h.minute !== minute) {
    hits.set(address, { minute, n: 1 });
    if (hits.size > 10_000) hits.clear();
    return false;
  }
  h.n++;
  return h.n > RATE_LIMIT;
}

/** Behind the proxy the client is in X-Real-IP (nix/module.nix sets it); otherwise the socket's peer. */
const addressOf = (req: FastifyRequest) => {
  const peer = req.raw.socket.remoteAddress ?? '';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  const real = req.headers['x-real-ip'];
  return loopback && typeof real === 'string' && real ? real : peer;
};

const notFound = (reply: FastifyReply) => reply.code(404).header('cache-control', 'no-store').send({ error: 'Not found' });

export function registerDownloadRoutes(app: FastifyInstance) {
  // GET only (Fastify answers HEAD for a GET route); any other method falls to the usual 404. No cookie is read or set.
  app.get('/dl/:token', async (req, reply) => {
    const address = addressOf(req);
    if (limited(address)) return reply.code(429).header('retry-after', '60').send({ error: 'Too many requests' });
    const got = resolveToken(String((req.params as any).token ?? ''));
    if (!got) return notFound(reply);
    reply
      .header('cache-control', 'no-store')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename="${got.name}"`);
    const single = got.link.artifact_id !== null;
    reply.header('content-length', String(single ? got.files[0].bytes : tarLength(got.files)));
    // HEAD: Fastify answers it from this handler and drops the body; it is not a download, so it is not counted.
    if (req.method !== 'HEAD') {
      run('UPDATE download_links SET uses = uses + 1, last_used_at = ? WHERE id = ?', now(), got.link.id);
      run('INSERT INTO download_log (link_id, release_id, at, address) VALUES (?,?,?,?)', got.link.id, got.link.release_id, now(), address);
      touchProject(got.link.project_id);
    }
    return reply.send(single ? createReadStream(got.files[0].path) : tarStream(got.files));
  });
}

/** Daily: expired and revoked links (over a day past) go, with their log. Returns how many. */
export function cleanLinks(at = now()): number {
  const old = all('SELECT id FROM download_links WHERE expires_at < ? OR revoked_at < ?', at, at - 24 * 60 * MIN).map((r) => r.id);
  for (const id of old) {
    run('DELETE FROM download_log WHERE link_id = ?', id);
    run('DELETE FROM download_links WHERE id = ?', id);
  }
  return old.length;
}
let timer: NodeJS.Timeout | null = null;
export function startLinkCleanup() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      cleanLinks();
    } catch (err) {
      console.error('Download link cleanup:', err);
    }
  }, 24 * 60 * MIN);
  timer.unref?.();
  setTimeout(() => cleanLinks(), 5 * MIN).unref?.();
}
export const downloadLog = (releaseId: string) => all('SELECT link_id, at, address FROM download_log WHERE release_id = ? ORDER BY at DESC LIMIT 50', releaseId);
