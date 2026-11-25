import { all, db, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { buildMatch, markRoots, markText } from './rankedsearch.ts';

/**
 * Agents' full transcripts in the search, as kind "history": every message, tool call (in plain words: its name and
 * what it acted on) and tool result (trimmed), so `find` and the Home search reach detail a context summary dropped.
 *
 * A full-text table of its own (history_fts, one row per event, rowid = the event's id), apart from the ranked
 * index of work items (searchschema.ts): a project's transcripts are tens of times bigger than everything else, and
 * keeping them out of search_fts keeps the main ranked query as fast as before however much history grows. A history
 * query walks matches newest first (ORDER BY rowid DESC, which FTS5 answers without sorting) and ranks only the first
 * HISTORY_WINDOW of them by bm25 and age, so its cost depends on that window, not on the size of the history.
 *
 * Kept current by triggers on events; built for older events a batch at a time by buildHistoryStep (called from the
 * search index's timer, searchindex.ts), its cursor in search_meta ('hist:cursor', 'hist:ready').
 */

const KINDS = "('inbound', 'text', 'tool', 'tool_result', 'result', 'note', 'error')";
/** The text of an event in the history index: tool calls in plain words, results trimmed. */
const TEXT = `CASE e.kind
  WHEN 'tool' THEN coalesce(json_extract(e.data, '$.name'), '') || ' ' || coalesce(json_extract(e.data, '$.summary'), '')
  WHEN 'tool_result' THEN substr(coalesce(json_extract(e.data, '$.text'), ''), 1, 600)
  WHEN 'error' THEN coalesce(json_extract(e.data, '$.message'), '')
  ELSE substr(coalesce(json_extract(e.data, '$.text'), ''), 1, 6000) END`;
const insertSql = (where: string) =>
  `INSERT OR REPLACE INTO history_fts (rowid, body, project_id, agent_id, kind) SELECT e.id, ${TEXT}, e.project_id, e.agent_id, e.kind FROM events e WHERE e.kind IN ${KINDS} AND json_valid(e.data) AND ${where}`;

db.exec(`
CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(body, project_id UNINDEXED, agent_id UNINDEXED, kind UNINDEXED, tokenize = 'porter unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS history_ins AFTER INSERT ON events BEGIN ${insertSql('e.id = NEW.id')}; END;
CREATE TRIGGER IF NOT EXISTS history_upd AFTER UPDATE OF data, kind ON events BEGIN DELETE FROM history_fts WHERE rowid = OLD.id; ${insertSql('e.id = NEW.id')}; END;
CREATE TRIGGER IF NOT EXISTS history_del AFTER DELETE ON events BEGIN DELETE FROM history_fts WHERE rowid = OLD.id; END;
`);

const meta = (key: string) => get('SELECT value FROM search_meta WHERE key = ?', key)?.value as string | undefined;
const setMeta = (key: string, value: string) => run('INSERT OR REPLACE INTO search_meta (key, value) VALUES (?,?)', key, value);
export const historyReady = () => meta('hist:ready') === '1';

const BATCH = 500;
/** One batch of the build for events from before the index existed; false when done. */
export function buildHistoryStep(batch = BATCH): boolean {
  if (historyReady()) return false;
  return tx(() => {
    const from = Number(meta('hist:cursor') ?? 0);
    const ids = db.prepare(`SELECT id FROM events WHERE id > ? ORDER BY id LIMIT ${batch}`).all(from) as { id: number }[];
    if (!ids.length) {
      run("INSERT INTO history_fts (history_fts) VALUES ('optimize')");
      setMeta('hist:ready', '1');
      return false;
    }
    const last = ids[ids.length - 1].id;
    db.exec(insertSql(`e.id > ${from} AND e.id <= ${last}`));
    setMeta('hist:cursor', String(last));
    return true;
  });
}
export function buildHistoryNow() {
  while (buildHistoryStep());
}
/** Empty and build again (with the search index's rebuild). */
export function resetHistoryIndex() {
  tx(() => {
    run('DELETE FROM history_fts');
    run("DELETE FROM search_meta WHERE key IN ('hist:cursor', 'hist:ready')");
  });
}


export type HistoryHit = { event: number; agent_id: string; agent_name: string; project_id: string; kind: string; ts: number; text: string; hl: string; score: number };

/**
 * History matching every word of `query` (as the ranked search: other word forms, the last word as a prefix), in a
 * project (or every project not archived) and optionally one agent's own (its subagents' too), newest first. Not
 * ranked by bm25: that needs each word's frequency over the whole history, which grows with it; newest first is what
 * FTS5 answers by walking the index backwards and stopping at the limit, so it stays fast however big history gets.
 */
/** What a mixed list takes from history: the work in between (what agents said, did and got back), not the messages, reports and chat other kinds already show. */
export const WORK_KINDS = ['text', 'tool', 'tool_result', 'note'];

export function searchHistory(projectId: string | null, query: string, opts: { agentId?: string; limit?: number; kinds?: string[] } = {}): HistoryHit[] {
  const m = buildMatch(query);
  if (!m) return [];
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const agents = opts.agentId ? [opts.agentId, ...all("SELECT id FROM agents WHERE parent_id = ? AND role_id = 'subagent'", opts.agentId).map((r) => String(r.id))] : null;
  const scope = [
    projectId ? 'AND project_id = ?' : 'AND project_id IN (SELECT id FROM projects WHERE archived = 0)',
    agents ? 'AND agent_id IN (SELECT value FROM json_each(?))' : '',
    opts.kinds ? 'AND kind IN (SELECT value FROM json_each(?))' : '',
  ].join(' ');
  try {
    const rows = all(
      `SELECT rowid AS id, agent_id, project_id, body FROM history_fts WHERE history_fts MATCH ? ${scope} ORDER BY rowid DESC LIMIT ${limit}`,
      m.all, ...(projectId ? [projectId] : []), ...(agents ? [JSON.stringify(agents)] : []), ...(opts.kinds ? [JSON.stringify(opts.kinds)] : []),
    );
    if (!rows.length) return [];
    const ev = new Map(all(`SELECT e.id, e.kind, e.ts, a.name FROM events e JOIN agents a ON a.id = e.agent_id WHERE e.id IN (SELECT value FROM json_each(?))`, JSON.stringify(rows.map((r) => r.id))).map((r) => [Number(r.id), r]));
    const roots = markRoots(query);
    return rows.map((r) => {
      const e = ev.get(Number(r.id));
      return { event: Number(r.id), agent_id: String(r.agent_id), agent_name: String(e?.name ?? ''), project_id: String(r.project_id), kind: String(e?.kind ?? ''), ts: Number(e?.ts ?? now()), hl: markText(String(r.body ?? ''), roots), text: String(r.body ?? ''), score: 0 };
    });
  } catch (err) {
    console.error('History search failed:', (err as Error).message);
    return [];
  }
}

/** How each event kind reads in a hit's title. */
export const EVENT_LABEL: Record<string, string> = { inbound: 'message to', text: 'said by', tool: 'tool call by', tool_result: 'tool result for', result: 'report by', note: 'note on', error: 'error of' };

/** What the history takes: its events' size, and its index's (null without dbstat). */
export function historySize(): { events: number; bytes: number; indexBytes: number | null } {
  const r = get('SELECT COUNT(*) AS n, COALESCE(SUM(length(data)), 0) AS b FROM events');
  let indexBytes: number | null = null;
  try {
    indexBytes = Number(get("SELECT SUM(pgsize) AS b FROM dbstat WHERE name LIKE 'history_fts%'")?.b ?? 0);
  } catch {}
  return { events: Number(r?.n ?? 0), bytes: Number(r?.b ?? 0), indexBytes };
}

export type { Row };
