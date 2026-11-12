import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca';
const commands = [];
const everyCommand = [];

// Only the process boundary and Electron are stubbed, so the real worker, router and notifier run under the app's host.
mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      commands.push([cmd, ...args]);
      everyCommand.push([cmd, ...args]);
      const out = cmd === ORCA ? JSON.stringify({ ok: true, result: { tabs: [], worktrees: [], terminals: [] } }) : '';
      setImmediate(() => done(cmd === ORCA ? null : Object.assign(new Error(`${cmd} is stubbed`), { code: 1 }), out, ''));
    },
  },
});

class FakeNotification extends EventEmitter {
  static made = [];
  static isSupported = () => true;
  constructor(options) {
    super();
    this.options = options;
    FakeNotification.made.push(this);
  }
  show() {}
}

const home = await mkdtemp(join(tmpdir(), 'control-centre-desktop-'));
process.env.HOME = home;
process.env.GITLAB_TOKEN = 'stub';
await mkdir(join(home, '.config/underlings'), { recursive: true });
const blocker = net.createServer();
await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
const blockedPort = blocker.address().port;
const matrixEngine = fileURLToPath(new URL('../lib/testkit.mjs', import.meta.url));
await writeFile(join(home, '.config/underlings/config.json'), JSON.stringify({ port: blockedPort, orcaUserDataPath: '/orca-profile', matrixEngine }));
const stateDir = join(home, '.local/state/underlings');
const KEPT = 'https://claude.ai/artifact/Kept1';
const LIVE_ONLY = 'https://claude.ai/code/artifact/Live2';
await mkdir(join(stateDir, 'artifacts/Kept1'), { recursive: true });
await writeFile(join(stateDir, 'artifacts/Kept1/index.html'), '<title>Kept</title>');
await writeFile(join(stateDir, 'artifacts.jsonl'), [
  { at: '2026-11-05T10:00:00Z', url: KEPT, title: 'Sprint review', dir: join(stateDir, 'artifacts/Kept1') },
  { at: '2026-11-04T10:00:00Z', url: LIVE_ONLY, title: 'Release notes' },
].map((r) => JSON.stringify(r)).join('\n') + '\n');
const { world, mr } = await import('../lib/testkit.mjs');
world.settings = { workspaceRoot: '/ws-root' };

const shown = [];
const focused = [];
const opened = [];
const claudeWindow = { shown: false, onTop: true, calls: [] };
const terminal = { opened: [], typed: new Set() };
const artifactWindow = [];
const covered = [];
let windowOpen = false;
const window = {
  showPage: (url) => {
    shown.push(url);
    const reused = windowOpen;
    windowOpen = true;
    return { reused };
  },
  focus: () => focused.push(true),
  popOut: () => Object.assign(claudeWindow, { shown: true, calls: [...claudeWindow.calls, 'pop out'] }),
  dockClaude: () => Object.assign(claudeWindow, { shown: false, calls: [...claudeWindow.calls, 'dock'] }),
  claudeOnTop: (on) => Object.assign(claudeWindow, { onTop: on, calls: [...claudeWindow.calls, `on top ${on}`] }),
  claudeState: () => ({ shown: claudeWindow.shown, onTop: claudeWindow.onTop }),
  openTerminal: (spec) => terminal.opened.push(spec),
  restartTerminal: (spec) => terminal.opened.push(spec),
  onTerminalTyped: (fn) => {
    terminal.typed.add(fn);
    return () => terminal.typed.delete(fn);
  },
  terminalAssets: {},
  openArtifact: (spec) => artifactWindow.push(['live', spec]),
  openArtifactCopy: (spec) => artifactWindow.push(['copy', spec]),
  showOverlay: () => covered.push('show'),
  closeOverlay: () => covered.push('close'),
};

const { CLAUDE_SHORTCUT, createHost, heldByOurWorker, nextFreePort, PAGE_MENU, readConfig, SHOW_SHORTCUT, VIEW_MENU } = await import('./host.mjs');
const host = createHost({ Notification: FakeNotification, openExternal: async (url) => opened.push(url), window, logDir: join(home, 'Logs') });
const worker = await import('../worker.mjs');
const clash = await worker.default(host.ctx).then(() => null, (err) => err);
const offeredPort = await nextFreePort(blockedPort);
host.ctx.desktop.port = offeredPort;
await worker.default(host.ctx);
blocker.close();
const pageUrl = new URL(shown[0]);
const origin = pageUrl.origin;
const token = pageUrl.searchParams.get('t');

