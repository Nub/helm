import type { FastifyInstance, FastifyReply } from 'fastify';
import { getProject, touchProject } from './store.ts';
import { rootAgent, sendToAgent } from './agents.ts';
import { TOPICS, TEXT_LINES, TEXT_MAX, TITLE_MAX, PATHS_MAX, USER, budgetOf, confirmNotes, knowledgeState, markViewed, removeNotes, seedMessage, writeNote } from './knowledge.ts';
import type { NoteInput } from './knowledge.ts';
import { checkSetting, getChoice, setSetting, settingsView } from './settings.ts';
import { get } from './db.ts';

function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
function noteInput(b: Record<string, any>): NoteInput {
  const paths = Array.isArray(b.paths) ? b.paths.filter((p: unknown) => typeof p === 'string') : typeof b.paths === 'string' ? b.paths.split('\n') : undefined;
  return { topic: str(b.topic), title: str(b.title), text: str(b.text), paths };
}

/** The Knowledge page (web/src/knowledge.tsx) and the Agent context group in Setup. The user's writes count as confirmed. */
export function registerKnowledgeApi(app: FastifyInstance) {
  app.get('/api/projects/:id/knowledge', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    return { ...knowledgeState(project.id), topics: TOPICS, limits: { title: TITLE_MAX, text: TEXT_MAX, lines: TEXT_LINES, paths: PATHS_MAX, budget: budgetOf(project.id) } };
  });

  /** The page was opened: what agents write after this is marked new on the next visit. No refetch needed. */
  app.post('/api/projects/:id/knowledge/viewed', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    return { before: markViewed(project.id) };
  });

  const write = async (projectId: string, body: Record<string, any>, id: string | undefined, reply: FastifyReply) => {
    const input = noteInput(body);
    if (!id && (!input.topic || !input.title || !input.text)) return bad(reply, 'Give a topic, a title and the text.');
    const res = writeNote(projectId, USER, { ...input, id }, { agent: false });
    if ('error' in res) return bad(reply, res.error);
    return { note: res.note };
  };

  app.post('/api/projects/:id/knowledge', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    return write(project.id, (req.body ?? {}) as Record<string, any>, undefined, reply);
  });

  app.patch('/api/knowledge/:id', async (req, reply) => {
    const note = get('SELECT id, project_id FROM knowledge_notes WHERE id = ?', (req.params as any).id);
    if (!note) return bad(reply, 'No such note', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    if (b.confirm === true && Object.keys(b).length === 1) {
      const res = confirmNotes(note.project_id, USER, [note.id]);
      return 'error' in res ? bad(reply, res.error) : { ok: true };
    }
    return write(note.project_id, b, note.id, reply);
  });

  app.delete('/api/knowledge/:id', async (req, reply) => {
    const note = get('SELECT id, project_id FROM knowledge_notes WHERE id = ?', (req.params as any).id);
    if (!note) return bad(reply, 'No such note', 404);
    const res = removeNotes(note.project_id, [note.id]);
    return 'error' in res ? bad(reply, res.error) : { ok: true };
  });

  /** "Ask the director to write the page": sent as the user's own message, so it shows in the conversation. Never automatic. */
  app.post('/api/projects/:id/knowledge/seed', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    await sendToAgent(rootAgent(project).id, seedMessage(project.id), { kind: 'user', name: 'You' });
    return { ok: true };
  });

  app.get('/api/projects/:id/settings', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    return { groups: settingsView(project.id, !!(req.query as { all?: string })?.all) };
  });

  /** { key: boolean | choice, ... }: all or nothing. Agents see the change at their next session (or next tool call). */
  app.patch('/api/projects/:id/settings', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const known = new Set(settingsView(project.id, true).flatMap((g) => g.settings.map((s) => s.key)));
    for (const k of Object.keys(b)) if (!known.has(k)) return bad(reply, `Unknown setting "${k}".`);
    // Checked first: a call that fails changes nothing (setSetting refuses a value of the wrong kind before writing).
    const wrong = Object.entries(b).map(([k, v]) => checkSetting(k, v)).find(Boolean);
    if (wrong) return bad(reply, wrong);
    for (const [k, v] of Object.entries(b)) setSetting(project.id, k, v as boolean | string);
    touchProject(project.id);
    return { groups: settingsView(project.id) };
  });
}
