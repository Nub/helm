// The ranked search's full-text index (search.ts, searchindex.ts): its tables, the views that say what text each kind
// of item gives it, and the triggers that keep it current. Applied by db.ts at every start, so it exists in every
// process that opens the database (the runner and the web service of a split install both write the sources, and a
// trigger fires for whichever connection writes). Additive only: it reads the source tables and never changes them.
//
// Design: one ordinary FTS5 table, `search_fts` (title, body, more), plus `search_rows` mapping each FTS row to its
// source row and to the item a search shows for it. Ordinary rather than contentless or external-content because the
// one-line snippet and highlights come from FTS's highlight(), which needs the text, and the text comes from nine
// tables (no single content table to point at). The copy is small next to the sources.
//
// Indexed: tasks and discussions (title, description, status summary, conclusion) and their thread messages; Spec
// entries (title, summary, body, tags, section path); previews (title, caption, text content); reports (title, body,
// triage note); journal entries; knowledge notes (title, text, topic, paths); dashboards (title, the user's description)
// and their tiles (title, caption, text, recipe; dependencies and kind as extras); agents (name, role, status line) and their
// final reports and errors; the chat with the director (the user's messages and its replies).
//
// One FTS row per source row: an item's own row (title and its main text) and, for tasks and discussions, one row per
// thread message, for agents one per final report or error. A search ranks rows and keeps each item's best row, so a
// long thread neither drowns its task's title nor needs re-indexing as a whole when one message is added.
//
// Tokenizer: porter over unicode61 with remove_diacritics 2. Porter so "searching", "searches" and "searched" find
// one another (the point of the change); its over-stemming of English is a fair price in a dashboard written in
// English, and a phrase in quotes still matches only those words in that order. remove_diacritics so "resume" finds
// "résumé".
//
// Columns of search_fts: title (weighted well above the rest), body (an item's own text), more (weighted lowest: a
// thread message, an agent's final report or error, a Spec entry's tags and section path). A word met only in one
// message of a long thread, or in one of a director's hundreds of reports, says less about the item than its own text.

/** Bump when a view or trigger changes: every process drops and recreates them, and the index is rebuilt. */
export const SEARCH_SCHEMA_VERSION = 3;

const NL = 'char(10)';

/** A message the user wrote in the chat with the director (as discussions.ts isPlainUserMessage). */
const CHAT_USER = `e.kind = 'inbound' AND json_extract(e.data, '$.from.kind') = 'user'
  AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = e.agent_id AND a.parent_id IS NOT NULL)
  AND coalesce(json_extract(e.data, '$.text'), '') != ''
  AND NOT (${['agent-report', 'user-answer', 'helm-note', 'task-message', 'discussion-message', 'toolbox-question'].map((t) => `json_extract(e.data, '$.text') GLOB '<${t}[^a-z-]*'`).join(' OR ')})`;
/**
 * A director's end-of-turn reply to the user (web/src/api.ts inConversation): dialogue, not replaced. Only replies the
 * runtime marked as dialogue (turns.ts routeTurn); older ones without the mark stay the director's final reports.
 */
const CHAT_REPLY = `e.kind = 'result' AND json_extract(e.data, '$.ok') AND json_extract(e.data, '$.dialogue')
  AND NOT coalesce(json_extract(e.data, '$.replaced'), 0) AND coalesce(json_extract(e.data, '$.text'), '') != ''
  AND EXISTS (SELECT 1 FROM agents a WHERE a.id = e.agent_id AND a.parent_id IS NULL)`;

