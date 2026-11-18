import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bus } from './bus.ts';
import { config } from './config.ts';
import { decideLan, decideProxySignIn, defaultAllowedHosts } from './lan.ts';
import type { LanSettings } from './lan.ts';
import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { allHostViews, attachHost, checkHost, createHost, deleteHost, detachHost, getHost, hostFields, hostsChanged, projectHostViews, updateHost } from './hosts.ts';
import { answerInbox, closeAgent, interruptAgent, liveCount, rootAgent, sendToAgent } from './runtime.ts';
import { VERSION, startLiveUpdate, versionInfo } from './liveupdate.ts';
import { addJournal, addPreview, agentView, deletePreviewFiles, getAgent, getProject, inboxView, listEvents, projectState, projectStructure, projectSummaries, touchProject } from './store.ts';
import { DEFAULT_COLD_DAYS, discussionView, filedLinks, listDiscussions, requestHolders } from './discussions.ts';
import { needingResponse } from './requests.ts';
import { HANDOFF_MESSAGE, handoffInfo, handoffState, markHandoffSeen } from './handoff.ts';
import { registerReportApi } from './reportapi.ts';
import { registerAttachmentApi } from './attachmentapi.ts';
import { registerAnnotationApi } from './annotations.ts';
import { deleteProjectAttachments, pendingAttachments } from './attachments.ts';
import { reportSummary } from './reports.ts';
import { afterDocDeleted, docView, specState } from './spec.ts';
import { registerSpecApi } from './specapi.ts';
import { registerTaskApi, tellDirector } from './taskapi.ts';
import { registerToolboxApi } from './toolboxapi.ts';
import { listDialogue } from './turns.ts';
import { STATE_LABEL, USER, createTask, listTasks, setTaskState, unfiledNeedsCount, taskRef, taskView } from './tasks.ts';
import { APPROVAL_POLICIES, MODELS, TEMPLATES, defaultStructure, stampUserEdit, validateStructure } from './structure.ts';
import { teamDetails } from './teamview.ts';
import { attention } from './taskwatch.ts';
import { DEFAULT_IDLE_MINUTES, activityProject, extendSession, getPeriod, listPeriods, presenceView, recordOwnerActivity, stepAway } from './sessions.ts';
import { openConsultViews } from './consults.ts';
import { ANSWERERS, DEFAULT_TRIAGE_MINUTES, decisionsFor, revokeRule, rulesFor } from './triage.ts';
import { resolveRefs } from './refs.ts';
import { contextBlock } from './chatcontext.ts';
import { diskStatus, healthDisk, saveDiskSettings, tick } from './disk.ts';
import { diskUsage } from './diskusage.ts';

const exec = promisify(execFile);

const COOKIE = 'helm_session';
const AUTONOMY = ['supervised', 'edits', 'auto', 'full'];
const sessionValue = createHash('sha256').update(`helm:${config.token}`).digest('hex');

function authed(req: FastifyRequest): boolean {
  const raw = req.headers.cookie ?? '';
  const m = raw.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!m) return false;
  const given = Buffer.from(m.slice(COOKIE.length + 1));
  const want = Buffer.from(sessionValue);
  return given.length === want.length && timingSafeEqual(given, want);
}

let hostCache = { at: 0, hosts: new Set<string>() };
/** This machine's addresses can change (DHCP), so the allowed Host set is rebuilt at most every 30 seconds. */
function lanSettings(): LanSettings {
  if (Date.now() - hostCache.at > 30_000) {
    hostCache = { at: Date.now(), hosts: new Set([...defaultAllowedHosts(config.port), ...config.lanAllowedHosts]) };
  }
  return { enabled: config.lanNoLogin, allowedHosts: hostCache.hosts };
}

