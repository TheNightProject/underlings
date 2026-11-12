import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { COVER, createOverlay, LEVEL, ON_EVERY_SPACE } from './overlay.mjs';

const SAFE = { contextIsolation: true, nodeIntegration: false, sandbox: true };
const URL_ = 'http://127.0.0.1:47321/?t=x&window=meeting';
const DELL = { id: 1, bounds: { x: 0, y: 0, width: 3840, height: 2160 } };
const LAPTOP = { id: 2, bounds: { x: -2056, y: 297, width: 2056, height: 1329 } };
const SAMSUNG = { id: 3, bounds: { x: -731, y: -1440, width: 2560, height: 1440 } };

class FakeContents extends EventEmitter {
  loaded = [];
  openHandler = null;
  loadURL(url) {
    this.loaded.push(url);
    return Promise.resolve();
  }

  setWindowOpenHandler(fn) {
    this.openHandler = fn;
  }
}

class FakeWindow extends EventEmitter {
  static made = [];
  webContents = new FakeContents();
  calls = [];
  opacity = 1;
  destroyed = false;

  constructor(options) {
    super();
    this.options = options;
    FakeWindow.made.push(this);
  }

  loadURL(url) {
    return this.webContents.loadURL(url);
  }

  setAlwaysOnTop(...args) {
    this.calls.push(['setAlwaysOnTop', ...args]);
  }

  setVisibleOnAllWorkspaces(...args) {
    this.calls.push(['setVisibleOnAllWorkspaces', ...args]);
  }

  setBounds(bounds) {
    this.calls.push(['setBounds', bounds]);
  }

  setOpacity(value) {
    this.opacity = value;
  }

  show() {
    this.calls.push(['show']);
  }

  showInactive() {
    this.calls.push(['showInactive']);
  }

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }

  loaded() {
    this.webContents.emit('did-finish-load');
  }
}

function fakeScreen(displays, cursor = DELL) {
  const screen = new EventEmitter();
  screen.displays = displays;
  screen.getAllDisplays = () => screen.displays;
  screen.getCursorScreenPoint = () => ({ x: cursor.bounds.x + 10, y: cursor.bounds.y + 10 });
  screen.getDisplayNearestPoint = (point) => screen.displays.find((d) => point.x >= d.bounds.x && point.x < d.bounds.x + d.bounds.width && point.y >= d.bounds.y && point.y < d.bounds.y + d.bounds.height);
  return screen;
}

function setup({ displays = [DELL, LAPTOP, SAMSUNG], cursor, reducedMotion = true } = {}) {
  FakeWindow.made = [];
  const screen = fakeScreen(displays, cursor);
  const overlay = createOverlay({ electron: { BrowserWindow: FakeWindow, screen }, safePage: SAFE, reducedMotion: () => reducedMotion });
  const live = () => FakeWindow.made.filter((w) => !w.destroyed);
  return { overlay, screen, live };
}

const shownBy = (w) => w.calls.filter(([name]) => name === 'show' || name === 'showInactive').map(([name]) => name);

