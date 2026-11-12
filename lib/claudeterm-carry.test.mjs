import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { terminalWorld } from './fixtures/terminal-world.mjs';

const w = await terminalWorld();
const { agent, claude, handleOf } = await import('./fixtures/panel-engine.mjs');
const HANDLE = handleOf(5);
const ID = HANDLE.slice('claude:'.length);
const TRANSCRIPT = join(w.home, '.claude/projects/-ws-root', `${ID}.jsonl`);

after(() => w.close());

const open = async () => {
  const res = await w.post('/api/claude/terminal/open', {});
  assert.equal(res.status, 200, await res.clone().text());
  return w.app.opened.at(-1);
};

test('the first time the panel terminal starts it resumes the panel\'s chat, on the model it ran on, with today\'s tools, rules and hooks, once its runner has stopped', async () => {
  w.world.agents = [agent(5, { state: 'working', alive: true, model: 'sonnet', effort: 'high', subagentModel: 'haiku', subagentForce: true })];
  assert.equal((await w.post('/api/claude/open', { handle: HANDLE })).status, 200);
  await mkdir(join(TRANSCRIPT, '..'), { recursive: true });
  await writeFile(TRANSCRIPT, '{"type":"user"}\n');
  const spec = await open();
  assert.deepEqual(spec.args, ['--mcp-config', join(w.STATE, 'mcp.json'), '--settings', join(w.STATE, 'terminal-settings.json'), '--model', 'sonnet', '--effort', 'high', '--resume', ID]);
  assert.equal(spec.env.CLAUDE_CODE_SUBAGENT_MODEL, 'haiku');
  assert.equal(spec.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1', 'the chat\'s builders stay forced');
  assert.deepEqual(claude.stopped, [HANDLE], 'the headless runner stops before the terminal takes its session');
  assert.deepEqual(await w.readJson('terminal.json'), { id: ID, resumable: true, account: '', model: 'sonnet', effort: 'high', subagentModel: 'haiku', subagentForce: true });
  assert.deepEqual(await w.readJson('panel.json'), { current: null }, 'nothing will send to that chat again');
  assert.equal(await readFile(TRANSCRIPT, 'utf8'), '{"type":"user"}\n', 'one config dir, so nothing is copied');
  const settings = await w.readJson('terminal-settings.json');
  assert.deepEqual(Object.keys(settings.hooks), ['Notification', 'Stop', 'UserPromptSubmit', 'PreToolUse']);
});

async function chatWithTranscript(n, extra = {}) {
  w.world.agents = [agent(n, extra)];
  assert.equal((await w.post('/api/claude/open', { handle: handleOf(n) })).status, 200);
  const file = join(w.home, '.claude/projects/-ws-root', `${handleOf(n).slice('claude:'.length)}.jsonl`);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, '{"type":"user"}\n');
}

test('once the terminal has a session it carries on with it, and never carries a chat over again', async () => {
  await writeFile(join(w.STATE, 'terminal.json'), JSON.stringify({ id: ID, resumable: true, account: '' }));
  await chatWithTranscript(8, { alive: true });
  const stopped = claude.stopped.length;
  assert.deepEqual((await open()).args.slice(-2), ['--resume', ID]);
  assert.equal(claude.stopped.length, stopped, 'that chat\'s runner is left alone');
});

test('in the app the panel\'s chat is not listed, so it raises no card and nothing waits on it', async () => {
  await chatWithTranscript(9, { state: 'blocked', alive: false, pending: { id: 'req-1', tool: 'Bash', summary: 'ls', questions: null } });
  await w.post('/api/matrix/refresh', {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  const { claude: panel, attention } = await (await fetch(`${w.origin}/api/state?t=${w.token}`)).json();
  assert.deepEqual([panel.current, panel.history], [null, []]);
  assert.deepEqual(attention.agents.filter((i) => i.kind === 'claude'), [], 'its old ask is no card');
});
