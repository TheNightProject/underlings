import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const KEY = 'acme/engine!7';
const AT = '2026-11-05T12:00:00Z';

function row(key = KEY, extra = {}) {
  const iid = Number(key.split('!')[1]);
  return {
    key, iid, repo: key.split('/')[1].split('!')[0], title: 'MR ' + iid, webUrl: 'https://gitlab.com/' + key.replace('!', '/-/merge_requests/'), author: 'ivan', reviewers: ['frank', 'rupert'],
    approvedBy: ['rupert'], draft: false, pipeline: 'FAILED', ticket: 'ABC-1', updatedAt: AT, unresolved: 2, threads: null, mergeStatus: 'DISCUSSIONS_NOT_RESOLVED', sourceBranch: 'feat/' + iid,
    sha: 'aaa111bbb222', agentHandle: null, watch: null, flags: { waitingOnYou: true }, phase: 'open', count: 0, mood: 'awaitingYou', verdict: null, agent: null, level: null, ...extra,
  };
}

function snapshot(rows = [row()], queue = []) {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue, runs: [], autoPasses: [],
    },
  };
}

function finding(id, path, key = KEY) {
  return {
    id, key, webUrl: row(key).webUrl, severity: 'MINOR', kind: 'finding', outcome: null, verdict: null, body: 'Check ' + path, hunk: '@@ -1 +1 @@\n-a\n+b', path, line: 1, side: 'new',
    anchor: 2, stale: false, createdBy: 'review', createdAt: AT, status: 'pending', postedAt: null, auto: null, error: null, discussionId: null, replyTo: null,
  };
}

function detail(key, over = {}) {
  const r = row(key);
  return {
    key, me: 'frank', fetchedAt: AT,
    mr: { iid: r.iid, repo: r.repo, title: r.title, webUrl: r.webUrl, author: r.author, reviewers: r.reviewers, approvedBy: r.approvedBy, draft: false, conflicts: false, pipeline: r.pipeline, mergeStatus: r.mergeStatus, sourceBranch: r.sourceBranch, sha: r.sha, ticket: r.ticket, createdAt: AT, updatedAt: AT, unresolved: 2 },
    discussions: [], jobs: [],
    merge: { status: 'discussions_not_resolved', words: 'blocked: unresolved threads', tone: 'blocked' },
    detail: { description: '', clipped: false, targetBranch: 'main', changes: '3', notes: 5 },
    files: { complete: true, list: [] },
    missing: {},
    ...over,
  };
}

const FILE_VIEW = {
  path: 'src/a.py', sha: 'aaa111bbb222', source: 'file', fileTooBig: false, inDiff: true, tooLarge: false, diffComplete: true,
  rows: [{ kind: 'code', line: 1, change: ' ', text: 'print(1)' }], starts: [], threads: 0, placed: 0, unplaced: 0, pending: 0, commentedPaths: ['src/a.py'],
};

async function drawerPage({ rows, queue, over = {}, tab = 'overview', hash = 'merge-requests' } = {}) {
  const requests = [];
  const page = await openPage({
    respond(path) {
      const url = new URL(path, 'http://page');
      requests.push(url);
      if (url.pathname === '/api/matrix/mr') return detail(url.searchParams.get('key'), over);
      if (url.pathname === '/api/matrix/file') return { ...FILE_VIEW, path: url.searchParams.get('path') || 'src/a.py' };
      return null;
    },
  });
  page.show(snapshot(rows, queue), hash);
  if (tab) {
    page.run(`openMr('${KEY}', '${tab}')`);
    await page.settle();
  }
  assert.deepEqual(page.errors, []);
  return { page, requests };
}

function fact(page, label) {
  const kv = page.$('#drawer .kv').childNodes;
  return kv[kv.findIndex((n) => n.tagName === 'DT' && n.textContent === label) + 1];
}

