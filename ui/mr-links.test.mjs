import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const KEY = 'acme/engine!7';
const AT = '2026-11-05T12:00:00Z';

const row = (webUrl) => ({
  key: KEY, iid: 7, repo: 'engine', title: 'Make the engine faster', webUrl, author: 'ivan', reviewers: ['frank'], approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: null, updatedAt: AT,
  unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'feat/7', sha: 'aaa111', agentHandle: null, watch: null, flags: {}, phase: 'open', count: 0, mood: 'quiet', verdict: null, agent: null, level: null,
});

async function open(host, webUrl) {
  const page = await openPage({ respond: () => null });
  page.show({
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false, ...(host ? { gitlabHost: host } : {}),
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [row(webUrl)] }, fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  }, 'merge-requests');
  await page.settle(60);
  return page;
}

test('a link to a merge request opens it here when it is on the configured GitLab host, not only on gitlab.com', async () => {
  const page = await open('https://git.acme.test', 'https://git.acme.test/acme/engine/-/merge_requests/7');
  assert.equal(page.run("mrKeyOf('https://git.acme.test/acme/engine/-/merge_requests/7')"), KEY);
  assert.equal(page.run("mrKeyOf('https://git.acme.test/acme/engine/-/merge_requests/7/diffs#note_1')"), KEY);
  assert.equal(page.run("mrKeyOf('https://gitlab.com/acme/engine/-/merge_requests/7')"), null, 'gitlab.com is not the configured host');
  assert.equal(page.run("mrKeyOf('https://git.acme.test/acme/engine/-/merge_requests/8')"), null, 'and only an MR in the list opens');
});

test('with no host set it is gitlab.com, as it always was', async () => {
  const page = await open(null, 'https://gitlab.com/acme/engine/-/merge_requests/7');
  assert.equal(page.run("mrKeyOf('https://gitlab.com/acme/engine/-/merge_requests/7')"), KEY);
  assert.equal(page.run("mrKeyOf('https://git.acme.test/acme/engine/-/merge_requests/7')"), null);
});
