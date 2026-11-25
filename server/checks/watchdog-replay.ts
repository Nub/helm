/**
 * Replay the watchdog (watchdog.ts step) over past data: for each task Active in the window, rebuild minute by minute
 * whether its agents were mid-turn, busy (a command, a subagent, a consult), waiting on a request, or idle, run the
 * same step the runner runs, and list what it would have done. Also lists, independently, every task that sat idle
 * with nothing pending for 3 minutes or more, so the two can be compared.
 * Run on a copy of a database (never the live one): node server/checks/watchdog-replay.ts <copy.db> [days=7]
 */
import '../testenv.ts';
import { DatabaseSync } from 'node:sqlite';

const { step, IDLE_MS, TICK_MS, waitingSentence } = await import('../watchdog.ts');
type WatchRow = Parameters<typeof step>[0];

const path = process.argv[2];
if (!path) throw new Error('usage: watchdog-replay.ts <copy of helm.db> [days]');
const days = Number(process.argv[3] ?? 7);
const db = new DatabaseSync(path, { readOnly: true });
const all = (sql: string, ...a: any[]) => db.prepare(sql).all(...a) as any[];
const end = Math.max(...all('SELECT MAX(ts) AS ts FROM events').map((r) => Number(r.ts)));
const from = end - days * 86_400_000;

type Span = [number, number];
const inSpans = (xs: Span[], t: number) => xs.some(([a, b]) => t >= a && t < b);

/** The Active stretches of a task within the window, from its state changes. */
function activeSpans(taskId: string): Span[] {
  const out: Span[] = [];
  let start: number | null = null;
  for (const s of all('SELECT state, at FROM task_states WHERE task_id = ? ORDER BY at, id', taskId)) {
    if (s.state === 'active' && start == null) start = Number(s.at);
    else if (s.state !== 'active' && start != null) (out.push([start, Number(s.at)]), (start = null));
  }
  if (start != null) out.push([start, end]);
  return out.map(([a, b]): Span => [Math.max(a, from), Math.min(b, end)]).filter(([a, b]) => b > a);
}

