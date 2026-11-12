import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPeople, levelForMr, parsePeople, peopleRules } from './people.js';
import { ME, mr } from './testkit.js';

test('the default row gives shadow to an MR that asks you, is not a draft and is not approved, whose author has no row', () => {
  const rules = peopleRules('*:shadow');
  assert.equal(levelForMr(mr({ author: 'judy' }), ME, rules), 'shadow');
  assert.equal(levelForMr(mr({ author: 'judy', draft: true }), ME, rules), null, 'a draft');
  assert.equal(levelForMr(mr({ author: 'judy', approvedBy: [ME] }), ME, rules), null, 'one you approved');
  assert.equal(levelForMr(mr({ author: 'judy', reviewers: ['alice'] }), ME, rules), null, 'one that does not ask you');
});

test('reviewing on request is only ever shadow, whatever level the default row names', () => {
  assert.equal(peopleRules('*:comments').onRequest, 'shadow');
  assert.equal(peopleRules('*:verdict').onRequest, 'shadow');
  assert.equal(peopleRules('*:off').onRequest, null);
  assert.equal(peopleRules('').onRequest, null);
});

test('a row of their own wins over the default, and off means never', () => {
  const rules = peopleRules('*:shadow, heidi:comments, judy:off');
  assert.equal(levelForMr(mr({ author: 'heidi' }), ME, rules), 'comments');
  assert.equal(levelForMr(mr({ author: 'judy' }), ME, rules), null);
  assert.equal(levelForMr(mr({ author: 'Judy' }), ME, rules), null, 'whatever the case GitLab gives');
});

test('a bot, a service account and your own MR get nothing from the default row', () => {
  const rules = peopleRules('*:shadow');
  assert.equal(levelForMr(mr({ author: 'project_1001_bot_abc' }), ME, rules), null);
  assert.equal(levelForMr(mr({ author: 'renovate-bot' }), ME, rules), null);
  assert.equal(levelForMr(mr({ author: ME }), ME, rules), null);
});

test('parsePeople still ignores the default row and the off entries, as an older build would', () => {
  assert.deepEqual(parsePeople('*:shadow, heidi:verdict, judy:off'), [{ username: 'heidi', level: 'verdict' }]);
});

test('the setting is written with the default first and the off entries last, and reads back the same', () => {
  const rules = peopleRules('judy:off, heidi:comments, *:shadow');
  const text = formatPeople(rules.people, rules);
  assert.equal(text, '*:shadow, heidi:comments, judy:off');
  assert.deepEqual(peopleRules(text), rules);
});
