import { hostname } from 'node:os';
import { DATA_DIR, config } from './config.ts';
import { noteDiskFull } from './safefs.ts';

/**
 * helm [all|runner|web] (or HELM_ROLE). `all`, the default, is one process that runs agents and serves the dashboard.
 * `runner` and `web` are the two halves run as separate services, so an update that changes only the dashboard does
 * not interrupt agents (server/runner.ts). The web half never loads the agent runtime, and the runner never loads the API.
 */
const role = process.argv[2] ?? process.env.HELM_ROLE ?? 'all';
if (!['all', 'runner', 'web'].includes(role)) {
  console.error(`helm: unknown mode "${role}"; use all, runner or web`);
  process.exit(2);
}

// A full disk must not take Helm down (server/safefs.ts): a write that fails for lack of space, in a timer or a
// request, is logged and shown as a banner instead of crashing the process. Any other uncaught error ends it as
// Node's default would. In either half: the runner keeps its agents, the web service keeps serving.
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

let stopRunner: (() => Promise<void>) | null = null;
let stopWeb: (() => Promise<void>) | null = null;
let stopLink: (() => void) | null = null;

if (role !== 'web') {
  // One runner per data directory (runner and all modes): a second would drive the same agents.
  const { takeRunnerLock } = await import('./runnerlock.ts');
  const locked = takeRunnerLock();
  if (locked) {
    console.error(`helm: ${locked}`);
    process.exit(3);
  }
  const r = await import('./runner-main.ts');
  r.bootRunner();
}
if (role === 'web') {
  const { startWebLink } = await import('./runner.ts');
  stopLink = startWebLink();
}
if (role !== 'runner') {
  const w = await import('./web-main.ts');
  stopWeb = await w.startWeb(role === 'web');
}
if (role !== 'web') {
  const r = await import('./runner-main.ts');
  stopRunner = r.startRunner(role === 'runner');
}

console.log(`Helm is running${role === 'all' ? '' : ` (${role})`}`);
if (role !== 'runner') {
  console.log(`  open        http://${hostname()}.local:${config.port}  (or http://localhost:${config.port})`);
  console.log(`  passphrase  ${config.token}`);
}
console.log(`  data        ${DATA_DIR}`);
console.log(`  projects    ${config.projectsRoot}`);
if (config.claudePath && role !== 'web') console.log(`  claude      ${config.claudePath}`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  stopLink?.();
  await stopRunner?.();
  await stopWeb?.();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
