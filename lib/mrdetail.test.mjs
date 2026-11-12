import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadEngine, refreshInbox } from './engine.mjs';
import { readMatrix } from './matrix.mjs';
import { invalidate, readMrDetail } from './mrdetail.mjs';
import { mr, reset, world } from './testkit.mjs';

const KEY = 'acme/engine!1121';
const TESTKIT = new URL('./testkit.mjs', import.meta.url);
const OLD_BUILD = fileURLToPath(TESTKIT);
const scratch = await mkdtemp(join(tmpdir(), 'control-centre-mrdetail-'));
const NEW_BUILD = join(scratch, 'engine.mjs');
await writeFile(NEW_BUILD, [
  `export * from ${JSON.stringify(TESTKIT.href)};`,
  'export const fetchMrDetail = (...args) => globalThis.gitlab.fetchMrDetail(...args);',
  'export const fetchMrFiles = (...args) => globalThis.gitlab.fetchMrFiles(...args);',
  'export const changeSince = (...args) => globalThis.gitlab.changeSince(...args);',
  'export const fetchSince = (...args) => globalThis.gitlab.fetchSince(...args);',
].join('\n'));
after(() => rm(scratch, { recursive: true }));

async function useEngine(path) {
  await loadEngine({ matrixEngine: path }, () => {});
  invalidate();
  await refreshInbox();
}

function gitlab({ detail = {}, files = [], complete = true, filesFail = null } = {}) {
  globalThis.gitlab = {
    async fetchMrDetail(projectId, iid) {
      world.calls.push(['fetchMrDetail', projectId, iid]);
      return { description: '', detailedMergeStatus: 'mergeable', targetBranch: 'main', changesCount: '1', userNotesCount: 0, ...detail };
    },
    changeSince: () => ({ headMoved: true, notes: 2, resolved: 1, approvals: 0, pipeline: 'SUCCESS' }),
    async fetchSince(projectId, from, to) {
      world.calls.push(['fetchSince', projectId, from, to]);
      return { commits: 2, paths: ['src/app.py', 'src/new.py'] };
    },
    async fetchMrFiles(projectId, iid) {
      world.calls.push(['fetchMrFiles', projectId, iid]);
      if (filesFail) throw new Error(filesFail);
      return { files, complete };
    },
  };
}

function note(author, body, at = '2026-11-05T10:00:00Z') {
  return { author, body, createdAt: at, system: false };
}

beforeEach(async () => {
  reset({ mrs: [mr('acme/engine', 1121)] });
  world.discussions[1121] = [
    { id: 'd-wait', resolved: false, position: { new_path: 'src/app.py', new_line: 12 }, notes: [note('frank', 'Why?'), note('ivan', 'Because.')] },
    { id: 'd-mine', resolved: false, notes: [note('ivan', 'Thoughts?'), note('frank', 'Looks fine')] },
    { id: 'd-back', resolved: false, position: { old_path: 'src/old.py', old_line: 4 }, notes: [note('frank', 'Gone?')] },
    { id: 'd-done', resolved: true, notes: [note('ivan', 'Ship it')] },
  ];
  world.jobs.aaa111 = [{ name: 'lint', status: 'success', stage: 'test', id: 99 }];
  world.memory[KEY] = { key: KEY, handedBack: ['d-back'] };
  world.queue = [
    { id: 'q-reply', status: 'pending', kind: 'reply', replyTo: 'd-mine', projectPath: 'acme/engine', iid: 1121 },
    { id: 'q-sent', status: 'posted', kind: 'reply', replyTo: 'd-wait', projectPath: 'acme/engine', iid: 1121 },
  ];
  await useEngine(OLD_BUILD);
});

const fetches = () => world.calls.filter(([name]) => name === 'fetchOneMr').length;

