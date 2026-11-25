import './testenv.ts';
// The Spec's section tree (server/sections.ts): depth limit, cycles, sibling names, paths, delete, the agent tools,
// the parent_id migration, and that moving entries or sections never opens a planning task.
// `node --test server/spectree.test.ts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const db = await import('./db.ts');
const { defaultStructure } = await import('./structure.ts');
const spec = await import('./spec.ts');
const T = await import('./sections.ts');
const { helmTools } = await import('./tools.ts');

const USER = { author: 'user' as const, name: 'You' };
const AGENT = { author: 'agent' as const, name: 'Director' };

function makeProject() {
  const id = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at, sessions_backfilled) VALUES (?,?,?,?,?,?,?,?,1)', id, 'Tree', tmpdir(), 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  return id;
}
const path = (pid: string, ref: string) => T.ensureSectionPath(pid, ref) as { id: string; created: string[] };
const sec = (id: string) => db.get('SELECT * FROM doc_sections WHERE id = ?', id)!;
const pathOf = (pid: string, id: string) => T.pathText(T.sectionTree(pid), id);
const err = (r: object) => ('error' in r ? String((r as any).error) : '');

test('paths create missing levels, at most three deep', () => {
  const pid = makeProject();
  const r = path(pid, 'Combat / Weapons / Ranged');
  assert.equal(r.created.length, 3);
  assert.equal(pathOf(pid, r.id), 'Combat / Weapons / Ranged');
  // The same path again, any case or separator, is the same section.
  assert.equal(path(pid, 'combat › weapons > RANGED').id, r.id);
  assert.equal(path(pid, 'Combat / Weapons / Ranged').created.length, 0);
  // A fourth level is refused, through a path and by adding under a third-level section.
  assert.match(err(T.ensureSectionPath(pid, 'Combat / Weapons / Ranged / Bows')), /4 levels deep; the Spec has at most 3/);
  assert.match(err(T.addSection(pid, 'Bows', '', r.id)), /at most 3/);
  // A path below an existing section by its bare name extends it.
  const melee = path(pid, 'Weapons / Melee');
  assert.equal(pathOf(pid, melee.id), 'Combat / Weapons / Melee');
});

test('moving a section refuses cycles and a fourth level, and carries what is inside', () => {
  const pid = makeProject();
  const a = path(pid, 'A / B / C').id;
  const b = T.resolveSection(pid, 'A / B') as any;
  const top = sec(T.sectionTree(pid).kids.get(null)![0].id);
  assert.match(err(T.placeSection(top, top.id)), /cannot go inside itself/);
  assert.match(err(T.placeSection(top, b.section.id)), /is inside "A"/);
  assert.match(err(T.placeSection(top, a)), /is inside "A"/);
  // X › Y is two levels; under a second-level section it would make four.
  const y = path(pid, 'X / Y').id;
  const x = sec(sec(y).parent_id);
  assert.match(err(T.placeSection(x, b.section.id)), /4 levels deep/);
  // Under a top-level section it fits (three levels), and Y comes along.
  assert.ok('ok' in T.placeSection(x, top.id));
  assert.equal(pathOf(pid, y), 'A / X / Y');
  // Back to the top level.
  assert.ok('ok' in T.placeSection(sec(x.id), null));
  assert.equal(pathOf(pid, y), 'X / Y');
});

test('names are unique among siblings only; bare names resolve when unique, paths otherwise', () => {
  const pid = makeProject();
  const r1 = path(pid, 'Combat / Ranged').id;
  const r2 = path(pid, 'Magic / Ranged').id;
  assert.notEqual(r1, r2);
  assert.match(err(T.addSection(pid, 'ranged', '', sec(r1).parent_id)), /already a section "Ranged" in Combat/);
  assert.match(err(T.addSection(pid, 'Combat', '')), /at the top level/);
  // Ambiguous bare name: refused with the paths to choose from.
  const amb = T.resolveSection(pid, 'Ranged');
  assert.ok('error' in amb && !amb.missing);
  assert.match((amb as any).error, /Combat \/ Ranged; Magic \/ Ranged/);
  assert.equal(T.findSection(pid, 'Ranged'), undefined);
  assert.match(err(T.ensureSectionPath(pid, 'Ranged')), /matches 2 sections/);
  // Paths and ids pick one.
  assert.equal((T.resolveSection(pid, 'magic/ranged') as any).section.id, r2);
  assert.equal((T.resolveSection(pid, r1) as any).section.id, r1);
  // A unique bare name keeps working, at any level.
  assert.equal(T.findSection(pid, 'magic')!.id, sec(r2).parent_id);
  // Renaming into a sibling's name is refused; into a cousin's is fine.
  const m = path(pid, 'Magic / Melee').id;
  assert.match(err(T.updateSection(sec(m), { name: 'Ranged' })), /already a section "Ranged"/);
  assert.ok('ok' in T.updateSection(sec(m), { name: 'Close' }));
  // Moving a section next to one of the same name is refused.
  const loose = path(pid, 'Ranged2').id;
  T.updateSection(sec(loose), { name: 'Elsewhere' });
  path(pid, 'Combat / Elsewhere');
  assert.match(err(T.placeSection(sec(loose), sec(r1).parent_id)), /already a section "Elsewhere" in Combat/);
});

