import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.ts';
import { SEARCH_SCHEMA_VERSION, SEARCH_TABLES_SQL, searchSchemaSql } from './searchschema.ts';

export const db = new DatabaseSync(join(DATA_DIR, 'helm.db'));
// Two processes may share this file (the runner and the web service, server/runner.ts). WAL lets readers run beside
// the one writer; busy_timeout makes a writer wait for the other's write instead of failing. synchronous NORMAL is
// safe in WAL (a power cut may lose the last commits, never corrupt the file) and saves an fsync per small write.
// Switching a new file to WAL needs a moment's exclusive lock; when the other process is creating the same file at that
// moment SQLite answers "database is locked" without waiting on busy_timeout, so the switch is retried for a while.
db.exec('PRAGMA busy_timeout = 5000;');
for (let tries = 0; ; tries++) {
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    break;
  } catch (err: any) {
    if (err?.errcode !== 5 || tries >= 100) throw err;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
}
db.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');

// The schema and its migrations run in one write transaction (committed at the end of this file), so two processes
// starting together do not race: the second waits, then finds everything done. If anything throws, the process
// exits and the transaction is rolled back with it. Migrations stay additive (new tables and columns only), so a
// process one version older keeps working against a database the newer one migrated.
db.exec('BEGIN IMMEDIATE');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT 'Setup',
  autonomy TEXT NOT NULL DEFAULT 'auto',
  structure TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT,
  role_id TEXT NOT NULL,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',
  status_line TEXT NOT NULL DEFAULT '',
  progress INTEGER,
  session_id TEXT,
  last_result TEXT NOT NULL DEFAULT '',
  cost_usd REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_project ON agents(project_id);
CREATE TABLE IF NOT EXISTS checklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'todo',
  sort INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checklist_agent ON checklist(agent_id, sort);
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  importance INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'active',
  author TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_project ON docs(project_id);
CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  payload TEXT NOT NULL DEFAULT '{}',
  importance INTEGER NOT NULL DEFAULT 3,
  blocking INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_project ON inbox(project_id, status);
CREATE TABLE IF NOT EXISTS previews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  file TEXT,
  content TEXT,
  source TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS previews_project ON previews(project_id, created_at);
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_project ON journal(project_id, ts);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, id);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'waiting',
  position INTEGER NOT NULL DEFAULT 0,
  doc_id TEXT,
  driver_agent_id TEXT,
  origin TEXT NOT NULL DEFAULT 'user',
  status_summary TEXT NOT NULL DEFAULT '',
  summary_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id, position);
CREATE TABLE IF NOT EXISTS task_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'message',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_messages_task ON task_messages(task_id, id);
CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  ssh_target TEXT NOT NULL DEFAULT '',
  port INTEGER,
  purpose TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  exclusive INTEGER NOT NULL DEFAULT 0,
  is_local INTEGER NOT NULL DEFAULT 0,
  check_state TEXT NOT NULL DEFAULT 'unknown',
  check_error TEXT NOT NULL DEFAULT '',
  load TEXT NOT NULL DEFAULT '',
  cpus INTEGER,
  checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_hosts (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, host_id)
);
CREATE INDEX IF NOT EXISTS project_hosts_host ON project_hosts(host_id);
CREATE TABLE IF NOT EXISTS host_claims (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  activity TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (host_id, agent_id)
);
CREATE INDEX IF NOT EXISTS host_claims_agent ON host_claims(agent_id);
CREATE TABLE IF NOT EXISTS toolbox_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  summary TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '{}',
  pin TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL DEFAULT '',
  install_hash TEXT NOT NULL DEFAULT '',
  install_path TEXT NOT NULL DEFAULT '',
  launch TEXT NOT NULL DEFAULT '{}',
  review TEXT NOT NULL DEFAULT '{}',
  proposal TEXT NOT NULL DEFAULT '{}',
  installable INTEGER NOT NULL DEFAULT 1,
  not_installable_reason TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'agent',
  proposed_by_agent TEXT,
  proposed_in_project TEXT,
  scope TEXT NOT NULL DEFAULT 'all',
  decided_note TEXT NOT NULL DEFAULT '',
  decided_at INTEGER,
  error TEXT NOT NULL DEFAULT '',
  integrity TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS toolbox_items_status ON toolbox_items(status);
CREATE TABLE IF NOT EXISTS toolbox_scope (
  item_id TEXT NOT NULL REFERENCES toolbox_items(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (item_id, project_id)
);
CREATE TABLE IF NOT EXISTS toolbox_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES toolbox_items(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS toolbox_messages_item ON toolbox_messages(item_id, id);
CREATE TABLE IF NOT EXISTS report_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'act',
  allow_write_back INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  interval_seconds INTEGER NOT NULL DEFAULT 300,
  cursor TEXT NOT NULL DEFAULT '',
  last_poll_at INTEGER,
  last_ok_at INTEGER,
  last_error TEXT NOT NULL DEFAULT '',
  last_count INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS report_sources_project ON report_sources(project_id);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES report_sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '{}',
  attachments TEXT NOT NULL DEFAULT '[]',
  author TEXT NOT NULL DEFAULT '',
  source_created_at INTEGER,
  source_updated_at INTEGER,
  content_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  duplicate_of TEXT,
  task_id TEXT,
  triage_note TEXT NOT NULL DEFAULT '',
  pending_delivery INTEGER NOT NULL DEFAULT 0,
  changed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS reports_project ON reports(project_id, status, changed_at);
CREATE INDEX IF NOT EXISTS reports_task ON reports(task_id);
`);

/** Add a column to a table created by an older version, once. */
function addColumn(table: string, column: string, decl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  } catch (err) {
    // The runner and the web service start together on one database: the other may have added it meanwhile.
    if (!/duplicate column name/i.test(String((err as Error).message))) throw err;
  }
}
// The host an agent's own process runs on; null means this machine. Separate from the hosts it uses over SSH.
addColumn('agents', 'run_host_id', 'TEXT');
// The user's bell on a task: notify once when it finishes (bell.ts).
addColumn('tasks', 'bell', 'INTEGER NOT NULL DEFAULT 0');
// When the agent became done or closed (NULL while it is not): the disk guard waives its one-hour rule only for
// folders untouched since then (server/diskusage.ts).
addColumn('agents', 'finished_at', 'INTEGER');
// When Helm resumes an agent stopped by a usage limit, as the user asked (agenterrors.ts); null when nothing is scheduled.
addColumn('agents', 'resume_at', 'INTEGER');
// The agent's own last activity (text, tool call, tool result, end of turn): a folder changed after it was not changed
// by that agent (server/diskusage.ts).
addColumn('agents', 'active_at', 'INTEGER');
// Reports: 1 = the first full read of a source is still to decide whether its existing backlog is announced,
// 2 = reading a large backlog quietly, 0 = caught up. quiet_imported counts reports brought in without telling the director.
addColumn('report_sources', 'backfill', 'INTEGER NOT NULL DEFAULT 1');
addColumn('report_sources', 'quiet_imported', 'INTEGER NOT NULL DEFAULT 0');
// Tasks: what an inbox question, an agent, a preview or a journal entry belongs to.
for (const table of ['inbox', 'agents', 'previews', 'journal']) {
  addColumn(table, 'task_id', 'TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS ${table}_task ON ${table}(task_id)`);
}
// Toolbox: which items the agent's last process start loaded, skipped or failed (JSON).
addColumn('agents', 'toolbox_loaded', "TEXT NOT NULL DEFAULT ''");
// 1 for a quick helper started with quick_job: it works for its parent (the caller) and Helm closes it when its job ends.
addColumn('agents', 'quick', 'INTEGER NOT NULL DEFAULT 0');
// The running token total its session's last result reported (usage.ts): each turn records what it added.
addColumn('agents', 'usage_seen', 'INTEGER NOT NULL DEFAULT 0');

