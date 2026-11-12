import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { BAR, chromeUserAgent, COPY_PARTITION, createViewer, HINT, LIVE_PARTITION, liveAllows, signingIn } from './viewer.mjs';

const SAFE = { contextIsolation: true, nodeIntegration: false, sandbox: true };
const ARTIFACT = 'https://claude.ai/artifact/Sprint1';
const OTHER = 'https://claude.ai/code/artifact/Other2';
const LOGIN = 'https://claude.ai/login?returnTo=%2Fartifact%2FSprint1';
const GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=claude&display=popup';
const ORIGIN = 'http://127.0.0.1:47321';
const COPY_PATH = '/preview/Sprint1/pv-1/index.html?v=2026-11-05T12%3A00%3A00Z';

class FakeContents extends EventEmitter {
  url = '';
  loaded = [];
  sent = [];
  went = [];
  closed = false;
  openHandler = null;
  navigationHistory = {
    canGoBack: () => this.loaded.length > 1,
    canGoForward: () => false,
    goBack: () => this.went.push('back'),
    goForward: () => this.went.push('forward'),
  };

  loadURL(url) {
    this.loaded.push(url);
    this.url = url;
    return Promise.resolve();
  }

  getURL() {
    return this.url;
  }

  setWindowOpenHandler(fn) {
    this.openHandler = fn;
  }

  send(channel, value) {
    this.sent.push([channel, value]);
  }

  reload() {
    this.went.push('reload');
  }

  close() {
    this.closed = true;
  }

  isDestroyed() {
    return this.closed;
  }

  lastState() {
    return this.sent.filter(([channel]) => channel === 'viewer:state').at(-1)?.[1];
  }
}

class FakeWindow extends EventEmitter {
  static made = [];
  webContents = new FakeContents();
  children = [];
  contentView = {
    addChildView: (view) => this.children.push(view),
    removeChildView: (view) => { this.children = this.children.filter((c) => c !== view); },
  };

  destroyed = false;

  constructor(options) {
    super();
    this.options = options;
    FakeWindow.made.push(this);
  }

  loadFile(file) {
    this.webContents.file = file;
  }

  setTitle(title) {
    this.title = title;
  }

  show() {
    this.shown = true;
  }

  focus() {}

  isDestroyed() {
    return this.destroyed;
  }

  getContentBounds() {
    return { x: 300, y: 200, width: 1000, height: 800 };
  }

  getNormalBounds() {
    return { x: 30, y: 40, width: 1000, height: 820 };
  }

  close() {
    this.emit('close', { preventDefault() {} });
    this.destroyed = true;
    this.emit('closed');
  }
}

class FakeView {
  static made = [];
  webContents = new FakeContents();

  constructor({ webPreferences }) {
    this.webPreferences = webPreferences;
    FakeView.made.push(this);
  }

  setBounds(bounds) {
    this.bounds = bounds;
  }
}

function fakeSessions() {
  const made = new Map();
  const touched = [];
  return {
    made,
    touched,
    get defaultSession() {
      touched.push('defaultSession');
      return {};
    },
    fromPartition(name) {
      if (!made.has(name)) made.set(name, { name, ua: null, setUserAgent(ua) { this.ua = ua; }, setPermissionRequestHandler(fn) { this.permit = fn; } });
      return made.get(name);
    },
  };
}

function setup(remembered = {}) {
  FakeWindow.made = [];
  FakeView.made = [];
  const out = [];
  const floated = [];
  let file = { ...remembered };
  const sessions = fakeSessions();
  const ipcMain = new EventEmitter();
  const clipboard = { text: null, writeText(text) { this.text = text; } };
  const viewer = createViewer({
    electron: { BrowserWindow: FakeWindow, WebContentsView: FakeView, session: sessions, ipcMain, clipboard },
    safePage: SAFE,
    toolbar: '/app/viewer.html',
    preload: '/app/viewer-preload.cjs',
    chromeVersion: '152.0.7977.167',
    openExternal: async (url) => {
      if (!/^https?:/.test(url)) throw new Error('only http and https links open in the browser');
      out.push(url);
    },
    saved: {
      bounds: () => (file.width ? { x: file.x, y: file.y, width: file.width, height: file.height } : {}),
      read: () => ({ ...file }),
      write: (value) => { file = value; },
    },
    floatOnTop: (w, on) => floated.push(on),
    focusApp() {},
  });
  const win = () => FakeWindow.made.at(-1);
  const page = () => FakeView.made.at(-1).webContents;
  const fromToolbar = (verb) => ipcMain.emit('viewer:run', { sender: win().webContents }, verb);
  return { viewer, out, floated, sessions, ipcMain, clipboard, saved: () => file, win, page, fromToolbar };
}

