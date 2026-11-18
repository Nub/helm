import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { all } from './db.ts';
import type { Row } from './db.ts';
import { createProposal, fetchForReview, getItem, hashTree, installItem, parse, snapshotTree } from './toolbox.ts';
import type { FileEntry, InstallInput, Review } from './toolbox.ts';

// Read-only view of the service user's personal Claude setup (~/.claude):
// the skills and plugins agents used to inherit, offered for import into the
// Toolbox, and the settings agents no longer receive.

const CLAUDE_HOME = process.env.HELM_CLAUDE_HOME ?? join(homedir(), '.claude');

export type PersonalItem = {
  key: string;
  kind: 'skill' | 'plugin';
  name: string;
  origin: string;
  path: string;
  version?: string;
  commit?: string;
  hash: string;
  review: Review;
  item_id: string | null;
  item_status: string | null;
  state: 'new' | 'added' | 'update';
  changes?: { added: string[]; removed: string[]; changed: string[] };
  error?: string;
};

const readJson = (p: string) => (existsSync(p) ? parse(readFileSync(p, 'utf8'), null) : null);
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

function skillDirs(): { name: string; path: string; origin: string }[] {
  const out: { name: string; path: string; origin: string }[] = [];
  const root = join(CLAUDE_HOME, 'skills');
  if (!isDir(root)) return out;
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name);
    if (name === 'synced' || name.startsWith('.') || !isDir(p)) continue;
    if (existsSync(join(p, 'SKILL.md'))) out.push({ name, path: p, origin: 'Personal skill (~/.claude/skills)' });
  }
  // Skills synced from claude.ai: skills/synced/<bucket>/<name>/SKILL.md
  const synced = join(root, 'synced');
  if (isDir(synced)) {
    for (const bucket of readdirSync(synced)) {
      const b = join(synced, bucket);
      if (bucket.startsWith('.') || !isDir(b)) continue;
      for (const name of readdirSync(b).sort()) {
        const p = join(b, name);
        if (isDir(p) && existsSync(join(p, 'SKILL.md'))) out.push({ name, path: p, origin: 'Synced from claude.ai' });
      }
    }
  }
  return out;
}

function enabledPlugins(): { name: string; key: string; path: string; version?: string; commit?: string }[] {
  const settings = readJson(join(CLAUDE_HOME, 'settings.json')) ?? {};
  const enabled = settings.enabledPlugins ?? {};
  const installed = readJson(join(CLAUDE_HOME, 'plugins', 'installed_plugins.json'))?.plugins ?? {};
  const out: { name: string; key: string; path: string; version?: string; commit?: string }[] = [];
  for (const [key, on] of Object.entries(enabled)) {
    if (!on) continue;
    const rec = (installed[key] ?? []).find((r: Row) => r.scope === 'user') ?? installed[key]?.[0];
    if (!rec?.installPath || !isDir(rec.installPath)) continue;
    out.push({ key, name: key.split('@')[0], path: rec.installPath, version: rec.version, commit: rec.gitCommitSha });
  }
  return out;
}

function diffFiles(before: FileEntry[], after: FileEntry[]) {
  const a = new Map(before.map((f) => [f.path, f.sha]));
  const b = new Map(after.map((f) => [f.path, f.sha]));
  return {
    added: [...b.keys()].filter((p) => !a.has(p)),
    removed: [...a.keys()].filter((p) => !b.has(p)),
    changed: [...b.keys()].filter((p) => a.has(p) && a.get(p) !== b.get(p)),
  };
}

