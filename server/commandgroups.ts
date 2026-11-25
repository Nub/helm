/**
 * Which command a shell command is, for "waiting on commands" by command (activitystats.ts): runs of the same command
 * group into one line though their arguments differ in ways that do not matter (paths, test names, `-p <crate>`), by
 * the program and its sub-command (`cargo build`, `npm test`, `nix build`, `node shoot.mjs`), keeping apart what is
 * meaningfully different (a release build, another test suite, another npm script). Each group has an intent derived
 * from it, used when the agent gave the command no description. Pure.
 */

export type CommandGroup = { key: string; intent: string };

/** Leading `cd x &&`, variable settings, `env`, `time`, `nice`, `timeout N`: not the command itself. */
function strip(c: string): string {
  let s = c.trim();
  for (let i = 0; i < 8; i++) {
    const next = s
      .replace(/^\s*cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/, '')
      .replace(/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_]*=("[^"]*"|'[^']*'|(?:\$\([^)]*\)|[^\s;&])*)\s*(&&|;)?\s*/, '')
      .replace(/^\s*(env|time|nice|nohup|exec|command)\s+/, '')
      .replace(/^\s*timeout\s+\S+\s+/, '')
      .replace(/^\s*(source|\.)\s+\S+\s*(&&|;)\s*/, '');
    if (next === s) break;
    s = next;
  }
  return s;
}

