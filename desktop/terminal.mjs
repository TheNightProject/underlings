import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SCROLLBACK = 10_000;
const RESET = '\x1bc';
const MAX_SIDE = 1000;
const QUIET_MS = 800;
const READY_WAIT_MS = 20_000;
const POLL_MS = 100;
// What xterm.js answers Claude Code's own queries with, and focus reports, reach the pty the way keys do, but are not typing.
const REPLY = /^\x1b(?:\[[IO]|\[\d+;\d+R|\[[?>=][\d;]*[cnu]|\[\?[\d;]*\$y|\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\)$/;
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export const typedByHand = (data) => !REPLY.test(data);

// Text from mail or Slack never carries an escape of its own into the prompt, so it cannot end the paste early or press a key.
export function pasteText(text, bracketed) {
  const clean = String(text).replace(/\r?\n/g, '\r').replace(CONTROLS, '');
  return bracketed ? `\x1b[200~${clean}\x1b[201~` : clean;
}

const sizeOk = (cols, rows) => [cols, rows].every((n) => Number.isInteger(n) && n > 0 && n <= MAX_SIDE);

// A screen of the pty's own, so a view that attaches at any size is drawn what a terminal of that size would show now.
function newScreen({ cols, rows }) {
  const { Terminal } = require('@xterm/headless');
  const { SerializeAddon } = require('@xterm/addon-serialize');
  const term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  return { term, serializer };
}

export function createTerminal({ spawn, log = () => {}, onTyped = () => {}, onWake = () => {}, now = Date.now }) {
  let pty = null;
  let pending = null;
  let size = null;
  let screen = null;
  let view = null;
  let heardAt = 0;

  function show(data) {
    heardAt = now();
    screen?.term.write(data);
    if (!view) return;
    if (view.live) view.send(data);
    else view.held.push(data);
  }

  function start(spec) {
    if (pty || pending) return false;
    pending = spec;
    if (size) launch();
    return true;
  }

  function launch() {
    const spec = pending;
    pending = null;
    try {
      screen ??= newScreen(size);
      if (spec.notice) {
        log(spec.notice);
        show(`${spec.notice}\r\n`);
      }
      pty = spawn(spec.file, spec.args, { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: spec.cwd, env: spec.env });
    } catch (err) {
      log(`could not start Claude Code: ${err.message}`);
      show(`Claude Code could not start: ${err.message}\r\n`);
      return;
    }
    log(`started Claude Code in ${spec.cwd} as pid ${pty.pid}`);
    const own = pty;
    own.onData((data) => pty === own && show(data));
    own.onExit(({ exitCode }) => {
      if (pty !== own) return;
      pty = null;
      log(`Claude Code ended with code ${exitCode}`);
      show(`\r\n\x1b[2mClaude Code has ended. Press Enter to start it again.\x1b[0m\r\n`);
    });
  }

  function restart(spec) {
    end();
    pending = null;
    screen?.term.write(RESET);
    if (view) view.send(RESET);
    return start(spec);
  }

  function resizeTo(cols, rows) {
    size = { cols, rows };
    screen?.term.resize(cols, rows);
    if (pty) pty.resize(cols, rows);
    else if (pending) launch();
  }

  // One view at a time: the one attaching is drawn the screen as it is, then hears what follows, and the other hears nothing more.
  function attach(id, send, cols, rows) {
    const next = { id, send, live: false, held: [] };
    view = next;
    if (sizeOk(cols, rows)) resizeTo(cols, rows);
    if (!pty && !pending) onWake();
    if (!screen) {
      next.live = true;
      return send(RESET);
    }
    screen.term.write('', () => {
      if (view !== next) return;
      send(RESET + screen.serializer.serialize());
      for (const data of next.held) send(data);
      next.live = true;
      next.held = [];
    });
  }

  function detach(id) {
    if (view?.id === id) view = null;
  }

  function write(id, data) {
    if (view?.id !== id || typeof data !== 'string') return;
    if (!pty) {
      if (data.includes('\r') && !pending) onWake();
      return;
    }
    pty.write(data);
    if (typedByHand(data)) onTyped();
  }

  function resize(id, cols, rows) {
    if (view?.id === id && sizeOk(cols, rows)) resizeTo(cols, rows);
  }

  // Claude Code takes a paste only once it is drawing its prompt, so this waits for it to start and fall quiet.
  async function paste(text) {
    const end = now() + READY_WAIT_MS;
    while (!(pty && heardAt && now() - heardAt >= QUIET_MS)) {
      if (now() >= end) return false;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    pty.write(pasteText(text, screen.term.modes.bracketedPasteMode));
    return true;
  }

  function end() {
    const ending = pty;
    pty = null;
    ending?.kill();
  }

  return { start, restart, attach, detach, write, resize, paste, end, running: () => Boolean(pty), attached: () => view?.id ?? null };
}

// The dashboard and the Claude Code window may reach the pty, and only from their own top frame on the dashboard's origin.
export function bridgeView(event, views, origin) {
  const frame = event?.senderFrame;
  if (!frame || frame !== event.sender?.mainFrame) return null;
  try {
    if (new URL(frame.url).origin !== origin) return null;
  } catch {
    return null;
  }
  return Object.entries(views).find(([, contents]) => contents && contents === event.sender)?.[0] ?? null;
}
