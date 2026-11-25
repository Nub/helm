import type { FastifyInstance, FastifyReply } from 'fastify';
import { attachmentView, deleteAttachment, receiveUpload } from './attachments.ts';
import { newId, run } from './db.ts';
import { rootAgent, sendToAgent } from './agents.ts';
import { getProject, touchProject } from './store.ts';
import { USER } from './tasks.ts';
import {
  IDEA_OWNER,
  boardView,
  cardView,
  createCard,
  createFrame,
  createImageCard,
  deleteCard,
  deleteFrame,
  discussFrame,
  fetchLinkPreview,
  frameView,
  getCard,
  getFrame,
  previewLater,
  updateCard,
  updateFrame,
} from './ideas.ts';
import type { CardKind } from './ideas.ts';

function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}

/** The Ideas board (ideas.ts): cards, frames, image uploads and Discuss. */
export function registerIdeasApi(app: FastifyInstance) {
  app.get('/api/projects/:id/ideas', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    return boardView(project.id);
  });

  /** A note or a link: { kind, text | url, x, y, w?, h? }. */
  app.post('/api/projects/:id/ideas/cards', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.kind !== 'note' && b.kind !== 'link') return bad(reply, 'kind must be note or link; images are uploaded.');
    const c = createCard(project.id, { kind: b.kind as CardKind, text: b.text, url: b.url, x: b.x, y: b.y, w: b.w, h: b.h });
    if ('error' in c) return bad(reply, c.error);
    if (c.kind === 'link') previewLater(c.id, project.id);
    touchProject(project.id);
    return cardView(c);
  });

  /** Images (multipart, one card each), placed from ?x=&y= and stepped so they do not cover each other. */
  app.post('/api/projects/:id/ideas/images', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    if (!String(req.headers['content-type'] ?? '').startsWith('multipart/form-data')) return bad(reply, 'Send the images as multipart/form-data.', 415);
    const q = (req.query ?? {}) as Record<string, string>;
    // One upload is one owner: the files land on a placeholder id and each is moved to its own card below.
    const holder = newId('ic');
    const res = await receiveUpload(req, project.id, { kind: IDEA_OWNER, id: holder }, 'user');
    if ('error' in res) return reply.code(res.code).header('connection', 'close').send({ error: res.error });
    const made = [];
    let i = 0;
    for (const a of res.rows) {
      if (a.kind !== 'image') {
        deleteAttachment(a);
        continue;
      }
      const id = i === 0 ? holder : newId('ic');
      run('UPDATE attachments SET owner_id = ? WHERE id = ?', id, a.id);
      const x = q.x != null ? Number(q.x) + i * 32 : undefined;
      const y = q.y != null ? Number(q.y) + i * 32 : undefined;
      made.push(cardView(createImageCard(project.id, id, a, { x, y, w: q.w, h: q.h })));
      i++;
    }
    if (!made.length) return bad(reply, 'Only images can go on the board as image cards.');
    touchProject(project.id);
    return { cards: made, attachments: res.rows.filter((a) => a.kind === 'image').map(attachmentView) };
  });

  app.patch('/api/ideas/cards/:cid', async (req, reply) => {
    const c = getCard((req.params as any).cid);
    if (!c) return bad(reply, 'No such card', 404);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const next = updateCard(c, { x: b.x, y: b.y, w: b.w, h: b.h, text: b.text });
    touchProject(c.project_id);
    return cardView(next);
  });

  app.delete('/api/ideas/cards/:cid', async (req, reply) => {
    const c = getCard((req.params as any).cid);
    if (!c) return bad(reply, 'No such card', 404);
    deleteCard(c);
    touchProject(c.project_id);
    return { ok: true };
  });

  app.post('/api/projects/:id/ideas/frames', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const f = createFrame(project.id, b);
    if ('error' in f) return bad(reply, f.error);
    touchProject(project.id);
    return frameView(f);
  });

  app.patch('/api/ideas/frames/:fid', async (req, reply) => {
    const f = getFrame((req.params as any).fid);
    if (!f) return bad(reply, 'No such frame', 404);
    const next = updateFrame(f, (req.body ?? {}) as Record<string, unknown>);
    touchProject(f.project_id);
    return frameView(next);
  });

  app.delete('/api/ideas/frames/:fid', async (req, reply) => {
    const f = getFrame((req.params as any).fid);
    if (!f) return bad(reply, 'No such frame', 404);
    deleteFrame(f);
    touchProject(f.project_id);
    return { ok: true };
  });

  /** Discuss a frame: a discussion holding its cards, delivered to the director like one the user starts. */
  app.post('/api/ideas/frames/:fid/discuss', async (req, reply) => {
    const f = getFrame((req.params as any).fid);
    if (!f) return bad(reply, 'No such frame', 404);
    const project = getProject(f.project_id)!;
    const res = await discussFrame(f, USER, async (d, text, files) => {
      const t = String(d.title).replace(/"/g, "'");
      await sendToAgent(rootAgent(project).id, `<discussion-message discussion="${d.id}" title="${t}" new="true">\n${text}\n</discussion-message>`, { kind: 'user', name: 'You' }, files, false);
    });
    if ('error' in res) return bad(reply, res.error);
    touchProject(f.project_id);
    return res;
  });
}
