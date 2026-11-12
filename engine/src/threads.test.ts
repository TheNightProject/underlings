import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Discussion, NotePosition } from './data/gitlab.js';
import { awaitsYou, isQueued, panelItems, threadAsComment , outdated } from './threads.js';
import type { Mr, QueuedComment } from './types.js';

const ME = 'you';

const MR = {
  projectPath: 'acme/engine',
  projectId: 1001,
  iid: 792,
  webUrl: 'https://gitlab.example/acme/engine/-/merge_requests/792',
} as Mr;

function discussion(id: string, notes: [string, string][], resolved = false): Discussion {
  return {
    id,
    resolved,
    notes: notes.map(([author, body]) => ({ author, body, createdAt: '', system: false })),
  };
}

function queued(id: string, discussionId?: string): QueuedComment {
  return {
    id,
    projectPath: MR.projectPath,
    projectId: MR.projectId,
    iid: MR.iid,
    webUrl: MR.webUrl,
    severity: 'MAJOR',
    body: 'MAJOR: something',
    createdAt: '',
    createdBy: ME,
    status: discussionId ? 'posted' : 'pending',
    ...(discussionId ? { discussionId } : {}),
  };
}

// The shape that prompted this: three queued findings with no replies, and the reply
// sitting on a fourth thread opened by hand, which was therefore never in the queue.
const FINDINGS = [queued('a', '960d62'), queued('b', '35c320'), queued('c', '419471')];
const DISCUSSIONS = [
  discussion('cfa0ce', [
    [ME, 'is this deliberate?'],
    ['ivan', 'good catch, fixed in a1b2c3d'],
  ]),
  discussion('960d62', [[ME, '**MAJOR** MAJOR: `MergeClause` is in neither']]),
  discussion('35c320', [[ME, '**MAJOR** MAJOR: `ShortestPathClause.via_labels`']]),
  discussion('419471', [[ME, '**MINOR** NIT: `_check_placement` already walks']]),
  discussion('other', [['ivan', 'a thread I am not in']]),
];

test('a reply on a thread that never came from the queue still reaches the panel', () => {
  const items = panelItems(FINDINGS, DISCUSSIONS, MR, ME);
  const ids = items.map((c) => c.discussionId);
  assert.ok(ids.includes('cfa0ce'), 'the replied-to thread must be listed');
  assert.equal(items.length, 4, 'three findings plus the one hand-written thread');
  assert.ok(!ids.includes('other'), 'a thread you are not in is none of your business');
});

test('whatever is waiting on you sorts to the top of the panel', () => {
  const items = panelItems(FINDINGS, DISCUSSIONS, MR, ME);
  assert.equal(items[0]?.discussionId, 'cfa0ce', 'the panel is this MR\'s inbox');
});

test('a thread you already answered does not keep claiming the top', () => {
  const answered = DISCUSSIONS.map((d) =>
    d.id === 'cfa0ce'
      ? discussion(d.id, [
          [ME, 'is this deliberate?'],
          ['ivan', 'good catch, fixed in a1b2c3d'],
          [ME, 'no problem'],
        ])
      : d,
  );
  assert.equal(panelItems(FINDINGS, answered, MR, ME)[0]?.discussionId, '960d62');
  assert.equal(awaitsYou(answered[0], ME), false);
  assert.equal(awaitsYou(DISCUSSIONS[0], ME), true);
});

test('a resolved thread is settled, however it ended', () => {
  const resolved = discussion('r', [[ME, 'q'], ['ivan', 'a']], true);
  assert.equal(awaitsYou(resolved, ME), false);
});

test('a queued finding is never listed twice when its thread comes back', () => {
  const items = panelItems(FINDINGS, DISCUSSIONS, MR, ME);
  assert.equal(new Set(items.map((c) => c.discussionId)).size, items.length);
  assert.equal(items.filter((c) => c.discussionId === '960d62').length, 1);
});

test('severity is read back off the posted body, so the panel keeps its colours', () => {
  const read = (body: string): string => threadAsComment(discussion('x', [[ME, body]]), MR).severity;
  assert.equal(read('**MAJOR** MAJOR: the thing'), 'MAJOR');
  assert.equal(read('CRITICAL: breaks'), 'CRITICAL');
  assert.equal(read('nit: lower case still counts'), 'NIT');
  assert.equal(read('just a question I typed'), 'QUESTION', 'an untagged thread still shows');
});

test('a synthesised row is marked as having no queue entry behind it', () => {
  const synthetic = threadAsComment(DISCUSSIONS[0] as Discussion, MR);
  assert.equal(isQueued(synthetic), false, 'discarding it would silently do nothing');
  assert.equal(isQueued(FINDINGS[0]), true);
  assert.equal(isQueued(undefined), false);
});

test('other MRs in the queue are left out of this one\'s panel', () => {
  const elsewhere = { ...queued('z'), iid: 621 };
  const items = panelItems([...FINDINGS, elsewhere], DISCUSSIONS, MR, ME);
  assert.ok(!items.some((c) => c.id === 'z'));
});

test('with no user known, nothing is claimed as yours', () => {
  const items = panelItems(FINDINGS, DISCUSSIONS, MR, undefined);
  assert.equal(items.length, 3, 'only the queue, since "mine" cannot be decided');
});

test('a comment written against an older head has had the code move under it', () => {
  // Authors fix the code far more often than they resolve the thread saying so, and
  // nothing in a resolved flag or a reply count would ever tell you.
  const at = (head: string): NotePosition => ({ new_path: 'a.py', new_line: 4, head_sha: head });
  assert.equal(outdated(at('old'), 'new'), true);
  assert.equal(outdated(at('same'), 'same'), false);
});

test('nothing is claimed when there is nothing to compare', () => {
  assert.equal(outdated(undefined, 'head'), false, 'a general comment has no line to move');
  assert.equal(outdated({ new_path: 'a.py', new_line: 1 }, 'head'), false, 'an old record has no sha');
  assert.equal(outdated({ head_sha: 'x' }, null), false, 'and an unknown head proves nothing');
});

test('an expired finding leaves the panel as a discarded one does, since it was never sent', () => {
  const items = [queued('kept'), { ...queued('gone'), status: 'discarded' as const }, { ...queued('late'), status: 'expired' as const, expiredReason: 'MR merged' as const }];
  assert.deepEqual(panelItems(items, [], MR, ME).map((c) => c.id), ['kept']);
});
