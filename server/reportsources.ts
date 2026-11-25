import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import { GH_PATH } from './config.ts';
import { dateText } from './clock.ts';

/**
 * Report source adapters. Each turns one kind of outside source (GitHub issues,
 * a folder of notes, a command) into a list of items; reports.ts stores them,
 * copies their attachments and tells the director. Adapters only read.
 */

/** A file to copy into the artifact store: a local path, or (GitHub only) an image URL. */
export type AttachmentRef = { path: string; name?: string } | { url: string; name?: string };

export type PolledItem = {
  id: string;
  title: string;
  body: string;
  fields?: Record<string, unknown>;
  attachments?: AttachmentRef[];
  url?: string;
  author?: string;
  created?: number | null;
  updated?: number | null;
  /** Problems Helm noticed while reading it (a screenshot named but missing, a file that does not parse). */
  warnings?: string[];
};

export type PollContext = {
  projectPath: string;
  cursor: string;
  signal: AbortSignal;
  /** What is already stored for an external id, so unchanged items can be skipped cheaply. */
  known: (externalId: string) => { updated: number | null } | undefined;
  /** A dry run for the Setup form: a few items, nothing downloaded, the cursor ignored. */
  preview?: number;
};

export type PollResult = { items: PolledItem[]; cursor?: string; skipped?: string[]; total?: number; /** More remain beyond this poll's cap: poll again soon. */ more?: boolean };

export type Adapter = {
  type: string;
  label: string;
  /** Check and tidy a config from the Setup form. */
  normalize(config: Record<string, any>, projectPath: string): { config: Record<string, any> } | { error: string };
  poll(config: Record<string, any>, ctx: PollContext): Promise<PollResult>;
  /** Short description of where it reads from, for lists and notes. */
  describe(config: Record<string, any>): string;
};

export class SourceError extends Error {}

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'];
const isImage = (p: string) => IMAGE_EXTS.includes(extname(p).toLowerCase());
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const toTime = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; maxBytes: number; signal: AbortSignal }): Promise<{ stdout: string; stderr: string; code: number | null; error?: NodeJS.ErrnoException }> {
  return new Promise((done) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: opts.maxBytes, signal: opts.signal, killSignal: 'SIGKILL', encoding: 'utf8' }, (error, stdout, stderr) => {
      done({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: error ? ((error as any).code ?? null) : 0, error: (error as NodeJS.ErrnoException | null) ?? undefined });
    });
  });
}

// ---------- GitHub issues ----------

const MAX_ISSUES_PER_POLL = 60;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function gh(path: string, signal: AbortSignal): Promise<any> {
  const res = await run(GH_PATH, ['api', '-H', 'Accept: application/vnd.github.full+json', path], { timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024, signal });
  if (res.error) {
    if (res.error.code === 'ENOENT') throw new SourceError(`The GitHub CLI (gh) was not found${GH_PATH === 'gh' ? ' on the server\'s PATH' : ` at ${GH_PATH}`}. Install it, or set HELM_GH_PATH to its full path.`);
    if (signal.aborted) throw new SourceError('Stopped.');
    if ((res.error as any).killed) throw new SourceError('gh did not answer within 60 seconds.');
    const msg = (res.stderr || res.error.message).trim().split('\n').slice(-3).join(' ').slice(0, 400);
    if (/auth login|not logged|HTTP 401|authentication/i.test(msg)) throw new SourceError(`gh is not logged in for the user Helm runs as. Run \`gh auth login\` as that user. (${msg})`);
    if (/HTTP 404/.test(msg)) throw new SourceError(`Repository not found, or the gh login has no access to it. (${msg})`);
    if (/rate limit/i.test(msg)) throw new SourceError(`GitHub rate limit reached; Helm will try again at the next poll. (${msg})`);
    throw new SourceError(`gh failed: ${msg}`);
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new SourceError('gh returned something that is not JSON.');
  }
}

