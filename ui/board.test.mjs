import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-05T12:00:00Z';
const STAGES = ['reading merge requests', 'paging the busy repos', 'reading reviews', 'counting'];

function snapshot() {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

const score = (user, opened, reviewed, comments, approved) => ({ user, opened, reviewed, comments, approved, total: opened * 3 + reviewed * 3 + comments * 0.5 + approved });

function built(extra = {}) {
  return {
    scores: [score('abe', 6, 1, 2, 0), score('bo', 1, 9, 30, 4), score('cy', 2, 2, 2, 2), score('di', 0, 3, 1, 3), score('ed', 1, 0, 0, 0)],
    series: { opened: [1, 0, 3, 2], merged: [0, 1, 1, 0], reviews: [4, 9, 2, 6], days: 4 },
    since: '2026-11-02T12:00:00Z', days: 4, repos: 12, builtAt: Date.parse(AT), partial: [], bots: false,
    weights: { opened: 2, reviewed: 4, comments: 0.5, approved: 1 },
    ...extra,
  };
}

const idle = (board = built()) => ({ board, progress: null, startedAt: null, bots: board?.bots ?? false, error: null, stages: STAGES, missing: [] });

const LEGEND = {
  moods: [{ mood: 'awaitingYou', label: 'waiting on you' }, { mood: 'moved', label: 'the code changed under you' }],
  review: [{ phase: 'ready', glyph: '📝', colour: 'yellow', label: 'waiting for you to post' }],
  tickets: [{ phase: 'working', glyph: '🔄', colour: 'yellow', label: 'agent working' }],
  pipeline: [{ phase: null, glyph: '●', colour: 'green', label: 'passed' }],
  missing: [],
};

async function boardPage(answers) {
  const posts = [];
  const page = await openPage({
    respond: (path, init) => {
      if (init?.method === 'POST') posts.push([path, JSON.parse(init.body)]);
      return answers[path]?.(init) ?? null;
    },
  });
  page.show(snapshot(), 'leaderboard');
  await page.settle();
  return Object.assign(page, { posts });
}

const column = (page, n) => page.$$('#main .board-table tbody tr').map((tr) => tr.childNodes[n].textContent);

test('the leaderboard sorts by the column clicked, and medals the top three of that order', async () => {
  const page = await boardPage({ '/api/matrix/board': () => idle() });
  assert.deepEqual(column(page, 1), ['bo', 'abe', 'cy', 'di', 'ed']);
  assert.deepEqual(column(page, 0), ['🥇', '🥈', '🥉', '4', '5']);
  assert.equal(page.$('#main th[aria-sort]').textContent, 'Total');
  page.$('#board-sort-opened').focus();
  page.$('#board-sort-opened').click();
  assert.deepEqual(column(page, 1), ['abe', 'cy', 'bo', 'ed', 'di']);
  assert.equal(page.$('#main th[aria-sort]').textContent, 'Opened');
  assert.equal(page.document.activeElement.id, 'board-sort-opened');
});

test('a finished board shows its window, weights, partial repos and a chart per series', async () => {
  const page = await boardPage({ '/api/matrix/board': () => idle(built({ partial: ['acme/engine', 'acme/web'] })) });
  const text = page.$('#main').textContent;
  assert.match(text, /over the last 4 days, across 12 repos/);
  assert.match(text, /Points: 2 per MR opened, 4 per MR reviewed, 0.5 per comment, 1 per approval/);
  assert.match(text, /2 repos had more activity than one window could hold.*engine, web/);
  assert.deepEqual(page.$$('#main figure.board-chart figcaption b').map((b) => b.textContent), ['Opened', 'Merged', 'Reviews']);
  const reviews = page.$$('#main figure.board-chart polyline')[2].getAttribute('points').split(' ').map((p) => Number(p.split(',')[1]));
  assert.equal(Math.min(...reviews), 4, 'the busiest day reaches the top');
  assert.equal(page.$('#board-build').textContent, 'Rebuild');
});

test('while it builds, the four stages show how far it has got, with running totals and Build held off', async () => {
  const building = { board: null, startedAt: Date.now() - 12_000, bots: false, error: null, stages: STAGES, missing: [], progress: { phase: STAGES[2], step: 2, done: 1, total: 4, found: { mrs: 12, comments: 30 } } };
  const page = await boardPage({ '/api/matrix/board': () => building });
  const stages = page.$$('#main .board-stage');
  assert.deepEqual(stages.map((s) => s.className.split(' ')[1]), ['s-done', 's-done', 's-info', 's-quiet']);
  assert.equal(stages[2].getAttribute('aria-current'), 'step');
  assert.match(stages[2].textContent, /reading reviews1\/4$/);
  assert.equal(stages[2].querySelector('.bar').getAttribute('aria-valuenow'), '25');
  assert.match(page.$('#main').textContent, /12 merge requests, 30 comments · 12 s/);
  assert.equal(page.$('#board-build').disabled, true);
});

test('Build asks for one board, and turning service accounts on asks for a board that counts them', async () => {
  let current = idle(null);
  const page = await boardPage({
    '/api/matrix/board': (init) => {
      if (init?.method !== 'POST') return current;
      current = idle(built({ bots: JSON.parse(init.body).bots }));
      return { ...current, text: 'Building the board' };
    },
  });
  page.$('#board-build').click();
  await page.settle();
  assert.match(page.$('#toast').textContent, /Building the board/);
  assert.equal(page.$('#board-build').textContent, 'Rebuild');
  page.fire(page.$('#board-bots'), 'change', { target: { checked: true } });
  await page.settle();
  assert.deepEqual(page.posts, [['/api/matrix/board', { bots: false }], ['/api/matrix/board', { bots: true }]]);
  assert.equal(page.$('#board-bots').hasAttribute('checked'), true);
});

test('an engine build too old to build the board says so, and Build still asks, so the worker\'s 501 can offer the rebuild', async () => {
  const stale = { ...idle(null), missing: ['parseWeights'] };
  const page = await boardPage({ '/api/matrix/board': () => stale });
  const posts = [];
  page.window.fetch = async (path, init = {}) => {
    if (init.method === 'POST') {
      posts.push(path);
      return { ok: false, status: 501, json: async () => ({}), text: async () => 'The review engine needs rebuilding: this build has no parseWeights' };
    }
    const body = path === '/api/state' ? snapshot() : stale;
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  const text = page.$('#main').textContent;
  assert.match(text, /This review engine build cannot build the board: it has no parseWeights\./);
  assert.doesNotMatch(text, /npm run build|did not load/);
  assert.equal(page.$('#board-build').disabled, false);
  page.$('#board-build').click();
  await page.settle();
  assert.deepEqual(posts, ['/api/matrix/board']);
  assert.match(page.$('#toast').textContent, /needs rebuilding: this build has no parseWeights/);
});

test('with the self-heal file loaded, the board\'s and the key\'s stale notices both carry its Rebuild the engine', async () => {
  const legend = { ...LEGEND, review: [], pipeline: [], missing: ['REVIEW_LEGEND', 'PIPELINE_LEGEND'] };
  const page = await boardPage({ '/api/matrix/board': () => ({ ...idle(null), missing: ['parseWeights'] }), '/api/matrix/legend': () => legend });
  assert.equal(page.$('#rebuild-matrix'), null);
  page.run("window.rebuildButton = () => el('button', { id: 'rebuild-matrix' }, 'Rebuild the engine')");
  page.run('render(true)');
  assert.ok(page.$('#main .banner #rebuild-matrix'), 'the board\'s notice has no Rebuild');
  page.$('#legend-toggle').click();
  await page.settle();
  assert.ok(page.$('#legend .banner #rebuild-matrix'), 'the key\'s notice has no Rebuild');
  assert.doesNotMatch(page.$('#legend').textContent, /npm run build/);
});

test('the table keeps its sideways scroll through every refresh, so a phone keeps the right-hand columns in view', async () => {
  const page = await boardPage({ '/api/matrix/board': () => idle() });
  const wrap = () => page.$('#main .tablewrap');
  const first = wrap();
  first.scrollLeft = 182;
  page.fire(first, 'scroll');
  page.run('render(true)');
  await page.settle(0);
  assert.notEqual(wrap(), first, 'the table is a new node after a render');
  assert.equal(wrap().scrollLeft, 182);
  page.show({ ...snapshot(), generatedAt: '2026-11-05T12:00:30Z' }, 'leaderboard');
  await page.settle();
  assert.equal(wrap().scrollLeft, 182, 'a new snapshot renders twice, once more after its board fetch');
});

test('the ? in every view header opens the key, which Esc closes, handing focus back', async () => {
  const page = await boardPage({ '/api/matrix/board': () => idle(), '/api/matrix/legend': () => LEGEND });
  for (const name of Object.keys(page.run('VIEWS'))) {
    page.show(snapshot(), name);
    assert.ok(page.$('#main .head #legend-toggle'), name + ' has no ?');
  }
  page.show(snapshot(), 'merge-requests');
  page.$('#legend-toggle').click();
  await page.settle();
  const legend = page.$('#legend');
  assert.equal(legend.hidden, false);
  assert.equal(page.$('#legend-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(page.document.activeElement, legend);
  assert.deepEqual(page.$$('#legend h3').map((h) => h.textContent), ['Row colour', 'Review', 'Pipeline', 'Ticket badges']);
  assert.deepEqual(page.$$('#legend .pill').map((p) => p.textContent), ['Waiting on me', 'Code moved']);
  assert.ok(page.$('#legend .pipe'), 'the pipeline glyph is shown beside the chip this page draws');
  page.run('render()');
  assert.equal(page.$('#legend').hidden, false);
  page.fire(page.document, 'keydown', { key: 'Escape' });
  assert.equal(legend.hidden, true);
  assert.equal(page.document.activeElement.id, 'legend-toggle');
  assert.equal(page.$('#legend-toggle').getAttribute('aria-expanded'), 'false');
});

test('a click elsewhere closes the key, and a stale engine build says what the key is missing until it is rebuilt', async () => {
  let legend = { ...LEGEND, review: [], missing: ['REVIEW_LEGEND'] };
  const page = await boardPage({ '/api/matrix/board': () => idle(), '/api/matrix/legend': () => legend });
  page.$('#legend-toggle').click();
  await page.settle();
  assert.match(page.$('#legend').textContent, /This review engine build has no REVIEW_LEGEND, so part of the key is missing/);
  assert.ok(!page.$$('#legend h3').some((h) => h.textContent === 'Review'));
  page.$('#legend .legend-head h2').click();
  assert.equal(page.$('#legend').hidden, false);
  page.$('#main .board-table').click();
  assert.equal(page.$('#legend').hidden, true);
  legend = LEGEND;
  page.$('#legend-toggle').click();
  await page.settle();
  assert.doesNotMatch(page.$('#legend').textContent, /stays partial/);
  assert.ok(page.$$('#legend h3').some((h) => h.textContent === 'Review'));
});
