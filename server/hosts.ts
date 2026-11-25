import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cacheVars, keepLineOk, pathAdditions, platformOf, PLATFORMS, rootError, usesSlot } from './hostwork.ts';
import { parseUnixStats, parseWindowsStats, unixScript, windowsScript } from './hoststats.ts';
import type { HostStats } from './hoststats.ts';
import { sharedBuildPrompt } from './sharedbuild.ts';
import { heavyAsked, heavyDropped, heavyEnded, heavyStarted, onCommandClaimEnd } from './commands.ts';
import { cpus, hostname, loadavg } from 'node:os';
import { bus } from './bus.ts';
import { all, get, newId, now, run } from './db.ts';
import type { Row } from './db.ts';
import { getAgent, touchProject } from './store.ts';

/**
 * Hosts: machines a project's agents may use over SSH. A host is defined once
 * for the install and attached to any number of projects. This machine is the
 * built-in local host, implicitly attached to every project. Agents claim a
 * host with a one-line activity before using it; claims are what the
 * dashboard shows, and an exclusive host takes one claim at a time.
 */

// ---------- validation ----------

/**
 * `user@host`, `host` or an ssh config alias. Only characters that cannot be
 * read as an ssh option or by a shell: no leading "-", no spaces, no quotes or
 * metacharacters. IPv6 literals are allowed through the ":".
 */
const SSH_TARGET = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9_:][A-Za-z0-9._:-]{0,252}$/;

export function sshTargetError(target: string): string | null {
  if (!target) return 'Give the SSH address, like user@buildbox or an alias from ~/.ssh/config.';
  if (!SSH_TARGET.test(target)) return 'The SSH address may only be user@host or an ssh config alias: letters, digits, ".", "_", "-", ":" and one "@", not starting with "-".';
  return null;
}

export type HostInput = { name?: unknown; ssh_target?: unknown; port?: unknown; purpose?: unknown; notes?: unknown; exclusive?: unknown; platform?: unknown; work_root?: unknown; work_env?: unknown; work_setup?: unknown; work_caches?: unknown; work_keep?: unknown };

/**
 * Checks and normalises user input for a host; `existing` is set when editing. Every field must
 * have its own JSON type: text fields strings, port an integer (or a string of digits, or null or
 * "" to clear it), exclusive a boolean. Anything else is a 400 with a message, not a coercion.
 */
