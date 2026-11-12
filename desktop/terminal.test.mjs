import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { bridgeView, createTerminal, pasteText, typedByHand } from './terminal.mjs';

const SPEC = { file: '/bin/claude', args: ['--session-id', 'abc'], cwd: '/ws-root', env: { PATH: '/usr/bin' }, notice: null };
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function fakePty() {
  const made = [];
  const spawn = (file, args, options) => {
    const pty = {
      file, args, options, pid: 4000 + made.length, written: [], sizes: [], killed: false,
      write: (data) => pty.written.push(data),
      resize: (cols, rows) => pty.sizes.push([cols, rows]),
      kill: () => { pty.killed = true; },
      onData: (fn) => { pty.say = fn; },
      onExit: (fn) => { pty.exit = fn; },
    };
    made.push(pty);
    return pty;
  };
  return { made, spawn, last: () => made.at(-1) };
}

function view() {
  const seen = [];
  return { seen, send: (data) => seen.push(data), text: () => seen.join(''), reset: () => seen.splice(0) };
}

const visible = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1bc/g, '');

test('Claude Code starts once a view attaches and says how big it is, in the folder and with the environment it was given', async () => {
  const { made, spawn } = fakePty();
  const terminal = createTerminal({ spawn });
  assert.equal(terminal.start(SPEC), true);
  assert.equal(made.length, 0, 'no view yet, so nothing to draw at');
  const panel = view();
  terminal.attach('panel', panel.send, 120, 40);
  assert.equal(made.length, 1);
  assert.deepEqual([made[0].file, made[0].args, made[0].options], [SPEC.file, SPEC.args, { name: 'xterm-256color', cols: 120, rows: 40, cwd: '/ws-root', env: { PATH: '/usr/bin' } }]);
  assert.equal(terminal.start({ ...SPEC, args: ['--resume', 'abc'] }), false, 'one already running is kept');
  terminal.resize('panel', 100, 30);
  terminal.resize('panel', 0, 30);
  terminal.resize('panel', 100.5, 30);
  assert.deepEqual(made[0].sizes, [[100, 30]], 'a size that is not whole and positive is ignored');
});

test('a view that attaches is drawn the screen as it is, then hears what follows, and moving between the panel and the window loses nothing', async () => {
  const { last, spawn } = fakePty();
  const terminal = createTerminal({ spawn });
  const panel = view();
  const window = view();
  terminal.start(SPEC);
  terminal.attach('panel', panel.send, 80, 24);
  await settle();
  last().say('first line\r\n');
  assert.equal(panel.seen.at(-1), 'first line\r\n', 'live once attached');
  terminal.attach('window', window.send, 80, 24);
  last().say('said while popping out\r\n');
  await settle();
  assert.match(visible(window.seen[0]), /first line/, 'the window starts from the screen as it was');
  assert.equal(window.seen.at(-1), 'said while popping out\r\n', 'and then what followed, once and in order');
  assert.equal(window.text().split('said while popping out').length, 2);
  assert.equal(panel.seen.includes('said while popping out\r\n'), false, 'the panel hears no more once the window has it');
  assert.equal(terminal.attached(), 'window');
  terminal.detach('window');
  last().say('said while nobody looked\r\n');
  panel.reset();
  terminal.attach('panel', panel.send, 80, 24);
  await settle();
  assert.match(visible(panel.seen[0]), /first line[\s\S]*said while popping out[\s\S]*said while nobody looked/, 'Back draws everything said meanwhile');
  assert.equal(last().killed, false);
});

test('only the view attached reaches the pty, and one attaching at another size is drawn at that size', async () => {
  const { last, spawn } = fakePty();
  const terminal = createTerminal({ spawn });
  const panel = view();
  const window = view();
  terminal.start(SPEC);
  terminal.attach('panel', panel.send, 60, 20);
  terminal.write('window', 'not this');
  terminal.resize('window', 200, 50);
  terminal.write('panel', 'y');
  assert.deepEqual(last().written, ['y']);
  assert.deepEqual(last().sizes, []);
  terminal.attach('window', window.send, 120, 40);
  assert.deepEqual(last().sizes, [[120, 40]], 'the pty takes the size of the view that has it');
  terminal.resize('panel', 30, 10);
  terminal.write('panel', 'n');
  assert.deepEqual([last().sizes.length, last().written], [1, ['y']], 'the panel left behind no longer types or resizes');
  terminal.write(null, 'x');
  assert.deepEqual(last().written, ['y']);
});

