import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { all, db, get, newId, now, run } from './db.ts';
import type { Row } from './db.ts';
import { touchProject } from './store.ts';
import { clockText } from './clock.ts';
import { checkDanger } from './danger.ts';
import { dangerContext } from './triage.ts';
import { createRequest } from './requests.ts';
import { diskStatus } from './disk.ts';
import { deepTasks, metricsOf, modelUse, telemetryRows } from './telemetry.ts';
import { findingCode, worstTasksText } from './findingcode.ts';
import { findingShareNow } from './findingstats.ts';

/**
 * Watches: standing conditions Helm checks on a schedule and acts on when they trip, so "if X passes 15% I will do Y"
 * is kept by Helm rather than promised by an agent that only acts when woken.
 *
 * A watch measures one number: a dashboard tile's number, a built-in measure (BUILTINS), or a command's output (run in
 * the project's folder, read-only, with a time limit; the first number it prints, or the one a pattern captures).
 * Its condition is above or below a value, held for a time (for_ms; 0: at once). The runner checks each watch every
 * `every_ms` (startWatches). When the condition has held long enough the watch trips once: the director is woken with
 * a note, and with `ask_user` a request goes to the user too. It then rests (firing) until the condition clears.
 * A watch that cannot be measured keeps the error on its row (the Watches page shows it) and tells the director once.
 */

db.exec(`CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  measure TEXT NOT NULL,
  op TEXT NOT NULL,
  value REAL NOT NULL,
  for_ms INTEGER NOT NULL DEFAULT 0,
  every_ms INTEGER NOT NULL,
  then_note TEXT NOT NULL DEFAULT '',
  ask_user INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_value REAL,
  last_checked_at INTEGER,
  last_error TEXT,
  error_noted INTEGER NOT NULL DEFAULT 0,
  cond_since INTEGER,
  firing INTEGER NOT NULL DEFAULT 0,
  tripped_at INTEGER,
  trips INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS watches_project ON watches(project_id);`);
// A command watch runs only the exact command the user approved (commandKey); until then it waits, paused if it
// existed before approval was asked for. Added with the column: any command watch from before is paused once.
if (!(db.prepare('PRAGMA table_info(watches)').all() as { name: string }[]).some((c) => c.name === 'approved_command')) {
  db.exec('ALTER TABLE watches ADD COLUMN approved_command TEXT');
  db.exec('ALTER TABLE watches ADD COLUMN approval_request TEXT');
  db.exec(`UPDATE watches SET state = 'paused', last_error = 'Waits for the user to approve its command.' WHERE json_extract(measure, '$.kind') = 'command'`);
}

const MIN = 60_000;
const DAY = 86_400_000;
export const MIN_EVERY_MS = 5 * MIN;
const COMMAND_TIMEOUT_MS = 30_000;

export type Measure =
  | { kind: 'builtin'; builtin: BuiltinId; days?: number }
  | { kind: 'tile'; tile: string }
  | { kind: 'command'; command: string; cwd?: string; pattern?: string };

// ---------- built-in measures ----------

/** Share of agents' active time spent finding code over the last `days` (findingcode.ts). */
export const findingCodeShare = (projectId: string, days: number, at = now()) => findingCode(all, projectId, at - days * DAY, at + 1).all.timeShare;

/** Free space on the fullest filesystem Helm watches, in GB. */
function freeDiskGb(): number | null {
  const fs = diskStatus().filesystems;
  if (!fs.length) return null;
  return Math.round((Math.min(...fs.map((f) => Number(f.free))) / 1e9) * 10) / 10;
}

