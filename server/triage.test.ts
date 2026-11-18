import { SCRATCH } from './testenv.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

/** What happens to a permission request at each autonomy level, against a scratch database. No Claude process starts. */


const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const triage = await import('./triage.ts');
const { homeRequests } = await import('./requests.ts');

const projectPath = mkdtempSync(join(SCRATCH, 'proj-'));
function makeProject(autonomy: string) {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, `p-${autonomy}`, projectPath, 'Build', autonomy, JSON.stringify(defaultStructure()), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const structure = defaultStructure();
  const worker = runtime.createAgent(project, director, structure.roles.find((r) => r.id !== structure.root)!, 'Engineer', 'Build it.');
  return { project, worker };
}
const opts = () => ({ signal: new AbortController().signal, suggestions: [], toolUseID: db.newId('tu') }) as any;
const last = (agentId: string) => db.get("SELECT * FROM inbox WHERE agent_id = ? ORDER BY rowid DESC LIMIT 1", agentId) as Record<string, any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const heredoc = "cd /tmp/shots && cat > drag.mjs <<'EOF'\nimport puppeteer from 'puppeteer-core';\nawait fetch('http://127.0.0.1:9013/');\nEOF\nnode drag.mjs";

test('Unrestricted, not flagged: allowed at once and recorded', async () => {
  const { project, worker } = makeProject('full');
  const r = await runtime.askPermission(worker, project, 'Bash', { command: heredoc }, opts());
  assert.equal(r?.behavior, 'allow');
  const row = last(worker.id);
  assert.deepEqual([row.status, row.answer, row.decided_by, row.decision_reason], ['answered', 'Allow', 'auto', triage.AUTO_REASON]);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM inbox WHERE status = 'open' AND agent_id = ?", worker.id)!.n, 0, 'nothing for the user');
  assert.equal(triage.decisionsFor(project.id)[0].id, row.id);
  // No task: no home, and the startup migration leaves it so (no discussion made for it).
  assert.equal(row.task_id, null);
  const before = db.get('SELECT COUNT(*) AS n FROM tasks')!.n;
  homeRequests();
  assert.equal(db.get('SELECT COUNT(*) AS n FROM tasks')!.n, before);
});

test('Unrestricted, flagged: goes to the user with the reason', async () => {
  const { project, worker } = makeProject('full');
  const p = runtime.askPermission(worker, project, 'Bash', { command: 'rm -rf ~/Documents' }, opts());
  await sleep(30);
  const row = last(worker.id);
  assert.equal(row.status, 'open');
  assert.match(JSON.parse(row.payload).danger, /^Deletes outside the project: /);
  assert.equal(await runtime.answerInbox(row.id, { choice: 'Deny' }), null);
  assert.equal(((await p) as any).behavior, 'deny');
  assert.equal(last(worker.id).decided_by, 'user');
});

test('Other levels unchanged: every request asks the user, the flagged ones with the reason', async () => {
  for (const level of ['supervised', 'edits', 'auto']) {
    const { project, worker } = makeProject(level);
    const p = runtime.askPermission(worker, project, 'Bash', { command: heredoc }, opts());
    await sleep(20);
    const row = last(worker.id);
    assert.equal(row.status, 'open', level);
    assert.equal(JSON.parse(row.payload).danger, undefined);
    await runtime.answerInbox(row.id, { choice: 'Allow' });
    assert.equal(((await p) as any).behavior, 'allow');
  }
});

test('automatic allows older than 30 days are pruned at startup', async () => {
  const { project, worker } = makeProject('full');
  await runtime.askPermission(worker, project, 'Bash', { command: heredoc }, opts());
  const row = last(worker.id);
  db.run('UPDATE inbox SET created_at = ? WHERE id = ?', db.now() - 31 * 86_400_000, row.id);
  assert.ok(triage.pruneAutoDecisions() >= 1);
  assert.equal(db.get('SELECT 1 AS x FROM inbox WHERE id = ?', row.id), undefined);
});
