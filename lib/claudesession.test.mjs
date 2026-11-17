import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { accountConfigDir, cswapConfigDir } from './claudesession.mjs';

const dir = mkdtempSync(join(tmpdir(), 'underlings-cswap-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// cswap as it behaves: account 1 lives in a folder of its own, and account 2 is the default login, run with no folder named.
writeFileSync(join(dir, 'cswap'), `#!/bin/sh
case "$2" in
  1) CLAUDE_CONFIG_DIR=/home/dev/.claude-swap/1 exec claude ;;
  *) unset CLAUDE_CONFIG_DIR; exec claude ;;
esac
`, { mode: 0o755 });
const env = { PATH: `${dir}:/usr/bin:/bin`, CLAUDE_CONFIG_DIR: '/left/by/the/app' };
const shimDir = join(dir, 'where');

test('a workspace\'s account runs in the folder cswap names for it, or with none named when cswap uses the default login', async () => {
  assert.equal(await accountConfigDir('1', { env, shimDir }), '/home/dev/.claude-swap/1');
  assert.equal(await accountConfigDir('2', { env, shimDir }), null, 'naming ~/.claude would be a login of its own to Claude Code');
});

test('the terminal still gets a folder to carry a session into, the default one for the default login', async () => {
  assert.equal(await cswapConfigDir({ cswap: join(dir, 'cswap'), account: '2', env: { ...env, CLAUDE_CONFIG_DIR: '' }, shimDir }), join(process.env.HOME, '.claude'));
});

test('without cswap on the PATH a workspace\'s account says so', async () => {
  await assert.rejects(accountConfigDir('1', { env: { PATH: '/usr/bin:/bin' }, shimDir }), { message: 'cswap is not on your PATH, so account 1 cannot be found' });
});
