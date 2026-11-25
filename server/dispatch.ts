import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { closeAgent, rootAgent, sendToAgent, tellDirector } from './agents.ts';
import { addJournal, getAgent, getProject, projectStructure, setTaskLine, touchProject } from './store.ts';
import { addTaskMessage, getTask, setTaskState, setTaskSummary, taskRef } from './tasks.ts';
import { getChoice } from './settings.ts';
import { DEFAULT_REASON } from './tiers.ts';
import { openBlockers } from './waits.ts';
import { markRelatedGiven } from './related.ts';
import { isStopped } from './projectmode.ts';
import { diskLevel } from './disk.ts';
import { BATCH_SIZE, BUILDER_AREA, BUILDER_PROMPT, batchNote, builderTaskDone, isBuilder, isRisky, noteSkipped, pendingBatch, queueHeld, startableScheduled } from './builder.ts';
import { openSubagents, pathsOf, pathsOverlap } from './subagents.ts';
import { workerBrief } from './freshworker.ts';
import type { Role } from './structure.ts';

/**
 * Helm dispatches (runner side): one fresh builder per task. When a task is Scheduled or started (Active with nobody
 * on it), Helm starts a builder for it with a brief (freshworker.ts workerBrief: the task, its Done when and touches,
 * Spec entries, knowledge, related past work, the check) and the rules below. In queue order, at the task's tier, up
 * to the project's "builders at once" (setting builders_at_once), and only when its paths overlap no running builder's
 * task (subagents.ts pathsOf/pathsOverlap; a task with no usable paths runs alone). Scheduled tasks wait while the
 * project is finishing up or stopped (Queue only and Autopilot run them), for the tasks they wait for, for a Spec link
 * under Strict adherence, and while the disk is nearly full.
 *
 * A builder is named Builder A, B, C…: the lowest letter no open builder of the project holds, reused once it closes.
 * When it ends its turn with complete_task, Helm settles its task (done, its summary), records it for the batch, closes
 * it and starts the next. The standing Builder of before and the area agents finish what they have and are closed
 * (retireStanding); they get no new work.
 *
 * Called where tasks become Scheduled or Active (tools.ts, taskactions.ts through agents.ts dispatchWork), when a
 * builder finishes, and from a timer.
 */

const HELM = { author: 'system' as const, name: 'Helm' };

/** How many builders may run at once in a project (Setup › Team, "Builders at once"). */
export const buildersAtOnce = (projectId: string) => Math.max(1, Number(getChoice(projectId, 'builders_at_once')) || 2);

/** Builders of a project that are open: Helm's fresh ones and, until it is closed, the standing Builder. */
export const openBuilders = (projectId: string) =>
  all("SELECT * FROM agents WHERE project_id = ? AND role_id = ? AND parent_id IS NOT NULL AND status NOT IN ('done', 'closed') ORDER BY created_at", projectId, BUILDER_AREA);

/** Open builders holding an Active task: what counts against "builders at once" (one on a paused task does not). */
export const busyBuilders = (projectId: string) =>
  openBuilders(projectId).filter((a) => !!get("SELECT 1 AS x FROM tasks WHERE driver_agent_id = ? AND state = 'active' LIMIT 1", a.id));

/** The name for a new builder: the lowest letter no open builder holds (Builder A, B, …), reused after one closes. */
export function builderName(projectId: string): string {
  const used = new Set(openBuilders(projectId).map((a) => String(a.name)));
  for (let i = 0; i < 26; i++) {
    const name = `Builder ${String.fromCharCode(65 + i)}`;
    if (!used.has(name)) return name;
  }
  for (let n = 27; ; n++) if (!used.has(`Builder ${n}`)) return `Builder ${n}`;
}

