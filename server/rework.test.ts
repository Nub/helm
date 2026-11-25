import { SCRATCH } from './testenv.ts';
// Rework, repeats and unused speed (rework.ts) on a seeded transcript: a failed command rerun, a reverted commit, an
// edit rewritten, a review sent back, an error repeated across two tasks (known from an earlier knowledge note, and
// one that was not known), and commands waited on while independent work sat queued. `node --test server/rework.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const rw = await import('./rework.ts');
const tel = await import('./telemetry.ts');
const { addEvent } = await import('./store.ts');
const { buildSearchIndexNow } = await import('./searchindex.ts');

const USER = { author: 'user' as const, name: 'You' };
const MIN = 60_000;
db.freezeClock();

const id = db.newId('pr');
const s = structure.defaultStructure();
db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'rw', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
const director = runtime.rootAgent(project);
const builderRole = s.roles.find((r) => r.id === 'builder')!;
const b1 = runtime.createAgent(project, director, builderRole, 'Builder', 'Hold the queue.');
const b2 = runtime.createAgent(project, director, builderRole, 'Builder 2', 'Help.');
const agent = (x: string) => db.get('SELECT * FROM agents WHERE id = ?', x)!;
const task = (title: string, driver: string, state = 'active', description = `Do ${title} in server/${title.replace(/\W/g, '')}.ts.`) =>
  tasks.createTask(id, { title, state, origin: 'director', description, driver_agent_id: driver } as any, USER);

let n = 0;
/** A tool call and its result `ms` later. */
function call(a: string, name: string, input: Record<string, unknown>, ms: number, result: { error?: boolean; text?: string } = {}) {
  const cid = `tu${++n}`;
  addEvent(agent(a), 'tool', { id: cid, name, summary: String(input.command ?? input.file_path ?? ''), input: JSON.stringify(input, null, 2) });
  db.advanceClock(ms);
  addEvent(agent(a), 'tool_result', { id: cid, error: !!result.error, text: result.text ?? 'ok' });
}

const SHARP_1 = "Exit code 1\nnode:internal/modules: Error: Cannot find module '/tmp/wt-one/node_modules/sharp/lib/index.js'\n    at Module._resolveFilename";
const SHARP_2 = "Exit code 1\nnode:internal/modules: Error: Cannot find module '/home/x/wt-two/node_modules/sharp/lib/index.js'\n    at Module._resolveFilename";
const PORT = "Exit code 1\nError: listen EADDRINUSE: address already in use 127.0.0.1:4173";

