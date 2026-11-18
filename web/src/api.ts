import { useCallback, useEffect, useRef, useState } from 'react';
import type { Boundary, Presence } from './sessions';

// ---------- types (mirroring the server's rows) ----------

export type Role = {
  id: string;
  name: string;
  model: string;
  effort: string;
  description: string;
  purpose?: string;
  prompt: string;
  canSpawn: string[];
  origin?: RoleOrigin;
};
/** `by` is "user" for the owner, otherwise the name of the agent that made the change. */
export type RoleStamp = { by: string; at: number; reason?: string; journalId?: number };
export type RoleOrigin = { created?: RoleStamp; changed?: RoleStamp };
export type ApprovalPolicy = 'none' | 'cap' | 'cap-and-model' | 'all';
export type Structure = {
  root: string;
  roles: Role[];
  maxAgents: number;
  approval?: ApprovalPolicy;
  template?: string;
  /** Role any agent may hand small, fully specified jobs to (quick_job); "" or missing: none. */
  quickRole?: string;
  /** Most unfinished quick helpers per agent; missing means 2. */
  quickPerCaller?: number;
};
/** GET /api/projects/:id/team: what Helm generates for each role. */
export type TeamDetails = {
  roles: { id: string; sample: { id: string; name: string } | null; systemPrompt: string; tools: { name: string; description: string }[] }[];
  extras: { mcpServers: string[]; hiddenBuiltins: string[]; settingSources: string[]; installed: { kind: string; name: string }[] };
};

