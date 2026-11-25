import type { FastifyInstance } from 'fastify';
import { get, now } from './db.ts';
import { accountFor, accountsView, addAccount, projectAccounts, removeAccount, setProjectAccounts } from './accounts.ts';
import { touchProject } from './store.ts';

// Claude accounts (server/accounts.ts): Setup › Accounts. Behind the same sign-in as the rest of /api (the guard in api.ts).
export function registerAccountsApi(app: FastifyInstance) {
  app.get('/api/accounts', async () => ({ accounts: accountsView(), now: now() }));
  app.post('/api/accounts', async (req, reply) => {
    const err = addAccount((req.body as { name?: unknown } | null)?.name);
    return err ? reply.code(400).send({ error: err }) : { accounts: accountsView(), now: now() };
  });
  app.delete('/api/accounts/:name', async (req, reply) => {
    const err = removeAccount((req.params as { name: string }).name);
    return err ? reply.code(400).send({ error: err }) : { accounts: accountsView(), now: now() };
  });
  const project = (id: string) => ({ ...projectAccounts(id), current: accountFor(id) });
  app.get('/api/projects/:id/accounts', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!get('SELECT 1 AS x FROM projects WHERE id = ?', id)) return reply.code(404).send({ error: 'No such project.' });
    return project(id);
  });
  app.put('/api/projects/:id/accounts', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!get('SELECT 1 AS x FROM projects WHERE id = ?', id)) return reply.code(404).send({ error: 'No such project.' });
    const err = setProjectAccounts(id, (req.body ?? {}) as { primary?: unknown; fallbacks?: unknown });
    if (err) return reply.code(400).send({ error: err });
    touchProject(id);
    return project(id);
  });
}