// Discussions are rows in tasks with kind 'discussion' (states open/settled), so threads, previews and inbox links work for both.
addColumn('tasks', 'kind', "TEXT NOT NULL DEFAULT 'task'");
// For a settled discussion: what was concluded, shown at the top of its page.
addColumn('tasks', 'conclusion', "TEXT NOT NULL DEFAULT ''");
// A message filed into a thread from the director conversation keeps the id of the original event.
addColumn('task_messages', 'event_id', 'INTEGER');
// The user's message on an active task sent as an interjection: the director acts on it at once (taskapi.ts).
addColumn('task_messages', 'interject', 'INTEGER NOT NULL DEFAULT 0');
// The director's post in an open discussion proposing its conclusion: it shows a Conclude button (discussions.ts).
addColumn('task_messages', 'conclude', 'INTEGER NOT NULL DEFAULT 0');
// A discussion opened to find the Spec entry for a task ("No Spec entry · Discuss", specdiscuss.ts): that task's id.
addColumn('tasks', 'about_task', 'TEXT');
// The "## Done when" items an agent ticked (update_task done_when): JSON array of 1-based numbers (taskstatus.ts).
addColumn('tasks', 'done_when_ticks', 'TEXT');
// Why the task's named check was not run when it was finished (complete_task / finish_task check_not_run), or NULL.
addColumn('tasks', 'check_not_run', 'TEXT');
// Discussion reminders (discrevisit.ts): reminders sent in the current quiet stretch, when the last one was, how many
// times the user said Not now, and when it went stale.
addColumn('tasks', 'revisit_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('tasks', 'revisit_at', 'INTEGER');
addColumn('tasks', 'revisit_later', 'INTEGER NOT NULL DEFAULT 0');
addColumn('tasks', 'stale_at', 'INTEGER');
// Versioned previews (store.ts addPreview): the previews row is the latest version under its stable id; earlier
// versions live in preview_versions. old_id: a preview that was its own row before versions were grouped (it resolves to
// the preview it became a version of).
addColumn('previews', 'pkey', 'TEXT');
addColumn('previews', 'version', 'INTEGER NOT NULL DEFAULT 1');
addColumn('previews', 'commit_sha', 'TEXT');
addColumn('previews', 'first_at', 'INTEGER');
db.exec(`CREATE TABLE IF NOT EXISTS preview_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preview_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  agent_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  file TEXT,
  content TEXT,
  source TEXT NOT NULL DEFAULT '',
  commit_sha TEXT,
  created_at INTEGER NOT NULL,
  old_id TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS preview_versions_preview ON preview_versions(preview_id, version)');
db.exec('CREATE INDEX IF NOT EXISTS preview_versions_old ON preview_versions(old_id)');
// A host's last live sample (hoststats.ts): CPU, memory, disk and GPUs as JSON; null when offline or unknown.
addColumn('hosts', 'stats', 'TEXT');
// A task's parts: each piece of work folded into it and its source (taskparts.ts).
db.exec(`CREATE TABLE IF NOT EXISTS task_parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_id TEXT,
  body TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
)`);
db.exec('CREATE INDEX IF NOT EXISTS task_parts_task ON task_parts(task_id, position)');
// HANDOFF.md: its modified time when the user last sent it to the director or dismissed it (server/handoff.ts).
addColumn('projects', 'handoff_seen', 'INTEGER');
// Projects are listed in an order the user sets (drag to reorder), never by activity. Upgrading starts from creation order.
if (!(db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).some((c) => c.name === 'position')) {
  db.exec('ALTER TABLE projects ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE projects SET position = 1 + (SELECT COUNT(*) FROM projects q WHERE q.created_at < projects.created_at OR (q.created_at = projects.created_at AND q.id < projects.id))');
}
// A standing discussion that collects one agent's permission requests while it has no task (server/requests.ts).
addColumn('tasks', 'requests_agent_id', 'TEXT');
// 1 on the settled discussion that keeps a project's requests answered in the old Inbox before they had a task.
addColumn('tasks', 'inbox_archive', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
CREATE INDEX IF NOT EXISTS tasks_kind ON tasks(project_id, kind);
CREATE INDEX IF NOT EXISTS task_messages_event ON task_messages(event_id);
CREATE TABLE IF NOT EXISTS discussion_tasks (
  discussion_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (discussion_id, task_id)
);
CREATE INDEX IF NOT EXISTS discussion_tasks_task ON discussion_tasks(task_id);
-- A question or review request from an agent to the agent that spawned it (see consults.ts).
CREATE TABLE IF NOT EXISTS consults (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  asker_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  manager_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL DEFAULT 'question',
  question TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  blocking INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT NOT NULL DEFAULT '',
  verdict TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS consults_asker ON consults(asker_id, status);
CREATE INDEX IF NOT EXISTS consults_project ON consults(project_id, status);
CREATE INDEX IF NOT EXISTS consults_task ON consults(task_id);
`);
// Who paused a task ('user' or an agent id) and the state it was paused from: only the user resumes
// what the user paused, and a goal's Begin puts work it took out of the queue back in. A task paused
// before these columns existed counts as paused by the user.
addColumn('tasks', 'paused_by', 'TEXT');
addColumn('tasks', 'paused_from', 'TEXT');
// What the task needs from the user, as its director wrote it (update_task needs_from_user), and the request filed
// for it (requests.ts fileNeeds). Cleared when that request is answered.
addColumn('tasks', 'needs_from_user', 'TEXT');
addColumn('tasks', 'needs_request_id', 'TEXT');
// Work tiers (server/tiers.ts): one table per install, the user's model and effort for each tier (defaults for unset rows).
db.exec('CREATE TABLE IF NOT EXISTS tiers (id TEXT PRIMARY KEY, model TEXT NOT NULL, effort TEXT NOT NULL DEFAULT \'\')');
// Checks run once (server/projectchecks.ts): a project's declared checks, and full runs kept against the commit.
db.exec(`CREATE TABLE IF NOT EXISTS project_checks (
  project_id TEXT PRIMARY KEY,
  quick TEXT NOT NULL DEFAULT '[]',
  full TEXT NOT NULL DEFAULT '[]',
  minutes INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS check_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  failed_check TEXT,
  output TEXT NOT NULL DEFAULT '',
  since_tasks TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS check_runs_commit ON check_runs(project_id, commit_sha);`);