export const BUILTINS = {
  finding_code: {
    label: 'Time finding code',
    unit: '%',
    // The week's figure the runner keeps (findingstats.ts); another period is measured now.
    read: (p: string, days: number) => (days === 7 ? findingShareNow(p) : findingCodeShare(p, days)),
    detail: (p: string, days: number) => {
      const worst = worstTasksText(all, p, now() - days * DAY, now() + 1);
      return worst ? `That is the share of agent time spent finding code over the last ${days} days. The tasks that spent most time finding code:\n${worst}\nTo judge a code index (graphify or another), trial it on a copy of the project and compare this number before and after.` : '';
    },
  },
  tokens_per_task: { label: 'Tokens per accepted task', unit: 'tokens', read: (p: string, days: number) => metricsOf(telemetryRows({ project: p }, now() - days * DAY)).tokens.value },
  cycle_minutes: { label: 'Median cycle time', unit: 'min', read: (p: string, days: number) => { const v = metricsOf(telemetryRows({ project: p }, now() - days * DAY)).cycle.value; return v == null ? null : Math.round(v / MIN); } },
  review_rounds: {
    label: 'Review rounds per task',
    unit: '',
    read: (p: string, days: number) => {
      const rows = telemetryRows({ project: p }, now() - days * DAY).filter((r) => r.state === 'done');
      return rows.length ? Math.round((rows.reduce((n, r) => n + Number(r.review_rounds), 0) / rows.length) * 100) / 100 : null;
    },
  },
  free_disk_gb: { label: 'Free disk', unit: 'GB', read: () => freeDiskGb() },
  // Deep (Fable) is for directing: the share of work tokens (not the director's) that ran at Deep (telemetry.ts).
  deep_share: {
    label: 'Work tokens at Deep',
    unit: '%',
    read: (p: string, days: number) => modelUse({ project: p }, now() - days * DAY, now() + 1).deepShare,
    detail: (p: string, days: number) => {
      const tasks = deepTasks({ project: p }, now() - days * DAY, now() + 1);
      return `That is the share of work tokens (not yours) that ran on Fable over the last ${days} days. Fable is for directing; move work to Skilled unless a listed reason holds.${tasks.length ? `\nDeep tasks: ${tasks.map((t) => `[[${t.id}]] (${t.tier_reason || 'no reason'})`).join('; ')}` : ''}`;
    },
  },
} as const;
export type BuiltinId = keyof typeof BUILTINS;
export const isBuiltin = (x: unknown): x is BuiltinId => typeof x === 'string' && x in BUILTINS;

// ---------- commands ----------

/** Verbs and forms that change things: a watch's command must only read. Best effort, with the danger check on top. */
const WRITES = /(^|[;&|]\s*|\$\(\s*|`\s*)(sudo|rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|dd|tee|truncate|kill|pkill|systemctl|reboot|shutdown|npm\s+(i|install|ci|publish|update)|pnpm\s+(i|install|add)|yarn\s+(add|install)|pip\s+install|cargo\s+(install|publish)|docker|git\s+(commit|push|pull|fetch|reset|checkout|switch|merge|rebase|clean|stash|tag|branch|worktree|rm|mv|restore|apply|am|cherry-pick|revert))\b|\bsed\s+-i|\bcurl\b[^|;&]*\s(-X\s*(POST|PUT|DELETE|PATCH)|-d|--data)|(^|[^0-9&])>(?!\s*\/dev\/null|&)/;

/**
 * Why a command cannot be a watch's measure, or null. Checked when it is set and again before every run: the write
 * refusals above, the folder inside the project, and the same danger check an agent's Bash call gets (triage.ts
 * dangerContext: the project, its worktrees, Helm's data, Helm's own processes).
 */
export function commandRefusal(project: Row, command: string, cwd?: string): string | null {
  if (!command.trim()) return 'Give the command.';
  if (command.length > 1000) return 'The command is too long (1000 characters at most).';
  if (WRITES.test(command)) return 'A watch only reads: this command looks like it changes something (a write, a redirect into a file, git or package changes, sudo).';
  const dir = resolve(project.path, cwd ?? '.');
  const rel = relative(project.path, dir);
  if (rel.startsWith('..') || isAbsolute(rel)) return 'The folder must be inside the project.';
  const danger = checkDanger('Bash', { command }, { ...dangerContext(project, { id: 'watch', run_host_id: null }), cwd: dir });
  if (danger.dangerous) return `Refused by the danger check: ${danger.reason}.`;
  return null;
}

/** What the user approves: the command, its folder and its pattern, exactly. */
export function commandKey(m: Measure): string | null {
  return m.kind === 'command' ? JSON.stringify({ command: m.command, cwd: m.cwd || '.', pattern: m.pattern || '' }) : null;
}
/** Whether a watch may run: not a command, or the command the user approved. */
export function approved(w: Row): boolean {
  try {
    const key = commandKey(JSON.parse(w.measure));
    return key === null || w.approved_command === key;
  } catch {
    return false;
  }
}
export const APPROVE = 'Approve';
export const DECLINE = 'Decline';

/** File the one request for the user to approve a watch's command (replacing an open one for an older command). */
function askApproval(w: Row, by: string) {
  const m = JSON.parse(w.measure) as Extract<Measure, { kind: 'command' }>;
  const key = commandKey(m)!;
  if (w.approval_request) run("UPDATE inbox SET status = 'dismissed', answer = 'Replaced by a newer command', answered_at = ? WHERE id = ? AND status = 'open'", now(), w.approval_request);
  const req = createRequest({
    projectId: w.project_id,
    agentId: null,
    kind: 'question',
    title: `Run this command for the watch "${w.name}"?`,
    body:
      `${by} set a watch that runs a shell command on a schedule, read-only, with a ${COMMAND_TIMEOUT_MS / 1000} s limit:\n\n\`\`\`\n${m.command}\n\`\`\`\n\n` +
      `Folder: ${m.cwd || 'the project folder'}. Every ${dur(Number(w.every_ms))}. It does not run until you approve it, and a changed command asks again.`,
    options: [{ label: APPROVE, detail: 'Run exactly this command on its schedule' }, { label: DECLINE, detail: 'Never run it; the watch stays paused' }],
    payload: { watch_approval: w.id, key },
    importance: 3,
    blocking: false,
  });
  run('UPDATE watches SET approval_request = ? WHERE id = ?', req.id, w.id);
}

