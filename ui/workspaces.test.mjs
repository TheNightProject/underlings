import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-05T12:00:00Z';
const DEFAULT = { id: 'default', name: 'Work', colour: 'blue', account: '1', port: 47321, count: 2, state: 'running', active: true, here: true };
const SIDE = { id: 'side-project', name: 'Side project', colour: 'rose', account: '2', port: 47322, count: 3, state: 'running', active: false, here: false };
const OSS = { id: 'oss', name: 'Open source', colour: 'teal', account: '', port: 47323, count: 0, state: 'starting', active: false, here: false };

function snapshot(workspaces) {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts: [],
    matrix: { available: false, error: 'not needed here' },
    workspaces: workspaces && { workspaces },
  };
}

async function workspacesPage(workspaces, hash = 'overview') {
  const posts = [];
  const page = await openPage({
    respond(path, init) {
      if (init?.method !== 'POST') return null;
      posts.push([path, JSON.parse(init.body)]);
      return { ok: true, text: 'Done' };
    },
  });
  page.show(snapshot(workspaces), hash);
  return Object.assign(page, { posts });
}

const rowFor = (page, id) => page.$(`.workspace-row[data-id="${id}"]`);

test('with one workspace there is no switcher, and a worker without the app has no Workspaces at all', async () => {
  const one = await workspacesPage([DEFAULT]);
  assert.equal(one.$('#switcher').hidden, true);
  assert.equal(one.$('.navlink[href="#workspaces"]').hidden, false, 'Workspaces is where a second one is made');
  const headless = await workspacesPage(null);
  assert.equal(headless.$('.navlink[href="#workspaces"]').hidden, true);
});

test('the switcher names this workspace, counts what waits elsewhere, and switches to the one picked', async () => {
  const page = await workspacesPage([DEFAULT, SIDE, OSS]);
  const button = page.$('#switcher-button');
  assert.equal(page.$('#switcher').hidden, false);
  assert.equal(button.querySelector('.ws-name').textContent, 'Work');
  assert.equal(button.querySelector('.count').textContent, '3', 'only the other workspaces\' count');
  assert.doesNotMatch(page.$('#switcher').textContent, /null/);
  button.click();
  const items = page.$$('.switcher-item[role="menuitemradio"]');
  assert.deepEqual(items.map((i) => [i.dataset.id, i.getAttribute('aria-checked')]), [['default', 'true'], ['side-project', 'false'], ['oss', 'false']]);
  assert.match(items[2].textContent, /starting/);
  items[1].click();
  await page.settle(0);
  assert.deepEqual(page.posts, [['/api/workspaces/switch', { id: 'side-project' }]]);
  assert.equal(page.$('.switcher-menu'), null, 'the menu closes');
});

test('the Workspaces page lists each with its account and port, renames, recolours and removes, and never offers to remove Default', async () => {
  const page = await workspacesPage([DEFAULT, SIDE], 'workspaces');
  assert.match(rowFor(page, 'default').textContent, /This one/);
  assert.match(rowFor(page, 'side-project').textContent, /cswap account 2 · port 47322 · workspaces\/side-project/);
  assert.equal(page.document.getElementById('g-ws-remove:default'), null);
  assert.ok(page.document.getElementById('g-ws-remove:side-project'));

  const name = page.$('#ws-name-side-project');
  name.value = 'Weekend';
  page.fire(name, 'input');
  page.$('#ws-save-side-project').click();
  await page.settle(0);
  page.$('#ws-colour-side-project-violet').click();
  await page.settle(0);
  page.document.getElementById('g-ws-remove:side-project').click();
  assert.deepEqual(page.posts.length, 2, 'the first click only asks to be sure');
  page.document.getElementById('g-ws-remove:side-project').click();
  await page.settle(0);
  assert.deepEqual(page.posts, [
    ['/api/workspaces/update', { id: 'side-project', name: 'Weekend', account: '2' }],
    ['/api/workspaces/update', { id: 'side-project', colour: 'violet' }],
    ['/api/workspaces/remove', { id: 'side-project' }],
  ]);
});

test('a new workspace is made with its name, account, colour and whose settings it copies', async () => {
  const page = await workspacesPage([DEFAULT], 'workspaces');
  const type = (id, value) => {
    const field = page.$('#' + id);
    field.value = value;
    page.fire(field, 'input');
  };
  type('ws-new-name', 'Side project');
  type('ws-new-account', '2');
  page.$('#ws-copy-default').click();
  page.$('#ws-create').click();
  await page.settle(0);
  assert.deepEqual(page.posts, [['/api/workspaces/create', { name: 'Side project', account: '2', copyFrom: 'default' }]]);
  assert.equal(page.run('ui.workspaces.create.name'), '', 'the form empties once it is made');
});

test('Jump to offers every other workspace, with what waits there', async () => {
  const page = await workspacesPage([DEFAULT, SIDE]);
  const entries = JSON.parse(page.run('JSON.stringify(paletteEntries({}).filter((x) => x.group === "Workspaces").map((x) => [x.label, x.detail]))'));
  assert.deepEqual(entries, [['Switch to Side project', '3 waiting on you · cswap account 2']]);
});
