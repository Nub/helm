import { SCRATCH } from './testenv.ts';
// Tiers (tiers.ts, workrules.ts, runtime.ts tierFor): the tier table, what a session runs at, the rules for Active
// tasks, review rounds and escalation, usage by tier.
// `node --test server/areas.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const tiers = await import('./tiers.ts');
const rules = await import('./workrules.ts');
const { recordTurnUsage, tokensByTier } = await import('./usage.ts');
const { recordOwnerActivity } = await import('./sessions.ts');
const { helmTools, toolAccess } = await import('./tools.ts');
const consults = await import('./consults.ts');

const USER = { author: 'user' as const, name: 'You' };
const spawned: string[] = [];
const rt = {
  spawn: async (parent: any, role: string, name: string, task: string, setup?: (a: any) => void) => {
    const project = db.get('SELECT * FROM projects WHERE id = ?', parent.project_id)!;
    const s = JSON.parse(project.structure);
    const a = runtime.createAgent(project, parent, s.roles.find((r: any) => r.id === role), name, task);
    setup?.(a);
    db.run("UPDATE agents SET status = 'working' WHERE id = ?", a.id);
    spawned.push(name);
    return db.get('SELECT * FROM agents WHERE id = ?', a.id);
  },
  send: async () => {}, close: async () => {}, markComplete: () => {},
};

function setup() {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'ar', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  db.run("INSERT INTO project_settings (project_id, key, value, updated_at) VALUES (?, 'spec_adherence', 'none', ?)", id, db.now()); // tests of other rules: no Spec links needed (specadherence.ts)
  // Builder mode is the only mode: areas are spawned for parallel work, with the task's parallel_reason.
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  // The user is here (a session): the director may start work.
  recordOwnerActivity(id);
  const tools = helmTools(director.id, rt as any, toolAccess(s, director.role_id, null));
  const call = async (name: string, input: Record<string, unknown>) => {
    const res: any = await tools.find((x: any) => x.name === name)!.handler(input, {});
    return { text: res.content[0].text as string, error: !!res.isError };
  };
  spawned.length = 0;
  return { project, director, call };
}
const task = (id: string) => tasks.getTask(id)!;
const created = (projectId: string, title: string) => db.get('SELECT * FROM tasks WHERE project_id = ? AND title = ?', projectId, title)!;

test('the tier table: defaults (Skilled is Opus at its default effort), the user edits a row, one up', () => {
  const t = tiers.getTiers();
  assert.deepEqual(t.map((x) => [x.id, x.model, x.effort]), [['light', 'claude-haiku-5-5', 'low'], ['routine', 'claude-sonnet-5-5', 'medium'], ['skilled', 'claude-opus-5-5', ''], ['deep', 'claude-fable-5-2', '']]);
  const models = structure.MODELS.map((m) => m.id);
  assert.match(tiers.setTier('routine', 'gpt', 'low', models, structure.EFFORTS)!, /Unknown model/);
  assert.match(tiers.setTier('huge', 'claude-opus-5-5', '', models, structure.EFFORTS)!, /No tier/);
  assert.equal(tiers.setTier('routine', 'claude-sonnet-5-5', 'high', models, structure.EFFORTS), null);
  assert.equal(tiers.tierOf('routine').effort, 'high');
  tiers.setTier('routine', 'claude-sonnet-5-5', 'medium', models, structure.EFFORTS);
  assert.equal(tiers.tierUp('routine'), 'skilled');
  assert.equal(tiers.tierUp('deep'), 'deep');
});