export type Project = {
  id: string;
  name: string;
  path: string;
  description: string;
  phase: string;
  autonomy: string;
  structure: Structure;
  archived: number;
  /** Days without activity before an open discussion shows as cold; null: the server default. */
  cold_days?: number | null;
  /** Minutes without activity after which a session ends; null: the server default. */
  session_idle_minutes?: number | null;
  /** Who answers permission requests: 'user', or 'director' (the director first; server/triage.ts). */
  permission_answerer?: 'user' | 'director';
  /** Minutes a request waits on the director before it comes to the user; null: 10. */
  triage_minutes?: number | null;
  created_at: number;
  updated_at: number;
};
export type ProjectSummary = {
  id: string;
  name: string;
  path: string;
  description: string;
  phase: string;
  archived: number;
  updated_at: number;
  agents: number;
  working: number;
  waiting: number;
  progress: number | null;
  /** Open requests to the user (needs response) in this project. */
  openInbox: number;
  /** Tasks that say they need the user while nothing is filed (no open request). */
  unfiledNeeds?: number;
  statusLine: string;
};
export type ChecklistItem = { id: number; text: string; state: 'todo' | 'doing' | 'done' | 'blocked' | 'dropped' };
export type Agent = {
  id: string;
  project_id: string;
  parent_id: string | null;
  role_id: string;
  name: string;
  model: string;
  task: string;
  status: string;
  status_line: string;
  progress: number | null;
  last_result: string;
  cost_usd: number;
  turns: number;
  created_at: number;
  updated_at: number;
  checklist: ChecklistItem[];
  task_id?: string | null;
  /** The host this agent's own process runs on; null is the machine Helm runs on. */
  run_host_id: string | null;
  /** JSON: which Toolbox items the agent's last process start loaded. */
  toolbox_loaded?: string;
  /** 1 for a quick helper started with quick_job: short-lived, closed by Helm when its job ends. */
  quick?: number;
};
export type Doc = {
  id: string;
  /** One kind of entry; 'goal' and 'design' are older names read until the server's migration has run. */
  kind: 'entry' | 'goal' | 'design' | 'decision' | 'note';
  title: string;
  body: string;
  importance: number;
  status: 'proposed' | 'active' | 'paused' | 'done' | 'dropped';
  author: string;
  created_at: number;
  updated_at: number;
  /** How many decisions and notes the entry's history records (moved ones and journal decisions naming it). */
  record_count: number;
  /** One or two sentences for the collapsed view; '' on entries written before summaries existed. */
  summary: string;
  section_id: string | null;
  tags: string[];
  /** A decision or note attached to a goal or design. */
  parent_id: string | null;
  /** Where an owner's edit stands: '' nothing pending, changed (not yet planned), planning, not_planned. */
  spec_state: '' | 'changed' | 'planning' | 'not_planned';
  changed_at: number | null;
  plan_task_id: string | null;
  /** Set while there is an edit Revert can undo. */
  base_rev: number | null;
  importance_reason: string;
  /** The owner's order within the importance level. */
  importance_rank: number | null;
  /** 1 when the owner set the level: agents may not change it. */
  importance_pinned: number;
  /** Files attached as references. */
  attach_count?: number;
};
export type BudgetLevel = { count: number; cap: number; over: boolean; holders: { id: string; kind: string; title: string; reason: string; pinned: boolean; updated_at: number }[] };
export type Budget = { open: number; rule: { min: number; cpct: number; hpct: number }; critical: BudgetLevel; high: BudgetLevel };
export type ImportanceLimits = { critical_min: number; critical_pct: number; high_pct: number; task_critical_min: number; task_critical_pct: number; task_high_pct: number };
export type ImportanceChange = { target_id: string; old_level: number; new_level: number; reason: string; author_name: string; created_at: number; cause_title?: string | null; author?: string };
export type DocSection = { id: string; project_id: string; /** The parent section; null at the top level (sections nest up to three levels). */ parent_id: string | null; name: string; description: string; position: number; created_at: number; updated_at: number };
export type DocRevision = {
  id: number;
  doc_id: string;
  op: 'create' | 'edit' | 'revert' | 'delete';
  author: 'user' | 'agent';
  author_name: string;
  kind: string;
  title: string;
  summary: string;
  body: string;
  section_id: string | null;
  tags: string[];
  parent_id: string | null;
  created_at: number;
};
/** One entry in a Spec change message (see entryChange on the server). */
export type EntryChange = { doc_id: string; kind: Doc['kind']; title: string; isNew: boolean; fields: { field: 'title' | 'summary' | 'body'; before: string; after: string }[] };
export type DocSnapshot = { title: string; summary: string; body: string };
/** A task or discussion as named in Spec links. kind is 'discussion' for discussions where the server has them. */
export type LinkedTask = { id: string; title: string; state: TaskState; kind: string; updated_at: number };
/** GET /api/docs/:id/history */
export type DocHistory = {
  changes: { task: LinkedTask; isNew: boolean; before: DocSnapshot; after: DocSnapshot | null; at: number; by: string }[];
  implements: (LinkedTask & { linked_at: number })[];
  /** Discussions about the entry (Discuss), open and settled. */
  discussions?: (LinkedTask & { linked_at: number; messages: number })[];
  revisions: DocRevision[];
  importance: ImportanceChange[];
  /** Decisions and notes recorded about the entry: ones that were entries before (source moved) and journal decisions. */
  records: { key: string; source: 'moved' | 'journal'; kind: 'decision' | 'note'; title: string; summary: string; body: string; author: string; at: number; task: { id: string; title: string; kind: string } | null }[];
};
/** An edit the director proposed in a discussion about an entry (server/specdiscuss.ts proposalView). */
export type Proposal = {
  id: string;
  doc_id: string;
  doc_title: string;
  doc_exists: boolean;
  discussion_id: string;
  author_name: string;
  rationale: string;
  status: 'open' | 'applied' | 'declined' | 'superseded' | 'closed';
  wording_only: boolean;
  note: string;
  created_at: number;
  decided_at: number | null;
  fields: { field: 'title' | 'summary' | 'body' | 'tags' | 'section'; before: string; after: string }[];
  stale: { field: 'title' | 'summary' | 'body' | 'tags' | 'section'; was: string; now: string }[];
};
/** The Spec side of a task page. */
export type TaskSpec = {
  implements: { id: string; kind: Doc['kind']; title: string; status: Doc['status']; summary: string }[];
  changes: { doc: { id: string; kind: string; title: string; removed: boolean }; isNew: boolean; before: DocSnapshot; after: DocSnapshot | null; at: number; by: string }[];
};
export type DocLink = { doc_id: string; task_id: string; relation: 'implements' | 'changed' | 'discusses'; revision_id: number | null; created_at: number };
/** A file the user attached (server/attachments.ts attachmentView). */
export type Attachment = {
  id: string;
  name: string;
  mime: string;
  kind: 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'file';
  size: number;
  url: string;
  created_at: number;
  removable?: boolean;
  project_id?: string;
  /** The agent that attached it (attach_reference); absent when the user did. */
  added_by?: string | null;
  caption?: string;
  /** Sent as image feedback (annotate.tsx): the marked-up PNG or the original beside it. */
  annotation?: { id: string; role: 'marked' | 'original' };
};
export type InboxItem = {
  id: string;
  project_id: string;
  agent_id: string | null;
  /** action: something to do outside Helm ("To do"), answered Done or Can't / not yet. */
  kind: 'question' | 'action' | 'permission' | 'structure';
  title: string;
  body: string;
  options: { label: string; detail?: string }[];
  /** wants: the agent asked the user to provide a file or image (ask_user's wants); the answer leads with Attach. */
  payload: { recommendation?: string; previews?: string[]; wants?: 'file' | 'image'; steps?: string; after?: string; from_needs?: boolean; toolName?: string; input?: string; blockedPath?: string; canAlways?: boolean; reason?: string; base?: Structure; proposed?: Structure; danger?: string; dangerReasons?: string[]; triage?: { route?: string; passed?: string; by?: string; fell?: string } };
  /** For a permission: who decided ('user', or on the user's behalf 'auto'; server/triage.ts) and why. */
  decided_by?: string | null;
  decision_reason?: string;
  /** While it waits on the director: how many of the project's requests do, and when the oldest arrived. */
  director_queue?: { count: number; oldest: number };
  importance: number;
  blocking: number;
  /** 'director': waiting on the director; 'check': the independent check of the director's own request. Neither needs the user, though the user may answer. */
  status: 'open' | 'answered' | 'dismissed' | 'director' | 'check';
  answer: string;
  created_at: number;
  answered_at: number | null;
  /** The previews the agent attached (payload.previews), resolved by the server; removed ones are left out. */
  previews: Preview[];
  project_name?: string;
  agent_name?: string;
  task_id?: string | null;
  task_title?: string | null;
  /** What it is about in one line: a permission's tool and command or path, else the title. */
  line: string;
};
export type Preview = {
  id: string;
  agent_id: string | null;
  kind: string;
  title: string;
  caption: string;
  file: string | null;
  content: string | null;
  created_at: number;
  task_id?: string | null;
  project_id?: string;
  /** Image feedback the user sent on it, newest first (annotate.tsx). */
  feedback?: { id: string; side: string; created_at: number }[];
};
export type JournalEntry = { id: number; agent_id: string | null; kind: string; phase: string; title: string; body: string; ts: number; task_id?: string | null };