/** The user's answer to an approval request (answers.ts): Approve runs exactly that command from now; Decline pauses it. */
export function onWatchAnswer(item: Row, choice: string | undefined) {
  const p = JSON.parse(item.payload || '{}');
  if (!p.watch_approval) return;
  const w = get('SELECT * FROM watches WHERE id = ?', p.watch_approval);
  if (!w) return;
  // Approval is for the command the request showed; a command changed since needs its own.
  if (choice === APPROVE && commandKey(JSON.parse(w.measure)) === p.key) approveWatch(w.id, p.key);
  // Declined, or a note alone (it never approves): the watch stays paused.
  else if (choice === DECLINE || !choice) {
    run("UPDATE watches SET state = 'paused', last_error = 'The user declined its command.', updated_at = ? WHERE id = ?", now(), w.id);
    touchProject(w.project_id);
  }
}
/** Approve a watch's command as it is now (the page's Approve, or the request's). */
export function approveWatch(id: string, key?: string): string | null {
  const w = get('SELECT * FROM watches WHERE id = ?', id);
  if (!w) return 'No such watch.';
  const now_ = commandKey(JSON.parse(w.measure));
  if (!now_) return 'This watch runs no command.';
  if (key && key !== now_) return 'The command changed since; approve the new one.';
  run("UPDATE watches SET approved_command = ?, state = 'active', last_error = NULL, error_noted = 0, updated_at = ? WHERE id = ?", now_, now(), id);
  if (w.approval_request) run("UPDATE inbox SET status = 'answered', answer = ?, answered_at = ? WHERE id = ? AND status = 'open'", APPROVE, now(), w.approval_request);
  touchProject(w.project_id);
  return null;
}

function runCommand(project: Row, m: { command: string; cwd?: string; pattern?: string }): Promise<number> {
  return new Promise((done, fail) => {
    const why = commandRefusal(project, m.command, m.cwd);
    if (why) return fail(new Error(why));
    execFile('bash', ['-c', m.command], { cwd: resolve(project.path, m.cwd ?? '.'), timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1 << 20, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), LANG: 'C.UTF-8' } }, (err, stdout, stderr) => {
      if (err && (err as any).killed) return fail(new Error(`It did not finish within ${COMMAND_TIMEOUT_MS / 1000} s.`));
      if (err) return fail(new Error(`It failed (exit ${(err as any).code ?? '?'}): ${String(stderr || err.message).trim().slice(0, 200)}`));
      const out = String(stdout);
      let text: string | undefined;
      if (m.pattern) {
        let re: RegExp;
        try {
          re = new RegExp(m.pattern);
        } catch {
          return fail(new Error('Its pattern is not a valid regular expression.'));
        }
        const hit = re.exec(out);
        text = hit?.[1] ?? hit?.[0];
      } else text = /-?\d+(?:\.\d+)?/.exec(out)?.[0];
      const n = Number(text);
      if (text === undefined || !Number.isFinite(n)) return fail(new Error(`Its output has no number${m.pattern ? ' for the pattern' : ''}: "${out.trim().slice(0, 80)}"`));
      done(n);
    });
  });
}

