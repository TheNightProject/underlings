import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { computeStats } from '../lib/stats.mjs';
import { openPage } from './testkit.mjs';

const H = 36e5;
const D = 24 * H;
const NOW = Date.now();
const before = (ms) => new Date(NOW - ms).toISOString();
const KEY = 'acme/engine!7';
const BODY = 'This authorises every caller.';

function item(extra = {}) {
  return { id: 'q' + Math.random(), projectPath: 'acme/engine', iid: 7, severity: 'MINOR', createdBy: 'review', createdAt: before(H), status: 'posted', postedAt: before(H), body: BODY, ...extra };
}

function figures(extra = {}) {
  return computeStats({
    now: NOW, timeZone: 'Europe/London', me: 'frank',
    rows: [
      { key: 'acme/engine!1', title: 'One', author: 'ivan', flags: { waitingOnYou: true }, approvedBy: [] },
      { key: 'acme/engine!2', title: 'Two', author: 'ivan', flags: { waitingOnYou: true }, approvedBy: [] },
      { key: 'acme/web!3', title: 'Mine', author: 'frank', flags: { mine: true }, approvedBy: [], mergeStatus: 'MERGEABLE' },
    ],
    history: [{ at: NOW - 7 * D, waiting: 5 }],
    queue: [
      item({ createdAt: before(20 * D) }),
      item({ createdAt: before(D) }), item({ createdAt: before(D) }), item({ createdAt: before(D), status: 'discarded' }),
      item({ createdAt: before(9 * D) }),
      item({ iid: 1, createdAt: before(3 * D - 2 * H) }),
      item({ iid: 2, createdAt: before(10 * D - H) }),
    ],
    runs: [],
    memory: {},
    gitlab: {
      reviewed: [{ key: 'acme/engine!1', author: 'ivan', createdAt: before(3 * D) }, { key: 'acme/engine!2', author: 'ivan', createdAt: before(10 * D) }],
      merged: [{ key: 'acme/web!9', title: 'Merged one', createdAt: before(4 * D), mergedAt: before(2 * D) }],
      fetchedAt: before(5 * 6e4),
    },
    ...extra,
  });
}

function snapshot({ agents = [], rows = [], queue = [], autoPasses = [] } = {}) {
  return {
    generatedAt: new Date(NOW).toISOString(),
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents,
    artifacts: [],
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: NOW, loading: false, error: null, repoCount: 1, rows },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue, runs: [], autoPasses,
    },
  };
}

async function overview({ stats = figures(), snap = snapshot() } = {}) {
  const asked = [];
  const page = await openPage({ respond: (path) => { asked.push(path); return path.startsWith('/api/stats?') ? stats : null; } });
  page.show(snap);
  await page.settle();
  const json = (code) => JSON.parse(page.run('JSON.stringify(' + code + ')'));
  return { ...page, asked, json };
}

