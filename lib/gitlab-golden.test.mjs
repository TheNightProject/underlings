// To change a baseline on purpose: UNDERLINGS_GOLDEN=update npm run test:golden, then read the diff before committing it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselineTests, goldenRun } from './fixtures/gitlab-golden/run.mjs';

const run = await goldenRun();
baselineTests(run);

test('with GitHub off the session asks it nothing and never runs gh, though a GitHub token is in the environment', () => {
  assert.ok(process.env.GITHUB_TOKEN);
  assert.deepEqual(run.github.requests, []);
  assert.deepEqual(run.calls.filter(([cmd]) => cmd === 'gh'), []);
});
