import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from './run.mjs';

test('a child that exits without reading a long input fails the call, not the worker', async () => {
  const input = 'x'.repeat(1024 * 1024);
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(3)'], process.env, { input }), { code: 3 });
});

test('a child that reads its input answers with what it read', async () => {
  const echo = 'process.stdin.pipe(process.stdout)';
  assert.equal(await run(process.execPath, ['-e', echo], process.env, { input: 'hello' }), 'hello');
});
