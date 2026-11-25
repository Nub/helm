import { all, db, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { getSetting } from './settings.ts';

/**
 * Short output. What agents write for someone else to read (a worker's final report, a review request, a question to
 * its manager, the director's reply to the user and its thread posts) has a budget of visible length. Agents are told
 * the rule in their prompt and in the tool descriptions; when a text is over its budget anyway, Helm asks the agent once
 * to cut it (not to move it elsewhere: what the reader does not need is simply not written; they ask for more). A
 * second over-budget attempt is delivered as written, never blocked or split, and counted on the agent
 * (agents.brevity_over) so its manager sees who ignores the budget. Tool calls, code and commit messages are untouched.
 *
 * The per-project setting "Short replies" (settings.ts, key brevity) turns the budgets off (full: today's lengths).
 * State lives in the database (brevity_asks, result events), so it holds across processes and restarts.
 */

export type Budget = { chars: number; lines: number };
/** From the live data (Nov 2026): worker reports had a median of 2,572 characters, directors' replies 540. */
export const BUDGETS = {
  /** A worker's final report, a review request, a question to its manager. */
  report: { chars: 600, lines: 8 },
  /** The director's reply to the user and its posts in task and discussion threads. */
  reply: { chars: 500, lines: 7 },
} satisfies Record<string, Budget>;
export type BudgetKind = keyof typeof BUDGETS;

/** The rule, in the words agents are given. */
export const RULE =
  'Say only the outcome, the evidence that matters, what you did not check and what you need. Do not add detail in case it is wanted: you will be asked.';
export const SHAPE = (b: Budget) =>
  `Lead with the outcome in one or two sentences, then at most five short bullets. Keep it under ${b.chars} characters and ${b.lines} lines: no file-by-file lists, test inventories, measurement tables or lists of what you removed unless asked.`;

export const NOTE_TAG = '<helm-note kind="brevity">';

db.exec(`
-- An agent was asked once to cut an over-budget review request, question or thread post (kind); its next attempt goes through.
CREATE TABLE IF NOT EXISTS brevity_asks (
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, kind)
);
`);
{
  const cols = db.prepare('PRAGMA table_info(agents)').all() as { name: string }[];
  // How many times the agent delivered over budget after it was asked to cut.
  if (!cols.some((c) => c.name === 'brevity_over')) db.exec('ALTER TABLE agents ADD COLUMN brevity_over INTEGER NOT NULL DEFAULT 0');
  // How many times it sent a long message saying the reader had asked for the detail (recorded, not counted against it).
  if (!cols.some((c) => c.name === 'brevity_detail')) db.exec('ALTER TABLE agents ADD COLUMN brevity_detail INTEGER NOT NULL DEFAULT 0');
}

/** An ask older than this is forgotten: the next over-budget text is a new attempt, asked about again. */
const ASK_TTL_MS = 60 * 60 * 1000;

export const shortOn = (projectId: string) => getSetting(projectId, 'brevity');

/** Visible length: characters of the trimmed text, and its non-blank lines. */
export function measure(text: string): { chars: number; lines: number } {
  const t = text.trim();
  return { chars: t.length, lines: t ? t.split('\n').filter((l) => l.trim()).length : 0 };
}

/** The measurement when `text` is over the budget, else null. */
export function over(text: string, kind: BudgetKind): { chars: number; lines: number; budget: Budget } | null {
  const m = measure(text);
  const budget = BUDGETS[kind];
  return m.chars > budget.chars || m.lines > budget.lines ? { ...m, budget } : null;
}

const size = (m: { chars: number; lines: number; budget: Budget }) =>
  `${m.chars.toLocaleString('en-US')} characters and ${m.lines} lines; the budget is ${m.budget.chars} characters and ${m.budget.lines} lines`;

const countOver = (agentId: string) => run('UPDATE agents SET brevity_over = brevity_over + 1 WHERE id = ?', agentId);
const countDetail = (agentId: string) => run('UPDATE agents SET brevity_detail = brevity_detail + 1 WHERE id = ?', agentId);

/**
 * The reader asked for this detail (an explanation, the details, a list): a long message is then answered in full.
 * End-of-turn text says so with a first line DETAIL_MARK, which Helm strips; tools take detail_requested: true.
 */
export const DETAIL_MARK = '[detail requested]';
const ASKED_FOR =
  `The one exception: when the reader explicitly asked for this detail (an explanation, the details, a list), or the brief demands it, answer in full`;
export function stripDetail(text: string): { text: string; detail: boolean } {
  const m = /^\s*\[detail requested\][ \t]*\n?/i.exec(text);
  return m ? { text: text.slice(m[0].length), detail: true } : { text, detail: false };
}
/** Record a long message the reader asked for: kept apart from brevity_over. */
function detailAnswer(agent: Row, text: string, kind: BudgetKind): void {
  if (shortOn(agent.project_id) && over(text, kind)) countDetail(agent.id);
}

/**
 * For a review request, a question or a thread post, before it is delivered: null to deliver it, or the tool result
 * that asks the agent to cut it and call again. Asked once; the next attempt is delivered as written (and counted when
 * still over).
 */
export function checkToolText(agent: Row, kind: 'review' | 'question' | 'post', text: string, detailRequested = false): string | null {
  const budgetKind: BudgetKind = kind === 'post' ? 'reply' : 'report';
  if (detailRequested) {
    run('DELETE FROM brevity_asks WHERE agent_id = ? AND kind = ?', agent.id, kind);
    detailAnswer(agent, text, budgetKind);
    return null;
  }
  const m = shortOn(agent.project_id) ? over(text, budgetKind) : null;
  const asked = get('SELECT at FROM brevity_asks WHERE agent_id = ? AND kind = ?', agent.id, kind);
  const recent = asked && now() - Number(asked.at) < ASK_TTL_MS;
  if (asked) run('DELETE FROM brevity_asks WHERE agent_id = ? AND kind = ?', agent.id, kind);
  if (!m) return null;
  if (recent) {
    countOver(agent.id);
    return null;
  }
  run('INSERT OR REPLACE INTO brevity_asks (agent_id, kind, at) VALUES (?,?,?)', agent.id, kind, now());
  const what = kind === 'review' ? 'review request' : kind === 'question' ? 'question' : 'post';
  return (
    `Not sent: your ${what} is ${size(m)}. Cut it to what the reader needs and call again. ${RULE}` +
    (kind === 'review' ? ' In a review request: what changed and the outcome, where to look, what you verified, what you did not, your doubts; one or two lines each.' : '') +
    ` Your next attempt is sent as written. ${ASKED_FOR}: call again with detail_requested: true.`
  );
}

const resultData = (id: number): Row | null => {
  const r = get('SELECT data FROM events WHERE id = ?', id);
  return r ? JSON.parse(r.data) : null;
};
const patchResult = (id: number, patch: Row) => {
  const d = resultData(id);
  if (d) run('UPDATE events SET data = ? WHERE id = ?', JSON.stringify({ ...d, ...patch }), id);
};

/**
 * The earlier result this turn rewrites: the turn was started by Helm's brevity note and the agent's previous result
 * was held for it. Read before the new result is recorded (nextEventId: an id after the turn's inbound events).
 */
export function heldResult(agent: Row, nextEventId: number = Number.MAX_SAFE_INTEGER): { id: number; data: Row } | null {
  const prev = get("SELECT id, data FROM events WHERE agent_id = ? AND kind = 'result' AND id < ? ORDER BY id DESC LIMIT 1", agent.id, nextEventId);
  if (!prev) return null;
  const data = JSON.parse(prev.data);
  if (data.brevity !== 'asked') return null;
  // Only a turn the note started (the note is among the inbound messages since that result) rewrites it.
  const note = get("SELECT 1 AS x FROM events WHERE agent_id = ? AND kind = 'inbound' AND id > ? AND id < ? AND json_extract(data, '$.text') LIKE ? LIMIT 1", agent.id, prev.id, nextEventId, `${NOTE_TAG}%`);
  return note ? { id: Number(prev.id), data } : null;
}

const workerNote = (m: NonNullable<ReturnType<typeof over>>) =>
  `${NOTE_TAG}Your report was not delivered: it is ${size(m)}. Write it again, cut to what your manager needs. ${RULE} ${SHAPE(m.budget)} Your next reply is delivered in its place, as written. ${ASKED_FOR}: start your reply with the line ${DETAIL_MARK} and give it in full.</helm-note>`;

const replyNote = (m: NonNullable<ReturnType<typeof over>>, where: string) =>
  `${NOTE_TAG}Your last reply, shown ${where}, is ${size(m)}. Rewrite it shorter: lead with the answer, then at most a few short bullets; leave out what the user did not ask for (they will ask). Reply with the rewritten text only: it replaces the earlier reply where the user sees it. Your rewrite is shown as written. ${ASKED_FOR.replace('the reader', 'the user').replace(', or the brief demands it', '')}: reply with the line ${DETAIL_MARK} and then the full answer.</helm-note>`;

/**
 * A worker's end of turn, before its report goes to its manager. Returns the text to deliver, or a note to send the
 * worker instead (the report is held until it answers). `ok`: the turn ended normally.
 */
export function workerTurn(agent: Row, resultId: number, text: string, ok: boolean, detail = false): { deliver: string } | { note: string } {
  const held = heldResult(agent, resultId);
  if (held) {
    patchResult(held.id, { brevity: 'replaced' });
    // The rewrite, unless the turn failed or said nothing: then the report as first written.
    const rewrite = ok && text.trim() ? text : String(held.data.text ?? '');
    if (detail) detailAnswer(agent, rewrite, 'report');
    else if (shortOn(agent.project_id) && over(rewrite, 'report')) countOver(agent.id);
    return { deliver: rewrite };
  }
  if (detail) {
    detailAnswer(agent, text, 'report');
    return { deliver: text };
  }
  if (agent.quick || !ok || !shortOn(agent.project_id)) return { deliver: text };
  const m = over(text, 'report');
  if (!m) return { deliver: text };
  patchResult(resultId, { brevity: 'asked' });
  return { note: workerNote(m) };
}

/**
 * The director's end of turn, when the reply is shown to the user (in the conversation, or added to a thread as
 * `routedMessage`). Returns the note to send it, or null. The reply stays shown until the rewrite replaces it.
 */
export function directorReply(agent: Row, resultId: number, text: string, route: { dialogue: boolean; routed: string | null; message?: number | null }, detail = false): string | null {
  if (!route.dialogue && !route.routed) return null;
  if (detail) {
    detailAnswer(agent, text, 'reply');
    return null;
  }
  if (!shortOn(agent.project_id)) return null;
  const m = over(text, 'reply');
  if (!m) return null;
  patchResult(resultId, { brevity: 'asked', ...(route.message ? { routed_message: route.message } : {}) });
  return replyNote(m, route.dialogue ? 'in your conversation with the user' : 'in the thread it was added to');
}

/**
 * The director's rewrite after a brevity note: it takes the earlier reply's place (the conversation hides a replaced
 * reply; a thread post is rewritten in place). Returns the routing the new result is recorded with.
 */
export function replaceReply(agent: Row, held: { id: number; data: Row }, text: string, ok: boolean, detail = false): { dialogue: boolean; routed: string | null } {
  const body = text.trim();
  if (!ok || !body) {
    patchResult(held.id, { brevity: 'kept' });
    return { dialogue: false, routed: null };
  }
  if (detail) detailAnswer(agent, body, 'reply');
  else if (shortOn(agent.project_id) && over(body, 'reply')) countOver(agent.id);
  patchResult(held.id, { brevity: 'replaced', replaced: true });
  if (held.data.routed_message) run('UPDATE task_messages SET body = ? WHERE id = ?', body, held.data.routed_message);
  return { dialogue: !!held.data.dialogue, routed: held.data.routed ?? null };
}

/**
 * Cut `text` to at most `max` characters at a clean place: the last sentence end in the second half, else the last
 * word break (with an ellipsis). Returns the text and whether it was cut.
 */
export function cutClean(text: string, max: number): { text: string; cut: boolean } {
  const t = text.trim();
  if (t.length <= max) return { text: t, cut: false };
  const head = t.slice(0, max);
  let end = -1;
  for (const m of head.matchAll(/[.!?](?=\s|$)/g)) if (m.index! + 1 <= max) end = m.index! + 1;
  if (end >= max * 0.5) return { text: head.slice(0, end), cut: true };
  const room = t.slice(0, max - 1);
  const space = room.search(/\s\S*$/);
  return { text: `${(space > max * 0.5 ? room.slice(0, space) : room).replace(/[\s,;:–—-]+$/, '')}…`, cut: true };
}

/** The tool-result sentence telling an agent its text was cut. */
export const cutNote = (what: string, max: number) => ` Your ${what} was over ${max} characters and was cut at a sentence end; keep it shorter.`;

/** Server-side caps on short fields agents write; text over them is cut at a sentence end (cutClean) and the agent told. */
export const CAPS = { summary: 600, journalTitle: 140, journalBody: 1200, notification: 160 };
export const summaryCut = (s: string) => cutClean(s, CAPS.summary).text;

// ---------- saying the budget up front, and counting what is still refused ----------

const fmt = (b: Budget) => `${b.chars} characters and ${b.lines} lines`;
/** The budget of a tool's text, for its description: stated up front, so the first attempt fits. */
export const budgetNote = (kind: BudgetKind) => `Budget: under ${fmt(BUDGETS[kind])}, all its text fields together; count before you send.`;
/** The prompt's one-line rule, listing every budget. */
export const COUNT_RULE = `Count before you send: a report, review request or question to your manager stays under ${fmt(BUDGETS.report)}; a reply to the user or a thread post under ${fmt(BUDGETS.reply)}.`;
/** Appended to a send's tool result: the budget for the next one. */
export const nextBudget = (agent: Row, kind: BudgetKind) => (shortOn(agent.project_id) ? ` Next one: under ${fmt(BUDGETS[kind])}.` : '');

/**
 * Over-budget refusals per day (UTC), from the events: a tool text refused ("Not sent: your … is …") and a report or
 * reply sent back with Helm's brevity note. The measure of whether stating the budget up front works.
 */
export function refusalsByDay(projectId: string | null, since = 0): { day: string; n: number }[] {
  const where = projectId ? 'AND project_id = ?' : '';
  return all(
    `SELECT date(ts / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM events WHERE ts >= ? ${where} AND (
       (kind = 'tool_result' AND json_extract(data, '$.error') AND json_extract(data, '$.text') LIKE 'Not sent: your % characters and % lines; the budget is %')
       OR (kind = 'inbound' AND json_extract(data, '$.text') LIKE ?)
     ) GROUP BY day ORDER BY day`,
    ...[since, ...(projectId ? [projectId] : []), `${NOTE_TAG}%`],
  ).map((r) => ({ day: String(r.day), n: Number(r.n) }));
}
