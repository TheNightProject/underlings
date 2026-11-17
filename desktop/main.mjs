import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, Notification, screen, session, shell, systemPreferences, Tray, utilityProcess, WebContentsView } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHelper } from '../lib/apphelper.mjs';
import { configDirOf, engineStateDirOf, logsDir, migrateHome, OLD_APP_NAME, sharedConfigDir } from '../lib/home.mjs';
import { APP_ID, APP_NAME, FOLDER } from '../lib/product.mjs';
import { DEFAULT_ID, DEFAULT_PORT, readWorkspaces, workspacesFile } from '../lib/workspaces.mjs';
import { COMMANDS, createHost, heldByOurWorker, isFree, logTo, nextFreePort, readConfig } from './host.mjs';
import { keptBounds } from './bounds.mjs';
import { createOverlay } from './overlay.mjs';
import { createSupervisor } from './supervisor.mjs';
import { createWorkspaceAdmin } from './workspaceadmin.mjs';
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
const CONFIG_FILE = join(sharedConfigDir(), 'config.json');
const LOG_DIR = logsDir();
const BADGE_MS = 10_000;
const QUIT_WAIT_MS = 3000;
const PERMISSIONS = new Set(['notifications', 'clipboard-sanitized-write']);

let host;
let supervisor;
let workspaces = [];
// The workspace whose page the window shows, and the page each worker gave when it started.
let active = DEFAULT_ID;
const pages = new Map();
const counts = new Map();
let admin;
let win = null;
let termWin = null;
let claudeOnTop = true;
let page = null;
let tray = null;
let trayState = '';
let quitting = false;
let startHidden = false;
// One Claude Code per workspace, each running as that workspace's account; the windows show the one whose page is in front.
const terminals = new Map();

if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', reveal);
app.on('activate', reveal);
// The app lives in the menu bar, so closing or swapping its last window is never a quit.
app.on('window-all-closed', () => {});
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', (event) => {
  event.preventDefault();
  globalShortcut.unregisterAll();
  for (const { terminal } of terminals.values()) terminal.end();
  const stopping = supervisor?.stop() ?? Promise.resolve();
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
    showPage, focus: reveal, quit: () => app.quit(), popOut, dockClaude, claudeOnTop: keepClaudeOnTop, claudeState, openTerminal: () => {}, restartTerminal: () => {}, pasteTerminal: () => {}, onTerminalTyped: () => () => {}, terminalAssets: terminalAssets(),
    openArtifact: viewer.open, openArtifactCopy: (spec) => openArtifactCopy(viewer, spec), showOverlay: () => overlay.show(windowUrl('meeting')), closeOverlay: overlay.close,
  };
  host = createHost({ Notification, openExternal: (url) => shell.openExternal(url), window: windows, logDir: LOG_DIR });
  logMoves(MOVED);
  if (MOVE_FAILED) host.ctx.log(`could not move ${MOVE.from} to ${MOVE.to}, so it runs where it is: ${MOVE_FAILED}`);
  workspaces = readWorkspaces({ defaultPort: readConfig(CONFIG_FILE).port ?? DEFAULT_PORT, log: host.ctx.log });
  supervisor = createSupervisor({ fork: (...args) => utilityProcess.fork(...args), entry: join(APP_DIR, 'workspace.mjs'), workerDir: WORKER_DIR, desktopFor, logFor });
  admin = createWorkspaceAdmin({ workspaces, file: workspacesFile(), supervisor, folders: { config: configDirOf, engine: engineStateDirOf }, isFree, agentsRunning, onChange: workspacesChanged });
  for (const id of [...Object.keys(COMMANDS), 'goto']) host.ctx.commands.register(id, (...args) => supervisor.get(active)?.bridge.run(id, ...args));
  if (!(await startDefault())) return app.exit(0);
  for (const workspace of workspaces.slice(1)) supervisor.start(workspace);
  host.bindShortcuts(globalShortcut, readConfig(CONFIG_FILE));
  supervisor.keep('hotkeys', host.ctx.desktop.hotkeys);
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

async function startDefault(port) {
  const { ok, error } = await supervisor.start(workspaces[0], { port }).ready;
  if (ok) return true;
  if (error.code !== 'EADDRINUSE') throw Object.assign(new Error(error.message), { stack: error.stack ?? error.message });
  const free = await askForAnotherPort(error.port);
  return free ? startDefault(free) : false;
}