test('deleting a section moves its entries and subsections up to its parent, renaming clashes', () => {
  const pid = makeProject();
  const weapons = path(pid, 'Combat / Weapons').id;
  const ranged = path(pid, 'Combat / Weapons / Ranged').id;
  path(pid, 'Combat / Ranged');
  const combat = sec(weapons).parent_id;
  const e1 = spec.saveDoc(pid, null, { title: 'Bow', summary: 's', section_id: ranged }, AGENT) as { id: string };
  const e2 = spec.saveDoc(pid, null, { title: 'Sword', summary: 's', section_id: weapons }, AGENT) as { id: string };
  const res = T.deleteSection(sec(weapons));
  assert.deepEqual(res.renamed, [{ from: 'Ranged', to: 'Ranged (Weapons)' }]);
  assert.equal(spec.getDoc(e2.id)!.section_id, combat, 'its entry moved up to Combat');
  assert.equal(spec.getDoc(e1.id)!.section_id, ranged, 'entries of subsections stay in them');
  assert.equal(pathOf(pid, ranged), 'Combat / Ranged (Weapons)');
  // A top-level section's contents go to the top level / no section.
  T.deleteSection(sec(combat));
  assert.equal(spec.getDoc(e2.id)!.section_id, null);
  assert.equal(sec(ranged).parent_id, null);
  // Siblings keep a clean order.
  assert.deepEqual(T.listSections(pid).filter((s) => !s.parent_id).map((s) => s.position), [1, 2]);
});

test('moving an entry or a section, by the user, opens no planning task', async () => {
  const pid = makeProject();
  const a = path(pid, 'Combat / Weapons').id;
  const b = path(pid, 'Magic').id;
  const made = spec.saveDoc(pid, null, { title: 'Sword', summary: 's', section_id: a }, AGENT) as { id: string };
  const tasks = () => Number(db.get('SELECT COUNT(*) AS n FROM tasks WHERE project_id = ?', pid)!.n);
  const before = tasks();
  const moved = spec.saveDoc(pid, spec.getDoc(made.id)!, { section_id: b }, USER);
  assert.ok('id' in moved && !moved.pending);
  assert.equal(spec.getDoc(made.id)!.spec_state, '');
  assert.ok('ok' in T.placeSection(sec(a), b));
  assert.ok('ok' in T.placeSection(sec(sec(a).parent_id ?? a), null));
  T.deleteSection(sec(b));
  await spec.flushProject(pid);
  assert.equal(tasks(), before, 'no task was opened');
  assert.equal(spec.pendingChanges(pid).count, 0);
  // The move is still in the entry's history.
  assert.equal(db.get("SELECT COUNT(*) AS n FROM doc_revisions WHERE doc_id = ? AND op = 'edit'", made.id)!.n, 1);
  // A content edit by the user still does (the control for this test).
  spec.saveDoc(pid, spec.getDoc(made.id)!, { summary: 'changed' }, USER);
  assert.equal(spec.pendingChanges(pid).count, 1);
});