const tasks = all("SELECT id, title, project_id, driver_agent_id FROM tasks WHERE kind = 'task' AND id IN (SELECT task_id FROM task_states WHERE at >= ?)", from - 30 * 86_400_000);
const results: { id: string; title: string; idleMin: number; spells: number; wake: number; director: number; stall: number; rerouted: number; firstAt: number | null }[] = [];
const userStalls: { project: string; at: number }[] = [];
for (const t of tasks) {
  const spans = activeSpans(t.id);
  if (!spans.length) continue;
  const agents = all("SELECT id FROM agents WHERE (id = ? OR task_id = ?) AND role_id != 'subagent'", t.driver_agent_id ?? '', t.id).map((a) => String(a.id));
  if (!agents.length) continue;
  const ph = agents.map(() => '?').join(',');
  const lo = spans[0][0] - 86_400_000;
  const hi = spans[spans.length - 1][1];
  // Turns: from the first inbound after a result to the next result.
  const turns: Span[] = [];
  const evts = all(`SELECT agent_id, ts, kind, data FROM events WHERE agent_id IN (${ph}) AND ts >= ? AND ts <= ? ORDER BY id`, ...agents, lo, hi);
  const open = new Map<string, number>();
  const evTs: number[] = [];
  const moves: number[] = [];
  for (const e of evts) {
    evTs.push(Number(e.ts));
    if (e.kind === 'inbound' && !open.has(e.agent_id)) open.set(e.agent_id, Number(e.ts));
    else if (e.kind === 'result' && open.has(e.agent_id)) (turns.push([open.get(e.agent_id)!, Number(e.ts)]), open.delete(e.agent_id));
    if (e.kind === 'tool' && /"name":"(Edit|Write|MultiEdit|NotebookEdit)"|git[^"|;&]*\b(commit|merge|rebase)\b/.test(String(e.data))) moves.push(Number(e.ts));
  }
  for (const [, s] of open) turns.push([s, hi]);
  let busy: Span[] = [];
  try {
    busy = all(`SELECT started_at AS a, COALESCE(ended_at, ?) AS b FROM running_commands WHERE (session_agent_id IN (${ph}) OR task_id = ?) AND started_at <= ?`, hi, ...agents, t.id, hi).map((r) => [Number(r.a), Number(r.b)]);
  } catch {}
  busy.push(...all(`SELECT created_at AS a, updated_at AS b FROM agents WHERE parent_id IN (${ph}) AND role_id = 'subagent' AND created_at <= ?`, ...agents, hi).map((r): Span => [Number(r.a), Number(r.b)]));
  busy.push(...all(`SELECT created_at AS a, COALESCE(answered_at, ?) AS b FROM consults WHERE asker_id IN (${ph}) AND created_at <= ?`, hi, ...agents, hi).map((r): Span => [Number(r.a), Number(r.b)]));
  const waiting: Span[] = all(
    "SELECT created_at AS a, COALESCE(answered_at, ?) AS b FROM inbox WHERE task_id = ? AND status != 'held'",
    hi, t.id,
  ).map((r) => [Number(r.a), Number(r.b)]);
  waiting.push(...all(`SELECT created_at AS a, COALESCE(answered_at, ?) AS b FROM inbox WHERE agent_id IN (${ph}) AND blocking = 1 AND kind IN ('question', 'action', 'agent_error', 'permission')`, hi, ...agents).map((r): Span => [Number(r.a), Number(r.b)]));

  // Open blockers (waits_for) until they finished.
  try {
    waiting.push(...all('SELECT w.created_at AS a, COALESCE(b.finished_at, ?) AS b FROM task_waits w JOIN tasks b ON b.id = w.waits_for WHERE w.task_id = ?', hi, t.id).map((r): Span => [Number(r.a), Number(r.b)]));
  } catch {}
  // A task the director drives: from a director post asking the user to the next post.
  const root = all('SELECT id FROM agents WHERE project_id = ? AND parent_id IS NULL', t.project_id)[0];
  if (root && t.driver_agent_id === root.id) {
    const posts = all("SELECT author, body, created_at FROM task_messages WHERE task_id = ? AND kind IN ('message', 'summary') ORDER BY id", t.id);
    posts.forEach((p, i) => {
      if (p.author === 'director' && waitingSentence(String(p.body))) waiting.push([Number(p.created_at), Number(posts[i + 1]?.created_at ?? hi)]);
    });
  }
  let userStallAt = -Infinity;
  let row: WatchRow = { state: '', tick_at: null, idle_since: null, strikes: 0, strike_at: null, stalled_at: null, idle_ms: 0, waiting_ms: 0, busy_ms: 0 };
  const r = { id: t.id, title: String(t.title).slice(0, 60), idleMin: 0, spells: 0, wake: 0, director: 0, stall: 0, firstAt: null as number | null, rerouted: 0 };
  let ei = 0;
  let last = 0;
  let run = 0;
  for (const [a, b] of spans) {
    row = { ...row, tick_at: null, state: '', idle_since: null };
    for (let at = a + TICK_MS; at <= b; at += TICK_MS) {
      let quiet = true;
      while (ei < evTs.length && evTs[ei] <= at) (last = Math.max(last, evTs[ei++])), (quiet = false);
      const st = inSpans(turns, at) ? 'working' : inSpans(busy, at) ? 'busy' : inSpans(waiting, at) ? 'waiting' : 'idle';
      const moved = row.strikes > 0 && moves.some((m) => m > (row.strike_at ?? 0) && m <= at);
      const out = step(row, st, at, moved, Math.max(last, a));
      row = out.row;
      // Independently of step: minutes in a row idle with nothing pending and no event from its agents.
      run = st === 'idle' && quiet ? run + TICK_MS : 0;
      if (run === IDLE_MS) r.spells++;
      if (out.action) {
        if (out.action === 'stall') {
          if (at - userStallAt < 86_400_000) r.rerouted++;
          else (r.stall++, (userStallAt = at), userStalls.push({ project: String(t.project_id), at }));
        } else r[out.action]++;
        r.firstAt ??= at;
      }
    }
  }
  r.idleMin = Math.round(row.idle_ms / 60_000);
  if (r.spells || r.wake) results.push(r);
}

results.sort((x, y) => y.idleMin - x.idleMin);
const missed = results.filter((r) => r.spells && !r.wake);
console.log(`Window: last ${days} days to ${new Date(end).toISOString()}. Tasks Active in it that sat idle with nothing pending for 3+ min: ${results.filter((r) => r.spells).length}. Caught (woken at least once): ${results.filter((r) => r.wake).length}. Missed: ${missed.length}.`);
const projects = new Set(userStalls.map((u) => u.project));
console.log(`Stalled put to the user: ${userStalls.length} (in ${projects.size} project(s); one open request per project, replaced as its list changes). Stalled again within the day, to the director instead: ${results.reduce((n, r) => n + r.rerouted, 0)}. Director told after a second spell: ${results.reduce((n, r) => n + r.director, 0)}.`);
console.log('task | idle min (nothing pending) | wakes | director told | stalled | first caught');
for (const r of results) console.log(`${r.id} | ${r.idleMin} | ${r.wake} | ${r.director} | ${r.stall} | ${r.firstAt ? new Date(r.firstAt).toISOString() : '-'} | ${r.title}`);
if (missed.length) process.exitCode = 1;
