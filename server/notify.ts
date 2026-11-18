import { db, all, get, now, run } from './db.ts';
import type { Row } from './db.ts';
import { liveOwned, liveUpdateEnabled, readStatus } from './liveupdate.ts';
import { presence } from './sessions.ts';
import { listSubscriptions, sendPush } from './push.ts';
import type { PushOptions } from './push.ts';

/**
 * Phone notifications: what is sent, to whom, and when not. Other code calls one of the `notify…` functions with an
 * event; nothing here can block or fail the action that triggered it (sending is asynchronous, errors are logged to
 * the subscription row). To add a kind: add it to KINDS (with its default and label in web/src/notify.tsx), and
 * call `notify()` from where it happens.
 *
 * Before an event becomes a push:
 * 1. Settings: the global mute; the kind's switch (install-wide, overridden per project); the project's switch.
 * 2. Manners: nothing about an item while a client has it open and visible (presence, reported by the page every
 *    30 seconds while visible); for non-blocking kinds, nothing while the user is looking at that project.
 *    (Whether the user is "away" for the away summary is the sessions feature's, from what they do, not what they view.)
 * 3. Quiet hours (in the time zone of the device that set them) hold everything but blocking requests; when they end,
 *    what was held goes out as one summary.
 * 4. Bursts collapse: events of one group (kind + project) wait a few seconds for company, and within a minute of
 *    the last send a new one replaces it (same `tag`) with a count: "3 tasks finished".
 */

export const KINDS = ['needs', 'done', 'away', 'update', 'agent', 'disk'] as const;
export type NotifyKind = (typeof KINDS)[number];

export type Settings = {
  muted: boolean;
  /** "HH:MM" local times in `tz`; null: none. */
  quiet: { start: string; end: string; tz: string } | null;
  kinds: Record<NotifyKind, boolean>;
  /** Task finished: every time, or only when it has a result to look at. */
  doneMode: 'every' | 'result';
  /** Per project: off entirely, or a kind switched differently from the install-wide default. */
  projects: Record<string, { off?: boolean; kinds?: Partial<Record<NotifyKind, boolean>> }>;
};

export const DEFAULT_SETTINGS: Settings = {
  muted: false,
  quiet: null,
  kinds: { needs: true, done: true, away: true, update: false, agent: false, disk: true },
  doneMode: 'every',
  projects: {},
};

db.exec(`
CREATE TABLE IF NOT EXISTS notify_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Notifications quiet hours are holding, sent as one summary when they end (kept across restarts and updates).
CREATE TABLE IF NOT EXISTS notify_held (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Things notified once: "plan:<task id>" (a plan to approve).
CREATE TABLE IF NOT EXISTS notify_marks (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
`);

function readState<T>(key: string, fallback: T): T {
  const r = get('SELECT value FROM notify_state WHERE key = ?', key);
  if (!r) return fallback;
  try {
    return JSON.parse(r.value);
  } catch {
    return fallback;
  }
}
function writeState(key: string, value: unknown) {
  run('INSERT INTO notify_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function getSettings(): Settings {
  const s = readState<Partial<Settings>>('settings', {});
  return { ...DEFAULT_SETTINGS, ...s, kinds: { ...DEFAULT_SETTINGS.kinds, ...(s.kinds ?? {}) }, projects: s.projects ?? {} };
}

/** Validate and store; returns an error message for a bad value. */
export function saveSettings(input: unknown): string | null {
  const s = input as Partial<Settings>;
  if (!s || typeof s !== 'object') return 'Settings must be an object';
  const out = getSettings();
  if (s.muted !== undefined) out.muted = !!s.muted;
  if (s.quiet !== undefined) {
    if (s.quiet === null) out.quiet = null;
    else {
      const { start, end, tz } = s.quiet;
      if (!HHMM.test(start) || !HHMM.test(end)) return 'Quiet hours need a start and end as HH:MM';
      try {
        new Intl.DateTimeFormat('en-GB', { timeZone: tz });
      } catch {
        return `Unknown time zone ${tz}`;
      }
      out.quiet = { start, end, tz };
    }
  }
  if (s.kinds) for (const k of KINDS) if (typeof s.kinds[k] === 'boolean') out.kinds[k] = s.kinds[k];
  if (s.doneMode === 'every' || s.doneMode === 'result') out.doneMode = s.doneMode;
  if (s.projects) {
    for (const [pid, p] of Object.entries(s.projects)) {
      if (!get('SELECT id FROM projects WHERE id = ?', pid)) continue;
      const kinds: Partial<Record<NotifyKind, boolean>> = {};
      for (const k of KINDS) if (typeof p?.kinds?.[k] === 'boolean') kinds[k] = p.kinds[k];
      out.projects[pid] = { ...(p?.off ? { off: true } : {}), ...(Object.keys(kinds).length ? { kinds } : {}) };
      if (!out.projects[pid].off && !out.projects[pid].kinds) delete out.projects[pid];
    }
  }
  writeState('settings', out);
  return null;
}

/** Minutes since local midnight in a time zone. */
function localMinutes(tz: string, at: number): number {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at).split(':').map(Number);
  return h * 60 + m;
}

