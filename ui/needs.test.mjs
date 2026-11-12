import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = new Date(Date.now() - 3 * 36e5).toISOString();
const KEY = 'acme/engine!1121';
const OWN = 'acme/portal!88';

function row(key, extra = {}) {
  const iid = Number(key.split('!')[1]);
  return {
    key, iid, repo: key.split('/')[1].split('!')[0], title: 'MR ' + iid, webUrl: 'https://gitlab.com/' + key.replace('!', '/-/merge_requests/'), author: 'judy', reviewers: ['frank'],
    approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: null, updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'b', sha: 'aaa111',
    agentHandle: null, watch: null, flags: {}, phase: 'open', count: 0, mood: 'quiet', verdict: null, agent: null, level: null, ...extra,
  };
}

const reason = (kind, why, extra = {}) => ({ kind, why, tier: 'interrupt', tab: 'threads', next: 'reply', since: AT, ...extra });
const card = (key, group, reasons, extra = {}) => ({ key, group, title: 'MR ' + key.split('!')[1], iid: Number(key.split('!')[1]), repo: 'engine', reasons, top: reasons[0], since: AT, interrupt: reasons.some((r) => r.tier === 'interrupt'), muted: null, ...extra });

function snapshot(attention = {}, matrix = {}) {
  const cards = attention.cards ?? [card(KEY, 'others', [reason('replied', 'Judy replied on 2 threads'), reason('findings', '3 to post', { tab: 'findings', next: 'post-all' })]), card(OWN, 'mine', [reason('red', 'the pipeline failed', { tab: 'pipeline', next: 'fix-pipeline' })])];
  return {
    generatedAt: new Date().toISOString(),
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts: [],
    attention: { cards, agents: [], system: [], count: cards.length, prefs: { enabled: true, quiet: false, quietFrom: '22:00', quietTo: '07:00', weekends: false, clickable: false }, toasts: [], offers: [], notReaching: null, ...attention },
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [row(KEY), row(OWN, { author: 'frank', flags: { mine: true }, pipeline: 'FAILED' })] },
      fullAuto: [], roster: [{ username: 'judy', level: null, askingYou: 1, open: 1, reviewing: 0 }], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
      onRequest: { level: null, optedOut: [], available: true }, ...matrix,
    },
  };
}

async function needsPage({ snap = snapshot(), hash = 'needs-you', focus = null, store = null, detail = null } = {}) {
  const posts = [];
  const page = await openPage({
    respond(path, init) {
      if (init?.method === 'POST') posts.push([path, JSON.parse(init.body ?? 'null')]);
      if (path.startsWith('/api/matrix/mr?')) return detail;
      if (path.startsWith('/api/matrix/settings')) return { rows: [], repos: null };
      return init?.method === 'POST' ? { ok: true, text: 'Done' } : null;
    },
  });
  if (focus) page.window.document.hasFocus = focus;
  if (store) page.window.localStorage = store;
  page.show(snap, hash);
  return Object.assign(page, { posts });
}

const buttonIn = (node, label) => node.querySelectorAll('button').find((b) => b.textContent === label);

test('Needs you renders from the worker\'s list alone: its groups in order, one card per MR with a pill per reason', async () => {
  const page = await needsPage();
  assert.deepEqual(page.$$('#main .needs-group h2').map((h) => h.textContent), ['Waiting on you', 'Your MRs']);
  const [theirs, mine] = page.$$('#main .need-card');
  assert.deepEqual(theirs.querySelectorAll('.row-head .pill').map((p) => p.textContent), ['replied', 'to post']);
  assert.match(theirs.querySelector('.need-why').textContent, /Judy replied on 2 threads · 3 to post/);
  assert.equal(mine.dataset.key, OWN);
  assert.ok(theirs.classList.contains('hot'), 'an interrupt reason marks the card');
});

test('a card expands in place, and its title opens the drawer on the tab of its top reason', async () => {
  const page = await needsPage();
  const theirs = page.$('#main .need-card');
  buttonIn(theirs, 'Show here').click();
  assert.ok(page.$('#main .need-card .need-behind'));
  assert.equal(page.run('ui.mr'), null, 'it stays on the page');
  page.$('#main .need-card .ref').click();
  assert.deepEqual(JSON.parse(page.run('JSON.stringify([ui.mr.key, ui.mr.tab])')), [KEY, 'threads']);
});

