import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-11T09:00:00Z';
const CODE_FOLDER = { id: 'workspace', state: 'fail', title: 'Code folder', detail: 'Not set.', root: '' };

async function setupPage({ shell, chosen }) {
  const posts = [];
  const page = await openPage({
    respond: (path, init) => {
      if (path === '/api/setup') return { done: false, checks: [CODE_FOLDER] };
      if (init?.method !== 'POST') return null;
      posts.push([path, JSON.parse(init.body)]);
      return path === '/api/choose-folder' ? { chosen } : { ok: true, text: 'Saved' };
    },
  });
  page.show({ generatedAt: AT, shell, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [], matrix: { available: false, error: 'not needed here' } }, 'setup');
  await page.settle(100);
  return { page, posts };
}

test('in the app the Code folder is picked with the Mac\'s own folder picker, and the folder picked is saved', async () => {
  const { page, posts } = await setupPage({ shell: 'app', chosen: '/Users/dev/code' });
  page.$('#setup-root-choose').click();
  await page.settle(50);
  assert.deepEqual(posts, [['/api/choose-folder', { from: '' }], ['/api/matrix/settings', { patch: { workspaceRoot: '/Users/dev/code' } }]]);
});

test('closing the picker without a folder saves nothing', async () => {
  const { page, posts } = await setupPage({ shell: 'app', chosen: null });
  page.$('#setup-root-choose').click();
  await page.settle(50);
  assert.deepEqual(posts, [['/api/choose-folder', { from: '' }]]);
});

test('without the app there is no picker, only the field to type in', async () => {
  const { page } = await setupPage({ shell: 'headless', chosen: null });
  assert.equal(page.$('#setup-root-choose'), null);
  assert.ok(page.$('#setup-root'));
});