export type TaskState = 'planning' | 'waiting' | 'scheduled' | 'active' | 'paused' | 'done' | 'dropped';
export type DiscussionState = 'open' | 'settled';
/** A link between a discussion and a task that came out of it. */
export type ThreadLink = { id: string; title: string; state: TaskState | DiscussionState; kind?: 'task' | 'discussion' };
export type Task = {
  id: string;
  project_id: string;
  /** Discussions share the tasks table: kind 'discussion' with state open or settled. */
  kind?: 'task' | 'discussion';
  conclusion?: string;
  /** For a task made separately from a discussion: that discussion (or the task it became). */
  discussions?: ThreadLink[];
  /** Further tasks made separately from this one's discussion. */
  tasks?: ThreadLink[];
  /** When a discussion became this task in place; the timeline before it is the discussion. */
  became_task_at?: number | null;
  title: string;
  description: string;
  state: TaskState;
  position: number;
  doc_id: string | null;
  driver_agent_id: string | null;
  origin: 'user' | 'director' | 'doc' | 'report' | 'away';
  /** For a task found while the user was away: what was found and what triggered it. */
  origin_note?: string;
  importance: number;
  importance_reason: string;
  importance_pinned: number;
  status_summary: string;
  summary_at: number | null;
  created_at: number;
  updated_at: number;
  driver: Pick<Agent, 'id' | 'name' | 'status' | 'status_line' | 'progress' | 'checklist'> | null;
  doc: { id: string; kind: Doc['kind']; title: string; status: Doc['status'] } | null;
  /** Every goal or design it serves, the main one included. */
  docs?: { id: string; kind: Doc['kind']; title: string; status: Doc['status'] }[];
  last: { author: 'user' | 'director' | 'system'; author_name: string; body: string; created_at: number } | null;
  thumb: Preview | null;
  /** Needs response: open requests to the user on it (derived on the server), whether any blocks an agent, and the requests. */
  needs_response: number;
  needs_blocking: boolean;
  requests: InboxItem[];
  /** Files attached to it and to its thread (server/attachments.ts). */
  attach_count?: number;
  /**
   * Time worked (ms; computed on the server, branch sessions): first time it became active, when it finished,
   * accumulated active time over completed stretches, and the start of the current stretch (null when not active).
   */
  started_at?: number | null;
  finished_at?: number | null;
  active_ms?: number | null;
  active_since?: number | null;
  /** Its driver finished while it is Active: waiting for the director to review it (server/taskwatch.ts). */
  awaiting_review?: boolean;
  review_agent?: string | null;
  /** Active, but nobody has worked on it for a while. */
  stalled?: boolean;
  /** What it needs from the user, as the director wrote it (update_task needs_from_user), and the request carrying it. */
  needs_from_user?: string | null;
  needs_request_id?: string | null;
  /** It says it needs the user (summary, last post or needs_from_user) but no request is open: the sentence that says so. */
  waiting_on_user_without_request?: boolean;
  unfiled_need?: string | null;
  /** For a standing request holder: whose requests these are and what that agent is doing. */
  holder?: RequestHolder | null;
  /** The old Inbox's archive of answered requests (a request holder, not a discussion). */
  inbox_archive?: number;
  /** Its pinned proposal in brief, for list rows (server/pins.ts proposalSummary). */
  proposal?: ProposalSummary | null;
};
export type RequestHolder = { agent_id: string; agent_name: string; task_id?: string | null; context: string };
/** One pinned item: a preview or an attachment, with its one-line label. */
export type PinnedItem = { pin_id: number; item_id: string; label: string; round: number; position: number; pinned_by: string; pinned_at: number; preview?: Preview; attachment?: Attachment };
/** One round of a pinned proposal: its items, the question, the linked request and the choice once made. */
export type ProposalRound = { round: number; question: string; request: InboxItem | null; choice: { text: string; pin_id: number | null; at: number } | null; items: PinnedItem[] };
export type PinnedProposal = ProposalRound & { earlier: ProposalRound[] };
export type ProposalSummary = { round: number; count: number; waiting: boolean; chosen: string | null; thumbs: { label: string; url: string | null; kind: string }[] };
/** One entry in a task's history (see taskTimeline on the server). */
export type TimelineItem =
  | { key: string; ts: number; type: 'message' | 'summary' | 'state' | 'change' | 'spec' | 'proposal'; author: 'user' | 'director' | 'system'; name: string; body: string; filed?: boolean; interject?: boolean; attachments?: Attachment[] }
  | { key: string; ts: number; type: 'question'; inbox_id: string; request?: InboxItem }
  | { key: string; ts: number; type: 'answer'; title: string; status: string; body: string; attachments?: Attachment[] }
  | { key: string; ts: number; type: 'preview'; preview: Preview }
  | { key: string; ts: number; type: 'journal'; kind: string; title: string; body: string; name: string }
  | { key: string; ts: number; type: 'consult'; kind: 'question' | 'review'; asker: string; manager: string; question: string; status: 'open' | 'answered' | 'dropped'; answer: string; verdict: 'accepted' | 'changes_needed' | null; answered_at: number | null };
