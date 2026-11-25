import './testenv.ts';
// Ranked search (rankedsearch.ts over the index of searchschema.ts, built by searchindex.ts), through search.ts's
// searchItems as every caller uses it: `node --test server/rankedsearch.test.ts` (npm test). Each matching case says
// what word matching (the setting off) gives for it, so the corpus shows what the change is for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as db from './db.ts';
import { SCRATCH } from './testenv.ts';
import { defaultStructure } from './structure.ts';
import { createTask } from './tasks.ts';
import { addJournal } from './store.ts';
import { rankedSearchSetting, renderFind, searchHelm, searchItems, setRankedSearchOn } from './search.ts';
import { setSetting } from './settings.ts';
import * as search from './search.ts';
import { MARK_CLOSE, MARK_OPEN, buildMatch, markedLine, typingStems } from './rankedsearch.ts';
import { buildSearchIndexNow, buildStep, requestSearchRebuild, searchIndexReady, searchIndexStatus } from './searchindex.ts';
import { searchView } from './searchapi.ts';

const project = (id: string, name: string, archived = 0) =>
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, archived, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)', id, name, tmpdir(), 'Build', 'auto', JSON.stringify(defaultStructure()), archived, db.now(), db.now());
const by = { author: 'user', name: 'You' } as const;
const YEAR = 365 * 86_400_000;
const old = (id: string, ago = 2 * YEAR) => db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', db.now() - ago, id);
const task = (title: string, description = '', state = 'waiting', kind: 'task' | 'discussion' = 'task') =>
  createTask('p_r', { title, description, state, origin: 'user', ...(kind === 'discussion' ? { kind } : {}) } as any, by);

project('p_r', 'Ranked');
project('p_s', 'Other');

// Data from before the index: written, then the index emptied as an upgrade finds it, and built in the background.
const forms = task('Searching the archive', 'Old reports are hard to find.');
const configured = task('Proxy configured for the LAN', 'Done once, kept in the module.');
const phrase = task('Home page header', 'The header on the home page wraps.');
const scattered = task('Page about the home', 'A page. Somewhere else, a home.');
const colon = task('Moving to node:sqlite', 'Drop the native module.');
const accents = task('Résumé of the week', 'What was done.');
const dense = task('Storage costs', 'Quota quota quota: the quota is the whole problem, quota limits.');
const passing = task('Storage notes', `${'Many words about other things. '.repeat(30)}One mention of the quota here.`);
const doneTwin = task('Billing export', 'Export billing as CSV.', 'done');
const openTwin = task('Billing export', 'Export billing as CSV.', 'active');
const titleHit = task('Telemetry dashboard', 'Charts.');
const bodyHit = task('Charts page', 'Shows the telemetry of each agent.');
for (const t of [forms, configured, phrase, scattered, colon, accents, dense, passing, titleHit, bodyHit]) old(t.id);
old(openTwin.id, 2 * YEAR);
old(doneTwin.id, 2 * YEAR - 1000); // the done one is a second newer: word matching puts it first
requestSearchRebuild();

test('before the index is built, searches use word matching; the build is resumable and ends ready', () => {
  assert.equal(searchIndexReady(), false);
  assert.ok(searchItems('p_r', 'searching').length);
  assert.equal(search.lastSearchMode, 'words');
  // A few small batches, as if the process stopped part way; the rest later; nothing twice.
  for (let i = 0; i < 3; i++) buildStep(2);
  assert.equal(searchIndexReady(), false);
  buildSearchIndexNow();
  assert.equal(searchIndexReady(), true);
  const rows = searchIndexStatus().rows;
  assert.ok(rows >= 14);
  searchItems('p_r', 'searching');
  assert.equal(search.lastSearchMode, 'ranked');
  // Idempotent: building again over the same data changes nothing.
  db.run("DELETE FROM search_meta WHERE key LIKE 'cursor:%' OR key = 'ready'");
  buildSearchIndexNow();
  assert.equal(searchIndexStatus().rows, rows);
});

