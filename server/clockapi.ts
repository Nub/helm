import type { FastifyInstance } from 'fastify';
import { declineZone, reportZone, setZone, zoneState } from './clock.ts';

// The user's time zone (server/clock.ts). Behind the same sign-in as the rest of /api (the guard in api.ts).
export function registerClockApi(app: FastifyInstance) {
  app.get('/api/timezone', async () => zoneState());
  // Every page load reports the browser's zone: the first sets it, a different one becomes a proposal.
  app.post('/api/timezone/report', async (req) => reportZone((req.body as { zone?: unknown } | null)?.zone));
  // Setup, or "Use this zone" on the proposal.
  app.put('/api/timezone', async (req, reply) => {
    const err = setZone((req.body as { zone?: unknown } | null)?.zone);
    return err ? reply.code(400).send({ error: err }) : zoneState();
  });
  // "Keep the current one" on the proposal.
  app.post('/api/timezone/decline', async (req) => {
    declineZone((req.body as { zone?: unknown } | null)?.zone);
    return zoneState();
  });
}
