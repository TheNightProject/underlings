import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = await mkdtemp(join(tmpdir(), 'underlings-models-'));
const stateDir = join(home, 'engine-state');
process.env.HOME = home;
process.env.UNDERLINGS_STATE_DIR = stateDir;
process.env.GITLAB_TOKEN = 'not-a-real-token';
process.env.UNDERLINGS_CLAUDE_BIN = '/nonexistent/claude';
const matrixEngine = fileURLToPath(new URL('../engine/dist/engine.js', import.meta.url));

globalThis.fetch = async () => new Response('{"message":"not in this test"}', { status: 503, headers: { 'content-type': 'application/json' } });

const shared = await import('./engine.mjs');
const models = await import('./models.mjs');
after(() => rm(home, { recursive: true }));

const call = (method, payload) => models.ROUTES[`${method} /api/models`]({ body: async () => payload });
const choice = (model, effort = 'same') => ({ model, effort });
const row = (view, key) => view.tasks.find((t) => t.key === key);

async function startOnce(shell = {}) {
  await shared.loadEngine({ matrixEngine }, () => {});
  models.start({}, shell);
}

beforeEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  await rm(join(home, '.config'), { recursive: true, force: true });
});

test('the Models view lists every task in order, with what it runs on, the fresh and suggested choice, effort only where Claude Code takes it, and the tokens each spent', async () => {
  await startOnce();
  shared.engine.recordUsage('kickoff', 1_250_000);
  shared.engine.recordUsage('reads', 4200);
  const view = await call('GET');
  assert.deepEqual(view.tasks.map((t) => t.key), ['review', 'fix', 'kickoff', 'ticket', 'message', 'panel', 'builders', 'reads', 'ticketDrafts', 'replyDrafts']);
  assert.deepEqual(view.tasks.map((t) => t.label), ['Review', 'Fix', 'Kickoff', 'Ticket agent', 'Message agent', 'Claude panel', 'Builders', 'Triage and reads', 'Ticket drafts', 'Reply drafts']);
  assert.deepEqual(view.tasks.filter((t) => !t.effort).map((t) => t.key), ['builders'], 'no effort for subagents: the CLI has none');
  assert.deepEqual([row(view, 'kickoff').current, row(view, 'kickoff').suggested], [choice('default'), choice('opus')]);
  assert.deepEqual([row(view, 'reads').current, row(view, 'reads').fresh], [choice('haiku'), choice('haiku')]);
  assert.deepEqual(view.tasks.map((t) => t.tokens), [0, 0, 1_250_000, 0, 0, 0, 0, 4200, 0, 0]);
  assert.equal(view.usageDays, 7);
  assert.equal(row(view, 'builders').uncounted, 'counted in the agent that spawned them');
  assert.equal(row(view, 'panel').uncounted, null, 'the panel\'s chat run in the background is counted');
  models.start({}, { desktop: { openTerminal() {} } });
  assert.equal(row(await call('GET'), 'panel').uncounted, 'not counted while the panel runs Claude Code in a terminal');
});

test('a model or effort is saved for one task at a time, a full model ID passes through trimmed, and anything else is refused with nothing saved', async () => {
  await startOnce();
  const saved = await call('POST', { task: 'review', model: 'sonnet' });
  assert.equal(saved.text, 'Review runs on Sonnet from its next start');
  assert.deepEqual(row(saved, 'review').current, choice('sonnet'));
  assert.equal((await call('POST', { task: 'fix', model: '  claude-opus-5-5[1m] ' })).text, 'Fix runs on claude-opus-5-5[1m] from its next start');
  assert.equal((await call('POST', { task: 'fix', effort: 'xhigh' })).text, 'Fix runs on extra high effort from its next start');
  assert.deepEqual(shared.engine.loadSettings().models.fix, choice('claude-opus-5-5[1m]', 'xhigh'));
  for (const bad of [{ task: 'fix', model: '--dangerously-skip-permissions' }, { task: 'fix', model: 'opus && rm -rf ~' }, { task: 'fix', effort: 'ludicrous' }, { task: 'builders', effort: 'high' }, { task: 'nothing', model: 'opus' }, { task: 'fix' }, { preset: 'cheapest' }]) {
    await assert.rejects(call('POST', bad), { status: 400 }, JSON.stringify(bad));
  }
  assert.deepEqual(shared.engine.loadSettings().models.fix, choice('claude-opus-5-5[1m]', 'xhigh'));
});

