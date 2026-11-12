import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActivityEvent, MrBrief } from './data/gitlab.js';
import { inProgressLines, isExcluded, meetingLines, nextStep, ownWork, plainTitle, reviews, type GitlabDay, type OpenMr } from './standup/compose.js';
import { startOfDay } from './locale.js';

const ME = 'frank.foster';

function brief(projectPath: string, iid: number, title: string, extra: Partial<MrBrief> = {}): MrBrief {
  return {
    projectId: projectPath.length, projectPath, iid, title, author: 'ivan', sourceBranch: 'feat/x', webUrl: '', draft: false, conflicts: false,
    mergeStatus: null, mergedAt: null, reviewers: ['judy'], ...extra,
  };
}

const on = (mr: MrBrief, action: string, at = '2026-11-09T10:00:00Z', author = ME): ActivityEvent => ({ action, projectId: mr.projectId, iid: mr.iid, title: mr.title, author, at });

function day(mrs: MrBrief[], events: ActivityEvent[], merged: MrBrief[] = []): GitlabDay {
  return { me: ME, events, mrs: new Map(mrs.map((m) => [`${m.projectId}!${m.iid}`, m])), merged };
}

const lines = (list: { tag: string; text: string }[]) => list.map((l) => `[${l.tag}] ${l.text}`);

test('a title loses its gitmoji, its ticket and its draft mark, and its capital unless the word is a name', () => {
  assert.equal(plainTitle('🔒 (ABC-1234) Require billing:write', 'ABC-1234'), 'require billing:write');
  assert.equal(plainTitle('Draft: ✨ (ABC-9) Add the thing', 'ABC-9'), 'add the thing');
  assert.equal(plainTitle('[ABC-9] Fix it', 'ABC-9'), 'fix it');
  assert.equal(plainTitle('ABC-9: Fix it', 'ABC-9'), 'fix it');
  assert.equal(plainTitle('👷 GitLab CI components', null), 'GitLab CI components');
  assert.equal(plainTitle('API keys rotate', null), 'API keys rotate');
});

test('reviews group by ticket, busiest ticket first, with what has no ticket last', () => {
  const a = brief('g/alpha', 1, '(ABC-2) Add'), b = brief('g/beta', 2, '(ABC-1) Bump'), c = brief('g/gamma', 3, '(ABC-2) Cut'), d = brief('g/delta', 4, 'Drop'), e = brief('g/eps', 5, '(ABC-3) Ease');
  const events = [on(a, 'commented on'), on(b, 'commented on'), on(b, 'commented on'), on(c, 'commented on'), on(c, 'commented on'), on(d, 'commented on'), on(d, 'commented on'), on(d, 'commented on'), on(e, 'approved')];
  assert.deepEqual(lines(reviews(day([a, b, c, d, e], events), [])), [
    '[Review - ABC-2] gamma !3, 2 comments: cut',
    '[Review - ABC-2] alpha !1, 1 comment: add',
    '[Review - ABC-1] beta !2, 2 comments: bump',
    '[Review - ABC-3] eps !5, approved: ease',
    '[Review - NoTicket] delta !4, 3 comments: drop',
  ]);
});

test('a review takes its ticket from the branch when the title has none, and your own MRs are never reviews', () => {
  const theirs = brief('g/alpha', 1, 'Tidy', { sourceBranch: 'fix/ABC-77-tidy' });
  const mine = brief('g/beta', 2, '(ABC-5) Mine', { author: ME });
  assert.deepEqual(lines(reviews(day([theirs, mine], [on(theirs, 'commented on'), on(mine, 'commented on'), on(mine, 'approved')]), [])), ['[Review - ABC-77] alpha !1, 1 comment: tidy']);
});

test('events by anyone else are not yours to report', () => {
  const theirs = brief('g/alpha', 1, '(ABC-2) A');
  assert.deepEqual(reviews(day([theirs], [on(theirs, 'commented on', undefined, 'review-bot')]), []), []);
});