function navigation(url, isMainFrame = true) {
  return { url, isMainFrame, prevented: false, preventDefault() { this.prevented = true; } };
}

function navigate(contents, type, url, isMainFrame) {
  const event = navigation(url, isMainFrame);
  contents.emit(type, event);
  return event.prevented;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the window loads claude.ai and the hosts its sign-in uses, and nothing else', () => {
  for (const url of [ARTIFACT, LOGIN, 'https://claude.ai/api/auth/apple/callback', GOOGLE, 'https://accounts.google.com/v3/signin/identifier', 'https://appleid.apple.com/auth/authorize']) assert.equal(liveAllows(url), true, url);
  for (const url of ['http://claude.ai/', 'https://claude.ai.example.com/', 'https://example.com/?next=https://claude.ai/', 'https://claude.ai@example.com/', 'https://claude.ai:8443/', 'https://www.claude.ai/', 'https://support.google.com/', 'javascript:alert(1)', 'not a link', undefined]) assert.equal(liveAllows(url), false, String(url));
});

test('Google\'s and Apple\'s sign-in may hop through their other account hosts, and nothing else of theirs stays in', () => {
  for (const url of ['https://accounts.youtube.com/accounts/SetSID?ssdc=1', 'https://accounts.google.co.uk/accounts/SetSID', 'https://accounts.google.de/', 'https://www.google.com/accounts/SetSID?continue=x', 'https://idmsa.apple.com/appleauth/auth']) assert.equal(liveAllows(url), true, url);
  for (const url of ['https://www.youtube.com/watch?v=1', 'https://www.google.com/search?q=x', 'https://accounts.youtube.com.example.com/', 'http://accounts.youtube.com/', 'https://accounts.google.evil.example/', 'https://user@accounts.youtube.com/', 'https://accounts.youtube.com:444/', 'https://mail.google.com/']) assert.equal(liveAllows(url), false, url);
});

test('a link or a redirect off those hosts goes to your browser, and only the main frame is held to them', async () => {
  const { viewer, out, page } = setup();
  viewer.open({ url: ARTIFACT, title: 'Sprint review' });
  assert.equal(navigate(page(), 'will-navigate', LOGIN), false);
  assert.equal(navigate(page(), 'will-navigate', 'https://appleid.apple.com/auth/authorize?client_id=claude'), false);
  assert.equal(navigate(page(), 'will-navigate', 'https://www.anthropic.com/legal/privacy'), true);
  assert.equal(navigate(page(), 'will-redirect', 'https://example.com/landing'), true);
  assert.equal(navigate(page(), 'will-redirect', 'https://newassets.hcaptcha.com/captcha', false), false, 'a frame inside the page loads where it likes');
  assert.equal(navigate(page(), 'will-navigate', 'mailto:someone@example.com'), true);
  await settle();
  assert.deepEqual(out, ['https://www.anthropic.com/legal/privacy', 'https://example.com/landing'], 'a mailto link is refused, not opened');
});

test('a new window goes to your browser, except Google\'s sign-in, which opens over the window and is held to the same hosts', async () => {
  const { viewer, out, page, win } = setup();
  viewer.open({ url: ARTIFACT, title: 'Sprint review' });
  assert.deepEqual(page().openHandler({ url: 'https://example.com/report' }), { action: 'deny' });
  assert.deepEqual(page().openHandler({ url: 'https://claude.ai/new' }), { action: 'deny' }, 'even claude.ai, in a window of its own, goes out');
  const signIn = page().openHandler({ url: GOOGLE });
  assert.equal(signIn.action, 'allow');
  assert.equal(signIn.overrideBrowserWindowOptions.parent, win());
  const popup = { webContents: new FakeContents() };
  page().emit('did-create-window', popup);
  assert.equal(navigate(popup.webContents, 'will-navigate', 'https://accounts.google.com/v3/signin/challenge/pwd'), false);
  assert.equal(navigate(popup.webContents, 'will-navigate', 'https://support.google.com/accounts'), true);
  assert.deepEqual(popup.webContents.openHandler({ url: GOOGLE }), { action: 'deny' }, 'the popup opens no popup of its own');
  await settle();
  assert.deepEqual(out, ['https://example.com/report', 'https://claude.ai/new', 'https://support.google.com/accounts', GOOGLE]);
});

