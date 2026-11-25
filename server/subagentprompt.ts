import { getChoice } from './settings.ts';

// What a builder is told about its subagents, and their limit (subagents.ts). Kept apart so structure.ts can import it
// without the task and store modules.

/** How many subagents a builder may have running at once (0: none). */
export const subagentLimit = (projectId: string) => Number(getChoice(projectId, 'builder_subagents')) || 0;

/** What a builder is told about long commands and heavy jobs (commands.ts, hosts.ts). */
export const WAITS_SECTION = [
  `# Long commands and heavy jobs: never sit waiting`,
  `Helm remembers how long each command took last time. A command expected to take over a minute (a build, a test suite, a render) starts with run_in_background: true; carry on meanwhile with work that does not need its result (reading, the next part, a light subagent) and return to it when it finishes. Helm refuses a known long command started in the foreground.`,
  `Heavy jobs are per machine: one build, render or test run at a time on each host. Before a heavy job, claim a free host that suits it with claim_host heavy: true (list_hosts shows each host, what it is for and who is on it), run the job there, and Helm releases the claim when the command ends. With several hosts free, spread heavy jobs over them rather than queueing on one. With none free, the job waits: fill the time with light work, and Helm tells you when a host frees.`,
].join('\n');

/** What a builder is told about its subagents (structure.ts). */
export const SUBAGENT_SECTION = (limit: number) =>
  [
    `# Subagents: fan out like the Claude CLI`,
    `You may start up to ${limit} subagents at once with the Agent tool, for parts of your own task: each gets a brief, works in its own context, returns one report and ends. They have no Helm tools and never talk to the director or the user; you own every result and every check.`,
    `- Pick the tier with subagent_type: "light" or "routine" for searching, reading, collecting facts and mechanical edits; "skilled" for a real piece of building. Leave model and effort unset.`,
    `- Fan out when parts are independent: different files, or read-only work (searching, reading, checking). Run them in the background and carry on; their reports arrive as they finish.`,
    `- Do not fan out step-by-step work on the same files, or anything shorter than writing its brief: do it yourself.`,
    `- A brief stands alone: what to do, exactly where, how to tell it is done, and whether to edit or only report. Read what comes back before relying on it.`,
    `- Every brief names the folder the subagent works in (your task's worktree path, or its own with isolation: "worktree") and says every command runs there, as plain separate commands: Claude refuses a worktree subagent's chained or piped git commands.`,
    `- complete_task is refused while a subagent still works on that task.`,
  ].join('\n');
