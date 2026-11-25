import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, Options, PermissionMode, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.ts';
import { dropConsults, hasOpenBlockingConsult } from './consults.ts';
import { all, get, newId, now, run, tx } from './db.ts';
import { hostsPromptSection, releaseAgentClaims, releaseStaleClaims } from './hosts.ts';
import type { Row } from './db.ts';
import { sharedBuildEnv } from './sharedbuild.ts';
import { FINISHED, addEvent, addJournal, getAgent, getProject, projectStructure, touchProject } from './store.ts';
import { reportFilesDir } from './reports.ts';
import { attachmentView, attachmentsBlock, attachmentsDir, bindAttachments, pendingAttachments } from './attachments.ts';
import { buildSystemPrompt, isManager } from './structure.ts';
import { unfiledAskNote } from './askcheck.ts';
import { waitingTurn } from './watchdog.ts';
import type { Role } from './structure.ts';
import { ACTION_CHOICES, createRequest, needsAnswered, releaseHeld } from './requests.ts';
import { dangerOf, directorStopped, dispatch, wakeWaiter, matchingRule, noteCwd, recordAuto, routeFor, ruleText, rulesFromSuggestions, setTriageHooks, settle, takeNotices, waitFor } from './triage.ts';
import { noteRequestAnswered } from './pins.ts';
import { loadStates, sessionToolbox } from './toolbox.ts';
import type { Expected, LoadState } from './toolbox.ts';
import { makeHelmServer } from './tools.ts';
import { knowledgeChangeNote, knowledgeForPrompt, withSubagentKnowledge } from './knowledge.ts';
import { noteFixedErrors, takeFixReminder } from './fixreminder.ts';
import { relatedNote } from './related.ts';
import { affectsNote } from './affects.ts';
import { isBuilder } from './builder.ts';
import { builderDone, dispatchProject } from './dispatch.ts';
import { presenceTag } from './sessions.ts';
import { afterDirectorTurn, onAgentFinished, onAgentResumed } from './taskwatch.ts';
import { agentErrored, agentRunning, answerAgentError, setAgentErrorHooks, turnFailure } from './agenterrors.ts';
import { classifyTrigger, routeTurn } from './turns.ts';
import { newWorkTracker, noteCall, pollPlanUsage, recordRateLimit, recordTurnUsage, takeWork } from './usage.ts';
import type { CallUsage, Work, WorkTracker } from './usage.ts';
import { MAIN, accountEnv, accountFor, ensureAccountDir, markLimited } from './accounts.ts';
import { directorTurnTask } from './telemetry.ts';
import { contextOf, directorWindow, recordSummary, saveNote, shouldAskSave } from './contextsave.ts';
import { bashCheck, hasRunningCommands, commandEnded, commandStarted, endCommandsOf, recoverCommands } from './commands.ts';
import { onHeavyFreed } from './hosts.ts';
import { SUBAGENT_ROLE, agentCallCheck, endSubagentRow, endSubagentsOf, openSubagents, recoverSubagents, subagentDefs, subagentEnded, subagentEvent, subagentFor, subagentProgress } from './subagents.ts';
import { agentTier, nearestTier, tierOf } from './tiers.ts';
import type { Tier } from './tiers.ts';
import type { RuntimeApi } from './tools.ts';
import { directorReply, heldResult, replaceReply, stripDetail, workerTurn } from './brevity.ts';
import { cleanArtifacts } from './diskusage.ts';
import type { Viewing } from './chatcontext.ts';
import { builtinRefusal, checkAtRest, holdMessage, holds, isStopped, modeChangeNote, modePromptSection, setProjectModeHooks, takeHeld } from './projectmode.ts';
import { getAttachment } from './attachments.ts';
import { HIDDEN_TOOLS, bindAgentOps, liveChanged, rootAgent } from './agents.ts';
import type { Sender } from './agents.ts';

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
  /** The tier this process runs at now, and its model and effort (tiers.ts): switched before a message for another tier. */
  tier: string;
  model: string;
  effort: string;
  /** The Claude account this process runs on (accounts.ts). */
  account: string;
  /** This turn's last API error code and usage-limit reset time, for naming an error when the turn ends (agenterrors.ts). */
  apiError?: string | null;
  resetsAt?: number | null;
  /** SDK subagent tokens since the last result, per API message id (one message may stream more than once), with the Agent call it belongs to. */
  subUsage?: Map<string, { tokens: number; call: string }>;
  /** Work tokens (usage.ts): the main thread's, and each subagent's per Agent call, since the last result. */
  work?: WorkTracker;
  subWork?: Map<string, WorkTracker>;
  /** The context the last main-thread call held, the window it fills, and when the save turn was asked for (contextsave.ts). */
  context?: number;
  contextWindow?: number;
  saveAskedAt?: number | null;
};

