import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-05T12:00:00Z';
const COPIED = { at: AT, url: 'https://claude.ai/artifact/Copied1', title: 'Sprint review', dir: '/state/artifacts/Copied1', previewToken: 'pv-1', hidden: false };
const BACKFILLED = { at: AT, url: 'https://claude.ai/code/artifact/Back-2', title: 'Old readout', hidden: false };

function snapshot(artifacts, shell = 'plugin') {
  return {
    generatedAt: AT,
    shell,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts,
    matrix: { available: false, error: 'not needed here' },
  };
}

async function artifactsPage(...artifacts) {
  return shownIn('plugin', artifacts);
}

async function shownIn(shell, artifacts) {
  const posts = [];
  const page = await openPage({
    respond(path, init) {
      if (init?.method !== 'POST') return null;
      posts.push([path, JSON.parse(init.body)]);
      return { ok: true, text: 'Opened in your browser' };
    },
  });
  page.show(snapshot(artifacts, shell), 'artifacts');
  return Object.assign(page, { posts });
}

const rowFor = (page, title) => page.$$('#main .row').find((r) => r.querySelector('.title').textContent === title);
const buttons = (row) => row.querySelectorAll('button').map((b) => b.textContent);
const press = (row, label) => row.querySelectorAll('button').find((b) => b.textContent === label).click();

test('an artifact with a copy offers Preview and Copy link, and no way to Orca', async () => {
  const page = await artifactsPage(COPIED);
  assert.deepEqual(buttons(rowFor(page, 'Sprint review')), ['Preview', 'Copy link', 'Hide']);
  assert.equal(page.errors.length, 0, page.errors.join('\n'));
});

test('Preview opens the copy inline in a frame sandboxed to scripts only, addressed by the preview token alone', async () => {
  const page = await artifactsPage(COPIED);
  press(rowFor(page, 'Sprint review'), 'Preview');
  const frame = rowFor(page, 'Sprint review').querySelector('.preview iframe');
  assert.ok(frame);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.getAttribute('src'), '/preview/Copied1/pv-1/index.html?v=2026-11-05T12%3A00%3A00Z');
  assert.doesNotMatch(frame.getAttribute('src'), /test/);
  assert.equal(rowFor(page, 'Sprint review').querySelector('button[aria-expanded]').getAttribute('aria-expanded'), 'true');
});

test('a refresh keeps the open preview\'s frame and the height it was dragged to, and Close preview drops it', async () => {
  const page = await artifactsPage(COPIED);
  press(rowFor(page, 'Sprint review'), 'Preview');
  const first = page.$('.preview iframe');
  page.$('.preview').style.height = '312px';
  page.run('render()');
  assert.equal(page.$('.preview iframe'), first);
  assert.equal(page.$('.preview').style.height, '312px');
  press(rowFor(page, 'Sprint review'), 'Close preview');
  assert.equal(page.$('.preview iframe'), null);
  press(rowFor(page, 'Sprint review'), 'Preview');
  assert.notEqual(page.$('.preview iframe'), first);
});

test('a republish loads the new copy in a fresh frame, at the height the old one was dragged to', async () => {
  const page = await artifactsPage(COPIED);
  press(rowFor(page, 'Sprint review'), 'Preview');
  const first = page.$('.preview iframe');
  page.$('.preview').style.height = '312px';
  page.show(snapshot([{ ...COPIED, at: '2026-11-06T09:36:09Z' }]), 'artifacts');
  assert.notEqual(page.$('.preview iframe'), first);
  assert.equal(page.$('.preview iframe').getAttribute('src'), '/preview/Copied1/pv-1/index.html?v=2026-11-06T09%3A36%3A09Z');
  assert.equal(page.$('.preview').style.height, '312px');
  assert.equal(page.$$('iframe').length, 1);
});