/** Image URLs in rendered issue HTML (signed, so they also work for private repositories) or else in the markdown. */
function imageUrls(html: string, markdown: string): { url: string; name?: string }[] {
  const out: { url: string; name?: string }[] = [];
  const add = (url: string, name?: string) => {
    url = url.replace(/&amp;/g, '&');
    if (/^https:\/\//.test(url) && !out.some((o) => o.url === url)) out.push({ url, name: name || undefined });
  };
  if (html) {
    for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
      const src = /\bsrc="([^"]+)"/i.exec(m[0])?.[1];
      const alt = /\balt="([^"]*)"/i.exec(m[0])?.[1];
      // Rendered HTML wraps camo-proxied images with the original in data-canonical-src; the camo URL is the one to fetch.
      if (src) add(src, alt);
    }
  } else {
    for (const m of markdown.matchAll(/!\[([^\]]*)\]\((\S+?)(?:\s+"[^"]*")?\)/g)) add(m[2], m[1]);
    for (const m of markdown.matchAll(/<img\b[^>]*\bsrc="([^"]+)"/gi)) add(m[1]);
  }
  return out;
}

const github: Adapter = {
  type: 'github-issues',
  label: 'GitHub issues',
  describe: (c) => `${c.repo}${c.labels?.length ? ` labelled ${c.labels.join(' or ')}` : ''}${c.state && c.state !== 'open' ? ` (${c.state})` : ''}`,
  normalize(c) {
    const repo = str(c.repo).trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
    if (!REPO.test(repo)) return { error: 'Give the repository as owner/name, for example octocat/hello-world.' };
    const labels = (Array.isArray(c.labels) ? c.labels : str(c.labels).split(','))
      .map((l: unknown) => str(l).trim())
      .filter(Boolean)
      .slice(0, 10);
    const state = ['open', 'closed', 'all'].includes(c.state) ? c.state : 'open';
    return { config: { repo, labels, state, comments: c.comments !== false } };
  },
  async poll(c, ctx) {
    const perPage = ctx.preview ? Math.min(ctx.preview, 10) : 100;
    const maxPages = ctx.preview ? 1 : 5;
    const since = ctx.preview ? '' : ctx.cursor;
    const issues = new Map<number, any>();
    // The API ANDs labels; one query per label gives "any of these labels".
    for (const label of c.labels?.length ? c.labels : ['']) {
      for (let page = 1; page <= maxPages; page++) {
        const q = new URLSearchParams({ state: c.state ?? 'open', sort: 'updated', direction: ctx.preview ? 'desc' : 'asc', per_page: String(perPage), page: String(page) });
        if (label) q.set('labels', label);
        if (since) q.set('since', since);
        const list = await gh(`repos/${c.repo}/issues?${q}`, ctx.signal);
        if (!Array.isArray(list)) throw new SourceError('Unexpected answer from GitHub.');
        for (const i of list) if (!i.pull_request) issues.set(i.number, i);
        if (list.length < perPage) break;
      }
    }
    let cursor = ctx.cursor;
    const items: PolledItem[] = [];
    // Oldest change first and at most MAX_ISSUES_PER_POLL per poll, each maybe costing a comments call:
    // a large repository's backlog comes in over several polls, the cursor moving forward each time.
    const ordered = [...issues.values()].sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
    for (const i of ctx.preview ? ordered : ordered.slice(0, MAX_ISSUES_PER_POLL)) {
      if (!cursor || i.updated_at > cursor) cursor = i.updated_at;
      const updated = toTime(i.updated_at);
      if (!ctx.preview && ctx.known(String(i.number))?.updated === updated) continue;
      let body = str(i.body).trim() || '_(no description)_';
      const images = imageUrls(str(i.body_html), str(i.body));
      if (c.comments !== false && i.comments > 0 && !ctx.preview) {
        const comments = await gh(`repos/${c.repo}/issues/${i.number}/comments?per_page=100`, ctx.signal);
        if (Array.isArray(comments) && comments.length) {
          body += `\n\n---\n\n### Comments\n`;
          for (const cm of comments) {
            body += `\n**${str(cm.user?.login) || 'someone'}** (${Date.parse(str(cm.created_at)) ? dateText(Date.parse(str(cm.created_at))) : str(cm.created_at).slice(0, 10)}):\n\n${str(cm.body).trim()}\n`;
            images.push(...imageUrls(str(cm.body_html), str(cm.body)).filter((u) => !images.some((x) => x.url === u.url)));
          }
        }
      }
      const fields: Record<string, unknown> = { issue: `#${i.number}`, state: i.state };
      const labels = (i.labels ?? []).map((l: any) => (typeof l === 'string' ? l : l.name)).filter(Boolean);
      if (labels.length) fields.labels = labels.join(', ');
      if (i.assignees?.length) fields.assignees = i.assignees.map((a: any) => a.login).join(', ');
      if (i.milestone?.title) fields.milestone = i.milestone.title;
      if (i.comments) fields.comments = i.comments;
      if (i.state_reason) fields.state_reason = i.state_reason;
      items.push({
        id: String(i.number),
        title: str(i.title) || `Issue #${i.number}`,
        body,
        fields,
        attachments: ctx.preview ? [] : images.slice(0, 10),
        url: str(i.html_url),
        author: str(i.user?.login),
        created: toTime(i.created_at),
        updated,
      });
    }
    return { items, cursor: ctx.preview ? ctx.cursor : cursor, total: issues.size, more: !ctx.preview && ordered.length > MAX_ISSUES_PER_POLL };
  },
};

// ---------- folder of notes ----------

export const DEFAULT_GLOB = '**/*.{json,toml,md,markdown,txt}';
const TITLE_KEYS = ['title', 'summary', 'subject', 'name', 'heading'];
const BODY_KEYS = ['body', 'description', 'text', 'note', 'notes', 'message', 'comment', 'content', 'details'];
const IMAGE_KEYS = ['screenshot', 'image', 'screenshot_path', 'screenshotPath', 'screenshot_file', 'screenshotFile', 'image_path', 'imagePath', 'images', 'screenshots'];
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const MAX_NOTES = 5000;

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** A note's own path relative to the folder, with forward slashes; also its external id. */
const relId = (root: string, abs: string) => relative(root, abs).split(sep).join('/');

type Parsed = { title: string; body: string; fields: Record<string, unknown>; warnings: string[] };

function pick(fields: Record<string, unknown>, keys: string[]): { key: string; value: string } | null {
  for (const k of keys) {
    if (!k) continue;
    const hit = Object.keys(fields).find((f) => f.toLowerCase() === k.toLowerCase());
    if (hit && (typeof fields[hit] === 'string' || typeof fields[hit] === 'number') && str(fields[hit]).trim()) return { key: hit, value: str(fields[hit]) };
  }
  return null;
}

function parseNote(text: string, ext: string, c: Record<string, any>): Parsed {
  const warnings: string[] = [];
  let fields: Record<string, unknown> = {};
  let body = '';
  let fromStructured = false;
  if (ext === '.json' || ext === '.toml') {
    let data: unknown;
    try {
      data = ext === '.json' ? JSON.parse(text) : parseToml(text);
    } catch (err: any) {
      warnings.push(`The file does not parse as ${ext.slice(1).toUpperCase()}: ${String(err.message).split('\n')[0].slice(0, 200)}`);
      return { title: '', body: '```\n' + text.slice(0, 4000) + '\n```', fields: {}, warnings };
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) fields = { ...(data as Record<string, unknown>) };
    else fields = { value: data };
    fromStructured = true;
  } else if (ext === '.md' || ext === '.markdown') {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    body = text;
    if (m) {
      body = text.slice(m[0].length);
      try {
        const fm = parseYaml(m[1]);
        if (fm && typeof fm === 'object' && !Array.isArray(fm)) fields = { ...(fm as Record<string, unknown>) };
      } catch (err: any) {
        warnings.push(`The front matter does not parse: ${String(err.message).split('\n')[0].slice(0, 200)}`);
      }
    }
  } else {
    body = text;
  }
  const t = pick(fields, [c.titleKey, ...TITLE_KEYS]);
  const b = pick(fields, [c.bodyKey, ...BODY_KEYS]);
  let title = t?.value.trim() ?? '';
  if (b) body = fromStructured ? b.value : `${b.value}\n\n${body}`.trim();
  if (t) delete fields[t.key];
  if (b) delete fields[b.key];
  if (!title) {
    const heading = /^\s*#{1,3}\s+(.+)$/m.exec(body);
    const first = body.split('\n').find((l) => l.trim());
    title = (heading?.[1] ?? (fromStructured ? '' : first ?? '')).trim().slice(0, 200);
    // A plain-text note's first line is its title; do not repeat it as the body's first line.
    if (!heading && !fromStructured && first && ext !== '.md' && ext !== '.markdown') body = body.slice(body.indexOf(first) + first.length);
  }
  return { title, body: body.trim(), fields, warnings };
}

async function safeReal(root: string, p: string): Promise<string | null> {
  try {
    const real = await fsp.realpath(p);
    return inside(root, real) ? real : null;
  } catch {
    return null;
  }
}

type FolderNote = PolledItem & { file: string; images: string[] };

async function readFolder(c: Record<string, any>, ctx: PollContext): Promise<PollResult & { notes: FolderNote[] }> {
  let root: string;
  try {
    root = await fsp.realpath(c.path);
    if (!(await fsp.stat(root)).isDirectory()) throw new Error();
  } catch {
    throw new SourceError(`The folder ${c.path} does not exist or is not readable by the user Helm runs as.`);
  }
  const skipped: string[] = [];
  const matches: string[] = [];
  for await (const rel of fsp.glob(c.glob || DEFAULT_GLOB, { cwd: root })) {
    const r = String(rel);
    if (r.split(/[\\/]/).some((seg) => seg.startsWith('.')) || isImage(r)) continue;
    matches.push(r);
    if (matches.length >= MAX_NOTES) {
      skipped.push(`More than ${MAX_NOTES} files match; only the first ${MAX_NOTES} are read.`);
      break;
    }
  }
  // Which files are real notes, with their stats; symlinks out of the folder are refused.
  const files: { abs: string; rel: string; st: Stats }[] = [];
  for (const rel of matches) {
    const abs = join(root, rel);
    const real = await safeReal(root, abs);
    if (!real) {
      skipped.push(`${rel}: points outside the folder, ignored.`);
      continue;
    }
    const st = await fsp.stat(real).catch(() => null);
    if (!st?.isFile()) continue;
    if (st.size > MAX_NOTE_BYTES) {
      skipped.push(`${rel}: larger than 2 MB, ignored.`);
      continue;
    }
    files.push({ abs: real, rel: relId(root, abs), st });
  }
  const perDir = new Map<string, number>();
  for (const f of files) perDir.set(dirname(f.abs), (perDir.get(dirname(f.abs)) ?? 0) + 1);
  const listings = new Map<string, string[]>();
  const listDir = async (d: string) => {
    if (!listings.has(d)) listings.set(d, await fsp.readdir(d).catch(() => []));
    return listings.get(d)!;
  };

  files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const pickFiles = ctx.preview ? files.slice(0, ctx.preview) : files;
  const notes: FolderNote[] = [];
  for (const f of pickFiles) {
    if (ctx.signal.aborted) throw new SourceError('Stopped.');
    const dir = dirname(f.abs);
    const ext = extname(f.abs).toLowerCase();
    const text = await fsp.readFile(f.abs, 'utf8').catch(() => null);
    if (text === null) {
      skipped.push(`${f.rel}: could not be read.`);
      continue;
    }
    const parsed = parseNote(text, ext, c);
    const images: string[] = [];
    const addImage = async (candidate: string, why: string) => {
      const real = await safeReal(root, candidate);
      if (!real) return why ? parsed.warnings.push(`${why} (${relId(root, candidate)}) was not found, or points outside the notes folder.`) : undefined;
      if (!isImage(real)) return why ? parsed.warnings.push(`${why} (${relId(root, real)}) is not an image.`) : undefined;
      if (!images.includes(real)) images.push(real);
    };
    // (a) a field naming the screenshot
    const keyHit = Object.keys(parsed.fields).find((k) => [c.imageKey, ...IMAGE_KEYS].some((ik) => ik && ik.toLowerCase() === k.toLowerCase()));
    if (keyHit) {
      const vals = Array.isArray(parsed.fields[keyHit]) ? (parsed.fields[keyHit] as unknown[]) : [parsed.fields[keyHit]];
      for (const v of vals.map(str).filter(Boolean).slice(0, 10)) {
        if (/^[a-z]+:\/\//i.test(v)) continue;
        const cands = isAbsolute(v) ? [v] : [resolve(dir, v), resolve(root, v)];
        const found = await (async () => {
          for (const cand of cands) if (await safeReal(root, cand)) return cand;
          return null;
        })();
        await addImage(found ?? cands[0], `The screenshot named in "${keyHit}"`);
      }
    }
    // (b) images referenced in markdown
    for (const m of parsed.body.matchAll(/!\[[^\]]*\]\(([^)\s]+)/g)) {
      if (/^[a-z]+:/i.test(m[1])) continue;
      await addImage(resolve(dir, decodeURIComponent(m[1])), `The image linked in the text`);
    }
    // (c) an image with the same base name
    const base = basename(f.abs, extname(f.abs)).toLowerCase();
    for (const name of await listDir(dir)) {
      if (isImage(name) && basename(name, extname(name)).toLowerCase() === base) await addImage(join(dir, name), '');
    }
    // (d) one folder per note: every image in it
    const folderLayout = c.layout === 'folder' || (c.layout !== 'file' && dir !== root && perDir.get(dir) === 1);
    if (folderLayout) for (const name of (await listDir(dir)).sort()) if (isImage(name) && !name.startsWith('.')) await addImage(join(dir, name), '');

    let updated = f.st.mtimeMs;
    for (const img of images) {
      const st = await fsp.stat(img).catch(() => null);
      if (st) updated = Math.max(updated, st.mtimeMs);
    }
    updated = Math.round(updated);
    const id = f.rel;
    if (!ctx.preview && ctx.known(id)?.updated === updated) continue;
    const fallback = folderLayout ? basename(dir) : basename(f.abs, extname(f.abs));
    notes.push({
      id,
      file: f.rel,
      images: images.slice(0, 10).map((i) => relId(root, i)),
      title: parsed.title || fallback,
      body: parsed.body,
      fields: parsed.fields,
      warnings: parsed.warnings,
      attachments: images.slice(0, 10).map((p) => ({ path: p })),
      created: Math.round(f.st.birthtimeMs || f.st.mtimeMs),
      updated,
    });
  }
  return { items: notes, notes, skipped, total: files.length };
}

const folder: Adapter = {
  type: 'folder',
  label: 'Notes folder',
  describe: (c) => `${c.path}${c.glob && c.glob !== DEFAULT_GLOB ? ` (${c.glob})` : ''}`,
  normalize(c, projectPath) {
    const raw = str(c.path).trim();
    if (!raw) return { error: 'Give the folder the notes are written to.' };
    const path = resolve(projectPath, raw.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'));
    const glob = str(c.glob).trim() || DEFAULT_GLOB;
    if (glob.startsWith('/') || glob.split('/').includes('..')) return { error: 'The file pattern must stay inside the folder (no leading / or ..).' };
    const layout = ['auto', 'file', 'folder'].includes(c.layout) ? c.layout : 'auto';
    const keys = Object.fromEntries(['titleKey', 'bodyKey', 'imageKey'].map((k) => [k, str(c[k]).trim().slice(0, 80)]));
    return { config: { path, glob, layout, ...keys } };
  },
  poll: (c, ctx) => readFolder(c, ctx),
};

// ---------- command ----------

/** Split a command line into words, honouring single and double quotes and backslashes. No shell is involved. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;

const command: Adapter = {
  type: 'command',
  label: 'Command',
  describe: (c) => c.command,
  normalize(c) {
    const line = str(c.command).trim();
    const argv = splitCommand(line);
    if (!argv.length) return { error: 'Give the command to run.' };
    const timeoutSeconds = Math.min(600, Math.max(5, Number(c.timeoutSeconds) || 60));
    return { config: { command: line, argv, timeoutSeconds } };
  },
  async poll(c, ctx) {
    const res = await run(c.argv[0], c.argv.slice(1), { cwd: ctx.projectPath, timeoutMs: c.timeoutSeconds * 1000, maxBytes: MAX_COMMAND_OUTPUT, signal: ctx.signal });
    if (res.error) {
      if (res.error.code === 'ENOENT') throw new SourceError(`Command not found: ${c.argv[0]}`);
      if (ctx.signal.aborted) throw new SourceError('Stopped.');
      if ((res.error as any).killed) throw new SourceError(`The command did not finish within ${c.timeoutSeconds} s (or printed more than 16 MB).`);
      throw new SourceError(`The command failed (exit ${res.code}): ${(res.stderr || res.error.message).trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
    }
    const items: PolledItem[] = [];
    const skipped: string[] = [];
    const lines = res.stdout.split('\n').filter((l) => l.trim());
    for (const [n, line] of lines.entries()) {
      let o: any;
      try {
        o = JSON.parse(line);
      } catch {
        skipped.push(`Line ${n + 1} is not JSON.`);
        continue;
      }
      if (!o || typeof o !== 'object' || (typeof o.id !== 'string' && typeof o.id !== 'number') || str(o.id) === '') {
        skipped.push(`Line ${n + 1} has no "id".`);
        continue;
      }
      const atts = (Array.isArray(o.attachments) ? o.attachments : [])
        .map((a: any) => (typeof a === 'string' ? { path: a } : a && typeof a.path === 'string' ? { path: a.path, name: str(a.name) || undefined } : null))
        .filter(Boolean)
        .map((a: { path: string; name?: string }) => ({ ...a, path: resolve(ctx.projectPath, a.path) }))
        .slice(0, 10);
      items.push({
        id: str(o.id).slice(0, 200),
        title: str(o.title).trim() || `Report ${o.id}`,
        body: str(o.body),
        fields: o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields) ? o.fields : undefined,
        attachments: atts,
        url: /^https?:\/\//.test(str(o.url)) ? str(o.url) : undefined,
        author: str(o.author) || undefined,
        created: toTime(o.created),
        updated: toTime(o.updated),
      });
      if (ctx.preview && items.length >= ctx.preview) break;
    }
    if (lines.length && !items.length) throw new SourceError(`The command printed ${lines.length} line(s) but none is a report: ${skipped.slice(0, 3).join(' ')}`);
    return { items, skipped, total: items.length };
  },
};

export const ADAPTERS: Record<string, Adapter> = { [github.type]: github, [folder.type]: folder, [command.type]: command };
export const SOURCE_TYPES = Object.keys(ADAPTERS);

/**
 * Whether a repository is public, private or internal, from the gh login. Used to pick a GitHub source's default
 * mode: on a public repository anyone can file issues, so the director should only propose work there.
 * Returns null with the reason when it cannot be determined.
 */
export async function repoVisibility(rawRepo: string): Promise<{ visibility: 'public' | 'private' | 'internal' | null; error?: string }> {
  const norm = github.normalize({ repo: rawRepo }, '');
  if ('error' in norm) return { visibility: null, error: norm.error };
  try {
    const r = await gh(`repos/${norm.config.repo}`, AbortSignal.timeout(20_000));
    const v = r?.visibility ?? (r?.private === true ? 'private' : r?.private === false ? 'public' : null);
    return ['public', 'private', 'internal'].includes(v) ? { visibility: v } : { visibility: null, error: 'GitHub did not say.' };
  } catch (err: any) {
    return { visibility: null, error: err instanceof SourceError ? err.message : String(err?.message ?? err) };
  }
}