/** What every fresh builder is told besides its task (the last part of its brief). */
export const BUILDER_RULES = [
  'How to work:',
  '- Do this task and nothing beyond it. You are a fresh builder: Helm started you for this task alone and closes you when it is done.',
  '- Work in a git worktree of your own on a branch named for the task (register it with register_artifacts), and commit there with messages naming the task id.',
  '- Run the check above. Then merge into the main line with git merge --ff-only (rebase onto it first if it moved, and run the check again).',
  '- Never wait in a loop: no sleep-and-check, no repeated status or list calls. A background command, a subagent and an answer each wake you when they finish; until then do other work or end your turn.',
  '- Before you finish, record what cost you time to find out about the project with note_knowledge.',
  '- Finish with complete_task: Helm refuses it, saying what is missing, until its gates pass. Then give one short report (what changed, the commit, the check and its result, what you did not check). Helm closes you after it.',
  '- If the plan is wrong (the task cannot be done as written, or doing it would break something it does not mention), stop: put the evidence and your recommendation to the director with ask_manager instead of improvising beyond the task.',
].join('\n');

/** The first message of a fresh builder: who it is, the task's brief and the rules. */
export function builderBrief(t: Row, name: string): string {
  const review = isRisky(t) ? '\n- This task is marked for review: request_review before you merge, and merge only once it is accepted.' : '';
  return `You are ${name}. Helm started you for ${taskRef(t)}.\n\n${workerBrief(t, BUILDER_RULES + review)}`;
}

/** The stock builder role, when a project's structure has none (an old one). */
const stockBuilder = (): Role => ({ id: BUILDER_AREA, name: 'Builder', model: 'claude-opus-5-5', effort: '', description: 'A fresh builder Helm starts for one task.', prompt: BUILDER_PROMPT, canSpawn: [], tier: 'skilled' });

/** Active tasks someone works on now (their driver is an open agent other than the director): what a new task must not overlap. */
function runningTasks(projectId: string): Row[] {
  return all(
    `SELECT t.* FROM tasks t JOIN agents a ON a.id = t.driver_agent_id WHERE t.project_id = ? AND t.kind = 'task' AND t.state = 'active'
       AND a.parent_id IS NOT NULL AND a.role_id != 'subagent' AND a.status NOT IN ('done', 'closed')`,
    projectId,
  );
}

/**
 * Why `t` cannot start beside the running tasks now, or null. Shared Spec entries do not make two tasks overlap:
 * only the files they touch. A task with no usable paths runs alone, and nothing starts beside one.
 */
export function overlapRefusal(t: Row, running: Row[]): string | null {
  if (!running.length) return null;
  const mine = pathsOf(t);
  if (!mine.length) return `${taskRef(t)} names no files, so it runs alone: it waits until no builder runs.`;
  for (const o of running) {
    const theirs = pathsOf(o);
    if (!theirs.length) return `${taskRef(o)} names no files and runs alone: ${taskRef(t)} waits for it.`;
    const hit = mine.find((p) => theirs.some((q) => pathsOverlap(p, q)));
    if (hit) return `${taskRef(t)} and ${taskRef(o)} both touch ${hit}: it waits.`;
  }
  return null;
}

/** Active tasks with nobody on them (no driver): started by the user or the director, waiting for a builder. */
function startedUnmanned(projectId: string): Row[] {
  return all("SELECT * FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'active' AND driver_agent_id IS NULL ORDER BY started_at, created_at", projectId).filter((t) => !openBlockers(t.id).length);
}