test('only a claude.ai artifact link opens the window', () => {
  const { viewer } = setup();
  for (const url of [GOOGLE, 'https://example.com/artifact/1', 'http://claude.ai/artifact/1']) assert.throws(() => viewer.open({ url, title: 'x' }), /only a claude\.ai link/, url);
  assert.equal(FakeWindow.made.length, 0);
});

test('the live page signs in to a persistent partition of its own, with a plain Chrome user agent, and never the dashboard\'s session', async () => {
  const { viewer, sessions, win } = setup();
  viewer.open({ url: ARTIFACT, title: 'Sprint review' });
  const view = FakeView.made[0];
  assert.equal(view.webPreferences.partition, LIVE_PARTITION);
  assert.match(LIVE_PARTITION, /^persist:/, 'kept on disk, so a sign-in lasts');
  assert.deepEqual({ ...view.webPreferences, partition: undefined }, { ...SAFE, partition: undefined }, 'sandboxed as the dashboard is, and with no preload');
  assert.equal(win().webContents.file, '/app/viewer.html');
  assert.equal(win().options.webPreferences.partition, undefined, 'the toolbar is a local file, not the claude.ai page');
  const live = sessions.made.get(LIVE_PARTITION);
  assert.equal(live.ua, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36');
  assert.doesNotMatch(chromeUserAgent('152.0.7977.167'), /Electron|Underlings/);
  assert.equal(sessions.made.get(COPY_PARTITION).ua, null, 'the plain Chrome agent is for claude.ai\'s partition only');
  assert.deepEqual(sessions.touched, [], 'the dashboard\'s default session is never touched');
  const allowed = (permission) => new Promise((resolve) => live.permit(null, permission, resolve));
  assert.deepEqual(await Promise.all(['clipboard-sanitized-write', 'notifications', 'media', 'geolocation'].map(allowed)), [true, false, false, false]);
  const main = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(main.match(/const SAFE_PAGE = \{[^}]*\}/)[0], /partition/, 'the dashboard\'s windows stay in the default session');
  assert.match(main, /safePage: SAFE_PAGE/);
});

test('one window is reused for every artifact, and opens again where it was left', () => {
  const { viewer, win, page } = setup();
  viewer.open({ url: ARTIFACT, title: 'Sprint review' });
  viewer.open({ url: OTHER, title: 'Release notes' });
  assert.equal(FakeWindow.made.length, 1);
  assert.equal(FakeView.made.length, 1, 'the same claude.ai page loads the next artifact');
  assert.deepEqual(page().loaded, [ARTIFACT, OTHER]);
  assert.equal(win().title, 'Release notes');
  assert.equal(win().webContents.lastState().title, 'Release notes');
  assert.equal(win().shown, true);
  const first = win();
  first.close();
  assert.equal(FakeView.made[0].webContents.closed, true, 'closing the window closes the page in it');
  viewer.open({ url: ARTIFACT, title: 'Sprint review' });
  assert.notEqual(win(), first);
  assert.deepEqual([win().options.x, win().options.y, win().options.width, win().options.height], [30, 40, 1000, 820]);
});

