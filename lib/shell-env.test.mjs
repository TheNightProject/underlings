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

const { adoptShellPath } = await import('./shell-env.mjs');

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
