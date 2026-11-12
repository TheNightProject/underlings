import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workspaceRoot, type RepoSpec } from './config.js';
import { labelRepos } from './data/gitlab.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_CHROME_ROWS,
  applyFilter,
  matchRepo,
  parseFilter,
  repoListRows,
  requestRate,
} from './settings.js';

const REPOS: RepoSpec[] = [
  { path: 'acme/platform/frontend', label: 'Frontend' },
  { path: 'acme/platform/services/order-book', label: 'Order Book' },
  { path: 'acme/platform/spikes/throwaway', label: 'Throwaway' },
  { path: 'acme/engine', label: 'Engine' },
  { path: 'other/thing', label: 'Thing' },
];

const paths = (filter: string): string[] => applyFilter(REPOS, filter).map((r) => r.path);

test('an empty filter keeps every repo that was discovered', () => {
  assert.equal(applyFilter(REPOS, '').length, REPOS.length);
  assert.equal(applyFilter(REPOS, '   ').length, REPOS.length);
  assert.equal(DEFAULT_SETTINGS.repoFilter, '', 'nothing is hidden until you say so');
});

test('a bare word matches anywhere in the path, which is how you would type it', () => {
  assert.deepEqual(paths('frontend'), ['acme/platform/frontend']);
  assert.deepEqual(paths('ENGINE'), ['acme/engine'], 'case does not matter');
});

test('a path or a wildcard is matched whole, so one repo cannot match by accident', () => {
  assert.deepEqual(paths('acme/platform/*'), [
    'acme/platform/frontend',
    'acme/platform/services/order-book',
    'acme/platform/spikes/throwaway',
  ]);
  assert.deepEqual(paths('acme/engine'), ['acme/engine']);
  assert.deepEqual(paths('acme/eng'), [], 'an anchored pattern is not a prefix match');
});

test('several patterns are an or, so a filter can name two trees', () => {
  assert.deepEqual(paths('acme/engine, other/*'), ['acme/engine', 'other/thing']);
});

test('an exclude wins wherever it is written, not just when it is written last', () => {
  const first = paths('!*/spikes/*, acme/platform/*');
  const last = paths('acme/platform/*, !*/spikes/*');
  assert.deepEqual(first, last, 'order must not change the answer');
  assert.ok(!first.includes('acme/platform/spikes/throwaway'));
  assert.equal(first.length, 2);
});

test('excludes on their own subtract from everything', () => {
  assert.deepEqual(paths('!other/*'), [
    'acme/platform/frontend',
    'acme/platform/services/order-book',
    'acme/platform/spikes/throwaway',
    'acme/engine',
  ]);
});

test('a pattern with regex characters is matched literally, not as a regex', () => {
  const odd: RepoSpec[] = [
    { path: 'acme/a.b', label: 'ab' },
    { path: 'acme/axb', label: 'axb' },
  ];
  assert.deepEqual(
    applyFilter(odd, 'acme/a.b').map((r) => r.path),
    ['acme/a.b'],
    'the dot must not match any character',
  );
});

test('a filter matching nothing says so by matching nothing, not by matching all', () => {
  assert.deepEqual(paths('nosuchrepo'), []);
  assert.equal(matchRepo('acme/engine', parseFilter('nosuchrepo')), false);
});

test('a repo is labelled by the shortest tail that still tells it apart', () => {
  const labels = labelRepos([
    'acme/platform/services/acme-engine-graphql',
    'acme/platform/frontend',
    'acme/platform/services/order-book',
  ]);
  assert.deepEqual(
    labels.map((r) => r.label),
    ['Engine Graphql', 'Frontend', 'Order Book'],
    'a long name loses its leading words, it does not get truncated',
  );
  for (const r of labels) assert.ok(r.label.length <= 16, `${r.label} is too wide for the column`);
});

test('two repos that would share a label are given a word back until they separate', () => {
  const labels = labelRepos(['acme/orbit/orbit-api', 'acme/kaidos/kaidos-api', 'acme/one/api']);
  assert.equal(new Set(labels.map((r) => r.label)).size, 3, 'every label must be distinct');
  assert.ok(labels.some((r) => r.label === 'Orbit Api'));
  assert.ok(labels.some((r) => r.label === 'Kaidos Api'));
});

test('a one-word repo keeps its one word however long it is', () => {
  const [only] = labelRepos(['acme/averyveryverylongsinglewordname']);
  assert.equal(only?.label, 'Averyveryverylongsinglewordname', 'there is nothing to drop');
});

test('repos with the same name in different groups are told apart by their group', () => {
  // Two repos literally called `common` cannot separate inside their own name, so the
  // label has to reach up into the parent.
  const labels = labelRepos(['acme/studio/common', 'acme/labs/common', 'acme/one/frontend']);
  assert.equal(new Set(labels.map((r) => r.label)).size, 3, 'every label must be distinct');
  assert.deepEqual(
    labels.map((r) => r.label).sort(),
    ['Frontend', 'Labs Common', 'Studio Common'],
  );
});

test('the settings pane never asks for more lines than it has', () => {
  // It cannot scroll, so one line too many pushes the title off the top of the terminal
  // and the first setting with it, which is exactly where the repo filter lives.
  for (const height of [10, 20, 41, 80, 200]) {
    for (const total of [0, 1, 5, 95, 500]) {
      const listed = repoListRows(height, total);
      const more = total > listed ? 1 : 0;
      assert.ok(
        SETTINGS_CHROME_ROWS + listed + more <= Math.max(height, SETTINGS_CHROME_ROWS + 1),
        `height ${height} with ${total} repos drew ${SETTINGS_CHROME_ROWS + listed + more} lines`,
      );
      assert.ok(listed <= total, 'it cannot list repos that are not there');
    }
  }
});

test('a short list is shown whole, with no "and more" line', () => {
  assert.equal(repoListRows(80, 5), 5);
  assert.equal(repoListRows(SETTINGS_CHROME_ROWS + 3, 3), 3);
});

test('the request rate is what trips the limit: queries times refreshes', () => {
  // 20 queries every 15 seconds is 80 a minute, which is what caused the 429.
  assert.deepEqual(requestRate(20, 15), { perRefresh: 20, perMinute: 80, heavy: true });
  assert.deepEqual(requestRate(20, 90), { perRefresh: 20, perMinute: 13, heavy: false });
  assert.equal(requestRate(3, 15).heavy, false, 'a narrow filter makes a short interval fine');
  assert.ok(requestRate(5, 0).perMinute > 0, 'a nonsense interval must not divide by zero');
});

test('the workspace root prefers the setting over where you happened to start', () => {
  // Running from a home directory is normal; assuming the working directory is the
  // checkout is what made every launch fail with "No Orca workspace covers /Users/<me>".
  assert.equal(workspaceRoot('/home/dev/work'), '/home/dev/work');
  assert.equal(workspaceRoot('  /home/dev/work  '), '/home/dev/work', 'typed-in whitespace');
  assert.equal(workspaceRoot(''), process.env['ORCA_WORKSPACE_ROOT'] ?? process.cwd());
  assert.equal(workspaceRoot(undefined), process.env['ORCA_WORKSPACE_ROOT'] ?? process.cwd());
  assert.equal(workspaceRoot('   '), process.env['ORCA_WORKSPACE_ROOT'] ?? process.cwd());
});