/** An open question or review request from an agent to its manager (server/consults.ts). */
export type OpenConsult = { id: string; asker_id: string; manager_id: string; task_id: string | null; kind: 'question' | 'review'; blocking: number; created_at: number };
/** The discussion a separately made task came from, with its discussion-era timeline (read-only). */
export type Origin = { id: string; title: string; kind: 'task' | 'discussion'; state: TaskState | DiscussionState; timeline: TimelineItem[] };
/** A notable change on a task (notableChange in server/tasks.ts); `key` is the history entry it jumps to. */
export type TaskChange = { key: string; ts: number; kind: string; text: string };
export type TaskDetail = { task: Task; agents: Agent[]; latest: Preview[]; proposal?: PinnedProposal | null; timeline: TimelineItem[]; reports?: Report[]; spec?: TaskSpec; origins?: Origin[]; changes?: TaskChange[]; periods?: Boundary[] };
/** A discussion as listed: a question or idea kept as a thread (see server/discussions.ts). */
export type Discussion = Omit<Task, 'state' | 'kind'> & {
  /** 'task' only in search results: a discussion that has since become a task (state is then the task's). */
  kind: 'discussion' | 'task';
  state: DiscussionState;
  conclusion: string;
  messages: number;
  tasks: ThreadLink[];
  last_active: number;
  /** Open, with no activity of any kind for the project's cold period. Derived on the server, never stored. */
  cold: boolean;
};
/** A user message in the director conversation that was filed under a discussion (or task). */
export type FiledLink = { event_id: number; id: string; title: string; kind: 'task' | 'discussion' };
export type HostClaim = {
  id: string;
  host_id: string;
  agent_id: string;
  agent_name: string;
  project_id: string;
  project_name: string;
  activity: string;
  created_at: number;
  updated_at: number;
};
/** A machine projects can use. check_state: online, offline (unreachable), login (reachable, SSH login refused), unknown. */
export type Host = {
  id: string;
  name: string;
  ssh_target: string;
  port: number | null;
  purpose: string;
  notes: string;
  exclusive: number;
  is_local: number;
  check_state: 'online' | 'offline' | 'login' | 'unknown';
  check_error: string;
  load: string;
  cpus: number | null;
  checked_at: number | null;
  checking: boolean;
  projects: { id: string; name: string }[];
  claims: HostClaim[];
};
/** HANDOFF.md at the project root (server/handoff.ts); offer says whether the Overview offers it to the director. */
export type ProjectHandoff = { file: { name: string; mtime: number; size: number } | null; offer: 'new' | 'updated' | null };
export type ProjectState = {
  project: Project;
  /** Server default for cold_days (HELM_COLD_DAYS, else 14). */
  coldDaysDefault?: number;
  /** Server default for session_idle_minutes. */
  idleMinutesDefault?: number;
  /** Whether the user is in a session or away, and what the director has running (server/sessions.ts). */
  presence?: Presence;
  /** Active tasks needing the director's attention: stalled, or finished by their driver and awaiting review. */
  attention?: { stalled: number; awaiting_review: number };
  handoff?: ProjectHandoff;
  agents: Agent[];
  docs: Doc[];
  inbox: InboxItem[];
  previews: Preview[];
  journal: JournalEntry[];
  tasks: Task[];
  discussions: Discussion[];
  /** Standing holders of task-less agents' permission requests with requests pending (server/requests.ts); never listed as discussions. */
  request_holders?: Discussion[];
  /** Every request holder (standing holders and the old Inbox archive), for History. */
  request_records?: { id: string; title: string; state: string; inbox_archive: number }[];
  filed: FiledLink[];
  hosts: Host[];
  reports: ReportSummary;
  consults?: OpenConsult[];
  sections: DocSection[];
  /** Links between Spec entries and tasks or discussions (tasks.doc_id is mirrored as an implements link). */
  docLinks: DocLink[];
  /** Owner edits waiting for the quiet period to end, and when it does. */
  pending: { count: number; dueAt: number | null };
  quietSeconds: number;
  /** Importance budgets over open goals and designs, and over open tasks. */
  budget: Budget;
  taskBudget: Budget;
  limits: ImportanceLimits;
  /** The latest importance change of anything changed in the last day and a half. */
  importanceRecent: ImportanceChange[];
};
export type AgentEvent = { id: number; agent_id: string; ts: number; kind: string; data: any };
export type Template = { id: string; name: string; description: string; structure: Structure };
export type Meta = { templates: Template[]; models: { id: string; label: string }[]; projectsRoot: string; home: string };

