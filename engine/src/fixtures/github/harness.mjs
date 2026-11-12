import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeGithub } from './fakegithub.mjs';
import { githubWorld } from './world.mjs';

const TOKENS = ['GITHUB_TOKEN', 'GH_TOKEN'];

/**
 * Everything a test of the GitHub side needs, moved off the real machine: a home and state folder of its own, a fake GitHub
 * in place of fetch, and a stand-in for gh that records each call and never reaches the real one, which is signed in.
 * Call it before importing anything that reads the environment.
 */
export function githubHarness({ world = githubWorld(), ghToken = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'underlings-github-'));
  const home = join(root, 'home');
  const gh = join(root, 'gh');
  const log = join(root, 'gh.log');
  const count = join(root, 'gh.count');
  mkdirSync(home, { recursive: true });
  for (const name of TOKENS) delete process.env[name];
  Object.assign(process.env, { HOME: home, UNDERLINGS_STATE_DIR: join(root, 'state'), UNDERLINGS_GH_BIN: gh, TZ: 'Europe/London' });
  // One token, or several handed out in turn, the last one for every call after; none means gh is signed out.
  const standIn = (tokens) => {
    const list = [tokens ?? []].flat();
    const answers = list.map((t, n) => `${n + 1}) echo '${t}';;`).join(' ');
    const out = list.length ? `n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${count}'; case $n in ${answers} *) echo '${list.at(-1)}';; esac` : "echo 'not logged in' >&2; exit 1";
    writeFileSync(gh, `#!/bin/sh\necho "$@" >> '${log}'\n${out}\n`);
    writeFileSync(count, '0');
    rmSync(log, { force: true });
    chmodSync(gh, 0o755);
  };
  standIn(ghToken);
  const fake = fakeGithub(world);
  const realFetch = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  return {
    root,
    home,
    fake,
    world,
    signedInWith: standIn,
    ghCalls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []),
    savedTokenFile: join(home, '.config', 'underlings', 'github-token'),
    done: () => {
      globalThis.fetch = realFetch;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
