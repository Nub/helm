/**
 * The runner's code, for deciding whether an update must restart agents (server/runner.ts, nix/live-update.sh).
 *
 *   node server/closure.ts [ROOT] [--out FILE]
 *
 * Follows every relative import (static, dynamic and re-exports; not `import type`, which Node strips) from the
 * runner's entry, server/runner-main.ts, and hashes what it reaches together with everything else that can change
 * what the runner does: main.ts itself (not what it imports for the web service), every file under server/ that is not
 * TypeScript (data read at run time, e.g. danger.live.json), package.json and package-lock.json (the dependencies,
 * among them the Agent SDK) and the Node binary. Two builds with the same hash run the same runner. nix/package.nix
 * writes the result to lib/helm/runner.json: { hash, files }.
 *
 * Tools and system prompts (tools.ts, structure.ts) are reached from runtime.ts, so changing them is a runner change.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IMPORT = /^\s*(import|export)\s+(?!type\s)[^;]*?\sfrom\s+'(\.[^']+)'/gms;
const BARE = /^\s*import\s+'(\.[^']+)'/gm;
const DYNAMIC = /\bimport\(\s*'(\.[^']+)'\s*\)/g;

/**
 * What of a file counts. Of package.json and package-lock.json only what the server runs with: not the scripts, nor
 * the development dependencies (the web app's build tools and React, which only change web/dist).
 */
function contents(root: string, f: string): string | Buffer {
  const raw = readFileSync(join(root, f));
  if (f === 'package.json') {
    const { scripts: _s, devDependencies: _d, ...rest } = JSON.parse(raw.toString('utf8'));
    return JSON.stringify(rest);
  }
  if (f === 'package-lock.json') {
    const lock = JSON.parse(raw.toString('utf8'));
    const packages = Object.fromEntries(Object.entries(lock.packages ?? {}).filter(([name, p]: [string, any]) => name !== '' && !p.dev));
    return JSON.stringify({ lockfileVersion: lock.lockfileVersion, packages, root: lock.packages?.['']?.dependencies ?? {} });
  }
  return raw;
}

export function runnerClosure(root: string): { hash: string; files: string[] } {
  const seen = new Set<string>();
  const stack = [join(root, 'server', 'runner-main.ts')];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const src = readFileSync(f, 'utf8');
    for (const re of [IMPORT, BARE, DYNAMIC]) {
      for (const m of src.matchAll(re)) stack.push(resolve(dirname(f), m[m.length - 1]));
    }
  }
  const files = new Set([...seen].map((f) => relative(root, f)));
  files.add('server/main.ts');
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = join(dir, name);
      if (statSync(join(root, rel)).isDirectory()) walk(rel);
      else if (!name.endsWith('.ts')) files.add(rel);
    }
  };
  walk('server');
  for (const f of ['package.json', 'package-lock.json']) files.add(f);
  const list = [...files].sort();
  const h = createHash('sha256');
  for (const f of list) {
    h.update(`${f}\0`);
    h.update(contents(root, f));
    h.update('\0');
  }
  h.update(`node ${process.version} ${realpathSync(process.execPath)}`);
  // The tests are not the runner; listed files are what an update that touches them restarts.
  return { hash: h.digest('hex'), files: list.filter((f) => !/\.test\.ts$|^server\/checks\//.test(f)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
  const root = resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out') ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const json = JSON.stringify(runnerClosure(root)) + '\n';
  if (out) writeFileSync(out, json);
  else process.stdout.write(json);
}
