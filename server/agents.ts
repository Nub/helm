import { all, get, newId, now, run, tx } from './db.ts';
import type { Row } from './db.ts';
import { getAgent, projectStructure, touchProject } from './store.ts';
import type { Role } from './structure.ts';
import type { Viewing } from './chatcontext.ts';
import type { PermissionDecision } from './triage.ts';

/**
 * What the API and shared modules may ask of running agents, without loading the runtime (server/runtime.ts) and the
 * Agent SDK. In the runner (and in `helm all`, one process) runtime.ts binds the real operations here when it loads.
 * In the web service the command queue (server/runner.ts) binds versions that hand each operation to the runner.
 * Nothing else may import runtime.ts outside the runner's own modules: that keeps the web service's code out of the
 * runner, so an update that changes only the web side does not restart agents.
 */

export type Sender = { kind: 'agent' | 'user' | 'system'; name: string };

export type AgentOps = {
  /**
   * Deliver a message. `files` are pending uploads sent with it: they become the event's attachments, the transcript
   * shows them under the message (unless they belong to a thread message: bindToEvent false), and the agent gets their
   * paths in an <attachments> block after the text. `viewing`: what the user was looking at (chatcontext.ts).
   */
  send(agentId: string, text: string, from: Sender, files?: Row[], bindToEvent?: boolean, viewing?: Viewing | null): Promise<void>;
  close(agentId: string, status: 'closed' | 'done'): Promise<void>;
  /** Stop the agent's current turn without ending its session. */
  interrupt(agentId: string): Promise<void>;
  /** The Toolbox changed for these projects: idle processes close now, busy ones after their turn. */
  restartForProjects(projectIds: string[]): void;
  /** Wake the agent waiting on a permission request someone decided (the decision is already recorded). */
  resolvePermission(inboxId: string, decision: PermissionDecision): void;
  /** Agents with a Claude process right now. */
  liveAgentIds(): Set<string>;
  /** Work was scheduled or started: Helm starts the fresh builders it allows now (dispatch.ts, runner side). */
  dispatch?(projectId: string): void;
};

let ops: AgentOps | null = null;
let bound = '';

/** Called once per process: by runtime.ts (`runtime`) or by the web service's command queue (`queue`). */
export function bindAgentOps(how: string, impl: AgentOps) {
  if (ops) throw new Error(`Agent operations are already bound (${bound}); cannot bind ${how}.`);
  ops = impl;
  bound = how;
}

function need(): AgentOps {
  if (!ops) throw new Error('No agent runtime in this process: neither the runtime nor the runner queue is loaded.');
  return ops;
}

let liveListener: () => void = () => {};
/**
 * The set of agents with a Claude process changed (runtime.ts calls this when one starts or ends). The runner link
 * writes its heartbeat at once, so the web service's count of agents mid-turn is never behind (server/runner.ts).
 */
export function liveChanged() {
  liveListener();
}
export function onLiveChange(fn: () => void) {
  liveListener = fn;
}

/** How this process reaches agents: 'runtime' (it runs them), 'queue' (it hands them to the runner) or '' (neither). */
export const agentOpsMode = () => bound;

export const sendToAgent: AgentOps['send'] = (...args) => need().send(...args);
export const closeAgent: AgentOps['close'] = (...args) => need().close(...args);
export const interruptAgent: AgentOps['interrupt'] = (...args) => need().interrupt(...args);
export const restartForProjects: AgentOps['restartForProjects'] = (ids) => need().restartForProjects(ids);
export const resolvePermission: AgentOps['resolvePermission'] = (id, d) => need().resolvePermission(id, d);
export const liveAgentIds = () => need().liveAgentIds();
export const liveCount = () => need().liveAgentIds().size;
/** Ask the runner to start builders for work that may run now (dispatch.ts). Nothing when no runtime is bound (tests). */
export const dispatchWork = (projectId: string) => {
  ops?.dispatch?.(projectId);
};

/** Built-in tools that have no surface in Helm. Questions and task lists go through the helm tools so the user can see and answer them. */
export const HIDDEN_TOOLS = ['AskUserQuestion', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'EnterPlanMode', 'ExitPlanMode'];

/**
 * What a session gets besides the helm tools, as Setup describes it. Keep in step with
 * the options in startLive (runtime.ts): mcpServers + strictMcpConfig, disallowedTools, and
 * settingSources (the project's own settings, not the personal ~/.claude). Toolbox items come on top.
 */
export const SESSION_EXTRAS = {
  mcpServers: ['helm'],
  hiddenBuiltins: HIDDEN_TOOLS,
  settingSources: ['project', 'local'],
};

// ---------- agent rows (database only, safe in either process) ----------

function uniqueName(projectId: string, name: string): string {
  const taken = new Set(all('SELECT name FROM agents WHERE project_id = ?', projectId).map((r) => r.name));
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`)) return `${name} ${i}`;
}

/** `exactName`: the name as given, even when a closed agent had it (a builder's letter is reused, dispatch.ts). */
export function createAgent(project: Row, parent: Row | null, role: Role, name: string, task: string, exactName = false): Row {
  const id = newId('ag');
  run(
    'INSERT INTO agents (id, project_id, parent_id, role_id, name, model, task, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, project.id, parent?.id ?? null, role.id, exactName ? name : uniqueName(project.id, name), role.model, task, 'idle', now(), now(),
  );
  touchProject(project.id);
  return getAgent(id)!;
}

/** The single top-level agent the user talks to; created on first use (in one transaction, so two processes make one). */
export function rootAgent(project: Row): Row {
  const find = () => get("SELECT * FROM agents WHERE project_id = ? AND parent_id IS NULL AND status != 'closed' ORDER BY created_at LIMIT 1", project.id);
  const existing = find();
  if (existing) return existing;
  return tx(() => {
    const again = find();
    if (again) return again;
    const structure = projectStructure(project);
    const role = structure.roles.find((r) => r.id === structure.root)!;
    return createAgent(project, null, role, role.name, '');
  });
}

/** A note from Helm to the project's director. */
export async function tellDirector(projectId: string, text: string) {
  const project = get('SELECT * FROM projects WHERE id = ?', projectId);
  if (!project) return;
  await sendToAgent(rootAgent(project).id, `<helm-note>${text}</helm-note>`, { kind: 'system', name: 'Helm' });
}
