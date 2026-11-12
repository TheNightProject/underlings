import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const WALL = Date.parse('2026-11-10T12:00:00Z');
const MINUTE = 60_000;
const PACE = 1.8;
const CLOUD_MS = 930 * PACE;
const STORY_MS = (1880 - 930) * PACE;
const FLY_MS = 420 * PACE;
const CAP_MS = 15_000;
const GATHER_BY = CAP_MS - STORY_MS - FLY_MS;
const LIGHTS = [0, 300, 600, 900].map((gap) => CLOUD_MS + gap);
const GATHER_MS = LIGHTS[3] + 700;

const ENGINES = {
  up: null,
  starting: { available: false, error: 'starting' },
  broken: { available: false, error: 'the review engine did not load' },
};
const INBOXES = {
  done: { fetchedAt: WALL, loading: false, error: null },
  waiting: { fetchedAt: null, loading: true, error: null },
  failed: { fetchedAt: null, loading: false, error: 'GitLab said 401' },
};
const NEEDS = { done: { builtAt: new Date(WALL).toISOString(), buildError: null }, waiting: { builtAt: null, buildError: null }, failed: { builtAt: null, buildError: 'settings unreadable' }, old: {} };
const TICKETS = {
  read: { read: true, loading: false, error: null, tickets: [] },
  loading: { read: false, loading: true, error: null, tickets: [] },
  error: { read: false, loading: false, error: 'acli is not signed in to Jira', tickets: [] },
  refused: null,
};

function snapshot({ engine = 'up', gitlab = 'done', needs = 'done' } = {}) {
  const matrix = ENGINES[engine] ?? {
    available: true, me: 'frank', paused: false, inbox: { ...INBOXES[gitlab], repoCount: 1, rows: [] },
    fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
  };
  return {
    generatedAt: new Date(WALL).toISOString(), version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [],
    attention: { cards: [], agents: [], system: [], count: 0, prefs: {}, toasts: [], offers: [], ...NEEDS[needs] },
    matrix,
  };
}

// Frames and timers run only when the test moves time on, so every step of the intro lands on a known millisecond.
function fakeClock({ frames = true } = {}) {
  let now = 0;
  let id = 0;
  const due = new Map();
  const timers = new Map();
  const clock = {
    now: () => now,
    wall: () => WALL + now,
    frame: (fn) => { due.set(++id, fn); return id; },
    cancelFrame: (handle) => due.delete(handle),
    after: (ms, fn) => { timers.set(++id, [now + ms, fn]); return id; },
    cancelAfter: (handle) => timers.delete(handle),
  };
  async function tick(ms) {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 16);
      for (const [handle, [at, fn]] of [...timers]) if (at <= now && timers.delete(handle)) fn();
      const ready = frames ? [...due.values()] : [];
      if (frames) due.clear();
      for (const fn of ready) fn(now);
      await new Promise(setImmediate);
    }
  }
  return { clock, tick, waiting: () => due.size + timers.size, at: () => now };
}

function store(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
}

const refused = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };

async function page({ session = store(), prefs = store(), reduced = false, jira = 'read' } = {}) {
  const world = { jira };
  const p = await openPage({ storage: prefs, respond: (path) => (path === '/api/matrix/tickets' ? TICKETS[world.jira] : null) });
  p.window.sessionStorage = session;
  p.window.matchMedia = (query) => ({ matches: reduced && query.includes('reduced-motion') });
  return Object.assign(p, { world, ticketReads: () => p.requested.filter((path) => path === '/api/matrix/tickets').length });
}

async function played(options = {}, snap = snapshot()) {
  const p = await page(options);
  const clock = fakeClock(options.clock);
  if (snap) p.show(snap);
  p.window.introBoot(clock.clock);
  return Object.assign(p, clock);
}

const shown = (p) => p.$$('#intro').length;
const leaveAt = (p) => p.run('introRun?.leaveAt ?? null');
const gatherAt = (p) => p.run('introRun?.gatherAt ?? null');
const steps = (p) => p.$('#intro .intro-steps')?.textContent;
const lights = (p) => JSON.parse(p.run('JSON.stringify(introRun?.lit ?? null)'));
const labels = (p) => p.$$('#intro .intro-branch').filter((l) => l.classList.contains('is-on')).map((l) => l.textContent);