// What every worker is given, less where its page goes and whose banners these are, which are its own.
function desktopFor(workspace) {
  const own = workspace.id !== DEFAULT_ID;
  return {
    ...host.ctx.desktop,
    port: own ? workspace.port : undefined,
    showPage: (url) => showPageOf(workspace, url),
    notify: (banner) => host.ctx.desktop.notify(workspaces.length > 1 ? { ...banner, title: `${workspace.name}: ${banner.title}` } : banner),
    openTerminal: (spec) => openTerminal(workspace, spec),
    restartTerminal: (spec) => restartTerminal(workspace, spec),
    pasteTerminal: (text) => terminalOf(workspace.id).terminal.paste(text),
    onTerminalTyped: (fn) => onTerminalTyped(workspace, fn),
    workspaces: () => workspacesView(workspace.id),
    switchWorkspace: ({ id } = {}) => switchToId(id),
    createWorkspace: (body) => admin.create(body),
    updateWorkspace: (body) => admin.update(body),
    removeWorkspace: (body) => removeWorkspace(body),
  };
}

// Every workspace, as the one asking sees it: which is in front, which is its own, and what each needs.
function workspacesView(asking) {
  return {
    workspaces: workspaces.map(({ id, name, colour, account, port }) => ({
      id, name, colour, account, port, count: counts.get(id) ?? 0, state: supervisor.get(id)?.state ?? 'stopped', active: id === active, here: id === asking,
    })),
  };
}

function switchToId(id) {
  const workspace = workspaces.find((w) => w.id === id);
  if (!workspace) throw Object.assign(new Error(`there is no workspace ${id}`), { status: 404 });
  if (id === active) {
    reveal();
    return { ok: true, text: `${workspace.name} is in front` };
  }
  const at = pages.get(id);
  if (!at) throw Object.assign(new Error(`${workspace.name} has not started yet`), { status: 409 });
  switchTo(workspace, at.origin + at.pathname + at.search);
  return { ok: true, text: `Switched to ${workspace.name}` };
}

async function removeWorkspace(body) {
  const answer = await admin.remove(body);
  pages.delete(body.id);
  counts.delete(body.id);
  terminals.get(body.id)?.terminal.end();
  terminals.delete(body.id);
  if (active === body.id) switchToId(DEFAULT_ID);
  return answer;
}

async function agentsRunning(id) {
  const at = pages.get(id);
  if (!at) return 0;
  const state = await askWorker(at, 'GET', '/api/state');
  return (state.agents ?? []).filter((a) => a.alive).length;
}

// Each page lists every workspace, so each worker is told to tell its pages when one changes.
function workspacesChanged() {
  for (const worker of supervisor.all()) if (worker.state === 'running') worker.bridge.run('changed', 'workspaces');
  trayState = '';
  refreshTray();
}

function logFor(workspace) {
  return workspace.id === DEFAULT_ID ? host.ctx.log : logTo(LOG_DIR, `${FOLDER}-${workspace.id}`);
}

// A worker shows its page once as it starts, which only Default's opens; after that, a page asked for is a switch to its workspace.
function showPageOf(workspace, url) {
  const starting = supervisor.get(workspace.id)?.state === 'starting';
  if (starting) pages.set(workspace.id, new URL(url));
  if (starting && win && workspace.id === active) return { reused: true };
  if (workspace.id === active) return showPage(url);
  if (starting) return { reused: false };
  return switchTo(workspace, url);
}

// The window's preloads are told the page's origin when it is made, so a page from another worker gets windows of its own.
function switchTo(workspace, url) {
  active = workspace.id;
  page = new URL(url);
  for (const { terminal } of terminals.values()) ['panel', 'window'].forEach((id) => terminal.detach(id));
  const [oldWin, oldTermWin] = [win, termWin];
  if (oldWin) writeFileSync(WINDOW_FILE, JSON.stringify({ ...readSaved(WINDOW_FILE), ...oldWin.getNormalBounds() }));
  startHidden = false;
  win = createWindow(url);
  termWin = null;
  reveal();
  oldTermWin?.destroy();
  oldWin?.destroy();
  if (oldTermWin) shareClaudeState();
  refreshTray();
  return { reused: false };
}

async function askForAnotherPort(taken) {
  const [free, ours] = await Promise.all([nextFreePort(taken), heldByOurWorker(taken)]);
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: `Port ${taken} is taken by ${ours ? `another copy of ${APP_NAME}, such as one run from a checkout` : 'another program'}.`,
    detail: ours
      ? 'Quit the other copy while you use this one. Until then, full auto\'s lock stops the two driving at once.'
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
  shareClaudeState();
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
  shareClaudeState();
  return claudeState();
}

function dockClaude() {
  termWin?.hide();
  reveal();
  shareClaudeState();
  return claudeState();
}

function claudeState() {
  return { shown: Boolean(termWin?.isVisible()), onTop: claudeOnTop };
}

// Each worker reads this without waiting, so it is handed every change.
function shareClaudeState() {
  supervisor?.keep('claudeWindow', claudeState());
}