test('one frameless panel covers each display, sized to it, above everything and on every Space', () => {
  const { overlay } = setup();
  assert.deepEqual(overlay.show(URL_), { shown: 3 });
  assert.deepEqual(FakeWindow.made.map((w) => [w.options.x, w.options.y, w.options.width, w.options.height]), [DELL, LAPTOP, SAMSUNG].map(({ bounds: b }) => [b.x, b.y, b.width, b.height]));
  for (const w of FakeWindow.made) {
    assert.deepEqual(w.calls.slice(0, 2), [['setAlwaysOnTop', true, 'screen-saver'], ['setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true, skipTransformProcessType: true }]]);
    assert.equal(w.options.type, 'panel', 'a panel is what floats over another app\'s full-screen Space');
    assert.equal(w.options.frame, false);
    assert.equal(w.options.transparent, true);
    assert.equal(w.options.vibrancy, 'fullscreen-ui', 'the blur behind is the system\'s own');
    assert.equal(w.options.visualEffectState, 'active', 'and stays blurred on the displays without focus');
    assert.equal(w.options.show, false, 'drawn only once the page has loaded');
    assert.deepEqual(w.options.webPreferences, SAFE);
    assert.deepEqual(w.webContents.loaded, [URL_]);
  }
  assert.equal(LEVEL, 'screen-saver');
  assert.deepEqual([COVER.roundedCorners, COVER.skipTaskbar, COVER.resizable, COVER.movable], [false, true, false, false]);
  assert.deepEqual(ON_EVERY_SPACE, { visibleOnFullScreen: true, skipTransformProcessType: true });
});

test('each shows once its page has loaded, and only the one under the pointer takes the keys', () => {
  const { overlay } = setup({ cursor: SAMSUNG });
  overlay.show(URL_);
  const [dell, laptop, samsung] = FakeWindow.made;
  assert.deepEqual(FakeWindow.made.map(shownBy), [[], [], []]);
  samsung.loaded();
  dell.loaded();
  laptop.loaded();
  assert.deepEqual([shownBy(dell), shownBy(laptop), shownBy(samsung)], [['showInactive'], ['showInactive'], ['show']]);
});

test('asked again while it shows, it covers only a display it is not on yet', () => {
  const { overlay, screen } = setup({ displays: [DELL] });
  overlay.show(URL_);
  overlay.show(URL_);
  assert.equal(FakeWindow.made.length, 1);
  screen.displays = [DELL, LAPTOP];
  overlay.show(URL_);
  assert.equal(FakeWindow.made.length, 2);
});

test('closing it closes every display, and a page that loads after does not show', () => {
  const { overlay, live } = setup();
  overlay.show(URL_);
  FakeWindow.made[0].loaded();
  assert.deepEqual(overlay.close(), { closed: 3 });
  assert.deepEqual(live(), []);
  FakeWindow.made[1].loaded();
  assert.deepEqual(shownBy(FakeWindow.made[1]), []);
  assert.deepEqual(overlay.close(), { closed: 0 });
});

test('one closed some other way, such as Cmd+W, takes the others with it', () => {
  const { overlay, live } = setup();
  overlay.show(URL_);
  FakeWindow.made[1].destroy();
  assert.deepEqual(live(), []);
});

test('a display plugged in while it shows is covered too, and one unplugged loses only its own', () => {
  const { overlay, screen, live } = setup({ displays: [DELL, LAPTOP] });
  overlay.show(URL_);
  screen.emit('display-added', {}, SAMSUNG);
  assert.equal(live().length, 3);
  assert.deepEqual([live()[2].options.x, live()[2].options.width], [SAMSUNG.bounds.x, SAMSUNG.bounds.width]);
  screen.emit('display-removed', {}, LAPTOP);
  assert.deepEqual(live().map((w) => w.options.x), [DELL.bounds.x, SAMSUNG.bounds.x]);
  const moved = { ...DELL, bounds: { ...DELL.bounds, width: 2560, height: 1440 } };
  screen.emit('display-metrics-changed', {}, moved);
  assert.deepEqual(live()[0].calls.at(-1), ['setBounds', moved.bounds]);
  overlay.close();
  screen.emit('display-added', {}, LAPTOP);
  assert.deepEqual(live(), [], 'nothing is covered once it has closed');
});

test('the page cannot navigate the cover away or open a window', () => {
  const { overlay } = setup({ displays: [DELL] });
  overlay.show(URL_);
  const contents = FakeWindow.made[0].webContents;
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  contents.emit('will-navigate', event, 'https://example.com/');
  assert.equal(event.prevented, true);
  assert.deepEqual(contents.openHandler({ url: 'https://example.com/' }), { action: 'deny' });
});

test('it fades in, except with reduced motion', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { overlay } = setup({ displays: [DELL], reducedMotion: false });
  overlay.show(URL_);
  const [w] = FakeWindow.made;
  w.loaded();
  assert.equal(w.opacity, 0);
  t.mock.timers.tick(120);
  assert.ok(w.opacity > 0 && w.opacity < 1, String(w.opacity));
  t.mock.timers.tick(200);
  assert.equal(w.opacity, 1);
  const still = setup({ displays: [DELL], reducedMotion: true });
  still.overlay.show(URL_);
  FakeWindow.made[0].loaded();
  assert.equal(FakeWindow.made[0].opacity, 1, 'never set below full');
});

test('the app hands the worker the overlay, loading the page as a window of its own', async () => {
  const main = await readFile(new URL('./main.mjs', import.meta.url), 'utf8');
  assert.match(main, /showOverlay: \(\) => overlay\.show\(windowUrl\('meeting'\)\), closeOverlay: overlay\.close/);
  assert.match(main, /safePage: SAFE_PAGE,\n\s+reducedMotion: \(\) => systemPreferences\.getAnimationSettings\(\)\.prefersReducedMotion/);
});