export function inQuietHours(s: Settings, at = Date.now()): boolean {
  if (!s.quiet) return false;
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const start = toMin(s.quiet.start);
  const end = toMin(s.quiet.end);
  if (start === end) return false;
  const t = localMinutes(s.quiet.tz, at);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export function kindOn(s: Settings, kind: NotifyKind, projectId?: string): boolean {
  if (s.muted) return false;
  const p = projectId ? s.projects[projectId] : undefined;
  if (p?.off) return false;
  return p?.kinds?.[kind] ?? s.kinds[kind];
}

// ---------- presence ----------

/** Where each open page is ("#/p/…" route) and whether it is visible, as the page last reported. */
const pagePresence = new Map<string, { hash: string; visible: boolean; at: number }>();
const PRESENCE_MS = 60_000;

export function notePresence(client: string, hash: string, visible: boolean) {
  pagePresence.set(client.slice(0, 64), { hash: hash.slice(0, 300), visible, at: Date.now() });
  if (pagePresence.size > 200) for (const [k, v] of pagePresence) if (Date.now() - v.at > PRESENCE_MS) pagePresence.delete(k);
}

/** A page visible in the last minute whose route starts with `prefix`. */
function watching(prefix: string): boolean {
  for (const p of pagePresence.values()) if (p.visible && Date.now() - p.at < PRESENCE_MS && p.hash.startsWith(prefix)) return true;
  return false;
}

// ---------- events ----------

export type NotifyEvent = {
  kind: NotifyKind;
  /** Undefined for install-wide events (an update). */
  projectId?: string;
  /** Already prefixed with the project name where there is one. */
  title: string;
  /** One line; clipped. Never command output, file contents or secrets. */
  body: string;
  /** Where tapping opens: a route ("#/p/…"); the service worker makes it absolute on the subscription's origin. */
  url: string;
  /** The route that counts as "the item is open" (no notification while it is visible). */
  item?: string;
  /** A blocking request: bypasses quiet hours, sent at once, marked urgent. */
  blocking?: boolean;
};

export type Payload = { title: string; body: string; url: string; tag: string; badge: number; urgent: boolean; ts: number };

/** Where payloads go. Replaced by the test harness; normally every enabled subscription. */
let deliver = async (payload: Payload, opts: PushOptions): Promise<void> => {
  const subs = listSubscriptions().filter((s) => s.enabled);
  await Promise.all(subs.map((s) => sendPush(s, payload, opts).catch((err) => console.error('Push failed:', err))));
};
export function setDeliver(fn: typeof deliver) {
  deliver = fn;
}

/** Open requests to the user in projects not archived: the app icon's badge. */
export function badgeCount(): number {
  return (get("SELECT COUNT(*) AS n FROM inbox i JOIN projects p ON p.id = i.project_id JOIN tasks t ON t.id = i.task_id WHERE i.status = 'open' AND p.archived = 0")?.n as number) ?? 0;
}

const oneLine = (s: string, n = 160) => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};
const projectName = (id?: string) => (id ? ((get('SELECT name FROM projects WHERE id = ?', id)?.name as string) ?? '') : '');
const prefixed = (projectId: string | undefined, text: string) => {
  const name = projectName(projectId);
  return name ? `${name} · ${text}` : text;
};

