import type { Row } from './db.ts';

/**
 * How much of agents' time goes to finding code, per project and week: the method of the hand study in
 * task_534f4aeea6, made a standing measure.
 *
 * A tool call is "finding" when it is a search (Grep, Glob, LS, an Agent/Explore subagent call, or a shell command made
 * only of search and read commands: rg, grep, find, fd, ls, tree, git grep/ls-files, cat, head, tail, sed -n, wc, jq,
 * git show/log/diff, with an optional leading cd), or a Read of a file the agent did not edit in the period. A shell
 * command that mixes in anything else (a build, a write) is not finding, so the share is a lower bound.
 *
 * Time: each call is charged from the agent's previous event to its result (the model's thinking plus the run), capped
 * at CAP; active time is every gap between an agent's consecutive events, capped the same way. Output: the size of the
 * results (as the transcript keeps them, trimmed) of finding calls against all results, the nearest thing to the
 * tokens they cost that Helm records per call.
 *
 * Pure: it takes a query function, so scripts can run it on a read-only database (scripts/finding-code.ts) and the
 * server on its own (watches.ts, the Helm page).
 */

export type Query = (sql: string, ...params: unknown[]) => Row[];

const CAP = 2 * 60_000;
const DAY = 86_400_000;
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS']);
/** An Agent call that only explores (the Explore subagent); a builder's subagents doing work are not finding. */
export const exploring = (d: Row) => (d.name === 'Agent' || d.name === 'Task') && /"subagent_type":\s*"Explore"/.test(String(d.input ?? ''));
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_ONLY = /^(rg|grep|egrep|fgrep|ugrep|find|fd|bfs|ls|tree|cat|head|tail|wc|jq|git\s+(grep|ls-files|show|log|diff|blame)|sed\s+-n|awk|sort|uniq|cut|echo|true)\b/;

/** Whether a shell command only searches and reads (an optional leading cd; pipes and && of such commands). */
export function searchOnly(command: string): boolean {
  const parts = String(command ?? '')
    .replace(/\s+2>\s*\/dev\/null|\s+2>&1/g, '')
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  const body = parts[0]?.startsWith('cd ') ? parts.slice(1) : parts;
  return body.length > 0 && body.every((p) => READ_ONLY.test(p) && !/(^|\s)>{1,2}\s*[^&\s]/.test(p) && !/\bsed\s+-i/.test(p));
}

/** The file a tool call names, from its input (JSON, maybe cut short) or its summary. */
export function fileOf(d: Row): string {
  const m = /"(?:file_path|notebook_path|path)":\s*"((?:[^"\\]|\\.)*)"/.exec(String(d.input ?? ''));
  return (m?.[1] ?? String(d.summary ?? '')).trim();
}

/**
 * timeShare: finding's share of agents' active time. tokenShare: the share of all the tokens the project used in the
 * period (token_usage: input + output + cache writes) that went into finding-code results: the size of those results
 * as tokens (characters / CHARS_PER_TOKEN) over the period's total. A result enters the context once, as a cache
 * write, which is what token_usage counts; its later re-reads from cache are not counted there, so the two are alike.
 * The transcript keeps results trimmed, so it is a lower bound. null for a task (token_usage per task is not split
 * the same way) or a period with no tokens.
 */
export type Share = { timeShare: number | null; tokenShare: number | null; resultTokens: number; findMs: number; activeMs: number; calls: number; findCalls: number };
/** A rough size of text in tokens: four characters each. */
export const CHARS_PER_TOKEN = 4;
export type TaskShare = Share & { task_id: string };

/**
 * The finding share of a project's agents in [from, to), overall and per task (an event counts for the task its agent
 * drove at that time: one whose driver it was and that was running then, else the agent's current task).
 */
