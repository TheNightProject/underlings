import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { loadEngine } from './engine.mjs';
import { forget, mergedError, mergedFor, noQaPathFor, readMerged, suggestMove } from './suggest.mjs';

// The merged MRs are read by the built GitLab forge, behind the shared stand-in engine.
const home = await mkdtemp(join(tmpdir(), 'control-centre-suggest-'));
process.env.HOME = home;
process.env.UNDERLINGS_STATE_DIR = join(home, 'engine-state');
const enginePath = join(home, 'engine.mjs');
const testkit = new URL('./testkit.mjs', import.meta.url).href;
const built = new URL('../engine/dist/engine.js', import.meta.url).href;
await writeFile(enginePath, `export * from '${testkit}';\nexport { forgeOf } from '${built}';\n`);
await loadEngine({ matrixEngine: enginePath }, () => {});
after(() => rm(home, { recursive: true }));

const TARGETS = ['To Do', 'In Progress', 'Blocked', 'Peer Review', 'QA', 'Done'];
const open = (iid, draft = false) => ({ key: 'acme/platform/frontend!' + iid, iid, draft });
const merged = (path, iid) => ({ path, iid });
const FRONTEND = 'acme/platform/frontend';
const ATLAS = 'acme/tooling/atlas';
// The repo path whose merged MRs need no QA.
const NO_QA = 'acme/tooling';
const suggest = (status, mrs, done, targets = TARGETS, noQaPaths = NO_QA) => suggestMove({ status, targets, open: mrs, merged: done, noQaPaths });

test('an open MR that is not a draft means Peer Review, whatever else is open or merged', () => {
  assert.deepEqual(suggest('In Progress', [open(1669)], []), { status: 'Peer Review', why: '!1669 is in review' });
  assert.deepEqual(suggest('To Do', [open(1, true), open(2), open(3)], [merged(FRONTEND, 9)]), { status: 'Peer Review', why: '2 MRs in review' });
});

test('only drafts open means In Progress, even with MRs merged before', () => {
  assert.deepEqual(suggest('To Do', [open(7, true)], [merged(FRONTEND, 9)]), { status: 'In Progress', why: '!7 is a draft' });
  assert.deepEqual(suggest('To Do', [open(7, true), open(8, true)], []), { status: 'In Progress', why: '2 draft MRs' });
});

test('with no paths named every merged MR needs QA, and a path names whole segments', () => {
  assert.deepEqual(suggest('Peer Review', [], [merged(ATLAS, 12)], TARGETS, ''), { status: 'QA', why: '!12 merged' });
  assert.equal(noQaPathFor('acme/tooling/cli', 'acme/tooling'), 'acme/tooling');
  assert.equal(noQaPathFor('acme/toolingx/cli', 'acme/tooling'), null);
  assert.equal(noQaPathFor('acme/ops/infra', ' /ops/ , docs'), 'ops');
  assert.deepEqual(suggest('Peer Review', [], [merged('acme/ops/infra', 4)], TARGETS, 'ops'), { status: 'Done', why: '!4 merged in ops' });
});

test('nothing open and something merged means QA, or Done when every merged MR is in a tooling repo', () => {
  assert.deepEqual(suggest('Peer Review', [], [merged(FRONTEND, 871)]), { status: 'QA', why: '!871 merged' });
  assert.deepEqual(suggest('Peer Review', [], [merged(FRONTEND, 871), merged(ATLAS, 12)]), { status: 'QA', why: '2 MRs merged' }, 'one repo outside tooling still needs QA');
  assert.deepEqual(suggest('Peer Review', [], [merged(ATLAS, 12)]), { status: 'Done', why: '!12 merged in tooling' });
  assert.deepEqual(suggest('In Progress', [], [merged(ATLAS, 12), merged('acme/tooling/gizmo', 3)]), { status: 'Done', why: '2 MRs merged in tooling' });
  assert.equal(suggest('Peer Review', [], [merged('acme/platform/frontend-tooling/x', 1)]).status, 'QA', 'only the tooling group itself skips QA');
});

test('a suggestion only ever moves a ticket further along: To Do, In Progress, Peer Review, QA, then anything past QA', () => {
  assert.deepEqual(suggest('In Progress', [open(1669)], []), { status: 'Peer Review', why: '!1669 is in review' });
  assert.equal(suggest('QA', [], [merged(FRONTEND, 871)]), null, 'QA with merged MRs stays');
  assert.equal(suggest('QA', [open(5)], []), null, 'a new MR in review does not take a ticket back from QA');
  assert.equal(suggest('Peer Review', [open(7, true)], []), null, 'nor a draft back from Peer Review');
  for (const later of ['Release Ready', 'Ready for Release - Demo', 'Ready for Release - Runway']) {
    assert.equal(suggest(later, [], [merged(FRONTEND, 871)]), null, later + ' with merged MRs stays');
    assert.equal(suggest(later, [], [merged(ATLAS, 12)]), null, later + ' is past QA already, as Done is');
  }
  assert.deepEqual(suggest('QA', [], [merged(ATLAS, 12)]), { status: 'Done', why: '!12 merged in tooling' }, 'Done is still further than QA');
});

test('a ticket in Blocked, or in a status off that line, gets no suggestion', () => {
  for (const status of ['Blocked', 'Design QA', 'In Design', 'Reviewed & Prioritised', 'Dev Ready']) {
    assert.equal(suggest(status, [open(1669)], []), null, status);
    assert.equal(suggest(status, [], [merged(FRONTEND, 871)]), null, status);
  }
});

