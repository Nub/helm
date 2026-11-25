import type { ModeView } from './projectmode';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
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
/** A project's roles: its director and the builder Helm starts per task (server/structure.ts). */
export type Structure = {
  root: string;
  roles: Role[];
  maxAgents: number;
};
/** GET /api/projects/:id/team: what Helm generates for each role. */
export type TeamDetails = {
  roles: { id: string; sample: { id: string; name: string } | null; systemPrompt: string; tools: { name: string; description: string }[] }[];
  extras: { mcpServers: string[]; hiddenBuiltins: string[]; settingSources: string[]; installed: { kind: string; name: string }[] };
  /**
   * Who computed it when Helm runs split (server/runner.ts): 'runner', what agents get; 'dashboard', the web service's
   * own build, because the runner did not answer (it is restarting). null: one process.
   */
  from?: 'runner' | 'dashboard' | null;
  runnerRev?: string;
  dashboardRev?: string;
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
  /** Scheduled and active tasks (queued work). */
  queued?: number;
  progress: number | null;
  /** Open requests to the user (needs response) in this project. */
  openInbox: number;
  /** Agents stopped with an error and not running again (server/agenterrors.ts). */
  errored?: number;
  /** Tasks that say they need the user while nothing is filed (no open request). */
  unfiledNeeds?: number;
  /** running (Autopilot), queue_only, winding_down (Finish up), at_rest or stopped (server/projectmode.ts). */
  mode?: string;
  statusLine: string;
};
export type ChecklistItem = { id: number; text: string; state: 'todo' | 'doing' | 'done' | 'blocked' | 'dropped' };
export type Agent = {
  /** On a task's detail: whether this is the agent's current task (else only this task's worklist is shown). */
  on_task?: boolean;
  /** On a task's detail: the tool call it is in now, with when it started (server/store.ts currentTool). */
  current_tool?: { name: string; summary: string; since: number } | null;
  /** Idle between model turns but with work in hand (server/busy.ts): shown Working, status_line says what it waits on. */
  busy_between_turns?: number;
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
  /** Tokens its turns used: input + output + cache writes (server/usage.ts). */
  tokens?: number;
  /** The tier it runs at now and that tier's model and effort ('' = default), as the runtime sets them (server/store.ts runningTier). */
  run_tier?: string;
  run_tier_name?: string;
  run_model?: string;
  run_effort?: string;
  turns: number;
  created_at: number;
  updated_at: number;
  checklist: ChecklistItem[];
  /** A resume Helm will make when a usage limit resets (server/agenterrors.ts): when, and the server's words for it ("Resumes Fri 4:01 am"). */
  resume_at?: number | null;
  resume_text?: string | null;
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
/** The Ideas board (server/ideas.ts cardView, frameView). Positions and sizes are board units. */
export type IdeaCard = {
  id: string;
  kind: 'note' | 'link' | 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  frame_id: string | null;
  /** A note's markdown; a link's title. */
  text: string;
  url: string | null;
  site: string | null;
  image: Attachment | null;
  /** A link whose title and image are still being fetched. */
  fetching: boolean;
  author: string;
};
export type IdeaFrame = { id: string; name: string; x: number; y: number; w: number; h: number; discussion: { id: string; title: string; state: string } | null };
export type IdeasBoard = { cards: IdeaCard[]; frames: IdeaFrame[] };
export type InboxItem = {
  id: string;
  project_id: string;
  agent_id: string | null;
  /** action: something to do outside Helm ("To do"), answered Done or Can't / not yet. */
  /** agent_error: an agent stopped with an error (server/agenterrors.ts), answered Resume, Ask the director or Close the agent. */
  kind: 'question' | 'action' | 'permission' | 'structure' | 'agent_error';
  title: string;
  body: string;
  options: { label: string; detail?: string }[];
  /** wants: the agent asked the user to provide a file or image (ask_user's wants); the answer leads with Attach. */
  payload: { recommendation?: string; previews?: string[]; wants?: 'file' | 'image'; steps?: string; after?: string; from_needs?: boolean; toolName?: string; input?: string; blockedPath?: string; canAlways?: boolean; reason?: string; base?: Structure; proposed?: Structure; danger?: string; dangerReasons?: string[]; triage?: { route?: string; passed?: string; by?: string; fell?: string }; error_kind?: string; plain?: string; raw?: string; count?: number; last_at?: number; resets_at?: number | null; doing?: string; root?: boolean; can_wait?: boolean; limit_peers?: number; resumes_text?: string; act?: { kind: string; target?: string; option?: string }; asked_again?: { root: string; first_at: number; count: number }; test_build?: string; spec_cards?: string[]; spec_open?: number };
  /** For a permission: who decided ('user', or on the user's behalf 'auto'; server/triage.ts) and why. */
  decided_by?: string | null;
  decision_reason?: string;
  /** While it waits on the director: how many of the project's requests do, and when the oldest arrived. */
  director_queue?: { count: number; oldest: number };
  importance: number;
  blocking: number;
  /** 'director': waiting on the director; 'check': the independent check of the director's own request. Neither needs the user, though the user may answer. */
  /** withdrawn: the agent took it back (its reason in answer); held ones (filed mid-turn) never reach the page. */
  status: 'open' | 'answered' | 'dismissed' | 'director' | 'check' | 'withdrawn';
  answer: string;
  created_at: number;
  answered_at: number | null;
  /** The previews the agent attached (payload.previews), resolved by the server; removed ones are left out. */
  previews: Preview[];
  project_name?: string;
  agent_name?: string;
  task_id?: string | null;
  task_title?: string | null;
  /** task or discussion: which page its thread is on. */
  task_kind?: string | null;
  /** Answered "not now": when Helm asks again (server/reminders.ts), while that is pending. */
  reminder?: { id: string; due_text: string | null; due_at: number | null } | null;
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
  /** Its latest version's number (server/store.ts addPreview): earlier ones via /api/previews/:id/versions. */
  version?: number;
};
export type JournalEntry = { id: number; agent_id: string | null; kind: string; phase: string; title: string; body: string; ts: number; task_id?: string | null };

export type TaskState = 'planning' | 'waiting' | 'scheduled' | 'active' | 'paused' | 'done' | 'dropped';
export type DiscussionState = 'open' | 'stale' | 'settled' | 'archived';
/** A link between a discussion and a task that came out of it. */
export type ThreadLink = { id: string; title: string; state: TaskState | DiscussionState; kind?: 'task' | 'discussion' };
export type Task = {
  /** 1: marked "Review before it lands" (server/builder.ts isRisky); review is opt-in. */
  risky?: number | null;
  /** The task it was merged into (server/merge.ts) and its title; the reports it is for. */
  merged_into?: string | null;
  merged_into_title?: string | null;
  report_count?: number;
  /** Active, nobody on it, while the project winds down or is stopped (server/projectmode.ts): shown as held. */
  held?: boolean;
  id: string;
  project_id: string;
  /** Discussions share the tasks table: kind 'discussion' with state open or settled. */
  kind?: 'task' | 'discussion';
  conclusion?: string;
  /** For a task made separately from a discussion: that discussion (or the task it became). */
  discussions?: ThreadLink[];
  /** How many parts it has (server/taskparts.ts): "N parts" by the title when more than one. */
  parts?: number;
  /** A discussion opened to find this task's Spec entry: the task (server/specdiscuss.ts). */
  about?: ThreadLink | null;
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
  /** 1 while the user wants one notification when it finishes (server/bell.ts). */
  bell?: number;
  /** Its work tier and why the director chose it (server/tiers.ts, workrules.ts). */
  tier?: string | null;
  tier_reason?: string | null;
  /** 1 once the user set its tier (the task page): agents may not change it. */
  tier_pinned?: number;
  /** JSON list of the files or globs it will change (create_task touches). */
  touches?: string;
  /** Open tasks it waits for, and open tasks waiting for it (server/waits.ts). */
  waits_for?: { id: string; title: string; state: string }[];
  blocks?: { id: string; title: string; state: string }[];
  status_summary: string;
  summary_at: number | null;
  created_at: number;
  updated_at: number;
  /** Tokens its agents used while on it (server/usage.ts). */
  tokens?: number;
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
  /** Work time (server/worktime.ts): never time it waited on you; work_since while it works now. Null: unknown. */
  work_ms?: number | null;
  work_since?: number | null;
  /** Once done: created to done on the clock, and the sentence with its parts. */
  ship_ms?: number | null;
  ship_text?: string;
  /** Its driver finished while it is Active: waiting for the director to review it (server/taskwatch.ts). */
  awaiting_review?: boolean;
  review_agent?: string | null;
  /** Active, but nobody has worked on it for a while. */
  stalled?: boolean;
  /** Why the progress check flagged it (stuck, or costly for its value), or null (server/progress.ts). */
  check?: string | null;
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
/** review: no proposal, these are the automatic "For review" pin's thumbnails (server/pins.ts). */
export type ProposalSummary = { round: number; count: number; waiting: boolean; chosen: string | null; review?: boolean; thumbs: { label: string; url: string | null; kind: string }[] };
/** One entry in a task's history (see taskTimeline on the server). */
export type TimelineItem =
  | { key: string; ts: number; type: 'message' | 'summary' | 'state' | 'change' | 'spec' | 'proposal' | 'recipe' | 'consolidate' | 'findings' | 'entries'; author: 'user' | 'director' | 'system'; name: string; body: string; filed?: boolean; interject?: boolean; attachments?: Attachment[]; conclude?: { task: string; message: number } }
  | { key: string; ts: number; type: 'question'; inbox_id: string; request?: InboxItem }
  | { key: string; ts: number; type: 'answer'; title: string; status: string; body: string; attachments?: Attachment[] }
  | { key: string; ts: number; type: 'preview'; preview: Preview }
  | { key: string; ts: number; type: 'journal'; kind: string; title: string; body: string; name: string }
  | { key: string; ts: number; type: 'consult'; kind: 'question' | 'review'; asker: string; manager: string; question: string; status: 'open' | 'answered' | 'dropped'; answer: string; verdict: 'accepted' | 'changes_needed' | null; answered_at: number | null };
/** An open question or review request from an agent to its manager (server/consults.ts). */
export type OpenConsult = { id: string; asker_id: string; manager_id: string; task_id: string | null; kind: 'question' | 'review'; blocking: number; created_at: number };
/** The discussion a separately made task came from, with its discussion-era timeline (read-only). */
export type Origin = { id: string; title: string; kind: 'task' | 'discussion'; state: TaskState | DiscussionState; timeline: TimelineItem[]; merged?: boolean };
/** A notable change on a task (notableChange in server/tasks.ts); `key` is the history entry it jumps to. */
export type TaskChange = { key: string; ts: number; kind: string; text: string };
/** A shell command running for a task now (server/commands.ts): its plain-words label, the host of a heavy job, when it began. */
export type RunningCommand = { id: string; agent_name: string | null; command: string; label: string; host_name: string | null; background: number; started_at: number; expected_ms: number | null };
export type TaskDetail = { task: Task; agents: Agent[]; commands?: RunningCommand[]; proposal?: PinnedProposal | null; review?: { items: PinnedItem[]; from: number } | null; timeline: TimelineItem[]; reports?: Report[]; spec?: TaskSpec; origins?: Origin[]; changes?: TaskChange[]; periods?: Boundary[]; dashboards?: TaskScope | null; dashboard?: { id: string; title: string; state: string } | null; test_builds?: import('./testbuilds').TestBuild[]; references?: { spec: string[]; related: string[] } | null; parallel?: string | null; status?: import('./taskstatus').TaskStatusData | null; parts?: TaskPart[]; peer?: Discussion['peer'] };
/** A piece of work folded into a task (server/taskparts.ts), with where it came from. */
export type TaskPart = { id: number; title: string; body: string; kind: 'self' | 'task' | 'discussion' | 'message' | 'note'; source: { label: string; ref: string | null; excerpt?: string } };
/** A discussion as listed: a question or idea kept as a thread (see server/discussions.ts). */
export type Discussion = Omit<Task, 'state' | 'kind'> & {
  /** 'task' only in search results: a discussion that has since become a task (state is then the task's). */
  kind: 'discussion' | 'task';
  state: DiscussionState;
  conclusion: string;
  messages: number;
  tasks: ThreadLink[];
  last_active: number;
  /** Open and waiting on the user's reply: a request on it, or the director spoke last (server/discussions.ts). */
  awaiting?: boolean;
  /** Open, with no activity of any kind for the project's cold period. Derived on the server, never stored. */
  cold: boolean;
  /** A thread with another project's director (server/crossproject.ts): who with, which way it started, an unread reply. */
  peer?: { project_id: string; name: string; from: boolean; unread: boolean } | null;
};
/** A cross-project thread with a reply the user has not opened. */
export type CrossThread = { id: string; title: string; peer: string };
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
  /** Clean workspaces (server/hostwork.ts): the root on the host, PATH additions, a setup line, cache variables. */
  work_root?: string;
  work_env?: string;
  work_setup?: string;
  work_caches?: string;
  /** Build folders a slot keeps between jobs, one per line (`CARGO_TARGET_DIR=target`); set: each project gets a slot. */
  work_keep?: string;
  platform?: 'linux' | 'macos' | 'windows';
  /** The last live sample (server/hoststats.ts); null values show "—". */
  stats?: { cpu: number | null; load: string; cpus: number | null; mem: HostUsed | null; disk: HostUsed | null; gpus: { util: number | null; mem: HostUsed | null }[] } | null;
};
export type HostUsed = { used: number; total: number };
/** A job's clean workspace on a host (server/hostwork.ts). */
export type HostWorkspace = { id: string; host_id: string; project_id: string; project: string | null; task_id: string | null; name: string; path: string; commit_sha: string; state: string; bytes: number | null; created_at: number; ended_at: number | null; slot?: number };
/** HANDOFF.md at the project root (server/handoff.ts); offer says whether the Overview offers it to the director. */
export type ProjectHandoff = { file: { name: string; mtime: number; size: number } | null; offer: 'new' | 'updated' | null };
export type ProjectState = {
  /** Old preview ids grouped into another as earlier versions: old id → the preview (server/store.ts). */
  preview_aliases?: Record<string, string>;
  project: Project;
  /** Server default for cold_days (HELM_COLD_DAYS, else 14). */
  coldDaysDefault?: number;
  /** Server default for session_idle_minutes. */
  idleMinutesDefault?: number;
  /** Whether the user is in a session or away, and what the director has running (server/sessions.ts). */
  presence?: Presence;
  /** The project's mode and what it holds (server/projectmode.ts, web/src/projectmode.tsx). */
  mode?: ModeView;
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
  /** Threads with other projects' directors holding an unread reply (server/crossproject.ts). */
  xthreads?: CrossThread[];
  /** Every request holder (standing holders and the old Inbox archive), for History. */
  request_records?: { id: string; title: string; state: string; inbox_archive: number }[];
  filed: FiledLink[];
  hosts: Host[];
  reports: ReportSummary;
  consults?: OpenConsult[];
  sections: DocSection[];
  /** Links between Spec entries and tasks or discussions (tasks.doc_id is mirrored as an implements link). */
  docLinks: DocLink[];
  /** Open Spec Review, Revise and Create discussions (server/specwork.ts); absent from an older server. */
  specWork?: SpecWork[];
  /** Owner edits waiting for the quiet period to end, and when it does. */
  pending: { count: number; dueAt: number | null };
  quietSeconds: number;
  /** Importance budgets over open goals and designs, and over open tasks. */
  budget: Budget;
  taskBudget: Budget;
  limits: ImportanceLimits;
  /** The latest importance change of anything changed in the last day and a half. */
  importanceRecent: ImportanceChange[];
  /** Dashboards (server/dashboards.ts dashboardSummary): on/off, how many, stale tiles, and the tiles pinned to Home. */
  dashboards?: { on: boolean; count: number; stale: number; pinned: Tile[] };
  releases?: { on: boolean; count: number };
  /** Helm's own project: its folder is the live-update repository (server/ownhelm.ts); Ship shows the Helm update for it. */
  own_helm?: boolean;
};
export type AgentEvent = { id: number; agent_id: string; ts: number; kind: string; data: any };
export type Meta = { models: { id: string; label: string }[]; projectsRoot: string; home: string };

// ---------- fetch ----------

export class ApiError extends Error {
  status: number;
  /** The response body, for errors that carry more than a message (needsConfirm). */
  data: any;
  constructor(message: string, status: number, data: any = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

/** An open Spec work discussion and where it stands (a Review counts sections). */
export type SpecWork = { discussion_id: string; mode: 'review' | 'revise' | 'create'; stop: boolean; done: number | null; total: number | null };

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
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status, data);
  return data as T;
}

// ---------- live stream ----------

type StreamMsg =
  | { type: 'projects' }
  | { type: 'hosts' }
  | { type: 'toolbox' }
  | { type: 'disk' }
  | { type: 'runner' }
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

// ---------- live data, cached across pages ----------

/**
 * One cache entry per resource path, shared by every hook that reads it and kept across navigation, so a page seen
 * before shows its last data at once while it is fetched again (stale while revalidate). Concurrent loads of a path
 * share one request; stream signals for it are coalesced into at most one refetch per REFRESH_MS.
 */
type Entry = { data?: unknown; error: string | null; at: number; inflight: Promise<void> | null; timer: number | null; subs: Set<() => void>; used: number };
const cache = new Map<string, Entry>();
/** A burst of stream signals (an agent working) refetches a path at most this often. */
const REFRESH_MS = 1000;
/** Summaries across projects (Needs you, the project list, the plan's usage, counts) change on every project's events: less often. */
const SUMMARY_REFRESH_MS = 3000;
const refreshMs = (path: string) => (/^\/api\/(needs|projects|runner|toolbox\/count|plan|inbox)(\?|$)/.test(path) ? SUMMARY_REFRESH_MS : REFRESH_MS);
/** A path loaded this recently is not loaded again just because another hook mounted on it. */
const FRESH_MS = 1500;
const MAX_ENTRIES = 120;

function entryOf(path: string): Entry {
  let e = cache.get(path);
  if (!e) {
    e = { error: null, at: 0, inflight: null, timer: null, subs: new Set(), used: Date.now() };
    cache.set(path, e);
    // Forget the least recently used paths nobody shows.
    if (cache.size > MAX_ENTRIES) {
      const idle = [...cache].filter(([, x]) => !x.subs.size).sort((x, y) => x[1].used - y[1].used);
      for (const [k] of idle.slice(0, cache.size - MAX_ENTRIES)) cache.delete(k);
    }
  }
  e.used = Date.now();
  return e;
}

function loadPath(path: string): Promise<void> {
  const e = entryOf(path);
  if (e.inflight) return e.inflight;
  e.inflight = api(path)
    .then(
      (d) => {
        e.data = d;
        e.error = null;
      },
      (err: any) => {
        // A failed refetch keeps the last data; the error shows only while there is none.
        e.error = err?.message ?? 'Request failed';
      },
    )
    .finally(() => {
      e.at = Date.now();
      e.inflight = null;
      e.subs.forEach((fn) => fn());
    });
  return e.inflight;
}

/** Load a path ahead of a likely visit (a row the user is about to tap), unless it is cached and fresh. */
export function prefetch(path: string) {
  const e = entryOf(path);
  if (!e.inflight && Date.now() - e.at > FRESH_MS) void loadPath(path);
}

/** A stream signal for a path: one refetch soon, and never more than one per REFRESH_MS however many arrive. */
function scheduleRefresh(path: string) {
  const e = entryOf(path);
  if (e.timer) return;
  const wait = Math.max(250, refreshMs(path) - (Date.now() - e.at));
  e.timer = window.setTimeout(() => {
    e.timer = null;
    void loadPath(path);
  }, wait);
}

/**
 * Fetch a resource and refetch it when `shouldRefresh` matches a stream message. Data already loaded for the path
 * (this page seen before, or another part of the page reading it) shows at once and is refreshed in the background, so
 * a loader shows only the first time a path is ever loaded.
 */
export function useLive<T>(path: string | null, shouldRefresh: (m: StreamMsg) => boolean) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!path) return;
    const e = entryOf(path);
    e.subs.add(rerender);
    if (!e.inflight && Date.now() - e.at > FRESH_MS) void loadPath(path);
    return () => {
      e.subs.delete(rerender);
    };
  }, [path]);

  useStream((m) => {
    if (!path || (m.type !== 'reconnect' && !shouldRefresh(m))) return;
    scheduleRefresh(path);
  });

  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && path && void loadPath(path);
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [path]);

  const reload = useCallback(() => (path ? loadPath(path) : Promise.resolve()), [path]);
  const e = path ? cache.get(path) : undefined;
  return { data: (e?.data as T | undefined) ?? null, error: e && e.data === undefined ? e.error : null, reload };
}

