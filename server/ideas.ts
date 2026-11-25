import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { attachmentPath, attachmentView, deleteAttachment, getAttachment, importFile } from './attachments.ts';
import type { OwnerKind } from './attachments.ts';
import { createDiscussion } from './discussions.ts';
import { touchProject } from './store.ts';
import { addTaskMessage, getTask } from './tasks.ts';
import type { Author } from './tasks.ts';

/**
 * The Ideas board: a free canvas per project holding cards (a markdown note, a link with a preview the server
 * fetches, an image) and named frames drawn around them. A card belongs to the smallest frame holding its centre;
 * moving a frame moves its cards. Discuss on a frame starts a discussion whose first message lists the frame's cards,
 * with its images attached, and links the frame to it. The director reads and adds cards with list_ideas / add_idea
 * (ideastools.ts). Each viewer's pan and zoom stay on their device (web/src/ideas.tsx).
 */

export const CARD_KINDS = ['note', 'link', 'image'] as const;
export type CardKind = (typeof CARD_KINDS)[number];
/** Image cards and link preview images are attachments owned by their card. */
export const IDEA_OWNER = 'idea' as OwnerKind;

export const LIMITS = { text: 20_000, name: 120, url: 2000, cards: 2000, frames: 200, size: 4000, coord: 1_000_000 };
const DEFAULT_SIZE: Record<CardKind, { w: number; h: number }> = { note: { w: 220, h: 150 }, link: { w: 260, h: 220 }, image: { w: 240, h: 240 } };
const MIN = { w: 80, h: 60 };
const GAP = 24;

const clampNum = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const coord = (v: unknown, fallback = 0) => Math.round(clampNum(v, -LIMITS.coord, LIMITS.coord, fallback));
const size = (v: unknown, lo: number, fallback: number) => Math.round(clampNum(v, lo, LIMITS.size, fallback));

export const getCard = (id: string) => get('SELECT * FROM idea_cards WHERE id = ?', id);
export const getFrame = (id: string) => get('SELECT * FROM idea_frames WHERE id = ?', id);
export const cardsOf = (projectId: string) => all('SELECT * FROM idea_cards WHERE project_id = ? ORDER BY z, created_at', projectId);
export const framesOf = (projectId: string) => all('SELECT * FROM idea_frames WHERE project_id = ? ORDER BY created_at', projectId);

export function cardView(c: Row) {
  const img = c.image_id ? getAttachment(c.image_id) : undefined;
  return {
    id: c.id as string,
    kind: c.kind as CardKind,
    x: c.x as number,
    y: c.y as number,
    w: c.w as number,
    h: c.h as number,
    z: c.z as number,
    frame_id: (c.frame_id as string | null) ?? null,
    text: c.text as string,
    url: (c.url as string | null) ?? null,
    site: (c.site as string | null) ?? null,
    image: img ? attachmentView(img) : null,
    fetching: c.status === 'fetching',
    author: c.author as string,
  };
}
export function frameView(f: Row) {
  const d = f.discussion_id ? getTask(f.discussion_id) : undefined;
  return { id: f.id as string, name: f.name as string, x: f.x as number, y: f.y as number, w: f.w as number, h: f.h as number, discussion: d ? { id: d.id as string, title: d.title as string, state: d.state as string } : null };
}
export function boardView(projectId: string) {
  return { cards: cardsOf(projectId).map(cardView), frames: framesOf(projectId).map(frameView) };
}

// ---------- frames and membership ----------

/** Each card's frame: the smallest frame holding its centre. Returns how many cards changed frame. */
export function assignFrames(projectId: string): number {
  const frames = framesOf(projectId);
  let changed = 0;
  for (const c of cardsOf(projectId)) {
    const cx = c.x + c.w / 2;
    const cy = c.y + c.h / 2;
    let best: Row | null = null;
    for (const f of frames) if (cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h && (!best || f.w * f.h < best.w * best.h)) best = f;
    const id = best?.id ?? null;
    if (id !== (c.frame_id ?? null)) {
      run('UPDATE idea_cards SET frame_id = ? WHERE id = ?', id, c.id);
      changed++;
    }
  }
  return changed;
}

/** Where the bottom of the board is: new things without a position go below everything. */
function below(projectId: string): { x: number; y: number } {
  const r = get(
    `SELECT MIN(x) AS x, MAX(y + h) AS b FROM (SELECT x, y, h FROM idea_cards WHERE project_id = ? UNION ALL SELECT x, y, h FROM idea_frames WHERE project_id = ?)`,
    projectId,
    projectId,
  );
  return r?.b == null ? { x: 0, y: 0 } : { x: Math.round(r.x), y: Math.round(r.b + GAP * 2) };
}