// ---------- fetch ----------

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && !path.startsWith('/api/login')) onUnauthorized();
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

// ---------- live stream ----------

type StreamMsg =
  | { type: 'projects' }
  | { type: 'hosts' }
  | { type: 'toolbox' }
  | { type: 'disk' }
  | { type: 'project'; projectId: string }
  | { type: 'event'; projectId: string; agentId: string; event: AgentEvent }
  | { type: 'reconnect' };

const listeners = new Set<(m: StreamMsg) => void>();
let source: EventSource | null = null;

function ensureStream() {
  if (source) return;
  source = new EventSource('/api/stream');
  let dropped = false;
  source.onmessage = (e) => {
    const msg = JSON.parse(e.data) as StreamMsg;
    listeners.forEach((fn) => fn(msg));
  };
  source.onerror = () => {
    dropped = true;
  };
  source.onopen = () => {
    // Anything may have changed while we were disconnected (phone asleep).
    if (dropped) listeners.forEach((fn) => fn({ type: 'reconnect' }));
    dropped = false;
  };
}

export function closeStream() {
  source?.close();
  source = null;
}

export function useStream(fn: (m: StreamMsg) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ensureStream();
    const l = (m: StreamMsg) => ref.current(m);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

/** Fetch a resource and refetch it (at most every 250 ms) when `shouldRefresh` matches a stream message. */
export function useLive<T>(path: string | null, shouldRefresh: (m: StreamMsg) => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const pathRef = useRef(path);
  pathRef.current = path;

  const load = useCallback(async () => {
    const p = pathRef.current;
    if (!p) return;
    try {
      const d = await api<T>(p);
      if (pathRef.current === p) {
        setData(d);
        setError(null);
      }
    } catch (err: any) {
      if (pathRef.current === p) setError(err.message);
    }
  }, []);

  useEffect(() => {
    setData(null);
    setError(null);
    void load();
  }, [path, load]);

  useStream((m) => {
    if (m.type !== 'reconnect' && !shouldRefresh(m)) return;
    if (timer.current) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void load();
    }, 250);
  });

  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && void load();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [load]);

  return { data, error, reload: load };
}