// ---------- measuring ----------

/** One watch's number now, or why it cannot be had. */
export async function measure(w: Row): Promise<{ value: number } | { error: string }> {
  let m: Measure;
  try {
    m = JSON.parse(w.measure);
  } catch {
    return { error: 'Its measure is unreadable.' };
  }
  try {
    if (m.kind === 'builtin') {
      if (!isBuiltin(m.builtin)) return { error: `No built-in measure "${m.builtin}".` };
      const v = BUILTINS[m.builtin].read(w.project_id, m.days ?? 7);
      return v == null || !Number.isFinite(v) ? { error: `No ${BUILTINS[m.builtin].label.toLowerCase()} to measure yet (nothing recorded in the period).` } : { value: v };
    }
    if (m.kind === 'tile') {
      const t = get('SELECT kind, data, error FROM tiles WHERE id = ? AND project_id = ?', m.tile, w.project_id);
      if (!t) return { error: 'Its dashboard tile was removed.' };
      if (t.kind !== 'number') return { error: 'Its tile is not a number tile.' };
      const v = Number((t.data ? JSON.parse(t.data) : {})?.value);
      return Number.isFinite(v) ? { value: v } : { error: 'Its tile has no number yet.' };
    }
    if (m.kind === 'command') {
      // Only the exact command the user approved runs.
      if (!approved(w)) return { error: WAITING, pending: true } as { error: string };
      const project = get('SELECT * FROM projects WHERE id = ?', w.project_id);
      if (!project) return { error: 'No project.' };
      return { value: await runCommand(project, m) };
    }
    return { error: 'Unknown measure.' };
  } catch (err) {
    return { error: String((err as Error)?.message ?? err).slice(0, 300) };
  }
}

const holds = (w: Row, v: number) => (w.op === 'above' ? v > Number(w.value) : v < Number(w.value));

export type Hooks = { tell: (projectId: string, text: string) => Promise<void> | void; ask: (projectId: string, title: string, body: string) => void };
let hooks: Hooks = { tell: () => {}, ask: () => {} };
export const setWatchHooks = (h: Hooks) => {
  hooks = h;
};

/**
 * Check one watch now and act on it. Trips once when the condition has held for for_ms, then rests (firing) until
 * the condition clears. Returns what happened.
 */
export async function evaluate(w: Row, at = now()): Promise<'tripped' | 'holds' | 'clear' | 'unmeasurable'> {
  const r = await measure(w);
  if ('error' in r) {
    run('UPDATE watches SET last_checked_at = ?, last_error = ?, last_value = NULL, updated_at = ? WHERE id = ?', at, r.error, at, w.id);
    // Waiting for the user is not a fault to report: the request is with them.
    if (!w.error_noted && !(r as { pending?: boolean }).pending) {
      run('UPDATE watches SET error_noted = 1 WHERE id = ?', w.id);
      await hooks.tell(w.project_id, `<helm-note kind="watch">The watch "${w.name}" cannot be measured: ${r.error} Fix it with set_watch, or remove it.</helm-note>`);
    }
    touchProject(w.project_id);
    return 'unmeasurable';
  }
  const v = r.value;
  if (!holds(w, v)) {
    run('UPDATE watches SET last_checked_at = ?, last_value = ?, last_error = NULL, error_noted = 0, cond_since = NULL, firing = 0, updated_at = ? WHERE id = ?', at, v, at, w.id);
    touchProject(w.project_id);
    return 'clear';
  }
  const since = w.cond_since ?? at;
  const due = !w.firing && at - since >= Number(w.for_ms);
  run(
    'UPDATE watches SET last_checked_at = ?, last_value = ?, last_error = NULL, error_noted = 0, cond_since = ?, firing = ?, tripped_at = CASE WHEN ? THEN ? ELSE tripped_at END, trips = trips + ?, updated_at = ? WHERE id = ?',
    at, v, since, due || w.firing ? 1 : 0, due ? 1 : 0, at, due ? 1 : 0, at, w.id,
  );
  touchProject(w.project_id);
  if (!due) return 'holds';
  const cond = conditionText(w);
  const detail = detailOf(w);
  await hooks.tell(
    w.project_id,
    `<helm-note kind="watch">The watch "${w.name}" tripped: ${valueText(w, v)}, ${cond}.${w.then_note ? ` What was meant to happen: ${w.then_note}` : ''} Act on it now. It rests until the condition clears.${detail ? `\n${detail}` : ''}</helm-note>`,
  );
  if (w.ask_user) hooks.ask(w.project_id, `Watch tripped: ${w.name}`, `${valueText(w, v)}, ${cond}.${w.then_note ? `\n\n${w.then_note}` : ''}`);
  return 'tripped';
}

