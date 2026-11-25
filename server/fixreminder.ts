import { all, db, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { knowledgeOn } from './knowledge.ts';
import { errorLine, errorSignature, selfExplaining } from './rework.ts';

/**
 * Write the fix down. An agent hit an error new to its task and later got past it (a later call of the same tool
 * succeeded): at the end of that turn it is noted here, and its next message ends with a reminder to record the error
 * and the fix with note_knowledge, so the next agent does not trip on it. Once per error, at most PER_TASK per task;
 * never for Helm's own refusals (rework.ts selfExplaining, Helm's tools), quick helpers or a builder's subagents.
 */

db.exec(`
-- An error an agent got past in a task (scope: the task id, '' for none), and whether it was reminded to record it.
CREATE TABLE IF NOT EXISTS fix_reminders (
  agent_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  sig TEXT NOT NULL,
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, scope, sig)
);
`);

export const PER_TASK = 2;
export const FIX_TEXT = 'If this would trip the next agent, record it with note_knowledge (one line: the error and the fix).';

const parse = (s: string): Row => {
  try {
    return JSON.parse(s) ?? {};
  } catch {
    return {};
  }
};

/** The end of an agent's turn: note the errors it got past that it has not been reminded of. Returns how many. */
export function noteFixedErrors(agentId: string): number {
  const a = get('SELECT * FROM agents WHERE id = ?', agentId);
  if (!a || a.quick || a.role_id === 'subagent' || !knowledgeOn(a.project_id)) return 0;
  const scope = String(a.task_id ?? '');
  const since = scope ? Number(get('SELECT started_at FROM tasks WHERE id = ?', scope)?.started_at ?? 0) : 0;
  const done = all('SELECT sig FROM fix_reminders WHERE agent_id = ? AND scope = ?', agentId, scope).map((r) => String(r.sig));
  if (done.length >= PER_TASK) return 0;
  const tools = new Map<string, string>();
  const errs = new Map<string, { text: string; tool: string; last: number }>();
  const lastOk = new Map<string, number>();
  const events = all("SELECT id, kind, data FROM events WHERE agent_id = ? AND ts >= ? AND kind IN ('tool', 'tool_result') ORDER BY id", agentId, since);
  for (const e of events) {
    const d = parse(String(e.data));
    if (e.kind === 'tool') {
      tools.set(String(d.id), String(d.name ?? ''));
      continue;
    }
    if (d.sub) continue;
    const tool = tools.get(String(d.id)) ?? '';
    if (!(d.error === true || d.error === 1)) {
      lastOk.set(tool, Number(e.id));
      continue;
    }
    const text = String(d.text ?? '');
    const sig = errorSignature(text);
    if (!sig || !tool || selfExplaining(text, tool)) continue;
    const prev = errs.get(sig);
    errs.set(sig, { text: prev?.text ?? text, tool, last: Number(e.id) });
  }
  let added = 0;
  for (const [sig, x] of errs) {
    if (done.length + added >= PER_TASK) break;
    if (done.includes(sig) || (lastOk.get(x.tool) ?? 0) < x.last) continue;
    run('INSERT OR IGNORE INTO fix_reminders (agent_id, scope, sig, text, at) VALUES (?,?,?,?,?)', agentId, scope, sig, (errorLine(x.text) ?? x.text).slice(0, 200), now());
    added++;
  }
  return added;
}

/** The reminder for the agent's next message ('' when none waits); each is given once. */
export function takeFixReminder(agentId: string): string {
  const rows = all('SELECT scope, sig, text FROM fix_reminders WHERE agent_id = ? AND delivered = 0 ORDER BY at', agentId);
  if (!rows.length) return '';
  run('UPDATE fix_reminders SET delivered = 1 WHERE agent_id = ? AND delivered = 0', agentId);
  const what = rows.map((r) => `"${r.text}"`).join(' and ');
  return `\n<helm-note kind="knowledge">You got past ${what} earlier. ${FIX_TEXT}</helm-note>`;
}
