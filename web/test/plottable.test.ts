// Plottable-table detection for markdown previews (web/src/plottable.ts). Run: node --test web/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPlottable, firstLine, parseNumber, tableChart } from '../src/plottable.ts';

test('numbers: commas, signs, percent, units and currency', () => {
  assert.deepEqual(parseNumber('1,234.5'), { value: 1234.5, unit: '' });
  assert.deepEqual(parseNumber('12.5%'), { value: 12.5, unit: '%' });
  assert.deepEqual(parseNumber('**-3 ms**'), { value: -3, unit: 'ms' });
  assert.deepEqual(parseNumber('$4'), { value: 4, unit: '$' });
  assert.equal(parseNumber('fast'), null);
  assert.equal(parseNumber('12 (ok)'), null);
});

test('a label column and numeric columns: a bar chart', () => {
  const p = findPlottable('# Latency\n\nBy route:\n\n| Route | p50 ms | p95 ms |\n|---|---:|---:|\n| /a | 12 | 30 |\n| /b | 1,200 | 2,400 |\n\nThat is all.');
  assert.ok(p);
  assert.equal(p.spec.type, 'bar');
  assert.deepEqual(p.spec.labels, ['/a', '/b']);
  assert.deepEqual(p.spec.series, [{ name: 'p50 ms', values: [12, 1200] }, { name: 'p95 ms', values: [30, 2400] }]);
  assert.match(p.before, /By route:/);
  assert.match(p.after, /That is all\./);
  assert.ok(p.table.startsWith('| Route'));
});

test('a percent column is parsed and gives the unit', () => {
  const p = findPlottable('| Suite | Pass rate |\n|---|---|\n| unit | 98.5% |\n| e2e | 87% |\n| lint | — |');
  assert.ok(p);
  assert.equal(p.spec.unit, '%');
  assert.deepEqual(p.spec.series[0].values.slice(0, 2), [98.5, 87]);
  assert.ok(Number.isNaN(p.spec.series[0].values[2]), 'a dash is a gap');
});

test('mixed text is not plottable', () => {
  assert.equal(findPlottable('| Name | Status | Time |\n|---|---|---|\n| a | ok | 3 |\n| b | failed | 4 |'), null);
  assert.equal(findPlottable('| Name | Time |\n|---|---|\n| a | 3 s |\n| b | about 4 |'), null);
  assert.equal(findPlottable('| Name | Time |\n|---|---|\n| a | 3 |'), null, 'one row is not a chart');
  assert.equal(findPlottable('No table here, just | a pipe.'), null);
});

test('a time or step column makes a line chart', () => {
  assert.equal(findPlottable('| Step | Loss |\n|---|---|\n| 1 | 0.9 |\n| 2 | 0.5 |\n| 3 | 0.3 |')!.spec.type, 'line');
  assert.equal(findPlottable('| Date | Users |\n|---|---|\n| 2026-01-01 | 10 |\n| 2026-02-01 | 14 |')!.spec.type, 'line');
  assert.equal(findPlottable('| Week | Users |\n|---|---|\n| W1 | 10 |\n| W2 | 14 |')!.spec.type, 'line');
  // All numeric, first column not climbing: no x to draw against.
  assert.equal(tableChart(['a', 'b'], [['3', '1'], ['2', '5']]), null);
});

test('the first plottable table wins', () => {
  const p = findPlottable('| a | b |\n|---|---|\n| x | y |\n| z | w |\n\n| Host | CPU |\n|---|---|\n| one | 40% |\n| two | 60% |');
  assert.deepEqual(p!.spec.labels, ['one', 'two']);
});

test('a card line: the first line that is not the title', () => {
  assert.equal(firstLine('# Release notes\n\n- **Faster** startup, see [docs](x)', 'Release notes'), 'Faster startup, see docs');
  assert.equal(firstLine('x'.repeat(200), '', 20).length, 20);
});
