import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { openPage } from './testkit.mjs';

const AT = '2026-11-10T12:00:00Z';
const NOW = Date.parse(AT);
const handle = (n) => `claude:${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const QUESTION = { id: 'q1', tool: 'AskUserQuestion', summary: 'AskUserQuestion', questions: [{ question: 'Post them?', options: [{ label: 'Yes' }, { label: 'No' }] }] };
const PERMISSION = { id: 'p1', tool: 'Bash', summary: 'npm test', questions: null, input: '{}' };

function agent(n, extra = {}) {
  return {
    handle: handle(n), name: 'agent-' + n, title: 'task ' + n, kind: 'review', mr: 'acme/engine!' + n, ticket: null, worktree: null, cwd: '/work',
    state: 'working', since: 1000 + n, lastAt: NOW - n * 1000, alive: true, said: '', outcome: null, ask: null, ...extra,
  };
}

const working = (n, extra) => agent(n, extra);
const asking = (n, extra) => agent(n, { state: 'waiting', ask: QUESTION, ...extra });
const idle = (n, extra) => agent(n, { state: 'done', alive: false, outcome: 'success', ...extra });
const stopped = (n, extra) => agent(n, { state: 'done', alive: false, outcome: 'stopped', ...extra });

const OFFICE_PURE = ['31-mood.js', '31-office-floor.js', '31-office-sim.js'];

// The office's own files, run on their own with core's one rule about who needs you.
async function sim() {
  const context = vm.createContext({ isNeed: (a) => a.state !== 'working' && a.state !== 'done', console });
  for (const name of OFFICE_PURE) vm.runInContext(await readFile(new URL('./' + name, import.meta.url), 'utf8'), context);
  return (code, values = {}) => {
    Object.assign(context, values);
    return vm.runInContext(code, context);
  };
}

function snapshot(agents) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents, artifacts: [],
    attention: { cards: [], agents: [], system: [], count: 0, prefs: {}, toasts: [], offers: [] },
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

// Every call answers something truthy, which is all the renderer asks of a context it is only setting up.
const FAKE_GL = `new Proxy({}, { get: (t, k) => (k === 'canvas' ? null : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({})) })`;

async function officePage(agents, { gl = true, storage = memory({ 'cc.agentLayout': 'office' }), globals = {} } = {}) {
  const posts = [];
  const respond = (path, init) => {
    if (init?.method === 'POST') posts.push({ path, body: JSON.parse(init.body) });
    if (path.startsWith('/api/agents/conversation')) return { ...agents[0], entries: [], pending: null };
    return init?.method === 'POST' ? { ok: true, text: 'Done' } : null;
  };
  const page = await openPage({ respond, storage, globals });
  if (gl) page.run(`{ const make = document.createElement.bind(document); document.createElement = (tag) => Object.assign(make(tag), tag === 'canvas' ? { getContext: (kind) => (kind === 'webgl2' ? ${FAKE_GL} : null) } : {}); }`);
  page.show(snapshot(agents), 'agents');
  return { page, posts: () => posts.splice(0) };
}

const who = (page) => page.$$('#main .office-people button').map((b) => b.textContent);
const person = (page, id) => page.document.getElementById('office-who-' + id);
const buttonIn = (page, scope, label) => page.$$(scope + ' button').find((b) => b.textContent === label);

test('working goes to a pod, asking stands at its pod to wave, idle goes to the lounge and stopped goes to the door', async () => {
  const run = await sim();
  const plan = run('officePlan(agents, officeMemory(), now)', { agents: [working(1), asking(2), agent(3, { state: 'blocked', ask: PERMISSION }), idle(4), stopped(5)], now: NOW });
  const place = (n) => plan.places.get(handle(n));
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => [place(n).role, place(n).spot.split(':')[0]]), [['pod', 'pod'], ['wave', 'stand'], ['wave', 'stand'], ['idle', place(4).activity], ['leave', 'door']]);
  assert.ok(['coffee', 'sofa', 'chat', 'board', 'wander'].includes(place(4).activity), place(4).spot);
  assert.equal(place(2).pod, Number(place(2).spot.split(':')[1]), 'it waves at its own pod');
});

test('only the latest idle agents stay in the lounge, the rest have gone home', async () => {
  const run = await sim();
  const idlers = Array.from({ length: 9 }, (_, i) => idle(i + 1, { lastAt: NOW - (i + 1) * 60000 }));
  const plan = run('officePlan(agents, officeMemory(), now)', { agents: idlers, now: NOW });
  const roles = idlers.map((a) => plan.places.get(a.handle).role);
  assert.deepEqual(roles, ['idle', 'idle', 'idle', 'idle', 'idle', 'idle', 'home', 'home', 'home']);
});

test('table tennis pairs two idle agents and never one at work or asking', async () => {
  const run = await sim();
  const mem = run('officeMemory()');
  const pairOf = (agents) => run('officePlan(agents, mem, now).pair', { agents, mem, now: NOW });
  assert.equal(pairOf([working(1), asking(2), idle(3)]), null, 'one idle agent has nobody to play');
  assert.deepEqual([...pairOf([working(1), asking(2), idle(3), idle(4)])], [handle(3), handle(4)]);
  assert.deepEqual([...pairOf([working(1), asking(2), working(3), idle(4), idle(5)])], [handle(5), handle(4)], 'the one called back to work leaves its end to the next idle one, and its partner stays where it is');
  const places = run('officePlan(agents, mem, now).places', { agents: [working(1), asking(2), working(3), idle(4), idle(5)], mem, now: NOW });
  assert.deepEqual([4, 5].map((n) => places.get(handle(n)).spot).sort(), ['ping:0', 'ping:1']);
  assert.ok([1, 2, 3].every((n) => !places.get(handle(n)).spot.startsWith('ping')));
});

test('an agent keeps its pod across snapshots, and a newcomer takes a free one rather than an idle agent\'s', async () => {
  const run = await sim();
  const mem = run('officeMemory()');
  const pods = (agents) => {
    const plan = run('officePlan(agents, mem, now)', { agents, mem, now: NOW });
    return Object.fromEntries(agents.filter((a) => plan.places.get(a.handle).pod != null).map((a) => [a.name, plan.places.get(a.handle).pod]));
  };
  assert.deepEqual(pods([working(1), working(2), working(3)]), { 'agent-1': 0, 'agent-2': 1, 'agent-3': 2 });
  assert.deepEqual(pods([working(3), working(2), working(1)]), { 'agent-1': 0, 'agent-2': 1, 'agent-3': 2 }, 'the order of the snapshot does not matter');
  assert.deepEqual(pods([idle(1), working(2), working(3), working(4)]), { 'agent-2': 1, 'agent-3': 2, 'agent-4': 3 });
  assert.deepEqual(pods([asking(1), working(2), working(3), working(4)]), { 'agent-1': 0, 'agent-2': 1, 'agent-3': 2, 'agent-4': 3 }, 'back at its own pod to ask');
  assert.deepEqual(pods([working(2), working(4)]), { 'agent-2': 1, 'agent-4': 3 }, 'a removed agent frees nobody else\'s pod');
});

test('a path walks round the desks, never through a blocked cell, and there is none to a sealed room', async () => {
  const run = await sim();
  run('L = officeLayout(6); grid = officeGrid(L); path = officePath(grid, L.door.inside, L.spots["pod:3"].via[0])');
  const path = run('path');
  assert.ok(path.length >= 2);
  assert.deepEqual(path.at(-1), run('L.spots["pod:3"].via[0]'));
  for (let i = 1; i < path.length; i++) assert.ok(run('officeClear(grid, a, b)', { a: path[i - 1], b: path[i] }), `leg ${i} crosses furniture`);
  const desk = run('L.blocks[3]');
  const crossesDesk = (a, b) => Array.from({ length: 50 }, (_, k) => k / 49).some((u) => {
    const x = a.x + (b.x - a.x) * u;
    const z = a.z + (b.z - a.z) * u;
    return x > desk.x0 && x < desk.x1 && z > desk.z0 && z < desk.z1;
  });
  assert.ok(!path.slice(1).some((p, i) => crossesDesk(path[i], p)));
  run('wall = { w: 6, d: 6, door: { z: 3, outside: { x: -0.6 } }, blocks: [{ x0: 2.9, x1: 3.1, z0: 0, z1: 4.6 }] }; wallGrid = officeGrid(wall)');
  const round = run('officePath(wallGrid, { x: 1, z: 1 }, { x: 5, z: 1 })');
  assert.ok(round.some((p) => p.z > 4.6), 'it goes round the end of the wall');
  run('sealed = { ...wall, blocks: [{ x0: 2.9, x1: 3.1, z0: 0, z1: 6 }] }');
  assert.equal(run('officePath(officeGrid(sealed), { x: 1, z: 1 }, { x: 5, z: 1 })'), null);
});

test('a change of state walks: a newcomer comes in at the door, a stopped agent walks out and is gone, nobody jumps', async () => {
  const run = await sim();
  run('scene = officeScene()');
  run('officeSync(scene, agents, now)', { agents: [working(1), idle(2)], now: NOW });
  const actor = (n) => run(`scene.actors.get(${JSON.stringify(handle(n))})`);
  assert.equal(actor(1).path.length, 0, 'the first snapshot finds everyone already in place');
  run('officeSync(scene, agents, now)', { agents: [stopped(1), idle(2), working(3)], now: NOW });
  const door = run('scene.layout.door');
  assert.deepEqual([actor(3).x, actor(3).z], [door.outside.x, door.outside.z], 'the newcomer starts outside the door');
  assert.ok(actor(3).path.length > 0 && actor(1).path.length > 0);
  assert.deepEqual([actor(1).path.at(-1).x, actor(1).path.at(-1).z], [door.outside.x, door.outside.z], 'the stopped one heads out of the door');
  const seat = run('scene.layout.spots["pod:" + scene.plan.places.get(h).pod]', { h: handle(3) });
  let biggest = 0;
  for (let i = 0; i < 1200 && actor(3)?.path.length; i++) {
    const [x, z] = [actor(3).x, actor(3).z];
    run('officeStep(scene, 1 / 60)');
    biggest = Math.max(biggest, Math.hypot(actor(3).x - x, actor(3).z - z));
  }
  assert.ok(biggest < 0.03, `no step longer than a walk: ${biggest}`);
  assert.deepEqual([actor(3).x, actor(3).z, actor(3).pose], [seat.x, seat.z, 'type']);
  assert.equal(actor(1), undefined, 'out of the door and gone');
});

test('one called away from the table stops leaning towards the ball, and the rally starts afresh', async () => {
  const run = await sim();
  run('scene = officeScene()');
  run('officeSync(scene, agents, now)', { agents: [working(1), idle(2), idle(3)], now: NOW });
  run('scene.actors.get(h).lane = 0.4; Object.assign(scene.rally, { miss: true, rest: 500, count: 7 })', { h: handle(2) });
  run('officeSync(scene, agents, now); officeStep(scene, 1 / 60)', { agents: [working(1), working(2), idle(3)], now: NOW });
  assert.equal(run('scene.actors.get(h).lane', { h: handle(2) }), 0);
  assert.deepEqual(JSON.parse(run('JSON.stringify([scene.rally.playing, scene.rally.miss, scene.rally.rest, scene.rally.count])')), [false, false, 0, 0]);
});

test('a second row of pods leaves the rest of the room where it was', async () => {
  const run = await sim();
  const room = (pods) => run('L = officeLayout(n); JSON.stringify([L.d, L.door, L.boss, L.spots["ping:0"], L.spots["sofa:1"], L.spots["pod:5"]])', { n: pods });
  assert.equal(room(7), room(6));
  assert.equal(room(12), room(6));
});

test('the List and Office switch is remembered for this browser, and b flips it', async () => {
  const storage = memory();
  const { page } = await officePage([working(1), asking(2)], { storage });
  assert.ok(page.$('#main .agent'), 'the list is the default');
  page.$('#agent-layout-office').click();
  assert.equal(storage.map.get('cc.agentLayout'), 'office');
  assert.ok(page.$('#main .office .office-stage') && !page.$('#main .agent'));
  const again = await officePage([working(1)], { storage });
  assert.ok(again.page.$('#main .office'), 'opened again in the office');
  again.page.fire(again.page.document.body, 'keydown', { key: 'b' });
  assert.ok(again.page.$('#main .agent') && !again.page.$('#main .office'));
  assert.equal(storage.map.get('cc.agentLayout'), 'list');
  assert.deepEqual([...page.errors, ...again.page.errors], []);
});

test('Jump to has Open the office, which goes to Agents as the office', async () => {
  const { page } = await officePage([working(1)], { storage: memory() });
  page.run("location.hash = '#overview'; render()");
  const entry = page.run("keymap().find((x) => x.id === 'act-layout:agents')");
  assert.equal(entry.label, 'Open the office');
  entry.run();
  await page.settle();
  assert.equal(page.run('agentLayout()'), 'office');
});

test('an agent in the office, its pod or its chip, opens in the agent window rather than a side card, and stays picked out while it is open', async () => {
  const { page } = await officePage([asking(1), working(2), idle(3)]);
  person(page, handle(1)).click();
  const win = page.$('#agent-window');
  assert.equal(win.hidden, false);
  assert.equal(win.getAttribute('aria-label'), 'agent-1');
  assert.equal(page.document.activeElement, win, 'the window takes focus from the keyboard');
  assert.equal(page.$('#office-card'), null, 'no side card for an agent');
  assert.equal(page.$('#main .office').classList.contains('has-card'), false, 'the office keeps its full width');
  assert.equal(page.run('office.selected'), handle(1));
  assert.equal(person(page, handle(1)).getAttribute('aria-pressed'), 'true');
  person(page, handle(2)).click();
  assert.deepEqual([page.$$('#agent-window').length, win.getAttribute('aria-label'), page.run('office.selected')], [1, 'agent-2', handle(2)], 'one window, switched');
  page.$$('#main .office-waiting .chip')[0].click();
  assert.deepEqual([win.getAttribute('aria-label'), page.run('office.selected')], ['agent-1', handle(1)]);
  page.run('officePick = () => ' + JSON.stringify(handle(3)));
  page.fire(page.$('#main .office-canvas'), 'pointerdown', { clientX: 5, clientY: 5 });
  page.fire(page.$('#main .office-canvas'), 'pointerup', { clientX: 5, clientY: 5 });
  assert.equal(win.getAttribute('aria-label'), 'agent-3', 'a click on it or its pod in the scene opens it too');
  assert.deepEqual(page.errors, []);
});

test('Esc closes the agent window and hands focus back to the agent, and a click on the empty floor closes it as it closed the card', async () => {
  const { page } = await officePage([working(1), idle(2)]);
  const who = person(page, handle(1));
  who.focus();
  who.click();
  page.fire(page.$('#agent-window'), 'keydown', { key: 'Escape' });
  assert.equal(page.$('#agent-window').hidden, true);
  assert.equal(page.document.activeElement.id, 'office-who-' + handle(1));
  assert.equal(page.run('office.selected'), null, 'the office lets it go');
  person(page, handle(2)).click();
  const canvas = page.$('#main .office-canvas');
  page.fire(canvas, 'pointerdown', { clientX: 5, clientY: 5 });
  page.fire(canvas, 'pointerup', { clientX: 5, clientY: 5 });
  assert.equal(page.$('#agent-window').hidden, true);
  assert.equal(page.run('office.selected'), null);
});

test('the manager has its own card, which opens the Claude panel', async () => {
  const { page } = await officePage([working(1)]);
  person(page, 'office:manager').click();
  assert.match(page.$('#office-card').textContent, /Claude/);
  assert.ok(buttonIn(page, '#office-card', 'Open the Claude panel'));
});

test('a name tag leads with its ticket or MR, then the MR it raised, then what it is doing, and says its kind in full on hover', async () => {
  const agents = [
    working(1, { phase: 'building' }),
    working(2, { kind: 'fix', mr: 'acme/engine!88', phase: 'testing' }),
    working(3, { kind: 'kickoff', mr: null, ticket: 'ABC-2753', phase: 'testing', raisedMr: 'acme/engine!58' }),
    working(4, { kind: 'kickoff', mr: null, ticket: 'ABC-2871', phase: 'builders', background: ['Build it in engine', 'Build it in ui'] }),
    working(5, { kind: 'message', mr: null, title: 'Slack: #deploys · Judy', phase: 'exploring' }),
    working(6, { kind: 'fix', mr: 'acme/engine!6', phase: 'mr', raisedMr: 'acme/engine!6' }),
    asking(7, { phase: 'waiting' }),
    idle(8, { kind: 'kickoff', mr: null, ticket: 'ABC-9', phase: 'done' }),
    stopped(9, { phase: 'stopped' }),
    working(10),
  ];
  const { page } = await officePage(agents);
  const tags = () => JSON.parse(page.run('JSON.stringify(state.agents.map((a) => officeTagText(a)))'));
  assert.deepEqual(tags(), [
    'engine!1 · Building', 'engine!88 · Testing', 'ABC-2753 · engine!58 · Testing', 'ABC-2871 · 2 builders running', 'Slack · Exploring',
    'engine!6 · Raising MR', 'engine!7 · Waiting on you', 'ABC-9 · Done', 'engine!9 · Stopped', 'engine!10 · Working',
  ]);
  const tagOf = (n) => page.run(`officeTagFor(office.scene.actors.get(${JSON.stringify(handle(n))})).node`);
  assert.equal(tagOf(3).dataset.kind, 'kickoff', 'the kind is still its colour');
  page.run(`office.hover = ${JSON.stringify(handle(3))}`);
  assert.equal(tagOf(3).querySelector('.office-name').textContent, 'Kickoff · ABC-2753 · engine!58 · Testing');
  page.run('office.hover = null');
  assert.equal(tagOf(3).querySelector('.office-name').textContent, 'ABC-2753 · engine!58 · Testing');
  assert.deepEqual(page.errors, []);
});

test('an agent that asks, or a finished kickoff that ends on a question, is waiting on you whatever its phase was', async () => {
  const ends = idle(2, { kind: 'kickoff', mr: null, ticket: 'ABC-12', phase: 'done', said: 'Shall I raise the MR now?' });
  const { page } = await officePage([asking(1, { phase: 'building' }), ends]);
  const snap = snapshot([asking(1, { phase: 'building' }), ends]);
  snap.matrix.runs = [{ key: 'kickoff:ABC-12', kickoff: true, status: 'running', terminal: handle(2) }];
  page.show(snap, 'agents');
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(state.agents.map((a) => officeTagText(a)))')), ['engine!1 · Waiting on you', 'ABC-12 · Waiting on you']);
});

test('screen readers get a list of who is where, in the order that matters, and the scene itself is hidden from them', async () => {
  const { page } = await officePage([idle(1, { mr: null, kind: 'kickoff', ticket: 'ABC-9', phase: 'done' }), working(2, { phase: 'mr', raisedMr: 'acme/engine!58' }), asking(3, { since: Date.now() - 42.5 * 60_000, phase: 'waiting' }), stopped(4, { phase: 'stopped' })]);
  const [first, second, third, ...rest] = who(page);
  assert.equal(first, 'Review · engine!3, needs an answer, at its desk, waiting 42 min, waving');
  assert.deepEqual([second, ...rest], ['Review · engine!2 · engine!58, working, raising MR, at its desk, happy at work', 'Review · engine!4, done, stopped, left the office, content', 'Claude, the manager, idle, at the big desk, content']);
  assert.match(third, /^Kickoff · ABC-9, done, (getting a coffee|on the sofa|chatting|at the whiteboard|stretching its legs), content$/);
  assert.equal(page.$('#main .office-canvas').getAttribute('aria-hidden'), 'true');
  assert.equal(page.$('#main .office-tags').getAttribute('aria-hidden'), 'true');
  page.fire(person(page, handle(3)), 'focus', { bubbles: false });
  assert.equal(page.run('office.focus'), handle(3));
});

test('without WebGL the office is the list, with a word to say why', async () => {
  const { page } = await officePage([working(1), asking(2)], { gl: false });
  assert.equal(page.$('#main .office'), null);
  assert.match(page.$('#main .banner').textContent, /needs WebGL/);
  assert.equal(page.$$('#main .agent').length, 2);
  assert.deepEqual(page.errors, []);
});

test('an office that throws while drawing goes back to the list rather than freeze', async () => {
  const { page } = await officePage([working(1), asking(2)]);
  assert.ok(page.$('#main .office'));
  page.run("officeBroke(new Error('no instancing'))");
  assert.equal(page.$('#main .office'), null);
  assert.match(page.$('#main .banner').textContent, /could not draw \(no instancing\)/);
  assert.equal(page.$$('#main .agent').length, 2);
});

test('with reduced motion the office stands still: everyone is placed, nobody walks, and the states show in colour and badges', async () => {
  const matchMedia = (query) => ({ matches: query.includes('reduce'), addEventListener() {} });
  const { page } = await officePage([working(1), idle(2)], { globals: { matchMedia } });
  assert.equal(page.$('#main .office').dataset.motion, 'still');
  page.show(snapshot([working(1), asking(2), working(3)]), 'agents');
  const actors = JSON.parse(page.run('JSON.stringify([...office.scene.actors.values()].map((a) => [a.path.length, a.pose]))'));
  assert.deepEqual(actors, [[0, 'type'], [0, 'wave'], [0, 'type']], 'the newcomer is at its desk, not at the door');
  assert.equal(page.run('office.loop'), null, 'no frame loop runs');
  page.show(snapshot([stopped(1), asking(2), working(3)]), 'agents');
  assert.deepEqual(JSON.parse(page.run('JSON.stringify([...office.scene.actors.keys()])')), [handle(2), handle(3)], 'a stopped one has gone, not left standing outside the door');
});

test('the name tags stay inside the scene, so a panel or menu over it is never shown through, and the card scrolls within its column', async () => {
  const css = await readFile(new URL('./31-office.css', import.meta.url), 'utf8');
  const rule = (selector) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, sel]) => sel.split(',').map((x) => x.trim()).includes(selector)).map(([, , body]) => body).join(';');
  assert.match(rule('.office-stage'), /isolation:\s*isolate/);
  assert.match(rule('.office-card'), /max-height:\s*calc\(100vh/);
  assert.match(rule('.office-card'), /overflow:\s*auto/);
  assert.match(rule('.office-card > *'), /min-width:\s*0/);
});
