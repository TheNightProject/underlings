import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { compareVersions, draft, groupLines, isVersion } from './changelog.mjs';

const home = await realpath(await mkdtemp(join(tmpdir(), 'control-centre-selfupdate-')));
const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
Object.assign(process.env, {
  HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file:ssh:http',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
});
for (const name of ['GITLAB_TOKEN', 'GIT_SSH_COMMAND', 'GIT_SSH', 'FAKE_SSH']) delete process.env[name];
const origin = join(home, 'origin.git');
const dev = join(home, 'dev');
const root = join(home, 'checkout');
const stateDir = join(home, 'state');
const bin = join(home, 'bin');
const tools = join(home, 'tools.json');
const calls = join(home, 'calls.log');
const sshCalls = join(home, 'ssh.log');
const CC = 'acme/tooling/dashboard';
const GITLAB_ORIGIN = `https://gitlab.com/${CC}.git`;
const UNDERLINGS = 'TheNightProject/underlings';
const mr = (iid) => `https://gitlab.com/${CC}/-/merge_requests/${iid}`;
const pr = (n) => `https://github.com/${UNDERLINGS}/pull/${n}`;
let FROM = null;
let TO = null;
let published = [];

// git is the real one behind a script that writes down each call; npm is a fake steered by tools.json.
const GIT = `#!/bin/sh
dir=$(pwd -P)
[ "$1" = -C ] && dir=$(cd "$2" 2>/dev/null && pwd -P || printf %s "$2")
{ printf git; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\037%s\\n' "$dir"; } >> ${calls}
exec ${REAL_GIT} "$@"
`;
const NPM = `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, ['npm', ...args, fs.realpathSync(process.cwd())].join('\\x1f') + '\\n');
process.stdout.write('> ' + args.join(' ') + '\\nadded 99 packages\\n');
process.stderr.write('npm notice from stderr\\n');
process.exit(JSON.parse(fs.readFileSync(${JSON.stringify(tools)}, 'utf8')).npmFails === args.join(' ') ? 1 : 0);
`;
// ssh serves the scratch origin, or fails as a private remote or a lost network does.
const SSH = `#!/bin/sh
{ printf %s "$*"; printf '\\037%s\\n' "$GIT_TERMINAL_PROMPT"; } >> ${sshCalls}
case "$FAKE_SSH" in
  auth) echo 'git@github.com: Permission denied (publickey).' >&2; exit 255;;
  offline) echo 'ssh: Could not resolve hostname github.com: nodename nor servname provided, or not known' >&2; exit 255;;
esac
exec ${REAL_GIT} upload-pack ${origin}
`;

const helped = [];
let helperFails = null;
mock.module(new URL('./apphelper.mjs', import.meta.url).href, {
  namedExports: {
    async startHelper(job, logFile) {
      helped.push({ job, logFile });
      if (helperFails) throw new Error(helperFails);
    },
  },
});

await mkdir(bin, { recursive: true });
for (const [name, script] of [['git', GIT], ['npm', NPM], ['ssh', SSH]]) {
  await writeFile(join(bin, name), script);
  await chmod(join(bin, name), 0o755);
}
process.env.PATH = bin + delimiter + process.env.PATH;
let asked = 0;
globalThis.fetch = async () => {
  asked += 1;
  throw new Error('a check must not ask any API');
};
const selfupdate = await import('./selfupdate.mjs');
after(() => rm(home, { recursive: true }));

