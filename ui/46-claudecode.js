const TERMINAL_WINDOW = new URLSearchParams(location.search).get('window') === 'terminal';
const TERMINAL_FILES = ['xterm.css', 'xterm.js', 'addon-fit.js', 'addon-web-links.js'];
const TERMINAL_COLOURS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const TERMINAL_FONT_PX = 13;
const TERMINAL_SCROLLBACK = 10000;
const claudeCode = { term: null, fit: null, screen: null, mounting: null };

function terminalWindowOnly() {
  return TERMINAL_WINDOW;
}

function claudeCodeHere() {
  return Boolean(state?.claudeCode?.available && window.ccTerminal);
}

function openClaudeCode() {
  return slot('openClaudePanel');
}

function claudeCodeNeedsCard(i) {
  return el('div', { class: 'agent s-need', 'data-kind': 'claude-code' },
    el('span', { class: 'avatar', title: 'Claude Code' }, icon('terminal')),
    el('div', { class: 'row-head' }, el('span', { class: 'title' }, i.title)),
    el('div', { class: 'text' }, i.why),
    el('div', { class: 'actions' }, el('button', { type: 'button', 'data-primary': true, onclick: openClaudeCode }, icon('terminal'), 'Open Claude Code')));
}

function renderClaudeCode() {
  slot('terminalStyleSoon');
  const tools = TERMINAL_WINDOW ? byId('claude-code')?.querySelector('.tw-tools') : null;
  if (!tools) return;
  const onTop = state?.claude?.onTop;
  const label = onTop ? 'Stop keeping Claude Code on top' : 'Keep Claude Code on top of every window';
  const tool = (title, iconName, onclick, extra = {}) => el('button', { type: 'button', class: 'icon-only', title, 'aria-label': title, onclick, ...extra }, icon(iconName));
  tools.replaceChildren(...[
    guarded('claude-code-new', 'New session', 'plus', 'Start a new session?', () => busyAct('/api/claude/terminal/new', {}, 'claude-code-new')),
    onTop == null ? null : tool(label, onTop ? 'lock' : 'unlock', () => slot('claudeCall', '/api/claude/on-top', { on: !onTop }), { 'aria-pressed': String(Boolean(onTop)) }),
    tool('Back into the Claude panel', 'chevron-left', () => slot('claudeCall', '/api/claude/dock', {})),
  ].filter(Boolean));
}

function claudeCodeNote(screen, text) {
  screen?.replaceChildren(el('p', { class: 'tw-note' }, text));
}

const vendorUrl = (name) => '/vendor/' + name + '?t=' + encodeURIComponent(TOKEN);

async function claudeCodeStyle(name) {
  const res = await fetch(vendorUrl(name));
  if (!res.ok) throw new Error(name + ' did not load');
  document.head.append(el('style', {}, await res.text()));
}

function claudeCodeScript(name) {
  return new Promise((resolve, reject) => document.head.append(el('script', { src: vendorUrl(name), onload: resolve, onerror: () => reject(new Error(name + ' did not load')) })));
}

function claudeCodeLoad() {
  if (typeof Terminal === 'function') return Promise.resolve();
  return TERMINAL_FILES.reduce((ready, name) => ready.then(() => (name.endsWith('.css') ? claudeCodeStyle(name) : claudeCodeScript(name))), Promise.resolve());
}

function claudeCodeTheme() {
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue('--term-' + name).trim();
  const colours = TERMINAL_COLOURS.flatMap((c) => [[c, token(c)], ['bright' + c.charAt(0).toUpperCase() + c.slice(1), token('bright-' + c)]]);
  return { background: token('bg'), foreground: token('fg'), cursor: token('cursor'), cursorAccent: token('bg'), selectionBackground: token('selection'), ...Object.fromEntries(colours) };
}

// Claude Code reads Esc then Enter as a new line, which is what Shift+Enter is everywhere else in the app.
function claudeCodeKey(e) {
  if (e.key !== 'Enter' || !e.shiftKey) return true;
  if (e.type === 'keydown') {
    e.preventDefault();
    ccTerminal.write('\x1b\r');
  }
  return false;
}

function claudeCodeTerminal() {
  const term = new Terminal({
    fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(), fontSize: TERMINAL_FONT_PX, scrollback: TERMINAL_SCROLLBACK,
    cursorBlink: true, theme: claudeCodeTheme(), linkHandler: { activate: (e, uri) => openOutside(uri) }, allowProposedApi: true,
  });
  const refs = slot('terminalLinks', term);
  // xterm.js gives a cell to the first provider that claims it, so these go in ahead of the plain web links.
  if (refs) term.registerLinkProvider(refs);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((e, uri) => openOutside(uri)));
  term.attachCustomKeyEventHandler(claudeCodeKey);
  return term;
}

// A hidden screen measures as nothing, and fitting to that would squeeze Claude Code to two columns for whoever looks next.
function claudeCodeFit() {
  const { fit, screen } = claudeCode;
  if (fit && screen?.offsetWidth > 0 && screen.offsetHeight > 0) fit.fit();
}

function claudeCodeMount(screen) {
  const term = claudeCodeTerminal();
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(screen);
  Object.assign(claudeCode, { term, fit, screen });
  ccTerminal.onData((data) => term.write(data));
  term.onData((data) => ccTerminal.write(data));
  term.onResize(({ cols, rows }) => ccTerminal.resize(cols, rows));
  new ResizeObserver(claudeCodeFit).observe(screen);
  slot('terminalStyleStart', term);
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    term.options.theme = claudeCodeTheme();
    slot('terminalStyleAgain');
  });
}

function claudeCodeAttach() {
  const { term } = claudeCode;
  if (!term) return;
  claudeCodeFit();
  ccTerminal.attach(term.cols, term.rows);
  term.focus();
}

function claudeCodeShow(screen) {
  if (!screen || !window.ccTerminal) return claudeCodeNote(screen, 'Claude Code runs here only in the ' + APP_NAME + ' app.');
  claudeCode.mounting ??= claudeCodeLoad().then(() => claudeCodeMount(screen));
  return claudeCode.mounting.then(claudeCodeAttach, (e) => claudeCodeNote(screen, 'The terminal did not load: ' + e.message));
}

function claudeCodeFocus() {
  claudeCode.term?.focus();
}

function claudeCodeStart() {
  if (!TERMINAL_WINDOW) return;
  document.body.classList.add('terminal-window');
  const screen = el('div', { class: 'tw-screen', id: 'claude-code-screen' });
  document.body.append(el('section', { id: 'claude-code', class: 'tw', 'aria-label': 'Claude Code' },
    el('header', { class: 'tw-head' }, el('div', { class: 'tw-title' }, el('span', { class: 'cp-badge' }, icon('terminal')), el('b', {}, 'Claude Code')), el('div', { class: 'tw-tools' })),
    screen));
  claudeCodeShow(screen);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') claudeCodeShow(screen); });
}

claudeCodeStart();
