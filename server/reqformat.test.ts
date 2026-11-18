import './testenv.ts';
// Table test for reqformat.ts: `node --test server/reqformat.test.ts` (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRequestText, splitAction, splitEnumeration } from './reqformat.ts';

/** The real to-do that showed as one run-on paragraph on a phone (filed from update_task needs_from_user). */
const REAL =
  "After the next update, try these on the real iPhone and iPad and answer with whichever misbehave: (1) Open a tall preview: pinch, pan, double-tap, swipe down to close. (2) Open the chat on a task and type: the box should sit just above the keyboard and Send should send. (3) Open the New task sheet and swipe on it: the page behind should stay still. (4) Long-press and drag a task, a Spec entry and a project: no text selection or link menu, and the drag works. (5) Open an HTML or PDF preview's Full screen: it should scroll and zoom, and Close should bring you back. (6) iPad in landscape: nothing under the status bar.";
const REAL_LIST = [
  '1. Open a tall preview: pinch, pan, double-tap, swipe down to close.',
  '2. Open the chat on a task and type: the box should sit just above the keyboard and Send should send.',
  '3. Open the New task sheet and swipe on it: the page behind should stay still.',
  '4. Long-press and drag a task, a Spec entry and a project: no text selection or link menu, and the drag works.',
  "5. Open an HTML or PDF preview's Full screen: it should scroll and zoom, and Close should bring you back.",
  '6. iPad in landscape: nothing under the status bar.',
].join('\n');

/** [input, expected output of formatRequestText] */
const TABLE: [string, string][] = [
  [REAL, `After the next update, try these on the real iPhone and iPad and answer with whichever misbehave:\n\n${REAL_LIST}`],
  // "1) … 2) …"
  ['Please check two things: 1) the login works; 2) the logout works.', 'Please check two things:\n\n1. the login works\n2. the logout works.'],
  // "1. … 2. …" inline
  ['Try this: 1. Open Setup. 2. Press Update now. 3. Wait for the restart.', 'Try this:\n\n1. Open Setup.\n2. Press Update now.\n3. Wait for the restart.'],
  // Joined with "and"
  ['Do (1) restart the router, and (2) reconnect the phone.', 'Do\n\n1. restart the router\n2. reconnect the phone.'],
  // No lead
  ['(1) Plug in the board. (2) Hold BOOT.', '1. Plug in the board.\n2. Hold BOOT.'],
  // Only in its own paragraph; the rest is kept as written
  ['The build is ready.\n\nOn the iPad: (1) rotate it. (2) open a task.', 'The build is ready.\n\nOn the iPad:\n\n1. rotate it.\n2. open a task.'],
];

/** Left alone. */
const UNCHANGED = [
  'See point (1) in the plan above before you approve.',
  'Is version 2.5 or 2.6 the one you want?',
  'Update Node from 22.1 to 24.2 and restart. 3 agents are waiting.',
  'Numbers out of order: (2) first, then (3).',
  'Already formatted:\n\n1. Open Setup.\n2. Press Update now.',
  'Already formatted:\n- one\n- two',
  'Run this:\n\n```\nnpm ci (1) && npm test (2)\n```',
  'Press Update now on the Helm page.',
  'Should I merge it?',
  'In 2025. 2 more things changed.',
  '',
];

test('inline enumerations become a lead and a numbered list', () => {
  for (const [input, want] of TABLE) assert.equal(formatRequestText(input), want, input);
});

test('everything else is left alone', () => {
  for (const input of UNCHANGED) assert.equal(formatRequestText(input), input, input);
});

test('splitEnumeration needs two items numbered from 1', () => {
  assert.equal(splitEnumeration('Only (1) one item here.'), null);
  assert.deepEqual(splitEnumeration('Pick: (1) red (2) blue'), { lead: 'Pick:', items: ['red', 'blue'] });
});

test("a to-do's enumeration goes to its steps", () => {
  assert.deepEqual(splitAction(REAL, ''), {
    body: 'After the next update, try these on the real iPhone and iPad and answer with whichever misbehave:',
    steps: REAL_LIST,
  });
  // Steps already given: the body is formatted in place, the steps kept (formatted when inline).
  assert.deepEqual(splitAction('Check (1) a (2) b', 'Run `make`.'), { body: 'Check\n\n1. a\n2. b', steps: 'Run `make`.' });
  assert.deepEqual(splitAction('Flash the board.', 'Do this: (1) hold BOOT, (2) press RESET.'), { body: 'Flash the board.', steps: 'Do this:\n\n1. hold BOOT\n2. press RESET.' });
  // No lead: nothing to leave as the body, so it stays a list in the body.
  assert.deepEqual(splitAction('(1) a. (2) b.', ''), { body: '1. a.\n2. b.', steps: '' });
  assert.deepEqual(splitAction('Press Update now.', ''), { body: 'Press Update now.', steps: '' });
});

test('formatting twice changes nothing (filing time, then display time)', () => {
  const once = splitAction(REAL, '');
  assert.deepEqual(splitAction(once.body, once.steps), once);
  for (const [input] of TABLE) assert.equal(formatRequestText(formatRequestText(input)), formatRequestText(input), input);
});
