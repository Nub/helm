import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { registerApi } from './api.ts';
import { APP_ROOT, ARTIFACT_DIR, config } from './config.ts';
import { registerNotifyApi } from './notifyapi.ts';
import { registerClockApi } from './clockapi.ts';
import { registerWeb } from './web.ts';
import { startDiskGuard, stopDiskGuard } from './disk.ts';
import { tellDirector } from './agents.ts';
import { setSessionNotifier } from './sessions.ts';

/**
 * The web service's half of Helm (server/runner.ts): the API, the live-update stream, the app and preview files.
 * `split`: the runner is another process. The web service then samples free space itself (the disk guard with no
 * hooks: it acts on nothing, the runner does), so the banner, /api/disk and its own refusals (live-update builds) see
 * the disk without waiting on the runner, which may be unable to write anything on a full disk.
 */
export async function startWeb(split: boolean): Promise<() => Promise<void>> {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  // Under test, the list of routes, for the check that drives every route in split mode (server/checks/split.check.ts).
  const routes: { method: string; url: string }[] = [];
  if (process.env.NODE_ENV === 'test') {
    app.addHook('onRoute', (r) => {
      for (const method of [r.method].flat()) if (method !== 'HEAD') routes.push({ method, url: r.url });
    });
    app.get('/api/test/routes', async () => routes);
  }
  registerApi(app);
  registerNotifyApi(app);
  registerClockApi(app);

  // Files agents posted as previews. HTML previews are agent-written, so they
  // are served sandboxed: they cannot read the Helm session or call its API.
  await app.register(fastifyStatic, {
    root: ARTIFACT_DIR,
    prefix: '/artifacts/',
    decorateReply: false,
    setHeaders(reply) {
      reply.header('content-security-policy', "sandbox allow-scripts; default-src 'self' 'unsafe-inline' data: blob:");
      reply.header('x-content-type-options', 'nosniff');
    },
  });

  const webRoot = join(APP_ROOT, 'web', 'dist');
  if (existsSync(webRoot)) {
    registerWeb(app, webRoot);
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Not found' }));
  } else {
    app.get('/', async () => 'Helm server is running, but the web app is not built. Run: npm run build');
  }

  await app.listen({ port: config.port, host: config.host });
  if (split) {
    startDiskGuard();
    // The API records the user's activity and stepping away; the notes to the director go through the facade (a
    // command for the runner).
    setSessionNotifier(tellDirector);
  }
  return async () => {
    if (split) stopDiskGuard();
    await app.close();
  };
}
