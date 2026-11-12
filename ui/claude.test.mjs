import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-10T12:00:00Z';
const HANDLE = 'claude:00000000-0000-4000-8000-000000000101';
const OLD = 'claude:00000000-0000-4000-8000-000000000007';
const TITLES = { 'mcp__underlings__merge_mr': 'Merge an MR', 'mcp__underlings__list_mrs': 'List merge requests', 'mcp__underlings__get_mr': 'Read an MR' };
const MERGE = { id: 'req-7', tool: 'mcp__underlings__merge_mr', summary: 'acme/engine!12', questions: null, input: '{\n  "mr": "acme/engine!12",\n  "sha": "abc123",\n  "when": "now"\n}' };

function current(extra = {}) {
  return { handle: HANDLE, name: 'control-centre-202611101200', title: 'What needs me?', kind: 'master', mr: null, ticket: null, worktree: null, cwd: '/work', state: 'done', since: 1000, lastAt: 1500, alive: false, said: '', outcome: 'success', ask: null, ...extra };
}

function snapshot({ claude = {}, shell = 'plugin', cards = [], agents = [] } = {}) {
  return {
    generatedAt: AT, shell, hotkeys: null,
    attention: { cards, agents, system: [], count: 0, prefs: {}, toasts: [], offers: [] },
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [], artifacts: [],
    claude: { available: true, tools: true, current: null, history: [], cwd: '/work', canPopOut: false, poppedOut: false, onTop: null, titles: TITLES, ...claude },
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

function memory(start = {}) {
  const saved = new Map(Object.entries(start));
  return { saved, getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)) };
}

async function panelPage({ snap = snapshot(), chat = null, search, storage = memory(), hash = 'overview' } = {}) {
  const posts = [];
  const page = await openPage({
    search, storage,
    respond(path, init) {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body ?? 'null');
        posts.push([path, body]);
        return path === '/api/claude/send' ? { ok: true, handle: HANDLE, text: 'Sent' } : { ok: true };
      }
      if (path.startsWith('/api/agents/conversation')) return chat;
      return null;
    },
  });
  page.show(snap, hash);
  const writes = () => posts.filter(([path]) => path !== '/api/attention/presence');
  return Object.assign(page, { posts, writes, storage });
}

const panel = (page) => page.$('#claude-panel');
const shown = (page) => !panel(page).hidden;
const press = (page, key, init = {}) => page.fire(init.target ?? page.document.activeElement, 'keydown', { key, shiftKey: /^[A-Z?]$/.test(key), ...init });
const named = (b) => b.getAttribute('title') || b.textContent;
const buttonIn = (page, scope, label) => page.$$(scope + ' button').find((b) => (label instanceof RegExp ? label.test(named(b)) : named(b) === label));

test('the rail button, the c key and Ask Claude in the palette each open the panel at its message box, and Esc from inside closes it', async () => {
  const page = await panelPage();
  assert.equal(shown(page), false);
  page.$('#ask-claude').click();
  assert.equal(shown(page), true);
  assert.equal(page.document.activeElement.id, 'claude-box');
  press(page, 'Escape');
  assert.equal(page.document.activeElement, panel(page), 'Esc leaves the box for the panel first');
  press(page, 'Escape');
  assert.equal(shown(page), false);
  press(page, 'c');
  assert.equal(shown(page), true);
  assert.equal(page.document.activeElement.id, 'claude-box');
  page.run('closeClaudePanel()');
  page.run("openPalette('ask claude')");
  assert.deepEqual(JSON.parse(page.run('JSON.stringify([palette.shown[0].label, palette.shown[0].keys])')), ['Ask Claude', ['c']]);
  press(page, 'Enter', { target: page.$('#palette-q') });
  assert.equal(shown(page), true);
  assert.ok(page.run("paletteEntries(keyContext()).some((x) => x.label === 'New chat with Claude')"));
  assert.deepEqual(page.writes(), []);
  assert.deepEqual(page.errors, []);
});

