import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { all, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { getProject } from './store.ts';
import { clockText } from './clock.ts';

/**
 * Checks run once. A project declares its checks (set_checks, the director): quick (what an agent runs while working)
 * and full (everything, with the expected minutes). Agents run only their task's named check and the quick checks;
 * the full set runs once per batch, on the main line, started by Helm when the builder's batch ends (batchclerk.ts) or
 * by the director with run_checks, in the
 * background. The result is kept against the commit: a commit already checked is not checked again. A failure names
 * the first failing check and the tasks finished since the last good run. Runner side (the runs are its processes).
 */

export type Check = { name: string; command: string };
export type Declared = { quick: Check[]; full: Check[]; minutes: number | null };

/** One check may run at most this long before it counts as failed. */
export const CHECK_TIMEOUT_MS = 40 * 60_000;
/** A run still marked running after this long was cut short (Helm restarted): it may be started again. */
export const STALE_RUN_MS = 3 * 60 * 60_000;

export function declaredChecks(projectId: string): Declared {
  const r = get('SELECT * FROM project_checks WHERE project_id = ?', projectId);
  return r ? { quick: JSON.parse(r.quick), full: JSON.parse(r.full), minutes: r.minutes ?? null } : { quick: [], full: [], minutes: null };
}

/** The director declares the checks. Returns an error, or null. */
export function setChecks(projectId: string, d: Declared): string | null {
  for (const c of [...d.quick, ...d.full]) {
    if (!c.name?.trim() || !c.command?.trim()) return 'Each check needs a name and a command.';
  }
  if (!d.full.length) return 'Give at least one full check.';
  run(
    'INSERT OR REPLACE INTO project_checks (project_id, quick, full, minutes, updated_at) VALUES (?, ?, ?, ?, ?)',
    projectId, JSON.stringify(d.quick), JSON.stringify(d.full), d.minutes ?? null, now(),
  );
  return null;
}

const exec = promisify(execFile);
async function head(path: string): Promise<string | null> {
  try {
    return (await exec('git', ['-C', path, 'rev-parse', 'HEAD'], { timeout: 10_000 })).stdout.trim();
  } catch {
    return null;
  }
}

/** At most this many tasks are named in a failure note, the most recent first. */
export const SINCE_SHOWN = 10;

/** The tasks a failure note names: the newest SINCE_SHOWN finished since the last good run; none when there was none. */
function sinceText(raw: string | null | undefined): string {
  let since: unknown;
  try {
    since = JSON.parse(raw || '[]');
  } catch {
    since = [];
  }
  if (!Array.isArray(since)) return ' No earlier run passed, so no tasks are named.';
  if (!since.length) return '';
  const newest = [...(since as string[])].reverse();
  const shown = newest.slice(0, SINCE_SHOWN).map((id) => `[[${id}]]`).join(', ');
  const rest = newest.length - SINCE_SHOWN;
  return ` Tasks finished since the last good run, newest first: ${shown}${rest > 0 ? `, and ${rest} earlier` : ''}.`;
}

/** A run as text for the director. */
export function runLine(r: Row): string {
  const c = String(r.commit).slice(0, 7);
  if (r.status === 'running') return `Checks are running on ${c} (started ${clockText(r.started_at)}).`;
  const mins = r.finished_at ? Math.max(1, Math.round((r.finished_at - r.started_at) / 60000)) : 0;
  if (r.status === 'passed') return `Checks passed on ${c} (${mins} min, ${clockText(r.finished_at)}).`;
  const out = r.output ? `\nLast output:\n${String(r.output).slice(-1500)}` : '';
  // The command never ran (not found, not executable): nothing was checked, so no task is blamed.
  if (r.status === 'unstartable') return `Checks could not start on ${c}: "${r.failed_check}" did not run (${clockText(r.finished_at)}). Nothing was checked; fix the command or what it needs (set_checks).${out}`;
  return `Checks failed on ${c} at "${r.failed_check}" (${clockText(r.finished_at)}).${sinceText(r.since_tasks)}${out}`;
}

/** A finished run as the director's note (run_checks, the batch clerk). */
export const checksNote = (r: Row) =>
  `<helm-note kind="checks">${runLine(r)}${r.status === 'failed' ? ' Send it to the agent whose task broke it, as a new task at the top of the queue.' : ''}</helm-note>`;

/** Whether a check's result means its command never started: exit 126/127 (bash: not executable, not found). */
export const couldNotStart = (r: { code: number; output: string }) =>
  r.code === 127 || r.code === 126 || (r.code !== 0 && /: command not found\s*$/m.test(r.output.split('\n').slice(-3).join('\n')));

/** The latest run for a project, or for one commit. */
export const latestRun = (projectId: string, commit?: string): Row | undefined =>
  commit ? get('SELECT * FROM check_runs WHERE project_id = ? AND commit_sha = ? ORDER BY id DESC LIMIT 1', projectId, commit) : get('SELECT * FROM check_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1', projectId);
const asRow = (r: Row | undefined) => (r ? { ...r, commit: r.commit_sha } : r);

/**
 * The environment a check runs in: an agent's Bash call gets the runner's own environment (runtime.ts passes
 * process.env to its session), so Node and npm are on PATH as they are for agents. Without Helm's own variables: a
 * check must not touch the running Helm's data.
 */
export const checkEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HELM_'))) as NodeJS.ProcessEnv;

/** How a check is run (tests replace it): exit code and the tail of its output. */
export let runCommand = (command: string, cwd: string): Promise<{ code: number; output: string }> =>
  new Promise((resolve) => {
    // `bash -c`, not a login shell: a login shell reads the system profile, which sets PATH afresh and drops the one
    // agents have (that is how "npm: command not found" happened).
    const child = spawn('bash', ['-c', command], { cwd, env: checkEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (d: Buffer) => (out = (out + d.toString()).slice(-8000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), CHECK_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: out });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, output: String(err) });
    });
  });
