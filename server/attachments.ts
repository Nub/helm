import { chmodSync, closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, sep } from 'node:path';
import type { Writable } from 'node:stream';
import { Busboy } from '@fastify/busboy';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ARTIFACT_DIR, DATA_DIR } from './config.ts';
import { all, get, newId, now, run } from './db.ts';
import type { Row } from './db.ts';
import { copyFileAtomic } from './safefs.ts';

/**
 * Files the user attaches as references: to a Spec entry (doc), a task or discussion, or one message (in a task's
 * thread, or in the conversation with the director). Kept per project under HELM_DATA/attachments/<project>, not
 * under artifacts/: the /artifacts/ static route serves by extension with scripts allowed in its sandbox, which is
 * right for agent-written HTML previews and wrong for anything a browser could be tricked into running. Uploads are
 * only served by serveAttachment below, with a type decided from their bytes.
 *
 * owner_kind: 'doc' | 'task' (also discussions) | 'message' (task_messages.id) | 'event' (events.id, a message to
 * an agent) | 'inbox' (inbox.id: files sent with the answer to a request; they belong to the request, so they stay
 * with its task or discussion wherever the request is moved) | 'pending' (uploaded from a composer, not yet sent;
 * claimed by the message it is sent with). A pending upload made for one request has that request's id as
 * owner_id, so only its answer can claim it.
 */

export const OWNER_KINDS = ['doc', 'task', 'message', 'event', 'inbox'] as const;
export type OwnerKind = (typeof OWNER_KINDS)[number] | 'pending';

const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
/** HELM_ATTACH_MAX_MB (per file, default 50) and HELM_ATTACH_MAX_FILES (per upload request, default 10). */
export const LIMITS = {
  fileBytes: envInt('HELM_ATTACH_MAX_MB', 50) * 1024 * 1024,
  files: envInt('HELM_ATTACH_MAX_FILES', 10),
};