const ids = (q: string, kind?: search.FindKind) => searchItems('p_r', q, { kind }).map((h) => h.id);
const words = <T>(fn: () => T): T => {
  setRankedSearchOn(() => false);
  try {
    return fn();
  } finally {
    setRankedSearchOn(rankedSearchSetting);
  }
};

test('word forms: "searches" finds "Searching", "configuring" finds "configured" (word matching finds neither)', () => {
  assert.deepEqual(words(() => ids('searches')), []);
  assert.deepEqual(ids('searches'), [forms.id]);
  assert.deepEqual(words(() => ids('configuring proxy')), []);
  assert.deepEqual(ids('configuring proxy'), [configured.id]);
});

test('prefix while typing, even part way into an ending ("configura" finds "configured")', () => {
  assert.deepEqual(words(() => ids('proxy configura')), []);
  assert.deepEqual(ids('proxy configura'), [configured.id]);
  assert.deepEqual(ids('archi'), [forms.id]);
  // A finished word (a space after it) is not a prefix.
  assert.deepEqual(ids('archi '), []);
  assert.ok(typingStems('searchin').includes('search'));
  assert.ok(typingStems('runn').includes('run'));
});

test('a quoted phrase matches those words in that order only (word matching finds nothing for it)', () => {
  assert.deepEqual(words(() => ids('"home page"')), []);
  assert.deepEqual(ids('"home page"'), [phrase.id]);
  assert.deepEqual(new Set(ids('home page')), new Set([phrase.id, scattered.id]));
  // Still typing the phrase: its last word is a prefix.
  assert.deepEqual(ids('"home pa'), [phrase.id]);
});

test('punctuation joins a word\'s parts; accents are ignored', () => {
  assert.deepEqual(words(() => ids('node-sqlite')), []);
  assert.deepEqual(ids('node-sqlite'), [colon.id]);
  assert.deepEqual(ids('node:sqlite'), [colon.id]);
  assert.deepEqual(words(() => ids('resume')), []);
  assert.deepEqual(ids('resume'), [accents.id]);
});

test('nothing a user can type is an FTS error: every character is safe, and an error would fall back', () => {
  const nasty = ['"', '""', '"unclosed', 'a"b', '*', 'quota*', '^quota', 'quota AND', 'OR NOT quota', 'NEAR(quota', '(quota', 'quota)', 'col:quota', '{title}: quota', '-quota', '+quota', "quota'", 'quota;--', '%_%', '\\', '\u0000quota', '😀 quota', 'quota\ttelemetry', 'title : quota', 'quota^2'];
  for (const q of nasty) {
    assert.doesNotThrow(() => searchItems('p_r', q), q);
    const m = buildMatch(q);
    if (m) assert.doesNotThrow(() => db.all('SELECT rowid FROM search_fts WHERE search_fts MATCH ?', m.all), q);
  }
  assert.ok(ids('quota*').includes(dense.id));
  assert.ok(ids('NEAR(quota').includes(dense.id) === false); // "near" and "quota" both required: no item has both
  // If the index fails anyway (here: its table renamed away), the search falls back to word matching.
  db.run('ALTER TABLE search_rows RENAME TO search_rows_away');
  try {
    assert.ok(searchItems('p_r', 'quota').length);
    assert.equal(search.lastSearchMode, 'words');
  } finally {
    db.run('ALTER TABLE search_rows_away RENAME TO search_rows');
  }
});

