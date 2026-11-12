import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queueInput } from './queueinput.js';

const base = { projectPath: 'acme/engine', projectId: 1001, iid: 621, body: 'a finding' };

test('a finding comes through as it always did', () => {
  const out = queueInput({ ...base, severity: 'minor', webUrl: 'u', diffHunk: '+x' }, 0);
  assert.equal(out.severity, 'MINOR', 'case does not matter');
  assert.equal(out.createdBy, 'ws:mr-review');
  assert.equal(out.kind, undefined, 'still a plain finding');
  assert.throws(() => queueInput({ ...base }, 3), /queue item 3: missing severity/);
  assert.throws(() => queueInput({ ...base, severity: 'BLOCKER' }, 0), /unknown severity/);
});

test('nothing an agent sends can mark an item to send itself', () => {
  const out = queueInput(
    { ...base, severity: 'NIT', auto: { level: 'verdict', sendAt: '2000-01-01' }, status: 'posted', verdict: 'approve', id: 'mine' },
    0,
  ) as Record<string, unknown>;
  for (const field of ['auto', 'status', 'verdict', 'id']) assert.equal(out[field], undefined, field);
});

test('an agent cannot queue a verdict, or anything else it invents', () => {
  assert.throws(() => queueInput({ ...base, severity: 'MINOR', kind: 'verdict', verdict: 'approve' }, 0), /cannot queue a verdict/);
  assert.throws(() => queueInput({ ...base, severity: 'MINOR', kind: 'settings' }, 0), /cannot queue a settings/);
});

test('a reply names its thread and one of three outcomes', () => {
  const out = queueInput({ ...base, kind: 'reply', replyTo: 'd1', outcome: 'fixed' }, 0);
  assert.equal(out.kind, 'reply');
  assert.equal(out.replyTo, 'd1');
  assert.equal(out.severity, 'MINOR', 'a reply needs no severity');
  assert.throws(() => queueInput({ ...base, kind: 'reply', outcome: 'fixed' }, 0), /needs replyTo/);
  assert.throws(() => queueInput({ ...base, kind: 'reply', replyTo: 'd1', outcome: 'resolve-and-approve' }, 0), /outcome must be/);
});
