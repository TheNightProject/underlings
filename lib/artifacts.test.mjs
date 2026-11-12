import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca';

mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      const out = cmd === ORCA ? JSON.stringify({ ok: true, result: { tabs: [], worktrees: [], terminals: [] } }) : '';
      setImmediate(() => done(cmd === ORCA ? null : Object.assign(new Error(`${cmd} is stubbed`), { code: 1 }), out, ''));
    },
  },
});

const COPIED = 'Copied1';
const OTHER = 'Other2';
const home = await mkdtemp(join(tmpdir(), 'control-centre-artifacts-'));
const state = join(home, '.local/state/underlings');
process.env.HOME = home;
process.env.GITLAB_TOKEN = 'stub';
await mkdir(join(home, '.config/underlings'), { recursive: true });
await writeFile(join(home, '.config/underlings/config.json'), JSON.stringify({ port: 0, orcaUserDataPath: '/orca-profile', matrixEngine: fileURLToPath(new URL('./testkit.mjs', import.meta.url)) }));
for (const id of [COPIED, OTHER]) {
  await mkdir(join(state, 'artifacts', id, 'css'), { recursive: true });
  await writeFile(join(state, 'artifacts', id, 'index.html'), `<title>${id}</title><link rel="stylesheet" href="css/site.css">`);
  await writeFile(join(state, 'artifacts', id, 'css/site.css'), 'body { color: red }');
}
await writeFile(join(state, 'artifacts.jsonl'), [
  { at: '2026-11-05T10:00:00Z', url: `https://claude.ai/artifact/${COPIED}`, title: 'Copied', dir: join(state, 'artifacts', COPIED) },
  { at: '2026-11-04T10:00:00Z', url: `https://claude.ai/code/artifact/${OTHER}`, title: 'Other', dir: join(state, 'artifacts', OTHER) },
  { at: '2026-06-25T12:00:00Z', url: 'https://claude.ai/artifact/Backfilled3', title: 'Backfilled', source: 'backfill' },
  { at: '2026-06-24T12:00:00Z', url: 'https://claude.ai/artifact/Cleared4', title: 'Cleared', dir: join(state, 'artifacts', 'Cleared4') },
  { at: '2026-06-23T12:00:00Z', url: 'https://claude.ai/artifact/Untitled5' },
].map((r) => JSON.stringify(r)).join('\n') + '\n');

const worker = await import('../worker.mjs');
const logged = [];
await worker.default({ log: (t) => logged.push(t), commands: { register() {} }, events: { on() {} }, host: { call: async () => {} } });
const pageUrl = new URL(logged.find((t) => t.startsWith('Underlings at ')).slice('Underlings at '.length));
const origin = pageUrl.origin;
const token = pageUrl.searchParams.get('t');
const artifacts = (await (await fetch(`${origin}/api/state?t=${token}`)).json()).artifacts;
const tokenFor = (title) => artifacts.find((a) => a.title === title).previewToken;
const previewToken = tokenFor('Copied');
const preview = (path, init) => fetch(`${origin}/preview/${COPIED}/${previewToken}/${path}`, init);

after(async () => {
  await worker.deactivate();
  await rm(home, { recursive: true });
});