test('tickets and the MRs the page can open are buttons in the description, and HTML in it stays as written', async () => {
  const known = [row(), row('acme/engine!8'), row('acme/web!3')];
  const description = 'Follows !8 and web!3, but not !99 or Done!1.\nSee https://gitlab.com/acme/engine/-/merge_requests/8#note_1 and ABC-12.\n<b>not bold</b>';
  const { page } = await drawerPage({ rows: known, over: { detail: { description, clipped: false, targetBranch: 'main', changes: '1', notes: 0 } } });
  assert.equal(page.$('#drawer .mr-desc').textContent, description);
  assert.deepEqual(page.$$('#drawer .mr-desc .ref').map((b) => [b.dataset.key, b.textContent]), [
    ['acme/engine!8', '!8'], ['acme/web!3', 'web!3'], ['acme/engine!8', 'https://gitlab.com/acme/engine/-/merge_requests/8#note_1'],
  ]);
  assert.deepEqual(page.$$('#drawer .mr-desc .ticket-ref').map((t) => t.textContent), ['ABC-12']);
  assert.equal(page.$$('#drawer .mr-desc *').filter((n) => n.tagName === 'B').length, 0);
  page.$('#drawer .mr-desc .ref').click();
  await page.settle();
  assert.equal(page.run('ui.mr.key'), 'acme/engine!8');
});

test('a Markdown link to an MR or a ticket opens it here, and any other link reads as its label and offers its address', async () => {
  const known = [row(), row('acme/engine!8')];
  const description = 'Move [ABC-4302](https://acme.atlassian.net/browse/ABC-4302) on merge. Gaps from [!8](https://gitlab.com/acme/engine/-/merge_requests/8) and [!79](https://gitlab.com/acme/engine/-/merge_requests/79), see [the docs](https://example.com/docs).';
  const { page } = await drawerPage({ rows: known, over: { detail: { description, clipped: false, targetBranch: 'main', changes: '1', notes: 0 } } });
  assert.equal(page.$('#drawer .mr-desc').textContent, 'Move ABC-4302 on merge. Gaps from !8 and !79, see the docs.');
  assert.deepEqual(page.$$('#drawer .mr-desc .ref').map((b) => b.dataset.key), ['acme/engine!8']);
  assert.deepEqual(page.$$('#drawer .mr-desc .ticket-ref').map((t) => t.textContent), ['ABC-4302']);
  assert.deepEqual(page.$$('#drawer .mr-desc .md-link').map((b) => [b.textContent, b.getAttribute('title')]), [
    ['!79', 'https://gitlab.com/acme/engine/-/merge_requests/79'], ['the docs', 'https://example.com/docs'],
  ]);
});

test('the description reads as Markdown, its headings, tables and code included, and references inside them are still buttons', async () => {
  const known = [row(), row('acme/engine!8')];
  const description = '### What changes\n\n| Repo | MR |\n| --- | --- |\n| engine | !8 |\n\n- **Follows** ABC-12\n- `!8 in code` stays text';
  const { page } = await drawerPage({ rows: known, over: { detail: { description, clipped: false, targetBranch: 'main', changes: '1', notes: 0 } } });
  const desc = page.$('#drawer .mr-desc');
  assert.doesNotMatch(desc.textContent, /###|\| ---/);
  assert.equal(page.$$('#drawer .mr-desc strong')[0].textContent, 'What changes');
  assert.deepEqual(page.$$('#drawer .mr-desc th').map((c) => c.textContent), ['Repo', 'MR']);
  assert.deepEqual(page.$$('#drawer .mr-desc td .ref').map((b) => b.dataset.key), ['acme/engine!8']);
  assert.deepEqual(page.$$('#drawer .mr-desc li .ticket-ref').map((t) => t.textContent), ['ABC-12']);
  assert.deepEqual(page.$$('#drawer .mr-desc code').map((c) => [c.textContent, c.childNodes.length]), [['!8 in code', 1]]);
  assert.equal(page.$$('#drawer .mr-desc .ref').length, 1, 'only the table cell, not the code span');
});

test('only the Jira projects the open MRs use become tickets, so a standard\'s name stays text', async () => {
  const description = 'Reads UTF-8 and checks SHA-256 for ABC-12, XYZ-3 and DEF-9.';
  const known = [row(), row('acme/engine!8', { ticket: 'DEF-1' })];
  const { page } = await drawerPage({ rows: known, over: { detail: { description, clipped: false, targetBranch: 'main', changes: '1', notes: 0 } } });
  assert.equal(page.$('#drawer .mr-desc').textContent, description);
  assert.deepEqual(page.$$('#drawer .mr-desc .ticket-ref').map((t) => t.textContent), ['ABC-12', 'DEF-9']);
});

test('a long description shows its first lines until the reader asks for the rest', async () => {
  const description = Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1)).join('\n');
  const { page } = await drawerPage({ over: { detail: { description, clipped: false, targetBranch: 'main', changes: '1', notes: 0 } } });
  assert.doesNotMatch(page.$('#drawer .mr-desc').textContent, /line 15/);
  page.$$('#drawer button').find((b) => b.textContent === 'Show all 30 lines').click();
  assert.equal(page.$('#drawer .mr-desc').textContent, description);
});

