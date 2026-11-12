import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMPLEXITY_BUDGET,
  costOf,
  firstFor,
  isComplexityError,
  planBatches,
  splitBatch,
} from './batching.js';
import type { RepoSpec } from './config.js';

const repo = (path: string, openCount?: number): RepoSpec =>
  openCount === undefined ? { path, label: path } : { path, label: path, openCount };

function assertWithinBudget(repos: RepoSpec[]): ReturnType<typeof planBatches> {
  const batches = planBatches(repos);
  for (const batch of batches) {
    const cost = costOf(batch.first) * batch.repos.length;
    assert.ok(
      cost <= COMPLEXITY_BUDGET,
      `a batch of ${batch.repos.length} at first=${batch.first} costs ${cost}`,
    );
  }
  return batches;
}

test('every repo lands in exactly one batch, and none is dropped', () => {
  const repos = Array.from({ length: 95 }, (_, i) => repo(`g/r${i}`, i % 7));
  const batches = assertWithinBudget(repos);
  const packed = batches.flatMap((b) => b.repos.map((r) => r.path));
  assert.equal(packed.length, repos.length);
  assert.equal(new Set(packed).size, repos.length, 'no repo packed twice');
});

test('no batch can exceed the complexity budget, whatever the sizes', () => {
  assertWithinBudget([repo('g/huge', 100), repo('g/big', 60), repo('g/small', 1)]);
  assertWithinBudget(Array.from({ length: 40 }, () => repo('g/x', 100)));
  assertWithinBudget(Array.from({ length: 40 }, () => repo('g/x', 0)));
});

test('small repos pack together instead of going three to a query', () => {
  // This is the whole point: 95 quiet repos should not cost 32 requests.
  const repos = Array.from({ length: 95 }, (_, i) => repo(`g/r${i}`, 2));
  const batches = planBatches(repos);
  assert.ok(batches.length < 24, `${batches.length} batches, expected well under 32`);
  assert.ok(
    batches.every((b) => b.repos.length > 3) || batches.length <= 20,
    'quiet repos should share a query rather than going three at a time',
  );
});

test('a busy repo still gets asked for all its merge requests', () => {
  const batches = planBatches([repo('g/busy', 60), repo('g/quiet', 1)]);
  const busy = batches.find((b) => b.repos.some((r) => r.path === 'g/busy'));
  assert.ok((busy?.first ?? 0) >= 60, 'asking for fewer would hide MRs it has');
});

test('a repo whose count is unknown is assumed busy rather than truncated', () => {
  assert.equal(firstFor(repo('g/new')), 100, 'an unknown count must not silently drop MRs');
  assert.ok(firstFor(repo('g/quiet', 1)) >= 10, 'and tiny repos keep some headroom');
});

test('headroom covers a repo that gained MRs since discovery', () => {
  assert.ok(firstFor(repo('g/r', 20)) > 20, 'a repo at its exact count would truncate');
});

test('an empty repo set plans no queries at all', () => {
  assert.deepEqual(planBatches([]), []);
});

test('a refused batch halves into two that between them hold everyone', () => {
  const batch = { repos: [repo('a'), repo('b'), repo('c'), repo('d'), repo('e')], first: 40 };
  const halves = splitBatch(batch);
  assert.equal(halves.length, 2);
  assert.deepEqual(
    halves.flatMap((h) => h.repos.map((r) => r.path)),
    ['a', 'b', 'c', 'd', 'e'],
    'splitting must not lose a repo',
  );
  for (const half of halves) assert.equal(half.first, 40, 'each half still asks the same question');
});

test('a single-repo batch cannot be split, so the caller stops rather than looping', () => {
  assert.deepEqual(splitBatch({ repos: [repo('only')], first: 40 }), []);
  assert.deepEqual(splitBatch({ repos: [], first: 40 }), []);
});

test('only a complexity refusal triggers a split, not any old failure', () => {
  assert.equal(isComplexityError('Query has complexity of 258, which exceeds max complexity of 250'), true);
  assert.equal(isComplexityError('GitLab GraphQL 429 Too Many Requests'), false);
  assert.equal(isComplexityError('GitLab GraphQL 500 Internal Server Error'), false);
});

test('the estimate matches what GitLab actually charged, at the points we measured', () => {
  // 6 projects at first=20 was refused at 258; 4 at first=65 and 6 at first=11 passed.
  assert.ok(costOf(20) * 6 > 250, 'the plan must not propose the batch that was refused');
  assert.ok(costOf(65) * 4 <= 250, 'and must still allow the one that passed');
  assert.ok(costOf(11) * 6 <= 250);
});
