import { all } from './db.ts';
import type { Row } from './db.ts';
import { touchesOf } from './subagents.ts';
import { linkedEntries } from './specadherence.ts';
import { knowledgeForSubagent } from './knowledge.ts';
import { relatedBlock } from './related.ts';
import { attachmentPath, taskAttachments } from './attachments.ts';

/**
 * The brief Helm assembles for a fresh builder started for one task (dispatch.ts): it stands alone, since the builder
 * starts with no conversation. Telemetry records whether a task was built this way (task_telemetry.ran_fresh) so its
 * tokens and work time can be compared with the standing Builder's that held the queue before.
 */

/** Knowledge in a worker's brief: the notes most relevant to the task, within this many characters. */
export const BRIEF_KNOWLEDGE = 2000;

/** What every worker is told besides its task. */
export const WORKER_RULES = [
  'How to work:',
  '- Do this task and nothing beyond it, in the worktree you were started in.',
  '- Commit on its branch with a message naming the task id. Never merge into the main line, push, or touch other worktrees: the Builder merges and checks.',
  '- Run the check above before you report.',
  '- If the plan is wrong (the task cannot be done as written, or doing it would break something it does not mention), stop: report the evidence and your recommendation instead of improvising beyond the task.',
  '- End with one short report: what changed, the commit, the check and its result, what you did not check.',
].join('\n');

export const BRIEF_START = '----- worker brief -----';
export const BRIEF_END = '----- end of worker brief -----';

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The Spec entries a task implements, as "- Title: summary" lines. */
function specLines(t: Row): string[] {
  const ids = linkedEntries(t.id);
  if (!ids.length) return [];
  return all(`SELECT title, summary FROM docs WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY title`, ...ids).map(
    (d) => `- ${d.title}${String(d.summary ?? '').trim() ? `: ${clip(String(d.summary), 300)}` : ''}`,
  );
}

/**
 * A worker's brief for a task, between BRIEF_START and BRIEF_END: its description (Features, Done when), what it
 * touches, the Spec entries it implements, attachments, related past work, the relevant knowledge notes, the check,
 * and the standing rules.
 */
export function workerBrief(t: Row, rules = WORKER_RULES): string {
  const touches = touchesOf(t);
  const spec = specLines(t);
  const knowledge = knowledgeForSubagent(t.project_id, { task_id: t.id } as Row, BRIEF_KNOWLEDGE);
  const files = taskAttachments(t.id).map((a) => `- ${attachmentPath(a)} (${a.name})`);
  return [
    BRIEF_START,
    `Task ${t.id}: ${t.title}`,
    t.description?.trim() || '(No description: work from the title.)',
    touches.length ? `Touches: ${touches.join(', ')}` : '',
    spec.length ? `Spec entries it implements:\n${spec.join('\n')}` : '',
    files.length ? `Attached:\n${files.join('\n')}` : '',
    relatedBlock(t),
    knowledge,
    `Check: ${t.check_how?.trim() || 'none named; pick the narrowest one that shows it works, run it and say which.'}`,
    rules,
    BRIEF_END,
  ].filter(Boolean).join('\n\n');
}