after(async () => {
  await worker.deactivate();
  await rm(home, { recursive: true });
});

beforeEach(() => {
  commands.length = 0;
  shown.length = 0;
  focused.length = 0;
  opened.length = 0;
});

const orcaCalls = (from = commands) => from.filter(([cmd]) => cmd === ORCA).map(([, ...args]) => args);
const orcaWrites = (calls) => calls.filter(([, verb]) => verb !== 'ps' && verb !== 'list');
const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-token': token, origin }, body: JSON.stringify(body) });
const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 20));
};

// Gives up after a few seconds, so an event that never comes fails the test rather than hanging it.
async function nextEvent(match) {
  const res = await fetch(`${origin}/api/events?t=${token}`, { signal: AbortSignal.timeout(3000) });
  const reader = res.body.getReader();
  let seen = '';
  try {
    for (let i = 0; i < 50 && !match.test(seen); i += 1) seen += new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
  } catch {
    return seen;
  } finally {
    reader.cancel().catch(() => {});
  }
  return seen;
}

test('activation shows the page in the app\'s window and opens no Orca tab', async () => {
  assert.equal(pageUrl.pathname, '/');
  assert.ok(token);
  await until(() => world.calls.some(([name]) => name === 'fetchInbox'));
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(orcaWrites(orcaCalls(everyCommand)), []);
});

test('the worker\'s commands become menu items, and Open what needs me carries Cmd+Shift+J', () => {
  const items = host.menuItems();
  assert.deepEqual(items.map(({ label, accelerator }) => [label, accelerator]), [
    ['Open Underlings', undefined],
    ['Open what needs me', 'CommandOrControl+Shift+J'],
    ['Open Claude Code', undefined],
  ]);
});

test('Open what needs me brings the window forward and tells the page where to go', async () => {
  const heard = nextEvent(/goto:needs-you/);
  await new Promise((r) => setTimeout(r, 50));
  host.menuItems().find((item) => item.label === 'Open what needs me').click();
  assert.match(await heard, /data: goto:needs-you/);
  assert.deepEqual(shown, [`${pageUrl.href}#needs-you`]);
  assert.deepEqual(orcaCalls(), []);
});

test('a banner goes out through Electron, and a click opens the item that banner named, not the latest', async () => {
  assert.equal((await post('/api/matrix/refresh', {})).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  world.mrs = [mr('acme/engine', 1121, { author: 'judy', sha: 'ask1' })];
  assert.equal((await post('/api/matrix/refresh', {})).status, 200);
  await until(() => FakeNotification.made.length === 1);
  world.mrs = [...world.mrs, mr('acme/portal', 88, { author: 'judy', sha: 'ask2' })];
  assert.equal((await post('/api/matrix/refresh', {})).status, 200);
  await until(() => FakeNotification.made.length === 2);
  const [first, second] = FakeNotification.made;
  assert.deepEqual(first.options, { title: 'engine!1121: asks for your review', body: '' }, 'no Orca shortcut in a banner that opens its item itself');
  assert.equal(second.options.title, 'portal!88: asks for your review');
  first.emit('click');
  await until(() => shown.length > 0);
  assert.deepEqual(shown, [`${pageUrl.href}#mr:acme/engine!1121:overview`]);
  assert.deepEqual(orcaWrites(orcaCalls()), []);
  world.mrs = [];
});

test('/api/open in the app opens any web link in the default browser and never an Orca tab', async () => {
  const url = 'https://gitlab.com/acme/engine/-/merge_requests/1';
  const res = await post('/api/open', { url });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, 'Opened in your browser');
  assert.equal((await post('/api/open', { url: 'http://example.com/' })).status, 200);
  assert.equal((await post('/api/open', { url: 'file:///etc/passwd' })).status, 400);
  assert.deepEqual(opened, [url, 'http://example.com/']);
  assert.deepEqual(orcaCalls(), []);
});

