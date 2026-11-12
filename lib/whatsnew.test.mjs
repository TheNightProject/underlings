import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { parseChangelog } from './changelog.mjs';

const home = await mkdtemp(join(tmpdir(), 'control-centre-whatsnew-'));
process.env.HOME = home;
const root = join(home, 'root');
const stateDir = join(home, 'state');
const whatsnew = await import('./whatsnew.mjs');
after(() => rm(home, { recursive: true }));

const REPO = new URL('../', import.meta.url);
const CHANGELOG = `# Changelog

What changed.

## 1.1.0 (2026-11-12)

### New

- [Alpha](https://gitlab.com/x/y/-/merge_requests/3)
- Beta

### Fixed

- Fix

### Changed

- Changed

## 1.0.0 (2026-11-10)

### New

- Old
`;

const get = () => whatsnew.ROUTES['GET /api/whatsnew']();
const seen = () => whatsnew.ROUTES['POST /api/whatsnew/seen']();
const state = (name, value) => writeFile(join(stateDir, name), JSON.stringify(value));
const banner = async () => (await whatsnew.summary()).banner;

async function build({ version = '1.1.0', commit = 'c'.repeat(40), changelog = CHANGELOG } = {}) {
  await writeFile(join(root, 'package.json'), JSON.stringify({ version }));
  await writeFile(join(root, 'build.json'), JSON.stringify({ version, commit, builtAt: '2026-11-12T09:00:00Z' }));
  if (changelog !== null) await writeFile(join(root, 'CHANGELOG.md'), changelog);
  else await rm(join(root, 'CHANGELOG.md'), { force: true });
}

beforeEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(root, { recursive: true });
  whatsnew.start({ stateDir, buildRoot: root });
  await build();
});

test('the view says which version and build is running and hands over each section of the changelog to render', async () => {
  const view = await get();
  assert.deepEqual([view.version, view.commit, view.builtAt], ['1.1.0', 'c'.repeat(40), '2026-11-12T09:00:00Z']);
  assert.equal(view.changelog.intro, '# Changelog\n\nWhat changed.');
  assert.deepEqual(view.changelog.sections.map((s) => [s.version, s.date]), [['1.1.0', '2026-11-12'], ['1.0.0', '2026-11-10']]);
  assert.match(view.changelog.sections[0].body, /^### New\n\n- \[Alpha\]/);
  assert.equal(view.updates.channel, 'main');
  await build({ changelog: null });
  assert.equal((await get()).changelog, null);
});

test('a version newer than the one last seen brings a banner of its New and Fixed lines, and the rest is counted', async () => {
  await state('release-seen.json', { version: '1.0.0' });
  assert.deepEqual(await banner(), { kind: 'updated', version: '1.1.0', commit: null, groups: { New: ['[Alpha](https://gitlab.com/x/y/-/merge_requests/3)', 'Beta'], Fixed: ['Fix'] }, more: 1 });
  await state('release-seen.json', { version: '1.1.0' });
  assert.equal(await banner(), null);
});

test('a viewer who has seen nothing yet is shown every version up to this one, eight lines at most', async () => {
  assert.deepEqual((await banner()).groups, { New: ['[Alpha](https://gitlab.com/x/y/-/merge_requests/3)', 'Beta', 'Old'], Fixed: ['Fix'] });
  const long = `## 2.0.0 (2026-12-01)\n\n### New\n\n${Array.from({ length: 10 }, (_, i) => `- N${i}`).join('\n')}\n\n### Fixed\n\n- F\n`;
  await build({ version: '2.0.0', changelog: long });
  const b = await banner();
  assert.equal(b.groups.New.length, 8);
  assert.deepEqual(b.groups.Fixed, []);
  assert.equal(b.more, 3);
});

test('Dismiss keeps the version and build as seen in the state folder, so the banner does not come back', async () => {
  await state('update.json', { to: 'c'.repeat(40), phase: 'done', lines: { New: ['x'] } });
  assert.equal((await seen()).ok, true);
  const kept = JSON.parse(await readFile(join(stateDir, 'release-seen.json'), 'utf8'));
  assert.deepEqual([kept.version, kept.commit], ['1.1.0', 'c'.repeat(40)]);
  assert.equal(await banner(), null);
  await assert.rejects(readFile(join(stateDir, 'update.json')), { code: 'ENOENT' });
});

test('after an update the banner lists what that update brought in and names the build, even with the version unchanged', async () => {
  await state('release-seen.json', { version: '1.1.0' });
  await state('update.json', { from: 'b'.repeat(40), to: 'c'.repeat(40), phase: 'installing', lines: { New: ['Came in'], Fixed: [], Changed: ['Moved'] } });
  assert.deepEqual(await banner(), { kind: 'updated', version: '1.1.0', commit: 'c'.repeat(40), groups: { New: ['Came in'], Fixed: [] }, more: 1 });
});

test('an install that did not land says why, and that the old version is still the one running', async () => {
  await state('release-seen.json', { version: '1.1.0' });
  await build({ commit: 'b'.repeat(40) });
  await state('update.json', { from: 'b'.repeat(40), to: 'c'.repeat(40), phase: 'installing', lines: {} });
  assert.deepEqual(await banner(), { kind: 'failed', version: '1.1.0', commit: 'b'.repeat(40), wanted: 'c'.repeat(40), error: 'the install did not finish' });
  await state('update-install.json', { phase: 'done', ok: false, error: 'the app was still running after 120 s, so nothing was installed' });
  assert.match((await banner()).error, /still running after 120 s/);
  await seen();
  assert.equal(await banner(), null);
});

test('an update overtaken by a later build is not reported as failed, since that build is what is running', async () => {
  await state('release-seen.json', { version: '1.1.0' });
  await build({ commit: 'd'.repeat(40) });
  await state('update.json', { from: 'b'.repeat(40), to: 'c'.repeat(40), phase: 'installing', lines: {}, at: '2026-11-10T14:03:16Z' });
  assert.equal(await banner(), null);
  await state('update.json', { from: 'b'.repeat(40), to: 'c'.repeat(40), phase: 'installing', lines: {}, at: '2026-11-12T10:00:00Z' });
  assert.equal((await banner()).kind, 'failed', 'one asked for after this build was made still says it did not land');
});

test('the changelog that ships starts at 1.0.0, has a line for each change, and names no ticket or internal link', async () => {
  const text = await readFile(new URL('CHANGELOG.md', REPO), 'utf8');
  const { sections } = parseChangelog(text);
  assert.equal(sections.at(-1).version, '1.0.0');
  const lines = sections.flatMap((s) => Object.values(s.groups).flat());
  assert.ok(lines.length >= 26);
  for (const line of lines) assert.doesNotMatch(line, /https?:\/\//, line);
  assert.doesNotMatch(text, /\b[A-Z][A-Z0-9]+-\d+\b|\u2014/);
  const versions = await Promise.all(['package.json', 'desktop/package.json', 'desktop/package-lock.json'].map(async (f) => JSON.parse(await readFile(new URL(f, REPO), 'utf8'))));
  assert.deepEqual([...versions.map((v) => v.version), versions[2].packages[''].version], Array(4).fill(sections[0].version));
});
