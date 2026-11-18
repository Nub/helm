import { posix } from 'node:path';

/**
 * The danger check: a deterministic floor under permission triage. A permission request it flags always goes to
 * the user, whoever would otherwise answer it (the director, or the independent check for the director's own);
 * nothing an agent says can change the result. It is a pure function of the tool name, the tool input and the
 * context below (project folder, home, the agent's worktrees, whether the target is a remote host), so it can be
 * tested as a table (danger.test.ts).
 *
 * It catches the clear cases and errs toward flagging: anything it cannot parse confidently (unbalanced quotes,
 * eval, a shell fed from a pipe, a command name computed at run time, very long or deeply nested commands) is
 * dangerous by default. It is a floor, not a guarantee. Known holes:
 * - scripts a command runs from files (node x.mjs, python file.py, npm run x, bash x.sh) are not read;
 * - inline interpreter code (node -e, python -c, a heredoc into an interpreter) is flagged when it starts programs,
 *   or changes files and names a place outside the project, its worktrees and /tmp; a path it builds at run time
 *   (from argv, a directory listing, string concatenation) is not seen;
 * - relative paths resolve from the Bash tool's working folder as Helm last saw it (ctx.cwd, from the session's
 *   PreToolUse hook, which carries the cwd the call will run in), else the project folder;
 * - anything outside the shell's own semantics: aliases and functions defined in rc files, programs that delete
 *   things themselves (a build script's clean step, a tool's own cache pruning).
 */

export type DangerContext = {
  /** The project folder, absolute. */
  project: string;
  /** The user's home directory. */
  home: string;
  /** Helm's data folder (~/.helm): never written or deleted by an agent. */
  helmData?: string;
  /** Other git worktrees of the project (agents' own workspaces): writable like the project, and discarding changes there is allowed. */
  worktrees?: string[];
  /** Pids no agent may signal (Helm's own). */
  protectedPids?: number[];
  /** Resolve symlinks for a path (the longest existing prefix). Identity when not given. */
  realpath?: (p: string) => string;
  /** The command runs on another machine: only /tmp there is a scratch area. */
  remote?: boolean;
  /** The Bash tool's working folder, if known; relative paths resolve from it (default: the project folder). */
  cwd?: string;
};

export type Danger = { dangerous: boolean; reason: string; reasons: string[] };

const MAX_COMMAND = 2000;
const MAX_DEPTH = 4;

// ---------- a conservative shell parser ----------

/**
 * A word: `pat` holds its characters with quoting removed, except that characters which were quoted and would be
 * special unquoted (globs, braces, tilde, backslash) are kept escaped with a backslash, and every expansion whose
 * value is not known ($var, $(...), `...`) is a NUL character. `raw` is the source text.
 */
type Word = { pat: string; dyn: boolean; raw: string };
type Redir = { op: string; target?: Word; body?: string };
type Cmd = { words: Word[]; redirs: Redir[]; level: number; sep: string; pipeline: number; stage: number; stages: number };

const SPECIAL = new Set(['*', '?', '[', ']', '{', '}', '~', '\\', ',']);
const esc = (ch: string) => (SPECIAL.has(ch) ? `\\${ch}` : ch);
const escAll = (s: string) => [...s].map(esc).join('');
const DYN = '\0';
const KNOWN_VARS = new Set(['HOME', 'USER', 'PWD']);

type Shared = { pipelines: number; heredocChars: number; errors: string[]; cmds: Cmd[] };

