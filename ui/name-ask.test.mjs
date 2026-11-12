import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const WALL = Date.parse('2026-11-10T12:00:00Z');
const PACE = 1.8;
const STORY_MS = (1880 - 930) * PACE;
const FLY_MS = 420 * PACE;
const LEAVE_MS = 930 * PACE + 900 + 700 + STORY_MS;
const CAP_MS = 15_000;
const FIRST_RUN = { name: '', ask: true, suggested: 'Ada', style: { language: '', rules: '' } };

function snapshot() {
  return {
    generatedAt: new Date(WALL).toISOString(), version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [],
    attention: { cards: [], agents: [], system: [], count: 0, prefs: {}, toasts: [], offers: [], builtAt: new Date(WALL).toISOString(), buildError: null },
    matrix: {
      available: true, me: 'ivan', paused: false, inbox: { fetchedAt: WALL, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

function fakeClock() {
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
      const ready = [...due.values()];
      due.clear();
      for (const fn of ready) fn(now);
      await new Promise(setImmediate);
    }
  }
  return { clock, tick, waiting: () => due.size + timers.size };
}

function store(entries = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)) };
}

async function page({ profile = FIRST_RUN, reduced = false, prefs = store(), clock = null, search } = {}) {
  const posts = [];
  const world = { profile };
  const p = await openPage({
    search,
    storage: prefs,
    respond: (path, init) => {
      if (path === '/api/matrix/tickets') return { read: true, loading: false, error: null, tickets: [] };
      if (path !== '/api/profile') return null;
      if (init?.method !== 'POST') return world.profile;
      const patch = JSON.parse(init.body);
      posts.push(patch);
      world.profile = { ...world.profile, name: patch.name ?? world.profile.name, ask: false };
      return { ok: true, text: patch.skip ? 'Prompts say "you"' : `Prompts call you ${patch.name}`, ...world.profile };
    },
  });
  p.window.sessionStorage = store();
  p.window.matchMedia = (query) => ({ matches: reduced && query.includes('reduced-motion') });
  p.show(snapshot());
  if (clock) p.window.introBoot(clock.clock);
  await p.window.profileLoad();
  return Object.assign(p, { posts, world });
}

// The intro starts as its script loads, before the profile is read, as it does on a real page.
async function played(options) {
  const clock = fakeClock();
  const p = await page({ ...options, clock });
  return Object.assign(p, clock);
}

const asking = (p) => p.$('#intro .name-ask');
const field = (p) => p.document.getElementById('name-ask-input');
const card = (p) => p.$('#name-ask');

// A real input's value starts as its value attribute; the stand-in page leaves that to the test.
function typeName(p, text) {
  const input = field(p);
  input.value = text ?? input.getAttribute('value');
  p.fire(input, 'input');
  return input;
}

async function until(p, ready, ms) {
  for (let spent = 0; spent < ms && !ready(); spent += 16) await p.tick(16);
  return ready();
}

test('on a first run the intro stops at the logo and asks what to call you, prefilled with the first name it found', async () => {
  const p = await played();
  assert.ok(await until(p, () => asking(p), LEAVE_MS + 200), 'it asks once the logo has formed');
  const leave = p.run('introRun.leaveAt');
  assert.equal(p.$('#name-ask-q').textContent, 'What should we call you?');
  assert.equal(field(p).getAttribute('value'), 'Ada');
  assert.equal(p.document.activeElement, field(p), 'the field has focus');
  assert.equal(p.$('#intro').classList.contains('intro-leaving'), false, 'the logo holds where it formed');
  await p.tick(CAP_MS * 2);
  assert.ok(asking(p), 'it waits for an answer however long it takes, past the cap');
  assert.equal(p.waiting(), 0, 'no frame or timer runs while it waits');
  assert.equal(p.run('introRun.leaveAt'), leave);
});

test('Enter saves the name and the intro carries on into the page, and it never asks again', async () => {
  const p = await played();
  await until(p, () => asking(p), LEAVE_MS + 200);
  const input = typeName(p);
  p.fire(input, 'keydown', { key: 'Enter' });
  await p.settle(20);
  assert.deepEqual(p.posts, [{ name: 'Ada' }]);
  assert.equal(asking(p), null);
  assert.ok(await until(p, () => !p.$('#intro'), FLY_MS + 100), 'the logo flies to its place, as it would have');
  assert.equal(p.$('.app').inert, false);
  assert.equal(card(p), null, 'no second ask once the intro has gone');
  p.window.introReplay(fakeClock().clock);
  await p.settle(20);
  assert.equal(p.window.nameAskDue(), false, 'a replay from Settings asks nothing');
});

test('a name typed over the one offered is the one saved, and typing or clicking in the field does not skip the intro', async () => {
  const p = await played();
  await until(p, () => asking(p), LEAVE_MS + 200);
  const input = typeName(p, 'Grace');
  p.fire(input, 'keydown', { key: 'g' });
  p.fire(input, 'click');
  assert.ok(p.$('#intro'), 'still there');
  p.$('#name-ask-save').click();
  await p.settle(20);
  assert.deepEqual(p.posts, [{ name: 'Grace' }]);
});

