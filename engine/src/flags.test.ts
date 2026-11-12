import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FLAG_SLOTS,
  age,
  cleanTitle,
  deriveFlags,
  flagCells,
  flagString,
  freshness,
  pad,
  pipelineGlyph,
  shortDuration,
  sortForReview,
} from './flags.js';
import { extractTicket, fingerprint, fingerprintDiffers, type Mr } from './types.js';
import { branchSlug, worktreeDirName } from './actions/launch.js';

function mr(over: Partial<Mr> = {}): Mr {
  return {
    projectPath: 'acme/engine',
    projectId: 1001,
    repoLabel: 'Engine',
    iid: 621,
    title: '🐛 (ABC-3568) Scope the App Library',
    webUrl: 'https://gitlab.com/x/-/merge_requests/621',
    draft: false,
    conflicts: false,
    notes: 3,
    author: 'you',
    reviewers: [],
    approvedBy: [],
    pipeline: 'SUCCESS',
    mergeStatus: 'NOT_APPROVED',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    sha: 'abc123',
    sourceBranch: 'fix/ABC-3568-app-store-org-scope',
    ticket: 'ABC-3568',
    unresolvedThreads: 0,
    ...over,
  };
}

test('a reviewer who has not approved is waiting on you', () => {
  const f = deriveFlags(mr({ reviewers: ['you'], author: 'hugo' }), { me: 'you' });
  assert.equal(f.waitingOnYou, true);
  assert.equal(f.mine, false);
  assert.equal(flagString(f)[0], 'W');
});

test('approving clears waiting and shows the tick', () => {
  const f = deriveFlags(
    mr({ reviewers: ['you'], approvedBy: ['you'], author: 'hugo' }),
    { me: 'you' },
  );
  assert.equal(f.waitingOnYou, false);
  assert.equal(flagString(f)[0], '✓');
});

test('flag string keeps a fixed width so columns never shift', () => {
  const plain = flagString(deriveFlags(mr(), {}));
  const loud = flagString(
    deriveFlags(mr({ conflicts: true, pipeline: 'FAILED' }), {
      me: 'you',
      watched: true,
      changed: true,
      queued: 2,
    }),
  );
  assert.equal(plain.length, loud.length);
  assert.equal(plain.length, 4);
});

test('a red pipeline outranks a conflict in the second slot', () => {
  const f = deriveFlags(mr({ pipeline: 'FAILED', conflicts: true }), {});
  assert.equal(flagString(f)[1], '×');
});

test('fingerprint only differs when something a reviewer cares about moved', () => {
  const before = fingerprint(mr());
  assert.equal(fingerprintDiffers(before, fingerprint(mr({ title: 'renamed' }))), false);
  assert.equal(fingerprintDiffers(before, fingerprint(mr({ sha: 'def456' }))), true);
  assert.equal(fingerprintDiffers(before, fingerprint(mr({ notes: 4 }))), true);
  assert.equal(fingerprintDiffers(before, fingerprint(mr({ pipeline: 'FAILED' }))), true);
  assert.equal(fingerprintDiffers(before, fingerprint(mr({ approvedBy: ['x'] }))), true);
});

test('an unwatched MR is never reported as changed', () => {
  assert.equal(fingerprintDiffers(undefined, fingerprint(mr())), false);
});

test('rows sort so queued comments and your review queue come first', () => {
  const queued = mr({ iid: 1 });
  const waiting = mr({ iid: 2, author: 'hugo', reviewers: ['you'] });
  const red = mr({ iid: 3, pipeline: 'FAILED', author: 'hugo' });
  const other = mr({ iid: 4, author: 'hugo' });
  const sorted = sortForReview([other, red, waiting, queued], (m) =>
    deriveFlags(m, { me: 'you', queued: m.iid === 1 ? 1 : 0 }),
  );
  assert.deepEqual(sorted.map((m) => m.iid), [1, 2, 3, 4]);
});

test('ticket keys come from the title or the branch', () => {
  assert.equal(extractTicket('🐛 (ABC-3568) thing'), 'ABC-3568');
  assert.equal(extractTicket('no ticket', 'feat/SE-656-observatory'), 'SE-656');
  assert.equal(extractTicket('nothing', 'plain-branch'), null);
});

test('age reads in the units a reviewer thinks in', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  assert.equal(age('2026-10-06T11:30:00Z', now), '30m');
  assert.equal(age('2026-10-06T04:00:00Z', now), '8h');
  assert.equal(age('2026-10-01T12:00:00Z', now), '5d');
});

test('pad truncates with an ellipsis and never overruns', () => {
  assert.equal(pad('short', 8), 'short   ');
  assert.equal(pad('a-very-long-title', 8).length, 8);
  assert.ok(pad('a-very-long-title', 8).endsWith('…'));
});

test('a worktree name is the repo prefix and the ticket key as it is, lower-cased', () => {
  assert.equal(
    worktreeDirName({ path: 'x', label: 'Engine', prefix: 'ce' }, 'ABC-3568'),
    'ce-abc-3568',
  );
  assert.equal(worktreeDirName({ path: 'x', label: 'Engine', prefix: 'ce' }, 'ABC-1234'), 'ce-abc-1234', 'the key keeps its own prefix');
  assert.equal(worktreeDirName({ path: 'x', label: 'Data Pipeline' }, 'DATA-7'), 'data-pipeline-data-7');
  assert.equal(branchSlug('[Org Management] A new org has no Desktop, so opening it errors'), 'a-new-org-has-no');
});