async function until(p, ready, ms) {
  for (let spent = 0; spent < ms && !ready(); spent += 16) await p.tick(16);
  return ready();
}

function painterSpy(p) {
  p.window.drawn = [];
  p.run('introRun.paint = { draw: (...args) => window.drawn.push(JSON.stringify(args)), resize() {}, seed: () => null }');
  return () => JSON.parse(p.window.drawn.at(-1));
}

test('a cold load plays the intro once, covering the page, and nothing in that page plays it again', async () => {
  const p = await page({ session: refused });
  const { clock, tick } = fakeClock();
  assert.equal(shown(p), 0, 'the stand-in page has no animation frames, so it never starts by itself');
  assert.equal(p.window.introBoot(clock), true);
  assert.equal(shown(p), 1);
  assert.equal(p.$('.app').inert, true, 'nothing behind it takes focus or a click');
  assert.ok(p.document.documentElement.classList.contains('intro-on'));
  assert.equal(p.window.introBoot(clock), false, 'a second start while it plays does nothing');
  p.show(snapshot());
  assert.equal(shown(p), 1, 'a render does not start another');
  await tick(6200);
  assert.equal(shown(p), 0);
  assert.equal(p.window.introBoot(clock), false, 'even with no session storage to remember it, the page plays it once');
  assert.equal(shown(p), 0);
});

test('with everything in, the branches light 300 ms apart from 1.67 s, the cloud collapses 0.7 s after the last, and the logo lands in time', async () => {
  const p = await played();
  const last = painterSpy(p);
  await p.tick(1800);
  const [clock, gather, , lit] = last();
  assert.ok(Math.abs(clock - 1800 / PACE) < 0.01, 'the painter is handed real time over 1.8');
  assert.equal(gather, null, 'the cloud is still going');
  assert.deepEqual(lit.map((l) => l.state), ['done', 'done', 'done', 'done']);
  assert.deepEqual(lit.map((l) => Math.round(l.at * PACE)).sort((a, b) => a - b), LIGHTS.map(Math.round), 'one after another, in the order they settled');
  assert.ok(await until(p, () => gatherAt(p) !== null, 3000));
  assert.ok(gatherAt(p) >= GATHER_MS && gatherAt(p) < GATHER_MS + 20, `it collapsed at ${gatherAt(p)} ms`);
  assert.equal(leaveAt(p), gatherAt(p) + STORY_MS, 'the logo is whole and flies 1.71 s after the collapse');
  const end = leaveAt(p) + FLY_MS;
  assert.ok(await until(p, () => !shown(p), 3000));
  assert.ok(p.at() >= end && p.at() < end + 40, `it ended at ${p.at()} ms`);
});

test('the cloud keeps going while any one step is still loading, and that branch lights when it arrives', async () => {
  const cases = [
    ['engine', 'Engine', { engine: 'starting' }, {}, (p) => p.show(snapshot())],
    ['gitlab', 'GitLab', { gitlab: 'waiting' }, {}, (p) => p.show(snapshot())],
    ['jira', 'Jira', {}, { jira: 'loading' }, (p) => { p.world.jira = 'read'; }],
    ['needs', 'Needs you', { needs: 'waiting' }, {}, (p) => p.show(snapshot())],
  ];
  for (const [key, label, snap, options, arrive] of cases) {
    const p = await played(options, snapshot(snap));
    await p.tick(6000);
    assert.equal(shown(p), 1, `${label} still loading keeps it`);
    assert.equal(gatherAt(p), null, label);
    assert.match(steps(p), new RegExp(`${label} …`), label);
    assert.ok(!labels(p).some((text) => text.startsWith(label)), `${label} is not lit yet`);
    arrive(p);
    assert.ok(await until(p, () => lights(p)?.[key], 1100), `${label} lights once it arrives`);
    assert.ok(lights(p)[key].at >= 6000, label);
    assert.ok(await until(p, () => gatherAt(p) !== null, 2500), `${label} arriving lets the cloud collapse`);
    assert.ok(gatherAt(p) >= Math.max(...Object.values(lights(p)).map((l) => l.at)) + 700, 'but not before the last branch has been seen');
    assert.ok(labels(p).includes(`${label} ✓`), label);
  }
});

