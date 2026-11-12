import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const page = await openPage();
const GRAPH = 'acme/order-book!898';
const ENGINE = 'acme/gateway!136';
const CLI = 'acme/tooling/cli!898';
const GRAPH_URL = 'https://gitlab.com/acme/order-book/-/merge_requests/898';
const plain = (value) => JSON.parse(JSON.stringify(value));
const known = (over = {}) => page.window.terminalKnowing({ mrs: [GRAPH, ENGINE, CLI], tickets: ['ABC-1'], jiraSite: 'acme.atlassian.net', ...over });
const refs = (lines, k = known(), width = 0) => plain(page.window.terminalRefs(lines, k, { width }));
const keys = (lines, k, width) => refs(lines, k, width).map((r) => [r.kind, r.key]);
const pieceText = (lines, { row, start, end }) => (typeof lines[row] === 'string' ? lines[row] : lines[row].text).slice(start, end);
const firstRef = (text, k = known()) => page.window.terminalRefs([text], k)[0];
const act = (text, k = known(), options = {}) => plain(page.window.terminalAction(firstRef(text, k), k, options));

test('each shape of reference is found where it stands: a ticket key, !iid, repo!iid, group/repo!iid, an MR link and a Jira link', () => {
  const line = 'See ABC-2871, order-book!898, !136, acme/gateway!136, ' + GRAPH_URL + ' or https://acme.atlassian.net/browse/OPS-7.';
  const found = refs([line]);
  assert.deepEqual(found.map((r) => [r.kind, r.key, r.url]), [
    ['ticket', 'ABC-2871', null], ['mr', GRAPH, null], ['mr', ENGINE, null], ['mr', ENGINE, null],
    ['mr', GRAPH, GRAPH_URL], ['ticket', 'OPS-7', 'https://acme.atlassian.net/browse/OPS-7'],
  ]);
  assert.deepEqual(found.map((r) => pieceText([line], r.pieces[0])), ['ABC-2871', 'order-book!898', '!136', 'acme/gateway!136', GRAPH_URL, 'https://acme.atlassian.net/browse/OPS-7']);
  assert.ok(found.every((r) => r.pieces.length === 1));
});

test('a key whose project no open MR, ticket or agent uses stays text, so UTF-8 and SHA-256 are never links', () => {
  assert.deepEqual(keys(['UTF-8, SHA-256, XYZ-12 and ABC-12']), [['ticket', 'ABC-12']]);
  assert.deepEqual(keys(['OPS-9 too'], known({ agents: [{ handle: 'h', ticket: 'OPS-3' }] })), [['ticket', 'OPS-9']], 'an agent\'s ticket makes its project known');
  assert.deepEqual(keys(['ABC-12'], known({ tickets: [] })), [], 'with nothing using ABC, ABC-12 is text too');
});

test('a short MR reference counts only when the MRs the page knows leave one answer', () => {
  assert.deepEqual(keys(['!898 is in two repos']), [], 'bare !898 could be order-book or cli');
  assert.deepEqual(keys(['order-book!899']), [['mr', 'acme/order-book!899']], 'a known repo, an MR not open');
  assert.deepEqual(keys(['nope!898, other/thing!4, bash: !2: event not found']), []);
  assert.deepEqual(keys(['acme/new-repo!4']), [['mr', 'acme/new-repo!4']], 'a full path in a group the page knows');
  assert.deepEqual(keys(['!136']), [['mr', ENGINE]]);
});

test('box-drawing borders are never part of a link, and the border rows hold none', () => {
  const lines = [
    '┌──────────┬───────────────────┐',
    '│ ABC-2871 │ order-book!898 │',
    '├──────────┼───────────────────┤',
    '│ABC-2900│' + GRAPH_URL + '/diffs│',
    '└──────────┴───────────────────┘',
  ];
  const found = refs(lines);
  assert.deepEqual(found.map((r) => [r.pieces[0].row, pieceText(lines, r.pieces[0])]), [[1, 'ABC-2871'], [1, 'order-book!898'], [3, 'ABC-2900'], [3, GRAPH_URL + '/diffs']]);
  assert.equal(found[3].url, GRAPH_URL + '/diffs', 'the link stops at the border that follows it');
});

test('a reference Claude Code wrapped inside a table cell is one link over both lines, read from that cell alone', () => {
  const lines = [
    '│ Ticket │ MR          │',
    '├────────┼─────────────┤',
    '│ ABC-28 │ order-book! │',
    '│ 71     │ 898         │',
    '└────────┴─────────────┘',
  ];
  const found = refs(lines);
  assert.deepEqual(found.map((r) => [r.key, r.pieces.map((p) => pieceText(lines, p))]), [['ABC-2871', ['ABC-28', '71']], [GRAPH, ['order-book!', '898']]]);
  assert.deepEqual(found[0].pieces.map((p) => p.row), [2, 3]);
});

test('a full row broken mid-link joins the next, and a row xterm.js wrapped joins it exactly', () => {
  const first = '  see ' + GRAPH_URL.slice(0, 34);
  const lines = [first, '  ' + GRAPH_URL.slice(34) + ' for it'];
  const [hard] = refs(lines, known(), first.length);
  assert.deepEqual([hard.key, hard.url, hard.pieces.map((p) => pieceText(lines, p)).join('')], [GRAPH, GRAPH_URL, GRAPH_URL]);
  const soft = [{ text: '│ tracked in order-b', wrapped: false }, { text: 'ook!898 │', wrapped: true }];
  assert.deepEqual(refs(soft, known(), soft[0].text.length).map((r) => [r.key, r.pieces]), [[GRAPH, [{ row: 0, start: 13, end: 20 }, { row: 1, start: 0, end: 7 }]]], 'even across a table too wide for the terminal');
});

