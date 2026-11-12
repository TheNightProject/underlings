import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const state = mkdtempSync(join(tmpdir(), 'move-targets-'));
process.env['UNDERLINGS_STATE_DIR'] = state;
const { changeSettings } = await import('./data/store.js');
const { DEFAULT_JIRA } = await import('./settings.js');
const { moveTargets } = await import('./tickets.js');
const { TEAM_JIRA, TEAM_STATUSES } = await import('./jira.testkit.js');

after(() => rmSync(state, { recursive: true, force: true }));
beforeEach(() => changeSettings((s) => ({ ...s, jira: DEFAULT_JIRA })));

const TEAM_MENU = TEAM_STATUSES.filter((status) => status !== 'In Progress');

test('with a workflow named in the settings, an In Progress ticket offers every other status of it, in order', () => {
  changeSettings((s) => ({ ...s, jira: TEAM_JIRA }));
  assert.deepEqual(moveTargets('In Progress', ['In Progress', 'QA', 'To Do']), TEAM_MENU);
});

test('the statuses you name come first, in your order, then any other status seen on your tickets', () => {
  changeSettings((s) => ({ ...s, jira: { ...DEFAULT_JIRA, statuses: 'Backlog, Doing, Shipped' } }));
  assert.deepEqual(moveTargets('Doing', ['Doing', 'Testing', 'Backlog']), ['Backlog', 'Shipped', 'Testing']);
});