class Parser {
  i = 0;
  pending: { redir: Redir; delim: string; strip: boolean; expand: boolean }[] = [];
  s: string;
  sh: Shared;
  vars: Record<string, string>;
  constructor(s: string, sh: Shared, vars: Record<string, string>) {
    this.s = s;
    this.sh = sh;
    this.vars = vars;
  }
  err(msg: string) {
    this.sh.errors.push(msg);
  }
  peek(k = 0) {
    return this.s[this.i + k];
  }
  skipBlanks() {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r') this.i++;
      else if (c === '\\' && this.peek(1) === '\n') this.i += 2;
      else if (c === '#') {
        while (this.i < this.s.length && this.peek() !== '\n') this.i++;
      } else return;
    }
  }
  newline() {
    this.i++;
    this.readHeredocs();
  }
  /** A list of pipelines up to `term` (consumed) or the end. */
  parseList(level: number, term: string | null) {
    let sep = ';';
    for (;;) {
      this.skipBlanks();
      const c = this.peek();
      if (c === undefined) {
        if (term) this.err(`missing "${term}"`);
        return;
      }
      if (c === '\n') {
        this.newline();
        sep = ';';
        continue;
      }
      if (term && c === term) {
        this.i++;
        return;
      }
      if (c === ';') {
        this.i++;
        sep = ';';
        continue;
      }
      if (c === '&' && this.peek(1) === '&') {
        this.i += 2;
        sep = '&&';
        continue;
      }
      if (c === '|' && this.peek(1) === '|') {
        this.i += 2;
        sep = '||';
        continue;
      }
      if (c === '&') {
        this.i++;
        sep = '&';
        continue;
      }
      if (c === ')' || c === '|') {
        this.err(`unexpected "${c}"`);
        this.i++;
        continue;
      }
      const before = this.i;
      this.parsePipeline(level, sep);
      if (this.i === before) {
        this.err(`cannot parse at "${this.s.slice(this.i, this.i + 20)}"`);
        this.i++;
      }
      sep = ';';
    }
  }
  parsePipeline(level: number, sep: string) {
    const id = this.sh.pipelines++;
    const mine: Cmd[] = [];
    for (let stage = 0; ; stage++) {
      const c = this.parseCommand(level, sep, id, stage);
      if (c) mine.push(c);
      this.skipBlanks();
      if (this.peek() === '|' && this.peek(1) !== '|') {
        this.i++;
        if (this.peek() === '&') this.i++;
        for (;;) {
          this.skipBlanks();
          if (this.peek() === '\n') this.newline();
          else break;
        }
        continue;
      }
      for (const m of mine) m.stages = stage + 1;
      return;
    }
  }
  parseCommand(level: number, sep: string, pipeline: number, stage: number): Cmd | null {
    this.skipBlanks();
    if (this.peek() === '(') {
      this.i++;
      if (this.peek() === '(') {
        // (( arithmetic ))
        const end = this.s.indexOf('))', this.i);
        if (end < 0) this.err('unterminated (( ))');
        const inner = this.s.slice(this.i + 1, end < 0 ? undefined : end);
        if (/\$\(|`/.test(inner)) this.err('command substitution inside arithmetic');
        this.i = end < 0 ? this.s.length : end + 2;
        return null;
      }
      this.parseList(level + 1, ')');
      // Redirections after a subshell apply to all of it; check them as a command of their own.
      const cmd: Cmd = { words: [], redirs: [], level, sep, pipeline, stage, stages: 1 };
      this.parseWords(cmd, level);
      this.sh.cmds.push(cmd);
      return cmd;
    }
    const cmd: Cmd = { words: [], redirs: [], level, sep, pipeline, stage, stages: 1 };
    this.parseWords(cmd, level);
    this.sh.cmds.push(cmd);
    return cmd;
  }
  parseWords(cmd: Cmd, level: number) {
    for (;;) {
      this.skipBlanks();
      const c = this.peek();
      if (c === undefined || '\n;&|)'.includes(c)) {
        if (c === '&' && this.peek(1) === '>') {
          this.parseRedir(cmd, level);
          continue;
        }
        return;
      }
      if (c === '(') {
        // f() { ...; } : the body follows as ordinary commands.
        if (this.peek(1) === ')') {
          this.i += 2;
          continue;
        }
        return;
      }
      const rest = this.s.slice(this.i, this.i + 4);
      if ((c === '<' || c === '>') && this.peek(1) === '(') {
        // Process substitution: a command whose output is a file name.
        this.i += 2;
        this.parseList(level + 1, ')');
        cmd.words.push({ pat: DYN, dyn: true, raw: '<(...)' });
        continue;
      }
      if (/^\d*[<>]/.test(rest)) {
        this.parseRedir(cmd, level);
        continue;
      }
      const w = this.parseWord(level);
      if (w) cmd.words.push(w);
      else return;
    }
  }
  parseRedir(cmd: Cmd, level: number) {
    while (/\d/.test(this.peek() ?? '')) this.i++;
    const ops = ['&>>', '&>', '<<<', '<<-', '<<', '<>', '<&', '>>', '>|', '>&', '<', '>'];
    const op = ops.find((o) => this.s.startsWith(o, this.i))!;
    this.i += op.length;
    this.skipBlanks();
    if (op === '<<' || op === '<<-') {
      const w = this.parseWord(level);
      if (!w) return this.err('heredoc without a delimiter');
      const quoted = /['"\\]/.test(w.raw);
      const redir: Redir = { op, body: '' };
      cmd.redirs.push(redir);
      this.pending.push({ redir, delim: unescape(w.pat), strip: op === '<<-', expand: !quoted });
      return;
    }
    const target = this.parseWord(level);
    if (!target) return this.err(`redirection without a target`);
    if (op === '<<<') cmd.redirs.push({ op, body: unescape(target.pat), target });
    else cmd.redirs.push({ op, target });
  }
  readHeredocs() {
    const list = this.pending;
    this.pending = [];
    for (const h of list) {
      let body = '';
      let closed = false;
      while (this.i < this.s.length) {
        let end = this.s.indexOf('\n', this.i);
        if (end < 0) end = this.s.length;
        const line = this.s.slice(this.i, end);
        this.i = Math.min(end + 1, this.s.length);
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) {
          closed = true;
          break;
        }
        body += `${line}\n`;
      }
      if (!closed) this.err(`heredoc "${h.delim}" is not closed`);
      this.sh.heredocChars += body.length;
      h.redir.body = body;
      // An unquoted heredoc expands $(...) and `...`: those run.
      if (h.expand && /\$\(|`/.test(body)) {
        const p = new Parser(body, this.sh, this.vars);
        p.parseDouble(1, null);
      }
    }
  }
  /** One word, or null at a metacharacter. */
  parseWord(level: number): Word | null {
    const start = this.i;
    let pat = '';
    let dyn = false;
    for (;;) {
      const c = this.peek();
      if (c === undefined || ' \t\r\n;&|<>()'.includes(c)) break;
      if (c === '\\') {
        const n = this.peek(1);
        if (n === '\n') {
          this.i += 2;
          continue;
        }
        if (n === undefined) {
          this.i++;
          break;
        }
        pat += esc(n);
        this.i += 2;
        continue;
      }
      if (c === "'") {
        const close = this.s.indexOf("'", this.i + 1);
        if (close < 0) {
          this.err('unterminated single quote');
          this.i = this.s.length;
          break;
        }
        pat += escAll(this.s.slice(this.i + 1, close));
        this.i = close + 1;
        continue;
      }
      if (c === '$' && this.peek(1) === "'") {
        // $'...': escapes like \x72 can spell any command, so those count as unknown.
        let j = this.i + 2;
        let text = '';
        while (j < this.s.length && this.s[j] !== "'") {
          if (this.s[j] === '\\') {
            const n = this.s[j + 1] ?? '';
            if (/[xuUc0-7]/.test(n)) { dyn = true; text += DYN; }
            text += ({ n: '\n', t: '\t', '\\': '\\', "'": "'", '"': '"' } as Record<string, string>)[n] ?? n;
            j += 2;
          } else text += this.s[j++];
        }
        if (j >= this.s.length) this.err("unterminated $'");
        pat += escAll(text);
        this.i = j + 1;
        continue;
      }
      if (c === '"') {
        this.i++;
        const r = this.parseDouble(level, '"');
        pat += r.pat;
        dyn ||= r.dyn;
        continue;
      }
      if (c === '$') {
        const r = this.parseDollar(level, false);
        pat += r.pat;
        dyn ||= r.dyn;
        continue;
      }
      if (c === '`') {
        this.parseBacktick(level);
        pat += DYN;
        dyn = true;
        continue;
      }
      pat += c;
      this.i++;
    }
    if (this.i === start) return null;
    return { pat, dyn, raw: this.s.slice(start, this.i) };
  }
  /** Inside double quotes (or an unquoted heredoc body when `end` is null). */
  parseDouble(level: number, end: '"' | null): { pat: string; dyn: boolean } {
    let pat = '';
    let dyn = false;
    for (;;) {
      const c = this.peek();
      if (c === undefined) {
        if (end) this.err('unterminated double quote');
        break;
      }
      if (c === end) {
        this.i++;
        break;
      }
      if (c === '\\') {
        const n = this.peek(1);
        if (n === '\n') {
          this.i += 2;
          continue;
        }
        if (n !== undefined && '$`"\\'.includes(n)) {
          pat += esc(n);
          this.i += 2;
          continue;
        }
        pat += esc('\\');
        this.i++;
        continue;
      }
      if (c === '$') {
        const r = this.parseDollar(level, true);
        pat += r.pat;
        dyn ||= r.dyn;
        continue;
      }
      if (c === '`') {
        this.parseBacktick(level);
        pat += DYN;
        dyn = true;
        continue;
      }
      pat += esc(c);
      this.i++;
    }
    return { pat, dyn };
  }
  parseDollar(level: number, quoted: boolean): { pat: string; dyn: boolean } {
    const n = this.peek(1);
    if (n === '(') {
      if (this.peek(2) === '(') {
        let depth = 0;
        let j = this.i + 1;
        for (; j < this.s.length; j++) {
          if (this.s[j] === '(') depth++;
          else if (this.s[j] === ')' && --depth === 0) break;
        }
        const inner = this.s.slice(this.i + 3, j);
        if (/\$\(|`/.test(inner)) this.err('command substitution inside arithmetic');
        if (j >= this.s.length) this.err('unterminated $((');
        this.i = j + 1;
        return { pat: DYN, dyn: true };
      }
      this.i += 2;
      this.parseList(level + 1, ')');
      return { pat: DYN, dyn: true };
    }
    if (n === '{') {
      let depth = 0;
      let j = this.i + 1;
      for (; j < this.s.length; j++) {
        if (this.s[j] === '{') depth++;
        else if (this.s[j] === '}' && --depth === 0) break;
      }
      if (j >= this.s.length) this.err('unterminated ${');
      const inner = this.s.slice(this.i + 2, j);
      this.i = j + 1;
      if (/\$\(|`/.test(inner)) new Parser(inner, this.sh, this.vars).parseList(level + 1, null);
      if (inner in this.vars) return { pat: quoted ? escAll(this.vars[inner]) : this.vars[inner], dyn: false };
      return { pat: DYN, dyn: true };
    }
    const m = /^([A-Za-z_][A-Za-z0-9_]*|[0-9?!$#@*-])/.exec(this.s.slice(this.i + 1));
    if (!m) {
      this.i++;
      return { pat: '$', dyn: false };
    }
    this.i += 1 + m[1].length;
    if (m[1] in this.vars) return { pat: quoted ? escAll(this.vars[m[1]]) : this.vars[m[1]], dyn: false };
    return { pat: DYN, dyn: true };
  }
  parseBacktick(level: number) {
    let j = this.i + 1;
    let inner = '';
    while (j < this.s.length && this.s[j] !== '`') {
      if (this.s[j] === '\\' && j + 1 < this.s.length) {
        inner += this.s[j + 1] === '`' || this.s[j + 1] === '\\' || this.s[j + 1] === '$' ? this.s[j + 1] : this.s[j] + this.s[j + 1];
        j += 2;
      } else inner += this.s[j++];
    }
    if (j >= this.s.length) this.err('unterminated backquote');
    this.i = j + 1;
    new Parser(inner, this.sh, this.vars).parseList(level + 1, null);
  }
}

/** The literal text of a pattern: escapes removed, unknown parts left as NUL. */
function unescape(pat: string): string {
  let out = '';
  for (let i = 0; i < pat.length; i++) {
    if (pat[i] === '\\' && i + 1 < pat.length) out += pat[++i];
    else out += pat[i];
  }
  return out;
}
const lit = (w: Word) => unescape(w.pat);
/** Index of the first unescaped character in `chars`, or -1. */
function findUnescaped(pat: string, chars: string, from = 0): number {
  for (let i = from; i < pat.length; i++) {
    if (pat[i] === '\\') i++;
    else if (chars.includes(pat[i])) return i;
  }
  return -1;
}

/** Brace expansion ({a,b}, {1..3}) of a word; a sequence or too many results is treated as a glob. */
function expandBraces(w: Word, depth = 0): Word[] {
  const open = findUnescaped(w.pat, '{');
  if (open < 0 || depth > 6) return [w];
  let level = 0;
  let close = -1;
  const commas: number[] = [];
  for (let i = open; i < w.pat.length; i++) {
    const c = w.pat[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '{') level++;
    else if (c === '}' && --level === 0) {
      close = i;
      break;
    } else if (c === ',' && level === 1) commas.push(i);
  }
  if (close < 0) return [w];
  const head = w.pat.slice(0, open);
  const tail = w.pat.slice(close + 1);
  if (!commas.length) {
    const inner = w.pat.slice(open + 1, close);
    if (/\.\./.test(inner)) return expandBraces({ ...w, pat: `${head}*${tail}` }, depth + 1);
    // Not an expansion ({} or {x}): keep it literal and look further on.
    const rest = expandBraces({ ...w, pat: tail }, depth + 1);
    return rest.map((r) => ({ ...w, pat: `${head}\\{${escAll(inner)}\\}${r.pat}` }));
  }
  const parts: string[] = [];
  let from = open + 1;
  for (const c of [...commas, close]) {
    parts.push(w.pat.slice(from, c));
    from = c + 1;
  }
  const out = parts.flatMap((p) => expandBraces({ ...w, pat: head + p + tail }, depth + 1));
  return out.length > 64 ? [{ ...w, pat: DYN, dyn: true }] : out;
}

// ---------- paths ----------

type Env = {
  ctx: DangerContext;
  cwd: string | null;
  remote: boolean;
  depth: number;
  /** Shared by every nested check of one call: the reasons found so far. */
  reasons: string[];
  host: string;
  /** The earlier stages of a command's pipeline (for `echo SQL | sqlite3`). */
  pipelineCmds?: (c: Cmd) => Cmd[];
};

const NULL_DEVS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/fd/1', '/dev/fd/2']);
const BLOCK_DEV = /^\/dev\/(sd[a-z]|nvme\d|mmcblk\d|vd[a-z]|xvd[a-z]|hd[a-z]|md\d|dm-\d|loop\d|mapper\/|disk\/|sr\d|nbd\d|zd\d|rbd\d)/;
const SYSTEM_TREES = ['/nix', '/etc', '/boot', '/dev', '/proc', '/sys', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/var', '/root', '/run', '/srv', '/opt', '/efi'];
const MOUNT_LEVELS = ['/', '/home', '/mnt', '/media', '/run/media', '/Volumes', '/Users'];

const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`);
const strictlyUnder = (p: string, root: string) => p !== root && under(p, root);
function pretty(p: string, env: Env): string {
  if (env.remote) return `${env.host}:${p}`;
  const h = env.ctx.home;
  return p === h ? '~' : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

function protectedTrees(ctx: DangerContext): { root: string; label: string }[] {
  const h = ctx.home;
  return [
    { root: ctx.helmData ?? posix.join(h, '.helm'), label: "Helm's data folder" },
    { root: posix.join(h, '.helm'), label: "Helm's data folder" },
    { root: posix.join(h, '.ssh'), label: 'your SSH keys folder' },
    { root: posix.join(h, '.claude'), label: "Claude's settings and login" },
    { root: posix.join(h, '.claude.json'), label: "Claude's settings" },
    { root: posix.join(h, '.config', 'gh'), label: 'the GitHub CLI login' },
    { root: posix.join(h, '.gnupg'), label: 'your GPG keys' },
    ...SYSTEM_TREES.map((r) => ({ root: r, label: 'a system folder' })),
  ];
}

const CRED_MARKERS = [
  /(^|\/)\.ssh(\/|$)/, /(^|\/)\.config\/gh(\/|$)/, /(^|\/)\.claude\/\.credentials/, /(^|\/)\.credentials\.json$/, /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.aws\/(credentials|config)/, /(^|\/)\.netrc$/, /(^|\/)\.git-credentials$/, /(^|\/)\.password-store(\/|$)/, /(^|\/)\.config\/age(\/|$)/,
  /(^|\/)\.config\/sops(\/|$)/, /(^|\/)\.config\/gcloud(\/|$)/, /(^|\/)\.azure(\/|$)/, /(^|\/)\.kube\/config$/, /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.pgpass$/, /(^|\/)\.npmrc$/, /(^|\/)\.pypirc$/, /(^|\/)\.vault-token$/, /(^|\/)\.local\/share\/keyrings(\/|$)/,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/, /\.age$/, /(^|\/)agenix(\/|$)/, /^\/run\/(agenix|secrets)(\/|$)/, /^\/etc\/(shadow|gshadow|sudoers)/, /^\/etc\/ssh\/.*key/,
];

/** Where a path is: a scratch area the agent may change, or a place it must not. */
type Zone = { zone: 'safe' | 'outside' | 'protected' | 'device' | 'null'; label: string };

function classifyPath(p: string, env: Env): Zone {
  const ctx = env.ctx;
  const show = pretty(p, env);
  if (env.remote) {
    if (strictlyUnder(p, '/tmp')) return { zone: 'safe', label: show };
    return { zone: 'outside', label: show };
  }
  if (NULL_DEVS.has(p)) return { zone: 'null', label: p };
  if (BLOCK_DEV.test(p)) return { zone: 'device', label: p };
  for (const t of protectedTrees(ctx)) if (under(p, t.root)) return { zone: 'protected', label: `${t.label}: ${show}` };
  const roots = [ctx.project, ...(ctx.worktrees ?? [])];
  if (p === ctx.project) return { zone: 'protected', label: `the project folder itself: ${show}` };
  if ((ctx.worktrees ?? []).includes(p)) return { zone: 'protected', label: `a whole worktree: ${show}` };
  if (p === ctx.home) return { zone: 'protected', label: 'your home folder' };
  if (MOUNT_LEVELS.includes(p) || p === '/tmp') return { zone: 'protected', label: `everything in ${p}` };
  for (const r of roots) {
    if (strictlyUnder(p, r)) {
      const rel = p.slice(r.length + 1).split('/');
      if (rel.includes('.git')) return { zone: 'protected', label: `the repository's .git folder: ${show}` };
      return { zone: 'safe', label: show };
    }
  }
  if (strictlyUnder(p, '/tmp')) return { zone: 'safe', label: show };
  if (/^\/(home|mnt|media|Volumes|Users)\/[^/]+$/.test(p) || /^\/run\/media\/[^/]+(\/[^/]+)?$/.test(p)) return { zone: 'protected', label: `a home folder or mount point: ${show}` };
  return { zone: 'outside', label: show };
}

/** The stricter of the path as written and with symlinks resolved. */
function classify(p: string, env: Env): Zone {
  const a = classifyPath(p, env);
  if (env.remote || !env.ctx.realpath) return a;
  let real = p;
  try {
    real = posix.normalize(env.ctx.realpath(p));
  } catch {
    return a;
  }
  if (real === p) return a;
  const b = classifyPath(real, env);
  const rank = { null: 0, safe: 1, outside: 2, protected: 3, device: 4 };
  return rank[b.zone] > rank[a.zone] ? { ...b, label: `${b.label} (through a symlink)` } : a;
}

type Target = { zone: Zone } | { unknown: string };

/** Resolve a word to an absolute path and say where it is. Globs are judged by the folder they match in. */
function target(w: Word, env: Env): Target[] {
  return expandBraces(w).map((x) => targetOne(x, env));
}
function targetOne(w: Word, env: Env): Target {
  if (w.pat.includes(DYN)) return { unknown: `a path built from a variable or command output (${w.raw})` };
  let pat = w.pat;
  if (pat === '~' || pat.startsWith('~/')) pat = escAll(env.remote ? '/home/~' : env.ctx.home) + pat.slice(1);
  else if (/^~[A-Za-z0-9_.-]+(\/|$)/.test(pat)) {
    const user = pat.slice(1).split('/')[0];
    pat = escAll(user === 'root' ? '/root' : `/home/${user}`) + pat.slice(1 + user.length);
  }
  const relative = !pat.startsWith('/');
  if (relative && env.cwd === null) return { unknown: `a relative path (${w.raw}) after a change to an unknown folder` };
  const base = relative ? env.cwd! : '/';
  const g = findUnescaped(pat, '*?[');
  if (g < 0) return { zone: classify(posix.resolve(base, unescape(pat)), env) };
  // A glob: the folder it matches in, and whether it matches everything there.
  const slash = pat.lastIndexOf('/', g);
  const dir = posix.resolve(base, unescape(slash < 0 ? '.' : pat.slice(0, slash) || '/'));
  const segEnd = pat.indexOf('/', g);
  const seg = unescape(pat.slice(slash + 1, segEnd < 0 ? undefined : segEnd));
  const broad = /^\.?[*?]+$/.test(seg) || /^\[.*\][*?]*$/.test(seg) || segEnd >= 0;
  const z = classify(dir, env);
  if (z.zone === 'protected' && (broad || !(dir === env.ctx.project || (env.ctx.worktrees ?? []).includes(dir) || dir === '/tmp'))) {
    return { zone: { zone: 'protected', label: `${z.label} (${w.raw})` } };
  }
  if (z.zone === 'protected') return { zone: { zone: 'safe', label: pretty(dir, env) } };
  return { zone: { zone: z.zone, label: `${pretty(dir, env)}/${seg}` } };
}

function isCredential(p: string, env: Env): boolean {
  if (CRED_MARKERS.some((r) => r.test(p))) return true;
  const base = posix.basename(p);
  if (/^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base)) {
    const roots = [env.ctx.project, ...(env.ctx.worktrees ?? [])];
    if (env.remote || !roots.some((r) => strictlyUnder(p, r))) return true;
  }
  if (/\.(pem|key|p12|pfx)$/.test(base)) {
    const roots = [env.ctx.project, ...(env.ctx.worktrees ?? []), '/tmp'];
    if (env.remote || !roots.some((r) => strictlyUnder(p, r))) return true;
  }
  return false;
}

/** Every path a word could name, resolved as far as possible, for the credential check. */
function credentialWord(w: Word, env: Env): string | null {
  for (const x of expandBraces(w)) {
    const text = lit(x);
    // --file=~/.ssh/id_rsa and the like
    const parts = [text, ...(text.includes('=') ? [text.slice(text.indexOf('=') + 1)] : [])];
    for (const part of parts) {
      if (/\s/.test(part)) continue;
      const clean = part.replace(new RegExp(DYN, 'g'), 'X');
      if (CRED_MARKERS.some((r) => r.test(clean))) return part;
      if (part.includes(DYN)) continue;
      let p = part;
      if (p === '~' || p.startsWith('~/')) p = env.ctx.home + p.slice(1);
      if (!p.startsWith('/')) {
        if (env.cwd === null) continue;
        p = posix.resolve(env.cwd, p);
      }
      p = posix.normalize(p);
      if (isCredential(p, env)) return pretty(p, env);
      if (env.ctx.realpath && !env.remote) {
        try {
          const real = env.ctx.realpath(p);
          if (real !== p && isCredential(real, env)) return `${pretty(p, env)} (through a symlink)`;
        } catch {}
      }
    }
  }
  return null;
}

// ---------- the checks ----------

function flag(env: Env, reason: string) {
  const r = env.remote ? `${reason} (on ${env.host})` : reason;
  if (!env.reasons.includes(r)) env.reasons.push(r);
}

/** Deleting, moving away or overwriting a path. */
function destroy(env: Env, w: Word, verb: string) {
  for (const t of target(w, env)) {
    if ('unknown' in t) flag(env, `${verb} ${t.unknown}`);
    else if (t.zone.zone === 'protected') flag(env, `${verb} ${t.zone.label}`);
    else if (t.zone.zone === 'device') flag(env, `Writes to a disk device: ${t.zone.label}`);
    else if (t.zone.zone === 'outside') flag(env, `${verb} outside the project: ${t.zone.label}`);
  }
}

/** Creating a file or folder: only protected places and devices count. */
function create(env: Env, w: Word) {
  for (const t of target(w, env)) {
    if ('unknown' in t) continue;
    if (t.zone.zone === 'device') flag(env, `Writes to a disk device: ${t.zone.label}`);
    else if (t.zone.zone === 'protected' && !/^everything in|project folder itself|whole worktree|home folder$/.test(t.zone.label)) flag(env, `Writes to ${t.zone.label}`);
  }
}

const isOpt = (w: Word) => !w.dyn && lit(w).startsWith('-') && lit(w) !== '-';
const name = (w: Word) => posix.basename(lit(w));

/** Non-option arguments, honouring `--`. `withArg` are options that take the next word as their value. */
function operands(args: Word[], withArg: string[] = []): Word[] {
  const out: Word[] = [];
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!ended && lit(a) === '--') {
      ended = true;
      continue;
    }
    if (!ended && isOpt(a)) {
      if (withArg.includes(lit(a))) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}
const hasOpt = (args: Word[], short: string, ...long: string[]) =>
  args.some((a) => {
    if (!isOpt(a)) return false;
    const t = lit(a);
    if (t.startsWith('--')) return long.some((l) => t === l || t.startsWith(`${l}=`));
    return short !== '' && [...t.slice(1)].some((c) => short.includes(c));
  });

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox', 'yash', 'tcsh', 'csh']);
const INTERPRETERS = new Set(['python', 'python2', 'python3', 'node', 'nodejs', 'perl', 'ruby', 'php', 'deno', 'bun', 'lua', 'Rscript', 'osascript', 'pwsh']);
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'aria2c', 'xh']);
const SQL_CLIENTS = new Set(['psql', 'sqlite3', 'sqlite', 'mysql', 'mariadb', 'duckdb', 'clickhouse-client', 'clickhouse', 'cockroach', 'mongosh', 'mongo', 'redis-cli', 'usql', 'litecli', 'pgcli', 'mycli']);
const DISK_TOOLS = new Set(['wipefs', 'parted', 'fdisk', 'sfdisk', 'gdisk', 'sgdisk', 'cfdisk', 'blkdiscard', 'cryptsetup', 'lvremove', 'vgremove', 'pvremove', 'mdadm', 'zpool', 'mkswap', 'hdparm', 'nvme', 'sgdisk', 'mke2fs', 'tune2fs', 'e2fsck', 'fsck', 'badblocks', 'losetup', 'umount', 'mount', 'swapoff']);
const POWER = new Set(['shutdown', 'reboot', 'poweroff', 'halt', 'telinit', 'kexec']);
const KILLERS = new Set(['pkill', 'killall', 'killall5', 'xkill', 'skill', 'slay', 'pkill.sh']);
const ROOT = new Set(['sudo', 'doas', 'run0', 'pkexec', 'su', 'sudoedit', 'machinectl']);
const CLOUD = new Set(['aws', 'gcloud', 'gsutil', 'az', 'doctl', 'fly', 'flyctl', 'heroku', 'vercel', 'netlify', 'hcloud', 'linode-cli', 'scw', 's3cmd', 'rclone', 'b2', 'wrangler', 'firebase', 'supabase', 'railway', 'render', 'gh-pages']);
const CLOUD_VERB = /^(rm|rb|del|delete|deletefile|destroy|purge|remove|rmdir|rmdirs|terminate|cleanup|sync|move|moveto|wipe|reset|nuke|uninstall|apps:destroy|apps:delete)$|^(delete|remove|terminate|destroy|purge|deregister|detach|disable|revoke|drop)-/;
const SQL_DESTROY = [
  /\bDROP\s+(TABLE|DATABASE|SCHEMA|INDEX|VIEW|TRIGGER|USER|ROLE|COLLECTION|OWNED|EXTENSION|FUNCTION|PROCEDURE)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\s+(?![^;]*\bWHERE\b)/i,
  /\bUPDATE\s+[\w."`\[\]]+\s+SET\b(?![^;]*\bWHERE\b)/i,
  /\bALTER\s+TABLE\b[^;]*\bDROP\b/i,
  /\bFLUSH(ALL|DB)\b/i,
  /dropDatabase|\.drop\s*\(|deleteMany\s*\(\s*\{\s*\}\s*\)|\bDEL\s+\*/,
];
/** Code that starts other programs: what they run cannot be seen. */
const CODE_EXEC = /\bos\.system|subprocess|child_process|\bexec(Sync|File|FileSync)?\s*\(|\bspawn(Sync)?\s*\(|popen|\bsystem\s*\(|%x\{|\bshell_exec\b|\bpassthru\b/;
/** Code that deletes, moves or writes files. */
const CODE_WRITE = /rmtree|\bunlink|\brmdir|os\.remove|removedirs|\brm(Sync)?\s*\(|fs\.rm|rimraf|shutil\.(move|rmtree|copy)|\btruncate|File\.delete|FileUtils\.(rm|mv)|writeFile|appendFile|createWriteStream|\brename(Sync)?\s*\(|copyFile|open\([^)]*['"][wax+]|\.write_(text|bytes)\(|\.unlink\(|\.chmod|\bchown/;
/** Places code names that are outside the project, read from its text: home, system folders, credentials. */
const CODE_FAR = /expanduser|homedir|os\.environ\[?['"]HOME|process\.env\.HOME|ENV\[['"]HOME|\$HOME|~\//;
const SECRET_VAR = /\$\{?[A-Za-z_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|ACCESS_KEY)[A-Za-z_]*\}?/i;
const HELM_SELF = /(^|\/)(helm-update|helm-rollback|live-update\.sh)(\.service)?$|^helm(-[a-z]+)?\.service$/;
const READERS = new Set(['cat', 'less', 'more', 'head', 'tail', 'grep', 'rg', 'ag', 'ls', 'wc', 'diff', 'file', 'stat', 'echo', 'printf', 'git', 'journalctl', 'jq', 'yq', 'bat', 'tree', 'find', 'nix', 'awk', 'sort', 'uniq', 'cut', 'tr', 'test', '[', '[[', 'true', 'false']);

/** Check one simple command's words (after any wrappers are stripped). */
function checkArgv(env: Env, argv: Word[], cmd: Cmd): void {
  // Leading assignments (FOO=bar cmd) and shell keywords.
  while (argv.length) {
    const t = lit(argv[0]);
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(argv[0].pat.replace(/\\./g, 'x'))) argv = argv.slice(1);
    else if (['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time', 'coproc'].includes(t)) argv = argv.slice(1);
    else if (['for', 'select', 'case', 'esac', 'in', 'function', 'local', 'export', 'readonly', 'declare', 'typeset'].includes(t)) {
      if (['export', 'declare', 'typeset'].includes(t) && argv.length === 1) flag(env, 'Prints environment variables, which may hold secrets');
      return;
    } else break;
  }
  if (!argv.length) return;
  const head = argv[0];
  if (head.pat.includes(DYN) || (head.dyn && !lit(head))) {
    flag(env, `Runs a command whose name is computed at run time (${head.raw}), so it cannot be checked`);
    return;
  }
  const cmdName = name(head);
  const args = argv.slice(1);
  const ops = () => operands(args);

  // Helm itself: restarting, updating or rolling it back stops every agent.
  if (HELM_SELF.test(lit(head)) || HELM_SELF.test(cmdName)) flag(env, 'Restarts, updates or rolls back Helm, which stops every agent');

  // Wrappers: check what they run.
  if (ROOT.has(cmdName)) {
    flag(env, `Runs as root (${cmdName})`);
    if (cmdName === 'su') {
      const i = args.findIndex((a) => lit(a) === '-c' || lit(a) === '--command');
      if (i >= 0 && args[i + 1]) shellString(env, args[i + 1], cmd);
      return;
    }
    let i = 0;
    const withArg = ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir'];
    while (i < args.length && isOpt(args[i])) i += withArg.includes(lit(args[i])) ? 2 : 1;
    return checkArgv(env, args.slice(i), cmd);
  }
  if (cmdName === 'env') {
    let i = 0;
    while (i < args.length) {
      const t = lit(args[i]);
      if (t === '-S' || t === '--split-string' || t.startsWith('--split-string=')) {
        flag(env, 'Runs a command string through env -S, which cannot be checked');
        return;
      }
      if (t === '-C' || t === '--chdir') {
        env = { ...env, cwd: null };
        i += 2;
      } else if (t === '-u' || t === '--unset') i += 2;
      else if (isOpt(args[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) i++;
      else break;
    }
    if (i >= args.length) flag(env, 'Prints environment variables, which may hold secrets');
    return checkArgv(env, args.slice(i), cmd);
  }
  if (['nice', 'nohup', 'time', 'timeout', 'stdbuf', 'ionice', 'setsid', 'command', 'builtin', 'exec', 'unbuffer', 'caffeinate', 'chronic', 'systemd-inhibit', 'taskset', 'chrt', 'faketime', 'catchsegv', 'strace', 'ltrace', 'valgrind', 'proxychains', 'proxychains4', 'torsocks', 'tsocks', 'firejail', 'bwrap', 'nsenter', 'unshare', 'chroot', 'flock', 'with-contenv'].includes(cmdName)) {
    if (cmdName === 'command' && args.some((a) => ['-v', '-V'].includes(lit(a)))) return;
    if (cmdName === 'flock') {
      const c = args.findIndex((a) => lit(a) === '-c' || lit(a) === '--command');
      if (c >= 0 && args[c + 1]) return shellString(env, args[c + 1], cmd);
    }
    const withArg: Record<string, string[]> = {
      nice: ['-n', '--adjustment'], timeout: ['-s', '--signal', '-k', '--kill-after'], ionice: ['-c', '-n', '-p', '-t'], stdbuf: ['-i', '-o', '-e'],
      taskset: ['-c', '-p'], chrt: ['-p'], strace: ['-o', '-e', '-p', '-s'], ltrace: ['-o', '-e'], 'systemd-inhibit': ['--what', '--who', '--why', '--mode'], flock: ['-w', '-E'],
      bwrap: ['--bind', '--ro-bind', '--dev-bind', '--chdir', '--setenv'], chroot: [],
    };
    let i = 0;
    while (i < args.length && isOpt(args[i])) i += (withArg[cmdName] ?? []).includes(lit(args[i])) ? 2 : 1;
    if (cmdName === 'timeout' || cmdName === 'faketime' || cmdName === 'chrt' || cmdName === 'taskset') i++; // the duration, time, priority or mask
    if (cmdName === 'flock') i++; // the lock file
    if (cmdName === 'chroot') {
      flag(env, 'Runs a command in a chroot');
      i++;
    }
    return checkArgv(env, args.slice(i), cmd);
  }
  if (cmdName === 'watch') {
    let i = 0;
    while (i < args.length && isOpt(args[i])) i += ['-n', '--interval', '-d', '-g'].includes(lit(args[i])) ? 2 : 1;
    const joined = args.slice(i).map(lit).join(' ');
    if (args.slice(i).some((a) => a.dyn)) return flag(env, 'Runs a command built at run time (watch), which cannot be checked');
    return parseInto(env, joined, null);
  }
  if (cmdName === 'xargs' || cmdName === 'parallel') {
    let i = 0;
    const withArg = ['-I', '-i', '-n', '-P', '-d', '-a', '-L', '-l', '-s', '-E', '-e', '--max-args', '--max-procs', '--delimiter', '--arg-file', '-j', '--jobs', '-S', '--sshlogin'];
    while (i < args.length && isOpt(args[i])) i += withArg.includes(lit(args[i])) ? 2 : 1;
    const rest = args.slice(i);
    const sep = rest.findIndex((a) => [':::', '::::', ':::+'].includes(lit(a)));
    const inner = sep >= 0 ? rest.slice(0, sep) : rest;
    if (!inner.length) return;
    // The arguments come from input: unknown.
    const unknownArg: Word = { pat: DYN, dyn: true, raw: `(arguments from ${cmdName})` };
    const replaced = inner.map((a) => (/\{\}|\{\.\}|\{\/\}/.test(lit(a)) || ['{}'].includes(lit(a)) ? unknownArg : a));
    return checkArgv(env, [...replaced, unknownArg], cmd);
  }
  if (cmdName === 'nix-shell') {
    const i = args.findIndex((a) => ['--run', '--command'].includes(lit(a)));
    if (i >= 0 && args[i + 1]) shellString(env, args[i + 1], cmd);
    return;
  }
  if (cmdName === 'nix') return checkNix(env, args, cmd);
  if (cmdName === 'ssh' || cmdName === 'mosh' || cmdName === 'autossh') return checkSsh(env, args, cmd);
  if (SHELLS.has(cmdName)) return checkShell(env, cmdName, args, cmd);
  if (INTERPRETERS.has(cmdName) || /^python\d(\.\d+)?$/.test(cmdName)) return checkInterpreter(env, cmdName, args, cmd);
  if (cmdName === 'eval') return flag(env, 'Uses eval, whose command cannot be checked');
  if (cmdName === 'source' || cmdName === '.') {
    if (args.some((a) => a.dyn)) flag(env, 'Sources a script produced at run time, which cannot be checked');
    else if (cmd.stage > 0 || args.length === 0) flag(env, 'Runs shell code read from a pipe, which cannot be checked');
    return;
  }

  // Deleting.
  if (['rm', 'unlink', 'rmdir', 'trash', 'trash-put', 'srm', 'shred', 'wipe'].includes(cmdName)) {
    const verb = cmdName === 'shred' || cmdName === 'wipe' ? 'Shreds' : 'Deletes';
    for (const t of operands(args, cmdName === 'shred' ? ['-n', '-s', '--iterations', '--size', '--random-source'] : [])) destroy(env, t, verb);
    return;
  }
  if (cmdName === 'gio' && ['trash', 'remove', 'move', 'rename', 'copy', 'save'].includes(lit(args[0] ?? head))) {
    for (const t of operands(args.slice(1))) destroy(env, t, 'Deletes or moves');
    return;
  }
  if (cmdName === 'mv') {
    for (const t of operands(args, ['-t', '--target-directory', '-S', '--suffix'])) destroy(env, t, 'Moves or overwrites');
    const tdir = args.findIndex((a) => lit(a) === '-t' || lit(a) === '--target-directory');
    if (tdir >= 0 && args[tdir + 1]) destroy(env, args[tdir + 1], 'Moves into');
    return;
  }
  if (['cp', 'install', 'ln', 'link', 'rsync', 'scp', 'sftp', 'rclone-copy'].includes(cmdName)) return checkCopy(env, cmdName, args);
  if (cmdName === 'tee') {
    for (const t of operands(args)) destroy(env, t, 'Overwrites');
    return;
  }
  if (['touch', 'mkdir', 'mkfifo', 'mknod'].includes(cmdName)) {
    for (const t of operands(args, ['-m', '--mode', '-d', '-r', '-t', '--reference', '--date'])) create(env, t);
    return;
  }
  if (cmdName === 'truncate') {
    for (const t of operands(args, ['-s', '--size', '-r', '--reference'])) destroy(env, t, 'Truncates');
    return;
  }
  if (cmdName === 'sed' || cmdName === 'perl') {
    if (cmdName === 'perl' && !hasOpt(args, 'i')) return checkInterpreter(env, cmdName, args, cmd);
    if (cmdName === 'sed' && !hasOpt(args, 'i', '--in-place')) return;
    const scriptGiven = hasOpt(args, 'ef', '--expression', '--file');
    const files = operands(args, ['-e', '-f', '--expression', '--file', '-l', '--line-length']);
    for (const t of scriptGiven || cmdName === 'perl' ? files : files.slice(1)) destroy(env, t, 'Edits in place');
    return;
  }
  if (['chmod', 'chown', 'chgrp', 'chattr', 'setfacl', 'chcon'].includes(cmdName)) {
    const recursive = hasOpt(args, 'R', '--recursive');
    const files = operands(args, ['--reference', '-m', '-x', '-M', '-X']).slice(cmdName === 'setfacl' && !hasOpt(args, 'mxMXbk') ? 0 : 1);
    for (const f of files) {
      for (const t of target(f, env)) {
        if ('unknown' in t) {
          if (recursive) flag(env, `Changes permissions recursively on ${t.unknown}`);
        } else if (t.zone.zone === 'protected' || t.zone.zone === 'device') flag(env, `Changes permissions on ${t.zone.label}`);
        else if (recursive && t.zone.zone === 'outside') flag(env, `Changes permissions recursively outside the project: ${t.zone.label}`);
      }
    }
    return;
  }
  if (cmdName === 'dd') {
    for (const a of args) {
      const t = lit(a);
      if (t.startsWith('of=')) destroy(env, { ...a, pat: a.pat.slice(3), raw: a.raw.replace(/^of=/, '') }, 'Writes with dd to');
    }
    return;
  }
  if (cmdName.startsWith('mkfs') || DISK_TOOLS.has(cmdName)) {
    if (['mount', 'losetup'].includes(cmdName) && (args.length === 0 || hasOpt(args, 'l', '--list', '--show'))) return;
    if (cmdName === 'zpool' && !['destroy', 'labelclear', 'remove', 'detach', 'offline', 'export', 'create', 'add', 'replace', 'split'].includes(lit(args[0] ?? head))) return;
    if (cmdName === 'nvme' && !['format', 'sanitize', 'delete-ns', 'write', 'write-zeroes'].includes(lit(args[0] ?? head))) return;
    flag(env, `Changes disks, partitions or mounts (${cmdName})`);
    return;
  }
  if (cmdName === 'zfs' && ['destroy', 'rollback', 'rename', 'promote', 'receive', 'recv'].includes(lit(args[0] ?? head))) return flag(env, `Changes ZFS datasets (zfs ${lit(args[0])})`);

  // System state.
  if (POWER.has(cmdName) || (cmdName === 'init' && /^[06sS]$/.test(lit(args[0] ?? head)))) return flag(env, `Shuts down or restarts the machine (${cmdName})`);
  if (cmdName === 'systemctl' || cmdName === 'service' || cmdName === 'rc-service' || cmdName === 'loginctl') return checkSystemctl(env, cmdName, args);
  if (cmdName === 'nixos-rebuild' || cmdName === 'nixos-install' || cmdName === 'darwin-rebuild' || cmdName === 'nixos-generate-config') return flag(env, `Changes the machine's system configuration (${cmdName})`);
  if (cmdName === 'home-manager' && ['switch', 'expire-generations', 'remove-generations', 'uninstall'].includes(lit(args[0] ?? head))) return flag(env, `Changes your home configuration (home-manager ${lit(args[0])})`);
  if (cmdName === 'nix-collect-garbage' && hasOpt(args, 'd', '--delete-old', '--delete-older-than')) return flag(env, 'Deletes old Nix generations, the rollback points');
  if (cmdName === 'nix-env' && hasOpt(args, 'e', '--uninstall', '--delete-generations', '--switch-generation', '--rollback', '--set')) return flag(env, 'Changes or deletes a Nix profile');
  if (cmdName === 'nix-store' && hasOpt(args, '', '--delete')) return flag(env, 'Deletes from the Nix store');
  if (cmdName === 'nix-channel' && hasOpt(args, '', '--remove', '--rollback')) return flag(env, 'Changes Nix channels');
  if (cmdName === 'kill') return checkKill(env, args);
  if (KILLERS.has(cmdName)) return flag(env, `Kills processes by name or pattern (${cmdName}), not only ones this agent started`);
  if (cmdName === 'fuser' && hasOpt(args, 'k', '--kill')) return flag(env, 'Kills every process using a file or port (fuser -k)');
  if (cmdName === 'crontab' && !(args.length === 1 && lit(args[0]) === '-l')) return flag(env, 'Replaces or removes the crontab');
  if (['useradd', 'userdel', 'usermod', 'groupdel', 'passwd', 'chpasswd', 'visudo', 'iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd', 'sysctl', 'modprobe', 'rmmod', 'insmod', 'tailscale', 'networkctl', 'nmcli', 'ip'].includes(cmdName)) {
    const readOnly = (cmdName === 'ip' && /^(a|addr|address|r|route|link|l|-br|neigh|n|-[46])$/.test(lit(args[0] ?? head)) && !args.some((a) => ['add', 'del', 'delete', 'set', 'flush', 'change', 'replace'].includes(lit(a))))
      || (cmdName === 'tailscale' && ['status', 'ip', 'ping', 'netcheck', 'whois', 'version'].includes(lit(args[0] ?? head)))
      || (cmdName === 'sysctl' && !args.some((a) => lit(a).includes('=') || lit(a) === '-w'))
      || (cmdName === 'nmcli' && !args.some((a) => ['delete', 'down', 'modify', 'off', 'disconnect'].includes(lit(a))));
    if (!readOnly) flag(env, `Changes users, the network, the firewall or the kernel (${cmdName})`);
    return;
  }

  // Version control and hosting.
  if (cmdName === 'git') return checkGit(env, args);
  if (cmdName === 'gh') return checkGh(env, args);
  if (cmdName === 'glab' && args.some((a) => /^(delete|remove|archive)$/.test(lit(a)))) return flag(env, 'Deletes a repository or release on GitLab');

  // Databases.
  if (SQL_CLIENTS.has(cmdName)) return checkSql(env, cmdName, args, cmd);
  if (['dropdb', 'dropuser', 'pg_dropcluster', 'mysqladmin'].includes(cmdName)) {
    if (cmdName !== 'mysqladmin' || args.some((a) => /^drop$/i.test(lit(a)))) flag(env, `Drops a database (${cmdName})`);
    return;
  }

  // Containers and cloud.
  if (['docker', 'podman', 'nerdctl', 'docker-compose', 'podman-compose'].includes(cmdName)) return checkDocker(env, cmdName, args);
  if (['kubectl', 'oc', 'k3s', 'microk8s'].includes(cmdName)) {
    const sub = args.filter((a) => !isOpt(a)).map(lit);
    if (sub.some((s) => ['delete', 'drain', 'cordon', 'taint'].includes(s)) || (sub.includes('replace') && hasOpt(args, '', '--force')) || (sub.includes('apply') && hasOpt(args, '', '--prune')) || (sub.includes('scale') && args.some((a) => /--replicas=0$/.test(lit(a))))) {
      flag(env, `Deletes or disrupts Kubernetes resources (${cmdName} ${sub[0] ?? ''})`.trim());
    }
    return;
  }
  if (cmdName === 'helm' && ['uninstall', 'delete', 'del', 'rollback'].includes(lit(args[0] ?? head))) return flag(env, `Removes a Kubernetes release (helm ${lit(args[0])})`);
  if (['terraform', 'tofu', 'terragrunt', 'pulumi', 'cdk', 'cdktf', 'serverless', 'sls'].includes(cmdName)) {
    const sub = operands(args).map(lit);
    if (sub.some((s) => ['destroy', 'apply', 'up', 'deploy', 'remove', 'import', 'taint', 'force-unlock'].includes(s)) || (sub[0] === 'state' && ['rm', 'mv', 'push', 'replace-provider'].includes(sub[1])) || hasOpt(args, '', '-destroy', '--destroy')) {
      flag(env, `Creates, changes or destroys cloud infrastructure (${cmdName} ${sub.join(' ').slice(0, 40)})`);
    }
    return;
  }
  if (CLOUD.has(cmdName)) {
    if (args.some((a) => CLOUD_VERB.test(lit(a)))) flag(env, `Deletes cloud resources or files (${cmdName} ${args.map(lit).find((t) => CLOUD_VERB.test(t))})`);
    return;
  }

  // Credentials.
  if (cmdName === 'printenv' || (cmdName === 'set' && args.length === 0)) return flag(env, 'Prints environment variables, which may hold secrets');
  if (['pass', 'gopass', 'secret-tool', 'security', 'keyring', 'op', 'bw', 'lpass', 'age', 'rage', 'agenix', 'sops', 'gpg', 'gpg2', 'ssh-keygen', 'ssh-add', 'vault', 'kubeseal'].includes(cmdName)) {
    const read = ['age', 'rage', 'sops', 'gpg', 'gpg2'].includes(cmdName) ? hasOpt(args, 'de', '--decrypt', '--edit', '--export-secret-keys', '--export-secret-subkeys') : cmdName === 'ssh-keygen' ? hasOpt(args, 'yRpcN') || args.some((a) => /^-[a-zA-Z]*f/.test(lit(a))) : cmdName === 'ssh-add' ? !hasOpt(args, 'lL') : true;
    if (read) flag(env, `Reads or changes secrets (${cmdName})`);
  }
  if (['echo', 'printf', 'cat', 'print'].includes(cmdName) && args.some((a) => SECRET_VAR.test(a.raw))) flag(env, 'Prints a secret from the environment');

  // Downloads into files.
  if (DOWNLOADERS.has(cmdName)) {
    for (let i = 0; i < args.length; i++) {
      const t = lit(args[i]);
      if (['-o', '--output', '-O', '--output-document', '-P', '--directory-prefix'].includes(t) && args[i + 1] && !(cmdName === 'curl' && t === '-O')) destroy(env, args[i + 1], 'Downloads over');
    }
  }
  if (cmdName === 'tar' || cmdName === 'bsdtar' || cmdName === 'unzip' || cmdName === '7z') {
    const extract = cmdName === 'unzip' || (cmdName === '7z' ? ['x', 'e'].includes(lit(args[0] ?? head)) : args.some((a) => /^-?[a-zA-Z]*x/.test(lit(a)) && !lit(a).startsWith('--')) || hasOpt(args, '', '--extract', '--get'));
    if (extract) {
      for (let i = 0; i < args.length; i++) {
        const t = lit(args[i]);
        if (['-C', '--directory', '-d'].includes(t) && args[i + 1]) destroy(env, args[i + 1], 'Extracts over');
        else if (t.startsWith('--directory=')) destroy(env, { ...args[i], pat: args[i].pat.slice(12), raw: t.slice(12) }, 'Extracts over');
        else if (cmdName === '7z' && t.startsWith('-o')) destroy(env, { ...args[i], pat: args[i].pat.slice(2), raw: t.slice(2) }, 'Extracts over');
      }
    }
    return;
  }
  if (cmdName === 'find' || cmdName === 'fd') return checkFind(env, cmdName, args, cmd);
  if (['awk', 'gawk', 'mawk', 'nawk', 'busybox-awk'].includes(cmdName)) {
    const program = operands(args, ['-f', '-v', '-F', '--file', '--assign', '--field-separator'])[0];
    if (program && /\bsystem\s*\(|\|\s*getline|\bprint[^;}]*>|\|\s*"/.test(lit(program))) flag(env, `Runs ${cmdName} code that runs commands or writes files, which cannot be checked`);
    return;
  }
}

function checkCopy(env: Env, cmdName: string, args: Word[]) {
  const withArg = ['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group', '-e', '--rsh', '-i', '-P', '-F', '-J', '-l', '-c', '--exclude', '--include', '--filter', '-f', '--files-from', '--exclude-from', '--include-from', '--chmod', '--backup-dir', '--partial-dir', '--temp-dir', '-T', '--log-file'];
  const files = operands(args, withArg);
  const tdir = args.findIndex((a) => lit(a) === '-t' || lit(a) === '--target-directory');
  const dest = tdir >= 0 ? args[tdir + 1] : files[files.length - 1];
  const sources = tdir >= 0 ? files : files.slice(0, -1);
  const remoteOf = (w: Word) => /^(?:[^/:\s]+@)?[A-Za-z0-9][\w.-]*:/.test(lit(w)) && !lit(w).startsWith('/') && !lit(w).startsWith('./');
  const moves = cmdName === 'rsync' && hasOpt(args, '', '--remove-source-files');
  for (const s of sources) {
    if (remoteOf(s)) continue;
    if (moves) destroy(env, s, 'Moves away');
  }
  if (!dest || (cmdName === 'ln' && files.length < 2 && tdir < 0)) return;
  if (cmdName === 'ln' && !hasOpt(args, 'f', '--force')) {
    create(env, dest);
    return;
  }
  if (remoteOf(dest)) {
    const t = lit(dest);
    const host = t.slice(0, t.indexOf(':'));
    const path = t.slice(t.indexOf(':') + 1) || '.';
    const r: Env = { ...env, remote: true, host, cwd: null };
    destroy(r, { pat: escAll(path.endsWith('/') ? `${path}__file__` : path), dyn: dest.dyn, raw: path }, 'Copies over');
    env.reasons.push(...r.reasons.filter((x) => !env.reasons.includes(x)));
    return;
  }
  if (cmdName === 'rsync' && hasOpt(args, '', '--delete', '--delete-before', '--delete-after', '--delete-during', '--delete-delay', '--delete-excluded', '--del')) destroy(env, dest, 'Deletes (rsync --delete) in');
  else destroy(env, lit(dest).endsWith('/') ? { ...dest, pat: `${dest.pat}__file__` } : dest, cmdName === 'ln' ? 'Replaces' : 'Copies over');
}

function shellString(env: Env, w: Word, cmd: Cmd) {
  if (w.dyn) return flag(env, `Runs a shell string built at run time (${w.raw.slice(0, 60)}), which cannot be checked`);
  parseInto(env, lit(w), null);
}

function checkShell(env: Env, cmdName: string, args: Word[], cmd: Cmd): void {
  let i = 0;
  let cFlag = false;
  while (i < args.length) {
    const t = lit(args[i]);
    if (t === '--') {
      i++;
      break;
    }
    if (['-o', '+o', '--rcfile', '--init-file', '-O', '+O'].includes(t)) {
      i += 2;
      continue;
    }
    if ((t.startsWith('-') || t.startsWith('+')) && t.length > 1 && !args[i].dyn) {
      if (!t.startsWith('--') && t.slice(1).includes('c')) cFlag = true;
      i++;
      continue;
    }
    break;
  }
  if (cmdName === 'busybox' && args[0] && !['sh', 'ash'].includes(lit(args[0]))) return checkArgv(env, args, cmd);
  if (cFlag) {
    if (!args[i]) return flag(env, `${cmdName} -c without a command`);
    return shellString(env, args[i], cmd);
  }
  if (args[i]) {
    const script = lit(args[i]);
    if (HELM_SELF.test(script)) flag(env, 'Restarts, updates or rolls back Helm, which stops every agent');
    if (args[i].dyn) flag(env, `Runs a script whose path is computed at run time (${args[i].raw})`);
    return;
  }
  // No script: it reads its commands from stdin.
  const here = cmd.redirs.find((r) => r.body !== undefined);
  if (here) return parseInto(env, here.body!, null);
  if (cmd.stage > 0) return flag(env, `Pipes data into a shell (${cmdName}), which cannot be checked`);
  if (cmd.redirs.some((r) => r.op === '<')) return;
  if (env.depth > 0) return;
}

function checkInterpreter(env: Env, cmdName: string, args: Word[], cmd: Cmd) {
  const codeFlag = args.findIndex((a) => /^-[a-zA-Z]*[ceE]$/.test(lit(a)) || ['--eval', '--print', '-p', '--command'].includes(lit(a)));
  if (codeFlag >= 0) {
    const code = args[codeFlag + 1];
    if (!code) return;
    if (code.dyn) return flag(env, `Runs ${cmdName} code built at run time, which cannot be checked`);
    return checkCode(env, cmdName, lit(code), 'inline');
  }
  const positional = args.filter((a) => !isOpt(a));
  if (positional.length === 0 || lit(positional[0]) === '-') {
    const here = cmd.redirs.find((r) => r.body !== undefined);
    if (here) {
      return checkCode(env, cmdName, here.body!, 'heredoc');
    }
    if (cmd.stage > 0) flag(env, `Pipes data into ${cmdName}, which runs it as code and cannot be checked`);
  }
}

/**
 * Code given to an interpreter on the command line or in a heredoc. It cannot be parsed like the shell, so the rule
 * is coarse: code that starts other programs is flagged (what they run is invisible); code that deletes, moves or
 * writes files is flagged only if its text names a place outside the project, its worktrees and /tmp (an absolute
 * path literal there, .., the home folder, a credential store). Relative paths are taken as relative to the working
 * folder. A path built at run time (from argv, a directory listing) is not seen: that is the rule's hole.
 */
function checkCode(env: Env, cmdName: string, text: string, where: 'inline' | 'heredoc') {
  const what = where === 'inline' ? `inline ${cmdName} code` : `${cmdName} code from a heredoc`;
  if (CODE_EXEC.test(text)) flag(env, `Runs ${what} that starts other programs, which cannot be checked`);
  if (CRED_MARKERS.some((r) => r.test(text))) flag(env, `Runs ${what} that names a credential store`);
  if (!CODE_WRITE.test(text)) return;
  if (CODE_FAR.test(text)) return flag(env, `Runs ${what} that changes files and refers to your home folder`);
  for (const m of text.matchAll(/(['"`])((?:\/|\.\.\/|\.\.(?=\1))[^'"`\s]*)\1/g)) {
    const path = m[2];
    if (path.includes('${') || path === '/') {
      if (path === '/' || path.startsWith('${')) return flag(env, `Runs ${what} that changes files at a path it builds at run time`);
    }
    const t = targetOne({ pat: escAll(path.replace(/\$\{[^}]*\}.*$/, '')), dyn: false, raw: path }, env);
    if ('unknown' in t) return flag(env, `Runs ${what} that changes files, with ${t.unknown}`);
    if (['outside', 'protected', 'device'].includes(t.zone.zone)) return flag(env, `Runs ${what} that changes files and names ${t.zone.label}`);
  }
}

function checkSsh(env: Env, args: Word[], cmd: Cmd) {
  const withArg = ['-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-b', '-c', '-E', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B', '-I'];
  let i = 0;
  while (i < args.length && isOpt(args[i])) i += withArg.includes(lit(args[i])) ? 2 : 1;
  const host = args[i] ? lit(args[i]) : '';
  let rest = args.slice(i + 1);
  if (rest[0] && lit(rest[0]) === '--') rest = rest.slice(1);
  const r: Env = { ...env, remote: true, host: host || 'a remote host', cwd: null, reasons: [] };
  if (rest.length) {
    if (rest.some((a) => a.dyn)) flag(env, `Runs a command built at run time on ${host}, which cannot be checked`);
    else parseInto(r, rest.map(lit).join(' '), null);
  } else {
    const here = cmd.redirs.find((x) => x.body !== undefined);
    if (here) parseInto(r, here.body!, null);
    else if (cmd.stage > 0 || cmd.redirs.some((x) => x.op === '<')) flag(env, `Sends a script to a shell on ${host}, which cannot be checked`);
  }
  if (rest.length && cmd.stage > 0 && rest.length >= 1 && SHELLS.has(posix.basename(lit(rest[0]))) && !rest.some((a) => /^-[a-z]*c/.test(lit(a)))) {
    flag(env, `Pipes a script into a shell on ${host}, which cannot be checked`);
  }
  for (const x of r.reasons) if (!env.reasons.includes(x)) env.reasons.push(x);
}

function checkNix(env: Env, args: Word[], cmd: Cmd): void {
  const sub = operands(args).map(lit);
  if (sub[0] === 'shell' || sub[0] === 'develop') {
    const c = args.findIndex((a) => ['-c', '--command'].includes(lit(a)));
    if (c >= 0) return checkArgv(env, args.slice(c + 1), cmd);
    return;
  }
  if (sub[0] === 'store' && ['delete', 'gc', 'repair'].includes(sub[1])) return flag(env, `Deletes from the Nix store (nix store ${sub[1]})`);
  if (sub[0] === 'profile' && ['remove', 'wipe-history', 'rollback'].includes(sub[1])) return flag(env, `Changes a Nix profile (nix profile ${sub[1]})`);
  if (sub[0] === 'run' && /helm-update|helm-rollback|nixos-rebuild/.test(sub.join(' '))) return flag(env, 'Restarts, updates or rolls back Helm or the system');
}

function checkSystemctl(env: Env, cmdName: string, args: Word[]) {
  const ops = operands(args, ['-H', '--host', '-M', '--machine', '-p', '--property', '-t', '--type', '--state', '-s', '--signal', '-n', '--lines', '-o', '--output', '--kill-whom', '--root', '--job-mode']).map(lit);
  const readVerbs = ['status', 'show', 'cat', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies', 'list-jobs', 'help', 'show-environment', 'get-default', 'list-sessions', 'list-users', 'show-session', 'show-user', 'session-status', 'user-status', 'list-machines'];
  if (cmdName === 'service' || cmdName === 'rc-service') {
    const verb = ops[1] ?? '';
    if (!['status', ''].includes(verb)) flag(env, `Changes a system service (${cmdName} ${ops.join(' ')})`);
    return;
  }
  const verb = ops[0] ?? 'list-units';
  if (readVerbs.includes(verb)) return;
  if (cmdName === 'loginctl') return flag(env, `Changes login sessions (loginctl ${verb})`);
  const units = ops.slice(1);
  if (units.some((u) => /helm/.test(u))) return flag(env, `Restarts, updates or stops Helm (systemctl ${verb} ${units.join(' ')}), which stops every agent`);
  if (['stop', 'restart', 'try-restart', 'reload-or-restart', 'try-reload-or-restart', 'condrestart', 'force-reload', 'kill', 'disable', 'mask', 'isolate', 'poweroff', 'reboot', 'halt', 'suspend', 'hibernate', 'hybrid-sleep', 'suspend-then-hibernate', 'kexec', 'emergency', 'rescue', 'default', 'switch-root', 'daemon-reexec', 'clean', 'freeze', 'revert', 'set-default', 'reset-failed', 'soft-reboot', 'exit', 'set-property', 'edit', 'link', 'preset', 'preset-all', 'unset-environment', 'set-environment'].includes(verb)) {
    flag(env, `Stops, restarts or disables a service or the machine (systemctl ${verb}${units.length ? ` ${units.join(' ')}` : ''})`);
  }
}

function checkKill(env: Env, args: Word[]) {
  const withArg = ['-s', '-n', '--signal'];
  if (hasOpt(args, 'l', '--list', '-L', '--table')) return;
  const pids = operands(args, withArg).filter((a) => !/^-[A-Z0-9]+$/.test(lit(a)));
  for (const p of pids) {
    const t = lit(p);
    const raw = p.raw.replace(/^"|"$/g, '');
    if (raw === '$!' || /^%\d*$/.test(t)) continue;
    if (!/^\d+$/.test(t)) {
      flag(env, `Kills processes chosen at run time (kill ${p.raw}), which may not be ones this agent started`);
      continue;
    }
    const n = Number(t);
    if (n <= 1) flag(env, `Kills every process or the system's init (kill ${t})`);
    else if ((env.ctx.protectedPids ?? []).includes(n)) flag(env, 'Kills Helm itself, which stops every agent');
  }
  // kill -9 -1, kill -- -123 (a process group)
  if (args.some((a) => /^-\d+$/.test(lit(a)) && Number(lit(a)) < 0 && args.indexOf(a) > 0 && !/^-(9|15|1|2|3|6|14)$/.test(lit(a)))) flag(env, 'Kills a whole process group');
  if (args.some((a) => lit(a) === '-1' && args.indexOf(a) > 0)) flag(env, 'Kills every process you own (kill -1)');
}

function checkGit(env: Env, args: Word[]) {
  let i = 0;
  let cwd = env.cwd;
  while (i < args.length && (isOpt(args[i]) || false)) {
    const t = lit(args[i]);
    if (t === '-C') {
      const w = args[i + 1];
      if (!w) return;
      const tg = targetOne(w, env);
      cwd = 'unknown' in tg ? null : posix.resolve(env.cwd ?? '/', lit(w).replace(/^~(?=\/|$)/, env.ctx.home));
      if (w.dyn) cwd = null;
      i += 2;
    } else if (['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'].includes(t)) {
      if (t === '--git-dir' || t === '--work-tree') cwd = null;
      i += 2;
    } else {
      if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) cwd = null;
      i++;
    }
  }
  const sub = lit(args[i] ?? { pat: '', dyn: false, raw: '' });
  const rest = args.slice(i + 1);
  const ops = operands(rest);
  const inOwnWorktree = cwd !== null && (env.ctx.worktrees ?? []).some((w) => under(cwd!, w));
  const where = cwd === null ? 'in a repository this check cannot place' : inOwnWorktree ? '' : `in ${pretty(cwd, env) === pretty(env.ctx.project, env) ? "the project's main checkout" : pretty(cwd, env)}`;
  const discard = (what: string) => {
    if (!inOwnWorktree || env.remote) flag(env, `${what} ${where}`.trim());
  };
  switch (sub) {
    case 'push': {
      if (hasOpt(rest, 'fd', '--force', '--force-with-lease', '--force-if-includes', '--delete', '--mirror', '--prune')) flag(env, 'Force-pushes or deletes on a remote (git push --force/--delete)');
      const refs = operands(rest, ['--repo', '-o', '--push-option', '--receive-pack', '--exec']).slice(1).map(lit);
      if (refs.some((r) => r.startsWith('+'))) flag(env, 'Force-pushes a branch (git push +ref)');
      if (refs.some((r) => r.startsWith(':'))) flag(env, 'Deletes a branch on a remote (git push :branch)');
      if (refs.some((r) => /(^|:|refs\/heads\/)(main|master)$/.test(r))) flag(env, 'Pushes to the main branch of a remote');
      if (hasOpt(rest, '', '--all', '--tags') && !refs.length) flag(env, 'Pushes every branch or tag to a remote');
      return;
    }
    case 'reset':
      if (hasOpt(rest, '', '--hard', '--merge', '--keep')) discard('Discards uncommitted changes (git reset --hard)');
      return;
    case 'checkout':
    case 'switch':
      if (hasOpt(rest, 'f', '--force', '--discard-changes', '--overwrite-ignore')) discard(`Discards uncommitted changes (git ${sub} --force)`);
      else if (sub === 'checkout' && (rest.some((a) => lit(a) === '--') || ops.some((a) => ['.', ':/', '*'].includes(lit(a))))) discard('Discards uncommitted changes to files (git checkout -- paths)');
      return;
    case 'restore':
      if (!hasOpt(rest, 'S', '--staged') || hasOpt(rest, 'W', '--worktree')) discard('Discards uncommitted changes to files (git restore)');
      return;
    case 'clean':
      if (hasOpt(rest, 'f', '--force') && !hasOpt(rest, 'n', '--dry-run')) discard('Deletes untracked files (git clean)');
      return;
    case 'stash':
      if (['drop', 'clear'].includes(lit(rest[0] ?? { pat: '', dyn: false, raw: '' }))) flag(env, `Discards stashed work (git stash ${lit(rest[0])})`);
      return;
    case 'branch':
      if (hasOpt(rest, 'DMC') || (hasOpt(rest, 'd', '--delete') && hasOpt(rest, 'f', '--force'))) flag(env, 'Force-deletes or overwrites a branch (git branch -D)');
      return;
    case 'tag':
      if (hasOpt(rest, 'df', '--delete', '--force')) flag(env, 'Deletes or moves a tag');
      return;
    case 'filter-branch':
    case 'filter-repo':
      flag(env, `Rewrites git history (git ${sub})`);
      return;
    case 'reflog':
      if (['expire', 'delete'].includes(lit(rest[0] ?? { pat: '', dyn: false, raw: '' }))) flag(env, 'Deletes git reflog entries, the record that lets lost commits be recovered');
      return;
    case 'update-ref':
      if (hasOpt(rest, 'd')) flag(env, 'Deletes a git ref (git update-ref -d)');
      return;
    case 'gc':
    case 'prune':
      if (rest.some((a) => /^--prune=now|^--expire=now/.test(lit(a))) || sub === 'prune') flag(env, 'Prunes unreachable git objects now, so lost commits cannot be recovered');
      return;
    case 'config':
      if (hasOpt(rest, '', '--global', '--system') && !hasOpt(rest, 'l', '--get', '--get-all', '--list', '--get-regexp', '--show-origin') && ops.length >= 2) flag(env, 'Changes your global git configuration');
      return;
    case 'credential':
    case 'credential-store':
    case 'credential-cache':
      flag(env, 'Reads or changes stored git credentials');
      return;
    case 'worktree':
      if (lit(rest[0] ?? { pat: '', dyn: false, raw: '' }) === 'remove' && hasOpt(rest, 'f', '--force')) {
        const path = operands(rest.slice(1))[0];
        if (path) {
          const t = targetOne(path, env);
          const p = 'unknown' in t ? null : posix.resolve(env.cwd ?? '/', lit(path).replace(/^~(?=\/|$)/, env.ctx.home));
          if (!p || !(env.ctx.worktrees ?? []).includes(p)) flag(env, 'Force-removes a worktree with its uncommitted changes');
        }
      }
      return;
  }
}

function checkGh(env: Env, args: Word[]) {
  const sub = operands(args, ['-R', '--repo', '-X', '--method', '-H', '--header', '-f', '-F', '--field', '--raw-field', '-q', '--jq', '-t', '--template', '--hostname']).map(lit);
  const all = args.map(lit);
  if (all.some((a) => /^(delete|delete-asset|remove)$/.test(a))) return flag(env, `Deletes something on GitHub (gh ${sub.slice(0, 2).join(' ')})`);
  if (sub[0] === 'repo' && ['archive', 'rename'].includes(sub[1])) return flag(env, `Archives or renames a repository (gh repo ${sub[1]})`);
  if (sub[0] === 'repo' && sub[1] === 'edit' && all.some((a) => a.startsWith('--visibility'))) return flag(env, "Changes a repository's visibility");
  if (sub[0] === 'auth' && (sub[1] === 'token' || all.includes('--show-token') || all.includes('-t'))) return flag(env, 'Prints the GitHub login token');
  if (sub[0] === 'auth' && ['logout', 'refresh', 'setup-git', 'login'].includes(sub[1])) return flag(env, `Changes the GitHub CLI login (gh auth ${sub[1]})`);
  if (['secret', 'variable', 'ssh-key', 'gpg-key'].includes(sub[0]) && sub[1] !== 'list') return flag(env, `Changes GitHub secrets or keys (gh ${sub[0]} ${sub[1] ?? ''})`.trim());
  if (sub[0] === 'api') {
    const m = args.findIndex((a) => ['-X', '--method'].includes(lit(a)));
    const method = m >= 0 ? lit(args[m + 1] ?? { pat: '', dyn: false, raw: '' }).toUpperCase() : (all.find((a) => a.startsWith('--method='))?.slice(9).toUpperCase() ?? '');
    if (method === 'DELETE') flag(env, 'Deletes something through the GitHub API');
    else if (['PUT', 'PATCH', 'POST'].includes(method) && all.some((a) => /\/(git\/refs|branches\/[^/]+\/protection|collaborators|keys|hooks|secrets)/.test(a))) flag(env, 'Changes branches, access or secrets through the GitHub API');
  }
}

function checkSql(env: Env, cmdName: string, args: Word[], cmd: Cmd) {
  const texts = args.map(lit);
  for (const r of cmd.redirs) if (r.body) texts.push(r.body);
  // echo "DELETE FROM t" | sqlite3 db, cat <<EOF | psql
  if (cmd.stage > 0) {
    for (const c of env.pipelineCmds?.(cmd) ?? []) {
      texts.push(...c.words.map(lit));
      for (const r of c.redirs) if (r.body) texts.push(r.body);
    }
  }
  const sql = texts.join('\n');
  if (SQL_DESTROY.some((re) => re.test(sql))) flag(env, `Deletes or drops database data (${cmdName}: ${(SQL_DESTROY.map((re) => re.exec(sql)?.[0]).find(Boolean) ?? '').trim()})`);
  if (cmdName === 'sqlite3' || cmdName === 'sqlite' || cmdName === 'duckdb' || cmdName === 'litecli') {
    const db = operands(args, ['-cmd', '-separator', '-nullvalue', '-init'])[0];
    if (db) {
      for (const t of target(db, env)) {
        if ('zone' in t && t.zone.zone === 'protected' && !hasOpt(args, '', '-readonly') && !args.some((a) => lit(a) === '-readonly')) {
          if (/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|VACUUM|ATTACH|REINDEX)\b|PRAGMA\s+\w+\s*=|^\.(restore|import|load)/im.test(sql) || operands(args, ['-cmd']).length < 2) {
            flag(env, `Opens a database in ${t.zone.label} for writing`);
          }
        }
      }
    }
  }
}

function checkDocker(env: Env, cmdName: string, args: Word[]) {
  const sub = operands(args, ['-H', '--host', '--context', '-c', '--config', '-f', '--file', '-p', '--project-name', '-e', '--env', '-v', '--volume', '--mount', '-w', '--workdir', '-u', '--user', '--name', '--network', '--entrypoint', '-l', '--label']).map(lit);
  const s = sub.join(' ');
  if (/\b(system|container|image|volume|network|builder|buildx) prune\b/.test(s) || /^(volume|network) (rm|remove)\b/.test(s) || /^(rm|container rm)\b/.test(s) || sub[0] === 'rmi' && hasOpt(args, 'f', '--force')) {
    return flag(env, `Deletes containers, volumes or images (${cmdName} ${sub.slice(0, 2).join(' ')})`);
  }
  if ((cmdName.endsWith('compose') || sub[0] === 'compose') && sub.includes('down') && hasOpt(args, 'v', '--volumes', '--rmi')) return flag(env, `Deletes a compose project's volumes (${cmdName} compose down -v)`);
  if ((cmdName.endsWith('compose') || sub[0] === 'compose') && sub.includes('rm')) return flag(env, 'Deletes compose containers');
  if (['stack', 'service', 'secret', 'config'].includes(sub[0]) && ['rm', 'remove'].includes(sub[1])) return flag(env, `Deletes swarm resources (${cmdName} ${sub[0]} rm)`);
  if (sub[0] === 'run' || sub[0] === 'create' || (sub[0] === 'container' && ['run', 'create'].includes(sub[1]))) {
    if (hasOpt(args, '', '--privileged', '--pid', '--cap-add')) flag(env, 'Runs a privileged container that can change the host');
    for (let i = 0; i < args.length; i++) {
      const t = lit(args[i]);
      let spec = '';
      if (['-v', '--volume'].includes(t)) spec = lit(args[i + 1] ?? args[i]);
      else if (t.startsWith('--volume=') || t.startsWith('-v=')) spec = t.slice(t.indexOf('=') + 1);
      else if (t === '--mount') spec = (/(?:source|src)=([^,]+)/.exec(lit(args[i + 1] ?? args[i]))?.[1] ?? '');
      if (!spec) continue;
      const src = spec.split(':')[0];
      if (!src.startsWith('/') && !src.startsWith('~') && !src.startsWith('.')) continue;
      const tg = targetOne({ pat: escAll(src).replace(/^\\~/, '~'), dyn: false, raw: src }, env);
      if ('unknown' in tg || ['protected', 'outside', 'device'].includes(tg.zone.zone)) {
        if (!spec.endsWith(':ro') || ('zone' in tg && tg.zone.zone === 'protected' && isCredential(posix.resolve(env.cwd ?? '/', src.replace(/^~/, env.ctx.home)), env))) {
          flag(env, `Gives a container write access outside the project (${spec})`);
        }
      }
    }
  }
}

function checkFind(env: Env, cmdName: string, args: Word[], cmd: Cmd) {
  if (cmdName === 'fd') {
    const x = args.findIndex((a) => ['-x', '--exec', '-X', '--exec-batch'].includes(lit(a)));
    const roots = operands(args.slice(0, x < 0 ? undefined : x), ['-e', '--extension', '-t', '--type', '-E', '--exclude', '-d', '--max-depth', '--min-depth', '-S', '--size', '--changed-within', '--changed-before', '-j', '--threads']).slice(1);
    if (x >= 0) {
      const rootPaths = roots.length ? roots : [{ pat: '.', dyn: false, raw: '.' }];
      for (const r of rootPaths) {
        const child: Word = { pat: `${r.pat}/__found__`, dyn: r.dyn, raw: `${r.raw}/...` };
        checkArgv(env, args.slice(x + 1).map((a) => (/\{[^}]*\}/.test(lit(a)) ? child : a)), cmd);
      }
    }
    return;
  }
  const exprStart = args.findIndex((a) => /^[-(!]/.test(lit(a)) && !a.dyn);
  const roots = (exprStart < 0 ? args : args.slice(0, exprStart)).filter((a) => !['-H', '-L', '-P'].includes(lit(a)));
  const rootPaths = roots.length ? roots : [{ pat: '.', dyn: false, raw: '.' }];
  const expr = exprStart < 0 ? [] : args.slice(exprStart);
  for (const r of rootPaths) {
    const child: Word = { pat: `${r.pat}/__found__`, dyn: r.dyn, raw: `${r.raw}/...` };
    for (let i = 0; i < expr.length; i++) {
      const t = lit(expr[i]);
      if (t === '-delete') destroy(env, child, 'Deletes (find -delete)');
      if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(t) && expr[i + 1]) destroy(env, expr[i + 1], 'Overwrites');
      if (['-exec', '-execdir', '-ok', '-okdir'].includes(t)) {
        let j = i + 1;
        const inner: Word[] = [];
        while (j < expr.length && ![';', '+'].includes(lit(expr[j]))) inner.push(expr[j++]);
        checkArgv(env, inner.map((a) => (lit(a).includes('{}') ? child : a)), cmd);
        i = j;
      }
    }
  }
}

/** Parse shell text and check every command in it. */
function parseInto(env: Env, src: string, _unused: null) {
  if (env.depth >= MAX_DEPTH) return flag(env, 'Nests shells too deeply to check');
  const vars: Record<string, string> = { HOME: env.remote ? '/home/~' : env.ctx.home };
  if (!env.remote) vars.USER = posix.basename(env.ctx.home);
  if (env.cwd && !env.remote) vars.PWD = env.cwd;
  const sh: Shared = { pipelines: 0, heredocChars: 0, errors: [], cmds: [] };
  const p = new Parser(src, sh, vars);
  p.parseList(0, null);
  p.readHeredocs();
  if (sh.errors.length) flag(env, `Could not parse the command confidently (${sh.errors[0]}), so it cannot be checked`);
  const codeChars = sh.cmds.reduce((n, c) => {
    const head = c.words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.pat));
    if (!head || !(INTERPRETERS.has(name(head)) || /^python\d/.test(name(head)))) return n;
    const i = c.words.findIndex((w) => /^-[a-zA-Z]*[ceE]$/.test(lit(w)) || ['--eval', '--print', '-p', '--command'].includes(lit(w)));
    return i >= 0 && c.words[i + 1] ? n + c.words[i + 1].raw.length : n;
  }, 0);
  if (src.length - sh.heredocChars - codeChars > MAX_COMMAND) flag(env, `The command is too long to check confidently (${src.length} characters)`);
  if (/\b(base64|base32|xxd|openssl\s+(enc|base64))\b[^|]*-(d|D|r|-decode)\b/.test(src) && /\|\s*(\S*\/)?(sh|bash|zsh|dash|python3?|perl|node|ruby|source|eval)\b/.test(src)) flag(env, 'Decodes data and runs it, which cannot be checked');
  const inner: Env = { ...env, depth: env.depth + 1, cwd: env.cwd };
  const byPipeline = new Map<number, Cmd[]>();
  for (const c of sh.cmds) byPipeline.set(c.pipeline, [...(byPipeline.get(c.pipeline) ?? []), c]);
  inner.pipelineCmds = (c: Cmd) => (byPipeline.get(c.pipeline) ?? []).filter((x) => x.stage < c.stage);
  for (const c of sh.cmds) {
    // Downloads piped into a shell or interpreter.
    if (c.stage > 0) {
      const earlier = (byPipeline.get(c.pipeline) ?? []).filter((x) => x.stage < c.stage);
      const first = c.words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.pat));
      const n = first ? name(first) : '';
      if (earlier.some((x) => x.words[0] && DOWNLOADERS.has(name(x.words[0]))) && (SHELLS.has(n) || INTERPRETERS.has(n) || ROOT.has(n) || /^python/.test(n))) {
        flag(inner, `Pipes a download into ${n}, which runs code that cannot be checked`);
      }
    }
    checkRedirs(inner, c);
    checkCredentials(inner, c);
    const first = lit(c.words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.pat.replace(/\\./g, 'x'))) ?? { pat: '', dyn: false, raw: '' });
    if ((first === 'cd' || first === 'pushd' || first === 'popd') && !inner.remote) {
      const top = c.level === 0 && c.stages === 1 && c.sep !== '||' && c.sep !== '&';
      const words = c.words.slice(c.words.findIndex((w) => lit(w) === first) + 1).filter((w) => !isOpt(w));
      const dest = words[0];
      if (!top || first === 'popd' || (dest && lit(dest) === '-')) inner.cwd = null;
      else if (!dest) inner.cwd = env.ctx.home;
      else {
        const t = targetOne(dest, inner);
        inner.cwd = 'unknown' in t ? null : posix.resolve(inner.cwd ?? '/', lit(dest).replace(/^~(?=\/|$)/, env.ctx.home));
        if (inner.cwd !== null && lit(dest).startsWith('~') === false && !lit(dest).startsWith('/') && env.cwd === null) inner.cwd = null;
      }
      continue;
    }
    checkArgv(inner, c.words, c);
  }
  for (const r of inner.reasons) if (!env.reasons.includes(r)) env.reasons.push(r);
}

function checkRedirs(env: Env, c: Cmd) {
  for (const r of c.redirs) {
    if (!r.target || r.op === '<<<') continue;
    const t = lit(r.target);
    if ((r.op === '>&' || r.op === '<&') && /^(\d+|-)$/.test(t)) continue;
    if (r.op === '<' || r.op === '<&') continue; // reads: the credential check covers them
    destroy(env, r.target, 'Overwrites');
  }
}

function checkCredentials(env: Env, c: Cmd) {
  const words = [...c.words, ...c.redirs.flatMap((r) => (r.target ? [r.target] : []))];
  for (const w of words) {
    const hit = credentialWord(w, env);
    if (hit) {
      flag(env, `Reads or changes credentials: ${hit}`);
      return;
    }
  }
}

// ---------- the entry point ----------

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * Whether a tool call is dangerous enough that only the user may allow it, and why. The first reason is the
 * one to show ("Deletes outside the project: ~/Documents"); all of them are kept.
 */
export function checkDanger(toolName: string, input: Record<string, unknown>, ctx: DangerContext): Danger {
  const env: Env = { ctx: { ...ctx, project: posix.normalize(ctx.project), home: posix.normalize(ctx.home), worktrees: (ctx.worktrees ?? []).map((w) => posix.normalize(w)) }, cwd: posix.normalize(ctx.cwd && posix.isAbsolute(ctx.cwd) ? ctx.cwd : ctx.project), remote: !!ctx.remote, depth: 0, reasons: [], host: 'a remote host' };
  const str = (k: string) => (typeof input?.[k] === 'string' ? (input[k] as string) : undefined);
  if (SHELL_TOOLS.has(toolName) || (toolName.startsWith('mcp__') && (str('command') || str('cmd')))) {
    const command = str('command') ?? str('cmd');
    if (command === undefined) flag(env, 'A shell call without a command string');
    else parseInto(env, command, null);
  } else if (WRITE_TOOLS.has(toolName)) {
    const path = str('file_path') ?? str('notebook_path') ?? str('path');
    if (!path) flag(env, `${toolName} without a file path`);
    else {
      const w: Word = { pat: escAll(path), dyn: false, raw: path };
      destroy(env, w, 'Writes');
      const hit = credentialWord(w, env);
      if (hit) flag(env, `Reads or changes credentials: ${hit}`);
    }
  } else if (READ_TOOLS.has(toolName)) {
    for (const k of ['file_path', 'path', 'notebook_path', 'pattern']) {
      const v = str(k);
      if (!v || (k === 'pattern' && toolName === 'Grep')) continue;
      const hit = credentialWord({ pat: escAll(v), dyn: false, raw: v }, env);
      if (hit) flag(env, `Reads credentials: ${hit}`);
    }
    if (toolName === 'Grep' || toolName === 'Glob') {
      const p = str('path');
      if (p) {
        const abs = posix.resolve(env.cwd!, p.replace(/^~(?=\/|$)/, env.ctx.home));
        if (['/', '/home', env.ctx.home].includes(abs)) flag(env, `Searches all of ${pretty(abs, env)}, which includes credential stores`);
      }
    }
  } else if (!toolName.startsWith('mcp__')) {
    // An unknown built-in tool that names a file: treat it as a write.
    const path = str('file_path') ?? str('notebook_path');
    if (path) destroy(env, { pat: escAll(path), dyn: false, raw: path }, 'Changes');
  }
  return { dangerous: env.reasons.length > 0, reason: env.reasons[0] ?? '', reasons: env.reasons };
}