test('a step that fails shows a cross on its branch and is not waited on', async () => {
  const cases = [
    ['GitLab', { gitlab: 'failed' }, {}],
    ['Jira', {}, { jira: 'error' }],
    ['Jira', {}, { jira: 'refused' }],
    ['Needs you', { needs: 'failed' }, {}],
  ];
  for (const [label, snap, options] of cases) {
    const p = await played(options, snapshot(snap));
    await p.tick(GATHER_MS + 32);
    assert.notEqual(gatherAt(p), null, `${label} failing does not hold the cloud`);
    assert.match(steps(p), new RegExp(`${label} ✗`), label);
    const view = p.$$('#intro .intro-branch').find((l) => l.textContent === `${label} ✗`);
    assert.ok(view?.classList.contains('is-on') && view.classList.contains('is-failed'), `${label} dims with a cross`);
  }
});

test('an engine that failed fails GitLab, Jira and Needs you with it, and Jira is never asked', async () => {
  const p = await played({}, snapshot({ engine: 'broken' }));
  await p.tick(GATHER_MS + 32);
  assert.equal(steps(p), 'Engine ✗ · GitLab ✗ · Jira ✗ · Needs you ✗');
  assert.deepEqual(Object.values(lights(p)).map((l) => l.state), ['failed', 'failed', 'failed', 'failed']);
  assert.notEqual(gatherAt(p), null);
  assert.equal(p.ticketReads(), 0);
});

test('Jira is asked once the engine is up, then about once a second until it is read, and no more', async () => {
  const p = await played({ jira: 'loading' }, snapshot({ engine: 'starting' }));
  await p.tick(2000);
  assert.equal(p.ticketReads(), 0, 'not before the engine can answer');
  p.show(snapshot({ gitlab: 'waiting' }));
  await p.tick(16);
  assert.equal(p.ticketReads(), 1);
  await p.tick(5000);
  assert.ok(p.ticketReads() >= 5 && p.ticketReads() <= 7, `${p.ticketReads()} reads in 5 s`);
  assert.equal(p.run('JSON.stringify([ui.tickets.data.read, ui.tickets.data.loading])'), '[false,true]', 'the Tickets view has the answer too');
  p.world.jira = 'read';
  await p.tick(1100);
  const reads = p.ticketReads();
  await p.tick(5000);
  assert.equal(shown(p), 1, 'GitLab still holds the cloud');
  assert.equal(p.ticketReads(), reads, 'a read Jira is not asked again');
});

test('the polling for Jira stops when the intro ends, whatever Jira says', async () => {
  const p = await played({ jira: 'loading' });
  await p.tick(2500);
  p.$('#intro').click();
  const reads = p.ticketReads();
  await p.tick(5000);
  assert.equal(p.ticketReads(), reads);
  assert.equal(p.waiting(), 0);
});

test('an answer from Jira that lands after the intro has ended starts no more polling', async () => {
  const p = await page({ jira: 'loading' });
  const { clock, tick, waiting } = fakeClock();
  const held = [];
  const answer = p.window.fetch;
  p.window.fetch = (path, init) => (path === '/api/matrix/tickets' ? new Promise((resolve) => held.push(() => resolve(answer(path, init)))) : answer(path, init));
  p.show(snapshot());
  p.window.introBoot(clock);
  await tick(16);
  assert.equal(held.length, 1);
  p.$('#intro').click();
  held.shift()();
  await tick(16);
  assert.equal(waiting(), 0);
});

