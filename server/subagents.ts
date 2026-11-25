import { all, get, newId, now, run } from './db.ts';
import { idleButBusy } from './busy.ts';
import type { Row } from './db.ts';
import { subagentLimit } from './subagentprompt.ts';
export { subagentLimit };
import { getTiers, tierName } from './tiers.ts';
import type { TierId } from './tiers.ts';
import { addEvent, getProject, setTaskLine, touchProject } from './store.ts';
import { addTaskMessage, getTask } from './tasks.ts';
import { namedPaths } from './affects.ts';

/**
 * The Builder fans out like the Claude CLI: its session gets the Agent SDK's own subagents (the `agents` option), one
 * per tier it may pick (Light, Routine, Skilled). A subagent gets a brief, works in its own context, returns one
 * result and ends; it has no Helm tools, so it never talks to the director or the user. Helm only watches:
 *
 * - The Builder's Agent calls pass a PreToolUse check (agentCallCheck): one of these types, at most the project's limit
 *   (Setup "builder_subagents", default 3) running at once, and a queued task given whole only in its own worktree.
 * - Each running subagent is a row in `agents` (role "subagent", sdk_tool_use_id = its Agent call), on the task it
 *   works for, so the task card lists it with its live action (its tool calls are its events) and its tokens count on
 *   that task at its tier (usage.ts). A row is never an agent anywhere else: it is left out of the agent limit, the
 *   area rules, list_agents, the progress check's agents and message_agent/close_agent (NOT_SUBAGENT), and once ended
 *   it is closed. It ends with the SDK's task_notification (or the call's result when it ran in the
 *   foreground), or with the Builder's session. Rows never get a session of their own: sendToAgent ignores them.
 * - A subagent works only on its builder's own task (a fresh builder has one, dispatch.ts): its row, tokens and thread
 *   lines are booked to that task and no other, whatever its brief names.
 */

export const SUBAGENT_ROLE = 'subagent';
export const SUB_TYPES: TierId[] = ['light', 'routine', 'skilled'];


const SUB_PROMPT = [
  'You are a subagent of the Builder of this project. You were given one brief: do exactly that, in the folder you were given, and nothing else.',
  'Work on your own: you cannot ask anyone anything. If the brief cannot be done as written, stop and say why.',
  'When you are working in a worktree of your own (for a whole task), commit your changes there on its branch with a message naming the task; never merge into the main line, push, or touch other worktrees.',
  'Otherwise do not commit: the Builder merges and checks your work.',
  'Run every command in the folder you were given (your worktree, when you have one), as plain separate commands: no cd into other folders, no && chains, pipes or subshells around git. Claude refuses a command it cannot verify stays inside a worktree; do not retry it as written, split it.',
  'End with one short report: what you did, the files you changed (or what you found), what you checked and what you did not.',
].join('\n');

const WHEN: Record<string, string> = {
  light: 'searching, reading, collecting facts, and mechanical edits spelled out in the brief',
  routine: 'well-defined changes of ordinary difficulty in files nobody else is editing',
  skilled: 'a real piece of building that needs judgement',
};

/** The `agents` option of a builder's session: one SDK subagent type per tier it may pick. */
export function subagentDefs(projectId: string): Record<string, { description: string; prompt: string; model: string; effort?: any; disallowedTools: string[] }> {
  if (subagentLimit(projectId) <= 0) return {};
  const out: Record<string, any> = {};
  for (const t of getTiers().filter((x) => SUB_TYPES.includes(x.id))) {
    out[t.id] = {
      description: `${t.name} tier subagent: ${WHEN[t.id]}.`,
      prompt: SUB_PROMPT,
      model: t.model,
      ...(t.effort ? { effort: t.effort } : {}),
      // No Helm tools (no director, no user) and no subagents of its own.
      disallowedTools: ['Agent', 'mcp__helm', 'AskUserQuestion'],
    };
  }
  return out;
}


/** SQL: an agents row that is a real agent, not a builder's subagent. */
export const NOT_SUBAGENT = "role_id != 'subagent'";
export const isSubagent = (a: Row | undefined) => a?.role_id === SUBAGENT_ROLE;

/** Agents of a project working now, for the agent limit: the director and subagent rows are not counted. */
export const workingAgents = (projectId: string) =>
  Number(get(`SELECT COUNT(*) AS n FROM agents WHERE project_id = ? AND parent_id IS NOT NULL AND status IN ('working', 'waiting') AND ${NOT_SUBAGENT}`, projectId)?.n ?? 0) +
  // An idle agent with work in hand (a background command, a host job, subagents, a driven task) still counts (busy.ts).
  idleButBusy(projectId, `parent_id IS NOT NULL AND ${NOT_SUBAGENT}`);