// Builder mode (server/builder.ts): tasks the builder finished, until the batch record covers them; and a
// task's risky mark (1 marked, 0 marked not risky, NULL judged from its text).
// Builder is every project's default work mode. The update before this one recorded Team for every project that
// existed then; the user chose Team nowhere, and those rows cannot be told apart from a choice, so the first boot with
// mode_switches clears every Team row once and records the switch (builder.ts tells each director).
const builderForAll = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mode_switches'").get();
db.exec(`CREATE TABLE IF NOT EXISTS builder_batch (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  finished_at INTEGER NOT NULL,
  commits TEXT NOT NULL DEFAULT '[]',
  result TEXT NOT NULL DEFAULT '',
  noted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, task_id)
)`);
addColumn('tasks', 'risky', 'INTEGER');
// A task's tier and why (tiers.ts), how it will be shown to work (check_how), why it may run beside overlapping work
// (parallel_reason), and from when its review rounds count (rounds_from: a manual re-tier or narrowing resets them).
addColumn('tasks', 'tier', 'TEXT');
addColumn('tasks', 'tier_reason', "TEXT NOT NULL DEFAULT ''");
// A tier the user set is pinned: agents and the director may not change it, and escalation leaves it (workrules.ts).
addColumn('tasks', 'tier_pinned', 'INTEGER NOT NULL DEFAULT 0');
addColumn('tasks', 'check_how', "TEXT NOT NULL DEFAULT ''");
addColumn('tasks', 'parallel_reason', "TEXT NOT NULL DEFAULT ''");
// touches: the files or globs a task will change (JSON list, create_task/update_task), for running tasks side by side.
addColumn('tasks', 'touches', "TEXT NOT NULL DEFAULT '[]'");
addColumn('tasks', 'rounds_from', 'INTEGER');
// Pairs of a task and a running task it may affect, shown to the director and answered (server/affects.ts).
db.exec(`CREATE TABLE IF NOT EXISTS affect_pairs (
  task_id TEXT NOT NULL,
  affected_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  shown_at INTEGER NOT NULL,
  answered_at INTEGER,
  how TEXT,
  note TEXT NOT NULL DEFAULT '',
  renoted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, affected_id)
)`);
// The task whose related past work the agent was last given (server/related.ts), so it is given once per task.
if (!(db.prepare('PRAGMA table_info(agents)').all() as { name: string }[]).some((c) => c.name === 'related_given')) {
  addColumn('agents', 'related_given', 'TEXT');
  // Agents already at work when this arrived are not handed related work for the task they are on.
  db.exec('UPDATE agents SET related_given = task_id');
}
// Progress checks (server/progress.ts): per Active task, its allowance (time and tokens when it started), worklist
// movement, the flags already put to the director (noted, JSON keys) and their text, and when Helm paused it.
db.exec(`CREATE TABLE IF NOT EXISTS task_progress (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  base_at INTEGER NOT NULL,
  base_ms INTEGER NOT NULL,
  base_tokens INTEGER NOT NULL,
  done_seen INTEGER NOT NULL DEFAULT 0,
  moved_at INTEGER NOT NULL,
  moved_ms INTEGER NOT NULL,
  noted TEXT NOT NULL DEFAULT '[]',
  flag_text TEXT NOT NULL DEFAULT '',
  hard_at INTEGER
)`);
// The re-plan rule: strikes = flags since the user last resumed it (a re-plan keeps them), replan_due = the deadline for
// the director's re-plan after a first flag (set while Re-planning), the first flag's text and what the re-plan changed,
// and lifetime counts for telemetry.
addColumn('task_progress', 'strikes', 'INTEGER NOT NULL DEFAULT 0');
addColumn('task_progress', 'replan_due', 'INTEGER');
addColumn('task_progress', 'first_flag', "TEXT NOT NULL DEFAULT ''");
addColumn('task_progress', 'replan_note', "TEXT NOT NULL DEFAULT ''");
addColumn('task_progress', 'flags_total', 'INTEGER NOT NULL DEFAULT 0');
addColumn('task_progress', 'replans_total', 'INTEGER NOT NULL DEFAULT 0');
// The allowance's start in work tokens (usage.ts taskWork): new input, output, subagents. NULL on rows from before:
// set at the next check, which starts the token part of that allowance afresh.
addColumn('task_progress', 'base_work_in', 'INTEGER');
addColumn('task_progress', 'base_work_out', 'INTEGER');
addColumn('task_progress', 'base_work_sub', 'INTEGER');
// The watchdog (server/watchdog.ts): per Active task, its last look (state, idle spell, strikes, Stalled mark) and the
// between-turn time spent idle with nothing pending, waiting on a request, and busy on commands.
db.exec(`CREATE TABLE IF NOT EXISTS task_watch (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT '',
  tick_at INTEGER,
  idle_since INTEGER,
  strikes INTEGER NOT NULL DEFAULT 0,
  strike_at INTEGER,
  stalled_at INTEGER,
  done_seen INTEGER NOT NULL DEFAULT 0,
  idle_ms INTEGER NOT NULL DEFAULT 0,
  waiting_ms INTEGER NOT NULL DEFAULT 0,
  busy_ms INTEGER NOT NULL DEFAULT 0,
  wakes INTEGER NOT NULL DEFAULT 0,
  -- Stalled: whether it is put to the user (one request per project lists them; asked = in the last one filed), and
  -- when it last was, so a task stalling again within the day goes to the director instead.
  stall_user INTEGER NOT NULL DEFAULT 0,
  stall_asked INTEGER NOT NULL DEFAULT 0,
  user_stall_at INTEGER
)`);
// Sentences an agent was already told about by askcheck.ts (a prose-only ask), so a restart does not note them again.
db.exec(`CREATE TABLE IF NOT EXISTS user_ask_notes (
  agent_id TEXT NOT NULL,
  sentence_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, sentence_key)
)`);
// Files the user attached as references (server/attachments.ts). owner_id is text: a doc or task id, or the number
// of a task message or an event; owners are checked in code because they live in different tables.
db.exec(`
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  file TEXT NOT NULL,
  uploader TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_owner ON attachments(owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS attachments_project ON attachments(project_id);
`);
// A reference a manager attached (attach_reference) has the agent's name as uploader and may say what it shows.
addColumn('attachments', 'caption', "TEXT NOT NULL DEFAULT ''");
// Image annotations the user sends as feedback (server/annotations.ts): marks and numbered notes as vector data in
// image coordinates (0-1), on a preview's image (side '', 'before', 'after' or 'step:N') or on an attachment.
// original_id and flat_id are attachments sent with the message (the image as it was, and a PNG with the marks drawn
// on it); task_id and message_id say which thread it was sent to, event_id the message when it went to the director.
db.exec(`
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_id TEXT NOT NULL,
  side TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  marks TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '[]',
  comment TEXT NOT NULL DEFAULT '',
  original_id TEXT,
  flat_id TEXT,
  task_id TEXT,
  message_id INTEGER,
  event_id INTEGER,
  parent_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS annotations_source ON annotations(source_kind, source_id);
CREATE INDEX IF NOT EXISTS annotations_flat ON annotations(flat_id);
CREATE INDEX IF NOT EXISTS annotations_original ON annotations(original_id);
`);
// Older versions left a task's doc_id pointing at a deleted document.
db.exec('UPDATE tasks SET doc_id = NULL WHERE doc_id IS NOT NULL AND doc_id NOT IN (SELECT id FROM docs)');
// The Spec: goals and designs grouped into sections, each with a short summary and tags; decisions and notes
// attach to the entry they concern (parent_id). spec_state tracks an owner's edit on its way to a planning task:
// '' (nothing pending), 'changed' (edited, not yet planned; changed_at is the last edit), 'planning' (in the
// planning task plan_task_id), 'not_planned' (that task was dropped). base_rev is the revision holding the entry
// as it was before the first unplanned edit (what Revert restores); batch_rev the one before the edits not yet
// shown to the director (what the next diff starts from).
addColumn('docs', 'summary', "TEXT NOT NULL DEFAULT ''");
addColumn('docs', 'section_id', 'TEXT');
addColumn('docs', 'tags', "TEXT NOT NULL DEFAULT '[]'");
addColumn('docs', 'parent_id', 'TEXT');
addColumn('docs', 'spec_state', "TEXT NOT NULL DEFAULT ''");
addColumn('docs', 'changed_at', 'INTEGER');
addColumn('docs', 'plan_task_id', 'TEXT');
addColumn('docs', 'base_rev', 'INTEGER');
addColumn('docs', 'batch_rev', 'INTEGER');
// Importance is scarce: why an entry is Critical or High, its place within its level (set by the owner), and the
// project's budgets for those levels (JSON; empty means the defaults in spec.ts).
addColumn('docs', 'importance_reason', "TEXT NOT NULL DEFAULT ''");
addColumn('docs', 'importance_rank', 'INTEGER');
addColumn('projects', 'importance_limits', "TEXT NOT NULL DEFAULT ''");
// Tasks are ranked too. A level the owner set is pinned: agents may suggest a change but not make it.
addColumn('docs', 'importance_pinned', 'INTEGER NOT NULL DEFAULT 0');
const tasksHadImportance = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).some((c) => c.name === 'importance');
addColumn('tasks', 'importance', 'INTEGER NOT NULL DEFAULT 3');
addColumn('tasks', 'importance_reason', "TEXT NOT NULL DEFAULT ''");
addColumn('tasks', 'importance_pinned', 'INTEGER NOT NULL DEFAULT 0');
db.exec(`
-- Every change of importance, of an entry (target doc) or a task: from, to, why, who, and what prompted it.
CREATE TABLE IF NOT EXISTS importance_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  target_id TEXT NOT NULL,
  old_level INTEGER NOT NULL,
  new_level INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  cause_task_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS importance_changes_target ON importance_changes(target_id, id);
-- A new task starts at the importance of the entry it implements (Medium without one).
CREATE TRIGGER IF NOT EXISTS tasks_inherit_importance AFTER INSERT ON tasks WHEN NEW.doc_id IS NOT NULL BEGIN
  UPDATE tasks SET importance = COALESCE((SELECT importance FROM docs WHERE id = NEW.doc_id), 3) WHERE id = NEW.id;
END;
`);
db.exec(`
CREATE INDEX IF NOT EXISTS docs_parent ON docs(parent_id);
CREATE TABLE IF NOT EXISTS doc_sections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_sections_project ON doc_sections(project_id, position);
-- Each row is the entry as it was just before a change (op create: before it existed, so empty).
CREATE TABLE IF NOT EXISTS doc_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  op TEXT NOT NULL,
  author TEXT NOT NULL,
  author_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  section_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  parent_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_revisions_doc ON doc_revisions(doc_id, id);
-- Links between Spec entries and tasks (or discussions, which are rows of tasks too).
-- relation 'implements': the task does or did the work for the entry. 'changed': the task led to the revision
-- revision_id of the entry (that row holds the entry as it was before the change).
CREATE TABLE IF NOT EXISTS doc_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  revision_id INTEGER,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS doc_links_unique ON doc_links(doc_id, task_id, relation, IFNULL(revision_id, 0));
CREATE INDEX IF NOT EXISTS doc_links_task ON doc_links(task_id);
-- tasks.doc_id stays the task's main entry; these keep it mirrored as an 'implements' link wherever it is set.
CREATE TRIGGER IF NOT EXISTS tasks_doc_link_insert AFTER INSERT ON tasks WHEN NEW.doc_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO doc_links (doc_id, task_id, relation, created_at) VALUES (NEW.doc_id, NEW.id, 'implements', NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS tasks_doc_link_update AFTER UPDATE OF doc_id ON tasks WHEN NEW.doc_id IS NOT OLD.doc_id BEGIN
  DELETE FROM doc_links WHERE task_id = NEW.id AND doc_id = OLD.doc_id AND relation = 'implements';
  INSERT OR IGNORE INTO doc_links (doc_id, task_id, relation, created_at) SELECT NEW.doc_id, NEW.id, 'implements', NEW.updated_at WHERE NEW.doc_id IS NOT NULL;
END;
INSERT OR IGNORE INTO doc_links (doc_id, task_id, relation, created_at) SELECT doc_id, id, 'implements', created_at FROM tasks WHERE doc_id IS NOT NULL;
`);
// Sections nest (server/sections.ts): parent_id is the parent section, null at the top level. Additive: every existing
// section stays at the top level until someone nests it.
addColumn('doc_sections', 'parent_id', 'TEXT');

