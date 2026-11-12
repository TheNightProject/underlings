// The GitLab baselines again, with GitHub switched on against a GitHub that has nothing for you. This run never writes them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baselineTests, goldenRun } from './fixtures/gitlab-golden/run.mjs';

const run = await goldenRun({ github: true });
baselineTests(run);

test('GitHub was really on: it was asked who you are and for what involves you, with its own token and only at its own host', () => {
  const asked = run.github.requests;
  assert.ok(asked.some((r) => r.op === 'Viewer' || r.op === 'Involved'));
  assert.ok(asked.length > 0 && asked.every((r) => r.bearer === run.GITHUB_TOKEN && r.path === '/graphql'));
  assert.deepEqual(run.calls.filter(([cmd]) => cmd === 'gh'), [], 'a token in the environment means gh is not asked');
});

test('GitHub having nothing for you adds nothing to the GitLab pages: no GitHub row, no GitHub wording', () => {
  const text = JSON.stringify(run.got.page);
  assert.equal(/github/i.test(text), false);
});