/** Subagent rows of a builder still running. */
export const openSubagents = (builderId: string) => all("SELECT * FROM agents WHERE parent_id = ? AND role_id = ? AND status = 'working'", builderId, SUBAGENT_ROLE);

/**
 * A builder is about to call the Agent tool: null to let it, or why not. On yes the subagent's row is made, so the
 * task card shows it from its first moment.
 */
export function agentCallCheck(builder: Row, toolUseId: string | undefined, input: Row): string | null {
  const limit = subagentLimit(builder.project_id);
  if (limit <= 0) return 'Subagents are off for this project (Setup). Do the work yourself.';
  const type = String(input.subagent_type ?? '');
  if (!SUB_TYPES.includes(type as TierId)) return `Start subagents with subagent_type ${SUB_TYPES.map((t) => `"${t}"`).join(', ')} (the tier: Light or Routine for searching, reading and mechanical edits; Skilled for a real piece of building). Leave model and effort unset.`;
  if (input.model || input.effort) return 'Leave model and effort unset: the subagent_type sets the tier.';
  const running = openSubagents(builder.id).length;
  if (running >= limit) return `${running} subagent(s) are already running; the limit is ${limit} at once. Wait for one to finish, or do this part yourself.`;
  // Booked to the builder's own task, never another: a builder has one task (dispatch.ts).
  const task = builder.task_id ? getTask(builder.task_id) : undefined;
  if (!task) return 'You have no task in hand: subagents work on your current task.';
  const name = `${tierName(type)} subagent: ${String(input.description ?? 'work').slice(0, 60)}`;
  const id = newId('ag');
  run(
    "INSERT INTO agents (id, project_id, parent_id, role_id, name, model, task, status, created_at, updated_at, task_id, sdk_tool_use_id, sub_tier, status_line) VALUES (?,?,?,?,?,?,?,'working',?,?,?,?,?,?)",
    id, builder.project_id, builder.id, SUBAGENT_ROLE, name, getTiers().find((t) => t.id === type)?.model ?? '', String(input.prompt ?? '').slice(0, 4000), now(), now(), task.id, toolUseId ?? null, type,
    String(input.description ?? ''),
  );
  run('UPDATE agents SET background = ? WHERE id = ?', input.run_in_background === false ? 0 : 1, id);
  addTaskMessage(task, { author: 'system', name: builder.name, id: builder.id }, `${builder.name} started a ${tierName(type)} subagent: ${String(input.description ?? '')}.`, 'state');
  touchProject(builder.project_id);
  return null;
}

/** The running subagent row for an Agent call (by its tool_use id). */
export const subagentFor = (toolUseId: string | null | undefined) =>
  toolUseId ? get("SELECT * FROM agents WHERE sdk_tool_use_id = ? AND role_id = ? ORDER BY created_at DESC LIMIT 1", toolUseId, SUBAGENT_ROLE) : undefined;

/** Progress from the SDK (task_progress): the subagent's line shows what it does now. */
export function subagentProgress(toolUseId: string | undefined, line: string) {
  const s = subagentFor(toolUseId);
  if (!s || s.status !== 'working' || !line.trim()) return;
  run('UPDATE agents SET status_line = ?, updated_at = ? WHERE id = ?', line.trim().slice(0, 300), now(), s.id);
  touchProject(s.project_id);
}

/**
 * A subagent ended (task_notification, or its foreground call returned): its row is done, with its summary, and its
 * task's thread says who did what. Returns the row, or undefined when it was not one of ours or had already ended.
 */
export function subagentEnded(toolUseId: string | undefined, status: 'completed' | 'failed' | 'stopped', summary: string): Row | undefined {
  const s = subagentFor(toolUseId);
  if (!s || s.status !== 'working') return undefined;
  run("UPDATE agents SET status = 'closed', last_result = ?, status_line = ?, finished_at = ?, updated_at = ? WHERE id = ?", summary.slice(0, 20000), status === 'completed' ? 'Finished' : status === 'failed' ? 'Failed' : 'Stopped', now(), now(), s.id);
  const t = s.task_id ? getTask(s.task_id) : undefined;
  if (t) addTaskMessage(t, { author: 'system', name: s.name, id: s.id }, `${s.name}: ${status === 'completed' ? 'finished' : status === 'failed' ? 'failed' : 'stopped'}${summary.trim() ? `. ${summary.trim().slice(0, 500)}` : '.'}`, 'state');
  // Its report is the builder's latest line on that task (only there: agent_task_status, or its own line on its own task).
  const first = summary.split('\n').map((l) => l.trim()).find(Boolean);
  if (t && s.parent_id && first) setTaskLine(s.parent_id, t.id, first.length > 160 ? `${first.slice(0, 159)}…` : first);
  touchProject(s.project_id);
  return s;
}

