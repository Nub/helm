import type { FastifyInstance, FastifyReply } from 'fastify';
import { get, run } from './db.ts';
import { getSettings, notePresence, saveSettings, testPayload } from './notify.ts';
import { listSubscriptions, saveSubscription, sendPush, subscriptionView, validEndpoint, vapidPublicKey } from './push.ts';
import type { SubscriptionInput } from './push.ts';

// Phone notifications: this device's subscription, the device list, settings and the page's presence reports.
// Behind the same sign-in as the rest of /api (the guard in api.ts).

const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ error });

function parseSub(raw: unknown): SubscriptionInput | null {
  const s = raw as SubscriptionInput;
  if (!s || typeof s.endpoint !== 'string' || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') return null;
  if (!validEndpoint(s.endpoint) || s.endpoint.length > 1000 || s.keys.p256dh.length > 200 || s.keys.auth.length > 100) return null;
  return { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } };
}

export function registerNotifyApi(app: FastifyInstance) {
  app.get('/api/push', async () => ({
    publicKey: vapidPublicKey(),
    devices: listSubscriptions().map(subscriptionView),
    settings: getSettings(),
  }));

  // Save this device's subscription. `refresh`: only bring an existing row up to date (the page does this on
  // every load), so a device removed from the list is not added back behind the user's back. `replaces`: the old
  // endpoint, from the service worker's pushsubscriptionchange.
  app.post('/api/push/subscriptions', async (req, reply) => {
    const b = (req.body ?? {}) as { subscription?: unknown; origin?: string; refresh?: boolean; replaces?: string };
    const sub = parseSub(b.subscription);
    if (!sub) return bad(reply, 'Not a valid push subscription');
    const known = get('SELECT id FROM push_subscriptions WHERE endpoint = ? OR endpoint = ?', sub.endpoint, b.replaces ?? '');
    if (b.refresh && !known) return { id: null };
    const origin = typeof b.origin === 'string' && /^https?:\/\/[^/]+$/.test(b.origin) ? b.origin : '';
    const row = saveSubscription(sub, origin, String(req.headers['user-agent'] ?? '').slice(0, 400), b.replaces);
    return { id: row.id, device: subscriptionView(row) };
  });

  app.patch('/api/push/subscriptions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as { label?: string; enabled?: boolean };
    if (!get('SELECT id FROM push_subscriptions WHERE id = ?', id)) return bad(reply, 'No such device', 404);
    if (typeof b.label === 'string' && b.label.trim()) run('UPDATE push_subscriptions SET label = ? WHERE id = ?', b.label.trim().slice(0, 60), id);
    if (typeof b.enabled === 'boolean') run('UPDATE push_subscriptions SET enabled = ? WHERE id = ?', b.enabled ? 1 : 0, id);
    return { ok: true };
  });

  app.delete('/api/push/subscriptions/:id', async (req) => {
    run('DELETE FROM push_subscriptions WHERE id = ?', (req.params as { id: string }).id);
    return { ok: true };
  });

  // A test notification to one device; waits for the push service's answer so Setup can show it.
  app.post('/api/push/subscriptions/:id/test', async (req, reply) => {
    const sub = get('SELECT * FROM push_subscriptions WHERE id = ?', (req.params as { id: string }).id);
    if (!sub) return bad(reply, 'No such device (it may have been removed after the push service said it was gone)', 404);
    const r = await sendPush(sub, testPayload(), { urgency: 'high', ttl: 600 }, [1000]);
    if (!r.ok) return bad(reply, r.gone ? 'The push service says this subscription is gone; it was removed. Enable notifications again on that device.' : r.error, 502);
    return { ok: true };
  });

  app.put('/api/push/settings', async (req, reply) => {
    const error = saveSettings(req.body);
    if (error) return bad(reply, error);
    return { settings: getSettings() };
  });

  // The page reports where it is and whether it is visible, so Helm does not notify about what the user is looking at.
  app.post('/api/presence', async (req) => {
    const b = (req.body ?? {}) as { client?: string; hash?: string; visible?: boolean };
    if (typeof b.client === 'string' && typeof b.hash === 'string') notePresence(b.client, b.hash, !!b.visible);
    return { ok: true };
  });
}