test('Skip, or Escape, leaves the name blank so prompts say "you", and the intro carries on', async () => {
  for (const how of ['button', 'escape']) {
    const p = await played();
    await until(p, () => asking(p), LEAVE_MS + 200);
    if (how === 'button') p.$('#name-ask-skip').click();
    else p.fire(field(p), 'keydown', { key: 'Escape' });
    await p.settle(20);
    assert.deepEqual(p.posts, [{ skip: true }], how);
    assert.ok(await until(p, () => !p.$('#intro'), FLY_MS + 100), how);
    assert.equal(card(p), null, how);
  }
});

test('a save that fails says so and still lets the page go on, without asking again in that page', async () => {
  const p = await played();
  await until(p, () => asking(p), LEAVE_MS + 200);
  p.window.fetch = async (path, init) => (init?.method === 'POST' ? { ok: false, status: 500, text: async () => 'the disk is full' } : { ok: false, status: 404, text: async () => '' });
  p.fire(typeName(p), 'keydown', { key: 'Enter' });
  await p.settle(20);
  assert.match(p.$('#toast').textContent, /Could not save your name: the disk is full/);
  assert.ok(await until(p, () => !p.$('#intro'), FLY_MS + 100));
  assert.equal(card(p), null);
});

test('an empty name saved is a skip', async () => {
  const p = await played();
  await until(p, () => asking(p), LEAVE_MS + 200);
  p.fire(typeName(p, '   '), 'keydown', { key: 'Enter' });
  await p.settle(20);
  assert.deepEqual(p.posts, [{ skip: true }]);
});

test('with reduced motion the still logo asks the same, and leaves at once when answered', async () => {
  const p = await played({ reduced: true });
  assert.ok(await until(p, () => asking(p), 1000), 'asked as soon as the page has loaded');
  assert.equal(field(p).getAttribute('value'), 'Ada');
  p.fire(typeName(p), 'keydown', { key: 'Enter' });
  await p.settle(20);
  assert.ok(await until(p, () => !p.$('#intro'), 300));
  assert.deepEqual(p.posts, [{ name: 'Ada' }]);
});

test('with the intro off it is a plain prompt in a corner of the page, which loads and works behind it', async () => {
  const p = await page({ prefs: store({ 'cc-intro': 'off' }) });
  assert.equal(p.window.introBoot(fakeClock().clock), false);
  assert.equal(p.$('#intro'), null);
  assert.ok(card(p), 'asked anyway');
  assert.equal(field(p).getAttribute('value'), 'Ada');
  assert.notEqual(p.$('.app').inert, true, 'nothing behind it is blocked');
  assert.ok(p.$('#main').childNodes.length > 0, 'the page rendered behind it');
  p.fire(typeName(p, 'Ada'), 'keydown', { key: 'Enter' });
  await p.settle(20);
  assert.deepEqual(p.posts, [{ name: 'Ada' }]);
  assert.equal(card(p), null);
  p.show(snapshot());
  assert.equal(card(p), null, 'a render does not bring it back');
});

test('a window the app opens for Claude Code never asks, as the page itself does', async () => {
  const p = await page({ search: '?t=test&window=terminal' });
  assert.equal(card(p), null);
  assert.equal(p.window.nameAskDue(), false);
});

test('an intro skipped before the logo formed asks in the plain prompt instead, once', async () => {
  const p = await played();
  await p.tick(1000);
  assert.equal(card(p), null, 'not over the intro while it plays');
  p.$('#intro').click();
  assert.equal(p.$('#intro'), null);
  assert.ok(card(p));
  p.window.nameAskPlain();
  assert.equal(p.$$('#name-ask').length, 1);
});

test('nothing is asked once a name is saved or skipped, or when the profile cannot be read', async () => {
  for (const profile of [{ ...FIRST_RUN, name: 'Ada', ask: false, suggested: '' }, { ...FIRST_RUN, ask: false, suggested: '' }, null]) {
    const p = await played({ profile });
    assert.ok(await until(p, () => !p.$('#intro'), LEAVE_MS + FLY_MS + 200), JSON.stringify(profile));
    assert.equal(card(p), null);
    assert.deepEqual(p.posts, []);
  }
});

test('Settings has a You group to change the name, language and writing rules after the first run', async () => {
  const p = await page({ profile: { name: 'Ada', ask: false, suggested: '', style: { language: 'British English', rules: 'No em dashes.' } } });
  p.show(snapshot(), 'settings');
  await p.settle(30);
  const group = p.$('#profile-settings');
  assert.deepEqual(group.querySelectorAll('.setting label').map((l) => l.textContent), ['Name', 'Language', 'Writing rules']);
  assert.equal(p.$('#profile-language').getAttribute('value'), 'British English');
  const name = p.$('#profile-name');
  name.value = 'Ada L';
  p.fire(name, 'input');
  p.fire(p.$('#profile-name'), 'keydown', { key: 'Enter' });
  await p.settle(30);
  assert.deepEqual(p.posts, [{ name: 'Ada L' }]);
  assert.match(p.$('#main .settings-spend').textContent, /spend your Claude usage/);
});
