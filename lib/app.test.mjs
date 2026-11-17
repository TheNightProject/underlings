import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const OPEN = '/usr/bin/open';
const commands = [];

// Only the process boundary is stubbed, so the real worker and router run.
mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      commands.push([cmd, ...args]);
      setImmediate(() => done(cmd === OPEN ? null : Object.assign(new Error(`${cmd} is stubbed`), { code: 1 }), '', ''));
    },
  },
});

// The app's windows, banners and browser, as the main process hands them over, recorded.
const desktop = {
  shown: [], focused: 0, banners: [], opened: [], windowOpen: false,
  showPage(url) {
    this.shown.push(url);
    const reused = this.windowOpen;
    this.windowOpen = true;
    return { reused };
  },
  focus() { this.focused += 1; },
  notify(banner) { this.banners.push(banner); return { delivered: true }; },
  openExternal(url) { this.opened.push(url); return { ok: true }; },
};

const home = await mkdtemp(join(tmpdir(), 'control-centre-app-'));
process.env.HOME = home;
process.env.GITLAB_TOKEN = 'stub';
await mkdir(join(home, '.config/underlings'), { recursive: true });
const matrixEngine = fileURLToPath(new URL('./testkit.mjs', import.meta.url));
await writeFile(join(home, '.config/underlings/config.json'), JSON.stringify({ port: 0, matrixEngine }));
const { world } = await import('./testkit.mjs');
world.settings = { workspaceRoot: '/ws-root' };

const worker = await import('../worker.mjs');
const logged = [];
const registered = new Map();
await worker.default({ log: (t) => logged.push(t), commands: { register: (id, fn) => registered.set(id, fn) }, desktop });
const pageUrl = new URL(logged.find((t) => t.startsWith('Underlings at ')).slice('Underlings at '.length));
const origin = pageUrl.origin;
const token = pageUrl.searchParams.get('t');

after(async () => {
  await worker.deactivate();
  await rm(home, { recursive: true });
});

beforeEach(() => {
  commands.length = 0;
  desktop.shown.length = 0;
  desktop.opened.length = 0;
  desktop.windowOpen = false;
});

function post(path, body, headers = { 'x-cc-token': token, origin }) {
  return fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}


test('a write carrying the token only in its query is refused', async () => {
  const res = await fetch(`${origin}/api/hide?t=${token}`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}' });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /missing token/);
});

test('a write from another origin is refused, even with the header token', async () => {
  const res = await post('/api/hide', { url: 'https://claude.ai/artifact/x', hidden: true }, { 'x-cc-token': token, origin: 'https://claude.ai' });
  assert.equal(res.status, 403);
  const plain = await post('/api/hide', { url: 'https://claude.ai/artifact/x', hidden: true }, { 'x-cc-token': token });
  assert.equal(plain.status, 403);
});

test('a read still takes the query token, and a wrong one is refused', async () => {
  assert.equal((await fetch(`${origin}/api/state?t=${token}`)).status, 200);
  assert.equal((await fetch(`${origin}/api/state?t=nope`)).status, 403);
});

test('a web link opens in the default browser through the app, and nothing is run for it', async () => {
  const urls = ['https://gitlab.com/acme/engine/-/merge_requests/1', 'http://example.com/docs', 'https://example.atlassian.net/browse/ABC-1'];
  for (const url of urls) assert.equal((await post('/api/open', { url })).status, 200, url);
  assert.deepEqual(desktop.opened, urls);
  assert.deepEqual(commands, []);
});

test('a Slack app link of exactly the shape Slack builds opens in the Slack app through the system open', async () => {
  const url = 'slack://channel?team=T0EXAMPLE01&id=C0PLATFORM1&message=1794312709.738689';
  commands.length = 0;
  const res = await post('/api/open', { url });
  assert.equal(res.status, 200);
  assert.deepEqual(commands, [[OPEN, url]]);
});

test('only an http or https link, or a Slack app link, opens, and anything else is a 400 that runs nothing', async () => {
  const slackish = ['slack://open', 'slack://channel?team=T0EXAMPLE01&id=C0PLATFORM1&message=1794312709.738689&x=1', 'slack://channel?team=T0EXAMPLE01&id=C0PLATFORM1;rm', 'slack://file?team=T0EXAMPLE01&id=F0123456'];
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'mailto:x@example.com', 'ssh://host', 'not a url', 7, undefined, ...slackish]) {
    assert.equal((await post('/api/open', { url })).status, 400, String(url));
  }
  assert.deepEqual([commands, desktop.opened], [[], []]);
});