/** The first command of a chain or pipeline, as words (quotes kept simple). */
function words(c: string): string[] {
  const first = c.split(/\s*(?:&&|\|\||;|\||\n)\s*/)[0] ?? '';
  return (first.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((w) => w.replace(/^["']|["']$/g, '')).filter((w) => !/^\d?>&?\d?$|^2>&1$/.test(w));
}
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;
const flags = (ws: string[]) => ws.filter((w) => w.startsWith('-'));
const args = (ws: string[]) => {
  // Positional arguments, skipping each flag's value where the flag takes one (`-p crate`, `--features x`).
  const out: string[] = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (w.startsWith('-')) {
      if (!w.includes('=') && /^(-p|--package|--features|-F|--bin|--example|--test|--target|--manifest-path|-j|--jobs|--profile|--config|-C|-o|--out-link|-I|--prefix|--filter|-t|--reporter|--test-name-pattern|--name|--routes|--devices|--out)$/.test(w)) i++;
      continue;
    }
    out.push(w);
  }
  return out;
};
const flagValue = (ws: string[], ...names: string[]) => {
  for (let i = 0; i < ws.length; i++) {
    for (const n of names) {
      if (ws[i] === n && ws[i + 1]) return ws[i + 1];
      if (ws[i].startsWith(`${n}=`)) return ws[i].slice(n.length + 1);
    }
  }
  return null;
};

const WAIT = /^\s*(until\b|while\b|sleep\b|for\s+\w+\s+in\b[^;]*;\s*do\b[\s\S]*\bsleep\b)/;
/** Programs that are not what a chain is for: moving about, reading, filtering, tidying, shell syntax. */
const HELPERS = new Set(['cd', 'echo', 'printf', 'cat', 'ls', 'rm', 'mkdir', 'touch', 'export', 'set', 'unset', 'true', 'false', 'test', '[', '[[', 'grep', 'egrep', 'rg', 'sed', 'awk', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'mv', 'cp', 'chmod', 'ln', 'date', 'sleep', 'wait', 'pwd', 'which', 'type', 'source', '.', 'exit', 'read', 'if', 'then', 'fi', 'do', 'done', 'for', 'while', 'until', 'else', 'elif', 'case', 'esac', 'tee', 'jq', 'xargs', 'find', 'stat', 'du', 'df', 'kill', 'pkill', 'pgrep', 'ps', 'local', 'shopt', 'trap', 'basename', 'dirname', 'realpath', 'readlink', 'diff', 'cmp', 'file', 'less', 'more', 'column', 'nl', 'paste', 'comm', 'seq', 'yes', 'git', 'id', 'whoami', 'env', 'printenv', 'clear']);

const NAV = new Set(['cd', 'export', 'set', 'unset', 'source', '.', 'local', 'shopt', 'trap', 'true', 'pushd', 'popd', 'umask', 'ulimit']);
/** Programs that run another command: the command they run is the one that counts. */
const WRAPPERS = new Set(['setsid', 'nohup', 'nice', 'ionice', 'stdbuf', 'taskset', 'systemd-run', 'sudo', 'doas', 'xvfb-run', 'time', 'timeout', 'env', 'exec', 'command', 'caffeinate', 'unbuffer', 'chrt', 'cgexec', 'firejail', 'bwrap']);
/** Tools a user's own wrapper script may run (`~/bin/slot.sh nix develop -c cargo test`). */
const TOOLS = new Set(['cargo', 'npm', 'pnpm', 'yarn', 'node', 'nix', 'make', 'python', 'python3', 'go', 'bash', 'sh', 'pytest', 'ffmpeg', 'blender', 'godot']);

/** Heredoc bodies and quoted strings out of the way, so splitting a chain never cuts inside them. */
function mask(c: string): { text: string; back: (s: string) => string } {
  const saved: string[] = [];
  const text = c
    .replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, (_m, _q, _w, tail) => `<<HEREDOC${tail}`)
    .replace(/"(?:[^"\\]|\\.)*"|'[^']*'|\$\([^()]*\)/g, (m) => `\u0000${saved.push(m) - 1}\u0000`);
  return { text, back: (s) => s.replace(/\u0000(\d+)\u0000/g, (_m, i) => saved[Number(i)]) };
}

/**
 * The command that matters in a chain: the first segment (of `&&`, `||`, `;`, `&`, new lines; the first part of a
 * pipeline) whose program is not a helper such as cd, cat, grep or echo; else the first segment. `cat x; cargo build` is
 * a cargo build; `(cargo test > log; touch done) &` too.
 */
const GIT_READS = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'branch', 'remote', 'config', 'describe', 'ls-files', 'blame', 'shortlog', 'worktree', 'stash', 'fetch', 'tag']);
const HEAVY = /^(cargo|npm|pnpm|yarn|bun|deno|nix|nix-build|make|just|gradle|gradlew|\.\/gradlew|mvn|dotnet|go|tsc|vite|webpack|esbuild|cmake|ninja|meson|bazel|pytest|jest|vitest|playwright|docker|podman|xcodebuild|swift|zig|flutter|node|python3?|setsid|nice|timeout|time)$/;
/** How central a step of a chain is: a git read 0, other tools 1, a git change 2, a build, test or program run 3. */
function segWeight(seg: string): number {
  const ws = words(seg);
  const prog = base(ws[0] ?? '');
  if (prog === 'git') {
    const sub = ws.find((w, i) => i > 0 && !w.startsWith('-')) ?? '';
    return GIT_READS.has(sub) ? 0 : sub === 'add' || sub === 'rm' || sub === 'mv' ? 1 : 2;
  }
  if (HEAVY.test(prog) || /^\.\//.test(ws[0] ?? '')) return 3;
  return 1;
}
export function mainCommand(command: string): string {
  const { text, back } = mask(String(command ?? ''));
  const segs = text.split(/\s*(?:&&|\|\||;|\n|(?<![>&|])&(?![>&]))\s*/).map((x) => x.split(/\s*\|(?!\|)\s*/)[0]).map((x) => strip(back(x.replace(/^[\s({]+|[\s)}]+$/g, '').replace(/^(do|then|else)\s+/, '')))).filter(Boolean);
  // The chain's main step: a build, test or run over a git look-around (`git status && cargo build` is the build), a
  // git change over a git read (`git status; git commit` is the commit); the first among equals.
  let best: string | null = null;
  let bestW = -1;
  for (const seg of segs) {
    const w = words(seg)[0];
    if (!w || HELPERS.has(base(w)) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    const weight = segWeight(seg);
    if (weight > bestW) (best = seg), (bestW = weight);
  }
  if (best) return best;
  // Only helpers: the weightiest that is not moving about or setting up (`git status; git add; git commit` is the
  // commit), the first among equals.
  const steps = segs.filter((seg) => !NAV.has(base(words(seg)[0] ?? '')) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(words(seg)[0] ?? ''));
  let top = steps[0] ?? segs[0] ?? '';
  for (const seg of steps) if (segWeight(seg) > segWeight(top)) top = seg;
  return top;
}

/**
 * What a wait loop waits on: the files its condition (or a `sleep; tail`) names, as the last two parts of each path
 * without the extension (/tmp/build_a.done → tmp/build_a), and the folder when the file has a generic name
 * (…/agents/grids/done → agents/grids). The command that wrote them is found by these (activity.ts).
 */
export function waitTargets(command: string): string[] {
  const c = String(command ?? '');
  const cond = /^\s*(until|while)\b/.test(c) ? c.split(/;\s*do\b/)[0] : c;
  const out = new Set<string>();
  for (const raw of cond.match(/[~$\w./-]*\/[\w./-]+/g) ?? []) {
    const p = raw.replace(/^(~|\$HOME|\$\{HOME\})/, '').replace(/\/+$/, '');
    const parts = p.split('/').filter(Boolean);
    if (parts.length < 2) continue;
    const last = parts[parts.length - 1].replace(/(\.(done|log|txt|out|output|json|status))+$/, '');
    out.add(`${parts[parts.length - 2]}/${last}`);
    if (/^(done|out|log|output|status|result|exit)$/.test(last) && parts.length >= 3) out.add(`${parts[parts.length - 3]}/${parts[parts.length - 2]}`);
  }
  return [...out];
}
/**
 * The files a command writes, normalised as waitTargets normalises a wait's files: its --out / -o / --output targets,
 * > and >> redirections, tee and touch arguments, and its background output (tasks/<id>, which activity.ts appends).
 * Paths it only reads or that appear in its output do not count.
 */
export function writtenTargets(command: string): string[] {
  const c = String(command ?? '');
  const out = new Set<string>();
  const add = (raw: string) => {
    const p = raw.replace(/^["']|["']$/g, '').replace(/^(~|\$HOME|\$\{HOME\})/, '').replace(/\/+$/, '');
    const parts = p.split('/').filter(Boolean);
    if (!parts.length) return;
    const last = parts[parts.length - 1].replace(/(\.(done|log|txt|out|output|json|status))+$/, '');
    if (parts.length >= 2) out.add(`${parts[parts.length - 2]}/${last}`);
    // A folder it writes into (--out bench/out/meshlet): the folder itself, so a wait on a file inside it matches.
    out.add(parts.slice(-2).join('/'));
  };
  for (const m of c.matchAll(/(?:--out(?:put)?(?:-dir)?|-o)(?:=|\s+)(\S+)/g)) add(m[1]);
  for (const m of c.matchAll(/(?<![0-9&])>>?\s*(?!&)(\S+)/g)) add(m[1]);
  for (const m of c.matchAll(/\b(?:tee|touch)\s+((?:-\S+\s+)*)([^|;&\s]+(?:\s+[^|;&\s-][^|;&\s]*)*)/g)) for (const p of m[2].split(/\s+/)) add(p);
  for (const m of c.matchAll(/#tasks\/(\w+)$/g)) out.add(`tasks/${m[1]}`);
  return [...out].filter((p) => !/^dev\/null$|^null$/.test(p));
}
const SCRIPTS = new Set(['node', 'python', 'python3', 'py3', 'perl', 'ruby', 'deno', 'bun', 'bash', 'sh', 'zsh', 'tsx', 'ts-node']);
/** A command's own text, without the background id activity.ts adds to it. */
export const commandText = (c: string) => String(c ?? '').replace(/ #tasks\/\w+$/, '');
const SUBS = new Set(['cargo', 'npm', 'pnpm', 'yarn', 'git', 'nix', 'go', 'docker', 'podman', 'kubectl', 'gh', 'make', 'just', 'gradle', './gradlew', 'gradlew', 'dotnet', 'mvn', 'pip', 'uv', 'poetry', 'systemctl', 'journalctl', 'flutter', 'xcodebuild', 'swift', 'zig', 'bazel', 'cmake', 'meson', 'ninja']);

/** The group a command belongs to and its intent in plain words. */
export function commandGroup(command: string): CommandGroup {
  command = commandText(command);
  if (WAIT.test(strip(String(command ?? '')))) return { key: 'wait loop', intent: 'Wait for something to finish' };
  const c = mainCommand(command);
  const ws = words(c);
  if (!ws.length) return { key: 'other', intent: 'Run a command' };
  const prog = base(ws[0]);
  const rest = ws.slice(1);
  // A wrapper (setsid, nice -n 5, systemd-run --user …): the command it runs, past its own flags and numbers.
  if (WRAPPERS.has(prog)) {
    const i = rest.findIndex((w) => !w.startsWith('-') && !/^\d+[smhd]?$/.test(w) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    if (i >= 0) return commandGroup(rest.slice(i).join(' '));
  }
  // nix develop/shell -c <command>: the command.
  if (prog === 'nix' && (rest[0] === 'develop' || rest[0] === 'shell')) {
    const i = rest.findIndex((w) => w === '-c' || w === '--command');
    if (i >= 0 && rest[i + 1]) return commandGroup(rest.slice(i + 1).join(' '));
  }
  // A script of the user's own that runs a known tool: the tool's command.
  if (!SUBS.has(prog) && !SCRIPTS.has(prog) && !TOOLS.has(prog)) {
    const i = rest.findIndex((w) => TOOLS.has(w));
    if (i >= 0) return commandGroup(rest.slice(i).join(' '));
  }
  const pos = args(rest);
  const fl = flags(rest);
  if (prog === 'cargo') {
    const sub = pos[0] ?? 'build';
    const release = fl.includes('--release') || fl.includes('-r') ? ' --release' : flagValue(rest, '--profile') ? ` --profile ${flagValue(rest, '--profile')}` : '';
    const suite = sub === 'test' && flagValue(rest, '--test') ? ` --test ${flagValue(rest, '--test')}` : sub === 'test' && fl.includes('--doc') ? ' --doc' : '';
    const mode = release ? 'in release mode' : 'in debug mode';
    const intent: Record<string, string> = {
      build: `Build ${mode}`, check: 'Check that it compiles', clippy: 'Lint with clippy', test: suite ? `Run the ${suite.replace(/^ --test /, '').replace(' --doc', 'doc')} tests` : 'Run the tests',
      run: `Run the program ${mode}`, bench: 'Run the benchmarks', fmt: 'Format the code', doc: 'Build the docs', install: 'Install a tool', update: 'Update dependencies', fetch: 'Download dependencies',
    };
    return { key: `cargo ${sub}${release}${suite}`, intent: intent[sub] ?? `cargo ${sub}` };
  }
  if (prog === 'npm' || prog === 'pnpm' || prog === 'yarn') {
    const sub = pos[0] ?? 'install';
    if (sub === 'run' || sub === 'run-script') {
      const script = pos[1] ?? '';
      const intent = /^test|:test|^check/.test(script) ? `Run the ${script} checks` : script === 'build' ? 'Build' : /build/.test(script) ? `Build (${script})` : /typecheck|lint/.test(script) ? `Check the code (${script})` : /dev|start|serve/.test(script) ? 'Start the app' : `Run the ${script} script`;
      return { key: `${prog} run ${script}`, intent };
    }
    const intent: Record<string, string> = { test: 'Run the tests', t: 'Run the tests', ci: 'Install dependencies', install: 'Install dependencies', i: 'Install dependencies', start: 'Start the app', exec: 'Run a package tool', x: 'Run a package tool' };
    return { key: `${prog} ${sub}`, intent: intent[sub] ?? `${prog} ${sub}` };
  }
  if (prog === 'npx' || prog === 'pnpx' || prog === 'bunx') return { key: `${prog} ${base(pos[0] ?? '')}`.trim(), intent: `Run ${base(pos[0] ?? 'a package tool')}` };
  if (prog === 'nix') {
    const sub = pos[0] ?? '';
    const attr = pos.slice(1).find((p) => /#/.test(p));
    const what = attr ? attr.replace(/^.*#/, '') : '';
    const intent: Record<string, string> = { build: `Build${what ? ` ${what}` : ''} with Nix`, develop: 'Enter the dev shell', shell: 'Get tools from Nix', run: `Run${what ? ` ${what}` : ''} with Nix`, flake: `nix flake ${pos[1] ?? ''}`.trim(), eval: 'Evaluate a Nix expression' };
    if (!sub) return { key: 'nix', intent: 'Run nix' };
    return { key: `nix ${sub}${what && (sub === 'build' || sub === 'run') ? ` #${what}` : ''}`, intent: intent[sub] ?? `Run nix ${sub}` };
  }
  if (prog === 'nix-build' || prog === 'nixos-rebuild') return { key: prog, intent: prog === 'nix-build' ? 'Build with Nix' : 'Rebuild the system' };
  if (SCRIPTS.has(prog)) {
    if (prog === 'node' && fl.includes('--test')) {
      // Not args(): --test takes no value here.
      const files = rest.filter((p) => !p.startsWith('-') && /\.(m?[jt]s)$/.test(p));
      const suite = files.length === 1 ? base(files[0]).replace(/\.test\.m?[jt]s$|\.m?[jt]s$/, '') : files.length ? 'several suites' : 'all';
      return { key: `node --test ${suite}`, intent: files.length === 1 ? `Run the ${suite} tests` : 'Run the tests' };
    }
    const script = pos.find((p) => p !== '-c' && p !== '-e' && !p.startsWith('<') && !p.startsWith('>'));
    if ((prog === 'bash' || prog === 'sh' || prog === 'zsh') && (fl.includes('-c') || fl.includes('-lc'))) {
      // bash -c '<command>': the command inside.
      const inner = rest[rest.indexOf(fl.includes('-c') ? '-c' : '-lc') + 1];
      if (inner) return commandGroup(inner);
    }
    if (fl.includes('-e') || fl.includes('-c') || !script) return { key: `${prog} inline`, intent: `Run an inline ${prog} script` };
    // A script named by a variable (`python $v`): which one is unknown.
    if (/^\$/.test(script)) return { key: `${prog} script`, intent: `Run a ${prog} script` };
    const name = base(script);
    const what = name.replace(/\.(m?[jt]s|py|sh|rb|pl)$/, '');
    const intent = /check/.test(name) ? `Run the ${what.replace(/\.check$/, '')} check` : /shoot|screenshot/.test(name) ? 'Take screenshots' : /scratch/.test(name) ? 'Start or stop a scratch server' : /render/.test(name) ? 'Render' : /bench/.test(name) ? 'Run a benchmark' : /test/.test(name) ? `Run the ${what} tests` : `Run ${name}`;
    return { key: `${prog} ${name}`, intent };
  }
  if (SUBS.has(prog)) {
    const sub = pos[0] ?? '';
    const intent = prog === 'git' ? `Run git ${sub}`.trim() : prog === 'make' || prog === 'just' ? `Build${sub ? ` ${sub}` : ''}` : prog === 'go' && sub === 'test' ? 'Run the tests' : prog === 'go' && sub === 'build' ? 'Build' : `Run ${prog} ${sub}`.trim();
    return { key: `${prog} ${sub}`.trim(), intent };
  }
  const name = base(ws[0]);
  if (name === 'ssh') {
    const host = pos[0] ?? '';
    return { key: `ssh ${host}`.trim(), intent: `Work on ${host.replace(/^.*@/, '') || 'another machine'}` };
  }
  const intent = /^(pytest|jest|vitest|playwright)$/.test(name) ? 'Run the tests' : /^(tsc|vite|webpack|esbuild|cmake|ninja)$/.test(name) ? 'Build' : /ffmpeg|blender|godot|render/.test(name) ? 'Render' : /^(scp|rsync)$/.test(name) ? 'Copy files to or from another machine' : HELPERS.has(name) ? 'Read, move or tidy files' : /^(curl|wget)$/.test(name) ? 'Fetch from the network' : `Run ${name}`;
  return { key: name, intent };
}
