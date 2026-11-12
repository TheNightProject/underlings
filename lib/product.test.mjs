import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { APP_ID, APP_NAME, FOLDER } from './product.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OLD_NAMES = /Control Cent(?:re|er)|TheMatrix|the matrix/i;
const TEST_ONLY = /\.test\.|[/\\]fixtures[/\\]|[/\\]testkit\.|[/\\]testproc\.|[/\\]workerproc\.mjs$/;
const SHIPPED = [['lib', /\.mjs$/], ['ui', /\.(?:js|css)$/], ['engine/src', /\.tsx?$/], ['hooks', /\.mjs$/], ['desktop', /^[^/]+\.(?:mjs|cjs|js|html)$/], ['scripts', /\.mjs$/]];
const TOP = ['worker.mjs', 'dashboard.html', 'panel.html', 'orca-plugin.json', 'package.json', 'engine/package.json', 'desktop/package.json'];
// The move from the old folders and the old app has to name them, and nothing else may.
const NAMES_THE_OLD = ['lib/home.mjs'];

async function filesUnder(dir, kind) {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true, recursive: dir !== 'desktop' });
  return entries.filter((e) => e.isFile() && kind.test(e.name)).map((e) => join(e.parentPath ?? e.path, e.name)).filter((path) => !TEST_ONLY.test(path));
}

test('no shipped file says Control Centre, Control Center or TheMatrix, outside the move from the old folders', async () => {
  const files = [...(await Promise.all(SHIPPED.map(([dir, kind]) => filesUnder(dir, kind)))).flat(), ...TOP.map((file) => join(ROOT, file))];
  assert.ok(files.length > 150, `${files.length} files read`);
  const named = [];
  for (const path of files) {
    if (NAMES_THE_OLD.includes(relative(ROOT, path))) continue;
    (await readFile(path, 'utf8')).split('\n').forEach((line, n) => {
      if (OLD_NAMES.test(line)) named.push(`${relative(ROOT, path)}:${n + 1}`);
    });
  }
  assert.deepEqual(named, []);
});

test('the files other programs read as they are carry the name the product module gives', async () => {
  const plugin = JSON.parse(await readFile(join(ROOT, 'orca-plugin.json'), 'utf8'));
  assert.deepEqual([plugin.id, plugin.name, plugin.contributes.panels[0].title], [FOLDER, APP_NAME, APP_NAME]);
  assert.ok(plugin.contributes.commands.every((c) => c.title.includes(APP_NAME)));
  assert.match(await readFile(join(ROOT, 'panel.html'), 'utf8'), new RegExp(`<h1>${APP_NAME}</h1>`));
  const page = await readFile(join(ROOT, 'dashboard.html'), 'utf8');
  assert.doesNotMatch(page, new RegExp(APP_NAME), 'the page shell is branded when it is served, not by hand');
  assert.match(page, /<title>\{\{APP_NAME\}\}<\/title>/);
  assert.equal(JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).name, FOLDER);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(ROOT, 'engine/package.json'), 'utf8')).bin), [FOLDER]);
  const desktop = JSON.parse(await readFile(join(ROOT, 'desktop/package.json'), 'utf8'));
  assert.deepEqual([desktop.productName, desktop.build.productName, desktop.build.appId], [APP_NAME, APP_NAME, APP_ID]);
});