const live = new Map<string, Live>();


const AUTONOMY: Record<string, PermissionMode> = {
  supervised: 'default',
  edits: 'acceptEdits',
  auto: 'auto',
  full: 'bypassPermissions',
};

/** Statuses that end an agent's hold on the hosts it claimed: closed, stopped, task complete, error. */
const RELEASES_HOSTS = ['closed', 'done', 'interrupted', 'error'];
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
  // An errored agent's entry under Needs you (agenterrors.ts) is withdrawn once it runs again or is closed.
  if (a && typeof fields.status === 'string' && fields.status !== 'error') agentRunning(agentId, FINISHED.includes(fields.status) ? 'Agent closed' : undefined);
  // A wind down ends when nothing is Active and no agent works (projectmode.ts): any agent stopping work may end it.
  if (a && typeof fields.status === 'string' && fields.status !== 'working') void checkAtRest(a.project_id).catch((err) => console.error('At-rest check failed:', err));
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

const withMode = (prompt: string, mode: string) => (mode ? `${prompt}\n\n${mode}` : prompt);

function startLive(agent: Row): Live {
  const { project, role } = roleFor(agent);
  // A new process starts in the project folder, whatever the last one had cd'd to.
  noteCwd(agent.id, project.path);
  const structure = projectStructure(project);
  // The model and effort of the tier it works at now (tiers.ts); a resumed session takes them.
  const run_ = tierFor(agent);
  // The account the project runs on now: its primary, or a fallback while the primary is limited (accounts.ts).
  const account = accountFor(project.id);
  ensureAccountDir(account);
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
    model: run_.model,
    effort: (run_.effort || undefined) as Options['effort'],
    resume: agent.session_id || undefined,
    // The director is summarised early (setting director_context): each of its turns re-reads the whole context.
    ...(!agent.parent_id && directorWindow(project.id) ? { settings: { autoCompactWindow: directorWindow(project.id)! } } : {}),
    systemPrompt: { type: 'preset', preset: 'claude_code', append: withMode(buildSystemPrompt(project, structure, role, agent, parent, hostsPromptSection(project.id), knowledgeForPrompt(project.id, agent)), modePromptSection(agent, isManager(structure, role))) },
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
    // A builder's own subagents, one per tier it may pick (subagents.ts).
    ...(isBuilder(agent) ? { agents: withSubagentKnowledge(subagentDefs(project.id), project.id, agent) } : {}),
    allowedTools: ['mcp__helm'],
    disallowedTools: HIDDEN_TOOLS,
    permissionMode: mode,
    allowDangerouslySkipPermissions: mode === 'bypassPermissions' ? true : undefined,
    canUseTool,
    // The Bash tool's working folder moves with cd. Every hook input carries the session's current one, so before each
    // tool call (and so before its permission request) the danger check learns where relative paths resolve from.
    // (CwdChanged would be the natural event, but the CLI does not deliver it to SDK hooks.)
    hooks: {
      // Just before Claude summarises the context: noted with whether the save turn came first (contextsave.ts).
      PreCompact: [{ hooks: [async (input) => {
        const a = getAgent(agent.id);
        const l = live.get(agent.id);
        if (a) addEvent(a, 'note', { text: `Context about to be summarised (${(input as { trigger?: string }).trigger ?? 'auto'})${l?.saveAskedAt || a.save_asked_at ? '; the save turn came first' : '; no save turn came first'}.` });
        return {};
      }] }],
      PreToolUse: [{ hooks: [async (input, toolUseId) => {
        if (input.cwd) noteCwd(agent.id, input.cwd);
        // A stopped project: the director may answer the user, not start background work (projectmode.ts).
        const pre = input as { tool_name?: string; tool_input?: unknown };
        let refused = pre.tool_name ? builtinRefusal(agent.project_id, pre.tool_name, (pre.tool_input ?? {}) as Row) : null;
        // A builder starting a subagent: its type, the limit, and its task (subagents.ts).
        // A builder's long commands: in the background, one heavy job per host (commands.ts).
        if (!refused && pre.tool_name === 'Bash' && isBuilder(agent)) refused = bashCheck(getAgent(agent.id)!, (pre.tool_input ?? {}) as Row);
        if (!refused && pre.tool_name === 'Agent' && isBuilder(agent)) refused = agentCallCheck(getAgent(agent.id)!, toolUseId ?? (input as { tool_use_id?: string }).tool_use_id, (pre.tool_input ?? {}) as Row);
        if (refused) return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: refused } };
        return {};
      }] }],
    },
    pathToClaudeCodeExecutable: config.claudePath,
    // One Rust build folder for every work tree of the project (sharedbuild.ts).
    env: { ...process.env, ...sharedBuildEnv(project), ...accountEnv(account), CLAUDE_AGENT_SDK_CLIENT_APP: 'helm/0.1' },
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
    tier: run_.id,
    model: run_.model,
    effort: run_.effort,
    account,
  };
  live.set(agent.id, l);
  liveChanged();
  l.done = pump(l);
  return l;
}

