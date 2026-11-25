import { mkdirSync, rmSync, statSync } from 'node:fs';
import { builderTask } from './buildtask.ts';
import { basename, join } from 'node:path';
import { ARTIFACT_DIR } from './config.ts';
import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { getProject, touchProject } from './store.ts';
import { addTaskMessage, getTask } from './tasks.ts';
import { createDiscussion } from './discussions.ts';
import { tellDirector } from './agents.ts';
import { MAX_ARTIFACT_BYTES, OFF_TEXT, checkArtifactPath, checkRecipe, copyHashed, getRecipe, mainCommit, releasesOn, renderRecipe, saveRecipe, spaceRefusal } from './releases.ts';
import type { Recipe, RecipeInput } from './releases.ts';

/**
 * Working out a project's release recipe on the Releases page (web/src/releases.tsx).
 *
 * - The user edits it in place (saveRecipe, the same checks as the director's tool).
 * - With the director: the project's "Release recipe" discussion. The director's set_release_recipe posts a proposal
 *   there, a card the user applies (as is, or changed in the form) or declines; it writes the recipe itself only when
 *   the user's own message in that turn asked it to just do it.
 * - Test build: the user's tap opens a record and sends the director a short brief; an agent builds that artifact from
 *   a clean checkout and reports with report_test_build (the file, checked and copied as a release's are, or the
 *   error). No agent starts one, and the report is refused without a record the user opened. Helm runs nothing.
 */

const HELM = { author: 'system' as const, name: 'Helm' };
type Proposed = Pick<Recipe, 'artifacts' | 'scheme' | 'publish'>;
const parse = (s: string): Proposed => {
  try {
    return JSON.parse(s);
  } catch {
    return { artifacts: [], scheme: 'semver', publish: '' };
  }
};

// ---------- the discussion ----------

/** The project's open "Release recipe" discussion, created on first use. */
export function recipeDiscussion(projectId: string, by: 'user' | 'director' = 'user'): Row {
  const known = get('SELECT discussion_id FROM recipe_threads WHERE project_id = ?', projectId)?.discussion_id;
  const d = known ? getTask(known) : undefined;
  if (d && d.kind === 'discussion' && d.state === 'open') return d;
  const made = createDiscussion(projectId, { title: 'Release recipe', summary: 'What a release builds and how it is published, worked out with the director.', origin: by }, by === 'user' ? { author: 'user', name: 'You' } : HELM);
  run('INSERT INTO recipe_threads (project_id, discussion_id) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET discussion_id = excluded.discussion_id', projectId, made.id);
  return made;
}

// ---------- proposals ----------

export const getRecipeProposal = (id: string) => get('SELECT * FROM recipe_proposals WHERE id = ?', id);

/** The director's set_release_recipe without the user's go-ahead: checked, then a card in the recipe discussion. */
export function proposeRecipe(agent: Row, input: RecipeInput, rationale = ''): { id: string; text: string } | { error: string } {
  const pid = agent.project_id as string;
  const checked = checkRecipe(pid, input);
  if ('error' in checked) return checked;
  const d = recipeDiscussion(pid, 'director');
  const id = newId('rp');
  tx(() => {
    run("UPDATE recipe_proposals SET status = 'superseded', decided_at = ? WHERE project_id = ? AND status = 'open'", now(), pid);
    run(
      'INSERT INTO recipe_proposals (id, project_id, discussion_id, agent_id, author_name, recipe, rationale, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, pid, d.id, agent.id, agent.name, JSON.stringify(checked.recipe), rationale.trim().slice(0, 300), now(),
    );
  });
  addTaskMessage(d, { author: 'director', name: agent.name }, JSON.stringify({ id }), 'recipe');
  return { id, text: `Proposed: a card in [[${d.id}]] with Apply, Change and Not this. The recipe is unchanged until the user applies it; you are told what they decide.` };
}

export function recipeProposalView(p: Row) {
  return { id: p.id, author_name: p.author_name, recipe: parse(p.recipe), current: getRecipe(p.project_id), rationale: p.rationale, status: p.status, note: p.note, created_at: p.created_at, decided_at: p.decided_at, discussion_id: p.discussion_id };
}

