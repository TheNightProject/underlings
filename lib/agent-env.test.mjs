import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'underlings-agent-env-'));
process.env.HOME = home;
after(() => rm(home, { recursive: true, force: true }));

const real = await import('./run.mjs');
const ran = [];
const DRAFT = { subtype: 'success', is_error: false, structured_output: { summary: 'Cache the token lookup', description: 'The lookup reads the token from the network every time.\n\nCache it for a minute, and drop it when a token is revoked.' } };
mock.module('./run.mjs', {
  namedExports: {
    ...real,
    run: async (cmd, args, env) => {
      ran.push({ cmd, env: { ...env } });
      return cmd === '/bin/zsh' ? '__CONTROL_CENTRE_BIN__\nclaude=/opt/bin/claude\nacli=/opt/bin/acli\n' : JSON.stringify(DRAFT);
    },
  },
});

const { fetchEnv } = await import('./connector.mjs');
const { askClaude } = await import('./ticketdraft.mjs');

const TOKENS = { GITLAB_TOKEN: 'gl-fake-secretsecretsecret', GITHUB_TOKEN: 'ghp_secretsecretsecretsecretsecretse', GH_TOKEN: 'gho_secretsecretsecretsecretsecretse' };

test('no forge token reaches a headless read, however it was set', () => {
  const env = fetchEnv({ ...TOKENS, PATH: '/usr/bin', HOME: '/home/frank' });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/frank', MCP_CONNECTION_NONBLOCKING: 'false' });
});

test('nor does one reach the claude that drafts a ticket, though the worker holds all three', async () => {
  Object.assign(process.env, TOKENS);
  try {
    assert.equal((await askClaude('draft it', 'system')).summary, 'Cache the token lookup');
  } finally {
    for (const name of Object.keys(TOKENS)) delete process.env[name];
  }
  const claude = ran.find((r) => r.cmd === '/opt/bin/claude');
  assert.ok(claude, 'claude was run');
  for (const name of Object.keys(TOKENS)) assert.equal(name in claude.env, false, name);
  assert.equal(typeof claude.env.PATH, 'string', 'the rest of the environment goes on');
});