test('the page is assembled with one tag per ui file, in filename order', async () => {
  const html = await (await fetch(`${origin}/?t=${token}`)).text();
  const ui = (await readdir(new URL('../ui', import.meta.url))).filter((n) => /\.(css|js)$/.test(n)).sort();
  assert.deepEqual([...html.matchAll(/\/\/# sourceURL=ui\/(\S+)/g)].map((m) => m[1]), ui.filter((n) => n.endsWith('.js')));
  assert.equal((html.match(/<style>/g) ?? []).length, ui.filter((n) => n.endsWith('.css')).length);
  assert.match(html, /<meta name="cc-ui" content="\d+(\.\d+)?">/);
  assert.equal(html.indexOf('<script>') > html.indexOf('<div class="sheet-backdrop"'), true);
});

test('reload swaps in new code and keeps the server, token and process, and the inbox it already has', async () => {
  const fetches = () => world.calls.filter(([name]) => name === 'fetchInbox').length;
  const before = fetches();
  const res = await post('/api/reload', {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.generation, 1);
  assert.equal(body.pid, process.pid);
  assert.equal(body.version.loaded, body.version.lib);
  const state = await (await fetch(`${origin}/api/state?t=${token}`)).json();
  assert.equal(state.matrix.available, true);
  assert.equal(state.matrix.inbox.fetchedAt !== null, true);
  assert.equal(fetches(), before);
  assert.equal((await post('/api/reload', {}, { 'x-cc-token': token })).status, 403);
});

test('the token file holds the token the page link carries', async () => {
  assert.equal((await readFile(join(home, '.local/state/underlings/token'), 'utf8')).trim(), token);
});

async function nextEvent(match) {
  const res = await fetch(`${origin}/api/events?t=${token}`);
  const reader = res.body.getReader();
  let seen = '';
  try {
    for (let i = 0; i < 50 && !match.test(seen); i += 1) seen += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
  } finally {
    reader.cancel().catch(() => {});
  }
  return seen;
}

test('Open what needs me is a command of its own, showing Needs you in the window when no banner has gone out', async () => {
  assert.ok(registered.has('latest'));
  await registered.get('latest')();
  assert.equal(desktop.shown.length, 1);
  assert.match(desktop.shown[0], /\?t=[^#]+#needs-you$/);
});

test('a window already open is brought forward and told where to go', async () => {
  desktop.windowOpen = true;
  const heard = nextEvent(/goto:needs-you/);
  await new Promise((r) => setTimeout(r, 50));
  await registered.get('latest')();
  assert.match(await heard, /data: goto:needs-you/);
});

test('summon refuses a target that is neither an MR tab, a ticket, an agent nor a view, and goes to one that is', async () => {
  const focused = desktop.focused;
  for (const target of ['https://gitlab.com/x', 'mr:not a key:threads', 'mr:acme/engine!1:secrets', '../etc', 7]) {
    assert.equal((await post('/api/summon', { target })).status, 400, String(target));
  }
  assert.equal(desktop.focused, focused);
  const heard = nextEvent(/goto:mr:acme\/engine!1:threads/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await post('/api/summon', { target: 'mr:acme/engine!1:threads' })).status, 200);
  assert.match(await heard, /goto:mr:acme\/engine!1:threads/);
  assert.equal(desktop.focused, focused + 1);
  for (const target of ['ticket:ABC-2900', 'agent:claude:00000000-0000-4000-8000-000000000201']) assert.equal((await post('/api/summon', { target })).status, 200, target);
});

test('a review asked of you after the first look goes out as one of the app\'s banners, from the worker itself', async () => {
  const { mr } = await import('./testkit.mjs');
  assert.equal((await post('/api/matrix/refresh', {})).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  world.mrs = [mr('acme/engine', 1121, { author: 'judy', sha: 'ask1' })];
  assert.equal((await post('/api/matrix/refresh', {})).status, 200);
  for (let i = 0; i < 100 && !desktop.banners.length; i += 1) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(desktop.banners.map(({ title, body }) => ({ title, body })), [{ title: 'engine!1121: asks for your review', body: '' }]);
  world.mrs = [];
});
