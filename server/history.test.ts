import { SCRATCH } from './testenv.ts';
// Nothing lost to a context summary: the save turn's rule and note, the summary record and its two-line note, the
// transcript index (kind history, mine, ranked below the rest), and the reduction of old history.
// `node --test server/history.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const db = await import('./db.ts');
const structure = await import('./structure.ts');
const runtime = await import('./runtime.ts');
const tasks = await import('./tasks.ts');
const { addEvent, addJournal } = (await import('./store.ts')) as any;
const ctx = await import('./contextsave.ts');
const hist = await import('./history.ts');
const reduce = await import('./historyreduce.ts');
const { buildSearchIndexNow } = await import('./searchindex.ts');
const { searchItems, renderFind } = await import('./search.ts');
const { setSetting } = await import('./settings.ts');

const USER = { author: 'user' as const, name: 'You' };
const DAY = 86_400_000;
db.freezeClock();

function setup() {
  const id = db.newId('pr');
  const s = structure.defaultStructure();
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, 'hist', SCRATCH, 'Build', 'auto', JSON.stringify(s), db.now(), db.now());
  const project = db.get('SELECT * FROM projects WHERE id = ?', id)!;
  const director = runtime.rootAgent(project);
  const builder = runtime.createAgent(project, director, s.roles.find((r) => r.id === 'builder')!, 'Builder', 'Hold the queue.');
  const t = tasks.createTask(id, { title: 'Port the exporter', state: 'active', origin: 'director', description: 'Port it.', driver_agent_id: builder.id } as any, USER);
  return { project, director, builder, t };
}
const agent = (id: string) => db.get('SELECT * FROM agents WHERE id = ?', id)!;

test('the save turn: asked once past 80% of the window; the director is also told to file what the user asked for', () => {
  assert.equal(ctx.shouldAskSave(150_000, 200_000, null), false);
  assert.equal(ctx.shouldAskSave(170_000, 200_000, null), true);
  assert.equal(ctx.shouldAskSave(190_000, 200_000, Date.now()), false, 'asked already');
  assert.equal(ctx.contextOf({ input_tokens: 10, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 2000 }), 152_010);
  const { director, builder } = setup();
  const b = ctx.saveNote(agent(builder.id), 170_000, 200_000);
  assert.match(b, /85% full/);
  assert.match(b, /note_knowledge/);
  assert.doesNotMatch(b, /the user asked for/);
  assert.match(ctx.saveNote(agent(director.id), 170_000, 200_000), /the user asked for that is not yet in a task/);
});

test('a summary is recorded with context before and after, what was saved, and a two-line note', () => {
  const { project, builder } = setup();
  const asked = db.now();
  db.advanceClock(1000);
  db.run(
    "INSERT INTO knowledge_notes (id, project_id, topic, title, body, paths, added_by, added_agent, created_at, updated_by, updated_agent, updated_at) VALUES (?,?,'Pitfalls','Exporter needs UTF-8','x','[]','agent',?,?,'agent',?,?)",
    db.newId('kn'), project.id, builder.id, db.now(), builder.id, db.now(),
  );
  db.run("INSERT INTO journal (project_id, agent_id, kind, title, body, ts) VALUES (?,?,'decision','Keep the old flag','because',?)", project.id, builder.id, db.now());
  const note = ctx.recordSummary(agent(builder.id), { trigger: 'auto', pre_tokens: 182_000, post_tokens: 21_000 }, asked);
  const lines = note.split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /182k → 21k tokens\)\. Saved before it: 1 knowledge note, 1 journal entry\./);
  assert.match(lines[1], /kind history and mine: true/);
  const [s] = ctx.summariesView(project.id);
  assert.equal(s.pre_tokens, 182_000);
  assert.equal(s.post_tokens, 21_000);
  assert.equal(s.saved_first, 1);
  assert.equal(ctx.summariesView(null).some((x) => x.id === s.id), true);
  // Without a save turn first, the last hour counts: two hours on, nothing.
  db.advanceClock(2 * 3600_000);
  assert.match(ctx.recordSummary(agent(builder.id), { pre_tokens: 100_000, post_tokens: 9000 }, null), /Saved before it: nothing\./);
});