/** What a built-in measure adds to a trip's note (the worst tasks for finding code). */
function detailOf(w: Row): string {
  try {
    const m = JSON.parse(w.measure) as Measure;
    if (m.kind !== 'builtin' || !isBuiltin(m.builtin)) return '';
    const b = BUILTINS[m.builtin] as { detail?: (p: string, days: number) => string };
    return b.detail ? b.detail(w.project_id, m.days ?? 7) : '';
  } catch {
    return '';
  }
}

// ---------- text ----------

function unitOf(w: Row): string {
  try {
    const m = JSON.parse(w.measure) as Measure;
    return m.kind === 'builtin' && isBuiltin(m.builtin) ? BUILTINS[m.builtin].unit : '';
  } catch {
    return '';
  }
}
const num = (n: number) => (Math.abs(n) >= 10_000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : String(Math.round(n * 100) / 100));
export const valueText = (w: Row, v: number) => `${num(v)}${unitOf(w) === '%' ? '%' : unitOf(w) ? ` ${unitOf(w)}` : ''}`;
const dur = (ms: number) => (ms >= DAY ? `${Math.round(ms / DAY)} day${ms >= 1.5 * DAY ? 's' : ''}` : ms >= 3600_000 ? `${Math.round(ms / 3600_000)} h` : `${Math.round(ms / MIN)} min`);
export const conditionText = (w: Row) => `${w.op} ${valueText(w, Number(w.value))}${Number(w.for_ms) ? ` for ${dur(Number(w.for_ms))}` : ''}`;

export function measureText(w: Row): string {
  try {
    const m = JSON.parse(w.measure) as Measure;
    if (m.kind === 'builtin') return isBuiltin(m.builtin) ? `${BUILTINS[m.builtin].label}${m.builtin === 'free_disk_gb' ? '' : `, last ${m.days ?? 7} days`}` : m.builtin;
    if (m.kind === 'tile') return `Tile ${get('SELECT title FROM tiles WHERE id = ?', m.tile)?.title ?? m.tile}`;
    return `\`${m.command}\`${m.cwd ? ` in ${m.cwd}` : ''}`;
  } catch {
    return '?';
  }
}

/** A watch as the page and the tools show it. */
export function watchView(w: Row) {
  return {
    id: w.id,
    name: w.name,
    measure: measureText(w),
    condition: conditionText(w),
    every_ms: Number(w.every_ms),
    state: w.state,
    then_note: w.then_note,
    ask_user: !!w.ask_user,
    value: w.last_value == null ? null : valueText(w, Number(w.last_value)),
    checked_at: w.last_checked_at,
    error: w.last_error,
    firing: !!w.firing,
    tripped_at: w.tripped_at,
    trips: Number(w.trips),
    created_by: w.created_by,
    needs_approval: !approved(w),
  };
}
export const listWatches = (projectId: string) => all('SELECT * FROM watches WHERE project_id = ? ORDER BY created_at', projectId).map(watchView);