test('the Overview says who is on the MR and why it will not merge, and its pipeline chip opens the Pipeline tab', async () => {
  const { page } = await drawerPage();
  const parts = page.$('#drawer .drawer-body').childNodes.map((n) => n.className);
  assert.ok(parts.indexOf('kv') < parts.indexOf('mr-doc'), `why it will not merge sits above a long description: ${parts}`);
  assert.equal(fact(page, 'Reviewers').textContent, 'frank, rupert (approved)');
  assert.equal(fact(page, 'Approved by').textContent, 'rupert');
  assert.equal(fact(page, 'Merge status').textContent, 'blocked: unresolved threads');
  assert.equal(fact(page, 'Branches').textContent, 'feat/7 → main');
  assert.match(fact(page, 'Changes').textContent, /3 files changed.*2 unresolved.*5 comments/);
  const chip = fact(page, 'Pipeline').querySelector('button');
  assert.equal(chip.textContent, 'failed');
  chip.click();
  assert.equal(page.run('ui.mr.tab'), 'pipeline');
});

test('a watched MR\'s Overview starts with what moved since your review, and each file it names opens the file sheet', async () => {
  const since = { at: new Date(Date.now() - 2 * 36e5).toISOString(), words: '2 commits, judy replied on 1 thread, 2 of your 3 threads resolved, pipeline passed', paths: ['src/a.py', 'src/b.py'], headMoved: true };
  const { page, requests } = await drawerPage({ over: { since } });
  const summary = page.$('#drawer .since');
  const body = page.$('#drawer .drawer-body').textContent;
  assert.ok(body.indexOf('Since your review') < body.indexOf('Author'), 'before the facts');
  assert.equal(summary.querySelector('p').textContent, 'Since your review 2 h ago: 2 commits, judy replied on 1 thread, 2 of your 3 threads resolved, pipeline passed');
  const files = summary.querySelectorAll('.file-row');
  assert.deepEqual(files.map((f) => f.dataset.path), ['src/a.py', 'src/b.py']);
  files[1].click();
  await page.settle();
  assert.deepEqual([...requests.at(-1).searchParams], [['key', KEY], ['path', 'src/b.py']]);
  const { page: unwatched } = await drawerPage({ over: { since: null } });
  assert.equal(unwatched.$('#drawer .since'), null, 'an MR you do not watch has none');
});

test('a row held by someone else offers no Release, and names who holds it; a hold of yours still offers it', async () => {
  const theirs = row(KEY, { flags: { held: true, heldByMe: false }, reviewStates: { judy: 'REQUESTED_CHANGES', frank: 'REVIEWED' } });
  const { page } = await drawerPage({ rows: [theirs], tab: null });
  const mrRow = page.$('#main .mr');
  assert.equal(mrRow.querySelectorAll('button').some((b) => b.textContent === 'Release'), false);
  assert.ok(mrRow.textContent.includes('held by judy'));
  const { page: mine } = await drawerPage({ rows: [row(KEY, { flags: { held: true, heldByMe: true } })], tab: null });
  assert.ok(mine.$('#main .mr').querySelectorAll('button').some((b) => b.textContent === 'Release'));
});

