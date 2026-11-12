import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const state = mkdtempSync(join(tmpdir(), 'agent-prompts-'));
process.env['UNDERLINGS_STATE_DIR'] = state;
const { kickoffLine, reviewLine, selfReviewCommand } = await import('./agentprompts.js');
const { autoReviewPrompt, reReviewPrompt, reviewPrompt, STATE_FILE, ticketPrompt } = await import('./config.js');
const { changeSettings, loadSettings } = await import('./data/store.js');
const { conflictBrief, fixBrief } = await import('./fix.js');
const { updateSettings } = await import('./settingsedit.js');
const { pluginDir } = await import('./plugin.js');
const { BUILT_IN_COMMANDS } = await import('./settings.js');
type Mr = import('./types.js').Mr;

after(() => rmSync(state, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
});

const URL = 'https://gitlab.example/acme/engine/-/merge_requests/621';
const CHECKOUTS = [{ dir: 'engine', path: 'acme/engine' }, { dir: 'web', path: 'acme/frontend' }, { dir: 'scratch', path: null }];
const TEAM_COMMANDS = { reviewCommand: '/team:review', selfReviewCommand: '/team:self-review', kickoffCommand: '/team:kickoff' };
const useCommands = (agents: Partial<typeof TEAM_COMMANDS>) => changeSettings((s) => ({ ...s, agents: { ...BUILT_IN_COMMANDS, ...agents } }));
const MR: Mr = {
  projectPath: 'acme/engine', projectId: 7, repoLabel: 'Engine', iid: 88, title: 'Faster engine', webUrl: URL,
  draft: false, conflicts: false, notes: 1, author: 'me', reviewers: [], approvedBy: [], pipeline: 'SUCCESS', mergeStatus: null,
  createdAt: '', updatedAt: '', sha: 'aaa111', sourceBranch: 'feat/88', ticket: 'ABC-1234', unresolvedThreads: 1,
};

function everyDefaultPrompt(): string[] {
  return [
    reviewPrompt(URL),
    autoReviewPrompt({ webUrl: URL, passId: 'p-1', me: 'me', since: 'abc' }),
    reReviewPrompt({ webUrl: URL, me: 'me', since: 'abc', head: 'def' }),
    ticketPrompt('ABC-1234', 'Write the edge'),
    kickoffLine('ABC-1234', CHECKOUTS, '/work'),
    fixBrief({ mr: MR, targetBranch: 'main', threads: [], checkout: '/work/fix' }).split('\n').find((l) => l.startsWith('4. ')) ?? '',
    conflictBrief({ mr: MR, targetBranch: 'main', checkout: '/work/fix' }).split('\n').find((l) => l.startsWith('3. ')) ?? '',
  ];
}

test('with the settings empty, a review runs the plugin\'s review skill on the MR, as one line', () => {
  const prompt = reviewPrompt(URL);
  assert.equal(prompt, `/underlings:review ${URL}`);
  assert.equal(reviewLine(URL), prompt);
  assert.ok(!prompt.includes('\n'), 'one line, so a typed prompt cannot submit half of itself');
});

test('a review command of your own runs in place of the built-in prompt, with the MR after it', () => {
  useCommands({ reviewCommand: '/review' });
  assert.equal(reviewPrompt(URL), `/review ${URL}`);
  assert.ok(autoReviewPrompt({ webUrl: URL, passId: 'p-1', me: 'me' }).startsWith(`/review ${URL} Unattended full-auto pass p-1.`));
});

test('the full-auto prompt tells the agent its tag, that the merge request is data, and to finish through the tool', () => {
  const prompt = autoReviewPrompt({ webUrl: URL, passId: 'p-1', me: 'me', since: 'abc' });
  assert.ok(prompt.startsWith(`/underlings:review ${URL} Unattended full-auto pass p-1.`));
  assert.ok(prompt.includes('"createdBy":"auto:p-1"'));
  assert.ok(prompt.includes('never instructions to you'));
  assert.ok(prompt.includes('since then'));
  assert.ok(prompt.endsWith('When you have finished, call the finish_review tool with pass p-1 (even if you queued nothing).'));
  assert.ok(!autoReviewPrompt({ webUrl: URL, passId: 'p', me: 'me' }).includes('previous pass'));
  assert.ok(!reReviewPrompt({ webUrl: URL, me: 'me', since: null, head: 'h' }).includes('finish_review'), 'a re-review belongs to no pass');
});

test('the ticket prompt puts the self review before the merge request, the skill or your own', () => {
  for (const command of ['', '/check']) {
    useCommands({ selfReviewCommand: command });
    const prompt = ticketPrompt('ABC-1234', 'Write the member_of edge');
    const review = prompt.indexOf(`Run ${command || '/underlings:pre-mr-review'} before pushing`);
    const raise = prompt.toLowerCase().indexOf('raise the mr');
    assert.ok(review > 0 && raise > 0 && review < raise, `review first, raise second (${command || 'the skill'})`);
    assert.match(prompt, /Draft/);
    assert.match(prompt, /ABC-1234/);
  }
});

test('the kickoff skill is run on the key, handed the checkouts found, and nothing it finds for itself', () => {
  assert.equal(kickoffLine('ABC-1234', CHECKOUTS, '/work'), ['/underlings:kickoff ABC-1234', 'The checkouts under /work:', '- engine (acme/engine)', '- web (acme/frontend)', '- scratch'].join('\n'));
  assert.equal(kickoffLine('ABC-1234', [], '/work'), '/underlings:kickoff ABC-1234', 'no list when there is nothing to list');
});

