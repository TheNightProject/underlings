import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIONS, act, mergeTables, perform } from './actions.mjs';
import { still } from './engine.mjs';

test('an action name two modules both define is refused when the tables merge', () => {
  const review = () => 'one';
  assert.throws(() => mergeTables({ matrix: { review }, decide: { review } }, 'action'), /action review is defined by both matrix and decide/);
  assert.deepEqual(Object.keys(mergeTables({ a: { x: 1 }, b: undefined, c: { y: 2 } }, 'route')), ['x', 'y']);
});

test('the real modules merge without a clash', () => {
  for (const name of ['review', 'approve', 'hold', 'post', 'post-all', 'discard', 'edit', 'level', 'pause']) assert.equal(typeof ACTIONS[name], 'function', name);
});

test('no action reaches Orca: an agent is focused by opening its drawer, so there is no focus, show or key to send', () => {
  for (const name of ['focus', 'agent-show', 'agent-key', 'agent-send']) assert.equal(ACTIONS[name], undefined, name);
  for (const name of ['agent-reply', 'agent-stop', 'agent-terminal', 'agent-remove', 'move-automation']) assert.equal(typeof ACTIONS[name], 'object', name);
});

test('still() refuses with 409 before the write runs, and a missing expectation is a 400', async () => {
  const writes = [];
  const stale = { verify: ({ expect }) => still(expect, { sha: 'bbb' }, 'the MR head'), run: () => writes.push('wrote') };
  await assert.rejects(perform(stale, { expect: { sha: 'aaa' } }), { status: 409, message: 'the MR head changed since you looked' });
  await assert.rejects(perform(stale, {}), { status: 400, message: 'the page did not send what it saw of the MR head' });
  assert.deepEqual(writes, []);
});

test('what verify read live is what the write uses', async () => {
  const action = { verify: () => ({ projectId: 42 }), run: (payload, live) => `wrote to ${live.projectId}` };
  assert.deepEqual(await perform(action, { projectId: 1 }), { ok: true, text: 'wrote to 42' });
});

test('an unknown action is a 404', async () => {
  await assert.rejects(act('no-such-thing', {}), { status: 404 });
});