test('if the Tickets view did not load, Jira shows a cross rather than holding the cloud', async () => {
  const p = await page();
  p.window.loadTickets = undefined;
  const clock = fakeClock();
  p.show(snapshot());
  p.window.introBoot(clock.clock);
  Object.assign(p, clock);
  await p.tick(GATHER_MS + 32);
  assert.match(steps(p), /Jira \u2717/);
  assert.notEqual(gatherAt(p), null);
});

test('the checklist is written only when a step changes, not on every frame, and shows once the mark is forming', async () => {
  const p = await played({}, snapshot({ gitlab: 'waiting' }));
  await p.tick(500);
  assert.equal(p.$('#intro').classList.contains('intro-listing'), false, 'not over the cloud');
  const text = p.$('#intro .intro-steps').childNodes[0];
  await p.tick(2500);
  assert.ok(p.$('#intro .intro-steps').childNodes[0] === text, 'the same text node');
  assert.ok(p.$('#intro').classList.contains('intro-listing'));
  p.show(snapshot());
  await p.tick(16);
  assert.ok(p.$('#intro .intro-steps').childNodes[0] !== text, 'a step changing writes it again');
});

test('a worker from before Needs you said when it was built is not waited on', async () => {
  const p = await played({}, snapshot({ needs: 'old' }));
  await p.tick(GATHER_MS + 32);
  assert.match(steps(p), /Needs you ✓/);
  assert.notEqual(gatherAt(p), null);
});

test('the 15 s cap ends it although nothing ever loads, frames or no frames', async () => {
  for (const frames of [true, false]) {
    const p = await played({ clock: { frames } }, null);
    await p.tick(GATHER_BY - 20);
    if (frames) assert.equal(gatherAt(p), null, 'the cloud waits as long as it can');
    await p.tick(CAP_MS - FLY_MS + 10 - (GATHER_BY - 20));
    if (frames) assert.deepEqual([gatherAt(p), leaveAt(p)], [GATHER_BY, CAP_MS - FLY_MS], 'it collapses and flies home in time to land on the cap, rather than vanishing there');
    await p.tick(FLY_MS - 30);
    assert.equal(shown(p), 1, `still there just before the cap, frames ${frames}`);
    await p.tick(32);
    assert.equal(shown(p), 0, `gone at the cap, frames ${frames}`);
    assert.equal(p.$('.app').inert, false);
  }
});

test('any key or click skips straight to the page, and the key goes no further', async () => {
  const keyed = await played({}, null);
  const reachedPage = keyed.fire(keyed.$('body'), 'keydown', { key: '?' });
  assert.equal(shown(keyed), 0);
  assert.equal(reachedPage, false, 'the skipping key is not also a shortcut');
  assert.equal(keyed.$$('.kb-backdrop').length, 0);
  const clicked = await played({}, null);
  clicked.$('#intro').click();
  assert.equal(shown(clicked), 0);
  assert.equal(clicked.$('.app').inert, false);
});

test('reduced motion shows the still mark and the checklist until everything has loaded, then fades in 250 ms', async () => {
  const p = await played({ reduced: true }, snapshot({ gitlab: 'waiting' }));
  assert.ok(p.$('#intro').classList.contains('intro-listing'), 'the checklist shows from the start');
  await p.tick(5000);
  assert.equal(shown(p), 1);
  assert.equal(p.$('#intro').classList.contains('intro-leaving'), false);
  p.show(snapshot());
  await p.tick(16);
  assert.ok(p.$('#intro').classList.contains('intro-leaving'));
  assert.deepEqual(labels(p), [], 'no branch lights with reduced motion');
  await p.tick(240);
  assert.equal(shown(p), 1);
  await p.tick(16);
  assert.equal(shown(p), 0);
  const capped = await played({ reduced: true }, null);
  await capped.tick(CAP_MS - 20);
  assert.equal(shown(capped), 1);
  await capped.tick(32);
  assert.equal(shown(capped), 0, 'the cap holds for reduced motion too');
});