test('the host opens only http and https links, whatever reaches it', async () => {
  await assert.rejects(host.ctx.desktop.openExternal('file:///etc/passwd'), { status: 400 });
  await assert.rejects(host.ctx.desktop.openExternal('javascript:alert(1)'), { status: 400 });
  assert.deepEqual(opened, []);
});

test('a clicked page banner brings the window forward rather than an Orca tab', async () => {
  const heard = nextEvent(/goto:mr:acme\/engine!1:threads/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await post('/api/summon', { target: 'mr:acme/engine!1:threads' })).status, 200);
  assert.match(await heard, /goto:mr:acme\/engine!1:threads/);
  assert.deepEqual(focused, [true]);
  assert.deepEqual(orcaCalls(), []);
});

test('the badge counts what the page counts and says whether full auto is paused, without asking Orca', async () => {
  world.settings = { ...world.settings, autoPaused: true };
  const badge = await (await fetch(`${origin}/api/badge`, { headers: { 'x-cc-token': token } })).json();
  assert.deepEqual(orcaCalls(), []);
  const state = await (await fetch(`${origin}/api/state?t=${token}`)).json();
  assert.deepEqual(badge, { count: state.attention.count, paused: true });
  assert.ok(badge.count > 0, 'the review asks above still need you');
  world.settings = { workspaceRoot: '/ws-root' };
});

test('a port already taken fails activation in a way the app can read, and a second one on the offered port starts the worker', () => {
  assert.equal(clash?.code, 'EADDRINUSE');
  assert.equal(clash.port, blockedPort);
  assert.equal(Number(pageUrl.port), offeredPort);
});

