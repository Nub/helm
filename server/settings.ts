import { all, get, now, run } from './db.ts';
import { isOwnHelm } from './ownhelm.ts';

/**
 * Per-project on/off settings, declared here with their default and grouped as Setup shows them. The table
 * (project_settings) holds only what the user changed, so adding a setting is one entry in SETTINGS: no column, no
 * migration, and Setup draws it from settingsView without a change of its own.
 *
 * Read from the database on every use (no cache): the runner that builds agents' prompts and the web process that
 * changes the setting may be different processes.
 */
export type SettingGroup = { id: string; title: string; description: string };
/** A switch (default true or false), or a choice of a few values (`choices`; default one of them). */
export type SettingDef = { key: string; group: string; label: string; detail: string; default: boolean | string; choices?: { value: string; label: string }[] };

export const SETTING_GROUPS: SettingGroup[] = [
  { id: 'agent-context', title: 'Agent context', description: 'What Helm gives every agent besides its task.' },
  { id: 'planning', title: 'Planning', description: 'How closely the work follows the Spec.' },
  { id: 'builds', title: 'Builds', description: 'Where build output is kept, so builds stay incremental.' },
  { id: 'checks', title: 'Checks', description: "When the builder finishes a batch, Helm runs the project's full checks on it." },
];

export const SETTINGS: SettingDef[] = [
  {
    key: 'knowledge',
    group: 'agent-context',
    label: 'Project knowledge',
    detail: 'Every new agent is given the Knowledge page, and agents record what they had to find out. Off: nothing is given or recorded; the notes are kept.',
    default: true,
  },
  {
    key: 'knowledge_budget',
    group: 'agent-context',
    label: 'Knowledge per agent',
    detail: 'How much of the Knowledge page a new agent is given: confirmed notes in up to half of it, then the notes most relevant to its task. The rest it can find with search.',
    default: '12000',
    choices: [
      { value: '6000', label: '6,000 characters' },
      { value: '12000', label: '12,000 characters' },
      { value: '24000', label: '24,000 characters' },
    ],
  },
  {
    key: 'director_context',
    group: 'agent-context',
    label: "Director's context",
    detail: "How much the director's session holds before Claude summarises it. Every turn re-reads all of it, so a smaller one costs far fewer tokens; its knowledge, journal and searchable history keep what matters. Takes effect at its next session.",
    default: '250000',
    choices: [
      { value: '150000', label: '150k tokens' },
      { value: '250000', label: '250k tokens' },
      { value: '500000', label: '500k tokens' },
      { value: 'model', label: "The model's whole window" },
    ],
  },
  {
    key: 'related_work',
    group: 'agent-context',
    label: 'Related past work',
    detail: 'An agent taking a task is handed up to five earlier tasks, decisions and discussion conclusions that search finds most like it, and the director sees them when it creates a task. Off: nothing is added.',
    default: true,
  },
  {
    key: 'affected_work',
    group: 'agent-context',
    label: 'Running work told of changes',
    detail: 'When the director creates or changes a task, it is shown the running tasks it may affect (same Spec entry, same files, similar) and tells their agents or says why not, in both threads. Off: nothing is shown.',
    default: true,
  },
  {
    key: 'builders_at_once',
    group: 'team',
    label: 'Builders at once',
    detail: 'Helm starts a fresh builder for each Scheduled task, in queue order: up to this many run side by side, each on a task whose files overlap none of the others.',
    default: '2',
    choices: [
      { value: '1', label: '1' },
      { value: '2', label: '2 (default)' },
      { value: '3', label: '3' },
      { value: '4', label: '4' },
      { value: '6', label: '6' },
    ],
  },
  {
    key: 'builder_subagents',
    group: 'team',
    label: 'Subagents per builder',
    detail: 'How many subagents each builder may run at once for parts of its own task; 0 turns them off.',
    default: '4',
    choices: [
      { value: '0', label: 'Off' },
      { value: '1', label: '1' },
      { value: '2', label: '2' },
      { value: '3', label: '3' },
      { value: '4', label: '4 (default)' },
      { value: '5', label: '5' },
    ],
  },
  {
    key: 'history_keep_days',
    group: 'agent-context',
    label: 'Full agent history kept',
    detail: 'Older transcripts are reduced once a day: tool results are dropped and tool calls keep only what they acted on, with a note in their place. Messages, tasks, the Spec, the journal, knowledge and the chat are never reduced.',
    default: '30',
    choices: [
      { value: '30', label: '30 days (default)' },
      { value: '90', label: '90 days' },
      { value: '365', label: 'A year' },
      { value: '0', label: 'Always' },
    ],
  },
  {
    key: 'ranked_search',
    group: 'agent-context',
    label: 'Ranked search',
    detail: 'Searches here (Home, and the agents\' find tool) find other forms of a word and put the best matches first. Off: every word must appear as typed, newest first.',
    default: true,
  },
  {
    key: 'brevity',
    group: 'agent-context',
    label: 'Short replies',
    detail: 'Reports, review requests, questions and the director\'s replies are kept short: an agent over the budget (about 600 characters for a report, 500 for a reply) is asked once to cut it, and gives more only when asked. Off: no budget.',
    default: true,
  },
  {
    key: 'dashboards',
    group: 'agent-context',
    label: 'Dashboards',
    detail: 'Agents keep the project\'s dashboards current: a finishing task refreshes the tiles its work affected, and the director checks the scope. Off: no dashboards page, no asks at the end of a task; the dashboards are kept.',
    default: true,
  },
  {
    key: 'releases',
    group: 'agent-context',
    label: 'Releases',
    detail: 'The Releases page: you cut a release, the director writes its change log and agents build the files the project\'s recipe names. Off: no page and no release tools; past releases are kept.',
    default: true,
  },
  {
    key: 'test_build_days',
    group: 'agent-context',
    label: 'Test builds kept after feedback',
    detail: "A task's test build for you to try is deleted once you answered its test request and the task then had no activity this long, if its commit is still in the repository (it can be built again). A superseded one goes after a day.",
    default: '3',
    choices: [
      { value: '1', label: '1 day' },
      { value: '3', label: '3 days' },
      { value: '7', label: '7 days' },
      { value: '30', label: '30 days' },
    ],
  },
  {
    key: 'progress_checks',
    group: 'agent-context',
    label: 'Progress checks',
    detail: 'Helm weighs each Active task\'s progress against its time and tokens. The first time one looks stuck it stops the work for the director to re-plan; the second time it pauses the task and asks you under Needs you. A task idle with nothing pending wakes its agent, then the director, then is marked Stalled and you are asked. Off: none of this.',
    default: true,
  },
  {
    key: 'spec_adherence',
    group: 'planning',
    label: 'Spec adherence',
    detail: "Strict: a task is scheduled or started only when it links the Spec entry it implements, and a plan that conflicts with the Spec comes to you. Loose: the same link, but the director may add a one-line entry as it plans, and small fixes may skip it. None: no checks; the director keeps only the project's purpose current.",
    default: 'loose',
    choices: [
      { value: 'strict', label: 'Strict' },
      { value: 'loose', label: 'Loose (default)' },
      { value: 'none', label: 'None' },
    ],
  },
  {
    key: 'build_slots',
    group: 'builds',
    label: 'Build slots on hosts',
    detail: 'On a host that keeps build folders, every job of this project reuses one folder there, with its code reset to the job\'s commit and its build output kept, so builds are incremental. One job at a time. Off: each job gets a fresh folder and builds from scratch.',
    default: true,
  },
  {
    key: 'shared_target',
    group: 'builds',
    label: 'One Rust build folder for all work trees',
    detail: 'On this machine, every work tree of the project builds into one target folder next to them (CARGO_TARGET_DIR), so dependencies compile once. Binaries move from ./target to that folder, the first build after turning it on is a full one, and builds in two work trees take turns. Off: one target folder per work tree.',
    default: false,
  },
  {
    key: 'discussion_revisit_days',
    group: 'agent-context',
    label: 'Revisit quiet discussions after',
    detail: 'An open discussion with no activity this long gets one request to revisit it: Continue, Close, Archive or Not now. Two unanswered (or two Not now) make it stale; it is never closed by itself.',
    default: '7',
    choices: [
      { value: '3', label: '3 days' },
      { value: '7', label: '7 days' },
      { value: '14', label: '14 days' },
      { value: '30', label: '30 days' },
    ],
  },
  {
    key: 'after_checks',
    group: 'checks',
    label: 'After checks pass',
    detail: "What Helm does with the batch's commit once its full checks pass. Moving a branch never pushes and never moves the branch checked out. A failure goes to the director and moves nothing.",
    default: 'nothing',
    choices: [
      { value: 'nothing', label: 'Nothing' },
      { value: 'release', label: 'Move branch release' },
    ],
  },
];

