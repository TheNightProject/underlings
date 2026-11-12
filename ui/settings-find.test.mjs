import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-11T12:00:00Z';
const EFFORTS = [['default', 'Claude Code\'s default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
const choice = (model, effort = 'same') => ({ model, effort });
const task = (key, label, hint, current) => ({ key, label, hint, effort: true, current, fresh: choice('default'), suggested: current, tokens: 0, uncounted: null });

const MODELS = {
  models: [['default', 'Claude Code\'s default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']],
  efforts: EFFORTS, taskEfforts: [['same', 'Same as every task'], ...EFFORTS], everyEffort: 'high', usageDays: 7,
  tasks: [task('review', 'Review', 'reviews someone else\'s MR.', choice('sonnet')), task('reads', 'Triage and reads', 'reads Slack and email for what needs you.', choice('haiku'))],
};

const SETTING_ROWS = [
  { key: 'pollSeconds', label: 'Refresh every', hint: 'how often GitLab is read, at the café or anywhere.', kind: 'number', value: 90, bounds: { min: 30, max: 600 } },
  { key: 'agentHost', label: 'Agent host', hint: 'where a background agent runs.', kind: 'choice', choices: [['claude', 'Claude Code'], ['orca', 'Orca']], value: 'claude' },
  { key: 'maxAgents', label: 'Most at once', hint: 'background agents running together.', kind: 'number', value: 4, bounds: { min: 0, max: 20 } },
];

const SLACK = { enabled: true, needsYou: true, keywords: ['incident'], skip: ['#random'], sign: true, signature: 'Sent by my underlings', everyMinutes: 15, budgetUsd: '0.50', window: { from: '08:00', to: '18:00' }, defaults: {} };

function snapshot() {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [],
    attention: { cards: [], agents: [], system: [], count: 0, prefs: {}, toasts: [], offers: [] },
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

function memory(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; } };
}

async function open({ hash = 'settings', session = memory() } = {}) {
  const page = await openPage({
    globals: { sessionStorage: session },
    respond(path, init) {
      const url = new URL(path, 'http://page');
      if (init?.method === 'POST') return { ok: true, text: 'Saved', ...MODELS };
      if (url.pathname === '/api/models') return MODELS;
      if (url.pathname === '/api/matrix/settings') return { rows: SETTING_ROWS, repos: null };
      if (url.pathname === '/api/slack/settings') return SLACK;
      return null;
    },
  });
  page.window.navigator.platform = 'MacIntel';
  page.show(snapshot(), hash);
  await page.settle(60);
  page.run('render()');
  return Object.assign(page, { session });
}

const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim();
const hidden = (node) => Boolean(node.closest('[hidden]'));
const groups = (page) => page.$$('#main section.settings-group').filter((g) => !g.hidden).map((g) => text(g.querySelector('h2')));
const rowsIn = (page, title) => {
  const group = page.$$('#main section.settings-group').find((g) => text(g.querySelector('h2')) === title);
  return group.querySelectorAll('.setting').filter((row) => !hidden(row)).map((row) => text(row.childNodes[0]));
};
const marks = (node) => node.querySelectorAll('mark.find-hit').map(text);
const press = (page, key, init = {}) => page.fire(init.target ?? page.document.activeElement, 'keydown', { key, ...init });

function type(page, value) {
  const box = page.$('#settings-q');
  box.value = value;
  page.fire(box, 'input');
}

test('the filter keeps the groups and rows whose label, hint, options or group title match, in any case or accent, and hides every group with none', async () => {
  const page = await open();
  assert.deepEqual(page.errors, []);
  const all = groups(page);
  assert.ok(all.includes('Models') && all.includes('Slack') && all.includes('Time and region'));

  type(page, 'EFFORT');
  assert.deepEqual(groups(page), ['Models']);
  assert.deepEqual(rowsIn(page, 'Models'), ['Effort for every task', 'Review', 'Triage and reads'], 'a row with an effort of its own to choose matches by that label too');

  type(page, 'slack sig');
  assert.ok(groups(page).includes('Slack'));
  assert.deepEqual(rowsIn(page, 'Slack'), ['Sign messages sent from ' + page.run('APP_NAME'), 'Signature']);

  type(page, 'time zone');
  assert.deepEqual(groups(page), ['Time and region']);
  assert.deepEqual(rowsIn(page, 'Time and region'), ['Time zone']);

  type(page, 'haiku');
  assert.deepEqual(rowsIn(page, 'Models'), ['Review', 'Triage and reads'], 'every row that offers Haiku as a choice');

  type(page, 'CAFE');
  assert.deepEqual(groups(page), ['Refresh every'], 'matched in a hint, without its accent');

  type(page, 'orca');
  assert.deepEqual(rowsIn(page, 'Running agents'), ['Agent host'], 'matched by a choice, and its group keeps only that row');

  type(page, 'running');
  assert.deepEqual(rowsIn(page, 'Running agents'), ['Agent host', 'Most at once'], 'a group title that matches keeps the whole group');

  type(page, 'running most');
  assert.deepEqual(rowsIn(page, 'Running agents'), ['Most at once'], 'words matched by the title and by a row together');
});

test('the matched words are highlighted in elements and text alone, in the label, hint, choices and group title', async () => {
  const page = await open();
  type(page, 'cafe refresh');
  const group = page.$$('#main section.settings-group').find((g) => !g.hidden);
  assert.deepEqual(marks(group.querySelector('h2')), ['Refresh']);
  assert.deepEqual(marks(group.querySelector('.setting')), ['Refresh', 'café']);
  assert.equal(text(group.querySelector('.setting .hint')), 'How often GitLab is read, at the café or anywhere.', 'the text reads as it did');
  type(page, 'orca');
  assert.deepEqual(marks(page.$('#set-agentHost-orca')), ['Orca']);
  type(page, 'sig');
  assert.deepEqual(marks(page.$('#slack-settings')), ['Sig', 'sig', 'Sig']);
  const source = await readFile(new URL('./36-settings-find.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/);
});

test('when nothing matches the page says so with a Clear button, which brings every setting back and leaves you in the box', async () => {
  const page = await open();
  const all = groups(page);
  type(page, 'zzqx');
  assert.deepEqual(groups(page), []);
  const none = page.$('#settings-find-none');
  assert.equal(text(none.querySelector('.empty')), 'No setting matches “zzqx”. Try a word from its name, its hint or one of its choices.');
  assert.equal(page.$('.settings-find-count'), null, 'said once, by the empty state');
  await page.settle(450);
  assert.equal(page.$('#settings-find-said').textContent, 'No setting matches zzqx.');
  none.querySelector('button').click();
  assert.equal(page.$('#settings-q').getAttribute('value'), '');
  assert.deepEqual(groups(page), all);
  assert.equal(page.$('#settings-find-none'), null);
  assert.equal(page.document.activeElement.id, 'settings-q');
});

test('/ puts you in the filter on Settings, Esc in it clears it and then leaves it, and Esc on the page clears it too', async () => {
  const page = await open();
  const all = groups(page);
  press(page, '/', { target: page.document.body });
  assert.equal(page.document.activeElement.id, 'settings-q');
  type(page, 'slack');
  assert.notDeepEqual(groups(page), all);
  press(page, 'Escape', { target: page.$('#settings-q') });
  assert.equal(page.$('#settings-q').getAttribute('value'), '');
  assert.deepEqual(groups(page), all);
  assert.equal(page.document.activeElement.id, 'settings-q', 'the first Esc only clears it');
  press(page, 'Escape', { target: page.$('#settings-q') });
  assert.notEqual(page.document.activeElement.id, 'settings-q');
  type(page, 'slack');
  page.$('#main').focus();
  press(page, 'Escape', { target: page.$('#main') });
  assert.deepEqual(groups(page), all);
});

test('j and k step only through the rows the filter shows', async () => {
  const page = await open();
  type(page, 'time zone');
  page.$('#main').focus();
  press(page, 'j', { target: page.$('#main') });
  const selected = page.$$('#main .is-selected');
  assert.deepEqual(selected.map((row) => text(row.childNodes[0])), ['Time zone']);
  press(page, 'j', { target: selected[0] });
  assert.deepEqual(page.$$('#main .is-selected').map((row) => text(row.childNodes[0])), ['Time zone'], 'no hidden row below it to land on');
});

test('the box has a label, and how many match is said politely once you stop typing', async () => {
  const page = await open();
  const box = page.$('#settings-q');
  assert.equal(box.closest('label').querySelector('.settings-find-hidden').textContent, 'Filter settings');
  assert.equal(box.getAttribute('type'), 'search');
  type(page, 'time zone');
  assert.equal(text(page.$('.settings-find-count')), '1 match in 1 group.');
  for (let i = 0; i < 60 && page.$('#settings-find-said')?.textContent !== '1 match in 1 group.'; i += 1) await page.settle(50);
  const said = page.$('#settings-find-said');
  assert.equal(said.getAttribute('role'), 'status');
  assert.equal(said.getAttribute('aria-live'), 'polite');
  assert.equal(said.textContent, '1 match in 1 group.');
  assert.ok(!page.$('#main').contains(said), 'it stays put while the page is drawn again');
});

test('the filter is kept for the tab, so a reload keeps it, and a new start does not', async () => {
  const session = memory();
  const first = await open({ session });
  type(first, 'time zone');
  assert.equal(session.data['cc.settings.find'], 'time zone');
  const reloaded = await open({ session });
  assert.equal(reloaded.$('#settings-q').getAttribute('value'), 'time zone');
  assert.deepEqual(groups(reloaded), ['Time and region']);
  type(reloaded, '');
  assert.equal(session.data['cc.settings.find'], undefined);
  const restarted = await open({ session: memory() });
  assert.equal(restarted.$('#settings-q').getAttribute('value'), '');
});

test('each setting is in the palette, and choosing one opens Settings on that row alone with its control focused', async () => {
  const page = await open({ hash: 'overview' });
  press(page, 'k', { metaKey: true, target: page.document.body });
  await page.settle(60);
  const search = (q) => {
    const input = page.$('#palette-q');
    input.value = q;
    page.fire(input, 'input');
    return page.$$('#palette [role="option"]').map((o) => text(o.querySelector('.palette-label')));
  };
  const found = search('effort for every');
  assert.equal(found[0], 'Settings: Effort for every task');
  assert.equal(text(page.$('#palette [role="option"] .palette-detail')), 'Models');
  assert.ok(search('slack sig').includes('Settings: Signature'));
  search('effort for every');
  press(page, 'Enter', { target: page.$('#palette-q') });
  assert.equal(page.window.location.hash, '#settings');
  page.run('render()');
  await page.settle(20);
  assert.equal(page.document.activeElement.id, 'model-every-high');
  assert.equal(page.$('#settings-q').getAttribute('value'), 'Effort for every task');
  assert.deepEqual(groups(page), ['Models']);
  assert.deepEqual(rowsIn(page, 'Models'), ['Effort for every task'], 'that row alone, though other rows have an effort');

  press(page, 'k', { metaKey: true, target: page.document.body });
  search('signature');
  const options = page.$$('#palette [role="option"]');
  options.find((o) => text(o.querySelector('.palette-label')) === 'Settings: Signature').click();
  await page.settle(20);
  assert.equal(page.document.activeElement.id, 'slack-signature');
  assert.deepEqual(rowsIn(page, 'Slack'), ['Signature']);
  type(page, 'signature');
  assert.deepEqual(rowsIn(page, 'Slack'), ['Sign messages sent from ' + page.run('APP_NAME'), 'Signature'], 'typing again filters as usual');
});

test('a label two groups share, or one named as a group, names its group in the palette, and a row named as its own group is left to the group\'s entry', async () => {
  const page = await open({ hash: 'overview' });
  page.run('settingsFindEntries(derive())');
  await page.settle(60);
  const labels = page.run('settingsFindEntries(derive()).map((e) => e.label)');
  assert.ok(labels.includes('Settings: Effort for every task'));
  assert.ok(!labels.includes('Settings: Slack') && !labels.includes('Settings: Slack in Slack'), 'the Slack switch in Slack has the group\'s own Settings: Slack already');
  assert.ok(labels.includes('Settings: Slack in Features'), 'a row named as another group says where it is');
  const on = labels.filter((label) => label.startsWith('Settings: On in '));
  assert.ok(on.length > 1, 'each feature\'s own On switch says which feature');
  assert.equal(new Set(labels).size, labels.length, 'no two entries read the same');
});
