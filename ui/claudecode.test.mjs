import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-10T12:00:00Z';
const HANDLE = 'claude:00000000-0000-4000-8000-000000000101';

function snapshot({ shell = 'app', code = shell === 'app', asking = false, agents = [], current = null, onTop = true, poppedOut = false, team = [], rows = [] } = {}) {
  return {
    generatedAt: AT, shell, hotkeys: null,
    attention: { cards: [], agents, system: [], count: agents.length, prefs: {}, toasts: [], offers: [] },
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: team, artifacts: [],
    claude: { available: true, tools: true, current, history: [], cwd: '/work', canPopOut: shell === 'app', poppedOut, onTop: shell === 'app' ? onTop : null, titles: {} },
    claudeCode: { available: code, asking },
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false, jiraSite: 'acme.atlassian.net',
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

function chat() {
  return { handle: HANDLE, name: 'control-centre-202611101200', title: 'Quick question', kind: 'master', mr: null, ticket: null, worktree: null, cwd: '/work', state: 'done', since: 1000, lastAt: 1500, alive: false, said: '', outcome: 'success', ask: null };
}

// The app's preload and xterm.js, as far as the page uses them, in place before the page's scripts run.
function terminalKit() {
  const bridge = { attached: [], written: [], resized: [], listeners: [] };
  const terms = [];
  const window = {};
  window.ccTerminal = {
    attach: (cols, rows) => bridge.attached.push([cols, rows]),
    write: (data) => bridge.written.push(data),
    resize: (cols, rows) => bridge.resized.push([cols, rows]),
    onData: (fn) => bridge.listeners.push(fn),
  };
  window.Terminal = class {
    constructor(options) {
      Object.assign(this, { options, cols: 88, rows: 26, shown: [], focused: 0, providers: [], order: [], markers: [], decos: [], parsed: [], resizers: [], bufferChanges: [] });
      this.buffer = { active: { type: 'normal', length: 0, baseY: 0, viewportY: 0, cursorY: 0, getNullCell: () => ({}), getLine: () => undefined }, onBufferChange: (fn) => this.bufferChanges.push(fn) };
      terms.push(this);
    }
    loadAddon(addon) { this.order.push(addon.constructor.name); }
    registerLinkProvider(provider) { this.providers.push(provider); this.order.push('links'); }
    attachCustomKeyEventHandler(fn) { this.key = fn; }
    open(parent) { Object.assign(this, { parent, element: parent }); }
    draw(lines, cols = 40) {
      const rows = lines.map((text) => ({ text, wrapped: false }));
      const line = (i) => rows[i] && { isWrapped: rows[i].wrapped, getCell: (x) => ({ getChars: () => rows[i].text[x] ?? '' }) };
      Object.assign(this.buffer.active, { length: rows.length, cursorY: Math.max(rows.length - 1, 0), getLine: line });
      Object.assign(this, { cols, rows: rows.length });
      this.parsed.forEach((fn) => fn());
    }
    registerMarker(offset) {
      const { baseY, cursorY } = this.buffer.active;
      const marker = { line: baseY + cursorY + offset, isDisposed: false, dispose() { Object.assign(marker, { isDisposed: true, line: -1 }); } };
      this.markers.push(marker);
      return marker;
    }
    registerDecoration(options) {
      const deco = { options, isDisposed: false, dispose() { deco.isDisposed = true; }, onRender(fn) { deco.rendered = fn; } };
      this.decos.push(deco);
      return deco;
    }
    onWriteParsed(fn) { this.parsed.push(fn); }
    onScroll(fn) { this.scrolled = fn; }
    onData(fn) { this.typed = fn; }
    onResize(fn) { this.resizers.push(fn); }
    write(data) { this.shown.push(data); }
    focus() { this.focused += 1; }
  };
  bridge.fits = 0;
  window.FitAddon = { FitAddon: class Fit { fit() { bridge.fits += 1; } } };
  window.WebLinksAddon = { WebLinksAddon: class WebLinks {} };
  window.ResizeObserver = class { observe() {} };
  bridge.themes = [];
  window.matchMedia = () => ({ matches: false, addEventListener: (type, fn) => bridge.themes.push(fn) });
  window.getComputedStyle = () => ({ getPropertyValue: (name) => (name === '--term-link' ? ' #f2c14e' : '') });
  return { bridge, terms, globals: window };
}

async function page({ snap = snapshot(), search, hash = 'overview', storage, kit = snap.shell === 'app' } = {}) {
  const posts = [];
  const term = kit ? terminalKit() : null;
  const opened = await openPage({
    search, storage, globals: term?.globals,
    respond(path, init) {
      if (init?.method !== 'POST') return path.startsWith('/api/agents/conversation') ? { ...chat(), entries: [], partial: null } : null;
      posts.push([path, JSON.parse(init.body ?? 'null')]);
      return { ok: true };
    },
  });
  opened.show(snap, hash);
  const writes = () => posts.filter(([path]) => path !== '/api/attention/presence');
  return Object.assign(opened, { posts, writes, term });
}

const named = (b) => b.getAttribute('title') || b.textContent;
const buttonIn = (p, scope, label) => p.$$(scope + ' button').find((b) => (label instanceof RegExp ? label.test(named(b)) : named(b) === label));
const press = (p, key, init = {}) => p.fire(init.target ?? p.document.activeElement, 'keydown', { key, shiftKey: /^[A-Z?]$/.test(key), ...init });
const panelShown = (p) => !p.$('#claude-panel').hidden;

test('in the app the panel is Claude Code\'s terminal: c, the rail\'s Ask Claude and Jump to each open it, and it attaches each time it comes into view', async () => {
  const p = await page({ snap: snapshot({ current: chat() }) });
  press(p, 'c');
  await p.settle();
  assert.equal(panelShown(p), true);
  assert.equal(p.$('#claude-panel').classList.contains('terminal'), true);
  assert.equal(p.term.terms.length, 1);
  assert.equal(p.term.terms[0].parent, p.$('#claude-panel .cp-term'), 'xterm.js is drawn in the panel');
  assert.deepEqual(p.term.bridge.attached, [[88, 26]], 'it takes the pty at its own size');
  assert.equal(buttonIn(p, '#claude-panel .cp-tools', /Earlier chats|New chat|Open in Terminal/), undefined, 'the chat\'s own tools are gone');
  p.run('closeClaudePanel()');
  p.$('#ask-claude').click();
  await p.settle();
  p.run('closeClaudePanel()');
  p.run("openPalette('open claude code')");
  press(p, 'Enter', { target: p.$('#palette-q') });
  await p.settle();
  assert.equal(panelShown(p), true);
  assert.deepEqual(p.term.bridge.attached.length, 3, 'once for each time it came into view');
  assert.equal(p.term.terms.length, 1, 'one terminal for the page');
  p.term.bridge.listeners[0]('hello from Claude Code');
  assert.deepEqual(p.term.terms[0].shown, ['hello from Claude Code']);
  p.term.terms[0].typed('y');
  assert.deepEqual(p.term.bridge.written, ['y']);
  assert.deepEqual(p.writes(), [], 'opening it asks the worker nothing: a view that attaches to nothing wakes Claude Code itself');
  assert.deepEqual(p.errors, []);
});

test('New session takes two clicks, and so does the palette\'s, which only arms it', async () => {
  const p = await page();
  p.run('openClaudePanel()');
  await p.settle();
  const fresh = () => p.$('#claude-panel #g-claude-code-new');
  fresh().click();
  await p.settle(50);
  assert.deepEqual(p.writes(), []);
  fresh().click();
  await p.settle();
  assert.deepEqual(p.writes(), [['/api/claude/terminal/new', {}]]);
  p.run("openPalette('new claude code session')");
  press(p, 'Enter', { target: p.$('#palette-q') });
  await p.settle(50);
  assert.equal(fresh().textContent, 'Start a new session?');
  assert.equal(p.writes().length, 1);
});

test('Pop out moves the session into the Claude Code window and Back brings it into the panel, which attaches again', async () => {
  const p = await page();
  p.run('openClaudePanel()');
  await p.settle();
  buttonIn(p, '#claude-panel .cp-tools', 'Pop out into the Claude Code window').click();
  await p.settle();
  assert.deepEqual(p.writes(), [['/api/claude/popout', {}]]);
  assert.equal(panelShown(p), false);
  p.show(snapshot({ poppedOut: true }));
  press(p, 'c');
  p.run("goTo('claude-code')");
  await p.settle();
  assert.deepEqual(p.writes().slice(1), [['/api/claude/popout', {}], ['/api/claude/popout', {}]], 'while it is out, c and a banner bring its window forward');
  assert.equal(panelShown(p), false);
  assert.equal(p.term.bridge.attached.length, 1);
  p.run("goTo('claude-here')");
  await p.settle();
  assert.equal(panelShown(p), true);
  assert.equal(p.term.bridge.attached.length, 2, 'back in the panel, it takes the pty again');
  const window = await page({ search: '?t=test&window=terminal' });
  await window.settle();
  assert.deepEqual(window.term.bridge.attached, [[88, 26]], 'the window takes it as it opens');
  assert.equal(window.$('#claude-code .tw-screen'), window.term.terms[0].parent);
  window.window.document.visibilityState = 'visible';
  window.fire(window.document, 'visibilitychange');
  await window.settle();
  assert.equal(window.term.bridge.attached.length, 2, 'and again each time it is shown');
  buttonIn(window, '#claude-code .tw-tools', 'Stop keeping Claude Code on top').click();
  buttonIn(window, '#claude-code .tw-tools', 'Back into the Claude panel').click();
  await window.settle();
  assert.deepEqual(window.writes(), [['/api/claude/on-top', { on: false }], ['/api/claude/dock', {}]]);
  assert.deepEqual([p.errors, window.errors], [[], []]);
});

test('a hidden terminal is never fitted, so it cannot squeeze Claude Code to nothing for the view that looks next', async () => {
  const p = await page();
  p.run('openClaudePanel()');
  await p.settle();
  const screen = p.$('#claude-panel .cp-term');
  Object.assign(screen, { offsetWidth: 0, offsetHeight: 0 });
  p.run('claudeCodeFit()');
  assert.equal(p.term.bridge.fits, 0);
  Object.assign(screen, { offsetWidth: 600, offsetHeight: 400 });
  p.run('claudeCodeFit()');
  assert.equal(p.term.bridge.fits, 1);
});

test('keys typed in the panel\'s terminal are Claude Code\'s, never the page\'s shortcuts', async () => {
  const p = await page();
  p.run('openClaudePanel()');
  await p.settle();
  const inside = p.$('#claude-panel .cp-term');
  for (const key of ['g', 'q', '?', 'c', 'Escape', '/']) press(p, key, { target: inside });
  assert.equal(p.run('location.hash'), '#overview');
  assert.equal(panelShown(p), true);
  assert.equal(p.run('keyState.overlay'), null);
});

test('Claude Code asking is a Needs you card in its own words, and the card and a banner\'s target open the panel terminal, with the rail\'s dot lit', async () => {
  const item = { kind: 'claude-code', key: null, group: 'agents', id: 'claude-code:1', tier: 'interrupt', why: 'Claude needs your permission to use Bash', title: 'Claude needs you', tab: 'claude-code' };
  const p = await page({ snap: snapshot({ agents: [item], asking: true }), hash: 'needs-you' });
  const card = p.$('#main [data-kind="claude-code"]');
  assert.equal(card.querySelector('.title').textContent, 'Claude needs you');
  assert.equal(card.querySelector('.text').textContent, 'Claude needs your permission to use Bash');
  assert.deepEqual(p.$$('#main [data-kind="claude-code"] button').map(named), ['Open Claude Code'], 'nothing else on it');
  assert.equal(p.$('#ask-claude .cp-dot').className, 'cp-dot hot');
  buttonIn(p, '#main', 'Open Claude Code').click();
  await p.settle();
  assert.equal(panelShown(p), true);
  assert.equal(p.$('#claude-panel .cp-state').textContent, 'asks you');
  p.run('closeClaudePanel()');
  p.run("goTo('claude-code')");
  await p.settle();
  assert.equal(panelShown(p), true);
  assert.equal(p.term.bridge.attached.length, 2);
  assert.deepEqual(p.errors, []);
});

test('the plugin page keeps the chat panel: Ask Claude opens its message box, Terminal resumes its chat in Terminal, and nothing reaches for a pty', async () => {
  const p = await page({ snap: snapshot({ shell: 'plugin', current: chat() }) });
  p.$('#ask-claude').click();
  assert.equal(panelShown(p), true);
  assert.equal(p.$('#claude-panel').classList.contains('terminal'), false);
  assert.equal(p.document.activeElement.id, 'claude-box');
  buttonIn(p, '#claude-panel .cp-tools', /^Open in Terminal/).click();
  await p.settle();
  assert.deepEqual(p.writes(), [['/api/matrix/agent-terminal', { handle: HANDLE }]]);
  assert.equal(p.run("paletteEntries(keyContext()).some((x) => x.id === 'act-claude-code')"), false);
  assert.equal(p.run("paletteEntries(keyContext()).find((x) => x.id === 'act-claude-new').label"), 'New chat with Claude');
  assert.deepEqual(p.errors, []);
});

test('an app page without the preload, such as one opened in a browser, keeps the chat panel too', async () => {
  const p = await page({ snap: snapshot(), kit: false });
  p.run('openClaudePanel()');
  assert.equal(p.$('#claude-panel').classList.contains('terminal'), false);
  assert.equal(p.document.activeElement.id, 'claude-box');
});

test('the Claude Code window is the terminal alone, its page takes no keys and reports no presence', async () => {
  const kept = new Map([['cc.claude.panel', JSON.stringify({ open: true })]]);
  const storage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) };
  const p = await page({ search: '?t=test&window=terminal', storage });
  assert.equal(p.document.body.classList.contains('terminal-window'), true);
  assert.equal(panelShown(p), false, 'the panel left open in the main window stays there');
  for (const key of ['g', 'q', 'c', '?', 'Escape']) press(p, key);
  assert.equal(p.run('location.hash'), '#overview');
  p.window.document.hasFocus = () => true;
  p.run('presenceStart()');
  await p.settle(50);
  assert.equal(p.posts.some(([path]) => path === '/api/attention/presence'), false, 'focus here must not turn a banner into a toast in the main window');
  const bare = await page({ search: '?t=test&window=terminal', kit: false });
  assert.match(bare.$('#claude-code-screen').textContent, /only in the Underlings app/);
});

