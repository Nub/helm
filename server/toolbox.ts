import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync,
} from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { McpServerConfig, SdkPluginConfig } from '@anthropic-ai/claude-agent-sdk';
import { bus } from './bus.ts';
import { DATA_DIR } from './config.ts';
import { writeFileAtomic } from './safefs.ts';
import { all, get, newId, now, run } from './db.ts';
import { addJournal } from './store.ts';
import type { Row } from './db.ts';

// The Toolbox: skills, plugins and MCP servers the owner approved, pinned to
// what they reviewed, and handed to agent sessions per project.
//
// Layout under HELM_DATA:
//   toolbox/staging/<id>/tree        what Helm fetched for review (never executed)
//   toolbox/items/<id>/<hash>/       the installed, read-only copy (a local plugin root)
//   toolbox/gcroots/<id>             nix out-link of an installed stdio MCP server
//   toolbox/secrets/<id>.json        0600: headers / env values, never sent to the browser

const exec = promisify(execFile);

export const TOOLBOX_DIR = join(DATA_DIR, 'toolbox');
const STAGING = join(TOOLBOX_DIR, 'staging');
const ITEMS = join(TOOLBOX_DIR, 'items');
const GCROOTS = join(TOOLBOX_DIR, 'gcroots');
const SECRETS = join(TOOLBOX_DIR, 'secrets');
for (const d of [STAGING, ITEMS, GCROOTS]) mkdirSync(d, { recursive: true });
mkdirSync(SECRETS, { recursive: true, mode: 0o700 });
chmodSync(SECRETS, 0o700);

export const KINDS = ['skill', 'plugin', 'mcp_http', 'mcp_stdio'] as const;
export type Kind = (typeof KINDS)[number];
export const STATUSES = ['proposed', 'installing', 'installed', 'failed', 'declined', 'removed'] as const;
export const SOURCE_TYPES = ['git', 'path', 'http_url', 'nix_flake', 'npm', 'pypi', 'other'] as const;

export function publishToolbox() {
  bus.publish({ type: 'toolbox' });
}

// ---------- hashing and copying ----------

/** Never copied, hashed or shown: VCS data and the CLI's own bookkeeping. */
const SKIP = new Set(['.git', '.in_use', 'node_modules']);
const MAX_FILES = 3000;
const MAX_BYTES = 60 * 1024 * 1024;

export type FileEntry = { path: string; size: number; exec: boolean; sha: string };
export type TreeInfo = { hash: string; files: FileEntry[]; symlinks: { path: string; target: string }[]; size: number };

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/**
 * Content hash of a folder: sha256 over the sorted list of (path, executable
 * bit, sha256 of contents), skipping .git. Permissions other than the
 * executable bit are ignored so that making a copy read-only keeps its hash.
 * Symlinks are listed but never followed, copied or hashed.
 */
export function hashTree(root: string): TreeInfo {
  const files: FileEntry[] = [];
  const symlinks: { path: string; target: string }[] = [];
  let size = 0;
  const walk = (rel: string) => {
    const entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(root, r);
      if (e.isSymbolicLink()) symlinks.push({ path: r, target: readlinkSync(abs) });
      else if (e.isDirectory()) walk(r);
      else if (e.isFile()) {
        const st = statSync(abs);
        size += st.size;
        if (files.length >= MAX_FILES) throw new Error(`More than ${MAX_FILES} files; too large to review.`);
        if (size > MAX_BYTES) throw new Error(`More than ${MAX_BYTES / 1024 / 1024} MB; too large to review.`);
        files.push({ path: r, size: st.size, exec: (st.mode & 0o111) !== 0, sha: sha256(readFileSync(abs)) });
      }
    }
  };
  walk('');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = sha256(files.map((f) => `${f.path}\0${f.exec ? 'x' : '-'}\0${f.sha}\n`).join(''));
  return { hash, files, symlinks, size };
}

/** Copy regular files and folders only (no symlinks, no .git), keeping the executable bit. */
function copyTree(src: string, dst: string) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) {
      cpSync(s, d);
      chmodSync(d, statSync(s).mode & 0o111 ? 0o755 : 0o644);
    }
  }
}

function setTreeWritable(dir: string, writable: boolean) {
  if (!existsSync(dir)) return;
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    if (writable) chmodSync(dir, 0o755);
    for (const name of readdirSync(dir)) setTreeWritable(join(dir, name), writable);
    if (!writable) chmodSync(dir, 0o555);
  } else {
    const x = st.mode & 0o111 ? 0o111 : 0;
    chmodSync(dir, writable ? 0o644 | (x ? 0o755 : 0) : 0o444 | x);
  }
}

function removeTree(dir: string) {
  if (!existsSync(dir)) return;
  setTreeWritable(dir, true);
  rmSync(dir, { recursive: true, force: true });
}

// ---------- review snapshot ----------