test('rows that only look joined stay apart', () => {
  assert.deepEqual(keys(['see ABC-28', '71 more'], known(), 40), [['ticket', 'ABC-28']], 'a row that stops short of the edge was not broken');
  const edge = '  owner ABC-2871';
  assert.deepEqual(keys([edge, '  and the rest'], known(), edge.length), [['ticket', 'ABC-2871']], 'a whole key at the edge keeps its link when a word follows');
  assert.deepEqual(keys(['│ ABC-2871 │', '│ ABC-2900 │']), [['ticket', 'ABC-2871'], ['ticket', 'ABC-2900']], 'two rows of one table with no rule between them');
  assert.deepEqual(keys(['│ ABC-28 │', '├────────┤', '│ 71     │']), [['ticket', 'ABC-28']], 'a rule between them ends the cell');
  assert.deepEqual(keys(['│ ABC-28 │', '71 more']), [['ticket', 'ABC-28']], 'a table row never runs on into the text below the table');
});

const agent = (handle, extra) => ({ handle, kind: 'review', mr: null, ticket: null, state: 'done', lastAt: 1, waiting: false, background: [], ...extra });

test('a ticket or MR with an agent opens the agent, the one waiting on you first, then a busy one, then the newest', () => {
  const agents = [
    agent('review-new', { ticket: 'ABC-2871', state: 'working', lastAt: 9 }),
    agent('kickoff-old', { kind: 'kickoff', ticket: 'ABC-2871', waiting: true, lastAt: 2 }),
    agent('fix', { kind: 'fix', mr: GRAPH, state: 'done', lastAt: 9 }),
    agent('builder', { kind: 'fix', mr: GRAPH, state: 'done', lastAt: 3, background: ['Build order-book'] }),
    agent('done-a', { ticket: 'ABC-5', lastAt: 1 }), agent('done-b', { ticket: 'ABC-5', lastAt: 5 }),
  ];
  const k = known({ agents });
  assert.deepEqual(act('ABC-2871', k), { kind: 'agent', label: 'ABC-2871', words: 'open its kickoff agent (waiting on you)', url: 'https://acme.atlassian.net/browse/ABC-2871', handle: 'kickoff-old' });
  assert.deepEqual([act('order-book!898', k).handle, act('order-book!898', k).words], ['builder', 'open its fix agent (working)'], 'builders in the background keep it live and busy');
  assert.equal(act('ABC-5', k).handle, 'done-b');
  assert.equal(act('ABC-5', known({ agents: [agent('x', { kind: null, ticket: 'ABC-5' })] })).words, 'open its agent (done)');
});

test('with no agent a ticket opens its drawer and a known MR its own; anything else opens in the browser', () => {
  assert.deepEqual(act('ABC-2900'), { kind: 'ticket', label: 'ABC-2900', words: 'open the ticket (no agent yet)', url: 'https://acme.atlassian.net/browse/ABC-2900', key: 'ABC-2900' });
  assert.deepEqual(act('order-book!898'), { kind: 'mr', label: 'order-book!898', words: 'open the MR', url: GRAPH_URL, key: GRAPH });
  assert.deepEqual(act('order-book!899'), { kind: 'browser', label: 'order-book!899', words: 'open it on GitLab', url: GRAPH_URL.replace('898', '899') });
  assert.deepEqual(act('https://acme.atlassian.net/browse/OPS-7'), { kind: 'browser', label: 'OPS-7', words: 'open it in Jira', url: 'https://acme.atlassian.net/browse/OPS-7' });
  assert.equal(act('https://acme.atlassian.net/browse/ABC-7').kind, 'ticket', 'a Jira link to a known project opens here');
});

test('a short reference no MR could have, such as !0 or !012, stays text rather than a link to nowhere', () => {
  assert.deepEqual(keys(['order-book!0, acme/gateway!012 and !0']), []);
  assert.deepEqual(keys(['order-book!12']), [['mr', 'acme/order-book!12']]);
});

test('Cmd-click always opens the browser, at the link as written when there is one', () => {
  const k = known({ agents: [agent('kick', { ticket: 'ABC-2871', waiting: true })] });
  const outside = (text, kk = k) => act(text, kk, { outside: true });
  assert.deepEqual([outside('ABC-2871').kind, outside('ABC-2871').url], ['browser', 'https://acme.atlassian.net/browse/ABC-2871']);
  assert.equal(outside('order-book!898').url, GRAPH_URL);
  assert.equal(outside(GRAPH_URL + '/diffs.').url, GRAPH_URL + '/diffs', 'without the full stop after it');
  assert.equal(outside('ABC-2871', known({ jiraSite: null, agents: k.agents })).kind, 'agent', 'with no Jira site to build a link, the click does what a plain one would');
});

test('each terminal cell is one character of the row, so a wide character before a key leaves its columns right', () => {
  const cells = ['⏺', ' ', '\u{1F600}', '', ...'ABC-2871'];
  const line = { isWrapped: true, getCell: (x) => ({ getChars: () => cells[x] ?? '' }) };
  const row = plain(page.window.terminalRowOf(line, 14, {}));
  assert.deepEqual(row, { text: '⏺ � ABC-2871  ', wrapped: true });
  assert.equal(refs([row.text])[0].pieces[0].start, 4);
});
