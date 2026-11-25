import { existsSync, lstatSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { all, get, now, run, tx } from './db.ts';
import type { Row } from './db.ts';

/**
 * Claude accounts. The main account is the login Helm runs with (its usual config folder, or CLAUDE_CONFIG_DIR). Each
 * extra account is a config folder of its own under HELM_DATA/accounts/<name>; the user signs it in from a terminal
 * (`CLAUDE_CONFIG_DIR=<folder> claude`, then /login). Helm never reads or stores the tokens: it only starts Claude Code
 * with that folder.
 *
 * A project names its primary account (projects.account, NULL = main) and an ordered list of fallbacks. All its agents
 * run on one account at a time, accountFor(): the primary, or while the primary is limited the first fallback that is
 * not, or the primary again (the project waits) when none has room. A usage-limit rejection marks the account limited
 * until its reset (markLimited); the runtime then moves the project's sessions, and moves them back once it resets.
 *
 * Sessions continue across accounts: Claude Code keeps transcripts in <config>/projects, and every extra account's
 * `projects` is a link to the main one's (shareTranscripts), so `resume` finds the same transcript on any account.
 */

export const MAIN = 'main';
const NAME = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** An account's limit with no reset time known: tried again after this long. */
export const UNKNOWN_RESET_MS = 30 * 60_000;
const WEEK = 7 * 86_400_000;

export const accountsRoot = () => join(DATA_DIR, 'accounts');
/** An extra account's config folder; null for the main one (Claude Code's own default). */
export const accountDir = (name: string): string | null => (name === MAIN ? null : join(accountsRoot(), name));
/** The main account's config folder, where transcripts live. */
export const mainConfigDir = () => (process.env.CLAUDE_CONFIG_DIR ?? '').trim() || join(homedir(), '.claude');

export const accountExists = (name: string) => !!get('SELECT 1 AS x FROM accounts WHERE name = ?', name);
export const accountNames = (): string[] => all("SELECT name FROM accounts ORDER BY name = 'main' DESC, created_at, name").map((r) => String(r.name));

/**
 * Make an extra account's folder, with its transcripts shared with the main account. A `projects` folder Claude Code
 * made itself (the user signed in before Helm linked it) is kept aside as projects.own, never deleted.
 */
export function ensureAccountDir(name: string) {
  const dir = accountDir(name);
  if (!dir) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const link = join(dir, 'projects');
  let st;
  try {
    st = lstatSync(link);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) return;
  if (st) renameSync(link, join(dir, `projects.own-${Date.now()}`));
  const target = join(mainConfigDir(), 'projects');
  mkdirSync(target, { recursive: true });
  symlinkSync(target, link);
}

/** Whether an extra account has signed in (Claude Code wrote its credentials file); the main one is taken as signed in. */
export const signedIn = (name: string) => name === MAIN || existsSync(join(accountDir(name)!, '.credentials.json'));

export function addAccount(raw: unknown): string | null {
  const name = String(raw ?? '').trim().toLowerCase();
  if (!NAME.test(name)) return 'Use lowercase letters, digits and dashes (up to 31).';
  if (accountExists(name)) return `There is already an account named ${name}.`;
  ensureAccountDir(name);
  run('INSERT INTO accounts (name, created_at) VALUES (?, ?)', name, now());
  return null;
}

/** Remove an extra account: projects on it go back to the main account, its fallback entries go, and so does its folder. */
export function removeAccount(name: string): string | null {
  if (name === MAIN) return 'The main account cannot be removed.';
  if (!accountExists(name)) return `No account named ${name}.`;
  tx(() => {
    run('UPDATE projects SET account = NULL WHERE account = ?', name);
    for (const p of all("SELECT id, account_fallbacks FROM projects WHERE account_fallbacks LIKE ?", `%"${name}"%`)) {
      run('UPDATE projects SET account_fallbacks = ? WHERE id = ?', JSON.stringify(parseList(p.account_fallbacks).filter((n) => n !== name)), p.id);
    }
    run('DELETE FROM accounts WHERE name = ?', name);
  });
  // The link to the shared transcripts is removed, not followed (rmSync does not follow symbolic links).
  rmSync(accountDir(name)!, { recursive: true, force: true });
  return null;
}

const parseList = (s: unknown): string[] => {
  try {
    const v = JSON.parse(String(s ?? '[]'));
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** A project's primary and fallbacks, as set (accounts removed since are dropped). */
export function projectAccounts(projectId: string): { primary: string; fallbacks: string[] } {
  const p = get('SELECT account, account_fallbacks FROM projects WHERE id = ?', projectId);
  const names = new Set(accountNames());
  const primary = p?.account && names.has(p.account) ? String(p.account) : MAIN;
  return { primary, fallbacks: parseList(p?.account_fallbacks).filter((n) => names.has(n) && n !== primary) };
}

export function setProjectAccounts(projectId: string, input: { primary?: unknown; fallbacks?: unknown }): string | null {
  const cur = projectAccounts(projectId);
  const primary = input.primary === undefined ? cur.primary : String(input.primary);
  if (!accountExists(primary)) return `No account named ${primary}.`;
  let fallbacks = input.fallbacks === undefined ? cur.fallbacks : Array.isArray(input.fallbacks) ? input.fallbacks.map(String) : null;
  if (!fallbacks) return 'Fallbacks are a list of account names.';
  const bad = fallbacks.find((n) => !accountExists(n));
  if (bad) return `No account named ${bad}.`;
  fallbacks = [...new Set(fallbacks)].filter((n) => n !== primary);
  run('UPDATE projects SET account = ?, account_fallbacks = ? WHERE id = ?', primary === MAIN ? null : primary, JSON.stringify(fallbacks), projectId);
  return null;
}

/** When an account's limit resets (ms), while it is limited at `at`; else null. */
export function limitedUntil(name: string, at = now()): number | null {
  const u = get('SELECT limited_until FROM accounts WHERE name = ?', name)?.limited_until;
  return u != null && Number(u) > at ? Number(u) : null;
}

/** The account a project's agents run on now: its primary, or the first fallback with room while the primary is limited. */
export function accountFor(projectId: string, at = now()): string {
  const { primary, fallbacks } = projectAccounts(projectId);
  if (!limitedUntil(primary, at)) return primary;
  return fallbacks.find((n) => !limitedUntil(n, at) && signedIn(n)) ?? primary;
}

/** The account rejected a turn for its usage limit: limited until the reset (seconds or ms), or a while if unknown. */
export function markLimited(name: string, resetsAt: number | null | undefined, at = now()) {
  const ms = resetsAt ? (resetsAt < 1e12 ? resetsAt * 1000 : resetsAt) : at + UNKNOWN_RESET_MS;
  run('UPDATE accounts SET limited_until = ?, limited_at = ? WHERE name = ?', Math.max(ms, at + 60_000), at, name);
}

/** What a session on this account adds to Claude Code's environment. */
export const accountEnv = (name: string): Record<string, string> => (name === MAIN ? {} : { CLAUDE_CONFIG_DIR: accountDir(name)! });

/** Tokens recorded on an account since `since` (rows from before accounts count as the main one's). */
export const accountTokens = (name: string, since: number) =>
  Number(get("SELECT COALESCE(SUM(tokens), 0) AS n FROM token_usage WHERE COALESCE(account, 'main') = ? AND at >= ?", name, since)?.n ?? 0);

export type AccountView = {
  name: string;
  main: boolean;
  /** Extra accounts: the command that signs it in. */
  command: string | null;
  signedIn: boolean;
  limitedUntil: number | null;
  tokensWeek: number;
  /** Projects with it as primary, and with it among their fallbacks. */
  primaryOf: { id: string; name: string }[];
  fallbackOf: { id: string; name: string }[];
};

export function accountsView(at = now()): AccountView[] {
  const projects = all('SELECT id, name FROM projects WHERE archived = 0 ORDER BY name').map((p: Row) => ({ id: String(p.id), name: String(p.name), ...projectAccounts(p.id) }));
  return accountNames().map((name) => ({
    name,
    main: name === MAIN,
    command: name === MAIN ? null : `CLAUDE_CONFIG_DIR=${accountDir(name)} claude`,
    signedIn: signedIn(name),
    limitedUntil: limitedUntil(name, at),
    tokensWeek: accountTokens(name, at - WEEK),
    primaryOf: projects.filter((p) => p.primary === name).map(({ id, name: n }) => ({ id, name: n })),
    fallbackOf: projects.filter((p) => p.fallbacks.includes(name)).map(({ id, name: n }) => ({ id, name: n })),
  }));
}
