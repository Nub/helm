import './testenv.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unrefInput } from './refs.ts';

test('unrefInput: id parameters unwrapped, free text kept', () => {
  const got = unrefInput({
    task: '[[task_0123456789]]',
    ids: ['[[doc_0123456789|Phone first]]', 'doc_aaaaaaaaaa'],
    changes: [{ id: '[[task_bbbbbbbbbb]]', reason: '[[task_bbbbbbbbbb]]' }],
    body: '[[task_0123456789]]',
    question: '[[disc_0123456789]]',
  });
  assert.deepEqual(got, {
    task: 'task_0123456789',
    ids: ['doc_0123456789', 'doc_aaaaaaaaaa'],
    changes: [{ id: 'task_bbbbbbbbbb', reason: '[[task_bbbbbbbbbb]]' }],
    body: '[[task_0123456789]]',
    question: '[[disc_0123456789]]',
  });
});