// First run with task importance: existing tasks take the highest importance among the entries they implement.
if (!tasksHadImportance) {
  db.exec(`UPDATE tasks SET importance = COALESCE((SELECT MAX(d.importance) FROM doc_links l JOIN docs d ON d.id = l.doc_id WHERE l.task_id = tasks.id AND l.relation = 'implements'), 3)`);
}

// One kind of Spec entry. Decisions and notes are no longer entries: an attached one became a history item of its
// entry (doc_history_items), a loose one a settled discussion; doc_conversions records where each went. A journal
// entry may name the Spec entry it concerns (journal.doc_id), and then shows in that entry's history.
addColumn('journal', 'doc_id', 'TEXT');
db.exec(`
CREATE TABLE IF NOT EXISTS doc_history_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  source_doc_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS doc_history_items_doc ON doc_history_items(doc_id);
CREATE TABLE IF NOT EXISTS doc_conversions (
  doc_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_doc ON journal(doc_id);
`);

// A discussion turned into a task in place keeps its row; this is when it became a task (null for a task that
// was always one). The timeline before it is the discussion era, shown as such on the task page.
addColumn('tasks', 'became_task_at', 'INTEGER');
// Days without activity after which an open discussion shows as cold; null uses the server default (HELM_COLD_DAYS, 14).
addColumn('projects', 'cold_days', 'INTEGER');
// Old ids that now resolve to another row: a separate task merged into the discussion it came from.
db.exec(`
CREATE TABLE IF NOT EXISTS task_aliases (
  alias_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_aliases_task ON task_aliases(task_id);
`);
// Edits the director proposes in a discussion about a Spec entry (server/specdiscuss.ts). The entry is untouched until
// the owner applies one; changes holds the proposed fields, base the entry's values of those fields when proposed.
// status: open, applied, declined, superseded (a newer one for the same entry), closed (the discussion was settled).
db.exec(`
CREATE TABLE IF NOT EXISTS doc_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  doc_id TEXT NOT NULL,
  discussion_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT,
  author_name TEXT NOT NULL DEFAULT '',
  changes TEXT NOT NULL,
  base TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  wording_only INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  revision_id INTEGER,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS doc_proposals_doc ON doc_proposals(doc_id, status);
CREATE INDEX IF NOT EXISTS doc_proposals_discussion ON doc_proposals(discussion_id);
`);
// Who decided a permission request: 'user', or on the user's behalf 'auto' (allowed at once: Unrestricted project,
// not flagged by the danger check; server/triage.ts). Null for rows from before. decision_reason: the reason given.
addColumn('inbox', 'decided_by', 'TEXT');
addColumn('inbox', 'decision_reason', "TEXT NOT NULL DEFAULT ''");
db.exec('CREATE INDEX IF NOT EXISTS inbox_decided ON inbox(project_id, decided_by)');
// Director first (triage.ts). Who answers a project's permission requests: 'user' (every request goes to the user;
// the default for projects from before) or 'director' (the director first; new projects). Also 'director' and 'check'
// for decided_by, and inbox statuses 'director' (waiting on the director) and 'check' (the independent check of the
// director's own request), neither of which needs the user's response. triage_minutes: how long a request waits on
// the director before it falls to the user (null: 10).
addColumn('projects', 'permission_answerer', "TEXT NOT NULL DEFAULT 'user'");
addColumn('projects', 'triage_minutes', 'INTEGER');
// Always-allow rules the director made for one agent (decide_permission allow_always). Kept in Helm, not in Claude
// Code's settings, so the user can revoke them: a revoked rule stops matching at the agent's next request.
db.exec(`
CREATE TABLE IF NOT EXISTS permission_rules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  rule_content TEXT,
  inbox_id TEXT,
  created_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS permission_rules_agent ON permission_rules(agent_id, revoked_at);
`);

// Sessions (server/sessions.ts): windows of time when the owner was working with the director, detected from what
// they do through the API. The stretch between two sessions is an away period; it has no row of its own: its summary
// is kept on the session that ended it (away_summary). summary_by / away_summary_by: 'director' or 'auto'.
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  ended_at INTEGER,
  ended_reason TEXT NOT NULL DEFAULT '',
  actions INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  summary_by TEXT NOT NULL DEFAULT '',
  summary_at INTEGER,
  away_summary TEXT NOT NULL DEFAULT '',
  away_summary_by TEXT NOT NULL DEFAULT '',
  away_summary_at INTEGER,
  backfilled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project_id, started_at);
-- Every state a task entered and when (from_state: the one it left; null when created). Task timing derives from it.
CREATE TABLE IF NOT EXISTS task_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_state TEXT,
  state TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_states_task ON task_states(task_id, at);
CREATE INDEX IF NOT EXISTS events_project_ts ON events(project_id, ts);
`);
// Per project: the owner's last activity, the idle period that ends a session (minutes; null: the default), whether
// sessions were backfilled from older data, and the away-period nudge state (sessions.ts).
addColumn('projects', 'last_owner_activity_at', 'INTEGER');
addColumn('projects', 'session_idle_minutes', 'INTEGER');
addColumn('projects', 'sessions_backfilled', 'INTEGER NOT NULL DEFAULT 0');
addColumn('projects', 'away_nudged_at', 'INTEGER');
addColumn('projects', 'away_nudges', 'INTEGER NOT NULL DEFAULT 0');
// Task timing (tasks.ts noteTaskState): first time active, active time so far excluding stretches in other states, the
// start of the current active stretch, and when it was finished (done or dropped). origin_note: why a task found while
// the owner was away was created.
addColumn('tasks', 'started_at', 'INTEGER');
addColumn('tasks', 'finished_at', 'INTEGER');
addColumn('tasks', 'active_ms', 'INTEGER NOT NULL DEFAULT 0');
addColumn('tasks', 'active_since', 'INTEGER');
addColumn('tasks', 'origin_note', "TEXT NOT NULL DEFAULT ''");
// taskwatch.ts: when an Active task's driver finished (awaiting the director's review), who it was, whether the director
// was reminded after its turn, and when it was last reminded that the task stalled.
addColumn('tasks', 'review_since', 'INTEGER');
addColumn('tasks', 'review_agent', 'TEXT');
addColumn('tasks', 'review_noted', 'INTEGER NOT NULL DEFAULT 0');
addColumn('tasks', 'stall_noted_at', 'INTEGER');
// Pinned proposals (pins.ts): the items the director (or the user) put at the top of a task or discussion for the user
// to look at, each a preview or an attachment, in numbered rounds; unpinning keeps the row (unpinned_at) and never
// touches the item. proposal_rounds: per round, the question asked, the request it is linked to and the choice made.
db.exec(`
CREATE TABLE IF NOT EXISTS pins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  preview_id TEXT,
  attachment_id TEXT,
  label TEXT NOT NULL DEFAULT '',
  round INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  pinned_by TEXT NOT NULL DEFAULT 'user',
  pinned_at INTEGER NOT NULL,
  unpinned_at INTEGER
);
CREATE INDEX IF NOT EXISTS pins_task ON pins(task_id, round, position);
CREATE TABLE IF NOT EXISTS proposal_rounds (
  task_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  request_id TEXT,
  choice TEXT NOT NULL DEFAULT '',
  chosen_pin INTEGER,
  decided_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, round)
);
CREATE INDEX IF NOT EXISTS proposal_rounds_request ON proposal_rounds(request_id);