const GRAPH = 'acme/order-book!898';
const KICKOFF = {
  handle: 'claude:00000000-0000-4000-8000-000000000201', name: 'kickoff-ABC-2871', title: 'Start ABC-2871', kind: 'kickoff', mr: null, ticket: 'ABC-2871', worktree: null, cwd: '/work',
  state: 'waiting', since: 1000, lastAt: 1500, alive: true, said: '', outcome: null, background: [],
  ask: { id: 'q1', tool: 'AskUserQuestion', summary: 'AskUserQuestion', questions: [{ question: 'Raise the MR?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
};
const TABLE = ['│ ABC-2871 │ Frank │ order-book!898 │', '├──────────┼───────┼───────────────────┤', '│ ABC-2900 │ Ivan  │ UTF-8             │'];
const graphRow = () => ({
  key: GRAPH, iid: 898, repo: 'order-book', title: 'Order book MR', webUrl: 'https://gitlab.com/acme/order-book/-/merge_requests/898', author: 'ivan', reviewers: ['frank'],
  approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: 'ABC-2871', updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'CAN_BE_MERGED', sourceBranch: 'feat/898', sha: 'aaa111bbb222',
  agentHandle: null, watch: null, flags: { waitingOnYou: false }, phase: 'open', count: 0, mood: 'quiet', verdict: null, agent: null, level: null,
});
const linked = () => snapshot({ team: [KICKOFF], rows: [graphRow()] });
const provide = (term, y) => new Promise((resolve) => term.providers[0].provideLinks(y, (links) => resolve(links ?? [])));
const spans = (links, line) => links.map((l) => [l.text, l.range.start.x, l.range.end.x, l.range.start.y === l.range.end.y]).map(([text, from, to, oneRow]) => [text, line.slice(from - 1, to), oneRow]);
const HINT = '⌘-click opens it in your browser';

test('both views give their terminal the link provider, ahead of the plain web links so a ticket or MR link is the app\'s', async () => {
  const p = await page();
  p.run('openClaudePanel()');
  await p.settle();
  const w = await page({ search: '?t=test&window=terminal' });
  await w.settle();
  for (const view of [p, w]) {
    assert.equal(view.term.terms.length, 1);
    assert.deepEqual(view.term.terms[0].order, ['links', 'WebLinks', 'Fit']);
  }
});

test('in the panel a key with an agent opens its agent window, one without opens the ticket drawer, and an MR its drawer, each saying so on hover', async () => {
  const p = await page({ snap: linked() });
  p.run('openClaudePanel()');
  await p.settle();
  const term = p.term.terms[0];
  term.draw(TABLE);
  const [key, mr] = await provide(term, 1);
  const [ticket, ...rest] = await provide(term, 3);
  assert.deepEqual(spans([key, mr], TABLE[0]), [['ABC-2871', 'ABC-2871', true], ['order-book!898', 'order-book!898', true]]);
  assert.deepEqual([spans([ticket], TABLE[2]), rest], [[['ABC-2900', 'ABC-2900', true]], []], 'UTF-8 stays text');
  assert.deepEqual(await provide(term, 2), [], 'the rule between the rows holds nothing');
  const tip = () => p.$('#claude-panel .cp-term .term-tip');
  const tips = () => p.$$('#claude-panel .term-tip').length;
  key.hover({ clientX: 40, clientY: 20 });
  assert.equal(tip().textContent, 'ABC-2871 · open its kickoff agent (waiting on you)' + HINT);
  key.leave();
  assert.equal(tips(), 0);
  ticket.hover({ clientX: 40, clientY: 60 });
  assert.equal(tip().textContent, 'ABC-2900 · open the ticket (no agent yet)' + HINT);
  mr.hover({ clientX: 40, clientY: 20 });
  assert.equal(tips(), 1, 'one tooltip at a time');
  assert.equal(tip().textContent, 'order-book!898 · open the MR' + HINT);
  key.activate({ metaKey: false });
  assert.equal(tips(), 0, 'a click puts the tooltip away');
  assert.equal(p.$('#agent-window').hidden, false);
  assert.equal(p.run('agentWin.handle'), KICKOFF.handle, 'its window is open at its conversation');
  assert.ok(p.$('#agent-window .console'));
  p.run('agentWinClose()');
  ticket.activate({ metaKey: false });
  assert.equal(p.$('#drawer .drawer').getAttribute('aria-label'), 'Ticket ABC-2900');
  mr.activate({ metaKey: false });
  assert.equal(p.$('#drawer .drawer').getAttribute('aria-label'), 'Merge request ' + GRAPH);
  assert.deepEqual(p.writes(), [], 'nothing so far left the page');
  key.activate({ metaKey: true });
  mr.activate({ metaKey: true });
  await p.settle(50);
  assert.deepEqual(p.writes(), [['/api/open', { url: 'https://acme.atlassian.net/browse/ABC-2871' }], ['/api/open', { url: graphRow().webUrl }]]);
  assert.deepEqual(p.errors, []);
});

test('in the Claude Code window a click brings the dashboard forward to open it there, and the window itself opens nothing', async () => {
  const w = await page({ search: '?t=test&window=terminal', snap: linked() });
  await w.settle();
  const term = w.term.terms[0];
  term.draw(TABLE);
  const [key, mr] = await provide(term, 1);
  const [ticket] = await provide(term, 3);
  for (const link of [key, mr, ticket]) link.activate({ metaKey: false });
  await w.settle(50);
  assert.deepEqual(w.writes(), [['/api/summon', { target: 'agent:' + KICKOFF.handle }], ['/api/summon', { target: 'mr:' + GRAPH + ':overview' }], ['/api/summon', { target: 'ticket:ABC-2900' }]]);
  key.activate({ metaKey: true });
  await w.settle(50);
  assert.deepEqual(w.writes().at(-1), ['/api/open', { url: 'https://acme.atlassian.net/browse/ABC-2871' }], 'Cmd-click goes straight to the browser, not by way of the dashboard');
  for (const data of ['goto:agent:' + KICKOFF.handle, 'goto:mr:' + GRAPH + ':overview', 'goto:ticket:ABC-2900']) w.run('onWorkerEvent(' + JSON.stringify({ data }) + ')');
  assert.deepEqual([w.$('#drawer').hidden, w.run('location.hash')], [true, '#overview'], 'the summons it hears back are the dashboard\'s to act on');
  assert.deepEqual(w.errors, []);
});

test('the dashboard acts on a summoned ticket or agent: the ticket drawer, or the agent window, in the list or the office alike', async () => {
  const p = await page({ snap: linked() });
  p.run("onWorkerEvent({ data: 'goto:ticket:ABC-2900' })");
  assert.equal(p.$('#drawer .drawer').getAttribute('aria-label'), 'Ticket ABC-2900');
  p.run('onWorkerEvent(' + JSON.stringify({ data: 'goto:agent:' + KICKOFF.handle }) + ')');
  assert.deepEqual([p.$('#drawer').hidden, p.$('#agent-window').hidden, p.run('agentWin.handle')], [false, false, KICKOFF.handle], 'the window opens over the ticket drawer, which stays where it was');
  p.run("agentWinClose(); ui.agentLayout = 'office'; goTo('agent:" + KICKOFF.handle + "')");
  assert.deepEqual([p.run('agentWin.handle'), p.run('office.selected')], [KICKOFF.handle, KICKOFF.handle], 'the office picks it out too');
  p.run("agentWinClose(); goTo('agent:claude:gone')");
  assert.deepEqual([p.run('agentWin.handle'), p.run('office.selected')], [null, null], 'an agent no longer listed opens nothing');
});

const live = (term) => term.decos.filter((d) => !d.isDisposed);
const decorated = (term, lines) => live(term).map((d) => [d.options.marker.line, lines[d.options.marker.line].slice(d.options.x, d.options.x + d.options.width), d.options.foregroundColor]);
const classOf = (view, deco) => {
  const node = view.document.createElement('div');
  deco.rendered(node);
  return node.className;
};
const PROMPTED = [...TABLE, '────────────────', '> fix ABC-2933 next'];

test('both views underline every reference the app can act on, in the link colour, and leave plain text and the prompt alone', async () => {
  const panel = await page({ snap: linked() });
  panel.run('openClaudePanel()');
  const window = await page({ search: '?t=test&window=terminal', snap: linked() });
  for (const view of [panel, window]) {
    await view.settle(50);
    const term = view.term.terms[0];
    assert.equal(term.options.allowProposedApi, true, 'xterm.js keeps decorations behind its proposed API');
    term.draw(PROMPTED);
    await view.settle(200);
    assert.deepEqual(decorated(term, PROMPTED), [[0, 'ABC-2871', '#f2c14e'], [0, 'order-book!898', '#f2c14e'], [2, 'ABC-2900', '#f2c14e']]);
    assert.deepEqual(live(term).map((d) => classOf(view, d)), ['term-ref term-ref-asks', 'term-ref', 'term-ref'], 'the key whose agent waits on you carries a dot');
    const [key] = await provide(term, 1);
    const [typed] = await provide(term, 5);
    assert.deepEqual([key.decorations.underline, typed.text, typed.decorations.underline], [false, 'ABC-2933', true], 'hover adds no second underline, and the prompt keeps its link with xterm.js\'s own');
    assert.deepEqual(view.errors, []);
  }
});

test('a write restyles only what changed, a line that leaves the buffer lets its decoration go, and a resize, a theme, a terminal reset or what the page knows restyles it all', async () => {
  const p = await page({ snap: linked() });
  p.run('openClaudePanel()');
  await p.settle(50);
  const term = p.term.terms[0];
  term.draw(PROMPTED);
  await p.settle(200);
  const [key, mr, ticket] = term.decos;
  term.draw(PROMPTED);
  await p.settle(200);
  assert.equal(term.decos.length, 3, 'the same screen again registers nothing');
  const next = PROMPTED.map((line, i) => (i === 2 ? line.replace('ABC-2900', 'ABC-2934') : line));
  term.draw(next);
  await p.settle(200);
  assert.deepEqual([key.isDisposed, mr.isDisposed, ticket.isDisposed], [false, false, true]);
  assert.deepEqual(decorated(term, next).map(([line, text]) => [line, text]), [[0, 'ABC-2871'], [0, 'order-book!898'], [2, 'ABC-2934']]);
  key.options.marker.dispose();
  key.dispose();
  term.draw(next);
  await p.settle(200);
  assert.equal(p.run('terminalStyle.entries.length'), 2, 'the one whose line was trimmed is let go');
  const resetByXterm = () => {
    term.decos.forEach((d) => d.dispose());
    term.bufferChanges.forEach((fn) => fn());
  };
  for (const restyle of [() => term.resizers.forEach((fn) => fn({ cols: 40, rows: 3 })), () => p.term.bridge.themes.forEach((fn) => fn()), resetByXterm]) {
    const before = live(term);
    restyle();
    await p.settle(200);
    assert.ok(before.every((d) => d.isDisposed));
    assert.deepEqual(decorated(term, next).map(([, text]) => text), ['ABC-2871', 'order-book!898', 'ABC-2934']);
  }
  p.show(snapshot({ team: [{ ...KICKOFF, state: 'done', ask: null }], rows: [graphRow()] }));
  await p.settle(200);
  assert.deepEqual(live(term).map((d) => classOf(p, d)), ['term-ref', 'term-ref', 'term-ref'], 'once its agent stops waiting, the dot goes');
  assert.deepEqual(p.errors, []);
});

test('when the scrollback trims its oldest line, decorations ride up with their lines and nothing unchanged is registered again', async () => {
  const p = await page({ snap: linked() });
  p.run('openClaudePanel()');
  await p.settle(50);
  const term = p.term.terms[0];
  const RULE = '────────────────';
  term.draw(['ABC-2871 a', 'ABC-2872 b', 'plain c', RULE, '> typing']);
  await p.settle(200);
  const registered = term.decos.length;
  for (const marker of term.markers.filter((m) => !m.isDisposed)) {
    marker.line -= 1;
    if (marker.line < 0) marker.dispose();
  }
  term.decos.filter((d) => d.options.marker.isDisposed).forEach((d) => d.dispose());
  term.draw(['ABC-2872 b', 'plain c', 'ABC-2934 d', RULE, '> typing']);
  await p.settle(200);
  assert.equal(term.decos.length - registered, 1, 'only the new line is decorated');
  assert.deepEqual(live(term).map((d) => [d.options.marker.line, d.options.x]), [[0, 0], [2, 0]]);
});

test('nothing is decorated while a full-screen program has the alternate buffer, and links still work there', async () => {
  const p = await page({ snap: linked() });
  p.run('openClaudePanel()');
  await p.settle(50);
  const term = p.term.terms[0];
  term.buffer.active.type = 'alternate';
  term.draw(PROMPTED);
  await p.settle(200);
  const links = JSON.parse(JSON.stringify((await provide(term, 1)).map((l) => [l.text, l.decorations.underline])));
  assert.deepEqual([term.decos.length, links], [0, [['ABC-2871', true], ['order-book!898', true]]]);
});