test('Mute for a day, Mute until it merges and Unmute each go to the worker in one click', async () => {
  const page = await needsPage();
  buttonIn(page.$('#main .need-card'), 'Mute').click();
  buttonIn(page.$('#main .need-card'), 'Mute for a day').click();
  buttonIn(page.$('#main .need-card'), 'Mute').click();
  buttonIn(page.$('#main .need-card'), 'Mute until it merges').click();
  await page.settle();
  const muted = snapshot({ cards: [card(KEY, 'others', [reason('replied', 'Judy replied')], { muted: { merged: true } })] });
  page.show(muted, 'needs-you');
  assert.match(page.$('#main .need-card .row-head').textContent, /muted/);
  buttonIn(page.$('#main .need-card'), 'Unmute').click();
  await page.settle();
  assert.deepEqual(page.posts.filter(([p]) => p === '/api/attention/mute').map(([, b]) => b.until), ['day', 'merged', null]);
});

test('a verdict card offers Later, kept by the worker until something on the MR changes', async () => {
  const page = await needsPage({ snap: snapshot({ cards: [card(KEY, 'others', [reason('verdict', 'ready for your verdict, new commits', { tab: 'findings', next: 'decide', later: 'aaa111||' })])] }) });
  buttonIn(page.$('#main .need-card'), 'Later').click();
  await page.settle();
  assert.deepEqual(page.posts.find(([p]) => p === '/api/attention/later')[1], { key: KEY, mark: 'aaa111||' });
});

test('a comments card on your MR expands to what people left that you have not answered, plain comments too', async () => {
  const note = (author, at) => ({ author, body: author + ' says', createdAt: at, system: false });
  const thread = (id, notes, extra = {}) => ({ id, resolved: false, resolvable: true, path: null, line: null, notes, awaitsYou: false, bot: false, handedBack: false, queuedReply: null, ...extra });
  const discussions = [
    thread('d-open', [note('olivia', '2026-11-05T10:00:00Z')]),
    thread('d-answered', [note('peggy', '2026-11-05T10:00:00Z'), note('frank', '2026-11-05T11:00:00Z')]),
    thread('n-plain', [note('quentin', '2026-11-05T12:00:00Z')], { resolvable: false }),
    thread('n-old', [note('quentin', '2026-11-05T09:00:00Z')], { resolvable: false }),
    thread('d-bot', [note('ci-bot', '2026-11-05T10:00:00Z')], { bot: true }),
  ];
  const detail = { key: OWN, me: 'frank', mr: { iid: 88, sha: 'aaa111' }, discussions, settled: [] };
  const own = card(OWN, 'mine', [reason('comments', 'olivia and quentin left 2 comments', { next: 'fix-threads' })]);
  const page = await needsPage({ snap: snapshot({ cards: [own] }), detail });
  buttonIn(page.$('#main .need-card'), 'Show here').click();
  await page.settle();
  const shown = page.$$('#main .need-behind .thread').map((t) => t.textContent);
  assert.equal(shown.length, 2, shown.join(' | '));
  assert.ok(shown[0].includes('olivia says') && shown[1].includes('quentin says'));
  assert.ok(!page.$('#main .need-behind').textContent.includes('waiting on you any more'));
});

test('a merged card has no next step and a Dismiss the worker keeps', async () => {
  const merged = card(OWN, 'mine', [reason('merged', 'merge when green merged it', { tab: null, next: 'dismiss', later: 'merged' })]);
  const page = await needsPage({ snap: snapshot({ cards: [merged] }) });
  const node = page.$('#main .need-card');
  assert.deepEqual(node.querySelector('.actions').childNodes.map((b) => b.textContent), ['Dismiss', 'Mute', 'Show here']);
  assert.equal(node.querySelector('.pill').textContent, 'merged');
  buttonIn(node, 'Dismiss').click();
  await page.settle();
  assert.deepEqual(page.posts.find(([p]) => p === '/api/attention/later')[1], { key: OWN, mark: 'merged' });
});

test('agents on no MR come last under Agents waiting, five at a time', async () => {
  const agents = Array.from({ length: 7 }, (_, n) => ({ kind: 'agent', group: 'agents', id: 'a' + n, handle: 't' + n, why: 'claude waiting in ws' + n }));
  const page = await needsPage({ snap: snapshot({ agents }) });
  assert.equal(page.$$('#main .needs-group h2').at(-1).textContent, 'Agents waiting');
  const group = page.$$('#main .needs-group').at(-1);
  assert.equal(group.querySelectorAll('.row').length, 5);
  buttonIn(group, 'All 7').click();
  assert.equal(page.$$('#main .needs-group').at(-1).querySelectorAll('.row').length, 7);
});

test('goTo opens an MR tab in the drawer, or a view, and a worker goto event lands there', async () => {
  const page = await needsPage();
  page.run(`goTo('mr:${KEY}:threads')`);
  assert.deepEqual(JSON.parse(page.run('JSON.stringify([ui.mr.key, ui.mr.tab])')), [KEY, 'threads']);
  page.run(`onWorkerEvent({ data: 'goto:settings' })`);
  assert.equal(page.window.location.hash, '#settings');
  assert.equal(page.run('ui.mr'), null, 'the drawer closes for a view');
});

