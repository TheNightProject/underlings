import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ATTRIBUTION, AUTO_FOOTER } from './config.js';
import { plainBody, renderCommentBody } from './comment.js';
import type { QueuedComment } from './types.js';

const comment = (over: Partial<QueuedComment> = {}): QueuedComment => ({
  id: 'c', projectPath: 'a/b', projectId: 1, iid: 2, webUrl: '',
  severity: 'MAJOR', body: 'this breaks on an empty list',
  createdAt: '', createdBy: 'you', status: 'pending',
  ...over,
});

test('the severity is not said twice when the body already opens with it', () => {
  const body = renderCommentBody(comment({ body: 'MAJOR: this breaks on an empty list' }));
  assert.ok(body.startsWith('**MAJOR** this breaks'), body);
  assert.equal(body.match(/MAJOR/g)?.length, 1);
});

test('a body with no tag of its own still gets one', () => {
  assert.ok(renderCommentBody(comment()).startsWith('**MAJOR** this breaks on an empty list'));
});

test('the trailer appears once, whether or not the body carried it', () => {
  for (const body of ['x', `x\n\n${ATTRIBUTION}`]) {
    const out = renderCommentBody(comment({ body }));
    assert.equal(out.split(ATTRIBUTION).length - 1, 1, out);
    assert.ok(out.endsWith(`\n\n${ATTRIBUTION}`), 'and always at the end');
  }
});

test('a severity word inside the sentence is left alone', () => {
  const out = renderCommentBody(comment({ body: 'the MAJOR version is wrong here' }));
  assert.ok(out.startsWith('**MAJOR** the MAJOR version is wrong here'), out);
});


test('the finding on its own is what the inline view shows', () => {
  assert.equal(plainBody(comment({ body: 'MAJOR: it breaks' })), 'it breaks');
  assert.equal(plainBody(comment({ body: `x\n\n${ATTRIBUTION}` })), 'x');
  assert.equal(plainBody(comment({ body: 'plain' })), 'plain');
});

test('the footers are the ones Settings gives, and a blank one posts none', () => {
  const footers = { posted: '_Checked by hand._', auto: '_Posted unread._' };
  assert.ok(renderCommentBody(comment(), { footers }).endsWith('\n\n_Checked by hand._'));
  assert.ok(renderCommentBody(comment(), { automatic: true, footer: true, footers }).endsWith('\n\n_Posted unread._'));
  assert.equal(renderCommentBody(comment(), { footers: { ...footers, posted: '' } }), '**MAJOR** this breaks on an empty list');
  assert.equal(plainBody(comment({ body: `x\n\n_Checked by hand._` }), footers), 'x');
  assert.equal(plainBody(comment({ body: `x\n\n${AUTO_FOOTER}` }), footers), 'x', 'the old wording comes off too');
  const short = { posted: 'Thanks', auto: '' };
  assert.equal(renderCommentBody(comment({ body: 'Thanks for the tests, but this breaks' }), { footers: short }), '**MAJOR** Thanks for the tests, but this breaks\n\nThanks', 'a footer of a common word comes off only at the end');
});
