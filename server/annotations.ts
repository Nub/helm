import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ARTIFACT_DIR } from './config.ts';
import { all, get, newId, now, run } from './db.ts';
import type { Row } from './db.ts';
import { attachmentPath, attachmentView, getAttachment, importFile, pendingAttachments } from './attachments.ts';
import { rootAgent, sendToAgent } from './agents.ts';
import { getProject } from './store.ts';
import { sendThreadMessage } from './taskapi.ts';
import { getTask, isDiscussion } from './tasks.ts';
import { dateTimeText } from './clock.ts';

/**
 * Feedback drawn on an image: the user marks up a preview's image (one side of a comparison, a guide step's
 * screenshot) or an attached image, adds numbered notes, and sends it to a task's thread or to the director.
 * Marks and notes are kept as vector data in image coordinates (0-1, origin top left), so they can be shown again
 * over the original and continued later. The browser renders a PNG with the marks drawn in and uploads it as a
 * pending attachment; the original image is copied into attachments here, so both travel with the message and the
 * agent can open them without asking. The message text says everything the vector data does, in words and numbers.
 */

export const MARK_TYPES = ['pen', 'arrow', 'rect', 'ellipse'] as const;
type MarkType = (typeof MARK_TYPES)[number];
export type Mark = { id: string; type: MarkType; color: string; points: [number, number][] };
export type Note = { id: string; x: number; y: number; text: string; mark: string | null };
type Source = { kind: 'preview' | 'attachment'; id: string; side: string };

const LIMIT = { marks: 300, points: 4000, notes: 60, noteText: 2000, comment: 8000 };

// ---------- validation ----------

const unit = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('A coordinate is not a number.');
  return Math.min(1, Math.max(0, Math.round(n * 10000) / 10000));
};
const shortId = (v: unknown) => {
  const s = String(v ?? '');
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(s)) throw new Error('A mark or note has a bad id.');
  return s;
};

export function cleanMarks(raw: unknown): Mark[] {
  if (!Array.isArray(raw)) throw new Error('marks must be a list.');
  if (raw.length > LIMIT.marks) throw new Error(`At most ${LIMIT.marks} marks.`);
  return raw.map((m: any) => {
    if (!MARK_TYPES.includes(m?.type)) throw new Error(`Unknown mark type ${String(m?.type).slice(0, 20)}.`);
    const color = String(m.color ?? '');
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw new Error('A mark colour must be #rrggbb.');
    if (!Array.isArray(m.points) || m.points.length < (m.type === 'pen' ? 1 : 2)) throw new Error('A mark has too few points.');
    const points = (m.type === 'pen' ? m.points.slice(0, LIMIT.points) : m.points.slice(0, 2)).map((p: any) => [unit(p?.[0]), unit(p?.[1])] as [number, number]);
    return { id: shortId(m.id), type: m.type, color: color.toLowerCase(), points };
  });
}

export function cleanNotes(raw: unknown, marks: Mark[]): Note[] {
  if (!Array.isArray(raw)) throw new Error('notes must be a list.');
  if (raw.length > LIMIT.notes) throw new Error(`At most ${LIMIT.notes} notes.`);
  const ids = new Set(marks.map((m) => m.id));
  return raw.map((n: any) => ({
    id: shortId(n?.id),
    x: unit(n?.x),
    y: unit(n?.y),
    text: String(n?.text ?? '').trim().slice(0, LIMIT.noteText),
    mark: n?.mark && ids.has(String(n.mark)) ? String(n.mark) : null,
  }));
}

// ---------- the message an agent reads ----------

const pct = (v: number) => `${Math.round(v * 100)}%`;
const span = (a: number, b: number) => (Math.round(a * 100) === Math.round(b * 100) ? pct(a) : `${Math.round(Math.min(a, b) * 100)}–${pct(Math.max(a, b))}`);

/** Where a point is, in words: a 3×3 grid of the image. */
export function region(x: number, y: number): string {
  const row = y < 1 / 3 ? 'top' : y < 2 / 3 ? 'middle' : 'bottom';
  const col = x < 1 / 3 ? 'left' : x < 2 / 3 ? 'center' : 'right';
  if (row === 'middle' && col === 'center') return 'center';
  if (row === 'middle') return `middle ${col}`;
  return `${row} ${col}`;
}