/**
 * Whether a live event belongs in the conversation view (see listDialogue in server/turns.ts):
 * what the user said, replies to it, notes and errors. Turns started by agents or Helm stay out.
 */
function inConversation(e: AgentEvent): boolean {
  if (e.kind === 'inbound') return e.data?.from?.kind === 'user';
  if (e.kind === 'result') return !e.data?.ok || (e.data?.dialogue !== false && !e.data?.replaced);
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
    if (m.type === 'event' && m.agentId === agentId && (view === 'all' || inConversation(m.event))) setEvents((cur) => merge(withReplaced(cur, m.event), [m.event]));
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

/** A reply Helm had the agent rewrite shorter (server/brevity.ts) is marked replaced when the rewrite arrives. */
function withReplaced(cur: AgentEvent[], e: AgentEvent): AgentEvent[] {
  const id = e.kind === 'result' ? e.data?.replaces : undefined;
  return typeof id === 'number' ? cur.map((x) => (x.id === id ? { ...x, data: { ...x.data, replaced: true } } : x)) : cur;
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
  /** What its task fixed, posted when the task was done. */
  fix_note?: string;
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

// ---------- project knowledge (server/knowledge.ts) and per-project settings (server/settings.ts) ----------

export type KnowledgeNote = {
  id: string;
  topic: string;
  title: string;
  body: string;
  paths: string[];
  added_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
  confirmed_at: number | null;
  confirmed_by: string | null;
  added_by_agent: boolean;
  changed_by_agent: boolean;
  /** Confirmed since its last change. */
  confirmed: boolean;
  chars: number;
  /** Given to agents; false when left out because the page is over its budget. */
  included: boolean;
};
export type KnowledgeState = {
  notes: KnowledgeNote[];
  used: number;
  total: number;
  budget: number;
  enabled: boolean;
  /** When the user last opened the Knowledge page. */
  viewed_at: number | null;
  topics: string[];
  limits: { title: number; text: number; lines: number; paths: number; budget: number };
};
/** A switch, or with `choices` a choice of a few values (server/settings.ts). */
export type ProjectSetting = { key: string; label: string; detail: string; default: boolean | string; value: boolean | string; choices?: { value: string; label: string }[] };
export type SettingGroup = { id: string; title: string; description: string; settings: ProjectSetting[] };

// ---------- dashboards (server/dashboards.ts, server/tilescope.ts) ----------

export type TileKind = 'number' | 'chart' | 'table' | 'scores' | 'image' | 'compare' | 'text' | 'page';
export type TileBuilt = { commit: string | null; at: number; agent_id: string | null; agent: string; task_id: string | null };
export type TileStale = { reason: string; task_id: string | null; files: string[]; at: number };
export type TileHistoryEntry = { id: number; data: any; commit: string | null; task_id: string | null; agent_id: string | null; at: number };
export type Tile = {
  id: string;
  dashboard_id: string;
  kind: TileKind;
  title: string;
  caption: string;
  /** Longer notes behind an info tap; the section it is in; its size on the grid; a page tile's stated reason (server/dashrules.ts). */
  info?: string;
  section_id?: string | null;
  size?: 's' | 'm' | 'l';
  page_reason?: string;
  group: string;
  position: number;
  pinned: number;
  expensive: boolean;
  deps: { paths: string[]; docs: string[]; tags: string[] };
  recipe: { command: string; cwd: string; host?: string; duration?: string; notes?: string } | null;
  data: any;
  built: TileBuilt | null;
  stale: TileStale | null;
  error: { message: string; at: number; agent: string } | null;
  asked_at: number | null;
  history_count: number;
  /** Numbers: the last 30 values (a trend); with ?history (GET /api/tiles/:id) every kept entry. */
  history: TileHistoryEntry[];
};
export type Dashboard = {
  id: string;
  title: string;
  description: string;
  state: 'building' | 'ready';
  task: { id: string; title: string; state: string } | null;
  position: number;
  created_at: number;
  ready_at: number | null;
  /** Titled sections in order; a sub-section has parent_id (one level). */
  sections?: { id: string; title: string; parent_id: string | null; position: number }[];
  /** Series named once, each with a palette colour (1 to 8). */
  key?: { name: string; color: number }[];
  tiles: Tile[];
};
export type TaskScope = {
  rows: { tile_id: string; tile: string; kind: string; dashboard_id: string; dashboard: string; status: string; reason: string; files: string[]; docs: string[]; at: number }[];
  reviews: { agent_name: string; decision: string; note: string; changes: string[]; created_at: number }[];
};
