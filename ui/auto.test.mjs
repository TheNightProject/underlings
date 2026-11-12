import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-05T12:00:00Z';
const KEY = 'acme/engine!7';

function row(extra = {}) {
  return {
    key: KEY, iid: 7, repo: 'engine', title: 'Make the engine faster', webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7', author: 'ivan', reviewers: ['frank'],
    approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: 'ABC-1', updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'feat/7',
    sha: 'aaa111', agentHandle: null, watch: null, flags: {}, phase: 'open', count: 0, mood: 'quiet', verdict: null, agent: null, level: 'comments', ...extra,
  };
}

function driver(extra = {}) {
  return {
    state: 'here', why: 'Underlings drives full auto', fix: null, holder: null, busy: null,
    lastPollAt: Date.parse('2026-11-05T10:42:00Z'), nextPollAt: Date.parse('2026-11-05T10:44:00Z'), recent: [], problems: 0, stateDir: '/Users/frank/.local/state/underlings/engine', ...extra,
  };
}

function item(id, extra = {}) {
  return {
    id, key: KEY, webUrl: row().webUrl, severity: 'MINOR', kind: 'finding', outcome: null, verdict: null, body: 'Finding ' + id, hunk: null, path: null, line: null, side: null,
    anchor: null, stale: false, createdBy: 'auto:p1', createdAt: AT, status: 'pending', postedAt: null, sending: null, editing: null, error: null, discussionId: null, replyTo: null,
    auto: { pass: 'p1', level: 'comments', sendAt: new Date(Date.now() + 45_000).toISOString(), held: null }, ...extra,
  };
}

function snapshot(matrix = {}, agents = []) {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1, started: 2 },
    agents,
    artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: 120, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [row()] },
      fullAuto: [{ username: 'ivan', level: 'comments' }, { username: 'erin', level: 'shadow' }], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
      autoLog: [], autoCounts: { sent: 0, waiting: 0, shadow: 0 }, driver: driver(), ...matrix,
    },
  };
}

async function served(snap, answer = () => ({ ok: true, text: 'done' })) {
  const page = await openPage();
  const writes = [];
  const reads = [];
  page.window.fetch = async (path, init = {}) => {
    if (init.method === 'POST') writes.push([path, JSON.parse(init.body)]);
    else if (path !== '/api/state') reads.push(path);
    const reply = path === '/api/state' ? page.snap : await answer(path, init);
    const status = reply?.status ?? (reply ? 200 : 404);
    return { ok: status === 200, status, json: async () => reply, text: async () => reply?.message ?? '' };
  };
  page.snap = snap;
  return Object.assign(page, { writes, reads, open(hash, next = page.snap) { page.snap = next; page.show(next, hash); } });
}

const label = (page, m) => page.run(`JSON.stringify(fullAutoLabel(${JSON.stringify(m)}))`);
const buttonsIn = (root, scope, text) => (scope ? root.$$(scope + ' button') : root.querySelectorAll('button')).filter((b) => b.textContent.startsWith(text));

test('every state full auto can be in gets its own label, tone and reason', async () => {
  const page = await openPage();
  page.show(snapshot());
  const m = (d, extra = {}) => JSON.parse(label(page, snapshot({ driver: driver(d), ...extra }).matrix));
  assert.deepEqual(m({}), { brief: 'Full auto on', text: 'Full auto on for 2', tone: '', title: 'Checked 10:42, next at 10:44' });
  assert.deepEqual([m({}, { paused: true }).text, m({}, { paused: true }).tone], ['Full auto paused', 'warn']);
  const off = m({}, { fullAuto: [] });
  assert.deepEqual([off.text, off.tone], ['Full auto off', 'idle']);
  assert.match(off.title, /Auto re-review and run output still run here/);
  assert.deepEqual([m({ state: 'starting', why: 'taking the full auto lock' }).text, m({ state: 'starting', why: 'taking the full auto lock' }).tone], ['Full auto starting', 'warn']);
  const stopped = m({ state: 'stopped', why: 'GITLAB_TOKEN is not set' });
  assert.deepEqual([stopped.text, stopped.tone, stopped.title], ['Full auto stopped', 'off', 'GITLAB_TOKEN is not set.']);
  assert.equal(m({ busy: { step: 'poll', since: Date.now() - 3 * 60_000 }, problems: 1 }).text, 'Full auto on for 2, busy 3 min, 1 problem');
  assert.equal(m({ busy: { step: 'tick', since: Date.now() - 30_000 } }).text, 'Full auto on for 2', 'a short step adds nothing');
  assert.equal(JSON.parse(page.run('JSON.stringify(fullAutoLabel({ available: false, error: "starting" }))')).text, 'Full auto stopped');
});

