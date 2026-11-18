import { closeSync, copyFileSync, fsyncSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Writing files so that a full disk can never leave one half-written.
 *
 * On 2026-11-18 the disk filled and a start of Helm truncated config.json to nothing; every start after that failed to
 * parse it. So no file Helm keeps is written in place: the new content goes to a temporary file beside it, which
 * replaces the old one by rename only once it is completely on disk. A failed write leaves the old file as it was and
 * no temporary file behind. Files are written only when their content changed, so a start on a full disk writes
 * nothing at all.
 *
 * Failures that mean "the disk is full" (ENOSPC, EDQUOT, EFBIG from a file size limit, SQLite's "database or disk is
 * full") are remembered here, in memory (the database may be the thing that cannot be written), so the dashboard can
 * say so (server/disk.ts reads lastDiskFull()).
 */

const FULL_CODES = new Set(['ENOSPC', 'EDQUOT', 'EFBIG']);

/** Whether an error means the disk (or a size limit) is full. SQLITE_FULL is 13; SQLITE_IOERR (10) with ENOSPC under it reads the same. */
export function isDiskFull(err: unknown): boolean {
  const e = err as { code?: string; errcode?: number; errstr?: string; message?: string } | null;
  if (!e || typeof e !== 'object') return false;
  if (e.code && FULL_CODES.has(e.code)) return true;
  const text = `${e.errstr ?? ''} ${e.message ?? ''}`;
  if (e.code === 'ERR_SQLITE_ERROR') {
    if (e.errcode === 13 || (e.errcode ?? 0) % 256 === 13) return true;
    // SQLITE_IOERR does not say why. Only when the disk is at or near the critical level is it a full disk;
    // otherwise it may be real damage, and that must stay loud.
    if ((e.errcode ?? 0) % 256 === 10 || /disk I\/O error/i.test(text)) return nearFull();
  }
  return /\b(ENOSPC|EDQUOT|EFBIG)\b|disk is full|no space left on device|file too large/i.test(text);
}

let nearFull: () => boolean = () => false;
/** server/disk.ts: whether free space is at or near the critical level now. */
export function setNearFull(fn: () => boolean) {
  nearFull = fn;
}

let lastFull: { at: number; what: string; message: string } | null = null;

/** Record a disk-full failure (no-op for other errors). Returns whether it was one. */
export function noteDiskFull(err: unknown, what: string): boolean {
  if (!isDiskFull(err)) return false;
  const message = String((err as Error)?.message ?? err).slice(0, 300);
  if (!lastFull || Date.now() - lastFull.at > 60_000) console.error(`Disk full: ${what}: ${message}`);
  const first = !lastFull;
  lastFull = { at: Date.now(), what, message };
  if (first) fullListener?.();
  return true;
}

let fullListener: (() => void) | null = null;
/** Called when a disk-full failure is recorded after none was (server/disk.ts tells browsers). */
export function onDiskFull(fn: () => void) {
  fullListener = fn;
}

/** The last write that failed because the disk was full, if any. */
export function lastDiskFull() {
  return lastFull;
}
export function clearDiskFull() {
  lastFull = null;
}

/** Test hook: called before every write here with the target path; throw to simulate a failure. */
export const faults: { beforeWrite: ((path: string, bytes: number) => void) | null } = { beforeWrite: null };

/** The temporary names writeFileAtomic and copyFileAtomic use: .<name>.<pid>.<random>.tmp */
export const TMP_PATTERN = /^\..+\.\d+\.[a-z0-9]{1,8}\.tmp$/;

/**
 * At start: remove temporary files of ours older than an hour left under `root` by a process that died mid-write
 * (only our own naming pattern; a few levels deep, where Helm writes). Returns how many.
 */
export function sweepTemporaries(root: string, depth = 4): number {
  let n = 0;
  const cutoff = Date.now() - 3600_000;
  const walk = (dir: string, d: number) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isFile() && TMP_PATTERN.test(e.name)) {
        try {
          if (statSync(p).mtimeMs < cutoff) {
            rmSync(p, { force: true });
            n++;
          }
        } catch {}
      } else if (e.isDirectory() && !e.isSymbolicLink() && d > 0) walk(p, d - 1);
    }
  };
  walk(root, depth);
  return n;
}

const tmpName = (path: string) => join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);

/**
 * Replace `path` with `data`: written to a temporary file in the same folder, flushed, then renamed over it. Does
 * nothing when the file already holds exactly `data` (returns false). Throws on failure, with the old file intact and
 * the temporary one removed; a disk-full failure is also recorded.
 */
export function writeFileAtomic(path: string, data: string | Buffer, opts: { mode?: number; ifChanged?: boolean } = {}): boolean {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  if (opts.ifChanged !== false) {
    try {
      if (readFileSync(path).equals(buf)) return false;
    } catch {}
  }
  const tmp = tmpName(path);
  let fd: number | null = null;
  try {
    faults.beforeWrite?.(path, buf.length);
    fd = openSync(tmp, 'wx', opts.mode ?? 0o644);
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    return true;
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    rmSync(tmp, { force: true });
    noteDiskFull(err, `writing ${path}`);
    throw err;
  }
}

/** Copy a file the same way: whole or not at all. */
export function copyFileAtomic(src: string, dest: string) {
  const tmp = tmpName(dest);
  try {
    faults.beforeWrite?.(dest, 0);
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    noteDiskFull(err, `copying to ${dest}`);
    throw err;
  }
}

/**
 * Run a step that writes (to the database or files) where a full disk should be survived: a disk-full failure is
 * logged and recorded and `fallback` returned; any other error is thrown as before.
 */
export function survive<T>(what: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    if (noteDiskFull(err, what)) return fallback;
    throw err;
  }
}