test('discussions are shaped for the drawer, with their place in the code', async () => {
  const detail = await readMrDetail(KEY);
  assert.equal(detail.mr.title, 'MR 1121');
  assert.equal(detail.mr.projectId, undefined);
  const [wait, mine, back, done] = detail.discussions;
  assert.deepEqual([wait.path, wait.line], ['src/app.py', 12]);
  assert.deepEqual([back.path, back.line], ['src/old.py', 4]);
  assert.deepEqual([mine.path, mine.line], [null, null]);
  assert.deepEqual(wait.notes[1], { author: 'ivan', body: 'Because.', createdAt: '2026-11-05T10:00:00Z', system: false });
  assert.deepEqual(detail.discussions.map((d) => d.resolvable), [true, true, true, false]);
  assert.deepEqual(detail.jobs, [{ name: 'lint', status: 'success', stage: 'test' }]);
  assert.equal(done.resolved, true);
});

test('a thread is flagged when it waits on you, when full auto handed it back, and when a reply to it is queued', async () => {
  const flags = (await readMrDetail(KEY)).discussions.map((d) => [d.id, d.awaitsYou, d.handedBack, d.queuedReply]);
  assert.deepEqual(flags, [
    ['d-wait', true, false, null],
    ['d-mine', false, false, 'q-reply'],
    ['d-back', false, true, null],
    ['d-done', false, false, null],
  ]);
});

test('the read brings every settled item of its MR, however many newer ones other MRs have', async () => {
  const at = (n) => `2026-11-05T12:${String(n).padStart(2, '0')}:00Z`;
  const busy = Array.from({ length: 61 }, (_, n) => ({ id: 'o' + n, status: 'posted', kind: 'finding', projectPath: 'acme/other', iid: 5, postedAt: at(n), discussionId: 'x' + n }));
  const old = { id: 'q-old', status: 'posted', kind: 'finding', projectPath: 'acme/engine', iid: 1121, postedAt: '2026-11-01T09:00:00Z', discussionId: 'd-wait', body: 'Old' };
  world.queue.push(...busy, old, { id: 'q-gone', status: 'discarded', kind: 'finding', projectPath: 'acme/engine', iid: 1121, createdAt: '2026-11-01T08:00:00Z' });
  assert.ok(!(await readMatrix()).queue.some((q) => q.id === 'q-old'), 'the page state keeps only the newest settled items');
  const { settled } = await readMrDetail(KEY);
  assert.deepEqual(settled.map((q) => [q.id, q.key, q.status]), [
    ['q-sent', KEY, 'posted'],
    ['q-old', KEY, 'posted'],
    ['q-gone', KEY, 'discarded'],
  ]);
  assert.deepEqual([settled[1].kind, settled[1].discussionId, settled[1].body], ['finding', 'd-wait', 'Old']);
});

test('a read is cached per head, and a push or a write reads GitLab again', async () => {
  await readMrDetail(KEY);
  await readMrDetail(KEY);
  assert.equal(fetches(), 1);
  world.mrs[0].sha = 'bbb222';
  await refreshInbox();
  await readMrDetail(KEY);
  assert.equal(fetches(), 2);
  invalidate(KEY);
  await readMrDetail(KEY);
  assert.equal(fetches(), 3);
  assert.deepEqual(world.calls.filter(([name]) => name === 'fetchPipelineJobs').at(-1), ['fetchPipelineJobs', 7, 'bbb222']);
});

test('a change to the MR\'s queue reads GitLab again, so a thread posted from elsewhere arrives', async () => {
  await readMrDetail(KEY);
  world.queue.push({ id: 'q-new', status: 'posted', kind: 'finding', projectPath: 'acme/engine', iid: 1121, discussionId: 'd-new' });
  world.discussions[1121].push({ id: 'd-new', resolved: false, notes: [note('frank', 'New')] });
  const detail = await readMrDetail(KEY);
  assert.equal(fetches(), 2);
  assert.ok(detail.discussions.some((d) => d.id === 'd-new'));
  world.queue.push({ id: 'q-else', status: 'posted', kind: 'finding', projectPath: 'acme/other', iid: 5, discussionId: 'x' });
  await readMrDetail(KEY);
  assert.equal(fetches(), 2, 'another MR\'s queue leaves this one cached');
});