/** Where a project's attachments live. Its agents may read it without asking (additionalDirectories in runtime.ts). */
export function attachmentsDir(projectId: string): string {
  if (!/^[a-z]+_[0-9a-f]+$/.test(projectId)) throw new Error('Bad project id');
  const dir = join(DATA_DIR, 'attachments', projectId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------- type detection ----------

export type Sniffed = { mime: string; ext: string; kind: 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'file' };

const ascii = (b: Buffer, start: number, end: number) => b.subarray(start, end).toString('latin1');

/** What a file is, from its first bytes. The client's Content-Type and the file name are not trusted. */
export function sniff(head: Buffer, name: string): Sniffed {
  const at = (sig: number[], offset = 0) => sig.every((v, i) => head[offset + i] === v);
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: 'image/png', ext: '.png', kind: 'image' };
  if (at([0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', ext: '.jpg', kind: 'image' };
  if (ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') return { mime: 'image/gif', ext: '.gif', kind: 'image' };
  if (ascii(head, 0, 4) === 'RIFF') {
    const t = ascii(head, 8, 12);
    if (t === 'WEBP') return { mime: 'image/webp', ext: '.webp', kind: 'image' };
    if (t === 'WAVE') return { mime: 'audio/wav', ext: '.wav', kind: 'audio' };
    if (t === 'AVI ') return { mime: 'video/x-msvideo', ext: '.avi', kind: 'file' };
  }
  if (ascii(head, 4, 8) === 'ftyp') {
    const size = head.readUInt32BE(0);
    const major = ascii(head, 8, 12);
    const brands = [major];
    for (let o = 16; o + 4 <= Math.min(size, head.length, 64); o += 4) brands.push(ascii(head, o, o + 4));
    const has = (...b: string[]) => brands.some((x) => b.includes(x));
    if (has('avif', 'avis')) return { mime: 'image/avif', ext: '.avif', kind: 'image' };
    if (has('heic', 'heix', 'hevc', 'hevx', 'heim', 'heis')) return { mime: 'image/heic', ext: '.heic', kind: 'image' };
    if (has('mif1', 'msf1')) return { mime: 'image/heif', ext: '.heif', kind: 'image' };
    if (major === 'qt  ') return { mime: 'video/quicktime', ext: '.mov', kind: 'video' };
    if (major === 'M4A ' || major === 'M4B ' || major === 'M4P ') return { mime: 'audio/mp4', ext: '.m4a', kind: 'audio' };
    if (major.startsWith('3g')) return { mime: 'video/3gpp', ext: '.3gp', kind: 'video' };
    return { mime: 'video/mp4', ext: '.mp4', kind: 'video' };
  }
  if (at([0x1a, 0x45, 0xdf, 0xa3])) {
    return ascii(head, 0, 64).includes('webm') ? { mime: 'video/webm', ext: '.webm', kind: 'video' } : { mime: 'video/x-matroska', ext: '.mkv', kind: 'file' };
  }
  if (ascii(head, 0, 4) === 'OggS') return { mime: 'audio/ogg', ext: '.ogg', kind: 'audio' };
  if (ascii(head, 0, 4) === 'fLaC') return { mime: 'audio/flac', ext: '.flac', kind: 'audio' };
  if (ascii(head, 0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe6) === 0xe2)) return { mime: 'audio/mpeg', ext: '.mp3', kind: 'audio' };
  if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) return { mime: 'audio/aac', ext: '.aac', kind: 'audio' };
  if (ascii(head, 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: '.pdf', kind: 'pdf' };
  if (at([0x50, 0x4b, 0x03, 0x04])) return { mime: 'application/zip', ext: '.zip', kind: 'file' };
  if (at([0x1f, 0x8b])) return { mime: 'application/gzip', ext: '.gz', kind: 'file' };
  if (head.length && !head.includes(0) && isUtf8(head)) {
    const start = head.toString('utf8', 0, 2048).replace(/^\uFEFF/, '').trimStart().toLowerCase();
    // Markup a browser would run. Detected so it is never served as itself; agents can still read it as text.
    if (/^<svg[\s>]/.test(start) || (start.startsWith('<?xml') && start.includes('<svg'))) return { mime: 'image/svg+xml', ext: '.svg', kind: 'file' };
    if (/<(!doctype\s+html|html|head|body|script|iframe|object|embed)[\s>]/.test(start)) return { mime: 'text/html', ext: '.html', kind: 'file' };
    const given = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase();
    const textExt = given && ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'yaml', 'yml', 'toml', 'xml', 'ini', 'diff', 'patch'].includes(given) ? `.${given}` : '.txt';
    return { mime: 'text/plain', ext: textExt, kind: 'text' };
  }
  return { mime: 'application/octet-stream', ext: '.bin', kind: 'file' };
}

/** UTF-8 check that forgives a character cut off at the end of the sample. */
function isUtf8(b: Buffer): boolean {
  for (let cut = 0; cut < 4 && cut < b.length; cut++) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(0, b.length - cut));
      return true;
    } catch {}
  }
  return false;
}

