import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const state = mkdtempSync(join(tmpdir(), 'models-'));
process.env['UNDERLINGS_STATE_DIR'] = state;
const { changeSettings, loadSettings } = await import('./data/store.js');
const { agentLaunch, applyModelPreset, modelUsage, recordUsage, saveEveryEffort, saveModel } = await import('./models.js');
const { DEFAULT_SETTINGS } = await import('./settings.js');
const { modelArgs, subagentEnv } = await import('../../lib/modeltiers.mjs');
const { STATE_FILE } = await import('./config.js');

after(() => rmSync(state, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
});

const saved = () => JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const choice = (model: string, effort = 'same') => ({ model, effort });
const BUILDERS = { model: 'default', effort: 'default' };
const KINDS = ['review', 'fix', 'kickoff', 'ticket', 'master', 'message'] as const;
const FRESH = {
  review: choice('default'), fix: choice('default'), kickoff: choice('default'), ticket: choice('default'), message: choice('default'), panel: choice('default'),
  builders: BUILDERS, reads: choice('haiku'), ticketDrafts: choice('haiku'), replyDrafts: choice('sonnet'),
};
const SUGGESTED = {
  review: choice('sonnet'), fix: choice('opus'), kickoff: choice('opus'), ticket: choice('opus'), message: choice('sonnet'), panel: choice('sonnet'),
  builders: BUILDERS, reads: choice('haiku'), ticketDrafts: choice('haiku'), replyDrafts: choice('sonnet'),
};
const RESET = Object.fromEntries(Object.keys(FRESH).map((task) => [task, task === 'builders' ? BUILDERS : choice('default')]));

test('a fresh install runs every agent on Claude Code\'s default, the reads and ticket drafts on Haiku and the reply drafts on Sonnet, as before', () => {
  assert.deepEqual(DEFAULT_SETTINGS.models, FRESH);
  assert.deepEqual(loadSettings().models, FRESH);
  for (const kind of KINDS) assert.deepEqual(agentLaunch(kind), {}, `${kind} passes no model, effort or builders' model`);
});

test('each kind of agent starts on its own task\'s model and effort, the Claude panel\'s chat on the panel\'s, and its subagents on the builders\'', () => {
  const models = { review: choice('sonnet', 'low'), fix: choice('opus', 'high'), kickoff: choice('opus', 'max'), ticket: choice('claude-opus-5-5'), message: choice('haiku'), panel: choice('sonnet', 'medium'), builders: choice('haiku', 'default') };
  changeSettings((s) => ({ ...s, models: { ...s.models, ...models } }));
  const launched = Object.fromEntries(KINDS.map((kind) => [kind, agentLaunch(kind)]));
  assert.deepEqual(launched, {
    review: { model: 'sonnet', effort: 'low', subagentModel: 'haiku' },
    fix: { model: 'opus', effort: 'high', subagentModel: 'haiku' },
    kickoff: { model: 'opus', effort: 'max', subagentModel: 'haiku' },
    ticket: { model: 'claude-opus-5-5', subagentModel: 'haiku' },
    master: { model: 'sonnet', effort: 'medium', subagentModel: 'haiku' },
    message: { model: 'haiku', subagentModel: 'haiku' },
  });
});

test('a model is saved as an alias or a full model ID, and anything that could read as a flag or a shell word is refused', () => {
  assert.deepEqual(saveModel('review', { model: 'claude-sonnet-5-5-20261001' }).review, choice('claude-sonnet-5-5-20261001'));
  assert.deepEqual(saveModel('fix', { model: 'us.anthropic.claude-opus-5-5-v1:0', effort: 'xhigh' }).fix, choice('us.anthropic.claude-opus-5-5-v1:0', 'xhigh'));
  assert.deepEqual(saveModel('panel', { model: 'sonnet[1m]' }).panel, choice('sonnet[1m]'));
  for (const bad of ['', '--dangerously-skip-permissions', 'opus; rm -rf ~', 'opus --effort max', '$(whoami)', 'x'.repeat(130), 7]) {
    assert.throws(() => saveModel('review', { model: bad }), /a model is/, String(bad));
  }
  assert.throws(() => saveModel('review', { effort: 'extreme' }), /effort is/);
  assert.throws(() => saveModel('builders', { effort: 'high' }), /no effort setting for subagents/);
  assert.throws(() => saveModel('everything', { model: 'opus' }), /a task is one of/);
  assert.equal(loadSettings().models['review']?.model, 'claude-sonnet-5-5-20261001', 'a refused change leaves what was saved');
});