export function setRunCommand(fn: typeof runCommand) {
  runCommand = fn;
}

/**
 * run_checks: the full set on the main checkout's current commit, in the background. A commit already checked returns
 * its stored result; a run in progress says so. `done` is called with the finished run (to tell the director).
 */
export async function startChecks(projectId: string, done: (r: Row) => void): Promise<{ text: string; started: boolean }> {
  const project = getProject(projectId);
  if (!project) return { text: 'No such project.', started: false };
  const d = declaredChecks(projectId);
  if (!d.full.length) return { text: 'This project has no checks declared. Declare them first with set_checks (quick and full).', started: false };
  const commit = await head(project.path);
  if (!commit) return { text: 'The project folder is not a git repository with a commit.', started: false };
  const stored = latestRun(projectId, commit);
  if (stored && (stored.status !== 'running' || now() - stored.started_at < STALE_RUN_MS)) {
    return { text: `${runLine(asRow(stored)!)} ${stored.status === 'running' ? 'You will be told when it ends.' : 'This commit was already checked; nothing was run.'}`, started: false };
  }
  const id = Number(run("INSERT INTO check_runs (project_id, commit_sha, status, started_at) VALUES (?, ?, 'running', ?)", projectId, commit, now()).lastInsertRowid);
  void (async () => {
    let failed: { name: string; output: string; start: boolean } | null = null;
    for (const c of d.full) {
      const r = await runCommand(c.command, project.path);
      if (r.code !== 0) {
        failed = { name: c.name, output: r.output, start: couldNotStart(r) };
        break;
      }
    }
    // The tasks since the last good run; with none ever, none are named (marked so the note can say why).
    const lastGood = get("SELECT started_at FROM check_runs WHERE project_id = ? AND status = 'passed' ORDER BY id DESC LIMIT 1", projectId);
    const since = !failed || failed.start ? [] : lastGood ? all("SELECT id FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'done' AND finished_at >= ? ORDER BY finished_at", projectId, lastGood.started_at).map((t) => t.id as string) : { no_good_run: true };
    run(
      'UPDATE check_runs SET status = ?, failed_check = ?, output = ?, since_tasks = ?, finished_at = ? WHERE id = ?',
      failed ? (failed.start ? 'unstartable' : 'failed') : 'passed', failed?.name ?? null, failed ? failed.output.slice(-4000) : '', JSON.stringify(since), now(), id,
    );
    done(asRow(get('SELECT * FROM check_runs WHERE id = ?', id))!);
  })().catch((err) => {
    run("UPDATE check_runs SET status = 'failed', failed_check = 'Helm could not run the checks', output = ?, finished_at = ? WHERE id = ?", String(err).slice(0, 2000), now(), id);
  });
  const names = d.full.map((c) => c.name).join(', ');
  return { text: `Started the full checks (${names}) on ${commit.slice(0, 7)} in the background${d.minutes ? `, about ${d.minutes} min` : ''}. You will be told when they end; carry on meanwhile.`, started: true };
}

/** The checks part of an agent's instructions: what to run while working. '' when none are declared. */
export function checksPrompt(projectId: string, manager: boolean): string {
  const d = declaredChecks(projectId);
  if (!d.full.length && !d.quick.length) return '';
  const quick = d.quick.length ? d.quick.map((c) => `\`${c.command}\``).join(', ') : 'none declared';
  return manager
    ? `# Checks\nAgents run only their task's named check and the quick checks (${quick}). Helm runs the full set (${d.full.map((c) => c.name).join(', ')}) when the builder's batch ends and tells you only of a failure; for other work, run it once per merged batch with run_checks: it runs in the background, and a commit already checked returns its stored result. A failure names the first failing check and the tasks finished since the last good run. Reviews read and reproduce; they do not rerun the suite.`
    : `# Checks\nWhile you work, run only your task's named check and the quick checks (${quick}). Never the full suite, and not again after a rebase unless it conflicted: the director runs the full set once per batch.`;
}