/** A display name: no directories, control characters or leading dots; at most 120 characters. Never used as a path. */
export function cleanName(raw: string): string {
  let n = String(raw ?? '').split(/[/\\]/).pop() ?? '';
  n = n.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').replace(/^[.\s]+/, '').trim();
  if (n.length > 120) {
    const ext = /\.[^.]{1,10}$/.exec(n)?.[0] ?? '';
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n || 'file';
}

// ---------- rows ----------

export function attachmentView(a: Row) {
  return { id: a.id, name: a.name, mime: a.mime, kind: a.kind, size: a.size, url: `/api/attachments/${a.id}/file`, created_at: a.created_at, project_id: a.project_id, added_by: a.uploader === 'user' ? null : a.uploader, caption: a.caption ?? '', ...annotationOf(a) };
}

/** An image sent as annotated feedback (annotations.ts): which annotation, and whether this is the marked-up PNG or the original. */
function annotationOf(a: Row): { annotation?: { id: string; role: 'marked' | 'original' } } {
  if (a.kind !== 'image') return {};
  const r = get('SELECT id, flat_id FROM annotations WHERE flat_id = ? OR original_id = ? LIMIT 1', a.id, a.id);
  return r ? { annotation: { id: r.id, role: r.flat_id === a.id ? 'marked' : 'original' } } : {};
}
export type AttachmentView = ReturnType<typeof attachmentView>;

export const attachmentPath = (a: Row) => join(attachmentsDir(a.project_id), a.file);

export function getAttachment(id: string): Row | undefined {
  return get('SELECT * FROM attachments WHERE id = ?', id);
}

export function listAttachments(kind: OwnerKind, ownerId: string): Row[] {
  return all('SELECT * FROM attachments WHERE owner_kind = ? AND owner_id = ? ORDER BY created_at, id', kind, ownerId);
}

/** A task's or discussion's own references plus those sent in its thread and with answers to its requests, oldest first. */
export function taskAttachments(taskId: string): Row[] {
  return all(
    `SELECT * FROM attachments WHERE (owner_kind = 'task' AND owner_id = ?)
       OR (owner_kind = 'message' AND owner_id IN (SELECT CAST(id AS TEXT) FROM task_messages WHERE task_id = ?))
       OR (owner_kind = 'inbox' AND owner_id IN (SELECT id FROM inbox WHERE task_id = ?))
     ORDER BY created_at, id`,
    taskId, taskId, taskId,
  );
}

/** Files sent with the answers to a task's or discussion's requests, by request id. */
export function answerAttachments(taskId: string): Map<string, AttachmentView[]> {
  const map = new Map<string, AttachmentView[]>();
  for (const a of all("SELECT * FROM attachments WHERE owner_kind = 'inbox' AND owner_id IN (SELECT id FROM inbox WHERE task_id = ?) ORDER BY created_at, id", taskId)) {
    map.set(a.owner_id, [...(map.get(a.owner_id) ?? []), attachmentView(a)]);
  }
  return map;
}

/** Attachments of each thread message of a task, by message id. */
export function messageAttachments(taskId: string): Map<number, ReturnType<typeof attachmentView>[]> {
  const map = new Map<number, ReturnType<typeof attachmentView>[]>();
  for (const a of all(
    "SELECT * FROM attachments WHERE owner_kind = 'message' AND owner_id IN (SELECT CAST(id AS TEXT) FROM task_messages WHERE task_id = ?) ORDER BY created_at, id",
    taskId,
  )) {
    const k = Number(a.owner_id);
    map.set(k, [...(map.get(k) ?? []), attachmentView(a)]);
  }
  return map;
}

export function docAttachmentCounts(projectId: string): Map<string, number> {
  return new Map(all("SELECT owner_id, COUNT(*) AS n FROM attachments WHERE project_id = ? AND owner_kind = 'doc' GROUP BY owner_id", projectId).map((r) => [r.owner_id, Number(r.n)]));
}

export function taskAttachmentCount(taskId: string): number {
  return Number(
    get(
      `SELECT COUNT(*) AS n FROM attachments WHERE (owner_kind = 'task' AND owner_id = ?)
         OR (owner_kind = 'message' AND owner_id IN (SELECT CAST(id AS TEXT) FROM task_messages WHERE task_id = ?))
         OR (owner_kind = 'inbox' AND owner_id IN (SELECT id FROM inbox WHERE task_id = ?))`,
      taskId, taskId, taskId,
    )?.n ?? 0,
  );
}

/**
 * Why a request cannot take files now, or null: it must be an open question of this project. Uploads for it, and
 * the answer that sends them, are refused once it is answered or dismissed, and for another project's request.
 */
export function requestRefusesFiles(projectId: string, requestId: string): string | null {
  const r = get('SELECT project_id, kind, status FROM inbox WHERE id = ?', requestId);
  if (!r || r.project_id !== projectId) return `No request ${requestId} on this project.`;
  if (r.kind !== 'question' && r.kind !== 'action') return 'Files can only be sent with the answer to a question or a to-do.';
  if (r.status !== 'open') return 'This request has already been answered.';
  return null;
}

/** Whether `ownerId` of `kind` exists on this project (pending and message/event owners are set by the server). */
export function ownerOnProject(projectId: string, kind: string, ownerId: string): boolean {
  if (kind === 'doc') return !!get('SELECT 1 AS x FROM docs WHERE id = ? AND project_id = ?', ownerId, projectId);
  if (kind === 'task') return !!get('SELECT 1 AS x FROM tasks WHERE id = ? AND project_id = ?', ownerId, projectId);
  return false;
}

/**
 * Check the ids a message is sent with: each must be a pending upload of this project. Returns the rows, or an error
 * that names the problem. Nothing is changed until bindAttachments.
 */
export function pendingAttachments(projectId: string, ids: unknown, requestId?: string): { rows: Row[] } | { error: string } {
  if (ids === undefined || ids === null) return { rows: [] };
  if (!Array.isArray(ids) || ids.some((i) => typeof i !== 'string')) return { error: 'attachments must be a list of attachment ids.' };
  if (ids.length > 50) return { error: 'At most 50 attachments per message.' };
  const rows: Row[] = [];
  for (const id of new Set(ids as string[])) {
    const a = getAttachment(id);
    if (!a || a.project_id !== projectId) return { error: `No attachment ${id} on this project.` };
    if (a.owner_kind !== 'pending') return { error: `Attachment ${a.name} was already sent with another message.` };
    // Uploaded for a request: only that request's answer takes it.
    if (a.owner_id && a.owner_id !== requestId) return { error: `Attachment ${a.name} was uploaded for another request.` };
    rows.push(a);
  }
  return { rows };
}

export function bindAttachments(rows: Row[], kind: OwnerKind, ownerId: string | number) {
  for (const a of rows) run('UPDATE attachments SET owner_kind = ?, owner_id = ? WHERE id = ?', kind, String(ownerId), a.id);
}

const human = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
export const sizeLabel = human;

/** The lines appended to a message delivered to an agent, and what list_attachments prints. */
export function attachmentLines(rows: Row[]): string {
  // A row may carry a role (annotations.ts sets one): what the file is, said after its path.
  return rows
    .map((a) => {
      const by = a.uploader === 'user' ? 'the user' : `${a.uploader} (an agent)`;
      const about = a.role ? ` — ${a.role}` : a.caption ? ` — caption: ${a.caption}` : '';
      return `- ${attachmentPath(a)}  (${a.mime}, ${human(a.size)}, named "${a.name.replace(/"/g, "'")}", added by ${by}, [[${a.id}]])${about}`;
    })
    .join('\n');
}

export function attachmentsBlock(rows: Row[]): string {
  if (!rows.length) return '';
  return `\n\n<attachments note="Files the user attached to this message. They are part of the message: look at them. Open images and PDFs with the Read tool.">\n${attachmentLines(rows)}\n</attachments>`;
}

// ---------- removal ----------

function unlinkQuiet(path: string) {
  try {
    unlinkSync(path);
  } catch {}
}

export function deleteAttachment(a: Row) {
  unlinkQuiet(attachmentPath(a));
  run('DELETE FROM attachments WHERE id = ?', a.id);
}

export function deleteOwnedBy(kind: OwnerKind, ownerId: string) {
  for (const a of listAttachments(kind, ownerId)) deleteAttachment(a);
}

/** Project removal: its rows go with the project (foreign key); the folder goes here. */
export function deleteProjectAttachments(projectId: string) {
  rmSync(join(DATA_DIR, 'attachments', projectId), { recursive: true, force: true });
}

/**
 * At start: uploads never sent (older than a day), attachments whose owner is gone, files with no row (an upload cut
 * off by a restart), and folders of projects that no longer exist.
 */
export function sweepAttachments() {
  const day = now() - 24 * 3600 * 1000;
  const orphans = all(
    `SELECT * FROM attachments WHERE (owner_kind = 'pending' AND created_at < ?)
       OR (owner_kind = 'doc' AND owner_id NOT IN (SELECT id FROM docs))
       OR (owner_kind = 'task' AND owner_id NOT IN (SELECT id FROM tasks))
       OR (owner_kind = 'message' AND owner_id NOT IN (SELECT CAST(id AS TEXT) FROM task_messages))
       OR (owner_kind = 'event' AND owner_id NOT IN (SELECT CAST(id AS TEXT) FROM events WHERE kind = 'inbound'))
       OR (owner_kind = 'inbox' AND owner_id NOT IN (SELECT id FROM inbox))`,
    day,
  );
  for (const a of orphans) deleteAttachment(a);
  const root = join(DATA_DIR, 'attachments');
  if (!existsSync(root)) return;
  for (const pid of readdirSync(root)) {
    const dir = join(root, pid);
    if (!get('SELECT 1 AS x FROM projects WHERE id = ?', pid)) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    const known = new Set(all('SELECT file FROM attachments WHERE project_id = ?', pid).map((r) => r.file));
    for (const f of readdirSync(dir)) if (!known.has(f)) unlinkQuiet(join(dir, f));
  }
}

// ---------- upload ----------

type UploadError = { code: number; error: string };

/**
 * Stream a multipart upload to disk: each file part becomes an attachment of `owner` (or pending). Limits are
 * enforced while reading, and on any failure every file written by this request is removed.
 */
export function receiveUpload(req: FastifyRequest, projectId: string, owner: { kind: OwnerKind; id: string }, uploader: string): Promise<{ rows: Row[] } | UploadError> {
  const dir = attachmentsDir(projectId);
  const mb = Math.round(LIMITS.fileBytes / 1024 / 1024);
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > LIMITS.files * (LIMITS.fileBytes + 64 * 1024)) {
    return Promise.resolve({ code: 413, error: `That upload is too large: at most ${LIMITS.files} files of up to ${mb} MB each per upload.` });
  }
  return new Promise((resolve) => {
    const written: { id: string; tmp: string; name: string; head: Buffer; size: number; done: Promise<void> }[] = [];
    let failed: UploadError | null = null;
    let finished = false;

    const fail = (e: UploadError) => {
      if (failed || finished) return;
      failed = e;
      req.raw.unpipe();
      req.raw.resume(); // drain what the client still sends, so it reads the reply instead of a reset
      for (const w of written) unlinkQuiet(w.tmp);
      resolve(e);
    };

    let bb;
    try {
      bb = Busboy({ headers: req.headers as any, limits: { fileSize: LIMITS.fileBytes, files: LIMITS.files, fields: 20, parts: LIMITS.files + 20, headerPairs: 50 } });
    } catch (err: any) {
      resolve({ code: 400, error: `Not a file upload (${err.message}).` });
      return;
    }

    bb.on('file', (_field: string, stream: NodeJS.ReadableStream & { truncated?: boolean }, filename: string) => {
      if (failed) {
        stream.resume();
        return;
      }
      const id = newId('att');
      const tmp = join(dir, `${id}.part`);
      const name = cleanName(filename);
      const entry = { id, tmp, name, head: Buffer.alloc(0), size: 0, done: Promise.resolve() };
      written.push(entry);
      const out: Writable = createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
      entry.done = new Promise((res, rej) => {
        out.on('finish', res);
        out.on('error', rej);
      });
      stream.on('data', (chunk: Buffer) => {
        if (entry.head.length < 8192) entry.head = Buffer.concat([entry.head, chunk.subarray(0, 8192 - entry.head.length)]);
        entry.size += chunk.length;
      });
      stream.on('limit', () => fail({ code: 413, error: `${name} is larger than the ${mb} MB limit for one file.` }));
      stream.pipe(out);
      entry.done.catch((err) => fail({ code: 500, error: `Could not save ${name}: ${err.message}` }));
    });
    bb.on('filesLimit', () => fail({ code: 413, error: `Too many files: at most ${LIMITS.files} per upload.` }));
    bb.on('partsLimit', () => fail({ code: 413, error: 'Too many parts in one upload.' }));
    bb.on('error', (err: any) => fail({ code: 400, error: `The upload was cut off or malformed (${err?.message ?? err}).` }));
    bb.on('finish', async () => {
      if (failed) return;
      try {
        await Promise.all(written.map((w) => w.done));
      } catch {
        return; // fail() already answered
      }
      if (failed) return;
      if (!written.length) return fail({ code: 400, error: 'No files in the upload.' });
      const rows: Row[] = [];
      for (const w of written) {
        if (!w.size) {
          unlinkQuiet(w.tmp);
          continue;
        }
        const t = sniff(w.head, w.name);
        const file = `${w.id}${t.ext}`;
        renameSync(w.tmp, join(dir, file));
        run(
          'INSERT INTO attachments (id, project_id, owner_kind, owner_id, name, mime, kind, size, file, uploader, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          w.id, projectId, owner.kind, owner.id, w.name, t.mime, t.kind, statSync(join(dir, file)).size, file, uploader, now(),
        );
        rows.push(getAttachment(w.id)!);
      }
      finished = true;
      if (!rows.length) return resolve({ code: 400, error: 'The files were empty.' });
      resolve({ rows });
    });
    req.raw.on('aborted', () => fail({ code: 400, error: 'The upload was cancelled.' }));
    req.raw.pipe(bb);
  });
}