/** Signed in without the passphrase: at the proxy's sign-in gate ("sso") or by being on the local network ("lan"). */
function viaWithoutCookie(req: FastifyRequest): 'sso' | 'lan' | null {
  const r = { peer: req.raw.socket.remoteAddress, method: req.method, headers: req.headers };
  if (config.trustProxySignIn && decideProxySignIn(r, true).ok) return 'sso';
  if (config.lanNoLogin && decideLan(r, lanSettings()).ok) return 'lan';
  return null;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';

function bad(reply: FastifyReply, message: string, code = 400) {
  return reply.code(code).send({ error: message });
}

/** Spec entries can be begun and stopped ('goal' and 'design' are the older names of an entry). */
const STEERABLE = ['entry', 'goal', 'design'];

export function registerApi(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url;
    const open = url.startsWith('/api/login') || url.startsWith('/api/session') || url === '/api/health';
    const guarded = (url.startsWith('/api/') && !open) || url.startsWith('/artifacts/');
    if (guarded && !authed(req) && !viaWithoutCookie(req)) return bad(reply, 'Not signed in', 401);
  });
  // Anything the owner does in a project (not viewing it) is activity that opens or extends a session (sessions.ts).
  // Before the handler, so a message it delivers to the director already carries the new presence.
  app.addHook('preHandler', async (req) => {
    const projectId = activityProject(req.method, req.routeOptions?.url, (req.params ?? {}) as Record<string, string>);
    if (projectId) {
      recordOwnerActivity(projectId);
      (req as any).helmActivity = projectId;
    }
  });
  // What the action recorded (a message, a state change) lands while it is handled, a moment after it started: the
  // session runs at least until the response, so those records fall inside it.
  app.addHook('onResponse', async (req) => {
    const projectId = (req as any).helmActivity as string | undefined;
    if (projectId) extendSession(projectId);
  });

  // ---------- session ----------

  // via says why: "sso" (the proxy's sign-in gate; signedInBy names it), "lan" (local network), "cookie" (the
  // passphrase), or null. The first two are reported even if the device also has a cookie, so the owner can see
  // which mode it is in.
  app.get('/api/session', async (req) => {
    const via = viaWithoutCookie(req) ?? (authed(req) ? 'cookie' : null);
    const signedInBy = via === 'sso' && config.trustProxySignIn !== '1' ? config.trustProxySignIn : null;
    return { authed: via !== null, via, signedInBy };
  });

  app.post('/api/login', async (req, reply) => {
    const { token } = (req.body ?? {}) as { token?: string };
    const a = Buffer.from(String(token ?? ''));
    const b = Buffer.from(config.token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await new Promise((r) => setTimeout(r, 600));
      return bad(reply, 'Wrong passphrase', 401);
    }
    // Secure only when the request came through an HTTPS proxy, so plain http on localhost and the LAN keeps working.
    // Forging the header could only make the cookie stop working for the forger.
    const secure = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' ? '; Secure' : '';
    reply.header('set-cookie', `${COOKIE}=${sessionValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}`);
    return { ok: true };
  });

  // ---------- version and live update (server/liveupdate.ts) ----------

  // Unauthenticated, for the update script's health check: it waits until the new build reports its own revision.
  // disk: { level: 'ok' | 'warning' | 'critical', full } (server/disk.ts); added later, so readers must not need it.
  app.get('/api/health', async () => ({ ok: true, rev: VERSION.rev, disk: healthDisk() }));

  app.get('/api/disk/status', async () => diskStatus());
  // The Disk page: free space, and what projects, worktrees, registered folders, Helm, Nix and /tmp take (server/diskusage.ts).
  app.get('/api/disk', async () => ({ status: diskStatus(), usage: await diskUsage() }));
  app.post('/api/disk/refresh', async () => {
    void tick();
    return { status: diskStatus(), usage: await diskUsage(true) };
  });
  app.put('/api/disk/settings', async (req, reply) => {
    const error = saveDiskSettings(req.body);
    if (error) return bad(reply, error);
    bus.publish({ type: 'disk' });
    return diskStatus();
  });

  app.get('/api/version', async () => versionInfo());

  for (const kind of ['update', 'rollback'] as const) {
    app.post(`/api/version/${kind}`, async (_req, reply) => {
      const error = await startLiveUpdate(kind);
      if (error) return bad(reply, error, 409);
      return versionInfo();
    });
  }

  // ---------- live updates ----------

  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const unsubscribe = bus.subscribe((msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ---------- reference data ----------

  app.get('/api/meta', async () => ({
    templates: TEMPLATES,
    models: MODELS,
    projectsRoot: config.projectsRoot,
    home: homedir(),
    liveAgents: liveCount(),
  }));

  /** The prompt that makes a session in another tool hand its project over to Helm (server/handoff.ts). */
  app.get('/api/handoff', async () => handoffInfo());

  /** Folder browser for picking an existing repository. */
  app.get('/api/fs', async (req, reply) => {
    const q = req.query as { path?: string };
    const path = resolve(q.path || homedir());
    if (!existsSync(path) || !statSync(path).isDirectory()) return bad(reply, 'Not a folder');
    const dirs: { name: string; path: string; git: boolean }[] = [];
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(path, entry.name);
      dirs.push({ name: entry.name, path: full, git: existsSync(join(full, '.git')) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    const parent = dirname(path);
    return { path, parent: parent === path ? null : parent, git: existsSync(join(path, '.git')), dirs };
  });

  // ---------- projects ----------

  // unfiledNeeds: tasks that say they need the user with no request open (tasks.ts unfiledNeed).
  app.get('/api/projects', async () => ({ projects: projectSummaries().map((p) => ({ ...p, unfiledNeeds: unfiledNeedsCount(p.id) })) }));

  // Every task and discussion awaiting the user's response, across projects, grouped by project (the top bar's
  // "Needs you"). The same rows the Tasks and Discussions lists show; count is the number of open requests.
  app.get('/api/needs', async () => needingResponse((t) => (t.kind === 'discussion' ? discussionView(t) : taskView(t))));

  // The open requests themselves, as the inbox listed them; kept for anything still asking for this path.
  app.get('/api/inbox', async () => ({
    items: all(
      "SELECT inbox.*, projects.name AS project_name, agents.name AS agent_name FROM inbox JOIN projects ON projects.id = inbox.project_id LEFT JOIN agents ON agents.id = inbox.agent_id WHERE inbox.status = 'open' AND projects.archived = 0 ORDER BY inbox.blocking DESC, inbox.importance DESC, inbox.created_at",
    ).map(inboxView),
  }));

  app.post('/api/projects', async (req, reply) => {
    const body = (req.body ?? {}) as {
      mode?: 'new' | 'existing' | 'clone';
      name?: string;
      path?: string;
      gitUrl?: string;
      brief?: string;
      templateId?: string;
      autonomy?: string;
    };
    let path: string;
    let name = (body.name ?? '').trim();

    if (body.mode === 'existing') {
      if (!body.path) return bad(reply, 'Pick a folder.');
      path = resolve(body.path);
      if (!existsSync(path) || !statSync(path).isDirectory()) return bad(reply, `Folder not found: ${path}`);
      name ||= basename(path);
    } else if (body.mode === 'clone') {
      const url = (body.gitUrl ?? '').trim();
      if (!url) return bad(reply, 'Give a repository URL.');
      name ||= basename(url).replace(/\.git$/, '');
      path = join(config.projectsRoot, slug(name));
      if (existsSync(path)) return bad(reply, `${path} already exists. Open it as an existing folder instead.`);
      mkdirSync(config.projectsRoot, { recursive: true });
      try {
        await exec('git', ['clone', '--', url, path], { timeout: 15 * 60 * 1000 });
      } catch (err: any) {
        return bad(reply, `git clone failed: ${String(err?.stderr || err?.message || err).trim().slice(0, 600)}`);
      }
    } else {
      if (!name) return bad(reply, 'Give the project a name.');
      path = join(config.projectsRoot, slug(name));
      if (existsSync(path) && readdirSync(path).length) return bad(reply, `${path} already exists and is not empty. Open it as an existing folder instead.`);
      mkdirSync(path, { recursive: true });
      await exec('git', ['init'], { cwd: path }).catch(() => {});
    }

    const already = get('SELECT id FROM projects WHERE path = ? AND archived = 0', path);
    if (already) return bad(reply, 'That folder is already a Helm project.');

    const template = TEMPLATES.find((t) => t.id === body.templateId);
    const structure = template ? structuredClone(template.structure) : defaultStructure();
    structure.template = template?.id ?? TEMPLATES[0].id;
    if (APPROVAL_POLICIES.includes((body as any).approval)) structure.approval = (body as any).approval;
    const id = newId('pr');
    run(
      // A new project goes to the end of the list.
      'INSERT INTO projects (id, name, path, description, phase, autonomy, structure, position, created_at, updated_at, permission_answerer) VALUES (?,?,?,?,?,?,?,(SELECT COALESCE(MAX(position), 0) + 1 FROM projects),?,?,?)',
      id, name, path, '', 'Setup', AUTONOMY.includes(body.autonomy ?? '') ? body.autonomy : 'auto', JSON.stringify(structure), now(), now(),
      // New projects have the director answer routine permission requests; older ones keep asking the user (db.ts).
      ANSWERERS.includes((body as any).permission_answerer) ? (body as any).permission_answerer : 'director',
    );
    // Its history starts now: there is nothing older to group into sessions.
    run('UPDATE projects SET sessions_backfilled = 1 WHERE id = ?', id);
    const project = getProject(id)!;
    const handoff = body.mode === 'new' ? null : handoffState(project).file;
    addJournal(
      id, null, 'milestone', 'Project created',
      (body.mode === 'clone' ? `Cloned from ${body.gitUrl}` : body.mode === 'existing' ? `Opened existing folder ${path}` : `New folder ${path}`) +
        (handoff ? `. It has a handoff file from a previous session (${handoff.name}).` : ''),
    );
    const root = rootAgent(project);
    const brief = (body.brief ?? '').trim();
    if (brief) await sendToAgent(root.id, brief, { kind: 'user', name: 'You' });
    bus.publish({ type: 'projects' });
    return { id };
  });

  /** What reference chips show: GET /api/refs?ids=task_x,doc_y (see server/refs.ts). */
  app.get('/api/refs', async (req) => resolveRefs(String((req.query as any)?.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean)));

  app.get('/api/projects/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    const state = projectState(id);
    return state ? { ...state, coldDaysDefault: DEFAULT_COLD_DAYS, idleMinutesDefault: DEFAULT_IDLE_MINUTES, presence: presenceView(id), attention: attention(id), docs: state.docs.map(docView), ...specState(id), handoff: handoffState(state.project), tasks: listTasks(id), discussions: listDiscussions(id), request_holders: requestHolders(id), request_records: all('SELECT id, title, state, inbox_archive FROM tasks WHERE project_id = ? AND (requests_agent_id IS NOT NULL OR inbox_archive = 1) ORDER BY inbox_archive, updated_at DESC', id), filed: filedLinks(id), hosts: projectHostViews(id), reports: reportSummary(id), consults: openConsultViews(id) } : bad(reply, 'No such project', 404);
  });

  app.patch('/api/projects/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    const project = getProject(id);
    if (!project) return bad(reply, 'No such project', 404);
    const body = (req.body ?? {}) as Record<string, any>;
    // Check everything before writing anything, so a bad field leaves the project as it was.
    if (body.structure !== undefined) {
      const err = validateStructure(body.structure);
      if (err) return bad(reply, err);
    }
    if (body.session_idle_minutes !== undefined && body.session_idle_minutes !== null && !(Number.isInteger(body.session_idle_minutes) && body.session_idle_minutes >= 5 && body.session_idle_minutes <= 720)) {
      return bad(reply, 'A session ends after a whole number of minutes from 5 to 720, or empty for the default.');
    }
    if (body.autonomy !== undefined && !AUTONOMY.includes(body.autonomy)) return bad(reply, `Autonomy must be one of ${AUTONOMY.join(', ')}.`);
    if (body.permission_answerer !== undefined && !ANSWERERS.includes(body.permission_answerer)) return bad(reply, `Who answers permission requests must be one of ${ANSWERERS.join(', ')}.`);
    if (body.triage_minutes !== undefined && body.triage_minutes !== null && !(Number.isInteger(body.triage_minutes) && body.triage_minutes >= 1 && body.triage_minutes <= 240)) {
      return bad(reply, 'The director has 1 to 240 minutes to decide, or empty for the default.');
    }
    if (body.cold_days !== undefined && body.cold_days !== null && !(Number.isInteger(body.cold_days) && body.cold_days >= 1 && body.cold_days <= 365)) {
      return bad(reply, 'Cold after must be a whole number of days from 1 to 365, or empty for the default.');
    }
    tx(() => {
      if (body.structure !== undefined) run('UPDATE projects SET structure = ? WHERE id = ?', JSON.stringify(stampUserEdit(projectStructure(project), body.structure, now())), id);
      if (body.cold_days !== undefined) run('UPDATE projects SET cold_days = ? WHERE id = ?', body.cold_days, id);
      if (body.session_idle_minutes !== undefined) run('UPDATE projects SET session_idle_minutes = ? WHERE id = ?', body.session_idle_minutes, id);
      if (body.permission_answerer !== undefined) run('UPDATE projects SET permission_answerer = ? WHERE id = ?', body.permission_answerer, id);
      if (body.triage_minutes !== undefined) run('UPDATE projects SET triage_minutes = ? WHERE id = ?', body.triage_minutes, id);
      for (const key of ['name', 'description', 'phase', 'autonomy'] as const) {
        if (typeof body[key] === 'string' && body[key].trim()) run(`UPDATE projects SET ${key} = ? WHERE id = ?`, body[key].trim(), id);
      }
    });
    if (typeof body.archived === 'boolean') {
      run('UPDATE projects SET archived = ? WHERE id = ?', body.archived ? 1 : 0, id);
      if (body.archived) {
        for (const a of all("SELECT id FROM agents WHERE project_id = ? AND status IN ('working','waiting')", id)) await interruptAgent(a.id);
        const held = all('SELECT DISTINCT host_id FROM host_claims WHERE project_id = ?', id).map((r) => r.host_id);
        run('DELETE FROM host_claims WHERE project_id = ?', id);
        hostsChanged(held);
      }
    }
    touchProject(id);
    return { ok: true };
  });

  /** Permission requests decided on the user's behalf (server/triage.ts), newest first. */
  app.get('/api/projects/:id/decisions', async (req, reply) => {
    const id = (req.params as any).id as string;
    return getProject(id) ? { decisions: decisionsFor(id), rules: rulesFor(id), defaultMinutes: DEFAULT_TRIAGE_MINUTES } : bad(reply, 'No such project', 404);
  });

  /** The user revokes an always-allow rule the director made: it stops matching at the agent's next request. */
  app.post('/api/projects/:id/rules/:rule/revoke', async (req, reply) => {
    const { id, rule } = req.params as any;
    const err = revokeRule(id, rule);
    return err ? bad(reply, err) : { ok: true };
  });

  // ---------- sessions (server/sessions.ts) ----------

  /** Sessions and away periods, newest first, with summaries and headline counts; before= pages back. */
  app.get('/api/projects/:id/sessions', async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!getProject(id)) return bad(reply, 'No such project', 404);
    const q = req.query as { before?: string; limit?: string };
    return { periods: listPeriods(id, { before: q.before ? Number(q.before) : undefined, limit: q.limit ? Number(q.limit) : undefined }), presence: presenceView(id) };
  });

  /** One session or away period with everything attributed to it. */
  app.get('/api/projects/:id/sessions/:period', async (req, reply) => {
    const { id, period } = req.params as any;
    const p = getPeriod(id, period);
    return p ?? bad(reply, 'No such session or away period', 404);
  });

  /** "I'm stepping away": the open session ends now and the director carries on alone. */
  app.post('/api/projects/:id/away', async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!getProject(id)) return bad(reply, 'No such project', 404);
    stepAway(id);
    return { ok: true, presence: presenceView(id) };
  });

  /** Read-only: per role, the instructions Helm generates and the helm tools it gets. */
  app.get('/api/projects/:id/team', async (req, reply) => {
    const project = getProject((req.params as any).id);
    return project ? teamDetails(project) : bad(reply, 'No such project', 404);
  });

  /** Removes the project from Helm. The folder on disk is left alone. */
  app.delete('/api/projects/:id', async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!getProject(id)) return bad(reply, 'No such project', 404);
    for (const a of all('SELECT id FROM agents WHERE project_id = ?', id)) await closeAgent(a.id, 'closed');
    for (const p of all('SELECT * FROM previews WHERE project_id = ?', id)) deletePreviewFiles(p);
    run('DELETE FROM projects WHERE id = ?', id);
    deleteProjectAttachments(id);
    bus.publish({ type: 'projects' });
    bus.publish({ type: 'hosts' });
    return { ok: true };
  });

  /** Message the project's top-level agent. */
  /** The user's order of the project list: ids top to bottom. Projects left out keep their place. */
  app.post('/api/projects/order', async (req, reply) => {
    const ids = (req.body as { ids?: unknown })?.ids;
    if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) return bad(reply, 'Send ids: the projects in their new order.');
    tx(() => ids.forEach((id, i) => run('UPDATE projects SET position = ? WHERE id = ?', i + 1, id)));
    bus.publish({ type: 'projects' });
    return { ok: true };
  });

  app.post('/api/projects/:id/message', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const text = String((req.body as any)?.text ?? '').trim();
    const files = pendingAttachments(project.id, (req.body as any)?.attachments);
    if ('error' in files) return bad(reply, files.error);
    if (!text && !files.rows.length) return bad(reply, 'Empty message');
    const root = rootAgent(project);
    // From the chat (web/src/chat.tsx): what the user was looking at, for the director to read with it.
    await sendToAgent(root.id, text, { kind: 'user', name: 'You' }, files.rows, true, contextBlock(project.id, (req.body as any)?.context));
    return { agentId: root.id };
  });

  /** The handoff card on the Overview: send HANDOFF.md to the director, or dismiss it. Either way it is not offered again until the file changes. */
  app.post('/api/projects/:id/handoff', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const action = String((req.body as any)?.action ?? '');
    if (action !== 'send' && action !== 'dismiss') return bad(reply, 'Action must be send or dismiss.');
    const { file } = handoffState(project);
    if (!file) return bad(reply, 'This project has no handoff file.');
    markHandoffSeen(project.id, file.mtime);
    if (action === 'send') await sendToAgent(rootAgent(project).id, HANDOFF_MESSAGE, { kind: 'user', name: 'You' });
    touchProject(project.id);
    return { ok: true };
  });

  // ---------- agents ----------

  app.get('/api/agents/:id', async (req, reply) => {
    const agent = getAgent((req.params as any).id);
    return agent ? { agent: agentView(agent) } : bad(reply, 'No such agent', 404);
  });

  app.get('/api/agents/:id/events', async (req, reply) => {
    const agent = getAgent((req.params as any).id);
    if (!agent) return bad(reply, 'No such agent', 404);
    const q = req.query as { before?: string; limit?: string; view?: string };
    const list = q.view === 'conversation' ? listDialogue : listEvents;
    return { events: list(agent.id, q.before ? Number(q.before) : null, Math.min(Number(q.limit ?? 200), 500)) };
  });

  app.post('/api/agents/:id/message', async (req, reply) => {
    const agent = getAgent((req.params as any).id);
    if (!agent) return bad(reply, 'No such agent', 404);
    const text = String((req.body as any)?.text ?? '').trim();
    const files = pendingAttachments(agent.project_id, (req.body as any)?.attachments);
    if ('error' in files) return bad(reply, files.error);
    if (!text && !files.rows.length) return bad(reply, 'Empty message');
    await sendToAgent(agent.id, text, { kind: 'user', name: 'You' }, files.rows);
    return { ok: true };
  });

  app.post('/api/agents/:id/stop', async (req, reply) => {
    const agent = getAgent((req.params as any).id);
    if (!agent) return bad(reply, 'No such agent', 404);
    await interruptAgent(agent.id);
    return { ok: true };
  });

  app.post('/api/agents/:id/resume', async (req, reply) => {
    const agent = getAgent((req.params as any).id);
    if (!agent) return bad(reply, 'No such agent', 404);
    await sendToAgent(agent.id, '<helm-note>Your previous turn was cut short. Pick up where you left off: check your worklist and the state of the files first.</helm-note>', { kind: 'system', name: 'Helm' });
    return { ok: true };
  });

  app.post('/api/agents/:id/close', async (req, reply) => {
    const agent = getAgent((req.params as any).id);
    if (!agent) return bad(reply, 'No such agent', 404);
    await closeAgent(agent.id, 'closed');
    return { ok: true };
  });

  // ---------- hosts ----------

  app.get('/api/hosts', async () => ({
    hosts: allHostViews(),
    projects: all('SELECT id, name FROM projects WHERE archived = 0 ORDER BY position, created_at'),
  }));

  /** Add a host; with projectId it is attached to that project at once. */
  app.post('/api/hosts', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, any>;
    const res = hostFields(b);
    if ('error' in res) return bad(reply, res.error);
    if (b.projectId && !getProject(b.projectId)) return bad(reply, 'No such project', 404);
    const host = createHost(res.fields);
    if (b.projectId) attachHost(b.projectId, host.id);
    else hostsChanged([host.id]);
    void checkHost(host.id, true);
    return { id: host.id };
  });

  app.patch('/api/hosts/:id', async (req, reply) => {
    const host = getHost((req.params as any).id);
    if (!host) return bad(reply, 'No such host', 404);
    const res = hostFields((req.body ?? {}) as Record<string, any>, host);
    if ('error' in res) return bad(reply, res.error);
    updateHost(host, res.fields);
    hostsChanged([host.id]);
    if ('ssh_target' in res.fields || 'port' in res.fields) void checkHost(host.id, true);
    return { ok: true };
  });

  /** Refused for a host that is attached or claimed unless the request says confirm. */
  app.delete('/api/hosts/:id', async (req, reply) => {
    const host = getHost((req.params as any).id);
    if (!host) return bad(reply, 'No such host', 404);
    if (host.is_local) return bad(reply, 'This machine is always available to every project and cannot be removed.');
    const confirm = String((req.query as any)?.confirm ?? '') === '1';
    const projects = Number(get('SELECT COUNT(*) AS n FROM project_hosts WHERE host_id = ?', host.id)?.n ?? 0);
    const claims = Number(get('SELECT COUNT(*) AS n FROM host_claims WHERE host_id = ?', host.id)?.n ?? 0);
    if ((projects || claims) && !confirm) {
      const parts = [projects && `attached to ${projects} ${projects === 1 ? 'project' : 'projects'}`, claims && `claimed by ${claims} ${claims === 1 ? 'agent' : 'agents'}`].filter(Boolean);
      return reply.code(409).send({ error: `${host.name} is ${parts.join(' and ')}. Confirm to remove it anyway.`, needsConfirm: true });
    }
    deleteHost(host);
    return { ok: true };
  });

  app.post('/api/hosts/:id/check', async (req, reply) => {
    const host = getHost((req.params as any).id);
    if (!host) return bad(reply, 'No such host', 404);
    await checkHost(host.id, true);
    return { ok: true };
  });

  app.post('/api/projects/:id/hosts', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const host = getHost(String((req.body as any)?.hostId ?? ''));
    if (!host) return bad(reply, 'No such host', 404);
    if (!host.is_local) attachHost(project.id, host.id);
    return { ok: true };
  });

  /** Detaching drops this project's claims on the host. */
  app.delete('/api/projects/:id/hosts/:hostId', async (req, reply) => {
    const { id, hostId } = req.params as any;
    if (!getProject(id)) return bad(reply, 'No such project', 404);
    const host = getHost(hostId);
    if (!host) return bad(reply, 'No such host', 404);
    if (host.is_local) return bad(reply, 'This machine is always available to every project.');
    detachHost(id, host.id);
    return { ok: true };
  });

  // ---------- requests to the user (answered on their task or discussion) ----------

  // Where a request is shown: what a notification's stable route (#/p/<project>/request/<id>) resolves through, so it
  // keeps working whatever page shows requests. Only ids, never the request's text.
  app.get('/api/requests/:id/where', async (req, reply) => {
    const r = get('SELECT id, project_id, task_id FROM inbox WHERE id = ?', (req.params as any).id);
    if (!r) return bad(reply, 'No such request', 404);
    const home = r.task_id ? get('SELECT id, kind FROM tasks WHERE id = ?', r.task_id) : undefined;
    return { id: r.id, project_id: r.project_id, task_id: home?.id ?? null, home_kind: home ? (home.kind === 'discussion' ? 'discussion' : 'task') : null };
  });

  // One action whether answered from a list row or from the thread; /api/inbox/... is the old path, kept.
  for (const path of ['/api/requests/:id/answer', '/api/inbox/:id/answer']) {
    app.post(path, async (req, reply) => {
      const err = await answerInbox((req.params as any).id, (req.body ?? {}) as any);
      return err ? bad(reply, err, err.startsWith('No such') ? 404 : err.startsWith('Already') ? 409 : 400) : { ok: true };
    });
  }

  // ---------- docs ----------

  // Creating and editing entries, revisions and sections: see specapi.ts.

  /** The user's Begin and Stop buttons: change the status and tell the director to act on it. */
  for (const action of ['begin', 'stop'] as const) {
    app.post(`/api/docs/:id/${action}`, async (req, reply) => {
      const doc = get('SELECT * FROM docs WHERE id = ?', (req.params as any).id);
      if (!doc) return bad(reply, 'No such document', 404);
      if (!STEERABLE.includes(doc.kind)) return bad(reply, 'Only Spec entries can be begun or stopped.');
      const allowed = action === 'begin' ? ['proposed', 'paused'] : ['active'];
      if (!allowed.includes(doc.status)) return bad(reply, `This entry is ${doc.status}; ${action === 'begin' ? 'Begin' : 'Stop'} applies to ${allowed.join(' or ')} ones.`);
      const what = `the Spec entry "${doc.title}" (id ${doc.id})`;
      // The work itself is tracked as tasks linked to the goal: Begin lines one up or resumes them, Stop pauses the
      // active ones and takes the scheduled ones out of the queue (paused, remembering they were scheduled).
      const open = all(`SELECT * FROM tasks WHERE doc_id = ? AND state IN ('planning','waiting','scheduled','active','paused') ORDER BY position`, doc.id);
      const list = (ts: Row[]) => ts.map(taskRef).join(', ');
      let note: string | null;
      if (action === 'stop') {
        const active = open.filter((t) => t.state === 'active');
        const queued = open.filter((t) => t.state === 'scheduled');
        tx(() => {
          run('UPDATE docs SET status = ?, updated_at = ? WHERE id = ?', 'paused', now(), doc.id);
          for (const t of [...active, ...queued]) setTaskState(t, 'paused', USER, `you pressed Stop on the entry`);
        });
        // Nothing was running or lined up for it, so there is nothing for the director to wind down.
        note = active.length || queued.length
          ? `The user pressed Stop on ${what}. It is now paused` +
            (active.length ? `, and so ${active.length === 1 ? 'is' : 'are'} ${list(active)}` : '') +
            (queued.length ? `${active.length ? '; ' : ', and '}${list(queued)} ${queued.length === 1 ? 'was' : 'were'} taken out of the scheduled queue (now Paused; Begin puts ${queued.length === 1 ? 'it' : 'them'} back)` : '') +
            `. Wind down work on it: stop or redirect the agents working on it, do not take its tasks up, and leave it paused until they resume it.`
          : null;
      } else {
        const paused = open.filter((t) => t.state === 'paused');
        const verb = doc.status === 'paused' ? 'Resume' : 'Begin';
        if (paused.length) {
          // Tasks Stop took out of the queue go back into it; the rest were running and resume.
          const requeued = paused.filter((t) => t.paused_from === 'scheduled');
          const resumed = paused.filter((t) => t.paused_from !== 'scheduled');
          tx(() => {
            run('UPDATE docs SET status = ?, updated_at = ? WHERE id = ?', 'active', now(), doc.id);
            for (const t of paused) setTaskState(t, t.paused_from === 'scheduled' ? 'scheduled' : 'active', USER, `you pressed ${verb} on the entry`);
          });
          note =
            `The user pressed ${verb} on ${what}. It is now active` +
            (resumed.length ? `, and ${list(resumed)} ${resumed.length === 1 ? 'is' : 'are'} active again` : '') +
            (requeued.length ? `${resumed.length ? '; ' : ', and '}${list(requeued)} ${requeued.length === 1 ? 'is' : 'are'} back in the scheduled queue` : '') +
            `. Pick that work back up${requeued.length ? ' (scheduled tasks in queue order)' : ''}, or say in the task's thread what is missing.`;
        } else if (open.length) {
          run('UPDATE docs SET status = ?, updated_at = ? WHERE id = ?', 'active', now(), doc.id);
          note = `The user pressed ${verb} on ${what}. It is now active. It already has ${list(open)}; take them up in queue order, or say in the task's thread what is missing.`;
        } else {
          const task = tx(() => {
            run('UPDATE docs SET status = ?, updated_at = ? WHERE id = ?', 'active', now(), doc.id);
            return createTask(doc.project_id, { title: doc.title, description: `Lined up when you pressed ${verb} on the entry "${doc.title}".`, state: 'scheduled', doc_id: doc.id, origin: 'doc' }, USER);
          });
          note = `The user pressed ${verb} on ${what}. It is now active, and Helm lined up ${taskRef(task)} for it as Scheduled. Take it up in queue order: rewrite the task's description into a concrete plan, keep its state and driver true, or say in its thread (task_post) what is missing before you can.`;
        }
      }
      touchProject(doc.project_id);
      if (note) await tellDirector(doc.project_id, note);
      return { ok: true };
    });
  }

  app.delete('/api/docs/:id', async (req, reply) => {
    const doc = get('SELECT * FROM docs WHERE id = ?', (req.params as any).id);
    if (!doc) return bad(reply, 'No such document', 404);
    // Its tasks stay, unlinked: a task's doc_id never points at a document that is gone.
    const open = all(`SELECT * FROM tasks WHERE doc_id = ? AND state IN ('planning','waiting','scheduled','active','paused') ORDER BY position`, doc.id);
    tx(() => {
      run('UPDATE tasks SET doc_id = NULL, updated_at = ? WHERE doc_id = ?', now(), doc.id);
      run('DELETE FROM docs WHERE id = ?', doc.id);
      afterDocDeleted(doc, { author: 'user', name: 'You' });
    });
    touchProject(doc.project_id);
    const tasks = open.length
      ? ` Its open tasks stay, no longer linked to it: ${open.map((t) => `${taskRef(t)}, ${STATE_LABEL[t.state]}`).join('; ')}. Drop the ones that only served it (update_task) and carry on with the rest, or ask the user with ask_user on those tasks.`
      : '';
    if (doc.status === 'active' && STEERABLE.includes(doc.kind)) {
      await tellDirector(
        doc.project_id,
        `The user removed the Spec entry "${doc.title}" (id ${doc.id}), which was active. Stop work on it: stop or redirect the agents working on it.${tasks}`,
      );
    } else if (open.length) {
      await tellDirector(doc.project_id, `The user removed the Spec entry "${doc.title}" (id ${doc.id}).${tasks}`);
    }
    return { ok: true };
  });

  // ---------- previews & journal ----------

  app.delete('/api/previews/:id', async (req, reply) => {
    const p = get('SELECT * FROM previews WHERE id = ?', (req.params as any).id);
    if (!p) return bad(reply, 'No such preview', 404);
    deletePreviewFiles(p);
    run('DELETE FROM previews WHERE id = ?', p.id);
    touchProject(p.project_id);
    return { ok: true };
  });

  app.post('/api/projects/:id/journal', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const b = (req.body ?? {}) as Record<string, any>;
    if (!String(b.title ?? '').trim()) return bad(reply, 'Give it a title.');
    addJournal(project.id, null, b.kind ?? 'note', String(b.title).trim(), String(b.body ?? ''));
    return { ok: true };
  });

  // Used by the seed script and handy for testing the gallery without an agent.
  app.post('/api/projects/:id/previews', async (req, reply) => {
    const project = getProject((req.params as any).id);
    if (!project) return bad(reply, 'No such project', 404);
    const res = addPreview(project, null, (req.body ?? {}) as any);
    return 'error' in res ? bad(reply, res.error) : res;
  });

  // Tasks and the Spec: registered last so the sign-in hook above covers them.
  registerTaskApi(app);
  registerToolboxApi(app);
  registerReportApi(app);
  registerSpecApi(app);
  registerAttachmentApi(app);
  registerAnnotationApi(app);
}
