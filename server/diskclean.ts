import { cleanArtifacts, publishDisk } from './diskusage.ts';
import { gb } from './disk.ts';
import { addJournal, getProject } from './store.ts';
import { buildFiles, buildLabel, keepReason, removeBuildFiles } from './testbuilds.ts';

/**
 * System › Disk's Clean up for one project (web/src/disk.tsx): first what would go, by the same rules as the director's
 * clean_artifacts (diskusage.ts cleanArtifacts with dryRun) plus test-build files past their keep time (testbuilds.ts
 * keepReason), each with its size, and what stays with why. Confirming removes exactly the listed items, each checked
 * again at removal; anything that no longer qualifies is skipped with its reason. Every removal is journaled.
 */
export type CleanItem = { path: string; what: string; bytes: number | null; kind: 'folder' | 'testbuild'; build?: string };
export type CleanPlan = { remove: CleanItem[]; skipped: { path: string; reason: string }[]; total: number };

const BY = 'the user (System › Disk › Clean up)';
const totalOf = (items: CleanItem[]) => items.reduce((n, i) => n + (i.bytes ?? 0), 0);

export async function cleanupPlan(projectId: string): Promise<CleanPlan> {
  const res = await cleanArtifacts(projectId, { dryRun: true, by: BY });
  const remove: CleanItem[] = res.removed.map((r) => ({ path: r.path, what: r.what, bytes: r.bytes, kind: 'folder' }));
  const skipped = [...res.refused];
  for (const { build, bytes } of buildFiles(projectId)) {
    const why = await keepReason(build);
    const label = `Test build ${buildLabel(build)}`;
    if (why) skipped.push({ path: label, reason: why });
    else remove.push({ path: label, what: 'test build files past their keep time', bytes, kind: 'testbuild', build: build.id });
  }
  return { remove, skipped, total: totalOf(remove) };
}

/** Remove what the plan listed (paths and test builds): nothing beyond it, each checked again now. */
export async function runCleanup(projectId: string, pick: { paths: string[]; builds: string[] }): Promise<CleanPlan> {
  const removed: CleanItem[] = [];
  const skipped: { path: string; reason: string }[] = [];
  if (pick.paths.length) {
    const res = await cleanArtifacts(projectId, { paths: pick.paths, by: BY });
    removed.push(...res.removed.map((r) => ({ path: r.path, what: r.what, bytes: r.bytes, kind: 'folder' as const })));
    skipped.push(...res.refused);
  }
  const builds = buildFiles(projectId).filter((b) => pick.builds.includes(b.build.id));
  const gone: CleanItem[] = [];
  for (const { build, bytes } of builds) {
    const why = await keepReason(build);
    const label = `Test build ${buildLabel(build)}`;
    if (why) {
      skipped.push({ path: label, reason: why });
      continue;
    }
    removeBuildFiles(build, 'removed from System › Disk (Clean up)');
    gone.push({ path: label, what: 'test build files past their keep time', bytes, kind: 'testbuild', build: build.id });
  }
  for (const id of pick.builds) if (!builds.some((b) => b.build.id === id)) skipped.push({ path: id, reason: 'no files left for this test build' });
  if (gone.length && getProject(projectId)) {
    // Folders are journaled by cleanArtifacts; test-build files here.
    addJournal(projectId, null, 'note', `Removed ${gone.length} test build${gone.length === 1 ? '' : 's'}' files (${gb(totalOf(gone))}) to free disk space`, `${BY}:\n\n${gone.map((g) => `- ${g.path}${g.bytes ? `, ${gb(g.bytes)}` : ''}`).join('\n')}`);
    publishDisk();
  }
  removed.push(...gone);
  return { remove: removed, skipped, total: totalOf(removed) };
}