/** Start a fresh builder on `t`: named, linked as its driver, the task Active at its tier; then its brief is sent. */
export async function startBuilder(project: Row, t: Row): Promise<Row> {
  const director = rootAgent(project);
  const structure = projectStructure(project);
  const role = structure.roles.find((r) => r.id === BUILDER_AREA) ?? stockBuilder();
  const agent = tx(() => {
    const name = builderName(project.id);
    const id = newId('ag');
    run(
      "INSERT INTO agents (id, project_id, parent_id, role_id, name, model, task, status, created_at, updated_at, task_id, per_task) VALUES (?,?,?,?,?,?,?,'idle',?,?,?,1)",
      id, project.id, director.id, role.id, name, role.model, '', now(), now(), t.id,
    );
    run('UPDATE tasks SET driver_agent_id = ?, updated_at = ? WHERE id = ?', id, now(), t.id);
    run("UPDATE tasks SET tier = COALESCE(tier, 'skilled'), tier_reason = CASE WHEN tier IS NULL THEN ? ELSE tier_reason END WHERE id = ?", DEFAULT_REASON, t.id);
    const cur = getTask(t.id)!;
    if (cur.state !== 'active') setTaskState(cur, 'active', HELM, `${name} started on it`);
    else addTaskMessage(cur, HELM, `${name} started on it.`, 'state');
    // Its brief carries the related past work (related.ts): not again with its first message.
    markRelatedGiven(id, t.id);
    const brief = builderBrief(getTask(t.id)!, name);
    run('UPDATE agents SET task = ? WHERE id = ?', brief.slice(0, 20000), id);
    return getAgent(id)!;
  });
  addJournal(project.id, director.id, 'status', `Helm started ${agent.name} on ${t.title}`.slice(0, 160), `[[${t.id}]]`);
  touchProject(project.id);
  await sendToAgent(agent.id, String(agent.task), { kind: 'system', name: 'Helm' });
  return agent;
}

/** The tasks that would start now, in order (without starting them): for the dispatcher and its tests. */
export function plan(projectId: string): Row[] {
  const project = getProject(projectId);
  if (!project || project.archived || isStopped(projectId) || diskLevel() === 'critical') return [];
  const running = runningTasks(projectId);
  let free = buildersAtOnce(projectId) - busyBuilders(projectId).length;
  const out: Row[] = [];
  const candidates = [...startedUnmanned(projectId), ...(queueHeld(project) ? [] : startableScheduled(projectId))];
  for (const t of candidates) {
    if (free <= 0) break;
    if (overlapRefusal(t, [...running, ...out])) continue;
    out.push(t);
    free--;
  }
  return out;
}

const busy = new Set<string>();
const again = new Set<string>();

/**
 * Start the builders the project allows now. One run per project at a time; a call during one runs once more after it.
 * Returns the builders started.
 */
export async function dispatchProject(projectId: string): Promise<Row[]> {
  if (busy.has(projectId)) {
    again.add(projectId);
    return [];
  }
  busy.add(projectId);
  const started: Row[] = [];
  try {
    do {
      again.delete(projectId);
      const project = getProject(projectId);
      if (!project) break;
      noteSkipped(projectId);
      for (const t of plan(projectId)) {
        const fresh = getTask(t.id);
        if (!fresh || !['scheduled', 'active'].includes(fresh.state) || (fresh.state === 'active' && fresh.driver_agent_id)) continue;
        started.push(await startBuilder(getProject(projectId)!, fresh));
      }
      await maybeBatch(projectId);
    } while (again.has(projectId));
  } finally {
    busy.delete(projectId);
  }
  return started;
}

/** One batch record when nothing is left running or startable, or BATCH_SIZE tasks have finished since the last. */
async function maybeBatch(projectId: string) {
  const pending = pendingBatch(projectId);
  if (!pending) return;
  const project = getProject(projectId);
  if (!project) return;
  const idle = !busyBuilders(projectId).length && !plan(projectId).length;
  if (idle || pending >= BATCH_SIZE) await batchNote(project);
}

/**
 * A builder's turn ended with complete_task (runtime.ts): its task is done with its summary, recorded for the batch,
 * the builder closed, and the next builders started. Also how the standing Builder's last task ends.
 */
export async function builderDone(agent: Row, summary: string): Promise<void> {
  const t = agent.task_id ? getTask(agent.task_id) : undefined;
  if (t && t.state === 'active') {
    if (summary.trim()) setTaskSummary(t, summary.trim().slice(0, 600), HELM);
    setTaskState(getTask(t.id)!, 'done', HELM, `${agent.name} finished it`);
    await builderTaskDone(agent, getTask(t.id)!, summary);
    if (summary.trim()) setTaskLine(agent.id, t.id, summary.trim().slice(0, 160));
    // Work Helm made for a tap of the user's that the director finishes (buildtask.ts): it is told now.
    if (t.done_note) await tellDirector(agent.project_id, t.done_note).catch(() => {});
  }
  await closeAgent(agent.id, 'closed');
  await dispatchProject(agent.project_id);
}