test('closing or hiding either view never ends Claude Code; only end, on quit, does', async () => {
  const { last, spawn } = fakePty();
  const terminal = createTerminal({ spawn });
  terminal.start(SPEC);
  terminal.attach('window', view().send, 80, 24);
  terminal.detach('window');
  terminal.detach('panel');
  assert.deepEqual([terminal.running(), last().killed], [true, false]);
  terminal.end();
  assert.deepEqual([terminal.running(), last().killed], [false, true]);
});

test('New session ends the old one, clears the screen of the view that has it and starts the next at the same size', async () => {
  const { made, spawn } = fakePty();
  const terminal = createTerminal({ spawn });
  const panel = view();
  terminal.start(SPEC);
  terminal.attach('panel', panel.send, 90, 30);
  await settle();
  made[0].say('old conversation');
  terminal.restart({ ...SPEC, args: ['--session-id', 'def'] });
  assert.equal(made[0].killed, true);
  made[0].exit({ exitCode: 0 });
  assert.deepEqual([made.length, made[1].args, made[1].options.cols, made[1].options.rows], [2, ['--session-id', 'def'], 90, 30]);
  assert.equal(panel.seen.at(-1), '\x1bc');
  const window = view();
  terminal.attach('window', window.send, 90, 30);
  await settle();
  assert.doesNotMatch(visible(window.text()), /old conversation|ended/, 'the old conversation is gone, and the ended one says nothing');
});

test('a view attaching with nothing running asks for Claude Code, and so does Enter once it has ended', async () => {
  const { made, spawn } = fakePty();
  let woken = 0;
  const terminal = createTerminal({ spawn, onWake: () => { woken += 1; } });
  const panel = view();
  terminal.attach('panel', panel.send, 80, 24);
  assert.equal(woken, 1);
  terminal.start(SPEC);
  assert.equal(made.length, 1, 'the size is already known, so it starts at once');
  await settle();
  made[0].exit({ exitCode: 1 });
  assert.match(panel.text(), /Claude Code has ended\. Press Enter to start it again\./);
  terminal.write('panel', 'x');
  assert.equal(woken, 1);
  terminal.write('panel', '\r');
  assert.equal(woken, 2);
});

test('a notice, such as cswap missing, is shown before Claude Code starts, and a spawn that fails says why', async () => {
  const lines = [];
  const panel = view();
  const failing = createTerminal({ spawn: () => { throw new Error('posix_spawnp failed'); }, log: (t) => lines.push(t) });
  failing.start({ ...SPEC, notice: 'cswap is not on your PATH, so this is plain claude rather than account 2.' });
  failing.attach('panel', panel.send, 80, 24);
  await settle();
  assert.match(visible(panel.text()), /cswap is not on your PATH, so this is plain claude rather than account 2\.[\s\S]*Claude Code could not start: posix_spawnp failed/);
  assert.deepEqual(lines, ['cswap is not on your PATH, so this is plain claude rather than account 2.', 'could not start Claude Code: posix_spawnp failed']);
  assert.equal(failing.running(), false);
});

test('typing counts as Frank answering, and the answers xterm.js sends to Claude Code\'s own queries do not', () => {
  const { spawn } = fakePty();
  let typed = 0;
  const terminal = createTerminal({ spawn, onTyped: () => { typed += 1; } });
  terminal.start(SPEC);
  terminal.attach('panel', view().send, 80, 24);
  for (const reply of ['\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[?0u', '\x1b[?2026;2$y', '\x1b]11;rgb:1414/1919/2222\x1b\\', '\x1b]10;rgb:e6e6/eaea/f1f1\x07', '\x1bP>|xterm.js(6.0.0)\x1b\\']) {
    terminal.write('panel', reply);
    assert.equal(typedByHand(reply), false, JSON.stringify(reply));
  }
  assert.equal(typed, 0);
  for (const key of ['y', '\r', '\x1b', '\x1b[A', '\x03', 'hello']) assert.equal(typedByHand(key), true, JSON.stringify(key));
  terminal.write('panel', '\r');
  assert.equal(typed, 1);
});

