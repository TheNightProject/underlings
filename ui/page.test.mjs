import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const KEY = 'acme/engine!7';
const AT = '2026-11-05T12:00:00Z';

function row() {
  return {
    key: KEY, iid: 7, repo: 'engine', title: 'Make the engine faster', webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7', author: 'ivan', reviewers: ['frank'],
    approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: 'ABC-1', updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'feat/7',
    sha: 'aaa111', agentHandle: null, watch: null, flags: { waitingOnYou: true }, phase: 'open', count: 0, mood: 'awaitingYou', verdict: null, agent: null, level: null,
  };
}

function snapshot() {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    release: { version: '1.0.0', commit: 'aaa111', banner: null, updates: { count: 0 } },
    agents: [],
    artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [row()] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

function finding() {
  return {
    id: 'f1', key: KEY, webUrl: row().webUrl, severity: 'MINOR', kind: 'finding', outcome: null, verdict: null, body: 'This authorises every caller.',
    hunk: '@@ -1,2 +1,2 @@\n-' + 'x'.repeat(30) + '\n+' + 'which authorises '.repeat(12), path: 'src/auth.ts', line: 2, side: 'new', anchor: 1, stale: false,
    createdBy: 'review', createdAt: AT, status: 'pending', postedAt: null, auto: null, error: null, discussionId: null, replyTo: null,
  };
}

const css = await readFile(new URL('./00-base.css', import.meta.url), 'utf8');
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({ selectors: selectors.split(',').map((s) => s.trim()), body }));
const rulesFor = (node) => RULES.filter((r) => r.selectors.some((s) => /^[\w.#-]+$/.test(s) && node.matches(s)));

async function pageWithDrawer(tab = 'overview', snap = snapshot()) {
  const page = await openPage();
  page.show(snap, 'merge-requests');
  page.run(`openMr('${KEY}', '${tab}')`);
  await page.settle();
  return page;
}

const textNodes = (node) => node.childNodes.filter((n) => n.nodeType === 3).map((n) => n.data);
const drawerButton = (page, label) => page.$$('#drawer button').find((b) => b.textContent === label);

test('the rail has the game first, Tickets, Standup, Calendar, Email and Slack under Work, after Now, QA under Team, and links every view once in reading order, What\'s new from its foot and Setup from Settings', async () => {
  const page = await openPage();
  page.show(snapshot(), 'tickets');
  const groups = page.$$('.rail .navgroup').map((g) => [g.querySelector('h2').textContent, g.querySelectorAll('.navlink').map((a) => a.getAttribute('href'))]);
  assert.deepEqual(groups, [
    ['You', ['#game']],
    ['Now', ['#overview', '#needs-you']],
    ['Work', ['#tickets', '#standup', '#calendar', '#email', '#slack']],
    ['Team', ['#qa']],
    ['Agents', ['#agents', '#artifacts']],
    ['Reviews', ['#merge-requests', '#review-queue', '#full-auto', '#review-runs', '#watching', '#leaderboard', '#settings']],
  ]);
  const foot = page.$$('#health .release-version').map((a) => a.getAttribute('href'));
  assert.deepEqual([...groups.flatMap(([, links]) => links), ...foot, '#setup'].sort(), JSON.parse(page.run('JSON.stringify(Object.keys(VIEWS).map((v) => "#" + v).sort())')));
  assert.deepEqual(page.$$('.navlink').filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.getAttribute('href')), ['#tickets']);
});

test('the rail lists only what it has, never the word null for a missing part', async () => {
  const page = await openPage();
  page.show(snapshot());
  assert.deepEqual(textNodes(page.$('#health')), []);
  page.run('delete window.matrixHealth; render();');
  assert.deepEqual(textNodes(page.$('#health')), []);
  assert.doesNotMatch(page.$('#health').textContent, /null/);
});

test('a drawer tab opens at its top, and a refresh of the same tab keeps the reader\'s place', async () => {
  const page = await pageWithDrawer('threads');
  page.$('#drawer .drawer-body').scrollTop = 900;
  page.run('render()');
  assert.equal(page.$('#drawer .drawer-body').scrollTop, 900);
  page.$('#mr-tab-findings').click();
  assert.equal(page.$('#drawer .drawer-body').scrollTop, 0);
});

test('a drag that starts in the drawer and ends on the backdrop leaves it open, and a click on the backdrop closes it', async () => {
  const page = await pageWithDrawer('threads');
  const backdrop = page.$('#drawer');
  page.fire(page.$('#drawer .drawer-body'), 'pointerdown');
  page.fire(backdrop, 'click');
  assert.equal(page.run('ui.mr?.key'), KEY);
  page.fire(backdrop, 'pointerdown');
  page.fire(backdrop, 'click');
  assert.equal(page.run('ui.mr'), null);
});

test('choosing a drawer tab, or a refresh, leaves keyboard focus on the tab', async () => {
  const page = await pageWithDrawer();
  page.$('#mr-tab-findings').focus();
  page.$('#mr-tab-findings').click();
  assert.equal(page.document.activeElement.id, 'mr-tab-findings');
  page.$('#mr-tab-threads').focus();
  page.run('refresh()');
  await page.settle();
  assert.equal(page.document.activeElement.id, 'mr-tab-threads');
});

test('arming a button in the drawer keeps focus on it, so a second Enter confirms', async () => {
  const page = await pageWithDrawer();
  const approve = drawerButton(page, 'Approve');
  approve.focus();
  approve.click();
  const armed = page.document.activeElement;
  assert.equal(armed.textContent, 'Approve on GitLab?');
  assert.ok(page.$('#drawer').contains(armed));
});

test('nothing behind an open drawer can take focus, and all of it can again once it closes', async () => {
  const page = await pageWithDrawer();
  const focuses = () => {
    const ref = page.$('#main .ref');
    ref.focus();
    return page.document.activeElement === ref;
  };
  assert.equal(focuses(), false);
  page.run('closeMr()');
  assert.equal(focuses(), true);
});

test('closing the drawer returns focus to the MR it was opened from, not the top of the page', async () => {
  const page = await openPage();
  page.show(snapshot(), 'merge-requests');
  const ref = page.$('#main .ref');
  ref.focus();
  ref.click();
  await page.settle();
  page.fire(page.document.activeElement, 'keydown', { key: 'Escape' });
  const back = page.document.activeElement;
  assert.ok(back.classList.contains('ref') && page.$('#main').contains(back), `focus went to ${back.tagName}#${back.id}`);
  assert.equal(back.dataset.key, KEY);
});

test('a refresh that lands after the drawer closes leaves focus on that MR, so the next Tab carries on from its row', async () => {
  const page = await openPage();
  page.show(snapshot(), 'merge-requests');
  const ref = page.$('#main .ref');
  ref.focus();
  ref.click();
  await page.settle();
  page.fire(page.document.activeElement, 'keydown', { key: 'Escape' });
  page.run('refresh()');
  await page.settle();
  const back = page.document.activeElement;
  assert.notEqual(back, ref, 'the refresh drew the list again');
  assert.ok(back.classList.contains('ref') && page.$('#main').contains(back), `focus went to ${back.tagName}#${back.id}`);
  assert.equal(back.dataset.key, KEY);
});

test('a render that replaces the focused button leaves the page scrolled where it was, rather than anchored to the lost button', () => {
  assert.ok(RULES.some((r) => r.selectors.includes('html') && /overflow-anchor:\s*none/.test(r.body)));
});

test('a finding\'s long diff line scrolls in its own box rather than widening the drawer at phone width', async () => {
  const snap = snapshot();
  snap.matrix.queue = [finding()];
  const page = await pageWithDrawer('findings', snap);
  const diff = page.$('#drawer pre.diff');
  assert.ok(diff);
  for (let n = diff.parentNode; !n.classList.contains('drawer-body'); n = n.parentNode) {
    const rules = rulesFor(n);
    const grows = rules.some((r) => /display:\s*grid/.test(r.body)) && !rules.some((r) => /min-width:\s*0|grid-template-columns:\s*minmax\(0,/.test(r.body));
    assert.ok(!grows, `.${n.className} grows to fit the diff's longest line`);
  }
});

test('at phone width the rail still offers Reload and says when the page has changed', async () => {
  const narrow = /@media \(max-width: 780px\) \{([\s\S]*?)\n\}/.exec(css)[1];
  const hidden = [...narrow.matchAll(/([^{}]+)\{[^}]*display:\s*none[^}]*\}/g)].flatMap(([, selectors]) => selectors.split(',').map((s) => s.trim()));
  const page = await openPage();
  page.run('ui.bootVersion = 0.5');
  page.show(snapshot());
  const reload = page.$$('#health button').find((b) => b.textContent.startsWith('Reload'));
  const notice = page.$$('#health span').find((s) => s.textContent === 'The page has changed');
  for (const node of [reload, notice]) {
    assert.ok(node);
    for (let n = node; n.nodeType === 1; n = n.parentNode) {
      for (const selector of hidden.filter((s) => /^[\w.#-]+$/.test(s))) assert.ok(!n.matches(selector), `${selector} hides ${node.textContent} at phone width`);
    }
  }
});

test('the person filter lists authors with the MRs they wrote, and picking one shows only those, not the ones they review', async () => {
  const snap = snapshot();
  const mr = (iid, author, reviewers) => ({ ...row(), key: 'acme/engine!' + iid, iid, title: 'MR ' + iid, author, reviewers });
  snap.matrix.inbox.rows = [mr(1, 'ivan', ['frank']), mr(2, 'ed', ['ivan']), mr(3, 'ed', ['ivan', 'rupert'])];
  const page = await openPage();
  page.show(snap, 'merge-requests');
  const person = page.$('#mr-person');
  assert.deepEqual(person.querySelectorAll('option').map((o) => o.textContent), ['Any author', 'ed (2)', 'ivan (1)']);
  person.value = 'ivan';
  page.fire(person, 'change');
  assert.deepEqual(page.$$('#main .mr .ref').map((r) => r.textContent), ['MR 1']);
});
