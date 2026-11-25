import { SCRATCH } from '../testenv.ts';
// Search speed at scale: a copy of a Helm database (read-only source), optionally made `factor` times bigger by
// copying every project's items and transcripts, then the index built from nothing and a fixed set of queries timed.
//   node server/checks/searchbench.check.ts <helm.db> [factor, default 10] [--write]
// Prints index size, build time and query times (p50, p95, max over every query and run, warm). --write saves the
// result in server/searchbench.json, which the Helm page shows. Fails (exit 1) when the p95 is over TARGET_MS.
import { DatabaseSync, backup } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const TARGET_MS = 50;
const [src, factorArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const write = process.argv.includes('--write');
const factor = Math.max(1, Number(factorArg ?? 10));
if (!src) {
  console.error('usage: searchbench.check.ts <helm.db> [factor] [--write]');
  process.exit(2);
}
const from = new DatabaseSync(src, { readOnly: true });
await backup(from, `${SCRATCH}/helm.db`);
from.close();

const dbm = await import('../db.ts');
const { db, all, get } = dbm;
await import('../history.ts');
const { requestSearchRebuild, buildSearchIndexNow, searchIndexStatus } = await import('../searchindex.ts');
const { searchItems } = await import('../search.ts');

// ---------- make it bigger ----------

const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
/** Copy every row of `table` k times: text ids get a suffix, `refs` (columns naming copied rows) the same suffix. */
function multiply(table: string, k: number, opts: { textId?: boolean; refs?: string[] } = {}) {
  const cs = cols(table);
  const keep = cs.filter((c) => !(c === 'id' && !opts.textId));
  const sel = keep.map((c) => (c === 'id' || opts.refs?.includes(c) ? `CASE WHEN ${c} IS NULL THEN NULL ELSE ${c} || '_x${k}' END` : c));
  db.exec(`INSERT INTO ${table} (${keep.join(', ')}) SELECT ${sel.join(', ')} FROM ${table} WHERE ${opts.textId ? "id NOT LIKE '%\\_x%' ESCAPE '\\'" : 'id <= ' + (get(`SELECT MAX(id) AS m FROM ${table}`)!.m ?? 0)}`);
}
const t0 = performance.now();
if (factor > 1) {
  db.exec('PRAGMA foreign_keys = OFF');
  // Copies are made with the index's triggers off; the index is rebuilt from nothing below.
  const triggers = all("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'");
  for (const t of triggers) db.exec(`DROP TRIGGER ${t.name}`);
  const maxIds = Object.fromEntries(['task_messages', 'journal', 'events'].map((t) => [t, Number(get(`SELECT MAX(id) AS m FROM ${t}`)?.m ?? 0)]));
  db.exec('BEGIN');
  for (let k = 1; k < factor; k++) {
    multiply('agents', k, { textId: true, refs: ['parent_id', 'task_id'] });
    multiply('tasks', k, { textId: true, refs: ['driver_agent_id', 'doc_id'] });
    multiply('docs', k, { textId: true });
    multiply('previews', k, { textId: true, refs: ['agent_id'] });
    multiply('reports', k, { textId: true, refs: ['external_id'] });
    multiply('knowledge_notes', k, { textId: true });
    // Integer ids: only the original rows are copied each time.
    for (const [t, refs] of [['task_messages', ['task_id']], ['journal', ['agent_id', 'task_id', 'doc_id']], ['events', ['agent_id']]] as const) {
      const cs = cols(t).filter((c) => c !== 'id');
      db.exec(`INSERT INTO ${t} (${cs.join(', ')}) SELECT ${cs.map((c) => ((refs as readonly string[]).includes(c) ? `CASE WHEN ${c} IS NULL THEN NULL ELSE ${c} || '_x${k}' END` : c)).join(', ')} FROM ${t} WHERE id <= ${maxIds[t]}`);
    }
  }
  db.exec('COMMIT');
  for (const t of triggers) db.exec(t.sql);
  db.exec('PRAGMA foreign_keys = ON');
}
const copyMs = performance.now() - t0;

// ---------- build ----------

requestSearchRebuild();
const b0 = performance.now();
buildSearchIndexNow();
const buildMs = performance.now() - b0;
const st = searchIndexStatus();
// --save=<file>: keep the built copy for profiling.
const save = process.argv.find((a) => a.startsWith('--save='))?.slice(7);
if (save) db.exec(`VACUUM INTO '${save.replace(/'/g, "''")}'`);
let historyBytes = 0;
try {
  historyBytes = Number(get("SELECT SUM(pgsize) AS b FROM dbstat WHERE name LIKE 'history_fts%'")?.b ?? 0);
} catch {}

// ---------- queries ----------

const project = String(get("SELECT project_id AS p FROM events GROUP BY project_id ORDER BY COUNT(*) DESC LIMIT 1")?.p);
const QUERIES = [
  'search', 'task', 'build', 'the', 'test', 'agent', 'director', 'release', 'dashboard tile', 'knowledge note', 'npm run typecheck',
  'screenshot phone', 'worktree merge', 'sessions', 'permission request', 'disk space', 'runner split', 'live update', 'spec entry',
  'brev', 'searchin', 'configura', '"ranked search"', 'node:sqlite', 'styles.css', 'tier', 'preview', 'interject', 'telemetry', 'zzzqx',
];
const times: number[] = [];
const histTimes: number[] = [];
// As the Home search asks: up to 100 of each kind, the first 5 of each marked.
const mixed = (q: string, pid: string | null) => searchItems(pid, q, { cap: 100, mark: 5 });
for (const q of QUERIES) mixed(q, project); // warm
for (let run = 0; run < 3; run++) {
  for (const q of QUERIES) {
    for (const pid of [project, null]) {
      const s = performance.now();
      mixed(q, pid);
      times.push(performance.now() - s);
    }
    const s = performance.now();
    searchItems(project, q, { kind: 'history', cap: 50 });
    histTimes.push(performance.now() - s);
  }
}
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
};
const result = {
  measured_at: new Date().toISOString().slice(0, 10),
  factor,
  events: Number(get('SELECT COUNT(*) AS n FROM events')?.n ?? 0),
  items: st.rows,
  index_mb: Math.round(((st.bytes ?? 0) + historyBytes) / 1e5) / 10,
  build_s: Math.round(buildMs / 100) / 10,
  copy_s: Math.round(copyMs / 100) / 10,
  query_ms: { p50: pct(times, 50), p95: pct(times, 95), max: pct(times, 100) },
  history_ms: { p50: pct(histTimes, 50), p95: pct(histTimes, 95), max: pct(histTimes, 100) },
  queries: times.length + histTimes.length,
};
console.log(JSON.stringify(result, null, 1));
if (write) writeFileSync(fileURLToPath(new URL('../searchbench.json', import.meta.url)), `${JSON.stringify(result, null, 1)}\n`);
const ok = result.query_ms.p95 <= TARGET_MS && result.history_ms.p95 <= TARGET_MS;
console.log(ok ? `ok   p95 within ${TARGET_MS} ms` : `FAIL p95 over ${TARGET_MS} ms`);
process.exit(ok ? 0 : 1);
