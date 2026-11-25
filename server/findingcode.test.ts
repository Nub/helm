import { SCRATCH } from './testenv.ts';
// Time finding code (findingcode.ts, findingstats.ts): what counts as finding, the time and output shares, per task,
// the stored weekly figures, and the watch's note naming the worst tasks. `node --test server/findingcode.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const fc = await import('./findingcode.ts');
const stats = await import('./findingstats.ts');
const w = await import('./watches.ts');
const { addEvent } = await import('./store.ts');

const MIN = 60_000;
const USER = { author: 'user' as const, name: 'You' };
db.freezeClock();

test('shell commands: only searches and reads count, with an optional cd and pipes', () => {
  for (const yes of ['rg -n foo server', 'cd /x && grep -rn bar . | head -20', 'git log --oneline -5', 'sed -n 1,80p a.ts', 'find . -name "*.ts" 2>/dev/null | wc -l', 'cat a.ts'])
    assert.equal(fc.searchOnly(yes), true, yes);
  for (const no of ['npm test', 'rg foo && npm run build', 'sed -i s/a/b/ x', 'cat a > b', 'node x.mjs', ''])
    assert.equal(fc.searchOnly(no), false, no);
});

test('the share of active time and of tool output, overall and per task; reads of files then edited are not finding', () => {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'fc', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const eng = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'x');
  const t = tasks.createTask(id, { title: 'Port it', state: 'active', origin: 'director', description: '', driver_agent_id: eng.id } as any, USER);
  const a = () => db.get('SELECT * FROM agents WHERE id = ?', eng.id)!;
  const t0 = db.now();
  const call = (n: string, name: string, input: Record<string, unknown>, summary: string, took: number, out: string) => {
    addEvent(a(), 'tool', { id: n, name, summary, input: JSON.stringify(input) });
    db.advanceClock(took);
    addEvent(a(), 'tool_result', { id: n, text: out });
  };
  addEvent(a(), 'inbound', { text: 'Your next task' });
  db.advanceClock(MIN);
  call('1', 'Bash', { command: 'rg -n exporter src' }, 'rg -n exporter src', MIN, 'x'.repeat(300)); // finding: 2 min (from the inbound)
  call('2', 'Read', { file_path: '/p/src/a.ts' }, '/p/src/a.ts', MIN, 'y'.repeat(300)); // read, then edited: not finding
  call('3', 'Read', { file_path: '/p/src/b.ts' }, '/p/src/b.ts', MIN, 'z'.repeat(300)); // read, never edited: finding 1 min
  call('4', 'Edit', { file_path: '/p/src/a.ts' }, '/p/src/a.ts', MIN, 'ok');
  call('5', 'Bash', { command: 'npm test' }, 'npm test', 2 * MIN, 'w'.repeat(98));
  call('6', 'Agent', { subagent_type: 'Explore', prompt: 'where is x' }, 'where is x', MIN, 'v'.repeat(100)); // finding 1 min
  const r = fc.findingCode(db.all, id, t0, db.now() + 1);
  assert.equal(r.all.findMs, 4 * MIN);
  assert.equal(r.all.activeMs, 8 * MIN);
  assert.equal(r.all.timeShare, 50);
  // Results of finding calls: 300 + 300 + 100 = 700 characters = 175 tokens; the project used 1750 tokens in the period.
  db.run("INSERT INTO token_usage (project_id, agent_id, task_id, tokens, at, who) VALUES (?, ?, ?, 1000, ?, 'builder')", id, eng.id, t.id, t0 + MIN);
  db.run("INSERT INTO token_usage (project_id, agent_id, task_id, tokens, at, who) VALUES (?, ?, NULL, 750, ?, 'director')", id, director.id, t0 + 2 * MIN);
  db.run("INSERT INTO token_usage (project_id, agent_id, task_id, tokens, at, who) VALUES (?, ?, NULL, 9999, ?, 'director')", id, director.id, t0 - 30 * 24 * 60 * MIN); // another period: not counted
  const r2 = fc.findingCode(db.all, id, t0, db.now() + 1);
  assert.equal(r2.all.resultTokens, 175);
  assert.equal(r2.all.tokenShare, 10, '175 of 1750 tokens');
  assert.equal(r2.tasks[0].tokenShare, null, 'a task row has no token total of its own');
  assert.equal(r.all.tokenShare, null, 'no tokens recorded in the period: nothing second is shown');
  assert.equal(r.all.findCalls, 3);
  assert.equal(r.tasks[0].task_id, t.id);
  assert.match(fc.worstTasksText(db.all, id, t0, db.now() + 1), new RegExp(`\\[\\[${t.id}\\]\\]: 4 min finding code, 50% of its active time \\(3 of 6 calls\\)`));
  // Stored by the runner; the Helm page reads it; the watch reads the stored week.
  stats.refreshFindingStat(id);
  const st = stats.findingStats().find((x) => x.project_id === id)!;
  assert.equal(st.thisWeek.timeShare, 50);
  assert.equal(st.lastWeek.timeShare, null);
  assert.equal(stats.findingShareNow(id), 50);
});

test('a trip of the finding-code watch tells the director the worst tasks', async () => {
  const id = (db.get("SELECT id FROM projects WHERE name = 'fc'")!).id as string;
  const told: string[] = [];
  w.setWatchHooks({ tell: (_p, text) => void told.push(text), ask: () => {} });
  const res = w.setWatch(id, { name: 'Time finding code', measure: { kind: 'builtin', builtin: 'finding_code', days: 7 }, op: 'above', value: 15 }, 'Helm') as any;
  assert.equal(await w.evaluate(res.watch), 'tripped');
  assert.match(told[0], /tripped: 50%, above 15%/);
  assert.match(told[0], /The tasks that spent most time finding code:\n- \[\[task_[0-9a-f]+\]\]: 4 min/);
  assert.match(told[0], /trial it on a copy of the project and compare this number before and after/);
});
