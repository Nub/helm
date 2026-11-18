import type { FastifyInstance, FastifyReply } from 'fastify';
import { all } from './db.ts';
import { importPersonal, personalItems, personalLeftBehind } from './personal.ts';
import { liveAgentIds, restartForProjects, rootAgent, sendToAgent } from './runtime.ts';
import { getProject } from './store.ts';
import {
  addItemMessage, declineItem, fetchForReview, getItem, installItem, itemView, projectsFor, publishToolbox, refreshFromSource, removeItem, repairItem, setProjectEnabled, setScope,
} from './toolbox.ts';
import type { InstallInput } from './toolbox.ts';

const bad = (reply: FastifyReply, message: string, code = 400) => reply.code(code).send({ error: message });

function installInput(b: any): InstallInput {
  return {
    scope: b?.scope === 'selected' ? 'selected' : 'all',
    projects: Array.isArray(b?.projects) ? b.projects.map(String) : [],
    secrets: b?.secrets && typeof b.secrets === 'object' ? Object.fromEntries(Object.entries(b.secrets).map(([k, v]) => [k, String(v)])) : {},
  };
}

export function registerToolboxApi(app: FastifyInstance) {
  app.get('/api/toolbox', async () => {
    const liveIds = liveAgentIds();
    return {
      items: all('SELECT * FROM toolbox_items ORDER BY updated_at DESC').map((r) => itemView(r, liveIds)),
      projects: all('SELECT id, name FROM projects WHERE archived = 0 ORDER BY position, created_at'),
    };
  });

  app.get('/api/toolbox/count', async () => ({ proposed: (all("SELECT COUNT(*) AS n FROM toolbox_items WHERE status IN ('proposed', 'failed')")[0]?.n as number) ?? 0 }));

  app.get('/api/toolbox/personal', async () => ({ items: personalItems(), left: personalLeftBehind() }));

  app.post('/api/toolbox/import', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const res = await importPersonal(String(b.path ?? ''), installInput(b));
    if ('error' in res) return bad(reply, res.error);
    publishToolbox();
    return res;
  });

  app.post('/api/toolbox/:id/install', async (req, reply) => {
    const id = (req.params as any).id;
    const err = installItem(id, installInput(req.body));
    if (err) return bad(reply, err);
    return { ok: true };
  });

  app.post('/api/toolbox/:id/decline', async (req, reply) => {
    const err = declineItem((req.params as any).id, String((req.body as any)?.note ?? ''));
    return err ? bad(reply, err) : { ok: true };
  });

  app.post('/api/toolbox/:id/remove', async (req, reply) => {
    const res = removeItem((req.params as any).id);
    if (typeof res === 'string') return bad(reply, res);
    restartForProjects(res);
    return { ok: true };
  });

  app.post('/api/toolbox/:id/refetch', async (req, reply) => {
    const item = getItem((req.params as any).id);
    if (!item) return bad(reply, 'No such item.', 404);
    if (item.status !== 'proposed' && item.status !== 'failed') return bad(reply, `It is ${item.status}.`);
    void fetchForReview(item.id);
    return { ok: true };
  });

  app.post('/api/toolbox/:id/repair', async (req, reply) => {
    const err = repairItem((req.params as any).id);
    return err ? bad(reply, err) : { ok: true };
  });

  /** Take the current personal copy of an imported item as its new pin. */
  app.post('/api/toolbox/:id/update-from-source', async (req, reply) => {
    const item = getItem((req.params as any).id);
    if (!item) return bad(reply, 'No such item.', 404);
    const err = await refreshFromSource(item.id);
    if (err) return bad(reply, err);
    restartForProjects(projectsFor(getItem(item.id)!));
    return { ok: true };
  });

  app.post('/api/toolbox/:id/scope', async (req, reply) => {
    const item = getItem((req.params as any).id);
    if (!item) return bad(reply, 'No such item.', 404);
    const before = projectsFor(item);
    setScope(item.id, (req.body as any)?.scope === 'selected' ? 'selected' : 'all');
    const after = projectsFor(getItem(item.id)!);
    restartForProjects(before.filter((p) => !after.includes(p)));
    return { ok: true };
  });

  app.post('/api/toolbox/:id/projects/:projectId', async (req, reply) => {
    const { id, projectId } = req.params as any;
    const item = getItem(id);
    if (!item) return bad(reply, 'No such item.', 404);
    if (!getProject(projectId)) return bad(reply, 'No such project.', 404);
    const enabled = !!(req.body as any)?.enabled;
    setProjectEnabled(id, projectId, enabled);
    if (!enabled) restartForProjects([projectId]);
    return { ok: true };
  });

  /** "Ask about it": a message to the proposing project's director, referencing the item. */
  app.post('/api/toolbox/:id/ask', async (req, reply) => {
    const item = getItem((req.params as any).id);
    if (!item) return bad(reply, 'No such item.', 404);
    const text = String((req.body as any)?.text ?? '').trim();
    if (!text) return bad(reply, 'Write the question.');
    const project = item.proposed_in_project ? getProject(item.proposed_in_project) : undefined;
    if (!project) return bad(reply, 'This item was not proposed by a project director, so there is no one to ask.');
    addItemMessage(item.id, 'user', 'You', text);
    const root = rootAgent(project);
    await sendToAgent(
      root.id,
      `<toolbox-question item="${item.id}" name="${item.name.replace(/"/g, "'")}">\n${text}\n\nAnswer with propose_tool: update_of="${item.id}" and message. If your proposal changes, pass the revised fields too.\n</toolbox-question>`,
      { kind: 'user', name: 'You' },
    );
    return { ok: true };
  });
}
