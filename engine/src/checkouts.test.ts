import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { checkoutFor, discoverCheckouts, noCheckout, remotePath } from './checkouts.js';

const root = mkdtempSync(join(tmpdir(), 'checkouts-'));
after(() => rmSync(root, { recursive: true, force: true }));

function clone(dir: string, url?: string): void {
  mkdirSync(join(root, dir, '.git'), { recursive: true });
  const origin = url ? `[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : '';
  writeFileSync(join(root, dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@gitlab.com:someone/else.git\n${origin}`);
}

clone('engine', 'git@gitlab.com:acme/engine.git');
clone('engine-copy', 'https://gitlab.com/acme/engine.git');
clone('web', 'https://oauth2:secret@gitlab.com/acme/platform/frontend');
clone('scratch');
mkdirSync(join(root, 'notes'));
mkdirSync(join(root, 'eng-abc-1'));
writeFileSync(join(root, 'eng-abc-1', '.git'), 'gitdir: /elsewhere/.git/worktrees/eng-abc-1\n');
writeFileSync(join(root, 'README.md'), 'not a folder');

test('every checkout directly under the root is found with the project its origin names, and nothing else is', () => {
  assert.deepEqual(discoverCheckouts(root), [
    { dir: 'engine', path: 'acme/engine' },
    { dir: 'engine-copy', path: 'acme/engine' },
    { dir: 'scratch', path: null },
    { dir: 'web', path: 'acme/platform/frontend' },
  ]);
  assert.deepEqual(discoverCheckouts(join(root, 'missing')), [], 'a root that is not there has none');
});

test('a remote in any of the shapes git takes names its project', () => {
  assert.equal(remotePath('git@gitlab.com:acme/engine.git'), 'acme/engine');
  assert.equal(remotePath('ssh://git@gitlab.example:2222/acme/sub/engine.git'), 'acme/sub/engine');
  assert.equal(remotePath('https://gitlab.com/acme/engine'), 'acme/engine');
  assert.equal(remotePath('https://user:token@gitlab.com/acme/engine.git/'), 'acme/engine');
  assert.equal(remotePath('/Users/me/origin.git'), null, 'a local path is no project');
});

test('a repo maps to the clone of its project, the one named after it first, and otherwise to a folder of its name', () => {
  const found = discoverCheckouts(root);
  assert.equal(checkoutFor('acme/engine', found)?.dir, 'engine');
  assert.equal(checkoutFor('ACME/Platform/Frontend', found)?.dir, 'web', 'by its remote, whatever the folder is called');
  assert.equal(checkoutFor('other/scratch', found)?.dir, 'scratch', 'by its name, when no remote says');
  assert.equal(checkoutFor('acme/missing', found), null);
  assert.equal(checkoutFor('acme/engine', found.filter((c) => c.dir !== 'engine'))?.dir, 'engine-copy');
});

test('no checkout says where to clone it, or which setting to change', () => {
  assert.equal(noCheckout('acme/missing', '/work').message, 'No checkout of acme/missing under /work. Clone it there as /work/missing, or set Workspace root in Settings to the folder your clones live in.');
});