test('a session runs at its task\'s tier; the director at the strongest, a helper at the lightest', () => {
  const { project, director } = setup();
  const s = JSON.parse(project.structure);
  const a = runtime.createAgent(project, director, s.roles.find((r: any) => r.id === 'builder'), 'Engineer', 'x');
  assert.equal(runtime.tierFor(db.get('SELECT * FROM agents WHERE id = ?', a.id)!).model, 'claude-opus-5-5', 'no task: the area default');
  const t = tasks.createTask(project.id, { title: 'Rename', state: 'active', origin: 'user' }, USER);
  db.run("UPDATE tasks SET tier = 'routine' WHERE id = ?", t.id);
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', t.id, a.id);
  assert.equal(runtime.tierFor(db.get('SELECT * FROM agents WHERE id = ?', a.id)!).model, 'claude-sonnet-5-5');
  db.run("UPDATE tasks SET tier = 'skilled' WHERE id = ?", t.id);
  const at = runtime.tierFor(db.get('SELECT * FROM agents WHERE id = ?', a.id)!);
  assert.deepEqual([at.model, at.effort], ['claude-opus-5-5', '']);
  assert.equal(runtime.tierFor(director).id, 'deep');
});

test('going Active: a check first; Skilled by default ("default: hard to judge"); another tier needs its reason', async () => {
  const { project, call } = setup();
  const none = await call('create_task', { title: 'No check', description: 'x', state: 'active' });
  assert.ok(none.error && /has no check yet/.test(none.text), none.text);
  const ok = await call('create_task', { title: 'With check', description: 'x', state: 'active', check: 'npm test' });
  assert.ok(!ok.error, ok.text);
  const t = created(project.id, 'With check');
  assert.deepEqual([t.tier, t.tier_reason, t.check_how], ['skilled', tiers.DEFAULT_REASON, 'npm test']);
  const light = await call('create_task', { title: 'Light one', description: 'x', state: 'active', check: 'npm test', tier: 'light' });
  assert.ok(light.error && /needs tier_reason/.test(light.text));
  // Through update_task too.
  const w = await call('create_task', { title: 'Later', description: 'x', state: 'waiting', tier: 'routine', tier_reason: 'Rename across files, named test.' });
  assert.ok(!w.error, w.text);
  const later = created(project.id, 'Later');
  assert.ok((await call('update_task', { task: later.id, state: 'active' })).error, 'no check');
  const up = await call('update_task', { task: later.id, state: 'active', check: 'npm test', parallel_reason: 'Different files.' });
  assert.ok(!up.error, up.text);
  assert.deepEqual([task(later.id).tier, task(later.id).state], ['routine', 'active']);
});

test('the user\'s own Start is never refused: no check, beside other work; Skilled, "started by the user"', async () => {
  const { project, director } = setup();
  const s = JSON.parse(project.structure);
  const eng = runtime.createAgent(project, director, s.roles.find((r: any) => r.id === 'builder'), 'Engineer', 'x');
  tasks.createTask(project.id, { title: 'Running', state: 'active', origin: 'user', driver_agent_id: eng.id }, USER);
  const w = tasks.createTask(project.id, { title: 'Mine', state: 'waiting', origin: 'user', driver_agent_id: eng.id }, USER);
  const { taskAction } = await import('./taskactions.ts');
  const res = await taskAction(task(w.id), 'start');
  assert.ok(!res.error, String(res.error));
  assert.deepEqual([task(w.id).state, task(w.id).tier, task(w.id).tier_reason], ['active', 'skilled', 'started by the user']);
});

test('two review rounds at most: each changes_needed moves the task up a tier, never past Skilled; a third is refused until narrowed', async () => {
  const { project, director, call } = setup();
  const s = JSON.parse(project.structure);
  await call('create_task', { title: 'Fix it', description: 'x', state: 'active', check: 'npm test', tier: 'routine', tier_reason: 'Small and named.' });
  const t = created(project.id, 'Fix it');
  const eng = runtime.createAgent(project, director, s.roles.find((r: any) => r.id === 'builder'), 'Engineer', 'x');
  db.run('UPDATE agents SET task_id = ? WHERE id = ?', t.id, eng.id);
  const review = () => {
    const asker = db.get('SELECT * FROM agents WHERE id = ?', eng.id)!;
    return consults.fileConsult(asker, director, t.id, { kind: 'review', r: { summary: 'Look', where: 'branch', verified: 'tests' } as any }).consult.id as string;
  };
  for (const want of ['skilled', 'skilled']) {
    const id = review();
    const res = await call('message_agent', { agent: eng.id, message: 'Fix the edge case.', reply_to: id, verdict: 'changes_needed' });
    assert.ok(!res.error, res.text);
    assert.equal(task(t.id).tier, want);
  }
  const third = await call('message_agent', { agent: eng.id, message: 'Again.', reply_to: review(), verdict: 'changes_needed' });
  assert.ok(third.error && /Two review rounds at most/.test(third.text), third.text);
  assert.ok(db.all("SELECT body FROM task_messages WHERE task_id = ? AND body LIKE 'Moved up from Routine to Skilled%'", t.id).length);
  assert.ok(db.all("SELECT body FROM task_messages WHERE task_id = ? AND body LIKE 'Stays at Skilled%never moves work to Deep%'", t.id).length);
  // Narrowed: rounds count afresh.
  await call('update_task', { task: t.id, description: 'Only the edge case now.' });
  const after = await call('message_agent', { agent: eng.id, message: 'One more.', reply_to: review(), verdict: 'changes_needed' });
  assert.ok(!after.error, after.text);
});