test('the moved pills say what moved since your review', async () => {
  const moved = row(KEY, { mood: 'moved', flags: { changed: true }, movedWhy: 'new commits, 2 threads resolved' });
  const { page } = await drawerPage({ rows: [moved], tab: null });
  const titles = page.$$('#main .mr .pill').map((p) => p.getAttribute('title')).filter(Boolean);
  assert.deepEqual(titles.filter((t) => t.startsWith('Since')), ['Since your review: new commits, 2 threads resolved', 'Since your review: new commits, 2 threads resolved']);
});

test('an engine that cannot read the description still shows the rest of the Overview and says why', async () => {
  const { page } = await drawerPage({ over: { detail: null, files: null, merge: null, missing: { detail: 'this review engine build cannot read it, so rebuild the engine' } } });
  assert.match(page.$('#drawer .mr-doc').textContent, /could not be read: this review engine build cannot read it, so rebuild the engine/);
  assert.equal(fact(page, 'Merge status').textContent, 'discussions not resolved');
  assert.equal(fact(page, 'Author').textContent, 'ivan');
});

test('the Files tab lists every changed file with its counts, marks the commented ones, and opens one in the file sheet', async () => {
  const files = { complete: true, list: [
    { path: 'src/a.py', oldPath: null, change: 'modified', added: 2, removed: 1, tooLarge: false },
    { path: 'src/b.py', oldPath: 'src/old.py', change: 'renamed', added: 0, removed: 0, tooLarge: false },
    { path: 'yarn.lock', oldPath: null, change: 'modified', added: 0, removed: 0, tooLarge: true },
  ] };
  const discussions = [{ id: 'd1', resolved: false, resolvable: true, path: 'src/a.py', line: 1, notes: [], awaitsYou: false, handedBack: false, queuedReply: null }];
  const { page, requests } = await drawerPage({ tab: 'files', queue: [finding('f1', 'src/c.py')], over: { files, discussions } });
  const rows = page.$$('#drawer .file-row');
  assert.deepEqual(rows.map((r) => r.dataset.path), ['src/a.py', 'src/b.py', 'yarn.lock', 'src/c.py']);
  assert.deepEqual(rows.map((r) => r.classList.contains('commented')), [true, false, false, true]);
  assert.match(rows[0].textContent, /\+2 −1.*1 thread/);
  assert.match(rows[1].textContent, /renamed from src\/old\.py/);
  assert.match(rows[2].textContent, /too large to count/);
  assert.match(rows[3].textContent, /not in the diff now.*1 not posted/);
  assert.match(page.$('#drawer .drawer-body').textContent, /3 files changed, \+2 −1, 2 commented on/);
  rows[0].click();
  await page.settle();
  assert.deepEqual([...requests.at(-1).searchParams], [['key', KEY], ['path', 'src/a.py']]);
  assert.equal(page.run('ui.file.path'), 'src/a.py');
  assert.equal(page.run('ui.mr.key'), KEY, 'the drawer stays open under the sheet');
  page.run('closeFile()');
  page.$$('#drawer button').find((b) => b.textContent === 'First commented file').click();
  await page.settle();
  assert.deepEqual([...requests.at(-1).searchParams], [['key', KEY], ['path', '']]);
});

test('an MR with only posted threads, and no changed-file list from an older engine, still has a way into its files', async () => {
  const discussions = [{ id: 'd1', resolved: false, resolvable: true, path: 'src/a.py', line: 4, notes: [], awaitsYou: true, handedBack: false, queuedReply: null }];
  const { page } = await drawerPage({ tab: 'files', over: { files: null, discussions, missing: { files: 'this review engine build cannot read it, so rebuild the engine' } } });
  assert.match(page.$('#drawer .drawer-body').textContent, /changed files could not be read: this review engine build/);
  assert.deepEqual(page.$$('#drawer .file-row').map((r) => r.dataset.path), ['src/a.py']);
  assert.doesNotMatch(page.$('#drawer .file-row').textContent, /not in the diff now/);
  assert.ok(page.$$('#drawer button').some((b) => b.textContent === 'First commented file'));
});