const sh = (cwd, ...args) => execFileSync(REAL_GIT, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ran = async () => (await readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => {
  const [tool, ...rest] = line.split('\x1f');
  const dir = rest.pop();
  return [tool, ...(rest[0] === '-C' ? rest.slice(2) : rest), dir];
});
const READS = ['rev-parse', 'symbolic-ref', 'status', 'log', 'diff', 'config', 'cat-file', 'tag'];
const checking = ([tool, verb, flag]) => tool === 'git' && (READS.includes(verb) || (verb === 'fetch' && flag === '--no-tags'));
const fetches = async () => (await ran()).filter(([tool, verb]) => tool === 'git' && verb === 'fetch').map((c) => c.slice(0, -1).join(' '));
const runs = async () => (await ran()).filter((call) => !checking(call)).map((c) => c.slice(0, -1).join(' '));
const ssh = async () => (await readFile(sshCalls, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => line.split('\x1f'));
const route = (name, body) => selfupdate.ROUTES[name]({ body: async () => body });
let quits = 0;

const setTools = (changes = {}) => writeFile(tools, JSON.stringify(changes));

async function commitFile(dir, file, text, message) {
  await mkdir(dirname(join(dir, file)), { recursive: true });
  await writeFile(join(dir, file), text);
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', message);
  return sh(dir, 'rev-parse', 'HEAD');
}

function publish(message) {
  sh(dev, 'push', '-q', 'origin', 'main');
  const sha = sh(dev, 'rev-parse', 'HEAD');
  published.unshift({ id: sha, title: message.split('\n')[0], message: `${message}\n`, committed_date: sh(dev, 'log', '-1', '--format=%cI') });
  return sha;
}

async function merged(branch, message, file = branch) {
  sh(dev, 'switch', '-q', '-c', branch);
  await commitFile(dev, file, branch, `Work on ${branch}`);
  sh(dev, 'switch', '-q', 'main');
  sh(dev, 'merge', '-q', '--no-ff', branch, '-m', message);
  return publish(message);
}

const mergeRequest = (title, iid, file) => merged(`b${iid}`, `Merge branch 'b${iid}' into 'main'\n\n${title}\n\nSee merge request ${CC}!${iid}`, file);
const pullRequest = (title, n) => merged(`p${n}`, `Merge pull request #${n} from someone/p${n}\n\n${title}`);

async function squashed(title, n) {
  const message = `${title} (#${n})\n\n* the branch's own commits`;
  await commitFile(dev, `s${n}`, title, message);
  return publish(message);
}

async function pushed(title, file = title) {
  await commitFile(dev, file, title, title);
  return publish(title);
}

function tag(name, sha, annotated = false) {
  sh(dev, 'tag', ...(annotated ? ['-a', '-m', name] : []), name, sha);
  sh(dev, 'push', '-q', 'origin', name);
}

async function scratch() {
  for (const dir of [origin, dev, root]) await rm(dir, { recursive: true, force: true });
  published = [];
  sh(home, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(home, 'clone', '-q', origin, dev);
  await writeFile(join(dev, '.gitignore'), 'build.json\n');
  await writeFile(join(dev, 'package.json'), JSON.stringify({ version: '1.1.0' }));
  await writeFile(join(dev, 'worker.mjs'), '');
  FROM = await commitFile(dev, 'lib/app.mjs', '', 'Start');
  sh(dev, 'push', '-q', '-u', 'origin', 'main');
  sh(home, 'clone', '-q', origin, root);
  sh(root, 'remote', 'set-url', 'origin', GITLAB_ORIGIN);
  sh(root, 'config', `url.${origin}.insteadOf`, GITLAB_ORIGIN);
  sh(root, 'config', `url.${origin}.insteadOf`, `https://github.com/${UNDERLINGS}.git`, '--add');
}

async function boot({ desktop = null, appPath, commit = FROM, channel, version = '1.1.0', repoPath = root, buildRoot = root } = {}) {
  selfupdate.stop();
  await rm(stateDir, { recursive: true, force: true });
  await rm(calls, { force: true });
  await rm(sshCalls, { force: true });
  await rm(join(home, '.config'), { recursive: true, force: true });
  if (channel) await mkdir(join(home, '.config/underlings'), { recursive: true }).then(() => writeFile(join(home, '.config/underlings/updates.json'), JSON.stringify({ channel })));
  await writeFile(join(buildRoot, 'build.json'), JSON.stringify({ version, commit }));
  await selfupdate.start({ stateDir, buildRoot, repoPath, appPath }, { notify() {}, desktop, carried: null });
}

const finished = async () => {
  await selfupdate.settled();
  return selfupdate.status();
};

beforeEach(async () => {
  helped.length = 0;
  helperFails = null;
  quits = 0;
  asked = 0;
  delete process.env.FAKE_SSH;
  await setTools();
  await scratch();
  await mergeRequest('✅ Test it', 19);
  await mergeRequest('🐛 Stop the loop', 20);
  TO = await mergeRequest('✨ Add the thing', 21);
  await boot();
});

after(() => selfupdate.stop());

test('starting runs no git; a check fetches origin\'s main and counts what landed since this build, drafted as the release notes are', async () => {
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await ran(), []);
  await selfupdate.check();
  const s = selfupdate.status();
  assert.deepEqual([s.channel, s.count, s.leftOut, s.error, s.target], ['main', 3, 1, null, { ref: 'main', sha: TO }]);
  assert.deepEqual(s.lines.New, [`[Add the thing](${mr(21)})`]);
  assert.deepEqual(s.lines.Fixed, [`[Stop the loop](${mr(20)})`]);
  assert.deepEqual(selfupdate.brief(), { channel: 'main', count: 3, checkedAt: s.checkedAt, checking: false, error: null, running: false, outcome: null });
  assert.deepEqual([await runs(), await fetches()], [[], ['git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main']], 'a check only fetches');
  assert.deepEqual([sh(root, 'rev-parse', 'HEAD'), sh(root, 'status', '--porcelain'), asked], [FROM, '', 0], 'and changes nothing in the checkout, with no token and no API');
  assert.deepEqual((await route('POST /api/updates/check')).text, 'Checking origin for updates');
});

test('on the releases channel only a newer v tag on origin counts, peeled to its commit, and what came in is read up to it', async () => {
  tag('v1.0.9', FROM);
  tag('v1.1.5', published[1].id);
  tag('v1.2.0', TO, true);
  tag('vnext', TO);
  await route('POST /api/updates/channel', { channel: 'releases' });
  await selfupdate.check();
  const s = selfupdate.status();
  assert.deepEqual([s.channel, s.count, s.target], ['releases', 3, { ref: 'v1.2.0', version: '1.2.0', sha: TO }]);
  assert.deepEqual(await fetches(), ['git fetch --no-tags origin refs/tags/v*:refs/tags/v*']);
  assert.equal(JSON.parse(await readFile(join(home, '.config/underlings/updates.json'), 'utf8')).channel, 'releases');
  await scratch();
  tag('v1.1.0', FROM);
  await boot({ channel: 'releases' });
  await selfupdate.check();
  assert.deepEqual([selfupdate.status().count, selfupdate.status().target, selfupdate.status().error], [0, null, null]);
  await assert.rejects(route('POST /api/updates/channel', { channel: 'nightly' }), { status: 400 });
});

test('a check says why it could not look: no commit recorded, a commit not in the checkout, no checkout, or no origin', async () => {
  for (const [arrange, said] of [
    [() => boot({ commit: null }), /does not know its commit/],
    [() => boot({ commit: 'f'.repeat(40) }), new RegExp(`^this build came from a commit that is not in your checkout: ffffffff is not in ${root}$`)],
    [() => mkdir(join(home, 'plain'), { recursive: true }).then(() => boot({ repoPath: join(home, 'plain') })), /plain is not a git checkout, so there is nothing to check/],
    [() => boot().then(() => sh(root, 'remote', 'remove', 'origin')), /has no origin remote, so there is nowhere to check for updates/],
  ]) {
    await arrange();
    await selfupdate.check();
    assert.match(selfupdate.status().error, said);
  }
});

test('a build from a commit that was never pushed still counts what origin has that it lacks', async () => {
  const local = await commitFile(root, 'notes.md', 'mine', '📝 A note of my own');
  await boot({ commit: local });
  await selfupdate.check();
  assert.deepEqual([selfupdate.status().error, selfupdate.status().count], [null, 3]);
});

test('a checkout whose main tracks nothing is still checked against origin\'s main', async () => {
  sh(root, 'branch', '--unset-upstream');
  await selfupdate.check();
  assert.deepEqual([selfupdate.status().count, selfupdate.status().target], [3, { ref: 'main', sha: TO }]);
});

test('a remote that wants signing in fails at once with how to sign git in, over ssh or https, and never asks for a password', async () => {
  sh(root, 'remote', 'set-url', 'origin', `git@github.com:${UNDERLINGS}.git`);
  process.env.FAKE_SSH = 'auth';
  await selfupdate.check();
  assert.equal(selfupdate.status().error, 'git could not sign in to origin. While the repo is private, sign git in (gh auth setup-git or an SSH key).');
  const [[args, prompt]] = await ssh();
  assert.match(args, /^-o BatchMode=yes .*git@github\.com git-upload-pack 'TheNightProject\/underlings\.git'$/);
  assert.equal(prompt, '0');
  await route('POST /api/updates/apply');
  assert.equal((await finished()).job.outcome.step, 'git pull --ff-only');
  assert.deepEqual((await ssh()).map(([line, said]) => [line.startsWith('-o BatchMode=yes '), said]), [[true, '0'], [true, '0']], 'nor does Update now');
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.authorization ?? null);
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="private"' }).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    sh(root, 'remote', 'set-url', 'origin', `http://127.0.0.1:${server.address().port}/team/cc.git`);
    await selfupdate.check();
  } finally {
    server.close();
  }
  assert.equal(selfupdate.status().error, 'git could not sign in to origin. While the repo is private, sign git in (a credential helper or an SSH key).');
  assert.deepEqual(seen, [null]);
});