/** A free spot for a card of size w×h inside a frame: under its lowest card; the frame grows to hold it. */
function spotInFrame(f: Row, w: number, h: number): { x: number; y: number } {
  const r = get('SELECT MAX(y + h) AS b FROM idea_cards WHERE frame_id = ?', f.id);
  const x = f.x + GAP;
  const y = r?.b == null ? f.y + 44 : r.b + GAP;
  const nw = Math.max(f.w, w + GAP * 2);
  const nh = Math.max(f.h, y + h + GAP - f.y);
  if (nw !== f.w || nh !== f.h) run('UPDATE idea_frames SET w = ?, h = ?, updated_at = ? WHERE id = ?', nw, nh, now(), f.id);
  return { x, y };
}

export function createFrame(projectId: string, input: { name?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown }): Row | { error: string } {
  if ((get('SELECT COUNT(*) AS n FROM idea_frames WHERE project_id = ?', projectId)?.n ?? 0) >= LIMITS.frames) return { error: `A board holds at most ${LIMITS.frames} frames.` };
  const id = newId('if');
  const at = input.x == null || input.y == null ? below(projectId) : { x: coord(input.x), y: coord(input.y) };
  return tx(() => {
    run(
      'INSERT INTO idea_frames (id, project_id, name, x, y, w, h, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, projectId, String(input.name ?? '').trim().slice(0, LIMITS.name), at.x, at.y, size(input.w, 160, 480), size(input.h, 120, 360), now(), now(),
    );
    assignFrames(projectId);
    return getFrame(id)!;
  });
}

/** Rename, move or resize a frame. Moving it moves its cards with it; then every card's frame is worked out again. */
export function updateFrame(f: Row, input: { name?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown }): Row {
  return tx(() => {
    const x = input.x == null ? f.x : coord(input.x, f.x);
    const y = input.y == null ? f.y : coord(input.y, f.y);
    const dx = x - f.x;
    const dy = y - f.y;
    if (dx || dy) run('UPDATE idea_cards SET x = x + ?, y = y + ?, updated_at = ? WHERE frame_id = ?', dx, dy, now(), f.id);
    run(
      'UPDATE idea_frames SET name = ?, x = ?, y = ?, w = ?, h = ?, updated_at = ? WHERE id = ?',
      input.name == null ? f.name : String(input.name).trim().slice(0, LIMITS.name), x, y,
      input.w == null ? f.w : size(input.w, 160, f.w), input.h == null ? f.h : size(input.h, 120, f.h), now(), f.id,
    );
    assignFrames(f.project_id);
    return getFrame(f.id)!;
  });
}

/** Remove a frame; its cards stay where they are. */
export function deleteFrame(f: Row) {
  tx(() => {
    run('DELETE FROM idea_frames WHERE id = ?', f.id);
    assignFrames(f.project_id);
  });
}

// ---------- cards ----------

/** A frame of this project by id or by name (case-insensitive). */
export function findFrame(projectId: string, ref: string): Row | undefined {
  return get('SELECT * FROM idea_frames WHERE project_id = ? AND (id = ? OR lower(name) = lower(?)) ORDER BY created_at LIMIT 1', projectId, ref, ref.trim());
}

export function cleanUrl(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s || s.length > LIMITS.url) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

export type NewCard = { kind: CardKind; text?: unknown; url?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown; frame?: string | null; author?: string };

/**
 * Add a card. Without a position it goes into its frame (under the frame's cards; the frame grows), else below
 * everything on the board. A link starts with its address as its title and status 'fetching': call fetchLinkPreview.
 */
export function createCard(projectId: string, input: NewCard): Row | { error: string } {
  if (!CARD_KINDS.includes(input.kind)) return { error: 'kind must be note, link or image.' };
  if ((get('SELECT COUNT(*) AS n FROM idea_cards WHERE project_id = ?', projectId)?.n ?? 0) >= LIMITS.cards) return { error: `A board holds at most ${LIMITS.cards} cards.` };
  const url = input.kind === 'link' ? cleanUrl(input.url) : null;
  if (input.kind === 'link' && !url) return { error: 'Give the link as an http or https address.' };
  const text = String(input.text ?? '').slice(0, LIMITS.text);
  const def = DEFAULT_SIZE[input.kind];
  const w = size(input.w, MIN.w, def.w);
  const h = size(input.h, MIN.h, def.h);
  const frame = input.frame ? findFrame(projectId, input.frame) : undefined;
  if (input.frame && !frame) return { error: `No frame "${input.frame}" on the board.` };
  const id = newId('ic');
  return tx(() => {
    const at = input.x != null && input.y != null ? { x: coord(input.x), y: coord(input.y) } : frame ? spotInFrame(frame, w, h) : below(projectId);
    const z = Number(get('SELECT MAX(z) AS z FROM idea_cards WHERE project_id = ?', projectId)?.z ?? 0) + 1;
    run(
      'INSERT INTO idea_cards (id, project_id, kind, x, y, w, h, z, text, url, site, status, author, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id, projectId, input.kind, at.x, at.y, w, h, z, input.kind === 'link' && !text ? url : text, url, url ? new URL(url).hostname.replace(/^www\./, '') : null,
      input.kind === 'link' ? 'fetching' : '', input.author ?? 'user', now(), now(),
    );
    assignFrames(projectId);
    return getCard(id)!;
  });
}