// assert is never handed a page node: on a failure it would print the whole document it hangs from.
const tile = (page, id) => page.$('#stat-' + id);
const textOf = (node, selector) => node.querySelector(selector)?.textContent ?? null;
const css = (await Promise.all(['00-base.css', '10-overview.css', '11-charts.css'].map((name) => readFile(new URL('./' + name, import.meta.url), 'utf8')))).join('\n');
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({ selectors: selectors.split(',').map((s) => s.trim()), body }));
const styled = (node, pattern) => RULES.some((r) => pattern.test(r.body) && r.selectors.some((s) => /^[\w.#-]+$/.test(s) && node.matches(s)));

test('the Overview leads with the headline figures, each change signed and coloured by whether it is better', async () => {
  const page = await overview();
  assert.ok(page.asked.some((p) => /^\/api\/stats\?tz=/.test(p)), 'it asks for the figures with the page\'s time zone');
  const waiting = tile(page, 'waiting');
  assert.equal(textOf(waiting, '.stat-value'), '2');
  assert.equal(waiting.querySelector('.stat-delta').className, 'stat-delta good');
  assert.equal(textOf(waiting, '.stat-delta'), '−3 on the week before, better');
  assert.ok(waiting.querySelector('.stat-delta svg'), 'an arrow carries the direction as well as the colour');
  const first = tile(page, 'firstReview');
  assert.equal(textOf(first, '.stat-value'), '2 h');
  assert.equal(first.querySelector('.stat-delta').className, 'stat-delta bad');
  assert.equal(textOf(first, '.stat-delta'), '+1 h on the week before, worse');
  const findings = tile(page, 'findings');
  assert.deepEqual([textOf(findings, '.stat-value'), textOf(findings, '.stat-delta'), findings.querySelector('.stat-delta').className, textOf(findings, '.stat-note')],
    ['3', '+1 on the week before', 'stat-delta flat', '25% discarded']);
  const open = tile(page, 'open');
  assert.deepEqual([textOf(open, '.stat-value'), textOf(open, '.stat-delta'), open.querySelector('.stat-delta').className], ['1', 'No reading from a week ago yet', 'stat-delta none']);
  const runs = tile(page, 'runs');
  assert.ok(!runs.querySelector('.stat-value'), 'no zero stands in for a figure that is not known');
  assert.equal(textOf(runs, '.stat-empty'), 'No review run recorded yet');
  assert.equal(page.$$('#main .banner').length, 0);
});

test('a tile opens the view behind its figure', async () => {
  const page = await overview();
  assert.deepEqual(page.$$('#main .stat').map((a) => [a.id, a.getAttribute('href')]), [
    ['stat-waiting', '#merge-requests'], ['stat-firstReview', '#merge-requests'], ['stat-findings', '#review-queue'],
    ['stat-open', '#merge-requests'], ['stat-fullAuto', '#full-auto'], ['stat-runs', '#review-runs'],
  ]);
  tile(page, 'open').click();
  assert.equal(page.run('ui.mrScope'), 'mine');
});

test('the axis ticks are round counts, durations read in the largest unit that fits, and big counts are compact', async () => {
  const page = await overview();
  assert.deepEqual(page.json('[vizTicks(7), vizTicks(3), vizTicks(0), vizTicks(120), vizTicks(1)]'), [[0, 2, 4, 6, 8], [0, 1, 2, 3], [0, 1], [0, 50, 100, 150], [0, 1]]);
  assert.deepEqual(page.json('[3e4, 27e5, 54e5, 936e5, 2592e5, 10713e5].map(vizDuration)'), ['1 min', '45 min', '1.5 h', '26 h', '3 d', '12 d']);
  assert.deepEqual(page.json('[999, 1200, 15000].map(vizCompact)'), ['999', '1.2K', '15K']);
});

const svgOf = (page, code) => {
  page.run('window.__svg = ' + code);
  return page.window.__svg;
};
const all = (node, tag) => node.querySelectorAll(tag);
const num = (node, name) => Number(node.getAttribute(name));

test('stacked columns share one scale, stay at most 24px wide, keep a 2px gap between segments and round only the top', async () => {
  const page = await overview();
  const svg = svgOf(page, "vizColumns({ id: 't', width: 300, height: 190, tones: ['viz-c1', 'viz-c2', 'viz-c3'], columns: [[2, 1, 0], [0, 0, 0], [4, 0, 0]].map((values, i) => ({ label: 'D' + i, values, readout: { title: 'D' + i, rows: [] } })) })");
  assert.deepEqual(all(svg, 'text').filter((t) => t.getAttribute('class') === 'viz-tick').map((t) => t.textContent), ['0', '1', '2', '3', '4']);
  assert.deepEqual(all(svg, 'text').filter((t) => t.getAttribute('class') === 'viz-label').map((t) => t.textContent), ['D0', 'D1', 'D2']);
  const plot = 190 - 10 - 26;
  const [lower] = all(svg, 'rect').filter((r) => r.getAttribute('class') === 'viz-mark viz-c1');
  assert.ok(num(lower, 'width') <= 24);
  assert.equal(num(lower, 'height'), Math.round(((2 / 4) * plot - 2) * 10) / 10, 'the lower segment gives up 2px to the gap above it');
  const tops = all(svg, 'path');
  assert.deepEqual(tops.map((p) => p.getAttribute('class')), ['viz-mark viz-c2', 'viz-mark viz-c1']);
  assert.match(tops[1].getAttribute('d'), new RegExp('^M[\\d.]+,' + (10 + plot) + 'V'), 'the tallest column starts on the baseline');
  const hits = all(svg, 'rect').filter((r) => r.getAttribute('class') === 'viz-hit');
  assert.deepEqual(hits.map((h) => [h.id, h.getAttribute('tabindex'), h.getAttribute('aria-label')]), [['viz-t-0', '0', 'D0: '], ['viz-t-1', '0', 'D1: '], ['viz-t-2', '0', 'D2: ']]);
  const narrow = svgOf(page, "vizColumns({ id: 'n', width: 200, tones: ['viz-c1'], columns: Array.from({ length: 14 }, (_, i) => ({ label: 'D' + i, values: [1], readout: { title: '', rows: [] } })) })");
  assert.deepEqual(all(narrow, 'text').filter((t) => t.getAttribute('class') === 'viz-label').map((t) => t.textContent), ['D1', 'D5', 'D9', 'D13'], 'labels thin out from today backwards rather than collide');
});

test('horizontal bars put each total at its tip and shorten a label that would not fit', async () => {
  const page = await overview();
  const svg = svgOf(page, "vizBars({ id: 'b', width: 200, rows: [['A rather long label for this', [6]], ['B', [3]], ['C', [0]]].map(([label, values]) => ({ label, values, tones: ['viz-o3'], readout: { title: label, rows: [] } })) })");
  const values = all(svg, 'text').filter((t) => t.getAttribute('class') === 'viz-value');
  assert.deepEqual(values.map((t) => t.textContent), ['6', '3', '0']);
  const [long, short] = all(svg, 'path');
  const width = (p) => Number(/H([\d.]+)A/.exec(p.getAttribute('d'))[1]) - Number(/^M([\d.]+),/.exec(p.getAttribute('d'))[1]) + 4;
  assert.ok(Math.abs(width(long) - 2 * width(short)) < 0.5, 'bars share one scale');
  assert.ok(Math.abs(width(long) - (200 - 84 - 44)) < 0.5, 'the longest bar fills the plot, beside the labels and its value');
  const label = all(svg, 'text').find((t) => t.getAttribute('class') === 'viz-label');
  assert.match(label.textContent, /…$/);
  assert.ok(label.textContent.length < 'A rather long label for this'.length);
});

test('time to merge draws every MR as its own dot on a log scale of durations, with the median marked', async () => {
  const page = await overview();
  const svg = svgOf(page, "vizDots({ id: 'm', width: 500, median: 2 * 864e5, points: [36e5, 864e5, 2 * 864e5, 2 * 864e5, 9 * 864e5].map((ms) => ({ ms, readout: { title: 'x', rows: [] } })) })");
  const dots = all(svg, 'circle');
  assert.equal(dots.length, 5);
  assert.ok(dots.every((c) => c.getAttribute('tabindex') === '0'), 'each dot takes keyboard focus');
  const [a, b] = dots.filter((c) => c.id === 'viz-m-2' || c.id === 'viz-m-3');
  assert.equal(a.getAttribute('cx'), b.getAttribute('cx'));
  assert.notEqual(a.getAttribute('cy'), b.getAttribute('cy'), 'equal durations are pushed apart, not drawn over each other');
  assert.deepEqual(all(svg, 'text').filter((t) => t.getAttribute('class') === 'viz-tick').map((t) => t.textContent), ['1 h', '4 h', '1 d', '3 d', '1 w', '2 w']);
  assert.ok(all(svg, 'text').some((t) => t.textContent === 'median 2 d'));
  const x = (ms) => Number(dots.find((c) => c.id === 'viz-m-' + [36e5, 864e5].indexOf(ms)).getAttribute('cx'));
  assert.ok(x(864e5) - x(36e5) > 100, 'an hour and a day sit well apart on a log scale');
  const near = (dot) => ({ clientX: num(dot, 'cx') + 9, clientY: num(dot, 'cy') + 9 });
  const tip = () => page.$('#viz-tip');
  page.fire(svg, 'pointermove', near(dots[4]));
  assert.equal(tip().hidden, false, 'a pointer within reach of a dot shows it');
  assert.ok(dots[4].classList.contains('hot'));
  page.fire(page.document, 'scroll');
  assert.equal(tip().hidden, true);
  page.fire(svg, 'pointermove', near(dots[4]));
  assert.equal(tip().hidden, false, 'after a scroll the same dot shows its tip again');
  page.fire(svg, 'pointermove', { clientX: 2, clientY: 2 });
  assert.equal(tip().hidden, true, 'nothing within reach, no tip');
  assert.ok(!dots[4].classList.contains('hot'));
});

test('hovering or focusing a mark shows its readout, value first, and leaving it hides it', async () => {
  const page = await overview();
  const day = page.$('#viz-per-day-13');
  page.fire(day, 'pointerenter', { clientX: 40, clientY: 300 });
  const tip = page.$('#viz-tip');
  assert.equal(tip.hidden, false);
  const rows = tip.querySelectorAll('.viz-tip-row').map((r) => [r.querySelector('b').textContent, r.querySelector('b').parentNode.childNodes.at(-1).textContent, r.querySelector('.viz-key')?.className]);
  assert.deepEqual(rows.map(([, label, key]) => [label, key]), [
    ['posted', 'viz-key viz-c1'], ['discarded', 'viz-key viz-c2'], ['handed back', 'viz-key viz-c3'], ['waiting', 'viz-key viz-c4'], ['withdrawn or expired', 'viz-key viz-c5'],
  ]);
  assert.ok(rows.every(([value]) => /^\d+$/.test(value)));
  assert.equal(tip.style.left, '54px');
  page.fire(day, 'pointerleave');
  assert.equal(tip.hidden, true);
  const bar = page.$$('#viz-severity .viz-hit')[2];
  page.fire(bar, 'focus');
  assert.equal(tip.querySelector('.viz-tip-title').textContent, 'Minor');
  assert.deepEqual(tip.querySelectorAll('.viz-tip-row b').map((b) => b.textContent).slice(0, 2), ['4', '3']);
  page.fire(page.document, 'scroll');
  assert.equal(tip.hidden, true, 'a scroll drops the tip of a mark that does not have focus');
  bar.focus();
  page.fire(bar, 'focus');
  page.fire(page.document, 'scroll');
  assert.equal(tip.hidden, false, 'a focused mark keeps its tip through a scroll');
  page.fire(bar, 'blur');
  assert.equal(tip.hidden, true);
});

test('each chart draws from the worker\'s figures, with a table holding the same numbers, and an empty one says why', async () => {
  const page = await overview();
  for (const id of ['per-day', 'severity', 'stages', 'merge']) {
    const figure = page.$('#viz-' + id);
    assert.ok(figure.querySelector('.viz-plot svg'), id + ' is drawn');
    assert.ok(figure.querySelector('details.viz-table table'), id + ' has a table');
  }
  const perDay = page.$('#viz-per-day');
  assert.deepEqual(perDay.querySelectorAll('.viz-legend li').map((li) => li.textContent), ['Posted', 'Discarded', 'Handed back', 'Waiting', 'Withdrawn or expired']);
  const today = perDay.querySelectorAll('tbody tr').at(-1).querySelectorAll('td').map((td) => td.textContent);
  const yesterday = perDay.querySelectorAll('tbody tr').at(-2).querySelectorAll('td').map((td) => td.textContent);
  assert.ok([today, yesterday].some((cells) => cells.join() === '2,1,0,0,0'), 'the day with two posted and one discarded is in the table');
  const ages = page.$('#viz-ages');
  assert.ok(!ages.querySelector('.viz-plot'), 'an empty chart draws no plot');
  assert.equal(ages.querySelector('.viz-empty').textContent, 'Nothing is waiting for you to post or discard');
  assert.equal(page.$('#viz-people .viz-empty').textContent, 'Full auto has not reviewed anything yet');
});

test('findings by severity add up: raised is what was posted, discarded, handed back, waiting and withdrawn, in the readout and the table', async () => {
  const queue = [
    item({ createdAt: before(20 * D) }),
    item({ severity: 'NIT', createdAt: before(D) }),
    item({ severity: 'NIT', createdAt: before(D), status: 'pending', postedAt: null }),
    item({ severity: 'NIT', createdAt: before(D), status: 'discarded', postedAt: null, auto: { superseded: 'a newer pass replaced it' } }),
  ];
  const page = await overview({ stats: figures({ queue }) });
  page.fire(page.$$('#viz-severity .viz-hit')[3], 'focus');
  const rows = page.$('#viz-tip').querySelectorAll('.viz-tip-row').map((r) => [r.querySelector('b').textContent, r.childNodes.at(-1).textContent]);
  assert.deepEqual(rows, [['3', 'raised'], ['1', 'posted'], ['0', 'discarded'], ['0', 'handed back'], ['1', 'waiting'], ['1', 'withdrawn or expired']]);
  const table = page.$('#viz-severity table');
  assert.deepEqual(table.querySelectorAll('thead th').map((th) => th.textContent), ['Severity', 'Raised', 'Posted', 'Discarded', 'Handed back', 'Waiting', 'Withdrawn or expired']);
  assert.deepEqual(table.querySelectorAll('tbody tr')[3].childNodes.map((c) => c.textContent), ['Nit', '3', '1', '0', '0', '1', '1']);
});

test('an MR stage\'s readout leads with its count and names at most three MRs, and its tip never runs off the foot of the window', async () => {
  const mine = Array.from({ length: 9 }, (_, i) => ({ key: 'acme/web!' + (i + 1), title: 'Mine ' + (i + 1), author: 'frank', flags: { mine: true }, approvedBy: [], mergeStatus: 'MERGEABLE' }));
  const page = await overview({ stats: figures({ rows: mine }) });
  const [draft, , , , mergeable] = page.$$('#viz-stages .viz-hit');
  assert.equal(mergeable.getAttribute('aria-label'), 'Mergeable: 9 MRs, web!1, web!2, web!3 and 6 more');
  assert.equal(draft.getAttribute('aria-label'), 'Draft: 0 MRs');
  page.run('innerHeight = 900; vizTip().offsetHeight = 600');
  page.fire(mergeable, 'pointerenter', { clientX: 100, clientY: 400 });
  const tip = page.$('#viz-tip');
  assert.deepEqual(tip.querySelectorAll('.viz-tip-row b').map((b) => b.textContent), ['9']);
  assert.equal(tip.querySelector('.viz-tip-note').textContent, 'web!1, web!2, web!3 and 6 more');
  assert.equal(tip.style.top, '292px', 'with no room above the pointer or below it, the tip sits as low as the window allows');
  assert.deepEqual(page.$('#viz-stages tbody').querySelectorAll('tr')[4].childNodes.map((c) => c.textContent).slice(1), ['9', mine.map((r) => r.key.split('/').pop()).join(', ')]);
});

test('a review run that reported a launch error makes the runs note a status line, with an alert icon and the alert colour', async () => {
  const runs = [{ key: 'acme/engine!1', startedAt: before(D), status: 'launch failed' }, { key: 'acme/engine!2', startedAt: before(2 * D), status: 'running' }];
  const page = await overview({ stats: figures({ runs }) });
  const note = tile(page, 'runs').querySelector('.stat-note');
  assert.deepEqual([note.className, note.textContent, Boolean(note.querySelector('svg'))], ['stat-note alert', '1 of 2 reported a launch error', true]);
  assert.ok(styled(note, /color:\s*var\(--need\)/), 'the note wears the alert colour');
  const calm = await overview({ stats: figures({ runs: runs.slice(1) }) });
  const quiet = tile(calm, 'runs').querySelector('.stat-note');
  assert.deepEqual([quiet.className, quiet.textContent, Boolean(quiet.querySelector('svg'))], ['stat-note', 'No launch errors', false]);
});

test('an open Table or How these are worked out stays open through the next refresh, and focus stays on the summary it was on', async () => {
  const page = await overview();
  const open = (details, on = true) => {
    details.open = on;
    page.fire(details, 'toggle', { bubbles: false });
  };
  const first = page.$('#viz-severity details.viz-table');
  open(first);
  open(page.$('details.stat-defs'));
  page.$('#viz-merge-table').focus();
  page.run('refresh()');
  await page.settle();
  const again = page.$('#viz-severity details.viz-table');
  assert.ok(again !== first, 'the chart was drawn again');
  assert.deepEqual(['severity', 'stages', 'merge'].map((id) => page.$('#viz-' + id + ' details.viz-table').open), [true, false, false]);
  assert.equal(page.$('details.stat-defs').open, true);
  assert.equal(page.document.activeElement.id, 'viz-merge-table');
  open(again, false);
  page.run('render(true)');
  assert.equal(page.$('#viz-severity details.viz-table').open, false, 'one closed stays closed');
});

test('an open chart Table scrolls inside its card rather than widening the card and the page', async () => {
  const page = await overview();
  const wrap = page.$('#viz-severity .tablewrap');
  assert.ok(styled(wrap, /overflow-x:\s*auto/));
  for (let n = wrap; !n.classList.contains('stat-charts'); n = n.parentNode) {
    const grid = n.parentNode;
    if (!styled(grid, /display:\s*grid/)) continue;
    const capped = styled(grid, /grid-template-columns:\s*minmax\(0,/) || styled(n, /min-width:\s*0/);
    assert.ok(capped, `.${grid.className} grows to the table's width`);
  }
});

test('Needs you now gives the first six MR cards a line each, then how many more and how many agents wait, with no thread text', async () => {
  const since = (ms) => new Date(Date.now() - ms).toISOString();
  const card = (n, reasons, interrupt = true) => ({ key: 'acme/engine!' + n, group: 'others', title: 'MR ' + n, iid: n, repo: 'engine', reasons, top: reasons[0], since: since(n * H), interrupt, muted: null });
  const reason = (kind, why, tier = 'interrupt') => ({ kind, why, tier, tab: 'threads', next: 'reply' });
  const cards = [card(1, [reason('replied', 'Judy replied on 2 threads'), reason('findings', '3 to post')]), ...[2, 3, 4, 5, 6, 7].map((n) => card(n, [reason('asked', 'asks for your review')]))];
  const snap = snapshot({ agents: [{ handle: 'claude:w', name: 'feature-work', title: 'Build it', state: 'working', since: since(2 * H), lastAt: Date.now(), alive: true, said: 'Working on it', ask: null }] });
  snap.attention = { cards, agents: [{ kind: 'agent', group: 'agents', id: 'agent:t9', handle: 't9', why: 'claude waiting' }], system: [], count: cards.length, prefs: {}, toasts: [], offers: [] };
  const page = await overview({ snap });
  const section = page.$$('#main .section').find((s) => s.querySelector('h2').textContent === 'Needs you now');
  const lines = section.querySelectorAll('.line').map((l) => [l.querySelector('.pill').textContent, l.querySelector('.line-title').textContent, l.getAttribute('href')]);
  assert.deepEqual(lines[0], ['2 reasons', 'MR 1: Judy replied on 2 threads, 3 to post', '#needs-you']);
  assert.deepEqual(lines.slice(1).map((l) => l[0]), ['asks you', 'asks you', 'asks you', 'asks you', 'asks you']);
  assert.equal(section.querySelector('.line-more').textContent, 'and 1 more MR and 1 agent waiting', 'agents never push an MR off it');
  assert.equal(page.$('[data-count="needs"]').textContent, '7', 'the rail counts the cards');
  const main = page.$('#main').textContent;
  assert.ok(!main.includes('Working on it'));
});

test('How these are worked out lists every definition the worker sent, and when GitLab was read', async () => {
  const stats = figures();
  const page = await overview({ stats });
  const defs = page.$('details.stat-defs');
  assert.deepEqual(defs.querySelectorAll('dt').map((dt) => dt.textContent), stats.definitions.map((d) => d.name));
  assert.deepEqual(defs.querySelectorAll('dd').map((dd) => dd.textContent), stats.definitions.map((d) => d.defines));
  assert.match(defs.querySelector('.meta').textContent, /^GitLab was last read 5 min ago\. It is read again at most every 15 minutes\.$/);
});

test('figures that cannot be read leave the rest of the Overview standing, with the reason in place of the tiles', async () => {
  const page = await openPage({ respond: () => null });
  page.show(snapshot());
  await page.settle();
  assert.match(page.$('#main .stat-state').textContent, /^Could not work out the figures: not stubbed: \/api\/stats/);
  assert.equal(page.$$('#main .stat').length, 0);
  assert.ok(page.$$('#main .section').some((s) => s.textContent.includes('Nothing is waiting on you.')));
  assert.equal(page.$$('#main .banner').length, 0);
});
