import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { writePrivate } from './connector.mjs';

const dir = await mkdtemp(join(tmpdir(), 'control-centre-connector-'));
after(() => rm(dir, { recursive: true }));

test('two writes of one file at once both land, the file stays readable only by Frank, and no temp file is left', async () => {
  const path = join(dir, 'state', 'slack.json');
  await Promise.all([writePrivate(path, { n: 1 }), writePrivate(path, { n: 2 })]);
  assert.ok([1, 2].includes(JSON.parse(await readFile(path, 'utf8')).n));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(dir, 'state')), ['slack.json']);
});