/** The user applies a proposal, as proposed or as they changed it in the form. */
export async function applyRecipeProposal(p: Row, changed?: RecipeInput): Promise<{ recipe: Recipe } | { error: string; code?: number }> {
  if (p.status !== 'open') return { error: `This proposal is ${p.status}.`, code: 409 };
  const res = saveRecipe(p.project_id, changed ?? parse(p.recipe), 'the user');
  if ('error' in res) return res;
  run("UPDATE recipe_proposals SET status = 'applied', decided_at = ? WHERE id = ?", now(), p.id);
  const d = p.discussion_id ? getTask(p.discussion_id) : undefined;
  if (d) addTaskMessage(d, HELM, `You applied the proposed release recipe${changed ? ', with your changes' : ''}.`, 'state');
  touchProject(p.project_id);
  await tellDirector(p.project_id, `The user applied your proposed release recipe${changed ? ' with changes' : ''}. It is now:\n${renderRecipe(res.recipe)}`).catch(() => {});
  return res;
}

export async function declineRecipeProposal(p: Row, note: string): Promise<{ error: string; code?: number } | null> {
  if (p.status !== 'open') return { error: `This proposal is ${p.status}.`, code: 409 };
  const n = note.trim().slice(0, 1000);
  run("UPDATE recipe_proposals SET status = 'declined', note = ?, decided_at = ? WHERE id = ?", n, now(), p.id);
  const d = p.discussion_id ? getTask(p.discussion_id) : undefined;
  if (d) addTaskMessage(d, HELM, `You declined the proposed release recipe${n ? `: ${n}` : '.'}`, 'state');
  touchProject(p.project_id);
  await tellDirector(p.project_id, `The user declined your proposed release recipe${n ? `: "${n}"` : ''}. The recipe stays as it was.${d ? ` Talk it over in [[${d.id}]].` : ''}`).catch(() => {});
  return null;
}

// ---------- test builds ----------

/** A test build with no result after this long failed (the agent stopped, Helm restarted). */
export const TEST_STALE_MS = 6 * 3600_000;
export const testDir = (projectId: string, id: string) => join(ARTIFACT_DIR, 'recipe-tests', projectId, id);
export const getTest = (id: string) => get('SELECT * FROM recipe_tests WHERE id = ?', id);

/** Closes test builds that never reported (each check of the page): failed, with the reason. */
function closeStale(projectId: string) {
  run("UPDATE recipe_tests SET status = 'failed', error = 'No result came back in time.', finished_at = ? WHERE project_id = ? AND status = 'running' AND started_at < ?", now(), projectId, now() - TEST_STALE_MS);
}

/**
 * Test build: the user's tap only (the API; no agent tool starts one). One running per artifact: a second tap returns
 * it. Helm makes it a Scheduled task with the recipe as its brief, and a fresh builder makes it (buildtask.ts).
 */
export async function startTestBuild(projectId: string, artifact: string): Promise<{ test: Row; existing?: boolean } | { error: string }> {
  const project = getProject(projectId);
  if (!project) return { error: 'No such project.' };
  if (!releasesOn(projectId)) return { error: OFF_TEXT };
  const a = getRecipe(projectId).artifacts.find((x) => x.name === artifact);
  if (!a) return { error: `The recipe has no artifact "${artifact}".` };
  closeStale(projectId);
  const open = get("SELECT * FROM recipe_tests WHERE project_id = ? AND artifact = ? AND status = 'running'", projectId, a.name);
  if (open) return { test: open, existing: true };
  const commit = await mainCommit(project);
  if (!commit) return { error: 'The project folder is not a git repository with a commit: a test build needs one to build from.' };
  const id = newId('rt');
  run('INSERT INTO recipe_tests (id, project_id, artifact, commit_sha, started_at) VALUES (?,?,?,?,?)', id, projectId, a.name, commit, now());
  touchProject(projectId);
  // A fresh builder makes it (buildtask.ts): the director does not build.
  builderTask(projectId, {
    title: `Test build: ${a.name}`,
    brief: [
      `The user started a test build [${id}] of "${a.name}" from ${commit.slice(0, 7)} (no release). Build it from a clean checkout (\`git worktree add --detach <folder> ${commit}\`, removed afterwards)${a.host ? ` on ${a.host}` : ''}, by the recipe:`,
      `- in ${a.cwd}: ${a.command.replace(/\n/g, ' ⏎ ')}`,
      `- produces: ${a.files.join(', ')}`,
      `Then report_test_build with test "${id}" and the file's path, or with error and the key output if it fails.`,
    ].join('\n'),
    touches: a.files,
    check: `report_test_build with test "${id}": the file attached, or the error`,
  });
  return { test: getTest(id)! };
}

