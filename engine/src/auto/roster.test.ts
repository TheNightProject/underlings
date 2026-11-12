import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPeople, parsePeople } from './people.js';
import { roster, typedUsername, withLevel } from './roster.js';
import { ME, mr } from './testkit.js';

const mrs = [
  mr({ iid: 1, author: 'heidi' }),
  mr({ iid: 2, author: 'heidi', draft: true }),
  mr({ iid: 3, author: 'Alice', reviewers: [] }),
  mr({ iid: 4, author: 'felix' }),
  mr({ iid: 5, author: 'felix' }),
  mr({ iid: 6, author: ME }),
  mr({ iid: 7, author: 'renovate-bot' }),
];

const reviewed = [
  mr({ iid: 10, author: 'felix', reviewers: [ME, 'heidi'] }),
  mr({ iid: 11, author: 'alice', reviewers: ['heidi', 'review-bot'], approvedBy: ['heidi', 'judy'] }),
  mr({ iid: 12, author: 'judy', reviewers: ['judy'] }),
];

test('everyone with an open merge request is listed once, without you or the bots', () => {
  const rows = roster(mrs, ME, []);
  assert.deepEqual(
    rows.map((r) => [r.username, r.askingYou, r.open]),
    [
      ['felix', 2, 2],
      ['heidi', 1, 2],
      ['alice', 0, 1],
    ],
  );
});

test('a draft, or a merge request you are not reviewing, is open but not asking you', () => {
  const heidi = roster(mrs, ME, []).find((r) => r.username === 'heidi');
  assert.deepEqual(heidi && [heidi.askingYou, heidi.open], [1, 2]);
});

test('someone already in full auto stays listed with their level after their last MR closes', () => {
  const rows = roster(mrs, ME, parsePeople('judy:comments, felix:shadow'));
  assert.equal(rows.find((r) => r.username === 'judy')?.level, 'comments');
  assert.equal(rows.find((r) => r.username === 'felix')?.level, 'shadow');
  assert.equal(rows.find((r) => r.username === 'alice')?.level, null);
});

test('changing a level leaves every row where it was, so the cursor stays on the person', () => {
  const before = roster(mrs, ME, []).map((r) => r.username);
  const after = roster(mrs, ME, parsePeople('alice:verdict')).map((r) => r.username);
  assert.deepEqual(after, before);
});

test('what the picker writes reads back as exactly what was picked', () => {
  let people = parsePeople('heidi:shadow');
  people = withLevel(people, 'felix', 'verdict');
  people = withLevel(people, 'heidi', 'comments');
  const text = formatPeople(people);
  assert.deepEqual(parsePeople(text), people);
  assert.deepEqual(parsePeople(formatPeople(withLevel(people, 'heidi', null))), [{ username: 'felix', level: 'verdict' }]);
});

test('someone who only reviews is listed, so they can be picked before they open an MR', () => {
  const heidi = roster(reviewed, ME, []).find((r) => r.username === 'heidi');
  assert.deepEqual(heidi && [heidi.open, heidi.reviewing], [0, 2]);
});

test('reviewing counts each MR once, and never an author reviewing their own or a bot', () => {
  const rows = roster(reviewed, ME, []);
  assert.equal(rows.find((r) => r.username === 'judy')?.reviewing, 1, 'approved alice, not their own');
  assert.ok(!rows.some((r) => r.username === 'review-bot'));
  assert.ok(!rows.some((r) => r.username === ME));
});

test('a typed name can be added only when it could be a GitLab username', () => {
  assert.equal(typedUsername('@Heidi.McCullough '), 'heidi.mccullough');
  assert.equal(typedUsername('two words'), null);
  assert.equal(typedUsername(''), null);
  assert.equal(typedUsername('.dot'), null);
});
