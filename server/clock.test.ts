import './testenv.ts';
// The user's time zone and Helm's one time formatter (clock.ts): `node --test server/clock.test.ts` (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import * as db from './db.ts';
import { clockText, configuredZone, dateText, dateTimeText, declineZone, reportZone, setZone, spanText, timeText, userZone, zoneAbbr, zoneState } from './clock.ts';
import { createTask, renderTasks } from './tasks.ts';
import { defaultStructure } from './structure.ts';

const LA = { tz: 'America/Los_Angeles' };
// Wednesday 18 Nov 2026, 12:52 pm in Los Angeles (PST, UTC-8).
const NOW = Date.UTC(2026, 10, 18, 20, 52);
const at = (iso: string) => Date.parse(iso);

test('12-hour clock, lower-case am/pm, noon and midnight', () => {
  assert.equal(timeText(NOW, LA), '12:52 pm');
  assert.equal(timeText(at('2026-11-18T08:00:00Z'), LA), '12:00 am');
  assert.equal(timeText(at('2026-11-18T20:00:00Z'), LA), '12:00 pm');
  assert.equal(timeText(at('2026-11-18T07:59:00Z'), LA), '11:59 pm');
  assert.equal(timeText(at('2026-11-18T17:05:00Z'), LA), '9:05 am');
});

test('today is the time alone; this week has the weekday; older has the date; another year has the year', () => {
  const o = { ...LA, now: NOW };
  assert.equal(clockText(at('2026-11-18T08:00:00Z'), o), '12:00 am'); // midnight starting today
  assert.equal(clockText(at('2026-11-18T07:59:00Z'), o), 'Tue 11:59 pm'); // a minute earlier is yesterday
  assert.equal(clockText(at('2026-11-14T02:30:00Z'), o), 'Fri 6:30 pm');
  assert.equal(clockText(at('2026-11-10T19:00:00Z'), o), 'Nov 10, 11:00 am');
  assert.equal(clockText(at('2025-12-24T19:00:00Z'), o), 'Dec 24, 2025, 11:00 am');
  assert.equal(dateTimeText(NOW, o), 'Nov 18, 12:52 pm');
});

test('the zone decides what "today" is', () => {
  // 3:00 am UTC on the 18th is 7:00 pm on the 17th in Los Angeles.
  const ts = at('2026-11-18T03:00:00Z');
  assert.equal(clockText(ts, { tz: 'UTC', now: NOW }), '3:00 am');
  assert.equal(clockText(ts, { ...LA, now: NOW }), 'Tue 7:00 pm');
  assert.equal(dateText(ts, { tz: 'UTC' }), '2026-11-18');
  assert.equal(dateText(ts, LA), '2026-11-17');
});

test('other zones, including half-hour offsets', () => {
  assert.equal(timeText(NOW, { tz: 'Europe/Berlin' }), '9:52 pm');
  assert.equal(timeText(NOW, { tz: 'Asia/Kolkata' }), '2:22 am');
  assert.equal(clockText(NOW, { tz: 'Asia/Tokyo', now: NOW }), '5:52 am');
  assert.equal(clockText(NOW, { tz: 'Asia/Tokyo', now: NOW + 86_400_000 }), 'Thu 5:52 am');
});

test('across the end of daylight saving time', () => {
  // 1 Nov 2026: 2:00 am PDT becomes 1:00 am PST, so 1:30 am happens twice.
  const first = at('2026-11-01T08:30:00Z');
  const second = at('2026-11-01T09:30:00Z');
  assert.equal(timeText(first, LA), '1:30 am');
  assert.equal(timeText(second, LA), '1:30 am');
  assert.equal(zoneAbbr(first, LA), 'PDT');
  assert.equal(zoneAbbr(second, LA), 'PST');
  assert.equal(timeText(at('2026-11-01T10:30:00Z'), LA), '2:30 am');
  // and the spring change: 2:30 am PST does not exist on 8 Mar 2026; 10:30 UTC is 3:30 am PDT.
  assert.equal(timeText(at('2026-03-08T10:30:00Z'), LA), '3:30 am');
});

