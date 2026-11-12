import assert from 'node:assert/strict';
import { test } from 'node:test';
import { terminalWorktree } from '../agents/orca.js';

const ROOT = '/Users/frank/Projects/Acme';

test('an Orca terminal opened without a workspace goes to the workspace root, never the caller cwd', () => {
  assert.equal(terminalWorktree(undefined, ROOT), `path:${ROOT}`);
  assert.equal(terminalWorktree({ path: '' }, ROOT), `path:${ROOT}`);
});

test('an Orca workspace that reports its id is named by it, and one that reports only its path by that', () => {
  assert.equal(terminalWorktree({ id: 'repo-1::/work::workspace:k1', path: ROOT }, ROOT), 'id:repo-1::/work::workspace:k1');
  assert.equal(terminalWorktree({ path: `${ROOT}/review-Engine-621` }, ROOT), `path:${ROOT}/review-Engine-621`);
});