test('an ssh command of your own is used as it is', async () => {
  sh(root, 'remote', 'set-url', 'origin', `git@github.com:${UNDERLINGS}.git`);
  process.env.GIT_SSH_COMMAND = 'ssh -o Mine=yes';
  try {
    await selfupdate.check();
  } finally {
    delete process.env.GIT_SSH_COMMAND;
  }
  sh(root, 'config', 'core.sshCommand', 'ssh -o Theirs=yes');
  await selfupdate.check();
  assert.deepEqual((await ssh()).map(([args]) => args.split(' ').slice(0, 2).join(' ')), ['-o Mine=yes', '-o Theirs=yes']);
  assert.equal(selfupdate.status().count, 3);
});

test('offline, a check says it could not look origin up', async () => {
  sh(root, 'remote', 'set-url', 'origin', `git@github.com:${UNDERLINGS}.git`);
  process.env.FAKE_SSH = 'offline';
  await selfupdate.check();
  assert.equal(selfupdate.status().error, 'git could not look up github.com, so you seem to be offline');
});

test('a tag of your own that clashes with origin\'s is named rather than read as a release', async () => {
  tag('v1.2.0', TO, true);
  sh(root, 'tag', 'v1.2.0', FROM);
  await boot({ channel: 'releases' });
  await selfupdate.check();
  assert.equal(selfupdate.status().error, 'your tag v1.2.0 is not the one origin has, so the releases could not be read. Delete yours with git tag -d v1.2.0 and check again.');
});

