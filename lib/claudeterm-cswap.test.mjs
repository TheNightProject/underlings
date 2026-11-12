import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { terminalWorld } from './fixtures/terminal-world.mjs';

const w = await terminalWorld({ claudeAccount: 2 });
const cswap = join(w.bin, 'cswap');
process.env.PATH = `${w.bin}:/usr/bin:/bin`;

after(() => w.close());

const open = async () => {
  const res = await w.post('/api/claude/terminal/open', {});
  assert.equal(res.status, 200, await res.clone().text());
  return w.app.opened.at(-1);
};

test('the first start, through cswap run as account 2, resumes the panel\'s chat there, copied into the profile cswap runs that account in', async () => {
  const { agent, handleOf } = await import('./fixtures/panel-engine.mjs');
  w.world.agents = [agent(6)];
  assert.equal((await w.post('/api/claude/open', { handle: handleOf(6) })).status, 200);
  const id = handleOf(6).slice('claude:'.length);
  const from = join(w.home, '.claude/projects/-ws-root');
  await mkdir(join(from, id, 'subagents'), { recursive: true });
  await writeFile(join(from, `${id}.jsonl`), '{"type":"user","message":"what needs me?"}\n');
  await writeFile(join(from, id, 'subagents/agent-1.jsonl'), '{}\n');
  const profile = join(w.home, 'cswap/sessions/2-me');
  await writeFile(cswap, `#!/bin/sh\n[ "$1" = run ] || exit 1\nshift 2\n[ "$1" = -- ] && shift\nCLAUDE_CONFIG_DIR='${profile}' exec claude "$@"\n`);
  await chmod(cswap, 0o755);
  const spec = await open();
  assert.deepEqual([spec.file, spec.notice], [cswap, null]);
  assert.deepEqual(spec.args, ['run', '2', '--', '--mcp-config', join(w.STATE, 'mcp.json'), '--settings', join(w.STATE, 'terminal-settings.json'), '--plugin-dir', '/app/plugin/underlings', '--resume', id]);
  assert.deepEqual(await w.readJson('terminal.json'), { id, resumable: true, account: '2' });
  assert.equal(await readFile(join(profile, `projects/-ws-root/${id}.jsonl`), 'utf8'), '{"type":"user","message":"what needs me?"}\n');
  assert.equal(await readFile(join(profile, `projects/-ws-root/${id}/subagents/agent-1.jsonl`), 'utf8'), '{}\n');
  assert.ok(await readFile(join(from, `${id}.jsonl`), 'utf8'), 'the default login keeps its copy');
});

test('with cswap gone from the PATH, it says so and starts plain claude on the session it would have run', async () => {
  await rm(cswap, { force: true });
  const spec = await open();
  const { id } = await w.readJson('terminal.json');
  assert.equal(spec.file, process.env.UNDERLINGS_CLAUDE_BIN);
  assert.equal(spec.notice, 'cswap is not on your PATH, so this is plain claude rather than account 2.');
  assert.deepEqual(spec.args.slice(-2), ['--resume', id]);
});

test('a session made under one account is not resumed under another', async () => {
  const id = '11111111-2222-4333-8444-555555555555';
  await mkdir(w.STATE, { recursive: true });
  await writeFile(join(w.STATE, 'terminal.json'), JSON.stringify({ id, resumable: true, account: '1' }));
  const spec = await open();
  assert.equal(spec.args.at(-2), '--session-id');
  assert.notEqual(spec.args.at(-1), id);
  assert.equal((await w.readJson('terminal.json')).account, '2');
});

const get = async (path) => (await fetch(w.origin + path, { headers: { 'x-cc-token': w.token } })).json();
const LISTED = { schemaVersion: 1, activeAccountNumber: 2, accounts: [
  { number: 1, email: 'me@example.com', organizationName: "me@example.com's Organization", active: false },
  { number: 2, email: 'me@work.example', organizationName: 'Work Ltd', active: true },
] };

test('Settings lists the cswap accounts, and the one chosen there is what Claude Code next starts as, over config.json', async () => {
  const listed = join(w.bin, 'cswap-list.json');
  await writeFile(listed, JSON.stringify(LISTED));
  await writeFile(cswap, `#!/bin/sh\nif [ "$1" = list ]; then cat '${listed}'; else echo "fake cswap $*"; fi\n`);
  await chmod(cswap, 0o755);
  const view = await get('/api/claude/account');
  assert.deepEqual([view.account, view.cswap, view.accounts.map((a) => [a.number, a.org])], ['2', true, [['1', "me@example.com's Organization"], ['2', 'Work Ltd']]]);
  const chosen = await w.post('/api/claude/account', { account: '1' });
  assert.equal((await chosen.json()).text, 'Claude Code runs as account 1 from its next start');
  assert.deepEqual((await open()).args.slice(0, 3), ['run', '1', '--']);
  await w.post('/api/claude/account', { account: '' });
  assert.equal((await open()).file, process.env.UNDERLINGS_CLAUDE_BIN, 'the default login is plain claude, whatever config.json says');
  assert.equal((await w.post('/api/claude/account', { account: '9' })).status, 400);
  assert.equal((await get('/api/claude/account')).account, '', 'a refused choice changes nothing');
});
