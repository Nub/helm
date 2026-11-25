import { all, get, now } from './db.ts';
import type { Row } from './db.ts';
import { commandGroup } from './commandgroups.ts';

/**
 * Whether an agent between model turns still has work in hand, and what it waits on. An agent that ended its turn
 * (status idle) counts as busy, and shows Working with this reason as its status line, while any of these hold:
 * - a background command it started is still running (commands.ts running_commands);
 * - it holds a claim on a host (a job running there);
 * - a subagent of its own is still running (subagents.ts);
 * - it waits on a review or question it asked its manager (consults);
 * - it drives an Active task (a builder or driver between turns).
 * Waiting on the user stays its own state (status waiting), and done, closed and error rows are left as they are.
 * One place decides it: agent views (store.ts agentView) and the agent limit (subagents.ts workingAgents) use it.
 */

/** A command older than this is taken as lost (the runner restarted), as hasRunningCommands does. */
const COMMAND_STALE_MS = 2 * 3600_000;

export function busyReason(a: Row): string | null {
  if (a.status !== 'idle') return null;
  const inHand = workInHand(a);
  if (inHand) return inHand;
  if (a.parent_id) {
    const t = get("SELECT title FROM tasks WHERE driver_agent_id = ? AND state = 'active' AND kind = 'task' ORDER BY started_at LIMIT 1", a.id);
    if (t) return `On ${String(t.title).slice(0, 80)}`;
  }
  return null;
}

/**
 * Work an idle agent has in hand beyond driving a task: a running command, a host claim, a subagent, a consult. The
 * watchdog (watchdog.ts) counts a task's agents as busy on this, never on merely driving it.
 */
export function workInHand(a: Row): string | null {
  // The table is the runner's (commands.ts); a process that never loaded it has no commands to show.
  let cmd: Row | undefined;
  try {
    cmd = get('SELECT * FROM running_commands WHERE session_agent_id = ? AND ended_at IS NULL AND started_at > ? ORDER BY started_at LIMIT 1', a.id, now() - COMMAND_STALE_MS);
  } catch {
    cmd = undefined;
  }
  if (cmd) {
    const what = String(cmd.label || cmd.command || 'a command').replace(/^cd \S+\s*&&\s*/, '').replace(/\s+/g, ' ').slice(0, 80);
    return `Waiting on ${what}${cmd.host_name ? ` on ${cmd.host_name}` : ''}`;
  }
  const claim = get('SELECT c.activity, h.name FROM host_claims c LEFT JOIN hosts h ON h.id = c.host_id WHERE c.agent_id = ? ORDER BY c.updated_at DESC LIMIT 1', a.id);
  if (claim) return `Waiting on ${String(claim.activity || 'a job').replace(/\s+/g, ' ').slice(0, 80)}${claim.name ? ` on ${claim.name}` : ''}`;
  const subs = all("SELECT name FROM agents WHERE parent_id = ? AND role_id = 'subagent' AND status = 'working' ORDER BY created_at", a.id);
  if (subs.length === 1) return `Waiting on subagent: ${subName(subs[0].name)}`;
  if (subs.length) return `Waiting on ${subs.length} subagents`;
  const consult = get("SELECT kind FROM consults WHERE asker_id = ? AND status = 'open' ORDER BY created_at LIMIT 1", a.id);
  if (consult) return consult.kind === 'review' ? 'Waiting on a review' : 'Waiting on an answer from its manager';
  return null;
}

/** A subagent row's name is "<Tier> subagent: <description>": the description. */
const subName = (name: unknown) => String(name ?? '').replace(/^\w+ subagent:\s*/, '').slice(0, 80) || 'a subagent';

const parse = (s: unknown): Row => {
  try {
    return JSON.parse(String(s)) ?? {};
  } catch {
    return {};
  }
};

