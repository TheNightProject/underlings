import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { MOOD_MINUTES } from '../lib/moods.mjs';
import { openPage } from './testkit.mjs';

const AT = '2026-11-11T12:00:00Z';
const NOW = Date.parse(AT);
const MIN = 60000;
const handle = (n) => `claude:${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const QUESTION = { id: 'q1', tool: 'AskUserQuestion', summary: 'AskUserQuestion', questions: [{ question: 'Post them?', options: [{ label: 'Yes' }] }] };
const agent = (n, extra = {}) => ({
  handle: handle(n), name: 'agent-' + n, title: 'task ' + n, kind: 'review', mr: 'acme/engine!' + n, ticket: null, worktree: null, cwd: '/work',
  state: 'working', since: NOW - MIN, lastAt: NOW - n * 1000, alive: true, said: '', outcome: null, ask: null, ...extra,
});
const working = (n, extra) => agent(n, extra);
const asking = (n, minutes = 0, extra) => agent(n, { state: 'waiting', ask: QUESTION, since: NOW - minutes * MIN, ...extra });
const idle = (n, extra) => agent(n, { state: 'done', alive: false, outcome: 'success', ...extra });
const ROOMS = ['room-kitchen', 'room-games', 'room-extension', 'room-terrace'];
const FUN = ['office-arcade', 'office-console', 'office-foosball', 'office-vr', 'office-beanbags', 'office-fishtank'];
const FUN_ACTS = ['arcade', 'console', 'foos', 'vr', 'beanbag', 'fish', 'lunch', 'terrace'];

async function sim(isNeed = (a) => a.state !== 'working' && a.state !== 'done') {
  const context = vm.createContext({ isNeed, console });
  for (const name of ['31-mood.js', '31-office-floor.js', '31-office-sim.js']) vm.runInContext(await readFile(new URL('./' + name, import.meta.url), 'utf8'), context);
  return (code, values = {}) => {
    Object.assign(context, values);
    return vm.runInContext(code, context);
  };
}

const json = (run, code, values) => JSON.parse(run('JSON.stringify(' + code + ')', values));

test('a mood follows the state and how long it has lasted, through every state and each threshold', async () => {
  const run = await sim((a) => a.state === 'waiting' || a.state === 'blocked' || Boolean(a.fixWaits));
  const mood = (a, extra = {}) => json(run, 'moodOf(a, now, limits, answeredAt)', { a, now: NOW, limits: MOOD_MINUTES, answeredAt: 0, ...extra }).mood;
  const waitedFor = (minutes, state = 'waiting') => mood({ state, since: NOW - minutes * MIN });
  const { impatient, grumpy, angry } = MOOD_MINUTES;
  assert.ok(impatient < grumpy && grumpy < angry && angry <= 60, 'minutes to an hour, rising');
  assert.deepEqual([0, impatient - 0.1, impatient, grumpy - 0.1, grumpy, angry - 0.1, angry, 300].map((m) => waitedFor(m)),
    ['fresh', 'fresh', 'impatient', 'impatient', 'grumpy', 'grumpy', 'angry', 'angry']);
  assert.equal(waitedFor(angry, 'blocked'), 'angry', 'a permission waits like a question');
  assert.equal(mood({ state: 'done', since: NOW - angry * MIN, fixWaits: true }), 'angry', 'so does a finished agent that still needs you');
  assert.equal(mood({ state: 'working', since: NOW - 3 * MIN }), 'happy');
  assert.equal(mood({ state: 'working' }, { answeredAt: NOW - 2000 }), 'cheer', 'answered a moment ago');
  assert.equal(mood({ state: 'working' }, { answeredAt: NOW - 60000 }), 'happy', 'and then back to plain happy work');
  assert.equal(mood({ state: 'done', outcome: 'success' }), 'content');
  assert.equal(mood({ state: 'done', outcome: 'stopped' }), 'content');
  assert.equal(mood({ state: 'done', outcome: 'error' }), 'sad');
  assert.equal(mood({ state: 'waiting', since: NOW - 300 * MIN }, { limits: null }), 'fresh', 'without thresholds a wait never escalates');
  const words = (minutes) => run('moodWords(moodOf(a, now, limits))', { a: { state: 'waiting', since: NOW - minutes * MIN }, now: NOW, limits: MOOD_MINUTES });
  assert.deepEqual([0.5, 3, 12, 42, 65, 120].map(words), [
    'Just asked, waving', 'Waiting 3 min, waving', 'Waiting 12 min, getting impatient', 'Waiting 42 min, getting grumpy', 'Waiting 1 h 5 min, angry', 'Waiting 2 h, angry',
  ]);
  assert.equal(run("moodWords({ mood: 'sad', waited: 0 })"), 'Sad, its last turn failed');
});

test('idle agents only ever go to what has been bought, and do go to it once it has', async () => {
  const run = await sim();
  const idlers = Array.from({ length: 7 }, (_, i) => idle(i + 1));
  const used = (addons, rooms) => {
    const mem = run('officeMemory()');
    const acts = new Set();
    for (let k = 0; k < 120; k++) {
      const places = json(run, '[...officePlan(agents, mem, now, officeFloor(addons, rooms)).places.values()]', { agents: idlers, mem, now: NOW + k * 47000, addons, rooms });
      for (const p of places) if (p.activity) acts.add(p.activity);
    }
    return acts;
  };
  const bare = used([], []);
  assert.deepEqual(FUN_ACTS.filter((act) => bare.has(act)), [], 'nothing bought, nothing used');
  const L = json(run, 'Object.keys(officeLayout(12, officeFloor([], [])).spots)');
  assert.deepEqual(L.filter((key) => FUN_ACTS.includes(key.split(':')[0])), [], 'and no spot exists for it');
  const some = used(['office-arcade', 'office-beanbags'], ['room-kitchen']);
  assert.deepEqual(FUN_ACTS.filter((act) => some.has(act)).sort(), ['arcade', 'beanbag', 'lunch']);
  const all = used(FUN, ROOMS);
  assert.deepEqual(FUN_ACTS.filter((act) => all.has(act)).sort(), [...FUN_ACTS].sort(), 'everything bought gets used');
  const putAway = used(['office-vr'], ['room-terrace']);
  assert.ok(!putAway.has('terrace'), 'a terrace with no way in is not built yet');
});

test('the console and foosball pair two idle agents, never one at work, asking or you, and never just one', async () => {
  const run = await sim();
  const floor = run('officeFloor(addons, [])', { addons: ['office-console', 'office-foosball'] });
  const you = { handle: 'office:player', player: true, state: 'done', lastAt: Number.MAX_SAFE_INTEGER };
  const busy = [working(1), asking(2), working(3), asking(4)];
  const pairsOf = (agents, now = NOW, mem = run('officeMemory()')) => json(run, 'officePlan(agents, mem, now, floor).pairs', { agents, mem, now, floor });
  assert.deepEqual(pairsOf([...busy, you, idle(5)]), {}, 'one idle agent has nobody to play');
  assert.deepEqual(Object.keys(pairsOf([...busy, idle(5), idle(6), idle(7), idle(8)])), ['ping'], 'four idle play table tennis and leave the rest for the lounge');
  for (const t of [0, 1, 2, 3].map((k) => NOW + k * 600000)) {
    const pairs = pairsOf([...busy, you, ...[5, 6, 7, 8, 9, 10].map((n) => idle(n))], t);
    const games = Object.keys(pairs);
    assert.equal(games.length, 2);
    assert.equal(games[0], 'ping');
    assert.ok(['console', 'foos'].includes(games[1]));
    for (const pair of Object.values(pairs)) {
      assert.equal(pair.length, 2);
      for (const h of pair) assert.ok([5, 6, 7, 8, 9, 10].map(handle).includes(h), h + ' is idle');
    }
  }
  const seen = new Set([0, 1, 2, 3].flatMap((k) => Object.keys(pairsOf([...[5, 6, 7, 8, 9, 10].map((n) => idle(n))], NOW + k * 600000))));
  assert.deepEqual([...seen].sort(), ['console', 'foos', 'ping'], 'the other games take turns through the day');
  const mem = run('officeMemory()');
  const six = [5, 6, 7, 8, 9, 10];
  const first = pairsOf(six.map((n) => idle(n)), NOW, mem);
  const [game, [called, partner]] = Object.entries(first).find(([act]) => act !== 'ping');
  const n = (h) => Number(h.slice(7, 15));
  const after = pairsOf(six.map((k) => (k === n(called) ? working(k) : idle(k))), NOW, mem);
  assert.ok(!Object.values(after).flat().includes(called), 'one called back to work leaves the game');
  assert.equal(after[game]?.[1], partner, 'and its partner keeps its end');
});

test('every floor that can be built reaches every pod, seat and facility from the door', async () => {
  const run = await sim();
  const sets = [[]];
  for (const room of ROOMS) for (const set of [...sets]) sets.push([...set, room]);
  let checked = 0;
  for (const rooms of sets) {
    for (const addons of [[], FUN]) {
      const result = json(run, `(() => {
        const floor = officeFloor(addons, rooms);
        const L = officeLayout(floor.capacity, floor);
        const grid = officeGrid(L);
        const bad = [];
        for (const [key, spot] of Object.entries(L.spots)) {
          const target = spot.via?.[0] ?? spot;
          const near = officeNearestOpen(grid, officeCellOf(grid, target));
          const cell = officeCellCentre(grid, near % grid.cols, Math.floor(near / grid.cols));
          if (!officePath(grid, L.door.outside, target) || Math.hypot(cell.x - target.x, cell.z - target.z) > 0.45) bad.push(key);
        }
        return { bad, spots: Object.keys(L.spots).length, pods: L.pods.length, built: floor.rooms };
      })()`, { addons, rooms });
      assert.deepEqual(result.bad, [], `${rooms.join('+') || 'starter'} ${addons.length ? 'with' : 'without'} facilities`);
      if (rooms.includes('room-extension')) assert.equal(result.pods, 24);
      checked += result.spots;
    }
  }
  assert.ok(checked > 1500, 'every spot of every floor was walked to: ' + checked);
});

test('a full office borrows a laptop seat rather than grow, and the extension gives those agents pods while the rest keep theirs', async () => {
  const run = await sim();
  const mem = run('officeMemory()');
  const crowd = Array.from({ length: 14 }, (_, i) => working(i + 1));
  const plan = (rooms, agents = crowd) => json(run, '(() => { const p = officePlan(agents, mem, now, officeFloor([], rooms)); return { pods: p.pods, places: [...p.places] }; })()', { agents, mem, now: NOW, rooms });
  plan([], [idle(13), idle(14)]);
  plan([], [...crowd.slice(0, 12), idle(13), idle(14)]);
  const before = plan([]);
  assert.equal(before.pods, 12, 'the starter floor is today\'s two rows and no more');
  const where = (p) => Object.fromEntries(p.places.map(([h, place]) => [h, place.pod ?? place.spot]));
  const was = where(before);
  assert.deepEqual(crowd.slice(12).map((a) => was[a.handle]), ['hot:0', 'hot:1']);
  const after = plan(['room-extension']);
  const now = where(after);
  assert.equal(after.pods, 24);
  assert.deepEqual(crowd.slice(0, 12).map((a) => now[a.handle]), crowd.slice(0, 12).map((a) => was[a.handle]), 'nobody already at a pod moves');
  assert.deepEqual(crowd.slice(12).map((a) => now[a.handle]), [12, 13], 'the two on laptops take the first new pods, though they came in first');
  const pods = (rooms, n) => json(run, 'officeLayout(n, officeFloor([], rooms)).pods.map((p) => [p.x, p.z])', { rooms, n });
  assert.deepEqual(pods(['room-extension'], 24).slice(0, 12), pods([], 12), 'and the old pods stand where they stood');
  const rest = (rooms) => json(run, '(() => { const L = officeLayout(12, officeFloor([], rooms)); return [L.door, L.boss, L.spots["ping:0"], L.spots["sofa:1"]]; })()', { rooms });
  assert.deepEqual(rest(ROOMS), rest([]), 'the door, the manager and the lounge stay put as the floor grows');
});

test('a room bought while the office is watched goes up, and one there from the start, or under reduced motion, just stands', async () => {
  const run = await sim();
  run('scene = officeScene(); scene.clock = 50; officeSync(scene, agents, now)', { agents: [working(1)], now: NOW });
  run('scene.rooms = ["room-kitchen"]; officeSync(scene, agents, now)');
  assert.deepEqual(json(run, '[...scene.building]'), [['room-kitchen', 50]]);
  assert.equal(run('scene.layout.floor.rooms.join()'), 'room-kitchen');
  run('fresh = officeScene(); fresh.rooms = ["room-kitchen"]; officeSync(fresh, agents, now)');
  assert.deepEqual(json(run, '[...fresh.building]'), [], 'a page opened on a built kitchen does not build it again');
  run('still = officeScene(); officeSync(still, agents, now, { still: true }); still.rooms = ["room-games"]; officeSync(still, agents, now, { still: true })');
  assert.deepEqual(json(run, '[...still.building]'), []);
});

test('an answered agent cheers on its way back to its desk, and the scene keeps each agent\'s mood', async () => {
  const run = await sim();
  run('scene = officeScene(); scene.limits = limits; officeSync(scene, agents, now)', { agents: [asking(1, 50), asking(2, 21), working(3)], now: NOW, limits: MOOD_MINUTES });
  const moods = () => json(run, '[...scene.actors.values()].map((a) => a.mood.mood)');
  assert.deepEqual(moods(), ['angry', 'grumpy', 'happy']);
  run('officeSync(scene, agents, now)', { agents: [working(1), asking(2, 21), working(3)], now: NOW + 1000 });
  assert.deepEqual(moods(), ['cheer', 'grumpy', 'happy']);
  run('officeSync(scene, agents, now)', { now: NOW + 9000 });
  assert.deepEqual(moods(), ['happy', 'grumpy', 'happy']);
});

const FAKE_GL = `new Proxy({}, { get: (t, k) => (k === 'canvas' ? null : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({})) })`;

function snapshot(agents, extra = {}) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents, artifacts: [], moods: MOOD_MINUTES,
    attention: { cards: [], agents: [], system: [], count: 0, prefs: {}, toasts: [], offers: [] },
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
    ...extra,
  };
}

async function page(agents, { layout = 'office', gl = true, globals = {} } = {}) {
  const storage = { getItem: (k) => (k === 'cc.agentLayout' ? layout : null), setItem() {} };
  const style = () => ({ getPropertyValue: () => '' });
  const p = await openPage({ respond: () => null, storage, globals: { getComputedStyle: style, Date: class extends Date { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } }, ...globals } });
  if (gl) p.run(`{ const make = document.createElement.bind(document); document.createElement = (tag) => Object.assign(make(tag), tag === 'canvas' ? { getContext: (kind) => (kind === 'webgl2' ? ${FAKE_GL} : null) } : {}); }`);
  p.show(snapshot(agents), 'agents');
  return p;
}

const MIXED = [working(1), asking(2, 0.5), asking(3, 12), asking(4, 42), asking(5, 65), idle(6), idle(7, { outcome: 'error' })];

test('the list, the agent window and the office\'s list for screen readers all say each mood in words', async () => {
  const list = await page(MIXED, { layout: 'list' });
  list.run("ui.agentFilter = 'all'; render()");
  const said = (n) => list.$(`#main .agent[data-handle="${handle(n)}"] .agent-mood`)?.textContent;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(said), [
    'Happy at work', 'Just asked, waving', 'Waiting 12 min, getting impatient', 'Waiting 42 min, getting grumpy', 'Waiting 1 h 5 min, angry', 'Content', 'Sad, its last turn failed',
  ]);
  assert.equal(list.$(`#main .agent[data-handle="${handle(5)}"] .agent-mood`).dataset.mood, 'angry');
  list.run(`agentWinOpen(${JSON.stringify(handle(4))})`);
  assert.match(list.$('#agent-window').textContent, /Waiting 42 min, getting grumpy/);
  const office = await page(MIXED);
  const roster = office.$$('#main .office-people button').map((b) => b.textContent);
  assert.ok(roster.includes('Review · engine!5, needs an answer, at its desk, waiting 1 h 5 min, angry'), roster.join('\n'));
  assert.ok(roster.includes('Review · engine!1, working, at its desk, happy at work'));
  assert.deepEqual([...list.errors, ...office.errors], []);
});

