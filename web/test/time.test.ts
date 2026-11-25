// The web app's one time formatter (web/src/time.ts) in the browser's zone: `node --test web/test/time.test.ts`.
process.env.TZ = 'America/Los_Angeles'; // as a browser in Los Angeles; set before any Date formatting
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axisTicks, dateTime, dayTime, fullDateTime, hhmm, midnight, span, timeOfDay, when } from '../src/time.ts';

const sp = (s: string) => s.replace(/ /g, ' ');
const NOW = Date.UTC(2026, 10, 18, 20, 52); // Wed 18 Nov 2026, 12:52 pm PST
const at = (iso: string) => Date.parse(iso);

test('12-hour, lower-case am/pm, in the browser zone', () => {
  assert.equal(sp(timeOfDay(NOW)), '12:52 pm');
  assert.equal(sp(timeOfDay(at('2026-11-18T08:00:00Z'))), '12:00 am');
  assert.equal(sp(dayTime(at('2026-11-19T05:22:00Z'))), 'Wed 9:22 pm');
  assert.equal(sp(fullDateTime(NOW)), 'Wed, Nov 18, 2026, 12:52 pm');
  assert.match(sp(dateTime(NOW)), /^Nov 18(, 2026)?, 12:52 pm$/);
});

test('when: today, this week, older', () => {
  assert.equal(sp(when(at('2026-11-18T17:49:00Z'), NOW)), '9:49 am');
  assert.equal(sp(when(at('2026-11-17T05:00:00Z'), NOW)), 'Mon 9:00 pm');
  assert.match(sp(when(at('2026-11-02T20:00:00Z'), NOW)), /^Nov 2(, 2026)?, 12:00 pm$/);
});

test('spans and quiet-hours times', () => {
  assert.equal(sp(span(at('2026-11-18T17:10:00Z'), at('2026-11-18T19:40:00Z'))), 'Wed 9:10–11:40 am');
  assert.equal(sp(span(at('2026-11-18T03:10:00Z'), at('2026-11-18T09:20:00Z'))), 'Tue 7:10 pm – Wed 1:20 am');
  assert.equal(sp(span(NOW, null)), 'Wed 12:52 pm – now');
  assert.equal(sp(hhmm('22:00')), '10:00 pm');
  assert.equal(sp(hhmm('00:30')), '12:30 am');
  assert.equal(sp(hhmm('12:00')), '12:00 pm');
});

test('timeline axis: hours and day breaks at local midnight, not UTC', () => {
  // Nov 23, 9 pm to Nov 24, 2 am in Los Angeles (05:00 to 10:00 UTC).
  const hourly = axisTicks(at('2026-11-24T04:30:00Z'), at('2026-11-24T10:00:00Z'), 'hour');
  assert.deepEqual(hourly.map((k) => sp(k.label)), ['9 pm', '10 pm', '11 pm', 'Nov 24', '1 am', '2 am']);
  assert.deepEqual(hourly.filter((k) => k.major).map((k) => k.t), [at('2026-11-24T08:00:00Z')]);
  assert.equal(hourly[0].t, at('2026-11-24T05:00:00Z'));
  // Daily ticks fall on local midnight, also across the end of daylight time (Nov 1, 2026).
  const daily = axisTicks(at('2026-10-30T12:00:00Z'), at('2026-11-03T12:00:00Z'), 'day');
  assert.deepEqual(daily.map((k) => k.label), ['Oct 31', 'Nov 1', 'Nov 2', 'Nov 3']);
  assert.deepEqual(daily.map((k) => k.t), ['2026-10-31T07:00:00Z', '2026-11-01T07:00:00Z', '2026-11-02T08:00:00Z', '2026-11-03T08:00:00Z'].map(at));
  assert.ok(daily.every((k) => k.major && midnight(k.t) === k.t));
});
