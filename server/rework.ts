import { all, db, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { commandKind } from './activity.ts';
import { commandGroup, commandText } from './commandgroups.ts';
import { relatedItems, relevanceTerms } from './rankedsearch.ts';
import { namedPaths } from './affects.ts';
import { taskTimes } from './worktime.ts';
import { subagentLimit } from './subagentprompt.ts';
import './waits.ts'; // task_waits
import { floorOf } from './telemetryreset.ts';

/**
 * Rework, repeats and unused speed (the Telemetry page's Rework and Repeats sections, get_telemetry).
 *
 * Rework per task, from its agents' transcripts while it ran and what Helm recorded about it, as time and as a share of
 * its work time (worktime.ts):
 * - a command that failed and was run again (the same command, or the same check): the failed run's time;
 * - an edit that rewrote or undid lines the same agent had just written on that file: the model's time on it (≤ 2 min);
 * - `git revert` (counted, no time);
 * - a review sent back (changes_needed): from the verdict to the next review request, or the finish;
 * - progress flags (counted);
 * - redone: reopened after done (its active time after), or a follow-up task naming it (the follow-up's work time).
 * Kept per finished task in task_rework (so it outlives history being reduced), with the task's errors.
 *
 * Repeats: the same error (normalised text; with no text, the same failing check) in two or more tasks. For each later
 * hit: was the answer already known then (a knowledge note on it, or an earlier task that hit it and finished), was the
 * agent given it (its brief, the notes it was shown), and would ranked search on the error have put it in the top 2.
 *
 * Unused speed, per project over a period: commands waited on with nothing else in hand while independent work sat
 * queued; parallel slots (builder mode: the builder and its subagent limit) left empty while independent work was
 * queued; a host free while a heavy job of the project queued (commands.ts free_ms). Independence is judged as the
 * builder's fan-out does (no path named by both, not marked risky), from the tasks as they are now.
 */

db.exec(`CREATE TABLE IF NOT EXISTS task_rework (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  finished_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_rework_finished ON task_rework(project_id, finished_at);`);

/** Bump when the counting changes: kept rows of an older version are computed again when read. */
const VERSION = 1;
const CAP = 2 * 60_000;
const RUN_CAP = 30 * 60_000;
const FOLLOWUP_MS = 7 * 24 * 3600_000;

export const REWORK_KINDS = ['rerun', 'edit', 'revert', 'review', 'flag', 'redo'] as const;
export type ReworkKind = (typeof REWORK_KINDS)[number];
export const REWORK_LABEL: Record<ReworkKind, string> = {
  rerun: 'Failed commands rerun',
  edit: 'Edits rewritten or undone',
  revert: 'Commits reverted',
  review: 'Reviews sent back',
  flag: 'Progress flags',
  redo: 'Reopened or redone',
};

export type ErrorHit = { sig: string; text: string; ts: number; agent_id: string; tool: string };
export type TaskRework = {
  v: number;
  task_id: string;
  project_id: string;
  title: string;
  finished_at: number | null;
  work_ms: number | null;
  rework_ms: number;
  kinds: Record<ReworkKind, { n: number; ms: number }>;
  errors: ErrorHit[];
};

// ---------- normalising ----------

const ERRORISH = /error|fail|cannot|can't|not found|denied|refus|invalid|missing|expected|panic|not allowed|no such|unable|not sent|not completed|blocked|too (long|many)|at most|exceed/i;
/** Not a pitfall: the user said no, or a turn was interrupted. */
const NOT_PITFALL = /^(the user doesn't want|request interrupted|\[request interrupted)/i;

/** The line of an error that says what went wrong, as written (Exit code and tags taken off). */
export function errorLine(text: string): string | null {
  const lines = String(text ?? '')
    .replace(/<\/?tool_use_error>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^Exit code \d+$/.test(l));
  if (!lines.length || NOT_PITFALL.test(lines[0])) return null;
  const pick = (lines.slice(0, 40).find((l) => ERRORISH.test(l)) ?? lines[0]).replace(/^Exit code \d+\s*/, '');
  return pick.slice(0, 300) || null;
}

/** The error's line with what varies taken out (paths, ids, numbers): equal for the same error in another task. */
export function errorSignature(text: string): string | null {
  const line = errorLine(text);
  if (!line) return null;
  const sig = stripPaths(line.toLowerCase().replace(/\b(ag|task|pr|disc|hj|toolu|host|cr|rq|pv|kn|doc)_[a-z0-9]+/g, '<id>'), '<path>')
    .replace(/\b[0-9a-f]{7,}\b/g, '<hex>')
    .replace(/\d[\d,]*(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  return sig.replace(/[^a-z]/g, '').length >= 8 ? sig : null;
}

const stripPaths = (s: string, by = ' ') => s.replace(/(?<![\w:])(~|\.{1,2})?\/[\w.@+-]+(\/[\w.@+-]*)*/g, by).replace(/\b[\w.@+-]+(\/[\w.@+-]+)+\.[a-z]{1,5}\b/g, by);

/** Words every error has: what is left says which error it is. */
const ERROR_WORDS = new Set('error errors failed fail fails cannot command found exit code file files directory such invalid option context line unexpected expected access denied missing exist exists does not unable while looking matching usage warning'.split(' '));

/** The words that say which error it is (paths and common error words left out): what a note on it would name. */
export const errorTerms = (text: string) => relevanceTerms(stripPaths(String(text ?? '')), 16).filter((w) => !ERROR_WORDS.has(w));

/** A command as it is rerun: leading cd and env settings, output trimming and redirections taken off. */
export function commandKey(command: string): string {
  let c = commandText(command).trim();
  for (let i = 0; i < 6; i++) {
    const next = c.replace(/^\s*cd\s+\S+\s*(&&|;)\s*/, '').replace(/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|[^\s;&]*)\s+/, '');
    if (next === c) break;
    c = next;
  }
  return c
    .replace(/\s*\|\s*(head|tail|grep|less|cat)\b[^|]*$/g, '')
    .replace(/\s*\d?>&\d|\s*2>\s*\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A failed check's name (a test or build command's group) or null. */
const checkOf = (command: string) => {
  const k = commandKind(command);
  return k === 'cmd_test' || k === 'cmd_build' ? commandGroup(command).key : null;
};

const parse = (s: unknown): Row => {
  try {
    const v = JSON.parse(String(s ?? ''));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
/** A clipped tool input (runtime.ts keeps 4000 characters) may not parse: the string fields read by pattern. */
function inputOf(raw: unknown): Row {
  const v = parse(raw);
  if (Object.keys(v).length) return v;
  const out: Row = {};
  for (const k of ['command', 'file_path', 'old_string', 'new_string']) {
    const m = new RegExp(`"${k}":\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(String(raw ?? ''));
    if (!m) continue;
    try {
      out[k] = JSON.parse(`"${m[1]}"`);
    } catch {
      out[k] = m[1];
    }
  }
  return out;
}

// ---------- one task ----------

const emptyKinds = () => Object.fromEntries(REWORK_KINDS.map((k) => [k, { n: 0, ms: 0 }])) as TaskRework['kinds'];

/** The agents that worked on a task (as telemetry.ts and tasktime.ts pick them), its subagents included. */
const taskAgents = (t: Row) =>
  all('SELECT id FROM agents WHERE parent_id IS NOT NULL AND (id = ? OR task_id = ? OR id IN (SELECT agent_id FROM token_usage WHERE task_id = ?))', t.driver_agent_id ?? '', t.id, t.id).map((a) => String(a.id));

/** Compute a task's rework from what the database holds now. */
export function computeRework(t: Row, at = now()): TaskRework {
  const ended = (t.state === 'done' || t.state === 'dropped') && t.finished_at != null;
  const end = ended ? Number(t.finished_at) : at;
  const start = Number(t.started_at ?? t.created_at);
  const kinds = emptyKinds();
  const errors: ErrorHit[] = [];
  const add = (k: ReworkKind, ms = 0) => {
    kinds[k].n++;
    kinds[k].ms += Math.max(0, ms);
  };
  const agents = taskAgents(t);
  for (const id of agents) {
    const calls = new Map<string, { name: string; ts: number; prev: number; input: Row }>();
    const failed = new Map<string, number>(); // command key → its failed run's ms, until it is run again
    const written = new Map<string, string[]>(); // file → what this agent's edits wrote there
    let prev = start;
    for (const e of all("SELECT ts, kind, data FROM events WHERE agent_id = ? AND ts >= ? AND ts <= ? AND kind IN ('tool', 'tool_result', 'text') ORDER BY id", id, start, end)) {
      const d = parse(e.data);
      const ts = Number(e.ts);
      if (e.kind === 'tool') {
        const input = inputOf(d.input);
        calls.set(String(d.id), { name: String(d.name ?? ''), ts, prev, input });
        if (d.name === 'Bash' && input.command) {
          const key = commandKey(String(input.command));
          const check = checkOf(String(input.command));
          for (const k of [key, check ? `check:${check}` : null]) {
            if (k && failed.has(k)) {
              add('rerun', Math.min(RUN_CAP, failed.get(k)!));
              failed.delete(key);
              if (check) failed.delete(`check:${check}`);
              break;
            }
          }
        }
      } else if (e.kind === 'tool_result') {
        const c = calls.get(String(d.id));
        calls.delete(String(d.id));
        const error = d.error === true || d.error === 1;
        if (c?.name === 'Bash' && c.input.command) {
          const command = String(c.input.command);
          if (error) {
            failed.set(commandKey(command), ts - c.ts);
            const check = checkOf(command);
            if (check) failed.set(`check:${check}`, ts - c.ts);
          } else if (/(^|[;&|]\s*)git\s+revert\b(?![^;&|]*--(abort|quit|skip|continue))/.test(commandKey(command))) add('revert');
        }
        if (c && !error && /^(Edit|MultiEdit)$/.test(c.name)) {
          const file = String(c.input.file_path ?? '');
          const edits: Row[] = c.name === 'MultiEdit' && Array.isArray(c.input.edits) ? c.input.edits : [c.input];
          const mine = written.get(file) ?? [];
          let redo = false;
          for (const x of edits) {
            const old = String(x.old_string ?? '').trim();
            if (old && mine.some((w) => w.length >= 20 && (old.includes(w) || (old.length >= 20 && w.includes(old))))) redo = true;
          }
          if (redo) add('edit', Math.min(CAP, ts - c.prev));
          for (const x of edits) {
            const w = String(x.new_string ?? '').trim();
            if (w) mine.push(w);
          }
          written.set(file, mine.slice(-50));
        }
        if (error) {
          const sig = errorSignature(String(d.text ?? ''));
          const check = c?.name === 'Bash' && c.input.command ? checkOf(String(c.input.command)) : null;
          const key = sig ?? (check ? `check: ${check}` : null);
          if (key) errors.push({ sig: key, text: errorLine(String(d.text ?? '')) ?? key, ts, agent_id: id, tool: c?.name ?? '' });
        }
      }
      prev = ts;
    }
  }
  // Reviews sent back: from the verdict to the next request (or the finish), while the task was Active.
  const states = all('SELECT state, at FROM task_states WHERE task_id = ? ORDER BY at, id', t.id);
  const activeSpans: [number, number][] = [];
  states.forEach((s, i) => {
    if (s.state === 'active') activeSpans.push([Number(s.at), Number(states[i + 1]?.at ?? end)]);
  });
  const reviews = all("SELECT created_at, answered_at, verdict FROM consults WHERE task_id = ? AND kind = 'review' ORDER BY created_at", t.id);
  reviews.forEach((r, i) => {
    if (r.verdict !== 'changes_needed') return;
    const from = Number(r.answered_at ?? r.created_at);
    const to = Math.min(end, Number(reviews[i + 1]?.created_at ?? end));
    add('review', activeSpans.length ? overlapMs([[from, to]], activeSpans) : to - from);
  });
  kinds.flag.n += Number(get('SELECT flags_total AS n FROM task_progress WHERE task_id = ?', t.id)?.n ?? 0);
  // Reopened after done: its active time after the first done.
  const firstDone = states.findIndex((s) => s.state === 'done');
  if (firstDone >= 0 && states.slice(firstDone + 1).some((s) => s.state !== 'done' && s.state !== 'dropped')) {
    let ms = 0;
    let from: number | null = null;
    for (const s of states.slice(firstDone + 1)) {
      if (s.state === 'active' && from == null) from = Number(s.at);
      else if (s.state !== 'active' && from != null) {
        ms += Number(s.at) - from;
        from = null;
      }
    }
    if (from != null) ms += end - from;
    add('redo', ms);
  }
  // A follow-up task naming it within a week of its finish.
  if (ended) {
    for (const f of all("SELECT * FROM tasks WHERE kind = 'task' AND id != ? AND created_at >= ? AND created_at <= ? AND (title LIKE ? OR description LIKE ?)", t.id, end, end + FOLLOWUP_MS, `%${t.id}%`, `%${t.id}%`)) {
      add('redo', f.state === 'dropped' ? 0 : Number(taskTimes(f, at).workMs ?? 0));
    }
  }
  const work = taskTimes(t, at).workMs;
  return {
    v: VERSION,
    task_id: String(t.id),
    project_id: String(t.project_id),
    title: String(t.title),
    finished_at: ended ? end : null,
    work_ms: work,
    rework_ms: REWORK_KINDS.reduce((n, k) => n + kinds[k].ms, 0),
    kinds,
    errors: errors.slice(0, 200),
  };
}

/** A task's share of rework (0–100, one decimal), null when its work time is unknown. */
export const shareOf = (r: { rework_ms: number; work_ms: number | null }) => (r.work_ms ? Math.round(Math.min(1, r.rework_ms / r.work_ms) * 1000) / 10 : null);

/** Keep a finished task's rework (task_rework). Never throws: it must not break a finish. */
export function recordRework(taskId: string): TaskRework | null {
  try {
    const t = get("SELECT * FROM tasks WHERE id = ? AND kind = 'task'", taskId);
    if (!t || t.finished_at == null || (t.state !== 'done' && t.state !== 'dropped')) return null;
    const r = computeRework(t);
    run('INSERT OR REPLACE INTO task_rework (task_id, project_id, finished_at, data, computed_at) VALUES (?,?,?,?,?)', t.id, t.project_id, r.finished_at, JSON.stringify(r), now());
    return r;
  } catch (err) {
    console.warn(`rework: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    return null;
  }
}

/** The rework of tasks finished in [from, to) (one project or all): kept rows, missing or outdated ones computed and kept. */
export function reworkRows(projectId: string | null, from: number, to: number): TaskRework[] {
  const kept = new Map(
    all(`SELECT task_id, data FROM task_rework WHERE finished_at >= ? AND finished_at < ? ${projectId ? 'AND project_id = ?' : ''}`, from, to, ...(projectId ? [projectId] : [])).map((r) => [String(r.task_id), parse(r.data) as TaskRework]),
  );
  const out: TaskRework[] = [];
  for (const t of all(`SELECT id FROM tasks WHERE kind = 'task' AND state IN ('done', 'dropped') AND finished_at >= ? AND finished_at < ? ${projectId ? 'AND project_id = ?' : ''} ORDER BY finished_at`, from, to, ...(projectId ? [projectId] : []))) {
    const k = kept.get(String(t.id));
    const r = k && k.v === VERSION ? k : recordRework(String(t.id));
    if (r) out.push(r);
  }
  return out;
}

// ---------- repeats ----------

export type Occurrence = { task_id: string; title: string; agent_id: string; ts: number; text: string; tool: string };
export type Repeat = {
  sig: string;
  text: string;
  count: number;
  tasks: { id: string; title: string }[];
  agents: number;
  first: number;
  last: number;
  /** The error says how to fix it (Helm's own refusals): nothing to look up. */
  self: boolean;
  /** Whether the answer was written down at a later hit: a knowledge note on it, or an earlier finished task's record. */
  known: boolean;
  by: { kind: 'knowledge' | 'task'; id: string; title: string } | null;
  /** Of the later hits where it was known: how many agents were given it, and how many times search had it in the top 2. */
  knownHits: number;
  given: number;
  top2: number;
};

/** Errors that hit two or more tasks, most tasks first. */
export function repeatsOf(rows: TaskRework[], limit = 8): { groups: { sig: string; occ: Occurrence[] }[] } {
  const by = new Map<string, Occurrence[]>();
  for (const r of rows) for (const e of r.errors) (by.get(e.sig) ?? by.set(e.sig, []).get(e.sig)!).push({ task_id: r.task_id, title: r.title, agent_id: e.agent_id, ts: e.ts, text: e.text, tool: e.tool });
  const groups = [...by]
    .map(([sig, occ]) => ({ sig, occ: occ.sort((a, b) => a.ts - b.ts) }))
    .filter((g) => new Set(g.occ.map((o) => o.task_id)).size >= 2)
    .sort((a, b) => new Set(b.occ.map((o) => o.task_id)).size - new Set(a.occ.map((o) => o.task_id)).size || b.occ.length - a.occ.length);
  return { groups: groups.slice(0, limit) };
}

const lower = (s: unknown) => String(s ?? '').toLowerCase();

/** The text (of those given) that covers the error best: all of its telling words when it has one or two, else half (two or more). */
function covering(text: string, candidates: { row: Row; hay: string }[]): Row | null {
  const terms = errorTerms(text);
  if (!terms.length) return null;
  const need = terms.length <= 2 ? terms.length : Math.max(2, Math.ceil(terms.length * 0.5));
  let best: Row | null = null;
  let bestN = 0;
  for (const c of candidates) {
    const hay = lower(c.hay);
    const hit = terms.filter((w) => hay.includes(w)).length;
    if (hit >= need && hit > bestN) [best, bestN] = [c.row, hit];
  }
  return best;
}

/** The knowledge note that existed at `at` and covers the error. */
const noteFor = (projectId: string, text: string, at: number) =>
  covering(text, all('SELECT id, title, body, paths FROM knowledge_notes WHERE project_id = ? AND created_at < ?', projectId, at).map((n) => ({ row: n, hay: `${n.title}\n${n.body}\n${n.paths}` })));

/**
 * An earlier task, finished by `at`, that hit the same error and whose record (description, summary, conclusion, the
 * thread up to `at`) covers it: the answer written where it could be found. Hitting it alone is not knowing the answer.
 */
function pastTaskFor(text: string, earlier: string[], at: number): Row | null {
  const rows = earlier
    .map((id) => get('SELECT id, title, description, status_summary, conclusion, finished_at FROM tasks WHERE id = ?', id))
    .filter((t): t is Row => !!t && t.finished_at != null && Number(t.finished_at) < at)
    .map((t) => ({ row: t, hay: [t.title, t.description, t.status_summary, t.conclusion, ...all('SELECT body FROM task_messages WHERE task_id = ? AND created_at < ?', t.id, at).map((m) => m.body)].join('\n') }));
  return covering(text, rows);
}

/**
 * Helm's own refusals and checks that say how to fix them in the message (a budget, a blocked wait, the worktree guard,
 * tool input validation): the answer is in the error itself, so attaching search results would not help.
 */
const SELF_EXPLAINING = /^(not sent:|not completed yet:|a note is at most|blocked:|this agent is isolated|pretooluse:|mcp error -32602|inputvalidationerror|you may not|the high budget|.* is one agent at a time)/i;
export const selfExplaining = (text: string, tool = '') => SELF_EXPLAINING.test(text.trim()) || /^mcp__helm__/.test(tool);

/** What the agent was given: its first message (its brief), the first that names the task, and the notes it was shown. */
function briefOf(agentId: string, taskId: string): { text: string; seen: Set<string> } {
  const first = get("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' ORDER BY id LIMIT 1", agentId);
  const named = get("SELECT data FROM events WHERE agent_id = ? AND kind = 'inbound' AND data LIKE ? ORDER BY id LIMIT 1", agentId, `%${taskId}%`);
  const a = get('SELECT knowledge_seen FROM agents WHERE id = ?', agentId);
  return { text: lower(`${parse(first?.data).text ?? ''}\n${parse(named?.data).text ?? ''}`), seen: new Set(Object.keys(parse(a?.knowledge_seen))) };
}

/** Each group's counts and whether its answer was known at the later hits (at most `per` hits checked per group). */
export function judgeRepeats(projectId: string, groups: { sig: string; occ: Occurrence[] }[], per = 30): Repeat[] {
  return groups.map((g) => {
    const tasks = [...new Map(g.occ.map((o) => [o.task_id, { id: o.task_id, title: o.title }])).values()];
    let by: Repeat['by'] = null;
    let knownHits = 0, given = 0, top2 = 0;
    // A later hit: one in a task after the group's first task.
    const later = g.occ.filter((o) => o.task_id !== g.occ[0].task_id).slice(0, per);
    for (const o of later) {
      const note = noteFor(projectId, o.text, o.ts);
      const past = pastTaskFor(o.text, [...new Set(g.occ.filter((p) => p.task_id !== o.task_id && p.ts < o.ts).map((p) => p.task_id))], o.ts);
      if (!note && !past) continue;
      knownHits++;
      by ??= note ? { kind: 'knowledge', id: String(note.id), title: String(note.title) } : { kind: 'task', id: String(past!.id), title: String(past!.title) };
      const b = briefOf(o.agent_id, o.task_id);
      if ((note && (b.seen.has(String(note.id)) || b.text.includes(lower(note.title)))) || (past && b.text.includes(String(past.id)))) given++;
      // Ranked search on the error, as it would have run then: only what existed at that moment.
      const hits = (relatedItems(projectId, stripPaths(o.text), { kinds: ['knowledge', 'task'], limit: 40 }) ?? []).filter((h) => {
        if (h.kind === 'knowledge') return Number(get('SELECT created_at FROM knowledge_notes WHERE id = ?', h.item)?.created_at ?? Infinity) < o.ts;
        return h.item !== o.task_id && !!get("SELECT 1 FROM tasks WHERE id = ? AND created_at < ?", h.item, o.ts);
      });
      const want = new Set([note?.id, past?.id].filter(Boolean).map(String));
      if (hits.slice(0, 2).some((h) => want.has(h.item))) top2++;
    }
    return { sig: g.sig, text: g.occ[0].text.slice(0, 200), self: selfExplaining(g.occ[0].text, g.occ[0].tool), count: g.occ.length, tasks, agents: new Set(g.occ.map((o) => o.agent_id)).size, first: g.occ[0].ts, last: g.occ[g.occ.length - 1].ts, known: knownHits > 0, by, knownHits, given, top2 };
  });
}

// ---------- unused speed ----------

export type Speed = {
  /** Commands waited on with nothing else in hand, and of that the time independent work sat queued. */
  idle_ms: number;
  idle_with_work_ms: number;
  /** Slot time left empty while independent work was queued (builder mode only), and the slots counted. */
  empty_slot_ms: number | null;
  slots: number | null;
  /** Time any independent work sat queued. */
  queued_ms: number;
  /** A host of the project free while a heavy job of it queued, and how many heavy jobs queued. */
  host_free_ms: number;
  heavy_queued: number;
};

const IDLE_GAP_MS = 20_000;

/**
 * The stretches the project's tasks' commands ran in [from, to) with nothing else in hand (commands.ts idleWaitMs, as
 * spans, for every task at once): the events are read once by project and time, not per task.
 */
export function idleSpans(projectId: string, from: number, to: number): [number, number][] {
  const cmds = all('SELECT id, task_id, session_agent_id, agent_id, started_at, COALESCE(ended_at, ?) AS ended_at FROM running_commands WHERE project_id = ? AND task_id IS NOT NULL AND started_at < ? AND COALESCE(ended_at, ?) >= ?', to, projectId, to, to, from);
  if (!cmds.length) return [];
  const lo = Math.min(...cmds.map((c) => Number(c.started_at)));
  const hi = Math.max(...cmds.map((c) => Number(c.ended_at)));
  // Each agent's actions (times, and the call ids of tool events) in time order.
  const acts = new Map<string, { ts: number[]; cid: (string | null)[]; tool: boolean[] }>();
  for (const e of all("SELECT agent_id, ts, kind, json_extract(data, '$.id') AS cid FROM events WHERE project_id = ? AND ts > ? AND ts < ? AND kind IN ('tool', 'tool_result', 'text') ORDER BY ts", projectId, lo, hi)) {
    const a = acts.get(String(e.agent_id)) ?? acts.set(String(e.agent_id), { ts: [], cid: [], tool: [] }).get(String(e.agent_id))!;
    a.ts.push(Number(e.ts));
    a.cid.push(e.kind === 'text' ? null : String(e.cid ?? ''));
    a.tool.push(e.kind !== 'text');
  }
  const subs = new Map<string, string[]>();
  for (const s of all("SELECT id, task_id FROM agents WHERE project_id = ? AND role_id = 'subagent' AND task_id IS NOT NULL", projectId)) (subs.get(String(s.task_id)) ?? subs.set(String(s.task_id), []).get(String(s.task_id))!).push(String(s.id));
  const firstAfter = (xs: number[], t: number) => {
    let a = 0, b = xs.length;
    while (a < b) {
      const m = (a + b) >> 1;
      if (xs[m] <= t) a = m + 1;
      else b = m;
    }
    return a;
  };
  const byTask = new Map<string, Row[]>();
  for (const c of cmds) (byTask.get(String(c.task_id)) ?? byTask.set(String(c.task_id), []).get(String(c.task_id))!).push(c);
  const out: [number, number][] = [];
  for (const [taskId, list] of byTask) {
    const spans: [number, number][] = [];
    for (const c of [...list].sort((a, b) => a.started_at - b.started_at)) {
      const last = spans[spans.length - 1];
      if (last && c.started_at <= last[1]) last[1] = Math.max(last[1], Number(c.ended_at));
      else spans.push([Number(c.started_at), Number(c.ended_at)]);
    }
    const agents = [...new Set(list.flatMap((c) => [String(c.session_agent_id), String(c.agent_id)]))];
    const own = new Set(list.map((c) => String(c.id)));
    for (const [a, b] of spans) {
      const points: number[] = [];
      for (const id of agents) {
        const x = acts.get(id);
        if (!x) continue;
        for (let i = firstAfter(x.ts, a); i < x.ts.length && x.ts[i] < b; i++) if (!x.tool[i] || !own.has(String(x.cid[i]))) points.push(x.ts[i]);
      }
      // Subagents of the session working for the task are work in hand too.
      for (const id of subs.get(taskId) ?? []) {
        const x = acts.get(id);
        if (!x) continue;
        for (let i = firstAfter(x.ts, a); i < x.ts.length && x.ts[i] < b; i++) if (x.tool[i]) points.push(x.ts[i]);
      }
      const p = [a, ...points.sort((x, y) => x - y), b];
      for (let i = 0; i + 1 < p.length; i++) if (p[i + 1] - p[i] > IDLE_GAP_MS) out.push([p[i] + IDLE_GAP_MS, p[i + 1]]);
    }
  }
  return clip(out, from, to);
}

const overlapMs = (spans: [number, number][], segs: [number, number][]) => {
  let n = 0;
  for (const [a, b] of spans) for (const [c, d] of segs) n += Math.max(0, Math.min(b, d) - Math.max(a, c));
  return n;
};
const clip = (spans: [number, number][], from: number, to: number): [number, number][] => spans.map(([a, b]): [number, number] => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a);

const overlapsPaths = (a: string[], b: string[]) => a.some((p) => b.some((q) => q === p || q.startsWith(p.endsWith('/') ? p : `${p}/`) || p.startsWith(q.endsWith('/') ? q : `${q}/`)));

/** The project's unused speed over [from, to). */
export function unusedSpeed(projectId: string, from: number, to: number): Speed {
  // Each task's state over time, from its history.
  const tasks = new Map(all("SELECT id, title, description, risky FROM tasks WHERE project_id = ? AND kind = 'task'", projectId).map((t) => [String(t.id), t]));
  const paths = new Map<string, string[]>();
  const pathsOf = (id: string) => paths.get(id) ?? paths.set(id, namedPaths(`${tasks.get(id)?.title ?? ''}\n${tasks.get(id)?.description ?? ''}`)).get(id)!;
  const changes = all("SELECT s.task_id, s.state, s.at FROM task_states s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ? AND t.kind = 'task' AND s.at < ? ORDER BY s.at, s.id", projectId, to);
  // What each task waits for (waits.ts), and when that finished: a task waiting on an open one is not startable.
  const waits = new Map<string, Row[]>();
  for (const w of all('SELECT w.task_id, w.created_at, t.finished_at FROM task_waits w JOIN tasks t ON t.id = w.waits_for JOIN tasks m ON m.id = w.task_id WHERE m.project_id = ?', projectId)) {
    (waits.get(String(w.task_id)) ?? waits.set(String(w.task_id), []).get(String(w.task_id))!).push(w);
  }
  const state = new Map<string, string>();
  let i = 0;
  for (; i < changes.length && Number(changes[i].at) <= from; i++) state.set(String(changes[i].task_id), String(changes[i].state));
  const slots = 1 + subagentLimit(projectId);
  const queuedSegs: [number, number][] = [];
  let emptySlot = 0;
  let at = from;
  const measure = (until: number) => {
    if (until <= at) return;
    const active = [...state].filter(([, s]) => s === 'active').map(([id]) => id);
    const activePaths = active.map(pathsOf);
    const blocked = (id: string) => (waits.get(id) ?? []).some((w) => Number(w.created_at) <= at && (w.finished_at == null || Number(w.finished_at) > at));
    const queued = [...state].filter(([id, s]) => s === 'scheduled' && !tasks.get(id)?.risky && !blocked(id) && !activePaths.some((p) => overlapsPaths(pathsOf(id), p)));
    if (queued.length) {
      queuedSegs.push([at, until]);
      if (slots != null) emptySlot += Math.min(Math.max(0, slots - active.length), queued.length) * (until - at);
    }
  };
  for (; i < changes.length; i++) {
    const c = changes[i];
    measure(Number(c.at));
    at = Math.max(at, Number(c.at));
    state.set(String(c.task_id), String(c.state));
  }
  measure(to);
  // Waiting on commands: every task with commands in the period.
  const spans = idleSpans(projectId, from, to);
  const idle = spans.reduce((n, [a, b]) => n + b - a, 0);
  const idleWithWork = overlapMs(spans, queuedSegs);
  const h = get('SELECT COALESCE(SUM(free_ms), 0) AS free, COUNT(*) AS n FROM heavy_jobs WHERE project_id = ? AND asked_at >= ? AND asked_at < ? AND (started_at IS NULL OR started_at > asked_at)', projectId, from, to);
  return {
    idle_ms: idle,
    idle_with_work_ms: idleWithWork,
    empty_slot_ms: slots == null ? null : emptySlot,
    slots,
    queued_ms: queuedSegs.reduce((n, [a, b]) => n + b - a, 0),
    host_free_ms: Number(h?.free ?? 0),
    heavy_queued: Number(h?.n ?? 0),
  };
}

// ---------- the view ----------

export type Periods = { period: 'day' | 'week'; edges: number[]; end: number; curStart: number; prevStart: number; labels: string[] };
export type ProjectRework = {
  project_id: string;
  name: string;
  /** The current period: rework share over all work time of the tasks finished in it, and the period before. */
  share: number | null;
  prev: number | null;
  tasks_n: number;
  rework_ms: number;
  work_ms: number;
  kinds: { kind: ReworkKind; label: string; n: number; ms: number }[];
  chart: { labels: string[]; values: (number | null)[] };
  top: { task_id: string; title: string; share: number | null; rework_ms: number; biggest: string }[];
  repeats: Repeat[];
  speed: Speed;
};

const shareOfRows = (rows: TaskRework[]) => {
  const known = rows.filter((r) => r.work_ms);
  const work = known.reduce((n, r) => n + Number(r.work_ms), 0);
  const re = known.reduce((n, r) => n + Math.min(r.rework_ms, Number(r.work_ms)), 0);
  return { share: work > 0 ? Math.round((re / work) * 1000) / 10 : null, work, re };
};

/** Per project: rework over the period and its history, repeats over the whole history window, unused speed now. */
/** Each project counts from its last Telemetry reset (telemetryreset.ts) unless `allTime`. */
export function reworkView(projectId: string | null, p: Periods, allTime = false): ProjectRework[] {
  const projects = projectId ? all('SELECT id, name FROM projects WHERE id = ?', projectId) : all('SELECT id, name FROM projects WHERE archived = 0 ORDER BY position, created_at');
  return projects
    .map((pr) => {
      const floor = floorOf(String(pr.id), allTime);
      return cached(`${pr.id}|${p.period}|${p.curStart}|${floor}`, () => projectRework(pr, p, floor));
    })
    .filter((x): x is ProjectRework => !!x);
}

/** A project's view is kept a minute: the page refetches on every project change, and repeats and waits are not cheap. */
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; v: ProjectRework | null }>();
function cached(key: string, f: () => ProjectRework | null): ProjectRework | null {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  const v = f();
  if (cache.size > 200) cache.clear();
  cache.set(key, { at: Date.now(), v });
  return v;
}

function projectRework(pr: Row, p: Periods, floor = 0): ProjectRework | null {
  const rows = reworkRows(String(pr.id), Math.max(floor, Math.min(p.edges[0], p.prevStart)), p.end);
  const cur = rows.filter((r) => Number(r.finished_at) >= p.curStart);
  const prev = rows.filter((r) => Number(r.finished_at) >= p.prevStart && Number(r.finished_at) < p.curStart);
  const hist = rows.filter((r) => Number(r.finished_at) >= p.edges[0]);
  if (!hist.length) return null;
  const s = shareOfRows(cur);
  const kinds = REWORK_KINDS.map((k) => ({ kind: k, label: REWORK_LABEL[k], n: cur.reduce((n, r) => n + r.kinds[k].n, 0), ms: cur.reduce((n, r) => n + r.kinds[k].ms, 0) })).filter((k) => k.n > 0);
  const values = p.edges.map((a, i) => shareOfRows(hist.filter((r) => Number(r.finished_at) >= a && Number(r.finished_at) < (p.edges[i + 1] ?? p.end))).share);
  const top = [...cur]
    .filter((r) => r.rework_ms >= 60_000)
    .sort((a, b) => b.rework_ms - a.rework_ms)
    .slice(0, 5)
    .map((r) => ({ task_id: r.task_id, title: r.title, share: shareOf(r), rework_ms: r.rework_ms, biggest: REWORK_LABEL[[...REWORK_KINDS].sort((x, y) => r.kinds[y].ms - r.kinds[x].ms)[0]] }));
  return {
    project_id: String(pr.id),
    name: String(pr.name),
    share: s.share,
    prev: shareOfRows(prev).share,
    tasks_n: cur.length,
    rework_ms: s.re,
    work_ms: s.work,
    kinds,
    chart: { labels: p.labels, values },
    top,
    repeats: judgeRepeats(String(pr.id), repeatsOf(hist).groups),
    speed: unusedSpeed(String(pr.id), Math.max(p.curStart, Math.min(floor, now())), Math.min(p.end, now())),
  };
}

const mins = (ms: number) => (ms >= 3600_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${Math.round(ms / 60_000)} min`);

/** For get_telemetry: one project's rework, repeats and unused speed, as lines. */
export function reworkText(projectId: string, p: Periods): string {
  const v = reworkView(projectId, p)[0];
  if (!v) return 'Rework: no finished tasks in the period.';
  const sp = v.speed;
  return [
    `Rework, ${p.period === 'week' ? 'last 7 days' : 'today'}: ${v.share ?? '–'}% of work time (before ${v.prev ?? '–'}%; ${v.tasks_n} task(s)). ${v.kinds.map((k) => `${k.label} ${k.n}${k.ms ? ` (${mins(k.ms)})` : ''}`).join('; ') || 'none'}.`,
    ...v.top.map((t) => `- [[${t.task_id}]]: ${t.share ?? '?'}% rework, mostly ${t.biggest.toLowerCase()}`),
    `Repeats (errors in 2+ tasks, ${p.period === 'week' ? '8 weeks' : '14 days'}):${v.repeats.length ? '' : ' none.'}`,
    ...v.repeats.map((r) => `- "${r.text.slice(0, 120)}": ${r.count}× in ${r.tasks.length} tasks; ${r.self ? 'the error says the fix; ' : ''}${r.known ? `known (${r.by!.kind} ${r.by!.kind === 'task' ? `[[${r.by!.id}]]` : `"${r.by!.title}"`}), given ${r.given}/${r.knownHits}, search top 2 ${r.top2}/${r.knownHits}` : 'not known'}`),
    `Unused speed: waited on commands ${mins(sp.idle_ms)} (${mins(sp.idle_with_work_ms)} of it with independent work queued); ${sp.empty_slot_ms == null ? '' : `empty slots while work queued ${mins(sp.empty_slot_ms)} of ${sp.slots}; `}a host free while heavy jobs queued ${mins(sp.host_free_ms)} (${sp.heavy_queued} queued).`,
  ].join('\n');
}
