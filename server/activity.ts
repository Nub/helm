import type { Row } from './db.ts';
import { exploring, fileOf, searchOnly } from './findingcode.ts';
import type { Query } from './findingcode.ts';
import { waitTargets, writtenTargets } from './commandgroups.ts';

/**
 * What agents spend their time and tokens on, per project: every agent's active time split by what it was doing,
 * read from the transcript's events. Pure (takes a query function); activitystats.ts keeps it per day.
 *
 * Time. An agent's events in order; each gap between two of its events within a turn (not the wait before an inbound
 * message, when it was not working) is charged to what the later event ends:
 * - a tool result: that tool call's category, from the previous event to the result (the model's thinking that led to
 *   the call plus the run, as the finding-code measure does);
 * - text or the end of a turn: thinking and writing.
 * A gap is charged at most CAP (2 min) to its category; the rest is idle, except for shell commands (a long build is
 * work, not idle; past COMMAND_IDLE_MS it is "waiting on a command": the agent has nothing else in hand), and time a
 * permission request for that agent was open, which is "waiting on the user". Every gap lands in exactly one
 * category, so the categories sum to the active time.
 *
 * Tokens (an estimate): a tool result's size into context (4 characters a token) for its category; what the model
 * wrote (text and tool inputs) for thinking and writing.
 *
 * Subagents: a builder's Agent call is "subagents (wall)" for the builder; a subagent's own events are its own agent
 * time (who = subagent), so time they ran in parallel counts once as wall time and once as agent time.
 *
 * Commands (onCommand): every shell command's run, and every piece of "waiting on commands" with the command it was
 * spent on: a foreground command's own wait, or a wait loop's time charged to the background command the agent had
 * running then (the latest started), else to the agent's earlier command that names the file the loop waits on (the
 * log or done file it wrote), else to the loop itself. So the waits per command sum to the category.
 */

export const CATEGORIES = [
  'thinking',
  'reading',
  'searching',
  'editing',
  'cmd_build',
  'cmd_test',
  'cmd_run',
  'cmd_git',
  'cmd_script',
  'cmd_other',
  'cmd_wait',
  'helm',
  'subagents',
  'other_tools',
  'waiting_user',
  'idle',
] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category, string> = {
  thinking: 'Thinking and writing',
  reading: 'Reading files',
  searching: 'Searching (finding code)',
  editing: 'Editing files',
  cmd_build: 'Commands: build',
  cmd_test: 'Commands: tests',
  cmd_run: 'Commands: run or render',
  cmd_git: 'Commands: git',
  cmd_script: 'Commands: scripts (node, python…)',
  cmd_other: 'Commands: other',
  cmd_wait: 'Waiting on commands (polling, long runs)',
  helm: "Helm's tools",
  subagents: 'Subagents (wall time)',
  other_tools: 'Other tools',
  waiting_user: 'Waiting on a permission',
  idle: 'Idle within a turn',
};

const CAP = 2 * 60_000;
/** A gap longer than this is not one turn's work (an agent left mid-turn, a restart): it is not counted at all. */
const HARD_CAP = 30 * 60_000;
/** A foreground command running longer than this: the rest is waiting with nothing else in hand. */
export const COMMAND_IDLE_MS = 60_000;
const CHARS_PER_TOKEN = 4;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const BUILD = /\b(npm run (build|typecheck)|tsc\b|vite build|cargo (build|check)|nix build|make\b|go build|gradle|cmake|ninja|esbuild|webpack)/;
const TEST = /\b(npm (run )?test|node --test|cargo test|pytest|jest|vitest|go test|check:\w+|\.check\.ts|playwright test)/;
const RUN = /\b(chromium|shoot\.mjs|scratch\.mjs|browser\.mjs|screenshot|cargo run|npm (run )?(dev|start)|node server|render|ffmpeg|blender|godot|ssh|scp|rsync)\b/;
/** Waiting in a loop for something to happen: all of its time is a wait. */
const POLL = /^\s*(until\b|while\b|sleep\b|timeout\s+\d+|for\s+\w+\s+in\b[^;]*;\s*do\b[\s\S]*\bsleep\b)/;
const SCRIPT = /^\s*(\S*\/)?(node|python3?|py3|perl|ruby|deno|bun|bash|sh)\b/;
const EDIT_SHELL = /\bsed\s+-i|\bcat\s*>|\btee\b|(^|[^0-9&2])>\s*[\w./~-]+\.(ts|tsx|js|mjs|css|json|md|rs|py|toml|yaml|yml|txt|sh)\b|\bapply_patch\b|\bpatch\b/;

