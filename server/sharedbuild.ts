import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Row } from './db.ts';
import { getSetting } from './settings.ts';

/**
 * One Rust build folder for all work trees of a project on this machine (setting "shared_target"): agents' processes
 * get CARGO_TARGET_DIR pointing at <project folder>-wt/.target, next to the work trees (<project>-wt is where they
 * live), so the main checkout and every work tree reuse one set of compiled dependencies instead of one target per
 * tree. Cargo locks the folder, so two builds at once take turns. Only for a project with a Cargo.toml at its root;
 * an agent's session reads it when it starts.
 */
export function sharedTargetDir(project: Row): string | null {
  if (!project?.path || !getSetting(project.id, 'shared_target')) return null;
  if (!existsSync(join(project.path, 'Cargo.toml'))) return null;
  return join(dirname(project.path), `${basename(project.path)}-wt`, '.target');
}

/** The variables for an agent's process: CARGO_TARGET_DIR when the project shares one (the folder made if missing). */
export function sharedBuildEnv(project: Row): Record<string, string> {
  const dir = sharedTargetDir(project);
  if (!dir) return {};
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return {};
  }
  return { CARGO_TARGET_DIR: dir };
}

/** The line agents are told, or ''. */
export function sharedBuildPrompt(project: Row): string {
  const dir = sharedTargetDir(project);
  return dir ? `Rust builds in every work tree of this project go to one shared folder, ${dir} (CARGO_TARGET_DIR is set): binaries are under ${dir}/debug or /release, not ./target. Two builds at once take turns on its lock.` : '';
}