/** The builder's session ended or was stopped: whatever of its subagents still runs has stopped with it. */
export function endSubagentsOf(builderId: string, why = 'Stopped with the Builder') {
  for (const s of openSubagents(builderId)) {
    run("UPDATE agents SET status = 'closed', status_line = ?, finished_at = ?, updated_at = ? WHERE id = ?", why, now(), now(), s.id);
    touchProject(s.project_id);
  }
}

/** One subagent row stopped by the user (its work inside the builder's session goes on until the builder is stopped). */
export function endSubagentRow(id: string) {
  run("UPDATE agents SET status = 'closed', status_line = 'Stopped by the user', finished_at = ?, updated_at = ? WHERE id = ? AND status = 'working'", now(), now(), id);
  const s = get('SELECT project_id FROM agents WHERE id = ?', id);
  if (s) touchProject(s.project_id);
}

/** At boot no subagent runs. */
export function recoverSubagents() {
  run("UPDATE agents SET status = 'closed', status_line = 'Stopped when Helm restarted', finished_at = COALESCE(finished_at, ?), updated_at = ? WHERE role_id = ? AND status != 'closed'", now(), now(), SUBAGENT_ROLE);
}

/** Subagents that worked on a task (for the batch note). */
export const subagentsOn = (taskId: string) => Number(get('SELECT COUNT(*) AS n FROM agents WHERE task_id = ? AND role_id = ?', taskId, SUBAGENT_ROLE)?.n ?? 0);

/** A subagent's events go to its own row, so its tool calls are its live action on the task card. */
export function subagentEvent(toolUseId: string | null | undefined, kind: string, data: unknown): boolean {
  const s = subagentFor(toolUseId);
  if (!s) return false;
  addEvent(s, kind, data);
  if (s.status === 'working') run('UPDATE agents SET updated_at = ? WHERE id = ?', now(), s.id);
  return true;
}

/** Store what a task touches (create_task / update_task touches): trimmed, unique, at most 12. */
export function setTouches(taskId: string, paths: string[]) {
  const list = [...new Set(paths.map((p) => p.trim().replace(/^\.\//, '')).filter(Boolean))].slice(0, 12);
  run('UPDATE tasks SET touches = ? WHERE id = ?', JSON.stringify(list), taskId);
}

/** A task's touches list, [] when it has none. */
export function touchesOf(t: Row): string[] {
  try {
    const v = JSON.parse(String(t.touches ?? '[]'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

// Folders too broad to tell two tasks apart: a bare top-level folder, or a top-level one's src/lib/app/test.
const BROAD_SECOND = new Set(['src', 'lib', 'app', 'test', 'tests']);
const broadFolder = (p: string) => {
  const parts = p.replace(/\/+$/, '').split('/');
  if (/[.*?]/.test(parts[parts.length - 1])) return false;
  return parts.length <= 1 || (parts.length === 2 && BROAD_SECOND.has(parts[1]));
};

/** What a task touches: its touches list when it has one, else the file-level paths and deeper folders its text names. */
export function pathsOf(t: Row): string[] {
  const own = touchesOf(t);
  if (own.length) return own;
  return namedPaths(`${t.title}\n${t.description ?? ''}`).filter((p) => !broadFolder(p));
}

const isGlob = (p: string) => /[*?]/.test(p);
const literalPrefix = (p: string) => p.slice(0, p.search(/[*?]/));
const globRe = (g: string) =>
  new RegExp(`^${g.split(/(\*\*\/?|\*|\?)/).map((part) => (part.startsWith('**') ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, (c) => `\\${c}`))).join('')}$`);

/** Whether two paths (files, folders or globs) may name the same file. */
export function pathsOverlap(a: string, b: string): boolean {
  const x = a.replace(/\/+$/, '');
  const y = b.replace(/\/+$/, '');
  if (x === y) return true;
  if (isGlob(x) && isGlob(y)) {
    const px = literalPrefix(x);
    const py = literalPrefix(y);
    return px.startsWith(py) || py.startsWith(px);
  }
  if (isGlob(x)) return globRe(x).test(y) || literalPrefix(x).startsWith(`${y}/`);
  if (isGlob(y)) return globRe(y).test(x) || literalPrefix(y).startsWith(`${x}/`);
  // A folder holds what is under it.
  return x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}


export const projectOf = (agent: Row) => getProject(agent.project_id);
