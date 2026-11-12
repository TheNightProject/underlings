import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as crypto from 'node:crypto';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyWorld, fakeGithub } from '../../../engine/src/fixtures/github/fakegithub.mjs';
import { fakeGitlab } from './fakegitlab.mjs';
import { fakeChildProcess } from './fakeprocs.mjs';
import { goldenWorld, HOST } from './world.mjs';
import { lineDiff } from './linediff.mjs';

const { default: _, ...realCrypto } = crypto;
const BASELINES = fileURLToPath(new URL('./', import.meta.url));
const GITHUB_TOKEN = 'github-golden-token';

/**
 * Runs the baseline session once and returns what it recorded. With `github`, GitHub is switched on against a fake that answers nothing,
 * and the same baselines must still hold; that run never writes them.
 */
export async function goldenRun({ github = false } = {}) {
  const update = process.env.UNDERLINGS_GOLDEN === 'update' && !github;
  const token = 'golden-token';
  const root = mkdtempSync(join(tmpdir(), 'underlings-golden-'));
  const home = join(root, 'home');
  after(() => rmSync(root, { recursive: true, force: true }));

  for (const name of Object.keys(process.env)) if (/^(?:UNDERLINGS_|ORCA_|CLAUDE_CONFIG_DIR$|GITHUB_TOKEN$|GH_TOKEN$)/.test(name)) delete process.env[name];
  Object.assign(process.env, {
    HOME: home,
    TZ: 'Europe/London',
    GITLAB_TOKEN: token,
    GITHUB_TOKEN,
    UNDERLINGS_STATE_DIR: join(home, '.local/state/underlings/engine'),
    UNDERLINGS_LOCALE_FILE: join(home, '.config/underlings/locale.json'),
    UNDERLINGS_CLAUDE_BIN: fileURLToPath(new URL('../fake-claude.mjs', import.meta.url)),
    UNDERLINGS_ACLI: 'acli',
  });
  mkdirSync(home, { recursive: true });

  const world = goldenWorld();
  const gitlab = fakeGitlab(world, { host: HOST, token });
  const githubWorld = emptyWorld();
  const githubFake = fakeGithub(githubWorld);
  const calls = [];
  mock.module('node:child_process', { namedExports: fakeChildProcess(world, calls) });
  mock.module('node:crypto', { namedExports: { ...realCrypto, randomUUID: countedUuid() }, defaultExport: realCrypto });
  globalThis.fetch = (input, init) => (new URL(String(input)).origin === HOST ? gitlab.fetch(input, init) : githubFake.fetch(input, init));

  const { asText, normalised, runSession, seed, START } = await import('./session.mjs');
  mock.timers.enable({ apis: ['Date'], now: START });
  const { config } = seed(root, home, github ? { github: { on: true, scope: 'involved', repos: '', host: '' } } : {});
  const got = normalised(await runSession({ fake: gitlab, root, config }), root);

  function againstBaseline(name, value) {
    const file = join(BASELINES, `${name}.json`);
    const actual = asText(value);
    if (update) return writeFileSync(file, actual);
    const expected = readFileSync(file, 'utf8');
    if (actual === expected) return;
    assert.fail(`the GitLab ${name} baseline changed (- baseline, + this run):\n${lineDiff(expected, actual)}\nIf the change is deliberate, regenerate with UNDERLINGS_GOLDEN=update npm run test:golden`);
  }

  return { got, againstBaseline, github: githubFake, calls, GITHUB_TOKEN };
}

// Ids the session mints are counted rather than random, so anything hashed from them, such as a notifier key, is the same every run.
function countedUuid() {
  let made = 0;
  return () => `00000000-0000-4000-8000-${String((made += 1)).padStart(12, '0')}`;
}

export function baselineTests({ got, againstBaseline }) {
  test('every GitLab request the session makes is the one the baseline records, in the same steps', () => againstBaseline('requests', got.requests));

  test('the session reaches every path it drives: no step is refused and GitLab answers every request', () => {
    assert.deepEqual(got.requests.steps.filter((s) => s.said.startsWith('refused')).map((s) => `${s.step}: ${s.said}`), []);
    assert.deepEqual(got.requests.steps.flatMap((s) => s.requests.filter((r) => r.unanswered).map((r) => `${s.step}: ${r.call}`)), []);
  });

  test('the state files the session leaves are the ones the baseline records', () => againstBaseline('state', got.state));

  test('the GitLab views show the text the baseline records', () => againstBaseline('page', got.page));
}
