import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const KEY = 'acme/engine!7';
const AT = '2026-11-05T12:00:00Z';
const URL_OF = 'https://gitlab.com/acme/engine/-/merge_requests/7';
const EPIC = { key: 'ABC-3789', summary: 'Native access control' };
const DRAFT = { summary: 'engine: rename the cache helper', description: 'Problem\nMisnamed.\n\nFix\nRename it.\n\nAcceptance criteria\n- Reads well.\n\nRaised in review: ' + URL_OF + '#note_1' };
const RAISED = { ticket: 'ABC-4400', url: 'https://example.atlassian.net/browse/ABC-4400', summary: DRAFT.summary, reply: 'Raised ABC-4400 for this.', replied: true, resolved: true };

function row(extra = {}) {
  return {
    key: KEY, iid: 7, repo: 'engine', title: 'Make the engine faster', webUrl: URL_OF, author: 'ivan', reviewers: ['frank'], approvedBy: [], draft: false,
    pipeline: 'SUCCESS', ticket: 'ABC-1200', updatedAt: AT, unresolved: 1, threads: { mine: 1, unresolved: 1, awaitingYou: 1 }, mergeStatus: 'MERGEABLE',
    sourceBranch: 'feat/7', sha: 'aaa111', agentHandle: null, watch: null, flags: { waitingOnYou: true }, phase: 'open', count: 0, mood: 'awaitingYou',
    verdict: null, agent: null, level: null, ...extra,
  };
}

function snapshot({ rows = [row()], queue = [] } = {}) {
  const reason = { kind: 'replied', why: 'ivan replied on 2 threads', tier: 'interrupt', tab: 'threads', next: 'reply' };
  const cards = rows.length ? [{ key: rows[0].key, group: 'others', title: rows[0].title, iid: rows[0].iid, repo: 'engine', reasons: [reason], top: reason, since: AT, interrupt: true, muted: null }] : [];
  return {
    generatedAt: AT,
    attention: { cards, agents: [], system: [], count: cards.length, prefs: {}, toasts: [], offers: [] },
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts: [],
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue, runs: [], autoPasses: [],
    },
  };
}

const note = (author, body) => ({ author, body, createdAt: AT, system: false });
const thread = (id, extra = {}) => ({ id, resolved: false, resolvable: true, path: 'src/cache.py', line: 12, notes: [note('frank', 'NIT: rename ' + id), note('ivan', 'Later, on ' + id)], awaitsYou: true, handedBack: false, queuedReply: null, ...extra });

const SEEN = { notes: ['NIT: rename d-nit', 'Later, on d-nit'] };
const answered = (id, extra = {}) => thread(id, { resolved: true, awaitsYou: false, notes: [...thread(id).notes, note('frank', 'Raised ABC-4400 for this.')], ...extra });

const THREADS = [
  thread('d-nit'),
  thread('d-theirs', { awaitsYou: false, notes: [note('ivan', 'Rename, on d-theirs?'), note('bob', 'Agreed.')] }),
  thread('d-closed', { resolved: true }),
  thread('d-plain', { resolvable: false }),
];

function failing(status, text) {
  return { ok: false, status, text: async () => text, json: async () => { throw new Error('not JSON'); } };
}

async function open({ snap = snapshot(), hash = 'merge-requests', discussions = THREADS, records = {}, check = {}, draft = () => DRAFT, refuse = {} } = {}) {
  const server = { discussions, records, calls: [], check: { raised: null, existing: [], searchError: null, epic: EPIC, epicNote: null, ...check }, draft, refuse };
  const page = await openPage({
    respond(path, init) {
      server.calls.push([init.method, path, init.body ? JSON.parse(init.body) : null]);
      if (path.startsWith('/api/matrix/mr?')) return { key: KEY, me: 'frank', fetchedAt: AT, mr: { iid: 7, repo: 'engine', title: 'Make the engine faster', author: snap.matrix.inbox.rows[0]?.author, webUrl: URL_OF }, discussions: server.discussions, jobs: [], settled: [] };
      if (path.startsWith('/api/matrix/thread-tickets?')) return { records: server.records };
      if (path.startsWith('/api/matrix/thread-ticket?')) return server.check;
      if (path === '/api/matrix/thread-ticket-draft') return server.draft();
      return init.method === 'POST' ? { ok: true, text: 'Done' } : null;
    },
  });
  const plain = page.window.fetch;
  page.window.fetch = async (path, init) => (await server.refuse[path]?.()) ?? plain(path, init);
  page.show(snap, hash);
  const posts = () => server.calls.filter(([method]) => method === 'POST').map(([, path, body]) => [path, body]);
  return Object.assign(page, { server, posts });
}