/**
 * Copy a file already on this machine into a project's attachments: the original image sent with annotated feedback.
 * Same type detection and size limit as an upload. `name` is a display name; `src` must already be a path the caller
 * has checked.
 */
export function importFile(projectId: string, src: string, name: string, owner: { kind: OwnerKind; id: string }, uploader: string, caption = ''): { row: Row } | { error: string } {
  let size: number;
  try {
    const st = statSync(src);
    if (!st.isFile()) return { error: `${name} is not a file.` };
    size = st.size;
  } catch {
    return { error: `${name} is gone.` };
  }
  if (!size) return { error: `${name} is empty.` };
  if (size > LIMITS.fileBytes) return { error: `${name} is larger than the ${Math.round(LIMITS.fileBytes / 1024 / 1024)} MB limit for one file.` };
  const head = Buffer.alloc(Math.min(8192, size));
  const fd = openSync(src, 'r');
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  const id = newId('att');
  const t = sniff(head, name);
  const file = `${id}${t.ext}`;
  copyFileAtomic(src, join(attachmentsDir(projectId), file));
  chmodSync(join(attachmentsDir(projectId), file), 0o600);
  const clean = cleanName(name);
  run(
    'INSERT INTO attachments (id, project_id, owner_kind, owner_id, name, mime, kind, size, file, uploader, caption, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    id, projectId, owner.kind, owner.id, /\.[a-z0-9]{1,8}$/i.test(clean) ? clean : `${clean}${t.ext}`, t.mime, t.kind, size, file, uploader, caption, now(),
  );
  return { row: getAttachment(id)! };
}