export type Review = {
  state: 'fetching' | 'ready' | 'failed' | 'none';
  error?: string;
  fetched_at?: number;
  resolved?: { commit?: string; requested?: string; path?: string };
  files?: FileEntry[];
  size?: number;
  symlinks?: { path: string; target: string }[];
  manifest?: string | null;
  skill_docs?: { path: string; name: string; description: string; allowed_tools: string; text: string }[];
  scripts?: { path: string; text: string; truncated: boolean }[];
  bang_commands?: { path: string; line: number; command: string }[];
  hooks?: { path: string; text: string }[];
  mcp_config?: { path: string; text: string }[];
  commands?: string[];
  agents?: string[];
  flags?: { hooks: boolean; mcp: boolean; runs_on_load: boolean; scripts: boolean; allowed_tools: boolean; network: string[]; file_access: string[] };
  // MCP servers
  url?: string;
  auth?: string;
  tools?: { name: string; description?: string }[];
  launch?: string;
  secrets?: { name: string; where: string; description?: string }[];
};

const SCRIPT_EXT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|ps1|php|lua)$/i;
const NETWORK = /\b(curl|wget|fetch\(|requests\.(get|post|put|delete|request|Session)|urllib\.request|urlopen|http\.client|https?\.(get|request)\(|axios|socket\.|Invoke-WebRequest|nc\s|ssh\s|scp\s|rsync\s|git\s+(clone|push|pull|fetch)|npm\s+(i|install)|pip3?\s+install|npx\s|uvx\s)/;
const FILE_ACCESS = /(~\/[\w.-]+|\$HOME\b|\/etc\/[\w.-]+|\.ssh\b|\.claude\b|\.aws\b|\.config\/|credentials|\brm\s+-rf?\b|\bsudo\b)/;

const isText = (buf: Buffer) => !buf.subarray(0, 8000).includes(0);

function frontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text.startsWith('---')) return out;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return out;
  let key = '';
  for (const line of text.slice(3, end).split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) {
      key = m[1];
      out[key] = m[2].replace(/^["']|["']$/g, '');
    } else if (key && /^\s+(-\s*)?\S/.test(line)) {
      out[key] = `${out[key]} ${line.trim().replace(/^-\s*/, '')}`.trim();
    }
  }
  return out;
}

/** Lines that match, as "path:line: text", keeping the URL on the line if there is one. */
function collect(re: RegExp, text: string, path: string, into: Set<string>) {
  text.split("\n").forEach((line, i) => {
    if (into.size >= 40) return;
    const m = re.exec(line);
    if (!m) return;
    const url = /https?:\/\/[^\s'")\]]+/.exec(line)?.[0];
    into.add(`${path}:${i + 1}: ${m[0].trim()}${url && url !== m[0] ? ` ${url}` : ""}`.slice(0, 160));
  });
}

/** What the owner needs to judge a skill or plugin folder. Reads files only; never runs anything. */
export function snapshotTree(root: string, info: TreeInfo): Review {
  const read = (p: string) => readFileSync(join(root, p));
  const textOf = (p: string) => read(p).toString('utf8');
  const network = new Set<string>();
  const fileAccess = new Set<string>();
  const skillDocs: Review['skill_docs'] = [];
  const scripts: Review['scripts'] = [];
  const bang: Review['bang_commands'] = [];
  const hooks: Review['hooks'] = [];
  const mcp: Review['mcp_config'] = [];
  const commands: string[] = [];
  const agents: string[] = [];
  let manifest: string | null = null;

  for (const f of info.files) {
    const name = basename(f.path);
    const buf = read(f.path);
    if (!isText(buf)) continue;
    const text = buf.toString('utf8');
    if (f.path === '.claude-plugin/plugin.json') {
      manifest = text;
      try {
        const m = JSON.parse(text);
        if (m.hooks) hooks.push({ path: `${f.path} (hooks)`, text: JSON.stringify(m.hooks, null, 2) });
        if (m.mcpServers) mcp.push({ path: `${f.path} (mcpServers)`, text: JSON.stringify(m.mcpServers, null, 2) });
      } catch {
        /* shown as text */
      }
    }
    if (name === 'SKILL.md') {
      const fm = frontmatter(text);
      skillDocs.push({ path: f.path, name: fm.name ?? '', description: fm.description ?? '', allowed_tools: fm['allowed-tools'] ?? '', text });
    }
    if (/^hooks\//.test(f.path) || /(^|\/)hooks\.json$/.test(f.path)) hooks.push({ path: f.path, text: text.slice(0, 30000) });
    if (name === '.mcp.json') mcp.push({ path: f.path, text: text.slice(0, 30000) });
    if (/^commands\/.+\.md$/.test(f.path)) commands.push(f.path);
    if (/^agents\/.+\.md$/.test(f.path)) agents.push(f.path);
    // Dynamic context: !`cmd` in a skill or command file runs when it loads.
    if (name === 'SKILL.md' || /(^|\/)commands\/.+\.md$/.test(f.path)) {
      text.split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/(?:^|\s)!`([^`\n]+)`/g)) bang.push({ path: f.path, line: i + 1, command: m[1] });
      });
    }
    const isScript = SCRIPT_EXT.test(name) || f.exec || text.startsWith('#!');
    if (isScript && scripts.length < 40) scripts.push({ path: f.path, text: text.slice(0, 30000), truncated: text.length > 30000 });
    if (isScript || /^hooks\//.test(f.path)) {
      collect(NETWORK, text, f.path, network);
      collect(FILE_ACCESS, text, f.path, fileAccess);
    }
  }
  for (const b of bang) {
    collect(NETWORK, b.command, b.path, network);
    collect(FILE_ACCESS, b.command, b.path, fileAccess);
  }
  return {
    state: 'ready',
    fetched_at: now(),
    files: info.files,
    size: info.size,
    symlinks: info.symlinks,
    manifest,
    skill_docs: skillDocs,
    scripts,
    bang_commands: bang,
    hooks,
    mcp_config: mcp,
    commands,
    agents,
    flags: {
      hooks: hooks.length > 0,
      mcp: mcp.length > 0,
      runs_on_load: bang.length > 0,
      scripts: scripts.length > 0,
      allowed_tools: skillDocs.some((d) => d.allowed_tools),
      network: [...network],
      file_access: [...fileAccess],
    },
  };
}

/** Check the folder has the shape its kind needs. */
function shapeError(kind: string, root: string): string | null {
  if (kind === 'skill' && !existsSync(join(root, 'SKILL.md'))) return 'No SKILL.md at the top of the fetched folder. Give the subpath of the folder that contains SKILL.md.';
  if (kind === 'plugin') {
    const markers = ['.claude-plugin/plugin.json', 'skills', 'commands', 'agents', 'hooks'];
    if (!markers.some((m) => existsSync(join(root, m)))) return 'This does not look like a plugin: no .claude-plugin/plugin.json, skills/, commands/, agents/ or hooks/ at the top. Give the subpath of the plugin folder.';
  }
  return null;
}

// ---------- items ----------

export const parse = (s: string, fallback: any = {}) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

export function getItem(id: string): Row | undefined {
  return get('SELECT * FROM toolbox_items WHERE id = ?', id);
}

function setItem(id: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const vals = keys.map((k) => (fields[k] !== null && typeof fields[k] === 'object' ? JSON.stringify(fields[k]) : fields[k]));
  run(`UPDATE toolbox_items SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...vals, now(), id);
  publishToolbox();
}

export function addItemMessage(itemId: string, author: 'user' | 'director' | 'system', name: string, body: string) {
  run('INSERT INTO toolbox_messages (item_id, author, author_name, body, created_at) VALUES (?,?,?,?,?)', itemId, author, name, body, now());
  publishToolbox();
}

/** Names usable as an MCP server key, a plugin name and a folder name. */
export const safeName = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

const normSource = (s: string) => s.trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/, '');

/** A nix flake reference fixed to one revision. */
export function pinnedFlake(ref: string): boolean {
  return /[?&](rev|narHash)=/.test(ref) || /\/[0-9a-f]{40}(?=[#?]|$)/.test(ref) || /^(github|gitlab|sourcehut):[^#]+\/[0-9a-f]{40}/.test(ref);
}

export type ProposalInput = {
  kind: Kind;
  name: string;
  source_type: (typeof SOURCE_TYPES)[number];
  source: string;
  pin?: string;
  subpath?: string;
  summary: string;
  homepage?: string;
  maintainer?: string;
  license?: string;
  adoption?: string;
  problem: string;
  evidence: string;
  install_effect: string;
  access: string;
  risks: string;
  recommendation: 'install' | 'do not install' | 'undecided';
  recommendation_reason: string;
  suggested_scope?: string[];
  command?: string;
  args?: string[];
  auth?: string;
  secrets?: { name: string; where: 'header' | 'env'; description?: string }[];
  tools?: { name: string; description?: string }[];
  alternatives?: string;
};

/** Why Helm cannot install this proposal itself, or '' if it can. */
export function notInstallableReason(p: Pick<ProposalInput, 'kind' | 'source_type' | 'source' | 'auth'>): string {
  if (p.kind === 'skill' || p.kind === 'plugin') {
    return p.source_type === 'git' || p.source_type === 'path' ? '' : 'Helm installs skills and plugins only from a git repository at a commit or from a folder on this machine.';
  }
  if (p.kind === 'mcp_http') {
    if (p.source_type !== 'http_url' || !/^https?:\/\//.test(p.source)) return 'An HTTP MCP server needs its URL as the source.';
    if (/oauth/i.test(p.auth ?? '')) return 'This server needs an interactive OAuth sign-in; Helm can only send fixed headers.';
    return '';
  }
  if (p.source_type === 'nix_flake') {
    return pinnedFlake(p.source) ? '' : 'The flake reference is not pinned to a revision (give e.g. github:owner/repo/<40-character commit>#package).';
  }
  return `Cannot be installed by Helm yet: version 1 runs local (stdio) MCP servers only from a pinned Nix flake reference. ${p.source_type === 'npm' ? 'npm packages' : p.source_type === 'pypi' ? 'PyPI packages' : 'Other sources'} would need vendoring and sandboxing, which are not built.`;
}

/** An earlier item that a new proposal would repeat. */
export function findEquivalent(name: string, source: string, exceptId?: string): Row | undefined {
  const n = safeName(name);
  const s = normSource(source);
  return all("SELECT * FROM toolbox_items WHERE status != 'removed' ORDER BY updated_at DESC").find(
    (r) => r.id !== exceptId && (safeName(r.name) === n || (s && normSource(parse(r.source).ref ?? '') === s)),
  );
}

function proposalFields(p: ProposalInput) {
  const reason = notInstallableReason(p);
  return {
    kind: p.kind,
    name: p.name.trim(),
    summary: p.summary,
    source: { type: p.source_type, ref: p.source.trim(), subpath: p.subpath?.trim() || '', pin: p.pin?.trim() || '', homepage: p.homepage ?? '' },
    proposal: {
      maintainer: p.maintainer ?? '', license: p.license ?? '', adoption: p.adoption ?? '', homepage: p.homepage ?? '',
      problem: p.problem, evidence: p.evidence, install_effect: p.install_effect, access: p.access, risks: p.risks,
      recommendation: p.recommendation, recommendation_reason: p.recommendation_reason, suggested_scope: p.suggested_scope ?? ['all'],
      alternatives: p.alternatives ?? '',
    },
    launch: p.kind === 'mcp_http'
      ? { type: 'http', url: p.source.trim(), auth: p.auth ?? 'none', secrets: p.secrets ?? [] }
      : p.kind === 'mcp_stdio'
        ? { type: 'stdio', flake: p.source.trim(), command: p.command ?? '', args: p.args ?? [], secrets: p.secrets ?? [] }
        : {},
    installable: reason ? 0 : 1,
    not_installable_reason: reason,
    review: p.kind === 'mcp_http' || p.kind === 'mcp_stdio'
      ? {
          state: 'ready', fetched_at: now(), url: p.kind === 'mcp_http' ? p.source.trim() : undefined, auth: p.auth ?? 'none', tools: p.tools ?? [],
          launch: p.kind === 'mcp_stdio' ? `nix build --out-link <toolbox>/gcroots/<id> '${p.source.trim()}', then run <store path>/${p.command || 'bin/<name>'} ${(p.args ?? []).join(' ')}`.trim() : undefined,
          secrets: p.secrets ?? [],
        }
      : reason ? { state: 'none' } : { state: 'fetching' },
  };
}

export function createProposal(p: ProposalInput, by: { agentId: string | null; projectId: string | null; origin: 'agent' | 'import' }, fetch = true): Row {
  const id = newId('tb');
  const f = proposalFields(p);
  run(
    `INSERT INTO toolbox_items (id, kind, name, status, summary, source, proposal, launch, installable, not_installable_reason, review, origin, proposed_by_agent, proposed_in_project, scope, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, f.kind, f.name, 'proposed', f.summary, JSON.stringify(f.source), JSON.stringify(f.proposal), JSON.stringify(f.launch), f.installable, f.not_installable_reason,
    JSON.stringify(f.review), by.origin, by.agentId, by.projectId, 'all', now(), now(),
  );
  publishToolbox();
  if (fetch && f.review.state === 'fetching') void fetchForReview(id);
  return getItem(id)!;
}

/** The director's answer to "Ask about it": a revised proposal replaces the old fields and is fetched again. */
export function updateProposal(id: string, p: ProposalInput) {
  const f = proposalFields(p);
  removeTree(join(STAGING, id));
  setItem(id, { ...f, status: 'proposed', content_hash: '', pin: {}, error: '' });
  if (f.review.state === 'fetching') void fetchForReview(id);
}

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
/** Hooks, external transports and symlinks off: fetching must not run anything from the source. */
const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.symlinks=false', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always', '-c', 'protocol.git.allow=always', '-c', 'protocol.file.allow=always', '-c', 'submodule.recurse=false'];

async function git(cwd: string, args: string[]) {
  const { stdout } = await exec('git', [...GIT_SAFE, ...args], { cwd, env: GIT_ENV, timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

function inside(root: string, sub: string): string {
  const abs = resolve(root, sub || '.');
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error('The subpath leaves the repository.');
  return abs;
}

/** Helm, not the agent, fetches the source into staging, hashes it and builds the review. Nothing from the source is executed. */
export async function fetchForReview(id: string): Promise<void> {
  const item = getItem(id);
  if (!item) return;
  const source = parse(item.source);
  const stage = join(STAGING, id);
  removeTree(stage);
  mkdirSync(stage, { recursive: true });
  const tree = join(stage, 'tree');
  try {
    let resolved: Review['resolved'] = {};
    if (source.type === 'git') {
      const repo = join(stage, 'repo');
      mkdirSync(repo);
      await git(repo, ['init', '-q']);
      const want = source.pin || 'HEAD';
      try {
        await git(repo, ['fetch', '-q', '--depth', '1', '--no-tags', '--', source.ref, want]);
      } catch {
        // Servers that refuse a bare commit in a shallow fetch: fetch everything, then pick the commit.
        await git(repo, ['fetch', '-q', '--no-tags', '--', source.ref, '+refs/heads/*:refs/remotes/origin/*']);
      }
      let commit: string;
      try {
        commit = await git(repo, ['rev-parse', '--verify', `${want === 'HEAD' ? 'FETCH_HEAD' : want}^{commit}`]);
      } catch {
        commit = await git(repo, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
      }
      await git(repo, ['checkout', '-q', '--detach', commit]);
      copyTree(inside(repo, source.subpath), tree);
      removeTree(repo);
      resolved = { commit, requested: source.pin || '(default branch)' };
    } else if (source.type === 'path') {
      const abs = resolve(source.ref, source.subpath || '.');
      if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`Folder not found: ${abs}`);
      copyTree(abs, tree);
      resolved = { path: abs };
    } else {
      throw new Error(`Helm cannot fetch a ${source.type} source.`);
    }
    const shape = shapeError(item.kind, tree);
    if (shape) throw new Error(shape);
    const info = hashTree(tree);
    const review = { ...snapshotTree(tree, info), resolved };
    setTreeWritable(tree, false);
    if (!getItem(id)) return removeTree(stage);
    setItem(id, { review, content_hash: info.hash, pin: { commit: resolved.commit ?? '', path: resolved.path ?? '', hash: info.hash } });
  } catch (err: any) {
    removeTree(stage);
    setItem(id, { review: { state: 'failed', error: String(err?.stderr || err?.message || err).trim().slice(0, 1500), fetched_at: now() } });
  }
}

// ---------- install, decline, remove ----------

const secretFile = (id: string) => join(SECRETS, `${id}.json`);

function readSecrets(id: string): { headers: Record<string, string>; env: Record<string, string> } {
  const f = secretFile(id);
  if (!existsSync(f)) return { headers: {}, env: {} };
  return { headers: {}, env: {}, ...parse(readFileSync(f, 'utf8')) };
}

function pluginNameFor(item: Row, tree: string): string {
  if (item.kind === 'plugin') {
    const m = join(tree, '.claude-plugin', 'plugin.json');
    if (existsSync(m)) {
      const n = parse(readFileSync(m, 'utf8')).name;
      if (typeof n === 'string' && n) return n;
    }
  }
  return safeName(item.name) || 'toolbox-item';
}

/** Copy the reviewed tree into its pinned, read-only place. Returns [path, hash of what sessions get]. */
function placeTree(item: Row): { path: string; hash: string } {
  const tree = join(STAGING, item.id, 'tree');
  if (!existsSync(tree)) throw new Error('The reviewed copy is gone; fetch it again.');
  const current = hashTree(tree);
  if (current.hash !== item.content_hash) throw new Error('The reviewed copy changed after review; fetch it again and re-review.');
  const dest = join(ITEMS, item.id, item.content_hash);
  removeTree(dest);
  if (item.kind === 'skill') {
    const skillName = safeName(parse(item.review).skill_docs?.[0]?.name || item.name) || 'skill';
    copyTree(tree, join(dest, 'skills', skillName));
    mkdirSync(join(dest, '.claude-plugin'), { recursive: true });
    writeFileAtomic(join(dest, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: pluginNameFor(item, tree), description: item.summary.slice(0, 300) }, null, 2) + '\n');
  } else {
    copyTree(tree, dest);
  }
  setTreeWritable(dest, false);
  return { path: dest, hash: hashTree(dest).hash };
}

export type InstallInput = { scope: 'all' | 'selected'; projects?: string[]; secrets?: Record<string, string> };

/** Approve and install. Long steps (nix build) continue in the background with status 'installing'. */
export function installItem(id: string, input: InstallInput): string | null {
  const item = getItem(id);
  if (!item) return 'No such item.';
  if (!['proposed', 'failed', 'declined'].includes(item.status)) return `It is ${item.status}.`;
  if (!item.installable) return item.not_installable_reason || 'Helm cannot install this.';
  const review = parse(item.review);
  if ((item.kind === 'skill' || item.kind === 'plugin') && review.state !== 'ready') return review.state === 'fetching' ? 'Still being fetched for review.' : 'The review copy could not be fetched.';
  if (input.scope === 'selected' && !input.projects?.length) return 'Choose at least one project.';
  const launch = parse(item.launch);
  const needed: { name: string; where: string }[] = launch.secrets ?? [];
  const missing = needed.filter((s) => !input.secrets?.[s.name]?.trim());
  if (missing.length) return `Needs ${missing.map((s) => s.name).join(', ')}.`;

  run('DELETE FROM toolbox_scope WHERE item_id = ?', id);
  if (input.scope === 'selected') for (const p of input.projects!) run('INSERT OR REPLACE INTO toolbox_scope (item_id, project_id, enabled) VALUES (?,?,1)', id, p);
  if (needed.length) {
    const secrets = { headers: {} as Record<string, string>, env: {} as Record<string, string> };
    for (const s of needed) (s.where === 'header' ? secrets.headers : secrets.env)[s.name] = input.secrets![s.name].trim();
    writeFileAtomic(secretFile(id), JSON.stringify(secrets), { mode: 0o600 });
    chmodSync(secretFile(id), 0o600);
  }
  setItem(id, { scope: input.scope, decided_at: now(), status: 'installing', error: '', integrity: '' });

  if (item.kind === 'skill' || item.kind === 'plugin') {
    try {
      const placed = placeTree(item);
      setItem(id, { status: 'installed', install_path: placed.path, install_hash: placed.hash });
    } catch (err: any) {
      setItem(id, { status: 'failed', error: String(err?.message ?? err) });
    }
  } else if (item.kind === 'mcp_http') {
    setItem(id, { status: 'installed', pin: { url: launch.url } });
  } else {
    void buildFlake(id, launch);
  }
  return null;
}

async function buildFlake(id: string, launch: Row) {
  const link = join(GCROOTS, id);
  try {
    await exec('nix', ['build', '--no-write-lock-file', '--out-link', link, '--', launch.flake], { timeout: 45 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
    const out = realpathSync(link);
    let command = launch.command as string;
    if (!command) {
      const bin = join(out, 'bin');
      const entries = existsSync(bin) ? readdirSync(bin) : [];
      if (entries.length !== 1) throw new Error(`Built ${out}, but it has ${entries.length} programs in bin/; the proposal must name the command (e.g. bin/server).`);
      command = `bin/${entries[0]}`;
    }
    const abs = inside(out, command);
    if (!existsSync(abs)) throw new Error(`Built ${out}, but ${command} is not in it.`);
    setItem(id, { status: 'installed', install_path: abs, pin: { store_path: out, flake: launch.flake }, content_hash: basename(out).slice(0, 32) });
  } catch (err: any) {
    try {
      unlinkSync(link);
    } catch {
      /* none */
    }
    const text = String(err?.stderr || err?.message || err).trim();
    const at = text.search(/error:/);
    setItem(id, { status: 'failed', error: (at >= 0 ? text.slice(at) : text).slice(0, 1500) });
  }
}

export function declineItem(id: string, note: string): string | null {
  const item = getItem(id);
  if (!item) return 'No such item.';
  if (!note.trim()) return 'Give a reason; it is kept so the item is not proposed again.';
  if (item.status !== 'proposed' && item.status !== 'failed') return `It is ${item.status}.`;
  removeTree(join(STAGING, id));
  setItem(id, { status: 'declined', decided_note: note.trim(), decided_at: now() });
  return null;
}

/** Remove an installed item: files, gc root and secrets go; the row stays as history. Returns affected project ids. */
export function removeItem(id: string): string[] | string {
  const item = getItem(id);
  if (!item) return 'No such item.';
  const affected = projectsFor(item);
  removeTree(join(ITEMS, id));
  removeTree(join(STAGING, id));
  for (const f of [join(GCROOTS, id), secretFile(id)]) {
    try {
      unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
  setItem(id, { status: 'removed', install_path: '', install_hash: '', decided_at: now() });
  return affected;
}

/** Turn an installed item on or off for one project. */
export function setProjectEnabled(id: string, projectId: string, enabled: boolean) {
  run('INSERT OR REPLACE INTO toolbox_scope (item_id, project_id, enabled) VALUES (?,?,?)', id, projectId, enabled ? 1 : 0);
  publishToolbox();
}

export function setScope(id: string, scope: 'all' | 'selected') {
  setItem(id, { scope });
}

// ---------- which items a project gets ----------

export function appliesTo(item: Row, projectId: string): boolean {
  const row = get('SELECT enabled FROM toolbox_scope WHERE item_id = ? AND project_id = ?', item.id, projectId);
  return item.scope === 'all' ? row?.enabled !== 0 : row?.enabled === 1;
}

export function projectsFor(item: Row): string[] {
  return all('SELECT id FROM projects WHERE archived = 0').map((p) => p.id).filter((p) => appliesTo(item, p));
}

export function itemsForProject(projectId: string): Row[] {
  return all("SELECT * FROM toolbox_items WHERE status = 'installed' ORDER BY name").filter((i) => appliesTo(i, projectId));
}

export type Expected = { id: string; name: string; kind: string; path?: string; server?: string };
export type LoadState = { id: string; name: string; kind: string; state: 'loaded' | 'failed' | 'skipped' | 'pending'; detail: string };

/**
 * The plugins and MCP servers to hand to a new session of an agent on this
 * project. Each installed tree is re-hashed first; a mismatch is skipped and
 * flagged on the item.
 */
export function sessionToolbox(projectId: string): { plugins: SdkPluginConfig[]; mcpServers: Record<string, McpServerConfig>; expected: Expected[]; skipped: LoadState[] } {
  const plugins: SdkPluginConfig[] = [];
  const mcpServers: Record<string, McpServerConfig> = {};
  const expected: Expected[] = [];
  const skipped: LoadState[] = [];
  for (const item of itemsForProject(projectId)) {
    const skip = (detail: string) => {
      skipped.push({ id: item.id, name: item.name, kind: item.kind, state: 'skipped', detail });
      if (item.integrity !== detail) setItem(item.id, { integrity: detail });
    };
    try {
      if (item.kind === 'skill' || item.kind === 'plugin') {
        if (!existsSync(item.install_path)) {
          skip('The installed copy is missing.');
          continue;
        }
        const h = hashTree(item.install_path).hash;
        if (h !== item.install_hash) {
          skip(`Installed files changed since install (hash ${h.slice(0, 12)}, expected ${item.install_hash.slice(0, 12)}). Not loaded.`);
          continue;
        }
        plugins.push({ type: 'local', path: item.install_path, skipMcpDiscovery: true });
        expected.push({ id: item.id, name: item.name, kind: item.kind, path: item.install_path });
      } else {
        const key = safeName(item.name);
        const secrets = readSecrets(item.id);
        const launch = parse(item.launch);
        if (item.kind === 'mcp_http') {
          mcpServers[key] = { type: 'http', url: launch.url, headers: Object.keys(secrets.headers).length ? secrets.headers : undefined };
        } else {
          const pin = parse(item.pin);
          const link = join(GCROOTS, item.id);
          if (!existsSync(link) || realpathSync(link) !== pin.store_path || !existsSync(item.install_path)) {
            skip('The pinned Nix build is missing or no longer matches.');
            continue;
          }
          mcpServers[key] = { type: 'stdio', command: item.install_path, args: launch.args ?? [], env: Object.keys(secrets.env).length ? secrets.env : undefined };
        }
        expected.push({ id: item.id, name: item.name, kind: item.kind, server: key });
      }
      if (item.integrity) setItem(item.id, { integrity: '' });
    } catch (err: any) {
      skip(`Could not check it: ${String(err?.message ?? err)}`);
    }
  }
  return { plugins, mcpServers, expected, skipped };
}

/** Pair what a session was given with what its init message (or a later MCP status) says loaded. */
export function loadStates(
  expected: Expected[],
  skipped: LoadState[],
  init: { plugins?: { path: string }[]; plugin_errors?: { path?: string; message: string; plugin: string }[]; mcp_servers?: { name: string; status: string; error?: string }[] },
): LoadState[] {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const out: LoadState[] = [...skipped];
  for (const e of expected) {
    if (e.path) {
      const p = real(e.path);
      const err = init.plugin_errors?.find((x) => x.path && real(x.path) === p);
      const loaded = init.plugins?.some((x) => real(x.path) === p);
      out.push({ id: e.id, name: e.name, kind: e.kind, state: err && !loaded ? 'failed' : loaded ? 'loaded' : 'failed', detail: err ? `${err.plugin}: ${err.message}` : loaded ? '' : 'Not reported as loaded.' });
    } else {
      const s = init.mcp_servers?.find((x) => x.name === e.server);
      const state = !s ? 'failed' : s.status === 'connected' ? 'loaded' : s.status === 'pending' ? 'pending' : 'failed';
      out.push({ id: e.id, name: e.name, kind: e.kind, state, detail: s ? (s.status === 'connected' ? '' : `${s.status}${s.error ? `: ${s.error}` : ''}`) : 'Not reported by the session.' });
    }
  }
  return out;
}

// ---------- views ----------

export function itemView(r: Row, liveAgents: Set<string>): Row {
  const scopeRows = all('SELECT project_id, enabled FROM toolbox_scope WHERE item_id = ?', r.id);
  const launch = parse(r.launch);
  const loadedBy = all("SELECT id, name, project_id, toolbox_loaded FROM agents WHERE toolbox_loaded != ''")
    .filter((a) => liveAgents.has(a.id))
    .map((a) => ({ id: a.id, name: a.name, project_id: a.project_id, state: (parse(a.toolbox_loaded, {}).items ?? []).find((x: LoadState) => x.id === r.id)?.state }))
    .filter((a) => a.state);
  const proposer = r.proposed_by_agent ? get('SELECT name FROM agents WHERE id = ?', r.proposed_by_agent) : undefined;
  const project = r.proposed_in_project ? get('SELECT name FROM projects WHERE id = ?', r.proposed_in_project) : undefined;
  return {
    ...r,
    source: parse(r.source),
    pin: parse(r.pin),
    launch: { ...launch, has_secrets: existsSync(secretFile(r.id)) },
    review: parse(r.review),
    proposal: parse(r.proposal),
    scope_rows: scopeRows,
    applies_to: r.status === 'installed' ? projectsFor(r) : [],
    loaded_by: loadedBy,
    proposer_name: proposer?.name ?? null,
    project_name: project?.name ?? null,
    messages: all('SELECT * FROM toolbox_messages WHERE item_id = ? ORDER BY id', r.id),
  };
}

/** One line per item, for agents. */
export function toolboxText(projectId: string | null): string {
  const items = all("SELECT * FROM toolbox_items WHERE status != 'removed' ORDER BY status, name");
  if (!items.length) return 'The Toolbox is empty.';
  return items
    .map((i) => {
      const applies = projectId && i.status === 'installed' ? (appliesTo(i, projectId) ? ', enabled for this project' : ', not enabled for this project') : '';
      const why = i.status === 'declined' ? `\n  declined: ${i.decided_note}` : i.status === 'failed' ? `\n  install failed: ${i.error}` : '';
      const flag = i.integrity ? `\n  problem: ${i.integrity}` : '';
      return `- ${i.name} (${i.kind}, ${i.status}${applies}; id ${i.id}): ${i.summary}${why}${flag}`;
    })
    .join('\n');
}

export const relTo = (root: string, p: string) => relative(root, p) || '.';

/**
 * Fetch an installed skill or plugin again from its (local) source and, once
 * the owner has asked for it, pin the new copy in place of the old one.
 */
export async function refreshFromSource(id: string): Promise<string | null> {
  const item = getItem(id);
  if (!item) return 'No such item.';
  if (item.kind !== 'skill' && item.kind !== 'plugin') return 'Only skills and plugins can be refreshed.';
  const oldPath = item.install_path;
  await fetchForReview(id);
  const fresh = getItem(id)!;
  if (parse(fresh.review).state !== 'ready') return parse(fresh.review).error ?? 'Could not fetch it again.';
  if (item.status !== 'installed') return null;
  try {
    const placed = placeTree(fresh);
    setItem(id, { install_path: placed.path, install_hash: placed.hash, integrity: '', decided_at: now() });
    if (oldPath && oldPath !== placed.path) removeTree(oldPath);
    return null;
  } catch (err: any) {
    return String(err?.message ?? err);
  }
}


// ---------- propose_tool ----------

/** propose_tool for the top-level agent: a new proposal, a revision (update_of) or an answer in an item's thread. */
export function proposeFromAgent(agent: Row, input: Partial<ProposalInput> & { update_of?: string; message?: string; reconsider?: string }): { text: string; error?: boolean } {
  const err = (text: string) => ({ text, error: true });
  const done = (text: string) => ({ text });
  const prev = input.update_of ? getItem(input.update_of) : undefined;
  if (input.update_of && !prev) return err(`No Toolbox item ${input.update_of}.`);
  if (prev && input.message) addItemMessage(prev.id, 'director', agent.name, input.message);
  const fields = ['kind', 'name', 'source_type', 'source', 'summary', 'problem', 'evidence', 'install_effect', 'access', 'risks', 'recommendation', 'recommendation_reason'] as const;
  if (prev && !fields.some((k) => input[k] !== undefined)) {
    return done(input.message ? `Answer posted on "${prev.name}".` : 'Nothing to change: pass message, or the fields to revise.');
  }
  const base = prev ? { ...JSON.parse(prev.proposal), kind: prev.kind, name: prev.name, summary: prev.summary, source_type: JSON.parse(prev.source).type, source: JSON.parse(prev.source).ref, pin: JSON.parse(prev.source).pin, subpath: JSON.parse(prev.source).subpath, ...JSON.parse(prev.launch) } : {};
  const p = { ...base, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as ProposalInput & { reconsider?: string };
  const missing = fields.filter((k) => !(p as any)[k]);
  if (missing.length) return err(`Missing: ${missing.join(', ')}. A proposal must let the user judge it without further research.`);
  if (safeName(p.name) === 'helm' || !safeName(p.name)) return err('Choose another name.');
  if (prev && prev.status !== 'proposed' && prev.status !== 'failed') return err(`"${prev.name}" is ${prev.status}; only open proposals can be revised. Propose it as a new item.`);
  if (!prev) {
    const eq = findEquivalent(p.name, p.source);
    if (eq?.status === 'declined' && !input.reconsider) {
      return err(`An equivalent item, "${eq.name}" (${eq.id}), was declined by the user on ${new Date(eq.decided_at ?? eq.updated_at).toISOString().slice(0, 10)}: "${eq.decided_note}". Do not propose it again unless something material has changed; if it has, call again with reconsider explaining what.`);
    }
    if (eq && eq.status !== 'declined') return err(`The Toolbox already has "${eq.name}" (${eq.id}, ${eq.status}). Use update_of to revise an open proposal, or list_toolbox to see it.`);
  }
  if (prev) {
    updateProposal(prev.id, p);
    addItemMessage(prev.id, 'system', 'Helm', `${agent.name} revised the proposal.`);
    return done(`Revised "${p.name}" (${prev.id}). It is back in the user's Proposed list.`);
  }
  const item = createProposal(p, { agentId: agent.id, projectId: agent.project_id, origin: 'agent' });
  if (input.reconsider) addItemMessage(item.id, 'director', agent.name, `Proposed again after an earlier decline. What changed: ${input.reconsider}`);
  addJournal(agent.project_id, agent.id, 'note', `Proposed for the Toolbox: ${item.name}`, `${item.summary}\n\nRecommendation: ${p.recommendation}. ${p.recommendation_reason}`);
  return done(`Proposed "${item.name}" (${item.id}). It is on the Toolbox page for the user's review${item.installable ? '' : `; Helm cannot install it itself: ${item.not_installable_reason.replace(/\.$/, '')}`}. The user's decision shows in list_toolbox; do not wait for it.`);
}

/** Put the reviewed copy back in place after the installed files were changed or lost. */
export function repairItem(id: string): string | null {
  const item = getItem(id);
  if (!item || item.status !== 'installed') return 'Only installed items can be repaired.';
  if (item.kind !== 'skill' && item.kind !== 'plugin') return 'Only skills and plugins have files to repair.';
  try {
    const placed = placeTree(item);
    setItem(id, { install_path: placed.path, install_hash: placed.hash, integrity: '' });
    return null;
  } catch (err: any) {
    return String(err?.message ?? err);
  }
}