test('a republish that lands while the kept frame is being moved across leaves no old frame behind', async () => {
  const page = await artifactsPage(COPIED);
  const proto = Object.getPrototypeOf(page.document.body);
  proto.moveBefore = function (node) { this.append(node); };
  try {
    press(rowFor(page, 'Sprint review'), 'Preview');
    page.run(`render(); state.artifacts[0].at = '2026-11-06T09:36:09Z'; render();`);
    await page.settle(0);
    assert.deepEqual(page.$$('iframe').map((f) => f.getAttribute('src')), ['/preview/Copied1/pv-1/index.html?v=2026-11-06T09%3A36%3A09Z']);
    assert.ok(page.$('.preview iframe'));
  } finally {
    delete proto.moveBefore;
  }
});

test('an artifact with no copy keeps Copy link and opens in your browser only as a secondary', async () => {
  const page = await artifactsPage(BACKFILLED);
  const row = rowFor(page, 'Old readout');
  assert.deepEqual(buttons(row), ['Open in your browser', 'Copy link', 'Hide']);
  assert.equal(row.querySelectorAll('button')[0].className, '');
  assert.equal(row.querySelector('.preview'), null);
});

test('a copy the worker cannot serve yet says how to preview it, and falls back to your browser', async () => {
  const page = await artifactsPage({ ...COPIED, previewToken: undefined });
  const row = rowFor(page, 'Sprint review');
  assert.equal(buttons(row)[0], 'Open in your browser');
  assert.match(row.querySelector('.meta').textContent, /restart Underlings to preview it here/);
});

test('every frame on the page is sandboxed to scripts only, never same-origin, popups or top navigation', async () => {
  const dir = new URL('./', import.meta.url);
  const sources = await Promise.all((await readdir(dir)).filter((n) => n.endsWith('.js')).map((n) => readFile(new URL(n, dir), 'utf8')));
  const frames = sources.flatMap((s) => [...s.matchAll(/el\(\s*'iframe'\s*,\s*\{([^}]*)\}/g)].map((m) => m[1]));
  assert.ok(frames.length > 0);
  for (const attrs of frames) assert.match(attrs, /\bsandbox: 'allow-scripts'/);
  assert.doesNotMatch(sources.join('\n'), /allow-same-origin|allow-top-navigation|allow-popups/);
});

test('in the app, Open shows the live artifact in the app\'s window, and its kept copy opens in one too', async () => {
  const page = await shownIn('app', [COPIED, BACKFILLED]);
  const row = rowFor(page, 'Sprint review');
  assert.deepEqual(buttons(row), ['Open', 'Preview', 'Open copy in a window', 'Copy link', 'Hide']);
  assert.equal(row.querySelectorAll('button')[0].className, 'primary');
  assert.deepEqual(buttons(rowFor(page, 'Old readout')), ['Open', 'Copy link', 'Hide']);
  press(row, 'Open');
  press(row, 'Open copy in a window');
  press(rowFor(page, 'Old readout'), 'Open');
  await page.settle(0);
  assert.deepEqual(page.posts, [
    ['/api/artifacts/window', { url: COPIED.url, copy: false }],
    ['/api/artifacts/window', { url: COPIED.url, copy: true }],
    ['/api/artifacts/window', { url: BACKFILLED.url, copy: false }],
  ]);
  press(row, 'Preview');
  assert.ok(rowFor(page, 'Sprint review').querySelector('.preview iframe'), 'the inline preview stays');
});

test('in the plugin, the live artifact opens in your browser and no window is asked for', async () => {
  const page = await artifactsPage(BACKFILLED);
  press(rowFor(page, 'Old readout'), 'Open in your browser');
  await page.settle(0);
  assert.deepEqual(page.posts, [['/api/open', { url: BACKFILLED.url }]]);
});

test('a window the worker cannot open says why', async () => {
  const page = await openPage({ respond: () => null });
  page.show(snapshot([COPIED], 'app'), 'artifacts');
  press(rowFor(page, 'Sprint review'), 'Open');
  await page.settle(0);
  assert.equal(page.$('#toast').className, 'toast bad');
  assert.match(page.$('#toast').textContent, /not stubbed: \/api\/artifacts\/window/);
});
