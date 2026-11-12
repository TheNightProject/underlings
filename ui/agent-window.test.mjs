import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-11T12:00:00Z';
const handle = (n) => `claude:${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const QUESTION = { id: 'q1', tool: 'AskUserQuestion', summary: 'AskUserQuestion', questions: [{ question: 'Post them?', options: [{ label: 'Yes' }, { label: 'No' }] }] };
const PERMISSION = { id: 'p1', tool: 'Bash', summary: 'npm test', questions: null, input: '{}' };

function agent(n, extra = {}) {
  return {
    handle: handle(n), name: 'agent-' + n, title: 'task ' + n, kind: 'review', mr: 'acme/engine!' + n, ticket: null, worktree: null, cwd: '/work',
    state: 'working', since: 1000 + n, lastAt: Date.parse(AT) - n * 1000, alive: true, said: '', outcome: null, ask: null, ...extra,
  };
}

const AGENTS = [
  agent(1, { state: 'waiting', ask: QUESTION }),
  agent(2, { state: 'blocked', ask: PERMISSION }),
  agent(3, { kind: 'kickoff', mr: null, ticket: 'ABC-12', state: 'done', alive: false, outcome: 'success' }),
  agent(4, { state: 'done', alive: false, outcome: 'success', worktree: '/work/agent-4' }),
];

const LONG = '/work/' + 'a-very-long-directory-name/'.repeat(8) + 'file.ts';
const ENTRIES = [
  { kind: 'you', at: 1, text: 'Look at ' + LONG },
  { kind: 'tool', at: 2, name: 'Read', summary: LONG },
  { kind: 'tool', at: 3, name: 'Bash', summary: 'git diff -- ' + LONG },
  { kind: 'said', at: 4, text: 'Found it:\n\n| File | Why |\n| --- | --- |\n| ' + LONG + ' | reads twice |\n\n```\n' + 'x'.repeat(300) + '\n```\n\n- a list item\n- another' },
  { kind: 'tool', at: 5, name: 'Grep', summary: 'ceiling' },
  { kind: 'asked', at: 6, questions: [{ question: 'Carry on?', options: [] }] },
  { kind: 'note', at: 7, text: 'Background: done' },
];

function snapshot(agents = AGENTS) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents, artifacts: [],
    attention: { cards: [], agents: [], system: [], count: 0, prefs: {}, toasts: [], offers: [] },
    claude: { available: true, tools: true, current: null, history: [], cwd: '/work', canPopOut: false, poppedOut: false, onTop: null, titles: {} },
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

function memory(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
}

async function windowPage({ agents = AGENTS, hash = 'agents', storage = memory(), entries = [] } = {}) {
  const posts = [];
  const respond = (path, init) => {
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(init.body) });
      return { ok: true, text: 'Done' };
    }
    if (!path.startsWith('/api/agents/conversation')) return null;
    const a = agents.find((x) => x.handle === new URLSearchParams(path.split('?')[1]).get('handle'));
    return a ? { ...a, entries, pending: a.ask, partial: null } : null;
  };
  const page = await openPage({ respond, storage });
  page.show(snapshot(agents), hash);
  page.run("ui.agentFilter = 'all'; render()");
  const writes = () => posts.splice(0).filter((p) => p.path !== '/api/attention/presence');
  return Object.assign(page, { writes, storage });
}

const win = (page) => page.$('#agent-window');
const shown = (page) => Boolean(win(page)) && !win(page).hidden;
const named = (b) => b.textContent || b.getAttribute('title');
const buttonIn = (page, scope, label) => page.$$(scope + ' button').find((b) => named(b) === label);
const twice = (page, scope, label, confirm) => {
  buttonIn(page, scope, label).click();
  buttonIn(page, scope, confirm).click();
};
const row = (page, n) => page.$('#main .agent[data-handle="' + handle(n) + '"]');
const geometry = (page) => ['left', 'top', 'width', 'height'].map((k) => win(page).style[k]);

test('Open on an agent\'s row opens its window with the whole agent: kind, name, state, since, its MR, the ask, the actions, the conversation and the reply', async () => {
  const page = await windowPage({ entries: ENTRIES });
  assert.equal(shown(page), false);
  buttonIn(page, '#main .agent[data-handle="' + handle(1) + '"]', 'Open').click();
  await page.settle(50);
  assert.equal(shown(page), true);
  assert.equal(win(page).getAttribute('role'), 'dialog');
  assert.equal(win(page).getAttribute('aria-label'), 'agent-1');
  assert.equal(page.document.activeElement, win(page), 'the window takes focus');
  assert.equal(page.$('#agent-window .aw-kind').textContent, 'Review');
  assert.equal(page.$('#agent-window .aw-title h2').textContent, 'agent-1');
  assert.equal(page.$('#agent-window .aw-meta .pill').textContent, 'needs an answer');
  assert.equal(page.$('#agent-window .aw-meta .ref').textContent, 'engine!1');
  assert.match(page.$$('#agent-window .aw-meta .meta').at(-1).textContent, /^since /);
  assert.equal(page.$('#agent-window .ask .asked').textContent, 'Post them?');
  const actions = page.$('#agent-window .aw-body').childNodes.find((n) => n.classList?.contains('actions'));
  assert.deepEqual(actions.querySelectorAll('button').map(named), ['Stop', 'Open in Terminal']);
  assert.equal(buttonIn(page, '#agent-window', 'Conversation'), undefined, 'the conversation is always open in the window');
  assert.ok(page.$('#agent-window .screen .chat .log .said'), 'the conversation is read in the window');
  assert.equal(page.$('#agent-window .screen .reply textarea').id, 'agent-reply-' + handle(1), 'and it ends in the follow-up box');
  assert.ok(buttonIn(page, '#agent-window .aw-head', 'Close (Esc)'));
  assert.deepEqual(page.errors, []);
});

test('the window\'s MR or ticket opens its drawer at the start, since the window is already the agent', async () => {
  const page = await windowPage();
  page.run(`agentWinOpen(${JSON.stringify(handle(2))})`);
  page.$('#agent-window .aw-meta .ref').click();
  await page.settle(20);
  assert.deepEqual([page.run('ui.mr.key'), page.run('ui.mr.tab')], ['acme/engine!2', 'overview']);
  page.run('closeDrawer()');
  page.run(`agentWinOpen(${JSON.stringify(handle(3))})`);
  page.$('#agent-window .aw-meta .ticket-ref').click();
  await page.settle(20);
  assert.deepEqual([page.run('ui.ticket.key'), page.run('ui.ticket.tab')], ['ABC-12', 'overview']);
});

test('only one agent window: opening another agent switches it, and an agent no longer listed opens nothing', async () => {
  const page = await windowPage();
  buttonIn(page, '#main .agent[data-handle="' + handle(1) + '"]', 'Open').click();
  buttonIn(page, '#main .agent[data-handle="' + handle(3) + '"]', 'Open').click();
  assert.equal(page.$$('#agent-window').length, 1);
  assert.equal(win(page).getAttribute('aria-label'), 'agent-3');
  assert.equal(page.$('#agent-window .aw-kind').textContent, 'Kickoff');
  assert.equal(page.$$('#agent-window .aw-title h2').length, 1);
  assert.equal(page.run('agentWin.handle'), handle(3));
  page.run("agentWinOpen('claude:gone')");
  assert.equal(page.run('agentWin.handle'), handle(3), 'an unknown agent leaves the window as it was');
  page.show(snapshot(AGENTS.filter((a) => a.handle !== handle(3))), 'agents');
  assert.equal(shown(page), false, 'its agent removed, the window closes');
});

test('Jump to\'s agent entries, a summons and the message agent each open the agent window, wherever you are', async () => {
  const page = await windowPage({ hash: 'overview' });
  page.run("openPalette('agent-2')");
  assert.equal(page.run('palette.shown[0].id'), 'agent:' + handle(2));
  page.fire(page.$('#palette-q'), 'keydown', { key: 'Enter' });
  assert.equal(shown(page), true);
  assert.equal(win(page).getAttribute('aria-label'), 'agent-2');
  assert.deepEqual([page.run('location.hash'), page.run('ui.mr')], ['#overview', null], 'it neither leaves the view nor opens the MR');
  page.run(`goTo('agent:${handle(4)}')`);
  assert.equal(win(page).getAttribute('aria-label'), 'agent-4');
  page.run(`showMessageAgent(${JSON.stringify(handle(1))})`);
  assert.equal(win(page).getAttribute('aria-label'), 'agent-1');
  assert.equal(page.run('location.hash'), '#overview');
});

test('Esc from inside closes it and the close button does too, each handing focus back to what opened it', async () => {
  const page = await windowPage();
  const open = buttonIn(page, '#main .agent[data-handle="' + handle(1) + '"]', 'Open');
  open.focus();
  open.click();
  assert.equal(page.document.activeElement, win(page));
  page.fire(win(page), 'keydown', { key: 'Escape' });
  assert.equal(shown(page), false);
  assert.equal(page.document.activeElement.id, 'agent-open-' + handle(1));
  page.document.getElementById('agent-open-' + handle(1)).click();
  const box = page.$$('#agent-window textarea')[0];
  box.focus();
  page.fire(box, 'keydown', { key: 'Escape' });
  assert.equal(page.document.activeElement, win(page), 'Esc in the reply box leaves it for the window first');
  assert.equal(shown(page), true);
  page.fire(win(page), 'keydown', { key: 'Escape' });
  assert.equal(shown(page), false);
  page.document.getElementById('agent-open-' + handle(1)).click();
  buttonIn(page, '#agent-window .aw-head', 'Close (Esc)').click();
  assert.equal(shown(page), false);
  assert.equal(page.document.activeElement.id, 'agent-open-' + handle(1));
});

test('the window answers and acts through the same routes, with the same words, as the Agents list', async () => {
  const list = await windowPage();
  twice(list, '#main .agent[data-handle="' + handle(1) + '"] .options', 'Yes', 'Answer “Yes” to agent-1?');
  twice(list, '#main .agent[data-handle="' + handle(2) + '"] .options', 'Allow Bash', 'Allow Bash for agent-2?');
  await list.settle();
  const listed = list.writes();
  assert.deepEqual(listed.map((p) => p.path), ['/api/matrix/agent-reply', '/api/matrix/agent-reply']);
  const page = await windowPage({ hash: 'overview' });
  page.run(`agentWinOpen(${JSON.stringify(handle(1))})`);
  await page.settle(50);
  twice(page, '#agent-window .options', 'Yes', 'Answer “Yes” to agent-1?');
  page.run(`agentWinOpen(${JSON.stringify(handle(2))})`);
  await page.settle(50);
  twice(page, '#agent-window .options', 'Allow Bash', 'Allow Bash for agent-2?');
  await page.settle();
  assert.deepEqual(page.writes(), listed);
  twice(page, '#agent-window', 'Stop', 'Stop agent-2?');
  page.run(`agentWinOpen(${JSON.stringify(handle(4))})`);
  buttonIn(page, '#agent-window', 'Open in Terminal').click();
  twice(page, '#agent-window', 'Remove', 'Remove agent-4 and its worktree?');
  await page.settle();
  assert.deepEqual(page.writes().map((p) => [p.path, p.body.handle]), [
    ['/api/matrix/agent-stop', handle(2)], ['/api/matrix/agent-terminal', handle(4)], ['/api/matrix/agent-remove', handle(4)],
  ]);
  const box = page.$('#agent-window textarea');
  box.value = 'Carry on';
  page.fire(box, 'input');
  twice(page, '#agent-window .reply', 'Send', 'Send “Carry on” to agent-4?');
  await page.settle();
  assert.deepEqual(page.writes(), [{ path: '/api/matrix/agent-reply', body: { handle: handle(4), text: 'Carry on', expect: { state: 'done', since: 1004, pending: null } } }]);
  assert.deepEqual(page.errors, []);
});

test('it opens about 640 wide and most of the window high, and where it was moved and its size are kept for this viewer, inside the window', async () => {
  const storage = memory();
  const page = await windowPage({ storage });
  page.run(`agentWinOpen(${JSON.stringify(handle(1))})`);
  assert.deepEqual(geometry(page), ['736px', '8px', '640px', '884px']);
  page.run("{ const h = agentWinHost(); h.getBoundingClientRect = () => ({ left: parseFloat(h.style.left), top: parseFloat(h.style.top), width: parseFloat(h.style.width), height: parseFloat(h.style.height) }); }");
  const drag = (node, dx, dy) => {
    page.fire(node, 'pointerdown', { clientX: 0, clientY: 0 });
    page.fire(page.document.body, 'pointermove', { clientX: dx, clientY: dy });
    page.fire(page.document.body, 'pointerup', { clientX: dx, clientY: dy });
  };
  drag(page.$('#agent-window .float-grip'), -100, -200);
  assert.deepEqual(geometry(page), ['736px', '8px', '540px', '684px']);
  drag(page.$('#agent-window .aw-head'), -200, 100);
  assert.deepEqual(geometry(page), ['536px', '108px', '540px', '684px']);
  assert.deepEqual(JSON.parse(storage.map.get('cc.agentWindow')), { x: 536, y: 108, w: 540, h: 684 });
  const again = await windowPage({ storage });
  again.run(`agentWinOpen(${JSON.stringify(handle(2))})`);
  assert.deepEqual(geometry(again), ['536px', '108px', '540px', '684px'], 'it opens where it was left, for any agent');
  storage.map.set('cc.agentWindow', JSON.stringify({ x: 5000, y: -40, w: 99999, h: 100 }));
  const clamped = await windowPage({ storage });
  clamped.run(`agentWinOpen(${JSON.stringify(handle(1))})`);
  assert.deepEqual(geometry(clamped), ['8px', '8px', '1384px', '360px']);
});

test('the window and the Claude panel each come to the front when used, and the one behind stays above the drawer', async () => {
  const page = await windowPage();
  page.run('openClaudePanel()');
  page.run(`agentWinOpen(${JSON.stringify(handle(1))})`);
  assert.deepEqual([win(page).classList.contains('float-back'), page.$('#claude-panel').classList.contains('float-back')], [false, true]);
  page.fire(page.$('#claude-panel .cp-head'), 'pointerdown');
  assert.deepEqual([win(page).classList.contains('float-back'), page.$('#claude-panel').classList.contains('float-back')], [true, false]);
  const css = await readFile(new URL('./04-float.css', import.meta.url), 'utf8');
  assert.match(css, /\.float\s*\{[^}]*z-index:\s*6/);
  assert.match(css, /\.float\.float-back\s*\{[^}]*z-index:\s*5/);
});

const STYLES = (await Promise.all((await readdir(new URL('./', import.meta.url))).filter((n) => n.endsWith('.css')).sort().map((n) => readFile(new URL('./' + n, import.meta.url), 'utf8')))).join('\n');
const RULES = [...STYLES.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({ selectors: selectors.split(',').map((s) => s.trim()), body }));
const declared = (selector, property) => RULES.filter((r) => r.selectors.includes(selector)).map((r) => new RegExp('(?:^|;)\\s*' + property + ':\\s*([^;]+)').exec(r.body)?.[1].trim()).filter(Boolean).at(-1);

test('every part of a conversation wraps to its width: the column cannot outgrow the box, whatever the log holds, and code and tables wrap too', async () => {
  const page = await windowPage({ entries: ENTRIES });
  page.run(`agentWinOpen(${JSON.stringify(handle(1))})`);
  await page.settle(50);
  const kids = new Set(page.$$('#agent-window .chat .log').flatMap((log) => log.childNodes.filter((n) => n.nodeType === 1).map((n) => n.tagName)));
  assert.deepEqual([...kids].sort(), ['DETAILS', 'DIV'], 'a run of tool calls is a details, not a div');
  assert.equal(declared('.chat .log', 'grid-template-columns'), 'minmax(0, 1fr)');
  assert.equal(declared('.chat .log > *', 'min-width'), '0');
  assert.equal(declared('.chat .log > *', 'overflow-wrap'), 'anywhere');
  assert.equal(declared('.chat .md pre', 'white-space'), 'pre-wrap');
  assert.equal(declared('.chat .md pre code', 'overflow-wrap'), 'anywhere');
  assert.equal(declared('.chat .md table', 'overflow-wrap'), 'anywhere');
  assert.ok(page.$('#agent-window .chat .md pre') && page.$('#agent-window .chat .md table'), 'the conversation has the code and the table those rules are for');
  assert.equal(declared('.aw-body .screen .chat', 'max-height'), 'none', 'in the window the conversation fills its height');
  assert.match(declared('.aw-body > .screen', 'flex'), /^1 1/);
});

test('the window says what the agent is doing beside its state, as the list does', async () => {
  const page = await windowPage({ agents: [...AGENTS, agent(5, { kind: 'kickoff', mr: null, ticket: 'ABC-2753', phase: 'building', raisedMr: 'acme/engine!58' })] });
  page.run(`agentWinOpen(${JSON.stringify(handle(5))})`);
  assert.deepEqual([page.$('#agent-window .aw-kind').textContent, page.$('#agent-window .aw-meta .pill').textContent, page.$('#agent-window .aw-meta .agent-phase').textContent], ['Kickoff', 'working', 'Building']);
  assert.equal(page.$('#agent-window .aw-meta .ref').textContent, 'engine!58');
  page.run(`agentWinOpen(${JSON.stringify(handle(1))})`);
  assert.equal(page.$('#agent-window .aw-meta .agent-phase'), null, 'needs an answer says it already');
});