/** Seconds a group waits for more events before sending (blocking requests do not wait). */
export const timing = { gatherMs: 4000, windowMs: 60_000 };

type Group = { pending: NotifyEvent[]; timer: ReturnType<typeof setTimeout> | null; sentAt: number; sentCount: number; tag: string };
const groups = new Map<string, Group>();

/** The entry point. Returns why an event was dropped, for the harness; callers ignore it. */
export function notify(e: NotifyEvent): 'sent' | 'off' | 'watching' | 'held' {
  try {
    const s = getSettings();
    if (!kindOn(s, e.kind, e.projectId)) return 'off';
    if (e.item && watching(e.item)) return 'watching';
    if (!e.blocking && e.projectId && (e.kind === 'done' || e.kind === 'agent') && watching(`#/p/${e.projectId}/`)) return 'watching';
    if (!e.blocking && inQuietHours(s)) {
      run('INSERT INTO notify_held (event, created_at) VALUES (?, ?)', JSON.stringify(e), Date.now());
      return 'held';
    }
    enqueue({ ...e, title: oneLine(e.title, 120), body: oneLine(e.body) });
    return 'sent';
  } catch (err) {
    console.error('Notification dropped:', err);
    return 'off';
  }
}

function enqueue(e: NotifyEvent) {
  const key = `${e.kind}:${e.projectId ?? ''}`;
  let g = groups.get(key);
  if (!g) {
    g = { pending: [], timer: null, sentAt: 0, sentCount: 0, tag: '' };
    groups.set(key, g);
  }
  g.pending.push(e);
  if (e.blocking) {
    if (g.timer) clearTimeout(g.timer);
    g.timer = null;
    flush(key, g);
  } else if (!g.timer) {
    g.timer = setTimeout(() => {
      g.timer = null;
      flush(key, g);
    }, timing.gatherMs);
  }
}

function flush(key: string, g: Group) {
  const events = g.pending;
  g.pending = [];
  if (!events.length) return;
  const t = Date.now();
  const inWindow = t - g.sentAt < timing.windowMs;
  const count = events.length + (inWindow ? g.sentCount : 0);
  if (!inWindow) g.tag = `${key}:${t.toString(36)}`;
  g.sentAt = t;
  g.sentCount = count;
  const last = events[events.length - 1];
  const urgent = events.some((e) => e.blocking);
  const payload: Payload =
    count === 1
      ? { title: last.title, body: last.body, url: last.url, tag: g.tag, badge: badgeCount(), urgent, ts: t }
      : { ...collapsed(last.kind, last.projectId, count, last), tag: g.tag, badge: badgeCount(), urgent, ts: t };
  send(payload);
}

function collapsed(kind: NotifyKind, projectId: string | undefined, n: number, last: NotifyEvent): { title: string; body: string; url: string } {
  const p = projectId ?? '';
  const name = projectName(projectId);
  const own = name && last.title.startsWith(`${name} · `) ? last.title.slice(name.length + 3) : last.title;
  switch (kind) {
    case 'done':
      return { title: prefixed(projectId, `${n} tasks finished`), body: `Latest: ${own.replace(/^Done: /, '')}`, url: `#/p/${p}/tasks/recent` };
    case 'needs':
      // Several requests: the project's home, which shows them one at a time (a group is always one project).
      return { title: prefixed(projectId, `${n} things need you`), body: `Latest: ${own}`, url: projectId ? `#/p/${p}` : '#/needs' };
    case 'agent':
      return { title: prefixed(projectId, `${n} agent problems`), body: last.body, url: `#/p/${p}/agents` };
    default:
      return { title: last.title, body: last.body, url: last.url };
  }
}

