import { all, db, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';
import { getChoice } from './settings.ts';

/**
 * Nothing is lost when a session's context is summarised (Claude Code compacts it when it fills).
 *
 * - Before: when a turn ends with the context past SAVE_AT of its window, the agent is given one short turn to save
 *   what must survive (saveNote): durable facts to the Knowledge page, decisions to the journal, open threads to its
 *   task's status summary; the director also files what the user asked for that is not yet in a task. The SDK's
 *   PreCompact hook cannot hold a turn of its own (it runs inside the summarising step), so the turn comes ahead of
 *   it; the hook records whether it did (`saved_first`).
 * - After: the SDK's compact_boundary message is recorded (context_summaries: when, context before and after) and the
 *   agent is told in two lines what was saved and that its earlier history is searchable (find kind history, mine).
 * - The usage page lists the summaries (summariesView).
 */

db.exec(`CREATE TABLE IF NOT EXISTS context_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  at INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  pre_tokens INTEGER,
  post_tokens INTEGER,
  saved_first INTEGER NOT NULL DEFAULT 0,
  saved TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS context_summaries_project ON context_summaries(project_id, at);`);

/** The share of the context window past which a turn's end asks for the save. */
export const SAVE_AT = 0.8;

/**
 * The window the director's session is summarised at (setting director_context; at least the SDK's 100k minimum), or
 * null for the model's whole window. Every turn re-reads the whole context, so a long-lived director at ~1M tokens
 * spent most of its tokens re-reading; its knowledge, journal and searchable history carry what matters past a summary.
 */
export function directorWindow(projectId: string): number | null {
  const v = Number(getChoice(projectId, 'director_context'));
  return Number.isFinite(v) && v > 0 ? Math.max(100_000, v) : null;
}

/** The context a main-thread API call used: input, cache reads and writes (what the window holds). */
export function contextOf(usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } | undefined): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}

/** Whether a turn that ended with `context` of `window` should be followed by the save turn. */
export const shouldAskSave = (context: number, window: number, askedAt: number | null | undefined) => !askedAt && window > 0 && context >= SAVE_AT * window;

/** The save turn's message. */
export function saveNote(agent: Row, context: number, window: number): string {
  const pct = Math.round((context / window) * 100);
  const lines = [
    `<helm-note kind="context">Your context is ${pct}% full; Claude will soon summarise it, and detail not saved elsewhere goes from your session. Take one short turn now to save what must survive, then carry on:`,
    `- durable facts about the project (commands, where things live, pitfalls): note_knowledge;`,
    `- decisions made and why: log_journal;`,
    agent.task_id ? `- where your task stands and its open threads: set your task's status (report_status, and the task's summary if you can).` : `- open threads: in the task or discussion they belong to.`,
  ];
  if (!agent.parent_id) lines.push(`- anything the user asked for that is not yet in a task or discussion: file it now.`);
  lines.push(`Keep it short: only what you would need after the summary. Your full history stays searchable (find kind history, mine: true).</helm-note>`);
  return lines.join('\n');
}

/** What an agent saved since `since`: knowledge notes, journal entries, status summaries, tasks and discussions filed. */
export function savedSince(agent: Row, since: number): { knowledge: number; journal: number; summaries: number; tasks: number } {
  const n = (sql: string, ...p: unknown[]) => Number(get(sql, ...p)?.n ?? 0);
  return {
    knowledge: n('SELECT COUNT(*) AS n FROM knowledge_notes WHERE updated_agent = ? AND updated_at >= ?', agent.id, since),
    journal: n('SELECT COUNT(*) AS n FROM journal WHERE agent_id = ? AND ts >= ?', agent.id, since),
    summaries: n("SELECT COUNT(*) AS n FROM task_messages WHERE kind = 'summary' AND author_name = ? AND created_at >= ?", agent.name, since),
    tasks: agent.parent_id ? 0 : n("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND origin = 'director' AND created_at >= ?", agent.project_id, since),
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A summary happened (compact_boundary): record it with what was saved since the save turn was asked for (or in the
 * last hour, when it came before the agent was asked), and return the two-line note for the agent.
 */
export function recordSummary(agent: Row, meta: { trigger?: string; pre_tokens?: number; post_tokens?: number }, askedAt: number | null): string {
  const since = askedAt ?? now() - 3600_000;
  const saved = savedSince(agent, since);
  run(
    'INSERT INTO context_summaries (project_id, agent_id, task_id, at, trigger, pre_tokens, post_tokens, saved_first, saved) VALUES (?,?,?,?,?,?,?,?,?)',
    agent.project_id, agent.id, agent.task_id ?? null, now(), meta.trigger ?? 'auto', meta.pre_tokens ?? null, meta.post_tokens ?? null, askedAt ? 1 : 0, JSON.stringify(saved),
  );
  touchProject(agent.project_id);
  const parts = [saved.knowledge && plural(saved.knowledge, 'knowledge note'), saved.journal && plural(saved.journal, 'journal entry', 'journal entries'), saved.summaries && plural(saved.summaries, 'status summary', 'status summaries'), saved.tasks && plural(saved.tasks, 'task')].filter(Boolean);
  const k = (n?: number) => (n ? `${Math.round(n / 1000)}k` : '?');
  return (
    `<helm-note kind="context">Your context was just summarised (${k(meta.pre_tokens)} → ${k(meta.post_tokens)} tokens). Saved before it: ${parts.length ? parts.join(', ') : 'nothing'}.\n` +
    `Your earlier history is searchable: find with kind history and mine: true brings back any message, tool call or result the summary dropped.</helm-note>`
  );
}

/** The usage lines' list (the Helm page): context summaries, newest first, across projects or of one. */
export function summariesView(projectId: string | null, limit = 10): Row[] {
  return all(
    `SELECT s.id, s.project_id, p.name AS project_name, s.agent_id, a.name AS agent_name, s.task_id, s.at, s.trigger, s.pre_tokens, s.post_tokens, s.saved_first, s.saved
       FROM context_summaries s LEFT JOIN agents a ON a.id = s.agent_id LEFT JOIN projects p ON p.id = s.project_id
      ${projectId ? 'WHERE s.project_id = ?' : ''} ORDER BY s.at DESC LIMIT ?`,
    ...(projectId ? [projectId] : []), limit,
  ).map((r) => ({ ...r, saved: JSON.parse(r.saved || '{}') }));
}