test('GitHub merge and squash commits read as GitLab\'s do, linked to the pull requests on origin, over https or ssh', async () => {
  await scratch();
  await pullRequest('✨ Add the office', 12);
  await squashed('🐛 Stop the flicker', 13);
  await squashed('📝 Say how to update', 14);
  await boot();
  for (const url of [`https://github.com/${UNDERLINGS}.git`, `git@github.com:${UNDERLINGS}.git`]) {
    sh(root, 'remote', 'set-url', 'origin', url);
    await selfupdate.check();
    const s = selfupdate.status();
    assert.deepEqual([s.error, s.count, s.leftOut, s.lines], [null, 3, 1, { New: [`[Add the office](${pr(12)})`], Fixed: [`[Stop the flicker](${pr(13)})`], Changed: [], 'Look and feel': [] }], url);
  }
  await route('POST /api/updates/apply');
  assert.equal((await finished()).job.outcome.ok, true);
  assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'update.json'), 'utf8')).lines.New, [`[Add the office](${pr(12)})`], 'and so are the lines an update brings in');
});

test('GitLab merge commits link to the GitLab host origin names, over https or ssh', async () => {
  for (const [url, web] of [[GITLAB_ORIGIN, 'https://gitlab.com'], [`git@gitlab.com:${CC}.git`, 'https://gitlab.com'], [`git@gitlab.example.com:${CC}.git`, 'https://gitlab.example.com']]) {
    sh(root, 'remote', 'set-url', 'origin', url);
    await selfupdate.check();
    assert.deepEqual(selfupdate.status().lines.New, [`[Add the thing](${web}/${CC}/-/merge_requests/21)`], url);
  }
});

// The check as it was when it asked GitLab's API, kept to prove the git check answers the same for the same commits.
function throughTheApi(info, wanted, { commits, tags }) {
  const newer = tags.map((t) => ({ ref: t.name, version: t.name.slice(1), sha: t.commit?.id ?? null })).filter((t) => isVersion(t.version) && t.sha && compareVersions(t.version, info.version) > 0);
  const target = wanted === 'releases' ? newer.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null : { ref: 'main', sha: null };
  if (!target) return { count: 0, target: null, lines: null, leftOut: 0 };
  const list = commits(info.commit, target.sha ?? 'main').map((c) => ({ sha: c.id, date: c.committed_date?.slice(0, 10) ?? null, message: c.message ?? c.title ?? '' }));
  const drafted = draft(list);
  return { target: { ...target, sha: target.sha ?? list[0]?.sha ?? info.commit }, count: list.length, lines: groupLines(drafted), leftOut: drafted.leftOut.length };
}