/**
 * Whether a live event belongs in the conversation view (see listDialogue in server/turns.ts):
 * what the user said, replies to it, notes and errors. Turns started by agents or Helm stay out.
 */
function inConversation(e: AgentEvent): boolean {
  if (e.kind === 'inbound') return e.data?.from?.kind === 'user';
  if (e.kind === 'result') return !e.data?.ok || e.data?.dialogue !== false;
  return e.kind === 'note' || e.kind === 'error';
}

/**
 * An agent's transcript, live. `view: 'conversation'` keeps only what was said to
 * the agent and its end-of-turn replies. A null id loads nothing.
 */
export function useAgentEvents(agentId: string | null, view: 'all' | 'conversation' = 'all') {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(true);
  const page = view === 'conversation' ? 60 : 200;
  const url = (before?: number) => `/api/agents/${agentId}/events?limit=${page}${view === 'conversation' ? '&view=conversation' : ''}${before ? `&before=${before}` : ''}`;

  useEffect(() => {
    let live = true;
    setEvents([]);
    setLoaded(!agentId);
    setMore(!!agentId);
    if (!agentId) return;
    api<{ events: AgentEvent[] }>(url()).then((d) => {
      if (!live) return;
      setEvents((cur) => merge(d.events, cur));
      setMore(d.events.length === page);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [agentId, view]);

  useStream((m) => {
    if (!agentId) return;
    if (m.type === 'event' && m.agentId === agentId && (view === 'all' || inConversation(m.event))) setEvents((cur) => merge(cur, [m.event]));
    if (m.type === 'reconnect') api<{ events: AgentEvent[] }>(url()).then((d) => setEvents((cur) => merge(cur, d.events)));
  });

  const loadOlder = useCallback(async () => {
    const first = events[0];
    if (!first || !agentId) return;
    const d = await api<{ events: AgentEvent[] }>(url(first.id));
    setEvents((cur) => merge(d.events, cur));
    setMore(d.events.length === page);
  }, [agentId, view, events]);

  return { events, loaded, more, loadOlder };
}

function merge(a: AgentEvent[], b: AgentEvent[]): AgentEvent[] {
  const seen = new Map<number, AgentEvent>();
  for (const e of a) seen.set(e.id, e);
  for (const e of b) seen.set(e.id, e);
  return [...seen.values()].sort((x, y) => x.id - y.id);
}

// ---------- reports ----------

export type ReportStatus = 'new' | 'needs_input' | 'in_progress' | 'fixed' | 'dismissed' | 'duplicate';
export type SourceMode = 'act' | 'triage' | 'collect';
export type SourceType = 'github-issues' | 'folder' | 'command';
export type ReportAttachment = { file: string; name: string; kind: 'image' | 'file'; size: number };
export type Report = {
  id: string;
  project_id: string;
  source_id: string;
  external_id: string;
  url: string;
  title: string;
  body: string;
  fields: Record<string, unknown>;
  attachments: ReportAttachment[];
  author: string;
  source_created_at: number | null;
  source_updated_at: number | null;
  status: ReportStatus;
  duplicate_of: string | null;
  task_id: string | null;
  triage_note: string;
  changed_at: number;
  created_at: number;
  updated_at: number;
  source: { id: string; name: string; type: SourceType; mode: SourceMode; label: string } | null;
  task: { id: string; title: string; state: TaskState } | null;
  duplicate: { id: string; title: string } | null;
};
export type ReportSource = {
  id: string;
  project_id: string;
  type: SourceType;
  name: string;
  config: Record<string, any>;
  mode: SourceMode;
  allow_write_back: number;
  enabled: number;
  interval_seconds: number;
  last_poll_at: number | null;
  last_ok_at: number | null;
  last_error: string;
  last_count: number | null;
  label: string;
  where: string;
  polling: boolean;
  reports: number;
  new: number;
  needs_input: number;
  quiet_imported: number;
};
export type ReportSummary = { total: number; new: number; needs_input: number; in_progress: number; sources: number; failing: number };
export type SourcePreview = {
  error?: string;
  total?: number;
  skipped?: string[];
  items?: { id: string; title: string; body: string; fields: Record<string, unknown>; images: string[]; warnings: string[]; url: string; updated: number | null }[];
};