/** Move, resize or edit a card. A move brings it to the front and may put it in (or take it out of) a frame. */
export function updateCard(c: Row, input: { x?: unknown; y?: unknown; w?: unknown; h?: unknown; text?: unknown }): Row {
  return tx(() => {
    const moved = input.x != null || input.y != null;
    const z = moved ? Number(get('SELECT MAX(z) AS z FROM idea_cards WHERE project_id = ?', c.project_id)?.z ?? 0) + 1 : c.z;
    run(
      'UPDATE idea_cards SET x = ?, y = ?, w = ?, h = ?, z = ?, text = ?, updated_at = ? WHERE id = ?',
      input.x == null ? c.x : coord(input.x, c.x), input.y == null ? c.y : coord(input.y, c.y),
      input.w == null ? c.w : size(input.w, MIN.w, c.w), input.h == null ? c.h : size(input.h, MIN.h, c.h), z,
      input.text == null ? c.text : String(input.text).slice(0, LIMITS.text), now(), c.id,
    );
    assignFrames(c.project_id);
    return getCard(c.id)!;
  });
}

export function deleteCard(c: Row) {
  const img = c.image_id ? getAttachment(c.image_id) : undefined;
  run('DELETE FROM idea_cards WHERE id = ?', c.id);
  if (img && img.owner_kind === IDEA_OWNER && img.owner_id === c.id) deleteAttachment(img);
}

/** An image card for an uploaded attachment (receiveUpload with owner IDEA_OWNER and the new card's id). */
export function createImageCard(projectId: string, id: string, att: Row, at: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }): Row {
  return tx(() => {
    const z = Number(get('SELECT MAX(z) AS z FROM idea_cards WHERE project_id = ?', projectId)?.z ?? 0) + 1;
    const pos = at.x != null && at.y != null ? { x: coord(at.x), y: coord(at.y) } : below(projectId);
    run(
      "INSERT INTO idea_cards (id, project_id, kind, x, y, w, h, z, text, image_id, author, created_at, updated_at) VALUES (?,?,'image',?,?,?,?,?,'',?,'user',?,?)",
      id, projectId, pos.x, pos.y, size(at.w, MIN.w, DEFAULT_SIZE.image.w), size(at.h, MIN.h, DEFAULT_SIZE.image.h), z, att.id, now(), now(),
    );
    assignFrames(projectId);
    return getCard(id)!;
  });
}

/** An image card from a file on this machine already checked by the caller (the director's add_idea). */
export function importImageCard(projectId: string, path: string, name: string, input: NewCard): Row | { error: string } {
  const made = createCard(projectId, { ...input, kind: 'image' });
  if ('error' in made) return made;
  const res = importFile(projectId, path, name, { kind: IDEA_OWNER, id: made.id }, input.author ?? 'director');
  if ('error' in res) {
    run('DELETE FROM idea_cards WHERE id = ?', made.id);
    return res;
  }
  if (res.row.kind !== 'image') {
    deleteAttachment(res.row);
    run('DELETE FROM idea_cards WHERE id = ?', made.id);
    return { error: `${name} is not an image.` };
  }
  run('UPDATE idea_cards SET image_id = ? WHERE id = ?', res.row.id, made.id);
  return getCard(made.id)!;
}

// ---------- link previews ----------

type Fetch = typeof fetch;
const HTML_BYTES = 1024 * 1024;
const IMAGE_BYTES = 8 * 1024 * 1024;

/** Hosts a link preview never fetches: this machine and cloud metadata addresses. */
function refusedHost(h: string): boolean {
  const host = h.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '::1' || host === '0.0.0.0' || /^169\.254\./.test(host) || /^fe80:/.test(host);
}

