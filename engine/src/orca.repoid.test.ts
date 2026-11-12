import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workspace } from './agents/host.js';
import { pickRepoId } from './data/orca.js';

const ROOT = '/home/dev/work';

function ws(id: string, path: string, isMainWorktree = false): Workspace {
  return { id, path, displayName: 'x', branch: '', isMainWorktree };
}

test('the repo id is the part of the Orca id before the path', () => {
  const list = [ws(`repo-abc::${ROOT}`, ROOT, true)];
  assert.equal(pickRepoId(list, ROOT), 'repo-abc');
});

test('a subdirectory resolves to the repo that contains it', () => {
  // The engine is usually started from a folder inside the workspace, not its root.
  const list = [ws(`repo-abc::${ROOT}`, ROOT, true)];
  assert.equal(pickRepoId(list, `${ROOT}/thematrix`), 'repo-abc');
  assert.equal(pickRepoId(list, `${ROOT}/a/b/c`), 'repo-abc');
});

test('the main worktree wins over a review workspace on the same path', () => {
  const list = [
    ws(`repo-abc::${ROOT}::workspace:1111`, ROOT),
    ws(`repo-abc::${ROOT}`, ROOT, true),
  ];
  assert.equal(pickRepoId(list, ROOT), 'repo-abc');
});

test('a workspace that only looks like a prefix is not a match', () => {
  // `/home/dev/workshop` starts with `/home/dev/work` as a string but is another tree.
  const list = [ws('other::/home/dev/workshop', '/home/dev/workshop', true)];
  assert.equal(pickRepoId(list, '/home/dev/workshop/x'), 'other');
  assert.equal(pickRepoId(list, ROOT), null, 'the separator has to be there');
});

test('no covering worktree yields null, so the caller can say what to do', () => {
  assert.equal(pickRepoId([], ROOT), null);
  assert.equal(pickRepoId([ws('x::/somewhere/else', '/somewhere/else', true)], ROOT), null);
  assert.equal(pickRepoId([ws('y::', '', true)], ROOT), null, 'an empty path covers nothing');
});
