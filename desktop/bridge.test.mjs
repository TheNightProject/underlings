import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      setImmediate(() => done(Object.assign(new Error(`${cmd} is stubbed`), { code: 1 }), '', ''));
    },
  },
});

const { initOf, serveWorker, workerCtx } = await import('./bridge.mjs');

// Two ends of a process boundary: each message arrives later, and as a copy, as it would through a utility process.
function wires() {
  const sides = [new EventEmitter(), new EventEmitter()];
  const end = (from, to) => ({ post: (msg) => setImmediate(() => to.emit('message', structuredClone(msg))), on: (fn) => from.on('message', fn) });
  return [end(sides[0], sides[1]), end(sides[1], sides[0])];
}

function connected(desktop) {
  const [app, worker] = wires();
  const logged = [];
  const served = serveWorker({ port: app, desktop, log: (text) => logged.push(text) });
  const ctx = workerCtx({ port: worker, init: structuredClone(initOf(desktop)) });
  return { served, ctx, logged };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('a call across answers with what the app returned, and a refusal arrives as an error with its status', async () => {
  const opened = [];
  const { ctx } = connected({
    showPage: (url) => ({ reused: opened.push(url) > 1 }),
    openArtifact: () => { throw Object.assign(new Error('only the app opens an artifact'), { status: 400 }); },
  });
  assert.deepEqual(await ctx.desktop.showPage('http://127.0.0.1:1/?t=x'), { reused: false });
  assert.deepEqual(await ctx.desktop.showPage('http://127.0.0.1:1/?t=x#needs-you'), { reused: true });
  await assert.rejects(ctx.desktop.openArtifact({ url: 'https://claude.ai/artifact/A1' }), { message: 'only the app opens an artifact', status: 400 });
  assert.equal(typeof ctx.desktop.popOut, 'undefined', 'what the app does not give is not there');
});

test('a banner is shown by the app, and its click runs what the worker gave it, there', async () => {
  const banners = [];
  const { ctx } = connected({ notify: (banner) => (banners.push(banner), { delivered: true }) });
  const clicked = [];
  assert.deepEqual(await ctx.desktop.notify({ title: 'Needs you', body: 'acme/engine!7', open: () => clicked.push('needs-you') }), { delivered: true });
  assert.deepEqual([banners[0].title, banners[0].body], ['Needs you', 'acme/engine!7']);
  banners[0].open();
  await settle();
  assert.deepEqual(clicked, ['needs-you']);
});

test('commands registered by the worker are run there from the app, with their arguments', async () => {
  const { served, ctx } = connected({});
  const ran = [];
  ctx.commands.register('goto', (target) => ran.push(target));
  await settle();
  assert.equal(served.has('goto'), true);
  assert.equal(served.has('claude'), false);
  served.run('goto', 'tickets');
  await settle();
  assert.deepEqual(ran, ['tickets']);
});

test('what the worker reads without waiting is kept on its side, and each change the app hands over replaces it', async () => {
  const state = { shown: false, onTop: true };
  const { served, ctx } = connected({ claudeWindow: () => state, hotkeys: { show: { accelerator: 'Control+Alt+Command+K' } }, terminalAssets: { 'xterm.js': '/x.js' }, port: 47322 });
  assert.deepEqual([ctx.desktop.claudeWindow(), ctx.desktop.port, ctx.desktop.terminalAssets], [state, 47322, { 'xterm.js': '/x.js' }]);
  served.keep('claudeWindow', { shown: true, onTop: false });
  served.keep('hotkeys', { show: null });
  await settle();
  assert.deepEqual([ctx.desktop.claudeWindow(), ctx.desktop.hotkeys], [{ shown: true, onTop: false }, { show: null }]);
});

test('typing in the terminal reaches every listener in the worker, until the last lets go', async () => {
  const listeners = new Set();
  const { ctx } = connected({ onTerminalTyped: (fn) => (listeners.add(fn), () => listeners.delete(fn)) });
  const heard = [];
  const offA = ctx.desktop.onTerminalTyped(() => heard.push('a'));
  const offB = ctx.desktop.onTerminalTyped(() => heard.push('b'));
  await settle();
  assert.equal(listeners.size, 1, 'one subscription across, however many listen');
  [...listeners][0]();
  await settle();
  assert.deepEqual(heard, ['a', 'b']);
  offA();
  offB();
  await settle();
  assert.equal(listeners.size, 0);
});

const home = await mkdtemp(join(tmpdir(), 'underlings-bridge-'));
after(async () => {
  await worker?.deactivate();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
let worker;

test('the real worker starts across the bridge: its page is shown, its banners come back clickable, and the app runs its commands', async () => {
  process.env.HOME = home;
  process.env.GITLAB_TOKEN = 'stub';
  await mkdir(join(home, '.config/underlings'), { recursive: true });
  const matrixEngine = fileURLToPath(new URL('../lib/testkit.mjs', import.meta.url));
  await writeFile(join(home, '.config/underlings/config.json'), JSON.stringify({ port: 0, matrixEngine }));
  const shown = [];
  const banners = [];
  const desktop = {
    showPage: (url) => ({ reused: shown.push(url) > 1 }),
    focus: () => {},
    notify: (banner) => (banners.push(banner), { delivered: true }),
    openExternal: async () => ({ ok: true }),
    workspaces: () => ({ workspaces: [{ id: 'default', name: 'Work', here: true }, { id: 'side', name: 'Side', here: false }] }),
    chooseFolder: ({ from }) => ({ chosen: from ? null : '/Users/dev/code' }),
    switchWorkspace: ({ id }) => {
      if (id === 'starting') throw Object.assign(new Error('Starting has not started yet'), { status: 409 });
      return { ok: true, text: `Switched to ${id}` };
    },
  };
  const { served, ctx, logged } = connected(desktop);
  worker = await import('../worker.mjs');
  await worker.default(ctx);
  await settle();
  const page = new URL(shown[0]);
  assert.ok(logged.some((line) => line.startsWith('Underlings at ')), logged.join('\n'));
  assert.equal(served.has('open'), true);

  const res = await fetch(page.origin + '/api/attention/test', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-token': page.searchParams.get('t'), origin: page.origin }, body: '{}' });
  assert.equal((await res.json()).text, 'Test banner sent.');
  assert.equal(banners.length, 1);
  banners[0].open();
  await settle();
  assert.equal(new URL(shown.at(-1)).hash, '#needs-you', 'its click opens what it named');

  served.run('goto', 'tickets');
  await settle();
  assert.equal(new URL(shown.at(-1)).hash, '#tickets');

  const headers = { 'content-type': 'application/json', 'x-cc-token': page.searchParams.get('t'), origin: page.origin };
  const state = await (await fetch(page.origin + '/api/state', { headers })).json();
  assert.deepEqual(state.workspaces.workspaces.map((w) => w.id), ['default', 'side'], 'the page is told every workspace');
  const switched = await fetch(page.origin + '/api/workspaces/switch', { method: 'POST', headers, body: JSON.stringify({ id: 'side' }) });
  assert.equal((await switched.json()).text, 'Switched to side');
  const picked = await fetch(page.origin + '/api/choose-folder', { method: 'POST', headers, body: JSON.stringify({ from: '' }) });
  assert.deepEqual(await picked.json(), { chosen: '/Users/dev/code' }, 'the app\'s folder picker answers the page');
  const refused = await fetch(page.origin + '/api/workspaces/switch', { method: 'POST', headers, body: JSON.stringify({ id: 'starting' }) });
  assert.deepEqual([refused.status, await refused.text()], [409, 'Starting has not started yet']);
});