test('ranking: title above body, dense above a passing mention, open above done on a tie, recent lifted', () => {
  // Word matching: the title match first, then newest; the passing mention is newer, so it comes first.
  const telemetry = ids('telemetry');
  assert.deepEqual(telemetry, [titleHit.id, bodyHit.id]);
  db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', db.now() - 2 * YEAR + 10, passing.id);
  assert.deepEqual(words(() => ids('quota')), [passing.id, dense.id]);
  assert.deepEqual(ids('quota'), [dense.id, passing.id]);
  // Twins: word matching puts the newer (done) one first; ranked puts the open one first.
  assert.deepEqual(words(() => ids('billing export')), [doneTwin.id, openTwin.id]);
  assert.deepEqual(ids('billing export'), [openTwin.id, doneTwin.id]);
  // Recency: the same text, one touched today, comes first even though it is a body match.
  db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', db.now(), bodyHit.id);
  assert.equal(ids('telemetry')[0], titleHit.id, 'a title match still beats a fresh body match');
  // Mixed lists: an agent comes after the task it works on, even when fresher and matching in its status line or reports.
  const work = task('Search ranking for the archive', 'Rank what the archive search finds.', 'active');
  db.run("INSERT INTO agents (id, project_id, role_id, name, model, status, status_line, created_at, updated_at) VALUES ('ag_s', 'p_r', 'engineer', 'Archive engineer', 'opus', 'working', 'Searching the archive ranking', ?, ?)", db.now(), db.now());
  assert.deepEqual(ids('searching').slice(0, 2), [work.id, forms.id]);
  assert.ok(ids('searching').includes('ag_s'));
  const lu = task('Live update in one tap', 'Update Helm without a rebuild.', 'active');
  db.run("INSERT INTO agents (id, project_id, role_id, name, model, status, status_line, created_at, updated_at) VALUES ('ag_lu', 'p_r', 'engineer', 'Live update engineer', 'opus', 'idle', '', ?, ?)", db.now(), db.now());
  db.run("INSERT INTO agents (id, project_id, role_id, name, model, status, status_line, created_at, updated_at) VALUES ('ag_dir', 'p_r', 'director', 'Director', 'opus', 'idle', '', ?, ?)", db.now(), db.now());
  db.run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES ('p_r', 'ag_dir', ?, 'result', ?)", db.now(), JSON.stringify({ text: 'The live update is merged; live update ready.' }));
  const live = ids('live update');
  assert.equal(live[0], lu.id);
  assert.ok(live.indexOf('ag_lu') > 0 && live.indexOf('ag_dir') > live.indexOf('ag_lu'), live.join(' '));
  // Its name is what makes an agent top a list.
  assert.equal(ids('archive engineer')[0], 'ag_s');
  const a = task('Ledger rounding', 'Rounding of the ledger.');
  const b = task('Ledger rounding', 'Rounding of the ledger.');
  old(a.id, YEAR);
  assert.deepEqual(ids('ledger rounding'), [b.id, a.id]);
});

test('highlights come from FTS: other forms of a word are marked, in the title and the line', () => {
  const hit = searchItems('p_r', 'searches').find((h) => h.id === forms.id)!;
  assert.equal(hit.hl?.title, `${MARK_OPEN}Searching${MARK_CLOSE} the archive`);
  const t = task('Rollout', 'First line.\nThe exports **were** exported by the [export job](http://x).\nLast line.');
  const [h] = searchItems('p_r', 'exporting', { kind: 'task' }).filter((x) => x.id === t.id);
  assert.equal(markedLine(h.hl!.text), `The ${MARK_OPEN}exports${MARK_CLOSE} were ${MARK_OPEN}exported${MARK_CLOSE} by the ${MARK_OPEN}export${MARK_CLOSE} job.`);
  // Cut inside a long line: around the first mark, marks balanced.
  const long = markedLine(`${'x '.repeat(100)}${MARK_OPEN}word${MARK_CLOSE}${' y'.repeat(100)}`, 40);
  assert.ok(long.startsWith('…') && long.endsWith('…') && long.includes(`${MARK_OPEN}word${MARK_CLOSE}`));
  // The endpoint sends the marked title and line; the tool's text has no marks.
  const view = searchView('exporting', 'p_r');
  const item = view.groups.find((g) => g.kind === 'task')!.items.find((i) => i.id === t.id)!;
  assert.match(item.line, /exports/);
  assert.doesNotMatch(renderFind('p_r', 'exporting'), /[]/);
});

