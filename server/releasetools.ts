import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { get } from './db.ts';
import type { Row } from './db.ts';
import { getProject } from './store.ts';
import { clockText } from './clock.ts';
import {
  OFF_TEXT,
  SCHEMES,
  addArtifact,
  failRelease,
  findRelease,
  finishRelease,
  getRecipe,
  markPublished,
  releasesOn,
  renderRecipe,
  renderReleases,
  saveRecipe,
  setNotes,
} from './releases.ts';
import type { RuntimeApi, ToolAccess } from './tools.ts';
import { proposeRecipe, reportTestBuild } from './recipework.ts';
import { makeTestBuild } from './testbuilds.ts';
import { findTask, getTask } from './tasks.ts';
import { userAskedFor } from './projectmode.ts';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const artifactSchema = z.object({
  name: z.string().min(1).max(80).describe('e.g. "Linux binary"'),
  command: z.string().min(1).max(4000).describe('The exact command(s) that build it'),
  cwd: z.string().min(1).max(500).describe('Folder to run it in, relative to the checkout ("." for its root)'),
  host: z.string().max(80).optional().describe('Host it builds on (list_hosts); leave out for here'),
  files: z.array(z.string().min(1).max(500)).min(1).max(20).describe('The file(s) it produces, relative to the checkout'),
  duration: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * The release tools: managers write the recipe and the change log; the release's agents build and finish. No agent
 * starts or publishes a release: the director proposes either with ask_user's cut_release or publish_release action,
 * done only when the user taps it (reqactions.ts).
 */
export function releaseTools(agentId: string, _rt: RuntimeApi, access: ToolAccess) {
  const me = () => get('SELECT * FROM agents WHERE id = ?', agentId)!;
  const pid = () => me().project_id as string;
  /** The release named, if this agent may work on it: managers, or an agent on its task. */
  const target = (ref: string): { r?: Row; error?: string } => {
    if (!releasesOn(pid())) return { error: OFF_TEXT };
    const r = findRelease(pid(), ref);
    if (!r) return { error: `No release ${ref} on this project (list_releases).` };
    if (!access.manager && me().task_id !== r.task_id && (!r.build_task_id || me().task_id !== r.build_task_id)) return { error: `Only the director or the builder of [[${r.build_task_id ?? r.task_id}]] works on release ${r.version}.` };
    return { r };
  };
  const bases = () => {
    const wt = get("SELECT path FROM artifacts WHERE agent_id = ? AND kind = 'worktree' AND removed_at IS NULL ORDER BY created_at DESC LIMIT 1", agentId);
    return [wt?.path, getProject(pid())?.path].filter(Boolean) as string[];
  };
  const release = z.string().min(1).describe('Release id or version');

  const tools: any[] = [
    tool('list_releases', "The project's release recipe and its releases: version, state, commit, tag, artifacts, change log status.", {}, async () =>
      releasesOn(pid()) ? ok(renderReleases(pid(), clockText)) : fail(OFF_TEXT),
    ),
    tool(
      'add_release_artifact',
      'Attach a file you built for a release (from a clean checkout of its commit, by the recipe). Helm copies it and records its size and SHA-256; the same name again replaces it.',
      { release, name: z.string().min(1).max(80).describe('The artifact\'s name in the recipe'), path: z.string().min(1).max(1000).describe('The built file (absolute, or relative to your worktree)') },
      async ({ release: ref, name, path }) => {
        const { r, error } = target(ref);
        if (!r) return fail(error!);
        const res = await addArtifact(r, name, path, bases());
        if ('error' in res) return fail(res.error);
        const missing = getRecipe(r.project_id).artifacts.map((a) => a.name).filter((n) => n !== name && !get('SELECT id FROM release_artifacts WHERE release_id = ? AND name = ?', r.id, n));
        return ok(`Attached "${name}" to ${r.version}: ${size(res.artifact.bytes)}, sha256 ${res.artifact.sha256.slice(0, 16)}….${missing.length ? ` Still to attach: ${missing.join(', ')}.` : ' All artifacts attached: finish_release next.'}`);
      },
    ),
    tool(
      'finish_release',
      'Make a release ready once its change log is written and every artifact in the recipe is attached. Helm tags its commit locally (never pushes).',
      { release },
      async ({ release: ref }) => {
        const { r, error } = target(ref);
        if (!r) return fail(error!);
        const res = await finishRelease(r);
        if ('error' in res) return fail(res.error);
        return ok(`Release ${res.release.version} is ready, tagged ${res.release.tag}. Tell the user; settle [[${r.task_id}]].`);
      },
    ),
    tool(
      'fail_release',
      'A build failed: the release fails with the error and its attached files are removed, so nothing half-made is listed. The user cuts a new one when it is fixed.',
      { release, error: z.string().min(1).max(2000).describe('What failed, with the key output') },
      async ({ release: ref, error: why }) => {
        const { r, error } = target(ref);
        if (!r) return fail(error!);
        const e = failRelease(r, why);
        return e ? fail(e) : ok(`Release ${r.version} failed; its files were removed. Tell the user why.`);
      },
    ),
    tool(
      'mark_published',
      'Record the result of publishing a release, after the user confirmed it and you followed the publish instructions: how (where it went, links), or error if it failed.',
      { release, how: z.string().max(2000).describe('Where it was published, with links'), error: z.string().max(2000).optional().describe('Publishing failed: why') },
      async ({ release: ref, how, error: why }) => {
        const { r, error } = target(ref);
        if (!r) return fail(error!);
        const e = markPublished(r, how, why);
        return e ? fail(e) : ok(why ? `Recorded the failure on ${r.version}; publishing again needs the user's confirmation.` : `Release ${r.version} is recorded as published.`);
      },
    ),
    tool(
      'make_test_build',
      "Make a test build for the user to download and try: the release recipe's artifacts (all, or the ones you name) that you built from a clean checkout of a commit of the task's work (committed, so it can be built again: `git worktree add --detach <folder> <commit>`), or on a host and copied back by host_workspace_end (its workspace's commit counts). Helm checks and copies each file (size, checksum, path and secret checks). No version or tag; it is named for its task. Then ask the user to try it with ask_user kind action and test_build: it shows with Download.",
      {
        artifacts: z.array(z.object({ name: z.string().min(1).max(80).describe('The artifact\'s name in the recipe'), path: z.string().min(1).max(1000).describe('The built file (absolute, or relative to your worktree)') })).min(1).max(20),
        commit: z.string().max(80).optional().describe('The commit built; default the checkout\'s HEAD'),
        task: z.string().optional().describe('Task id; default the task you were spawned for'),
        rebuild_of: z.string().optional().describe('The test build this makes again (a Rebuild the user asked for)'),
      },
      async ({ artifacts, commit, task: ref, rebuild_of }) => {
        const t = ref ? findTask(pid(), ref) : me().task_id ? getTask(me().task_id) : undefined;
        if (!t) return fail(ref ? `No task "${ref}" on this project.` : 'Name the task (task): a test build belongs to one.');
        const res = await makeTestBuild(me(), t, { artifacts, commit, rebuild_of }, bases());
        return 'error' in res ? fail(res.error) : ok(res.text);
      },
    ),
    tool(
      'report_test_build',
      'Report a test build the user started (its id is in the brief): the built file (checked and copied as a release artifact is), or the error with the key output if it failed. Refused without a test build the user opened.',
      { test: z.string().min(1).describe('The test build id from the brief'), path: z.string().max(1000).optional().describe('The built file (absolute, or relative to your worktree)'), error: z.string().max(2000).optional().describe('Why it failed') },
      async ({ test, path, error: why }) => {
        if (!releasesOn(pid())) return fail(OFF_TEXT);
        const res = await reportTestBuild(me(), test, { path, error: why }, bases());
        return 'error' in res ? fail(res.error) : ok(res.text);
      },
    ),
  ];
  if (!access.manager) return tools;
  tools.push(
    tool(
      'set_release_recipe',
      "Propose the project's release recipe: the artifacts a release builds (exact commands, folder, host, files produced), the version scheme, and optional publish instructions (markdown steps: where it goes and how). It posts a card in the project's Release recipe discussion that the user applies, changes or declines; the recipe changes only when they apply it. just_do_it saves it at once, only when the user's own message in this turn asked you to just set it. Never put credentials in it: refer to ones already on the machine. Omitted fields keep their value.",
      {
        artifacts: z.array(artifactSchema).max(20).optional().describe('Replaces the list'),
        scheme: z.enum(SCHEMES).optional(),
        publish: z.string().max(8000).optional().describe('Markdown steps; "" for none (releases stay in Helm)'),
        rationale: z.string().max(300).optional().describe('One line on the card: why this recipe'),
        just_do_it: z.boolean().optional().describe('Save it now instead of proposing: only when the user, in this turn, asked you to just set it'),
      },
      async ({ rationale, just_do_it, ...input }) => {
        if (!releasesOn(pid())) return fail(OFF_TEXT);
        if (just_do_it) {
          if (!userAskedFor(agentId)) return fail('Not saved: just_do_it needs the user\'s own message in this turn asking you to set it. Leave it out to propose the recipe as a card they apply.');
          const res = saveRecipe(pid(), input, me().name);
          return 'error' in res ? fail(res.error) : ok(`Saved, as the user asked. ${renderRecipe(res.recipe)}`);
        }
        const res = proposeRecipe(me(), input, rationale);
        return 'error' in res ? fail(res.error) : ok(res.text);
      },
    ),
    tool(
      'set_release_notes',
      'Write or replace a release\'s change log (markdown): for users, "## New", "## Improved", "## Fixed", one plain sentence per change, internal work left out.',
      { release, notes: z.string().min(1).max(20000) },
      async ({ release: ref, notes }) => {
        const { r, error } = target(ref);
        if (!r) return fail(error!);
        const e = setNotes(r, notes);
        return e ? fail(e) : ok(`Change log saved for ${r.version}.`);
      },
    ),
  );
  return tools;
}