/** GET with every redirect checked, at most `limit` bytes of body read. */
async function getCapped(url: string, limit: number, f: Fetch, accept: string): Promise<{ type: string; body: Buffer; url: string }> {
  let u = new URL(url);
  for (let hop = 0; hop < 5; hop++) {
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || refusedHost(u.hostname)) throw new Error(`refused: ${u.hostname}`);
    const res = await f(u, { redirect: 'manual', signal: AbortSignal.timeout(10_000), headers: { accept, 'user-agent': 'Mozilla/5.0 (compatible; HelmLinkPreview/1.0)' } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel();
      if (!loc) throw new Error('redirect without a location');
      u = new URL(loc, u);
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Error(`HTTP ${res.status}`);
    }
    const chunks: Buffer[] = [];
    let n = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      chunks.push(Buffer.from(value));
      if (n >= limit) {
        await reader.cancel();
        break;
      }
    }
    return { type: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), body: Buffer.concat(chunks).subarray(0, limit), url: u.href };
  }
  throw new Error('too many redirects');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Title, site name and preview image of an HTML page, from its Open Graph and Twitter tags, else its <title>. */
export function parseLinkMeta(html: string, base: string): { title: string | null; site: string | null; image: string | null } {
  const head = html.slice(0, 300_000);
  const metas = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
    const key = attr('property') ?? attr('name');
    const content = attr('content');
    if (!key || !content) continue;
    const k = (key[2] ?? key[3] ?? key[4] ?? '').toLowerCase();
    if (!metas.has(k)) metas.set(k, decode(content[2] ?? content[3] ?? content[4] ?? '').trim());
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = metas.get('og:title') || metas.get('twitter:title') || (titleTag ? decode(titleTag).replace(/\s+/g, ' ').trim() : '') || null;
  const rawImage = metas.get('og:image') || metas.get('og:image:url') || metas.get('og:image:secure_url') || metas.get('twitter:image') || metas.get('twitter:image:src') || null;
  let image: string | null = null;
  if (rawImage) {
    try {
      image = new URL(rawImage, base).href;
    } catch {}
  }
  return { title: title ? title.slice(0, 300) : null, site: metas.get('og:site_name') || null, image };
}

/**
 * Fetch a link card's page for its title and preview image (stored as an attachment of the card). Failure leaves the
 * address as its title. Returns the card after.
 */
export async function fetchLinkPreview(cardId: string, f: Fetch = fetch): Promise<Row | undefined> {
  const c = getCard(cardId);
  if (!c || c.kind !== 'link' || !c.url) return c;
  let title: string | null = null;
  let site: string | null = null;
  let imageRow: Row | null = null;
  try {
    const page = await getCapped(c.url, HTML_BYTES, f, 'text/html,application/xhtml+xml');
    if (page.type.includes('html') || page.type === '') {
      const meta = parseLinkMeta(page.body.toString('utf8'), page.url);
      title = meta.title;
      site = meta.site;
      if (meta.image) {
        try {
          const img = await getCapped(meta.image, IMAGE_BYTES, f, 'image/*');
          if (img.type.startsWith('image/') && img.body.length && img.body.length < IMAGE_BYTES) {
            const dir = mkdtempSync(join(tmpdir(), 'helm-idea-'));
            try {
              const file = join(dir, 'preview');
              writeFileSync(file, img.body);
              const res = importFile(c.project_id, file, 'preview', { kind: IDEA_OWNER, id: c.id }, 'helm');
              if ('row' in res) {
                if (res.row.kind === 'image') imageRow = res.row;
                else deleteAttachment(res.row);
              }
            } finally {
              rmSync(dir, { recursive: true, force: true });
            }
          }
        } catch {}
      }
    } else if (page.type.startsWith('image/')) title = null;
  } catch {}
  const now2 = getCard(cardId);
  if (!now2) {
    if (imageRow) deleteAttachment(imageRow);
    return undefined;
  }
  const old = now2.image_id && now2.image_id !== imageRow?.id ? getAttachment(now2.image_id) : undefined;
  // The user may have renamed it meanwhile: only the placeholder (its address) is replaced.
  const keepText = now2.text && now2.text !== now2.url;
  run(
    "UPDATE idea_cards SET text = ?, site = COALESCE(?, site), image_id = COALESCE(?, image_id), status = '', updated_at = ? WHERE id = ?",
    keepText ? now2.text : (title ?? now2.text), site, imageRow?.id ?? null, now(), cardId,
  );
  if (old && imageRow && old.owner_kind === IDEA_OWNER) deleteAttachment(old);
  return getCard(cardId);
}

