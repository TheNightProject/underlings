import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ACTIONS, act } from './actions.mjs';
import { loadEngine, refreshInbox } from './engine.mjs';
import { invalidate, readMrDetail } from './mrdetail.mjs';
import { mr, reset, world } from './testkit.mjs';

const KEY = 'acme/engine!1121';
const testkit = new URL('./testkit.mjs', import.meta.url).href;
const dir = await mkdtemp(join(tmpdir(), 'control-centre-threads-'));
const writer = join(dir, 'engine.mjs');
await writeFile(writer, `import { world } from '${testkit}';
export * from '${testkit}';
export async function replyToDiscussion(...args) { world.calls.push(['replyToDiscussion', ...args]); }
export async function setDiscussionResolved(...args) { world.calls.push(['setDiscussionResolved', ...args]); }
`);
await loadEngine({ matrixEngine: writer }, () => {});

after(() => rm(dir, { recursive: true }));

function note(author, body) {
  return { author, body, createdAt: '2026-11-05T10:00:00Z', system: false };
}

beforeEach(async () => {
  reset({ mrs: [mr('acme/engine', 1121), mr('acme/engine', 1000)] });
  world.discussions[1121] = [
    { id: 'd-wait', resolved: false, position: { new_path: 'src/app.py', new_line: 12 }, notes: [note('frank', 'Why?'), note('ivan', 'Because.')] },
    { id: 'd-done', resolved: true, position: { new_path: 'src/app.py', new_line: 30 }, notes: [note('frank', 'Typo')] },
  ];
  world.discussions[1000] = [{ id: 'd-elsewhere', resolved: false, notes: [note('ivan', 'Elsewhere')] }];
  invalidate();
  await refreshInbox();
  world.calls.length = 0;
});

const writes = () => world.calls.filter(([name]) => name === 'replyToDiscussion' || name === 'setDiscussionResolved');
const reply = (extra = {}) => act('reply', { key: KEY, discussionId: 'd-wait', body: 'Fair enough.', expect: { notes: 2 }, ...extra });
const resolve = (extra = {}) => act('resolve', { key: KEY, discussionId: 'd-wait', resolved: true, ...extra });

test('reply and resolve are actions of their own', () => {
  assert.equal(typeof ACTIONS.reply.verify, 'function');
  assert.equal(typeof ACTIONS.resolve.verify, 'function');
});

test('a reply goes to the MR and thread the worker read, never the ids in the payload', async () => {
  const { text } = await reply({ projectId: 99, iid: 5, discussionId: 'd-wait', mr: { projectId: 99 } });
  assert.equal(text, `Replied on ${KEY}`);
  assert.deepEqual(writes(), [['replyToDiscussion', 7, 1121, 'd-wait', 'Fair enough.']]);
  assert.deepEqual(world.calls.find(([name]) => name === 'fetchDiscussions'), ['fetchDiscussions', 7, 1121]);
});

test('a resolve or reopen goes to the MR and thread the worker read', async () => {
  await resolve({ projectId: 99, iid: 5 });
  await resolve({ discussionId: 'd-done', resolved: false });
  assert.deepEqual(writes(), [['setDiscussionResolved', 7, 1121, 'd-wait', true], ['setDiscussionResolved', 7, 1121, 'd-done', false]]);
});

test('the reply is sent as typed, with nothing added or trimmed', async () => {
  const body = '  Line one\n\n> quoted\n';
  await reply({ body });
  assert.equal(writes()[0][4], body);
});

test('a reply is refused with 409 when a note arrived since the page read the thread', async () => {
  world.discussions[1121][0].notes.push(note('ivan', 'Also this.'));
  await assert.rejects(reply(), { status: 409, message: 'the thread changed since you looked' });
  assert.deepEqual(writes(), []);
});

test('a reply that does not say what the page saw is refused', async () => {
  await assert.rejects(reply({ expect: undefined }), { status: 400 });
  assert.deepEqual(writes(), []);
});

test('a reply to a thread on another MR is refused', async () => {
  await assert.rejects(reply({ discussionId: 'd-elsewhere', expect: { notes: 1 } }), { status: 404, message: `that thread is not on ${KEY}` });
  await assert.rejects(resolve({ discussionId: 'd-elsewhere' }), { status: 404 });
  assert.deepEqual(writes(), []);
});

test('an empty or overlong reply is refused before GitLab is asked anything', async () => {
  for (const body of ['', '   \n ', undefined, 42, 'x'.repeat(20_001)]) await assert.rejects(reply({ body }), { status: 400 }, JSON.stringify(body));
  assert.deepEqual(world.calls, []);
  await reply({ body: 'x'.repeat(20_000) });
  assert.equal(writes().length, 1);
});

test('a resolve is refused with 409 when the thread is already in the state asked for', async () => {
  await assert.rejects(resolve({ discussionId: 'd-done' }), { status: 409, message: 'the thread was resolved since you looked' });
  await assert.rejects(resolve({ resolved: false }), { status: 409, message: 'the thread was reopened since you looked' });
  await assert.rejects(resolve({ resolved: 'yes' }), { status: 400 });
  assert.deepEqual(writes(), []);
});

test('an MR that is not open any more is refused without asking GitLab', async () => {
  await assert.rejects(reply({ key: 'acme/engine!77' }), { status: 404 });
  await assert.rejects(resolve({ key: 'not a key' }), { status: 400 });
  assert.deepEqual(world.calls, []);
});

test('a refusal drops the drawer\'s copy, so the reloaded panel shows what changed', async () => {
  await readMrDetail(KEY);
  world.discussions[1121][0].notes.push(note('ivan', 'Also this.'));
  await assert.rejects(reply(), { status: 409 });
  const detail = await readMrDetail(KEY);
  assert.equal(detail.discussions[0].notes.length, 3);
});

test('a write drops the drawer\'s copy too', async () => {
  await readMrDetail(KEY);
  world.discussions[1121][1].resolved = false;
  await resolve({ discussionId: 'd-done' });
  assert.equal((await readMrDetail(KEY)).discussions[1].resolved, false);
});

test('an engine built before threads could be written answers 501, so the page can offer a rebuild', async () => {
  await loadEngine({ matrixEngine: fileURLToPath(testkit) }, () => {});
  try {
    await assert.rejects(reply(), { status: 501, message: /has no reply$/ });
    await assert.rejects(resolve(), { status: 501, message: /has no resolve$/ });
  } finally {
    await loadEngine({ matrixEngine: writer }, () => {});
  }
});