/** report_test_build: the file (checked and copied as a release's artifact) or the error closes the record. */
export async function reportTestBuild(agent: Row, testId: string, input: { path?: string; error?: string }, bases: string[] = []): Promise<{ text: string } | { error: string }> {
  const t = getTest(testId);
  if (!t || t.project_id !== agent.project_id) return { error: `No test build "${testId}" on this project. Only the user starts one, with Test build on the Releases page.` };
  if (t.status !== 'running') return { error: `Test build ${testId} is already ${t.status === 'done' ? 'done' : 'closed'}. Only the user starts another.` };
  if (input.error?.trim()) {
    run("UPDATE recipe_tests SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'", input.error.trim().slice(0, 2000), now(), t.id);
    touchProject(t.project_id);
    return { text: `Recorded: the test build of "${t.artifact}" failed. The user sees the error on the Releases page.` };
  }
  if (!input.path?.trim()) return { error: 'Give path (the built file) or error (why it failed).' };
  const checked = checkArtifactPath(getProject(t.project_id)!, input.path.trim(), bases);
  if ('error' in checked) return checked;
  if (checked.bytes > MAX_ARTIFACT_BYTES) return { error: `The file is ${(checked.bytes / 1073741824).toFixed(1)} GB; an artifact is at most ${MAX_ARTIFACT_BYTES / 1073741824} GB.` };
  const full = spaceRefusal(checked.bytes);
  if (full) return { error: full };
  const dir = testDir(t.project_id, t.id);
  mkdirSync(dir, { recursive: true });
  const name = basename(checked.path).replace(/[^A-Za-z0-9._+-]/g, '_');
  let sum: string;
  try {
    sum = await copyHashed(checked.path, join(dir, name));
  } catch (err) {
    return { error: `Could not copy ${checked.path}: ${String((err as Error).message).slice(0, 300)}` };
  }
  const file = `recipe-tests/${t.project_id}/${t.id}/${name}`;
  const done = run("UPDATE recipe_tests SET status = 'done', file = ?, bytes = ?, sha256 = ?, finished_at = ? WHERE id = ? AND status = 'running'", file, statSync(join(dir, name)).size, sum, now(), t.id);
  if (!done.changes) {
    rmSync(dir, { recursive: true, force: true });
    return { error: `Test build ${t.id} was closed meanwhile; the file was not kept.` };
  }
  // One result kept per artifact: earlier test files of it go.
  for (const old of all("SELECT id FROM recipe_tests WHERE project_id = ? AND artifact = ? AND id != ? AND file IS NOT NULL AND build_id IS NULL", t.project_id, t.artifact, t.id)) {
    rmSync(testDir(t.project_id, old.id), { recursive: true, force: true });
    run('UPDATE recipe_tests SET file = NULL WHERE id = ?', old.id);
  }
  touchProject(t.project_id);
  return { text: `Recorded: "${t.artifact}" built, ${(checked.bytes / 1048576).toFixed(1)} MB. The user can download it from the Releases page.` };
}

/** The latest test build of each artifact in the recipe, for the page. */
export function testsView(projectId: string) {
  closeStale(projectId);
  const out: Record<string, Row> = {};
  for (const t of all('SELECT * FROM recipe_tests WHERE project_id = ? AND build_id IS NULL ORDER BY started_at', projectId)) {
    out[t.artifact] = { id: t.id, status: t.status, commit: t.commit_sha, bytes: t.bytes, url: t.file ? `/artifacts/${t.file}` : null, file: t.file ? basename(t.file) : null, error: t.error, started_at: t.started_at, finished_at: t.finished_at };
  }
  return out;
}

/** The open proposal, if any, for the page's Recipe card. */
export function openProposal(projectId: string) {
  const p = get("SELECT * FROM recipe_proposals WHERE project_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1", projectId);
  return p ? recipeProposalView(p) : null;
}