test('the rail shows that label, links to Full auto, and names the review engine when it is not loaded', async () => {
  const since = Date.now() - 30_000;
  const page = await served(snapshot({ driver: driver({ busy: { step: 'poll', since } }) }));
  page.open('overview');
  const link = page.$('#health a.health-link');
  assert.equal(link.getAttribute('href'), '#full-auto');
  assert.equal(link.textContent, 'Full auto on for 2');
  assert.equal(link.getAttribute('title'), 'Checking the MRs since ' + new Date(since).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
  page.open('overview', snapshot({ driver: driver({ state: 'stopped', why: 'GITLAB_TOKEN is not set' }) }));
  assert.equal(page.$('#health a.health-link span').className, 'off');
  page.open('overview', { ...snapshot(), matrix: { available: false, error: 'could not load the review engine from /engine/dist/engine.js: Cannot find module' } });
  assert.match(page.$('#health').textContent, /^Review engine: could not load the review engine from/);
  assert.doesNotMatch(page.$('#health').textContent, /thematrix|open|closed/i);
});

test('the Full auto view says why it is stopped and offers the fix beside it', async () => {
  const page = await served(snapshot());
  const banner = (d) => {
    page.open('full-auto', snapshot({ driver: driver(d) }));
    return page.$$('#main .banner').map((b) => b.textContent).join(' | ');
  };
  assert.equal(banner({ state: 'stopped', why: 'GITLAB_TOKEN is not set' }), 'Full auto is stopped: GITLAB_TOKEN is not set.');
  banner({ state: 'stopped', fix: 'rebuild', why: 'the review engine needs rebuilding: this build has no takeAutoTurn' });
  assert.equal(buttonsIn(page, '#main .banner', 'Rebuild the engine').length, 1);
  banner({ state: 'stopped', fix: 'settings', why: 'there is no workspace root to launch reviews in' });
  assert.equal(page.$('#main .banner a.fix-link').getAttribute('href'), '#settings');
  banner({ state: 'stopped', fix: 'token', why: 'GITLAB_TOKEN is not set' });
  assert.ok(page.$('#main .banner #gitlab-token'));
  assert.match(banner({}), /^Live for 2 people\. Anything it queues waits 120 s in the review queue/);
  page.open('full-auto', snapshot());
  assert.match(page.$('#main').textContent, /Shared state in ~\/\.local\/state\/underlings\/engine/);
  assert.match(page.$('#main .head p').textContent, /Full auto runs here, in Underlings, whether or not this page is open\./);
});

test('Pause and Resume in the Full auto header and on the paused banner post the one kill switch', async () => {
  const page = await served(snapshot());
  page.open('full-auto');
  buttonsIn(page, '#main .head', 'Pause full auto')[0].click();
  page.open('full-auto', snapshot({ paused: true }));
  buttonsIn(page, '#main .head', 'Resume full auto')[0].click();
  buttonsIn(page, '#main .banner', 'Resume')[0].click();
  await page.settle(50);
  assert.deepEqual(page.writes, [['/api/matrix/pause', {}], ['/api/matrix/pause', {}], ['/api/matrix/pause', {}]]);
});

test('Activity lists what full auto did, newest first, with problems in red and repeats folded', async () => {
  const recent = [
    { at: Date.parse('2026-11-05T10:44:05Z'), text: 'not launching: the agents could not be listed (EACCES)', error: true, times: 3 },
    { at: Date.parse('2026-11-05T10:42:10Z'), text: 'Reviewing acme/engine!7, sent 2', error: false },
  ];
  const page = await served(snapshot({ driver: driver({ recent }) }));
  page.open('full-auto');
  const items = page.$$('#main ol.activity li');
  assert.deepEqual(items.map((li) => [li.className, li.childNodes[1].textContent]), [
    ['bad', 'not launching: the agents could not be listed (EACCES) · 3 times'],
    ['', 'Reviewing acme/engine!7, sent 2'],
  ]);
  page.open('full-auto', snapshot({ driver: driver({ recent: [] }) }));
  assert.match(page.$('#main').textContent, /Nothing yet\. Each step full auto takes shows here/);
});

test('Sent without you shows the counts and a row for each thing sent, each opening its MR', async () => {
  const autoLog = Array.from({ length: 12 }, (_, i) => ({ at: AT, key: KEY, mr: 'engine!7', what: i ? 'MINOR' : 'reply, fixed, resolved', text: 'Line ' + i + '\nmore' }));
  const page = await served(snapshot({ autoLog, autoCounts: { sent: 12, waiting: 1, shadow: 3 } }));
  page.open('full-auto');
  const section = page.$$('#main section').find((s) => s.querySelector('h2').textContent === 'Sent without you');
  assert.deepEqual(section.querySelectorAll('.row-head .pill').map((p) => p.textContent), ['12 sent', '1 handed back', '3 shadow waiting']);
  assert.equal(section.querySelectorAll('tbody tr').length, 10);
  assert.deepEqual(section.querySelectorAll('tbody tr')[0].querySelectorAll('td').slice(1).map((td) => td.textContent), ['engine!7', 'reply, fixed, resolved', 'Line 0']);
  assert.equal(section.querySelector('button.ref').dataset.key, KEY);
  buttonsIn(page, '#main', 'Show all 12')[0].click();
  assert.equal(page.$$('#main section').find((s) => s.querySelector('h2').textContent === 'Sent without you').querySelectorAll('tbody tr').length, 12);
});

test('Sending soon lists what will send itself, each with a guarded Discard, and nothing Needs you shows', async () => {
  const queue = [item('a', { sendsItself: true }), item('b', { sendsItself: true, sending: { by: 'auto:t1', at: AT } }), item('c', { sendsItself: false, auto: { pass: 'p1', level: 'shadow', held: null } }), item('d', { sendsItself: false, auto: null, createdBy: 'review' })];
  const page = await served(snapshot({ queue }));
  page.open('full-auto');
  const section = () => page.$$('#main section').find((s) => s.querySelector('h2').textContent === 'Sending soon');
  assert.deepEqual(section().querySelectorAll('.row').map((r) => r.dataset.id), ['a', 'b']);
  assert.deepEqual(section().querySelectorAll('button').filter((b) => b.textContent === 'Discard').length, 1, 'not on one already being sent');
  section().querySelectorAll('button').find((b) => b.textContent === 'Discard').click();
  assert.deepEqual(page.writes, [], 'armed first');
  section().querySelectorAll('button').find((b) => b.textContent === 'Discard it before it sends?').click();
  await page.settle(20);
  assert.deepEqual(page.writes.at(-1), ['/api/matrix/discard', { id: 'a' }]);
  page.open('full-auto', snapshot({ queue: [] }));
  assert.match(section().textContent, /Nothing is waiting to send itself/);
});

test('a pass row reads how far it got and opens to the items it queued and the threads it handed back', async () => {
  const autoPasses = [
    { key: KEY, id: 'p1', sha: 'aaa111', author: 'ivan', trigger: 'commit', launchedAt: AT, doneAt: null, state: 'finishing', handedBack: ['d-back'] },
    { key: 'acme/portal!88', id: 'p2', sha: 'bbb', author: 'erin', trigger: 'new', launchedAt: AT, doneAt: AT, state: 'closed', handedBack: [] },
  ];
  const queue = [item('q1'), item('q2', { auto: { ...item('q2').auto, pass: 'other' } })];
  const detail = { me: 'frank', discussions: [{ id: 'd-back', resolved: false, notes: [{ author: 'frank', body: 'Please fix', createdAt: AT }, { author: 'ivan', body: 'Why?', createdAt: AT }], awaitsYou: true, handedBack: true }] };
  const page = await served(snapshot({ autoPasses, queue }), (path) => (path.startsWith('/api/matrix/mr?') ? detail : { ok: true }));
  page.open('full-auto');
  const results = page.$$('#main table.passes tbody tr').map((tr) => tr.querySelectorAll('td')[3].textContent);
  assert.deepEqual(results, ['finishing', 'closed']);
  page.$('#main table.passes button.disclose').click();
  await page.settle(50);
  const opened = page.$('#main tr.pass-detail');
  assert.deepEqual(opened.querySelectorAll('details summary').map((s) => s.textContent), ['Finding q1']);
  assert.ok(page.reads.some((p) => p.startsWith('/api/matrix/mr?')), 'the handed-back threads are read');
  assert.match(page.$('#main tr.pass-detail').textContent, /Why\?/);
});

test('an auto item\'s pill says what happens to it next', async () => {
  const page = await openPage();
  const pill = (q, m = {}) => page.run(`autoPill(${JSON.stringify(q)}, ${JSON.stringify({ paused: false, driver: driver(), queue: [], ...m })})?.textContent ?? null`);
  const later = new Date(Date.now() + 45_000).toISOString();
  const auto = { pass: 'p1', level: 'comments', sendAt: later, held: null };
  assert.equal(pill(item('a', { auto: { ...auto, level: 'shadow' } })), 'shadow, never sends');
  assert.match(pill(item('a', { auto })), /^auto, sends in (44|45) s$/);
  assert.equal(pill(item('a', { auto: { ...auto, sendAt: '2026-11-05T11:00:00Z' } })), 'auto, sending now');
  assert.equal(pill(item('a', { auto, sending: { by: 'auto:t', at: AT } })), 'auto, sending now');
  assert.equal(pill(item('a', { auto, editing: { by: 'thematrix:1', until: new Date(Date.now() + 60_000).toISOString() } })), 'auto, being edited');
  assert.match(pill(item('a', { auto, editing: { by: 'thematrix:1', until: '2026-11-05T11:00:00Z' } })), /^auto, sends in/, 'a lapsed mark is ignored');
  assert.equal(pill(item('a', { auto }), { paused: true }), 'auto, paused');
  assert.equal(pill(item('a', { auto }), { driver: driver({ state: 'stopped' }) }), 'auto, waits: full auto stopped');
  assert.equal(pill(item('a', { auto: { ...auto, held: 'its author is not in full auto any more' } })), 'auto, handed back');
  const verdict = item('v', { kind: 'verdict', verdict: 'approve', auto });
  assert.equal(pill(verdict, { queue: [verdict, item('a', { auto })] }), 'auto, after its comments');
  assert.equal(pill(item('a', { status: 'posted', auto: { ...auto, sentAuto: true } })), 'sent without you');
  assert.equal(pill(item('a', { status: 'discarded', auto: { ...auto, superseded: 'the head moved while it was being reviewed' } })), 'dropped: the head moved while it was being reviewed');
  assert.equal(pill(item('a', { status: 'expired', expiredReason: 'MR merged', auto })), 'not posted: MR merged', 'never sending now, however due it was');
  assert.equal(pill(item('a', { status: 'expired', expiredReason: null, auto: { ...auto, sendAt: new Date(Date.now() - 1000).toISOString() } })), 'not posted: MR closed');
  assert.equal(pill(item('a', { auto: null })), null);
});

test('Edit marks the item as being edited, renewed while it stays open, and Cancel clears the mark', async () => {
  const page = await served(snapshot({ queue: [item('q1')] }));
  page.open('review-queue');
  buttonsIn(page, '#main', 'Edit')[0].click();
  await page.settle(20);
  assert.deepEqual(page.writes, [['/api/matrix/editing', { id: 'q1', editing: true }]]);
  assert.equal(typeof page.run('editRenewal'), 'object', 'a renewal is waiting');
  buttonsIn(page, '#main', 'Cancel')[0].click();
  await page.settle(20);
  assert.deepEqual(page.writes.at(-1), ['/api/matrix/editing', { id: 'q1', editing: false }]);
});

test('Review runs shows the latest run on each MR or ticket, its conversation while it lives and its last words after', async () => {
  const live = { handle: 'term-live', name: 'review-Engine-7', title: 'review !7', kind: 'review', mr: KEY, ticket: null, worktree: null, cwd: '/Users/frank/ws', state: 'working', since: 1, lastAt: Date.parse(AT), alive: true, said: '', outcome: null, ask: null };
  const ended = (key, extra = {}) => ({ key, webUrl: '', startedAt: AT, endedAt: AT, status: 'ended', worktreePath: '/Users/frank/ws', tail: [], terminal: null, live: false, working: false, ...extra });
  const runs = [
    { key: KEY, webUrl: '', startedAt: AT, endedAt: null, status: 'working', worktreePath: '/Users/frank/ws', tail: ['working…'], terminal: 'term-live', live: true, working: true },
    ended('acme/portal!88', { tail: ['last line'], terminal: 'term-gone' }),
    { key: 'ticket:ABC-12', webUrl: '', startedAt: AT, endedAt: null, status: 'launch failed', worktreePath: null, tail: ['No checkout at /work/engine'], terminal: null, live: false, working: false },
    ended('acme/portal!90'),
    { ...ended('acme/portal!91'), endedAt: null, status: 'working', terminal: 'term-new' },
  ];
  const places = {
    [KEY]: { id: 'w1', name: 'review-Engine-7', removable: false, blocker: 'an agent in it is still working' },
    'acme/portal!88': { id: 'claude:x', name: 'review-Portal-88', removable: true, blocker: null },
    'acme/portal!90': { id: 'claude:y', name: 'review-Portal-90', removable: true, blocker: null },
  };
  const rows = [row({ agent: 'working' }), row({ key: 'acme/portal!88', iid: 88, repo: 'portal' }), row({ key: 'acme/portal!91', iid: 91, repo: 'portal', agentStarting: true })];
  const whole = { key: 'acme/portal!88', tail: ['first line', 'middle', 'last line'] };
  const page = await served(snapshot({ runs, inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows } }, [live]), (path, init) => {
    if (path === '/api/matrix/run-workspaces') return places;
    if (path.startsWith('/api/matrix/run?')) return whole;
    if (path.startsWith('/api/agents/conversation')) return { ...live, pending: null, entries: [{ kind: 'said', at: 1, text: 'reading the diff' }] };
    return init?.method === 'POST' ? { ok: true, text: 'done' } : null;
  });
  page.open('review-runs');
  await page.settle(50);
  assert.match(page.$('#main .head p').textContent, /^The latest review, fix or ticket agent on each MR or ticket, newest first, with what it last said\.$/);
  const cards = page.$$('#main .row.run');
  assert.deepEqual(cards.map((c) => c.querySelector('.pill').textContent), ['working', 'ended', 'launch failed', 'ended', 'working']);
  assert.deepEqual(cards.map((c) => buttonsIn(c, '', 'Remove workspace').length), [0, 1, 0, 1, 0], 'its MR closed or not, a run offers Remove where clean-up would remove it');
  assert.equal(cards[0].textContent.includes('review-Engine-7 stays: an agent in it is still working'), true);
  assert.equal(cards[0].querySelectorAll('.meta')[1].textContent, '~/ws');
  assert.ok(buttonsIn(page, '#main .row.run', 'Conversation').length === 1, 'the live run shows its agent\'s conversation');
  assert.deepEqual(cards.map((c) => buttonsIn(c, '', 'Retry').length), [0, 1, 0, 0, 0], 'Retry only where no agent is on the MR or on its way');
  assert.equal(cards[2].querySelector('.ticket-ref').textContent, 'ABC-12');
  buttonsIn(page, '#main', 'Last words')[0].click();
  await page.settle(50);
  assert.equal(page.$$('#main .row.run')[1].querySelector('pre.console').textContent, 'first line\nmiddle\nlast line');
  assert.ok(page.reads.includes('/api/matrix/run?key=acme%2Fportal%2188'));
  buttonsIn(page, '#main', 'Stop')[0].click();
  buttonsIn(page, '#main', 'Stop review-Engine-7?')[0].click();
  buttonsIn(page, '#main', 'Retry')[0].click();
  buttonsIn(page, '#main', 'Retry the review of !88?')[0].click();
  buttonsIn(page.$$('#main .row.run')[3], '', 'Remove workspace')[0].click();
  buttonsIn(page, '#main', 'Remove review-Portal-90?')[0].click();
  await page.settle(50);
  assert.deepEqual(page.writes, [
    ['/api/matrix/agent-stop', { handle: 'term-live' }],
    ['/api/matrix/review', { key: 'acme/portal!88' }],
    ['/api/agents/cleanup', { remove: ['claude:y'], close: [] }],
  ]);
  assert.equal(page.reads.filter((p) => p === '/api/matrix/run-workspaces').length, 2, 'asked again once a workspace has gone');
});