test('an MR in neither the open list nor the queue is a 404, and a malformed key a 400', async () => {
  await assert.rejects(readMrDetail('acme/engine!9'), { status: 404 });
  await assert.rejects(readMrDetail('not a key'), { status: 400 });
  assert.equal(fetches(), 0);
});

test('an MR known only from its queued findings is still read', async () => {
  world.queue.push({ id: 'q-old', status: 'pending', kind: 'finding', projectPath: 'acme/engine', projectId: 7, iid: 1000 });
  world.mrs.push(mr('acme/engine', 1000));
  const detail = await readMrDetail('acme/engine!1000');
  assert.equal(detail.mr.iid, 1000);
});

test('the description reads as GitLab shows it, without the template comments it hides', async () => {
  gitlab({ detail: { description: '## What\r\n<!-- Say what changed -->\r\nFixes !1100 for ABC-12.   \r\n\r\n\r\n\r\nDone.\n<!-- never closed', changesCount: '1000+', userNotesCount: 4 } });
  await useEngine(NEW_BUILD);
  const { detail, missing } = await readMrDetail(KEY);
  assert.deepEqual(detail, { description: '## What\n\nFixes !1100 for ABC-12.\n\nDone.', clipped: false, targetBranch: 'main', changes: '1000+', notes: 4 });
  assert.deepEqual(missing, {});
  assert.deepEqual(world.calls.filter(([name]) => name === 'fetchMrDetail'), [['fetchMrDetail', 7, 1121]]);
});

test('the merge status is put in words, from the fresh REST read over the inbox\'s', async () => {
  await useEngine(NEW_BUILD);
  const cases = [
    ['discussions_not_resolved', 'blocked: unresolved threads', 'blocked'],
    ['need_rebase', 'needs rebase', 'blocked'],
    ['ci_must_pass', 'pipeline must succeed', 'blocked'],
    ['ci_still_running', 'waiting for the pipeline', 'waiting'],
    ['mergeable', 'ready to merge', 'ready'],
    ['something_new', 'something new', 'blocked'],
  ];
  for (const [status, words, tone] of cases) {
    gitlab({ detail: { detailedMergeStatus: status } });
    invalidate();
    assert.deepEqual((await readMrDetail(KEY)).merge, { status, words, tone });
  }
  world.mrs[0].mergeStatus = 'NEED_REBASE';
  await refreshInbox();
  gitlab({ detail: { detailedMergeStatus: null } });
  invalidate();
  assert.equal((await readMrDetail(KEY)).merge.words, 'needs rebase');
});

test('changed files carry their line counts, renames, and whether GitLab collapsed them', async () => {
  gitlab({
    complete: false,
    files: [
      { oldPath: 'src/app.py', newPath: 'src/app.py', diff: '@@ -1,3 +1,4 @@\n ctx\n-old\n+new\n+more\n', tooLarge: false },
      { oldPath: 'src/new.py', newPath: 'src/new.py', diff: '@@ -0,0 +1,2 @@\n+a\n+b\n', tooLarge: false },
      { oldPath: 'src/gone.py', newPath: 'src/gone.py', diff: '@@ -1,2 +0,0 @@\n-a\n-b\n', tooLarge: false },
      { oldPath: 'src/before.py', newPath: 'src/after.py', diff: '', tooLarge: false },
      { oldPath: 'yarn.lock', newPath: 'yarn.lock', diff: '', tooLarge: true },
    ],
  });
  await useEngine(NEW_BUILD);
  const { files } = await readMrDetail(KEY);
  assert.equal(files.complete, false);
  assert.deepEqual(files.list, [
    { path: 'src/app.py', oldPath: null, change: 'modified', added: 2, removed: 1, tooLarge: false },
    { path: 'src/new.py', oldPath: null, change: 'added', added: 2, removed: 0, tooLarge: false },
    { path: 'src/gone.py', oldPath: null, change: 'deleted', added: 0, removed: 2, tooLarge: false },
    { path: 'src/after.py', oldPath: 'src/before.py', change: 'renamed', added: 0, removed: 0, tooLarge: false },
    { path: 'yarn.lock', oldPath: null, change: 'modified', added: 0, removed: 0, tooLarge: true },
  ]);
  assert.deepEqual(world.calls.filter(([name]) => name === 'fetchMrFiles'), [['fetchMrFiles', 7, 1121]]);
});

