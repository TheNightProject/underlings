import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = join(process.cwd(), 'dist', 'cli.js');

test('an agent says it has finished, and a pass nobody launched is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'underlings-done-'));
  try {
    const pass = { id: 'p-1', key: 'a!1', author: 's', sha: 'h', trigger: 'new', launchedAt: '2026-11-03T10:00:00Z' };
    writeFileSync(join(dir, 'auto.json'), JSON.stringify({ 'a!1': { key: 'a!1', pass } }));
    const env = { ...process.env, UNDERLINGS_STATE_DIR: dir, GITLAB_TOKEN: '' };
    const ok = await run('node', [CLI, 'queue', 'done', 'p-1'], { env });
    assert.match(ok.stdout, /marked finished/);
    const saved = JSON.parse(readFileSync(join(dir, 'auto.json'), 'utf8')) as Record<string, { pass: { doneAt?: string } }>;
    assert.ok(saved['a!1']?.pass.doneAt, 'the pass is marked done');
    await assert.rejects(run('node', [CLI, 'queue', 'done', 'made-up'], { env }), /no full-auto pass made-up/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the terminal app is gone: no tsx, nothing imports ink or react, and the one command is underlings', () => {
  const src = fileURLToPath(new URL('.', import.meta.url));
  const files = readdirSync(src, { recursive: true }).map(String);
  assert.deepEqual(files.filter((f) => f.endsWith('.tsx')), []);
  assert.deepEqual(files.filter((f) => f.endsWith('.ts') && /from '(?:ink|react)(?:\/[^']*)?'/.test(readFileSync(join(src, f), 'utf8'))), []);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { bin: Record<string, string>; scripts: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  assert.deepEqual(pkg.bin, { underlings: './dist/cli.js' });
  const used = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.deepEqual(used.filter((name) => ['ink', 'react', '@types/react', 'chalk'].includes(name)), []);
  assert.match(pkg.scripts['build'] ?? '', /src\/cli\.ts /);
});

test('with no command it prints what it does and opens nothing', async () => {
  const shown = await run('node', [CLI], { env: { ...process.env, GITLAB_TOKEN: '' } });
  assert.match(shown.stdout, /^underlings - /);
  assert.match(shown.stdout, /underlings queue add --json/);
  await assert.rejects(run('node', [CLI, 'tui'], { env: { ...process.env, GITLAB_TOKEN: '' } }), (err: { code?: number }) => err.code === 2);
});