test('a page newer than its worker says to reload rather than offering a box that cannot send', async () => {
  const snap = snapshot();
  delete snap.claude;
  const page = await panelPage({ snap });
  page.run('openClaudePanel()');
  assert.equal(page.$('#claude-box').getAttribute('placeholder'), 'Reload Underlings to talk to Claude');
  assert.equal(page.$('#claude-box').disabled, true);
  assert.deepEqual(page.errors, []);
});

test('Enter sends what you typed with what the page saw, and Shift+Enter is a new line', async () => {
  const page = await panelPage();
  page.run('openClaudePanel()');
  const box = page.$('#claude-box');
  box.value = 'What needs me today?';
  assert.equal(press(page, 'Enter', { shiftKey: true, target: box }), true, 'Shift+Enter is left to the box');
  assert.deepEqual(page.writes(), []);
  press(page, 'Enter', { target: box });
  await page.settle();
  assert.deepEqual(page.writes(), [['/api/claude/send', { text: 'What needs me today?', expect: { handle: null, pending: null } }]]);
  assert.equal(box.value, '');
  assert.deepEqual(page.$$('#claude-panel .log .you').map((n) => n.textContent), ['YouWhat needs me today?'], 'what you sent shows at once');
});

test('replies show as markdown, a run of tool calls folds to one line, and the reply being written comes last', async () => {
  const chat = {
    ...current({ state: 'working', alive: true }), pending: null, partial: 'Two of them **need** you',
    entries: [
      { kind: 'you', at: 1, text: 'What needs me?' },
      { kind: 'tool', at: 2, name: 'mcp__underlings__list_mrs', summary: 'mcp__underlings__list_mrs' },
      { kind: 'tool', at: 3, name: 'mcp__underlings__get_mr', summary: 'acme/engine!12' },
      { kind: 'tool', at: 3, name: 'Bash', summary: 'git log -1' },
      { kind: 'said', at: 4, text: 'Looking at **engine!12**:\n\n- the pipeline failed' },
      { kind: 'tool', at: 5, name: 'Bash', summary: 'git status' },
    ],
  };
  const page = await panelPage({ snap: snapshot({ claude: { current: current({ state: 'working', alive: true }) } }), chat });
  page.run('openClaudePanel()');
  await page.settle();
  const log = page.$('#claude-panel .log').childNodes;
  assert.deepEqual(log.map((n) => n.className), ['you', 'calls', 'said', 'call', 'said streaming']);
  assert.equal(log[1].querySelector('summary').textContent, '3 tool calls: List merge requests, Read an MR, Bash');
  assert.equal(log[1].open, false);
  assert.deepEqual(log[1].querySelectorAll('.call').map((n) => n.textContent), ['List merge requests', 'Read an MR: acme/engine!12', 'Bash: git log -1']);
  assert.equal(log[2].querySelector('.md strong').textContent, 'engine!12');
  assert.equal(log[2].querySelector('.md li').textContent, 'the pipeline failed');
  assert.equal(log[4].querySelector('.md strong').textContent, 'need');
  assert.match(page.$('#claude-panel .cp-state').textContent, /working/);
  assert.deepEqual(page.errors, []);
});

test('a write through the app\'s own tools asks inline with what it will send, open, and Allow takes two clicks naming it', async () => {
  const live = current({ state: 'blocked', alive: true, ask: MERGE });
  const page = await panelPage({ snap: snapshot({ claude: { current: live } }), chat: { ...live, pending: MERGE, entries: [], partial: null } });
  page.run('openClaudePanel()');
  await page.settle();
  assert.equal(page.$('#claude-panel .cp-ask .asked').textContent, 'Asks to merge an MR: acme/engine!12');
  const what = page.$('#claude-panel .cp-ask .ask-input');
  assert.equal(what.open, true);
  assert.match(what.querySelector('pre').textContent, /"sha": "abc123"/);
  const allow = () => page.$$('#claude-panel .cp-ask button').find((b) => /^Allow/.test(b.textContent));
  assert.equal(allow().textContent, 'Allow Merge an MR');
  allow().click();
  assert.equal(allow().textContent, 'Allow Merge an MR for Claude?');
  assert.deepEqual(page.writes(), []);
  allow().click();
  await page.settle();
  assert.deepEqual(page.writes(), [['/api/matrix/agent-reply', { handle: HANDLE, allow: true, expect: { state: 'blocked', since: 1000, pending: 'req-7' } }]]);
  assert.equal(page.$('#claude-box').getAttribute('placeholder'), 'Or say what it should do instead, which denies it');
});

