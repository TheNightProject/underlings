import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bump, compareVersions, draft, entryOf, groupLines, insertSection, linesSince, listedMrs, parseChangelog, parseLog, parseRemote, renderSection } from './changelog.mjs';

const CC = 'acme/tooling/dashboard';
const merged = (branch, title, iid, project = CC) => ({ sha: `sha-${iid}`, date: '2026-11-10', message: `Merge branch '${branch}' into 'main'\n\n${title}\n\nSee merge request ${project}!${iid}` });

test('a GitLab merge is filed by its title\'s GitMoji, without it, linked to its MR', () => {
  const entry = entryOf(merged('feat/qa', '✨ Add a QA view', 17));
  assert.equal(entry.title, 'Add a QA view');
  assert.equal(entry.group, 'New');
  assert.deepEqual(entry.mr, { project: CC, iid: 17, ref: `${CC}!17`, url: `https://gitlab.com/${CC}/-/merge_requests/17` });
  assert.equal(groupLines(draft([merged('feat/qa', '✨ Add a QA view', 17)])).New[0], `[Add a QA view](https://gitlab.com/${CC}/-/merge_requests/17)`);
});

test('each GitMoji lands in its group, with or without its variation selector, and tests, docs and tidying are left out', () => {
  const titles = ['✨ new', '🐛 fixed', '♻️ reworked', '♻ reworked bare', '🔓 opened', '🚚 moved', '💄 styled', '🍱 icon', '✅ tested', '📝 documented', '🎨 tidied', '🔀 merged', '✏️ typo'];
  const { groups, leftOut } = draft(titles.map((t, i) => merged('b', t, i + 1)));
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((e) => e.title)])), {
    New: ['new'], Fixed: ['fixed'], Changed: ['reworked', 'reworked bare', 'opened', 'moved'], 'Look and feel': ['styled', 'icon'],
  });
  assert.deepEqual(leftOut.map((e) => e.title), ['tested', 'documented', 'tidied', 'merged', 'typo']);
});

test('a title with no GitMoji, or one it does not know, is filed under Changed and said to be a guess', () => {
  const { groups, guessed } = draft([merged('b', 'Bump the thing', 1), merged('b', '🦄 Something odd', 2), merged('b', '🔧 Configure', 3)]);
  assert.deepEqual(groups.Changed.map((e) => e.title), ['Bump the thing', 'Something odd', 'Configure']);
  assert.deepEqual(guessed.map((e) => e.title), ['Bump the thing', 'Something odd']);
});

test('ticket keys never reach a line, and brackets in a title cannot break its link', () => {
  assert.equal(entryOf(merged('b', '🐛 (ABC-1234) Stop the [loop]', 1)).title, 'Stop the (loop)');
  assert.equal(entryOf(merged('b', '✨ XYZ-77: Add a thing', 2)).title, 'Add a thing');
  assert.equal(entryOf(merged('b', '✨ Add a thing [DEF-9]', 3)).title, 'Add a thing');
});

test('a merge made outside GitLab, or a plain commit, is read from its subject and has no link', () => {
  const local = entryOf({ message: '🔀 Merge the groundwork: in-place reload' });
  assert.deepEqual([local.title, local.group, local.mr], ['Merge the groundwork: in-place reload', null, null]);
  const plain = entryOf({ message: '🐛 Fix the rail\n\nLonger body.' });
  assert.deepEqual([plain.title, plain.group, groupLines(draft([{ message: plain.title }])).Changed], ['Fix the rail', 'Fixed', ['Fix the rail']]);
});

test('git log output is split into commits whatever their bodies hold', () => {
  const text = `aaa\x1f2026-11-09\x1fMerge branch 'a' into 'main'\n\n✨ One\n\nSee merge request ${CC}!1\n\x1e\nbbb\x1f2026-11-10\x1f🐛 Two\n\x1e\n`;
  assert.deepEqual(parseLog(text).map((c) => [c.sha, c.date, entryOf(c).title]), [['aaa', '2026-11-09', 'One'], ['bbb', '2026-11-10', 'Two']]);
  assert.deepEqual(parseLog(''), []);
});