function bounds(m: Mark) {
  const xs = m.points.map((p) => p[0]);
  const ys = m.points.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** A mark in words, e.g. "a box spanning x 55–70%, y 14–22%". */
export function describeMark(m: Mark): string {
  const b = bounds(m);
  const area = `x ${span(b.x0, b.x1)}, y ${span(b.y0, b.y1)}`;
  if (m.type === 'rect') return `a box spanning ${area}`;
  if (m.type === 'ellipse') return `an ellipse circling ${area}`;
  if (m.type === 'pen') return `a freehand mark spanning ${area}`;
  const [[x0, y0], [x1, y1]] = m.points;
  return `an arrow from x ${pct(x0)}, y ${pct(y0)} pointing to x ${pct(x1)}, y ${pct(y1)} (${region(x1, y1)})`;
}

const quote = (s: string) => `"${s.replace(/\s+/g, ' ').replace(/"/g, "'")}"`;

/** What was annotated, in words: "the After image of the comparison preview "Login"". */
export function sourcePhrase(kind: string, side: string, title: string, sideLabel = ''): string {
  if (kind === 'attachment') return `the attached image ${quote(title)}`;
  if (side === 'before' || side === 'after') return `the ${sideLabel ? `${quote(sideLabel)} (${side})` : side} side of the comparison preview ${quote(title)}`;
  const step = /^step:(\d+)$/.exec(side);
  if (step) return `the screenshot of step ${Number(step[1]) + 1} of the guide preview ${quote(title)}`;
  return `the image preview ${quote(title)}`;
}

/**
 * The message text: the overall comment, each note as a numbered line with its place in words and numbers, the marks
 * without a note, and how to read the two attached images. The <attachments> block follows it (runtime.ts).
 */
export function feedbackText(input: { what: string; width: number; height: number; comment: string; marks: Mark[]; notes: Note[]; continues?: number | null }): string {
  const out: string[] = [`Feedback drawn on ${input.what} (${input.width}×${input.height} px).`];
  if (input.continues) out.push(`This continues the feedback the user drew on the same image on ${dateTimeText(input.continues)}; the marks and notes below are the complete set now.`);
  if (input.comment.trim()) out.push(input.comment.trim());
  const byId = new Map(input.marks.map((m) => [m.id, m]));
  if (input.notes.length) {
    out.push(
      'Numbered notes (x is measured from the left edge and y from the top, in % of the image width and height):\n' +
        input.notes
          .map((n, i) => {
            const m = n.mark ? byId.get(n.mark) : undefined;
            return `${i + 1}. ${n.text ? quote(n.text) : '(no text)'} at x ${pct(n.x)}, y ${pct(n.y)} (${region(n.x, n.y)})${m ? `, on ${describeMark(m)}` : ''}`;
          })
          .join('\n'),
    );
  }
  const noted = new Set(input.notes.map((n) => n.mark).filter(Boolean));
  const loose = input.marks.filter((m) => !noted.has(m.id));
  if (loose.length) out.push(`${input.notes.length ? 'Marks without a note' : 'Marks (x from the left, y from the top, in % of the image)'}:\n${loose.map((m) => `- ${describeMark(m)}`).join('\n')}`);
  out.push('Two images are attached: the original as the user saw it, and a copy with the marks and numbered pins drawn on it (the pin numbers match the notes). Open both.');
  return out.join('\n\n');
}

// ---------- sources ----------

/** The image file behind a preview or one of its parts, with what it is called. */
function resolveSource(projectId: string, kind: string, id: string, side: string): { path: string; url: string; title: string; name: string; what: string; taskId: string | null } | { error: string } {
  if (kind === 'attachment') {
    const a = getAttachment(id);
    if (!a || a.project_id !== projectId) return { error: 'No such attachment on this project.' };
    if (a.kind !== 'image') return { error: 'Only images can be annotated.' };
    const taskId =
      a.owner_kind === 'task' ? a.owner_id : a.owner_kind === 'message' ? (get('SELECT task_id FROM task_messages WHERE id = ?', Number(a.owner_id))?.task_id ?? null) : null;
    return { path: attachmentPath(a), url: `/api/attachments/${a.id}/file`, title: a.name, name: a.name, what: sourcePhrase('attachment', '', a.name), taskId };
  }
  if (kind !== 'preview') return { error: 'source.kind must be preview or attachment.' };
  const p = get('SELECT * FROM previews WHERE id = ? AND project_id = ?', id, projectId);
  if (!p) return { error: 'No such preview on this project.' };
  let file: string | null = null;
  let sideLabel = '';
  if (p.kind === 'image' && !side) file = p.file;
  else if (p.kind === 'compare' && (side === 'before' || side === 'after')) {
    const c = JSON.parse(p.content ?? '{}');
    file = c?.[side]?.file ?? null;
    sideLabel = c?.[side]?.label ?? '';
  } else if (p.kind === 'guide' && /^step:\d+$/.test(side)) {
    const g = JSON.parse(p.content ?? '{}');
    file = g?.steps?.[Number(side.slice(5))]?.image?.file ?? null;
  }
  if (!file || file.includes('/') || file.includes('..')) return { error: 'That preview has no image there.' };
  const base = p.title.slice(0, 80) + (side ? ` (${side.replace('step:', 'step ')})` : '');
  return { path: join(ARTIFACT_DIR, file), url: `/artifacts/${file}`, title: p.title, name: `${base}${/\.[a-z0-9]+$/i.exec(file)?.[0] ?? ''}`, what: sourcePhrase('preview', side, p.title, sideLabel), taskId: p.task_id ?? null };
}

/** Open tasks and discussions, most recently active first: where feedback can go besides the director. */
function openThreads(projectId: string): Row[] {
  return all(
    `SELECT id, title, kind, state FROM tasks WHERE project_id = ?
       AND ((kind = 'task' AND state NOT IN ('done', 'dropped')) OR (kind = 'discussion' AND state = 'open'))
     ORDER BY updated_at DESC LIMIT 200`,
    projectId,
  );
}

const threadRef = (t: Row | undefined) => (t ? { id: t.id, title: t.title, kind: isDiscussion(t) ? 'discussion' : 'task', state: t.state } : null);

export function annotationView(r: Row) {
  const original = r.original_id ? getAttachment(r.original_id) : undefined;
  const flat = r.flat_id ? getAttachment(r.flat_id) : undefined;
  return {
    id: r.id,
    project_id: r.project_id,
    source: { kind: r.source_kind, id: r.source_id, side: r.side },
    title: r.title,
    width: r.width,
    height: r.height,
    marks: JSON.parse(r.marks) as Mark[],
    notes: JSON.parse(r.notes) as Note[],
    comment: r.comment,
    original: original ? attachmentView(original) : null,
    flat: flat ? attachmentView(flat) : null,
    task: threadRef(r.task_id ? getTask(r.task_id) : undefined),
    parent_id: r.parent_id,
    created_at: r.created_at,
  };
}

// ---------- API ----------

function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}

