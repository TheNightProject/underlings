import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION_LINE = /^(\s*"version": ")[^"]*(")/m;

export function stamp(root = ROOT, now = new Date()) {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  setVersion(root, version);
  const commit = headOf(root);
  const build = { version, commit, builtAt: now.toISOString(), repo: commit ? root : null };
  writeFileSync(join(root, 'build.json'), JSON.stringify(build) + '\n');
  return build;
}

// npm install rewrites a lock whose version lags its package.json, which would leave the checkout dirty.
export function setVersion(root, version) {
  for (const file of ['package.json', 'desktop/package.json']) {
    const path = join(root, file);
    const text = readFileSync(path, 'utf8');
    const next = text.replace(VERSION_LINE, `$1${version}$2`);
    if (next !== text) writeFileSync(path, next);
  }
  const lockPath = join(root, 'desktop/package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (lock.version === version && lock.packages?.['']?.version === version) return;
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}

function headOf(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { version, commit } = stamp();
  console.log(`Stamped build.json: ${version} at ${commit?.slice(0, 8) ?? 'no commit'}`);
}
