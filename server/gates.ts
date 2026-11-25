import { all, get, run } from './db.ts';
import { addTaskMessage } from './tasks.ts';
import type { Row } from './db.ts';
import { z } from 'zod';
import { commandGroup, commandText } from './commandgroups.ts';
import { doneWhenItems, doneWhenTicks } from './taskstatus.ts';
import { namedPaths } from './affects.ts';
import { touchesOf } from './subagents.ts';
import { knowledgeOn } from './knowledge.ts';
import { noteFixedErrors } from './fixreminder.ts';
import { relatedLines, relatedOn } from './related.ts';

/**
 * Helm's rules as gates rather than prompt lines: each refuses a call with what to do, and lets it through once that is
 * done. Finishing a task (complete_task) needs its named check run, every "Done when" item
 * ticked or explained, a preview on a UI task, and the errors got past written down (or why not). Scheduling a task
 * needs its touches list; the director's new task names related past work (or says none was found).
 */

export type Unmet = { item: number; why: string };

const parse = (s: unknown): Row => {
  try {
    return JSON.parse(String(s)) ?? {};
  } catch {
    return {};
  }
};

/** Programs a check's command starts with; a backticked span starting otherwise (a path, a name) is not a command. */
const PROGRAMS = /^(npm|npx|pnpm|yarn|node|cargo|nix|nix-build|bash|sh|make|just|pytest|python3?|go|deno|bun|tsc|vitest|jest|playwright|\.\/\S+)$/;
const BARE = /\b(npm (?:test|t|run [\w:.-]+)|node --test(?: +[\w./*-]+\.m?[jt]s)+|cargo (?:test|build|check|clippy)(?: +--?[\w-]+)*|nix build(?: +[\w.#/-]+)*|bash [\w./-]+\.sh|pytest(?: +[\w./:-]+)*|go test(?: +[\w./-]+)*)/g;

/** The shell commands a task's check names (backticked or bare), placeholders like <rev> cut off. Pure. */
export function checkCommands(check: string): string[] {
  const text = String(check ?? '');
  const out: string[] = [];
  const add = (c: string) => {
    const s = c.replace(/\s*<[^>]*>.*$/, '').replace(/\s+/g, ' ').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  for (const span of spans) {
    for (const part of span.split(/\s*(?:&&|;|\|\|)\s*/)) {
      const first = part.trim().split(/\s+/)[0] ?? '';
      if (PROGRAMS.test(first)) add(part);
    }
  }
  const rest = text.replace(/`[^`]*`/g, ' ');
  for (const m of rest.matchAll(BARE)) add(m[1]);
  return out;
}

/** Whether the check asks for screenshots (a preview posted on the task shows them). */
export const checkWantsShots = (check: string) => /screenshot|\bshots?\b|before\/after|\bpreview/i.test(String(check ?? ''));

/** Whether a command that ran is the check's command: it contains it, or (node --test) names each of its files. */
export function ranCheck(ran: string, check: string): boolean {
  const r = commandText(ran).replace(/\s+/g, ' ');
  if (r.includes(check)) return true;
  if (/^node --test /.test(check) && /\bnode\b[^&;|]*--test/.test(r)) {
    const files = check.split(' ').filter((w) => /\.m?[jt]s$/.test(w));
    return files.length > 0 && files.every((f) => r.includes(f));
  }
  const g = commandGroup(check);
  return g.key !== 'other' && /\s/.test(g.key) && commandGroup(r).key === g.key;
}

/** The agents working on a task: whoever has it as its current task, its driver, their subagents. */
const taskAgents = (t: Row, callerId: string): string[] =>
  [...new Set([callerId, ...(t.driver_agent_id ? [String(t.driver_agent_id)] : []), ...all('SELECT id FROM agents WHERE task_id = ?', t.id).map((a) => String(a.id))])];

/** Shell commands those agents ran since the task started (their Bash calls). */
function commandsRun(t: Row, agents: string[]): string[] {
  const since = Number(t.started_at ?? t.created_at ?? 0);
  const marks = agents.map(() => '?').join(',');
  return all(`SELECT data FROM events WHERE agent_id IN (${marks}) AND kind = 'tool' AND ts >= ? AND data LIKE '%"name":"Bash"%' ORDER BY id`, ...agents, since).map((e) => {
    const d = parse(e.data);
    const input = parse(d.input);
    if (typeof input.command === 'string') return input.command;
    // The input is clipped at 4000 characters: take the command out of the text.
    const m = /"command":\s*"((?:[^"\\]|\\.)*)/.exec(String(d.input ?? ''));
    return m ? m[1].replace(/\\n/g, '\n').replace(/\\(.)/g, '$1') : String(d.summary ?? '');
  });
}

const hasPreview = (t: Row) => !!get('SELECT 1 AS x FROM previews WHERE task_id = ? LIMIT 1', t.id);

/** Whether the task changes the web app: its touches, else the paths its text names, include web/src. */
export function isUiTask(t: Row): boolean {
  const own = touchesOf(t);
  const paths = own.length ? own : namedPaths(`${t.title}\n${t.description ?? ''}`);
  return paths.some((p) => /(^|\/)web\/src(\/|$)/.test(p.replace(/^\.\//, '')));
}

/**
 * Why the task may not be finished yet, as one message listing everything still to do, or null. `unmet`: the "Done
 * when" items not met, each with why; `noNoteWhy`: why the errors got past need no knowledge note.
 */
export function finishGate(t: Row, callerId: string, opts: { unmet?: Unmet[]; noNoteWhy?: string; checkNotRun?: string } = {}): string | null {
  const todo: string[] = [];
  const agents = taskAgents(t, callerId);
  // Its named check.
  const check = String(t.check_how ?? '').trim();
  const cmds = checkCommands(check);
  if (cmds.length) {
    const ran = commandsRun(t, agents);
    const missing = cmds.filter((c) => !ran.some((r) => ranCheck(r, c)));
    // A check that cannot run here (another host, a 40-minute script, loosely worded) is let through with why.
    if (missing.length && !opts.checkNotRun?.trim()) todo.push(`Run its check: ${missing.map((c) => `\`${c}\``).join(', ')} (no run of ${missing.length === 1 ? 'it' : 'them'} on this task yet), or pass check_not_run with one line on why it cannot run here.`);
  }
  const shots = check && checkWantsShots(check);
  const ui = isUiTask(t);
  if ((shots || ui) && !hasPreview(t)) {
    todo.push(`Post a preview on it (post_preview${t.id ? ` task ${t.id}` : ''}): ${shots ? 'its check asks for screenshots' : 'it changes the web app (web/src)'}.`);
  }
  // Done when: every item ticked or explained.
  const items = doneWhenItems(t.description);
  if (items.length) {
    const ticks = doneWhenTicks(t);
    const explained = (opts.unmet ?? []).filter((u) => u.why?.trim()).map((u) => u.item);
    const open = items.map((text, i) => ({ n: i + 1, text })).filter((x) => !ticks.includes(x.n) && !explained.includes(x.n));
    if (open.length) {
      todo.push(`"Done when" items not ticked: ${open.map((x) => `${x.n}. ${x.text.slice(0, 80)}`).join('; ')}. Tick the met ones (report_status done_when, all met numbers), and pass unmet [{ item, why }] for the rest.`);
    }
  }
  // Errors got past in this task, not written down.
  if (knowledgeOn(t.project_id) && !opts.noNoteWhy?.trim()) {
    noteFixedErrors(callerId);
    const marks = agents.map(() => '?').join(',');
    const since = Number(t.started_at ?? t.created_at ?? 0);
    const fixed = all(`SELECT agent_id, text, at FROM fix_reminders WHERE scope = ? AND agent_id IN (${marks}) ORDER BY at`, t.id, ...agents);
    const unnoted = fixed.filter(
      (f) => !get("SELECT 1 AS x FROM knowledge_notes WHERE project_id = ? AND (added_agent = ? OR updated_agent = ?) AND updated_at >= ? LIMIT 1", t.project_id, f.agent_id, f.agent_id, since),
    );
    if (unnoted.length) {
      todo.push(`You got past ${unnoted.map((f) => `"${String(f.text).slice(0, 120)}"`).join(' and ')} on this task: record the error and the fix with note_knowledge, or pass no_note_why (one line) if it would not trip the next agent.`);
    }
  }
  if (!todo.length) return null;
  return `Not completed yet. Before you finish:\n${todo.map((x, i) => `${i + 1}. ${x}`).join('\n')}`;
}

/** Why a task may not be Scheduled without a touches list, or null. */
export function touchesGate(touches: string[] | undefined): string | null {
  if (touches?.some((p) => p.trim())) return null;
  return 'A Scheduled task lists what it touches: pass touches, the files or globs it will change (e.g. ["server/tools.ts", "web/src/home.tsx"]). The builder runs tasks side by side only when their lists do not overlap. Nothing was changed.';
}

const RELATED_REF = /\[\[(task|disc|kn)_[0-9a-z]+\]\]|related past work|none found/i;

/**
 * Why the director's new task (outside a quick fix) must name related past work, or null: when Helm finds related
 * tasks or decisions, the description references at least one ([[id]]), says "Related past work", or "none found".
 */
export function relatedGate(projectId: string, title: string, description: string): string | null {
  if (RELATED_REF.test(description) || !relatedOn(projectId)) return null;
  const lines = relatedLines({ id: '', project_id: projectId, title, description, kind: 'task' });
  if (!lines.length) return null;
  return `Name related past work in the description: Helm finds\n${lines.join('\n')}\nReference what applies ([[id]], or a knowledge note [[kn_…]]) and what it means for this task, or write "Related past work: none found" if none applies. Nothing was created.`;
}

/** complete_task's extra arguments and the line its description carries. */
export const UNMET_ARG = z
  .array(z.object({ item: z.number().int().min(1), why: z.string().min(1).max(300) }))
  .max(40)
  .optional()
  .describe('"Done when" items not met (their numbers), each with one line on why');
export const CHECK_NOT_RUN_ARG = z.string().max(300).optional().describe('Only when the named check cannot run where you are (another host, a very long script): one line on why. It is posted in the task\'s thread and counted');
/** A finish that skipped the check: the why goes in the task's thread and on the task, for telemetry (task_telemetry.check_not_run). */
export function recordCheckNotRun(t: Row, why: string | undefined) {
  const w = why?.trim();
  if (!w) return;
  run('UPDATE tasks SET check_not_run = ? WHERE id = ?', w, t.id);
  addTaskMessage(t, { author: 'system', name: 'Helm' }, `Check not run: ${w}`, 'state');
}
export const NO_NOTE_ARG = z.string().max(300).optional().describe('Only when Helm lists errors you got past: one line on why they need no knowledge note');
export const FINISH_GATES =
  'Helm refuses it until the task\'s check has run (a command it names, run on this task; a preview when it asks for screenshots), (or check_not_run with why), every "Done when" item is ticked or passed in unmet with why, a UI task (web/src) has a preview, and errors you got past are recorded with note_knowledge (or no_note_why).';
