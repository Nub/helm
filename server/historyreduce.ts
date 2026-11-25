import { all, db, get, now, run, tx } from './db.ts';
import { getChoice } from './settings.ts';
import { dateText } from './clock.ts';
import { historySize } from './history.ts';

/**
 * The stored history compacts too. Agents' transcripts older than the project's "history_keep_days" (Setup, default
 * 30) are reduced: tool results are dropped and tool calls lose their full input (their name and what they acted on
 * stay), and each agent's reduced stretch keeps one note saying what was dropped, in the place of its first result.
 * Messages (what was said to and by agents, their reports) stay whole. Tasks, the Spec, the journal, knowledge and the
 * chat are other tables, never touched here. The runner runs it once a day; the Disk page shows what the history
 * takes and when it was last reduced (reduceState).
 */

db.exec('CREATE TABLE IF NOT EXISTS history_reduce (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const DAY = 86_400_000;
/** Days of full history a project keeps (0: never reduced). */
export const keepDays = (projectId: string) => Number(getChoice(projectId, 'history_keep_days')) || 0;

export type ReduceResult = { at: number; results: number; calls: number; bytesBefore: number; bytesAfter: number };

/** Reduce every project's history older than its keep period. Returns what was done. */
export function reduceHistory(at = now()): ReduceResult {
  const before = historySize().bytes;
  let results = 0;
  let calls = 0;
  for (const p of all('SELECT id FROM projects')) {
    const days = keepDays(p.id);
    if (!days) continue;
    const cutoff = at - days * DAY;
    for (const a of all("SELECT DISTINCT agent_id FROM events WHERE project_id = ? AND ts < ? AND kind = 'tool_result'", p.id, cutoff)) {
      tx(() => {
        const old = all("SELECT id, ts FROM events WHERE agent_id = ? AND ts < ? AND kind = 'tool_result' ORDER BY id", a.agent_id, cutoff);
        if (!old.length) return;
        const tools = all(
          "SELECT json_extract(data, '$.name') AS name, COUNT(*) AS n FROM events WHERE agent_id = ? AND ts < ? AND kind = 'tool' GROUP BY name ORDER BY n DESC LIMIT 6",
          a.agent_id, cutoff,
        );
        const text = `History reduced: ${old.length} tool result${old.length === 1 ? '' : 's'} from ${dateText(old[0].ts)} to ${dateText(old[old.length - 1].ts)} were dropped (older than ${days} days); the messages and the tool calls (${tools.map((t) => `${t.name} ${t.n}`).join(', ')}) stay.`;
        run("UPDATE events SET kind = 'note', data = ? WHERE id = ?", JSON.stringify({ text, reduced: true }), old[0].id);
        run(`DELETE FROM events WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(old.slice(1).map((r) => r.id)));
        results += old.length;
        // Tool calls keep their name and summary; the full input goes.
        calls += Number(
          run("UPDATE events SET data = json_remove(data, '$.input') WHERE agent_id = ? AND ts < ? AND kind = 'tool' AND json_extract(data, '$.input') IS NOT NULL", a.agent_id, cutoff).changes ?? 0,
        );
      });
    }
  }
  const out: ReduceResult = { at, results, calls, bytesBefore: before, bytesAfter: historySize().bytes };
  run("INSERT OR REPLACE INTO history_reduce (key, value) VALUES ('last', ?)", JSON.stringify(out));
  return out;
}

/** The Disk page's line: what the history takes, its index, and the last reduction. */
export function reduceState(): { events: number; bytes: number; indexBytes: number | null; last: ReduceResult | null } {
  const r = get("SELECT value FROM history_reduce WHERE key = 'last'");
  return { ...historySize(), last: r ? (JSON.parse(r.value) as ReduceResult) : null };
}

let timer: NodeJS.Timeout | null = null;
/** Runner: reduce once a day (checked hourly, so a restart does not skip or repeat a day). */
export function startHistoryReduce() {
  if (timer) return;
  const tick = () => {
    try {
      const last = reduceState().last;
      if (!last || now() - last.at > 20 * 3600_000) {
        const r = reduceHistory();
        if (r.results || r.calls) console.log(`History: reduced ${r.results} tool results and ${r.calls} tool calls (${Math.round((r.bytesBefore - r.bytesAfter) / 1e6)} MB).`);
      }
    } catch (err) {
      console.error('History reduction failed:', err);
    }
  };
  timer = setInterval(tick, 3600_000);
  timer.unref?.();
  setTimeout(tick, 60_000).unref?.();
}
export function stopHistoryReduce() {
  if (timer) clearInterval(timer);
  timer = null;
}