test('no suggestion without MRs, before merged MRs are read, to the status it is in, or to a status Jira does not offer', () => {
  assert.equal(suggest('In Progress', [], []), null);
  assert.equal(suggest('In Progress', [], null), null);
  assert.equal(suggest('Peer Review', [open(1)], []), null);
  assert.equal(suggest('QA', [], [merged(FRONTEND, 2)]), null);
  assert.equal(suggest('In Progress', [open(1)], [], ['To Do', 'QA']), null);
  assert.equal(suggest('Peer Review', [], [merged(ATLAS, 2)], ['To Do', 'QA']), null, 'Done is not offered, and QA is not what tooling wants');
});

const NOW = Date.parse('2026-11-09T12:00:00Z');
const MIN = 60_000;
let calls = [];
let reply = () => [];

function gitlab(rows, status = 200) {
  return { ok: status === 200, status, statusText: status === 200 ? 'OK' : 'Server Error', json: async () => rows };
}

const glMr = (path, iid, title) => ({ iid, title, references: { full: path + '!' + iid } });

beforeEach(() => {
  forget();
  calls = [];
  reply = () => gitlab([]);
  process.env.GITLAB_TOKEN = 'stub-token';
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: new URL(url), method: init.method ?? 'GET', body: init.body, token: init.headers?.['PRIVATE-TOKEN'], signal: init.signal });
    return reply(new URL(url));
  };
});

test('merged MRs are read with one GET per ticket and group, searched by key in the title and kept only when the key is the MR\'s own ticket', async () => {
  reply = () => gitlab([
    glMr(FRONTEND, 871, '🐛 (ABC-12) Fix the edge'),
    glMr(FRONTEND, 872, '✨ (ABC-123) Something else'),
    glMr(ATLAS, 5, '♻️ (ABC-12) Tidy the build'),
    glMr(FRONTEND, 873, '✨ (ABC-99) Mentions ABC-12 later'),
  ]);
  await readMerged([{ key: 'ABC-12', open: [] }], ['acme'], NOW);
  assert.deepEqual(calls.map((c) => [c.method, c.body, c.token, c.url.origin + c.url.pathname]), [['GET', undefined, 'stub-token', 'https://gitlab.com/api/v4/groups/acme/merge_requests']]);
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), { state: 'merged', search: 'ABC-12', in: 'title', per_page: '100' });
  assert.ok(calls[0].signal instanceof AbortSignal, 'a read that hangs is given up, so the ticket list is read again');
  assert.deepEqual(mergedFor('ABC-12'), [{ path: FRONTEND, iid: 871 }, { path: ATLAS, iid: 5 }]);
});

test('a ticket is read again only after 15 minutes, and not at all while it has an open MR', async () => {
  const tickets = [{ key: 'ABC-12', open: [] }, { key: 'ABC-13', open: [open(1)] }];
  await readMerged(tickets, ['acme'], NOW);
  await readMerged(tickets, ['acme'], NOW + 14 * MIN);
  assert.deepEqual(calls.map((c) => c.url.searchParams.get('search')), ['ABC-12']);
  await readMerged(tickets, ['acme'], NOW + 15 * MIN);
  assert.deepEqual(calls.map((c) => c.url.searchParams.get('search')), ['ABC-12', 'ABC-12']);
});

test('a ticket whose open MR has just merged is read at once, not a quarter of an hour later', async () => {
  await readMerged([{ key: 'ABC-12', open: [] }], ['acme'], NOW);
  await readMerged([{ key: 'ABC-12', open: [open(1)] }], ['acme'], NOW + MIN);
  assert.equal(mergedFor('ABC-12'), null, 'what was read before the MR opened is dropped');
  reply = () => gitlab([glMr(FRONTEND, 1, '(ABC-12) The edge')]);
  await readMerged([{ key: 'ABC-12', open: [] }], ['acme'], NOW + 2 * MIN);
  assert.equal(calls.length, 2);
  assert.deepEqual(mergedFor('ABC-12'), [{ path: FRONTEND, iid: 1 }]);
});

test('before the MR list has named a group nothing is read or kept, since every ticket would look as if it had no MR', async () => {
  await readMerged([{ key: 'ABC-12', open: [] }], [], NOW);
  assert.deepEqual([calls.length, mergedFor('ABC-12')], [0, null]);
  reply = () => gitlab([glMr(FRONTEND, 1, '(ABC-12) The edge')]);
  await readMerged([{ key: 'ABC-12', open: [] }], ['acme'], NOW + MIN);
  assert.deepEqual(mergedFor('ABC-12'), [{ path: FRONTEND, iid: 1 }], 'so the first read once it has is not held back');
});

test('a GitLab that refuses, or no token, is said and keeps what was read before', async () => {
  reply = () => gitlab([glMr(FRONTEND, 1, '(ABC-12) The edge')]);
  await readMerged([{ key: 'ABC-12', open: [] }], ['acme'], NOW);
  reply = () => gitlab([], 500);
  await readMerged([{ key: 'ABC-12', open: [] }], ['acme'], NOW + 15 * MIN);
  assert.equal(mergedError(), 'GitLab 500 Server Error');
  assert.deepEqual(mergedFor('ABC-12'), [{ path: FRONTEND, iid: 1 }]);
  delete process.env.GITLAB_TOKEN;
  await readMerged([{ key: 'ABC-14', open: [] }], ['acme'], NOW);
  assert.equal(mergedError(), 'there is no GitLab token');
  assert.equal(calls.length, 2, 'nothing is asked without a token');
});