// ---------- the standing Builder and the area agents, retired ----------

/**
 * The standing Builder and the area agents of before get no new work: each finishes its Active task and is closed once
 * it has none and is not mid-turn. A task the standing Builder held alongside its own (take_task, no longer there)
 * goes back to the queue when no subagent of its works on it. Idempotent; at boot and on every tick.
 */
export async function retireStanding(projectId?: string): Promise<string[]> {
  const closed: string[] = [];
  const rows = all(
    `SELECT * FROM agents WHERE parent_id IS NOT NULL AND per_task = 0 AND role_id != 'subagent' AND status != 'closed'${projectId ? ' AND project_id = ?' : ''}`,
    ...(projectId ? [projectId] : []),
  );
  for (const a of rows) {
    if (isBuilder(a)) {
      for (const t of all("SELECT * FROM tasks WHERE driver_agent_id = ? AND state = 'active' AND kind = 'task' AND id != ?", a.id, a.task_id ?? '')) {
        if (openSubagents(a.id).some((s) => s.task_id === t.id)) continue;
        run('UPDATE tasks SET driver_agent_id = NULL WHERE id = ?', t.id);
        setTaskState(getTask(t.id)!, 'scheduled', HELM, `${a.name} held it alongside its own; back in the queue for a fresh builder`);
      }
    }
    const holds = get("SELECT 1 AS x FROM tasks WHERE driver_agent_id = ? AND state = 'active' AND kind = 'task' LIMIT 1", a.id);
    if (holds || ['working', 'waiting'].includes(a.status)) continue;
    await closeAgent(a.id, 'closed');
    closed.push(a.id);
    addJournal(a.project_id, null, 'status', `${a.name} closed: Helm now starts a fresh builder per task`, '');
  }
  run('UPDATE mode_switches SET told = 1, close_told = 1 WHERE told = 0 OR close_told = 0');
  return closed;
}

/** Every project, once: retire what is left of the old ways, then start what may run. */
export async function dispatchTick() {
  await retireStanding();
  for (const p of all('SELECT id FROM projects WHERE archived = 0')) await dispatchProject(p.id);
}

let timer: NodeJS.Timeout | null = null;
export function startDispatch() {
  void dispatchTick().catch((err) => console.error('Dispatch failed:', err));
  timer = setInterval(() => void dispatchTick().catch((err) => console.error('Dispatch failed:', err)), 30_000);
}
export function stopDispatch() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * The task page's line for a Scheduled task: whether a builder starts on it as soon as one is free, or why it waits
 * (another task's files, a builder running a task with no files, its own missing files). Null when it does not apply.
 */
export function parallelHint(t: Row): string | null {
  if (t.kind !== 'task' || t.state !== 'scheduled') return null;
  if (openBlockers(t.id).length) return 'Stays in the queue: it waits for another task.';
  const why = overlapRefusal(t, runningTasks(t.project_id));
  if (!why) return busyBuilders(t.project_id).length >= buildersAtOnce(t.project_id) ? 'Starts when a builder slot frees.' : 'Starts with its own builder.';
  const touch = /both touch (.+): it waits/.exec(why);
  if (touch) {
    const other = [...why.matchAll(/\[\[([a-z]+_[0-9a-f]+)\]\]/g)].map((m) => m[1]).find((id) => id !== t.id);
    return `Waits: ${other ? `[[${other}]]` : 'a running task'} also touches ${touch[1]}.`;
  }
  if (/names no files, so it runs alone/.test(why)) return 'Runs alone: no files named. Add touches.';
  return why.replace(taskRef(t), 'It');
}