test('a fix run is listed as the fix on its MR, opens that MR\'s agent, reads its own screen and offers no review Retry', async () => {
  const fix = { key: 'fix:' + KEY, webUrl: '', startedAt: AT, endedAt: AT, status: 'ended', worktreePath: '/Users/frank/fix-Engine-7', tail: ['pushed'], terminal: 'term-fix', live: false, working: false };
  const page = await served(snapshot({ runs: [fix], inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [row()] } }), (path) => {
    if (path === '/api/matrix/run-workspaces') return {};
    if (path.startsWith('/api/matrix/run?')) return { key: fix.key, tail: ['read whole'] };
    return null;
  });
  page.open('review-runs');
  await page.settle(50);
  const card = page.$('#main .row.run');
  const ref = card.querySelector('.ref');
  assert.equal(ref.textContent, 'fix ' + KEY);
  assert.equal(ref.dataset.key, KEY);
  assert.equal(buttonsIn(card, '', 'Retry').length, 0, 'Retry would launch a review, not a fix');
  buttonsIn(page, '#main', 'Last words')[0].click();
  await page.settle(50);
  assert.ok(page.reads.includes('/api/matrix/run?' + new URLSearchParams({ key: fix.key })), page.reads.join(', '));
  assert.equal(page.$('#main .row.run pre.console').textContent, 'read whole');
  ref.click();
  assert.equal(page.run('ui.mr?.tab'), 'agent');
});