// ---------- serving ----------

/** Types shown in the browser as themselves. Anything else, notably HTML and SVG, is only ever downloaded. */
const INLINE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp',
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/aac',
  'application/pdf', 'text/plain',
]);

export function serveAttachment(req: FastifyRequest, reply: FastifyReply, a: Row) {
  const path = attachmentPath(a);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return reply.code(404).send({ error: 'The file is gone.' });
  }
  const download = (req.query as any)?.download === '1' || !INLINE.has(a.mime);
  const type = !INLINE.has(a.mime) ? 'application/octet-stream' : a.mime === 'text/plain' ? 'text/plain; charset=utf-8' : a.mime;
  const ascii = a.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  reply
    .header('content-type', type)
    .header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(a.name)}`)
    .header('x-content-type-options', 'nosniff')
    // No scripts, no plugins, no network: even if a browser rendered the bytes as a document, nothing in it could run.
    .header('content-security-policy', "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'")
    .header('cross-origin-resource-policy', 'same-origin')
    .header('cache-control', 'private, max-age=604800, immutable')
    .header('accept-ranges', 'bytes');
  // Ranges: Safari will not play a video without them.
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
    reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`).header('content-length', end - start + 1);
    return reply.send(createReadStream(path, { start, end }));
  }
  reply.header('content-length', size);
  return reply.send(createReadStream(path));
}