function send(payload: Payload) {
  // Fire and forget: the caller's action has already happened and must not wait on a push service.
  void deliver(payload, { urgency: payload.urgent ? 'high' : 'normal', ttl: payload.urgent ? 3 * 24 * 3600 : 24 * 3600, topic: payload.tag.replace(/[^A-Za-z0-9]/g, '').slice(-32) }).catch((err) =>
    console.error('Push delivery failed:', err),
  );
}

/** A test notification for one subscription (from Setup). Bypasses settings, quiet hours and presence. */
export function testPayload(): Payload {
  return { title: 'Helm notifications are on', body: 'This is a test. Requests that need you will arrive like this.', url: '#/', tag: `test:${Date.now().toString(36)}`, badge: badgeCount(), urgent: false, ts: Date.now() };
}

// ---------- the kinds ----------

/** Run a notification hook so that nothing it does can fail the caller's action. */
export function safe(fn: () => void) {
  try {
    fn();
  } catch (err) {
    console.error('Notification hook failed:', err);
  }
}

const pageOf = (t: Row) => (t.kind === 'discussion' ? 'discussions' : 'tasks');

/** A request reached the user: a question, a permission request, a team change to approve. */
export function notifyRequest(inboxId: string) {
  const r = get('SELECT * FROM inbox WHERE id = ?', inboxId);
  const home = r?.task_id ? get('SELECT * FROM tasks WHERE id = ?', r.task_id) : undefined;
  // Only what the user must answer: a permission request the director or the independent check is deciding is not
  // (triage.ts calls this again if it falls to the user).
  if (!r || !home || r.status !== 'open') return;
  let payload: Row = {};
  try {
    payload = JSON.parse(r.payload);
  } catch {}
  // Permission bodies would hold the command or file: say only that it asks, and why it was flagged if it was.
  const body =
    r.kind === 'permission' ? (payload.danger ? `Asks permission. Flagged: ${payload.danger}` : 'Asks permission. Open to allow or deny.')
    : r.kind === 'structure' ? 'A team change waits for your approval.'
    : r.body;
  const item = `#/p/${r.project_id}/${pageOf(home)}/${home.id}`;
  // The stable route: the app resolves it to wherever the request is shown (web/src/project.tsx), scrolled to it.
  notify({ kind: 'needs', projectId: r.project_id, title: prefixed(r.project_id, r.title), body, url: `#/p/${r.project_id}/request/${r.id}`, item, blocking: !!r.blocking });
}

/**
 * A plan to approve is there to read: the director's first post or status summary in a task that is in Planning
 * (tasks.ts addTaskMessage). Once per task: later revisions of the plan are the thread's business.
 */
export function notifyPlanReady(taskId: string, text: string) {
  const task = get('SELECT * FROM tasks WHERE id = ?', taskId);
  if (!task || task.kind !== 'task' || task.state !== 'planning') return;
  const key = `plan:${task.id}`;
  if (get('SELECT 1 AS x FROM notify_marks WHERE key = ?', key)) return;
  run('INSERT INTO notify_marks (key, at) VALUES (?, ?)', key, Date.now());
  const item = `#/p/${task.project_id}/tasks/${task.id}`;
  notify({ kind: 'needs', projectId: task.project_id, title: prefixed(task.project_id, `Plan to approve: ${task.title}`), body: text, url: item, item });
}

/** A task moved to Done. `stretchStart`: when it last changed state before this, to judge "a result to look at". */
export function notifyTaskDone(task: Row, stretchStart: number) {
  if (task.kind !== 'task') return;
  const s = getSettings();
  if (s.doneMode === 'result' && !hasResult(task.id, stretchStart)) return;
  const fresh = get('SELECT status_summary FROM tasks WHERE id = ?', task.id);
  const item = `#/p/${task.project_id}/tasks/${task.id}`;
  notify({ kind: 'done', projectId: task.project_id, title: prefixed(task.project_id, `Done: ${task.title}`), body: fresh?.status_summary || task.status_summary || '', url: item, item });
}