async function pump(l: Live) {
  try {
    for await (const msg of l.q) handleMessage(l, msg);
  } catch (err: any) {
    const a = getAgent(l.agentId);
    const failure = a ? turnFailure({ closing: l.closing, thrown: String(err?.message ?? err), apiError: l.apiError, resetsAt: l.resetsAt }) : null;
    if (a && failure?.kind === 'usage_limit' && failOver(l, failure.resetsAt)) {
      // Moved to a fallback account: the process is gone, and failOver resumes it there.
    } else if (a && failure) {
      addEvent(a, 'error', { message: String(err?.message ?? err) });
      setAgent(l.agentId, { status: 'error' });
      agentErrored(l.agentId, failure);
    }
  } finally {
    if (l.idleTimer) clearTimeout(l.idleTimer);
    if (live.get(l.agentId) === l) {
      live.delete(l.agentId);
      liveChanged();
    }
    // Subagents and commands ran inside the process: they ended with it.
    endSubagentsOf(l.agentId);
    endCommandsOf(l.agentId);
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

/** A subagent's API message: its tokens (input + output + cache writes, as usage.ts counts), the largest seen per id. */
function noteSubUsage(l: Live, call: string, m: { id?: string; usage?: CallUsage } | undefined) {
  const u = m?.usage;
  if (!u || !m?.id) return;
  const n = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  l.subUsage ??= new Map();
  l.subUsage.set(m.id, { tokens: Math.max(l.subUsage.get(m.id)?.tokens ?? 0, n), call });
  l.subWork ??= new Map();
  if (!l.subWork.has(call)) l.subWork.set(call, newWorkTracker());
  noteCall(l.subWork.get(call)!, m.id, u);
}

/** The subagent tokens noted since the last result, per Agent call, with their work tokens; cleared. */
function takeSubUsage(l: Live): { call: string; tokens: number; work: Work }[] {
  const per = new Map<string, number>();
  for (const v of l.subUsage?.values() ?? []) per.set(v.call, (per.get(v.call) ?? 0) + v.tokens);
  l.subUsage = undefined;
  return [...per].map(([call, tokens]) => ({ call, tokens, work: takeWork(l.subWork?.get(call)) }));
}

/** A builder's subagent ended: once none runs and the builder rests, its session may close when idle. */
function afterSubagent(l: Live) {
  if (openSubagents(l.agentId).length || hasRunningCommands(l.agentId)) return;
  const a = getAgent(l.agentId);
  if (a && !['working', 'waiting'].includes(a.status) && !l.closing) scheduleIdleClose(l, config.idleSeconds);
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
    if (sub) noteSubUsage(l, msg.parent_tool_use_id!, msg.message as any);
    else if ((msg.message as any)?.usage) {
      l.context = contextOf((msg.message as any).usage) || l.context;
      noteCall((l.work ??= newWorkTracker()), String((msg.message as any).id ?? msg.uuid), (msg.message as any).usage);
    }
    // A builder's subagent's messages are its own row's events (subagents.ts): its live action on the task card.
    const put = (kind: string, data: Row) => (sub && subagentEvent(msg.parent_tool_use_id, kind, data)) || addEvent(agent, kind, data);
    for (const block of msg.message.content as any[]) {
      if (block.type === 'text' && block.text.trim()) put('text', { text: block.text, sub });
      else if (block.type === 'tool_use') {
        // Every shell command is tracked from start to end (commands.ts): the task card, and its duration next time.
        if (block.name === 'Bash') commandStarted((sub && subagentFor(msg.parent_tool_use_id)) || agent, agent, block.id, block.input ?? {});
        put('tool', {
          id: block.id,
          name: block.name,
          summary: summarizeTool(block.name, block.input),
          input: clip(JSON.stringify(block.input, null, 2) ?? '', 4000),
          sub,
        });
      }
    }
    if (msg.error) {
      addEvent(agent, 'error', { message: `API error: ${msg.error}` });
      l.apiError = msg.error;
    }
    return;
  }

  // Claude summarised the context: recorded, and the agent told what was saved and where the rest is (contextsave.ts).
  if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
    const meta = (msg as any).compact_metadata ?? {};
    const note = recordSummary(agent, meta, l.saveAskedAt ?? agent.save_asked_at ?? null);
    l.saveAskedAt = null;
    run('UPDATE agents SET save_asked_at = NULL WHERE id = ?', agent.id);
    l.context = meta.post_tokens ?? 0;
    addEvent(agent, 'note', { text: `Context summarised (${meta.trigger ?? 'auto'}): ${meta.pre_tokens ?? '?'} → ${meta.post_tokens ?? '?'} tokens.` });
    setTimeout(() => void sendToAgent(agent.id, note, { kind: 'system', name: 'Helm' }).catch(() => {}), 0);
    return;
  }

  if (msg.type === 'system' && (msg.subtype === 'task_progress' || msg.subtype === 'task_notification' || msg.subtype === 'task_started')) {
    const m = msg as any;
    if (m.subtype === 'task_progress') subagentProgress(m.tool_use_id, String(m.summary || (m.last_tool_name ? `${m.description} · ${m.last_tool_name}` : m.description) || ''));
    else if (m.subtype === 'task_started' && m.is_backgrounded === false) {
      const s = subagentFor(m.tool_use_id);
      if (s) run('UPDATE agents SET background = 0 WHERE id = ?', s.id);
    } else if (m.subtype === 'task_notification') {
      // A background command's end, or a subagent's.
      const cmd = commandEnded(m.tool_use_id, 'notification');
      if (subagentEnded(m.tool_use_id, m.status, String(m.summary ?? '')) || cmd) afterSubagent(l);
    }
    return;
  }

  if (msg.type === 'rate_limit_event') {
    if (msg.rate_limit_info.status === 'rejected') {
      l.resetsAt = msg.rate_limit_info.resetsAt ?? null;
      // The whole account is limited: no new session starts on it until the reset (accounts.ts).
      if (msg.rate_limit_info.rateLimitType !== 'overage') markLimited(l.account, l.resetsAt);
    }
    // The plan windows shown are the main account's.
    if (l.account === MAIN) recordRateLimit(msg.rate_limit_info);
    return;
  }

  if (msg.type === 'user') {
    const content = msg.message.content;
    if (!Array.isArray(content)) return;
    for (const block of content as any[]) {
      if (block.type !== 'tool_result') continue;
      const data = { id: block.tool_use_id, error: !!block.is_error, text: clip(blockText(block.content), 2500), sub: !!msg.parent_tool_use_id };
      if (!(msg.parent_tool_use_id && subagentEvent(msg.parent_tool_use_id, 'tool_result', data))) addEvent(agent, 'tool_result', data);
      commandEnded(block.tool_use_id, 'result');
      // A subagent that ran in the foreground ends when its Agent call returns.
      if (!msg.parent_tool_use_id) {
        const s = subagentFor(block.tool_use_id);
        if (s && s.status === 'working' && !s.background && subagentEnded(block.tool_use_id, block.is_error ? 'failed' : 'completed', blockText(block.content))) afterSubagent(l);
      }
    }
    return;
  }

  if (msg.type === 'result') {
    const ok = msg.subtype === 'success' && !msg.is_error;
    // A director's turn counts for the task it was about; an agent's subagents' share is recorded apart (telemetry.ts).
    // Each subagent's share counts on its own row and task, at its tier (subagents.ts).
    const subs = takeSubUsage(l).map((x) => ({ ...x, row: subagentFor(x.call) }));
    // The window the context fills, from the turn's models (contextsave.ts).
    const windows = Object.values(msg.modelUsage ?? {}).map((m: any) => Number(m?.contextWindow ?? 0)).filter((n) => n > 0);
    if (windows.length) l.contextWindow = Math.max(...windows);
    // The director's session is summarised at its own, smaller window: the save turn comes ahead of that.
    const limit = !agent.parent_id ? directorWindow(agent.project_id) : null;
    if (limit && l.contextWindow) l.contextWindow = Math.min(l.contextWindow, limit);
    recordTurnUsage(agent, msg.modelUsage, l.tier, !agent.parent_id ? 'director' : isBuilder(agent) ? 'builder' : 'agent', {
      sub: subs.filter((x) => !x.row).reduce((n, x) => n + x.tokens, 0),
      subWork: subs.filter((x) => !x.row).reduce((w, x) => ({ input: w.input + x.work.input, output: w.output + x.work.output }), { input: 0, output: 0 }),
      work: takeWork(l.work),
      subagents: subs.filter((x) => x.row).map((x) => ({ agent: x.row!, tokens: x.tokens, tier: x.row!.sub_tier ?? null, work: x.work })),
      ...(!agent.parent_id ? { task: directorTurnTask(agent.id) ?? agent.task_id ?? null } : {}),
      context: l.context,
      account: l.account,
    });
    if (l.account === MAIN) void pollPlanUsage(l.q);
    // "[detail requested]" on the first line: the reader asked for the detail, so a long reply is not held (brevity.ts).
    const { text, detail } = stripDetail(msg.subtype === 'success' ? (msg.result ?? '') : `Turn ended early (${msg.subtype}). ${msg.errors.join('; ')}`);
    // A top-level agent's reply is either dialogue with the user or belongs elsewhere (see turns.ts). A rewrite asked
    // for by Helm's brevity note takes the place of the reply it rewrites (brevity.ts).
    const held = agent.parent_id ? null : heldResult(agent);
    const routedFrom = get('SELECT MAX(id) AS id FROM task_messages')?.id ?? 0;
    const route = agent.parent_id ? null : held ? replaceReply(agent, held, text ?? '', ok, detail) : routeTurn(agent, Number.MAX_SAFE_INTEGER, ok ? (text ?? '') : '');
    const resultId = addEvent(agent, 'result', { ok, text, cost: msg.total_cost_usd, ms: msg.duration_ms, ...(route ? { dialogue: route.dialogue, routed: route.routed } : {}), ...(held && ok && text?.trim() ? { replaces: held.id } : {}) });
    // The requests it filed this turn are shown now, in their final form, with one notification (requests.ts).
    releaseHeld(agent.id);
    // Something the user must do, said only in prose: the manager is told to file it (askcheck.ts). Delivered as its next turn.
    const askNote = l.manager && ok ? unfiledAskNote(agent, resultId, { text: text ?? '', dialogue: !!route?.dialogue }) : null;
    // A reply to the user over its budget: one note asking for it shorter (not when another note already goes, nor for a rewrite).
    const routedMessage = route?.routed && !held ? (get('SELECT MAX(id) AS id FROM task_messages WHERE task_id = ? AND id > ?', route.routed, routedFrom)?.id ?? null) : null;
    const replyNote = route && ok && !held && !askNote ? directorReply(agent, resultId, text ?? '', { ...route, message: routedMessage }, detail) : null;
    // After this handler has settled the turn (status, idle timer), so the note starts a fresh one.
    if (askNote || replyNote) setTimeout(() => void sendToAgent(agent.id, (askNote ?? replyNote)!, { kind: 'system', name: 'Helm' }).catch(() => {}), 0);
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
    // A worker's report over its budget is held, and the worker asked once to cut it; its rewrite is delivered instead
    // (brevity.ts). Whatever it called (complete_task) still counts at the end of that next turn.
    const askedFirst = !!agent.parent_id && hasOpenBlockingConsult(agent.id);
    const brief = agent.parent_id && !askedFirst && !l.interrupted ? workerTurn(agent, resultId, text ?? '', ok, detail) : null;
    if (brief && 'note' in brief) {
      setAgent(agent.id, fields);
      setTimeout(() => void sendToAgent(agent.id, brief.note, { kind: 'system', name: 'Helm' }).catch(() => {}), 0);
      return;
    }
    // A builder ending its turn waiting on the user with no request open on its task is not let go idle: it is asked to
    // file it now, in the same turn; if that turn too ends without one, Helm files it from its text (watchdog.ts).
    if (isBuilder(agent) && ok && !l.interrupted && !l.completeRequested && !askedFirst) {
      const wait = waitingTurn(getAgent(agent.id) ?? agent, text ?? '', resultId);
      if (wait) {
        setAgent(agent.id, fields);
        setTimeout(() => void sendToAgent(agent.id, wait, { kind: 'system', name: 'Helm' }).catch(() => {}), 0);
        return;
      }
    }
    const report = brief ? brief.deliver : (text ?? '');
    // The turn is over and nothing else is queued. An error is any unsuccessful end nobody chose (agenterrors.ts).
    const failure = turnFailure({ interrupted: l.interrupted, ok, subtype: msg.subtype, text: text ?? '', apiError: l.apiError, resetsAt: l.resetsAt });
    // A usage limit with a fallback that has room: the session continues there, with no error (accounts.ts).
    if (failure?.kind === 'usage_limit' && failOver(l, failure.resetsAt)) {
      l.completeRequested = false;
      l.apiError = null;
      l.resetsAt = null;
      setAgent(agent.id, { ...fields, status: 'idle' });
      return;
    }
    if (l.interrupted) fields.status = 'interrupted';
    else if (l.completeRequested && ok) fields.status = 'done';
    else if (hasOpenBlocking(agent.id)) fields.status = 'waiting';
    else fields.status = failure ? 'error' : 'idle';
    const stopped = l.interrupted;
    l.completeRequested = false;
    l.interrupted = false;
    l.apiError = null;
    l.resetsAt = null;
    setAgent(agent.id, fields);
    // An error it got past this task: its next message reminds it to record the fix (fixreminder.ts).
    if (ok && !stopped) noteFixedErrors(agent.id);
    // Builders (dispatch.ts): a builder's own turns never wake the director; its finished task is settled, it is
    // closed and the next builders start. Errors still reach the director and Needs you.
    const building = isBuilder(agent);
    if (building && fields.status === 'done') {
      const finished = getAgent(agent.id)!;
      setTimeout(() => void builderDone(finished, String(finished.status_line ?? '')).catch((err) => console.error('Builder close failed:', err)), 0);
    }
    // Its task now waits for the director's review; and a director's turn that saw such a report must settle it (taskwatch.ts).
    if (fields.status === 'done' && !building) onAgentFinished(agent.id);
    if (!agent.parent_id) {
      afterDirectorTurn(agent);
      // The same for a task the director drives itself, unless another note already asks it to file (askcheck.ts).
      const wait = ok && !stopped && !askNote && !replyNote ? waitingTurn(getAgent(agent.id) ?? agent, text ?? '', resultId, directorTurnTask(agent.id) ?? agent.task_id ?? null) : null;
      if (wait) setTimeout(() => void sendToAgent(agent.id, wait, { kind: 'system', name: 'Helm' }).catch(() => {}), 0);
      // New work shown to affect running tasks and not passed on this turn: asked once more (affects.ts).
      const aff = affectsNote(agent);
      if (aff) setTimeout(() => void sendToAgent(agent.id, aff, { kind: 'system', name: 'Helm' }).catch(() => {}), 0);
    }

    // A turn that ends waiting on the manager's answer or review says nothing new to it: the question already went.
    const askedParent = fields.status === 'idle' && hasOpenBlockingConsult(agent.id);
    // A quick helper's job ends with its turn, unless the user stopped it or it waits on its caller or the user.
    const quickEnd = !!agent.quick && !stopped && !askedParent && fields.status !== 'waiting';
    // Its entry under Needs you; a quick helper is closed instead, and its caller hears of it in the report below.
    // When the parent is the director, the note rides on the report rather than waking it twice.
    const toRoot = !!agent.parent_id && !askedParent && !getAgent(agent.parent_id)?.parent_id;
    const errorNote = fields.status === 'error' && failure && !quickEnd ? agentErrored(agent.id, failure, !toRoot) : null;
    if (agent.parent_id && !askedParent && !(building && !(fields.status === 'error' && failure))) {
      const parent = getAgent(agent.parent_id);
      if (parent && parent.status !== 'closed') {
        const state = quickEnd
          ? ok ? 'quick job finished; helper closed' : 'quick job failed; helper closed'
          : stopped ? 'stopped by the user' : fields.status === 'done' ? 'task complete' : fields.status === 'waiting' ? 'waiting on the user' : ok ? 'turn finished' : 'stopped with an error';
        const after = quickEnd ? '\n\n(Helm closed this quick helper. Check what it reports before relying on it: you remain responsible for the result.)' : '';
        void sendToAgent(
          parent.id,
          `<agent-report from="${agent.name}" id="${agent.id}" state="${state}"${quickEnd ? ' quick="true"' : ''}>\n${clip(report, 12000)}${after}\n</agent-report>${errorNote && toRoot ? `\n${errorNote}` : ''}`,
          { kind: 'agent', name: agent.name },
        ).catch(() => {});
      }
    }
    if (quickEnd) {
      void closeAgent(agent.id, ok ? 'done' : 'closed').catch(() => {});
      return;
    }
    // The context is nearly full: one short turn to save what must survive before Claude summarises it (contextsave.ts).
    if (!stopped && fields.status !== 'error' && !agent.quick && shouldAskSave(l.context ?? 0, l.contextWindow ?? 0, l.saveAskedAt ?? agent.save_asked_at)) {
      l.saveAskedAt = now();
      run('UPDATE agents SET save_asked_at = ? WHERE id = ?', l.saveAskedAt, agent.id);
      const note = saveNote(getAgent(agent.id)!, l.context ?? 0, l.contextWindow ?? 0);
      setTimeout(() => void sendToAgent(agent.id, note, { kind: 'system', name: 'Helm' }).catch(() => {}), 0);
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
  // Its subagents run inside this process: it stays open until the last one ends (afterSubagent).
  if ((openSubagents(l.agentId).length || hasRunningCommands(l.agentId)) && seconds > 1) return;
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

/**
 * A turn hit its account's usage limit (accounts.ts). The account is marked limited until the reset; if the project
 * has a fallback with room, this process ends and the agent resumes there from the same transcript, and the project's
 * other sessions follow (rebalanceAccounts). False when there is none: the project waits, and the error stands.
 */
function failOver(l: Live, resetsAt: number | null): boolean {
  const agent = getAgent(l.agentId);
  if (!agent) return false;
  markLimited(l.account, resetsAt);
  const next = accountFor(agent.project_id);
  if (next === l.account) return false;
  const from = l.account;
  addEvent(agent, 'note', { text: `Usage limit on the ${from} account: continuing on ${next}.` });
  shutdown(l, null);
  rebalanceAccounts();
  void l.done
    .then(() => sendToAgent(agent.id, `<helm-note kind="account">Your last turn was cut short by the usage limit on the ${from} Claude account; your session continues on the ${next} account. Pick up where you left off: check your worklist and the state of the files first.</helm-note>`, { kind: 'system', name: 'Helm' }))
    .catch(() => {});
  return true;
}

/**
 * Keep every live session on its project's account now: after a failover, and once the primary's limit has reset
 * (the runner checks every minute). An idle process is closed (its next message starts on the right account); a busy
 * one closes when its turn ends.
 */
export function rebalanceAccounts() {
  for (const l of live.values()) {
    if (l.closing) continue;
    const a = getAgent(l.agentId);
    if (!a || l.account === accountFor(a.project_id)) continue;
    if (a.status === 'working' || a.status === 'waiting') l.restartAfterTurn = true;
    else shutdown(l, null);
  }
}
setInterval(rebalanceAccounts, 60_000).unref();

// ---------- operations used by the API and by agent tools ----------


/**
 * Deliver a message. `files` are pending uploads sent with it: they become the event's attachments, the transcript
 * shows them under the message (unless they belong to a thread message: bindToEvent false), and the agent gets their paths in an <attachments> block after the text.
 */
/** `viewing`: what the user was looking at (chatcontext.ts): the director reads its block; the event keeps the reference. */
export async function sendToAgent(agentId: string, text: string, from: Sender, files: Row[] = [], bindToEvent = true, viewing?: Viewing | null): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent) throw new Error(`No agent ${agentId}`);
  // A builder's subagent has no session of its own: it cannot be messaged or resumed (subagents.ts).
  if (agent.role_id === SUBAGENT_ROLE) return;
  // A stopped project: held until the user resumes, except the user's own messages to the director (projectmode.ts).
  if (holds(agent, from)) {
    holdMessage(agent, text, from, files.map((f) => f.id), bindToEvent, viewing ?? null);
    return;
  }
  // Messages held while it was stopped go first, in the order they were sent.
  if (!isStopped(agent.project_id)) {
    for (const h of takeHeld(agentId)) {
      const held = h.files.map((id) => getAttachment(id)).filter((r): r is Row => !!r);
      await deliver(agentId, h.text, h.from, held, h.bind, h.viewing);
    }
  }
  await deliver(agentId, text, from, files, bindToEvent, viewing);
}

async function deliver(agentId: string, text: string, from: Sender, files: Row[], bindToEvent: boolean, viewing?: Viewing | null): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent) return;
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
  // The project knowledge page changed since this agent was given it: a short note naming what (knowledge.ts).
  text += knowledgeChangeNote(agentId);
  text += takeFixReminder(agentId);
  // A standing agent now on another task: that task's related past work, once (related.ts).
  text += relatedNote(agentId);
  // The project's mode changed since this agent was last told: the rules for the new one, once (projectmode.ts).
  text += modeChangeNote(agent, managerOf(agent));
  // Between turns on another account than its project's now (a failover, or the return to the primary): the next
  // turn starts a process on the right one, resumed from the same transcript (accounts.ts).
  const cur = live.get(agentId);
  if (cur && !cur.closing && cur.account !== accountFor(agent.project_id) && !['working', 'waiting'].includes(agent.status)) {
    shutdown(cur, null);
    await cur.done;
  }
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
      // Its current task is at another tier: the session moves to that tier's model and effort first.
      await switchTier(l, getAgent(agentId)!);
      l.queue.push(text);
      return;
    }
    await l.done;
  }
}

