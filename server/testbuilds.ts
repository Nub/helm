import { execFile } from 'node:child_process';
import { builderTask } from './buildtask.ts';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ARTIFACT_DIR } from './config.ts';
import { SECRET_DIR, SECRET_NAME, SECRET_TEXT } from './attachments.ts';
import { resultsDir } from './hostwork.ts';
import { promisify } from 'node:util';
import { all, get, newId, now, run } from './db.ts';
import type { Row } from './db.ts';
import { getProject, touchProject } from './store.ts';
import { getTask, taskRef } from './tasks.ts';
import { getChoice } from './settings.ts';
import { tellDirector } from './agents.ts';
import { withdrawRequest } from './requests.ts';
import { MAX_ARTIFACT_BYTES, checkArtifactPath, copyHashed, getRecipe, spaceRefusal } from './releases.ts';
import { testDir } from './recipework.ts';

/**
 * Test builds: a task's build of the release recipe's artifacts at one committed commit, for the user to download and
 * try. Not a release (no version, tag or change log; never in the Releases list): named "Test build N of <task>", its
 * files recipe_tests rows (build_id set) under artifacts/recipe-tests/, checked and copied as a release's are.
 *
 * - make_test_build (an agent on the task, or the director): the files must come from a clean checkout of the commit
 *   (no tracked changes, HEAD at the commit) that the project's repository has.
 * - ask_user test_build: the request carries it (Download, Get link). A newer build for the task supersedes the older
 *   one and withdraws its open request.
 * - Cleanup (runner timer): files go once the request was answered and the task then had no activity for the
 *   project's set days (Setup, default 3), or a day after it was superseded; only when its commit is still in the
 *   repository (else flagged and kept). Never while its request is open or it is the newest build of an Active task.
 *   Live links are revoked first. The record stays, with Rebuild.
 */

const exec = promisify(execFile);
const git = async (dir: string, ...args: string[]) => (await exec('git', ['-C', dir, ...args], { timeout: 30_000 })).stdout.trim();
export const SUPERSEDED_KEEP_MS = 24 * 3600_000;
const DAY = 24 * 3600_000;
export const keepDays = (projectId: string) => Number(getChoice(projectId, 'test_build_days')) || 3;