// fetch() folds ../ out of a URL before sending it, so this sends the path exactly as written.
function rawGet(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: Number(new URL(origin).port), path, headers: { host: new URL(origin).host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

test('only an artifact with a copy still on disk gets a preview token, and it is not the dashboard token', () => {
  assert.deepEqual(artifacts.map((a) => [a.title, typeof a.previewToken, a.dir]), [
    ['Copied', 'string', join(state, 'artifacts', COPIED)],
    ['Other', 'string', join(state, 'artifacts', OTHER)],
    ['Backfilled', 'undefined', undefined],
    ['Cleared', 'undefined', undefined],
    ['https://claude.ai/artifact/Untitled5', 'undefined', undefined],
  ]);
  assert.notEqual(previewToken, token);
  assert.notEqual(tokenFor('Other'), previewToken);
});

test('a preview serves the copy with the sandbox CSP and a content type by extension', async () => {
  const page = await preview('index.html');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-security-policy'), 'sandbox allow-scripts');
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await page.text(), /<title>Copied1<\/title>/);
  const css = await preview('css/site.css');
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(css.headers.get('content-security-policy'), 'sandbox allow-scripts');
  assert.equal((await preview('')).status, 200);
  assert.equal((await preview('missing.js')).status, 404);
});

test('../ and absolute paths are refused, however they are spelled', async () => {
  const absolute = encodeURIComponent(join(state, 'artifacts', COPIED, 'index.html'));
  for (const path of ['..%2F..%2Ftoken', '..%2f..%2f..%2f.local%2fstate%2fcontrol-centre%2ftoken', 'css/..%2F..%2F..%2Ftoken', '%2Fetc%2Fpasswd', absolute, `..%2F${OTHER}%2Findex.html`]) {
    const res = await preview(path);
    assert.equal(res.status, 400, path);
    assert.doesNotMatch(await res.text(), new RegExp(token), path);
  }
  for (const path of [`/preview/${COPIED}/${previewToken}/../../token`, `/preview/${COPIED}/${previewToken}/../../../../../../../../etc/passwd`, `/preview/${COPIED}/${previewToken}/../${OTHER}/index.html`]) {
    const res = await rawGet(path);
    assert.notEqual(res.status, 200, path);
    assert.doesNotMatch(res.body, new RegExp(`${token}|root:|${OTHER}`), path);
  }
});

test('a preview refuses the dashboard token, wherever it is put, and another artifact\'s token', async () => {
  assert.equal((await fetch(`${origin}/preview/${COPIED}/${token}/index.html`)).status, 403);
  assert.equal((await fetch(`${origin}/preview/${COPIED}/${token}/index.html?t=${token}`)).status, 403);
  assert.equal((await preview('index.html?t=' + token)).status, 403);
  assert.equal((await preview('index.html', { headers: { 'x-cc-token': token } })).status, 403);
  assert.equal((await fetch(`${origin}/preview/${COPIED}/${tokenFor('Other')}/index.html`)).status, 403);
  assert.equal((await fetch(`${origin}/preview/${COPIED}//index.html`)).status, 403);
  assert.equal((await fetch(`${origin}/preview/${COPIED}/${previewToken}x/index.html`)).status, 403);
  assert.equal((await preview('index.html', { method: 'POST', headers: { 'x-cc-token': token, origin } })).status, 403);
  assert.equal((await preview('index.html', { method: 'POST', headers: { origin } })).status, 403);
});

test('every other route refuses the preview token', async () => {
  for (const path of ['/', '/api/state', '/api/events', '/api/matrix/mr?key=acme/engine!1']) {
    const res = await fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}t=${previewToken}`, { headers: { 'x-cc-token': previewToken } });
    assert.equal(res.status, 403, path);
  }
  for (const path of ['/api/hide', '/api/open', '/api/reload', '/api/matrix/refresh']) {
    const res = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-token': previewToken, origin }, body: '{}' });
    assert.equal(res.status, 403, path);
  }
});

test('the plugin has no window to open an artifact in, so it says so and the page keeps the browser', async () => {
  const res = await fetch(origin + '/api/artifacts/window', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-token': token, origin }, body: JSON.stringify({ url: `https://claude.ai/artifact/${COPIED}` }) });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /only the Underlings app opens an artifact in a window of its own/);
});

test('with Artifacts switched off the snapshot reads no artifact record, and says the switch is off', async () => {
  await writeFile(join(home, '.config/underlings/features.json'), JSON.stringify({ artifacts: false }));
  try {
    const off = await (await fetch(`${origin}/api/state?t=${token}`)).json();
    assert.deepEqual([off.artifacts, off.features.artifacts, off.features.tickets, off.features.qa], [[], false, true, false]);
  } finally {
    await rm(join(home, '.config/underlings/features.json'), { force: true });
  }
  assert.ok((await (await fetch(`${origin}/api/state?t=${token}`)).json()).artifacts.length > 0);
});
