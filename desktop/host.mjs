import { readFileSync } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { APP_NAME, FOLDER } from '../lib/product.mjs';

export const COMMANDS = {
  open: { label: `Open ${APP_NAME}` },
  latest: { label: 'Open what needs me', accelerator: 'CommandOrControl+Shift+J' },
  claude: { label: 'Open Claude Code' },
};
// Cmd+Shift+. is Finder's show hidden files, in every open and save panel too, so the default is a chord macOS itself leaves free.
export const SHOW_SHORTCUT = 'Control+Alt+Command+K';
export const CLAUDE_SHORTCUT = 'Control+Alt+Command+C';
export const VIEW_MENU = [
  ['Overview', 'overview', 'CommandOrControl+1'],
  ['Needs you', 'needs-you', 'CommandOrControl+2'],
  ['Merge requests', 'merge-requests', 'CommandOrControl+3'],
  ['Review queue', 'review-queue', 'CommandOrControl+4'],
  ['Tickets', 'tickets', 'CommandOrControl+5'],
  ['Standup', 'standup', 'CommandOrControl+6'],
  ['Agents', 'agents', 'CommandOrControl+7'],
  ['Full auto', 'full-auto', 'CommandOrControl+8'],
  ['Watching', 'watching', 'CommandOrControl+9'],
  ['Artifacts', 'artifacts'],
  ['Review runs', 'review-runs'],
  ['Leaderboard', 'leaderboard'],
];
export const PAGE_MENU = [
  ['Jump to…', 'jump', 'CommandOrControl+K'],
  ['Keyboard Shortcuts', 'keys', 'CommandOrControl+/'],
  ['Settings…', 'settings', 'CommandOrControl+,'],
];
const KEPT_BANNERS = 50;
const PORT_TRIES = 20;