async function drawer(options, tab = 'threads', filter = `ui.mr.threadFilter = 'all'`) {
  const page = await open(options);
  page.run(`openMr('${KEY}', '${tab}'); ${filter}`);
  await page.settle();
  page.run('render(true)');
  return page;
}

const onDefault = (options, tab) => drawer(options, tab, '');

const cardOf = (page, id, where = '#drawer') => page.$$(where + ' .thread').find((c) => c.textContent.includes('on ' + id));
const buttonIn = (node, label) => node?.querySelectorAll('button').find((b) => b.textContent === label) ?? null;
const make = (page, id = 'd-nit') => buttonIn(cardOf(page, id), 'Make a ticket');
const panelText = (page) => page.$('#drawer .ticket-panel')?.textContent ?? '';

async function twoClicks(page, find) {
  const before = page.posts().length;
  find().click();
  const armed = find().textContent;
  assert.equal(page.posts().length, before, 'the first click only arms it');
  find().click();
  await page.settle();
  return armed;
}

async function toForm(options) {
  const page = await drawer(options);
  make(page).click();
  await page.settle();
  return page;
}

test('Make a ticket is offered on an open thread you wrote in, and on any open thread of your own MR', async () => {
  const page = await drawer();
  assert.deepEqual(page.errors, []);
  assert.ok(make(page, 'd-nit'), 'a thread you wrote in');
  assert.ok(!make(page, 'd-theirs'), 'a thread between others on their MR');
  assert.ok(!make(page, 'd-closed'), 'a resolved thread');
  assert.ok(!make(page, 'd-plain'), 'a comment GitLab cannot resolve');
  const mine = await drawer({ snap: snapshot({ rows: [row({ author: 'frank' })] }) });
  assert.ok(make(mine, 'd-theirs'), 'any open thread on your own MR');
});

test('it looks for a ticket first, then asks for a draft and opens it as a form with the epic from Jira', async () => {
  const page = await toForm();
  const gets = page.server.calls.map(([method, path]) => method + ' ' + path.split('?')[0]);
  assert.ok(gets.indexOf('GET /api/matrix/thread-ticket') < gets.indexOf('POST /api/matrix/thread-ticket-draft'));
  assert.deepEqual(page.posts(), [['/api/matrix/thread-ticket-draft', { key: KEY, discussionId: 'd-nit', epic: 'ABC-3789' }]]);
  assert.equal(page.$('#drawer [id="ticket-summary-d-nit"]').getAttribute('value'), DRAFT.summary);
  assert.equal(page.$('#drawer [id="ticket-description-d-nit"]').textContent, DRAFT.description);
  assert.equal(page.$('#drawer [id="ticket-epic-d-nit"]').getAttribute('value'), 'ABC-3789');
  assert.match(panelText(page), /Native access control/);
  assert.match(panelText(page), /A Task, assigned to you/);
  assert.equal(page.document.activeElement.id, 'ticket-summary-d-nit', 'the summary takes focus, as a reply box does');
});

test('while it looks and drafts, the card says so and can be cancelled, which puts focus back on the button', async () => {
  let release;
  const page = await drawer({ draft: () => null });
  page.server.refuse['/api/matrix/thread-ticket-draft'] = () => new Promise((resolve) => { release = () => resolve(failing(502, 'late')); });
  make(page).click();
  await page.settle();
  assert.match(panelText(page), /Claude is drafting the ticket…/);
  assert.equal(page.document.activeElement.id, 'ticket-cancel-d-nit');
  buttonIn(page.$('#drawer .ticket-panel'), 'Cancel').click();
  assert.ok(!page.$('#drawer .ticket-panel'));
  assert.equal(page.document.activeElement.id, 'ticket-make-d-nit');
  release();
  await page.settle();
  assert.ok(!page.$('#drawer .ticket-panel'), 'a draft that lands after Cancel is dropped');
});