const THREAD_ON_A = { id: 'd1', resolved: false, resolvable: true, path: 'src/a.py', line: 4, notes: [], awaitsYou: true, handedBack: false, queuedReply: null };
const ONLY_F0 = [{ path: 'src/f0.py', oldPath: null, change: 'modified', added: 1, removed: 0, tooLarge: false }];

test('a commented file is called gone from the diff only when GitLab listed every changed file', async () => {
  const rowFor = (page, path) => page.$$('#drawer .file-row').find((r) => r.dataset.path === path).textContent;
  const failed = await drawerPage({ tab: 'files', over: { files: null, discussions: [THREAD_ON_A], missing: { files: 'GitLab 502 Bad Gateway' } } });
  assert.match(failed.page.$('#drawer .drawer-body').textContent, /changed files could not be read: GitLab 502 Bad Gateway/);
  assert.equal(rowFor(failed.page, 'src/a.py'), 'src/a.py1 thread');
  const cut = await drawerPage({ tab: 'files', over: { files: { complete: false, list: ONLY_F0 }, discussions: [THREAD_ON_A] } });
  assert.match(cut.page.$('#drawer .drawer-body').textContent, /GitLab listed only the first 1 files/);
  assert.equal(rowFor(cut.page, 'src/a.py'), 'src/a.py1 thread');
  const whole = await drawerPage({ tab: 'files', over: { files: { complete: true, list: ONLY_F0 }, discussions: [THREAD_ON_A] } });
  assert.equal(rowFor(whole.page, 'src/a.py'), 'src/a.pynot in the diff now1 thread');
});

test('an unread changed-file list never claims the MR changes no file', async () => {
  const { page } = await drawerPage({ tab: 'files', over: { files: null, missing: { files: 'GitLab 502 Bad Gateway' } } });
  assert.doesNotMatch(page.$('#drawer .drawer-body').textContent, /changes no file/);
  const none = await drawerPage({ tab: 'files' });
  assert.match(none.page.$('#drawer .drawer-body').textContent, /The MR changes no file/);
});

test('while the changed files are being read, a queued finding\'s file says so instead of calling it gone', async () => {
  const { page } = await drawerPage({ tab: null, queue: [finding('f1', 'src/c.py')] });
  page.run(`openMr('${KEY}', 'files')`);
  assert.equal(page.run('ui.mr.loading'), true);
  assert.match(page.$('#drawer .drawer-body').textContent, /Reading the changed files…/);
  assert.equal(page.$('#drawer .file-row').textContent, 'src/c.py1 not posted');
  await page.settle();
  assert.doesNotMatch(page.$('#drawer .drawer-body').textContent, /Reading the changed files/);
});

test('the file sheet still opens by showFile, the name other ui files call it by', async () => {
  const { page, requests } = await drawerPage();
  page.run(`showFile('${KEY}', 'src/a.py', { line: 4 })`);
  await page.settle();
  assert.deepEqual(page.errors, []);
  assert.deepEqual([...requests.at(-1).searchParams], [['key', KEY], ['path', 'src/a.py']]);
  assert.equal(page.run('JSON.stringify(ui.file.focus)'), JSON.stringify({ line: 4 }));
  assert.ok(page.$('#sheet .sheet'));
});

test('an MR that is no longer open lists its files but offers none to open', async () => {
  const files = { complete: true, list: [{ path: 'src/a.py', oldPath: null, change: 'modified', added: 1, removed: 0, tooLarge: false }] };
  const { page } = await drawerPage({ rows: [], tab: 'files', queue: [finding('f1', 'src/a.py')], over: { files } });
  assert.equal(page.$$('#drawer button.file-row').length, 0);
  assert.equal(page.$$('#drawer div.file-row').length, 1);
  assert.ok(!page.$$('#drawer button').some((b) => b.textContent === 'First commented file'));
});

