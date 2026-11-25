import { SCRATCH } from './testenv.ts';
// Per-task telemetry (tasktime.ts): a scripted transcript with known model, tool and command times reproduces them per
// kind, the parts add up to the task's work time, re-runs and failures are counted, and the director's text.
// `node --test server/tasktime.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const tt = await import('./tasktime.ts');
const { addEvent } = await import('./store.ts');

const SEC = 1000;
const MIN = 60 * SEC;
const USER = { author: 'user' as const, name: 'You' };
db.freezeClock();

test('a scripted task: the model, each tool and each command get their known time; the parts add up to the work time', () => {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'tt', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const b = runtime.createAgent(project, runtime.rootAgent(project), s.roles.find((r) => r.id === 'builder')!, 'Builder', 'x');
  const t = tasks.createTask(id, { title: 'Port the renderer', state: 'scheduled', origin: 'user' }, USER);
  db.run('UPDATE tasks SET driver_agent_id = ? WHERE id = ?', b.id, t.id);
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', t.id, b.id);
  const a = () => db.get('SELECT * FROM agents WHERE id = ?', b.id)!;
  tasks.setTaskState(tasks.getTask(t.id)!, 'active', USER);
  db.advanceClock(MIN); // active, before the first message: not in the transcript ("other")
  let n = 0;
  const think = (ms: number) => {
    db.advanceClock(ms);
    addEvent(a(), 'text', { text: 'thinking' });
  };
  const call = (name: string, input: Record<string, unknown>, ms: number, error = false) => {
    const cid = `c${++n}`;
    addEvent(a(), 'tool', { id: cid, name, summary: String(input.command ?? input.file_path ?? ''), input: JSON.stringify(input) });
    db.advanceClock(ms);
    addEvent(a(), 'tool_result', { id: cid, error, text: error ? 'error: build failed' : 'ok' });
  };
  addEvent(a(), 'inbound', { text: 'Your next task' });
  think(40 * SEC);
  call('Read', { file_path: '/p/src/render.rs' }, 5 * SEC);
  think(20 * SEC);
  call('Bash', { command: 'cargo build --release -p game', description: 'Compile the game, release' }, 3 * MIN, true); // 60 s work + 2 min waiting, failed
  think(30 * SEC);
  call('Edit', { file_path: '/p/src/render.rs', old_string: 'a', new_string: 'b' }, 10 * SEC);
  call('Bash', { command: 'cargo build --release -p game', description: 'Compile the game, release' }, 2 * MIN); // again
  call('Bash', { command: 'cargo test --test scenes', description: 'Run the scene tests' }, 90 * SEC);
  call('mcp__helm__report_status', {}, 2 * SEC);
  think(3 * MIN); // a slow stretch of the model
  addEvent(a(), 'result', { ok: true, text: 'done' });
  tasks.setTaskState(tasks.getTask(t.id)!, 'done', USER);

  const x = tt.taskTime(t.id)!;
  const item = (key: string) => x.items.find((i) => i.key === key)!;
  const within = (got: number, want: number, what: string) => assert.ok(Math.abs(got - want) <= want * 0.02, `${what}: ${got} ms, want ${want}`);
  within(item('model').ms, 40 * SEC + 20 * SEC + 30 * SEC + 3 * MIN, 'model');
  within(item('reading').ms, 5 * SEC, 'reading');
  within(item('editing').ms, 10 * SEC, 'editing');
  const build = item('cmd:cargo build --release');
  within(build.ms, 5 * MIN, 'compiling');
  within(build.idle_ms, 3 * MIN, 'idle on the builds');
  assert.equal(build.kind, 'compile');
  assert.equal(build.runs.length, 2);
  assert.equal(build.failed, 1);
  const tests = item('cmd:cargo test --test scenes');
  within(tests.ms, 90 * SEC, 'tests');
  assert.equal(tests.kind, 'test');
  within(item('helm:report_status').ms, 2 * SEC, 'Helm');
  within(item('other').ms, MIN, 'before the first message');
  // The parts add up to the work time.
  assert.equal(x.work_ms, x.items.filter((i) => !i.alongside).reduce((s2, i) => s2 + i.ms, 0));
  assert.equal(x.model.slow_turns, 1);
  // Biggest first; the header and the sentence.
  assert.equal(x.items[0].key, 'cmd:cargo build --release');
  assert.match(tt.headline(x), /^12 min · mostly build in release mode$/);
  assert.match(tt.topSentence(x), /^Build in release mode: 5 min over 2 runs \(1 failed\); Waiting for the model \(thinking and writing\): 5 min/);
  assert.match(tt.taskTimeText(x), /Work time 12 min/);
  // Kept for the finished task, and summed across tasks.
  assert.ok(db.get('SELECT 1 AS x FROM task_time WHERE task_id = ?', t.id));
  assert.equal(tt.slowestItems(id, 0, db.now() + 1)[0].key, 'cmd:cargo build --release');
  assert.match(tt.biggestOf(t.id)!, /^Build in release mode \(5 min\)$/);
});