test('an install on GitLab: the same commits read through GitLab\'s API and through git give the same lines, counts and target', async () => {
  await mergeRequest('🔖 Release 1.2.0', 50);
  tag('v1.2.0', published[0].id, true);
  await mergeRequest('✨ Show your calendar in Underlings, with Join and a banner before each meeting', 51);
  await mergeRequest('✅ Pin the office\'s screen reader test to a 42 minute wait, so it passes on the hour', 52);
  await mergeRequest('Run the agents on built-in prompts out of the box', 53);
  await pushed('🚑 Mend the build straight on main');
  await merged('groundwork', '🔀 Merge the groundwork: in-place reload');
  await mergeRequest('♻️ Rework the rail [and its keys]', 54);
  tag('v1.3.0', published[0].id);
  await mergeRequest('💄 Restyle the drawer', 55);
  await mergeRequest('🐛 Stop the loop, again', 56);
  const reachable = (...args) => new Set(sh(origin, 'rev-list', ...args).split('\n'));
  const commits = (from, to) => {
    const wanted = reachable('--first-parent', to === 'main' ? published[0].id : to);
    const had = reachable(from);
    return published.filter((c) => wanted.has(c.id) && !had.has(c.id));
  };
  const built = join(home, 'built');
  await mkdir(built, { recursive: true });
  const tags = sh(origin, 'for-each-ref', '--format=%(refname:strip=2) %(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)', 'refs/tags').split('\n').map((line) => ({ name: line.split(' ')[0], commit: { id: line.split(' ')[1] } }));
  for (const [commit, version] of [[FROM, '1.1.0'], [TO, '1.1.0'], [published[0].id, '1.3.0']]) {
    for (const wanted of ['main', 'releases']) {
      await boot({ commit, version, channel: wanted, buildRoot: built });
      await selfupdate.check();
      const { count, target, lines, leftOut, error } = selfupdate.status();
      assert.equal(error, null);
      assert.deepEqual({ count, target, lines, leftOut }, throughTheApi({ commit, version }, wanted, { commits, tags }), `${wanted} from ${version} at ${commit.slice(0, 8)}`);
    }
  }
});

test('Update now refuses a checkout that is not one, is off main, or has changes, and runs nothing that writes', async () => {
  await mkdir(join(home, 'plain'), { recursive: true });
  for (const [arrange, reason] of [
    [() => boot({ repoPath: join(home, 'plain') }), /is not a git checkout/],
    [() => boot().then(() => sh(root, 'switch', '-q', '-c', 'feat/x')), /is on feat\/x, not main, so nothing was changed/],
    [() => boot().then(() => sh(root, 'switch', '-q', '--detach', 'main')), /is not on a branch, not main/],
    [async () => {
      await boot();
      sh(root, 'switch', '-q', 'main');
      await writeFile(join(root, 'lib/app.mjs'), 'changed');
      await writeFile(join(root, 'notes.txt'), 'mine');
    }, /has uncommitted changes \(lib\/app\.mjs, notes\.txt\), so nothing was changed/],
  ]) {
    await arrange();
    await assert.rejects(route('POST /api/updates/apply'), (err) => err.status === 409 && reason.test(err.message), String(reason));
    assert.match(selfupdate.status().job.outcome.error, reason);
    assert.deepEqual(await runs(), []);
  }
});

test('in the plugin Update now pulls, sets up and builds in the checkout, streams what each says, and says to Reload', async () => {
  await selfupdate.check();
  const answer = await route('POST /api/updates/apply');
  assert.match(answer.text, /Updating from/);
  assert.equal(selfupdate.brief().running, true);
  await assert.rejects(route('POST /api/updates/apply'), { status: 409, message: /already running/ });
  const s = await finished();
  assert.deepEqual(await runs(), ['git pull --ff-only', 'npm run setup', 'npm run build']);
  assert.deepEqual([...new Set((await ran()).map((c) => c.at(-1)))], [root], 'every git and npm call is in the checkout');
  assert.deepEqual(s.job.outcome, { ok: true, to: TO, text: `Updated ${root} to ${TO.slice(0, 8)}. Press Reload to load the new code.` });
  for (const line of ['$ git pull --ff-only', 'Fast-forward', '$ npm run setup', '> run setup', 'npm notice from stderr', '$ npm run build']) assert.ok(s.job.log.includes(line), line);
  const pending = JSON.parse(await readFile(join(stateDir, 'update.json'), 'utf8'));
  assert.deepEqual([pending.from, pending.to, pending.phase, pending.lines.New], [FROM, TO, 'done', [`[Add the thing](${mr(21)})`]]);
  assert.deepEqual([helped, sh(root, 'rev-parse', 'HEAD')], [[], TO]);
});