export function watchesText(projectId: string): string {
  const ws = all('SELECT * FROM watches WHERE project_id = ? ORDER BY created_at', projectId);
  if (!ws.length) return 'No watches on this project.';
  return ws
    .map((w) => {
      const now_ = w.last_error ? `cannot be measured: ${w.last_error}` : w.last_value == null ? 'not checked yet' : `now ${valueText(w, Number(w.last_value))}${w.last_checked_at ? ` (${clockText(w.last_checked_at)})` : ''}`;
      return `- ${w.name} [${w.id}]${w.state === 'paused' ? ' (paused)' : ''}: ${measureText(w)} ${conditionText(w)}, every ${dur(Number(w.every_ms))}; ${now_}${w.firing ? '; tripped, resting until it clears' : ''}${w.tripped_at ? `; last tripped ${clockText(w.tripped_at)}` : ''}`;
    })
    .join('\n');
}

// ---------- changes (the director's tool and the page) ----------

export type WatchInput = {
  id?: string;
  name?: string;
  measure?: Measure;
  op?: 'above' | 'below';
  value?: number;
  for_minutes?: number;
  every_minutes?: number;
  then?: string;
  ask_user?: boolean;
  state?: 'active' | 'paused';
  remove?: boolean;
};

/**
 * Create, change, pause or remove a watch. Returns the watch or why not. `byUser`: the call comes from the user's own
 * page (the API route), so a command they typed is approved as typed. Decided by who called, never by a name: an agent
 * could be called anything. Agents' tools always pass false.
 */
export function setWatch(projectId: string, input: WatchInput, by: string, byUser = false): { watch: Row | null } | { error: string } {
  const project = get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) return { error: 'No such project.' };
  const old = input.id ? get('SELECT * FROM watches WHERE id = ? AND project_id = ?', input.id, projectId) : undefined;
  if (input.id && !old) return { error: `No watch "${input.id}" on this project.` };
  if (input.remove) {
    if (!old) return { error: 'Name the watch to remove (id).' };
    run('DELETE FROM watches WHERE id = ?', old.id);
    touchProject(projectId);
    return { watch: null };
  }
  const m = input.measure ?? (old ? (JSON.parse(old.measure) as Measure) : undefined);
  if (!m) return { error: 'Give what it measures.' };
  if (m.kind === 'builtin' && !isBuiltin(m.builtin)) return { error: `Built-in measures: ${Object.keys(BUILTINS).join(', ')}.` };
  if (m.kind === 'tile') {
    const t = get('SELECT kind FROM tiles WHERE id = ? AND project_id = ?', m.tile, projectId);
    if (!t) return { error: `No tile "${m.tile}" on this project (list_dashboards shows them).` };
    if (t.kind !== 'number') return { error: 'Only a number tile can be watched.' };
  }
  if (m.kind === 'command') {
    const why = commandRefusal(project, m.command, m.cwd);
    if (why) return { error: why };
    if (m.pattern) {
      try {
        new RegExp(m.pattern);
      } catch {
        return { error: 'The pattern is not a valid regular expression.' };
      }
    }
  }
  const name = (input.name ?? old?.name ?? '').trim();
  const op = input.op ?? old?.op;
  const value = input.value ?? old?.value;
  if (!name) return { error: 'Give it a name.' };
  if (op !== 'above' && op !== 'below') return { error: 'op is "above" or "below".' };
  if (typeof value !== 'number' || !Number.isFinite(value)) return { error: 'Give the value to compare with.' };
  const every = input.every_minutes !== undefined ? input.every_minutes * MIN : (old?.every_ms ?? 60 * MIN);
  if (every < MIN_EVERY_MS) return { error: `Check at most every ${MIN_EVERY_MS / MIN} minutes.` };
  const forMs = input.for_minutes !== undefined ? Math.max(0, input.for_minutes) * MIN : (old?.for_ms ?? 0);
  const fields = [name, JSON.stringify(m), op, value, forMs, every, (input.then ?? old?.then_note ?? '').trim().slice(0, 600), (input.ask_user ?? !!old?.ask_user) ? 1 : 0, input.state ?? old?.state ?? 'active', now()];
  let id = old?.id;
  if (old) {
    const changed = JSON.stringify(m) !== old.measure || op !== old.op || value !== old.value;
    run('UPDATE watches SET name = ?, measure = ?, op = ?, value = ?, for_ms = ?, every_ms = ?, then_note = ?, ask_user = ?, state = ?, updated_at = ? WHERE id = ?', ...fields, old.id);
    // A new measure or condition starts afresh.
    if (changed) run('UPDATE watches SET cond_since = NULL, firing = 0, last_value = NULL, last_error = NULL, error_noted = 0, last_checked_at = NULL WHERE id = ?', old.id);
  } else {
    id = newId('watch');
    run(
      'INSERT INTO watches (name, measure, op, value, for_ms, every_ms, then_note, ask_user, state, updated_at, id, project_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ...fields, id, projectId, by, now(),
    );
  }
  // A command not yet approved: the user set it (approved as they typed it), or one request asks them.
  const w = get('SELECT * FROM watches WHERE id = ?', id)!;
  if (m.kind === 'command' && !approved(w)) {
    if (byUser) approveWatch(w.id);
    else if (!old || commandKey(JSON.parse(old.measure)) !== commandKey(m) || !w.approval_request) askApproval(w, by);
    run('UPDATE watches SET last_error = ? WHERE id = ? AND approved_command IS NOT ?', WAITING, w.id, commandKey(m));
  }
  touchProject(projectId);
  return { watch: get('SELECT * FROM watches WHERE id = ?', id)! };
}
/** The name the page's changes are recorded under. */
export const USER_NAME = 'You';
const WAITING = 'Waits for the user to approve its command.';

