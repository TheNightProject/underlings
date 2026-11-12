import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { engineFile } from '../lib/engine.mjs';
import { APP_ID, APP_NAME } from '../lib/product.mjs';

const DESKTOP = fileURLToPath(new URL('.', import.meta.url));
const { build } = JSON.parse(await readFile(join(DESKTOP, 'package.json'), 'utf8'));
const BUILT = dirname(engineFile({}));
const ENTRIES = ['engine.js', 'agentrun.js'];
const IMPORTS = [/^import\s[^;]*?["']([^"']+)["'];$/gm, /\bimport\(\s*["']([^"']+)["']\s*\)/g];
const skip = existsSync(join(BUILT, 'engine.js')) ? false : `needs the review engine built at ${BUILT}: run npm run build`;

const specifiers = (code) => IMPORTS.flatMap((re) => [...code.matchAll(re)].map((m) => m[1]));
const packedFrom = (folder) => build.extraResources.find((r) => resolve(DESKTOP, r.from) === folder);

test('the app packs the engine build at the place its worker looks for one', () => {
  const repo = resolve(DESKTOP, '..');
  assert.equal(packedFrom(repo)?.to, 'worker');
  assert.equal(packedFrom(BUILT)?.to, join('worker', relative(repo, BUILT)));
});

test('the engine the app packs needs nothing from node_modules', { skip }, async () => {
  const seen = new Set();
  const outside = [];
  async function walk(file) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const name of specifiers(await readFile(file, 'utf8'))) {
      if (name.startsWith('.')) await walk(resolve(dirname(file), name));
      else if (!isBuiltin(name)) outside.push(`${basename(file)} imports ${name}`);
    }
  }
  for (const entry of ENTRIES) await walk(join(BUILT, entry));
  assert.deepEqual(outside, []);
  assert.ok(seen.size > ENTRIES.length, 'the walk followed the build into its chunks');
});

test('the app packs the release notes and the build stamp beside its worker, stamped before it packs', async () => {
  const { scripts } = JSON.parse(await readFile(join(DESKTOP, 'package.json'), 'utf8'));
  const repo = resolve(DESKTOP, '..');
  const { filter } = packedFrom(repo);
  for (const file of ['CHANGELOG.md', 'build.json', 'worker.mjs', 'lib/*.mjs']) assert.ok(filter.includes(file), file);
  const root = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).scripts;
  assert.match(root.build, /node scripts\/stamp\.mjs$/);
  assert.match(scripts.dist, /^npm --prefix \.\. run build && npm run pack$/);
  assert.match(scripts['install-app'], /^npm run dist && ditto /);
});

test('the app packs every file its main process loads, the preloads and the pages they load among them', async () => {
  const main = await readFile(join(DESKTOP, 'main.mjs'), 'utf8');
  const local = [...main.matchAll(/from '\.\/([\w.-]+)'/g), ...main.matchAll(/join\(APP_DIR, '([\w.-]+)'\)/g)].map((m) => m[1]);
  const pages = await Promise.all(local.filter((file) => file.endsWith('.html')).map((file) => readFile(join(DESKTOP, file), 'utf8')));
  const loaded = pages.flatMap((html) => [...html.matchAll(/<script src="([\w.-]+)"/g)].map((m) => m[1]));
  for (const file of ['terminal.mjs', 'terminal-preload.cjs', 'viewer.mjs', 'viewer.html', 'viewer-preload.cjs']) assert.ok(local.includes(file), file);
  assert.deepEqual(loaded, ['viewer.js']);
  for (const file of [...local, ...loaded]) assert.ok(build.files.includes(file), `${file} is packed`);
});