test('transcripts are searchable as kind history: own history with mine, after every other kind in a mixed list', () => {
  const { project, director, builder, t } = setup();
  addEvent(agent(builder.id), 'tool', { id: 'tu1', name: 'Bash', summary: 'pnpm exec vitest flamingo-suite' });
  addEvent(agent(builder.id), 'tool_result', { id: 'tu1', text: `${'x'.repeat(50)} the flamingo fixture failed with ENOSPC` });
  addEvent(agent(director.id), 'text', { text: 'I asked about the flamingo palette.' });
  db.run('UPDATE tasks SET description = ? WHERE id = ?', 'Flamingo colours for the exporter.', t.id);
  buildSearchIndexNow();
  const mine = searchItems(project.id, 'flamingo', { kind: 'history', agentId: builder.id });
  assert.equal(mine.length, 2);
  assert.ok(mine.every((h) => h.kind === 'history' && h.ref === `[[${builder.id}]]`));
  assert.match(mine[0].hl!.text, /flamingo/);
  assert.equal(searchItems(project.id, 'flamingo', { kind: 'history' }).length, 3);
  const mixed = searchItems(project.id, 'flamingo');
  assert.equal(mixed[0].kind, 'task', 'work items first');
  assert.ok(mixed.slice(1).every((h) => h.kind === 'history'), 'history last');
  // The find tool's mine.
  assert.match(renderFind(project.id, 'ENOSPC', 'history', 10, builder.id), /tool result for Builder/);
  // An event's text change is re-indexed; a deleted one leaves the index.
  const id = Number(db.get("SELECT id FROM events WHERE agent_id = ? AND kind = 'tool_result'", builder.id)!.id);
  db.run('DELETE FROM events WHERE id = ?', id);
  assert.equal(searchItems(project.id, 'ENOSPC', { kind: 'history' }).length, 0);
});

test('old history is reduced: results dropped with a note in their place, tool calls keep their summary, messages stay', () => {
  const { project, builder } = setup();
  setSetting(project.id, 'history_keep_days', '30');
  const old = (kind: string, data: unknown) => {
    const id = addEvent(agent(builder.id), kind, data);
    db.run('UPDATE events SET ts = ? WHERE id = ?', db.now() - 40 * DAY, id);
    return id;
  };
  old('inbound', { text: 'Your next task: the exporter' });
  old('tool', { id: 'a', name: 'Read', summary: 'src/export.ts', input: 'x'.repeat(5000) });
  old('tool_result', { id: 'a', text: 'y'.repeat(20_000) });
  old('tool', { id: 'b', name: 'Bash', summary: 'npm test', input: 'z'.repeat(5000) });
  old('tool_result', { id: 'b', text: 'w'.repeat(20_000) });
  old('text', { text: 'Exporter ported.' });
  const fresh = addEvent(agent(builder.id), 'tool_result', { id: 'c', text: 'recent result' });
  const r = reduce.reduceHistory();
  assert.ok(r.results >= 2 && r.calls >= 2, JSON.stringify(r));
  assert.ok(r.bytesAfter < r.bytesBefore - 40_000);
  const kinds = db.all('SELECT kind, data FROM events WHERE agent_id = ? ORDER BY id', builder.id);
  assert.deepEqual(kinds.map((e) => e.kind), ['inbound', 'tool', 'note', 'tool', 'text', 'tool_result']);
  assert.match(JSON.parse(kinds[2].data).text, /2 tool results .* dropped .*Read 1/);
  assert.equal(JSON.parse(kinds[1].data).input, undefined);
  assert.equal(JSON.parse(kinds[1].data).summary, 'src/export.ts');
  assert.ok(db.get('SELECT 1 FROM events WHERE id = ?', fresh), 'recent history untouched');
  assert.equal(reduce.reduceState().last?.results, r.results);
  // Never: reduction off for a project keeps it whole.
  setSetting(project.id, 'history_keep_days', '0');
  assert.equal(reduce.keepDays(project.id), 0);
});

void addJournal;
void hist;