/** Fetch a link card's preview in the background, then tell browsers. */
export function previewLater(cardId: string, projectId: string) {
  void fetchLinkPreview(cardId)
    .catch(() => {})
    .finally(() => touchProject(projectId));
}

// ---------- reading and Discuss ----------

const byPosition = (a: Row, b: Row) => a.y - b.y || a.x - b.x;
const oneLine = (s: string, n = 160) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One card as markdown for a discussion's first message. */
function cardMarkdown(c: Row): string {
  if (c.kind === 'note') return c.text.trim() || '(empty note)';
  if (c.kind === 'link') return `[${(c.text || c.url).replace(/[[\]]/g, '')}](${c.url})${c.site ? ` (${c.site})` : ''}`;
  const a = c.image_id ? getAttachment(c.image_id) : undefined;
  return `Image: ${a?.name ?? 'image'}${c.text ? ` (${c.text})` : ''}, attached`;
}

export function frameMessage(f: Row, cards: Row[]): string {
  const parts = cards.sort(byPosition).map((c) => (c.kind === 'note' && c.text.includes('\n') ? c.text.trim() : `- ${cardMarkdown(c)}`));
  return `From the Ideas board, frame "${f.name || 'Untitled'}" (${cards.length} ${cards.length === 1 ? 'card' : 'cards'}):\n\n${parts.join('\n\n')}`;
}

/**
 * Discuss a frame: a new discussion whose first message (from the user) lists the frame's cards, its image cards
 * attached to that message. The frame links to it. A frame whose discussion is still there returns it instead.
 * `deliver` sends the message to the director (taskapi's path for a discussion the user starts).
 */
export async function discussFrame(
  f: Row,
  by: Author,
  deliver: (d: Row, text: string, files: Row[]) => Promise<void>,
): Promise<{ id: string; existing: boolean } | { error: string }> {
  const linked = f.discussion_id ? getTask(f.discussion_id) : undefined;
  if (linked && linked.state !== 'archived') return { id: linked.id, existing: true };
  const cards = all('SELECT * FROM idea_cards WHERE frame_id = ?', f.id);
  if (!cards.length) return { error: 'Put some cards in the frame first.' };
  const text = frameMessage(f, cards);
  const { d, msg } = tx(() => {
    const d = createDiscussion(f.project_id, { title: (f.name || 'Ideas').slice(0, 140), origin: 'user' }, by);
    run('UPDATE idea_frames SET discussion_id = ?, updated_at = ? WHERE id = ?', d.id, now(), f.id);
    return { d, msg: addTaskMessage(d, by, text) };
  });
  // Copies, outside the transaction: the files may be large.
  const files: Row[] = [];
  for (const c of cards.filter((x) => x.kind === 'image').sort(byPosition)) {
    const a = c.image_id ? getAttachment(c.image_id) : undefined;
    if (!a) continue;
    const res = importFile(f.project_id, attachmentPath(a), a.name, { kind: 'message', id: String(msg) }, 'user', c.text ?? '');
    if ('row' in res) files.push(res.row);
  }
  await deliver(d, text, files);
  return { id: d.id, existing: false };
}

/** The board as text for the director: frames with their cards, then cards in no frame. */
export function renderBoard(projectId: string): string {
  const frames = framesOf(projectId);
  const cards = cardsOf(projectId).sort(byPosition);
  if (!frames.length && !cards.length) return 'The Ideas board is empty.';
  const line = (c: Row) => {
    const what = c.kind === 'note' ? oneLine(c.text) || '(empty)' : c.kind === 'link' ? `${oneLine(c.text, 100)} <${c.url}>` : `image ${getAttachment(c.image_id ?? '')?.name ?? ''}${c.text ? `: ${oneLine(c.text, 80)}` : ''}`;
    return `- ${c.id} ${c.kind} at ${Math.round(c.x)},${Math.round(c.y)}: ${what}`;
  };
  const out: string[] = [`Ideas board: ${cards.length} cards, ${frames.length} frames.`];
  for (const f of frames) {
    const own = cards.filter((c) => c.frame_id === f.id);
    out.push(`\nFrame "${f.name || 'Untitled'}" ${f.id} at ${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.w)}×${Math.round(f.h)}${f.discussion_id ? `, discussed in [[${f.discussion_id}]]` : ''}:`);
    out.push(own.length ? own.map(line).join('\n') : '(no cards)');
  }
  const loose = cards.filter((c) => !c.frame_id);
  if (loose.length) out.push(`\nIn no frame:\n${loose.map(line).join('\n')}`);
  return out.join('\n');
}