test('a progress-check flag moves the task up; usage is recorded by tier; the director is told the tiers and rules', async () => {
  const { project, director } = setup();
  const t = tasks.createTask(project.id, { title: 'Slow', state: 'active', origin: 'user' }, USER);
  db.run("UPDATE tasks SET tier = 'routine' WHERE id = ?", t.id);
  assert.equal(rules.escalate(t.id, 'after a progress check'), true);
  assert.equal(task(t.id).tier, 'skilled');
  recordTurnUsage({ ...director, usage_seen: 0 }, { m: { inputTokens: 700 } } as any, 'deep');
  assert.ok((tokensByTier(project.id).deep ?? 0) >= 700);
  const s = JSON.parse(project.structure);
  // The director runs at Deep: Fable at the model's default effort, whatever effort its role had.
  assert.deepEqual([runtime.tierFor(director).model, runtime.tierFor(director).effort], ['claude-fable-5-2', '']);
  const prompt = structure.buildSystemPrompt(project, s, s.roles[0], director, undefined);
  assert.match(prompt, /# Tiers and the rules Helm enforces/);
  assert.match(prompt, /Skilled \(Opus 5\.5\)/);
  assert.match(prompt, /Reviewing a task marked for review is your own job/);
  assert.match(prompt, /# Builders\nYou plan, brief and ask; you do not start agents/);
  assert.doesNotMatch(prompt, /spawn_agent/);
});

test('an agent\'s running tier, model and effort follow its current task\'s tier; the director is Deep, a helper Light, a subagent its tier', async () => {
  const { runningTier } = await import('./store.ts');
  const proj = db.get('SELECT * FROM projects LIMIT 1')!;
  const s = JSON.parse(proj.structure);
  const base = { project_id: proj.id, parent_id: 'x', role_id: s.roles.find((r: any) => r.id !== s.root).id, model: 'claude-opus-5-5', quick: 0, task_id: null };
  assert.equal(runningTier({ ...base, parent_id: null, role_id: s.root }).run_tier, 'deep');
  assert.equal(runningTier({ ...base, quick: 1 }).run_tier, 'light');
  const t = db.newId('task');
  db.run("INSERT INTO tasks (id, project_id, title, state, kind, tier, created_at, updated_at) VALUES (?, ?, 'T', 'active', 'task', 'routine', ?, ?)", t, proj.id, db.now(), db.now());
  const r = runningTier({ ...base, task_id: t });
  assert.deepEqual([r.run_tier, r.run_tier_name, r.run_model, r.run_effort], ['routine', 'Routine', 'claude-sonnet-5-5', 'medium']);
  db.run("UPDATE tasks SET tier = 'skilled' WHERE id = ?", t);
  assert.equal(runningTier({ ...base, task_id: t }).run_model, 'claude-opus-5-5', 'follows the tier when it changes');
  assert.equal(runningTier({ ...base, role_id: 'subagent', sub_tier: 'light' }).run_tier_name, 'Light');
});

test('Fable is the director\'s: no escalation reaches Deep, Deep needs a listed reason', async () => {
  const { project, director, call } = setup();
  // Escalation from Skilled never yields Deep (reviews and progress flags both go through escalate).
  const t = tasks.createTask(project.id, { title: 'Hard bug', state: 'active', origin: 'user' }, USER);
  db.run("UPDATE tasks SET tier = 'skilled' WHERE id = ?", t.id);
  assert.equal(rules.escalate(t.id, 'after a progress check'), false);
  assert.equal(rules.escalate(t.id, 'after a review with changes needed'), false);
  assert.equal(task(t.id).tier, 'skilled');
  // A task that reached Deep only by escalation (before this rule) goes back to Skilled once.
  db.run("UPDATE tasks SET tier = 'deep', tier_reason = 'moved up after a progress check' WHERE id = ?", t.id);
  assert.ok(rules.resetEscalatedDeep() >= 1);
  assert.equal(task(t.id).tier, 'skilled');
  assert.equal(rules.resetEscalatedDeep(), 0, 'once');
  // Deep without a listed reason is refused, "open-ended" included; with one it is recorded with its words.
  const bare = await call('create_task', { title: 'Design', description: 'x', state: 'active', check: 'a doc', tier: 'deep', tier_reason: 'Open-ended design.' });
  assert.ok(bare.error && /Deep \(Fable\) is for directing/.test(bare.text), bare.text);
  const noLine = await call('create_task', { title: 'Design 2', description: 'x', state: 'active', check: 'a doc', tier: 'deep', deep_reason: 'system_design' });
  assert.ok(noLine.error && /needs tier_reason/.test(noLine.text));
  const okDeep = await call('create_task', { title: 'Design 3', description: 'x', state: 'active', check: 'a doc', tier: 'deep', deep_reason: 'system_design', tier_reason: 'Changes how every project stores tasks.' });
  assert.ok(!okDeep.error, okDeep.text);
  const d = created(project.id, 'Design 3');
  assert.equal(d.tier, 'deep');
  assert.equal(d.tier_reason, 'System-wide design decision: Changes how every project stores tasks.');
  const up = await call('update_task', { task: t.id, tier: 'deep', tier_reason: 'It is hard.' });
  assert.ok(up.error && /deep_reason/.test(up.text));
  void director;
});

test('deep_share: work tokens (not the director\'s) at Deep over all work tokens, against a fixture', async () => {
  const { project, director } = setup();
  const { modelUse } = await import('./telemetry.ts');
  const w = await import('./watches.ts');
  const s = JSON.parse(project.structure);
  const eng = runtime.createAgent(project, director, s.roles.find((r: any) => r.id === 'builder'), 'Engineer', 'x');
  const at = db.now();
  const row = (agent: string, tier: string, who: string, n: number) => db.run('INSERT INTO token_usage (project_id, agent_id, task_id, tokens, at, tier, who) VALUES (?, ?, NULL, ?, ?, ?, ?)', project.id, agent, n, at, tier, who);
  row(director.id, 'deep', 'director', 5000); // directing on Fable: not work
  row(eng.id, 'deep', 'agent', 300); // work on Fable
  row(eng.id, 'skilled', 'agent', 2400);
  row(eng.id, 'routine', 'agent', 300);
  const m = modelUse({ project: project.id }, at - 1, at + 1);
  assert.equal(m.work, 3000);
  assert.equal(m.deepWork, 300);
  assert.equal(m.deepShare, 10);
  assert.deepEqual(m.byModel.map((x) => [x.model, x.tokens]), [['claude-fable-5-2', 5300], ['claude-opus-5-5', 2400], ['claude-sonnet-5-5', 300]]);
  // Every project gets the watch, above 10% over 7 days, asking the user too.
  w.seedWatches();
  const watch = w.listWatches(project.id).find((x) => x.name === 'Work on Fable (Deep)')!;
  assert.equal(watch.condition, 'above 10%');
  assert.equal(watch.ask_user, true);
  row(eng.id, 'deep', 'agent', 1000);
  assert.equal((await w.measure(db.get('SELECT * FROM watches WHERE id = ?', watch.id)!) as any).value, 32.5);
});