test('the MR title opens on Findings when items are queued and on Overview otherwise, and so does Needs you', async () => {
  const other = 'acme/engine!8';
  const { page } = await drawerPage({ tab: null, rows: [row(), row(other)], queue: [finding('f1', 'src/a.py')] });
  const titleOf = (key) => page.$$('#main .mr .ref').find((b) => b.dataset.key === key);
  titleOf(KEY).click();
  assert.equal(page.run('ui.mr.tab'), 'findings');
  page.run('closeMr()');
  titleOf(other).click();
  assert.equal(page.run('ui.mr.tab'), 'overview');
  page.run('closeMr()');
  const needs = snapshot([row(), row(other)], [finding('f1', 'src/a.py')]);
  const reason = { kind: 'findings', why: '1 to post', tier: 'interrupt', tab: 'findings', next: 'post-all' };
  needs.attention = { cards: [{ key: KEY, group: 'others', title: 'MR', iid: 7, repo: 'engine', reasons: [reason], top: reason, since: null, interrupt: true, muted: null }], agents: [], system: [], count: 1, prefs: {}, toasts: [], offers: [] };
  page.show(needs, 'needs-you');
  page.$$('#main .ref').find((b) => b.dataset.key === KEY).click();
  assert.equal(page.run('ui.mr.tab'), 'findings');
});

test('the Findings tab shows what waits to post with its code and Post all, and the rest under All', async () => {
  const { page } = await drawerPage({ tab: 'findings', queue: [finding('f1', 'src/a.py'), { ...finding('f2', 'src/b.py'), status: 'posted' }] });
  assert.match(page.$('#drawer .drawer-body').textContent, /1 waiting to post, 1 posted/);
  assert.ok(page.$$('#drawer button').some((b) => b.textContent === 'Post all 1'));
  assert.equal(page.$$('#drawer pre.diff').length, 1);
  assert.ok(!page.$$('#drawer button').some((b) => /posted or discarded/.test(b.textContent)), 'the chips replace the fold');
  page.$$('#drawer .chip').find((b) => b.textContent === 'All (2)').click();
  assert.equal(page.$$('#drawer pre.diff').length, 2);
});

test('Show file on a finding opens the sheet at that finding, and on a posted one at its line', async () => {
  const { page, requests } = await drawerPage({ tab: 'findings', queue: [finding('f1', 'src/a.py'), { ...finding('f2', 'src/b.py'), status: 'posted', line: 9, side: 'old' }] });
  page.$$('#drawer button').find((b) => b.textContent === 'Show file').click();
  await page.settle();
  assert.deepEqual([...requests.at(-1).searchParams], [['key', KEY], ['path', 'src/a.py']]);
  assert.equal(page.run('JSON.stringify(ui.file.focus)'), JSON.stringify({ queueId: 'f1', line: 1, side: 'new' }));
  page.run('closeFile()');
  page.$$('#drawer .chip').find((b) => b.textContent === 'All (2)').click();
  page.$$('#drawer button').filter((b) => b.textContent === 'Show file')[1].click();
  await page.settle();
  assert.equal(page.run('JSON.stringify(ui.file.focus)'), JSON.stringify({ queueId: null, line: 9, side: 'old' }));
});

test('with nothing left to post, the Findings tab shows what was posted without a click', async () => {
  const { page } = await drawerPage({ tab: 'findings', queue: [{ ...finding('f2', 'src/b.py'), status: 'posted' }] });
  assert.equal(page.$$('#drawer pre.diff').length, 1);
  assert.ok(!page.$$('#drawer button').some((b) => b.textContent.startsWith('Post all')));
});

test('a long path breaks after its slashes, and reads the same', async () => {
  const files = { complete: true, list: [{ path: 'platform/services/databases/access_request_common.py', oldPath: null, change: 'modified', added: 1, removed: 0, tooLarge: false }] };
  const { page } = await drawerPage({ tab: 'files', over: { files } });
  const path = page.$('#drawer .file-row .path');
  assert.equal(path.textContent, 'platform/services/databases/access_request_common.py');
  assert.equal(path.querySelectorAll('wbr').length, 3);
});
