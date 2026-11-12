import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-verdict-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { CHANGES_NOTE, decide } = await import('./verdict.js');
const { watchForReview, recordReviewTerminal } = await import('./actions/watch.js');
const { loadState, noteReviewHold, saveSettings } = await import('./data/store.js');
const { RELEASE_NOTE_BARE } = await import('./config.js');
const { DEFAULT_SETTINGS } = await import('./settings.js');
const { ME, mr, resetState } = await import('./auto/testkit.js');

const KEY = 'acme/engine!621';
let liveStatus = 'NOT_APPROVED';
let holdErrors: string[] = [];
const calls: string[] = [];
const realFetch = globalThis.fetch;

function describe(url: string, init?: RequestInit): string {
  const body = init?.body ? (JSON.parse(String(init.body)) as { query?: string; body?: string }) : {};
  if (body.query?.includes('mergeRequestRequestChanges')) return 'hold';
  if (body.query?.includes('mergeRequestDestroyRequestedChanges')) return 'release';
  if (body.query) return 'fetch';
  if (url.endsWith('/notes')) return `note: ${body.body}`;
  return url.split('/').pop() ?? url;
}

function answer(call: string): unknown {
  if (call === 'fetch') {
    const node = {
      iid: '621', title: 'Scope it', webUrl: 'https://x', draft: false, conflicts: false, userNotesCount: 0,
      resolvableDiscussionsCount: 0, resolvedDiscussionsCount: 0, createdAt: '', updatedAt: '',
      diffHeadSha: 'head-1', sourceBranch: 'b', detailedMergeStatus: liveStatus,
      author: { username: 'heidi' }, reviewers: { nodes: [] }, approvedBy: { nodes: [] }, headPipeline: null,
    };
    return { data: { p0: { id: 'gid://gitlab/Project/1001', fullPath: 'acme/engine', name: 'Engine', mergeRequests: { count: 1, nodes: [node] } } } };
  }
  if (call === 'hold') {
    const status = holdErrors.length ? liveStatus : 'REQUESTED_CHANGES';
    return { data: { mergeRequestRequestChanges: { errors: holdErrors, mergeRequest: { detailedMergeStatus: status } } } };
  }
  if (call === 'release') return { data: { mergeRequestDestroyRequestedChanges: { errors: [], mergeRequest: { detailedMergeStatus: 'NOT_APPROVED' } } } };
  return { id: 1 };
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const call = describe(String(input), init);
  calls.push(call);
  return new Response(JSON.stringify(answer(call)), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const REVIEW_WORKSPACE = { id: 'repo::/work::workspace:review', displayName: 'review-Engine-621', path: '/work', branch: '', isMainWorktree: false };
let agentTitle = '✳ Claude Code';

function orcaStub() {
  const removed: string[] = [];
  const orca = {
    listWorktrees: async () => [REVIEW_WORKSPACE],
    removeWorktree: async (id: string) => {
      removed.push(id);
    },
    listAgentTerminals: async () => [{ handle: 'term-review', title: agentTitle, agent: 'claude', connected: true, orphaned: false }],
  };
  return { orca, removed };
}

beforeEach(() => {
  resetState();
  calls.length = 0;
  liveStatus = 'NOT_APPROVED';
  holdErrors = [];
  agentTitle = '✳ Claude Code';
  saveSettings({ ...DEFAULT_SETTINGS, closeWorkspaceWhenDone: true });
  watchForReview(mr());
  recordReviewTerminal(KEY, 'term-review');
});

const recorded = (): string | undefined => loadState().verdicts?.[KEY]?.verdict;

test('approving lifts a hold that is on now, and records the verdict', async () => {
  liveStatus = 'REQUESTED_CHANGES';
  const { orca } = orcaStub();
  const decision = await decide(mr({ mergeStatus: 'NOT_APPROVED' }), 'approve', { hosts: orca });
  assert.equal(decision.liftedHold, true);
  assert.deepEqual(calls, ['fetch', 'approve', 'release', `note: ${RELEASE_NOTE_BARE}`]);
  assert.equal(recorded(), 'approved');
});

test('requesting changes holds the merge, says why, and records the verdict', async () => {
  const { orca } = orcaStub();
  const decision = await decide(mr(), 'changes', { hosts: orca });
  assert.equal(decision.liftedHold, false);
  assert.deepEqual(calls, ['hold', `note: ${CHANGES_NOTE}`]);
  assert.equal(recorded(), 'changes');
});

test('requesting changes makes the hold your verdict, so the review no longer owns it', async () => {
  noteReviewHold(KEY, 'head-1');
  await decide(mr(), 'changes', { hosts: orcaStub().orca });
  assert.equal(loadState().reviewHolds?.[KEY], undefined);
});

test('a hold GitLab warns about but places still counts, and the warning is passed on', async () => {
  holdErrors = ['Reviewer not found'];
  liveStatus = 'REQUESTED_CHANGES';
  const { orca } = orcaStub();
  const decision = await decide(mr(), 'changes', { hosts: orca });
  assert.equal(decision.warning, 'Reviewer not found');
  assert.equal(recorded(), 'changes');
});

test('a change request GitLab refuses records nothing and closes nothing', async () => {
  holdErrors = ['You are not allowed to request changes'];
  const { orca, removed } = orcaStub();
  await assert.rejects(decide(mr(), 'changes', { hosts: orca }), /You are not allowed to request changes/);
  assert.equal(recorded(), undefined);
  assert.deepEqual(removed, []);
});

test('an MR you already approved is not approved twice, but the verdict is still recorded', async () => {
  const { orca } = orcaStub();
  await decide(mr({ approvedBy: [ME] }), 'approve', { me: ME, hosts: orca });
  assert.deepEqual(calls, []);
  assert.equal(recorded(), 'approved');
});

test('deciding closes the review workspace once its agent has stopped', async () => {
  const { orca, removed } = orcaStub();
  const decision = await decide(mr(), 'approve', { hosts: orca });
  assert.deepEqual(decision.workspace, { closed: true });
  assert.deepEqual(removed, [REVIEW_WORKSPACE.id]);
});

test('the workspace is kept while its agent works, and says so', async () => {
  agentTitle = '◐ Claude Code';
  const { orca, removed } = orcaStub();
  const decision = await decide(mr(), 'approve', { hosts: orca });
  assert.deepEqual(decision.workspace, { closed: false, kept: 'its agent is still working' });
  assert.deepEqual(removed, []);
  assert.equal(recorded(), 'approved');
});

test('with tidying switched off nothing in Orca is touched', async () => {
  saveSettings({ ...DEFAULT_SETTINGS, closeWorkspaceWhenDone: false });
  let asked = false;
  const touched = async (): Promise<never> => {
    asked = true;
    throw new Error('Orca should not be asked');
  };
  const decision = await decide(mr(), 'changes', { hosts: { listWorktrees: touched, removeWorktree: touched, listAgentTerminals: touched } });
  assert.deepEqual(decision.workspace, { closed: false });
  assert.equal(asked, false);
});

test('Orca refusing the removal is reported, and the verdict still stands', async () => {
  const { orca } = orcaStub();
  orca.removeWorktree = async () => {
    throw new Error('orca worktree rm failed: workspace has uncommitted changes');
  };
  const decision = await decide(mr(), 'approve', { hosts: orca });
  assert.deepEqual(decision.workspace, { closed: false, kept: 'orca worktree rm failed: workspace has uncommitted changes' });
  assert.equal(recorded(), 'approved');
});

test('a Claude Code review agent still mid-turn keeps its workspace, and one whose turn ended has it removed', async () => {
  const claude = (working: boolean) => ({
    listWorktrees: async () => [{ ...REVIEW_WORKSPACE, id: 'claude:5f0c3b8e-9a6d-4c1e-8f2a-1b3c4d5e6f70' }],
    removeWorktree: async (id: string) => {
      removed.push(id);
    },
    listAgentTerminals: async () => [{ handle: 'term-review', title: 'review !621', agent: 'claude', connected: true, orphaned: false, working }],
  });
  const removed: string[] = [];
  assert.deepEqual((await decide(mr(), 'changes', { hosts: claude(true) })).workspace, { closed: false, kept: 'its agent is still working' });
  assert.deepEqual((await decide(mr(), 'changes', { hosts: claude(false) })).workspace, { closed: true });
  assert.deepEqual(removed, ['claude:5f0c3b8e-9a6d-4c1e-8f2a-1b3c4d5e6f70']);
});