test('title cleaning drops the emoji and the duplicated ticket, keeping the bracket', () => {
  assert.equal(
    cleanTitle("🐛 (ABC-3568) Scope the App Library's rows", 'ABC-3568'),
    "Scope the App Library's rows",
  );
  assert.equal(cleanTitle('✨ Store stored-tool audit rows durably', null), 'Store stored-tool audit rows durably');
  assert.equal(cleanTitle('Draft: ✨ WK-251: NICHE-sim Explorer', 'WK-251'), 'Draft: NICHE-sim Explorer');
  assert.equal(cleanTitle('ABC-3665: Use the baked style-gate', 'ABC-3665'), 'Use the baked style-gate');
  assert.equal(cleanTitle('♻️ Move ontology CAS off raw AQL', null), 'Move ontology CAS off raw AQL');
});

test('a title that is only a ticket is left alone rather than blanked', () => {
  assert.equal(cleanTitle('ABC-3568', 'ABC-3568'), 'ABC-3568');
});

test('failed and success pipelines differ in shape, not just colour', () => {
  assert.notEqual(pipelineGlyph('SUCCESS'), pipelineGlyph('FAILED'));
});

test('literal gitmoji shortcodes come off as well as real emoji', () => {
  assert.equal(
    cleanTitle(':sparkles: SE-732: app-bench 1.1.0', 'SE-732'),
    'app-bench 1.1.0',
  );
  assert.equal(cleanTitle(':bug: (ABC-2950) move the dev traefik netpol', 'ABC-2950'), 'move the dev traefik netpol');
});

test('a colon-wrapped word that is not a shortcode survives', () => {
  assert.equal(cleanTitle('Fix :memory: database handling', null), 'Fix :memory: database handling');
});

test('the key and the rows draw from one table, so the key cannot lie', () => {
  const inRows = new Set(FLAG_SLOTS.flatMap((s) => s.specs).map((s) => `${s.glyph}${s.colour}`));
  const red = FLAG_SLOTS[1]!.specs.find((s) => s.glyph === '×');
  assert.equal(red?.colour, 'red', 'the key says red, so the row glyph must be red');
  const cells = flagCells(deriveFlags(mr({ pipeline: 'FAILED' }), {}));
  const shown = cells.find((c) => c.glyph === '×');
  assert.ok(shown && inRows.has(`${shown.glyph}${shown.colour}`));
});

test('every slot keeps its glyphs distinct so a colour repeat is never ambiguous', () => {
  for (const slot of FLAG_SLOTS) {
    const glyphs = slot.specs.map((s) => s.glyph);
    assert.equal(new Set(glyphs).size, glyphs.length, `${slot.name} has a duplicate glyph`);
  }
});

test('cells stay four wide whatever is set', () => {
  assert.equal(flagCells(deriveFlags(mr(), {})).length, 4);
  assert.equal(
    flagCells(deriveFlags(mr({ conflicts: true }), { me: 'you', watched: true, queued: 1 }))
      .length,
    4,
  );
});

test('durations read in seconds while they are fresh', () => {
  assert.equal(shortDuration(0), '0s');
  assert.equal(shortDuration(12_000), '12s');
  assert.equal(shortDuration(59_999), '59s');
  assert.equal(shortDuration(60_000), '1m');
  assert.equal(shortDuration(90 * 60_000), '1h');
  assert.equal(shortDuration(-5000), '0s', 'clock skew never shows a negative age');
});

test('freshness goes amber past one poll and red past three', () => {
  const poll = 90_000;
  const t = 1_000_000;
  assert.equal(freshness(t, t + 5_000, poll).colour, 'gray');
  assert.equal(freshness(t, t + 5_000, poll).stale, false);
  assert.equal(freshness(t, t + 100_000, poll).colour, 'gray', 'one interval is not yet late');
  assert.equal(freshness(t, t + 140_000, poll).colour, 'yellow');
  assert.equal(freshness(t, t + 300_000, poll).colour, 'red');
  assert.equal(freshness(t, t + 300_000, poll).stale, true);
});

test('before the first fetch it says so rather than claiming to be current', () => {
  const f = freshness(null, Date.now(), 90_000);
  assert.equal(f.label, 'not loaded');
  assert.equal(f.stale, true);
});

test('the label carries the age so a stale screen is readable at a glance', () => {
  const t = 1_000_000;
  assert.equal(freshness(t, t + 42_000, 90_000).label, 'updated 42s ago');
  assert.equal(freshness(t, t + 600_000, 90_000).label, 'updated 10m ago');
});

test('a held MR shows as held rather than as whatever else blocks it', () => {
  const f = deriveFlags(mr({ pipeline: 'FAILED', conflicts: true, draft: true }), { held: true });
  assert.equal(flagString(f)[1], 'H', 'the hold is the headline reason it cannot merge');
  const unheld = deriveFlags(mr({ pipeline: 'FAILED', conflicts: true }), {});
  assert.equal(flagString(unheld)[1], '×');
});

test('the blocked slot still keeps every glyph distinct', () => {
  const slot = FLAG_SLOTS[1]!;
  const glyphs = slot.specs.map((s) => s.glyph);
  assert.equal(new Set(glyphs).size, glyphs.length);
  assert.ok(glyphs.includes('H'));
});
