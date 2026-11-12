export const LEVEL = 'screen-saver';
// A panel sits over another app's full-screen Space and takes keys without activating the app; a plain window moves you off that Space.
export const COVER = {
  type: 'panel', frame: false, transparent: true, backgroundColor: '#00000000', vibrancy: 'fullscreen-ui', visualEffectState: 'active', roundedCorners: false,
  hasShadow: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false, title: 'Meeting',
};
export const ON_EVERY_SPACE = { visibleOnFullScreen: true, skipTransformProcessType: true };
const FADE_MS = 240;
const FADE_STEPS = 12;

export function createOverlay({ electron: { BrowserWindow, screen }, safePage, reducedMotion = () => false, log = () => {} }) {
  const covers = new Map();
  let url = null;

  screen.on('display-added', (_event, display) => url && cover(display));
  screen.on('display-removed', (_event, display) => drop(display.id));
  screen.on('display-metrics-changed', (_event, display) => covers.get(display.id)?.setBounds(display.bounds));

  function show(next) {
    url = next;
    for (const display of screen.getAllDisplays()) cover(display);
    return { shown: covers.size };
  }

  function cover(display) {
    if (covers.has(display.id)) return;
    const w = new BrowserWindow({ ...COVER, ...display.bounds, webPreferences: { ...safePage } });
    w.setAlwaysOnTop(true, LEVEL);
    w.setVisibleOnAllWorkspaces(true, ON_EVERY_SPACE);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', (event) => event.preventDefault());
    w.webContents.once('did-finish-load', () => reveal(w, display.id));
    w.on('closed', () => closedBy(w, display.id));
    covers.set(display.id, w);
    w.loadURL(url).catch((err) => log(`the meeting reminder did not load: ${err.message}`));
  }

  // Only one window can have the keys, so it is the one on the display under the pointer.
  function reveal(w, id) {
    if (w.isDestroyed()) return;
    fadeIn(w);
    if (id === screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id) w.show();
    else w.showInactive();
  }

  function fadeIn(w) {
    if (reducedMotion()) return;
    w.setOpacity(0);
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      if (!w.isDestroyed()) w.setOpacity(step / FADE_STEPS);
      if (step >= FADE_STEPS || w.isDestroyed()) clearInterval(timer);
    }, FADE_MS / FADE_STEPS);
  }

  function close() {
    url = null;
    const windows = [...covers.values()];
    covers.clear();
    for (const w of windows) if (!w.isDestroyed()) w.destroy();
    return { closed: windows.length };
  }

  function drop(id) {
    const w = covers.get(id);
    covers.delete(id);
    if (w && !w.isDestroyed()) w.destroy();
  }

  // One closed some other way, such as Cmd+W, takes the rest with it, as acting on any one does.
  function closedBy(w, id) {
    if (covers.get(id) !== w) return;
    covers.delete(id);
    close();
  }

  return { show, close };
}
