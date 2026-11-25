import { createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { builderTask } from './buildtask.ts';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { ARTIFACT_DIR, DATA_DIR } from './config.ts';
import { SECRET_DIR, SECRET_NAME, SECRET_TEXT, projectRoots } from './attachments.ts';
import { getDiskSettings, thresholds } from './disk.ts';
import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { getSetting } from './settings.ts';
import { addJournal, getProject, touchProject } from './store.ts';
import { projectHosts } from './hosts.ts';
import { USER, createTask } from './tasks.ts';
import type { Author } from './tasks.ts';
import { createRequest } from './requests.ts';
import { rootAgent, tellDirector } from './agents.ts';

/**
 * Releases. A project describes once what a release builds (its recipe: artifacts with exact commands, folder, host
 * and files; a version scheme; optional publish steps). Only the user starts a release, by a tap (Cut release on
 * the Releases page, or the cut_release action on a request the director files; no agent tool starts one). Helm proposes the version and commit
 * and gathers the tasks finished since the previous release; the director writes the change log for users; an agent
 * builds each artifact from a clean checkout of the commit and attaches the files (copied here, sized, checksummed);
 * finish_release tags the commit locally. A failed build fails the release and removes what it made. Publishing
 * happens only after the user confirms a request, each time. Helm itself never runs a recipe.
 *
 * State is in the database and artifacts/releases/<project>/<release>/, read fresh on every use (two processes).
 */

export const OFF_TEXT = 'Releases are off for this project (Setup › Agent context). Nothing was changed.';
export const releasesOn = (projectId: string) => getSetting(projectId, 'releases');
export const SCHEMES = ['semver', 'date'] as const;
export const STATES = ['drafting', 'building', 'ready', 'failed', 'published'] as const;
/** States in which a release is still being made: only one at a time per project. */
const OPEN = ['drafting', 'building'];
/** One artifact at most (a larger build belongs somewhere other than Helm's data folder). */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
export const MAX_NOTES = 20000;

const exec = promisify(execFile);
const parse = <T>(s: unknown, fallback: T): T => {
  if (typeof s !== 'string' || !s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};
const git = async (dir: string, ...args: string[]) => (await exec('git', ['-C', dir, ...args], { timeout: 30_000 })).stdout.trim();

// ---------- the recipe ----------

export type Artifact = { name: string; command: string; cwd: string; host?: string; files: string[]; duration?: string; notes?: string };
export type Recipe = { artifacts: Artifact[]; scheme: (typeof SCHEMES)[number]; publish: string; updated_at: number | null; updated_by: string };

export function getRecipe(projectId: string): Recipe {
  const r = get('SELECT * FROM release_recipes WHERE project_id = ?', projectId);
  return { artifacts: parse<Artifact[]>(r?.artifacts, []), scheme: r?.scheme === 'date' ? 'date' : 'semver', publish: r?.publish ?? '', updated_at: r?.updated_at ?? null, updated_by: r?.updated_by ?? '' };
}

/** Text that looks like a credential: Helm stores none (publish steps refer to credentials already on the machine). */
const SECRET = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(password|passwd|token|secret)\s*[:=]\s*\S{6,}/i;

export type RecipeInput = { artifacts?: Partial<Artifact>[]; scheme?: string; publish?: string };

/**
 * The recipe `input` would make (omitted fields keep the current values), checked as the director's tool and the
 * user's form both are: names, commands, folders and files present, hosts of this project, no credentials.
 */
export function checkRecipe(projectId: string, input: RecipeInput): { recipe: Pick<Recipe, 'artifacts' | 'scheme' | 'publish'> } | { error: string } {
  const cur = getRecipe(projectId);
  let artifacts = cur.artifacts;
  if (input.artifacts) {
    artifacts = [];
    const hosts = projectHosts(projectId);
    for (const [i, a] of input.artifacts.entries()) {
      const name = (a.name ?? '').trim();
      const command = (a.command ?? '').trim();
      const cwd = (a.cwd ?? '').trim();
      const files = (a.files ?? []).map((f) => f.trim()).filter(Boolean);
      if (!name || name.length > 80) return { error: `artifacts[${i}] needs a name of at most 80 characters.` };
      if (artifacts.some((x) => x.name === name)) return { error: `Two artifacts are named "${name}".` };
      if (!command || command.length > 4000) return { error: `"${name}" needs "command": the exact command(s) that build it (at most 4000 characters).` };
      if (!cwd) return { error: `"${name}" needs "cwd": the folder to run it in, relative to the checkout ("." for its root).` };
      if (!files.length) return { error: `"${name}" needs "files": the file(s) it produces, relative to the checkout.` };
      let host = a.host?.trim() || undefined;
      if (host) {
        const h = hosts.find((x) => x.name === host || x.id === host);
        if (!h) return { error: `No host "${host}" on this project. Hosts: ${hosts.map((x) => x.name).join(', ')}. Leave host out when it runs here.` };
        host = h.name;
      }
      artifacts.push({ name, command, cwd, host, files, duration: a.duration?.trim() || undefined, notes: a.notes?.trim() || undefined });
    }
  }
  const scheme = input.scheme ?? cur.scheme;
  if (!SCHEMES.includes(scheme as any)) return { error: `scheme is ${SCHEMES.join(' or ')}.` };
  const publish = (input.publish ?? cur.publish).trim();
  if (publish.length > 8000) return { error: 'Publish instructions are at most 8000 characters.' };
  if (SECRET.test(JSON.stringify(artifacts) + publish)) return { error: 'The recipe seems to contain a credential. Helm stores none: refer to credentials already set up on the machine (a logged-in CLI, a key file by path) instead.' };
  return { recipe: { artifacts, scheme: scheme as Recipe['scheme'], publish } };
}

export function saveRecipe(projectId: string, input: RecipeInput, by: string): { recipe: Recipe } | { error: string } {
  const checked = checkRecipe(projectId, input);
  if ('error' in checked) return checked;
  const { artifacts, scheme, publish } = checked.recipe;
  run(
    'INSERT INTO release_recipes (project_id, artifacts, scheme, publish, updated_by, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET artifacts = excluded.artifacts, scheme = excluded.scheme, publish = excluded.publish, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
    projectId, JSON.stringify(artifacts), scheme, publish, by, now(),
  );
  touchProject(projectId);
  return { recipe: getRecipe(projectId) };
}

export function renderRecipe(r: Recipe): string {
  if (!r.artifacts.length && !r.publish) return `No recipe yet (version scheme ${r.scheme}).`;
  const lines = [`Version scheme: ${r.scheme}.`];
  for (const a of r.artifacts) {
    lines.push(`- ${a.name}: in ${a.cwd}${a.host ? ` on ${a.host}` : ''}${a.duration ? `, takes ${a.duration}` : ''}: ${a.command.replace(/\n/g, ' ⏎ ')} → ${a.files.join(', ')}${a.notes ? ` (${a.notes.replace(/\n/g, ' ')})` : ''}`);
  }
  if (!r.artifacts.length) lines.push('No artifacts: a release is its change log and tag.');
  lines.push(r.publish ? `Publish instructions:\n${r.publish}` : 'No publish instructions: releases stay in Helm.');
  return lines.join('\n');
}

// ---------- proposing a release ----------

export const getRelease = (id: string) => get('SELECT * FROM releases WHERE id = ?', id);
const openRelease = (projectId: string) => get(`SELECT * FROM releases WHERE project_id = ? AND state IN ('drafting','building') ORDER BY created_at LIMIT 1`, projectId);
/** The latest release that counts (not failed). */
const previous = (projectId: string) => get("SELECT * FROM releases WHERE project_id = ? AND state != 'failed' ORDER BY created_at DESC LIMIT 1", projectId);

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;
export function nextVersion(projectId: string, scheme: string, at = new Date()): string {
  const taken = new Set(all("SELECT version FROM releases WHERE project_id = ? AND state != 'failed'", projectId).map((r) => r.version as string));
  if (scheme === 'date') {
    const base = `${at.getFullYear()}.${String(at.getMonth() + 1).padStart(2, '0')}.${String(at.getDate()).padStart(2, '0')}`;
    let v = base;
    for (let n = 2; taken.has(v); n++) v = `${base}.${n}`;
    return v;
  }
  const prev = previous(projectId)?.version?.match(SEMVER);
  return prev ? `${prev[1]}.${Number(prev[2]) + 1}.0` : '0.1.0';
}

export function checkVersion(projectId: string, scheme: string, version: string): string | null {
  if (!version || version.length > 40) return 'A version is 1 to 40 characters.';
  if (scheme === 'semver' && !SEMVER.test(version)) return `"${version}" is not MAJOR.MINOR.PATCH (e.g. 1.4.0).`;
  if (!/^[0-9A-Za-z][0-9A-Za-z.\-+]*$/.test(version)) return 'A version uses letters, digits, dots, dashes and plus signs.';
  if (get("SELECT id FROM releases WHERE project_id = ? AND version = ? AND state != 'failed'", projectId, version)) return `Version ${version} was already released.`;
  return null;
}

/** The main line's head: the project folder's HEAD. */
export async function mainCommit(project: Row): Promise<string | null> {
  if (!project.path || !existsSync(project.path)) return null;
  try {
    return (await git(project.path, 'rev-parse', 'HEAD')) || null;
  } catch {
    return null;
  }
}

/** Tasks finished since the previous release (not its own release tasks), oldest first. */
export function tasksSince(projectId: string): Row[] {
  const prev = previous(projectId);
  const releaseTasks = new Set(all('SELECT task_id FROM releases WHERE project_id = ? AND task_id IS NOT NULL', projectId).map((r) => r.task_id));
  return all(
    "SELECT id, title, status_summary, finished_at FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'done' AND COALESCE(finished_at, updated_at) > ? ORDER BY COALESCE(finished_at, updated_at)",
    projectId, prev?.created_at ?? 0,
  ).filter((t) => !releaseTasks.has(t.id));
}

/** What the director is given to write the change log from: each task with its summary and the reports it fixed. */
export function changeMaterial(taskIds: string[]): string {
  if (!taskIds.length) return 'No tasks were finished since the previous release.';
  return taskIds
    .map((id) => {
      const t = get('SELECT id, title, status_summary FROM tasks WHERE id = ?', id);
      if (!t) return null;
      const reports = all("SELECT title FROM reports WHERE task_id = ? AND status = 'fixed'", id).map((r) => `"${String(r.title).slice(0, 120)}"`);
      const summary = String(t.status_summary ?? '').replace(/\s+/g, ' ').slice(0, 400);
      return `- [[${t.id}]] ${t.title}${summary ? `: ${summary}` : ''}${reports.length ? ` Fixed reports: ${reports.join(', ')}.` : ''}`;
    })
    .filter(Boolean)
    .join('\n');
}

export async function proposal(projectId: string) {
  const project = getProject(projectId)!;
  const recipe = getRecipe(projectId);
  const prev = previous(projectId);
  return {
    version: nextVersion(projectId, recipe.scheme),
    commit: await mainCommit(project),
    previous: prev ? { id: prev.id, version: prev.version } : null,
    tasks: tasksSince(projectId).map((t) => ({ id: t.id, title: t.title })),
    open: get(`SELECT id FROM releases WHERE project_id = ? AND state IN ('drafting','building')`, projectId)?.id ?? null,
  };
}

// ---------- starting (the user only) ----------

/**
 * Starts a release. Called only for the user's tap: the API (Cut release on the page) or the cut_release request
 * action (reqactions.ts). An open release is returned instead of a second one.
 */
export async function startRelease(projectId: string, input: { version?: string; commit?: string }, by: Author = USER): Promise<{ release: Row; existing?: boolean } | { error: string }> {
  const project = getProject(projectId);
  if (!project) return { error: 'No such project.' };
  if (!releasesOn(projectId)) return { error: OFF_TEXT };
  // One release is made at a time: a second start (a double tap, the page and a request) returns the open one.
  const open = openRelease(projectId);
  if (open) return { release: open, existing: true };
  const recipe = getRecipe(projectId);
  const version = (input.version ?? '').trim() || nextVersion(projectId, recipe.scheme);
  const bad = checkVersion(projectId, recipe.scheme, version);
  if (bad) return { error: bad };
  let commit: string | null;
  try {
    commit = input.commit?.trim() ? await git(project.path, 'rev-parse', '--verify', `${input.commit.trim()}^{commit}`) : await mainCommit(project);
  } catch {
    return { error: `No commit "${input.commit}" in the project's repository.` };
  }
  if (!commit) return { error: "The project folder is not a git repository with a commit: a release needs one to build from and tag." };
  const tasks = tasksSince(projectId).map((t) => t.id);
  const prev = previous(projectId);
  const id = newId('rel');
  const director = rootAgent(project);
  // Checked again inside the write transaction: two starts racing past the check above make one release.
  const raced = tx(() => {
    const again = openRelease(projectId);
    if (again) return again;
    const task = createTask(
      projectId,
      { title: `Release ${version}`, description: `Cut release ${version} from ${commit.slice(0, 7)}: change log, artifacts, tag. [[page:releases]]`, state: 'active', driver_agent_id: director.id, origin: 'user' },
      by,
    );
    run(
      'INSERT INTO releases (id, project_id, version, commit_sha, state, tasks, task_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, projectId, version, commit, 'drafting', JSON.stringify(tasks), task.id, now(), now(),
    );
    return null;
  });
  if (raced) return { release: raced, existing: true };
  // The director writes the change log and finishes; a fresh builder builds the artifacts (buildtask.ts).
  if (recipe.artifacts.length) {
    const build = builderTask(projectId, {
      title: `Build release ${version}`,
      brief: buildBrief(getRelease(id)!, recipe),
      touches: recipe.artifacts.flatMap((a) => a.files),
      check: `every artifact of release ${version} attached with add_release_artifact`,
      doneNote: `The builder finished building release ${version} [${id}]: its artifacts are attached. Once the change log is written, finish_release.`,
    });
    run('UPDATE releases SET build_task_id = ? WHERE id = ?', build.id, id);
  }
  addJournal(projectId, null, 'milestone', `Release ${version} started`, `From ${commit.slice(0, 7)}, with ${tasks.length} finished task(s) since ${prev ? prev.version : 'the start'}.`);
  touchProject(projectId);
  await tellDirector(projectId, directorBrief(getRelease(id)!, prev, recipe)).catch(() => {});
  return { release: getRelease(id)! };
}

/** The builder's brief for a release's artifacts: the recipe, from a clean checkout, each file attached; the director finishes. */
function buildBrief(r: Row, recipe: Recipe): string {
  return [
    `Build the artifacts of release ${r.version} [${r.id}] from a clean checkout of ${r.commit_sha} (\`git worktree add --detach <folder> ${r.commit_sha}\`, removed afterwards), each on its host, by the release recipe:`,
    renderRecipe(recipe),
    `Attach each file with add_release_artifact (release "${r.id}"). Do not finish_release: the director does once the change log is written. If a build fails, fail_release with the error and the key output.`,
  ].join('\n\n');
}

function directorBrief(r: Row, prev: Row | undefined, recipe: Recipe): string {
  const ids = parse<string[]>(r.tasks, []);
  return [
    `The user started release ${r.version} [${r.id}] from commit ${r.commit_sha.slice(0, 7)}; its task is [[${r.task_id}]] (Active, yours).`,
    `1. Write the change log now with set_release_notes, from the ${ids.length} task(s) finished since ${prev ? prev.version : 'the start'} (below). It is for the project's users: sections "## New", "## Improved", "## Fixed", one plain sentence per change, what they will notice; leave out internal work (refactors, tests, tooling, process). Omit empty sections. The user may edit it on the release's page.`,
    recipe.artifacts.length
      ? `2. Build: Helm made [[${r.build_task_id}]] for a fresh builder to build the artifacts from a clean checkout and attach them; you do not build. You are told when it is done: then finish_release. If the builder reports a failed build, fail_release with the error: nothing half-made is kept.`
      : `2. The project has no artifacts in its release recipe: once the log is written, finish_release (it tags the commit). If the user wants files built, write the recipe with them (set_release_recipe) first.`,
    `3. Then settle [[${r.task_id}]] and tell the user the release is ready.`,
    `Finished tasks:\n${changeMaterial(ids)}`,
  ].join('\n');
}

// ---------- making it ----------

export const fileDir = (projectId: string, releaseId: string) => join(ARTIFACT_DIR, 'releases', projectId, releaseId);
const relFile = (projectId: string, releaseId: string, name: string) => `releases/${projectId}/${releaseId}/${name}`;
const artifactsOf = (releaseId: string) => all('SELECT * FROM release_artifacts WHERE release_id = ? ORDER BY created_at', releaseId);

export function setNotes(r: Row, notes: string): string | null {
  if (!['drafting', 'building', 'ready'].includes(r.state)) return `Release ${r.version} is ${r.state}: its change log is final.`;
  if (notes.length > MAX_NOTES) return `A change log is at most ${MAX_NOTES} characters.`;
  run('UPDATE releases SET notes = ?, state = ?, updated_at = ? WHERE id = ?', notes.trim(), r.state === 'drafting' ? 'building' : r.state, now(), r.id);
  touchProject(r.project_id);
  return null;
}

/**
 * Where an agent may attach a built file from: a regular file (no symlink anywhere in its path) inside the project's
 * folder or one of its git worktrees (the release's clean checkout is one), never in Helm's data folder, and not
 * looking like credentials by name, folder or content. Returns its real path, or why not.
 */
export function checkArtifactPath(project: Row, path: string, bases: string[] = []): { path: string; bytes: number } | { error: string } {
  const tries = isAbsolute(path) ? [path] : [...bases, project.path].filter((b) => existsSync(b)).map((b) => resolve(b, path));
  const abs = tries.find((t) => existsSync(t));
  if (!abs) return { error: `File not found: ${tries.join(' or ') || path}. Give an absolute path.` };
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return { error: `Cannot read ${abs}.` };
  }
  if (real !== resolve(abs)) return { error: `${abs} goes through a symlink (it is really ${real}). Attach the built file by its real path, inside the checkout.` };
  const st = lstatSync(real);
  if (!st.isFile()) return { error: `Not a regular file: ${real}` };
  const within = (root: string) => real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
  if (within(realpathSync(DATA_DIR))) return { error: `${real} is in Helm's data folder; only files built from the release's checkout are attached.` };
  if (!projectRoots(project.path).some(within)) return { error: `${real} is outside the project's folder and its worktrees. Build in a clean checkout of the release commit (a git worktree of the project) and attach from there.` };
  if (SECRET_NAME.test(basename(real)) || SECRET_DIR.test(real)) return { error: `${basename(real)} looks like credentials or keys; it is not attached.` };
  if (st.size <= SNIFF_BYTES) {
    const head = readFileSync(real);
    if (!head.includes(0) && SECRET_TEXT.test(head.toString('utf8'))) return { error: `${basename(real)} contains what looks like a private key or API token; it is not attached.` };
  }
  return { path: real, bytes: st.size };
}
/** Text files up to this size are read for secrets before they are attached. */
const SNIFF_BYTES = 1024 * 1024;

/** Why copying `bytes` into Helm's data folder would take its disk under the disk guard's critical level, or null. */
export function spaceRefusal(bytes: number, statfs: (p: string) => { bavail: number; bsize: number; blocks: number } = (p) => statfsSync(p)): string | null {
  let fs: { bavail: number; bsize: number; blocks: number };
  try {
    fs = statfs(ARTIFACT_DIR);
  } catch {
    return null;
  }
  const free = fs.bavail * fs.bsize;
  const critical = thresholds(fs.blocks * fs.bsize, getDiskSettings()).critical;
  if (free - bytes >= critical) return null;
  return `Not attached: copying ${(bytes / 1048576).toFixed(0)} MB would leave ${((free - bytes) / 1073741824).toFixed(1)} GB free, under the disk guard's critical level (${(critical / 1073741824).toFixed(1)} GB). Free space first, or fail_release.`;
}

/** Copies a file without blocking the event loop, hashing it on the way; the destination appears only when complete. */
export async function copyHashed(src: string, dest: string): Promise<string> {
  const h = createHash('sha256');
  const tmp = `${dest}.part`;
  try {
    await pipeline(
      createReadStream(src),
      new Transform({
        transform(chunk, _enc, done) {
          h.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(tmp, { flags: 'wx' }),
    );
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return h.digest('hex');
}

/** Copies a built file into the release (replacing one of the same name), with its size and checksum. */
export async function addArtifact(r: Row, name: string, path: string, bases: string[] = []): Promise<{ artifact: Row } | { error: string }> {
  if (!OPEN.includes(r.state)) return { error: `Release ${r.version} is ${r.state}: files are attached only while it is being made.` };
  name = name.trim();
  if (!name || name.length > 80) return { error: 'name is 1 to 80 characters: the artifact\'s name in the recipe.' };
  const checked = checkArtifactPath(getProject(r.project_id)!, path, bases);
  if ('error' in checked) return checked;
  const abs = checked.path;
  if (checked.bytes > MAX_ARTIFACT_BYTES) return { error: `The file is ${(checked.bytes / 1073741824).toFixed(1)} GB; an artifact is at most ${MAX_ARTIFACT_BYTES / 1073741824} GB.` };
  const full = spaceRefusal(checked.bytes);
  if (full) return { error: full };
  const dir = fileDir(r.project_id, r.id);
  mkdirSync(dir, { recursive: true });
  const fname = `${newId('f').slice(2)}-${basename(abs).replace(/[^A-Za-z0-9._+-]/g, '_')}`;
  let sum: string;
  try {
    sum = await copyHashed(abs, join(dir, fname));
  } catch (err) {
    return { error: `Could not copy ${abs}: ${String((err as Error).message).slice(0, 300)}` };
  }
  const bytes = statSync(join(dir, fname)).size;
  // The release may have failed while the file was copying: then the copy goes too.
  const now0 = getRelease(r.id);
  if (!now0 || !OPEN.includes(now0.state)) {
    rmSync(join(dir, fname), { force: true });
    return { error: `Release ${r.version} is ${now0?.state ?? 'gone'}: the file was not attached.` };
  }
  const old = all('SELECT * FROM release_artifacts WHERE release_id = ? AND name = ?', r.id, name);
  const id = newId('ra');
  tx(() => {
    run('DELETE FROM release_artifacts WHERE release_id = ? AND name = ?', r.id, name);
    run('INSERT INTO release_artifacts (id, release_id, project_id, name, file, bytes, sha256, created_at) VALUES (?,?,?,?,?,?,?,?)', id, r.id, r.project_id, name, relFile(r.project_id, r.id, fname), bytes, sum, now());
    run("UPDATE releases SET state = 'building', updated_at = ? WHERE id = ?", now(), r.id);
  });
  for (const o of old) removeFile(o.file);
  touchProject(r.project_id);
  return { artifact: get('SELECT * FROM release_artifacts WHERE id = ?', id)! };
}

function removeFile(file: string | null | undefined) {
  if (!file || file.includes('..') || !file.startsWith('releases/')) return;
  try {
    unlinkSync(join(ARTIFACT_DIR, file));
  } catch {}
}

/** Ready: the change log is written, every artifact in the recipe is attached, and the commit is tagged locally. */
export async function finishRelease(r: Row): Promise<{ release: Row } | { error: string }> {
  if (!OPEN.includes(r.state)) return { error: `Release ${r.version} is ${r.state}.` };
  if (!r.notes.trim()) return { error: 'Write the change log first (set_release_notes).' };
  const have = new Set(artifactsOf(r.id).map((a) => a.name));
  const missing = getRecipe(r.project_id).artifacts.filter((a) => !have.has(a.name)).map((a) => a.name);
  if (missing.length) return { error: `Not attached yet: ${missing.join(', ')}. Attach each with add_release_artifact, or fail_release if one cannot be built.` };
  const project = getProject(r.project_id)!;
  const tag = `v${r.version.replace(/^v/, '')}`;
  try {
    let existing: string | null = null;
    try {
      existing = await git(project.path, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`);
    } catch {}
    if (existing && existing !== r.commit_sha) return { error: `The tag ${tag} already exists on another commit (${existing.slice(0, 7)}). Remove or rename it with the user, then finish again.` };
    if (!existing) await git(project.path, 'tag', tag, r.commit_sha);
  } catch (err) {
    return { error: `Could not tag ${r.commit_sha.slice(0, 7)} as ${tag}: ${String((err as Error).message).slice(0, 300)}` };
  }
  run("UPDATE releases SET state = 'ready', tag = ?, error = NULL, ready_at = ?, updated_at = ? WHERE id = ?", tag, now(), now(), r.id);
  addJournal(r.project_id, null, 'milestone', `Release ${r.version} is ready`, `Tagged ${tag} at ${r.commit_sha.slice(0, 7)}; ${have.size} artifact(s).`);
  touchProject(r.project_id);
  return { release: getRelease(r.id)! };
}

/** A failed build fails the release: its files go, so nothing half-made is listed. */
export function failRelease(r: Row, error: string): string | null {
  if (!OPEN.includes(r.state)) return `Release ${r.version} is ${r.state}.`;
  for (const a of artifactsOf(r.id)) removeFile(a.file);
  try {
    rmSync(fileDir(r.project_id, r.id), { recursive: true, force: true });
  } catch {}
  tx(() => {
    run('DELETE FROM release_artifacts WHERE release_id = ?', r.id);
    run("UPDATE releases SET state = 'failed', error = ?, updated_at = ? WHERE id = ?", error.trim().slice(0, 2000), now(), r.id);
  });
  addJournal(r.project_id, null, 'status', `Release ${r.version} failed`, error.trim().slice(0, 600));
  touchProject(r.project_id);
  return null;
}

/** Removes a release's files (from the Disk page), keeping its record and change log. */
export function removeFiles(r: Row): number {
  const rows = artifactsOf(r.id).filter((a) => a.file);
  for (const a of rows) removeFile(a.file);
  try {
    rmSync(fileDir(r.project_id, r.id), { recursive: true, force: true });
  } catch {}
  run('UPDATE release_artifacts SET file = NULL, removed_at = ? WHERE release_id = ? AND file IS NOT NULL', now(), r.id);
  touchProject(r.project_id);
  return rows.length;
}

// ---------- publishing (after the user confirms, each time) ----------

export const PUBLISH = 'Publish';

/** Why a release cannot be published now, or null. */
function cannotPublish(r: Row): string | null {
  if (r.state !== 'ready') return `Release ${r.version} is ${r.state}: only a ready release is published.`;
  if (!getRecipe(r.project_id).publish) return 'This project has no publish instructions: its releases stay in Helm.';
  return null;
}

/** The newest ready release that can be published (publish_release without a release named). */
export function latestPublishable(projectId: string): Row | undefined {
  const r = get("SELECT * FROM releases WHERE project_id = ? AND state = 'ready' ORDER BY created_at DESC LIMIT 1", projectId);
  return r && !cannotPublish(r) ? r : undefined;
}

/**
 * Publish on the release's page: files the confirmation, a request whose Publish button (the publish_release action,
 * reqactions.ts) is the only thing that lets the director publish. One open at a time.
 */
export function requestPublish(r: Row): { request: string } | { error: string } {
  const why = cannotPublish(r);
  if (why) return { error: why };
  const open = r.publish_request ? get("SELECT id FROM inbox WHERE id = ? AND status IN ('open','held')", r.publish_request) : undefined;
  if (open) return { request: open.id };
  const task = r.task_id ? get('SELECT * FROM tasks WHERE id = ?', r.task_id) : undefined;
  const { id } = createRequest({
    projectId: r.project_id,
    agentId: rootAgent(getProject(r.project_id)!).id,
    kind: 'question',
    title: `Publish release ${r.version}?`,
    body: `The director will follow the project's publish instructions:\n\n${getRecipe(r.project_id).publish}`,
    options: [{ label: 'Not now' }],
    payload: { act: { kind: 'publish_release', target: r.id } },
    importance: 3,
    blocking: false,
    task,
  });
  run('UPDATE releases SET publish_request = ?, updated_at = ? WHERE id = ?', id, now(), r.id);
  return { request: id };
}

/** The user tapped Publish (reqactions.ts): the confirmation mark_published needs, used once. */
export function confirmPublish(releaseId: string): string | null {
  const r = getRelease(releaseId);
  if (!r) return 'That release no longer exists.';
  const why = cannotPublish(r);
  if (why) return why;
  run('UPDATE releases SET publish_confirmed_at = ?, updated_at = ? WHERE id = ?', now(), now(), r.id);
  touchProject(r.project_id);
  return null;
}

/**
 * After the user's Publish (answers.ts, once the action was done): the instructions, which go to the director with
 * the answer. Anything else, nothing.
 */
export function onReleaseAnswer(item: Row, choice: string | undefined): string {
  const act = parse<Row>(item.payload, {}).act;
  const r = act?.kind === 'publish_release' ? getRelease(act.target) : undefined;
  if (!r || choice !== PUBLISH || !r.publish_confirmed_at || r.state !== 'ready') return '';
  return `\n\nThe user confirmed publishing release ${r.version} [${r.id}] (tag ${r.tag}, files under its page). Follow these instructions now, then record the result with mark_published:\n${getRecipe(r.project_id).publish}`;
}

export function markPublished(r: Row, how: string, error?: string): string | null {
  if (r.state !== 'ready' || !r.publish_confirmed_at) return `Release ${r.version} has no publish confirmation from the user. Only they give one: Publish on its page, or a request you file with the publish_release action.`;
  if (error?.trim()) {
    run('UPDATE releases SET publish_confirmed_at = NULL, error = ?, updated_at = ? WHERE id = ?', `Publishing failed: ${error.trim().slice(0, 1800)}`, now(), r.id);
  } else {
    run("UPDATE releases SET state = 'published', published_at = ?, published_how = ?, publish_confirmed_at = NULL, error = NULL, updated_at = ? WHERE id = ?", now(), how.trim().slice(0, 2000), now(), r.id);
    addJournal(r.project_id, null, 'milestone', `Release ${r.version} published`, how.trim().slice(0, 600));
  }
  touchProject(r.project_id);
  return null;
}

// ---------- views ----------

export function findRelease(projectId: string, ref: string): Row | undefined {
  return get('SELECT * FROM releases WHERE project_id = ? AND (id = ? OR version = ? OR version = ?) ORDER BY created_at DESC LIMIT 1', projectId, ref, ref, ref.replace(/^v/, ''));
}

export function releaseView(r: Row) {
  const recipe = getRecipe(r.project_id);
  return {
    id: r.id,
    version: r.version,
    commit: r.commit_sha,
    state: r.state,
    notes: r.notes,
    task_id: r.task_id,
    tasks: parse<string[]>(r.tasks, []).map((id) => get('SELECT id, title FROM tasks WHERE id = ?', id)).filter(Boolean),
    tag: r.tag,
    error: r.error,
    created_at: r.created_at,
    ready_at: r.ready_at,
    published_at: r.published_at,
    published_how: r.published_how,
    can_publish: r.state === 'ready' && !!recipe.publish,
    publish_pending: !!(r.publish_request && get("SELECT id FROM inbox WHERE id = ? AND status = 'open'", r.publish_request)) || !!r.publish_confirmed_at,
    artifacts: artifactsOf(r.id).map((a) => ({ id: a.id, name: a.name, url: a.file ? `/artifacts/${a.file}` : null, file: a.file ? basename(a.file).replace(/^[^-]+-/, '') : null, bytes: a.bytes, sha256: a.sha256, removed: !!a.removed_at })),
  };
}

export function releasesView(projectId: string) {
  return {
    on: releasesOn(projectId),
    recipe: getRecipe(projectId),
    releases: all('SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC', projectId).map(releaseView),
  };
}

export function renderReleases(projectId: string, tz: (ts: number) => string): string {
  const rows = all('SELECT * FROM releases WHERE project_id = ? ORDER BY created_at DESC LIMIT 20', projectId);
  const out = [`Recipe: ${renderRecipe(getRecipe(projectId))}`, ''];
  if (!rows.length) out.push('No releases yet.');
  for (const r of rows) {
    const arts = artifactsOf(r.id);
    out.push(
      `- ${r.version} [${r.id}] ${r.state}, ${tz(r.created_at)}, commit ${r.commit_sha.slice(0, 7)}${r.tag ? `, tag ${r.tag}` : ''}${r.task_id ? `, task [[${r.task_id}]]` : ''}; ${arts.length} artifact(s)${arts.length ? ` (${arts.map((a) => a.name).join(', ')})` : ''}; change log ${r.notes ? `${r.notes.length} chars` : 'not written'}${r.error ? `; ${r.error.slice(0, 200)}` : ''}${r.publish_confirmed_at ? '; PUBLISH CONFIRMED by the user, not yet recorded' : ''}`,
    );
  }
  return out.join('\n');
}

/** Bytes of release files a project keeps, per release (the Disk page lists them). */
export function releaseFiles(projectId: string): { release: Row; bytes: number }[] {
  return all(
    'SELECT r.*, SUM(a.bytes) AS kept FROM releases r JOIN release_artifacts a ON a.release_id = r.id WHERE r.project_id = ? AND a.file IS NOT NULL GROUP BY r.id ORDER BY r.created_at DESC',
    projectId,
  ).map((r) => ({ release: r, bytes: r.kept as number }));
}

/** For the project state: whether the Releases page shows (on, or it has releases). */
export function releaseSummary(projectId: string) {
  return { on: releasesOn(projectId), count: (get('SELECT COUNT(*) AS n FROM releases WHERE project_id = ?', projectId)?.n as number) ?? 0 };
}
