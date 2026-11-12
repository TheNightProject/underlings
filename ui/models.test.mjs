import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { EFFORTS as EFFORT_NAMES, TASKS, taskOfKind } from '../lib/modeltiers.mjs';
import { openPage } from './testkit.mjs';

const AT = '2026-11-11T12:00:00Z';
const handle = (n) => `claude:0000000${n}-0000-4000-8000-000000000000`;
const choice = (model, effort = 'same') => ({ model, effort });
const MODELS = [['default', 'Claude Code\'s default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
const EFFORTS = [['default', 'Claude Code\'s default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const TASK_EFFORTS = [['same', 'Same as every task'], ...EFFORTS];

const task = (key, label, current, suggested, extra = {}) => ({ key, label, hint: 'does the ' + label.toLowerCase() + ' work.', effort: true, current, fresh: choice('default'), suggested, tokens: 0, uncounted: null, ...extra });

const VIEW = {
  models: MODELS, efforts: EFFORTS, taskEfforts: TASK_EFFORTS, everyEffort: 'default', usageDays: 7,
  tasks: [
    task('review', 'Review', choice('sonnet'), choice('sonnet'), { tokens: 1_250_000 }),
    task('fix', 'Fix', choice('default'), choice('opus')),
    task('kickoff', 'Kickoff', choice('claude-opus-5-5[1m]', 'high'), choice('opus')),
    task('builders', 'Builders', choice('default', 'default'), choice('default', 'default'), { effort: false, force: true, tokens: null, uncounted: 'counted in the agent that spawned them' }),
    task('reads', 'Triage and reads', choice('haiku'), choice('haiku'), { tokens: 4200 }),
  ],
};

function agent(n, extra = {}) {
  return {
    handle: handle(n), name: 'agent-' + n, title: 'task ' + n, kind: 'kickoff', mr: null, ticket: 'ABC-' + n, worktree: null, cwd: '/work',
    state: 'working', since: 1000 + n, lastAt: Date.parse(AT), alive: true, said: '', outcome: null, ask: null, model: null, effort: null, subagentModel: null, subagentForce: false, runningModel: null, ...extra,
  };
}

function snapshot(agents = []) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents, artifacts: [],
    attention: { cards: [], agents: [], system: [], count: 0, prefs: {}, toasts: [], offers: [] },
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

async function open({ hash = 'settings', agents = [], view = VIEW } = {}) {
  const posts = [];
  const page = await openPage({
    respond(path, init) {
      const url = new URL(path, 'http://page');
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push([url.pathname, body]);
        return { ok: true, text: 'Saved', ...view };
      }
      if (url.pathname === '/api/models') return view;
      if (url.pathname === '/api/agents/conversation') return { ...agents[0], entries: [], partial: null, pending: null };
      return null;
    },
  });
  page.show(snapshot(agents), hash);
  await page.settle(60);
  return Object.assign(page, { posts });
}

const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim();
const byId = (page, id) => page.document.getElementById(id);
const pressed = (page, key) => byId(page, 'model-row-' + key).querySelectorAll('.chip').filter((c) => c.getAttribute('aria-pressed') === 'true').map(text);

test('token counts read the same in every ICU build: k for thousands, M for millions', async () => {
  const page = await open();
  assert.equal(page.run('[0, 950, 38000, 96400, 410000, 1300000, 12600000].map(modelTokens).join(" ")'), '0 950 38k 96.4k 410k 1.3M 12.6M');
});

test('Settings has a Models group with a row a task, each on its model, with the effort only where Claude Code takes one, what it does and what it spent', async () => {
  const page = await open();
  assert.deepEqual(page.errors, []);
  const group = byId(page, 'model-settings');
  assert.equal(text(group.querySelector('h2')), 'Models');
  assert.deepEqual(group.querySelectorAll('.model-row').map((row) => text(row.childNodes[0])), ['Review', 'Fix', 'Kickoff', 'Builders', 'Triage and reads']);
  assert.deepEqual(byId(page, 'model-row-review').querySelectorAll('.chip').map(text), ['Claude Code\'s default', 'Opus', 'Sonnet', 'Haiku', 'Custom']);
  assert.deepEqual(['review', 'fix', 'kickoff', 'builders', 'reads'].map((k) => pressed(page, k)), [['Sonnet'], ['Claude Code\'s default'], ['Custom'], ['Claude Code\'s default'], ['Haiku']]);
  assert.equal(byId(page, 'model-kickoff-id').getAttribute('value'), 'claude-opus-5-5[1m]', 'a custom model shows the ID it runs on');
  assert.equal(byId(page, 'model-kickoff-effort').querySelectorAll('option').find((o) => o.selected)?.getAttribute('value'), 'high');
  assert.equal(byId(page, 'model-builders-effort'), null, 'no effort for subagents');
  assert.match(text(byId(page, 'model-row-review').querySelector('.hint')), /^Does the review work\. 1\.3M tokens in the last 7 days\.$/);
  assert.equal(text(byId(page, 'model-usage-fix')), 'No tokens in the last 7 days.');
  assert.equal(text(byId(page, 'model-usage-builders')), 'Counted in the agent that spawned them.');
});

test('the Builders row alone has Force on every builder, off with its hint to start, and a click saves it the other way', async () => {
  const page = await open();
  assert.equal(page.document.querySelectorAll('.model-force').length, 1);
  const row = byId(page, 'model-row-builders');
  const off = row.querySelector('#model-builders-force');
  assert.deepEqual([off.getAttribute('role'), off.getAttribute('aria-checked'), text(off)], ['switch', 'false', 'Off']);
  assert.equal(text(row.querySelector('.model-force label')), 'Force on every builder');
  assert.equal(row.querySelector('.model-force label').getAttribute('for'), 'model-builders-force');
  assert.match(text(row.querySelector('.model-force-hint')), /^Overrides a subagent that picks its own model, so every builder runs on the one above\./);
  off.click();
  await page.settle(60);
  const forced = { ...VIEW, tasks: VIEW.tasks.map((t) => (t.key === 'builders' ? { ...t, current: { model: 'haiku', effort: 'default', force: true } } : t)) };
  const onPage = await open({ view: forced });
  const on = byId(onPage, 'model-builders-force');
  assert.deepEqual([on.getAttribute('aria-checked'), text(on)], ['true', 'On']);
  on.click();
  await onPage.settle(60);
  assert.deepEqual(page.posts, [['/api/models', { task: 'builders', force: true }]]);
  assert.deepEqual(onPage.posts, [['/api/models', { task: 'builders', force: false }]]);
});

test('each row shows its suggested choice faintly, and marks the rows that differ from it', async () => {
  const page = await open();
  assert.deepEqual(['review', 'fix', 'kickoff', 'builders'].map((k) => text(byId(page, 'model-suggested-' + k))), ['Suggested: Sonnet', 'Suggested: Opus', 'Suggested: Opus', 'Suggested: Claude Code\'s default']);
  assert.deepEqual(['review', 'fix', 'kickoff', 'builders', 'reads'].map((k) => byId(page, 'model-suggested-' + k).classList.contains('differs')), [false, true, true, false, false]);
  assert.match(text(byId(page, 'model-settings').querySelector('.model-presets .hint')), /2 tasks differ from it now\.$/);
});

test('picking a model or an effort saves that one task at once, and a custom ID is typed and saved on Enter', async () => {
  const page = await open();
  byId(page, 'model-fix-sonnet').click();
  await page.settle(60);
  const effort = byId(page, 'model-review-effort');
  effort.value = 'low';
  page.fire(effort, 'change');
  await page.settle(60);
  byId(page, 'model-fix-custom').click();
  await page.settle(20);
  const typed = byId(page, 'model-fix-id');
  assert.equal(typed.getAttribute('value'), '', 'a new custom ID starts blank');
  typed.value = ' claude-sonnet-5-5-20261001 ';
  page.fire(typed, 'input');
  page.fire(byId(page, 'model-fix-id'), 'keydown', { key: 'Enter' });
  await page.settle(60);
  assert.deepEqual(page.posts, [
    ['/api/models', { task: 'fix', model: 'sonnet' }],
    ['/api/models', { task: 'review', effort: 'low' }],
    ['/api/models', { task: 'fix', model: 'claude-sonnet-5-5-20261001' }],
  ]);
});

test('Use suggested tiers and the reset each ask once more before they change every task', async () => {
  const page = await open();
  byId(page, 'g-models-suggested').click();
  await page.settle(20);
  assert.deepEqual(page.posts, [], 'the first click only arms it');
  assert.equal(text(byId(page, 'g-models-suggested')), 'Put every task on its suggested model, at the effort for every task?');
  byId(page, 'g-models-suggested').click();
  await page.settle(60);
  byId(page, 'g-models-default').click();
  await page.settle(20);
  assert.equal(text(byId(page, 'g-models-default')), 'Put every task and the effort for every task on Claude Code\'s default?');
  byId(page, 'g-models-default').click();
  await page.settle(60);
  assert.deepEqual(page.posts, [['/api/models', { preset: 'suggested' }], ['/api/models', { preset: 'default' }]]);
});

test('Effort for every task sits at the top of Models, saves at once, and each row that follows it says the effort it gets from there', async () => {
  const view = { ...VIEW, everyEffort: 'high' };
  const page = await open({ view });
  const group = byId(page, 'model-settings');
  const first = group.querySelectorAll('.setting')[0];
  assert.equal(first.id, 'model-every');
  assert.equal(text(first.childNodes[0]), 'Effort for every task');
  assert.deepEqual(first.querySelectorAll('.chip').map(text), ['Claude Code\'s default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  assert.deepEqual(first.querySelectorAll('.chip').filter((c) => c.getAttribute('aria-pressed') === 'true').map(text), ['High']);
  assert.equal(first.childNodes[0].getAttribute('for'), 'model-every-high');
  assert.deepEqual(byId(page, 'model-review-effort').querySelectorAll('option').map(text), ['Same as every task', 'Claude Code\'s default', 'Low', 'Medium', 'High', 'Extra high', 'Max']);
  assert.equal(text(byId(page, 'model-effective-review')), 'High, from every task');
  assert.equal(text(byId(page, 'model-effective-fix')), 'High, from every task');
  assert.equal(byId(page, 'model-effective-kickoff'), null, 'a row with its own effort says nothing more');
  assert.equal(byId(page, 'model-effective-builders'), null);
  byId(page, 'model-every-high').click();
  await page.settle(20);
  assert.deepEqual(page.posts, [], 'the effort already chosen saves nothing');
  byId(page, 'model-every-max').click();
  await page.settle(60);
  const effort = byId(page, 'model-kickoff-effort');
  effort.value = 'same';
  page.fire(effort, 'change');
  await page.settle(60);
  assert.deepEqual(page.posts, [['/api/models', { every: 'max' }], ['/api/models', { task: 'kickoff', effort: 'same' }]]);
});

test('a row that follows Claude Code\'s default for every task says so too', async () => {
  const page = await open();
  assert.equal(text(byId(page, 'model-effective-review')), 'Claude Code\'s default, from every task');
});

const rowOf = (page, n) => page.$('#main .agent[data-handle="' + handle(n) + '"]');
const launchOf = (node) => node.querySelectorAll('.model-launch span').map(text);

async function windowOf(page, n) {
  page.run('agentWinOpen(' + JSON.stringify(handle(n)) + ')');
  await page.settle(60);
  return page.$('#agent-window');
}

test('the Agents list and the agent window say what each agent runs on: what Claude Code said, else what it was started with', async () => {
  const agents = [
    agent(1, { model: 'opus', effort: 'high', subagentModel: 'haiku', runningModel: 'claude-opus-5-5' }),
    agent(2, { model: 'sonnet' }),
    agent(3),
  ];
  const page = await open({ hash: 'agents', agents });
  assert.deepEqual([1, 2, 3].map((n) => launchOf(rowOf(page, n))[0]), ['Opus 5.5', 'Sonnet', 'Claude Code\'s default']);
  assert.equal(rowOf(page, 1).querySelector('.model-launch').getAttribute('title'), 'Runs on Opus 5.5, high effort. Its subagents start on Haiku.');
  assert.equal(launchOf(await windowOf(page, 1))[0], 'Opus 5.5');
});

test('the Agents list and the agent window show an agent\'s effort, task type and builders after its model, in one line', async () => {
  const agents = [
    agent(1, { kind: 'kickoff', model: 'opus', effort: 'high', subagentModel: 'haiku', subagentForce: true, runningModel: 'claude-opus-5-5' }),
    agent(2, { kind: 'ticket', model: 'sonnet', effort: 'xhigh', subagentModel: 'sonnet' }),
  ];
  const page = await open({ hash: 'agents', agents });
  const wanted = [['Opus 5.5', 'High effort', 'Kickoff', 'builders on Haiku, forced'], ['Sonnet', 'Extra high effort', 'Ticket agent', 'builders on Sonnet']];
  assert.deepEqual([1, 2].map((n) => launchOf(rowOf(page, n))), wanted);
  assert.equal(rowOf(page, 1).querySelectorAll('.model-launch').length, 1, 'one line on a row');
  assert.equal(text(rowOf(page, 1).querySelector('.model-launch')), 'Opus 5.5 High effort Kickoff builders on Haiku, forced');
  for (const [n, facts] of [[1, wanted[0]], [2, wanted[1]]]) {
    const win = await windowOf(page, n);
    assert.deepEqual(launchOf(win), facts);
    const status = win.querySelector('.aw-meta').childNodes.map((c) => c.className);
    assert.deepEqual([status.at(-2), status.at(-1)], ['meta model-launch', 'meta'], 'between the state, phase and what it works for, and since');
    assert.match(text(win.querySelector('.aw-meta').childNodes.at(-1)), /^since /);
  }
});

test('an agent with nothing set says Claude Code\'s default model and effort, and names no builders, as does one from an engine that sends none of it', async () => {
  const { model, effort, subagentModel, subagentForce, runningModel, ...older } = agent(5);
  const agents = [agent(3, { kind: 'review' }), agent(4, { kind: null }), older];
  const page = await open({ hash: 'agents', agents });
  const wanted = [['Claude Code\'s default', 'Default effort', 'Review'], ['Claude Code\'s default', 'Default effort'], ['Claude Code\'s default', 'Default effort', 'Kickoff']];
  assert.deepEqual([3, 4, 5].map((n) => launchOf(rowOf(page, n))), wanted);
  assert.equal(rowOf(page, 3).querySelector('.model-launch').getAttribute('title'), 'Runs on Claude Code\'s default.');
  assert.doesNotMatch([3, 4, 5].map((n) => text(rowOf(page, n))).join(' '), /builders|undefined|null/);
  for (const [n, facts] of [[3, wanted[0]], [4, wanted[1]], [5, wanted[2]]]) assert.deepEqual(launchOf(await windowOf(page, n)), facts);
});

test('an agent\'s task type and effort are named as Models names them, for every kind of agent and every effort', async () => {
  const kinds = ['review', 'fix', 'kickoff', 'ticket', 'message', 'master'];
  const efforts = EFFORT_NAMES.filter(([id]) => id !== 'default');
  const agents = [...kinds.map((kind, i) => agent(i + 1, { kind })), ...efforts.map(([effort], i) => agent(i + 10, { effort }))];
  const page = await open({ hash: 'agents', agents });
  assert.deepEqual(kinds.map((kind, i) => launchOf(rowOf(page, i + 1))[2]), kinds.map((kind) => TASKS.find((t) => t.key === taskOfKind(kind)).label));
  assert.deepEqual(efforts.map((e, i) => launchOf(rowOf(page, i + 10))[1]), efforts.map(([, label]) => label + ' effort'));
  assert.deepEqual(launchOf(await windowOf(page, 6)).slice(2), ['Claude panel']);
});

test('the Agents list and the agent window say forced beside the builders\' model when it applied, and say nothing of it when it did not', async () => {
  const agents = [
    agent(1, { model: 'opus', subagentModel: 'haiku', subagentForce: true }),
    agent(2, { model: 'opus', subagentModel: 'haiku' }),
    agent(3, { model: 'opus', subagentForce: true }),
  ];
  const page = await open({ hash: 'agents', agents });
  const title = (n) => rowOf(page, n).querySelector('.model-launch').getAttribute('title');
  assert.deepEqual([1, 2, 3].map(title), ['Runs on Opus. Its subagents start on Haiku, forced.', 'Runs on Opus. Its subagents start on Haiku.', 'Runs on Opus.']);
  assert.deepEqual([1, 2, 3].map((n) => launchOf(rowOf(page, n)).slice(3)), [['builders on Haiku, forced'], ['builders on Haiku'], []]);
  const win = await windowOf(page, 1);
  assert.equal(win.querySelector('.model-launch').getAttribute('title'), 'Runs on Opus. Its subagents start on Haiku, forced.');
  assert.deepEqual(launchOf(win).slice(3), ['builders on Haiku, forced']);
});

test('every top-level name the Models file declares is its own, so it cannot replace another file\'s', async () => {
  const source = await readFile(new URL('./51-models.js', import.meta.url), 'utf8');
  const declared = [...source.matchAll(/^(?:async\s+)?function\s*\*?\s*(\w+)|^(?:const|let|var|class)\s+(\w+)/gm)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(declared.filter((name) => !/^(?:model|MODEL_)/i.test(name)), []);
});
