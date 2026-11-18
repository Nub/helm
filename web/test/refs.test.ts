// Table tests for the reference parser and the markdown that uses it. Run: node --test web/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainRefs, refIds, splitRefs } from '../src/refs.ts';
import type { ChipEnv, RefInfo } from '../src/refs.ts';
import { renderMarkdown } from '../src/markdown.ts';

const T = 'task_0123456789';
const D = 'disc_aaaaaaaaaa';
const known: Record<string, RefInfo> = {
  [T]: { id: T, kind: 'task', title: 'Overview rework', state: 'active', project_id: 'prj_1', project_name: 'Helm', href: '#/p/prj_1/tasks/task_0123456789', thumb: null },
  // An alias: the old discussion id resolves to the task it became.
  [D]: { id: D, kind: 'task', title: 'Became a task', state: 'done', project_id: 'prj_1', project_name: 'Helm', href: '#/p/prj_1/tasks/task_bbbbbbbbbb', thumb: null },
  pv_cccccccccc: { id: 'pv_cccccccccc', kind: 'preview', title: 'Menu <fixed>', state: '', project_id: 'prj_2', project_name: 'Other & Co', href: '#/p/prj_2/previews/pv_cccccccccc', thumb: '/artifacts/x.png' },
};
const env: ChipEnv = { resolve: (id) => (id in known ? known[id] : id === 'doc_dddddddddd' ? undefined : null), projectId: 'prj_1', icon: (n) => `<i data-icon="${n}"></i>` };
const md = (s: string) => renderMarkdown(s, env);
const chips = (html: string) => [...html.matchAll(/class="ref [^"]*"/g)].length;

const split: [string, string, unknown][] = [
  ['explicit', `see [[${T}]].`, ['see ', { id: T, explicit: true }, '.']],
  ['label', `[[${T}|the rework]]`, [{ id: T, label: 'the rework', explicit: true }]],
  ['page', '[[page:previews]]', [{ id: 'page:previews', explicit: true }]],
  ['bare with punctuation', `(${T}), ${D}!`, ['(', { id: T, explicit: false }, '), ', { id: D, explicit: false }, '!']],
  ['not inside a word', `x${T} ${T}x`, [`x${T} ${T}x`]],
  ['not in a path or query', `/p/prj/tasks/${T} ?id=${T} #${T}`, [`/p/prj/tasks/${T} ?id=${T} #${T}`]],
  ['wrong length is text', 'task_0123', ['task_0123']],
  ['unknown prefix is text', '[[foo_0123456789]]', ['[[foo_0123456789]]']],
  ['unknown page is text', '[[page:nope]]', ['[[page:nope]]']],
];
for (const [name, input, want] of split) test(`splitRefs: ${name}`, () => assert.deepEqual(splitRefs(input), want));

test('refIds: unique, pages left out', () => assert.deepEqual(refIds(`[[${T}]] ${T} [[page:spec]] ${D}`), [T, D]));

const render: [string, string, (html: string) => void][] = [
  ['chip with title and state', `Where: [[${T}]]`, (h) => {
    assert.match(h, /<a class="ref ref-task st-active" href="#\/p\/prj_1\/tasks\/task_0123456789"/);
    assert.match(h, /<span class="ref-t">Overview rework<\/span><span class="ref-s">Active<\/span>/);
    assert.doesNotMatch(h, /\[\[/);
  }],
  ['code span untouched', `\`${T}\` and \`[[${T}]]\``, (h) => assert.equal(chips(h), 0)],
  ['code block untouched', `\`\`\`\n${T}\n[[${T}]]\n\`\`\``, (h) => assert.equal(chips(h), 0)],
  ['bare id in prose', `Done in ${T}.`, (h) => assert.equal(chips(h), 1)],
  ['id inside an autolinked URL not double-linked', `http://host/#/p/prj_1/tasks/${T}`, (h) => { assert.equal(chips(h), 0); assert.match(h, /<a href="http:\/\/host/); }],
  ['markdown link to an app route kept', `[open it](#/p/prj_1/tasks/${T})`, (h) => { assert.equal(chips(h), 0); assert.match(h, /<a href="#\/p\/prj_1\/tasks\/task_0123456789">open it<\/a>/); }],
  ['no chip inside a link label', `[see ${T}](https://x.y)`, (h) => assert.equal(chips(h), 0)],
  ['alias resolves to its task', `[[${D}]]`, (h) => assert.match(h, /href="#\/p\/prj_1\/tasks\/task_bbbbbbbbbb".*Became a task.*Done/)],
  ['unknown id degrades to plain text', '[[task_ffffffffff]]', (h) => assert.match(h, /<span class="ref ref-missing" title="Not found in Helm">task_ffffffffff<\/span>/)],
  ['loading shows the kind, not the id', '[[doc_dddddddddd]]', (h) => { assert.match(h, /ref-loading/); assert.match(h, /Spec entry/); }],
  ['other project: name shown, titles escaped', '[[pv_cccccccccc]]', (h) => {
    assert.match(h, /Menu &lt;fixed&gt;/);
    assert.match(h, /<span class="ref-p">Other &amp; Co<\/span>/);
    assert.match(h, /<img class="ref-img" src="\/artifacts\/x.png"/);
  }],
  ['label with markup is escaped once', `[[${T}|a & b]]`, (h) => assert.match(h, /<span class="ref-t">a &amp; b<\/span>/)],
  ['page link uses the current project', '[[page:previews]] [[page:helm]]', (h) => { assert.match(h, /href="#\/p\/prj_1\/previews"/); assert.match(h, /href="#\/helm"/); }],
  ['emphasis around a reference', `**[[${T}]]** and _${T}_`, (h) => assert.equal(chips(h), 2)],
  ['punctuation after a chip stays with it', `see [[${T}]]. Next`, (h) => assert.match(h, /<span class="ref-wrap"><a [^]*<\/a>\.<\/span> Next/)],
  ['eight in one paragraph', Array(8).fill(`[[${T}]]`).join(', '), (h) => assert.equal(chips(h), 8)],
];
for (const [name, input, check] of render) test(`renderMarkdown: ${name}`, () => check(md(input)));

test('no env: plain markdown', () => assert.equal(chips(renderMarkdown(`[[${T}]]`, null)), 0));

test('plainRefs: titles, labels, pages', () => {
  assert.equal(plainRefs(`Director: see [[${T}]] and [[${T}|this]] on [[page:spec]]; ${D}.`, env.resolve), 'Director: see Overview rework and this on Spec; Became a task.');
  assert.equal(plainRefs('gone [[task_ffffffffff]]', env.resolve), 'gone task_ffffffffff');
});
