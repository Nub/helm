import { closeSync, existsSync, openSync, readSync, statSync, unlinkSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { bus } from './bus.ts';
import { ARTIFACT_DIR } from './config.ts';
import { copyFileAtomic, writeFileAtomic } from './safefs.ts';
import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { formatRequestText, splitAction } from './reqformat.ts';
import type { Structure } from './structure.ts';

/** Agent statuses that mean "no longer part of the active team". */
export const FINISHED = ['done', 'closed'];

/**
 * Housekeeping that must follow any change to a project. touchProject runs these hooks; requests.ts registers one that
 * settles empty request holders (an agent's standing "Requests from …" holder with nothing pending).
 */
const touchHooks: ((projectId: string) => void)[] = [];
export function onTouch(fn: (projectId: string) => void) {
  touchHooks.push(fn);
}

/** Tells browsers to refetch the project. Also runs the onTouch hooks, which settle empty request holders (requests.ts). */
export function touchProject(projectId: string) {
  run('UPDATE projects SET updated_at = ? WHERE id = ?', now(), projectId);
  for (const fn of touchHooks) fn(projectId);
  bus.publish({ type: 'project', projectId });
  bus.publish({ type: 'projects' });
}

export function getProject(id: string): Row | undefined {
  return get('SELECT * FROM projects WHERE id = ?', id);
}
export function getAgent(id: string): Row | undefined {
  return get('SELECT * FROM agents WHERE id = ?', id);
}
export function projectStructure(project: Row): Structure {
  return JSON.parse(project.structure);
}

// ---------- docs ----------

/** Every Spec entry is one kind; goal and design are older names for it, still read but no longer written. */
export const DOC_KINDS = ['entry'];
/** paused: the user pressed Stop; agents leave it alone until it is resumed. */
export const DOC_STATUSES = ['proposed', 'active', 'paused', 'done', 'dropped'];

// ---------- checklist ----------

export const ITEM_STATES = ['todo', 'doing', 'done', 'blocked', 'dropped'] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export function getChecklist(agentId: string): Row[] {
  return all('SELECT id, text, state, sort FROM checklist WHERE agent_id = ? ORDER BY sort, id', agentId);
}

export function setChecklist(agentId: string, items: { text: string; state?: ItemState }[]) {
  tx(() => {
    run('DELETE FROM checklist WHERE agent_id = ?', agentId);
    items.forEach((it, i) =>
      run('INSERT INTO checklist (agent_id, text, state, sort, updated_at) VALUES (?,?,?,?,?)', agentId, it.text, it.state ?? 'todo', i, now()),
    );
  });
}

export function updateChecklist(
  agentId: string,
  updates: { item: number; state?: ItemState; text?: string }[],
  add: { text: string; state?: ItemState }[],
): string | null {
  const items = getChecklist(agentId);
  for (const u of updates) {
    const row = items[u.item - 1];
    if (!row) return `There is no item ${u.item}; the worklist has ${items.length} items.`;
    if (u.state) run('UPDATE checklist SET state = ?, updated_at = ? WHERE id = ?', u.state, now(), row.id);
    if (u.text) run('UPDATE checklist SET text = ?, updated_at = ? WHERE id = ?', u.text, now(), row.id);
  }
  let sort = items.length ? Math.max(...items.map((i) => i.sort)) + 1 : 0;
  for (const a of add) run('INSERT INTO checklist (agent_id, text, state, sort, updated_at) VALUES (?,?,?,?,?)', agentId, a.text, a.state ?? 'todo', sort++, now());
  return null;
}

export function renderChecklist(agentId: string): string {
  const items = getChecklist(agentId);
  if (!items.length) return '(worklist is empty)';
  return items.map((it, i) => `${i + 1}. [${it.state}] ${it.text}`).join('\n');
}

/** Percent complete from the worklist, or null when there is nothing to measure. */
export function checklistProgress(items: Row[]): number | null {
  const live = items.filter((i) => i.state !== 'dropped');
  if (!live.length) return null;
  const score = live.reduce((n, i) => n + (i.state === 'done' ? 1 : i.state === 'doing' ? 0.5 : 0), 0);
  return Math.round((score / live.length) * 100);
}

// ---------- transcript events ----------

const OWN_ACTIVITY = ['text', 'tool', 'tool_result', 'result'];

export function addEvent(agent: Row, kind: string, data: unknown): number {
  const ts = now();
  const json = JSON.stringify(data);
  const res = run('INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES (?,?,?,?,?)', agent.project_id, agent.id, ts, kind, json);
  // What the agent itself did (not what it was sent): its last active time, for the disk guard's cleanup rules.
  if (OWN_ACTIVITY.includes(kind)) run('UPDATE agents SET active_at = ? WHERE id = ?', ts, agent.id);
  bus.publish({
    type: 'event',
    projectId: agent.project_id,
    agentId: agent.id,
    event: { id: Number(res.lastInsertRowid), agent_id: agent.id, ts, kind, data },
  });
  return Number(res.lastInsertRowid);
}

export function listEvents(agentId: string, before: number | null, limit: number): Row[] {
  const rows = before
    ? all('SELECT id, agent_id, ts, kind, data FROM events WHERE agent_id = ? AND id < ? ORDER BY id DESC LIMIT ?', agentId, before, limit)
    : all('SELECT id, agent_id, ts, kind, data FROM events WHERE agent_id = ? ORDER BY id DESC LIMIT ?', agentId, limit);
  return rows.reverse().map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

// ---------- journal ----------

export function addJournal(projectId: string, agentId: string | null, kind: string, title: string, body = '', taskId: string | null = null, docId: string | null = null) {
  const project = getProject(projectId);
  run('INSERT INTO journal (project_id, agent_id, kind, phase, title, body, ts, task_id, doc_id) VALUES (?,?,?,?,?,?,?,?,?)', projectId, agentId, kind, project?.phase ?? '', title, body, now(), taskId, docId);
  touchProject(projectId);
}

// ---------- previews ----------

const KIND_BY_EXT: Record<string, string> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image', '.avif': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.m4v': 'video',
  '.html': 'html', '.htm': 'html',
  '.md': 'markdown',
  '.pdf': 'pdf',
};
const MAX_PREVIEW_BYTES = 500 * 1024 * 1024;
const IMAGE_EXTS = Object.keys(KIND_BY_EXT).filter((e) => KIND_BY_EXT[e] === 'image');

/** An image inside a comparison or guide, as stored in the preview's content JSON. Size is null when unknown (SVG, AVIF). */
export type StoredImage = { file: string; width: number | null; height: number | null };
export type CompareSide = StoredImage & { label: string; caption: string };
export type CompareContent = { before: CompareSide; after: CompareSide };
export type GuideContent = { steps: { text: string; image: StoredImage | null }[]; expect: string };

type ImageRef = { path: string; label?: string; caption?: string };
export type PreviewInput = {
  title: string;
  caption?: string;
  path?: string;
  content?: string;
  url?: string;
  kind?: string;
  before?: ImageRef;
  after?: ImageRef;
  steps?: { text: string; image?: string }[];
  expect?: string;
  task_id?: string | null;
};

/** Resolves a path an agent gave and checks it is a file of a sensible size. */
function sourceFile(project: Row, path: string, imageOnly = false): { abs: string; ext: string } | { error: string } {
  const abs = isAbsolute(path) ? path : resolve(project.path, path);
  if (!existsSync(abs)) return { error: `File not found: ${abs}` };
  const st = statSync(abs);
  if (!st.isFile()) return { error: `Not a file: ${abs}` };
  if (st.size > MAX_PREVIEW_BYTES) return { error: `File is larger than 500 MB: ${abs}` };
  const ext = extname(abs).toLowerCase();
  if (imageOnly && !IMAGE_EXTS.includes(ext)) return { error: `Not an image (${IMAGE_EXTS.join(' ')}): ${abs}` };
  return { abs, ext };
}

/** Pixel size read from the file header for PNG, GIF, JPEG and WebP; null for anything else. */
export function imageSize(abs: string): { width: number; height: number } | null {
  let b = Buffer.alloc(256 * 1024);
  try {
    const fd = openSync(abs, 'r');
    b = b.subarray(0, readSync(fd, b, 0, b.length, 0));
    closeSync(fd);
  } catch {
    return null;
  }
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length && b[i] === 0xff) {
      const marker = b[i + 1];
      // Start-of-frame markers carry the size; C4, C8 and CC share the range but are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

function storeImage(src: { abs: string; ext: string }, file: string): StoredImage {
  copyFileAtomic(src.abs, join(ARTIFACT_DIR, file));
  const size = imageSize(src.abs);
  return { file, width: size?.width ?? null, height: size?.height ?? null };
}

/** Every artifact file a preview owns, so removing it removes them all. */
export function previewFiles(p: Row): string[] {
  const files: string[] = p.file ? [p.file] : [];
  if ((p.kind === 'compare' || p.kind === 'guide') && p.content) {
    try {
      const c = JSON.parse(p.content);
      if (p.kind === 'compare') files.push(c.before.file, c.after.file);
      else for (const s of c.steps) if (s.image) files.push(s.image.file);
    } catch {}
  }
  return files;
}

export function deletePreviewFiles(p: Row) {
  for (const f of previewFiles(p)) {
    try {
      unlinkSync(join(ARTIFACT_DIR, f));
    } catch {}
  }
}

/** Tells the agent when the two sides of a comparison differ in size, so it can retake one. */
function compareNote({ before: b, after: a }: CompareContent): string {
  if (!b.width || !b.height || !a.width || !a.height || (b.width === a.width && b.height === a.height)) return '';
  const shape = Math.abs(b.width / b.height - a.width / a.height) > 0.01 ? 'different aspect ratios' : 'same shape, different sizes';
  return `"${b.label}" is ${b.width}×${b.height} and "${a.label}" is ${a.width}×${a.height} (${shape}); the user is shown that they differ. If they were meant to be the same viewpoint, retake one to match and post again.`;
}

export function addPreview(project: Row, agentId: string | null, input: PreviewInput): { id: string; note?: string } | { error: string } {
  const id = newId('pv');
  let kind = input.kind ?? '';
  let file: string | null = null;
  let content: string | null = null;
  let source = '';
  let note = '';

  if (kind === 'compare' || (!kind && (input.before || input.after))) {
    kind = 'compare';
    if (!input.before?.path || !input.after?.path) return { error: 'A comparison needs both before and after, each with the path of an image: before: {"path": "..."}, after: {"path": "..."}.' };
    const refs = [input.before, input.after];
    const srcs = refs.map((r) => sourceFile(project, r.path, true));
    for (const src of srcs) if ('error' in src) return src;
    const [before, after] = refs.map((r, i): CompareSide => ({
      ...storeImage(srcs[i] as { abs: string; ext: string }, `${id}-${i ? 'after' : 'before'}${(srcs[i] as { ext: string }).ext}`),
      label: r.label?.trim() || (i ? 'After' : 'Before'),
      caption: r.caption?.trim() ?? '',
    }));
    content = JSON.stringify({ before, after });
    source = srcs.map((s) => (s as { abs: string }).abs).join('\n');
    note = compareNote({ before, after });
  } else if (kind === 'guide' || (!kind && input.steps)) {
    kind = 'guide';
    const steps = input.steps ?? [];
    if (!steps.length) return { error: 'A guide needs at least one step: steps: [{"text": "...", "image": "shot1.png"}].' };
    const srcs = steps.map((s) => (s.image ? sourceFile(project, s.image, true) : null));
    for (const [i, s] of steps.entries()) {
      if (!s.text?.trim()) return { error: `Step ${i + 1} has no text.` };
      const src = srcs[i];
      if (src && 'error' in src) return { error: `Step ${i + 1}: ${src.error}` };
    }
    const guide: GuideContent = {
      steps: steps.map((s, i) => {
        const src = srcs[i] as { abs: string; ext: string } | null;
        return { text: s.text.trim(), image: src ? storeImage(src, `${id}-step${i + 1}${src.ext}`) : null };
      }),
      expect: input.expect?.trim() ?? '',
    };
    content = JSON.stringify(guide);
    source = srcs.flatMap((s) => (s && 'abs' in s ? [s.abs] : [])).join('\n');
  } else if (input.path) {
    const src = sourceFile(project, input.path);
    if ('error' in src) return src;
    kind ||= KIND_BY_EXT[src.ext] ?? 'text';
    file = `${id}${src.ext}`;
    copyFileAtomic(src.abs, join(ARTIFACT_DIR, file));
    source = src.abs;
  } else if (input.url) {
    kind ||= 'link';
    content = input.url;
  } else if (input.content !== undefined) {
    kind ||= 'markdown';
    if (kind === 'chart') {
      try {
        const spec = JSON.parse(input.content);
        if (!Array.isArray(spec.series) || !spec.series.length) return { error: 'A chart needs a non-empty "series" array.' };
      } catch {
        return { error: 'Chart content must be JSON: {"type":"line"|"bar","labels":[...],"series":[{"name":"...","values":[...]}]}' };
      }
      content = input.content;
    } else if (kind === 'html') {
      file = `${id}.html`;
      writeFileAtomic(join(ARTIFACT_DIR, file), input.content, { ifChanged: false });
    } else {
      content = input.content;
    }
  } else {
    return { error: 'Give one of path, content or url; or before and after for a comparison; or steps for a guide.' };
  }

  run(
    'INSERT INTO previews (id, project_id, agent_id, kind, title, caption, file, content, source, created_at, task_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, project.id, agentId, kind, input.title, input.caption ?? '', file, content, source, now(), input.task_id ?? null,
  );
  touchProject(project.id);
  return note ? { id, note } : { id };
}

// ---------- snapshots for the UI ----------

/** A preview row with the image feedback the user sent on it (annotations.ts), newest first. */
export function withFeedback(p: Row): Row {
  const feedback = all("SELECT id, side, created_at FROM annotations WHERE source_kind = 'preview' AND source_id = ? ORDER BY created_at DESC LIMIT 20", p.id);
  return feedback.length ? { ...p, feedback } : p;
}

export function agentView(a: Row): Row {
  const checklist = getChecklist(a.id);
  return { ...a, checklist, progress: a.progress ?? checklistProgress(checklist) };
}

export function projectState(projectId: string) {
  const project = getProject(projectId);
  if (!project) return null;
  return {
    project: { ...project, structure: JSON.parse(project.structure) },
    agents: all('SELECT * FROM agents WHERE project_id = ? ORDER BY created_at', projectId).map(agentView),
    docs: all("SELECT d.*, (SELECT COUNT(*) FROM attachments a WHERE a.owner_kind = 'doc' AND a.owner_id = d.id) AS attach_count FROM docs d WHERE d.project_id = ? ORDER BY d.importance DESC, d.updated_at DESC", projectId),
    inbox: all("SELECT * FROM inbox WHERE project_id = ? AND (decided_by IS NULL OR decided_by != 'auto') ORDER BY created_at DESC LIMIT 300", projectId).map(inboxView),
    previews: all('SELECT * FROM previews WHERE project_id = ? ORDER BY created_at DESC LIMIT 500', projectId).map(withFeedback),
    journal: all('SELECT * FROM journal WHERE project_id = ? ORDER BY ts DESC LIMIT 500', projectId),
  };
}

export function inboxView(r: Row): Row {
  const payload = JSON.parse(r.payload);
  const task = r.task_id ? get('SELECT title FROM tasks WHERE id = ?', r.task_id) : undefined;
  // Previews attached to a request travel with it, so the inbox can show them without the project's gallery.
  const ids: string[] = Array.isArray(payload.previews) ? payload.previews : [];
  const previews = ids.map((id) => get('SELECT * FROM previews WHERE id = ?', id)).filter(Boolean);
  // Waiting on the director: how many of this project's requests are, and since when the oldest, so the user can step in.
  const queue = r.status === 'director' ? get("SELECT COUNT(*) AS count, MIN(created_at) AS oldest FROM inbox WHERE project_id = ? AND status = 'director'", r.project_id) : undefined;
  // Steps numbered inline become a numbered list as the user reads it, also for requests filed before that was done at
  // filing (requests.ts, tools.ts). The stored text is unchanged; on text already formatted this changes nothing.
  let body = r.body;
  if (r.kind === 'action' && body) {
    const f = splitAction(body, payload.steps ?? '');
    body = f.body;
    payload.steps = f.steps;
  } else if (r.kind === 'question' && body) body = formatRequestText(body);
  return { ...r, body, options: JSON.parse(r.options), payload, previews, task_title: task?.title ?? null, line: requestLine(r.kind, r.title, payload), ...(queue ? { director_queue: { count: queue.count, oldest: queue.oldest } } : {}) };
}

/**
 * One line saying what a request is about, for a list row: a permission's tool and its command or path,
 * else the title. The UI truncates it; this only flattens it.
 */
export function requestLine(kind: string, title: string, payload: Row): string {
  if (kind !== 'permission') return title;
  let what = typeof payload.summary === 'string' ? payload.summary : '';
  if (!what && typeof payload.input === 'string') {
    // Older rows kept only the (possibly clipped) JSON input: take the first likely field from it.
    const m = payload.input.match(/"(command|file_path|path|url|pattern|query)":\s*"((?:[^"\\]|\\.)*)/);
    if (m) what = m[2].replace(/\\n/g, ' ').replace(/\\(.)/g, '$1');
  }
  if (!what && payload.blockedPath) what = payload.blockedPath;
  const tool = String(payload.toolName ?? 'a tool').replace(/^mcp__([^_]+)__/, '$1: ');
  return (what ? `${tool}: ${what}` : tool).replace(/\s+/g, ' ').trim().slice(0, 400);
}

export function projectSummaries() {
  return all('SELECT * FROM projects ORDER BY archived, position, created_at').map((p) => {
    const agents = all('SELECT * FROM agents WHERE project_id = ?', p.id).map(agentView);
    const active = agents.filter((a) => !FINISHED.includes(a.status));
    const measured = active.filter((a) => a.progress !== null);
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      description: p.description,
      phase: p.phase,
      archived: p.archived,
      updated_at: p.updated_at,
      agents: active.length,
      working: agents.filter((a) => a.status === 'working').length,
      waiting: agents.filter((a) => a.status === 'waiting').length,
      progress: measured.length ? Math.round(measured.reduce((n, a) => n + a.progress, 0) / measured.length) : null,
      openInbox: (get("SELECT COUNT(*) AS n FROM inbox WHERE project_id = ? AND status = 'open'", p.id)?.n as number) ?? 0,
      statusLine: agents.find((a) => !a.parent_id)?.status_line ?? '',
    };
  });
}
