import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { release } from './release.mjs';
import { stamp } from './stamp.mjs';

const dir = await mkdtemp(join(tmpdir(), 'control-centre-release-'));
const repo = join(dir, 'repo');
const CC = 'acme/tooling/dashboard';
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const PLUGIN = 'plugin/underlings/.claude-plugin/plugin.json';
const LOCK = { name: 'control-centre-desktop', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'control-centre-desktop', version: '1.0.0', devDependencies: { electron: '44.9.3' } } } };
after(() => rm(dir, { recursive: true }));

const git = (...args) => execFileSync('git', args, { cwd: repo, env: ENV, encoding: 'utf8' }).trim();
const read = (file) => readFile(join(repo, file), 'utf8');

async function merge(branch, title, iid) {
  git('switch', '-q', '-c', branch);
  await writeFile(join(repo, branch.replace('/', '-')), branch);
  git('add', '.');
  git('commit', '-q', '-m', `${title} on the branch`);
  git('switch', '-q', 'main');
  git('merge', '-q', '--no-ff', branch, '-m', `Merge branch '${branch}' into 'main'\n\n${title}\n\nSee merge request ${CC}!${iid}`);
}

async function pull(branch, title, number) {
  git('switch', '-q', '-c', branch);
  await writeFile(join(repo, branch.replace('/', '-')), branch);
  git('add', '.');
  git('commit', '-q', '-m', `${title} on the branch`);
  git('switch', '-q', 'main');
  git('merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${number} from someone/${branch}\n\n${title}`);
}

beforeEach(async () => {
  await rm(repo, { recursive: true, force: true });
  await mkdir(join(repo, 'desktop'), { recursive: true });
  await mkdir(join(repo, 'plugin/underlings/.claude-plugin'), { recursive: true });
  git('init', '-q', '-b', 'main');
  await writeFile(join(repo, 'package.json'), '{\n  "name": "control-centre",\n  "version": "1.0.0",\n  "private": true\n}\n');
  await writeFile(join(repo, 'desktop/package.json'), '{\n  "name": "control-centre-desktop",\n  "version": "1.0.0",\n  "build": { "directories": { "output": "dist.noindex" } }\n}\n');
  await writeFile(join(repo, 'desktop/package-lock.json'), JSON.stringify(LOCK, null, 2) + '\n');
  await writeFile(join(repo, PLUGIN), '{\n  "name": "underlings",\n  "version": "1.0.0",\n  "license": "MIT"\n}\n');
  await writeFile(join(repo, 'CHANGELOG.md'), `# Changelog\n\nIntro.\n\n## 1.0.0 (2026-11-10)\n\n### New\n\n- [Listed already](https://gitlab.com/${CC}/-/merge_requests/1)\n`);
  await writeFile(join(repo, '.gitignore'), 'build.json\n');
  git('add', '.');
  git('commit', '-q', '-m', 'Start');
  await merge('feat/one', '✨ Listed already', 1);
});

test('a release drafts the merges since the last tag above the newest section and bumps every version in step', async () => {
  await merge('feat/before', '✨ Shipped before the tag', 5);
  git('tag', 'v1.0.0');
  await merge('fix/loop', '🐛 Stop the loop', 2);
  await merge('docs/readme', '📝 Say how to release', 3);
  await merge('feat/notes', '✨ Show release notes', 4);
  const out = release({ root: repo, today: '2026-11-12' });
  assert.deepEqual(out, { version: '1.0.1', tag: 'v1.0.0', shown: 2, leftOut: 1, guessed: [] });
  const changelog = await read('CHANGELOG.md');
  assert.equal(changelog.slice(0, changelog.indexOf('## 1.0.0')), `# Changelog\n\nIntro.\n\n## 1.0.1 (2026-11-12)\n\n### New\n\n- [Show release notes](https://gitlab.com/${CC}/-/merge_requests/4)\n\n### Fixed\n\n- [Stop the loop](https://gitlab.com/${CC}/-/merge_requests/2)\n\n`);
  assert.match(await read('package.json'), /"version": "1\.0\.1"/);
  assert.match(await read('desktop/package.json'), /"version": "1\.0\.1",\n  "build": \{ "directories": \{ "output": "dist\.noindex" \} \}/, 'only the version line moves');
  const lock = JSON.parse(await read('desktop/package-lock.json'));
  assert.deepEqual([lock.version, lock.packages[''].version], ['1.0.1', '1.0.1']);
  assert.equal(await read(PLUGIN), '{\n  "name": "underlings",\n  "version": "1.0.1",\n  "license": "MIT"\n}\n', 'the skills carry the app\'s version, so an installed copy can be told from the new one');
  assert.equal(git('tag'), 'v1.0.0', 'it never tags');
  assert.equal(git('log', '-1', '--format=%s'), "Merge branch 'feat/notes' into 'main'", 'and never commits');
});

test('minor and major bump their part, and with no tag yet only what the changelog does not list is drafted', async () => {
  await merge('feat/two', '✨ Second thing', 2);
  assert.deepEqual(release({ root: repo, part: 'minor', today: '2026-11-12' }), { version: '1.1.0', tag: null, shown: 1, leftOut: 0, guessed: [] });
  assert.doesNotMatch((await read('CHANGELOG.md')).split('## 1.0.0')[0], /Listed already/);
  git('commit', '-q', '-am', 'Release');
  await merge('feat/three', '🦄 Third thing', 3);
  assert.deepEqual(release({ root: repo, part: 'major', today: '2026-11-13' }), { version: '2.0.0', tag: null, shown: 1, leftOut: 0, guessed: ['Third thing'] });
});

test('with origin on GitHub the draft links each pull request there and leaves out the ones the changelog lists', async () => {
  const underlings = 'https://github.com/TheNightProject/underlings/pull';
  git('remote', 'add', 'origin', 'git@github.com:TheNightProject/underlings.git');
  await writeFile(join(repo, 'CHANGELOG.md'), `${await read('CHANGELOG.md')}- [Listed on GitHub](${underlings}/7)\n`);
  git('commit', '-q', '-am', 'List it');
  await pull('feat/listed', '✨ Listed on GitHub', 7);
  await pull('fix/loop', '🐛 Stop the loop', 8);
  assert.deepEqual(release({ root: repo, today: '2026-11-12' }), { version: '1.0.1', tag: null, shown: 1, leftOut: 0, guessed: [] });
  const changelog = await read('CHANGELOG.md');
  assert.equal(changelog.slice(0, changelog.indexOf('## 1.0.0')), `# Changelog\n\nIntro.\n\n## 1.0.1 (2026-11-12)\n\n### Fixed\n\n- [Stop the loop](${underlings}/8)\n\n`);
});

test('it refuses a dirty checkout, an unknown part, and a release with nothing in it, and writes nothing', async () => {
  await writeFile(join(repo, 'package.json'), '{ "version": "9.9.9" }\n');
  assert.throws(() => release({ root: repo }), /the checkout has changes, so nothing was written/);
  git('checkout', '--', 'package.json');
  assert.throws(() => release({ root: repo }), /nothing has merged since the last section in CHANGELOG\.md/);
  await merge('feat/two', '✨ Second thing', 2);
  assert.throws(() => release({ root: repo, part: 'huge' }), /huge is not patch, minor or major/);
  assert.equal(git('status', '--porcelain'), '');
});

test('the build stamp records the version, commit and checkout for the app and the plugin, and keeps the app\'s version in step', async () => {
  await writeFile(join(repo, 'package.json'), '{\n  "name": "control-centre",\n  "version": "1.2.0"\n}\n');
  const made = stamp(repo, new Date('2026-11-12T09:00:00Z'));
  assert.deepEqual(made, { version: '1.2.0', commit: git('rev-parse', 'HEAD'), builtAt: '2026-11-12T09:00:00.000Z', repo });
  assert.deepEqual(JSON.parse(await read('build.json')), made);
  assert.match(await read('desktop/package.json'), /"version": "1\.2\.0"/);
  assert.equal(JSON.parse(await read('desktop/package-lock.json')).packages[''].version, '1.2.0');
  assert.equal(JSON.parse(await read(PLUGIN)).version, '1.2.0');
});

test('a release build names no checkout, as the Mac it runs on has none', async () => {
  await writeFile(join(repo, 'package.json'), '{\n  "name": "control-centre",\n  "version": "1.2.0"\n}\n');
  const made = stamp(repo, new Date('2026-11-12T09:00:00Z'), true);
  assert.deepEqual(made, { version: '1.2.0', commit: git('rev-parse', 'HEAD'), builtAt: '2026-11-12T09:00:00.000Z', repo: null, release: true });
  assert.deepEqual(JSON.parse(await read('build.json')), made);
});
