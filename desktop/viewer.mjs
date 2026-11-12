export const LIVE_PARTITION = 'persist:claude-ai';
export const COPY_PARTITION = 'artifact-copy';
export const SIGN_IN_HOSTS = ['accounts.google.com', 'appleid.apple.com'];
export const LIVE_HOSTS = ['claude.ai', ...SIGN_IN_HOSTS];
export const BAR = 40;
export const HINT = 48;
const SIZE = { width: 1100, height: 820, minWidth: 560, minHeight: 320 };
const POPUP = { width: 520, height: 700 };
const PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

export function chromeUserAgent(chromeVersion) {
  const major = String(chromeVersion).split('.')[0];
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function parse(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

const httpsOn = (hosts) => (url) => {
  const u = parse(url);
  return u?.protocol === 'https:' && hosts.includes(u.host);
};

// Google's sign-in sets its session through hops on its other account hosts, and one sent to the browser leaves the consent page failing.
const SIGN_IN_HOPS = [/^accounts\.youtube\.com$/, /^accounts\.google\.[a-z]{2,3}(?:\.[a-z]{2})?$/, /^idmsa\.apple\.com$/];

function signInHop(url) {
  const u = parse(url);
  if (u?.protocol !== 'https:' || u.port || u.username || u.password) return false;
  if (u.host === 'www.google.com') return u.pathname.startsWith('/accounts/');
  return SIGN_IN_HOPS.some((host) => host.test(u.host));
}

const onLiveHost = httpsOn(LIVE_HOSTS);
export const liveAllows = (url) => onLiveHost(url) || signInHop(url);
const popupAllows = httpsOn(SIGN_IN_HOSTS);
const onClaude = httpsOn(['claude.ai']);

function mustBeArtifact(url) {
  if (!onClaude(url)) throw new Error('only a claude.ai link opens in the artifact window');
}

function copyAllows(copyUrl) {
  const folder = new URL('./', copyUrl).href;
  return (url) => typeof url === 'string' && url.startsWith(folder);
}

export function signingIn(url) {
  const u = parse(url);
  if (!u) return false;
  return SIGN_IN_HOSTS.includes(u.host) || (u.host === 'claude.ai' && u.pathname.startsWith('/login'));
}

export function createViewer({ electron, safePage, toolbar, preload, chromeVersion, openExternal, saved, floatOnTop, focusApp, log = () => {} }) {
  const { BrowserWindow, WebContentsView, session, ipcMain, clipboard } = electron;
  let win = null;
  let content = null;
  let shown = null;
  let onTop = saved.read().onTop === true;

  const live = session.fromPartition(LIVE_PARTITION);
  live.setUserAgent(chromeUserAgent(chromeVersion));
  for (const ses of [live, session.fromPartition(COPY_PARTITION)]) ses.setPermissionRequestHandler((contents, permission, allow) => allow(PERMISSIONS.has(permission)));

  const verbs = {
    back: () => history()?.goBack(),
    forward: () => history()?.goForward(),
    reload: () => content?.view.webContents.reload(),
    copy: () => clipboard.writeText(shown.url),
    browser: () => sendOut(shown.url),
    top: () => keepOnTop(!onTop),
  };
  const fromToolbar = (event) => Boolean(win) && !win.isDestroyed() && event.sender === win.webContents;
  ipcMain.on('viewer:ready', (event) => fromToolbar(event) && tell());
  ipcMain.on('viewer:run', (event, verb) => fromToolbar(event) && shown && Object.hasOwn(verbs, verb) && verbs[verb]());

  function open({ url, title }) {
    mustBeArtifact(url);
    return show({ kind: 'live', url, title, load: url, allows: liveAllows });
  }

  function openCopy({ url, title, path, origin }) {
    mustBeArtifact(url);
    const copyUrl = new URL(path, origin);
    if (copyUrl.origin !== origin || !copyUrl.pathname.startsWith('/preview/')) throw new Error('a kept copy loads only from the app\'s own preview');
    return show({ kind: 'copy', url, title, load: copyUrl.href, allows: copyAllows(copyUrl.href) });
  }

  function show(next) {
    shown = next;
    win ??= createWindow();
    if (content?.kind !== next.kind) swapContent(next.kind);
    content.view.webContents.loadURL(next.load).catch((err) => log(`the artifact window did not finish loading: ${err.message}`));
    win.setTitle(next.title);
    changed();
    win.show();
    win.focus();
    focusApp();
    return { shown: true };
  }

  function createWindow() {
    const w = new BrowserWindow({ ...SIZE, ...saved.bounds(), show: false, title: 'Artifact', titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 13 }, webPreferences: { ...safePage, preload } });
    floatOnTop(w, onTop);
    w.on('page-title-updated', (event) => event.preventDefault());
    w.on('resize', layout);
    w.on('close', () => saved.write({ ...saved.read(), ...w.getNormalBounds(), onTop }));
    w.on('closed', () => {
      closeContent();
      win = null;
    });
    w.loadFile(toolbar);
    return w;
  }

  // A view's partition is fixed when it is made, so moving between the live page and a copy takes a new view.
  function swapContent(kind) {
    closeContent();
    const view = new WebContentsView({ webPreferences: { ...safePage, partition: kind === 'live' ? LIVE_PARTITION : COPY_PARTITION } });
    guard(view.webContents, (url) => shown.allows(url), kind === 'live');
    view.webContents.on('did-navigate', changed);
    view.webContents.on('did-navigate-in-page', changed);
    win.contentView.addChildView(view);
    content = { kind, view };
  }

  // A view's page lives on after its window closes unless it is closed too.
  function closeContent() {
    if (!content) return;
    if (win && !win.isDestroyed()) win.contentView.removeChildView(content.view);
    if (!content.view.webContents.isDestroyed()) content.view.webContents.close();
    content = null;
  }

  function guard(contents, allows, signInPopups) {
    contents.setWindowOpenHandler(({ url }) => {
      // Google's sign-in is a popup that hands its code back to the page that opened it, so it has to stay in the app.
      if (signInPopups && popupAllows(url)) return { action: 'allow', overrideBrowserWindowOptions: { ...POPUP, parent: win } };
      sendOut(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event) => keepIn(event, allows));
    contents.on('will-redirect', (event) => event.isMainFrame && keepIn(event, allows));
    if (signInPopups) contents.on('did-create-window', (popup) => guard(popup.webContents, liveAllows, false));
  }

  function keepIn(event, allows) {
    if (allows(event.url)) return;
    event.preventDefault();
    sendOut(event.url);
  }

  function sendOut(url) {
    const host = parse(url)?.host || 'a link';
    Promise.resolve()
      .then(() => openExternal(url))
      .then(() => log(`sent ${host} from the artifact window to your browser`), (err) => log(`kept ${host} out of the artifact window: ${err.message}`));
  }

  function history() {
    return content?.view.webContents.navigationHistory;
  }

  const hinting = () => content?.kind === 'live' && signingIn(content.view.webContents.getURL());

  function layout() {
    if (!win || !content) return;
    const { width, height } = win.getContentBounds();
    const top = BAR + (hinting() ? HINT : 0);
    content.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }

  function changed() {
    layout();
    tell();
  }

  function tell() {
    if (!win || win.isDestroyed()) return;
    const where = content?.kind === 'copy' ? 'kept copy' : (parse(content?.view.webContents.getURL())?.host ?? '');
    win.webContents.send('viewer:state', {
      title: shown?.title ?? '',
      where,
      canGoBack: Boolean(history()?.canGoBack()),
      canGoForward: Boolean(history()?.canGoForward()),
      onTop,
      hint: hinting(),
      bar: BAR,
      hintHeight: HINT,
    });
  }

  function keepOnTop(on) {
    onTop = on;
    if (win) floatOnTop(win, on);
    saved.write({ ...saved.read(), onTop });
    tell();
  }

  return { open, openCopy, keepOnTop };
}
