import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, Options, PermissionMode, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.ts';
import { dropConsults, hasOpenBlockingConsult } from './consults.ts';
import { all, get, newId, now, run, tx } from './db.ts';
import { hostsPromptSection, releaseAgentClaims, releaseStaleClaims } from './hosts.ts';
import type { Row } from './db.ts';
import { FINISHED, addEvent, addJournal, getAgent, getProject, projectStructure, touchProject } from './store.ts';
import { reportFilesDir } from './reports.ts';
import { attachmentView, attachmentsBlock, attachmentsDir, bindAttachments, pendingAttachments } from './attachments.ts';
import { buildSystemPrompt, isManager, quickRoleOf, spawnableIds } from './structure.ts';
import { unfiledAskNote } from './askcheck.ts';
import type { Role } from './structure.ts';
import { ACTION_CHOICES, createRequest, needsAnswered } from './requests.ts';
import { dangerOf, directorStopped, dispatch, matchingRule, noteCwd, recordAuto, routeFor, ruleText, rulesFromSuggestions, setTriageHooks, settle, takeNotices, waitFor } from './triage.ts';
import { noteRequestAnswered } from './pins.ts';
import { resolveStructureProposal } from './team.ts';
import { loadStates, sessionToolbox } from './toolbox.ts';
import type { Expected, LoadState } from './toolbox.ts';
import { makeHelmServer } from './tools.ts';
import { presenceTag } from './sessions.ts';
import { afterDirectorTurn, onAgentFinished, onAgentResumed } from './taskwatch.ts';
import { notifyAgentFailed, safe } from './notify.ts';
import { classifyTrigger, routeTurn } from './turns.ts';
import type { RuntimeApi } from './tools.ts';
import { refusal } from './disk.ts';
import { cleanArtifacts } from './diskusage.ts';
import type { Viewing } from './chatcontext.ts';

// ---------- small async queue feeding a session's input stream ----------

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;
  push(value: T) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value, done: false });
    else this.items.push(value);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters) w({ value: undefined as never, done: true });
    this.waiters = [];
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

// ---------- live sessions ----------

/** One running Claude Code process for one agent. */
export type Live = {
  agentId: string;
  q: Query;
  queue: AsyncQueue<string>;
  done: Promise<void>;
  closing: boolean;
  idleTimer: NodeJS.Timeout | null;
  /** Set by complete_task; applied when the turn ends. */
  completeRequested: boolean;
  /** Status to leave the agent in if we close the process on purpose. */
  closeStatus: string | null;
  /** The user stopped the current turn. */
  interrupted: boolean;
  /** Toolbox items handed to this process, and those skipped before it started. */
  toolbox: { expected: Expected[]; skipped: LoadState[] };
  /** The Toolbox changed under this busy process: close it when the turn ends so the next message starts clean. */
  restartAfterTurn: boolean;
  /** A manager (the root or a role that can spawn): its turns are checked for asks made only in prose (askcheck.ts). */
  manager: boolean;
};

const live = new Map<string, Live>();


const AUTONOMY: Record<string, PermissionMode> = {
  supervised: 'default',
  edits: 'acceptEdits',
  auto: 'auto',
  full: 'bypassPermissions',
};

/**
 * Built-in tools that have no surface in Helm. Questions and task lists go
 * through the helm tools so the user can see and answer them.
 */
const HIDDEN_TOOLS = ['AskUserQuestion', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'EnterPlanMode', 'ExitPlanMode'];

/** Statuses that end an agent's hold on the hosts it claimed: closed, stopped, task complete, error. */
const RELEASES_HOSTS = ['closed', 'done', 'interrupted', 'error'];
/**
 * What a session gets besides the helm tools, as Setup describes it. Keep in step with
 * the options in startLive: mcpServers + strictMcpConfig, disallowedTools, and
 * settingSources (the project's own settings, not the personal ~/.claude). Toolbox items come on top.
 */
export const SESSION_EXTRAS = {
  mcpServers: ['helm'],
  hiddenBuiltins: HIDDEN_TOOLS,
  settingSources: ['project', 'local'],
};