export function registerAnnotationApi(app: FastifyInstance) {
  /** What the editor needs before sending: the image, where it goes by default, the open threads to pick from. */
  app.get('/api/projects/:id/annotate', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const q = req.query as { kind?: string; id?: string; side?: string; parent?: string };
    const src = resolveSource(project.id, String(q.kind ?? ''), String(q.id ?? ''), String(q.side ?? ''));
    if ('error' in src) return bad(reply, src.error, 404);
    const parent = q.parent ? get('SELECT * FROM annotations WHERE id = ? AND project_id = ?', q.parent, project.id) : undefined;
    const defaultTask = parent ? parent.task_id : src.taskId;
    const task = defaultTask ? getTask(defaultTask) : undefined;
    const earlier = all('SELECT id, created_at FROM annotations WHERE source_kind = ? AND source_id = ? AND side = ? ORDER BY created_at DESC LIMIT 20', q.kind, q.id, String(q.side ?? ''));
    return { title: src.title, url: src.url, target: threadRef(task), threads: openThreads(project.id).map(threadRef), director: rootAgent(project).name, earlier };
  });

  app.get('/api/annotations/:id', async (req, reply) => {
    const r = get('SELECT * FROM annotations WHERE id = ?', (req.params as any).id);
    return r ? { annotation: annotationView(r) } : bad(reply, 'No such annotation', 404);
  });

  /**
   * Send feedback: { source: {kind, id, side}, width, height, marks, notes, comment, flat (a pending PNG upload),
   * to: {task: id} or {director: true}, parent? }.
   */
  app.post('/api/projects/:id/annotations', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const b = (req.body ?? {}) as any;
    const kind = String(b.source?.kind ?? '');
    const side = String(b.source?.side ?? '');
    const src = resolveSource(project.id, kind, String(b.source?.id ?? ''), side);
    if ('error' in src) return bad(reply, src.error);
    const width = Math.round(Number(b.width));
    const height = Math.round(Number(b.height));
    if (!(width > 0 && height > 0 && width <= 100000 && height <= 100000)) return bad(reply, 'width and height must be the image size in pixels.');
    let marks: Mark[];
    let notes: Note[];
    try {
      marks = cleanMarks(b.marks ?? []);
      notes = cleanNotes(b.notes ?? [], marks);
    } catch (err: any) {
      return bad(reply, err.message);
    }
    const comment = String(b.comment ?? '').trim().slice(0, LIMIT.comment);
    if (!marks.length && !notes.length) return bad(reply, 'Draw a mark or add a note first.');
    const flatRes = pendingAttachments(project.id, [String(b.flat ?? '')]);
    if ('error' in flatRes) return bad(reply, flatRes.error);
    const flat = flatRes.rows[0];
    if (flat.mime !== 'image/png') return bad(reply, 'The marked-up image must be a PNG.');
    const toTask = b.to?.task ? getTask(String(b.to.task)) : undefined;
    if (b.to?.task && (!toTask || toTask.project_id !== project.id)) return bad(reply, 'No such task on this project.');
    if (!toTask && b.to?.director !== true) return bad(reply, 'Say where to send it: to.task or to.director.');
    const parent = b.parent ? get('SELECT * FROM annotations WHERE id = ? AND project_id = ?', String(b.parent), project.id) : undefined;
    if (b.parent && !parent) return bad(reply, 'The annotation this continues is gone.');

    const original = importFile(project.id, src.path, src.name.replace(/(\.[a-z0-9]+)?$/i, (e) => ` (original)${e}`), { kind: 'pending', id: '' }, 'user');
    if ('error' in original) return bad(reply, `Could not keep the original image: ${original.error}`);
    const id = newId('ann');
    // The row exists before the message is sent, so the message's attachments already show as feedback.
    run(
      `INSERT INTO annotations (id, project_id, source_kind, source_id, side, title, width, height, marks, notes, comment, original_id, flat_id, task_id, parent_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, project.id, kind, String(b.source.id), side, src.title, width, height, JSON.stringify(marks), JSON.stringify(notes), comment, original.row.id, flat.id, toTask?.id ?? null, parent?.id ?? null, now(),
    );
    const text = feedbackText({ what: src.what, width, height, comment, marks, notes, continues: parent?.created_at ?? null });
    const files = [
      { ...original.row, role: 'ORIGINAL: the image as the user saw it, without marks.' },
      { ...flat, role: 'MARKED UP: the same image with the user’s marks and numbered pins drawn on it; the numbers match the notes.' },
    ];
    try {
      if (toTask) await sendThreadMessage(toTask, text, files);
      else await sendToAgent(rootAgent(project).id, text, { kind: 'user', name: 'You' }, files);
    } catch (err: any) {
      run('DELETE FROM annotations WHERE id = ?', id);
      return bad(reply, `Could not send: ${err.message}`, 500);
    }
    // Where it landed: the thread message or the director's event now owns the marked-up image.
    const owner = getAttachment(flat.id);
    if (owner?.owner_kind === 'message') run('UPDATE annotations SET message_id = ? WHERE id = ?', Number(owner.owner_id), id);
    if (owner?.owner_kind === 'event') run('UPDATE annotations SET event_id = ? WHERE id = ?', Number(owner.owner_id), id);
    return { annotation: annotationView(get('SELECT * FROM annotations WHERE id = ?', id)!) };
  });
}