/** A preview posted, or the status summary rewritten, since the task last changed state. */
export function hasResult(taskId: string, since: number): boolean {
  return !!get('SELECT 1 AS x FROM previews WHERE task_id = ? AND created_at >= ? LIMIT 1', taskId, since) || !!get('SELECT 1 AS x FROM tasks WHERE id = ? AND summary_at >= ?', taskId, since);
}

/** An agent's run ended with an error. The error text is not sent (it can hold command output). */
export function notifyAgentFailed(agent: Row) {
  notify({ kind: 'agent', projectId: agent.project_id, title: prefixed(agent.project_id, `${agent.name} stopped with an error`), body: 'Open the agent to see what happened and resume it.', url: `#/p/${agent.project_id}/agents/${agent.id}` });
}

// ---------- away summary ----------

/**
 * Away is the sessions feature's (server/sessions.ts): no session open, i.e. the user has done nothing in the
 * project for its idle period, or said they were stepping away. Once per away period, when the director has worked
 * through the queue or stopped (no agent working and nothing scheduled, for two checks in a row so the gap between
 * two turns does not count) after at least one task finished in that period.
 */
const quietSince = new Map<string, number>();

/** When an away summary was last sent, per project (kept across restarts so one away period gets one). */
const awaySentAt = (projectId: string) => readState<Record<string, number>>('awaySent', {})[projectId] ?? 0;

function finishedSince(projectId: string, since: number): number {
  return Number(get("SELECT COUNT(DISTINCT s.task_id) AS n FROM task_states s JOIN tasks t ON t.id = s.task_id WHERE t.project_id = ? AND t.kind = 'task' AND s.state = 'done' AND s.at > ?", projectId, since)?.n ?? 0);
}

/** Send the away summary for a project now. Callers with their own summary (a director's) pass it. */
export function notifyAway(projectId: string, summary?: { title?: string; body?: string }) {
  writeState('awaySent', { ...readState<Record<string, number>>('awaySent', {}), [projectId]: Date.now() });
  const since = presence(projectId).since ?? 0;
  const lastEnded = get('SELECT id FROM sessions WHERE project_id = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1', projectId);
  const done = finishedSince(projectId, since);
  const needs = Number(get("SELECT COUNT(*) AS n FROM inbox WHERE project_id = ? AND status = 'open' AND task_id IS NOT NULL", projectId)?.n ?? 0);
  const parts = [done ? `${done} ${done === 1 ? 'task' : 'tasks'} finished` : '', needs ? `${needs} ${needs === 1 ? 'request needs' : 'requests need'} you` : 'nothing waits on you'].filter(Boolean);
  notify({
    kind: 'away',
    projectId,
    title: summary?.title ?? prefixed(projectId, 'Work has stopped while you were away'),
    body: summary?.body ?? `${parts.join(', ')}.`.replace(/^./, (ch) => ch.toUpperCase()),
    // History, opened at this away period (web/src/sessions.tsx: an away period's id is away_<the session it follows>).
    url: lastEnded ? `#/p/${projectId}/history/away_${lastEnded.id}` : `#/p/${projectId}/history`,
  });
}

function checkAway(t: number) {
  for (const { id: pid } of all('SELECT id FROM projects WHERE archived = 0')) {
    const p = presence(pid);
    if (p.state !== 'away' || !p.since) {
      quietSince.delete(pid);
      continue;
    }
    if (!finishedSince(pid, Math.max(p.since, awaySentAt(pid)))) continue;
    const busy =
      get("SELECT 1 AS x FROM agents WHERE project_id = ? AND status = 'working' LIMIT 1", pid) ||
      get("SELECT 1 AS x FROM tasks WHERE project_id = ? AND kind = 'task' AND state = 'scheduled' LIMIT 1", pid);
    if (busy) {
      quietSince.delete(pid);
      continue;
    }
    if (!quietSince.has(pid)) {
      quietSince.set(pid, t);
      continue;
    }
    quietSince.delete(pid);
    notifyAway(pid);
  }
}