// The pty lives here, not in either view, so hiding or closing one leaves Claude Code running.
// Loaded when Claude Code first starts, so a native module that will not load leaves the rest of the app working.
function terminalOf(id) {
  if (!terminals.has(id)) {
    const typed = new Set();
    const workspace = workspaces.find((w) => w.id === id);
    const terminal = createTerminal({
      spawn: (...args) => require('node-pty').spawn(...args),
      log: (text) => (workspace ? logFor(workspace) : host.ctx.log)(text),
      onTyped: () => typed.forEach((fn) => fn()),
      onWake: () => supervisor.get(id)?.bridge.run('claude'),
    });
    terminals.set(id, { terminal, typed });
  }
  return terminals.get(id);
}

function openTerminal(workspace, spec) {
  if (!page) throw new Error('the worker has not shown its page yet');
  if (workspace.id !== active) switchToId(workspace.id);
  terminalOf(workspace.id).terminal.start(spec);
  if (!termWin?.isVisible()) return reveal();
  termWin.focus();
  app.focus({ steal: true });
}

function restartTerminal(workspace, spec) {
  terminalOf(workspace.id).terminal.restart(spec);
}

function onTerminalTyped(workspace, fn) {
  const { typed } = terminalOf(workspace.id);
  typed.add(fn);
  return () => typed.delete(fn);
}

function createTerminalWindow() {
  const w = new BrowserWindow({ ...TERMINAL_SIZE, ...savedBounds(TERMINAL_FILE), show: false, title: 'Claude Code', fullscreenable: false, webPreferences: terminalPage() });
  floatOnTop(w, claudeOnTop);
  keepOnPage(w, TERMINAL_FILE);
  w.on('page-title-updated', (event) => event.preventDefault());
  w.on('closed', () => {
    terminals.get(active)?.terminal.detach('window');
    termWin = null;
    shareClaudeState();
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
    if (id) terminalOf(active).terminal.attach(id, sendTo(event.sender), cols, rows);
  });
  ipcMain.on('terminal:write', (event, data) => terminalOf(active).terminal.write(viewOf(event), data));
  ipcMain.on('terminal:resize', (event, cols, rows) => terminalOf(active).terminal.resize(viewOf(event), cols, rows));
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

// One count for every workspace, and full auto paused only when it is paused in all of them.
async function badges() {
  const each = await Promise.all([...pages].map(([id, at]) => askWorker(at, 'GET', '/api/badge').then((b) => ({ id, ...b }), () => ({ id, count: 0, paused: null }))));
  const moved = each.some((b) => (counts.get(b.id) ?? 0) !== (b.count ?? 0));
  for (const b of each) counts.set(b.id, b.count ?? 0);
  if (moved && workspaces.length > 1) for (const worker of supervisor.all()) if (worker.state === 'running') worker.bridge.run('changed', 'workspaces');
  return each;
}

async function refreshTray() {
  if (!tray) return;
  const each = await badges();
  const known = each.filter((b) => b.paused !== null);
  const badge = { count: each.reduce((n, b) => n + (b.count ?? 0), 0), paused: known.length ? known.every((b) => b.paused) : null };
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  const state = JSON.stringify({ ...badge, openAtLogin, active, workspaces: workspaces.map((w) => [w.id, w.name, counts.get(w.id) ?? 0]) });
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
    ...trayWorkspaces(),
    { type: 'separator' },
    { label: 'Pause full auto', type: 'checkbox', checked: paused === true, enabled: paused !== null, click: togglePause },
    { label: 'Launch at login', type: 'checkbox', checked: openAtLogin, enabled: app.isPackaged, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, role: 'quit' },
  ]);
}

function trayWorkspaces() {
  if (workspaces.length < 2) return [];
  const switchTo = (id) => {
    try {
      switchToId(id);
    } catch (err) {
      host.ctx.log(`could not switch workspace: ${err.message}`);
    }
  };
  return [
    { type: 'separator' },
    ...workspaces.map((w) => ({ label: counts.get(w.id) ? `${w.name} (${counts.get(w.id)})` : w.name, type: 'radio', checked: w.id === active, click: () => switchTo(w.id) })),
  ];
}

// The page's pause flips one workspace; the menu bar's pauses or resumes them all, so each one not already there is flipped.
async function togglePause() {
  const at = [...pages.values()];
  const each = await badges();
  const pause = !each.filter((b) => b.paused !== null).every((b) => b.paused);
  await Promise.all(at.map((url, i) => (each[i].paused === null || each[i].paused === pause ? null : askWorker(url, 'POST', '/api/matrix/pause'))))
    .catch((err) => host.ctx.log(`could not pause or resume full auto: ${err.message}`))
    .finally(refreshTray);
}

// Over HTTP with the page's token and origin, so the menu bar passes the same checks a click on the page does.
async function askWorker(at, method, path) {
  const headers = { 'x-cc-token': at.searchParams.get('t'), origin: at.origin, 'content-type': 'application/json' };
  const res = await fetch(at.origin + path, { method, headers, body: method === 'POST' ? '{}' : undefined });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}