/** The tier an agent works at now, with its model and effort (tiers.ts). */
export function tierFor(agent: Row): Tier {
  const { project, role } = roleFor(agent);
  const structure = projectStructure(project);
  return tierOf(agentTier(agent, { root: !agent.parent_id && role.id === structure.root, quick: !!agent.quick, areaTier: role.tier ?? nearestTier(role.model, role.effort) }));
}

/** Move a live session to the tier its agent should work at now (setModel, effort through the flag settings). */
async function switchTier(l: Live, agent: Row) {
  const want = tierFor(agent);
  if (want.model === l.model && want.effort === l.effort) return;
  try {
    if (want.model !== l.model) await l.q.setModel(want.model);
    if (want.effort !== l.effort) await l.q.applyFlagSettings({ effortLevel: (want.effort || null) as any });
    Object.assign(l, { tier: want.id, model: want.model, effort: want.effort });
  } catch (err) {
    // Not switched: close it, so the next message starts a session at the new tier (resumed from its transcript).
    console.warn(`Tier switch for ${agent.name} failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    l.restartAfterTurn = true;
  }
}

function managerOf(agent: Row): boolean {
  const { project, role } = roleFor(agent);
  return isManager(projectStructure(project), role);
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
  // A builder's subagent stops with its builder; stopping one alone ends its row only (the SDK has no handle on it here).
  if (agent.role_id === SUBAGENT_ROLE) {
    endSubagentRow(agentId);
    return;
  }
  if (!l || l.closing) {
    if (['working', 'waiting'].includes(agent.status)) setAgent(agentId, { status: 'interrupted' });
    return;
  }
  addEvent(agent, 'note', { text: isStopped(agent.project_id) ? 'Stopped: the user stopped all work in the project.' : 'Stopped by the user.' });
  l.interrupted = true;
  await l.q.interrupt().catch(() => {});
  endSubagentsOf(agentId, 'Stopped by the user');
  endCommandsOf(agentId);
  // Stop all work: the process ends too, so no input already queued for it starts another turn. Its conversation is
  // saved, and the resume note starts it again (projectmode.ts).
  if (isStopped(agent.project_id)) shutdown(l, 'interrupted');
  setAgent(agentId, { status: 'interrupted' });
}

// A heavy claim ended while other agents' heavy jobs are queued: each is told the host is free (hosts.ts).
onHeavyFreed((agents, host) => {
  for (const a of agents) void sendToAgent(a.id, `<helm-note kind="host">${host.name} is free for a heavy job now. Claim it with claim_host heavy: true if yours still waits.</helm-note>`, { kind: 'system', name: 'Helm' }).catch(() => {});
});
setTriageHooks({ send: (agentId, text) => sendToAgent(agentId, text, { kind: 'system', name: 'Helm' }), root: (project) => rootAgent(project) });
setAgentErrorHooks({ send: (agentId, text, from) => sendToAgent(agentId, text, from), close: (agentId) => closeAgent(agentId, 'closed'), root: (project) => rootAgent(project) });

// This process runs the agents: the API and shared modules reach them through server/agents.ts.
bindAgentOps('runtime', {
  send: sendToAgent,
  close: closeAgent,
  interrupt: interruptAgent,
  restartForProjects,
  resolvePermission: wakeWaiter,
  liveAgentIds,
  dispatch: (projectId) => void dispatchProject(projectId).catch((err) => console.error('Dispatch failed:', err)),
});

export const runtimeApi: RuntimeApi = {
  send: sendToAgent,
  close: closeAgent,
  markComplete(agentId) {
    const l = live.get(agentId);
    if (l) l.completeRequested = true;
  },
};

/** After a restart no agent process is running, whatever the database says. */
export function recoverOnBoot() {
  recoverSubagents();
  recoverCommands();
  run("UPDATE agents SET status = 'interrupted', updated_at = ? WHERE status IN ('working')", now());
  // Waiting on a permission answer is mid-turn too: its process is gone with the request, so the turn was cut short
  // (and is resumed like any interrupted one), not finished.
  run("UPDATE agents SET status = 'interrupted', updated_at = ? WHERE status = 'waiting' AND id IN (SELECT agent_id FROM inbox WHERE status IN ('open', 'director', 'check') AND kind = 'permission' AND agent_id IS NOT NULL)", now());
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

// Moved to server/agents.ts and server/answers.ts; re-exported for the tests and checks that drive the runtime directly.
export { createAgent, rootAgent } from './agents.ts';
export { answerInbox } from './answers.ts';
