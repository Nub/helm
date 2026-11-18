import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Vite's CSS minifier (lightningcss) merges a -webkit-backdrop-filter that follows backdrop-filter into the prefixed
// one alone: the build then had no standard property and Chromium, Android and Firefox drew the bars without blur.
// Written prefixed first, standard second, both survive. Keep that order.
test('styles.css: backdrop-filter follows -webkit-backdrop-filter', () => {
  const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  const lines = css.split('\n');
  let seen = 0;
  lines.forEach((l, i) => {
    if (/^\s*backdrop-filter:/.test(l)) {
      seen++;
      assert.match(lines[i - 1] ?? '', /^\s*-webkit-backdrop-filter:/, `line ${i + 1}: put -webkit-backdrop-filter on the line before backdrop-filter`);
    }
    if (/^\s*-webkit-backdrop-filter:/.test(l)) assert.match(lines[i + 1] ?? '', /^\s*backdrop-filter:/, `line ${i + 1}: follow -webkit-backdrop-filter with backdrop-filter`);
  });
  assert.ok(seen > 0);
});