test('when it ends it takes away its overlay, its listeners, its frame and its timers', async () => {
  const p = await page({ jira: 'loading' });
  const { clock, tick, waiting } = fakeClock();
  const before = { window: p.window.listeners.length, document: p.document.listeners.length };
  p.show(snapshot());
  p.window.introBoot(clock);
  assert.ok(p.window.listeners.length > before.window && p.document.listeners.length > before.document);
  await tick(3000);
  p.world.jira = 'read';
  await tick(6000);
  assert.equal(shown(p), 0);
  assert.deepEqual({ window: p.window.listeners.length, document: p.document.listeners.length }, before);
  assert.equal(waiting(), 0, 'no frame or timer is left to run');
  assert.equal(p.run('introRun'), null);
  assert.equal(p.document.documentElement.classList.contains('intro-on'), false);
  assert.equal(p.$('.app').inert, false);
});

test('it pauses while the page is hidden, so the cap counts only time it was seen', async () => {
  const p = await played({}, null);
  await p.tick(1000);
  p.document.hidden = true;
  p.fire(p.document, 'visibilitychange');
  assert.equal(p.waiting(), 0, 'nothing runs while hidden');
  await p.tick(60_000);
  p.document.hidden = false;
  p.fire(p.document, 'visibilitychange');
  await p.tick(CAP_MS - 1100);
  assert.equal(shown(p), 1);
  await p.tick(120);
  assert.equal(shown(p), 0);
});

test('a reload within 10 minutes of the last play skips it, a later one or a page that cannot remember plays it', async () => {
  const at = (ago) => store({ 'cc-intro-at': String(WALL - ago) });
  const recent = await page({ session: at(5 * MINUTE) });
  assert.equal(recent.window.introBoot(fakeClock().clock), false);
  assert.equal(shown(recent), 0);
  const stale = at(11 * MINUTE);
  const later = await page({ session: stale });
  assert.equal(later.window.introBoot(fakeClock().clock), true);
  assert.equal(stale.map.get('cc-intro-at'), String(WALL), 'it notes when it played');
  const forgetful = await page({ session: refused });
  assert.equal(forgetful.window.introBoot(fakeClock().clock), true);
});

test('Settings has Play the intro, on by default, and turning it off stops it playing in that browser', async () => {
  const prefs = store();
  const p = await page({ prefs });
  p.show(snapshot(), 'settings');
  const toggle = () => p.$('#intro-play');
  assert.equal(toggle().getAttribute('aria-checked'), 'true');
  toggle().click();
  assert.equal(prefs.map.get('cc-intro'), 'off');
  assert.equal(toggle().getAttribute('aria-checked'), 'false');
  assert.equal(p.window.introBoot(fakeClock().clock), false);
  assert.equal(shown(p), 0);
});

test('a canvas that throws, when made or on any frame, hands the page straight back', async () => {
  const made = await page();
  const element = made.document.createElement('canvas').constructor.prototype;
  element.getContext = () => { throw new Error('no canvas'); };
  try {
    made.window.introBoot(fakeClock().clock);
  } finally {
    delete element.getContext;
  }
  assert.equal(shown(made), 0);
  assert.equal(made.$('.app').inert, false);
  const drawn = await played({}, null);
  drawn.run('introRun.paint = { draw() { throw new Error("lost the canvas"); }, resize() {} }');
  await drawn.tick(16);
  assert.equal(shown(drawn), 0);
  assert.equal(drawn.waiting(), 0);
});

test('the app\'s terminal and Claude windows never play it', async () => {
  for (const name of ['terminal', 'claude']) {
    const p = await openPage({ search: '?t=test&window=' + name });
    p.window.sessionStorage = store();
    assert.equal(p.window.introBoot(fakeClock().clock), false, name);
  }
});

async function settingsPage(options = {}) {
  const p = await page(options);
  const clock = fakeClock();
  Object.assign(p.run('INTRO_CLOCK'), clock.clock);
  p.show(snapshot(), 'settings');
  p.run('ui.tickets.data = { read: true, loading: false, error: null, tickets: [] }');
  return Object.assign(p, clock);
}

