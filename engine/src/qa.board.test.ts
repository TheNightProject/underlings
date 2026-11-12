import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';

process.env['UNDERLINGS_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'qa-test-'));
process.env['UNDERLINGS_JIRA_SITE'] = 'example.atlassian.net';
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/qa/${name}`, import.meta.url), 'utf8')) as unknown[];
const TICKETS = fixture('tickets.json') as { key: string; fields: { status: unknown } }[];
const MERGED = fixture('merged.json') as { mergedAt: string }[];
const NOW = Date.parse('2026-11-10T10:00:00Z');
const DAY_MS = 86_400_000;
const PAGE = 2;

let inQaFor: Record<string, number> = {};
let jiraDown: string | null = null;
let groupFound = true;
const searches: { jql: string; fields: string }[] = [];
const pages: { after: string; before: string | null; cursor: string | null }[] = [];
const realFetch = globalThis.fetch;
let gate: Promise<void> | null = null;

const fakeExecFile = Object.assign(() => undefined, {
  [promisify.custom]: (_cmd: string, args: string[]) => {
    const answer = answerSearch(args);
    return gate ? gate.then(() => answer) : answer;
  },
});

function answerSearch(args: string[]): Promise<{ stdout: string }> {
  const jql = args[args.indexOf('--jql') + 1] ?? '';
  const fields = args[args.indexOf('--fields') + 1] ?? '';
  searches.push({ jql, fields });
  if (jiraDown) return Promise.reject(Object.assign(new Error('acli failed'), { stdout: jiraDown }));
  const back = /AFTER startOfDay\(-(\d+)\)/.exec(jql)?.[1];
  if (back === undefined) return Promise.resolve({ stdout: JSON.stringify(TICKETS) });
  const moved = TICKETS.filter((t) => (inQaFor[t.key] ?? Infinity) <= Number(back) + 1);
  const rows = moved.map((t) => (fields === 'key' ? null : { key: t.key, fields: { status: t.fields.status } }));
  return Promise.resolve({ stdout: `✓ ${rows.length} work items\n${JSON.stringify(rows)}` });
}
Object.assign(childProcess, { execFile: fakeExecFile });
syncBuiltinESMExports();

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

// Paged a few at a time, with mergedBefore read as the end of its day, as GitLab answers it.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  assert.equal(String(input), 'https://gitlab.com/api/graphql');
  const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { group: string; after: string; before: string | null; cursor: string | null } };
  assert.match(query, /mergeRequests\(state: merged, mergedAfter: \$after, mergedBefore: \$before, includeSubgroups: true/);
  pages.push({ after: variables.after, before: variables.before, cursor: variables.cursor });
  if (!groupFound) return json({ data: { group: null } });
  const until = variables.before ? Date.parse(`${variables.before.slice(0, 10)}T23:59:59.999Z`) : Infinity;
  const inside = MERGED.filter((mr) => Date.parse(mr.mergedAt) >= Date.parse(variables.after) && Date.parse(mr.mergedAt) <= until);
  const at = Number(variables.cursor ?? 0);
  const hasNextPage = at + PAGE < inside.length;
  return json({ data: { group: { mergeRequests: { pageInfo: { hasNextPage, endCursor: hasNextPage ? String(at + PAGE) : null }, nodes: inside.slice(at, at + PAGE) } } } });
}) as typeof fetch;

const { buildQaBoard, ticketKeysIn } = await import('./qa/board.js');
const { fetchMyTickets } = await import('./data/jira.js');
const { QA_BUCKETS } = await import('./engine.js');
// What the board was built from before the search and group were settings, so these show it unchanged.
const QA_SETTINGS = { jql: 'project = ABC AND status = QA', group: 'acme' };

after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  inQaFor = { 'ABC-4142': 1, 'ABC-3990': 3, 'ABC-4101': 9, 'ABC-3801': 25 };
  jiraDown = null;
  groupFound = true;
  searches.length = 0;
  pages.length = 0;
});

const mrRefs = (mrs: { project: string; iid: number }[]) => mrs.map((mr) => `${mr.project.split('/').pop()}!${mr.iid}`);

test('every ticket in QA comes with its assignee, its days in QA and the MRs that name it in their title or branch, oldest first', async () => {
  const board = await buildQaBoard({ ...QA_SETTINGS, now: NOW });
  assert.deepEqual(board.tickets.map((t) => [t.key, t.assignee, t.days, t.bucket, mrRefs(t.mrs)]), [
    ['ABC-3500', 'Sybil Shaw', { from: 91, to: null }, 'weeks-2-plus', []],
    ['ABC-3801', 'Ivan Irving', { from: 22, to: 28 }, 'weeks-2-plus', ['gateway!212', 'relay!1188']],
    ['ABC-4101', 'Sybil Shaw', { from: 9, to: 9 }, 'weeks-1-2', ['frontend!1702']],
    ['ABC-3990', null, { from: 3, to: 3 }, 'days-2-3', []],
    ['ABC-4142', 'Ivan Irving', { from: 1, to: 1 }, 'today', ['relay!1201', 'frontend!1720']],
  ]);
  const stale = board.tickets.find((t) => t.key === 'ABC-4142');
  assert.equal(stale?.summary, '[Renderer] A button can act on stale state while a save is in flight');
  assert.equal(stale?.url, 'https://example.atlassian.net/browse/ABC-4142');
  assert.deepEqual(stale?.mrs[0], {
    project: 'acme/platform/relay', iid: 1201, url: 'https://gitlab.com/acme/platform/relay/-/merge_requests/1201',
    title: 'Wait for the save before acting', mergedAt: '2026-11-09T16:00:00Z', author: 'Trent Tyler', additions: 40, deletions: 5, keys: ['ABC-4142'],
  });
  assert.deepEqual(board.buckets, QA_BUCKETS);
  assert.equal(board.jql, QA_SETTINGS.jql);
  assert.equal(board.status, 'QA');
});

test('days in QA are read from one Jira search per day boundary, and the main search asks for the assignee', async () => {
  await buildQaBoard({ ...QA_SETTINGS, jql: 'project in (ABC, XYZ) AND status = QA ORDER BY created DESC', now: NOW });
  const main = searches.filter((s) => !s.jql.includes('CHANGED'));
  assert.deepEqual(main, [{ jql: 'project in (ABC, XYZ) AND status = QA ORDER BY created DESC', fields: 'key,summary,status,assignee' }]);
  const edges = searches.filter((s) => s.jql.includes('CHANGED'));
  assert.equal(edges.length, 19);
  assert.deepEqual(edges.slice(0, 2).map((s) => s.jql), [
    '(project in (ABC, XYZ) AND status = QA) AND status CHANGED TO "QA" AFTER startOfDay(-0)',
    '(project in (ABC, XYZ) AND status = QA) AND status CHANGED TO "QA" AFTER startOfDay(-1)',
  ]);
  assert.match(edges.at(-1)?.jql ?? '', /AFTER startOfDay\(-89\)$/);
  assert.ok(edges.every((s) => s.fields === 'key,status'), 'a search for the key alone answers with nulls');
});

test('a ticket that went back to QA counts from its latest move', async () => {
  inQaFor['ABC-4101'] = 2;
  const board = await buildQaBoard({ ...QA_SETTINGS, now: NOW });
  assert.deepEqual(board.tickets.find((t) => t.key === 'ABC-4101')?.days, { from: 2, to: 2 });
});

test('merged MRs are read a week at a time across the window, paged, never per ticket, and only those naming a ticket are kept', async () => {
  const board = await buildQaBoard({ ...QA_SETTINGS, now: NOW });
  const slices = pages.filter((p) => p.cursor === null);
  assert.equal(slices.length, 9, 'sixty days in weeks');
  assert.equal(slices[0]?.after, new Date(NOW - 60 * DAY_MS).toISOString());
  assert.equal(slices.filter((p) => p.before === null).length, 1, 'only the newest slice runs up to now');
  assert.ok(pages.some((p) => p.cursor !== null), 'a slice longer than a page follows its cursor');
  assert.deepEqual(mrRefs(board.merged.mrs), ['frontend!1720', 'relay!1201', 'frontend!1702', 'desk-booking!2', 'relay!1188', 'gateway!212']);
  assert.deepEqual(board.merged.mrs.find((mr) => mr.iid === 1702)?.keys, ['ABC-4101'], 'a lower case key in a branch still counts');
  assert.deepEqual([board.merged.fullAt, board.merged.through], [new Date(NOW).toISOString(), new Date(NOW).toISOString()]);
});

test('with the last read in hand only what merged since it is asked for, and what has left the window is dropped', async () => {
  const first = await buildQaBoard({ ...QA_SETTINGS, now: NOW });
  const old = { ...first.merged.mrs[0]!, iid: 7, mergedAt: '2026-09-01T09:00:00Z' };
  pages.length = 0;
  const later = NOW + 15 * 60_000;
  const next = await buildQaBoard({ ...QA_SETTINGS, now: later, merged: { ...first.merged, mrs: [...first.merged.mrs, old] } });
  assert.deepEqual(pages, [{ after: new Date(NOW - 3_600_000).toISOString(), before: null, cursor: null }]);
  assert.deepEqual(mrRefs(next.merged.mrs), mrRefs(first.merged.mrs));
  assert.deepEqual([next.merged.fullAt, next.merged.through], [first.merged.fullAt, new Date(later).toISOString()]);
});

test('the whole window is read again when asked, once a day, or for another group', async () => {
  const first = await buildQaBoard({ ...QA_SETTINGS, now: NOW });
  const reads = async (request: Parameters<typeof buildQaBoard>[0]) => {
    pages.length = 0;
    await buildQaBoard(request);
    return pages.filter((p) => p.cursor === null).length;
  };
  assert.equal(await reads({ ...QA_SETTINGS, now: NOW + 60_000, merged: first.merged, full: true }), 9);
  assert.equal(await reads({ ...QA_SETTINGS, now: NOW + DAY_MS, merged: first.merged }), 9);
  assert.equal(await reads({ ...QA_SETTINGS, now: NOW + 60_000, merged: { ...first.merged, group: 'elsewhere' } }), 9);
  assert.equal(await reads({ ...QA_SETTINGS, now: NOW + 60_000, merged: { ...first.merged, mrs: 'not a list' as never } }), 9);
});

test('an MR that names two tickets is listed under both', async () => {
  MERGED.unshift({ ...MERGED[3]!, iid: '1740', title: 'ABC-4101 and ABC-4142: share the session guard', sourceBranch: 'fix/session-guard', mergedAt: '2026-11-10T09:00:00Z' } as never);
  try {
    const board = await buildQaBoard({ ...QA_SETTINGS, now: NOW });
    const refs = (key: string) => mrRefs(board.tickets.find((t) => t.key === key)?.mrs ?? []);
    assert.deepEqual([refs('ABC-4101'), refs('ABC-4142')], [['frontend!1702', 'frontend!1740'], ['relay!1201', 'frontend!1720', 'frontend!1740']]);
  } finally {
    MERGED.shift();
  }
});

test('a board built in the background leaves a slot free, so a search someone is waiting on starts at once', async () => {
  let open = () => {};
  gate = new Promise((resolve) => { open = resolve; });
  const board = buildQaBoard({ ...QA_SETTINGS, now: NOW, priority: 'background' });
  const yours = fetchMyTickets();
  assert.equal(searches.length, 3, 'the board holds two slots and the tickets search takes the third');
  assert.match(searches[2]?.jql ?? '', /^assignee = currentUser\(\)/);
  open();
  gate = null;
  await Promise.all([board, yours]);
  assert.equal(searches.length, 21);
});

test('Jira or GitLab failing fails the board, with what they said', async () => {
  jiraDown = '✗ Error: unauthorized: use "acli jira auth login" to authenticate';
  await assert.rejects(buildQaBoard({ ...QA_SETTINGS, now: NOW }), /unauthorized: use "acli jira auth login"/);
  jiraDown = null;
  groupFound = false;
  await assert.rejects(buildQaBoard({ ...QA_SETTINGS, now: NOW, group: 'nowhere' }), /GitLab has no group nowhere/);
  await assert.rejects(buildQaBoard({ jql: '  ' }), /needs some JQL/);
});

test('days in QA count from the status the settings name, and each group named has its merged MRs read', async () => {
  const board = await buildQaBoard({ jql: 'project = ABC', status: 'Ready to "test"', group: 'acme, acme-labs', now: NOW });
  assert.match(searches.find((s) => s.jql.startsWith('(project = ABC)') && s.jql.includes('CHANGED'))?.jql ?? '', /status CHANGED TO "Ready to \\"test\\"" AFTER/);
  assert.deepEqual([board.status, board.group], ['Ready to "test"', 'acme, acme-labs']);
  assert.equal(pages.filter((p) => p.cursor === null).length, 18, 'nine weeks of slices for each of the two groups');
});

test('with no group to read the tickets still come, and GitLab is not asked', async () => {
  const board = await buildQaBoard({ jql: 'project = ABC', group: '', now: NOW });
  assert.equal(pages.length, 0);
  assert.ok(board.tickets.length > 0);
  assert.ok(board.tickets.every((t) => t.mrs.length === 0));
});

test('ticket keys are found in any case, once each, and words that only look like keys are left to the join', () => {
  assert.deepEqual(ticketKeysIn('XYZ-2909: harden prompts', 'fix/xyz-2909-harden'), ['XYZ-2909']);
  assert.deepEqual(ticketKeysIn('Bump DEF-14 and ABC-1', 'feat/abc-1-and-abc-0'), ['DEF-14', 'ABC-1']);
  assert.deepEqual(ticketKeysIn('Refresh the docs', 'main'), []);
  assert.deepEqual(ticketKeysIn('chore(deps): update dependency vite to v6.4.1', 'renovate/vite-6.x'), []);
});