// ---------- references a manager attaches (attach_reference) ----------

/** Names and folders that hold secrets. Such files are refused even when they sit in the project. */
export const SECRET_NAME = /^(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|\.htpasswd|credentials(\..*)?|secrets?(\..*)?|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|kdbx|keystore|jks|asc|gpg))$/i;
export const SECRET_DIR = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|\.config\/gh|\.config\/gcloud)(\/|$)/;
/** Text inside a file that gives a secret away: private keys and common API key shapes. */
export const SECRET_TEXT = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bsk-(ant-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}/;

/** The project folder and the worktrees git knows for it: where an agent may take a file from. */
export function projectRoots(projectPath: string): string[] {
  const roots = [projectPath];
  try {
    const out = execFileSync('git', ['-C', projectPath, 'worktree', 'list', '--porcelain'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) if (line.startsWith('worktree ')) roots.push(line.slice(9));
  } catch {}
  return roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return r;
    }
  });
}

const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Files of this project's previews (images inside comparisons and guides included), by artifact file name. */
function previewFiles(projectId: string): Set<string> {
  const files = new Set<string>();
  for (const p of all('SELECT file, content, kind FROM previews WHERE project_id = ?', projectId)) {
    if (p.file) files.add(p.file);
    if ((p.kind === 'compare' || p.kind === 'guide') && p.content) for (const m of String(p.content).matchAll(/"file":"([^"/\\]+)"/g)) files.add(m[1]);
  }
  return files;
}

