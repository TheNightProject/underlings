import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, Notification, screen, session, shell, systemPreferences, Tray, WebContentsView } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startHelper } from '../lib/apphelper.mjs';
import { configDir, logsDir, migrateHome, OLD_APP_NAME } from '../lib/home.mjs';
import { APP_ID, APP_NAME, FOLDER } from '../lib/product.mjs';
import { createHost, heldByOurWorker, nextFreePort, readConfig } from './host.mjs';
import { keptBounds } from './bounds.mjs';
import { createOverlay } from './overlay.mjs';
import { bundleOf, moveFor, moveJob, tidyAfterMove } from './relocate.mjs';
import { bridgeView, createTerminal } from './terminal.mjs';
import { createViewer } from './viewer.mjs';

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_DIR = app.isPackaged ? join(process.resourcesPath, 'worker') : dirname(APP_DIR);
const WINDOW_FILE = join(app.getPath('userData'), 'window.json');
const CLAUDE_FILE = join(app.getPath('userData'), 'claude-window.json');
const TERMINAL_FILE = join(app.getPath('userData'), 'terminal-window.json');
const TERMINAL_SIZE = { width: 920, height: 640, minWidth: 480, minHeight: 300 };
const VIEWER_FILE = join(app.getPath('userData'), 'artifact-window.json');
const require = createRequire(import.meta.url);
const TERMINAL_ASSETS = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
};
const BUNDLE = app.isPackaged ? bundleOf(process.execPath) : null;
const MOVE = moveFor({ bundle: BUNDLE, appName: APP_NAME, oldName: OLD_APP_NAME, argv: process.argv });
const MOVE_FAILED = MOVE ? await moveToOwnName(MOVE) : null;
// Before the single instance lock, the first thing to write in the app's own folder, so the move still finds it empty.
const MOVED = migrateHome({ parts: ['config', 'state', 'logs', 'appData'], userData: app.getPath('userData') });
// $HOME, which Electron's own paths ignore, so the main process reads the config and writes the log the worker does.
const CONFIG_FILE = join(configDir(), 'config.json');
const LOG_DIR = logsDir();
const BADGE_MS = 10_000;
const QUIT_WAIT_MS = 3000;
const PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);

let host;
let worker;
let win = null;
let termWin = null;
let claudeOnTop = true;
let page = null;
let tray = null;
let trayState = '';
let quitting = false;
let startHidden = false;
const typedListeners = new Set();
// Loaded when Claude Code first starts, so a native module that will not load leaves the rest of the app working.
const terminal = createTerminal({
  spawn: (...args) => require('node-pty').spawn(...args),
  log: (text) => host?.ctx.log(text),
  onTyped: () => typedListeners.forEach((fn) => fn()),
  onWake: () => host?.run('claude'),
});

if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', reveal);
app.on('activate', reveal);
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', (event) => {
  event.preventDefault();
  globalShortcut.unregisterAll();
  terminal.end();
  const stopping = worker?.deactivate?.() ?? Promise.resolve();
  Promise.race([stopping, new Promise((resolve) => setTimeout(resolve, QUIT_WAIT_MS))]).finally(() => app.exit(0));
});
app.whenReady().then(start).catch((err) => {
  dialog.showErrorBox(`${APP_NAME} could not start`, err.stack ?? String(err));
  app.exit(1);
});

async function start() {
  startHidden = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;
  session.defaultSession.setPermissionRequestHandler((contents, permission, allow) => allow(PERMISSIONS.has(permission)));
  claudeOnTop = readSaved(CLAUDE_FILE).onTop !== false;
  listenToTerminal();
  const viewer = artifactViewer();
  const overlay = meetingOverlay();
  const windows = {
    showPage, focus: reveal, quit: () => app.quit(), popOut, dockClaude, claudeOnTop: keepClaudeOnTop, claudeState, openTerminal, restartTerminal, pasteTerminal: terminal.paste, onTerminalTyped, terminalAssets: terminalAssets(),
    openArtifact: viewer.open, openArtifactCopy: (spec) => openArtifactCopy(viewer, spec), showOverlay: () => overlay.show(windowUrl('meeting')), closeOverlay: overlay.close,
  };
  host = createHost({ Notification, openExternal: (url) => shell.openExternal(url), window: windows, logDir: LOG_DIR });
  logMoves(MOVED);
  if (MOVE_FAILED) host.ctx.log(`could not move ${MOVE.from} to ${MOVE.to}, so it runs where it is: ${MOVE_FAILED}`);
  worker = await import(pathToFileURL(join(WORKER_DIR, 'worker.mjs')).href);
  if (!(await activate())) return app.exit(0);
  host.bindShortcuts(globalShortcut, readConfig(CONFIG_FILE));
  Menu.setApplicationMenu(appMenu());
  tray = new Tray(join(APP_DIR, 'assets/trayTemplate.png'));
  tray.setToolTip(APP_NAME);
  await refreshTray();
  setInterval(refreshTray, BADGE_MS);
  tidyAfterMove({ argv: process.argv, bundle: BUNDLE, oldName: OLD_APP_NAME, appName: APP_NAME, appId: APP_ID })
    .then((done) => done && host.ctx.log(`removed ${done.removed}, which this copy was moved from${done.tiles ? ', and pointed its Dock tile here' : ''}`))
    .catch((err) => host.ctx.log(`could not remove the copy this one was moved from: ${err.message}`));
}

