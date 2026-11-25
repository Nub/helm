import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { createRequest } from './requests.ts';
import type { RequestKind } from './requests.ts';
import { rootAgent, sendToAgent } from './agents.ts';
import { getProject, touchProject } from './store.ts';
import { clockText } from './clock.ts';

/**
 * "Not now" on a request schedules a reminder that asks again. A to-do answered Can't / not yet, or a question
 * answered with an option that defers (marked `defer: true`, or labelled Not now, Not yet or Later), closes as usual
 * and gets a reminder: by default at the start of the user's next session in the project at least SESSION_GAP_MS
 * later, or at a time the user picks (in 1 hour, tomorrow) or never. When due, Helm checks it still applies (its task
 * not done or dropped, its inline action not already done, not withdrawn) and files a new request with the same
 * title, text, steps, options and action, marked "Asked again" with when it was first asked. The old request is never
 * reopened. Deferring the same ask MAX_DEFERRALS times stops the reminders and tells the director once.
 */

export const SESSION_GAP_MS = 3 * 3600_000;
export const MAX_DEFERRALS = 3;
const CANT = "Can't / not yet";

/** Whether an option defers: marked so by the asker, or labelled as such. */
export const defersOption = (o: { label?: string; defer?: boolean } | undefined) => !!o && (o.defer === true || /^(not now|not yet|later)\b/i.test(String(o.label ?? '').trim()));

/** Whether this answer defers the request. */
export function defers(item: Row, choice: string | undefined): boolean {
  if (!choice) return false;
  if (item.kind === 'action') return choice === CANT;
  if (item.kind !== 'question') return false;
  const options = JSON.parse(item.options || '[]') as { label: string; defer?: boolean }[];
  return defersOption(options.find((o) => o.label === choice));
}

/** How the chain stands: its first request and how many times it was deferred before this one. */
const chainOf = (item: Row) => {
  const p = JSON.parse(item.payload || '{}');
  return { root: String(p.asked_again?.root ?? item.id), firstAt: Number(p.asked_again?.first_at ?? item.created_at), count: Number(p.asked_again?.count ?? 0) };
};

/** The user deferred a request (answers.ts): schedule its reminder, or stop at the third and tell the director. */
export async function deferRequest(item: Row, at = now()): Promise<Row | null> {
  const chain = chainOf(item);
  const count = chain.count + 1;
  const id = newId('rem');
  if (count >= MAX_DEFERRALS) {
    run("INSERT INTO request_reminders (id, project_id, request_id, root_id, count, deferred_at, status, reason, done_at) VALUES (?,?,?,?,?,?, 'stopped', ?, ?)", id, item.project_id, item.id, chain.root, count, at, `deferred ${count} times`, at);
    const project = getProject(item.project_id);
    if (project) {
      const where = item.task_id ? ` on [[${item.task_id}]]` : '';
      await sendToAgent(rootAgent(project).id, `<helm-note kind="deferred">The user deferred "${item.title}"${where} ${count} times (first asked ${clockText(chain.firstAt)}). Helm stops reminding them. Decide whether it is still needed: drop it, change the plan, or ask again in a different way.</helm-note>`, { kind: 'system', name: 'Helm' }).catch(() => {});
    }
    return get('SELECT * FROM request_reminders WHERE id = ?', id)!;
  }
  run('INSERT INTO request_reminders (id, project_id, request_id, root_id, count, deferred_at) VALUES (?,?,?,?,?,?)', id, item.project_id, item.id, chain.root, count, at);
  touchProject(item.project_id);
  return get('SELECT * FROM request_reminders WHERE id = ?', id)!;
}

/** The user changed when a reminder comes (Needs you, the deferred tile): in an hour, tomorrow, next session, never. */
export function setReminder(id: string, when: 'hour' | 'tomorrow' | 'session' | 'never', at = now()): string | null {
  const r = get("SELECT * FROM request_reminders WHERE id = ? AND status = 'pending'", id);
  if (!r) return 'That reminder is no longer pending.';
  if (when === 'never') run("UPDATE request_reminders SET status = 'cancelled', reason = 'you chose not to be reminded', done_at = ? WHERE id = ?", at, id);
  else run('UPDATE request_reminders SET due_at = ? WHERE id = ?', when === 'session' ? null : at + (when === 'hour' ? 3600_000 : 24 * 3600_000), id);
  touchProject(r.project_id);
  return null;
}


/** When it is due: its time, or the start of the project's first session at least SESSION_GAP_MS after the deferral. */
export function dueAt(r: Row): number | null {
  if (r.due_at != null) return Number(r.due_at);
  const s = get('SELECT MIN(started_at) AS at FROM sessions WHERE project_id = ? AND started_at >= ?', r.project_id, Number(r.deferred_at) + SESSION_GAP_MS);
  return s?.at != null ? Number(s.at) : null;
}

/** "next session", "in 1 hour", "tomorrow 9:12 am": when a pending reminder comes, for the page. */
export function dueText(r: Row, at = now()): string {
  if (r.due_at == null) return 'next session';
  const d = Number(r.due_at) - at;
  if (d <= 90 * 60_000) return `in ${Math.max(1, Math.round(d / 60_000))} min`;
  return clockText(Number(r.due_at));
}

/**
 * Why a deferred request no longer needs asking, or null: its task is done or dropped, its inline action or what it
 * asks is already done (the task approved, started or resumed; the release published; Helm updated; the watch's
 * command approved), or the request was withdrawn.
 */
