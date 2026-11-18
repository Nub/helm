import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from './config.ts';

export const db = new DatabaseSync(join(DATA_DIR, 'helm.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

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
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
// The host an agent's own process runs on; null means this machine. Separate from the hosts it uses over SSH.
addColumn('agents', 'run_host_id', 'TEXT');
// When the agent became done or closed (NULL while it is not): the disk guard waives its one-hour rule only for
// folders untouched since then (server/diskusage.ts).
addColumn('agents', 'finished_at', 'INTEGER');
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

// Discussions are rows in tasks with kind 'discussion' (states open/settled), so threads, previews and inbox links work for both.
addColumn('tasks', 'kind', "TEXT NOT NULL DEFAULT 'task'");
// For a settled discussion: what was concluded, shown at the top of its page.
addColumn('tasks', 'conclusion', "TEXT NOT NULL DEFAULT ''");
// A message filed into a thread from the director conversation keeps the id of the original event.
addColumn('task_messages', 'event_id', 'INTEGER');
// The user's message on an active task sent as an interjection: the director acts on it at once (taskapi.ts).
addColumn('task_messages', 'interject', 'INTEGER NOT NULL DEFAULT 0');
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
`);

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
  return db.prepare(sql).run(...clean(params));
}
/** Run `fn` in one transaction: all of its writes land, or none do. A nested call joins the outer one. */
export function tx<T>(fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
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