// Never returns once the helper has started: the copy it opens is this build under its own name.
async function moveToOwnName(move) {
  const at = (ext) => join(tmpdir(), `${FOLDER}-move-${process.pid}.${ext}`);
  try {
    await startHelper(moveJob(move, { pid: process.pid, result: at('json'), argv: process.argv }), at('log'));
  } catch (err) {
    return err.message;
  }
  app.exit(0);
  return new Promise(() => {});
}

function logMoves(moved) {
  for (const [part, { outcome, why, from, to }] of Object.entries(moved)) {
    if (outcome === 'moved') host.ctx.log(`moved ${from.join(' and ')} to ${to}`);
    if (outcome === 'waiting' || outcome === 'failed') host.ctx.log(`kept the ${part} where it was, as ${why}; it moves on a later start`);
  }
}

async function activate() {
  try {
    await worker.default(host.ctx);
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    const port = await askForAnotherPort(err.port);
    if (!port) return false;
    host.ctx.desktop.port = port;
    await worker.default(host.ctx);
  }
  return true;
}

async function askForAnotherPort(taken) {
  const [free, plugin] = await Promise.all([nextFreePort(taken), heldByOurWorker(taken)]);
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: `Port ${taken} is taken by ${plugin ? `another copy of ${APP_NAME}, most likely the Orca plugin` : 'another program'}.`,
    detail: plugin
      ? 'Turn the Orca plugin off (Orca, Settings, Plugins) while you use the app. Until then, full auto\'s lock stops the two driving at once.'
      : `Change "port" in ~/.config/${FOLDER}/config.json to keep the app off it.`,
    buttons: free ? [`Use port ${free}`, 'Quit'] : ['Quit'],
    defaultId: 0,
    cancelId: free ? 1 : 0,
  });
  return response === 0 ? free : null;
}

function showPage(url) {
  if (win) {
    reveal();
    return { reused: true };
  }
  page = new URL(url);
  win = createWindow(url);
  return { reused: false };
}

function reveal() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
}

const SAFE_PAGE = { contextIsolation: true, nodeIntegration: false, sandbox: true };

function keepOnPage(w, file) {
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (event, to) => {
    if (new URL(to).origin !== page.origin) event.preventDefault();
  });
  w.on('close', (event) => {
    writeFileSync(file, JSON.stringify({ ...readSaved(file), ...w.getNormalBounds() }));
    if (quitting) return;
    event.preventDefault();
    w.hide();
  });
}

function createWindow(url) {
  const w = new BrowserWindow({ width: 1400, height: 900, ...savedBounds(WINDOW_FILE), show: !startHidden, title: APP_NAME, webPreferences: terminalPage() });
  keepOnPage(w, WINDOW_FILE);
  w.loadURL(url);
  return w;
}