/** Each source: its views give src, src_id, kind (of the item shown), item, project_id, title, body, more. */
const VIEWS: Record<string, string> = {
  task: `SELECT 'task' AS src, id AS src_id, 'task' AS kind, id AS item, project_id, title,
    description || ${NL} || status_summary || ${NL} || conclusion AS body, '' AS more FROM tasks`,
  msg: `SELECT 'msg' AS src, m.id AS src_id, 'task' AS kind, m.task_id AS item, t.project_id, '' AS title, '' AS body, m.body AS more
    FROM task_messages m JOIN tasks t ON t.id = m.task_id`,
  doc: `SELECT 'doc' AS src, d.id AS src_id, 'doc' AS kind, d.id AS item, d.project_id, d.title,
    d.summary || ${NL} || d.body AS body,
    (CASE WHEN json_valid(d.tags) THEN (SELECT group_concat(value, ' ') FROM json_each(d.tags)) ELSE d.tags END)
      || ${NL} || coalesce(s3.name || ' ', '') || coalesce(s2.name || ' ', '') || coalesce(s1.name, '') AS more,
    d.section_id
    FROM docs d LEFT JOIN doc_sections s1 ON s1.id = d.section_id LEFT JOIN doc_sections s2 ON s2.id = s1.parent_id
    LEFT JOIN doc_sections s3 ON s3.id = s2.parent_id`,
  // A preview's text: its caption, and what it holds as text (markdown, text; a guide's steps and outcome; a
  // comparison's labels and captions). Images, video, HTML and charts give only their title and caption.
  preview: `SELECT 'preview' AS src, id AS src_id, 'preview' AS kind, id AS item, project_id, title,
    caption || ${NL} || coalesce(CASE
      WHEN kind IN ('markdown', 'text') THEN content
      WHEN kind = 'guide' AND json_valid(content) THEN
        (SELECT group_concat(json_extract(value, '$.text'), ${NL}) FROM json_each(content, '$.steps')) || ${NL} || coalesce(json_extract(content, '$.expect'), '')
      WHEN kind = 'compare' AND json_valid(content) THEN
        coalesce(json_extract(content, '$.before.label'), '') || ' ' || coalesce(json_extract(content, '$.before.caption'), '') || ${NL}
          || coalesce(json_extract(content, '$.after.label'), '') || ' ' || coalesce(json_extract(content, '$.after.caption'), '')
    END, '') AS body, '' AS more FROM previews`,
  report: `SELECT 'report' AS src, id AS src_id, 'report' AS kind, id AS item, project_id, title,
    body || ${NL} || triage_note AS body, '' AS more FROM reports`,
  journal: `SELECT 'journal' AS src, id AS src_id, 'journal' AS kind, CAST(id AS TEXT) AS item, project_id, title, body, '' AS more FROM journal`,
  // A knowledge note (knowledge.ts): its topic and the paths it names go with the extras.
  knowledge: `SELECT 'knowledge' AS src, id AS src_id, 'knowledge' AS kind, id AS item, project_id, title, body,
    topic || ${NL} || (CASE WHEN json_valid(paths) THEN (SELECT group_concat(value, ' ') FROM json_each(paths)) ELSE paths END) AS more
    FROM knowledge_notes`,
  // A dashboard (dashboards.ts): its title and what the user asked it to show.
  dash: `SELECT 'dash' AS src, id AS src_id, 'dashboard' AS kind, id AS item, project_id, title, description AS body, '' AS more FROM dashboards`,
  // A tile is an item of its own (it opens full screen on its dashboard): caption, a text tile's text, the recipe.
  tile: `SELECT 'tile' AS src, id AS src_id, 'dashboard' AS kind, id AS item, project_id, title,
    caption || ${NL} || coalesce(CASE WHEN kind = 'text' AND json_valid(data) THEN json_extract(data, '$.markdown') END, '')
      || ${NL} || coalesce(CASE WHEN json_valid(recipe) THEN coalesce(json_extract(recipe, '$.command'), '') || ' ' || coalesce(json_extract(recipe, '$.notes'), '') END, '') AS body,
    kind || ' ' || grp || ${NL} || coalesce(CASE WHEN json_valid(deps) THEN (SELECT group_concat(value, ' ') FROM json_each(deps, '$.paths')) END, '') AS more
    FROM tiles`,
  agent: `SELECT 'agent' AS src, id AS src_id, 'agent' AS kind, id AS item, project_id, name AS title,
    role_id || ${NL} || status_line AS body, '' AS more FROM agents`,
  // An agent's final reports and errors (the transcript keeps them as JSON). A director's replies to the user are the
  // chat's (below), not its final reports.
  ev: `SELECT 'ev' AS src, e.id AS src_id, 'agent' AS kind, e.agent_id AS item, e.project_id, '' AS title,
    '' AS body, coalesce(json_extract(e.data, '$.text'), json_extract(e.data, '$.message'), '') AS more
    FROM events e WHERE e.kind IN ('result', 'error') AND json_valid(e.data) AND NOT coalesce((${CHAT_REPLY}), 0)`,
  // The chat with the director: what the user said in it (not thread messages, answers or Toolbox questions, which
  // arrive tagged) and the director's replies to the user. Each message is an item of its own.
  chat: `SELECT 'chat' AS src, e.id AS src_id, 'chat' AS kind, CAST(e.id AS TEXT) AS item, e.project_id, '' AS title,
    json_extract(e.data, '$.text') AS body, '' AS more
    FROM events e WHERE json_valid(e.data) AND ((${CHAT_USER}) OR (${CHAT_REPLY}))`,
};
export const SEARCH_SOURCES = Object.keys(VIEWS);