// ---------- stalled agents, update results, quiet hours ending ----------

const STALL_MS = 20 * 60_000;
const stalled = new Set<string>();

function checkStalled(t: number) {
  const working = all("SELECT * FROM agents WHERE status = 'working' AND updated_at < ?", t - STALL_MS);
  const still = new Set<string>();
  for (const a of working) {
    const last = (get('SELECT MAX(ts) AS ts FROM events WHERE agent_id = ?', a.id)?.ts as number) ?? 0;
    if (t - last < STALL_MS) continue;
    still.add(a.id);
    if (stalled.has(a.id)) continue;
    // Switched off: not remembered, so switching the kind on during a stall still tells the user.
    const r = notify({ kind: 'agent', projectId: a.project_id, title: prefixed(a.project_id, `${a.name} seems stalled`), body: 'It has been working for 20 minutes without any activity.', url: `#/p/${a.project_id}/agents/${a.id}` });
    if (r === 'off') still.delete(a.id);
  }
  stalled.clear();
  for (const id of still) stalled.add(id);
}

function checkUpdate(t: number) {
  // Only this server's own update state (not the live one, from a scratch server that inherited its environment).
  if (!liveUpdateEnabled() || !liveOwned()) return;
  const s = readStatus();
  if (!s || !['healthy', 'failed', 'rolled-back'].includes(s.stage) || t - s.updatedAt > 30 * 60_000) return;
  if (readState('updateNotified', '') === s.id) return;
  writeState('updateNotified', s.id);
  const rev = (r: string) => r.slice(0, 7);
  const title =
    s.stage === 'healthy' ? (s.kind === 'rollback' ? `Helm rolled back to ${rev(s.toRev)}` : `Helm updated to ${rev(s.toRev)}`)
    : s.stage === 'rolled-back' ? 'Helm update rolled back'
    : `Helm ${s.kind} failed`;
  notify({ kind: 'update', title, body: oneLine(s.message || ''), url: '#/helm' });
}

function checkQuietEnd(t: number) {
  if (inQuietHours(getSettings(), t)) return;
  const rows = all('SELECT * FROM notify_held ORDER BY id');
  if (rows.length) {
    run('DELETE FROM notify_held WHERE id <= ?', rows[rows.length - 1].id);
    const events: NotifyEvent[] = rows.map((r) => JSON.parse(r.event));
    const done = events.filter((e) => e.kind === 'done').length;
    const needs = events.filter((e) => e.kind === 'needs').length;
    const other = events.length - done - needs;
    const parts = [done && `${done} ${done === 1 ? 'task' : 'tasks'} finished`, needs && `${needs} ${needs === 1 ? 'request' : 'requests'}`, other && `${other} other`].filter(Boolean);
    const single = events.length === 1 ? events[0] : null;
    // Requests from one project open its home; from several, the Needs you list across projects.
    const needProjects = [...new Set(events.filter((e) => e.kind === 'needs').map((e) => e.projectId ?? ''))];
    send({
      title: single ? single.title : 'While quiet hours were on',
      body: single ? single.body : `${parts.join(', ')}.`,
      url: single ? single.url : needs ? (needProjects.length === 1 && needProjects[0] ? `#/p/${needProjects[0]}` : '#/needs') : '#/',
      tag: `quiet:${t.toString(36)}`, badge: badgeCount(), urgent: false, ts: t,
    });
  }
}

/** One minute tick for everything time-based. */
export function tick(t = Date.now()) {
  for (const f of [checkQuietEnd, checkAway, checkStalled, checkUpdate]) {
    try {
      f(t);
    } catch (err) {
      console.error('Notification check failed:', err);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startNotifications() {
  timer = setInterval(() => tick(), 60_000);
  timer.unref();
}
export function stopNotifications() {
  if (timer) clearInterval(timer);
}

/** For the test harness. */
export const _internal = { presence: pagePresence, groups, held: () => all('SELECT * FROM notify_held'), resetGroups: () => groups.clear() };