function readSaved(file) {
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function savedBounds(file) {
  return keptBounds(readSaved(file), () => screen.getAllDisplays().map((d) => d.workArea));
}

// The Claude Code window's page attaches itself when it shows, which takes the session from the panel.
function popOut() {
  if (!page) throw new Error('the worker has not shown its page yet');
  termWin ??= createTerminalWindow();
  termWin.show();
  termWin.focus();
  app.focus({ steal: true });
  return { shown: true };
}

function terminalPage() {
  return { ...SAFE_PAGE, preload: join(APP_DIR, 'terminal-preload.cjs'), additionalArguments: [`--cc-origin=${page.origin}`] };
}

// Above every window and on every Space, full screen apps included, which is what lets it be summoned over anything.
function floatOnTop(w, on) {
  w.setAlwaysOnTop(on, 'floating');
  w.setVisibleOnAllWorkspaces(on, { visibleOnFullScreen: on });
}

function keepClaudeOnTop(on) {
  claudeOnTop = on;
  if (termWin) floatOnTop(termWin, on);
  writeFileSync(CLAUDE_FILE, JSON.stringify({ ...readSaved(CLAUDE_FILE), onTop: on }));
  return claudeState();
}

function dockClaude() {
  termWin?.hide();
  reveal();
  return claudeState();
}

function claudeState() {
  return { shown: Boolean(termWin?.isVisible()), onTop: claudeOnTop };
}

// The pty lives here, not in either view, so hiding or closing one leaves Claude Code running.
function openTerminal(spec) {
  if (!page) throw new Error('the worker has not shown its page yet');
  terminal.start(spec);
  if (!termWin?.isVisible()) return reveal();
  termWin.focus();
  app.focus({ steal: true });
}

function restartTerminal(spec) {
  terminal.restart(spec);
}

function onTerminalTyped(fn) {
  typedListeners.add(fn);
  return () => typedListeners.delete(fn);
}

function createTerminalWindow() {
  const w = new BrowserWindow({ ...TERMINAL_SIZE, ...savedBounds(TERMINAL_FILE), show: false, title: 'Claude Code', fullscreenable: false, webPreferences: terminalPage() });
  floatOnTop(w, claudeOnTop);
  keepOnPage(w, TERMINAL_FILE);
  w.on('page-title-updated', (event) => event.preventDefault());
  w.on('closed', () => {
    terminal.detach('window');
    termWin = null;
  });
  w.loadURL(windowUrl('terminal'));
  return w;
}

function windowUrl(kind) {
  if (!page) throw new Error('the worker has not shown its page yet');
  const url = new URL(page);
  url.searchParams.set('window', kind);
  url.hash = '';
  return url.href;
}

function meetingOverlay() {
  return createOverlay({
    electron: { BrowserWindow, screen },
    safePage: SAFE_PAGE,
    reducedMotion: () => systemPreferences.getAnimationSettings().prefersReducedMotion,
    log: (text) => host?.ctx.log(text),
  });
}

// A checkout that has not run npm run setup since the terminal came only loses the terminal, which says its files did not load.
function terminalAssets() {
  try {
    return Object.fromEntries(Object.entries(TERMINAL_ASSETS).map(([name, id]) => [name, require.resolve(id)]));
  } catch {
    return {};
  }
}

const live = (w) => (w && !w.isDestroyed() ? w.webContents : null);

function listenToTerminal() {
  const viewOf = (event) => bridgeView(event, { panel: live(win), window: live(termWin) }, page?.origin);
  const sendTo = (contents) => (data) => !contents.isDestroyed() && contents.send('terminal:data', data);
  ipcMain.on('terminal:attach', (event, cols, rows) => {
    const id = viewOf(event);
    if (id) terminal.attach(id, sendTo(event.sender), cols, rows);
  });
  ipcMain.on('terminal:write', (event, data) => terminal.write(viewOf(event), data));
  ipcMain.on('terminal:resize', (event, cols, rows) => terminal.resize(viewOf(event), cols, rows));
}

function artifactViewer() {
  return createViewer({
    electron: { BrowserWindow, WebContentsView, session, ipcMain, clipboard },
    safePage: SAFE_PAGE,
    toolbar: join(APP_DIR, 'viewer.html'),
    preload: join(APP_DIR, 'viewer-preload.cjs'),
    chromeVersion: process.versions.chrome,
    openExternal: (url) => host.ctx.desktop.openExternal(url),
    saved: { bounds: () => savedBounds(VIEWER_FILE), read: () => readSaved(VIEWER_FILE), write: (value) => writeFileSync(VIEWER_FILE, JSON.stringify(value)) },
    floatOnTop,
    focusApp: () => app.focus({ steal: true }),
    log: (text) => host?.ctx.log(text),
  });
}

function openArtifactCopy(viewer, spec) {
  if (!page) throw new Error('the worker has not shown its page yet');
  return viewer.openCopy({ ...spec, origin: page.origin });
}

function appMenu() {
  return Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, host.settingsItem(), { type: 'separator' }, ...host.menuItems(), { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: host.viewMenu() },
    { role: 'windowMenu' },
  ]);
}

async function refreshTray() {
  const badge = await askWorker('GET', '/api/badge').catch(() => ({ count: 0, paused: null }));
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  const state = JSON.stringify({ ...badge, openAtLogin });
  if (state === trayState) return;
  trayState = state;
  tray.setTitle(badge.count ? String(badge.count) : '');
  tray.setToolTip(badge.count ? `${APP_NAME}: ${badge.count} need${badge.count === 1 ? 's' : ''} you` : APP_NAME);
  tray.setContextMenu(trayMenu(badge.paused, openAtLogin));
}

function trayMenu(paused, openAtLogin) {
  return Menu.buildFromTemplate([
    ...host.menuItems(),
    ...host.shortcutNote(),
    { type: 'separator' },
    { label: 'Pause full auto', type: 'checkbox', checked: paused === true, enabled: paused !== null, click: togglePause },
    { label: 'Launch at login', type: 'checkbox', checked: openAtLogin, enabled: app.isPackaged, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, role: 'quit' },
  ]);
}

function togglePause() {
  askWorker('POST', '/api/matrix/pause')
    .catch((err) => host.ctx.log(`could not pause or resume full auto: ${err.message}`))
    .finally(refreshTray);
}

// Over HTTP with the page's token and origin, so the menu bar passes the same checks a click on the page does.
async function askWorker(method, path) {
  if (!page) throw new Error('the worker has not shown its page yet');
  const headers = { 'x-cc-token': page.searchParams.get('t'), origin: page.origin, 'content-type': 'application/json' };
  const res = await fetch(page.origin + path, { method, headers, body: method === 'POST' ? '{}' : undefined });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}