test('Play it now plays the whole intro at once, switched off or not and however recently it played, lighting each branch in turn on a loaded page', async () => {
  const session = store({ 'cc-intro-at': String(WALL - MINUTE) });
  const p = await settingsPage({ session, prefs: store({ 'cc-intro': 'off' }) });
  p.$('#intro-replay').click();
  assert.equal(shown(p), 1);
  p.run('introReplay()');
  assert.equal(shown(p), 1, 'asking while it plays does not start a second');
  await p.tick(LIGHTS[3] + 16);
  assert.deepEqual(Object.values(lights(p)).map((l) => Math.round(l.at)).sort((a, b) => a - b), LIGHTS.map(Math.round), 'each branch still lights, one after another');
  assert.deepEqual(labels(p), ['Engine ✓', 'GitLab ✓', 'Jira ✓', 'Needs you ✓'], 'each with its label');
  await p.tick(GATHER_MS - LIGHTS[3]);
  assert.ok(gatherAt(p) >= GATHER_MS && gatherAt(p) < GATHER_MS + 20, 'then it collapses straight away');
  assert.equal(p.ticketReads(), 0, 'what the page already holds is not asked again');
  await p.tick(STORY_MS + FLY_MS + 32);
  assert.equal(shown(p), 0);
  assert.equal(session.map.get('cc-intro-at'), String(WALL - MINUTE), 'a replay leaves the reload rule alone');
  p.$('#intro-replay').click();
  assert.equal(shown(p), 1, 'and it plays again whenever asked');
});

test('a replay still uses reduced motion, and any key still skips it', async () => {
  const still = await settingsPage({ reduced: true });
  still.$('#intro-replay').click();
  await still.tick(16);
  assert.ok(still.$('#intro').classList.contains('intro-leaving'), 'a loaded page fades at once');
  await still.tick(256);
  assert.equal(shown(still), 0);
  const skipped = await settingsPage();
  skipped.$('#intro-replay').click();
  skipped.fire(skipped.$('body'), 'keydown', { key: 'Escape' });
  assert.equal(shown(skipped), 0);
});

test('Jump to has Play the intro, which plays it', async () => {
  const p = await settingsPage();
  p.window.navigator.platform = 'MacIntel';
  p.fire(p.$('body'), 'keydown', { key: 'k', metaKey: true });
  const input = p.$('#palette-q');
  input.value = 'Play the intro';
  p.fire(input, 'input');
  assert.equal(p.$('#palette [role="option"] .palette-label').textContent, 'Play the intro');
  p.fire(input, 'keydown', { key: 'Enter' });
  assert.equal(shown(p), 1);
});

test('each step gets a branch of its own: about twenty connected nodes grown from a seed, apart from the others and spread round the cloud', async () => {
  const p = await page();
  const g = JSON.parse(p.run(`JSON.stringify((() => {
    const g = introGraph();
    return { nodes: g.nodes.map((n) => ({ p: n.p, branch: n.branch, hop: n.hop, parent: n.parent })), edges: g.edges.map((e) => [e.a, e.b]), branches: g.branches.map((b) => ({ seed: b.seed, members: b.members })) };
  })())`));
  assert.equal(g.branches.length, 4);
  const owners = new Map();
  for (const [b, { seed, members }] of g.branches.entries()) {
    assert.ok(members.length >= 15 && members.length <= 25, `branch ${b} has ${members.length} nodes`);
    for (const i of members) {
      assert.ok(!owners.has(i), `node ${i} is in two branches`);
      owners.set(i, b);
      assert.equal(g.nodes[i].branch, b);
    }
    const inside = new Set(members);
    const reached = new Set([seed]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [x, y] of g.edges) {
        if (!inside.has(x) || !inside.has(y) || reached.has(x) === reached.has(y)) continue;
        reached.add(x).add(y);
        grew = true;
      }
    }
    assert.equal(reached.size, inside.size, `branch ${b} is connected through the graph's own edges`);
    assert.equal(g.nodes[seed].hop, 0);
    for (const i of members.filter((m) => m !== seed)) {
      assert.ok(inside.has(g.nodes[i].parent));
      assert.equal(g.nodes[i].hop, g.nodes[g.nodes[i].parent].hop + 1, 'hops count out from the seed');
    }
  }
  const seeds = g.branches.map(({ seed }) => g.nodes[seed].p);
  for (let i = 0; i < 4; i += 1) for (let j = i + 1; j < 4; j += 1) assert.ok(Math.hypot(...seeds[i].map((v, axis) => v - seeds[j][axis])) > 0.9, `seeds ${i} and ${j} are apart`);
});