test('every write path keeps the index current (triggers): edits, deletes, threads, docs, sections, previews, reports, journal, agents, final reports', () => {
  const t = task('Kestrel migration');
  assert.deepEqual(ids('kestrel'), [t.id]);
  db.run('UPDATE tasks SET title = ? WHERE id = ?', 'Osprey migration', t.id);
  assert.deepEqual(ids('kestrel'), []);
  assert.deepEqual(ids('osprey'), [t.id]);
  db.run("UPDATE tasks SET status_summary = 'waiting on the falcon review', conclusion = 'agreed on harrier' WHERE id = ?", t.id);
  assert.deepEqual(ids('falcon'), [t.id]);
  assert.deepEqual(ids('harrier'), [t.id]);
  // Thread messages: added, edited, moved, deleted with the task.
  const msg = db.run("INSERT INTO task_messages (task_id, author, author_name, body, created_at) VALUES (?, 'user', 'You', 'what about the buzzard?', ?)", t.id, db.now()).lastInsertRowid;
  assert.deepEqual(ids('buzzard'), [t.id]);
  const hit = searchItems('p_r', 'buzzard')[0];
  assert.equal(hit.title, 'Osprey migration');
  assert.equal(hit.hl?.title, 'Osprey migration');
  db.run("UPDATE task_messages SET body = 'what about the condor?' WHERE id = ?", msg);
  assert.deepEqual(ids('buzzard'), []);
  assert.deepEqual(ids('condor'), [t.id]);
  const d = task('Condor discussion', '', 'open', 'discussion');
  db.run('UPDATE task_messages SET task_id = ? WHERE id = ?', d.id, msg);
  assert.deepEqual(ids('condor', 'discussion'), [d.id]);
  assert.deepEqual(ids('condor', 'task'), []);
  db.run('DELETE FROM tasks WHERE id = ?', d.id);
  assert.deepEqual(ids('condor'), []);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM search_rows WHERE item = ?", d.id)!.n, 0);
  // A Spec entry: its text, tags and section path; renaming a parent section re-indexes the entries under it.
  db.run("INSERT INTO doc_sections (id, project_id, name, created_at, updated_at) VALUES ('sec_1', 'p_r', 'Pipelines', 0, 0)");
  db.run("INSERT INTO doc_sections (id, project_id, name, parent_id, created_at, updated_at) VALUES ('sec_2', 'p_r', 'Ingest', 'sec_1', 0, 0)");
  db.run("INSERT INTO docs (id, project_id, kind, title, summary, body, tags, section_id, created_at, updated_at) VALUES ('doc_1', 'p_r', 'goal', 'Nightly loads', 'Loads finish by six.', 'Body text.', '[\"etl\",\"ops\"]', 'sec_2', ?, ?)", db.now(), db.now());
  assert.deepEqual(ids('etl'), ['doc_1']);
  assert.deepEqual(ids('pipelines ingest'), ['doc_1']);
  db.run("UPDATE doc_sections SET name = 'Streams' WHERE id = 'sec_1'");
  assert.deepEqual(ids('pipelines'), []);
  assert.deepEqual(ids('streams'), ['doc_1']);
  db.run("UPDATE docs SET tags = 'not json' WHERE id = 'doc_1'"); // a bad value never breaks the write
  assert.deepEqual(ids('etl'), []);
  // Previews: caption, markdown text, a guide's steps, a comparison's captions.
  db.run("INSERT INTO previews (id, project_id, kind, title, caption, content, created_at) VALUES ('pv_1', 'p_r', 'markdown', 'Measurements', 'cap', '# Heading\\nthe pelican numbers', ?)", db.now());
  db.run("INSERT INTO previews (id, project_id, kind, title, caption, content, created_at) VALUES ('pv_2', 'p_r', 'guide', 'Try it', '', ?, ?)", JSON.stringify({ steps: [{ text: 'Open the albatross menu' }], expect: 'A gannet appears' }), db.now());
  db.run("INSERT INTO previews (id, project_id, kind, title, caption, content, created_at) VALUES ('pv_3', 'p_r', 'compare', 'Fixed', '', ?, ?)", JSON.stringify({ before: { caption: 'cormorant clipped' }, after: { caption: 'shown whole' } }), db.now());
  db.run("INSERT INTO previews (id, project_id, kind, title, caption, content, created_at) VALUES ('pv_4', 'p_r', 'guide', 'Broken', '', 'not json {', ?)", db.now());
  assert.deepEqual(ids('pelican'), ['pv_1']);
  assert.deepEqual(ids('albatross gannet'), ['pv_2']);
  assert.deepEqual(ids('cormorant'), ['pv_3']);
  // Reports and the journal.
  db.run("INSERT INTO report_sources (id, project_id, type, name, config, created_at, updated_at) VALUES ('rs_1', 'p_r', 'notes', 'n', '{}', 0, 0)");
  db.run("INSERT INTO reports (id, project_id, source_id, external_id, title, body, changed_at, created_at, updated_at) VALUES ('rp_1', 'p_r', 'rs_1', 'x', 'Crash', 'The puffin screen crashes.', 0, ?, ?)", db.now(), db.now());
  assert.deepEqual(ids('puffin'), ['rp_1']);
  db.run("UPDATE reports SET triage_note = 'same as the heron bug' WHERE id = 'rp_1'");
  assert.deepEqual(ids('heron'), ['rp_1']);
  addJournal('p_r', null, 'decision', 'Chose the egret plan', 'Because.', t.id);
  const j = searchItems('p_r', 'egret')[0];
  assert.equal(j.kind, 'journal');
  assert.equal(j.ref, `[[${t.id}]]`);
  // Agents: name, role, status line; final reports and errors from the transcript.
  db.run("INSERT INTO agents (id, project_id, role_id, name, model, status, status_line, created_at, updated_at) VALUES ('ag_r', 'p_r', 'engineer', 'Ibis engineer', 'opus', 'working', 'reading', ?, ?)", db.now(), db.now());
  assert.deepEqual(ids('ibis'), ['ag_r']);
  db.run("UPDATE agents SET status_line = 'tuning the plover' WHERE id = 'ag_r'");
  assert.deepEqual(ids('plover'), ['ag_r']);
  db.run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES ('p_r', 'ag_r', ?, 'result', ?)", db.now(), JSON.stringify({ ok: true, text: 'Finished the sandpiper fix.' }));
  db.run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES ('p_r', 'ag_r', ?, 'error', ?)", db.now(), JSON.stringify({ message: 'API error: curlew' }));
  db.run("INSERT INTO events (project_id, agent_id, ts, kind, data) VALUES ('p_r', 'ag_r', ?, 'text', ?)", db.now(), JSON.stringify({ text: 'thinking about the dunlin' }));
  assert.deepEqual(ids('sandpiper'), ['ag_r']);
  assert.deepEqual(ids('curlew'), ['ag_r']);
  // The rest of the transcript is history (history.ts), not the agent's own row.
  assert.deepEqual(searchItems('p_r', 'dunlin').map((h) => h.kind), ['history'], 'only final reports and errors find the agent; the rest is history');
  db.run("DELETE FROM agents WHERE id = 'ag_r'");
  assert.deepEqual(ids('sandpiper'), []);
  // Knowledge notes: title, text, topic and paths; they open the Knowledge page.
  db.run("INSERT INTO knowledge_notes (id, project_id, topic, title, body, paths, added_by, created_at, updated_by, updated_at) VALUES ('kn_1', 'p_r', 'Testing', 'Run the suites', 'Use the kittiwake runner.', '[\"server/guillemot.ts\"]', 'You', 0, 'You', ?)", db.now());
  assert.deepEqual(ids('kittiwake'), ['kn_1']);
  assert.deepEqual(ids('guillemot'), ['kn_1']);
  const k = searchItems('p_r', 'kittiwake')[0];
  assert.deepEqual([k.kind, k.ref, k.state], ['knowledge', '[[page:knowledge]]', 'Testing']);
  assert.deepEqual(words(() => ids('kittiwake')), ['kn_1']);
  db.run("UPDATE knowledge_notes SET body = 'Use the tern runner.' WHERE id = 'kn_1'");
  assert.deepEqual(ids('kittiwake'), []);
  db.run("DELETE FROM knowledge_notes WHERE id = 'kn_1'");
  assert.deepEqual(ids('tern'), []);
  // Dashboards (title, the user's description) and their tiles (title, caption, text, recipe, dependencies).
  db.run("INSERT INTO dashboards (id, project_id, title, description, state, created_at, updated_at) VALUES ('dash_1', 'p_r', 'Levels', 'Every level from the puffbird angle.', 'ready', 0, ?)", db.now());
  db.run(
    "INSERT INTO tiles (id, dashboard_id, project_id, kind, title, caption, deps, recipe, created_at, updated_at) VALUES ('tile_1', 'dash_1', 'p_r', 'image', 'Forest', 'From the hoatzin camera', ?, ?, 0, ?)",
    JSON.stringify({ paths: ['levels/quetzal/**'] }), JSON.stringify({ command: 'node render.mjs motmot', cwd: '.' }), db.now(),
  );
  assert.deepEqual(ids('puffbird'), ['dash_1']);
  for (const w of ['hoatzin', 'motmot', 'quetzal']) assert.deepEqual(ids(w), ['tile_1'], w);
  const dh = searchItems('p_r', 'motmot')[0];
  assert.deepEqual([dh.kind, dh.ref, dh.state], ['dashboard', '[[page:dashboards]]', 'tile on Levels']);
  assert.deepEqual(words(() => ids('motmot')), ['tile_1']);
  db.run("UPDATE tiles SET data = ?, kind = 'text' WHERE id = 'tile_1'", JSON.stringify({ markdown: 'The fulmar note.' }));
  assert.deepEqual(ids('fulmar'), ['tile_1']);
  db.run("DELETE FROM dashboards WHERE id = 'dash_1'");
  assert.deepEqual(ids('puffbird'), []);
  assert.deepEqual(ids('fulmar'), [], 'tiles go with their dashboard');
  assert.deepEqual(ids('motmot'), []);
});

