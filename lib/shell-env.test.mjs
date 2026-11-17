import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let shellPath = '';
const calls = [];
mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      calls.push([cmd, ...args]);
      setImmediate(() => done(null, `zsh noise__CONTROL_CENTRE__${shellPath}`, ''));
    },
  },
});

const { adoptShellEnv, adoptShellPath } = await import('./shell-env.mjs');

test('the login shell\'s PATH comes first, and the worker keeps any folder of its own the shell lacks', async () => {
  process.env.PATH = '/usr/bin:/bin:/Applications/Orca.app/Contents/Resources/bin';
  shellPath = '/opt/homebrew/bin:/Users/frank/.local/bin:/usr/bin:/bin';
  await adoptShellPath();
  assert.equal(process.env.PATH, '/opt/homebrew/bin:/Users/frank/.local/bin:/usr/bin:/bin:/Applications/Orca.app/Contents/Resources/bin');
  assert.equal(calls.at(-1)[0], '/bin/zsh');
});

test('a shell that prints no PATH leaves the worker\'s alone', async () => {
  process.env.PATH = '/usr/bin:/bin';
  shellPath = '';
  await adoptShellPath();
  assert.equal(process.env.PATH, '/usr/bin:/bin');
});

test('a workspace other than Default never takes a token, folder or Claude login from your shell profile, and still takes the rest', async () => {
  for (const name of ['GITLAB_TOKEN', 'GH_TOKEN', 'UNDERLINGS_STATE_DIR', 'CLAUDE_CONFIG_DIR', 'JIRA_SITE']) delete process.env[name];
  process.env.UNDERLINGS_WORKSPACE = 'side-project';
  try {
    calls.length = 0;
    await adoptShellEnv(['GITLAB_TOKEN', 'GH_TOKEN', 'UNDERLINGS_STATE_DIR', 'CLAUDE_CONFIG_DIR']);
    assert.deepEqual(calls, [], 'the shell is not even asked');
    shellPath = 'acme.atlassian.net\0';
    await adoptShellEnv(['GITLAB_TOKEN', 'JIRA_SITE']);
    assert.equal(process.env.JIRA_SITE, 'acme.atlassian.net');
    assert.equal(process.env.GITLAB_TOKEN, undefined);
    assert.doesNotMatch(calls.at(-1).join(' '), /GITLAB_TOKEN/);
  } finally {
    delete process.env.UNDERLINGS_WORKSPACE;
    delete process.env.JIRA_SITE;
  }
});
