import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const NOW = Date.now();
const iso = (minutes) => new Date(NOW + minutes * 60_000).toISOString();

function snapshot(features = { scheduled: true }) {
  return {
    generatedAt: iso(0), version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [], features,
    matrix: { available: false, error: 'not needed here' },
  };
}

const routine = (extra = {}) => ({
  id: 'trig_01', name: 'Nightly report', about: 'Builds the nightly report.', cron: '0 8-19 * * 1-5', schedule: 'Hourly, 8am to 7pm, weekdays',
  enabled: true, nextRunAt: iso(55), lastRunAt: iso(-5), lastFinishedAt: iso(-4), lastStatus: 'succeeded', ...extra,
});

async function open({ data, features, hash = 'scheduled' } = {}) {
  const posts = [];
  const page = await openPage({
    respond(path, init) {
      if (path === '/api/routines/refresh') { posts.push(path); return data; }
      if (path === '/api/routines') return data;
      return null;
    },
  });
  page.show(snapshot(features), hash);
  await page.settle(60);
  return Object.assign(page, { posts });
}

const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim();
const rows = (page) => page.$$('#main .scheduled-row');

test('Scheduled sits under Work and lists each routine with its schedule, next run and last result', async () => {
  const page = await open({ data: { routines: [routine(), routine({ id: 'trig_02', name: 'Weekly digest', schedule: '9am, Mon', nextRunAt: iso(2000), lastStatus: 'failed' })], fetchedAt: iso(-1), error: null, loading: false } });
  assert.deepEqual(page.errors, []);
  assert.equal(text(page.$('#main .head h1')), 'Scheduled');
  assert.ok(page.$$('.navlink').some((a) => a.getAttribute('href') === '#scheduled'));
  assert.deepEqual(rows(page).map((r) => text(r.querySelector('.title'))), ['Nightly report', 'Weekly digest']);
  const [first, second] = rows(page);
  assert.equal(text(first.querySelector('.pill')), 'on');
  assert.match(text(first.querySelector('.foot')), /Hourly, 8am to 7pm, weekdays · next run in 5\d min · last run 5 min ago, succeeded/);
  assert.equal(text(second.querySelector('.pill')), 'last run failed');
  assert.match(text(second.querySelector('.foot')), /next run in 1 d/);
});

test('a paused routine says so and has no next run', async () => {
  const page = await open({ data: { routines: [routine({ enabled: false, nextRunAt: null })], fetchedAt: iso(-1), error: null, loading: false } });
  const [row] = rows(page);
  assert.equal(text(row.querySelector('.pill')), 'paused');
  assert.match(text(row.querySelector('.foot')), /paused/);
  assert.doesNotMatch(text(row.querySelector('.foot')), /next run/);
});

test('the page offers nothing that runs, edits or pauses a routine, only Refresh', async () => {
  const page = await open({ data: { routines: [routine()], fetchedAt: iso(-1), error: null, loading: false } });
  assert.ok(rows(page).every((r) => r.querySelectorAll('button').length === 0));
  assert.deepEqual(page.$$('#main button').map(text).filter(Boolean), ['Refresh']);
});

test('a failed read keeps the last list and says when it was read', async () => {
  const page = await open({ data: { routines: [routine()], fetchedAt: iso(-70), error: 'Claude refused the routines list', loading: false } });
  assert.equal(rows(page).length, 1);
  assert.match(text(page.$('#main .banner')), /The last read failed, so this is from 1 h ago: Claude refused the routines list/);
});

test('the first read failing is a banner and no list', async () => {
  const page = await open({ data: { routines: null, fetchedAt: null, error: 'this Claude Code has no routines tool', loading: false } });
  assert.match(text(page.$('#main .banner')), /Could not read the routines: this Claude Code has no routines tool/);
  assert.equal(rows(page).length, 0);
});

test('Refresh reads again and shows the new list', async () => {
  const page = await open({ data: { routines: [routine()], fetchedAt: iso(-1), error: null, loading: false } });
  page.$('#scheduled-refresh').click();
  await page.settle(60);
  assert.deepEqual(page.posts, ['/api/routines/refresh']);
});

test('with the feature off the page says so and does not read anything', async () => {
  const page = await open({ data: { routines: [routine()], fetchedAt: iso(-1), error: null, loading: false }, features: { scheduled: false } });
  assert.match(text(page.$('#main')), /Scheduled is off\. Turn it on in Settings/);
  assert.equal(rows(page).length, 0);
});
