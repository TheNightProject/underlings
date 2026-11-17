import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const state = mkdtempSync(join(tmpdir(), 'kickoff-state-'));
const root = mkdtempSync(join(tmpdir(), 'kickoff-root-'));
const fixtures = fileURLToPath(new URL('../fixtures/claude/', import.meta.url));
chmodSync(join(fixtures, 'fake-claude.mjs'), 0o755);
process.env['UNDERLINGS_STATE_DIR'] = state;
process.env['UNDERLINGS_CODE_FOLDER'] = root;
process.env['UNDERLINGS_CLAUDE_BIN'] = join(fixtures, 'fake-claude.mjs');
process.env['FAKE_CLAUDE_FIRST'] = join(fixtures, 'question.jsonl');
process.env['FAKE_CLAUDE_RESUME'] = join(fixtures, 'resume.jsonl');
after(() => {
  rmSync(state, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const { kickoffPrompt, kickoffRunAlive, launchKickoff } = await import('./launch.js');
const { changeSettings, loadRuns } = await import('../data/store.js');
const { claudeAgents, claudeHost } = await import('../agents/claude.js');
changeSettings((s) => ({ ...s, agents: { ...s.agents, kickoffCommand: '/team:kickoff' } }));

const KEY = 'ABC-1234';
const TICKET_URL = 'https://example.atlassian.net/browse/ABC-1234';

function promptOf(handle: string | undefined): string {
  const input = join(state, 'agents', (handle ?? '').slice('claude:'.length), 'input.jsonl');
  const first = JSON.parse(readFileSync(input, 'utf8').split('\n')[0] ?? '{}') as { message?: { message?: { content?: string } } };
  return first.message?.message?.content ?? '';
}

beforeEach(() => {
  writeFileSync(join(state, 'runs.json'), '{}');
});
afterEach(async () => {
  for (const agent of await claudeHost.agents()) await claudeHost.removeWorkspace(agent.handle);
});

test('the kickoff prompt runs the kickoff skill on the ticket, then says to ask before anything leaves the machine', () => {
  assert.equal(kickoffPrompt(KEY), [
    '/team:kickoff ABC-1234',
    'Before any git push, merge request, Jira transition or comment, stop and ask me with the AskUserQuestion tool and wait for my answer.',
  ].join('\n'));
});

test('a kickoff starts Claude Code in the code folder, named for the ticket, on the kickoff prompt', async () => {
  const outcome = await launchKickoff(KEY, TICKET_URL);
  assert.deepEqual([outcome.how, outcome.name], ['claude', 'kickoff-ABC-1234']);
  const agent = claudeAgents().find((a) => a.handle === outcome.handle);
  assert.deepEqual([agent?.kind, agent?.ticket, agent?.cwd], ['kickoff', KEY, root]);
  assert.equal(promptOf(outcome.handle), kickoffPrompt(KEY));
});

test('the run is recorded under the ticket with the agent and marked a kickoff, so the page can find and answer it', async () => {
  const { handle } = await launchKickoff(KEY, TICKET_URL);
  const run = loadRuns()[`ticket:${KEY}`];
  assert.deepEqual([run?.status, run?.terminal, run?.webUrl, run?.kickoff], ['running', handle, TICKET_URL, true]);
});

test('a second start is refused while the last kickoff agent is still listed, even one that ended its turn', async () => {
  const { handle = '' } = await launchKickoff(KEY);
  await claudeHost.stop(handle);
  assert.equal(await kickoffRunAlive(KEY), true);
  await assert.rejects(launchKickoff(KEY), /an agent is still open on ABC-1234/);
  await claudeHost.removeWorkspace(handle);
  assert.equal(await kickoffRunAlive(KEY), false, 'its agent has gone');
  await launchKickoff(KEY);
  assert.equal(claudeAgents().length, 1);
});

test('two starts at once launch one agent', async () => {
  const [first, second] = await Promise.allSettled([launchKickoff(KEY), launchKickoff(KEY)]);
  assert.equal(first.status, 'fulfilled');
  assert.match(String(second.status === 'rejected' && second.reason), /an agent is already starting on ABC-1234/);
  assert.equal(claudeAgents().length, 1);
});

test('a key that is not a Jira key starts nothing', async () => {
  await assert.rejects(launchKickoff('ABC-1; rm -rf ~'), /not a Jira key/);
  assert.equal(claudeAgents().length, 0);
  assert.deepEqual(loadRuns(), {});
});
