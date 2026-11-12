import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist.noindex']);
const SKIP_FILES = new Set(['build.json', '.git']);
const BINARY = /\.(png|icns|ico|gif|jpe?g|woff2?)$/i;

// The banned terms live outside the repo, so the public tree names none of them; without the file there is nothing to check.
const TERMS = process.env.UNDERLINGS_GUARD_TERMS ?? join(userInfo().homedir, '.config/underlings-dev/guard-terms.txt');

async function bannedTerms() {
  const text = await readFile(TERMS, 'utf8').catch(() => '');
  return text.split('\n').flatMap((line) => {
    const literal = /^\/(.+)\/([a-z]*)$/.exec(line.trim());
    return literal ? [new RegExp(literal[1], literal[2])] : [];
  });
}

async function filesUnder(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : filesUnder(path);
    return entry.isFile() && !BINARY.test(entry.name) && !SKIP_FILES.has(entry.name) ? [path] : [];
  }));
  return found.flat();
}

async function hitsIn(path, banned) {
  const text = await readFile(path, 'utf8');
  if (text.includes('\u0000')) return [];
  return text.split('\n').flatMap((line, n) => (banned.some((re) => re.test(line)) ? [`${relative(ROOT, path)}:${n + 1}`] : []));
}

test('no shipped code, doc or fixture names an employer, its products, its people or its tickets', async (t) => {
  const banned = await bannedTerms();
  if (!banned.length) return t.diagnostic(`no terms at ${TERMS}, so nothing to check`);
  const files = await filesUnder(ROOT);
  assert.ok(files.length > 400, `${files.length} files read`);
  const hits = (await Promise.all(files.map((path) => hitsIn(path, banned)))).flat();
  assert.deepEqual(hits, []);
});