test('a section lists each group that has lines, in a fixed order, under its version and date', () => {
  const section = renderSection({ version: '1.2.0', date: '2026-11-12', ...draft([merged('b', '💄 Look', 3), merged('b', '✨ New thing', 2), merged('b', '✅ Tests', 1)]) });
  assert.equal(section, `## 1.2.0 (2026-11-12)\n\n### New\n\n- [New thing](https://gitlab.com/${CC}/-/merge_requests/2)\n\n### Look and feel\n\n- [Look](https://gitlab.com/${CC}/-/merge_requests/3)\n`);
  assert.match(renderSection({ version: '1.2.1', date: '2026-11-13', ...draft([merged('b', '✅ Tests', 4)]) }), /tests, docs and tidying only/);
});

test('a new section goes above the newest one, and the changelog reads back into versions and groups', () => {
  const base = '# Changelog\n\nIntro.\n\n## 1.0.0 (2026-11-10)\n\n### New\n\n- [A](https://gitlab.com/x/y/-/merge_requests/1)\n\n### Fixed\n\n- B\n';
  const next = insertSection(base, renderSection({ version: '1.0.1', date: '2026-11-11', ...draft([merged('b', '🐛 C', 2, 'x/y')]) }));
  const { intro, sections } = parseChangelog(next);
  assert.equal(intro, '# Changelog\n\nIntro.');
  assert.deepEqual(sections.map((s) => [s.version, s.date, s.groups]), [
    ['1.0.1', '2026-11-11', { Fixed: ['[C](https://gitlab.com/x/y/-/merge_requests/2)'] }],
    ['1.0.0', '2026-11-10', { New: ['[A](https://gitlab.com/x/y/-/merge_requests/1)'], Fixed: ['B'] }],
  ]);
  assert.match(sections[1].body, /^### New\n\n- \[A\]/);
  assert.deepEqual([...listedMrs(next)].sort(), ['x/y!1', 'x/y!2']);
  assert.match(insertSection('# Changelog\n', '## 1.0.0 (2026-11-10)\n'), /^# Changelog\n\n## 1\.0\.0/);
});

test('versions compare by number and bump by part', () => {
  assert.ok(compareVersions('1.10.0', '1.9.9') > 0);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.ok(compareVersions('0.9.0', null) > 0);
  assert.deepEqual(['patch', 'minor', 'major'].map((p) => bump('1.4.2', p)), ['1.4.3', '1.5.0', '2.0.0']);
  assert.throws(() => bump('1.4', 'patch'), /not a version/);
  assert.throws(() => bump('1.4.2', 'huge'), /not patch, minor or major/);
});

test('the lines since a version are every group of every newer section up to this one', () => {
  const sections = [
    { version: '1.2.0', groups: { New: ['c'], Changed: ['x'] } },
    { version: '1.1.0', groups: { New: ['b'], Fixed: ['f'], Extra: ['e'] } },
    { version: '1.0.0', groups: { New: ['a'] } },
  ];
  assert.deepEqual(linesSince(sections, '1.0.0', '1.1.0'), { New: ['b'], Fixed: ['f'], Changed: [], 'Look and feel': [], Extra: ['e'] });
  assert.deepEqual(linesSince(sections, null, '1.2.0').New, ['c', 'b', 'a']);
  assert.deepEqual(Object.values(linesSince(sections, '1.2.0', '1.2.0')).flat(), []);
});

const UNDERLINGS = 'TheNightProject/underlings';
const GITHUB = parseRemote(`https://github.com/${UNDERLINGS}.git`);
const pulled = (n) => `https://github.com/${UNDERLINGS}/pull/${n}`;

test('a GitHub merge commit is filed by the title on its next line, linked to its pull request on origin', () => {
  const entry = entryOf({ message: 'Merge pull request #12 from someone/feat-qa\n\n✨ Add a QA view\n\nWhat it does.' }, GITHUB);
  assert.deepEqual([entry.title, entry.group], ['Add a QA view', 'New']);
  assert.deepEqual(entry.mr, { project: UNDERLINGS, iid: 12, ref: `${UNDERLINGS}#12`, url: pulled(12) });
});

test('a GitHub squash commit is read from its title, without the number GitHub adds, and linked the same way', () => {
  const { groups, leftOut } = draft([
    { message: '🐛 Stop the [loop] (#13)\n\n* fix it\n* test it' },
    { message: '📝 Say how to update (#14)' },
    { message: '♻️ Rework the rail' },
  ], GITHUB);
  assert.deepEqual(groupLines({ groups }), { New: [], Fixed: [`[Stop the (loop)](${pulled(13)})`], Changed: ['Rework the rail'], 'Look and feel': [] });
  assert.deepEqual(leftOut.map((e) => [e.title, e.mr.url]), [['Say how to update', pulled(14)]]);
});

test('GitLab merge commits read exactly as before, linked on the GitLab host origin names, or gitlab.com when origin is not GitLab', () => {
  const message = merged('feat/qa', '✨ Add a QA view', 17).message;
  const before = entryOf({ message });
  assert.deepEqual(entryOf({ message }, parseRemote(`https://gitlab.com/${CC}.git`)), before);
  assert.deepEqual(entryOf({ message }, parseRemote(`git@gitlab.com:${CC}.git`)), before);
  assert.equal(entryOf({ message }, GITHUB).mr.url, `https://gitlab.com/${CC}/-/merge_requests/17`);
  assert.equal(entryOf({ message }, parseRemote(`git@gitlab.example.com:${CC}.git`)).mr.url, `https://gitlab.example.com/${CC}/-/merge_requests/17`);
  for (const remote of [null, parseRemote(`https://gitlab.com/${CC}.git`)]) {
    const odd = entryOf({ message: 'Merge pull request #3 from a/b\n\n✨ Elsewhere' }, remote);
    assert.deepEqual([odd.title, odd.mr, entryOf({ message: '🐛 Fix it (#4)' }, remote).title], ['Merge pull request #3 from a/b', null, 'Fix it (#4)']);
  }
});

test('origin\'s web address comes from its https or ssh URL, without any credentials in it', () => {
  const web = (url) => { const r = parseRemote(url); return r && [r.web, r.path, r.github]; };
  assert.deepEqual(web(`https://github.com/${UNDERLINGS}.git`), ['https://github.com', UNDERLINGS, true]);
  assert.deepEqual(web(`https://github.com/${UNDERLINGS}/`), ['https://github.com', UNDERLINGS, true]);
  assert.deepEqual(web(`git@github.com:${UNDERLINGS}.git`), ['https://github.com', UNDERLINGS, true]);
  assert.deepEqual(web(`ssh://git@github.com/${UNDERLINGS}.git`), ['https://github.com', UNDERLINGS, true]);
  assert.deepEqual(web(`https://gitlab.com/${CC}.git`), ['https://gitlab.com', CC, false]);
  assert.deepEqual(web('ssh://git@gitlab.example.com:2222/team/tools/cc.git'), ['https://gitlab.example.com', 'team/tools/cc', false]);
  assert.deepEqual(web('https://frank:gl-fake-secret@gitlab.example.com:8443/team/cc.git'), ['https://gitlab.example.com:8443', 'team/cc', false]);
  assert.deepEqual(web('http://gitlab.local/team/cc'), ['http://gitlab.local', 'team/cc', false]);
  assert.deepEqual([web('/Users/frank/origin.git'), web('file:///tmp/origin.git'), web('')], [null, null, null]);
});

test('a changelog lists the pull requests and merge requests it already links, on any GitLab host', () => {
  const text = `- [A](${pulled(3)})\n- [B](https://gitlab.example.com/team/cc/-/merge_requests/4)\n- [C](https://gitlab.com/${CC}/-/merge_requests/5)`;
  assert.deepEqual([...listedMrs(text)].sort(), [`${UNDERLINGS}#3`, `${CC}!5`, 'team/cc!4']);
});