test('spans', () => {
  const o = { ...LA, now: NOW };
  assert.equal(spanText(at('2026-11-18T17:10:00Z'), at('2026-11-18T19:40:00Z'), o), '9:10–11:40 am');
  assert.equal(spanText(at('2026-11-18T17:10:00Z'), at('2026-11-18T21:40:00Z'), o), '9:10 am–1:40 pm');
  assert.equal(spanText(at('2026-11-17T03:10:00Z'), at('2026-11-17T05:40:00Z'), o), 'Mon 7:10–9:40 pm');
  assert.equal(spanText(at('2026-11-17T06:10:00Z'), at('2026-11-17T09:20:00Z'), o), 'Mon 10:10 pm – Tue 1:20 am');
});

test('the setting: first report sets it, a different one is proposed, decline and set', () => {
  assert.equal(configuredZone(), null);
  assert.equal(userZone(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.deepEqual(reportZone('Not/AZone'), zoneState());
  assert.equal(configuredZone(), null);
  assert.equal(reportZone('America/Los_Angeles').timeZone, 'America/Los_Angeles');
  assert.equal(reportZone('America/Los_Angeles').proposed, null);
  const p = reportZone('Europe/Berlin');
  assert.equal(p.timeZone, 'America/Los_Angeles');
  assert.equal(p.proposed, 'Europe/Berlin');
  declineZone('Europe/Berlin');
  assert.equal(zoneState().proposed, null);
  assert.equal(reportZone('Europe/Berlin').proposed, null, 'a declined zone is not proposed again');
  assert.equal(reportZone('Asia/Tokyo').proposed, 'Asia/Tokyo');
  assert.match(setZone('Nope/Nope') ?? '', /Unknown time zone/);
  assert.equal(setZone('Asia/Tokyo'), null);
  assert.deepEqual(zoneState(), { timeZone: 'Asia/Tokyo', effective: 'Asia/Tokyo', proposed: null, declined: ['Europe/Berlin'] });
  assert.equal(setZone('America/Los_Angeles'), null);
});

test('a tool result (list_tasks timing) follows the setting', () => {
  const pid = db.newId('pr');
  db.run('INSERT INTO projects (id, name, path, phase, autonomy, structure, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', pid, 'Clock', tmpdir(), 'Build', 'auto', JSON.stringify(defaultStructure()), db.now(), db.now());
  const task = createTask(pid, { title: 'Timed', state: 'active', origin: 'user' }, { author: 'user', name: 'You' });
  const started = db.now() - 5 * 60_000;
  db.run('UPDATE tasks SET started_at = ?, active_since = ?, active_ms = 0 WHERE id = ?', started, started, task.id);
  const hm = (tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(started).replace(/\s+/, ' ').toLowerCase();
  for (const tz of ['America/Los_Angeles', 'Asia/Kolkata']) {
    assert.equal(setZone(tz), null);
    const line = renderTasks(pid).split('\n').find((l) => l.includes('timing:'))!;
    assert.match(line, /timing: started (\w{3} )?\d{1,2}:\d{2} (am|pm), 5 min of work so far/);
    assert.ok(line.includes(hm(tz)), `${line} should show ${hm(tz)} for ${tz}`);
  }
});

test('a zone set by another process sharing the database is seen at once', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { join } = await import('node:path');
  const { DATA_DIR } = await import('./config.ts');
  assert.equal(setZone('America/Los_Angeles'), null);
  assert.equal(userZone(), 'America/Los_Angeles');
  const other = new DatabaseSync(join(DATA_DIR, 'helm.db'));
  other.prepare("UPDATE clock_state SET value = ? WHERE key = 'timeZone'").run(JSON.stringify('Europe/Berlin'));
  other.close();
  assert.equal(userZone(), 'Europe/Berlin');
  assert.equal(timeText(NOW), '9:52 pm');
  assert.equal(setZone('America/Los_Angeles'), null);
});