test('only the Builders row has Force on every builder: off to start, saved from the page, kept through a model change, switched off by both presets, and refused anywhere else', async () => {
  await startOnce();
  const view = await call('GET');
  assert.deepEqual(view.tasks.filter((t) => t.force).map((t) => t.key), ['builders']);
  assert.equal(Boolean(row(view, 'builders').current.force), false, 'off to start');
  const on = await call('POST', { task: 'builders', force: true });
  assert.equal(on.text, 'Builders override a subagent\'s own model from their next start');
  assert.equal(row(on, 'builders').current.force, true);
  assert.deepEqual(models.panelLaunch(), {}, 'on Claude Code\'s default there is no model to force');
  const named = await call('POST', { task: 'builders', model: 'haiku' });
  assert.deepEqual(row(named, 'builders').current, { model: 'haiku', effort: 'default', force: true }, 'a model change leaves the switch where it was');
  assert.deepEqual(models.panelLaunch(), { subagentModel: 'haiku', subagentForce: true });
  assert.equal((await call('POST', { task: 'builders', force: false })).text, 'Builders leave a subagent\'s own model alone from their next start');
  assert.deepEqual(models.panelLaunch(), { subagentModel: 'haiku' });
  for (const bad of [{ task: 'review', force: true }, { task: 'builders', force: 'yes' }]) await assert.rejects(call('POST', bad), { status: 400 }, JSON.stringify(bad));
  for (const preset of ['suggested', 'default']) {
    await call('POST', { task: 'builders', model: 'opus', force: true });
    assert.equal(Boolean(row(await call('POST', { preset }), 'builders').current.force), false, `${preset} switches it off`);
  }
});

test('Use suggested tiers puts every task on its suggested model, and the reset puts every task on Claude Code\'s default', async () => {
  await startOnce();
  await call('POST', { every: 'high' });
  const suggested = await call('POST', { preset: 'suggested' });
  assert.equal(suggested.text, 'Each task runs on its suggested model, at the effort for every task, from its next start');
  assert.equal(suggested.everyEffort, 'high', 'Suggested leaves the effort for every task as it was');
  assert.ok(suggested.tasks.every((t) => t.current.model === t.suggested.model && t.current.effort === t.suggested.effort));
  assert.deepEqual(suggested.tasks.map((t) => t.current.model), ['sonnet', 'opus', 'opus', 'opus', 'sonnet', 'sonnet', 'default', 'haiku', 'haiku', 'sonnet']);
  assert.deepEqual(models.taskArgs('fix'), ['--model', 'opus', '--effort', 'high']);
  const reset = await call('POST', { preset: 'default' });
  assert.equal(reset.text, 'Each task runs on Claude Code\'s default model and effort from its next start');
  assert.equal(reset.everyEffort, 'default');
  assert.ok(reset.tasks.every((t) => t.current.model === 'default' && t.current.effort === (t.effort ? 'same' : 'default')));
  assert.deepEqual(models.taskArgs('reads'), [], 'not even the reads pass a model then');
});

test('the effort for every task reaches every read and draft set to Same as every task, and the panel, while a row\'s own effort wins and Claude Code\'s default on a row passes none', async () => {
  await startOnce();
  const view = await call('GET');
  assert.equal(view.everyEffort, 'default');
  assert.deepEqual(view.taskEfforts.map(([id]) => id), ['same', 'default', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(view.efforts.map(([id]) => id), ['default', 'low', 'medium', 'high', 'xhigh', 'max']);
  const saved = await call('POST', { every: 'high' });
  assert.equal(saved.text, 'Every task set to Same as every task runs on high effort from its next start');
  assert.equal(saved.everyEffort, 'high');
  assert.deepEqual(row(saved, 'reads').current, choice('haiku'), 'the row still follows it');
  for (const task of ['reads', 'ticketDrafts', 'replyDrafts']) assert.deepEqual(models.taskArgs(task).slice(-2), ['--effort', 'high'], task);
  assert.deepEqual(models.panelLaunch(), { effort: 'high' });
  await call('POST', { task: 'reads', effort: 'low' });
  assert.deepEqual(models.taskArgs('reads'), ['--model', 'haiku', '--effort', 'low']);
  assert.equal((await call('POST', { task: 'ticketDrafts', effort: 'default' })).text, 'Ticket drafts runs on Claude Code\'s default effort from its next start');
  assert.deepEqual(models.taskArgs('ticketDrafts'), ['--model', 'haiku']);
  assert.equal((await call('POST', { task: 'ticketDrafts', effort: 'same' })).text, 'Ticket drafts runs on the effort for every task from its next start');
  assert.deepEqual(models.taskArgs('ticketDrafts'), ['--model', 'haiku', '--effort', 'high']);
  for (const bad of [{ every: 'same' }, { every: 'ludicrous' }, { every: '' }]) await assert.rejects(call('POST', bad), { status: 400 }, JSON.stringify(bad));
  assert.equal(shared.engine.loadSettings().everyEffort, 'high');
});

test('a run\'s tokens are fresh input, what it wrote to the cache and its output, across every model it used, and a run with no usage counts nothing', () => {
  assert.equal(models.resultTokens({ modelUsage: { a: { inputTokens: 10, cacheCreationInputTokens: 100, cacheReadInputTokens: 9999, outputTokens: 5 }, b: { inputTokens: 1, outputTokens: 1 } } }), 117);
  assert.equal(models.resultTokens({ usage: { input_tokens: 3, cache_creation_input_tokens: 30, cache_read_input_tokens: 999, output_tokens: 7 } }), 40);
  assert.equal(models.resultTokens({}), 0);
  assert.equal(models.resultTokens(null), 0);
});