test('no pulse runs off the end of its walk however long the cloud waits', async () => {
  const p = await page();
  const walks = JSON.parse(p.run('JSON.stringify(introGraph().walks.map((w) => [w.path.length, w.at, w.rate]))'));
  for (const [length, at, rate] of walks) assert.ok(((CAP_MS / PACE - at) / 1000) * rate < length - 1, `a walk of ${length} at ${rate} edges a second`);
});

test('the camera never freezes while the page loads, and eases back to rest as the collapse starts, with no jump', async () => {
  const p = await page();
  const frame = 16 / PACE;
  const series = JSON.parse(p.run(`JSON.stringify((() => {
    const sc = { d0: 1000, rx: 400 };
    const out = [];
    for (let t = 0; t <= 8000; t += ${frame}) out.push(introCamera(sc, t, t < 6000 ? Math.min(t, 930) : 930 + t - 6000));
    return out;
  })())`));
  for (let i = 1; i < series.length; i += 1) {
    const [a, b] = [series[i - 1], series[i]];
    assert.ok(Math.abs(b.dist - a.dist) < 20 && Math.abs(b.x - a.x) < 4 && Math.abs(b.pitch - a.pitch) < 0.01 && Math.abs(b.yaw - a.yaw) < 0.03, `a jump at frame ${i}`);
  }
  const holding = series.slice(Math.ceil(2000 / frame), Math.floor(6000 / frame));
  assert.ok(holding.every((c, i) => i === 0 || c.pitch !== holding[i - 1].pitch || c.dist !== holding[i - 1].dist), 'it keeps drifting');
  assert.ok(Math.max(...holding.map((c) => c.pitch)) - Math.min(...holding.map((c) => c.pitch)) > 0.05, 'by enough to see');
  const rest = series.at(-1);
  assert.ok(Math.abs(rest.x) < 1e-6 && Math.abs(rest.pitch - 0.14) < 1e-6 && Math.abs(rest.dist - 1000) < 1e-6, 'at rest the glyph lands where the mark is drawn');
});

test('a step that loads later lights as it loads, and two that land together light 300 ms apart', async () => {
  const p = await played({}, snapshot({ gitlab: 'waiting', needs: 'waiting' }));
  await p.tick(5000);
  assert.deepEqual(Object.keys(lights(p)), ['engine', 'jira']);
  assert.deepEqual([lights(p).engine.at, lights(p).jira.at], [LIGHTS[0], LIGHTS[1]]);
  p.show(snapshot());
  await p.tick(16);
  const { gitlab, needs } = lights(p);
  assert.ok(gitlab.at >= 5000 && gitlab.at <= 5016, 'GitLab lights the frame it arrives');
  assert.equal(needs.at, gitlab.at + 300, 'Needs you a beat after');
});

test('the painter is told which branches failed, and when', async () => {
  const p = await played({ jira: 'error' });
  const last = painterSpy(p);
  await p.tick(2000);
  const [, , , lit] = last();
  assert.deepEqual(lit.map((l) => l.state), ['done', 'done', 'failed', 'done']);
});

test('a branch label is written when its step lights and not on every frame after', async () => {
  const p = await played();
  await p.tick(LIGHTS[0] + 16);
  const label = p.$('#intro .intro-branch[data-step="engine"]');
  assert.equal(label.textContent, 'Engine \u2713');
  const text = label.childNodes[0];
  await p.tick(400);
  assert.ok(label.childNodes[0] === text, 'the same text node');
  assert.equal(p.$('#intro .intro-branch[data-step="needs"]').classList.contains('is-on'), false, 'Needs you is not lit yet');
});