/** What a shell command is, from its text (after a leading cd and variable settings). */
export function commandKind(command: string): Category {
  let c = String(command ?? '');
  for (let i = 0; i < 6; i++) {
    const next = c.replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, '').replace(/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|\$\([^)]*\)[^\s;&]*|[^\s;&]*)\s*(&&|;|\s)\s*/, '');
    if (next === c) break;
    c = next;
  }
  if (POLL.test(c)) return 'cmd_wait';
  if (searchOnly(c)) return 'searching';
  if (/^\s*git\s/.test(c) && !TEST.test(c) && !BUILD.test(c)) return 'cmd_git';
  if (TEST.test(c)) return 'cmd_test';
  if (BUILD.test(c)) return 'cmd_build';
  if (RUN.test(c)) return 'cmd_run';
  if (EDIT_SHELL.test(c)) return 'editing';
  if (SCRIPT.test(c)) return 'cmd_script';
  return 'cmd_other';
}

/** A tool call's category (Bash by its command; Read by whether the agent edited the file in the period). */
export function toolCategory(d: Row, edited: Set<string> | undefined): Category {
  const name = String(d.name ?? '');
  if (name.startsWith('mcp__helm__')) return 'helm';
  if (name === 'Bash') return commandKind(String(d.summary ?? ''));
  if (name === 'Grep' || name === 'Glob' || name === 'LS' || exploring(d)) return 'searching';
  if (name === 'Read') return edited?.has(fileOf(d)) ? 'reading' : 'searching';
  if (EDIT_TOOLS.has(name)) return 'editing';
  if (name === 'Agent' || name === 'Task') return 'subagents';
  return 'other_tools';
}
const isCommand = (c: Category) => c.startsWith('cmd_');

export type Split = Record<Category, { ms: number; tokens: number }>;
export const emptySplit = (): Split => Object.fromEntries(CATEGORIES.map((c) => [c, { ms: 0, tokens: 0 }])) as Split;

/** Who an agent is, for the filters. */
export const whoOf = (a: Row): string => (!a.parent_id ? 'director' : a.role_id === 'subagent' ? 'subagent' : a.quick ? 'helper' : a.role_id === 'builder' ? 'builder' : 'agent');

export type Bucket = { agent_id: string; who: string; tier: string; day: number; split: Split };
/**
 * One command event for the per-command view: a run (runMs, background or not) or a wait charged to it (waitedMs).
 * `agent` is the row with who and tier resolved by the caller; `ts` places it in a day.
 */
export type CommandEvent = { agent: Row; ts: number; command: string; description: string; runMs?: number; background?: boolean; waitedMs?: number };

/**
 * The split of [from, to), per agent (with who and tier) and per day (`dayOf` gives the day an instant belongs to, the
 * user's midnight). `tierOf(agent, ts)` is the tier the agent worked at then.
 */
/**
 * One charged stretch of an agent's time (activity's onSpan): its category, how long, when it ended, and the tool call it
 * belongs to (name, command and description for a shell command, whether its result was an error). The spans of a
 * period add up to its categories exactly. Per-task telemetry (tasktime.ts) is built from them.
 */
export type Span = { agent_id: string; at: number; ms: number; category: Category; tool: string | null; command: string | null; description: string | null; failed: boolean; call: string | null; background?: boolean };