test('a port clash names a worker of ours on it, and finds the next free port', async (t) => {
  const taken = Number(new URL(origin).port);
  assert.equal(await heldByOurWorker(taken), true);
  const other = net.createServer((socket) => socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nhi'));
  t.after(() => other.close());
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  const otherPort = other.address().port;
  assert.equal(await heldByOurWorker(otherPort), false);
  assert.ok((await nextFreePort(otherPort - 1)) > otherPort);
});

test('the worker\'s log goes to the app\'s log folder', async () => {
  await until(() => existsSync(join(home, 'Logs/underlings.log')));
  const logged = await readFile(join(home, 'Logs/underlings.log'), 'utf8');
  assert.match(logged, /^\S+Z Underlings at http:\/\/127\.0\.0\.1:\d+\/\?t=/m);
});

function shortcutKeeper(refuse = () => false) {
  const held = new Map();
  return { held, register: (accelerator, handler) => (refuse(accelerator) ? false : Boolean(held.set(accelerator, handler))) };
}

test('the View menu goes to each view through the worker, which brings the window forward and tells the page', async () => {
  const items = host.viewMenu();
  const mrs = items.find((item) => item.label === 'Merge requests');
  assert.equal(mrs.accelerator, 'CommandOrControl+3');
  const heard = nextEvent(/goto:merge-requests/);
  await new Promise((r) => setTimeout(r, 50));
  mrs.click();
  assert.match(await heard, /data: goto:merge-requests/);
  assert.deepEqual(shown, [`${pageUrl.href}#merge-requests`]);
  const jump = nextEvent(/goto:jump/);
  await new Promise((r) => setTimeout(r, 50));
  items.find((item) => item.label === 'Jump to…').click();
  assert.match(await jump, /data: goto:jump/, 'the palette is opened by the page, which also takes Cmd+K itself');
  assert.deepEqual([host.settingsItem().label, host.settingsItem().accelerator], ['Settings…', 'CommandOrControl+,']);
  assert.deepEqual(orcaCalls(), []);
});

test('every menu target is a view or overlay the page knows, and no two of the app\'s shortcuts share keys', async () => {
  const core = await readFile(new URL('../ui/00-core.js', import.meta.url), 'utf8');
  const views = core.match(/^const VIEWS = \{[\s\S]*?\};/m)[0];
  for (const [, target] of VIEW_MENU) assert.match(views, new RegExp(`['\\s]${target}'?:`), target);
  assert.deepEqual(PAGE_MENU.map(([, target]) => target), ['jump', 'keys', 'settings']);
  const all = [...VIEW_MENU, ...PAGE_MENU].map(([, , accelerator]) => accelerator).filter(Boolean).concat(SHOW_SHORTCUT, 'CommandOrControl+Shift+J', CLAUDE_SHORTCUT);
  assert.equal(new Set(all).size, all.length, all.join(' '));
});

test('the show shortcut comes from config.json, brings the window forward, and the page and menus say what was taken', async () => {
  const keeper = shortcutKeeper();
  const bound = host.bindShortcuts(keeper, readConfig(join(home, '.config/underlings/config.json')));
  assert.deepEqual(bound.open, { accelerator: SHOW_SHORTCUT, registered: true, why: null });
  assert.deepEqual([...keeper.held.keys()], [SHOW_SHORTCUT, 'CommandOrControl+Shift+J', CLAUDE_SHORTCUT]);
  keeper.held.get(SHOW_SHORTCUT)();
  await until(() => shown.length > 0);
  assert.deepEqual(shown, [pageUrl.href]);
  assert.equal(host.menuItems()[0].accelerator, SHOW_SHORTCUT, 'the menus show it beside Open Underlings');
  assert.deepEqual(host.shortcutNote(), []);
  const state = await (await fetch(`${origin}/api/state?t=${token}`)).json();
  assert.deepEqual(state.hotkeys.show, bound.open);
  assert.ok(state.hotkeys.menu.some(([label, accelerator]) => label === 'Merge requests' && accelerator === 'CommandOrControl+3'));
});

test('a show shortcut macOS refuses is reported, and a blank one turns it off', async () => {
  const taken = host.bindShortcuts(shortcutKeeper((accelerator) => accelerator === 'Command+Shift+Y'), { showShortcut: 'Command+Shift+Y' });
  assert.deepEqual(taken.open, { accelerator: 'Command+Shift+Y', registered: false, why: 'macOS would not give it to the app' });
  assert.equal(host.menuItems()[0].accelerator, undefined);
  assert.deepEqual(host.shortcutNote(), [{ label: 'No shortcut shows this window: macOS would not give it to the app', enabled: false }]);
  await until(() => existsSync(join(home, 'Logs/underlings.log')));
  await new Promise((r) => setTimeout(r, 50));
  assert.match(await readFile(join(home, 'Logs/underlings.log'), 'utf8'), /could not take Command\+Shift\+Y for Open Underlings: macOS would not give it to the app/);
  const odd = host.bindShortcuts({ register() { throw new Error('conversion failure'); } }, { showShortcut: 'Hyper+Q' });
  assert.match(odd.open.why, /not a shortcut Electron understands \(conversion failure\)/);
  const off = host.bindShortcuts(shortcutKeeper(), { showShortcut: '' });
  assert.deepEqual(off.open, { accelerator: null, registered: false, why: 'turned off in config.json' });
  assert.deepEqual(host.shortcutNote(), [], 'turned off on purpose is not a problem to report');
  assert.deepEqual(readConfig(join(home, 'no-such-config.json')), {});
});

test('the Claude shortcut comes from claudeShortcut in config.json and opens Claude Code through the worker, and one macOS refuses is logged and said', async () => {
  const keeper = shortcutKeeper();
  const bound = host.bindShortcuts(keeper, {});
  assert.deepEqual(bound.claude, { accelerator: CLAUDE_SHORTCUT, registered: true, why: null });
  claudeWindow.calls = [];
  terminal.opened.length = 0;
  keeper.held.get(CLAUDE_SHORTCUT)();
  await until(() => terminal.opened.length > 0);
  assert.deepEqual([terminal.opened[0].cwd, terminal.opened[0].args.at(-2)], ['/ws-root', '--session-id']);
  assert.deepEqual(claudeWindow.calls, [], 'the chat panel is not popped out');
  assert.equal(terminal.typed.size, 1, 'the worker hears when Frank types in it');
  assert.equal(host.menuItems().find((item) => item.label === 'Open Claude Code').accelerator, CLAUDE_SHORTCUT, 'the menus show it beside Open Claude Code');
  const state = await (await fetch(`${origin}/api/state?t=${token}`)).json();
  assert.deepEqual(state.hotkeys.claude, bound.claude);
  assert.deepEqual([state.claude.canPopOut, state.claude.poppedOut, state.claude.onTop, state.claudeCode.available], [true, false, true, true]);
  host.bindShortcuts(shortcutKeeper((accelerator) => accelerator === 'Command+Shift+L'), { claudeShortcut: 'Command+Shift+L' });
  await new Promise((r) => setTimeout(r, 50));
  assert.match(await readFile(join(home, 'Logs/underlings.log'), 'utf8'), /could not take Command\+Shift\+L for Open Claude Code: macOS would not give it to the app/);
  assert.deepEqual(host.bindShortcuts(shortcutKeeper(), { claudeShortcut: '' }).claude, { accelerator: null, registered: false, why: 'turned off in config.json' });
  claudeWindow.shown = false;
});

test('the page pops Claude out, keeps it on top or not, and docks it back, which tells the page to open its panel in place', async () => {
  claudeWindow.calls = [];
  assert.equal((await post('/api/claude/popout', {})).status, 200);
  assert.equal((await post('/api/claude/on-top', { on: false })).status, 200);
  assert.equal((await post('/api/claude/on-top', { on: 'yes' })).status, 400);
  const heard = nextEvent(/goto:claude-here/);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await post('/api/claude/dock', {})).status, 200);
  assert.match(await heard, /data: goto:claude-here\n/);
  assert.deepEqual(claudeWindow.calls, ['pop out', 'on top false', 'dock']);
});