function setAgent(agentId: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  run(`UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k]), now(), agentId);
  if (typeof fields.status === 'string') {
    if (FINISHED.includes(fields.status)) run('UPDATE agents SET finished_at = COALESCE(finished_at, ?) WHERE id = ?', now(), agentId);
    else run('UPDATE agents SET finished_at = NULL WHERE id = ?', agentId);
  }
  if (RELEASES_HOSTS.includes(fields.status as string)) releaseAgentClaims(agentId);
  const a = getAgent(agentId);
  // A stopped director cannot decide: what waits on it goes to the user.
  if (a && !a.parent_id && ['interrupted', 'closed', 'error'].includes(fields.status as string)) directorStopped(a, `${a.name} was stopped before deciding.`);
  if (a) touchProject(a.project_id);
  if (a && fields.status === 'error') safe(() => notifyAgentFailed(a));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);

function hasOpenBlocking(agentId: string): boolean {
  return !!get("SELECT 1 AS x FROM inbox WHERE agent_id = ? AND status = 'open' AND blocking = 1 LIMIT 1", agentId);
}

function roleFor(agent: Row): { project: Row; role: Role } {
  const project = getProject(agent.project_id)!;
  const structure = projectStructure(project);
  const role: Role = structure.roles.find((r) => r.id === agent.role_id) ?? {
    // The role was removed from the structure after this agent was created.
    id: agent.role_id, name: agent.role_id, model: agent.model, effort: '', description: '', prompt: '', canSpawn: [],
  };
  return { project, role };
}

/**
 * The SDK's permission callback for one agent: the danger check, the director's always-allow rules, then a request
 * routed to the user, the director or the independent check (triage.ts), and the wait for its answer.
 */
export async function askPermission(agent: Row, project: Row, toolName: string, toolInput: Record<string, unknown>, opts: Parameters<CanUseTool>[2]): ReturnType<CanUseTool> {
  if (toolName.startsWith('mcp__helm__')) return { behavior: 'allow', updatedInput: toolInput };
  const canAlways = !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule;
  const self = getAgent(agent.id) ?? agent;
  const current = getProject(agent.project_id) ?? project;
  const title = opts.title ?? `${agent.name} wants to use ${opts.displayName ?? toolName}`;
  // The danger check (danger.ts): what it flags always goes to the user, whatever the autonomy level.
  const danger = dangerOf(current, self, toolName, toolInput);
  // Unrestricted: Claude Code still asks about commands it cannot analyse (heredocs, inline scripts). Not flagged: allow.
  if (current.autonomy === 'full' && !danger.dangerous) {
    recordAuto({ projectId: agent.project_id, agent: self, title, payload: { toolName, input: clip(JSON.stringify(toolInput, null, 2), 6000), summary: summarizeTool(toolName, toolInput, 400) } });
    return { behavior: 'allow', updatedInput: toolInput };
  }
  // Director first: an always-allow rule the director made for this agent, which the user has not revoked.
  if (!danger.dangerous && current.permission_answerer === 'director') {
    const rule = matchingRule(self, toolName, toolInput, current.path);
    if (rule) {
      addEvent(self, 'note', { text: `Allowed by an always-allow rule the director made (${ruleText(rule)}): ${summarizeTool(toolName, toolInput, 200)}` });
      return { behavior: 'allow', updatedInput: toolInput };
    }
  }
  // Who answers: the user, the director, or for the director's own the independent check (triage.ts).
  const route = routeFor(current, self, danger.dangerous);
  const stated = typeof toolInput.description === 'string' ? toolInput.description : '';
  // It lands on the agent's task, or its standing "Requests from" discussion (requests.ts).
  const { id } = createRequest({
    status: route.status,
    projectId: agent.project_id,
    agentId: agent.id,
    kind: 'permission',
    title,
    body: opts.description ?? opts.decisionReason ?? '',
    payload: {
      toolName,
      input: clip(JSON.stringify(toolInput, null, 2), 6000),
      summary: summarizeTool(toolName, toolInput, 400),
      blockedPath: opts.blockedPath ?? '',
      canAlways,
      rules: rulesFromSuggestions(opts.suggestions),
      ...(danger.dangerous ? { danger: danger.reason, dangerReasons: danger.reasons } : {}),
      ...(route.status !== 'open' ? { triage: { route: route.status } } : {}),
    },
    importance: 4,
    blocking: true,
  });
  setAgent(agent.id, { status: 'waiting' });
  const decided = waitFor(id, opts.signal);
  dispatch({ id }, route, { project: current, agent: self, toolName, input: toolInput, stated, dangerReason: danger.reason });
  const decision = await decided;
  if (decision.aborted) {
    run("UPDATE inbox SET status = 'dismissed', answer = 'No longer needed', answered_at = ? WHERE id = ? AND status IN ('open', 'director', 'check')", now(), id);
    touchProject(agent.project_id);
  }
  if (getAgent(agent.id)?.status === 'waiting') setAgent(agent.id, { status: 'working' });
  else touchProject(agent.project_id);
  if (decision.allow) {
    return { behavior: 'allow', updatedInput: toolInput, updatedPermissions: decision.always ? opts.suggestions : undefined };
  }
  return { behavior: 'deny', message: decision.message || 'The user denied this request.' };
}

function startLive(agent: Row): Live {
  const { project, role } = roleFor(agent);
  // A new process starts in the project folder, whatever the last one had cd'd to.
  noteCwd(agent.id, project.path);
  const structure = projectStructure(project);
  const parent = agent.parent_id ? getAgent(agent.parent_id) : undefined;
  const queue = new AsyncQueue<string>();

  async function* input(): AsyncGenerator<SDKUserMessage> {
    for await (const text of queue) {
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    }
  }

  const mode = AUTONOMY[project.autonomy] ?? 'auto';

  const canUseTool: CanUseTool = (toolName, toolInput, opts) => askPermission(agent, project, toolName, toolInput, opts);

  const toolbox = sessionToolbox(project.id);
  const external = Object.keys(toolbox.mcpServers).length > 0;

  const options: Options = {
    cwd: project.path,
    // Screenshots and files attached to this project's reports, which get_report points agents at.
    // And the files the user attached to Spec entries, tasks and messages (server/attachments.ts).
    additionalDirectories: [reportFilesDir(project.id), attachmentsDir(project.id)],
    model: role.model,
    effort: role.effort || undefined,
    resume: agent.session_id || undefined,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemPrompt(project, structure, role, agent, parent, hostsPromptSection(project.id)) },
    // Helm's own tools plus the Toolbox MCP servers enabled for this project.
    // Toolbox tools are not pre-allowed: they go through the normal permission flow.
    mcpServers: { ...toolbox.mcpServers, helm: makeHelmServer(agent.id, runtimeApi) },
    // Only these servers: an unattended agent should not inherit the user's
    // personal connectors (mail, drive, ...) from their Claude login.
    strictMcpConfig: true,
    // Secrets in toolbox server headers and env go over stdin, not the command line.
    mcpServersDelivery: external ? 'initialize' : undefined,
    // The project's own .claude/ and CLAUDE.md, but not the personal ~/.claude
    // (skills, plugins, hooks, permission rules, CLAUDE.md). Approved items come from the Toolbox.
    settingSources: ['project', 'local'],
    plugins: toolbox.plugins,
    allowedTools: ['mcp__helm'],
    disallowedTools: HIDDEN_TOOLS,
    permissionMode: mode,
    allowDangerouslySkipPermissions: mode === 'bypassPermissions' ? true : undefined,
    canUseTool,
    // The Bash tool's working folder moves with cd. Every hook input carries the session's current one, so before each
    // tool call (and so before its permission request) the danger check learns where relative paths resolve from.
    // (CwdChanged would be the natural event, but the CLI does not deliver it to SDK hooks.)
    hooks: {
      PreToolUse: [{ hooks: [async (input) => {
        if (input.cwd) noteCwd(agent.id, input.cwd);
        return {};
      }] }],
    },
    pathToClaudeCodeExecutable: config.claudePath,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'helm/0.1' },
    stderr: (data) => {
      if (process.env.HELM_DEBUG) process.stderr.write(`[${agent.name}] ${data}`);
    },
  };

  const l: Live = {
    agentId: agent.id,
    q: query({ prompt: input(), options }),
    queue,
    done: Promise.resolve(),
    closing: false,
    idleTimer: null,
    completeRequested: false,
    closeStatus: null,
    interrupted: false,
    toolbox: { expected: toolbox.expected, skipped: toolbox.skipped },
    restartAfterTurn: false,
    manager: isManager(structure, role),
  };
  live.set(agent.id, l);
  l.done = pump(l);
  return l;
}

async function pump(l: Live) {
  try {
    for await (const msg of l.q) handleMessage(l, msg);
  } catch (err: any) {
    const a = getAgent(l.agentId);
    if (a && !l.closing) {
      addEvent(a, 'error', { message: String(err?.message ?? err) });
      setAgent(l.agentId, { status: 'error', status_line: clip(String(err?.message ?? err), 150) });
    }
  } finally {
    if (l.idleTimer) clearTimeout(l.idleTimer);
    if (live.get(l.agentId) === l) live.delete(l.agentId);
    const a = getAgent(l.agentId);
    if (a) {
      if (l.closeStatus) setAgent(l.agentId, { status: l.closeStatus });
      // The process ended while a turn was still running.
      else if (a.status === 'working' || a.status === 'waiting') setAgent(l.agentId, { status: 'interrupted' });
    }
  }
}

function summarizeTool(name: string, input: any, max = 160): string {
  if (!input || typeof input !== 'object') return '';
  const first = (...keys: string[]) => keys.map((k) => input[k]).find((v) => typeof v === 'string' && v);
  const s = first('command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'title', 'status', 'name', 'skill');
  return s ? clip(String(s).replace(/\s+/g, ' '), max) : '';
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c: any) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : '')).join('\n');
}

/** Exported for the tool-handler harness, which feeds it stand-in SDK messages. */
export function handleMessage(l: Live, msg: SDKMessage) {
  const agent = getAgent(l.agentId);
  if (!agent) return;

  if (msg.type === 'system' && msg.subtype === 'init') {
    if (msg.session_id && msg.session_id !== agent.session_id) setAgent(agent.id, { session_id: msg.session_id });
    recordToolbox(l, msg);
    return;
  }

  if (msg.type === 'assistant') {
    const sub = !!msg.parent_tool_use_id;
    for (const block of msg.message.content as any[]) {
      if (block.type === 'text' && block.text.trim()) addEvent(agent, 'text', { text: block.text, sub });
      else if (block.type === 'tool_use') {
        addEvent(agent, 'tool', {
          id: block.id,
          name: block.name,
          summary: summarizeTool(block.name, block.input),
          input: clip(JSON.stringify(block.input, null, 2) ?? '', 4000),
          sub,
        });
      }
    }
    if (msg.error) addEvent(agent, 'error', { message: `API error: ${msg.error}` });
    return;
  }

  if (msg.type === 'user') {
    const content = msg.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content as any[]) {
      if (block.type !== 'tool_result') continue;
      addEvent(agent, 'tool_result', {
        id: block.tool_use_id,
        error: !!block.is_error,
        text: clip(blockText(block.content), 2500),
        sub: !!msg.parent_tool_use_id,
      });
    }
    return;
  }

  if (msg.type === 'result') {
    const ok = msg.subtype === 'success' && !msg.is_error;
    const text = msg.subtype === 'success' ? msg.result : `Turn ended early (${msg.subtype}). ${msg.errors.join('; ')}`;
    // A top-level agent's reply is either dialogue with the user or belongs elsewhere (see turns.ts).
    const route = agent.parent_id ? null : routeTurn(agent, Number.MAX_SAFE_INTEGER, ok ? (text ?? '') : '');
    const resultId = addEvent(agent, 'result', { ok, text, cost: msg.total_cost_usd, ms: msg.duration_ms, ...(route ? { dialogue: route.dialogue, routed: route.routed } : {}) });
    // Something the user must do, said only in prose: the manager is told to file it (askcheck.ts). Delivered as its next turn.
    const askNote = l.manager && ok ? unfiledAskNote(agent, resultId, { text: text ?? '', dialogue: !!route?.dialogue }) : null;
    // After this handler has settled the turn (status, idle timer), so the note starts a fresh one.
    if (askNote) setTimeout(() => void sendToAgent(agent.id, askNote, { kind: 'system', name: 'Helm' }).catch(() => {}), 0);
    const queued = msg.queued_turn_count ?? 0;
    const fields: Record<string, unknown> = {
      cost_usd: msg.total_cost_usd,
      turns: agent.turns + msg.num_turns,
      last_result: clip(text ?? '', 20000),
    };
    if (queued > 0) {
      setAgent(agent.id, fields);
      return;
    }
    // The turn is over and nothing else is queued.
    if (l.interrupted) fields.status = 'interrupted';
    else if (l.completeRequested && ok) fields.status = 'done';
    else if (hasOpenBlocking(agent.id)) fields.status = 'waiting';
    else fields.status = ok ? 'idle' : 'error';
    const stopped = l.interrupted;
    l.completeRequested = false;
    l.interrupted = false;
    setAgent(agent.id, fields);
    // Its task now waits for the director's review; and a director's turn that saw such a report must settle it (taskwatch.ts).
    if (fields.status === 'done') onAgentFinished(agent.id);
    if (!agent.parent_id) afterDirectorTurn(agent);

    // A turn that ends waiting on the manager's answer or review says nothing new to it: the question already went.
    const askedParent = fields.status === 'idle' && hasOpenBlockingConsult(agent.id);
    // A quick helper's job ends with its turn, unless the user stopped it or it waits on its caller or the user.
    const quickEnd = !!agent.quick && !stopped && !askedParent && fields.status !== 'waiting';
    if (agent.parent_id && !askedParent) {
      const parent = getAgent(agent.parent_id);
      if (parent && parent.status !== 'closed') {
        const state = quickEnd
          ? ok ? 'quick job finished; helper closed' : 'quick job failed; helper closed'
          : stopped ? 'stopped by the user' : fields.status === 'done' ? 'task complete' : fields.status === 'waiting' ? 'waiting on the user' : ok ? 'turn finished' : 'stopped with an error';
        const after = quickEnd ? '\n\n(Helm closed this quick helper. Check what it reports before relying on it: you remain responsible for the result.)' : '';
        void sendToAgent(
          parent.id,
          `<agent-report from="${agent.name}" id="${agent.id}" state="${state}"${quickEnd ? ' quick="true"' : ''}>\n${clip(text ?? '', 12000)}${after}\n</agent-report>`,
          { kind: 'agent', name: agent.name },
        ).catch(() => {});
      }
    }
    if (quickEnd) {
      void closeAgent(agent.id, ok ? 'done' : 'closed').catch(() => {});
      return;
    }
    scheduleIdleClose(l, l.restartAfterTurn ? 1 : fields.status === 'done' ? 5 : config.idleSeconds);
    return;
  }
}

/** Which toolbox items this process actually loaded; MCP servers are checked again once they had time to connect. */
function recordToolbox(l: Live, init: any) {
  const { expected, skipped } = l.toolbox;
  const save = (items: LoadState[]) => setAgent(l.agentId, { toolbox_loaded: JSON.stringify({ at: now(), items }) });
  const items = loadStates(expected, skipped, init);
  save(items);
  for (const s of skipped) {
    const a = getAgent(l.agentId);
    if (a) addEvent(a, 'note', { text: `Toolbox item "${s.name}" was not loaded: ${s.detail}` });
  }
  // Servers still connecting, or failed without a reason in the init message: ask again for status and error text.
  if (!items.some((i) => i.state === 'pending' || (i.kind.startsWith('mcp') && i.state === 'failed'))) return;
  setTimeout(() => {
    if (live.get(l.agentId) !== l || l.closing) return;
    l.q.mcpServerStatus().then((servers) => save(loadStates(expected, skipped, { ...init, mcp_servers: servers }))).catch(() => {});
  }, 15000);
}

function scheduleIdleClose(l: Live, seconds: number) {
  if (l.idleTimer) clearTimeout(l.idleTimer);
  l.idleTimer = setTimeout(() => shutdown(l, null), seconds * 1000);
}

/** End a live session's process. Its conversation is saved and resumes on the next message. */
function shutdown(l: Live, closeStatus: string | null) {
  if (l.closing) return;
  l.closing = true;
  l.closeStatus = closeStatus;
  if (l.idleTimer) clearTimeout(l.idleTimer);
  l.queue.close();
  // Closing stdin lets the process exit cleanly; force it if it lingers.
  const force = setTimeout(() => l.q.close(), closeStatus ? 500 : 8000);
  void l.done.finally(() => clearTimeout(force));
}

// ---------- operations used by the API and by agent tools ----------

type Sender = { kind: 'agent' | 'user' | 'system'; name: string };

/**
 * Deliver a message. `files` are pending uploads sent with it: they become the event's attachments, the transcript
 * shows them under the message (unless they belong to a thread message: bindToEvent false), and the agent gets their paths in an <attachments> block after the text.
 */
/** `viewing`: what the user was looking at (chatcontext.ts): the director reads its block; the event keeps the reference. */
export async function sendToAgent(agentId: string, text: string, from: Sender, files: Row[] = [], bindToEvent = true, viewing?: Viewing | null): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`No agent ${agentId}`);
  const eventId = addEvent(agent, 'inbound', { from, text, ...classifyTrigger(text, from), ...(files.length ? { attachments: files.map(attachmentView) } : {}), ...(viewing ? { viewing: viewing.ref } : {}) });
  // Notices about flagged permission requests wait for the director's next message of any kind (triage.ts).
  const notices = agent.parent_id ? '' : takeNotices(agent.project_id);
  if (notices) addEvent(agent, 'inbound', { from: { kind: 'system', name: 'Helm' }, text: notices.trim(), dialogue: false, about: null });
  if (files.length) {
    if (bindToEvent) bindAttachments(files, 'event', eventId);
    text = (text.trim() ? text : '(The user sent only attachments.)') + attachmentsBlock(files);
  }
  if (viewing) text += viewing.block;
  // The director always knows whether the user is here or away (sessions.ts); the tag is not kept in the transcript.
  if (!agent.parent_id) text = `${presenceTag(agent.project_id)}\n${text}`;
  // A finished agent sent back to work: its task is no longer awaiting review.
  else onAgentResumed(agentId);
  text += notices;
  setAgent(agentId, { status: 'working' });
  for (;;) {
    const l = live.get(agentId);
    if (!l) {
      startLive(getAgent(agentId)!).queue.push(text);
      return;
    }
    if (!l.closing) {
      if (l.idleTimer) clearTimeout(l.idleTimer);
      l.idleTimer = null;
      l.queue.push(text);
      return;
    }
    await l.done;
  }
}

function uniqueName(projectId: string, name: string): string {
  const taken = new Set(all('SELECT name FROM agents WHERE project_id = ?', projectId).map((r) => r.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
}

export function createAgent(project: Row, parent: Row | null, role: Role, name: string, task: string): Row {
  const id = newId('ag');
  run(
    'INSERT INTO agents (id, project_id, parent_id, role_id, name, model, task, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, project.id, parent?.id ?? null, role.id, uniqueName(project.id, name), role.model, task, 'idle', now(), now(),
  );
  touchProject(project.id);
  return getAgent(id)!;
}

/** The single top-level agent the user talks to; created on first use. */
export function rootAgent(project: Row): Row {
  const structure = projectStructure(project);
  const existing = get("SELECT * FROM agents WHERE project_id = ? AND parent_id IS NULL AND status != 'closed' ORDER BY created_at LIMIT 1", project.id);
  if (existing) return existing;
  const role = structure.roles.find((r) => r.id === structure.root)!;
  return createAgent(project, null, role, role.name, '');
}

/** `setup` runs on the new agent's row before its first session starts, so that session's system prompt sees what it sets. */
/**
 * `quick`: a quick helper started with quick_job. It needs no canSpawn (any agent may start one, see tools.ts),
 * only the project's quick helper role, and is marked so Helm closes it when its job ends.
 */
async function spawn(parent: Row, roleId: string, name: string, task: string, setup?: (agent: Row) => void, quick = false): Promise<Row | string> {
  const project = getProject(parent.project_id)!;
  const structure = projectStructure(project);
  const parentRole = structure.roles.find((r) => r.id === parent.role_id);
  const qr = quickRoleOf(structure);
  if (quick) {
    if (!qr || qr.id !== roleId) return 'This project has no quick helper role. Do the job yourself.';
  } else {
    // The top-level agent may always start the quick helper role, whether or not its canSpawn names it.
    const rootQuick = !parent.parent_id && parent.role_id === structure.root && qr?.id === roleId;
    if (!parentRole?.canSpawn.includes(roleId) && !rootQuick) {
      return `Your role cannot spawn "${roleId}". Available: ${spawnableIds(structure, parentRole, !parent.parent_id).join(', ') || 'none'}.`;
    }
  }
  // Disk guard (server/disk.ts): no new agents while the disk is nearly full.
  const noSpace = refusal(quick ? 'quick helpers' : 'new agents', project.name);
  if (noSpace) return noSpace;
  const role = structure.roles.find((r) => r.id === roleId)!;
  const active = all('SELECT status FROM agents WHERE project_id = ?', project.id).filter((a) => !FINISHED.includes(a.status)).length;
  if (active >= structure.maxAgents) {
    return quick
      ? `Not started: the project is at its limit of ${structure.maxAgents} unfinished agents, so no quick helper is available. Do the job yourself.`
      : `The project is at its limit of ${structure.maxAgents} active agents. Close one that is finished (close_agent), or reuse an idle one with message_agent.`;
  }
  const agent = tx(() => {
    const created = createAgent(project, parent, role, name, task);
    // Any holder of the quick helper role does one job and is closed when it ends, however it was started.
    if (quick || role.id === qr?.id) run('UPDATE agents SET quick = 1 WHERE id = ?', created.id);
    setup?.(created);
    return getAgent(created.id)!;
  });
  addJournal(project.id, parent.id, 'status', `${parent.name} started ${agent.name}`, clip(task, 600));
  await sendToAgent(agent.id, task, { kind: 'agent', name: parent.name });
  return agent;
}

export async function closeAgent(agentId: string, status: 'closed' | 'done'): Promise<void> {
  const l = live.get(agentId);
  if (l) {
    shutdown(l, status);
    await l.done;
  }
  setAgent(agentId, { status });
  onAgentFinished(agentId);
  dropConsults(agentId);
  run("UPDATE inbox SET status = 'dismissed', answer = 'Agent closed', answered_at = ? WHERE agent_id = ? AND status IN ('open', 'director', 'check')", now(), agentId);
  // What it registered and no longer needs: disposable scratch folders, and its worktrees once merged and clean
  // (server/diskusage.ts refuses anything holding work). In the background; removals are journaled.
  const closed = getAgent(agentId);
  if (closed) {
    void cleanArtifacts(closed.project_id, { agentId, kinds: ['scratch', 'worktree'], by: `Helm, when ${closed.name} finished` }).catch((err) => console.error('Cleanup after closing an agent failed:', err));
  }
  // Quick helpers work only for their caller: nobody would read their reports once it is closed.
  if (status === 'closed') {
    for (const h of all("SELECT id FROM agents WHERE parent_id = ? AND quick = 1 AND status NOT IN ('done', 'closed')", agentId)) await closeAgent(h.id, 'closed');
  }
}

/** Stop the agent's current turn without ending its session. */
export async function interruptAgent(agentId: string): Promise<void> {
  const agent = getAgent(agentId);
  const l = live.get(agentId);
  if (!agent) return;
  if (!l || l.closing) {
    if (['working', 'waiting'].includes(agent.status)) setAgent(agentId, { status: 'interrupted' });
    return;
  }
  addEvent(agent, 'note', { text: 'Stopped by the user.' });
  l.interrupted = true;
  await l.q.interrupt().catch(() => {});
  setAgent(agentId, { status: 'interrupted' });
}

setTriageHooks({ send: (agentId, text) => sendToAgent(agentId, text, { kind: 'system', name: 'Helm' }), root: (project) => rootAgent(project) });

export const runtimeApi: RuntimeApi = {
  spawn,
  send: sendToAgent,
  close: closeAgent,
  markComplete(agentId) {
    const l = live.get(agentId);
    if (l) l.completeRequested = true;
  },
};

/**
 * Answer a request. `attachments` (ids of pending uploads, for a question only) go with the answer: they become the
 * request's own (owner 'inbox'), show under the answer in its thread, and reach the agent in an <attachments> block
 * as files sent with a thread message do. An answer may be files only.
 */
export async function answerInbox(id: string, input: { choice?: string; text?: string; dismiss?: boolean; attachments?: unknown }): Promise<string | null> {
  const item = get('SELECT * FROM inbox WHERE id = ?', id);
  if (!item) return 'No such request.';
  if (item.kind === 'permission' ? !['open', 'director', 'check'].includes(item.status) : item.status !== 'open') {
    return `Already answered${item.decided_by && item.decided_by !== 'user' ? ` by ${item.decided_by === 'check' ? 'the independent check' : item.decided_by === 'auto' ? 'Helm automatically' : 'the director'}` : ''}.`;
  }
  const sent = input.dismiss ? { rows: [] } : pendingAttachments(item.project_id, input.attachments, id);
  if ('error' in sent) return sent.error;
  const files = sent.rows;
  if (files.length && item.kind !== 'question' && item.kind !== 'action') return 'Files can only be sent with the answer to a question or a to-do.';
  const filesNote = files.length ? `(sent ${files.length === 1 ? 'a file' : `${files.length} files`})` : '';
  const answer = [input.choice, input.text].filter(Boolean).join(' — ') || filesNote;

  if (item.kind === 'permission') {
    if (!input.dismiss && !['Allow', 'Always allow', 'Deny'].includes(input.choice ?? '')) return 'Choose Allow, Always allow or Deny.';
    if (input.choice === 'Always allow' && !JSON.parse(item.payload).canAlways) return 'This request cannot be allowed always; choose Allow or Deny.';
    const allow = !input.dismiss && (input.choice === 'Allow' || input.choice === 'Always allow');
    // First answer wins: the director or the independent check may have decided it a moment ago.
    return settle(id, { allow, always: input.choice === 'Always allow', message: input.text ?? '' }, { status: input.dismiss ? 'dismissed' : 'answered', answer: answer || 'Dismissed', by: input.dismiss ? null : 'user' });
  }

  if (item.kind === 'structure') {
    if (!input.dismiss && input.choice !== 'Approve' && input.choice !== 'Deny') return 'Choose Approve or Deny.';
    const decision = input.dismiss ? 'dismiss' : input.choice === 'Approve' ? 'approve' : 'deny';
    const res = resolveStructureProposal(item, decision, input.text?.trim() ?? '');
    run('UPDATE inbox SET status = ?, answer = ?, answered_at = ? WHERE id = ?', input.dismiss ? 'dismissed' : 'answered', res.answer, now(), id);
    touchProject(item.project_id);
    let target = item.agent_id ? getAgent(item.agent_id) : undefined;
    if (!target || target.status === 'closed') target = rootAgent(getProject(item.project_id)!);
    await sendToAgent(target.id, `<user-answer request="${item.title}">\n${res.message}\n</user-answer>`, { kind: 'user', name: 'You' });
    return null;
  }

  if (item.kind === 'action' && !input.dismiss && !(ACTION_CHOICES as readonly string[]).includes(input.choice ?? '')) return `Choose ${ACTION_CHOICES.join(' or ')}.`;
  if (!input.dismiss && !answer.trim()) return 'Choose an option, write an answer or attach a file.';
  tx(() => {
    run('UPDATE inbox SET status = ?, answer = ?, answered_at = ? WHERE id = ?', input.dismiss ? 'dismissed' : 'answered', answer || 'Dismissed', now(), id);
    bindAttachments(files, 'inbox', id);
    needsAnswered(id);
  });
  // A question linked to a pinned proposal: its answer is recorded there as the choice (pins.ts).
  if (!input.dismiss) noteRequestAnswered(id);
  if (item.task_id) run('UPDATE tasks SET updated_at = ? WHERE id = ?', now(), item.task_id);
  touchProject(item.project_id);
  if (input.dismiss) return null;

  const project = getProject(item.project_id)!;
  let target = item.agent_id ? getAgent(item.agent_id) : undefined;
  if (!target || target.status === 'closed') target = rootAgent(project);
  // An answer to a question about a task carries the task, so the reply to it goes to that task's thread.
  const about = (item.task_id ? ` task="${item.task_id}"` : '') + (item.kind === 'action' ? ' kind="to-do"' : '');
  await sendToAgent(target.id, `<user-answer request="${item.title}"${about}>\n${answer}\n</user-answer>`, { kind: 'user', name: 'You' }, files, false);
  return null;
}

/** After a restart no agent process is running, whatever the database says. */
export function recoverOnBoot() {
  run("UPDATE agents SET status = 'interrupted', updated_at = ? WHERE status IN ('working')", now());
  run("UPDATE agents SET status = 'idle', updated_at = ? WHERE status = 'waiting' AND id NOT IN (SELECT agent_id FROM inbox WHERE status = 'open' AND kind IN ('question', 'action') AND blocking = 1 AND agent_id IS NOT NULL)", now());
  run("UPDATE inbox SET status = 'dismissed', answer = 'Helm restarted before this was answered', answered_at = ? WHERE status IN ('open', 'director', 'check') AND kind = 'permission'", now());
  releaseStaleClaims();
}

/**
 * The Toolbox changed for these projects. Idle processes are closed now so the
 * next message starts with the new set; busy ones close when their turn ends.
 */
export function restartForProjects(projectIds: string[]) {
  for (const l of live.values()) {
    const a = getAgent(l.agentId);
    if (!a || !projectIds.includes(a.project_id) || l.closing) continue;
    if (a.status === 'working' || a.status === 'waiting') l.restartAfterTurn = true;
    else shutdown(l, null);
  }
}

export function liveAgentIds(): Set<string> {
  return new Set(live.keys());
}

export function liveCount() {
  return live.size;
}

export async function shutdownAll() {
  const all = [...live.values()];
  for (const l of all) shutdown(l, null);
  await Promise.allSettled(all.map((l) => l.done));
}