test('your merges and openings come in the order they happened, an MR opened and merged that day once, and one with no ticket marked', () => {
  const first = brief('g/one', 1, '(ABC-1) First', { author: ME, mergedAt: '2026-11-09T11:00:20Z' });
  const second = brief('g/two', 2, 'No key here', { author: ME });
  const both = brief('g/three', 3, '(ABC-3) Both', { author: ME });
  const theirs = brief('g/four', 4, '(ABC-4) Theirs');
  const mergedByOthers = brief('g/five', 5, '(ABC-5) Merged by Judy', { author: ME, mergedAt: '2026-11-09T09:00:00Z' });
  const events = [on(second, 'accepted', '2026-11-09T15:00:00Z'), on(first, 'accepted', '2026-11-09T11:00:00Z'), on(both, 'opened'), on(both, 'accepted', '2026-11-09T16:00:00Z'), on(theirs, 'accepted')];
  const own = ownWork(day([first, second, both, theirs], events, [mergedByOthers, first]), []);
  assert.deepEqual(lines(own.merged), [
    '[ABC-5] Merged five !5: merged by Judy',
    '[ABC-1] Merged one !1: first',
    '[?] Merged two !2: no key here',
    '[ABC-3] Merged three !3: both',
  ]);
  assert.deepEqual(own.opened, []);
  assert.deepEqual(own.merged.map((l) => Boolean(l.unknown)), [false, false, true, false]);
});

test('a repo is left out by the end of its path, never by a part of a name', () => {
  assert.ok(isExcluded('acme/tooling/dashboard', ['tooling/dashboard']));
  assert.ok(isExcluded('acme/tooling/sandbox', [' /tooling/sandbox/ ']));
  assert.ok(!isExcluded('acme/tooling/dashboard-v2', ['tooling/dashboard']));
  assert.ok(!isExcluded('acme/tooling/new-dashboard', ['dashboard']));
  assert.ok(!isExcluded('acme/tooling/dashboard', ['']));
});

test('an open MR says what it is waiting on, and from whom', () => {
  const open = (extra: Partial<OpenMr>): string => {
    const { verb, state } = nextStep({ ...brief('g/r', 1, 'T'), approvedBy: [], ...extra });
    return `${verb} (${state})`;
  };
  assert.equal(open({ draft: true, conflicts: true }), 'Finish (draft)');
  assert.equal(open({ conflicts: true, mergeStatus: 'mergeable' }), 'Fix conflicts on (conflict)');
  assert.equal(open({ mergeStatus: 'requested_changes' }), 'Address the review on (changes requested)');
  assert.equal(open({ mergeStatus: 'need_rebase' }), 'Rebase (needs rebase)');
  assert.equal(open({ mergeStatus: 'ci_must_pass' }), 'Fix the pipeline on (pipeline failing)');
  assert.equal(open({ mergeStatus: 'discussions_not_resolved' }), 'Resolve the threads on (unresolved threads)');
  assert.equal(open({ mergeStatus: 'mergeable', approvedBy: ['judy'] }), 'Merge (ready to merge)');
  assert.equal(open({ mergeStatus: 'mergeable' }), 'Chase review on (awaiting review)', 'mergeable with nobody approving is still waiting on a review');
  assert.equal(open({ mergeStatus: 'ci_still_running', approvedBy: ['judy'] }), 'Merge (approved, pipeline running)');
  assert.equal(open({ mergeStatus: 'not_approved', reviewers: [] }), 'Ask for a review on (no reviewers)');
  assert.equal(open({ mergeStatus: 'not_approved' }), 'Chase review on (awaiting review)');
});

test('a ticket in progress that an open MR already covers is not said twice', () => {
  const tickets = ['ABC-1', 'ABC-2', 'ABC-3'].map((key) => ({ key, summary: `Do ${key}`, status: 'In Progress', labels: [], url: '' }));
  const mrs = [brief('g/a', 1, '(ABC-1) A'), brief('g/b', 2, 'B', { sourceBranch: 'feat/ABC-3-b' })];
  assert.deepEqual(lines(inProgressLines(tickets, mrs)), ['[ABC-2] Do ABC-2 (In Progress)']);
});

test('a meeting line has its time and the others in it, and an all-day one is offered unticked', () => {
  const at = startOfDay('2026-11-09', 'Europe/London');
  const shown = meetingLines([
    { id: 'a@1', summary: 'Planning', day: '2026-11-09', time: '10:00', at, others: ['Abe', 'Ben'] },
    { id: 'b@1', summary: 'Offsite', day: '2026-11-09', time: null, at, others: ['Abe'] },
  ], 'meetings');
  assert.deepEqual(shown.map((l) => [l.id, `[${l.tag}] ${l.text}`, l.ticked]), [
    ['meetings:a@1', '[Meeting: Planning] 10:00 with Abe and Ben', true],
    ['meetings:b@1', '[Meeting: Offsite] all day', false],
  ]);
});