test('the page opens a recorded artifact in the app\'s window, live or its kept copy, and nothing it was not told about', async () => {
  artifactWindow.length = 0;
  assert.equal((await post('/api/artifacts/window', { url: KEPT })).status, 200);
  assert.equal((await post('/api/artifacts/window', { url: KEPT, copy: true })).status, 200);
  assert.equal((await post('/api/artifacts/window', { url: LIVE_ONLY })).status, 200);
  assert.equal((await post('/api/artifacts/window', { url: LIVE_ONLY, copy: true })).status, 404, 'no copy is kept of it');
  assert.equal((await post('/api/artifacts/window', { url: 'https://claude.ai/artifact/Unknown3' })).status, 404);
  assert.equal((await post('/api/artifacts/window', { url: 'https://example.com/' })).status, 404);
  const state = await (await fetch(`${origin}/api/state?t=${token}`)).json();
  const previewToken = state.artifacts.find((a) => a.url === KEPT).previewToken;
  assert.deepEqual(artifactWindow, [
    ['live', { url: KEPT, title: 'Sprint review' }],
    ['copy', { url: KEPT, title: 'Sprint review', path: `/preview/Kept1/${previewToken}/index.html?v=2026-11-05T10%3A00%3A00Z` }],
    ['live', { url: LIVE_ONLY, title: 'Release notes' }],
  ]);
  assert.doesNotMatch(artifactWindow[1][1].path, new RegExp(token), 'a copy is addressed by its own preview token, never the page token');
  assert.equal((await fetch(origin + artifactWindow[1][1].path)).status, 200, 'and the worker serves it at that path');
  assert.deepEqual(opened, [], 'nothing went to the browser');
  assert.deepEqual(orcaCalls(), []);
});

test('in the app the Calendar can cover the screen, and acting on the reminder closes it through the host', async () => {
  assert.equal(typeof host.ctx.desktop.showOverlay, 'function');
  const here = () => fetch(`${origin}/api/calendar/settings`, { headers: { 'x-cc-token': token } }).then((r) => r.json()).then((s) => s.overlayHere);
  let said = await here();
  for (let i = 0; i < 50 && !said; i += 1) said = await new Promise((r) => setTimeout(r, 40)).then(here);
  assert.equal(said, true);
  const answer = await post('/api/calendar/overlay', { act: 'dismiss' });
  assert.equal(answer.status, 200);
  assert.deepEqual(covered, ['close']);
  assert.equal((await post('/api/calendar/overlay', { act: 'explode' })).status, 400);
});