/** Skills and plugins found in the personal setup, each with its review snapshot and whether it is in the Toolbox. */
export function personalItems(): PersonalItem[] {
  const imported = all("SELECT * FROM toolbox_items WHERE origin = 'import' AND status NOT IN ('removed', 'declined')");
  const found = [
    ...skillDirs().map((s) => ({ kind: 'skill' as const, ...s })),
    ...enabledPlugins().map((p) => ({ kind: 'plugin' as const, name: p.name, path: p.path, origin: `Enabled plugin ${p.key}`, version: p.version, commit: p.commit })),
  ];
  return found.map((f) => {
    const existing = imported.find((r) => parse(r.source).ref === f.path);
    const base = { key: f.path, kind: f.kind, name: f.name, origin: f.origin, path: f.path, version: (f as any).version, commit: (f as any).commit, item_id: existing?.id ?? null, item_status: existing?.status ?? null };
    try {
      const info = hashTree(f.path);
      const review = snapshotTree(f.path, info);
      if (!existing) return { ...base, hash: info.hash, review, state: 'new' as const };
      const pinned: FileEntry[] = parse(existing.review).files ?? [];
      if (existing.content_hash === info.hash) return { ...base, hash: info.hash, review, state: 'added' as const };
      return { ...base, hash: info.hash, review, state: 'update' as const, changes: diffFiles(pinned, info.files) };
    } catch (err: any) {
      return { ...base, hash: '', review: { state: 'failed' as const, error: String(err?.message ?? err) }, state: existing ? ('added' as const) : ('new' as const), error: String(err?.message ?? err) };
    }
  });
}

/** Personal settings agents no longer receive and that are not imported: shown so the owner can see what changed. */
export function personalLeftBehind() {
  const settings = readJson(join(CLAUDE_HOME, 'settings.json')) ?? {};
  const hooks: { event: string; matcher: string; command: string }[] = [];
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    for (const g of (groups as Row[]) ?? []) for (const h of g.hooks ?? []) hooks.push({ event, matcher: g.matcher ?? '', command: h.command ?? h.type ?? '' });
  }
  const perms = settings.permissions ?? {};
  const claudeMd = join(CLAUDE_HOME, 'CLAUDE.md');
  const listMd = (dir: string) => (isDir(join(CLAUDE_HOME, dir)) ? readdirSync(join(CLAUDE_HOME, dir)).filter((n) => n.endsWith('.md')) : []);
  const known = new Set(['hooks', 'permissions', 'enabledPlugins']);
  return {
    home: CLAUDE_HOME,
    hooks,
    permissions: { allow: perms.allow ?? [], deny: perms.deny ?? [], ask: perms.ask ?? [], defaultMode: perms.defaultMode ?? '' },
    claude_md: existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8').slice(0, 20000) : null,
    rules: listMd('rules'),
    agents: listMd('agents'),
    commands: listMd('commands'),
    other_settings: Object.keys(settings).filter((k) => !known.has(k)),
  };
}

/** One-tap Add: the same copy-and-pin path as any other item. */
export async function importPersonal(path: string, install: InstallInput): Promise<{ id: string } | { error: string }> {
  const f = personalItems().find((p) => p.path === path);
  if (!f) return { error: 'Not found in the personal Claude setup.' };
  if (f.item_id) return { error: 'Already in the Toolbox.' };
  const taken = new Set(all("SELECT name FROM toolbox_items WHERE status NOT IN ('removed', 'declined')").map((r) => r.name.toLowerCase()));
  let name = f.name;
  for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${f.name}-${i}`;
  const item = createProposal(
    {
      kind: f.kind, name, source_type: 'path', source: f.path, pin: f.commit ?? '',
      summary: f.review.skill_docs?.[0]?.description || `${f.kind === 'plugin' ? 'Plugin' : 'Skill'} imported from the personal Claude setup.`,
      problem: 'Imported from your personal Claude setup.', evidence: f.origin, install_effect: 'A pinned, read-only copy is loaded into agent sessions as a local plugin.',
      access: 'Runs inside the agent with everything the agent can reach.', risks: '', recommendation: 'undecided', recommendation_reason: '',
    },
    { agentId: null, projectId: null, origin: 'import' },
    false,
  );
  await fetchForReview(item.id);
  const review = parse(getItem(item.id)!.review);
  if (review.state !== 'ready') return { error: review.error ?? 'Could not copy it.' };
  const err = installItem(item.id, install);
  return err ? { error: err } : { id: item.id };
}