/** How long something has run, short: "40 s", "3 min", "1 h 5 min". */
export function ranFor(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

const FILE_TOOLS: Record<string, string> = { Read: 'Read', Edit: 'Edit', MultiEdit: 'Edit', Write: 'Write', NotebookEdit: 'Edit', Grep: 'Search for', Glob: 'Find files', WebFetch: 'Fetch', WebSearch: 'Search the web for' };

/**
 * The status line Helm derives from what an agent is doing right now, and since when: its newest tool call without a
 * result (its own, not a subagent's). A shell command reads as its description or its intent (commandgroups.ts) and how
 * long it has run ("Build in release mode · 3 min"); the Agent tool as the subagent it waits on; a file tool as what it
 * does to which file. Null when no call is open. Helm's own tools (report_status and the like) give no line.
 */
export function toolLine(agentId: string, taskId?: string | null, at = now()): { line: string; since: number } | null {
  const last = get("SELECT ts, data FROM events WHERE agent_id = ? AND kind = 'tool' AND data NOT LIKE '%\"sub\":true%' ORDER BY id DESC LIMIT 1", agentId);
  if (!last) return null;
  const d = parse(last.data);
  if (!d.id || get("SELECT 1 AS x FROM events WHERE agent_id = ? AND kind = 'tool_result' AND ts >= ? AND data LIKE ? LIMIT 1", agentId, last.ts, `%"id":"${d.id}"%`)) return null;
  const name = String(d.name ?? '');
  const input = parse(d.input);
  let since = Number(last.ts);
  let what = '';
  if (name === 'Bash') {
    let cmd: Row | undefined;
    try {
      cmd = get('SELECT command, label, started_at FROM running_commands WHERE id = ?', String(d.id));
    } catch {
      cmd = undefined;
    }
    if (cmd) since = Number(cmd.started_at);
    const command = String(cmd?.command ?? input.command ?? d.summary ?? '');
    what = String(cmd?.label || input.description || '').trim() || commandGroup(command).intent;
  } else if (name === 'Agent' || name === 'Task') {
    // A builder's call that started a subagent for another task shows on that task (subagentLine), not here.
    const sub = get("SELECT task_id FROM agents WHERE sdk_tool_use_id = ? AND role_id = 'subagent' LIMIT 1", String(d.id));
    if (sub && taskId && sub.task_id !== taskId) return null;
    what = `Waiting on subagent: ${String(input.description ?? d.summary ?? 'a subagent').slice(0, 80)}`;
  } else if (FILE_TOOLS[name]) {
    const target = String(d.summary ?? '').split('/').slice(-2).join('/');
    what = `${FILE_TOOLS[name]}${target ? ` ${target}` : ''}`;
  } else if (/^mcp__helm__/.test(name)) return null;
  else what = name.replace(/^mcp__([^_]+)__/, '$1: ').replace(/_/g, ' ');
  what = what.replace(/\s+/g, ' ').slice(0, 120);
  return what ? { line: `${what} · ${ranFor(at - since)}`, since } : null;
}

/** The line a task an agent runs alongside shows (a builder's): its working subagent on it, or null. */
export function subagentLine(agentId: string, taskId: string): { line: string; since: number } | null {
  const s = get("SELECT name, status_line, created_at, updated_at FROM agents WHERE parent_id = ? AND task_id = ? AND role_id = 'subagent' AND status = 'working' ORDER BY created_at DESC LIMIT 1", agentId, taskId);
  if (!s) return null;
  const desc = subName(s.name);
  const line = String(s.status_line ?? '').trim();
  return { line: line && line !== desc ? `Subagent: ${line.slice(0, 120)}` : `Waiting on subagent: ${desc}`, since: Number(s.updated_at ?? s.created_at) };
}

/**
 * The agent as views show it. An idle agent with work in hand reads Working, its reason as the status line. A working
 * agent shows the line derived from its current tool (toolLine), unless it set a line itself (report_status) after
 * that tool started.
 */
export function withBusy(a: Row): Row {
  if (a.status === 'working') {
    const live = toolLine(a.id, a.task_id);
    if (live && !(Number(a.status_at ?? 0) > live.since)) return { ...a, status_line: live.line, status_derived: 1 };
    return a;
  }
  const why = busyReason(a);
  return why ? { ...a, status: 'working', status_line: why, busy_between_turns: 1 } : a;
}

/** Agents of a project with work in hand between turns (idle rows only), for counts that must agree with the views. */
export const idleButBusy = (projectId: string, where = '1 = 1') =>
  all(`SELECT * FROM agents WHERE project_id = ? AND status = 'idle' AND ${where}`, projectId).filter((a) => busyReason(a) !== null).length;