test('a draft that fails shows the reason with Try again, which asks once more', async () => {
  let tries = 0;
  const page = await drawer();
  page.server.refuse['/api/matrix/thread-ticket-draft'] = () => (++tries === 1 ? failing(502, "Claude's draft was not usable: the draft is not JSON") : null);
  make(page).click();
  await page.settle();
  assert.match(panelText(page), /Claude's draft was not usable: the draft is not JSON/);
  assert.equal(page.document.activeElement.id, 'ticket-retry-d-nit');
  buttonIn(page.$('#drawer .ticket-panel'), 'Try again').click();
  await page.settle();
  assert.equal(page.$('#drawer [id="ticket-summary-d-nit"]').getAttribute('value'), DRAFT.summary);
});

test('a ticket that already covers the thread is offered instead, as a two-click reply and resolve', async () => {
  const existing = [{ key: 'ABC-77', summary: 'engine: cache naming', status: 'To Do', url: 'https://example.atlassian.net/browse/ABC-77', why: 'named in the thread' }];
  const page = await drawer({ check: { existing } });
  make(page).click();
  await page.settle();
  assert.match(panelText(page), /A ticket may already cover this thread\.ABC-77engine: cache namingTo Do · named in the thread/);
  assert.equal(page.posts().length, 0, 'no draft is asked for');
  const reply = () => buttonIn(page.$('#drawer .ticket-panel'), 'Reply with ABC-77 and resolve') ?? page.$('#drawer [id="ticket-first-d-nit"]');
  assert.equal(page.document.activeElement.id, 'ticket-first-d-nit');
  page.server.records = { 'd-nit': { ...RAISED, ticket: 'ABC-77', url: existing[0].url, linked: true } };
  assert.equal(await twoClicks(page, reply), 'Reply and resolve on !7?');
  assert.deepEqual(page.posts(), [['/api/matrix/thread-ticket-link', { key: KEY, discussionId: 'd-nit', ticket: 'ABC-77', expect: SEEN }]]);
  await page.settle();
  assert.ok(!page.$('#drawer .ticket-panel'));
  assert.ok(buttonIn(cardOf(page, 'd-nit'), 'ABC-77'), 'the card shows the ticket it was closed with');
});

test('Draft a new ticket goes on to the draft when the one found is not it', async () => {
  const existing = [{ key: 'ABC-77', summary: 'Other', status: 'Done', url: 'https://example.atlassian.net/browse/ABC-77', why: 'named in the thread' }];
  const page = await drawer({ check: { existing, searchError: 'acli is not logged in' } });
  make(page).click();
  await page.settle();
  assert.match(panelText(page), /Jira could not be searched \(acli is not logged in\)/);
  buttonIn(page.$('#drawer .ticket-panel'), 'Draft a new ticket').click();
  await page.settle();
  assert.equal(page.$('#drawer [id="ticket-summary-d-nit"]').getAttribute('value'), DRAFT.summary);
});

test('Create ticket takes two clicks, names the epic, and sends the form as edited with the thread the page saw', async () => {
  const page = await toForm();
  const summary = page.$('#drawer [id="ticket-summary-d-nit"]');
  summary.value = 'engine: rename `cache_get` to say what it does';
  page.fire(summary, 'input');
  const create = () => buttonIn(page.$('#drawer .ticket-panel'), 'Create ticket') ?? page.$('#drawer [id="g-ticket:d-nit"]');
  page.server.records = { 'd-nit': RAISED };
  assert.equal(await twoClicks(page, create), 'Create a ticket under ABC-3789?');
  assert.deepEqual(page.posts().at(-1), ['/api/matrix/thread-ticket', {
    key: KEY, discussionId: 'd-nit', expect: SEEN, summary: 'engine: rename `cache_get` to say what it does', description: DRAFT.description, epic: 'ABC-3789',
  }]);
  await page.settle();
  assert.ok(!page.$('#drawer .ticket-panel'), 'the form closes once the ticket exists');
  assert.equal(page.run(`ui.drafts.has('ticket:d-nit')`), false, 'nothing is left half typed to hold off a reload');
  const chip = buttonIn(cardOf(page, 'd-nit'), 'ABC-4400');
  assert.ok(chip, 'the card shows the new key');
  assert.ok(!make(page));
  chip.click();
  await page.settle();
  assert.deepEqual(page.posts().at(-1), ['/api/open', { url: RAISED.url }]);
});

test('Create ticket waits for an epic, and the epic is read as a key whatever its case', async () => {
  const page = await toForm({ check: { epic: null, epicNote: 'ABC-1200 is not under an epic, so give one yourself.' } });
  const create = () => page.$('#drawer [id="g-ticket:d-nit"]');
  assert.equal(create().disabled, true);
  assert.match(panelText(page), /ABC-1200 is not under an epic, so give one yourself\./);
  const epic = page.$('#drawer [id="ticket-epic-d-nit"]');
  epic.value = 'nope';
  page.fire(epic, 'input');
  assert.equal(create().disabled, true);
  epic.value = 'abc-3790';
  page.fire(epic, 'input');
  assert.equal(create().disabled, false);
  await twoClicks(page, create);
  assert.equal(page.posts().at(-1)[1].epic, 'ABC-3790');
});

test('a create refused because the thread moved keeps the form and what was typed', async () => {
  const page = await toForm();
  page.server.refuse['/api/matrix/thread-ticket'] = () => failing(409, 'the thread changed since you looked');
  const description = page.$('#drawer [id="ticket-description-d-nit"]');
  description.value = 'Edited by hand.';
  page.fire(description, 'input');
  await twoClicks(page, () => page.$('#drawer [id="g-ticket:d-nit"]'));
  assert.match(page.$('#toast').textContent, /the thread changed since you looked/);
  assert.equal(page.$('#drawer [id="ticket-description-d-nit"]').textContent, 'Edited by hand.');
});

test('a ticket raised whose reply did not post says so, and offers to retry only the reply and resolve', async () => {
  const page = await drawer({ records: { 'd-nit': { ...RAISED, replied: false, resolved: false, error: 'GitLab 500' } } });
  const card = cardOf(page, 'd-nit');
  assert.ok(buttonIn(card, 'ABC-4400'));
  assert.ok(!make(page), 'no second ticket is offered');
  assert.match(card.textContent, /ABC-4400 is raised, but the reply has not posted: GitLab 500\./);
  page.server.records = { 'd-nit': RAISED };
  assert.equal(await twoClicks(page, () => page.$('#drawer [id="g-ticket-finish:d-nit"]')), 'Reply and resolve on !7?');
  assert.deepEqual(page.posts(), [['/api/matrix/thread-ticket-finish', { key: KEY, discussionId: 'd-nit' }]]);
  await page.settle();
  assert.doesNotMatch(cardOf(page, 'd-nit').textContent, /is raised, but/);
});

test('Escape in the form leaves the drawer open, as it does in a reply box', async () => {
  const page = await toForm();
  const summary = page.$('#drawer [id="ticket-summary-d-nit"]');
  page.fire(summary, 'keydown', { key: 'Escape' });
  assert.ok(page.run('ui.mr'), 'the drawer is still open');
  page.fire(page.$('#drawer .drawer'), 'keydown', { key: 'Escape' });
  assert.equal(page.run('ui.mr'), null, 'Escape elsewhere still closes it');
});

test('a draft that lands while you type in another thread leaves your focus where it is', async () => {
  let release;
  const page = await drawer({ discussions: [thread('d-nit'), thread('d-two')] });
  page.server.refuse['/api/matrix/thread-ticket-draft'] = () => new Promise((resolve) => { release = () => resolve(null); });
  make(page).click();
  await page.settle();
  buttonIn(cardOf(page, 'd-two'), 'Reply').click();
  assert.equal(page.document.activeElement.id, 'reply-d-two');
  release();
  await page.settle();
  assert.ok(page.$('#drawer [id="ticket-summary-d-nit"]'));
  assert.equal(page.document.activeElement.id, 'reply-d-two');
});

test('the button is on the Findings tab\'s thread blocks and the threads under Needs you too', async () => {
  const finding = {
    id: 'f1', key: KEY, webUrl: URL_OF, severity: 'NIT', kind: 'finding', outcome: null, verdict: null, body: 'NIT: rename d-nit', hunk: null, path: 'src/cache.py', line: 12,
    side: 'new', anchor: null, stale: false, createdBy: 'review', createdAt: AT, status: 'posted', postedAt: AT, auto: null, error: null, discussionId: 'd-nit', replyTo: null,
  };
  const findings = await open({ snap: snapshot({ queue: [finding] }) });
  findings.run(`openMr('${KEY}', 'findings'); ui.mr.findingFilter = 'all'`);
  await findings.settle();
  assert.ok(buttonIn(findings.$('#drawer .item'), 'Make a ticket'));
  const needs = await open({ hash: 'needs-you' });
  buttonIn(needs.$('#main'), 'Show here').click();
  await needs.settle();
  const button = buttonIn(cardOf(needs, 'd-nit', '#main'), 'Make a ticket');
  assert.equal(button.id, 'needs-ticket-make-d-nit');
  button.click();
  await needs.settle();
  assert.equal(needs.document.activeElement.id, 'needs-ticket-summary-d-nit');
});

async function createOn(page, prefix = '') {
  page.$(`[id="${prefix}ticket-make-d-nit"]`).click();
  await page.settle();
  page.server.records = { 'd-nit': RAISED };
  page.server.discussions = [answered('d-nit'), thread('d-two')];
  await twoClicks(page, () => page.$('[id="g-ticket:d-nit"]'));
  await page.settle();
}

test('on the default filter the thread just ticketed stays in view with its chip, which takes the focus', async () => {
  const page = await onDefault({ discussions: [thread('d-nit'), thread('d-two')] });
  await createOn(page);
  assert.match(page.$('#drawer').textContent, /Awaiting you \(1\)/, 'the count is still only what waits on you');
  const chip = buttonIn(cardOf(page, 'd-nit'), 'ABC-4400');
  assert.ok(chip, 'the resolved thread is still listed, with the new key');
  assert.equal(page.document.activeElement.id, 'ticket-chip-d-nit');
  assert.ok(cardOf(page, 'd-two'));
  assert.deepEqual(page.errors, []);
});

test('the toast after a ticket is made opens it, for when the card has gone from view', async () => {
  const page = await onDefault({ discussions: [thread('d-nit'), thread('d-two')] });
  await createOn(page);
  assert.match(page.$('#toast').textContent, /Done/);
  buttonIn(page.$('#toast'), 'ABC-4400').click();
  await page.settle();
  assert.deepEqual(page.posts().at(-1), ['/api/open', { url: RAISED.url }]);
});

test('a ticket whose resolve failed keeps its thread and the retry in view on the default filter', async () => {
  const stuck = answered('d-nit', { resolved: false });
  const page = await onDefault({ discussions: [stuck, thread('d-two')], records: { 'd-nit': { ...RAISED, resolved: false, error: 'GitLab 503' } } });
  assert.match(page.$('#drawer').textContent, /Awaiting you \(1\)/);
  assert.ok(page.$('#drawer [id="g-ticket-finish:d-nit"]'), 'Retry the resolve is offered');
  assert.match(cardOf(page, 'd-nit').textContent, /ABC-4400 is raised, but the thread is not resolved yet: GitLab 503\./);
});

test('on the Findings tab\'s default filter the finding just ticketed stays in view with its chip', async () => {
  const posted = (id, discussionId) => ({
    id, key: KEY, webUrl: URL_OF, severity: 'NIT', kind: 'finding', outcome: null, verdict: null, body: 'NIT: rename ' + discussionId, hunk: null, path: 'src/cache.py', line: 12,
    side: 'new', anchor: null, stale: false, createdBy: 'review', createdAt: AT, status: 'posted', postedAt: AT, auto: null, error: null, discussionId, replyTo: null,
  });
  const page = await onDefault({ snap: snapshot({ queue: [posted('f1', 'd-nit'), posted('f2', 'd-two')] }), discussions: [thread('d-nit'), thread('d-two')] }, 'findings');
  assert.match(page.$('#drawer').textContent, /Needs you \(2\)/);
  await createOn(page, 'item-');
  assert.match(page.$('#drawer').textContent, /Needs you \(1\)/);
  const block = page.$$('#drawer .item').find((n) => n.textContent.includes('NIT: rename d-nit'));
  assert.ok(buttonIn(block, 'ABC-4400'), 'the finding is still listed, with the new key');
  assert.equal(page.document.activeElement.id, 'item-ticket-chip-d-nit');
});

test('under Needs you the thread just ticketed stays with its chip while the MR still waits on you', async () => {
  const page = await open({ hash: 'needs-you', discussions: [thread('d-nit'), thread('d-two')] });
  buttonIn(page.$('#main'), 'Show here').click();
  await page.settle();
  await createOn(page, 'needs-');
  assert.ok(buttonIn(cardOf(page, 'd-nit', '#main'), 'ABC-4400'));
  assert.equal(page.document.activeElement.id, 'needs-ticket-chip-d-nit');
});

test('a ticket whose key never came back says so under its epic, and offers neither a new ticket nor a retry', async () => {
  const epic = { key: 'ABC-3789', summary: 'Native access control', url: 'https://example.atlassian.net/browse/ABC-3789' };
  const page = await drawer({ records: { 'd-nit': { ticket: null, epic, summary: DRAFT.summary, error: 'acli made it but did not say its key' } } });
  const card = cardOf(page, 'd-nit');
  assert.match(card.textContent, /A ticket under ABC-3789 has no key here, as acli made it but did not say its key\. Look under the epic before raising another/);
  assert.ok(buttonIn(card, 'ABC-3789'), 'the epic opens, to find it under');
  assert.ok(!make(page));
  assert.ok(!page.$('#drawer [id="g-ticket-finish:d-nit"]'));
  page.server.records = { 'd-nit': { ticket: null, epic, summary: DRAFT.summary, making: true } };
  page.run(`readRaised('${KEY}')`);
  await page.settle();
  assert.match(cardOf(page, 'd-nit').textContent, /A ticket is being made under ABC-3789…/);
  assert.deepEqual(page.errors, []);
});
