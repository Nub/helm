import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Serves the built web app (web/dist).
//
// Not @fastify/static: its ETag and Last-Modified come from size and mtime, and every file in the Nix store has
// mtime 1. index.html is the same size in every build, so after a deploy a browser revalidating it got 304 and kept
// the old page, whose hashed bundle no longer exists. Here every validator is a hash of the file's bytes.
//
// - index.html (also the answer for any extensionless path, as a client route): `no-cache`, so the browser always
//   asks, and a content ETag, so the answer is a small 304 until the page really changes. (Not `no-store`: that
//   would refetch the page every time and keep it out of the back/forward cache, for nothing.)
// - assets/*: Vite names them by content hash, so they are immutable for a year.
// - sw.js, the service worker (web/public/sw.js; push notifications only, it never handles fetches): `no-cache`, so
//   a new one is picked up on the next check. Browsers also bypass the HTTP cache for it (registered with
//   updateViaCache 'none'), and cap its freshness at a day whatever the header says.
// - other files (manifest, icons): an hour, then revalidated by content ETag.
// - a missing file with an extension, or anything missing under assets/, is a 404: answering a script request with
//   index.html is what made the stale page fail as a white screen instead of an error.

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

type Entry = { key: string; body: Buffer; etag: string };

export function registerWeb(app: FastifyInstance, root: string) {
  // Keyed by path; revalidated against the file's identity so a rebuild during development is picked up without a
  // restart. In the Nix store the files never change, so each is read and hashed once.
  const cache = new Map<string, Entry>();

  async function load(rel: string): Promise<Entry | null> {
    const file = join(root, rel);
    let st;
    try {
      st = await stat(file);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const hit = cache.get(rel);
    if (hit && hit.key === key) return hit;
    const body = await readFile(file);
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`;
    const entry = { key, body, etag };
    cache.set(rel, entry);
    return entry;
  }

  function send(req: FastifyRequest, reply: FastifyReply, rel: string, entry: Entry) {
    const cacheControl =
      rel === 'index.html' || rel === 'sw.js' ? 'no-cache' : rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
    reply.header('cache-control', cacheControl).header('etag', entry.etag).header('x-content-type-options', 'nosniff');
    const match = req.headers['if-none-match'];
    if (match && match.split(',').some((t) => t.trim().replace(/^W\//, '') === entry.etag)) return reply.code(304).send();
    return reply.type(TYPES[extname(rel).toLowerCase()] ?? 'application/octet-stream').send(entry.body);
  }

  app.get('/*', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/') || path.startsWith('/artifacts/')) return reply.callNotFound();
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(path)).replace(/^[/\\]+/, '');
    } catch {
      return reply.code(400).send({ error: 'Bad path' });
    }
    if (rel.split(sep).includes('..') || rel.includes('\0')) return reply.code(404).send({ error: 'Not found' });
    if (rel === '' || rel.endsWith(sep)) rel = 'index.html';

    const entry = await load(rel);
    if (entry) return send(req, reply, rel, entry);
    if (rel.startsWith('assets/') || extname(rel) !== '') return reply.code(404).send({ error: 'Not found' });

    // Any other path is a client route (the app routes by hash, so this is only ever a bookmark or a typo).
    const index = await load('index.html');
    if (!index) return reply.code(404).send({ error: 'Not found' });
    return send(req, reply, 'index.html', index);
  });
}