test('agent tools: set_section with parent and paths, set_doc with a path, list_docs as a tree', async () => {
  const pid = makeProject();
  const agentId = db.newId('ag');
  db.run("INSERT INTO agents (id, project_id, role_id, name, model, status, created_at, updated_at) VALUES (?, ?, 'director', 'Director', 'x', 'idle', ?, ?)", agentId, pid, db.now(), db.now());
  const rt = { spawn: async () => 'x', send: async () => {}, close: async () => {}, markComplete: () => {} };
  const list = helmTools(agentId, rt as any, { manager: true, root: true, consult: false }) as any[];
  const call = async (name: string, args: any) => {
    const r = await list.find((t) => t.name === name)!.handler(args, {});
    return { text: r.content.map((c: any) => c.text).join('\n'), error: !!r.isError };
  };
  // A section gets sub-sections only once it holds eight entries (speclimits.ts).
  const seed = (ref: string) => {
    const id = T.findSection(pid, ref)!.id;
    for (let i = 0; i < 8; i++) spec.saveDoc(pid, null, { title: `${ref} ${i}`, summary: 's', section_id: id }, AGENT);
  };
  assert.equal((await call('set_section', { name: 'Combat', description: 'Fighting' })).error, false);
  assert.ok((await call('set_section', { name: 'Weapons', parent: 'Combat' })).error, 'Combat is still empty');
  seed('Combat');
  assert.equal((await call('set_section', { name: 'Weapons', parent: 'Combat' })).error, false);
  seed('Combat / Weapons');
  let r = await call('set_section', { name: 'Ranged', parent: 'Combat / Weapons', description: 'Bows' });
  assert.equal(r.error, false);
  assert.match(r.text, /- Combat \/ Weapons \/ Ranged \(0 entries\) — Bows/);
  r = await call('set_section', { name: 'Deep', parent: 'Ranged' });
  assert.ok(r.error);
  assert.match(r.text, /at most 3/);
  // A second Ranged elsewhere, by full path; then the bare name is ambiguous.
  assert.equal((await call('set_section', { name: 'Magic' })).error, false);
  seed('Magic');
  assert.equal((await call('set_section', { name: 'Magic / Ranged' })).error, false);
  r = await call('set_doc', { title: 'Longbow', summary: 'A bow.', section: 'Ranged' });
  assert.ok(r.error);
  assert.match(r.text, /matches 2 sections/);
  r = await call('set_doc', { title: 'Longbow', summary: 'A bow.', section: 'Weapons / Ranged' });
  assert.equal(r.error, false, r.text);
  // Two new levels at once: Spells would hold one entry, too few for a sub-section.
  r = await call('set_doc', { title: 'Fireball', summary: 'Hot.', section: 'Magic / Spells / Fire' });
  assert.match(r.text, /"Magic \/ Spells" would hold 1 entry/);
  r = await call('set_doc', { title: 'Fireball', summary: 'Hot.', section: 'Magic / Spells' });
  assert.equal(r.error, false, r.text);
  // Moving a section to the top level, then back under Combat.
  r = await call('set_section', { name: 'Magic / Ranged', parent: 'Combat / Weapons' });
  assert.ok(r.error);
  assert.match(r.text, /already a section "Ranged" in Combat \/ Weapons/);
  r = await call('set_section', { name: 'Magic / Ranged', parent: '' });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /^- Ranged \(0 entries\)$/m);
  const docs = await call('list_docs', {});
  assert.match(docs.text, /^# Combat \(17 entries\) — Fighting$/m);
  assert.match(docs.text, /^### Combat \/ Weapons \/ Ranged \(1 entry\) — Bows$/m);
  assert.match(docs.text, /^## Magic \/ Spells \(1 entry\)$/m);
  const only = await call('list_docs', { section: 'Combat' });
  assert.match(only.text, /Longbow/);
  assert.doesNotMatch(only.text, /Fireball/);
  // Removing a section moves its contents up.
  r = await call('set_section', { name: 'Combat / Weapons', remove: true });
  assert.equal(r.error, false);
  assert.match(r.text, /- Combat \/ Ranged/);
});

test('the parent_id migration is additive and idempotent: run twice on an old database', () => {
  // A database from before nesting: doc_sections without parent_id, with a section and an entry in it.
  const dir = mkdtempSync(join(tmpdir(), 'helm-tree-mig-'));
  const old = new DatabaseSync(join(dir, 'helm.db'));
  old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE doc_sections (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO projects VALUES ('pr_old', 'Old', '/tmp', 1, 1);
    INSERT INTO doc_sections VALUES ('sec_a', 'pr_old', 'Alpha', 'first', 1, 1, 1), ('sec_b', 'pr_old', 'Beta', '', 2, 1, 1);`);
  old.close();
  const out = [runMigration(dir), runMigration(dir)];
  rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(out[0], out[1], 'the second run changes nothing');
  assert.ok(out[0].cols.includes('parent_id'));
  assert.deepEqual(out[0].sections, [
    { id: 'sec_a', name: 'Alpha', parent_id: null, position: 1 },
    { id: 'sec_b', name: 'Beta', parent_id: null, position: 2 },
  ]);
});

// A copy of a real database (SPEC_TREE_DB=/path/to/helm.db; never the live file itself): migrated twice, nothing else
// changes and every section stays at the top level.
test('the migration on a copy of a real database, twice', { skip: !process.env.SPEC_TREE_DB && 'set SPEC_TREE_DB to a helm.db to copy' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-tree-copy-'));
  try {
    copyFileSync(process.env.SPEC_TREE_DB!, join(dir, 'helm.db'));
    const src = new DatabaseSync(join(dir, 'helm.db'), { readOnly: true });
    const had = Number((src.prepare('SELECT COUNT(*) AS n FROM doc_sections').get() as any).n);
    src.close();
    const [first, second] = [runMigration(dir), runMigration(dir)];
    assert.deepEqual(first, second);
    assert.equal(first.counts.doc_sections, had);
    assert.ok((first.sections as any[]).every((s) => s.parent_id === null));
    console.log(`migrated twice: ${JSON.stringify(first.counts)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Open a data directory with the server's db.ts in a fresh process (which migrates it); report the sections. */
export function runMigration(dir: string): { cols: string[]; sections: unknown[]; counts: Record<string, number> } {
  const script = `
    const { all } = await import(${JSON.stringify(new URL('./db.ts', import.meta.url).href)});
    const cols = all('PRAGMA table_info(doc_sections)').map((c) => c.name);
    const sections = all('SELECT id, name, parent_id, position FROM doc_sections ORDER BY id');
    const counts = Object.fromEntries(['projects', 'docs', 'doc_sections', 'tasks', 'doc_revisions'].map((t) => [t, all('SELECT COUNT(*) AS n FROM ' + t)[0].n]));
    console.log(JSON.stringify({ cols, sections, counts }));`;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HELM_'))), HELM_DATA: dir, NODE_ENV: 'test', HELM_CLAUDE_PATH: '/bin/false' };
  const res = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { env, encoding: 'utf8' });
  return JSON.parse(res.trim().split('\n').pop()!);
}
