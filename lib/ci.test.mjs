import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('CI runs on Apple Silicon for pushes and pull requests, and runs the install, build, type check and every suite', () => {
  assert.match(workflow, /^on:\n {2}push:\n {2}pull_request:/m);
  assert.match(workflow, /runs-on: macos-1[45]\b/);
  for (const command of ['npm run setup', 'npm run build', 'npm --prefix engine run typecheck', 'npm test', 'npm run test:golden']) assert.ok(workflow.includes(`${command}\n`) || workflow.includes(`${command} 2>&1`), command);
});

test('CI fails when a test is skipped, so full auto\'s tests, which skip without the engine build, cannot pass by not running', () => {
  assert.match(workflow, /grep -E '\^# skipped \[1-9\]'/);
  assert.match(workflow, /shell: bash/);
});