test('a draft is pasted only once Claude Code has drawn its prompt and fallen quiet, bracketed when it asked for that, and never carries a key of its own', async () => {
  let clock = 0;
  const { last, spawn } = fakePty();
  const terminal = createTerminal({ spawn, now: () => clock });
  assert.equal(pasteText('Reply to:\nhello\x1b[201~\x03', false), 'Reply to:\rhello[201~');
  terminal.start(SPEC);
  terminal.attach('panel', view().send, 80, 24);
  const pasting = terminal.paste('Read this thread\nthen draft a reply');
  clock = 100;
  last().say('\x1b[?2004h> ');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(last().written, [], 'still drawing, so it waits');
  clock = 2000;
  assert.equal(await pasting, true);
  assert.deepEqual(last().written, ['\x1b[200~Read this thread\rthen draft a reply\x1b[201~']);
  last().say('\x1b[?2004l');
  await settle();
  clock = 5000;
  assert.equal(await terminal.paste('plain'), true);
  assert.equal(last().written.at(-1), 'plain');
});

test('the bridge answers only the dashboard\'s and the Claude Code window\'s own top frame, on the dashboard\'s origin', () => {
  const origin = 'http://127.0.0.1:47321';
  const dashboard = { mainFrame: null };
  dashboard.mainFrame = { url: `${origin}/?t=x` };
  const window = { mainFrame: { url: `${origin}/?t=x&window=terminal` } };
  const views = { panel: dashboard, window };
  const from = (sender, frame = sender.mainFrame) => ({ sender, senderFrame: frame });
  assert.equal(bridgeView(from(dashboard), views, origin), 'panel');
  assert.equal(bridgeView(from(window), views, origin), 'window');
  assert.equal(bridgeView(from(dashboard, { url: `${origin}/preview/a/b/index.html` }), views, origin), null, 'a frame inside the page, such as an artifact preview');
  const elsewhere = { mainFrame: { url: 'https://evil.example/' } };
  assert.equal(bridgeView(from(elsewhere), { panel: elsewhere }, origin), null, 'a page on another origin');
  const viewer = { mainFrame: { url: `${origin}/` } };
  assert.equal(bridgeView(from(viewer), views, origin), null, 'any other window, such as an artifact window');
  assert.equal(bridgeView({ sender: dashboard }, views, origin), null);
  assert.equal(bridgeView(from(dashboard), { panel: null, window }, origin), null);
});

test('the preload offers the terminal only to the top frame of the dashboard\'s origin, and only write, resize, attach and onData', async () => {
  const source = await readFile(new URL('./terminal-preload.cjs', import.meta.url), 'utf8');
  const origin = 'http://127.0.0.1:47321';
  function load({ href, top = true, argv = [`--cc-origin=${origin}`] }) {
    const exposed = {};
    const sent = [];
    const location = new URL(href);
    const win = { location };
    win.top = top ? win : {};
    const electron = { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer: { send: (...args) => sent.push(args), on() {} } };
    vm.runInNewContext(source, { require: (name) => (name === 'electron' ? electron : assert.fail(`required ${name}`)), process: { argv }, window: win, location });
    return { exposed, sent };
  }
  const page = load({ href: `${origin}/?t=x` });
  assert.deepEqual(Object.keys(page.exposed), ['ccTerminal']);
  assert.deepEqual(Object.keys(page.exposed.ccTerminal).sort(), ['attach', 'onData', 'resize', 'write']);
  page.exposed.ccTerminal.attach('80', 24);
  page.exposed.ccTerminal.write(7);
  assert.deepEqual(page.sent, [['terminal:attach', 80, 24], ['terminal:write', '7']]);
  assert.deepEqual(load({ href: `${origin}/?t=x`, top: false }).exposed, {}, 'a frame');
  assert.deepEqual(load({ href: 'https://evil.example/' }).exposed, {}, 'another origin');
  assert.deepEqual(load({ href: `${origin}/`, argv: [] }).exposed, {}, 'no origin given');
});