export function activity(q: Query, projectId: string, from: number, to: number, dayOf: (ts: number) => number, tierOf: (agent: Row, ts: number) => string, onCommand?: (c: CommandEvent) => void, opts: { agents?: Set<string>; onSpan?: (s: Span) => void } = {}): Bucket[] {
  const agents = new Map(q('SELECT id, parent_id, role_id, quick, sub_tier, task_id FROM agents WHERE project_id = ?', projectId).map((a) => [String(a.id), a]));
  const evs = q(
    `SELECT e.agent_id, e.ts, e.kind, json_extract(e.data, '$.name') AS name, json_extract(e.data, '$.id') AS cid,
            json_extract(e.data, '$.summary') AS summary, substr(json_extract(e.data, '$.input'), 1, 600) AS input,
            CASE WHEN e.kind IN ('tool_result', 'text', 'result') THEN length(json_extract(e.data, '$.text')) ELSE 0 END AS size,
            CASE WHEN e.kind = 'tool' THEN length(json_extract(e.data, '$.input')) ELSE 0 END AS insize,
            CASE WHEN e.kind = 'tool_result' THEN substr(json_extract(e.data, '$.text'), 1, 160) END AS head,
            CASE WHEN e.kind = 'tool_result' THEN json_extract(e.data, '$.error') END AS iserr,
            CASE WHEN e.kind = 'tool' AND json_extract(e.data, '$.name') = 'Bash' AND json_valid(json_extract(e.data, '$.input')) THEN json_extract(json_extract(e.data, '$.input'), '$.command') END AS cmd,
            CASE WHEN e.kind = 'tool' AND json_extract(e.data, '$.name') = 'Bash' AND json_valid(json_extract(e.data, '$.input')) THEN json_extract(json_extract(e.data, '$.input'), '$.description') END AS descr,
            CASE WHEN e.kind = 'tool' AND json_extract(e.data, '$.name') = 'Bash' AND json_valid(json_extract(e.data, '$.input')) THEN json_extract(json_extract(e.data, '$.input'), '$.run_in_background') END AS bg
       FROM events e WHERE e.project_id = ? AND e.ts >= ? AND e.ts < ? AND json_valid(e.data)
        AND e.kind IN ('inbound', 'text', 'tool', 'tool_result', 'result') ORDER BY e.agent_id, e.id`,
    projectId, from, to,
  ).filter((e) => !opts.agents || opts.agents.has(String(e.agent_id)));
  // Files each agent edited in the period (a read of one is reading, not finding).
  const edited = new Map<string, Set<string>>();
  for (const e of evs) {
    if (e.kind === 'tool' && EDIT_TOOLS.has(String(e.name))) {
      const f = fileOf({ input: e.input, summary: e.summary });
      if (f) (edited.get(e.agent_id) ?? edited.set(e.agent_id, new Set()).get(e.agent_id)!).add(f);
    }
  }
  // Permission requests per agent: [created, answered].
  const perms = new Map<string, [number, number][]>();
  for (const p of q("SELECT agent_id, created_at, COALESCE(answered_at, created_at) AS answered_at FROM inbox WHERE project_id = ? AND kind = 'permission' AND agent_id IS NOT NULL AND created_at < ? AND COALESCE(answered_at, created_at) >= ?", projectId, to, from)) {
    (perms.get(p.agent_id) ?? perms.set(p.agent_id, []).get(p.agent_id)!).push([Number(p.created_at), Number(p.answered_at)]);
  }
  const overlap = (agent: string, a: number, b: number) => (perms.get(agent) ?? []).reduce((n, [x, y]) => n + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);

  // Background commands (commands.ts), for the waits a wait loop spends on them and for their runs.
  const bgRuns = onCommand || opts.onSpan
    ? q('SELECT agent_id, session_agent_id, command, label, started_at, ended_at FROM running_commands WHERE project_id = ? AND background = 1 AND started_at < ? AND COALESCE(ended_at, started_at) >= ? ORDER BY started_at', projectId, to, from)
    : [];
  const bgDuring = (agent: string, a: number, b: number) => {
    let found: Row | null = null;
    for (const r of bgRuns) if ((r.agent_id === agent || r.session_agent_id === agent) && r.started_at < b && (r.ended_at ?? b) > a) found = r;
    return found;
  };
  const agentRow = (id: string) => agents.get(id) ?? { id, parent_id: 'x', role_id: 'unknown' };
  if (onCommand) for (const r of bgRuns) if (r.ended_at != null && r.started_at >= from) onCommand({ agent: agentRow(String(r.agent_id)), ts: Number(r.started_at), command: String(r.command), description: String(r.label ?? ''), runMs: Number(r.ended_at) - Number(r.started_at), background: true });
  const calls = new Map<string, Row>();
  const toolNames = new Map<string, string>();
  // Each agent's earlier shell commands (not wait loops), latest last: what a wait loop waits on is found among them.
  const earlier = new Map<string, Row[]>();
  const writerOf = (agent: string, loop: Row, at: number): Row | null => {
    const targets = waitTargets(String(loop.cmd ?? loop.summary ?? ''));
    if (!targets.length) return null;
    const list = earlier.get(agent) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (at - c.ts > 6 * 3600_000) break;
      // Only the files the command writes (its --out, > and tee targets, what it touches), or its background output
      // file (tasks/<id>): never a path that only shows up in what it printed or reads.
      const text = String(c.cmd ?? c.summary ?? '');
      const own = writtenTargets(text);
      if (targets.some((t) => own.includes(t) || own.some((o) => o.startsWith(`${t}/`)))) return c;
    }
    return null;
  };
  // Background runs each agent started (Claude's run_in_background, from the transcript) and subagents it launched
  // (the Agent tool): what a wait between turns, or before its next call, is spent on when no Helm run covers it.
  const started = new Map<string, Row[]>();
  const waitedOn = (agent: string, a: number, b: number): { row: Row; subagent: boolean } | null => {
    const helm = bgDuring(agent, a, b);
    if (helm) return { row: { cmd: helm.command, descr: helm.label, ts: helm.started_at }, subagent: false };
    const list = started.get(agent) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (r.ts > b) continue;
      if (b - r.ts > 3 * 3600_000) break;
      return { row: r, subagent: r.name === 'Agent' };
    }
    return null;
  };
  const buckets = new Map<string, Bucket>();
  const bucket = (agentId: string, ts: number) => {
    const a = agents.get(agentId) ?? { id: agentId, parent_id: 'x', role_id: 'unknown' };
    const day = dayOf(ts);
    const tier = tierOf(a, ts);
    const key = `${agentId}|${day}|${tier}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { agent_id: agentId, who: whoOf(a), tier, day, split: emptySplit() }));
    return b.split;
  };
  const open = new Map<string, Category>();
  let prev: Row | null = null;
  for (let e of evs) {
    const same = prev && prev.agent_id === e.agent_id;
    const s = bucket(e.agent_id, e.ts);
    let cat: Category = 'thinking';
    if (e.kind === 'tool') {
      cat = toolCategory({ name: e.name, summary: e.summary, input: e.input }, edited.get(e.agent_id));
      open.set(String(e.cid), cat);
      if (e.name === 'Agent') (started.get(e.agent_id) ?? started.set(e.agent_id, []).get(e.agent_id)!).push(e);
      toolNames.set(String(e.cid), String(e.name ?? ''));
      if (e.cmd != null || (e.name === 'Bash' && isCommand(cat))) {
        calls.set(String(e.cid), e);
        if (cat !== 'cmd_wait') (earlier.get(e.agent_id) ?? earlier.set(e.agent_id, []).get(e.agent_id)!).push(e);
      }
      s.thinking.tokens += Math.round(Number(e.insize) / CHARS_PER_TOKEN);
    } else if (e.kind === 'tool_result') {
      cat = open.get(String(e.cid)) ?? 'other_tools';
      open.delete(String(e.cid));
      const call = calls.get(String(e.cid));
      calls.delete(String(e.cid));
      // A background run's id (its output is tasks/<id>.output, which a wait loop may watch): kept with the call.
      const bgId = call && call.bg ? /background with ID:\s*(\w+)/.exec(String(e.head ?? ''))?.[1] : null;
      if (bgId) call!.cmd = `${String(call!.cmd ?? call!.summary ?? '')} #tasks/${bgId}`;
      if (bgId) (started.get(e.agent_id) ?? started.set(e.agent_id, []).get(e.agent_id)!).push(call!);
      if (call) e = { ...e, call };
      // A foreground command's run (a background one returns at once; its run is from running_commands).
      if (onCommand && call && !call.bg && call.agent_id === e.agent_id) onCommand({ agent: agentRow(e.agent_id), ts: Number(call.ts), command: String(call.cmd ?? call.summary ?? ''), description: String(call.descr ?? ''), runMs: e.ts - call.ts });
      s[cat].tokens += Math.round(Number(e.size) / CHARS_PER_TOKEN);
    } else if (e.kind === 'text' || e.kind === 'result') {
      s.thinking.tokens += Math.round(Number(e.size) / CHARS_PER_TOKEN);
    }
    // The gap before this event (none before an inbound message: the agent was between turns).
    const gap = same && e.kind !== 'inbound' ? Math.max(0, e.ts - prev!.ts) : 0;
    const last = prev;
    prev = e;
    if (!gap) continue;
    // A wait that is not the next command's: after the turn ended (the agent sat until a background run or a subagent
    // woke it), or the part of the gap before a command past COMMAND_IDLE_MS. It goes to the background run or subagent
    // it waited on; with none, the time between turns is not counted and the in-turn rest is idle. Never to the short
    // command that happens to come next (task_11ca06b799: a git status took the blame for a 2-hour subagent).
    const betweenTurns = last!.kind === 'result';
    const beforeCall = e.kind === 'tool' && (isCommand(cat) || cat === 'cmd_wait') && gap > COMMAND_IDLE_MS;
    if (betweenTurns || beforeCall) {
      if (gap > 3 * 3600_000) continue;
      const waitUser = Math.min(gap, overlap(e.agent_id, e.ts - gap, e.ts));
      const rest = gap - waitUser;
      s.waiting_user.ms += waitUser;
      const work = betweenTurns ? 0 : Math.min(rest, COMMAND_IDLE_MS);
      const on = waitedOn(e.agent_id, e.ts - gap, e.ts);
      const waitCat: Category = on ? (on.subagent ? 'subagents' : 'cmd_wait') : 'idle';
      if (betweenTurns && !on) {
        s.waiting_user.ms -= waitUser;
        continue;
      }
      s[cat].ms += work;
      s[waitCat].ms += rest - work;
      if (onCommand && on && !on.subagent && rest - work > 0) onCommand({ agent: agentRow(e.agent_id), ts: e.ts, command: String(on.row.cmd ?? on.row.summary ?? ''), description: String(on.row.descr ?? ''), waitedMs: rest - work, background: true });
      if (opts.onSpan) {
        const call = e.kind === 'tool' && e.cmd != null ? e : undefined;
        const base = { agent_id: String(e.agent_id), at: Number(e.ts), tool: String(e.name ?? ''), command: call ? String(call.cmd ?? call.summary ?? '') : null, description: call ? String(call.descr ?? '') || null : null, failed: false, call: e.cid != null ? String(e.cid) : null };
        if (waitUser > 0) opts.onSpan({ ...base, category: 'waiting_user', ms: waitUser });
        if (work > 0) opts.onSpan({ ...base, category: cat, ms: work });
        if (rest - work > 0) opts.onSpan({ ...base, category: waitCat, ms: rest - work, ...(on && !on.subagent ? { command: String(on.row.cmd ?? on.row.summary ?? ''), description: String(on.row.descr ?? '') || null, background: true } : {}) });
      }
      continue;
    }
    if (gap > (isCommand(cat) || cat === 'subagents' ? 3 * 3600_000 : HARD_CAP)) continue;
    const waitUser = Math.min(gap, overlap(e.agent_id, e.ts - gap, e.ts));
    const rest = gap - waitUser;
    s.waiting_user.ms += waitUser;
    // The command a gap is charged to: the call a result ends, or (the gap before it) the call itself.
    const call: Row | undefined = e.call ?? (e.kind === 'tool' && e.cmd != null ? e : undefined);
    if (opts.onSpan) {
      // Every part of the gap, with what it belongs to (tasktime.ts); the same arithmetic as the categories below.
      const toolOf = e.kind === 'tool_result' ? (e.call?.name ?? toolNames.get(String(e.cid)) ?? null) : e.kind === 'tool' ? String(e.name ?? '') : null;
      const base = { agent_id: String(e.agent_id), at: Number(e.ts), tool: toolOf, command: call ? String(call.cmd ?? call.summary ?? '') : null, description: call ? String(call.descr ?? '') || null : null, failed: e.kind === 'tool_result' && (e.iserr === 1 || e.iserr === true), call: e.cid != null && (e.kind === 'tool' || e.kind === 'tool_result') ? String(e.cid) : null };
      const emit = (category: Category, ms: number, over: Partial<Span> = {}) => ms > 0 && opts.onSpan!({ ...base, ...over, category, ms });
      emit('waiting_user', waitUser);
      if (cat === 'cmd_wait') {
        // A wait loop's time goes to what it waits on: the background run, or the earlier command that writes its file.
        const on = call ? bgDuring(e.agent_id, e.ts - gap, e.ts) : null;
        const writer = call && !on ? writerOf(e.agent_id, call, e.ts) : null;
        emit('cmd_wait', rest, on ? { command: String(on.command), description: String(on.label ?? '') || null, background: true } : writer ? { command: String(writer.cmd ?? writer.summary ?? ''), description: String(writer.descr ?? '') || null } : {});
      }
      else if (isCommand(cat) || cat === 'subagents') {
        const work = cat === 'subagents' ? rest : Math.min(rest, COMMAND_IDLE_MS);
        emit(cat, work);
        emit('cmd_wait', rest - work);
      } else {
        // A gap that ends in the model's own output (text, a call) is the model's time however long: a slow turn, not
        // idle. (The project view keeps its 2-minute cap.)
        const work = cat === 'thinking' ? rest : Math.min(rest, CAP);
        emit(cat, work);
        emit('idle', rest - work);
      }
    }
    if (cat === 'cmd_wait') {
      s.cmd_wait.ms += rest;
      if (onCommand && rest > 0 && call) {
        // A wait loop waits on the background command running then, if there is one.
        const on = bgDuring(e.agent_id, e.ts - gap, e.ts);
        const writer = on ? null : writerOf(e.agent_id, call, e.ts);
        onCommand(
          on
            ? { agent: agentRow(e.agent_id), ts: e.ts, command: String(on.command), description: String(on.label ?? ''), waitedMs: rest, background: true }
            : writer
              ? { agent: agentRow(e.agent_id), ts: e.ts, command: String(writer.cmd ?? writer.summary ?? ''), description: String(writer.descr ?? ''), waitedMs: rest }
              : { agent: agentRow(e.agent_id), ts: e.ts, command: String(call.cmd ?? call.summary ?? ''), description: String(call.descr ?? ''), waitedMs: rest },
        );
      }
    } else if (isCommand(cat) || cat === 'subagents') {
      // A command (or a subagent) runs as long as it runs; past COMMAND_IDLE_MS a foreground command is a wait.
      const work = cat === 'subagents' ? rest : Math.min(rest, COMMAND_IDLE_MS);
      s[cat].ms += work;
      s.cmd_wait.ms += rest - work;
      if (onCommand && rest - work > 0 && call) onCommand({ agent: agentRow(e.agent_id), ts: e.ts, command: String(call.cmd ?? call.summary ?? ''), description: String(call.descr ?? ''), waitedMs: rest - work });
    } else {
      const work = Math.min(rest, CAP);
      s[cat].ms += work;
      s.idle.ms += rest - work;
    }
  }
  return [...buckets.values()];
}