-- The runner and the web service (server/runner.ts). Commands the web service hands the runner (send a message,
-- stop an agent, a permission answer, ...), done in order; op names are the protocol between the two.
CREATE TABLE IF NOT EXISTS runner_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  op TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  error TEXT,
  -- What a query (an op that answers, such as team-details) returned, as JSON.
  result TEXT
);
CREATE INDEX IF NOT EXISTS runner_commands_pending ON runner_commands(done_at, id);
-- Live-update messages the runner publishes (server/bus.ts), which the web service passes to browsers. Pruned after minutes.
CREATE TABLE IF NOT EXISTS bus_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  msg TEXT NOT NULL,
  ts INTEGER NOT NULL
);
-- One row: the running runner (its build, its heartbeat, the agents it holds).
CREATE TABLE IF NOT EXISTS runner_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  pid INTEGER NOT NULL,
  rev TEXT NOT NULL,
  hash TEXT NOT NULL DEFAULT '',
  protocol INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  beat_at INTEGER NOT NULL,
  live TEXT NOT NULL DEFAULT '[]',
  working INTEGER NOT NULL DEFAULT 0,
  info TEXT NOT NULL DEFAULT '{}'
);
-- Which pages the user has open and visible (server/notify.ts): the web service records it, the runner reads it.
CREATE TABLE IF NOT EXISTS page_presence (
  client TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  visible INTEGER NOT NULL,
  at INTEGER NOT NULL
);
`);
// Which runner took a command and when (server/runner.ts drain): claimed by a conditional UPDATE, so none is done twice.
addColumn('runner_commands', 'claimed_by', 'TEXT');
addColumn('runner_commands', 'claimed_at', 'INTEGER');
// The automatic "For review" pin (pins.ts autoPin): auto = 1 marks a pin Helm made itself from an agent's latest burst
// of previews (round 0, never part of a proposal round); burst names that burst (agent and turn). previews.turn: the
// posting agent's turn count when it was posted, so the previews of one turn form one burst.
addColumn('pins', 'auto', 'INTEGER NOT NULL DEFAULT 0');
addColumn('pins', 'burst', "TEXT NOT NULL DEFAULT ''");
addColumn('previews', 'turn', 'INTEGER');
// A worklist belongs to a task (task_aeff7900b5): a builder with tasks alongside keeps one per task, and a task's Status
// shows only its own. NULL: written before, read as the agent's current task's.
addColumn('checklist', 'task_id', 'TEXT');
// A status line per task an agent drives (task_3508723a80): a builder with tasks alongside reports each one's on its own
// card. agents.status_line stays its current task's line.
db.exec(`CREATE TABLE IF NOT EXISTS agent_task_status (
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  status_line TEXT NOT NULL DEFAULT '',
  progress INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, task_id)
)`);
db.exec('CREATE INDEX IF NOT EXISTS agent_task_status_task ON agent_task_status(task_id, updated_at)');

// Per-project settings (settings.ts): one row per setting the user changed from its default. Settings are declared
// in settings.ts with their default, so a new one needs no column and no migration.
// Project knowledge (knowledge.ts): short notes of durable facts agents learned about the project, given to every new
// agent session. added_by / updated_by: an agent's name or 'You'; *_agent: the agent's id (null for the user).
// agents.knowledge_seen: what the agent was last given ({ note id: [updated_at, title] }), to tell it what changed.
db.exec(`
CREATE TABLE IF NOT EXISTS project_settings (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, key)
);
CREATE TABLE IF NOT EXISTS knowledge_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  paths TEXT NOT NULL DEFAULT '[]',
  added_by TEXT NOT NULL,
  added_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  updated_agent TEXT,
  updated_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  confirmed_by TEXT
);
CREATE INDEX IF NOT EXISTS knowledge_notes_project ON knowledge_notes(project_id, topic);
`);
db.exec(`CREATE TABLE IF NOT EXISTS mode_switches (
  project_id TEXT PRIMARY KEY,
  from_mode TEXT NOT NULL,
  to_mode TEXT NOT NULL,
  at INTEGER NOT NULL,
  told INTEGER NOT NULL DEFAULT 0,
  close_told INTEGER NOT NULL DEFAULT 0
)`);
if (builderForAll) {
  const at = Date.now();
  db.prepare("INSERT OR REPLACE INTO mode_switches (project_id, from_mode, to_mode, at) SELECT project_id, 'team', 'builder', ? FROM project_settings WHERE key = 'work_mode' AND value = 'team'").run(at);
  db.exec("DELETE FROM project_settings WHERE key = 'work_mode' AND value = 'team'");
  // Every other project now in builder mode that has no builder yet (the user switched some by hand, leaving no row):
  // its director is told too. A very old database has no archived column yet at this point: then none is archived.
  const hasArchived = (db.prepare('PRAGMA table_info(projects)').all() as { name: string }[]).some((c) => c.name === 'archived');
  db.prepare(
    `INSERT OR IGNORE INTO mode_switches (project_id, from_mode, to_mode, at) SELECT p.id, 'team', 'builder', ? FROM projects p
     WHERE ${hasArchived ? 'p.archived = 0 AND ' : ''}NOT EXISTS (SELECT 1 FROM project_settings s WHERE s.project_id = p.id AND s.key = 'work_mode' AND s.value != 'builder')
       AND NOT EXISTS (SELECT 1 FROM agents a WHERE a.project_id = p.id AND a.role_id = 'builder' AND a.parent_id IS NOT NULL AND a.status != 'closed')`,
  ).run(at);
}
// Builder mode is the only way work runs: a project still set to Team switches at its next idle moment
// (builder.ts modeSwitchTick tells the director, waits for its area agents, then has the builder started), with a line
// in its journal. Idempotent: the setting row is gone once switched.
for (const r of db.prepare("SELECT project_id FROM project_settings WHERE key = 'work_mode' AND value != 'builder'").all() as { project_id: string }[]) {
  const at = Date.now();
  db.prepare("INSERT OR REPLACE INTO mode_switches (project_id, from_mode, to_mode, at, told, close_told) VALUES (?, 'team', 'builder', ?, 0, 0)").run(r.project_id, at);
  db.prepare("INSERT INTO journal (project_id, agent_id, kind, phase, title, body, ts) VALUES (?, NULL, 'decision', '', 'Work now runs in builder mode', 'Team mode was retired: one builder takes the queue, and the area agents finish what they have first.', ?)").run(r.project_id, at);
}
db.exec("DELETE FROM project_settings WHERE key = 'work_mode'");
addColumn('agents', 'knowledge_seen', 'TEXT');
// complete_task asked this agent once to record what it learned (knowledge.ts, finishNudge).
addColumn('agents', 'knowledge_asked', 'INTEGER');
addColumn('projects', 'knowledge_over_noted', 'INTEGER');
// When the user last opened the Knowledge page: notes agents added or changed since are marked for a human glance.
addColumn('projects', 'knowledge_viewed_at', 'INTEGER');
// The project's mode (server/projectmode.ts): running (Autopilot), queue_only, winding_down (Finish up), at_rest or stopped. Only the user changes it;
// mode_data holds what the change recorded (tasks Active at a wind down, agents a stop interrupted, the at-rest tally).
addColumn('projects', 'mode', "TEXT NOT NULL DEFAULT 'running'");
addColumn('projects', 'mode_since', 'INTEGER');
addColumn('projects', 'mode_note', "TEXT NOT NULL DEFAULT ''");
addColumn('projects', 'mode_data', "TEXT NOT NULL DEFAULT '{}'");
// Which mode change this agent was last told about ("mode@since"), so each agent hears of a change once.
addColumn('agents', 'mode_seen', 'TEXT');
// A builder's SDK subagent (subagents.ts): the Agent call it runs for, its tier, and whether it runs in the background.
addColumn('agents', 'sdk_tool_use_id', 'TEXT');
addColumn('agents', 'sub_tier', 'TEXT');
addColumn('agents', 'background', 'INTEGER');
addColumn('builder_batch', 'subagents', 'INTEGER NOT NULL DEFAULT 0');
// A heavy claim: the one build, suite or render running on that host (commands.ts).
addColumn('host_claims', 'heavy', 'INTEGER NOT NULL DEFAULT 0');
// When an agent was asked to save before its context is summarised; cleared by the summary (contextsave.ts).
addColumn('agents', 'save_asked_at', 'INTEGER');
// When the agent last set its own status line (report_status): a line set after its current tool started wins over
// the line Helm derives from that tool (busy.ts liveLine).
addColumn('agents', 'status_at', 'INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS held_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  sender TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  bind INTEGER NOT NULL DEFAULT 1,
  viewing TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS held_messages_agent ON held_messages(agent_id, id);
`);