export function hostFields(b: HostInput, existing?: Row): { fields: Record<string, unknown> } | { error: string } {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'Send the host as a JSON object.' };
  const textFields = { name: 'name', ssh_target: 'SSH address', purpose: 'purpose', notes: 'notes' } as const;
  for (const [key, label] of Object.entries(textFields)) {
    const v = b[key as keyof HostInput];
    if (v !== undefined && v !== null && typeof v !== 'string') return { error: `The ${label} must be text.` };
  }
  if (b.port !== undefined && b.port !== null && typeof b.port !== 'number' && !(typeof b.port === 'string' && /^\s*\d*\s*$/.test(b.port))) {
    return { error: 'The port must be a number from 1 to 65535, or empty for the default.' };
  }
  if (b.exclusive !== undefined && typeof b.exclusive !== 'boolean') return { error: 'exclusive must be true or false.' };
  const fields: Record<string, unknown> = {};
  if (b.name !== undefined || !existing) {
    const name = String(b.name ?? '').trim();
    if (!name || name.length > 40 || /[\n\r\t]/.test(name)) return { error: 'Give the host a name of up to 40 characters.' };
    const clash = get('SELECT id FROM hosts WHERE name = ? AND id != ?', name, existing?.id ?? '');
    if (clash) return { error: `There is already a host called "${name}".` };
    fields.name = name;
  }
  if (!existing?.is_local) {
    if (b.ssh_target !== undefined || !existing) {
      const target = String(b.ssh_target ?? '').trim();
      const err = sshTargetError(target);
      if (err) return { error: err };
      fields.ssh_target = target;
    }
    if (b.port !== undefined) {
      if (b.port === null || (typeof b.port === 'string' && !b.port.trim())) fields.port = null;
      else {
        const port = Number(b.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'The port must be a number from 1 to 65535.' };
        fields.port = port;
      }
    }
  }
  if (b.purpose !== undefined) {
    const purpose = String(b.purpose ?? '').trim();
    if (purpose.length > 160 || /\n/.test(purpose)) return { error: 'Keep the purpose to one line of up to 160 characters.' };
    fields.purpose = purpose;
  }
  if (b.notes !== undefined) fields.notes = String(b.notes ?? '').slice(0, 8000);
  if (b.exclusive !== undefined) fields.exclusive = b.exclusive ? 1 : 0;
  // Which scripts it gets (hostwork.ts). This machine's is what Helm runs on.
  if (b.platform !== undefined && !existing?.is_local) {
    if (typeof b.platform !== 'string' || !(PLATFORMS as readonly string[]).includes(b.platform)) return { error: 'The platform is linux, macos or windows.' };
    fields.platform = b.platform;
  }
  // Clean workspaces (hostwork.ts): where they go, PATH additions, a setup line, cache variables, kept build folders.
  for (const k of ['work_root', 'work_env', 'work_setup', 'work_caches', 'work_keep'] as const) {
    const v = b[k];
    if (v === undefined) continue;
    if (v !== null && typeof v !== 'string') return { error: `${k} must be text.` };
    const t = String(v ?? '').trim();
    if (k === 'work_root') {
      const root = t || '~/.helm-work';
      const err = rootError(root);
      if (err) return { error: err };
      fields.work_root = root;
    } else if (k === 'work_env') {
      const bad = t.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => !pathAdditions(l).length);
      if (bad) return { error: `PATH additions are folders, one per line, starting with / or ~/ ("${bad}" is not).` };
      fields.work_env = t;
    } else if (k === 'work_caches') {
      const bad = t.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => !cacheVars(l).length);
      if (bad) return { error: `Cache variables are variable names, one per line ("${bad}" is not).` };
      fields.work_caches = t;
    } else if (k === 'work_keep') {
      const bad = t.split('\n').map((l) => l.trim()).filter(Boolean).find((l) => !keepLineOk(l));
      if (bad) return { error: `Build folders are paths inside the code, one per line, like target or CARGO_TARGET_DIR=target ("${bad}" is not).` };
      fields.work_keep = t;
    } else fields.work_setup = t.slice(0, 2000);
  }
  return { fields };
}

// ---------- rows ----------

export function getHost(id: string): Row | undefined {
  return get('SELECT * FROM hosts WHERE id = ?', id);
}

/** The built-in row for this machine. Created on first start; its name follows the machine's. */
export function localHost(): Row {
  const row = get('SELECT * FROM hosts WHERE is_local = 1');
  if (row) return row;
  let name = hostname() || 'this machine';
  if (get('SELECT id FROM hosts WHERE name = ?', name)) name = `${name} (local)`;
  run(
    'INSERT INTO hosts (id, name, purpose, is_local, check_state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    newId('host'), name, 'Where Helm and its agents run', 1, 'online', now(), now(),
  );
  return get('SELECT * FROM hosts WHERE is_local = 1')!;
}

export function createHost(fields: Record<string, unknown>): Row {
  const id = newId('host');
  run(
    'INSERT INTO hosts (id, name, ssh_target, port, purpose, notes, exclusive, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, fields.name, fields.ssh_target, fields.port ?? null, fields.purpose ?? '', fields.notes ?? '', fields.exclusive ?? 0, now(), now(),
  );
  // The workspace settings (hostwork.ts), when given.
  const work = Object.fromEntries(Object.entries(fields).filter(([k]) => k.startsWith('work_') || k === 'platform'));
  if (Object.keys(work).length) updateHost(getHost(id)!, work);
  return getHost(id)!;
}