test('a changed worker.mjs asks for the plugin to be turned off and on rather than a Reload', async () => {
  await pushed('⚡ Start the worker faster', 'worker.mjs');
  await route('POST /api/updates/apply');
  assert.match((await finished()).job.outcome.text, /The worker has changed, so in Orca, Settings, Plugins, turn Underlings off and on/);
});

test('a step that fails stops the update there, keeps its output, and leaves this version running with nothing recorded', async () => {
  await setTools({ npmFails: 'run build' });
  await route('POST /api/updates/apply');
  const s = await finished();
  assert.deepEqual(await runs(), ['git pull --ff-only', 'npm run setup', 'npm run build']);
  assert.deepEqual(s.job.outcome, { ok: false, step: 'npm run build', error: 'npm run build failed with exit code 1' });
  assert.equal(s.job.log.at(-1), 'Stopped: npm run build failed with exit code 1. This version keeps running.');
  await assert.rejects(readFile(join(stateDir, 'update.json')), { code: 'ENOENT' });
  await mergeRequest('✨ Land something else', 22);
  await commitFile(root, 'mine.md', 'mine', '📝 Something of my own');
  await route('POST /api/updates/apply');
  assert.equal((await finished()).job.outcome.step, 'git pull --ff-only');
  assert.ok(selfupdate.status().job.log.includes('fatal: Not possible to fast-forward, aborting.'));
});

test('nothing new after the pull means nothing is built', async () => {
  await scratch();
  await boot();
  await route('POST /api/updates/apply');
  assert.match((await finished()).job.outcome.text, new RegExp(`Already up to date at ${FROM.slice(0, 8)}`));
  assert.deepEqual(await runs(), ['git pull --ff-only']);
});

test('on the releases channel Update now fast-forwards main to the release tag instead of pulling', async () => {
  tag('v1.2.0', TO, true);
  await boot({ channel: 'releases' });
  await assert.rejects(route('POST /api/updates/apply'), { status: 409, message: /no newer release/ });
  await selfupdate.check();
  await route('POST /api/updates/apply');
  await finished();
  assert.deepEqual(await runs(), ['git fetch --tags origin', 'git merge --ff-only refs/tags/v1.2.0', 'npm run setup', 'npm run build']);
  assert.equal(sh(root, 'rev-parse', 'HEAD'), TO);
});

test('in the app it builds the app too, then hands the install to a helper and quits, so the helper can swap the bundle', async () => {
  const appPath = join(home, 'Applications/Underlings.app');
  await boot({ desktop: { quit: () => { quits += 1; } }, appPath });
  await route('POST /api/updates/apply');
  const s = await finished();
  assert.deepEqual(await runs(), ['git pull --ff-only', 'npm run setup', 'npm run build', 'npm --prefix desktop run pack']);
  assert.equal(s.mode, 'app');
  assert.deepEqual(helped, [{
    job: { pid: process.pid, built: join(root, 'desktop/dist.noindex/mac-arm64/Underlings.app'), bundle: appPath, result: join(stateDir, 'update-install.json'), relaunch: ['/usr/bin/open', appPath] },
    logFile: join(stateDir, 'update-install.log'),
  }]);
  assert.equal(JSON.parse(await readFile(join(stateDir, 'update.json'), 'utf8')).phase, 'installing');
  assert.equal(quits, 0, 'the page hears the outcome before the app goes');
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(quits, 1);
});

test('in the app a helper that does not start leaves the app running and nothing pending', async () => {
  helperFails = 'the install helper did not start, so this version keeps running';
  await boot({ desktop: { quit: () => { quits += 1; } }, appPath: join(home, 'Applications/Underlings.app') });
  await route('POST /api/updates/apply');
  assert.deepEqual((await finished()).job.outcome, { ok: false, step: 'npm --prefix desktop run pack', error: helperFails });
  await assert.rejects(readFile(join(stateDir, 'update.json')), { code: 'ENOENT' });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(quits, 0);
});