test('the name tag\'s ! turns red for an angry agent and the waiting strip says who is cross', async () => {
  const office = await page(MIXED);
  const tag = (n) => office.run(`officeTagClass(office.scene.actors.get(${JSON.stringify(handle(n))}), false)`);
  assert.match(tag(5), /is-angry/);
  assert.match(tag(4), /is-grumpy/);
  assert.match(tag(3), /is-impatient/);
  assert.doesNotMatch(tag(2), /is-(angry|grumpy|impatient)/);
  const css = await readFile(new URL('./31-mood.css', import.meta.url), 'utf8');
  assert.match(css, /\.office-tag\.is-angry \.office-bang \{[^}]*background: var\(--bang\)/);
  assert.match(css, /\.office-tag\.is-angry \.office-bang \{[^}]*--bang: var\(--need\)/);
  assert.deepEqual(office.$$('#main .office-waiting .chip').map((c) => c.dataset.mood), ['fresh', 'impatient', 'grumpy', 'angry']);
});

test('with reduced motion a mood is in the face and its colour only: the body keeps its place\'s pose and nothing floats round the head', async () => {
  const matchMedia = (query) => ({ matches: query.includes('reduce'), addEventListener() {} });
  const office = await page(MIXED, { globals: { matchMedia } });
  assert.equal(office.$('#main .office').dataset.motion, 'still');
  const angry = `office.scene.actors.get(${JSON.stringify(handle(5))})`;
  assert.equal(office.run(`${angry}.mood.mood`), 'angry');
  assert.equal(office.run(`officePoseOf(${angry}, true)`), 'wave');
  assert.equal(office.run(`officePoseOf(${angry}, false)`), 'stomp');
  const drawn = (still) => office.run(`(() => { const f = officeFrame(); const look = officeLook(); officeMoodFx(f, look, ${angry}, { t: 1, still: ${still} }); return Object.values(f.solids).reduce((n, b) => n + b.n, 0) + f.glow.n; })()`);
  assert.equal(drawn(true), 0);
  assert.ok(drawn(false) > 0);
  assert.equal(office.run('office.loop'), null, 'no frame loop runs');
});

test('without WebGL the office is the list, and the list still says how everyone feels', async () => {
  const p = await page(MIXED, { gl: false });
  p.run("ui.agentFilter = 'all'; render()");
  assert.equal(p.$('#main .office'), null);
  assert.match(p.$('#main .banner').textContent, /needs WebGL/);
  assert.equal(p.$$('#main .agent-mood').length, MIXED.length);
  assert.deepEqual(p.errors, []);
});