// ---------- the first watch ----------

db.exec('CREATE TABLE IF NOT EXISTS watch_seeds (project_id TEXT NOT NULL, seed TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (project_id, seed))');

/**
 * Once per project (a removed one is not put back): "Time finding code" above 15% over the last week, checked every
 * six hours. Measured on this install it is about 3 to 5%; past 15% a code index or language server would pay off.
 */
export function seedWatches(): number {
  let n = 0;
  for (const p of all("SELECT id FROM projects WHERE archived = 0 AND id NOT IN (SELECT project_id FROM watch_seeds WHERE seed = 'finding_code')")) {
    run("INSERT OR IGNORE INTO watch_seeds (project_id, seed, at) VALUES (?, 'finding_code', ?)", p.id, now());
    const res = setWatch(
      p.id,
      { name: 'Time finding code', measure: { kind: 'builtin', builtin: 'finding_code', days: 7 }, op: 'above', value: 15, every_minutes: 360, then: 'Agents spend over 15% of their time finding code: propose a code index or a language-server tool to the user (ask_user), with the numbers.' },
      'Helm',
    );
    if (!('error' in res)) n++;
  }
  // Deep's share of work tokens above 10% over a week: the director and the user are told (Fable is for directing).
  for (const p of all("SELECT id FROM projects WHERE archived = 0 AND id NOT IN (SELECT project_id FROM watch_seeds WHERE seed = 'deep_share')")) {
    run("INSERT OR IGNORE INTO watch_seeds (project_id, seed, at) VALUES (?, 'deep_share', ?)", p.id, now());
    const res = setWatch(
      p.id,
      { name: 'Work on Fable (Deep)', measure: { kind: 'builtin', builtin: 'deep_share', days: 7 }, op: 'above', value: 10, every_minutes: 360, ask_user: true, then: 'Over 10% of work tokens ran on Fable: move tasks to Skilled unless one of the listed Deep reasons holds, and say which in the task.' },
      'Helm',
    );
    if (!('error' in res)) n++;
  }
  return n;
}

// ---------- the runner's timer ----------

let timer: NodeJS.Timeout | null = null;
let busy = false;
/** Every watch due (active, its interval passed) is checked, one at a time. */
export async function checkDue(at = now()) {
  if (busy) return;
  busy = true;
  try {
    for (const w of all("SELECT * FROM watches WHERE state = 'active' AND (last_checked_at IS NULL OR last_checked_at + every_ms <= ?) ORDER BY last_checked_at", at)) {
      try {
        await evaluate(w);
      } catch (err) {
        console.error(`Watch ${w.id}:`, err);
      }
    }
  } finally {
    busy = false;
  }
}
export function startWatches() {
  if (timer) return;
  timer = setInterval(() => void checkDue(), MIN);
  timer.unref?.();
}
export function stopWatches() {
  if (timer) clearInterval(timer);
  timer = null;
}
