// Structure check for web/src/styles.css: a merge once dropped closing braces silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
// Deepest legitimate nesting, measured on master: 2 (a rule inside @media). Depth 3 means a lost "}".
const MAX_DEPTH = 2;

function scan(src: string) {
  let depth = 0, line = 1, open = 0, close = 0;
  let firstNegative = 0, firstTooDeep = 0, max = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (const ch of src.slice(i, stop)) if (ch === '\n') line++;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '\n') line++;
    else if (c === '{') {
      open++; depth++;
      if (depth > max) max = depth;
      if (depth > MAX_DEPTH && !firstTooDeep) firstTooDeep = line;
    } else if (c === '}') {
      close++; depth--;
      if (depth < 0 && !firstNegative) firstNegative = line;
    }
    i++;
  }
  return { depth, open, close, firstNegative, firstTooDeep, max };
}

const r = scan(css);

test('styles.css has no git conflict markers', () => {
  const lines = css.split('\n');
  const at = lines.findIndex((l) => /^(<<<<<<<|>>>>>>>)/.test(l) || /^=======\s*$/.test(l));
  assert.equal(at, -1, `conflict marker at styles.css line ${at + 1}`);
});

test('styles.css braces are balanced', () => {
  assert.equal(r.open, r.close, `styles.css has ${r.open} "{" but ${r.close} "}"`);
  assert.equal(r.firstNegative, 0, `brace depth goes below 0 at styles.css line ${r.firstNegative} (extra "}")`);
  assert.equal(r.depth, 0, `brace depth is ${r.depth} at the end of styles.css (missing "}")`);
});

test(`styles.css nests at most ${MAX_DEPTH} deep`, () => {
  assert.equal(r.firstTooDeep, 0, `brace depth reaches ${MAX_DEPTH + 1} at styles.css line ${r.firstTooDeep}: a closing brace was probably lost above it`);
});


// The Quieter system (task_5c39a0ebe5): buttons and chips are styled only in the shared block; elsewhere a rule
// whose subject is one may only place it (sharedstyles.ts has the definition).
test('no button or chip rules outside the shared set', async () => {
  const { strays } = await import('./sharedstyles.ts');
  const found = strays(css).map((r) => `line ${r.line}: ${r.selector} sets ${r.visual.map((d) => d.prop).join(', ')}`);
  assert.deepEqual(found, [], `Style these in the shared block of styles.css, or only place them here:\n${found.join('\n')}`);
  // And the block itself is there.
  assert.ok(css.includes('shared:start') && css.includes('shared:end'));
});

test('a bespoke class is caught: a rule outside the block styling a -btn or a .tag', async () => {
  const { strays } = await import('./sharedstyles.ts');
  const sample = '.x .tag { margin: 0; }\n.y-btn { background: red; }\n.z .chip { color: blue; }\n/* shared:start */ .tag { color: red; } /* shared:end */';
  assert.deepEqual(strays(sample).map((r) => r.selector), ['.y-btn', '.z .chip']);
});
