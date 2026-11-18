import type { FastifyInstance, FastifyReply } from 'fastify';
import { LIMITS, attachmentView, deleteAttachment, getAttachment, listAttachments, ownerOnProject, receiveUpload, requestRefusesFiles, serveAttachment, taskAttachments } from './attachments.ts';
import type { OwnerKind } from './attachments.ts';
import { getProject, touchProject } from './store.ts';

function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}

/** "doc:<id>" or "task:<id>" (tasks and discussions); absent for a composer's pending upload. */
function parseOwner(raw: unknown): { kind: OwnerKind; id: string } | null | 'bad' {
  if (raw === undefined || raw === '') return null;
  const m = /^(doc|task):([A-Za-z0-9_]+)$/.exec(String(raw));
  return m ? { kind: m[1] as OwnerKind, id: m[2] } : 'bad';
}

/** "request:<id>": an upload for the answer to that request, pending until the answer is sent. */
const requestOf = (raw: unknown) => /^request:([A-Za-z0-9_]+)$/.exec(String(raw ?? ''))?.[1];

export function registerAttachmentApi(app: FastifyInstance) {
  // The body is left unread here; receiveUpload streams it to disk with its own limits. The sign-in hook runs before
  // this, so nothing from a signed-out client is read.
  app.addContentTypeParser('multipart/form-data', (_req, _payload, done) => done(null, undefined));

  app.get('/api/attachments/limits', async () => ({ fileBytes: LIMITS.fileBytes, files: LIMITS.files }));

  /** Upload one or more files (multipart, any field name). With ?owner=doc:ID or task:ID they are its references at once. */
  app.post('/api/projects/:id/attachments', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    if (!String(req.headers['content-type'] ?? '').startsWith('multipart/form-data')) return bad(reply, 'Send the files as multipart/form-data.', 415);
    const request = requestOf((req.query as any)?.owner);
    const owner = request ? null : parseOwner((req.query as any)?.owner);
    if (owner === 'bad') return bad(reply, 'owner must be doc:<id>, task:<id> or request:<id>.');
    if (owner && !ownerOnProject(project.id, owner.kind, owner.id)) return bad(reply, `No ${owner.kind} ${owner.id} on this project.`, 404);
    const refused = request ? requestRefusesFiles(project.id, request) : null;
    if (refused) return reply.code(refused.startsWith('No ') ? 404 : 409).header('connection', 'close').send({ error: refused });
    const res = await receiveUpload(req, project.id, owner ?? { kind: 'pending', id: request ?? '' }, 'user');
    if ('error' in res) return reply.code(res.code).header('connection', 'close').send({ error: res.error });
    if (owner) touchProject(project.id);
    return { attachments: res.rows.map(attachmentView) };
  });

  /** A Spec entry's, task's or discussion's references; for a task or discussion, also those sent in its thread. */
  app.get('/api/projects/:id/attachments', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const owner = parseOwner((req.query as any)?.owner);
    if (!owner || owner === 'bad') return bad(reply, 'owner must be doc:<id> or task:<id>.');
    if (!ownerOnProject(project.id, owner.kind, owner.id)) return bad(reply, `No ${owner.kind} ${owner.id} on this project.`, 404);
    const own = listAttachments(owner.kind, owner.id).map((a) => ({ ...attachmentView(a), removable: true }));
    const thread = owner.kind === 'task' ? taskAttachments(owner.id).filter((a) => a.owner_kind !== 'task').map((a) => ({ ...attachmentView(a), removable: false })) : [];
    return { attachments: [...own, ...thread] };
  });

  app.get('/api/attachments/:id/file', async (req, reply) => {
    const a = getAttachment((req.params as any).id);
    if (!a) return bad(reply, 'No such attachment', 404);
    return serveAttachment(req, reply, a);
  });

  /** Remove a reference, or a pending upload taken out of a composer. Files sent with a message stay with it. */
  app.delete('/api/attachments/:id', async (req, reply) => {
    const a = getAttachment((req.params as any).id);
    if (!a) return bad(reply, 'No such attachment', 404);
    if (a.owner_kind === 'message' || a.owner_kind === 'event' || a.owner_kind === 'inbox') return bad(reply, 'This file was sent with a message and stays with it.', 409);
    deleteAttachment(a);
    if (a.owner_kind !== 'pending') touchProject(a.project_id);
    return { ok: true };
  });
}
