import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { registerApi } from './api.ts';
import { sweepAttachments } from './attachments.ts';
import { APP_ROOT, ARTIFACT_DIR, DATA_DIR, config } from './config.ts';
import { startHealthChecks, stopHealthChecks } from './hosts.ts';
import { setReportNotifier, startReportPolling, stopReportPolling } from './reports.ts';
import { recordPlannedRestart, resumeAfterUpdate } from './liveupdate.ts';
import { recoverOnBoot, sendToAgent, shutdownAll } from './runtime.ts';
import { createRequest, homeRequests, settleIdleHolders } from './requests.ts';
import { KEEP_AUTO_DAYS, pruneAutoDecisions } from './triage.ts';
import { foldSpecKinds, startSpecTimer, stopSpecTimer } from './spec.ts';
import { tellDirector } from './taskapi.ts';
import { migrateStructures } from './team.ts';
import { registerWeb } from './web.ts';
import { backfillSessions, setSessionNotifier, startSessionTimer, stopSessionTimer } from './sessions.ts';
import { backfillTaskTiming } from './tasks.ts';
import { registerNotifyApi } from './notifyapi.ts';
import { notify, startNotifications, stopNotifications } from './notify.ts';
import { noteDiskFull, survive, sweepTemporaries } from './safefs.ts';
import { setGuardHooks, startDiskGuard, stopDiskGuard } from './disk.ts';
import { biggestUsers } from './diskusage.ts';
import { get } from './db.ts';

const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

// A full disk must not take Helm down (server/safefs.ts): a write that fails for lack of space, in a timer or a
// request, is logged and shown as a banner instead of crashing the process. Any other uncaught error ends it as
// Node's default would.
process.on('uncaughtException', (err) => {
  if (noteDiskFull(err, 'background work')) return;
  console.error(err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  if (noteDiskFull(err, 'background work')) return;
  console.error(err);
  process.exit(1);
});

// Boot-time upkeep writes to the database; on a full disk it is skipped (and done at the next start) so the UI
// still comes up to say what is wrong.
const boot = (what: string, fn: () => void) => survive(what, fn, undefined);

// Temporary files of writes a crash cut short (server/safefs.ts names them .<name>.<pid>.<random>.tmp).
const swept = sweepTemporaries(DATA_DIR);
if (swept) console.log(`Removed ${swept} leftover temporary file(s) from interrupted writes.`);
boot('recovering agents', () => recoverOnBoot());
boot('boot upkeep', () => {
  // Every request has a task or discussion to live on (idempotent; after recoverOnBoot dismissed stale permissions).
  const homed = homeRequests();
  // Standing request holders with nothing pending are settled (idempotent; later changes settle them as they happen).
  const settledHolders = settleIdleHolders();
  if (settledHolders) console.log(`Requests: settled ${settledHolders} standing request holder(s) with nothing pending.`);
  if (homed.open || homed.handled || homed.moved) console.log(`Requests: gave a home to ${homed.open} open and ${homed.handled} answered or dismissed request(s) (${homed.discussions} new discussion(s)); ${homed.moved} moved off old task ids.`);
  sweepAttachments();
  const pruned = pruneAutoDecisions();
  if (pruned) console.log(`Permissions: dropped the record of ${pruned} automatic allow(s) older than ${KEEP_AUTO_DAYS} days.`);
  migrateStructures();
  // One kind of Spec entry: decisions and notes become history items or settled discussions (idempotent).
  const folded = foldSpecKinds();
  if (folded.history || folded.discussions || folded.entries) console.log(`Spec: ${folded.entries} goals/designs became entries; ${folded.history} decisions/notes moved into entry history, ${folded.discussions} into settled discussions.`);
  // Task timing and sessions from data kept before they existed (each idempotent).
  const timed = backfillTaskTiming();
  if (timed) console.log(`Tasks: derived timing for ${timed} task(s) from their state history.`);
  for (const b of backfillSessions()) console.log(`Sessions: found ${b.sessions} past session(s) in ${b.project}.`);
});
registerApi(app);
registerNotifyApi(app);

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
boot('starting host checks', () => startHealthChecks());
setReportNotifier(tellDirector);
boot('starting report polling', () => startReportPolling());
// Owner edits to the Spec become planning tasks after a quiet period; pending ones survive restarts in the database.
boot('starting the Spec timer', () => startSpecTimer(tellDirector));
// Sessions end after the owner's idle period; at boot, ones whose period passed while Helm was down are closed.
setSessionNotifier(tellDirector);
boot('starting the session timer', () => startSessionTimer());
// Phone notifications: stalled agents, update results, the away summary and the end of quiet hours (server/notify.ts).
boot('starting notifications', () => startNotifications());
// Disk guard: free space every minute; at warning a to-do for the user, at critical no new agents or builds and a note
// to the directors (server/disk.ts).
setGuardHooks({
  tellDirector,
  fileRequest: (projectId, title, body, steps, silent) =>
    createRequest({ projectId, agentId: null, kind: 'action', title, body, payload: { steps, after: '' }, importance: 4, blocking: false, silent }).id,
  requestOpen: (id) => get('SELECT status FROM inbox WHERE id = ?', id)?.status === 'open',
  notify: (title, body) => notify({ kind: 'disk', title, body, url: '#/helm', blocking: true }),
  biggest: biggestUsers,
});
startDiskGuard();

console.log(`Helm is running`);
console.log(`  open        http://${hostname()}.local:${config.port}  (or http://localhost:${config.port})`);
console.log(`  passphrase  ${config.token}`);
console.log(`  data        ${DATA_DIR}`);
console.log(`  projects    ${config.projectsRoot}`);
if (config.claudePath) console.log(`  claude      ${config.claudePath}`);

// After a planned update or rollback, resume the agents it interrupted once the update script reports this server healthy.
boot('resuming agents after an update', () => resumeAfterUpdate((id, text) => sendToAgent(id, text, { kind: 'system', name: 'Helm' })));

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  recordPlannedRestart();
  stopHealthChecks();
  await stopReportPolling();
  stopSpecTimer();
  stopSessionTimer();
  stopNotifications();
  stopDiskGuard();
  await shutdownAll();
  await app.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