export async function noLongerNeeded(req: Row): Promise<string | null> {
  if (req.status === 'withdrawn') return 'withdrawn';
  const task = req.task_id ? get('SELECT state, kind FROM tasks WHERE id = ?', req.task_id) : undefined;
  if (task && task.kind === 'task' && (task.state === 'done' || task.state === 'dropped')) return `its task is ${task.state}`;
  const p = JSON.parse(req.payload || '{}');
  const act = p.act as { kind: string; target?: string } | undefined;
  if (act?.target && ['approve_task', 'start_task', 'resume_task'].includes(act.kind)) {
    const t = get('SELECT state FROM tasks WHERE id = ?', act.target);
    if (!t) return 'its task is gone';
    if (act.kind === 'approve_task' && t.state !== 'planning') return 'already approved';
    if (act.kind === 'start_task' && ['active', 'done', 'dropped'].includes(t.state)) return 'already started';
    if (act.kind === 'resume_task' && t.state !== 'paused') return 'already resumed';
  }
  if (act?.kind === 'publish_release' && act.target && get('SELECT 1 AS x FROM releases WHERE id = ? AND published_at IS NOT NULL', act.target)) return 'the release is already published';
  if (act?.kind === 'update_helm' && (await helmUpToDate())) return 'Helm is already up to date';
  if (p.watch_approval) {
    const w = get('SELECT approved_command FROM watches WHERE id = ?', p.watch_approval);
    if (!w) return 'its watch is gone';
    if (w.approved_command && w.approved_command === p.key) return 'already approved';
  }
  if (p.toolbox && !get("SELECT 1 AS x FROM toolbox_items WHERE id = ? AND status IN ('proposed', 'failed')", p.toolbox)) return 'already decided';
  if (Array.isArray(p.watchdog_stalls) && !p.watchdog_stalls.some((x: Row) => get("SELECT 1 AS x FROM task_watch w JOIN tasks t ON t.id = w.task_id WHERE w.task_id = ? AND w.stalled_at IS NOT NULL AND t.state = 'active'", x.id))) return 'no task in it is stalled any more';
  if (p.progress_pause && get("SELECT 1 AS x FROM tasks WHERE id = ? AND state != 'paused'", p.progress_pause)) return 'its task is no longer paused';
  return null;
}

/** Whether the running Helm has nothing to update to (live update on, and the release branch is not ahead). Tests replace it. */
export let helmUpToDate = async (): Promise<boolean> => {
  try {
    const { versionInfo, liveUpdateEnabled } = await import('./liveupdate.ts');
    if (!liveUpdateEnabled()) return false;
    const v = await versionInfo({ mode: 'all', rev: '' } as never);
    return v.available != null && v.behind === 0;
  } catch {
    return false;
  }
};
export function setHelmUpToDate(fn: () => Promise<boolean>) {
  helmUpToDate = fn;
}

/** Due reminders of every project: each still needed is filed again as a new request; the rest are skipped. */
export async function sendDueReminders(at = now()): Promise<number> {
  let sent = 0;
  for (const r of all("SELECT * FROM request_reminders WHERE status = 'pending' ORDER BY deferred_at")) {
    const due = dueAt(r);
    if (due == null || due > at) continue;
    const req = get('SELECT * FROM inbox WHERE id = ?', r.request_id);
    const why = req ? await noLongerNeeded(req) : 'the request is gone';
    if (why || !req) {
      run("UPDATE request_reminders SET status = 'skipped', reason = ?, done_at = ? WHERE id = ?", why ?? 'gone', at, r.id);
      touchProject(r.project_id);
      continue;
    }
    const chain = chainOf(req);
    const payload = { ...JSON.parse(req.payload || '{}'), asked_again: { root: chain.root, first_at: chain.firstAt, count: r.count } };
    const agent = req.agent_id ? get("SELECT id FROM agents WHERE id = ? AND status != 'closed'", req.agent_id) : undefined;
    const task = req.task_id ? get('SELECT * FROM tasks WHERE id = ?', req.task_id) : undefined;
    const made = tx(() => {
      const m = createRequest({
        projectId: req.project_id,
        agentId: agent ? req.agent_id : null,
        kind: req.kind as RequestKind,
        title: req.title,
        body: req.body,
        options: JSON.parse(req.options || '[]'),
        payload,
        importance: req.importance,
        blocking: !!req.blocking,
        task,
      });
      run("UPDATE request_reminders SET status = 'sent', sent_request_id = ?, done_at = ? WHERE id = ?", m.id, at, r.id);
      return m;
    });
    void made;
    sent++;
  }
  return sent;
}

/** Pending reminders, for Needs you (one muted line) and the deferred tiles: the request, when it comes, its project. */
export function pendingReminders(projectId?: string, at = now()): Row[] {
  return all(
    `SELECT m.id, m.request_id, m.project_id, m.count, m.due_at, m.deferred_at, i.title, i.kind, i.task_id, p.name AS project_name
       FROM request_reminders m JOIN inbox i ON i.id = m.request_id JOIN projects p ON p.id = m.project_id
      WHERE m.status = 'pending' AND p.archived = 0 ${projectId ? 'AND m.project_id = ?' : ''} ORDER BY COALESCE(m.due_at, m.deferred_at + ${SESSION_GAP_MS})`,
    ...(projectId ? [projectId] : []),
  ).map((r) => ({ ...r, due_text: dueText(r, at) }));
}

let timer: NodeJS.Timeout | null = null;
export function startReminders() {
  if (timer) return;
  timer = setInterval(() => void sendDueReminders().catch((err) => console.error('Reminders:', err)), 60_000);
  timer.unref?.();
}
export function stopReminders() {
  if (timer) clearInterval(timer);
  timer = null;
}