// The slice of Orca's plugin context the worker uses, plus `desktop`, which is how the worker knows it runs in the app.
export function createHost({ Notification, openExternal, window, logDir }) {
  const commands = new Map();
  const banners = new Set();
  const log = logTo(logDir);

  let bound = {};

  function run(id, ...args) {
    return Promise.resolve()
      .then(() => commands.get(id)?.(...args))
      .catch((err) => log(`${COMMANDS[id]?.label ?? id} failed: ${err.message}`));
  }

  function bindShortcuts(globalShortcut, config) {
    const wanted = { open: showShortcut(config), latest: COMMANDS.latest.accelerator, claude: claudeShortcut(config) };
    bound = Object.fromEntries(Object.entries(wanted).map(([id, accelerator]) => [id, bindOne(globalShortcut, accelerator, () => run(id))]));
    for (const [id, { accelerator, registered, why }] of Object.entries(bound)) if (accelerator && !registered) log(`could not take ${accelerator} for ${COMMANDS[id].label}: ${why}`);
    const menu = [...VIEW_MENU, ...PAGE_MENU.slice(1)].filter(([, , accelerator]) => accelerator);
    ctx.desktop.hotkeys = { show: bound.open, claude: bound.claude, menu: menu.map(([label, , accelerator]) => [label.replace('…', ''), accelerator]) };
    return bound;
  }

  function notify({ title, body, open }) {
    if (!Notification.isSupported()) throw new Error('macOS will not show notifications for the app');
    const banner = new Notification({ title, body });
    keep(banner);
    banner.on('click', () => {
      banners.delete(banner);
      Promise.resolve().then(open).catch((err) => log(`could not open what a banner named: ${err.message}`));
    });
    banner.show();
    return { delivered: true };
  }

  // Electron drops a notification's click handler once nothing holds the notification.
  function keep(banner) {
    banners.add(banner);
    if (banners.size > KEPT_BANNERS) banners.delete(banners.values().next().value);
  }

  async function openLink(url) {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) throw Object.assign(new Error('only http and https links open in the browser'), { status: 400 });
    await openExternal(url);
    return { ok: true, text: 'Opened in your browser' };
  }

  const ctx = {
    log,
    commands: { register: (id, handler) => commands.set(id, handler) },
    host: { call: async () => undefined },
    desktop: { port: undefined, showPage: window.showPage, focus: window.focus, quit: window.quit, notify, openExternal: openLink, openArtifact: window.openArtifact, openArtifactCopy: window.openArtifactCopy, showOverlay: window.showOverlay, closeOverlay: window.closeOverlay, ...claudeWindow(window) },
  };

  const menuItems = () =>
    Object.entries(COMMANDS)
      .filter(([id]) => commands.has(id))
      .map(([id, { label, accelerator }]) => ({ label, accelerator: bound[id]?.registered ? bound[id].accelerator : accelerator, click: () => run(id) }));

  // The page handles Cmd+K itself and stops it, so the menu's copy only answers a click or a page that has not loaded.
  const viewMenu = () => [
    ...VIEW_MENU.flatMap(([label, target, accelerator], i) => [
      !accelerator && VIEW_MENU[i - 1][2] ? { type: 'separator' } : null,
      { label, accelerator, click: () => run('goto', target) },
    ].filter(Boolean)),
    { type: 'separator' },
    ...PAGE_MENU.slice(0, 2).map(([label, target, accelerator]) => ({ label, accelerator, click: () => run('goto', target) })),
    { type: 'separator' },
    { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' },
    { type: 'separator' },
    { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  const settingsItem = () => {
    const [label, target, accelerator] = PAGE_MENU[2];
    return { label, accelerator, click: () => run('goto', target) };
  };

  const shortcutNote = () => {
    const show = bound.open;
    return show?.accelerator && !show.registered ? [{ label: `No shortcut shows this window: ${show.why}`, enabled: false }] : [];
  };

  return { ctx, run, menuItems, viewMenu, settingsItem, bindShortcuts, shortcutNote };
}

export function readConfig(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function showShortcut(config) {
  return config.showShortcut === undefined ? SHOW_SHORTCUT : config.showShortcut || null;
}

export function claudeShortcut(config) {
  return config.claudeShortcut === undefined ? CLAUDE_SHORTCUT : config.claudeShortcut || null;
}

// Only a main process that can make the windows passes these, so the worker offers the pop out and the terminal only then.
function claudeWindow({ popOut, dockClaude, claudeOnTop, claudeState, openTerminal, restartTerminal, pasteTerminal, onTerminalTyped, terminalAssets }) {
  if (typeof popOut !== 'function') return {};
  const terminal = typeof openTerminal === 'function' ? { openTerminal, restartTerminal, pasteTerminal, onTerminalTyped, terminalAssets } : {};
  return { popOut, dockClaude, claudeOnTop, claudeWindow: claudeState, ...terminal };
}

function bindOne(globalShortcut, accelerator, handler) {
  if (!accelerator) return { accelerator: null, registered: false, why: 'turned off in config.json' };
  try {
    return globalShortcut.register(accelerator, handler)
      ? { accelerator, registered: true, why: null }
      : { accelerator, registered: false, why: 'macOS would not give it to the app' };
  } catch (err) {
    return { accelerator, registered: false, why: `it is not a shortcut Electron understands (${err.message})` };
  }
}

function logTo(dir) {
  const file = join(dir, `${FOLDER}.log`);
  let writing = mkdir(dir, { recursive: true });
  return (text) => {
    writing = writing.then(() => appendFile(file, `${new Date().toISOString()} ${text}\n`)).catch(() => {});
  };
}

export async function nextFreePort(taken) {
  for (let port = taken + 1; port <= taken + PORT_TRIES; port += 1) if (await isFree(port)) return port;
  return null;
}

function isFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer().once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

// A worker of this app, under any of its names, answers a request without its token in these words, which tells the Orca plugin apart from any other program.
export async function heldByOurWorker(port) {
  const said = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text(), () => '');
  return said === 'missing token';
}