const defOf = (key: string) => SETTINGS.find((s) => s.key === key);

export function getSetting(projectId: string, key: string): boolean {
  const def = defOf(key);
  if (!def || def.choices) throw new Error(`Unknown switch ${key}`);
  const row = get('SELECT value FROM project_settings WHERE project_id = ? AND key = ?', projectId, key);
  return row ? row.value === '1' : (def.default as boolean);
}

/** A choice setting's value (one of its choices; the default when unset or no longer offered). */
export function getChoice(projectId: string, key: string): string {
  const def = defOf(key);
  if (!def?.choices) throw new Error(`Unknown choice ${key}`);
  const v = get('SELECT value FROM project_settings WHERE project_id = ? AND key = ?', projectId, key)?.value;
  return def.choices.some((c) => c.value === v) ? String(v) : String(defaultFor(projectId, def));
}

/** A setting's default for one project: Helm's own project (ownhelm.ts) moves release after checks pass. */
function defaultFor(projectId: string, def: SettingDef): boolean | string {
  if (def.key === 'after_checks' && isOwnHelm(get('SELECT path FROM projects WHERE id = ?', projectId)?.path)) return 'release';
  return def.default;
}

/** Why `value` is not a value for setting `key`, or null. */
export function checkSetting(key: string, value: unknown): string | null {
  const def = defOf(key);
  if (!def) return `Unknown setting "${key}".`;
  if (def.choices) return def.choices.some((c) => c.value === value) ? null : `"${key}" is one of ${def.choices.map((c) => c.value).join(', ')}.`;
  return typeof value === 'boolean' ? null : `"${key}" is on or off (true or false).`;
}

/** Returns an error for an unknown key or a value of the wrong kind. Setting a value equal to the default removes the row. */
export function setSetting(projectId: string, key: string, value: boolean | string): string | null {
  const def = defOf(key);
  const wrong = checkSetting(key, value);
  if (wrong || !def) return wrong;
  if (value === defaultFor(projectId, def)) run('DELETE FROM project_settings WHERE project_id = ? AND key = ?', projectId, key);
  else run('INSERT OR REPLACE INTO project_settings (project_id, key, value, updated_at) VALUES (?,?,?,?)', projectId, key, typeof value === 'string' ? value : value ? '1' : '0', now());
  return null;
}

/** What Setup draws: the groups, each with its settings and their current values. `all`: also those Setup › Team edits. */
export function settingsView(projectId: string, all = false) {
  const groups = all ? [...SETTING_GROUPS, { id: 'team', title: 'Team', description: '' }] : SETTING_GROUPS;
  return groups.map((g) => ({
    ...g,
    settings: SETTINGS.filter((s) => s.group === g.id).map((s) => ({ ...s, value: s.choices ? getChoice(projectId, s.key) : getSetting(projectId, s.key) })),
  }));
}