test('an MR whose review full auto has just launched offers no Review until its agent is listed', async () => {
  const page = await served(snapshot({ inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [row({ agentStarting: true })] } }));
  page.open('merge-requests');
  assert.equal(buttonsIn(page, '#main .mr', 'Review').length, 0);
  page.open('merge-requests', snapshot());
  assert.equal(buttonsIn(page, '#main .mr', 'Review').length, 1);
});

test('Edit on an item full auto has started sending closes the editor and says why', async () => {
  const page = await served(snapshot({ queue: [item('q1')] }), (path) => (path === '/api/matrix/editing' ? { status: 409, message: 'full auto is sending this right now' } : null));
  page.open('review-queue');
  buttonsIn(page, '#main', 'Edit')[0].click();
  await page.settle(20);
  assert.equal(page.$$('#main textarea').length, 0);
  assert.equal(page.$('#toast').textContent, 'full auto is sending this right now');
});

test('the rail counts review runs whose agent is working now', async () => {
  const runs = [{ working: true }, { working: false }, { working: true }].map((r, i) => ({ key: 'acme/engine!' + (i + 1), startedAt: AT, status: 'working', tail: [], live: r.working, ...r }));
  const page = await served(snapshot({ runs }));
  page.open('overview');
  assert.equal(page.$('[data-count="runs"]').textContent, '2');
});

test('Settings marks a blank workspace root red, but only while full auto has none to launch into', async () => {
  const rows = [{ key: 'workspaceRoot', label: 'Workspace', hint: 'the checkout agents run against.', kind: 'text', bounds: null, value: '' }];
  const settings = { rows, repos: { filter: '', matching: [], total: 0, perRefresh: 1, perMinute: 1, heavy: false } };
  const page = await served(snapshot({ driver: driver({ state: 'stopped', fix: 'settings', why: 'there is no workspace root to launch reviews in' }) }), (path) => (path.startsWith('/api/matrix/settings') ? settings : null));
  page.open('settings');
  await page.settle(50);
  assert.equal(page.$('#main .setting .hint.bad').textContent, 'Full auto cannot launch reviews while this is blank.');
  page.open('settings', snapshot());
  await page.settle(50);
  assert.equal(page.$('#main .setting .hint.bad'), null);
});
