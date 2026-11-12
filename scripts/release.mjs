import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bump, draft, entryOf, insertSection, listedMrs, LOG_FORMAT, parseLog, parseRemote, renderSection } from '../lib/changelog.mjs';
import { dayIn, machineZone } from '../lib/clock.mjs';
import { APP_NAME } from '../lib/product.mjs';
import { setVersion } from './stamp.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const INTRO = `# Changelog\n\nWhat changed in each version of ${APP_NAME}, newest first. Each line is a merged change: \`npm run release\` drafts the next section from the ones merged since the last release.\n`;

export function release({ root = ROOT, part = 'patch', today = localDay() } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const dirty = git('status', '--porcelain').trim();
  if (dirty) throw new Error(`the checkout has changes, so nothing was written:\n${dirty}`);
  const tag = lastTag(git);
  const file = join(root, 'CHANGELOG.md');
  const changelog = existsSync(file) ? readFileSync(file, 'utf8') : INTRO;
  const listed = listedMrs(changelog);
  const remote = parseRemote(originUrl(git));
  const commits = parseLog(git('log', '--first-parent', '--merges', `--format=${LOG_FORMAT}`, tag ? `${tag}..HEAD` : 'HEAD'));
  const drafted = draft(commits.filter((c) => !listed.has(entryOf(c, remote).mr?.ref)), remote);
  const shown = Object.values(drafted.groups).flat();
  if (!shown.length && !drafted.leftOut.length) throw new Error(`nothing has merged since ${tag ?? 'the last section in CHANGELOG.md'}, so there is nothing to release`);
  const current = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const version = bump(current, part);
  writeFileSync(file, insertSection(changelog, renderSection({ version, date: today, groups: drafted.groups })));
  setVersion(root, version);
  return { version, tag, shown: shown.length, leftOut: drafted.leftOut.length, guessed: drafted.guessed.map((e) => e.title) };
}

function lastTag(git) {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*').trim();
  } catch {
    return null;
  }
}

function originUrl(git) {
  try {
    return git('config', '--get', 'remote.origin.url').trim();
  } catch {
    return null;
  }
}

function localDay() {
  return dayIn(Date.now(), machineZone());
}

function report({ version, tag, shown, leftOut, guessed }) {
  const since = tag ? `since ${tag}` : 'not yet in CHANGELOG.md';
  return [
    `Drafted ${version} in CHANGELOG.md from ${shown} merge request${shown === 1 ? '' : 's'} ${since}${leftOut ? `, leaving out ${leftOut} that only touched tests, docs or tidying` : ''}.`,
    ...(guessed.length ? [`These had no GitMoji it knows, so they went under Changed: ${guessed.join('; ')}.`] : []),
    'Read it over and edit it, then:',
    '',
    `  git switch -c release/${version}`,
    `  git commit -am "🔖 Release ${version}"`,
    `  git push -u origin release/${version}`,
    '',
    'Once that MR has merged, tag what landed on main:',
    '',
    '  git switch main && git pull --ff-only',
    `  git tag -a v${version} -m "${version}" && git push origin v${version}`,
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(report(release({ part: process.argv[2] ?? 'patch' })));
  } catch (err) {
    console.error(`npm run release: ${err.message}`);
    process.exit(1);
  }
}