test('the toolbar goes back, forward and reloads the page, copies and opens the artifact\'s own link, and keeps the window on top', async () => {
  const { viewer, win, page, fromToolbar, out, clipboard, floated, saved, ipcMain } = setup();
  viewer.open({ url: ARTIFACT, title: 'Sprint review' });
  page().url = LOGIN;
  const html = await readFile(new URL('./viewer.html', import.meta.url), 'utf8');
  const verbs = [...html.matchAll(/data-run="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(verbs, ['back', 'forward', 'reload', 'copy', 'browser', 'top']);
  for (const verb of verbs) fromToolbar(verb);
  await settle();
  assert.deepEqual(page().went, ['back', 'forward', 'reload']);
  assert.equal(clipboard.text, ARTIFACT, 'the artifact\'s link, not the sign-in page it is on');
  assert.deepEqual(out, [ARTIFACT]);
  assert.deepEqual(floated, [false, true]);
  assert.equal(saved().onTop, true);
  assert.equal(win().webContents.lastState().onTop, true);
  ipcMain.emit('viewer:run', { sender: page() }, 'top');
  ipcMain.emit('viewer:run', { sender: win().webContents }, 'constructor');
  assert.deepEqual(floated, [false, true], 'only the toolbar runs these, and only these');
  assert.deepEqual(setup({ onTop: true }).floated, [], 'nothing floats before a window exists');
  const remembered = setup({ onTop: true });
  remembered.viewer.open({ url: ARTIFACT, title: 'Sprint review' });
  assert.deepEqual(remembered.floated, [true], 'Keep on top is remembered');
});

test('a sign-in page shows how to sign in with an email code, and the page moves down to make room', () => {
  for (const url of [LOGIN, GOOGLE, 'https://appleid.apple.com/auth/authorize']) assert.equal(signingIn(url), true, url);
  for (const url of [ARTIFACT, 'https://claude.ai/new', 'not a link']) assert.equal(signingIn(url), false, url);
  const { viewer, win, page } = setup();
  viewer.open({ url: ARTIFACT, title: 'Sprint review' });
  assert.equal(win().webContents.lastState().hint, false);
  assert.deepEqual(FakeView.made[0].bounds, { x: 0, y: BAR, width: 1000, height: 800 - BAR });
  page().url = LOGIN;
  page().emit('did-navigate');
  assert.equal(win().webContents.lastState().hint, true);
  assert.deepEqual(FakeView.made[0].bounds, { x: 0, y: BAR + HINT, width: 1000, height: 800 - BAR - HINT });
  assert.match(win().webContents.lastState().where, /^claude\.ai$/);
});

test('a kept copy opens in the same window from the worker\'s preview, in a partition with no sign-in, and every link out of its folder goes to your browser', async () => {
  const { viewer, win, page, out, fromToolbar, clipboard } = setup();
  viewer.open({ url: ARTIFACT, title: 'Sprint review' });
  const live = FakeView.made[0];
  viewer.openCopy({ url: ARTIFACT, title: 'Sprint review', path: COPY_PATH, origin: ORIGIN });
  assert.equal(FakeWindow.made.length, 1);
  assert.equal(live.webContents.closed, true);
  assert.deepEqual(win().children, [FakeView.made[1]]);
  assert.equal(FakeView.made[1].webPreferences.partition, COPY_PARTITION);
  assert.doesNotMatch(COPY_PARTITION, /^persist:/);
  assert.deepEqual(page().loaded, [ORIGIN + COPY_PATH]);
  assert.equal(navigate(page(), 'will-navigate', `${ORIGIN}/preview/Sprint1/pv-1/slides/2.html`), false);
  assert.equal(navigate(page(), 'will-navigate', ARTIFACT), true);
  assert.equal(navigate(page(), 'will-navigate', `${ORIGIN}/api/state`), true);
  assert.deepEqual(page().openHandler({ url: GOOGLE }), { action: 'deny' }, 'no sign-in popup from a copy');
  assert.equal(win().webContents.lastState().where, 'kept copy');
  assert.equal(win().webContents.lastState().hint, false);
  fromToolbar('copy');
  assert.equal(clipboard.text, ARTIFACT, 'the claude.ai link, never the preview address');
  await settle();
  assert.deepEqual(out, [ARTIFACT, `${ORIGIN}/api/state`, GOOGLE]);
  for (const path of ['https://example.com/preview/Sprint1/pv-1/index.html', '/api/state', '//example.com/preview/x']) assert.throws(() => viewer.openCopy({ url: ARTIFACT, title: 'x', path, origin: ORIGIN }), /own preview/, path);
  assert.throws(() => viewer.openCopy({ url: 'https://example.com/', title: 'x', path: COPY_PATH, origin: ORIGIN }), /only a claude\.ai link/);
});