// Dashboards (dashboards.ts, tilescope.ts): named pages of tiles agents keep up to date. Created here, before any view
// that reads them (the search index), so every process that opens the database has them.
db.exec(`
CREATE TABLE IF NOT EXISTS dashboards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  -- The user's words: what the dashboard is to show. The director builds it from them.
  description TEXT NOT NULL DEFAULT '',
  -- building: the director is making it (its task); ready: the director checked it against the description.
  state TEXT NOT NULL DEFAULT 'building',
  -- The task that builds it, or carries the latest change the user asked for.
  task_id TEXT,
  -- Further tasks whose agents may create and edit its tiles (set_tile), as the director delegated (JSON array).
  allow_tasks TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ready_at INTEGER
);
CREATE INDEX IF NOT EXISTS dashboards_project ON dashboards(project_id, position);
CREATE TABLE IF NOT EXISTS tiles (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  -- Tiles sharing a group show together (a gallery: one image tile per level or angle).
  grp TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  -- What it depends on: {"paths": [globs], "docs": [Spec entry ids], "tags": [Spec tags]}.
  deps TEXT NOT NULL DEFAULT '{}',
  -- How to refresh it: {"command", "cwd", "host", "duration", "notes"}, written by the agent that built it.
  recipe TEXT NOT NULL DEFAULT '{}',
  -- 1: refreshed only when the director asks; a task that affects it leaves it Stale for the director.
  expensive INTEGER NOT NULL DEFAULT 0,
  -- Its place on the project's Home (1 or 2), 0 when not pinned.
  pinned INTEGER NOT NULL DEFAULT 0,
  -- The last good data (JSON, its shape by kind), and what it was built from: {"commit", "at", "agent_id", "agent", "task_id"}.
  data TEXT,
  built TEXT,
  -- Why it is out of date: {"reason", "task_id", "files", "at"}; null when current.
  stale TEXT,
  -- The last refresh that failed: {"message", "at", "agent"}; the last good data stays.
  error TEXT,
  -- When the user last asked the director to refresh it.
  asked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tiles_dashboard ON tiles(dashboard_id, position);
CREATE INDEX IF NOT EXISTS tiles_project ON tiles(project_id);
-- Each refresh of a tile, newest kept (dashboards.ts trims by count and size). file: an image or page in the artifact folder.
CREATE TABLE IF NOT EXISTS tile_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tile_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  data TEXT NOT NULL,
  file TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  commit_sha TEXT,
  task_id TEXT,
  agent_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tile_history_tile ON tile_history(tile_id, id);
-- Which tiles a task's work may have affected (tilescope.ts) and what was done about each:
-- pending, refreshed, unaffected, stale (left stale, or failed), expensive (for the director), extra (refreshed unasked).
CREATE TABLE IF NOT EXISTS tile_checks (
  task_id TEXT NOT NULL,
  tile_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  docs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  agent_id TEXT,
  computed_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (task_id, tile_id)
);
-- The director's check of a task's dashboard scope (review_dashboard_scope).
CREATE TABLE IF NOT EXISTS dashboard_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT,
  agent_name TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  changes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dashboard_reviews_task ON dashboard_reviews(task_id, id);
-- Tokens each agent turn used (usage.ts): input + output + cache writes. task_id is the
-- agent's task when the turn ended.
CREATE TABLE IF NOT EXISTS token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT,
  tokens INTEGER NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS token_usage_agent ON token_usage(agent_id);
CREATE INDEX IF NOT EXISTS token_usage_task ON token_usage(task_id);
CREATE INDEX IF NOT EXISTS token_usage_project ON token_usage(project_id);
-- The subscription's plan windows (five_hour, seven_day, ...) as the last rate_limit_event reported them (usage.ts).
CREATE TABLE IF NOT EXISTS plan_usage (
  name TEXT PRIMARY KEY,
  percent REAL NOT NULL,
  resets_at INTEGER,
  at INTEGER NOT NULL
);
`);
// The tier a turn ran at (usage by tier, server/tiers.ts), and whose turn it was: director, builder or agent.
addColumn('token_usage', 'tier', 'TEXT');
addColumn('token_usage', 'who', 'TEXT');
// Work tokens (usage.ts, the progress check): the row's new input and output, without cache reads and context re-writes.
addColumn('token_usage', 'work_in', 'INTEGER');
addColumn('token_usage', 'work_out', 'INTEGER');
// The context the agent's last call of the turn held (contextsave.ts contextOf): what each call of the next turn re-reads.
addColumn('token_usage', 'context', 'INTEGER');

// Releases (releases.ts): a project's release recipe (what it builds and how it publishes) and its releases, each
// with its change log, the tasks in it and the files built for it (under artifacts/releases/<project>/<release>/).
db.exec(`
CREATE TABLE IF NOT EXISTS release_recipes (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  -- JSON array of {name, command, cwd, host, files, duration, notes}
  artifacts TEXT NOT NULL DEFAULT '[]',
  -- semver or date
  scheme TEXT NOT NULL DEFAULT 'semver',
  -- Markdown steps to publish a release (where it goes, how); empty: releases stay in Helm.
  publish TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  -- drafting (change log being written), building, ready, failed, published
  state TEXT NOT NULL DEFAULT 'drafting',
  notes TEXT NOT NULL DEFAULT '',
  -- JSON array of the ids of the tasks finished since the previous release
  tasks TEXT NOT NULL DEFAULT '[]',
  -- The Active task that carries the release's work and thread.
  task_id TEXT,
  tag TEXT,
  error TEXT,
  -- The inbox request asking the user to confirm publishing, and when they confirmed it (cleared once recorded).
  publish_request TEXT,
  publish_confirmed_at INTEGER,
  published_at INTEGER,
  published_how TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ready_at INTEGER
);
CREATE INDEX IF NOT EXISTS releases_project ON releases(project_id, created_at);
CREATE TABLE IF NOT EXISTS release_artifacts (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Relative to the artifact folder; NULL once the file was removed (the record stays).
  file TEXT,
  bytes INTEGER NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);
CREATE INDEX IF NOT EXISTS release_artifacts_release ON release_artifacts(release_id);
`);

// The ranked search's full-text index (searchschema.ts): its tables always; its views and triggers whenever their
// version is newer than the database's, which also empties the index for searchindex.ts to build again in the
// background. Inside the migration transaction (BEGIN IMMEDIATE at the top of this file), so two processes starting
// together do it once.
db.exec(SEARCH_TABLES_SQL);
const searchSchemaAt = () => Number((db.prepare("SELECT value FROM search_meta WHERE key = 'schema'").get() as { value?: string } | undefined)?.value ?? 0);
if (searchSchemaAt() < SEARCH_SCHEMA_VERSION) {
  db.exec(searchSchemaSql());
  db.exec("DELETE FROM search_fts; DELETE FROM search_rows; DELETE FROM search_meta WHERE key LIKE 'cursor:%' OR key = 'ready'");
  db.prepare("INSERT OR REPLACE INTO search_meta (key, value) VALUES ('schema', ?)").run(String(SEARCH_SCHEMA_VERSION));
}

type Param = string | number | bigint | null | Uint8Array;
const clean = (params: unknown[]): Param[] =>
  params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : (p as Param)));

export type Row = Record<string, any>;

export function all(sql: string, ...params: unknown[]): Row[] {
  return db.prepare(sql).all(...clean(params)) as Row[];
}
export function get(sql: string, ...params: unknown[]): Row | undefined {
  return db.prepare(sql).get(...clean(params)) as Row | undefined;
}
export function run(sql: string, ...params: unknown[]) {
  const t = Date.now();
  const out = db.prepare(sql).run(...clean(params));
  slow(t, sql);
  return out;
}

/** Writes that hold (or waited for) the write lock long enough to stall the other process are logged (see tx). */
const SLOW_MS = 150;
function slow(t: number, what: string) {
  const ms = Date.now() - t;
  if (ms >= SLOW_MS && !db.isTransaction) console.warn(`db: a write took ${ms} ms: ${what.replace(/\s+/g, ' ').slice(0, 160)}`);
}
/**
 * Run `fn` in one transaction: all of its writes land, or none do. A nested call joins the outer one.
 *
 * Keep transactions short. Split, the runner and the web service share this file, and a write waits for the other's
 * open write transaction; node:sqlite waits synchronously, so the waiting process's whole event loop stops (agents'
 * messages, the API, the stream). Measured: a 3 s transaction in one process froze the other's event loop for 2.8 s.
 * Batch work (backfills, migrations of many rows) belongs in chunks of short transactions.
 */