test('node-pty is built from source against the app\'s own Electron, and only that build is packed', async () => {
  const { dependencies, devDependencies, scripts } = JSON.parse(await readFile(join(DESKTOP, 'package.json'), 'utf8'));
  assert.ok(dependencies['node-pty'], 'a production dependency, so electron-builder packs and rebuilds it');
  assert.ok(devDependencies.electron);
  assert.equal(build.buildDependenciesFromSource, true);
  assert.equal(scripts.postinstall, 'electron-builder install-app-deps', 'npm run setup builds it for Electron too, so npm start works');
  const dropped = build.files.filter((f) => f.startsWith('!node_modules/node-pty/'));
  assert.ok(dropped.some((f) => /\bprebuilds\b/.test(f)), 'its prebuilt binaries are left out, so the Electron build is the one that loads');
  assert.ok(!dropped.some((f) => /Release\/pty\.node|Release\/spawn-helper|Release\$\{/.test(f)), 'the build itself is packed');
});

test('xterm.js and the two addons the terminal window loads are packed as dependencies', async () => {
  const { dependencies } = JSON.parse(await readFile(join(DESKTOP, 'package.json'), 'utf8'));
  const main = await readFile(join(DESKTOP, 'main.mjs'), 'utf8');
  const named = [...main.matchAll(/'(@xterm\/[\w-]+)\/[^']+'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(named)].sort(), ['@xterm/addon-fit', '@xterm/addon-web-links', '@xterm/xterm']);
  for (const name of named) assert.ok(dependencies[name], name);
});

test('the headless screen and serializer the pty keeps are packed as dependencies', async () => {
  const { dependencies } = JSON.parse(await readFile(join(DESKTOP, 'package.json'), 'utf8'));
  const terminal = await readFile(join(DESKTOP, 'terminal.mjs'), 'utf8');
  const named = [...terminal.matchAll(/require\('(@xterm\/[\w-]+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(named.sort(), ['@xterm/addon-serialize', '@xterm/headless']);
  for (const name of named) assert.ok(dependencies[name], name);
});

test('what the main process imports from lib/ is packed beside it, where the same import finds it', async () => {
  const sources = await Promise.all(['main.mjs', 'host.mjs'].map((file) => readFile(join(DESKTOP, file), 'utf8')));
  const wanted = [...new Set(sources.flatMap((code) => [...code.matchAll(/from '\.\.\/lib\/([\w.-]+)'/g)].map((m) => m[1])))];
  assert.ok(wanted.includes('product.mjs'));
  const packed = packedFrom(resolve(DESKTOP, '../lib'));
  assert.equal(packed?.to, 'lib', 'Resources/app/../lib is Resources/lib');
  assert.deepEqual(wanted.filter((file) => !packed.filter.includes(file)), []);
});

test('the app is built as Underlings, under the product module\'s bundle ID, and installed under that name', async () => {
  const pkg = JSON.parse(await readFile(join(DESKTOP, 'package.json'), 'utf8'));
  assert.deepEqual([pkg.productName, build.productName, build.appId], [APP_NAME, APP_NAME, APP_ID]);
  assert.match(pkg.scripts['install-app'], new RegExp(`ditto dist\\.noindex/mac-arm64/${APP_NAME}\\.app /Applications/${APP_NAME}\\.app$`));
  const selfupdate = await readFile(join(DESKTOP, '../lib/selfupdate.mjs'), 'utf8');
  assert.match(selfupdate, /const BUILT_APP = `desktop\/dist\.noindex\/mac-arm64\/\$\{APP_NAME\}\.app`;/);
});

test('every pack also leaves the build where an updater from before the rename installs from', async () => {
  const { scripts } = JSON.parse(await readFile(join(DESKTOP, 'package.json'), 'utf8'));
  assert.equal(scripts.pack, 'electron-builder --mac dir --arm64 && node ../scripts/legacy-bundle.mjs');
  assert.match(scripts.dist, /npm run pack$/, 'which is what an older updater runs, by the name pack');
});

test('the app packs the third-party notices, which name each runtime dependency at the version it ships, and ical.js with where to get its source', async () => {
  const repo = resolve(DESKTOP, '..');
  const notices = await readFile(join(repo, 'THIRD_PARTY_NOTICES'), 'utf8');
  assert.equal(packedFrom(join(repo, 'THIRD_PARTY_NOTICES'))?.to, 'THIRD_PARTY_NOTICES');
  const desktop = JSON.parse(await readFile(join(DESKTOP, 'package.json'), 'utf8'));
  const engine = JSON.parse(await readFile(join(repo, 'engine/package.json'), 'utf8'));
  const shipped = { ...desktop.dependencies, electron: desktop.devDependencies.electron, ...engine.dependencies };
  for (const [name, version] of Object.entries(shipped)) assert.match(notices, new RegExp(`${name.replace(/[.\\/]/g, '\\$&')}\\s+${version.replace(/\./g, '\\.')}`, 'i'), `${name} ${version} has a notice`);
  assert.match(notices, /Mozilla Public License Version 2\.0/);
  assert.match(notices, /https:\/\/github\.com\/kewisch\/ical\.js/);
});