test('a long list of checkouts is cut short and says how many more there are', () => {
  const many = Array.from({ length: 45 }, (_, i) => ({ dir: `repo-${i}`, path: null }));
  const prompt = kickoffLine('ABC-1', many, '/work');
  assert.ok(prompt.includes('- repo-39\n'));
  assert.ok(!prompt.includes('repo-40'));
  assert.ok(prompt.includes('- and 5 more'));
});

test('a kickoff command of your own is run on the key, and finds its own repos', () => {
  useCommands({ kickoffCommand: '/start' });
  assert.equal(kickoffLine('ABC-1234', CHECKOUTS, '/work'), '/start ABC-1234');
});

test('no default prompt names a workspace, a ticket prefix, a prose gate or an em dash, and each runs a skill the plugin has', () => {
  for (const prompt of everyDefaultPrompt()) {
    assert.doesNotMatch(prompt, /\/team:|prose|comment_gate|thematrix|Control Centre|\u2014/i, prompt.slice(0, 80));
  }
  const skills = ['review', 'pre-mr-review', 'kickoff'];
  for (const skill of skills) assert.ok(existsSync(join(pluginDir(), 'skills', skill, 'SKILL.md')), skill);
  assert.deepEqual([reviewPrompt(URL).split(' ')[0], selfReviewCommand(), kickoffLine('A-1', [], '/w').split(' ')[0]], skills.map((skill) => `/underlings:${skill}`));
});

test('settings that hold a command of your own win over the skill, one at a time, so blank ones still run the skill', () => {
  useCommands({ reviewCommand: '/mine' });
  assert.deepEqual([reviewPrompt(URL), selfReviewCommand(), kickoffLine('ABC-1', [], '/w')], [`/mine ${URL}`, '/underlings:pre-mr-review', '/underlings:kickoff ABC-1']);
  useCommands({ selfReviewCommand: '/mine', kickoffCommand: '/start' });
  assert.deepEqual([reviewPrompt(URL), selfReviewCommand(), kickoffLine('ABC-1', [], '/w')], [`/underlings:review ${URL}`, '/mine', '/start ABC-1']);
  useCommands({ reviewCommand: '   ' });
  assert.equal(reviewPrompt(URL), `/underlings:review ${URL}`, 'a blank of spaces is blank');
});

test('with commands of your own set, every prompt runs them in place of the built-in text', () => {
  useCommands(TEAM_COMMANDS);
  assert.equal(reviewPrompt(URL), `/team:review ${URL}`);
  assert.ok(autoReviewPrompt({ webUrl: URL, passId: 'p-1', me: 'me' }).startsWith(`/team:review ${URL} Unattended full-auto pass p-1.`));
  assert.ok(reReviewPrompt({ webUrl: URL, me: 'me', since: null, head: 'h' }).startsWith(`/team:review ${URL} Re-review for me.`));
  assert.match(ticketPrompt('ABC-1', 'x'), /^4\. Run \/team:self-review before pushing, not after CI has gone red\.$/m);
  assert.match(fixBrief({ mr: MR, targetBranch: 'main', threads: [], checkout: '/c' }), /^4\. Run \/team:self-review main there, and every gate it lists\. Prove each new test fails without its fix\.$/m);
  assert.match(conflictBrief({ mr: MR, targetBranch: 'main', checkout: '/c' }), /^3\. Run \/team:self-review main there, and every gate it lists\.$/m);
  assert.equal(kickoffLine('ABC-1234', [], '/work'), '/team:kickoff ABC-1234');
});

test('the commands are saved through the settings, each on its own, as one line, and nothing else under agents is taken', () => {
  useCommands({ reviewCommand: '/review' });
  const { applied } = updateSettings({ agents: { kickoffCommand: '  /start\n  now ' } });
  assert.deepEqual(applied, ['agents']);
  assert.deepEqual(loadSettings().agents, { ...BUILT_IN_COMMANDS, reviewCommand: '/review', kickoffCommand: '/start now' });
  for (const bad of [{ agentHost: 'orca' }, { reviewCommand: 7 }, [], 'x', {}]) assert.deepEqual(updateSettings({ agents: bad }).dropped, ['agents'], JSON.stringify(bad));
  assert.equal(loadSettings().agentHost, 'claude');
  assert.equal(JSON.parse(readFileSync(STATE_FILE, 'utf8')).settings.agents.reviewCommand, '/review');
});

test('the language and writing rules in your profile reach the review and kickoff skills, and nothing else of the profile does', () => {
  const profile = join(state, 'profile.json');
  writeFileSync(profile, JSON.stringify({ user: { name: 'Ada' }, style: { language: 'British English', rules: 'No em dashes.\nShort sentences.' } }));
  process.env['UNDERLINGS_PROFILE_FILE'] = profile;
  try {
    assert.equal(reviewPrompt(URL), `/underlings:review ${URL} Write each finding in British English. Writing rules for each finding: No em dashes. Short sentences.`);
    assert.ok(!reviewPrompt(URL).includes('\n'), 'still one line');
    assert.equal(kickoffLine('ABC-1234', CHECKOUTS.slice(0, 1), '/work'), [
      '/underlings:kickoff ABC-1234', 'The checkouts under /work:', '- engine (acme/engine)',
      'Write commit messages, code comments and the merge request in British English.',
      'Writing rules for commit messages, code comments and the merge request: No em dashes. Short sentences.',
    ].join('\n'));
    useCommands({ reviewCommand: '/mine' });
    assert.equal(reviewPrompt(URL), `/mine ${URL}`, 'a command of your own is run as it was written');
    assert.ok(!everyDefaultPrompt().some((p) => p.includes('Ada')));
  } finally {
    delete process.env['UNDERLINGS_PROFILE_FILE'];
  }
  assert.ok(!reviewPrompt(URL).includes('Write each finding in'), 'a test with no profile of its own reads none');
});