test('a seeded transcript: rework counted, errors repeated across tasks, the known one marked known', () => {
  const t1 = task('Image thumbnails', b1.id);
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', t1.id, b1.id);
  const t2 = task('Preview cards', b2.id);
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', t2.id, b2.id);
  db.advanceClock(MIN);

  // Task 1: the tests fail for 3 minutes, then are rerun (another form of the same command) and pass.
  call(b1.id, 'Bash', { command: 'npm test', description: 'Run the tests' }, 3 * MIN, { error: true, text: SHARP_1 });
  call(b1.id, 'Bash', { command: 'cd /tmp/wt-one && npm test 2>&1 | tail -20' }, MIN);
  // A port clash, hit by both tasks before either finished: nothing to have known.
  call(b1.id, 'Bash', { command: 'node scripts/serve.mjs' }, 5000, { error: true, text: PORT });
  db.advanceClock(1000);
  call(b2.id, 'Bash', { command: 'node scripts/serve.mjs --port 4173' }, 5000, { error: true, text: PORT });
  // An edit, then its own lines rewritten.
  call(b1.id, 'Edit', { file_path: 'server/thumbs.ts', old_string: 'export const a = 1;', new_string: 'export function thumb(size: number) {\n  return size * 2;\n}' }, 1000);
  db.advanceClock(30_000);
  call(b1.id, 'Edit', { file_path: 'server/thumbs.ts', old_string: 'export function thumb(size: number) {\n  return size * 2;\n}', new_string: 'export function thumb(size: number) {\n  return Math.round(size * 2);\n}' }, 1000);
  // A commit reverted.
  call(b1.id, 'Bash', { command: 'git revert --no-edit 1a2b3c4d' }, 2000);
  // A review sent back after a minute, the next request 4 minutes later.
  db.run("INSERT INTO consults (id, project_id, asker_id, manager_id, task_id, kind, question, created_at, answered_at, verdict, status) VALUES ('rv1', ?, ?, ?, ?, 'review', 'Look', ?, ?, 'changes_needed', 'answered')", id, b1.id, director.id, t1.id, db.now(), db.now() + MIN);
  db.advanceClock(5 * MIN);
  db.run("INSERT INTO consults (id, project_id, asker_id, manager_id, task_id, kind, question, created_at, answered_at, verdict, status) VALUES ('rv2', ?, ?, ?, ?, 'review', 'Again', ?, ?, 'accepted', 'answered')", id, b1.id, director.id, t1.id, db.now(), db.now());
  db.advanceClock(MIN);
  tasks.setTaskState(tasks.getTask(t1.id)!, 'done', USER);

  // Learned from task 1: a knowledge note, before task 2 hits the same error.
  db.advanceClock(MIN);
  db.run(
    "INSERT INTO knowledge_notes (id, project_id, topic, title, body, paths, added_by, created_at, updated_by, updated_at) VALUES ('kn_sharp', ?, 'Pitfalls', 'Cannot find module sharp in a worktree', 'A new worktree has no node_modules: run npm ci in it before npm test, or the sharp module is missing.', '[]', 'Builder', ?, 'Builder', ?)",
    id, db.now(), db.now(),
  );
  db.run('UPDATE agents SET knowledge_seen = ? WHERE id = ?', JSON.stringify({ kn_sharp: [db.now(), 'Cannot find module sharp in a worktree'] }), b2.id);
  db.advanceClock(MIN);
  call(b2.id, 'Bash', { command: 'npm test' }, 2 * MIN, { error: true, text: SHARP_2 });
  db.advanceClock(MIN);
  tasks.setTaskState(tasks.getTask(t2.id)!, 'done', USER);

  const r1 = JSON.parse(db.get('SELECT data FROM task_rework WHERE task_id = ?', t1.id)!.data) as import('./rework.ts').TaskRework;
  assert.deepEqual(r1.kinds.rerun, { n: 1, ms: 3 * MIN }, 'the failed run rerun, its 3 minutes');
  assert.equal(r1.kinds.revert.n, 1, 'the reverted commit');
  assert.equal(r1.kinds.edit.n, 1, 'its own lines rewritten');
  assert.deepEqual(r1.kinds.review, { n: 1, ms: 4 * MIN });
  assert.ok(r1.work_ms && rw.shareOf(r1)! > 0 && rw.shareOf(r1)! <= 100, String(rw.shareOf(r1)));
  // Task 2's failure was not rerun: not rework.
  const r2 = rw.reworkRows(id, 0, db.now() + 1).find((r) => r.task_id === t2.id)!;
  assert.equal(r2.kinds.rerun.n, 0);

  buildSearchIndexNow();
  const rows = rw.reworkRows(id, 0, db.now() + 1);
  const repeats = rw.judgeRepeats(id, rw.repeatsOf(rows).groups);
  assert.equal(repeats.length, 2, JSON.stringify(repeats.map((r) => r.sig)));
  const sharp = repeats.find((r) => /cannot find module/.test(r.sig))!;
  assert.equal(sharp.sig, "node:internal/modules: error: cannot find module '<path>'");
  assert.deepEqual(sharp.tasks.map((t) => t.id).sort(), [t1.id, t2.id].sort());
  assert.equal(sharp.known, true, 'a knowledge note held the answer before the second hit');
  assert.deepEqual(sharp.by, { kind: 'knowledge', id: 'kn_sharp', title: 'Cannot find module sharp in a worktree' });
  assert.equal(sharp.given, 1, 'the agent was shown the note');
  assert.equal(sharp.top2, 1, 'search on the error puts the note in the top 2');
  const port = repeats.find((r) => /eaddrinuse/.test(r.sig))!;
  assert.equal(port.known, false, 'both hits came before anything held the answer');
  assert.equal(port.agents, 2);
  assert.equal(port.self, false);

  // The page's view and the director's tool text.
  const view = rw.reworkView(id, tel.periodsOf('day'))[0];
  assert.ok(view.share != null && view.share > 0);
  assert.ok(view.kinds.some((k) => k.kind === 'revert' && k.n === 1));
  assert.equal(view.repeats.length, 2);
  assert.match(rw.reworkText(id, tel.periodsOf('week')), /known \(knowledge "Cannot find module sharp in a worktree"\), given 1\/1, search top 2 1\/1/);
});

test('error signatures: paths, ids and numbers taken out; the user saying no is not a pitfall', () => {
  assert.equal(rw.errorSignature('Exit code 2\nls: cannot access /a/b/c: No such file'), 'ls: cannot access <path>: no such file');
  assert.equal(rw.errorSignature('Not sent: your review request is 812 characters; the budget is 600.'), 'not sent: your review request is # characters; the budget is #.');
  assert.equal(rw.errorSignature("The user doesn't want to proceed with this tool use."), null);
  assert.equal(rw.errorSignature('Exit code 144'), null);
  assert.ok(rw.selfExplaining('Not sent: your question is 905 characters') && !rw.selfExplaining('Error: listen EADDRINUSE'));
  assert.equal(rw.commandKey('cd /x && FOO=1 npm test 2>&1 | tail -5'), 'npm test');
});

test('unused speed: a command waited on while independent work sat queued', () => {
  db.run("INSERT OR REPLACE INTO project_settings (project_id, key, value, updated_at) VALUES (?, 'work_mode', 'builder', ?)", id, db.now());
  const from = db.now();
  const t = task('Render pass', b1.id, 'active', 'Work in renderer/pass.rs.');
  const q = task('Docs page', b2.id, 'scheduled', 'Write docs/page.md.');
  db.run("INSERT INTO running_commands (id, project_id, agent_id, session_agent_id, task_id, command, started_at, ended_at) VALUES ('rc1', ?, ?, ?, ?, 'cargo build', ?, ?)", id, b1.id, b1.id, t.id, db.now(), db.now() + 5 * MIN);
  db.advanceClock(5 * MIN);
  db.run("INSERT INTO heavy_jobs (id, project_id, agent_id, task_id, host_id, asked_at, started_at, ended_at, free_ms) VALUES ('hj1', ?, ?, ?, 'h1', ?, ?, ?, ?)", id, b1.id, t.id, from, from + MIN, from + 2 * MIN, 30_000);
  const sp = rw.unusedSpeed(id, from, db.now());
  assert.equal(sp.idle_ms, 5 * MIN - 20_000);
  assert.equal(sp.idle_with_work_ms, 5 * MIN - 20_000, 'the docs task was queued and independent the whole time');
  assert.equal(sp.queued_ms, 5 * MIN);
  assert.equal(sp.host_free_ms, 30_000);
  assert.equal(sp.heavy_queued, 1);
  void q;
});
