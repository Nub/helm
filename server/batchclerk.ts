import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { all, get } from './db.ts';
import type { Row } from './db.ts';
import { addJournal, getProject } from './store.ts';
import { rootAgent, sendToAgent } from './agents.ts';
import { isStopped } from './projectmode.ts';
import { getChoice } from './settings.ts';
import { checksNote, declaredChecks, latestRun, runLine, startChecks } from './projectchecks.ts';
import { createRequest, withdrawRequest } from './requests.ts';
import { isOwnHelm } from './ownhelm.ts';

/**
 * The batch clerk: when the builder's batch ends (builder.ts batchNote), Helm starts the project's full checks on that
 * commit (projectchecks.ts; a commit already checked keeps its result). On a pass it does the project's step "After
 * checks pass" (Setup): nothing, or move a branch to the checked commit (never pushed, never the branch checked out).
 * For Helm's own project it also files one Update Helm request (update_helm), replacing an open one: only the user's
 * tap starts the update. A failure wakes the director, as run_checks does; a pass does not. Stopped: nothing.
 */

const exec = promisify(execFile);
const git = async (path: string, args: string[]) => (await exec('git', ['-C', path, ...args], { timeout: 15_000 })).stdout.trim();

/** Start the batch's checks. Returns the line the batch record shows. */
export async function batchChecks(project: Row, taskIds: string[]): Promise<string> {
  if (!declaredChecks(project.id).full.length) return '';
  if (isStopped(project.id)) return 'Checks: not started, the project is stopped.';
  const res = await startChecks(project.id, (r) => void afterChecks(project.id, r, taskIds).catch(() => {}));
  if (res.started) return res.text.replace(/ You will be told.*$/, '');
  // Already checked (or running from the director's run_checks): a stored pass still takes the step for this batch.
  const commit = await git(project.path, ['rev-parse', 'HEAD']).catch(() => '');
  const stored = commit ? latestRun(project.id, commit) : undefined;
  if (stored?.status === 'passed') await afterChecks(project.id, { ...stored, commit: stored.commit_sha }, taskIds);
  return stored ? runLine({ ...stored, commit: stored.commit_sha }) : res.text;
}

/** A finished run: the step on a pass, the director on a failure. */
export async function afterChecks(projectId: string, r: Row, taskIds: string[]): Promise<void> {
  const project = getProject(projectId);
  if (!project || isStopped(projectId)) return;
  if (r.status !== 'passed') {
    await sendToAgent(rootAgent(project).id, checksNote(r), { kind: 'system', name: 'Helm' });
    return;
  }
  const branch = getChoice(projectId, 'after_checks');
  if (branch === 'nothing') return;
  const moved = await moveBranch(project.path, branch, r.commit_sha);
  if (moved) {
    await sendToAgent(rootAgent(project).id, `<helm-note kind="checks">${runLine(r)} Helm could not move branch ${branch}: ${moved}</helm-note>`, { kind: 'system', name: 'Helm' });
    return;
  }
  addJournal(projectId, null, 'status', `Checks passed; branch ${branch} moved to ${String(r.commit_sha).slice(0, 7)}`, '', null);
  if (isOwnHelm(project.path)) fileUpdateRequest(project, taskIds);
}

/** `git branch -f <name> <commit>` in the project folder; never the branch checked out. Returns an error, or null. */
export async function moveBranch(path: string, name: string, commit: string): Promise<string | null> {
  try {
    const current = await git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
    if (current === name) return `${name} is the branch checked out in the project folder.`;
    await git(path, ['branch', '-f', name, commit]);
    return null;
  } catch (err) {
    return String((err as { stderr?: string }).stderr || err).trim().slice(0, 300);
  }
}

/** Helm's own project: one open Update Helm request, listing every task finished since the user last updated. */
function fileUpdateRequest(project: Row, taskIds: string[]) {
  const open = all("SELECT id, payload FROM inbox WHERE project_id = ? AND status IN ('open','held') AND json_extract(payload, '$.update_batch') = 1", project.id);
  const earlier = open.flatMap((o) => (JSON.parse(o.payload || '{}').tasks as string[] | undefined) ?? []);
  const tasks = [...new Set([...earlier, ...taskIds])].filter((id) => get('SELECT 1 FROM tasks WHERE id = ?', id));
  for (const o of open) withdrawRequest(o.id, 'Replaced by a newer Update Helm request.');
  createRequest({
    projectId: project.id,
    agentId: null,
    kind: 'question',
    title: 'Update Helm',
    body: `The full checks passed and release points at the new commit. Finished since the last update:\n${tasks.map((id) => `- [[${id}]]`).join('\n')}`,
    options: [{ label: 'Not now' }],
    payload: { act: { kind: 'update_helm' }, update_batch: 1, tasks },
    importance: 3,
    blocking: false,
  });
}