/** Whether the project's repository has `sha` as a commit. */
export async function commitExists(projectPath: string, sha: string): Promise<boolean> {
  try {
    await git(projectPath, 'cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

export const getBuild = (id: string) => get('SELECT * FROM test_builds WHERE id = ?', id);
const filesOf = (buildId: string) => all('SELECT * FROM recipe_tests WHERE build_id = ? ORDER BY rowid', buildId);
export const buildLabel = (b: Row) => `Test build ${b.n} of ${getTask(b.task_id)?.title ?? 'a task'}`;

/**
 * A file a job copied back from a host (host_workspace_end, hostwork.ts resultsDir): under host-results/<project>/<its
 * workspace>/. That workspace held the code of one commit (git archive of it), so the commit comes from its record.
 * Null when the path is not there; an error when it is but cannot be used (no such workspace, the job failed, a link,
 * not a file, looks like credentials).
 */
function hostResult(project: Row, path: string): { path: string; bytes: number; commit: string } | { error: string } | null {
  if (!isAbsolute(path) || !existsSync(path)) return null;
  const base = join(ARTIFACT_DIR, 'host-results', project.id);
  if (!existsSync(base)) return null;
  const root = realpathSync(base);
  const real = realpathSync(path);
  if (!real.startsWith(root + sep)) return null;
  if (real !== resolve(path)) return { error: `${path} goes through a symlink; give the copied-back file by its real path.` };
  const w = get('SELECT * FROM host_workspaces WHERE id = ? AND project_id = ?', relative(root, real).split(sep)[0], project.id);
  if (!w || !real.startsWith(realpathSync(resultsDir(w)) + sep)) return { error: `${path} is not the result of a workspace of this project.` };
  if (w.state !== 'done') return { error: `The job in workspace ${w.id} did not end well (${w.state}): build it again and end it with ok.` };
  const st = lstatSync(real);
  if (!st.isFile()) return { error: `Not a regular file: ${real}` };
  if (SECRET_NAME.test(basename(real)) || SECRET_DIR.test(real)) return { error: `${basename(real)} looks like credentials or keys; it is not attached.` };
  if (st.size <= 1024 * 1024) {
    const head = readFileSync(real);
    if (!head.includes(0) && SECRET_TEXT.test(head.toString('utf8'))) return { error: `${basename(real)} contains what looks like a private key or API token; it is not attached.` };
  }
  return { path: real, bytes: st.size, commit: w.commit_sha };
}

/**
 * Make a test build from files an agent built. `artifacts`: the recipe's artifact names with the built file of each
 * (all of the recipe's, or the ones named). Returns the build, or why not (nothing kept then).
 */
export async function makeTestBuild(agent: Row, task: Row, input: { artifacts: { name: string; path: string }[]; commit?: string; rebuild_of?: string }, bases: string[] = []): Promise<{ build: Row; text: string } | { error: string }> {
  const project = getProject(task.project_id)!;
  if (task.kind !== 'task') return { error: 'A test build belongs to a task, not a discussion.' };
  const recipe = getRecipe(project.id);
  if (!recipe.artifacts.length) return { error: 'The project has no release recipe with artifacts: a test build builds the recipe. Set it up with the user on the Releases page first.' };
  if (!input.artifacts.length) return { error: 'Name the artifacts you built, each with its file.' };
  const picked: { a: (typeof recipe.artifacts)[number]; path: string; bytes: number }[] = [];
  let head: string | null = null;
  for (const it of input.artifacts) {
    const a = recipe.artifacts.find((x) => x.name === it.name);
    if (!a) return { error: `The recipe has no artifact "${it.name}". It has: ${recipe.artifacts.map((x) => x.name).join(', ')}.` };
    if (picked.some((p) => p.a.name === a.name)) return { error: `"${a.name}" is named twice.` };
    // Built on a host: the workspace's record says the commit (a workspace holds committed work only).
    const remote = hostResult(project, it.path);
    if (remote && 'error' in remote) return remote;
    if (remote) {
      if (head && head !== remote.commit) return { error: 'The files come from different commits: build them all from one commit.' };
      head = remote.commit;
      picked.push({ a, path: remote.path, bytes: remote.bytes });
      continue;
    }
    const checked = checkArtifactPath(project, it.path, bases);
    if ('error' in checked) return checked;
    // Built from a committed tree: the checkout the file sits in has no tracked changes and is at one commit.
    let top: string, at: string, dirty: string;
    try {
      top = await git(dirname(checked.path), 'rev-parse', '--show-toplevel');
      at = await git(top, 'rev-parse', 'HEAD');
      dirty = await git(top, 'status', '--porcelain', '--untracked-files=no');
    } catch {
      return { error: `${checked.path} is not inside a git checkout of the project. Build from a clean checkout of the commit (git worktree add --detach <folder> <commit>).` };
    }
    if (dirty) return { error: `The checkout ${top} has uncommitted changes:\n${dirty.split('\n').slice(0, 5).join('\n')}\nCommit the work first and build from a clean checkout of that commit: a test build must be rebuildable from its commit.` };
    if (head && head !== at) return { error: 'The files come from checkouts at different commits: build them all from one commit.' };
    head = at;
    picked.push({ a, path: checked.path, bytes: checked.bytes });
  }
  let commit = head!;
  if (input.commit?.trim()) {
    let want: string;
    try {
      want = await git(project.path, 'rev-parse', '--verify', `${input.commit.trim()}^{commit}`);
    } catch {
      return { error: `No commit "${input.commit}" in the project's repository.` };
    }
    if (want !== commit) return { error: `The files were built at ${commit.slice(0, 7)}, not ${want.slice(0, 7)}: build from a clean checkout of the commit you name.` };
    commit = want;
  }
  if (!(await commitExists(project.path, commit))) return { error: `Commit ${commit.slice(0, 7)} is not in the project's repository: commit the work on the project (or merge its branch) so the build can be made again.` };
  const total = picked.reduce((n, p) => n + p.bytes, 0);
  if (picked.some((p) => p.bytes > MAX_ARTIFACT_BYTES)) return { error: `A file is over ${MAX_ARTIFACT_BYTES / 1073741824} GB.` };
  const full = spaceRefusal(total);
  if (full) return { error: full };
  const id = newId('tb');
  const n = Number(get('SELECT COUNT(*) AS n FROM test_builds WHERE task_id = ?', task.id)?.n ?? 0) + 1;
  run(
    'INSERT INTO test_builds (id, project_id, task_id, n, commit_sha, recipe, made_by, created_at, rebuild_of) VALUES (?,?,?,?,?,?,?,?,?)',
    id, project.id, task.id, n, commit, JSON.stringify(picked.map((p) => p.a)), agent.name, now(), input.rebuild_of ?? null,
  );
  const made: string[] = [];
  for (const p of picked) {
    const fid = newId('rt');
    const dir = testDir(project.id, fid);
    mkdirSync(dir, { recursive: true });
    const name = basename(p.path).replace(/[^A-Za-z0-9._+-]/g, '_');
    let sum: string;
    try {
      sum = await copyHashed(p.path, join(dir, name));
    } catch (err) {
      for (const f of filesOf(id)) rmSync(testDir(project.id, f.id), { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
      run('DELETE FROM recipe_tests WHERE build_id = ?', id);
      run('DELETE FROM test_builds WHERE id = ?', id);
      return { error: `Could not copy ${p.path}: ${String((err as Error).message).slice(0, 300)}` };
    }
    run(
      "INSERT INTO recipe_tests (id, project_id, artifact, commit_sha, status, file, bytes, sha256, started_at, finished_at, build_id) VALUES (?,?,?,?,'done',?,?,?,?,?,?)",
      fid, project.id, p.a.name, commit, `recipe-tests/${project.id}/${fid}/${name}`, statSync(join(dir, name)).size, sum, now(), now(), id,
    );
    made.push(`${p.a.name} (${(p.bytes / 1048576).toFixed(1)} MB)`);
  }
  touchProject(project.id);
  const build = getBuild(id)!;
  return { build, text: `Made ${buildLabel(build)} [${id}] at ${commit.slice(0, 7)}: ${made.join(', ')}. Ask the user to try it with ask_user (kind action, test_build "${id}", the steps to try); it shows with Download on the request.` };
}

/** ask_user test_build: the request carries it; older builds of the task are superseded and their open requests withdrawn. */
export function attachToRequest(buildId: string, requestId: string) {
  const b = getBuild(buildId);
  if (!b) return;
  for (const old of all("SELECT * FROM test_builds WHERE task_id = ? AND id != ? AND state IN ('ready', 'waiting', 'feedback') AND created_at <= ?", b.task_id, b.id, b.created_at)) {
    run("UPDATE test_builds SET state = 'superseded', superseded_at = ? WHERE id = ?", now(), old.id);
    if (old.request_id && get("SELECT 1 AS x FROM inbox WHERE id = ? AND status IN ('open', 'held')", old.request_id)) withdrawRequest(old.request_id, `A newer test build replaces it (test build ${b.n}).`);
  }
  run("UPDATE test_builds SET request_id = ?, state = 'waiting' WHERE id = ?", requestId, b.id);
  touchProject(b.project_id);
}

/** A test request was answered (or dismissed): its build has its feedback. */
export function onTestBuildAnswer(requestId: string) {
  run("UPDATE test_builds SET state = 'feedback', feedback_at = ? WHERE request_id = ? AND state = 'waiting'", now(), requestId);
}

/** Its files go (Delete, or the cleanup): links revoked, files removed, the record kept with why. */
export function removeBuildFiles(b: Row, why: string): number {
  const files = filesOf(b.id).filter((f) => f.file);
  for (const f of files) rmSync(testDir(b.project_id, f.id), { recursive: true, force: true });
  run('UPDATE recipe_tests SET file = NULL WHERE build_id = ?', b.id);
  run("UPDATE download_links SET revoked_at = COALESCE(revoked_at, ?) WHERE release_id = ? AND kind = 'test'", now(), b.id);
  run("UPDATE test_builds SET state = 'removed', removed_at = ?, removed_why = ? WHERE id = ?", now(), why, b.id);
  touchProject(b.project_id);
  return files.length;
}

/** The latest time anything happened on a task: a thread message or a state change, a request, an agent's turn. */
function lastActivity(taskId: string): number {
  const t = getTask(taskId);
  return Math.max(
    Number(t?.updated_at ?? 0),
    Number(get('SELECT MAX(created_at) AS t FROM task_messages WHERE task_id = ?', taskId)?.t ?? 0),
    Number(get('SELECT MAX(COALESCE(answered_at, created_at)) AS t FROM inbox WHERE task_id = ?', taskId)?.t ?? 0),
  );
}

/** Why a build's files may not go now, or null when the rule says they go. */
export async function keepReason(b: Row, at = now()): Promise<string | null> {
  if (b.state === 'removed') return 'already removed';
  if (!filesOf(b.id).some((f) => f.file)) return 'no files';
  if (b.state === 'ready') return 'not asked yet';
  if (b.request_id && get("SELECT 1 AS x FROM inbox WHERE id = ? AND status IN ('open', 'held', 'director', 'check')", b.request_id)) return 'its test request is open';
  const task = getTask(b.task_id);
  const newest = get("SELECT id FROM test_builds WHERE task_id = ? AND state != 'removed' ORDER BY created_at DESC LIMIT 1", b.task_id)?.id;
  if (task?.state === 'active' && newest === b.id) return 'the newest build of an Active task';
  if (b.state === 'superseded') {
    if (at - Number(b.superseded_at ?? at) < SUPERSEDED_KEEP_MS) return 'superseded less than a day ago';
  } else if (b.state === 'feedback') {
    const quiet = keepDays(b.project_id) * DAY;
    if (at - Math.max(Number(b.feedback_at ?? 0), lastActivity(b.task_id)) < quiet) return `the task had activity in the last ${keepDays(b.project_id)} days`;
  } else return `state ${b.state}`;
  const project = getProject(b.project_id);
  if (!project || !(await commitExists(project.path, b.commit_sha))) return 'commit missing';
  return null;
}

/** The cleanup: every build whose files may go, gone; builds whose commit is missing flagged. Returns how many went. */
export async function sweepTestBuilds(at = now()): Promise<number> {
  let n = 0;
  for (const b of all("SELECT * FROM test_builds WHERE state IN ('feedback', 'superseded')")) {
    const why = await keepReason(b, at);
    if (why === 'commit missing') {
      if (!b.flag) {
        run("UPDATE test_builds SET flag = ? WHERE id = ?", `Kept: commit ${String(b.commit_sha).slice(0, 7)} is not in the repository, so this build could not be made again.`, b.id);
        touchProject(b.project_id);
      }
      continue;
    }
    if (why) continue;
    removeBuildFiles(b, b.state === 'superseded' ? 'superseded by a newer test build' : 'tested, then no activity');
    n++;
  }
  return n;
}

/** Rebuild: the user's tap; a fresh builder makes it again at its commit (a new build replaces it, buildtask.ts). */
export async function askRebuild(b: Row): Promise<string | null> {
  const task = getTask(b.task_id);
  if (!task) return 'Its task no longer exists.';
  const project = getProject(b.project_id)!;
  if (!(await commitExists(project.path, b.commit_sha))) return `Commit ${String(b.commit_sha).slice(0, 7)} is not in the repository any more: it cannot be rebuilt.`;
  run('UPDATE test_builds SET rebuild_asked_at = ? WHERE id = ?', now(), b.id);
  touchProject(b.project_id);
  const names = (JSON.parse(b.recipe || '[]') as { name: string }[]).map((a) => a.name);
  // A fresh builder makes it again (buildtask.ts): the director does not build.
  const files = (JSON.parse(b.recipe || '[]') as { files?: string[] }[]).flatMap((a) => a.files ?? []);
  builderTask(b.project_id, {
    title: `Rebuild ${buildLabel(b)}`,
    brief: `The user asked to rebuild ${buildLabel(b)} [${b.id}] on ${taskRef(task)}. Build ${names.join(', ')} by the release recipe from a clean checkout of ${b.commit_sha} (\`git worktree add --detach <folder> ${b.commit_sha}\`, removed afterwards), then make_test_build with task "${task.id}", rebuild_of "${b.id}" and commit "${b.commit_sha}". No new test request is needed unless the user asks.`,
    touches: files,
    check: `make_test_build with rebuild_of "${b.id}": the new build attached to ${task.id}`,
  });
  return null;
}

// ---------- views ----------

export function buildView(b: Row) {
  const task = getTask(b.task_id);
  const req = b.request_id ? get('SELECT id, status FROM inbox WHERE id = ?', b.request_id) : undefined;
  return {
    id: b.id,
    n: b.n,
    label: buildLabel(b),
    task: task ? { id: task.id, title: task.title, state: task.state } : null,
    commit: b.commit_sha,
    state: b.state,
    made_by: b.made_by,
    created_at: b.created_at,
    feedback_at: b.feedback_at,
    removed_at: b.removed_at,
    removed_why: b.removed_why,
    flag: b.flag,
    rebuild_asked_at: b.rebuild_asked_at,
    request: req ?? null,
    files: filesOf(b.id).map((f) => ({ id: f.id, name: f.artifact, file: f.file ? basename(f.file) : null, url: f.file ? `/artifacts/${f.file}` : null, bytes: f.bytes, sha256: f.sha256 })),
  };
}

export const listBuilds = (projectId: string) => all('SELECT * FROM test_builds WHERE project_id = ? ORDER BY created_at DESC', projectId).map(buildView);
export const buildsForTask = (taskId: string) => all('SELECT * FROM test_builds WHERE task_id = ? ORDER BY created_at DESC', taskId).map(buildView);

/** Bytes of test build files per build, for the Disk page. */
export function buildFiles(projectId: string): { build: Row; bytes: number }[] {
  return all('SELECT b.*, SUM(t.bytes) AS kept FROM test_builds b JOIN recipe_tests t ON t.build_id = b.id WHERE b.project_id = ? AND t.file IS NOT NULL GROUP BY b.id ORDER BY b.created_at DESC', projectId).map((b) => ({ build: b, bytes: Number(b.kept) }));
}

let timer: NodeJS.Timeout | null = null;
/** Runner side: the cleanup every hour, the first a few minutes after start. */
export function startTestBuildSweep() {
  if (timer) return;
  const tick = () => void sweepTestBuilds().catch((err) => console.error('Test build cleanup:', err));
  timer = setInterval(tick, 3600_000);
  timer.unref?.();
  setTimeout(tick, 5 * 60_000).unref?.();
}