test('Force on every builder is saved on the Builders row alone, keeps through a model change, drops when switched off, and is refused anywhere else or as anything but a switch', () => {
  assert.deepEqual(saveModel('builders', { force: true })['builders'], { ...BUILDERS, force: true });
  assert.deepEqual(saveModel('builders', { model: 'haiku' })['builders'], { model: 'haiku', effort: 'default', force: true }, 'choosing a model leaves the switch where it was');
  assert.deepEqual(saveModel('builders', { force: false })['builders'], { model: 'haiku', effort: 'default' }, 'off writes nothing down');
  for (const [task, bad] of [['review', true], ['builders', 'yes'], ['builders', 1], ['builders', null]] as const) {
    assert.throws(() => saveModel(task, { force: bad }), /force is on or off|no subagents to force/, `${task} ${String(bad)}`);
  }
  assert.throws(() => saveModel('builders', {}), /say the model, the effort or whether to force it/);
  assert.deepEqual(loadSettings().models['builders'], { model: 'haiku', effort: 'default' }, 'a refused change leaves what was saved');
  writeFileSync(STATE_FILE, JSON.stringify({ watches: {}, seen: {}, settings: { models: { review: { model: 'sonnet', effort: 'same', force: true }, builders: { model: 'haiku', effort: 'default', force: 'yes' } } } }));
  assert.deepEqual(loadSettings().models['review'], choice('sonnet'), 'a row with no subagents never reads a switch');
  assert.deepEqual(loadSettings().models['builders'], { model: 'haiku', effort: 'default' }, 'only a true switch counts');
});

test('every agent starts with the builders forced when the switch is on and Builders names a model, and with neither the model nor the force otherwise', () => {
  saveModel('builders', { model: 'haiku', force: true });
  for (const kind of KINDS) assert.deepEqual(agentLaunch(kind), { subagentModel: 'haiku', subagentForce: true }, `${kind} forced`);
  saveModel('builders', { force: false });
  for (const kind of KINDS) assert.deepEqual(agentLaunch(kind), { subagentModel: 'haiku' }, `${kind} not forced`);
  saveModel('builders', { model: 'default', force: true });
  for (const kind of KINDS) assert.deepEqual(agentLaunch(kind), {}, `${kind} on Claude Code's default, whatever the switch`);
});

