import { hostname } from 'node:os';
import { db, get, now, run, tx } from './db.ts';
import { SEARCH_SOURCES, upsertSql } from './searchschema.ts';
import { buildHistoryNow, buildHistoryStep, historyReady, resetHistoryIndex } from './history.ts';

// Building the ranked search's index (searchschema.ts) for data that existed before it, and rebuilding it on request.
// New writes are indexed by triggers from the moment the schema exists; this fills in the rest, source by source in
// small batches, each in its own transaction, recording where it got to (search_meta 'cursor:<src>'), so it never holds
// up startup or a writer for long, and an interrupted build resumes where it stopped. Every batch is an upsert from
// the source rows as they are at that moment, so re-indexing a row a trigger already did is harmless (idempotent).
// When every source is done it marks the index ready (search_meta 'ready'); until then searches use word matching.
//
// Exactly one process builds: the one that calls startSearchIndex (the runner; in one-process mode, the one process),
// and a lease in search_meta keeps a second caller (a restart overlapping the old process) from building at once.

const BATCH = 200;
const LEASE_MS = 60_000;
const me = `${hostname()}:${process.pid}`;

const meta = (key: string) => get('SELECT value FROM search_meta WHERE key = ?', key)?.value as string | undefined;
const setMeta = (key: string, value: string) => run('INSERT OR REPLACE INTO search_meta (key, value) VALUES (?,?)', key, value);

/** Read from the database each time: the builder may be another process. */
export const searchIndexReady = () => meta('ready') === '1';

export type SearchIndexStatus = { ready: boolean; history: boolean; rows: number; building: boolean; sources: number; done: number; bytes: number | null };

/** What the Helm page shows: ready or building (with how far), and the index's size on disk. */
export function searchIndexStatus(): SearchIndexStatus {
  const rows = Number(get('SELECT COUNT(*) AS n FROM search_rows')?.n ?? 0);
  const done = SEARCH_SOURCES.filter((s) => meta(`cursor:${s}`) === 'done').length;
  let bytes: number | null = null;
  try {
    // dbstat is compiled into most builds; without it the size is left out.
    bytes = Number(get("SELECT SUM(pgsize) AS b FROM dbstat WHERE name LIKE 'search_%' OR name LIKE 'sqlite_autoindex_search_%'")?.b ?? 0);
  } catch {
    bytes = null;
  }
  const lease = meta('lease');
  return { ready: searchIndexReady(), history: historyReady(), rows, building: !!lease && Number(lease.split('@')[1]) > now(), sources: SEARCH_SOURCES.length, done, bytes };
}

/**
 * The maintenance action: empty the index and build it again. Searches use word matching until it is done. Safe from
 * either process: the builder (startSearchIndex) sees the index is not ready at its next look.
 */
export function requestSearchRebuild() {
  tx(() => {
    run('DELETE FROM search_fts');
    run('DELETE FROM search_rows');
    run("DELETE FROM search_meta WHERE key LIKE 'cursor:%' OR key = 'ready'");
  });
  resetHistoryIndex();
  poke?.();
}

/** Take or renew the build lease; false if another process holds it. */
function lease(): boolean {
  return tx(() => {
    const held = meta('lease');
    if (held) {
      const [who, until] = held.split('@');
      if (who !== me && Number(until) > now()) return false;
    }
    setMeta('lease', `${me}@${now() + LEASE_MS}`);
    return true;
  });
}

const TABLE: Record<string, string> = { task: 'tasks', msg: 'task_messages', doc: 'docs', preview: 'previews', report: 'reports', journal: 'journal', knowledge: 'knowledge_notes', dash: 'dashboards', tile: 'tiles', agent: 'agents', ev: 'events', chat: 'events' };

/**
 * One step of the build: index the next batch of one source. Returns false when there is nothing left to do (the index
 * is ready), true when it should be called again.
 */
export function buildStep(batch = BATCH): boolean {
  if (searchIndexReady()) return false;
  const src = SEARCH_SOURCES.find((s) => meta(`cursor:${s}`) !== 'done');
  if (!src) {
    tx(() => {
      // Merge the segments written batch by batch into one, for faster queries.
      run("INSERT INTO search_fts (search_fts) VALUES ('optimize')");
      setMeta('ready', '1');
    });
    return false;
  }
  tx(() => {
    const cursor = meta(`cursor:${src}`);
    // Integer ids (messages, journal, events) and text ids both go in the order of the source's primary key.
    const ids = (cursor === undefined
      ? db.prepare(`SELECT id FROM ${TABLE[src]} ORDER BY id LIMIT ${batch}`).all()
      : db.prepare(`SELECT id FROM ${TABLE[src]} WHERE id > ? ORDER BY id LIMIT ${batch}`).all(JSON.parse(cursor))) as { id: string | number }[];
    if (ids.length) {
      const list = JSON.stringify(ids.map((r) => r.id)).replace(/'/g, "''");
      db.exec(upsertSql(src, `src_id IN (SELECT value FROM json_each('${list}'))`));
    }
    setMeta(`cursor:${src}`, ids.length < batch ? 'done' : JSON.stringify(ids[ids.length - 1].id));
  });
  return true;
}

let timer: NodeJS.Timeout | null = null;
let poke: (() => void) | null = null;

/**
 * Keep the index built: build what is missing a batch at a time, yielding to the event loop between batches, then
 * look once a minute for a rebuild requested from the other process. Call it in one process only.
 */
export function startSearchIndex(onError: (err: unknown) => void = (err) => console.error('Search index:', err)) {
  if (timer) return;
  let started = 0;
  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
    timer.unref?.();
  };
  const tick = () => {
    let again = false;
    try {
      // The transcripts' index (history.ts) builds once the work items are searchable.
      if (searchIndexReady() && !historyReady() && lease()) {
        if (!started) started = Date.now();
        again = buildHistoryStep();
        if (!again) {
          console.log(`History index: built in ${Date.now() - started} ms.`);
          started = 0;
          run('DELETE FROM search_meta WHERE key = ? AND value LIKE ?', 'lease', `${me}@%`);
          // Then the transcripts, without waiting for the next minute.
          again = !historyReady();
        }
      } else if (!searchIndexReady() && lease()) {
        if (!started) started = Date.now();
        again = buildStep();
        if (!again) {
          console.log(`Search index: built (${get('SELECT COUNT(*) AS n FROM search_rows')?.n} rows) in ${Date.now() - started} ms.`);
          started = 0;
          run('DELETE FROM search_meta WHERE key = ? AND value LIKE ?', 'lease', `${me}@%`);
        }
      }
    } catch (err) {
      onError(err);
    }
    schedule(again ? 0 : 60_000);
  };
  poke = () => schedule(0);
  schedule(0);
}

export function stopSearchIndex() {
  if (timer) clearTimeout(timer);
  timer = null;
  poke = null;
}

/** Tests and measurements: build all of it now. */
export function buildSearchIndexNow() {
  while (buildStep());
  buildHistoryNow();
}
