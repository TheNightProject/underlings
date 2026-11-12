import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { leaveForOldUpdater } from './legacy-bundle.mjs';

const out = mkdtempSync(join(tmpdir(), 'underlings-pack-'));
after(() => rmSync(out, { recursive: true, force: true }));
const built = join(out, 'Underlings.app');
// Where an updater from before the rename takes the build it installs from, in a checkout.
const OLD_BUILT = join(out, 'Control Centre.app');

test('the pack leaves the build where an older updater looks for it too, replacing what an earlier pack left there', () => {
  mkdirSync(join(built, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(built, 'Contents/MacOS/Underlings'), 'this build');
  mkdirSync(join(OLD_BUILT, 'Contents'), { recursive: true });
  writeFileSync(join(OLD_BUILT, 'Contents/stale'), 'the build before');
  assert.equal(leaveForOldUpdater(out), OLD_BUILT);
  assert.equal(readFileSync(join(OLD_BUILT, 'Contents/MacOS/Underlings'), 'utf8'), 'this build');
  assert.throws(() => readFileSync(join(OLD_BUILT, 'Contents/stale')), 'nothing of the last build is left in it');
  assert.equal(readFileSync(join(built, 'Contents/MacOS/Underlings'), 'utf8'), 'this build', 'and the build itself stays');
});

test('with no build there is nothing to leave, and it says so', () => {
  rmSync(built, { recursive: true, force: true });
  assert.throws(() => leaveForOldUpdater(out), /there is no built app at/);
});