test('both presets switch the force off, and the subagent variables are the model alone, or the model with the force as 1, or nothing', () => {
  saveModel('builders', { model: 'haiku', force: true });
  assert.deepEqual(applyModelPreset('suggested')['builders'], BUILDERS);
  saveModel('builders', { force: true });
  assert.deepEqual(applyModelPreset('default')['builders'], BUILDERS);
  assert.deepEqual(subagentEnv({ model: 'haiku', force: true }), { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
  assert.deepEqual(subagentEnv({ model: 'haiku', force: false }), { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
  assert.deepEqual(subagentEnv({ model: 'haiku' }), { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' });
  for (const model of [undefined, 'default', '']) assert.deepEqual(subagentEnv({ model, force: true }), {}, `${String(model)} is no model, so nothing to force`);
});

test('a model saved by hand that is not a name is read as the fresh choice, so it never reaches claude', () => {
  writeFileSync(STATE_FILE, JSON.stringify({ watches: {}, seen: {}, settings: { models: { review: { model: '--yolo', effort: 'turbo' }, reads: { model: 'sonnet' } } } }));
  assert.deepEqual(loadSettings().models['review'], choice('default'));
  assert.deepEqual(loadSettings().models['reads'], choice('sonnet'));
  assert.deepEqual(agentLaunch('review'), {});
});

test('the suggested tiers put building and fixing on Opus, reviews and checks on Sonnet and the mechanical work on Haiku, and the reset puts every task on Claude Code\'s default', () => {
  saveModel('reads', { model: 'opus', effort: 'max' });
  assert.deepEqual(applyModelPreset('suggested'), SUGGESTED);
  assert.deepEqual(loadSettings().models, SUGGESTED);
  assert.deepEqual(applyModelPreset('default'), RESET);
  for (const kind of KINDS) assert.deepEqual(agentLaunch(kind), {});
  assert.throws(() => applyModelPreset('cheapest'), /a preset is suggested or default/);
});

test('a task set to Same as every task starts on the effort for every task, an effort of its own wins, and Claude Code\'s default on its row passes none', () => {
  assert.equal(saveEveryEffort('high'), 'high');
  saveModel('review', { model: 'sonnet' });
  saveModel('fix', { effort: 'low' });
  saveModel('kickoff', { effort: 'default' });
  saveModel('builders', { model: 'haiku' });
  assert.deepEqual(agentLaunch('review'), { model: 'sonnet', effort: 'high', subagentModel: 'haiku' });
  assert.deepEqual(agentLaunch('fix'), { effort: 'low', subagentModel: 'haiku' });
  assert.deepEqual(agentLaunch('kickoff'), { subagentModel: 'haiku' });
  assert.deepEqual(agentLaunch('master'), { effort: 'high', subagentModel: 'haiku' }, 'the Claude panel\'s chat follows it too');
  assert.equal(loadSettings().models['review']?.effort, 'same', 'the row still follows it, rather than copying it');
  for (const bad of ['same', 'turbo', '', 3]) assert.throws(() => saveEveryEffort(bad), /effort for every task is/, String(bad));
  assert.equal(loadSettings().everyEffort, 'high');
});

test('the effort for every task is read back only as an effort Claude Code takes, and starts at Claude Code\'s default', () => {
  assert.equal(DEFAULT_SETTINGS.everyEffort, 'default');
  writeFileSync(STATE_FILE, JSON.stringify({ watches: {}, seen: {}, settings: { everyEffort: '--yolo', models: { review: { model: 'opus', effort: 'same' } } } }));
  assert.equal(loadSettings().everyEffort, 'default');
  assert.deepEqual(agentLaunch('review'), { model: 'opus' });
  assert.deepEqual(modelArgs({ model: 'opus', effort: 'same' }), ['--model', 'opus'], 'a row still marked to follow never reaches claude as a flag');
});

test('Use suggested tiers leaves the effort for every task as it is and has every row follow it, and the reset puts it back to Claude Code\'s default', () => {
  saveEveryEffort('max');
  saveModel('review', { effort: 'low' });
  applyModelPreset('suggested');
  assert.equal(loadSettings().everyEffort, 'max');
  assert.deepEqual(agentLaunch('review'), { model: 'sonnet', effort: 'max' });
  applyModelPreset('default');
  assert.equal(loadSettings().everyEffort, 'default');
  assert.deepEqual(loadSettings().models, RESET);
  saveEveryEffort('high');
  assert.deepEqual(agentLaunch('review'), { effort: 'high' }, 'after the reset every row follows the effort for every task again');
});

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-11-11T12:00:00Z');

test('each task\'s tokens are counted over the last seven days, and nothing older or of no task counts', () => {
  recordUsage('review', 1200, NOW - 60_000);
  recordUsage('review', 800, NOW - 3 * DAY);
  recordUsage('kickoff', 5000, NOW - 6.9 * DAY);
  recordUsage('kickoff', 9000, NOW - 7.1 * DAY);
  recordUsage('reads', 300, NOW);
  recordUsage('nonsense', 999, NOW);
  recordUsage('fix', 0, NOW);
  assert.deepEqual(modelUsage(NOW), { days: 7, tokens: { review: 2000, kickoff: 5000, reads: 300 } });
  assert.deepEqual(modelUsage(NOW + 8 * DAY).tokens, {});
});

test('the count keeps a file a day and drops the ones two weeks old when a new day starts, never rewriting one being written', () => {
  recordUsage('review', 10, NOW - 20 * DAY);
  recordUsage('review', 10, NOW - 13 * DAY);
  assert.deepEqual(readdirSync(join(state, 'usage')).sort(), ['2026-10-22.jsonl', '2026-10-29.jsonl']);
  recordUsage('review', 10, NOW);
  assert.deepEqual(readdirSync(join(state, 'usage')).sort(), ['2026-10-29.jsonl', '2026-11-11.jsonl']);
  writeFileSync(join(state, 'usage', '2026-11-10.jsonl'), 'not json\n{"at":' + (NOW - DAY) + ',"task":"fix","tokens":40}\n');
  assert.deepEqual(modelUsage(NOW).tokens, { review: 10, fix: 40 }, 'a torn line is skipped');
  assert.ok(existsSync(join(state, 'usage', '2026-10-29.jsonl')), 'reading never deletes');
});