test('a watched MR says what moved since your review: commits, who replied on your threads, how many of yours are resolved, the pipeline, and the files', async () => {
  gitlab();
  await useEngine(NEW_BUILD);
  world.discussions[1121][2].resolved = true;
  world.watches[KEY] = { key: KEY, seen: { sha: 'old111', pipeline: 'RUNNING', notes: 2, approvals: 0, unresolved: 3 }, seenAt: Date.parse('2026-11-05T09:30:00Z') };
  const { since } = await readMrDetail(KEY);
  assert.deepEqual(since, { at: '2026-11-05T09:30:00.000Z', words: '2 commits, ivan replied on 2 threads, 1 of your 3 threads resolved, pipeline passed', paths: ['src/app.py', 'src/new.py'], headMoved: true });
  assert.deepEqual(world.calls.filter(([n]) => n === 'fetchSince'), [['fetchSince', 7, 'old111', 'aaa111']]);
  delete world.watches[KEY];
  invalidate();
  assert.equal((await readMrDetail(KEY)).since, null, 'an MR you do not watch has no summary');
});

test('a testkit engine without fetchMrDetail or fetchMrFiles still returns mr, discussions and jobs', async () => {
  const detail = await readMrDetail(KEY);
  assert.equal(detail.mr.title, 'MR 1121');
  assert.equal(detail.discussions.length, 4);
  assert.deepEqual(detail.jobs, [{ name: 'lint', status: 'success', stage: 'test' }]);
  assert.deepEqual([detail.detail, detail.files], [null, null]);
  assert.match(detail.missing.detail, /rebuild the engine/);
  assert.match(detail.missing.files, /rebuild the engine/);
  assert.equal(detail.merge.words, 'ready to merge');
});

test('a part GitLab fails to read is named, the rest still arrives, and the next open asks again', async () => {
  gitlab({ filesFail: 'GitLab 500 Internal Server Error on /projects/7/merge_requests/1121/diffs' });
  await useEngine(NEW_BUILD);
  const detail = await readMrDetail(KEY);
  assert.equal(detail.files, null);
  assert.equal(detail.missing.files, 'GitLab 500 Internal Server Error on /projects/7/merge_requests/1121/diffs');
  assert.equal(detail.detail.targetBranch, 'main');
  assert.equal(detail.discussions.length, 4);
  gitlab();
  await readMrDetail(KEY);
  assert.equal(fetches(), 2);
  await readMrDetail(KEY);
  assert.equal(fetches(), 2);
});

test('a failed read that lands after a fresh one leaves the fresh one cached', async () => {
  gitlab();
  let failures = 1;
  globalThis.gitlab.fetchMrFiles = async () => {
    if (failures-- > 0) throw new Error('GitLab 502 Bad Gateway');
    return { files: [], complete: true };
  };
  await useEngine(NEW_BUILD);
  const stale = readMrDetail(KEY);
  invalidate(KEY);
  const fresh = readMrDetail(KEY);
  assert.match((await stale).missing.files, /502/);
  assert.deepEqual((await fresh).missing, {});
  await readMrDetail(KEY);
  assert.equal(fetches(), 2);
});