test('an app run from a checkout with npm start is told to start again rather than swapped', async () => {
  await boot({ desktop: { quit: () => { quits += 1; } } });
  await pushed('⚡ Start the worker faster', 'worker.mjs');
  await route('POST /api/updates/apply');
  const s = await finished();
  assert.equal(s.mode, 'dev');
  assert.match(s.job.outcome.text, /quit the app and run npm start in desktop\/ again/);
  assert.deepEqual(helped, []);
});

test('a build from a release reads the newer releases on GitHub, drafts their notes, and leaves updating to Homebrew', async () => {
  const bundle = join(home, 'Applications/Underlings.app/Contents/Resources/worker');
  await mkdir(bundle, { recursive: true });
  await writeFile(join(bundle, 'build.json'), JSON.stringify({ version: '1.1.0', commit: FROM, repo: null, release: true }));
  const page = (tag) => `https://github.com/${UNDERLINGS}/releases/tag/${tag}`;
  const release = (tag, body, extra = {}) => ({ tag_name: tag, html_url: page(tag), body, draft: false, prerelease: false, ...extra });
  const noApi = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify([
      release('v1.2.1', '### Fixed\r\n\r\n- Stop the loop\r\n'),
      release('v1.3.0', '### New\n\n- Not out yet\n', { draft: true }),
      release('v1.2.0', '### New\n\n- Add the thing\n\n### Fixed\n\n- Keep the office tidy\n'),
      release('v1.1.0', '### New\n\n- Already here\n'),
      release('v2.0.0-beta', '### New\n\n- Maybe\n', { prerelease: true }),
    ]));
  };
  try {
    await selfupdate.start({ stateDir, buildRoot: bundle }, { notify() {}, desktop: {}, carried: null });
    await selfupdate.check();
    const s = selfupdate.status();
    assert.deepEqual([s.mode, s.channel, s.count, s.error, s.upgrade], ['release', 'releases', 3, null, 'brew upgrade --cask underlings']);
    assert.deepEqual(s.target, { ref: 'v1.2.1', version: '1.2.1', url: page('v1.2.1') });
    assert.deepEqual([s.lines.New, s.lines.Fixed], [['Add the thing'], ['Stop the loop', 'Keep the office tidy']]);
    assert.deepEqual(urls, ['https://api.github.com/repos/TheNightProject/underlings/releases?per_page=20']);
    await assert.rejects(route('POST /api/updates/apply'), (err) => err.status === 409 && /Homebrew updates it: run brew upgrade --cask underlings/.test(err.message));
    await assert.rejects(route('POST /api/updates/channel', { channel: 'main' }), { status: 409 });
    assert.deepEqual(await ran(), [], 'and runs no git and no npm');
    globalThis.fetch = async () => new Response('', { status: 403 });
    await selfupdate.check();
    assert.match(selfupdate.status().error, /GitHub answered 403 when asked for the releases/);
  } finally {
    globalThis.fetch = noApi;
  }
});

test('a code reload hands the check and the update in progress to the new code', async () => {
  await selfupdate.check();
  const carried = selfupdate.carry();
  selfupdate.stop();
  await selfupdate.start({ stateDir, buildRoot: root, repoPath: root }, { notify() {}, carried: { selfupdate: carried } });
  assert.equal(selfupdate.status().count, 3);
});

test('the checkout is repoPath, else the one this runs from, else the one the build was made in, else the usual place', async () => {
  const bundle = join(home, 'Applications/Underlings.app/Contents/Resources/worker');
  await mkdir(bundle, { recursive: true });
  const usual = join(home, 'Projects/underlings');
  const resolved = async (config, stamp) => {
    if (stamp !== undefined) await writeFile(join(bundle, 'build.json'), JSON.stringify({ version: '1.1.0', commit: FROM, repo: stamp }));
    await selfupdate.start({ stateDir, ...config }, { notify() {}, carried: null });
    return selfupdate.status().repo;
  };
  assert.equal(await resolved({ buildRoot: root, repoPath: dev }), dev);
  assert.equal(await resolved({ buildRoot: root }), root);
  assert.equal(await resolved({ buildRoot: bundle }, dev), dev);
  assert.equal(await resolved({ buildRoot: bundle }, join(home, 'moved')), usual);
  assert.equal(await resolved({ buildRoot: bundle }, null), usual);
});