/** The statements that (re)index the rows of view `src` selected by `cond` (on the view's columns). */
export function upsertSql(src: string, cond: string): string {
  const v = `search_src_${src}`;
  return `
    INSERT INTO search_rows (src, src_id, kind, item, project_id) SELECT src, src_id, kind, item, project_id FROM ${v} WHERE ${cond}
      ON CONFLICT (src, src_id) DO UPDATE SET kind = excluded.kind, item = excluded.item, project_id = excluded.project_id;
    DELETE FROM search_fts WHERE rowid IN (SELECT r.id FROM search_rows r WHERE r.src = '${src}' AND r.src_id IN (SELECT src_id FROM ${v} WHERE ${cond}));
    INSERT INTO search_fts (rowid, title, body, more) SELECT r.id, v.title, v.body, v.more FROM ${v} v
      JOIN search_rows r ON r.src = '${src}' AND r.src_id = v.src_id WHERE ${cond.replace(/\bsrc_id\b/g, 'v.src_id').replace(/\bsection_id\b/g, 'v.section_id')};`;
}
/** The statements that drop the row of source row `id` of `src`. */
function removeSql(src: string, id: string): string {
  return `
    DELETE FROM search_fts WHERE rowid IN (SELECT id FROM search_rows WHERE src = '${src}' AND src_id = ${id});
    DELETE FROM search_rows WHERE src = '${src}' AND src_id = ${id};`;
}

/** Each source table, the columns whose change re-indexes it, and its view. */
const TABLES: { src: string; table: string; cols: string; when?: string }[] = [
  { src: 'task', table: 'tasks', cols: 'title, description, status_summary, conclusion, project_id' },
  { src: 'msg', table: 'task_messages', cols: 'body, task_id' },
  { src: 'doc', table: 'docs', cols: 'title, summary, body, tags, section_id, project_id' },
  { src: 'preview', table: 'previews', cols: 'title, caption, content, kind, project_id' },
  { src: 'report', table: 'reports', cols: 'title, body, triage_note, project_id' },
  { src: 'journal', table: 'journal', cols: 'title, body, project_id' },
  { src: 'knowledge', table: 'knowledge_notes', cols: 'topic, title, body, paths, project_id' },
  { src: 'dash', table: 'dashboards', cols: 'title, description, project_id' },
  { src: 'tile', table: 'tiles', cols: 'title, caption, data, recipe, deps, grp, kind, project_id' },
  { src: 'agent', table: 'agents', cols: 'name, role_id, status_line, project_id' },
  { src: 'ev', table: 'events', cols: 'data, kind', when: "NEW.kind IN ('result', 'error')" },
  { src: 'chat', table: 'events', cols: 'data, kind', when: "NEW.kind IN ('inbound', 'result')" },
];

/** The views and triggers, created fresh (after dropping any older ones). */
export function searchSchemaSql(): string {
  const out: string[] = [];
  for (const [src, sql] of Object.entries(VIEWS)) out.push(`DROP VIEW IF EXISTS search_src_${src};`, `CREATE VIEW search_src_${src} AS ${sql};`);
  for (const { src, table, cols, when } of TABLES) {
    for (const op of ['ins', 'upd', 'del']) out.push(`DROP TRIGGER IF EXISTS search_${src}_${op};`);
    const w = when ? ` WHEN ${when}` : '';
    out.push(`CREATE TRIGGER search_${src}_ins AFTER INSERT ON ${table}${w} BEGIN ${upsertSql(src, 'src_id = NEW.id')} END;`);
    // An update drops the old row first: an event that stops being a report, or a row the view no longer selects.
    out.push(`CREATE TRIGGER search_${src}_upd AFTER UPDATE OF ${cols} ON ${table} BEGIN ${removeSql(src, 'OLD.id')} ${upsertSql(src, 'src_id = NEW.id')} END;`);
    out.push(`CREATE TRIGGER search_${src}_del AFTER DELETE ON ${table} BEGIN ${removeSql(src, 'OLD.id')} END;`);
  }
  // A section renamed or moved changes the path of every entry under it (sections nest at most three levels).
  out.push('DROP TRIGGER IF EXISTS search_section_upd;');
  const under = `(section_id = NEW.id OR section_id IN (SELECT id FROM doc_sections WHERE parent_id = NEW.id)
    OR section_id IN (SELECT id FROM doc_sections WHERE parent_id IN (SELECT id FROM doc_sections WHERE parent_id = NEW.id)))`;
  out.push(`CREATE TRIGGER search_section_upd AFTER UPDATE OF name, parent_id ON doc_sections BEGIN ${upsertSql('doc', under)} END;`);
  return out.join('\n');
}

/** The tables: created once, never dropped by an upgrade (a rebuild empties them). */
export const SEARCH_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS search_rows (
  id INTEGER PRIMARY KEY,
  src TEXT NOT NULL,
  src_id NOT NULL,
  kind TEXT NOT NULL,
  item TEXT NOT NULL,
  project_id TEXT NOT NULL,
  UNIQUE (src, src_id)
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(title, body, more, tokenize = 'porter unicode61 remove_diacritics 2');
CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