export function findingCode(q: Query, projectId: string, from: number, to: number): { all: Share; tasks: TaskShare[] } {
  const evs = q(
    // Only the fields used, read from the JSON in SQL: parsing whole events in JS was most of the cost.
    `SELECT e.agent_id, e.ts, e.kind, json_extract(e.data, '$.name') AS name, json_extract(e.data, '$.id') AS cid,
            json_extract(e.data, '$.summary') AS summary, substr(json_extract(e.data, '$.input'), 1, 600) AS input,
            CASE WHEN e.kind = 'tool_result' THEN length(json_extract(e.data, '$.text')) ELSE 0 END AS size
       FROM events e JOIN agents a ON a.id = e.agent_id
      WHERE e.project_id = ? AND e.ts >= ? AND e.ts < ? AND e.kind IN ('tool', 'tool_result', 'text', 'inbound', 'result')
        AND coalesce(a.role_id, '') != 'subagent' AND json_valid(e.data) ORDER BY e.agent_id, e.id`,
    projectId, from, to,
  );
  // Files each agent edited in the period: reading them is part of changing them, not finding.
  const edited = new Map<string, Set<string>>();
  const parsed: Row[] = evs.map((e) => {
    const d: Row = { name: e.name, id: e.cid, summary: e.summary, input: e.input };
    if (e.kind === 'tool' && EDIT_TOOLS.has(String(d.name))) {
      const f = fileOf(d);
      if (f) (edited.get(e.agent_id) ?? edited.set(e.agent_id, new Set()).get(e.agent_id)!).add(f);
    }
    return { ...e, d };
  });
  // Tasks per agent with their running stretches.
  const drives = new Map<string, Row[]>();
  for (const t of q("SELECT id, driver_agent_id, started_at, finished_at FROM tasks WHERE project_id = ? AND kind = 'task' AND driver_agent_id IS NOT NULL AND started_at IS NOT NULL AND started_at < ? AND COALESCE(finished_at, ?) >= ?", projectId, to, to, from)) {
    (drives.get(t.driver_agent_id) ?? drives.set(t.driver_agent_id, []).get(t.driver_agent_id)!).push(t);
  }
  const current = new Map(q('SELECT id, task_id FROM agents WHERE project_id = ?', projectId).map((a) => [String(a.id), a.task_id as string | null]));
  const taskAt = (agent: string, ts: number) => drives.get(agent)?.find((t) => t.started_at <= ts && (t.finished_at ?? Infinity) >= ts)?.id ?? current.get(agent) ?? null;

  const empty = (): Share => ({ timeShare: null, tokenShare: null, resultTokens: 0, findMs: 0, activeMs: 0, calls: 0, findCalls: 0 });
  const total = { ...empty(), out: 0, findOut: 0 };
  const per = new Map<string, Share & { out: number; findOut: number }>();
  const bucket = (task: string | null) => (task ? (per.get(task) ?? per.set(task, { ...empty(), out: 0, findOut: 0 }).get(task)!) : null);
  const open = new Map<string, { finding: boolean; since: number; task: string | null }>();
  let prev: Row | null = null;
  for (const e of parsed) {
    const sameAgent = prev && prev.agent_id === e.agent_id;
    const gap = sameAgent ? Math.min(CAP, Math.max(0, e.ts - prev!.ts)) : 0;
    const task = taskAt(e.agent_id, e.ts);
    const t = bucket(task);
    total.activeMs += gap;
    if (t) t.activeMs += gap;
    if (e.kind === 'tool') {
      const name = String(e.d.name ?? '');
      const finding =
        SEARCH_TOOLS.has(name) ||
        exploring(e.d) ||
        (name === 'Read' && !edited.get(e.agent_id)?.has(fileOf(e.d))) ||
        (name === 'Bash' && searchOnly(String(e.d.summary ?? '')));
      open.set(String(e.d.id), { finding, since: sameAgent ? prev!.ts : e.ts, task });
      total.calls++;
      if (t) t.calls++;
      if (finding) {
        total.findCalls++;
        if (t) t.findCalls++;
      }
    } else if (e.kind === 'tool_result') {
      const call = open.get(String(e.d.id));
      const size = Number(e.size ?? 0);
      total.out += size;
      const ct = call ? bucket(call.task) : t;
      if (ct) ct.out += size;
      if (call?.finding) {
        const ms = Math.min(CAP, Math.max(0, e.ts - call.since));
        total.findMs += ms;
        total.findOut += size;
        if (ct) {
          ct.findMs += ms;
          ct.findOut += size;
        }
      }
      open.delete(String(e.d.id));
    }
    prev = e;
  }
  const usedTokens = Number(q('SELECT COALESCE(SUM(tokens), 0) AS n FROM token_usage WHERE project_id = ? AND at >= ? AND at < ?', projectId, from, to)[0]?.n ?? 0);
  const finish = <T extends Share & { out: number; findOut: number }>(s: T, tokens = 0): Share => ({
    timeShare: s.activeMs > 0 ? Math.round((Math.min(s.findMs, s.activeMs) / s.activeMs) * 1000) / 10 : null,
    resultTokens: Math.round(s.findOut / CHARS_PER_TOKEN),
    tokenShare: tokens > 0 ? Math.min(100, Math.round(((s.findOut / CHARS_PER_TOKEN) / tokens) * 1000) / 10) : null,
    findMs: s.findMs,
    activeMs: s.activeMs,
    calls: s.calls,
    findCalls: s.findCalls,
  });
  return {
    all: finish(total, usedTokens),
    tasks: [...per].map(([task_id, s]) => ({ task_id, ...finish(s) })).sort((a, b) => b.findMs - a.findMs),
  };
}

export type Week = { from: number; to: number; share: Share };

/** The last `weeks` rolling weeks ending at `at`, oldest first (the last one is this week). */
export function weeklyShares(q: Query, projectId: string, at: number, weeks = 8): Week[] {
  const out: Week[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const to = at - i * 7 * DAY;
    const from = to - 7 * DAY;
    out.push({ from, to, share: findingCode(q, projectId, from, to).all });
  }
  return out;
}

/** The worst tasks of a period by time spent finding, as lines for a note to the director. */
export function worstTasksText(q: Query, projectId: string, from: number, to: number, n = 5): string {
  const rows = findingCode(q, projectId, from, to).tasks.filter((t) => t.findMs > 0).slice(0, n);
  if (!rows.length) return '';
  return rows.map((t) => `- [[${t.task_id}]]: ${Math.round(t.findMs / 60_000)} min finding code, ${t.timeShare ?? 0}% of its active time (${t.findCalls} of ${t.calls} calls)`).join('\n');
}
