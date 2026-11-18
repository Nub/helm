import { closeSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, sep } from 'node:path';
import { run } from './db.ts';
import type { Row } from './db.ts';

/**
 * Moving a session from another tool into Helm: the prompt the user pastes into the old session, which makes it
 * leave the repository clean and write HANDOFF.md, and the detection of that file once the folder is a project.
 * The web app reads the prompt from /api/handoff, so this is the only copy of the text.
 */
export const HANDOFF_PROMPT = `You are handing this project over to another agent that will continue it inside Helm,
a dashboard where a director agent plans work and delegates to workers. That agent
starts with no memory of this session: it will only have the repository and the
handoff file you write now. Do not start new work. Your job is to leave things clean
and write everything down.

1. Leave the repository in a clean state.
   - Finish or back out anything half-done. If work in progress is worth keeping,
     commit it on a clearly named branch; do not leave uncommitted changes.
   - Stop any servers or background processes you started. List anything that must
     keep running and why.
   - Do not push, deploy or delete anything as part of this handoff unless I have
     already asked for it.

2. Write HANDOFF.md at the repository root, with these sections. Be specific and
   honest: say what is verified and what is assumed. Prefer file paths and commands
   over descriptions.

   ## Purpose
   What this project is for and who it is for, in a few sentences. What "done" or
   "good" looks like to the user.

   ## Spec: what the project should be
   The goals (what must be true) and designs (how it works), grouped by area. For
   each: a title, a one or two sentence summary, then detail. Describe the intended
   result, not progress. Mark the two or three that matter most and say why.

   ## Decisions
   Choices already made, each with the reason and, where it matters, what was
   rejected. Include preferences the user has stated about how they want things done.

   ## Where things stand
   For each piece of work: done and verified (how), done but not verified, in
   progress (branch, what remains), or not started. Include the current branch,
   recent commits that matter, and anything deployed and where.

   ## Next tasks
   An ordered list of the units of work to do next. For each: a title, what done
   looks like, files or areas involved, and anything blocking it. Say which the
   user has already approved and which are only your suggestion.

   ## Open questions and discussions
   Things undecided, ideas raised but not acted on, and questions waiting on the
   user. For each, what is known so far.

   ## How to work on this project
   Exact commands to build, run, test and deploy. Required tools and versions.
   Other machines or devices involved and what they are for. Where bug reports or
   feedback come from (issue tracker, folders, logs). Name any credentials or
   accounts needed, without including secrets.

   ## Traps
   Things that broke before, fragile areas, things that look wrong but are
   deliberate, and anything the next agent must not do.

3. Check your own handoff: read HANDOFF.md as if you knew nothing else, and fix
   anything you would have had to ask about. Then commit it, and reply with a short
   summary: the branch and commit, anything left running, and anything you could not
   capture in the file.`;

/** Appended when the old session runs on another machine than Helm. */
export const otherMachineLine = (host = hostname()) =>
  `The next agent works on ${host}; say how the repository gets there and what on the current machine it depends on.`;

/** What "Have the director read it" sends, as the user. */
export const HANDOFF_MESSAGE = `Read HANDOFF.md at the root of the project. Set up the Spec, tasks and discussions from it, keeping what it marks as approved separate from what is only suggested, and before starting any work, ask me what is unclear or missing with ask_user (a question for each decision, a to-do for anything I must do), so each shows under Needs response.`;

export const handoffInfo = () => ({ prompt: HANDOFF_PROMPT, otherMachineLine: otherMachineLine(), hostname: hostname(), message: HANDOFF_MESSAGE });

/** A handoff larger than this is not offered: no session writes one that big on purpose, and the director could not take it in. */
export const HANDOFF_MAX_BYTES = 512 * 1024;

export type HandoffFile = { name: string; mtime: number; size: number };

/**
 * HANDOFF.md (any case) at the root of the project folder: a regular file, not a symlink (one could point anywhere
 * on the machine), inside the folder, under the size cap, and text. Reads at most the cap plus one byte.
 */
export function findHandoff(dir: string): HandoffFile | null {
  try {
    const entry = readdirSync(dir, { withFileTypes: true }).find((e) => e.name.toLowerCase() === 'handoff.md');
    if (!entry || !entry.isFile()) return null;
    const path = join(dir, entry.name);
    const st = lstatSync(path);
    if (!st.isFile() || st.size === 0 || st.size > HANDOFF_MAX_BYTES) return null;
    const root = realpathSync(dir);
    if (!realpathSync(path).startsWith(root.endsWith(sep) ? root : root + sep)) return null;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(st.size, HANDOFF_MAX_BYTES) + 1);
      const n = readSync(fd, buf, 0, buf.length, 0);
      if (n > HANDOFF_MAX_BYTES || buf.subarray(0, n).includes(0)) return null;
    } finally {
      closeSync(fd);
    }
    return { name: entry.name, mtime: Math.round(st.mtimeMs), size: st.size };
  } catch {
    return null;
  }
}

/**
 * The project's handoff file and whether to offer it: "new" until the user sends it to the director or dismisses
 * it, "updated" once if the file changes after that, otherwise null. handoff_seen holds the file's modified time
 * when the user last acted on it.
 */
export function handoffState(project: Row) {
  const file = findHandoff(project.path);
  if (!file) return { file: null, offer: null };
  const seen = project.handoff_seen as number | null;
  return { file, offer: seen === null || seen === undefined ? 'new' : file.mtime > seen ? 'updated' : null };
}

export function markHandoffSeen(projectId: string, mtime: number) {
  run('UPDATE projects SET handoff_seen = ? WHERE id = ?', mtime, projectId);
}