test('Stop shows while it runs, and New chat and an earlier chat each go to the worker', async () => {
  const live = current({ state: 'working', alive: true });
  const snap = snapshot({ claude: { current: live, history: [{ handle: OLD, title: 'Yesterday\'s standup', state: 'done', lastAt: Date.parse(AT), alive: false }] } });
  const page = await panelPage({ snap, chat: { ...live, pending: null, entries: [], partial: null } });
  page.run('openClaudePanel()');
  await page.settle();
  buttonIn(page, '#claude-panel .cp-send', 'Stop what Claude is doing').click();
  await page.settle();
  buttonIn(page, '#claude-panel .cp-tools', 'Earlier chats').click();
  page.$('#claude-panel .cp-history .cp-old').click();
  await page.settle();
  buttonIn(page, '#claude-panel .cp-tools', 'New chat').click();
  await page.settle();
  assert.deepEqual(page.writes(), [['/api/matrix/agent-stop', { handle: HANDLE }], ['/api/claude/open', { handle: OLD }], ['/api/claude/new', {}]]);
});

test('where the panel sits, its size and whether it is open are kept for this viewer, inside the window', async () => {
  const storage = memory();
  const first = await panelPage({ storage });
  first.run('openClaudePanel()');
  assert.deepEqual(JSON.parse(storage.saved.get('cc.claude.panel')), { open: true });
  first.run('claudePanel.place = { x: 200, y: 120, w: 500, h: 400 }; claudeSavePlace()');
  const again = await panelPage({ storage });
  assert.equal(shown(again), true, 'it opens again where it was left open');
  const { left, top, width, height } = panel(again).style;
  assert.deepEqual([left, top, width, height], ['200px', '120px', '500px', '400px']);
  storage.saved.set('cc.claude.panel', JSON.stringify({ open: true, x: 5000, y: -40, w: 99999, h: 100 }));
  const clamped = await panelPage({ storage });
  assert.deepEqual([clamped.$('#claude-panel').style.width, clamped.$('#claude-panel').style.height, clamped.$('#claude-panel').style.top], ['1384px', '320px', '8px']);
});

test('the plugin offers no Pop out, since it has no window to pop the panel into', async () => {
  const plugin = await panelPage();
  plugin.run('openClaudePanel()');
  assert.equal(buttonIn(plugin, '#claude-panel .cp-tools', /Pop out/), undefined);
  assert.equal(plugin.run("paletteEntries(keyContext()).some((x) => x.id === 'act-claude-window')"), false);
});

test('the chat asking while its panel is closed is a Needs you card that answers in place and opens the panel', async () => {
  const live = current({ state: 'blocked', alive: true, ask: MERGE });
  const item = { kind: 'claude', key: null, group: 'agents', id: 'claude:' + HANDLE + ':1000', handle: HANDLE, tier: 'interrupt', why: 'asks to merge an MR', title: 'Claude', tab: 'claude' };
  const page = await panelPage({ snap: snapshot({ claude: { current: live }, agents: [item] }), hash: 'needs-you' });
  const card = page.$('#main .agent[data-handle="' + HANDLE + '"]');
  assert.equal(card.querySelector('.ask .asked').textContent, 'Asks to merge an MR: acme/engine!12');
  assert.ok(buttonIn(page, '#main', 'Allow Merge an MR'));
  buttonIn(page, '#main', 'Open the Claude panel').click();
  assert.equal(shown(page), true);
  page.run("closeClaudePanel(); goTo('claude')");
  assert.equal(shown(page), true, 'a banner click lands on the panel too');
});