/**
 * Check a path an agent wants to attach: it must resolve (symlinks followed) inside the project folder, one of its
 * worktrees, /tmp, or this project's preview artifacts; be a file; and not look like credentials by name, folder or
 * content. Returns the resolved path or why not.
 */
export function checkAgentFile(project: Row, path: string): { path: string } | { error: string } {
  if (!isAbsolute(path)) path = join(project.path, path);
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return { error: `No such file: ${path}` };
  }
  const artifacts = realpathSync(ARTIFACT_DIR);
  // Inside Helm's own data (its database, passphrase, other projects' files) only this project's preview files may be
  // taken, wherever that folder lives (even under /tmp or the project).
  const allowed = inside(real, realpathSync(DATA_DIR))
    ? inside(real, artifacts) && previewFiles(project.id).has(real.slice(artifacts.length + 1))
    : [...projectRoots(project.path), realpathSync(tmpdir()), '/tmp'].some((r) => inside(real, r));
  if (!allowed) return { error: `${path} is outside what can be attached: the project folder and its worktrees, /tmp, and this project's preview files.` };
  if (!statSync(real).isFile()) return { error: `${path} is not a file.` };
  if (SECRET_NAME.test(basename(real)) || SECRET_DIR.test(real)) return { error: `${basename(real)} looks like credentials or keys; it is not attached.` };
  const head = Buffer.alloc(Math.min(256 * 1024, statSync(real).size));
  const fd = openSync(real, 'r');
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  if (!head.includes(0) && SECRET_TEXT.test(head.toString('utf8'))) return { error: `${basename(real)} contains what looks like a private key or API token; it is not attached.` };
  return { path: real };
}

/** The file behind a preview (side: 'before' or 'after' of a comparison, or a guide step number from 1). */
export function previewFile(projectId: string, previewId: string, side?: string): { path: string; name: string } | { error: string } {
  const p = get('SELECT * FROM previews WHERE id = ? AND project_id = ?', previewId, projectId);
  if (!p) return { error: `No preview ${previewId} on this project.` };
  let file: string | null = p.file;
  let label = p.title;
  if (p.kind === 'compare') {
    const c = JSON.parse(p.content ?? '{}');
    const s = side === 'before' ? 'before' : 'after';
    file = c?.[s]?.file ?? null;
    label = `${p.title} (${c?.[s]?.label ?? s})`;
  } else if (p.kind === 'guide') {
    const n = Number(side ?? 1);
    const steps = JSON.parse(p.content ?? '{}')?.steps ?? [];
    file = steps[n - 1]?.image?.file ?? steps.find((s: any) => s.image)?.image?.file ?? null;
    label = `${p.title} (step ${n})`;
  }
  if (!file || file.includes('/')) return { error: `Preview ${previewId} has no file to attach (a ${p.kind} preview${p.kind === 'link' || p.kind === 'chart' ? ' keeps its content inline' : ''}).` };
  return { path: join(ARTIFACT_DIR, file), name: `${label.slice(0, 100)}${extname(file)}` };
}
