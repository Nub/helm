import './testenv.ts';
// Table test for userasks.ts: `node --test server/userasks.test.ts` (npm test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findUserAsks, isUserAsk } from './userasks.ts';

/** Sentences that say the user must do or decide something. */
const ASKS = [
  // The real instance (another project, 18 Nov): said in a reply and in the status summary, no request open.
  "The report export tool is finished, and it's waiting on you to add the source in Helm with the command /home/user/src/game/tools/reports/pull.sh --jsonl.",
  'Needed from you: add the Helm report source with command /home/user/src/game/tools/reports/pull.sh --jsonl; then I triage.',
  'Three small finishing touches are in progress. Needed from you: add the report source in Helm, steps in the thread.',
  'Two things will be needed from you once it is ready: zgamer reachable by ssh, and a report source.',
  'Needs from you: a go-ahead to commit.',
  'Recorded: agents will ssh into zgamer once you connect it.',
  'The Overview mockups are ready for you to choose from, in the discussion "How the user works with Helm".',
  'Look, feel and frame-time changes wait for your play test.',
  // Plain obligations
  'You need to restart the router before I can continue.',
  "You'll need to approve the merge on GitHub.",
  'You will need to plug the board in over USB.',
  'You have to press Update now on the Helm page.',
  'The user needs to run nixos-rebuild switch.',
  'The user must sign in to the vendor portal first.',
  'You must enter the license key on zgamer.',
  'You should now run the migration script.',
  'Please run `sudo nixos-rebuild switch --flake .#myhost`.',
  'Please approve the plan so I can start.',
  'Please restart Helm when convenient.',
  'Please send me the crash log from the phone.',
  'I need you to connect the second monitor.',
  'This needs your approval before it ships.',
  'It needs your go-ahead.',
  'The deploy is blocked on you: the token expired.',
  'Waiting for the user to flash the firmware.',
  'Work on the build is waiting for your decision on the SDK.',
  "It's your turn: try the new jump on the ledge.",
  'Over to you for the play test.',
  'The next step is on your side: power-cycle the printer.',
  "Once you've added the source, I'll triage the notes.",
  'After you approve it, I will schedule the work.',
  "I'll merge as soon as you confirm the numbers.",
  'Until you install the driver, agents cannot run the benchmark.',
  'What I need from you: the API key for staging.',
  'This one is for you to decide.',
  'Your step: add the dev-notes report source in Helm.',
  'Then you need to click Allow in the browser prompt.',
  'You still have to merge the release branch.',
  'For this to work you must unplug the dongle.',
  "**Needed from you:** run `make flash` on zbook.",
  '- Please check the new menu on your phone and tell me if the font is right.',
  'Both builds are waiting on you to install SDK 310.9.1.',
]; // 42

/** Sentences that do not ask anything of the user. */
const NOT_ASKS = [
  // The real ones from the Helm project that only inform (after the user presses Update, things change).
  'After you update, this project will show as over its importance limits until I re-rank it.',
  'After you update, requests appear on the task or discussion they concern, with the answer buttons on the row.',
  'Say if you want item 2 set up as a task.',
  "Tell me if you'd rather they came off it.",
  'If you would rather play it before it reaches main, say so in that task\'s thread.',
  'Nothing is needed from you right now.',
  "You don't need to do anything; the tests are running.",
  'No action needed from you.',
  'You do not need to restart Helm for this.',
  'The user will not need to approve this again.',
  'I merged the branch and the suites are green.',
  'The engineer is building on zgamer now.',
  'You approved six tasks and dropped the zip task.',
  'You asked for the font to be larger, so I changed it.',
  "You've already added the source, so reports will flow in.",
  'The build needs SDK 310.9.1, which is installed.',
  'Agents reach the Windows dev PC by ssh.',
  'I need to rerun the suite after the merge.',
  'The engineer needs to finish the shader first.',
  'Waiting on the CI runner to finish.',
  'Blocked on the upstream fix in rolldown.',
  'This is for the user-facing summary only.',
  'Your notes on zgamer were only read, never changed.',
  'Your originals in %APPDATA% are not touched.',
  'Let me know if anything looks off.',
  'If you want, I can also add a dark mode toggle.',
  'The request is on the task; the user sees and answers it there.',
  'The user can attach files to any answer.',
  'Once the tests pass, I will merge it.',
  'After the merge, the release branch moves.',
  'Should you want to see it, the preview is in the gallery.',
  'You can see the result in the preview.',
  'Your play test from yesterday found two bugs, both fixed.',
  'The review is waiting on the director.',
  'I am waiting for the build to finish.',
  'The worker must rerun the benchmark.',
  'Helm needs to restart to pick this up, which the update does.',
  'Nothing here waits on you.',
  'This does not need your approval.',
  'The decision you made on Tuesday stands.',
  'After you update, each Spec entry has Discuss, the Spec can be sorted by Sections, Priority, Updated, Status or Title.',
  'A director that just says "you need to do X" in a reply has filed nothing, so nothing lands.',
]; // 40

test('asks are found', () => {
  assert.deepEqual(ASKS.filter((s) => !isUserAsk(s)), [], "missed asks");
});

test('non-asks are not', () => {
  assert.deepEqual(NOT_ASKS.filter((s) => isUserAsk(s)), [], "false asks");
});

test('the table is big enough', () => {
  assert.ok(ASKS.length + NOT_ASKS.length >= 60);
});

test('findUserAsks picks the sentence out of a reply, skipping code and quotes', () => {
  const reply = [
    'The report export tool is finished, apart from a live run.',
    "It now only brings in notes from 0113 onward, and it's waiting on you to add the source in Helm.",
    '',
    '```',
    'you need to run this inside the block',
    '```',
    '> You need to do this (quoted from the user)',
    'Say if you want it changed.',
  ].join('\n');
  assert.deepEqual(findUserAsks(reply), ["It now only brings in notes from 0113 onward, and it's waiting on you to add the source in Helm."]);
  assert.deepEqual(findUserAsks(''), []);
});