export function updateHost(host: Row, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  run(`UPDATE hosts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), now(), host.id);
  // A new address makes the last check meaningless.
  if ('ssh_target' in fields || 'port' in fields) run("UPDATE hosts SET check_state = 'unknown', check_error = '', load = '', cpus = NULL WHERE id = ?", host.id);
}

/** Projects a host is attached to. The local host belongs to every project. */
function projectIdsFor(host: Row): string[] {
  if (host.is_local) return all('SELECT id FROM projects').map((p) => p.id);
  return all('SELECT project_id FROM project_hosts WHERE host_id = ?', host.id).map((r) => r.project_id);
}

/**
 * Tell open browsers that hosts changed: the Hosts page, and every project
 * that shows these hosts. Projects are notified without bumping their
 * "updated" time, since nothing in the project itself changed.
 */
export function hostsChanged(hostIds: string[], extraProjects: string[] = []) {
  const projects = new Set(extraProjects);
  for (const id of hostIds) {
    const host = getHost(id);
    if (host) for (const p of projectIdsFor(host)) projects.add(p);
  }
  bus.publish({ type: 'hosts' });
  for (const projectId of projects) bus.publish({ type: 'project', projectId });
}

export function attachHost(projectId: string, hostId: string) {
  run('INSERT OR IGNORE INTO project_hosts (project_id, host_id, created_at) VALUES (?,?,?)', projectId, hostId, now());
  touchProject(projectId);
  hostsChanged([hostId]);
}

/** Detaching also drops the project's agents' claims on that host. */
export function detachHost(projectId: string, hostId: string) {
  run('DELETE FROM project_hosts WHERE project_id = ? AND host_id = ?', projectId, hostId);
  run('DELETE FROM host_claims WHERE project_id = ? AND host_id = ?', projectId, hostId);
  touchProject(projectId);
  hostsChanged([hostId]);
}

export function deleteHost(host: Row) {
  const projects = projectIdsFor(host);
  run('DELETE FROM hosts WHERE id = ?', host.id);
  for (const p of projects) touchProject(p);
  bus.publish({ type: 'hosts' });
}

// ---------- views ----------

export type ClaimView = { id: string; host_id: string; agent_id: string; agent_name: string; project_id: string; project_name: string; activity: string; created_at: number; updated_at: number; heavy?: number };

function claimsFor(hostIds: string[]): ClaimView[] {
  if (!hostIds.length) return [];
  return all(
    `SELECT c.id, c.host_id, c.agent_id, a.name AS agent_name, c.project_id, p.name AS project_name, c.activity, c.created_at, c.updated_at, c.heavy
       FROM host_claims c JOIN agents a ON a.id = c.agent_id JOIN projects p ON p.id = c.project_id
      WHERE c.host_id IN (${hostIds.map(() => '?').join(',')}) ORDER BY c.created_at`,
    ...hostIds,
  ) as ClaimView[];
}

/** A host as the web app shows it: health, the projects sharing it and who is on it now. */
function hostViews(hosts: Row[]): Row[] {
  const claims = claimsFor(hosts.map((h) => h.id));
  const projects = all('SELECT ph.host_id, p.id, p.name FROM project_hosts ph JOIN projects p ON p.id = ph.project_id WHERE p.archived = 0 ORDER BY p.name');
  const everyProject = hosts.some((h) => h.is_local) ? all('SELECT id, name FROM projects WHERE archived = 0 ORDER BY position, created_at') : [];
  return hosts.map((h) => ({
    ...h,
    stats: h.stats ? JSON.parse(h.stats) : null,
    checking: checking.has(h.id),
    projects: h.is_local ? everyProject : projects.filter((p) => p.host_id === h.id).map((p) => ({ id: p.id, name: p.name })),
    claims: claims.filter((c) => c.host_id === h.id),
  }));
}

const ORDER = 'ORDER BY is_local DESC, name COLLATE NOCASE';

/** Every host, for the global Hosts page. */
export function allHostViews(): Row[] {
  localHost();
  return hostViews(all(`SELECT * FROM hosts ${ORDER}`));
}

/** Hosts attached to a project, the local one first. */
export function projectHosts(projectId: string): Row[] {
  localHost();
  return all(`SELECT * FROM hosts WHERE is_local = 1 OR id IN (SELECT host_id FROM project_hosts WHERE project_id = ?) ${ORDER}`, projectId);
}

export function projectHostViews(projectId: string): Row[] {
  return hostViews(projectHosts(projectId));
}

// ---------- claims ----------

/** A host this project can use, by name or id. */
export function findProjectHost(projectId: string, ref: string): Row | undefined {
  const r = ref.trim();
  return projectHosts(projectId).find((h) => h.id === r || h.name.toLowerCase() === r.toLowerCase());
}

const sshCommand = (h: Row) => (h.is_local ? '' : `ssh ${h.port ? `-p ${h.port} ` : ''}${h.ssh_target}`);

function since(ts: number): string {
  const m = Math.round((now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 120) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

/** Hosts of the project no heavy job runs on now (and that are reachable), for a refusal to point at. */
function freeForHeavy(projectId: string): Row[] {
  return projectHosts(projectId).filter((h) => (h.is_local || h.check_state === 'online') && !get('SELECT 1 FROM host_claims WHERE host_id = ? AND heavy = 1', h.id));
}

/** Told when a heavy claim ends and other agents' heavy jobs are queued (runtime.ts sets it: a note to each). */
let heavyFreed: (agents: Row[], host: Row) => void = () => {};
export const onHeavyFreed = (fn: (agents: Row[], host: Row) => void) => {
  heavyFreed = fn;
};
function endHeavy(agentId: string, hostId: string) {
  const waiting = heavyEnded(agentId, hostId);
  const host = getHost(hostId);
  if (waiting.length && host) heavyFreed(waiting, host);
}
// A command bound to a heavy claim ended: the claim is released with it (commands.ts).
onCommandClaimEnd((claimId) => {
  const c = get('SELECT * FROM host_claims WHERE id = ?', claimId);
  if (!c) return;
  run('DELETE FROM host_claims WHERE id = ?', claimId);
  if (c.heavy) endHeavy(c.agent_id, c.host_id);
  touchProject(c.project_id);
  hostsChanged([c.host_id]);
});

/**
 * `heavy`: the claim is for a heavy job (a build, a suite, a render): one runs at a time on each host, whoever holds
 * the others. Refused while another runs there, with the hosts that are free; the job then queues (commands.ts).
 */
export function claimHost(agentId: string, ref: string, activity: string, heavy = false): { ok: string } | { error: string } {
  const agent = getAgent(agentId);
  if (!agent) return { error: 'No such agent.' };
  const host = findProjectHost(agent.project_id, ref);
  if (!host) return { error: `"${ref}" is not one of this project's hosts. Call list_hosts to see them.` };
  if (heavy) {
    const running = get('SELECT c.agent_id, c.activity, c.created_at, a.name AS agent_name FROM host_claims c JOIN agents a ON a.id = c.agent_id WHERE c.host_id = ? AND c.heavy = 1', host.id);
    if (running) {
      const free = freeForHeavy(agent.project_id).filter((h) => h.id !== host.id);
      heavyAsked(agent);
      return {
        error:
          `${host.name} already runs a heavy job (${running.agent_id === agentId ? 'yours' : `"${running.agent_name}"`}, since ${since(running.created_at)}: ${running.activity}); one runs at a time on each host. ` +
          (free.length ? `Free for a heavy job now: ${free.map((h) => h.name).join(', ')}. Claim one that suits the job.` : 'No host is free: carry on with light work, and Helm tells you when one frees.'),
      };
    }
  }
  if (host.exclusive) {
    const held = claimsFor([host.id]).find((c) => c.agent_id !== agentId);
    if (held) {
      const where = held.project_id === agent.project_id ? '' : ` on the project "${held.project_name}"`;
      return {
        error: `${host.name} is one agent at a time and is held by "${held.agent_name}"${where} since ${since(held.created_at)}, for: ${held.activity}. Do not use it until it is released; work on something else meanwhile, or ask your manager or the user if you are blocked.`,
      };
    }
  }
  const mine = get('SELECT id FROM host_claims WHERE host_id = ? AND agent_id = ?', host.id, agentId);
  if (mine) run('UPDATE host_claims SET activity = ?, updated_at = ?, heavy = MAX(heavy, ?) WHERE id = ?', activity, now(), heavy ? 1 : 0, mine.id);
  else run('INSERT INTO host_claims (id, host_id, agent_id, project_id, activity, created_at, updated_at, heavy) VALUES (?,?,?,?,?,?,?,?)', newId('claim'), host.id, agentId, agent.project_id, activity, now(), now(), heavy ? 1 : 0);
  if (heavy) heavyStarted(agent, host.id, projectHosts(agent.project_id).map((h) => h.id));
  touchProject(agent.project_id);
  hostsChanged([host.id]);
  if (heavy) return { ok: `You hold ${host.name}${host.is_local ? '' : ` (${sshCommand(host)})`} for one heavy job. Start it there now, in the background; Helm releases the claim when that command ends (or release_host).` };
  return { ok: mine ? `Updated your activity on ${host.name}.` : `You hold ${host.name}${host.is_local ? '' : ` (${sshCommand(host)})`}. Release it with release_host when you are done.` };
}

/** Release one host, or with no ref every host the agent holds. */
export function releaseHost(agentId: string, ref?: string): { ok: string } | { error: string } {
  const agent = getAgent(agentId);
  if (!agent) return { error: 'No such agent.' };
  if (!ref) {
    const n = releaseAgentClaims(agentId);
    return { ok: n ? `Released ${n} ${n === 1 ? 'host' : 'hosts'}.` : 'You held no hosts.' };
  }
  const claim = get(
    'SELECT c.id, c.host_id, c.heavy, h.name FROM host_claims c JOIN hosts h ON h.id = c.host_id WHERE c.agent_id = ? AND (h.id = ? OR h.name = ?)',
    agentId, ref.trim(), ref.trim(),
  );
  if (!claim) return { error: `You do not hold "${ref}".` };
  run('DELETE FROM host_claims WHERE id = ?', claim.id);
  if (claim.heavy) endHeavy(agentId, claim.host_id);
  touchProject(agent.project_id);
  hostsChanged([claim.host_id]);
  return { ok: `Released ${claim.name}.` };
}

/** Drops every claim an agent holds. Called when it is closed, stopped, completes or errors. */
export function releaseAgentClaims(agentId: string): number {
  heavyDropped(agentId);
  const held = all('SELECT host_id, project_id, heavy FROM host_claims WHERE agent_id = ?', agentId);
  if (!held.length) return 0;
  run('DELETE FROM host_claims WHERE agent_id = ?', agentId);
  for (const c of held) if (c.heavy) endHeavy(agentId, c.host_id);
  hostsChanged(held.map((c) => c.host_id), [held[0].project_id]);
  return held.length;
}

// ---------- what agents are told ----------

function stateText(h: Row): string {
  if (h.is_local) return 'this machine';
  const load = h.load ? `, load ${h.load.split(' ')[0]}${h.cpus ? ` on ${h.cpus} cores` : ''}` : '';
  switch (h.check_state) {
    case 'online':
      return `online${load}`;
    case 'login':
      return `reachable but SSH login fails: ${h.check_error}`;
    case 'offline':
      return `unreachable: ${h.check_error}`;
    default:
      return 'not checked yet';
  }
}

/** The list_hosts tool's answer. */
export function hostsText(projectId: string, agentId: string): string {
  const hosts = projectHostViews(projectId);
  return hosts
    .map((h) => {
      const lines = [`## ${h.name}${h.is_local ? ' (local: you run here)' : ''} — ${stateText(h)}`];
      lines.push(h.is_local ? 'reach: you are already on it; no SSH needed' : `reach: ${sshCommand(h)}`);
      if (h.purpose) lines.push(`purpose: ${h.purpose}`);
      if (h.exclusive) lines.push('one agent at a time: claim it before use; a claim by anyone else means wait');
      if (h.claims.length) {
        lines.push('on it now:');
        for (const c of h.claims as ClaimView[]) {
          const who = c.agent_id === agentId ? 'you' : `"${c.agent_name}"${c.project_id === projectId ? '' : ` (project "${c.project_name}")`}`;
          lines.push(`- ${who}, since ${since(c.created_at)}${c.heavy ? ', heavy job' : ''}: ${c.activity}`);
        }
      } else lines.push('on it now: nobody');
      if (h.notes.trim()) lines.push(`notes:\n${h.notes.trim()}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** A section of the system prompt, only when the project has hosts besides this machine. */
export function hostsPromptSection(projectId: string): string {
  const remote = projectHosts(projectId).filter((h) => !h.is_local);
  const shared = sharedBuildPrompt(get('SELECT * FROM projects WHERE id = ?', projectId)!);
  if (!remote.length) return shared ? `# Builds\n${shared}` : '';
  const slots = remote.filter((h) => usesSlot(h, projectId));
  return [
    `# Hosts`,
    `Besides this machine, the project can use these hosts over SSH (keys are already set up; never ask for or store passwords):`,
    ...remote.map((h) => `- ${h.name}: \`${sshCommand(h)}\`${platformOf(h) !== 'linux' ? ` (${platformOf(h) === 'macos' ? 'macOS' : 'Windows'})` : ''}${h.purpose ? ` — ${h.purpose}` : ''}${h.exclusive ? ' (one agent at a time)' : ''}`),
    `Work on a host goes in a clean workspace of its own: host_workspace gives you a fresh folder there with the project's code at a commit, and a runner, .helm/run, that runs a command in it with no login shell or profile and a minimal environment (the user's settings and earlier runs do not leak in). Run everything there through its runner with the command on stdin (\`ssh <host> <workspace>/.helm/run <<'HELM'\` … \`HELM\`: the host's own login shell never parses it), never in the host's home or elsewhere; when the job ends call host_workspace_end with the files to bring back (it removes the workspace, or keeps it a day if the job failed). On Windows the runner is .helm/run.ps1 (host_workspace says how to call it) and commands are PowerShell.`,
    ...(slots.length ? [`On ${slots.map((h) => h.name).join(', ')}, jobs use the project's build slot: the same folder every time, its code reset to your commit and its build folders kept, so builds are incremental. One job at a time: end yours with host_workspace_end as soon as it is done; if the slot is busy, Helm tells you when it frees (pass fresh: true only when a clean build is the point).`] : []),
    ...(shared ? [shared] : []),
    `Before you run anything on a host, claim it with claim_host and a one-line activity ("running the Android test suite"). Call claim_host again when the activity changes, and release_host when you are done. The dashboard shows the user who is on which machine from these claims. A host marked one agent at a time refuses your claim while someone else holds it: do not use it then. Your claims are dropped automatically when you finish your task, are stopped, closed or hit an error; claim again after resuming. This list was read when your session started and may be stale; list_hosts shows the current hosts, their state, notes and who is on them.`,
  ].join('\n');
}

// ---------- health checks ----------

const CHECK_EVERY_MS = 60_000;
const CHECK_TIMEOUT_MS = 20_000;

const checking = new Set<string>();
const children = new Set<ChildProcess>();
let timer: NodeJS.Timeout | null = null;
let stopped = false;

type CheckResult = { state: 'online' | 'offline' | 'login'; error: string; load: string; cpus: number | null; stats?: HostStats | null };

/** The collector's output as a check result: its load and core count, and the stats (hoststats.ts). */
function withStats(out: string, windows: boolean): Pick<CheckResult, 'load' | 'cpus' | 'stats'> {
  const stats = windows ? parseWindowsStats(out) : parseUnixStats(out);
  return { load: stats.load, cpus: stats.cpus, stats };
}

const LOGIN_FAILED = /permission denied|host key verification failed|too many authentication failures|authentication failed|no supported authentication|remote host identification has changed|account (is )?(locked|expired)|password change required/i;

function sshCheck(host: Row): Promise<CheckResult> {
  return new Promise((resolve) => {
    if (sshTargetError(host.ssh_target)) return resolve({ state: 'offline', error: 'Invalid SSH address.', load: '', cpus: null });
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', '-T', '-n'];
    if (host.port) args.push('-p', String(host.port));
    // One round per sample: the platform's collector (hoststats.ts). Unix reads it from stdin with sh, so the login
    // shell (fish, zsh) never parses it; Windows gets one encoded PowerShell command.
    const windows = platformOf(host) === 'windows';
    if (!windows) args.splice(args.indexOf('-n'), 1);
    args.push('--', host.ssh_target, windows ? windowsScript(host.work_root ?? '') : 'sh -s');
    let out = '';
    let err = '';
    let timedOut = false;
    const child = spawn('ssh', args, { stdio: [windows ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    children.add(child);
    if (!windows) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(unixScript(host.work_root ?? ''));
    }
    const kill = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CHECK_TIMEOUT_MS);
    child.stdout!.on('data', (d) => (out = (out + d).slice(-4000)));
    child.stderr!.on('data', (d) => (err = (err + d).slice(-4000)));
    const finish = (code: number | null, spawnError?: Error) => {
      clearTimeout(kill);
      children.delete(child);
      const message = (spawnError?.message ?? err)
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !/^warning: permanently added/i.test(l))
        .join(' ')
        .slice(0, 300);
      if (spawnError) return resolve({ state: 'offline', error: `Could not run ssh: ${message}`, load: '', cpus: null });
      if (timedOut) return resolve({ state: 'offline', error: `No answer within ${CHECK_TIMEOUT_MS / 1000} s.`, load: '', cpus: null });
      if (code === 0) return resolve({ state: 'online', error: '', ...withStats(out, windows) });
      // 255 is ssh's own failure; anything else came from the remote command after a successful login.
      if (code !== 255) return resolve({ state: 'online', error: message ? `Load command failed: ${message}` : '', ...withStats(out, windows) });
      if (LOGIN_FAILED.test(message)) return resolve({ state: 'login', error: message, load: '', cpus: null });
      return resolve({ state: 'offline', error: message || 'ssh failed without a message.', load: '', cpus: null });
    };
    child.on('error', (e) => finish(null, e));
    child.on('close', (code) => finish(code));
  });
}

/** This machine: the same Unix collector, run with sh; the load and cores from Node if it fails. */
function localCheck(host: Row): Promise<CheckResult> {
  const fallback: CheckResult = { state: 'online', error: '', load: loadavg().map((n) => n.toFixed(2)).join(' '), cpus: cpus().length, stats: null };
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('sh', ['-s'], { stdio: ['pipe', 'pipe', 'ignore'] });
    children.add(child);
    const kill = setTimeout(() => child.kill('SIGKILL'), CHECK_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out = (out + d).slice(-8000)));
    child.stdin.on('error', () => {});
    child.stdin.end(unixScript(host.work_root ?? ''));
    const done = () => {
      clearTimeout(kill);
      children.delete(child);
      const s = withStats(out, false);
      resolve({ ...fallback, load: s.load || fallback.load, cpus: s.cpus ?? fallback.cpus, stats: s.stats });
    };
    child.on('error', () => {
      clearTimeout(kill);
      children.delete(child);
      resolve(fallback);
    });
    child.on('close', done);
  });
}

/** Check one host now. Resolves at once if a check of it is already running. */
export async function checkHost(hostId: string, announce = false): Promise<void> {
  if (checking.has(hostId) || stopped) return;
  const host = getHost(hostId);
  if (!host) return;
  checking.add(hostId);
  // Lets an open Hosts page show that a requested check is running.
  if (announce && !host.is_local) bus.publish({ type: 'hosts' });
  try {
    const res = host.is_local ? await localCheck(host) : await sshCheck(host);
    if (stopped) return;
    const current = getHost(hostId);
    // Deleted, or its address changed while the check ran.
    if (!current || current.ssh_target !== host.ssh_target || current.port !== host.port) return;
    // Stats: the last sample while online; offline, the old ones are dropped (nothing current to show).
    run('UPDATE hosts SET check_state = ?, check_error = ?, load = ?, cpus = ?, stats = ?, checked_at = ? WHERE id = ?', res.state, res.error, res.load, res.cpus, res.state === 'online' && res.stats ? JSON.stringify(res.stats) : null, now(), hostId);
    // Projects show the state but not the load, so only a change of state concerns them.
    if (current.check_state !== res.state || current.check_error !== res.error) hostsChanged([hostId]);
    else bus.publish({ type: 'hosts' });
  } finally {
    checking.delete(hostId);
  }
}

/**
 * The Hosts page, while open and visible, asks for a sample about every SAMPLE_EVERY_MS (POST /api/hosts/sample);
 * nothing samples on a timer for it, so the extra sampling stops when no one has the page open and the once-a-minute
 * check is all that runs. Asks closer together than this (two open pages) share one sample.
 */
export const SAMPLE_EVERY_MS = 15_000;
let lastSample = 0;
export function sampleForPage(): boolean {
  if (stopped || Date.now() - lastSample < SAMPLE_EVERY_MS - 3_000) return false;
  lastSample = Date.now();
  checkAll();
  return true;
}

export function checkAll() {
  for (const h of all('SELECT id FROM hosts')) void checkHost(h.id);
}

export function startHealthChecks() {
  localHost();
  stopped = false;
  checkAll();
  timer = setInterval(checkAll, CHECK_EVERY_MS);
}

export function stopHealthChecks() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
  for (const c of children) c.kill('SIGKILL');
  children.clear();
}

/** Used when the server starts: an agent left stopped or finished holds nothing. */
export function releaseStaleClaims() {
  run("DELETE FROM host_claims WHERE agent_id IN (SELECT id FROM agents WHERE status IN ('closed', 'done', 'interrupted', 'error'))");
}

