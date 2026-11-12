import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { OLD_APP_NAME } from '../lib/home.mjs';
import { APP_ID, APP_NAME } from '../lib/product.mjs';
import { bundleOf, dockTiles, moveFor, moveJob, replacedBy, tidyAfterMove } from './relocate.mjs';

const dir = mkdtempSync(join(tmpdir(), 'underlings-relocate-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const apps = join(dir, 'Applications');
const OLD = join(apps, `${OLD_APP_NAME}.app`);
const NEW = join(apps, `${APP_NAME}.app`);
const names = { appName: APP_NAME, oldName: OLD_APP_NAME };

function bundle(path) {
  mkdirSync(join(path, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(path, 'Contents/MacOS', APP_NAME), '');
}

test('a run from a bundle under the old name moves itself beside it under its own; any other run stays where it is', () => {
  assert.equal(bundleOf(join(OLD, 'Contents/MacOS', APP_NAME)), OLD);
  assert.equal(bundleOf('/usr/local/bin/node'), null);
  assert.deepEqual(moveFor({ bundle: OLD, ...names }), { from: OLD, to: NEW });
  assert.equal(moveFor({ bundle: NEW, ...names }), null);
  assert.equal(moveFor({ bundle: join(apps, 'Renamed By Hand.app'), ...names }), null, 'a name you chose is left alone');
  assert.equal(moveFor({ bundle: null, ...names }), null, 'run from a checkout');
  assert.equal(moveFor({ bundle: OLD, ...names, argv: ['--stay'] }), null, 'reopened after a move that failed, so it does not try again and again');
});

test('the helper copies the running bundle across and opens the copy, saying where it came from, or reopens this one to stay', () => {
  const job = moveJob({ from: OLD, to: NEW }, { pid: 42, result: '/tmp/r.json' });
  assert.deepEqual(job, {
    pid: 42, built: OLD, bundle: NEW, result: '/tmp/r.json',
    relaunch: ['/usr/bin/open', NEW, '--args', `--replaced=${OLD}`],
    fallback: ['/usr/bin/open', OLD, '--args', '--stay'],
  });
  const started = moveJob({ from: OLD, to: NEW }, { pid: 42, result: '/tmp/r.json', argv: ['/x/Underlings', '--hidden', '--user-data-dir=/scratch/ud', '--inspect', 'file.txt'] });
  assert.deepEqual(started.relaunch.slice(4), ['--hidden', '--user-data-dir=/scratch/ud'], 'the copy starts hidden, on the same folder, as this one did');
  assert.deepEqual(started.fallback.slice(4), ['--hidden', '--user-data-dir=/scratch/ud']);
  assert.equal(replacedBy(['/x/Underlings', `--replaced=${OLD}`]), OLD);
  assert.equal(replacedBy(['/x/Underlings']), null);
});

test('once running under its own name it removes the bundle it was moved from, and only that one', async () => {
  const quiet = { replace: async () => 0 };
  bundle(OLD);
  bundle(NEW);
  assert.equal(await tidyAfterMove({ argv: [], bundle: NEW, ...names, appId: APP_ID, dock: quiet }), null, 'a start that was not a move');
  assert.equal(await tidyAfterMove({ argv: [`--replaced=${NEW}`], bundle: NEW, ...names, appId: APP_ID, dock: quiet }), null, 'never itself');
  const other = join(apps, 'Other.app');
  bundle(other);
  assert.equal(await tidyAfterMove({ argv: [`--replaced=${other}`], bundle: NEW, ...names, appId: APP_ID, dock: quiet }), null, 'never a bundle of another name');
  assert.ok(existsSync(other) && existsSync(OLD));
  const asked = [];
  const dock = { replace: async (...args) => { asked.push(args); return 1; } };
  assert.deepEqual(await tidyAfterMove({ argv: [`--replaced=${OLD}`], bundle: NEW, ...names, appId: APP_ID, dock }), { removed: OLD, tiles: 1 });
  assert.equal(existsSync(OLD), false);
  assert.ok(existsSync(NEW));
  assert.deepEqual(asked, [[OLD, NEW, { label: APP_NAME, id: APP_ID }]]);
});

const DOCK = (url, label) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>persistent-apps</key><array>
<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>file:///System/Applications/Mail.app/</string><key>_CFURLStringType</key><integer>15</integer></dict><key>file-label</key><string>Mail</string></dict></dict>
<dict><key>tile-data</key><dict/><key>tile-type</key><string>spacer-tile</string></dict>
<dict><key>tile-data</key><dict><key>book</key><data>AAAA</data><key>bundle-identifier</key><string>old.id</string><key>file-data</key><dict><key>_CFURLString</key><string>${url}</string><key>_CFURLStringType</key><integer>15</integer></dict><key>file-label</key><string>${label}</string></dict></dict>
</array></dict></plist>
`;

// Only the defaults domain and the Dock restart are stood in for; PlistBuddy edits a copy of the plist for real.
function fakeDock(start) {
  const exported = join(dir, 'exported.plist');
  writeFileSync(exported, start);
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === '/usr/bin/defaults' && args[0] === 'export') return copyFileSync(exported, args[2]);
    if (cmd === '/usr/bin/defaults' && args[0] === 'import') return copyFileSync(args[2], join(dir, 'imported.plist'));
    return execFileSync(cmd, args, { encoding: 'utf8' });
  };
  return { dock: dockTiles({ exec, tmp: dir, restart: async () => calls.push('restart Dock') }), calls };
}

const tile = (file, field) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :persistent-apps:2:tile-data:${field}`, file], { encoding: 'utf8' }).trim();

test('a Dock tile for the old bundle, past a spacer, is pointed at the new one in its place, and the Dock is restarted once', async () => {
  rmSync(join(dir, 'imported.plist'), { force: true });
  const { dock, calls } = fakeDock(DOCK(`file://${encodeURI(OLD)}/`, OLD_APP_NAME));
  assert.equal(await dock.replace(OLD, NEW, { label: APP_NAME, id: APP_ID }), 1);
  const out = join(dir, 'imported.plist');
  assert.equal(tile(out, 'file-data:_CFURLString'), `file://${encodeURI(NEW)}/`);
  assert.deepEqual([tile(out, 'file-label'), tile(out, 'bundle-identifier')], [APP_NAME, APP_ID]);
  assert.throws(() => tile(out, 'book'), 'the bookmark to the old bundle is dropped, so the Dock follows the path');
  assert.equal(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :persistent-apps:0:tile-data:file-label', out], { encoding: 'utf8' }).trim(), 'Mail');
  assert.equal(calls.filter((c) => c === 'restart Dock').length, 1);
});

test('with no tile for the old bundle the Dock is not touched at all', async () => {
  rmSync(join(dir, 'imported.plist'), { force: true });
  const { dock, calls } = fakeDock(DOCK('file:///Applications/Safari.app/', 'Safari'));
  assert.equal(await dock.replace(OLD, NEW, { label: APP_NAME, id: APP_ID }), 0);
  assert.equal(existsSync(join(dir, 'imported.plist')), false);
  assert.deepEqual(calls.filter((c) => /import|restart/.test(c)), []);
  assert.match(readFileSync(join(dir, 'exported.plist'), 'utf8'), /Safari/);
});