test('another process writing the same database (the web service beside the runner) is indexed too', () => {
  const other = new DatabaseSync(join(SCRATCH, 'helm.db'));
  other.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  other.prepare("INSERT INTO tasks (id, project_id, title, created_at, updated_at) VALUES ('task_other', 'p_r', 'Written by the skua process', 0, 0)").run();
  other.close();
  assert.deepEqual(ids('skua'), ['task_other']);
});

test('the setting (Setup › Agent context, "Ranked search"): off gives word matching for that project only; across projects stays ranked', () => {
  setSetting('p_r', 'ranked_search', false);
  try {
    assert.deepEqual(ids('searches'), []);
    assert.equal(search.lastSearchMode, 'words');
    createTask('p_s', { title: 'Searching elsewhere', state: 'waiting', origin: 'user' }, by);
    assert.equal(searchItems('p_s', 'searches').length, 1);
    assert.equal(search.lastSearchMode, 'ranked');
    searchItems(null, 'searches');
    assert.equal(search.lastSearchMode, 'ranked');
  } finally {
    setSetting('p_r', 'ranked_search', true);
  }
  searchItems('p_r', 'searches');
  assert.equal(search.lastSearchMode, 'ranked');
});

test('search_helm uses the same index across projects, archived ones included', () => {
  project('p_arch', 'Archived', 1);
  createTask('p_arch', { title: 'Searched long ago', state: 'done', origin: 'user' }, by);
  const out = searchHelm('searches');
  assert.equal(search.lastSearchMode, 'ranked');
  assert.match(out, /\[Archived\].*Searched long ago/);
  assert.match(out, /\[Ranked\].*Searching the archive/);
  assert.doesNotMatch(out, /[]/);
  // The Home search across projects leaves archived projects out.
  assert.ok(!searchItems(null, 'searches').some((h) => h.project_id === 'p_arch'));
});

test('rebuild: empties the index, word matching meanwhile, then the same results', () => {
  const before = ids('quota');
  requestSearchRebuild();
  assert.equal(searchIndexReady(), false);
  searchItems('p_r', 'quota');
  assert.equal(search.lastSearchMode, 'words');
  buildSearchIndexNow();
  assert.deepEqual(ids('quota'), before);
});
