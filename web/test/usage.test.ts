// Token and plan text (web/src/usage.ts): `node --test web/test/usage.test.ts`.
process.env.TZ = 'America/Los_Angeles';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactNumber, planLines, tokensText } from '../src/usage.ts';

const sp = (s: string) => s.replace(/ /g, ' ');

test('compact numbers', () => {
  assert.deepEqual([0, 980, 1000, 1234, 12_345, 123_456, 999_499, 999_500, 1_234_567, 45_600_000, 2_300_000_000].map(compactNumber), [
    '0', '980', '1k', '1.2k', '12k', '123k', '999k', '1M', '1.2M', '46M', '2.3B',
  ]);
  assert.equal(sp(tokensText(1_234_567)!), '1.2M tokens');
  assert.equal(tokensText(0), null);
});

test('plan lines: one per known window, reset in the browser zone', () => {
  const now = Date.UTC(2026, 10, 18, 20, 52); // Wed 12:52 pm PST
  const lines = planLines(
    [
      { name: 'five_hour', percent: 41.6, resetsAt: Date.UTC(2026, 10, 19, 0, 0) },
      { name: 'seven_day', percent: 18, resetsAt: Date.UTC(2026, 10, 21, 17, 0) },
      { name: 'seven_day_fable', percent: 3, resetsAt: null },
    ],
    now,
  ).map(sp);
  assert.deepEqual(lines, ['Plan: 42% used · resets 4:00 pm', 'Plan (week): 18% used · resets Sat 9:00 am', 'Plan (seven day fable): 3% used']);
  const old = planLines([{ name: 'model:Fable', percent: 7, resetsAt: null, at: now - 20 * 60_000 }, { name: 'five_hour', percent: 1, resetsAt: null, at: now - 60_000 }], now).map(sp);
  assert.deepEqual(old, ['Plan (week, Fable): 7% used · as of 12:32 pm', 'Plan: 1% used']);
});