export function tx<T>(fn: () => T): T {
  if (db.isTransaction) return fn();
  // IMMEDIATE: take the write lock up front. A deferred BEGIN that read first and then writes fails at once with
  // "database is locked" when the other process committed meanwhile; busy_timeout cannot retry that case.
  const t = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    slow(t, `transaction from ${new Error().stack?.split('\n')[2]?.trim() ?? '?'}`);
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * The clock stored times come from. Tests move it forward with advanceClock (HELM_CLOCK_OFFSET_MS starts a server
 * shifted), so session idle periods and task timing can be checked without waiting.
 */
let clockOffset = Number(process.env.HELM_CLOCK_OFFSET_MS ?? 0) || 0;
let frozenAt: number | null = null;
export const now = () => (frozenAt ?? Date.now()) + clockOffset;
export function advanceClock(ms: number) {
  clockOffset += ms;
}
/** Tests: stop the clock at its current time; from then on only advanceClock moves it. */
export function freezeClock() {
  frozenAt = Date.now();
}
export const newId = (prefix: string) => `${prefix}_${randomBytes(5).toString('hex')}`;

/**
 * Before discussions became tasks in place, "Turn into a task" made a separate task linked through
 * discussion_tasks, leaving the discussion open beside it. A discussion is now either a discussion or the task
 * it became, so merge each discussion that led to tasks into the first of them: the discussion row survives with
 * that task's fields and everything keyed on the task id, and the old task id becomes an alias. Any further
 * tasks from it stay separate and keep referencing it (now as the task it became), showing its discussion inline.
 * Idempotent (a merged discussion is a task, so it is not picked again) and all in one transaction.
 */
export function mergeConvertedDiscussions(): number {
  const pairs = all(
    `SELECT l.discussion_id AS d, l.task_id AS t FROM discussion_tasks l
       JOIN tasks d ON d.id = l.discussion_id AND d.kind = 'discussion'
       JOIN tasks t ON t.id = l.task_id AND t.kind = 'task' AND t.project_id = d.project_id
     WHERE (SELECT COUNT(*) FROM discussion_tasks y WHERE y.task_id = l.task_id) = 1
       AND NOT EXISTS (SELECT 1 FROM discussion_tasks e JOIN tasks et ON et.id = e.task_id AND et.kind = 'task'
                       WHERE e.discussion_id = l.discussion_id AND (e.created_at < l.created_at OR (e.created_at = l.created_at AND e.task_id < l.task_id)))
       -- A discussion about a Spec entry that was settled because its edit joined an existing planning task stays settled
       -- and references that task (spec.ts postBatch); it is not that task's origin, so it is not merged into it.
       AND NOT EXISTS (SELECT 1 FROM doc_links s WHERE s.task_id = l.discussion_id AND s.relation = 'discusses')`,
  );
  if (!pairs.length) return 0;
  // Every table that points at a task by a task_id column (inbox, agents, previews, journal, reports, task_messages,
  // attachments, aliases, ...), found from the schema so tables added later are included.
  const keyed = all("SELECT name FROM sqlite_master WHERE type = 'table'")
    .map((r) => r.name as string)
    .filter((name) => !['tasks', 'discussion_tasks'].includes(name))
    .filter((name) => (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).some((c) => c.name === 'task_id'));
  const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  tx(() => {
    for (const { d: dId, t: tId } of pairs) {
      const d = get('SELECT * FROM tasks WHERE id = ?', dId)!;
      const t = get('SELECT * FROM tasks WHERE id = ?', tId)!;
      // The discussion's last summary stays readable in its era of the timeline.
      if (d.status_summary && !get("SELECT 1 AS x FROM task_messages WHERE task_id = ? AND kind = 'summary' AND body = ?", d.id, d.status_summary)) {
        run("INSERT INTO task_messages (task_id, author, author_name, kind, body, created_at) VALUES (?, 'system', 'Helm', 'summary', ?, ?)", d.id, d.status_summary, t.created_at - 1);
      }
      // The old pair of notes ("turned this into the task", "created this task as") becomes the one marker a conversion writes now.
      run("DELETE FROM task_messages WHERE task_id = ? AND kind = 'state' AND (body LIKE 'Came from the discussion %' OR body LIKE '% created this task as %')", t.id);
      const note = get("SELECT id, body FROM task_messages WHERE task_id = ? AND kind = 'state' AND body LIKE '% turned this into the task %' ORDER BY id LIMIT 1", d.id);
      const who = note ? String(note.body).split(' turned this into the task ')[0] : 'Someone';
      const label = ({ planning: 'Planning', waiting: 'Waiting' } as Record<string, string>)[String(note?.body ?? '').match(/\((\w+)\)\.$/)?.[1]?.toLowerCase() ?? ''] ?? 'Planning';
      const became = `Became a task: ${who} turned this ${d.state === 'settled' ? 'settled' : 'open'} discussion into a task, in ${label}.`;
      if (note) run('UPDATE task_messages SET body = ?, created_at = ? WHERE id = ?', became, t.created_at, note.id);
      else run("INSERT INTO task_messages (task_id, author, author_name, kind, body, created_at) VALUES (?, 'system', 'Helm', 'state', ?, ?)", d.id, became, t.created_at);
      run('DELETE FROM discussion_tasks WHERE discussion_id = ? AND task_id = ?', d.id, t.id);
      run('UPDATE OR IGNORE discussion_tasks SET discussion_id = ? WHERE discussion_id = ?', d.id, t.id);
      // OR IGNORE: a row both had (e.g. the same Spec link) would break a unique index; the task's copy goes with the task.
      for (const table of keyed) run(`UPDATE OR IGNORE ${table} SET task_id = ? WHERE task_id = ?`, d.id, t.id);
      run('UPDATE docs SET plan_task_id = ? WHERE plan_task_id = ?', d.id, t.id);
      run('UPDATE importance_changes SET cause_task_id = ? WHERE cause_task_id = ?', d.id, t.id);
      // Every field of the task moves onto the surviving row (columns added later included); the row keeps its id,
      // project, creation time and conclusion, and records when it became a task.
      const keep = ['id', 'project_id', 'created_at', 'conclusion', 'kind', 'became_task_at', 'updated_at'];
      const cols = taskCols.filter((c) => !keep.includes(c));
      // The old conversion ended the description with a pointer to the discussion, which is now this same row.
      const value = (c: string) => (c === 'description' ? String(t.description).replace(`\n\nFrom the discussion "${d.title}".`, '').trim() : t[c]);
      run(
        `UPDATE tasks SET kind = 'task', became_task_at = ?, updated_at = ?, ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
        t.created_at, Math.max(d.updated_at, t.updated_at), ...cols.map(value), d.id,
      );
      run('DELETE FROM tasks WHERE id = ?', t.id);
      run('INSERT OR REPLACE INTO task_aliases (alias_id, task_id, created_at) VALUES (?,?,?)', t.id, d.id, now());
    }
  });
  return pairs.length;
}
const merged = mergeConvertedDiscussions();
if (merged) console.log(`Merged ${merged} discussion(s) into the task made from each.`);
db.exec('COMMIT');

/**
 * Previews posted under the same title on one task before previews had versions become one preview: the newest keeps
 * its row and id, the older ones become its earlier versions (their ids resolve to it through preview_versions.old_id,
 * and pins on them move to it). Previews pinned by hand (proposal options) stay apart. Idempotent: nothing to do once
 * grouped, and new posts are versioned as they arrive (store.ts addPreview).
 */
export function groupPreviewVersions(): number {
  const groups = all(
    `SELECT task_id, lower(trim(title)) AS t, COUNT(*) AS n FROM previews p
      WHERE task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pins h WHERE h.preview_id = p.id AND h.auto = 0)
      GROUP BY task_id, lower(trim(title)) HAVING COUNT(*) > 1`,
  );
  if (!groups.length) return 0;
  return tx(() => {
    let moved = 0;
    for (const g of groups) {
      const rows = all(
        `SELECT * FROM previews p WHERE task_id = ? AND lower(trim(title)) = ? AND NOT EXISTS (SELECT 1 FROM pins h WHERE h.preview_id = p.id AND h.auto = 0) ORDER BY created_at, rowid`,
        g.task_id, g.t,
      );
      if (rows.length < 2) continue;
      const head = rows[rows.length - 1];
      const older = rows.slice(0, -1);
      older.forEach((r, i) => {
        run(
          'INSERT INTO preview_versions (preview_id, version, agent_id, kind, title, caption, file, content, source, commit_sha, created_at, old_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          head.id, i + 1, r.agent_id, r.kind, r.title, r.caption, r.file, r.content, r.source, r.commit_sha ?? null, r.created_at, r.id,
        );
        // Its auto pin (For review) goes; the head carries the review now.
        run('DELETE FROM pins WHERE preview_id = ? AND auto = 1', r.id);
        run('DELETE FROM previews WHERE id = ?', r.id);
        moved++;
      });
      run('UPDATE previews SET version = ?, first_at = ? WHERE id = ?', rows.length, older[0].created_at, head.id);
    }
    return moved;
  });
}
const grouped = groupPreviewVersions();
if (grouped) console.log(`Grouped ${grouped} preview(s) as earlier versions of the same-titled preview on their task.`);

// Reminders of deferred requests (server/reminders.ts): a request the user answered "not now" is asked again as a new
// request when due: at the user's next session at least 3 hours later (due_at NULL), or at due_at. root_id is the first
// request of the chain, count how many times it was deferred. status: pending, sent, skipped, cancelled, stopped.
db.exec(`CREATE TABLE IF NOT EXISTS request_reminders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  deferred_at INTEGER NOT NULL,
  due_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  sent_request_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS request_reminders_pending ON request_reminders(status, project_id);
CREATE INDEX IF NOT EXISTS request_reminders_request ON request_reminders(request_id);`);

// Dashboard sections, sizes, a shared series key and the rules (dashboards.ts): a dashboard is a few titled sections in
// order (a section may sit under another, parent_id); every tile belongs to one (section_id), has a size on the grid
// (s, m, l), an optional longer note behind an info tap (info), and a page tile states why it is free HTML (page_reason).
// The key names a dashboard's series once (JSON [{name, color}]); lint_noted: when its director was told what breaks the rules.
db.exec(`CREATE TABLE IF NOT EXISTS dashboard_sections (
  id TEXT PRIMARY KEY,
  dashboard_id TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  parent_id TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dashboard_sections_dash ON dashboard_sections(dashboard_id, position);`);
addColumn('tiles', 'section_id', 'TEXT');
{
  // Tiles from before sizes keep how they looked: tables and pages across the grid, numbers small, the rest medium.
  const had = (db.prepare('PRAGMA table_info(tiles)').all() as { name: string }[]).some((c) => c.name === 'size');
  addColumn('tiles', 'size', "TEXT NOT NULL DEFAULT 'm'");
  if (!had) db.exec("UPDATE tiles SET size = CASE WHEN kind IN ('table', 'page') THEN 'l' WHEN kind = 'number' THEN 's' ELSE 'm' END");
}
addColumn('tiles', 'info', "TEXT NOT NULL DEFAULT ''");
addColumn('tiles', 'page_reason', "TEXT NOT NULL DEFAULT ''");
addColumn('dashboards', 'series_key', "TEXT NOT NULL DEFAULT '[]'");
addColumn('dashboards', 'lint_noted', 'INTEGER');

// The release recipe worked out on the Releases page (recipework.ts): the director's proposed recipes, each a card in
// the project's "Release recipe" discussion that the user applies (as is or changed) or declines; and test builds,
// one artifact built now by an agent without a release, started only by the user, with its file or error.
db.exec(`
CREATE TABLE IF NOT EXISTS recipe_threads (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  discussion_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recipe_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  discussion_id TEXT,
  agent_id TEXT,
  author_name TEXT NOT NULL DEFAULT '',
  -- JSON {artifacts, scheme, publish}: the whole recipe it proposes
  recipe TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  -- open, applied, declined, superseded
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS recipe_proposals_project ON recipe_proposals(project_id, status);
CREATE TABLE IF NOT EXISTS recipe_tests (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact TEXT NOT NULL,
  commit_sha TEXT,
  -- running, done, failed
  status TEXT NOT NULL DEFAULT 'running',
  file TEXT,
  bytes INTEGER,
  sha256 TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS recipe_tests_project ON recipe_tests(project_id, artifact, started_at);
`);

// Merging tasks that are the same work (merge.ts): the closed ones point at the kept one; a report records what its
// task fixed; pairs the director decided to keep apart are not raised again by the queue review; the review's last
// note; the director's consolidation proposals (merge, back to back, wait for), each a card the user applies.
addColumn('tasks', 'merged_into', 'TEXT');
addColumn('reports', 'fix_note', "TEXT NOT NULL DEFAULT ''");
db.exec(`
CREATE TABLE IF NOT EXISTS task_pairs_apart (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);
CREATE TABLE IF NOT EXISTS queue_reviews (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  pairs_key TEXT NOT NULL DEFAULT '',
  noted_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS consolidations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  discussion_id TEXT NOT NULL,
  agent_name TEXT NOT NULL DEFAULT '',
  -- merge, adjacent (back to back), wait (the first waits for the second)
  kind TEXT NOT NULL,
  -- JSON array of task ids; for merge the first is the one kept
  tasks TEXT NOT NULL,
  gain TEXT NOT NULL DEFAULT '',
  -- open, applied, declined
  status TEXT NOT NULL DEFAULT 'open',
  result TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS consolidations_discussion ON consolidations(discussion_id, status);
`);

// The For review rule (pins.ts reviewNow): who took a pin off ('user', 'helm' or an agent's name), so a preview the
// user unpinned is not pinned again; and whether a project's pins were set by the rule once (the repair).
addColumn('pins', 'unpinned_by', 'TEXT');
addColumn('projects', 'review_pins_repaired', 'INTEGER NOT NULL DEFAULT 0');

// Test builds (testbuilds.ts): a task's build of the release recipe's artifacts at a commit, for the user to try; its
// files are recipe_tests rows with build_id set. Kept apart from releases, cleaned up after feedback and a quiet spell.
db.exec(`
CREATE TABLE IF NOT EXISTS test_builds (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  -- JSON: the recipe's artifacts as built (name, command, cwd, host, files)
  recipe TEXT NOT NULL DEFAULT '[]',
  -- ready (made), waiting (its test request is open), feedback (answered), superseded, removed
  state TEXT NOT NULL DEFAULT 'ready',
  request_id TEXT,
  made_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  feedback_at INTEGER,
  superseded_at INTEGER,
  removed_at INTEGER,
  removed_why TEXT NOT NULL DEFAULT '',
  -- why its files are kept past the rule (its commit is not in the repository)
  flag TEXT NOT NULL DEFAULT '',
  rebuild_of TEXT,
  rebuild_asked_at INTEGER
);
CREATE INDEX IF NOT EXISTS test_builds_task ON test_builds(task_id, created_at);
CREATE INDEX IF NOT EXISTS test_builds_project ON test_builds(project_id, state);
`);
addColumn('recipe_tests', 'build_id', 'TEXT');

// Spec work (specwork.ts): Review, Revise and Create, each a discussion with the director started from the Spec page.
// spec_work holds its mode and progress; spec_items the cards it posts: Review findings and proposed new entries.
db.exec(`
CREATE TABLE IF NOT EXISTS spec_work (
  discussion_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- review, revise, create
  mode TEXT NOT NULL,
  -- the section it is limited to ('' for the whole Spec) and the user's ask
  focus TEXT NOT NULL DEFAULT '',
  ask TEXT NOT NULL DEFAULT '',
  -- the user asked it to stop after the current section
  stop INTEGER NOT NULL DEFAULT 0,
  -- JSON array of the section ids done ('none' for entries with no section)
  done TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS spec_work_project ON spec_work(project_id, mode);
CREATE TABLE IF NOT EXISTS spec_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  discussion_id TEXT NOT NULL,
  -- the thread message that shows it
  message_id INTEGER,
  -- match, gap, disagree (Review findings), entry (a proposed new entry)
  kind TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  doc_id TEXT,
  -- for an entry: JSON {title, summary, body, section, tags}
  data TEXT NOT NULL DEFAULT '{}',
  -- open, picked (taken into a Revise), accepted (entry written), dropped
  status TEXT NOT NULL DEFAULT 'open',
  result TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS spec_items_discussion ON spec_items(discussion_id, message_id);
-- Cross-project threads (crossproject.ts): one row per side, a discussion in project_id paired with one in the peer.
CREATE TABLE IF NOT EXISTS project_threads (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  peer_project_id TEXT NOT NULL,
  -- the peer's side; NULL until a first message reaches it (a work request waits for the user's Allow)
  peer_task_id TEXT,
  -- 1: this side started the thread ("To <peer>"); 0: it arrived ("From <peer>")
  started_here INTEGER NOT NULL DEFAULT 0,
  -- the latest message from the peer, and when the user last opened this side
  last_in_at INTEGER,
  seen_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_threads_project ON project_threads(project_id, peer_project_id);
`);
// A builder Helm started fresh for one task (dispatch.ts), as opposed to the standing Builder that held the queue
// before (closed once its last task finishes) and the area agents of team mode.
addColumn('agents', 'per_task', 'INTEGER NOT NULL DEFAULT 0');
// Work the user tapped that a builder does (buildtask.ts): what to tell the director when it is done, and the task
// that builds a release's artifacts (its builder may attach them, releasetools.ts).
addColumn('tasks', 'done_note', 'TEXT');
addColumn('releases', 'build_task_id', 'TEXT');
// The Ideas board (ideas.ts): cards (a note, a link or an image) placed on a free canvas, and named frames drawn around
// them. A card belongs to the smallest frame holding its centre (frame_id, kept by ideas.ts assignFrames); Discuss on a
// frame starts a discussion (discussion_id). image_id is an attachment (owner_kind 'idea', owner_id the card): the
// uploaded image, or a link's preview image fetched by the server.
db.exec(`
CREATE TABLE IF NOT EXISTS idea_frames (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  discussion_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idea_frames_project ON idea_frames(project_id);
CREATE TABLE IF NOT EXISTS idea_cards (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  -- note | link | image
  kind TEXT NOT NULL,
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  z INTEGER NOT NULL DEFAULT 0,
  frame_id TEXT,
  -- a note's markdown; for a link, its title
  text TEXT NOT NULL DEFAULT '',
  url TEXT,
  site TEXT,
  image_id TEXT,
  -- a link: '' fetched or failed, 'fetching' while its preview is fetched
  status TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idea_cards_project ON idea_cards(project_id);
`);
// Claude accounts (accounts.ts): the main login and extra ones, each with its own config folder under
// HELM_DATA/accounts/<name>. A project runs every agent on its primary (projects.account, NULL = main) and moves to its
// fallbacks in order (projects.account_fallbacks, JSON names) while the primary is limited (accounts.limited_until).
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  name TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  limited_until INTEGER,
  limited_at INTEGER
);
INSERT OR IGNORE INTO accounts (name, created_at) VALUES ('main', 0);
`);
addColumn('projects', 'account', 'TEXT');
addColumn('projects', 'account_fallbacks', "TEXT NOT NULL DEFAULT '[]'");
// The account a turn ran on (NULL: the main one, and every row from before accounts).
addColumn('token_usage', 'account', 'TEXT');