test('the tab title and the favicon carry the card count', async () => {
  const page = await needsPage();
  assert.equal(page.document.title, '(2) Underlings');
  assert.equal(page.$('#favicon').dataset.state, 'dot');
  page.show(snapshot({ cards: [] }), 'needs-you');
  assert.equal(page.document.title, 'Underlings');
  assert.equal(page.$('#favicon').dataset.state, 'plain');
  assert.match(page.$('#favicon').getAttribute('href'), /^data:image\/svg\+xml,/);
});

test('while the page has focus a banner the worker held back shows as a toast with Open, once', async () => {
  const toasts = [{ id: 'x', title: 'engine!1121: Judy replied', target: `mr:${KEY}:threads`, at: Date.now() }];
  const page = await needsPage({ snap: snapshot({ toasts }), focus: () => true });
  const node = page.$('#toast');
  assert.equal(node.hidden, false);
  assert.match(node.textContent, /engine!1121: Judy replied/);
  buttonIn(node, 'Open').click();
  assert.deepEqual(JSON.parse(page.run('JSON.stringify([ui.mr.key, ui.mr.tab])')), [KEY, 'threads']);
  node.hidden = true;
  page.show(snapshot({ toasts }), 'needs-you');
  assert.equal(node.hidden, true, 'shown once');
});

test('a focused page tells the worker so, beating with its focus, visibility, permission and whether the Claude panel is open', async () => {
  const page = await needsPage({ focus: () => true });
  page.run('presenceStart()');
  await page.settle(20);
  const [, body] = page.posts.find(([p]) => p === '/api/attention/presence');
  assert.deepEqual(Object.keys(body).sort(), ['focused', 'page', 'panel', 'permission', 'visible']);
  assert.deepEqual([body.focused, body.panel], [true, false]);
});

test('the first-run banner lists the one-time steps until Done, and says nothing of the terminal', async () => {
  const saved = new Map();
  const store = { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, v) };
  const page = await needsPage({ store });
  const setup = page.$('#main .banner.setup');
  assert.match(setup.textContent, /approve “Show desktop notifications labeled with the plugin name”/);
  assert.match(setup.textContent, /turn Underlings off and on once/);
  assert.match(setup.textContent, /macOS System Settings, Notifications, Orca/);
  assert.match(setup.textContent, /Underlings: Open what needs me/);
  buttonIn(setup, 'Done').click();
  assert.equal(page.$('#main .banner.setup'), null);
});

test('a banner Orca would not show is said at the top of Needs you, with the way to the settings', async () => {
  const page = await needsPage({ snap: snapshot({ notReaching: 'notifications are turned off for Orca' }) });
  assert.match(page.$('#main').textContent, /Desktop notifications are not reaching you: notifications are turned off for Orca\./);
});

test('Settings has a Notifications group whose switches save at once', async () => {
  const page = await needsPage({ hash: 'settings' });
  await page.settle();
  const group = page.$('#notifications');
  assert.ok(group);
  page.$('#note-quiet').click();
  page.$('#note-enabled').click();
  await page.settle();
  assert.deepEqual(page.posts.filter(([p]) => p === '/api/attention/prefs').map(([, b]) => b), [{ quiet: true }, { enabled: false }]);
  assert.match(group.textContent, /Clickable banners/);
});

test('Send a test banner asks the worker for one', async () => {
  const page = await needsPage({ hash: 'settings' });
  await page.settle();
  page.$('#note-test').click();
  await page.settle();
  assert.deepEqual(page.posts.filter(([p]) => p === '/api/attention/test').length, 1);
});

test('Full auto\'s People table starts with the row for anyone else who asks for your review, at shadow or off', async () => {
  const page = await needsPage({ hash: 'full-auto' });
  const first = page.$('#main tbody tr');
  assert.match(first.textContent, /Anyone else who asks for my review/);
  assert.deepEqual(first.querySelectorAll('.chip').map((c) => c.textContent), ['Off', 'Shadow']);
  buttonIn(first, 'Shadow').click();
  await page.settle();
  assert.deepEqual(page.posts.find(([p]) => p === '/api/matrix/level')[1], { username: '*', level: 'shadow' });
});

test('with the default row on, a person with no row follows it, and Off on their row means never', async () => {
  const page = await needsPage({ hash: 'full-auto', snap: snapshot({}, { onRequest: { level: 'shadow', optedOut: [], available: true } }) });
  const judy = page.$$('#main tbody tr')[1];
  assert.equal(judy.querySelector('.chip[aria-pressed="true"]').textContent, 'Default (shadow)');
  buttonIn(judy, 'Off').click();
  await page.settle();
  assert.deepEqual(page.posts.find(([p]) => p === '/api/matrix/level')[1], { username: 'judy', level: 'off' });
});
