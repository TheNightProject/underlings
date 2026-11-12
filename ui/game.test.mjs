import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import { openPage } from './testkit.mjs';

const AT = '2026-11-11T12:00:00Z';
const handle = (n) => `claude:${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const agent = (n, extra = {}) => ({
  handle: handle(n), name: 'agent-' + n, title: 'task ' + n, kind: 'review', mr: 'acme/engine!' + n, ticket: null, worktree: null, cwd: '/work',
  state: 'done', since: 1000, lastAt: Date.parse(AT) - n * 1000, alive: false, said: '', outcome: 'success', ask: null, ...extra,
});

const quests = [{ id: 'review', target: 3, label: 'Review 3 MRs', have: 3, done: true }, { id: 'merge', target: 1, label: 'Merge an MR', have: 0, done: false }, { id: 'needs', target: 1, label: 'Clear Needs you', have: 0, done: false }];
const entry = (seq, label, extra = {}) => ({ seq, kind: 'reward', source: 'merged', key: 'k' + seq, label, xp: 120, coins: 12, at: AT, back: false, item: null, ...extra });

function hud(extra = {}) {
  return {
    on: true, toasts: true, started: true, epoch: '2026-11-01T09:00:00.000Z', backfilling: false, me: 'Frank',
    level: 15, title: 'Senior', xp: 45198, levelAt: 40531, nextAt: 45732, coins: 4718, streak: 8, quests,
    equipped: { office: { 'office-neon': 'office-neon' }, player: { hat: 'hat-crown', held: 'held-saber', pet: 'pet-cat' }, 'kind:review': { hat: 'hat-wizard' } },
    trophies: [{ id: 'first-merge', secret: false }], seq: 10, recent: [entry(10, 'Merged atlas!44')], earned: { xp: 45198, coins: 6000, rewards: 10, tokens: 0 }, ...extra,
  };
}

function landed(all, extra = {}) {
  const fresh = all.filter((e) => e.seq > 10);
  const earned = { xp: 45198 + fresh.reduce((n, e) => n + e.xp, 0), coins: 6000 + fresh.reduce((n, e) => n + e.coins, 0), rewards: 10 + fresh.length, tokens: fresh.filter((e) => e.source === 'tokens').length };
  return hud({ seq: all.at(-1).seq, recent: all.slice(-40), earned, ...extra });
}

function snapshot(game, agents = [agent(1), agent(2), agent(3, { state: 'working', alive: true })]) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents, artifacts: [], game,
    attention: { cards: [], agents: [], system: [], count: 0, prefs: {}, toasts: [], offers: [] },
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

const item = (id, slot, name, level, price, extra = {}) => ({ id, slot, name, level, price, blurb: name + '.', owned: false, locked: level > 15, short: price > 4718, ...extra });
const FULL = {
  ...hud(),
  settings: { on: true, toasts: true, tokenRate: 40 }, status: { gitlab: null, jira: null },
  stats: { merged: 117, review: 165, comment: 716, approval: 105, finding: 3, qa: 42, done: 29, agent: 12, tokens: 235, bestStreak: 8, rallyBest: 0, exactTokens: { today: 2_217_049, window: 243_168_525 } },
  catalogue: [
    item('hat-party', 'hat', 'Party hat', 1, 80, { owned: true }), item('hat-wizard', 'hat', 'Wizard hat', 6, 300, { owned: true }), item('hat-crown', 'hat', 'Crown', 30, 2600),
    item('skin-chrome', 'skin', 'Chrome', 15, 900), item('held-saber', 'held', 'Lightsaber', 20, 1500), item('pet-dog', 'pet', 'Dog', 10, 7500, { short: true }),
    item('office-neon', 'office', 'Neon sign', 2, 140, { owned: true }), item('office-disco', 'office', 'Disco ball', 35, 3000),
  ],
  wearers: [{ id: 'player', label: 'You' }, { id: 'manager', label: 'The manager' }, { id: 'kind:review', label: 'Review agents' }],
  slots: ['skin', 'hat', 'held', 'pet'],
  achievements: [{ id: 'first-merge', name: 'First merge', blurb: 'One merged.', secret: false, at: AT, badge: false }, { id: 'night-owl', name: '???', blurb: 'A secret achievement.', secret: true, at: null, badge: false }],
  rewards: [{ source: 'merged', what: 'Your MR merged', xp: 120, coins: 12 }, { source: 'tokens', what: 'Each million', xp: 40, coins: 4 }],
  tokenRate: { min: 0, max: 400, value: 40 },
};

const FAKE_GL = `new Proxy({}, { get: (t, k) => (k === 'canvas' ? null : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 1 : () => ({})) })`;

async function gamePage(game = hud(), { view = 'agents', globals = {}, full = FULL, agents } = {}) {
  const posts = [];
  const respond = (path, init) => {
    if (init?.method === 'POST') {
      posts.push({ path, body: JSON.parse(init.body) });
      return { ok: true, text: 'Done' };
    }
    if (path === '/api/game') return full;
    return null;
  };
  const storage = { getItem: (k) => (k === 'cc.agentLayout' ? 'office' : null), setItem() {} };
  const page = await openPage({ respond, storage, globals });
  page.run(`{ const make = document.createElement.bind(document); document.createElement = (tag) => Object.assign(make(tag), tag === 'canvas' ? { getContext: (kind) => (kind === 'webgl2' ? ${FAKE_GL} : null) } : {}); }`);
  page.show(snapshot(game, agents), view);
  await page.settle(20);
  page.run('render()');
  return { page, posts };
}

const words = (node) => (node.nodeType === 3 ? [node.data] : node.childNodes.flatMap(words));
const text = (node) => node && words(node).join(' ').replace(/\s+/g, ' ').trim();
const toasts = (page) => page.$$('#game-toasts .game-toast').map(text);

test('the office shows the HUD: level and title, XP to the next level, coins, streak and today\'s quests with ticks', async () => {
  const { page } = await gamePage();
  const bar = page.$('#main .office .game-hud');
  assert.ok(bar, 'the HUD sits in the office');
  assert.match(text(bar.querySelector('.game-hud-level')), /^15 Senior 4,667 \/ 5,201 XP$/);
  assert.equal(bar.querySelector('.game-xp-fill').getAttribute('style'), 'width:89.7%');
  assert.equal(bar.querySelector('.game-xp').getAttribute('aria-valuenow'), '4667');
  assert.deepEqual(bar.querySelectorAll('.game-stat').map(text), ['4,718', '8 days']);
  assert.deepEqual(bar.querySelectorAll('.game-quests li').map((li) => [li.className || '', text(li)]), [['done', 'Review 3 MRs 3/3'], ['', 'Merge an MR 0/1'], ['', 'Clear Needs you 0/1']]);
  assert.deepEqual(bar.querySelectorAll('.game-go').map((a) => [text(a), a.getAttribute('href')]), [['Shop', '#game'], ['Wardrobe', '#game']]);
  assert.deepEqual(page.errors, []);
});

test('the rail carries a level and coins pill and an XP bar on every view, and the game link goes when the game is off', async () => {
  const { page } = await gamePage(hud({ coins: 12345 }), { view: 'overview' });
  assert.equal(text(page.$('#game-pill')), 'Lv 15 12.3k');
  assert.equal(page.$('#game-pill').hidden, false);
  const bar = page.$('.game-link .game-rail-xp');
  assert.equal(bar.hidden, false);
  assert.equal(bar.querySelector('.game-xp-fill').getAttribute('style'), 'width:89.7%');
  assert.equal(bar.querySelector('.game-xp').getAttribute('title'), '534 XP to level 16');
  page.show(snapshot({ on: false, toasts: true }), 'overview');
  assert.equal(page.$('.game-link').hidden, true);
  page.show(snapshot(undefined), 'overview');
  assert.equal(page.$('.game-link').hidden, false, 'a worker without the game still links to it');
  assert.equal(page.$('#game-pill').hidden, true);
  assert.equal(bar.hidden, true);
  assert.equal(bar.querySelector('.game-xp'), null);
});

test('a reward that lands while the page is open toasts, several at once as one, and none from the first snapshot', async () => {
  const { page } = await gamePage();
  assert.deepEqual(toasts(page), [], 'what was there when the page opened stays quiet');
  page.show(snapshot(landed([entry(10, 'Merged atlas!44'), entry(11, 'Merged atlas!45')])), 'agents');
  assert.deepEqual(toasts(page), ['+120 XP · +12 coins Merged atlas!45']);
  const many = [entry(11, 'Merged atlas!45'), entry(12, 'Reviewed engine!12', { xp: 40, coins: 4 }), entry(13, 'Commented on engine!12', { xp: 8, coins: 1 }), entry(14, 'Commented on engine!12', { xp: 8, coins: 1 }), entry(15, 'Approved engine!12', { xp: 30, coins: 3 })];
  page.show(snapshot(landed(many)), 'agents');
  assert.equal(toasts(page).at(-1), '+86 XP · +9 coins Reviewed engine!12, Commented on engine!12 and 1 more');
  const tokens = Array.from({ length: 60 }, (_, i) => entry(16 + i, (i + 1) + ' million tokens today', { source: 'tokens', xp: 40, coins: 4 }));
  page.show(snapshot(landed([...many, ...tokens])), 'agents');
  assert.equal(toasts(page).at(-1), '+2,400 XP · +240 coins 60 million tokens today', 'sixty millions, more than the snapshot lists, are one line and counted whole');
  page.show(snapshot(landed([...many, ...tokens, entry(76, 'Merged atlas!46')], { toasts: false })), 'agents');
  assert.equal(toasts(page).length, 3, 'toasts off shows none');
});

test('the first count of your last 30 days toasts once, as a summary', async () => {
  const { page } = await gamePage({ on: true, toasts: true, started: false, quests: [], recent: [], seq: 0, epoch: null });
  assert.match(text(page.$('#main .game-hud')), /Counting your last 30 days/);
  const back = Array.from({ length: 40 }, (_, i) => entry(i + 1, 'Merged x!' + i, { back: true, xp: 100, coins: 10 }));
  page.show(snapshot(hud({ seq: 40, recent: back, earned: { xp: 4000, coins: 400, rewards: 40, tokens: 0 } })), 'agents');
  assert.deepEqual(toasts(page), ['+4,000 XP · +400 coins Counted 40 rewards from earlier days: level 15 Senior']);
});

test('a level up bursts and says the new level and title, and with reduced motion it only says so', async () => {
  const { page } = await gamePage();
  page.show(snapshot(landed([entry(11, 'Merged atlas!45')], { level: 16 })), 'agents');
  const moment = page.$('.game-levelup');
  assert.equal(text(moment.querySelector('.game-banner')), 'Level up Level 16 Senior');
  assert.equal(moment.querySelectorAll('.game-burst i').length, 14);
  const matchMedia = (query) => ({ matches: query.includes('reduce'), addEventListener() {} });
  const still = await gamePage(hud(), { globals: { matchMedia } });
  still.page.show(snapshot(landed([entry(11, 'Merged atlas!45')], { level: 16 })), 'agents');
  assert.ok(still.page.$('.game-levelup').className.includes('still'));
  assert.equal(still.page.$$('.game-burst i').length, 0);
  assert.equal(still.page.run('office.scene.burst'), undefined, 'and the office does not burst either');
});

test('an achievement pops on its own, and a badge says it pays nothing', async () => {
  const { page } = await gamePage();
  page.show(snapshot(landed([entry(11, 'Achievement: Centurion', { source: 'achievement', xp: 250, coins: 30 }), entry(12, 'Achievement: Table tennis ace', { source: 'achievement', xp: 0, coins: 0 })])), 'agents');
  assert.deepEqual(page.$$('#game-pops .game-pop').map(text), ['Achievement unlocked Centurion +250 XP · +30 coins', 'Achievement unlocked Table tennis ace A badge, for fun']);
  assert.deepEqual(toasts(page), [], 'an achievement is not toasted twice');
});

test('you are in the office with your level on your name tag, and a click opens your profile', async () => {
  const { page } = await gamePage();
  const tag = page.run('officeTagText(office.agents.find((a) => a.player))');
  assert.equal(tag, 'Frank · Lv 15 Senior');
  assert.equal(page.run('office.scene.actors.has(OFFICE_PLAYER)'), true);
  const you = page.document.getElementById('office-who-office:player');
  assert.match(text(you), /^You, Frank, level 15 Senior, /);
  you.click();
  await page.settle(20);
  page.run('render()');
  const card = page.$('#office-card');
  assert.match(text(card), /Frank/);
  assert.match(text(card), /Review 3 MRs 3\/3/);
  assert.match(text(card), /1 of 2 achievements/);
  assert.match(text(card), /MRs merged 117/);
  assert.deepEqual(card.querySelectorAll('.game-go').map(text), ['Profile', 'Shop', 'Wardrobe']);
});

test('what is worn reaches the office: your outfit, every review agent\'s hat and the add-ons placed', async () => {
  const { page } = await gamePage();
  const outfit = (h) => JSON.parse(page.run(`JSON.stringify(officeOutfitOf(office.scene, office.scene.actors.get(${JSON.stringify(h)})))`));
  assert.deepEqual(outfit('office:player'), { hat: 'hat-crown', held: 'held-saber', pet: 'pet-cat' });
  assert.deepEqual([outfit(handle(1)), outfit(handle(2))], [{ hat: 'hat-wizard' }, { hat: 'hat-wizard' }]);
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(office.scene.addons)')), ['office-neon']);
  assert.equal(page.run('office.scene.pets.has(OFFICE_PLAYER)'), true);
});

test('the shop previews what you pick, buys with one id and nothing else, and says why it cannot', async () => {
  const { page, posts } = await gamePage(hud(), { view: 'game' });
  page.run("gameUi.tab = 'shop'; render()");
  await page.settle(20);
  page.run('render()');
  assert.ok(page.$('#main .game-preview canvas'), 'a live preview');
  assert.equal(page.run('gameUi.preview.renderer.spec.outfit.hat'), 'hat-crown');
  page.$('#game-item-skin-chrome').click();
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(gameUi.preview.renderer.spec)')), { wearer: 'player', outfit: { hat: 'hat-crown', held: 'held-saber', pet: 'pet-cat', skin: 'skin-chrome' } });
  const buy = page.$('#g-game-buy\\:skin-chrome') ?? page.document.getElementById('g-game-buy:skin-chrome');
  buy.click();
  page.document.getElementById('g-game-buy:skin-chrome').click();
  await page.settle(20);
  assert.deepEqual(posts.splice(0), [{ path: '/api/game/buy', body: { item: 'skin-chrome' } }]);
  page.$('#game-item-hat-crown').click();
  assert.match(text(page.$('#main .game-detail')), /Unlocks at level 30/);
  page.$('#game-item-pet-dog').click();
  assert.match(text(page.$('#main .game-detail')), /2,782 more coins to go/);
  page.$('#game-item-office-disco').click();
  assert.deepEqual(JSON.parse(page.run('JSON.stringify(gameUi.preview.renderer.spec)')), { addon: 'office-disco' });
  page.$('#game-item-hat-party').click();
  assert.match(text(page.$('#main .game-detail')), /Wear it in the wardrobe/);
  assert.deepEqual(page.errors, []);
});

test('the wardrobe dresses you, the manager or a whole kind of agent, and places what the office has', async () => {
  const { page, posts } = await gamePage(hud(), { view: 'game' });
  page.run("gameUi.tab = 'wardrobe'; render()");
  await page.settle(20);
  page.run('render()');
  page.$('#game-wearer-kind\\:review')?.click() ?? page.document.getElementById('game-wearer-kind:review').click();
  const hats = page.$$('#main .game-slot').find((s) => s.querySelector('h3').textContent === 'Hats');
  assert.deepEqual(hats.querySelectorAll('.chip').map((c) => [c.textContent, c.getAttribute('aria-pressed')]), [['None', 'false'], ['Party hat', 'false'], ['Wizard hat', 'true']]);
  hats.querySelectorAll('.chip')[1].click();
  await page.settle(20);
  page.document.getElementById('game-place-office-neon').click();
  await page.settle(20);
  assert.deepEqual(posts, [
    { path: '/api/game/equip', body: { wearer: 'kind:review', slot: 'hat', item: 'hat-party' } },
    { path: '/api/game/equip', body: { wearer: 'office', slot: 'office-neon', item: null } },
  ]);
});

test('the profile lists stats, achievements with secrets hidden, and how each reward is earned', async () => {
  const { page } = await gamePage(hud(), { view: 'game' });
  await page.settle(20);
  page.run('render()');
  const main = text(page.$('#main'));
  assert.match(main, /Level 15 Senior · 4,718 coins · 8 days in a row/);
  assert.match(main, /Review comments 716/);
  assert.match(main, /2,217,049 tokens today, 243,168,525 over the last 30 days/);
  assert.deepEqual(page.$$('#main .game-badges li').map((li) => [li.className, li.querySelector('b').textContent]), [['got', 'First merge'], ['locked', '???']]);
  assert.deepEqual(page.$$('#main .game-earn tbody tr').map((tr) => tr.querySelectorAll('td').map(text)), [['MR merged Your MR merged', '120', '12'], ['Million tokens Each million', '40', '4']]);
});

test('Settings has the game: on and off, toasts, the token rate, and a reset that takes two clicks and says what it clears', async () => {
  const { page, posts } = await gamePage(hud(), { view: 'settings' });
  await page.settle(20);
  page.run('render()');
  const group = page.$('#game-settings');
  assert.match(text(group), /Clears your level, XP, coins, streak, quests, achievements and everything bought and worn/);
  page.document.getElementById('game-on').click();
  await page.settle(20);
  page.document.getElementById('game-toasts').click();
  await page.settle(20);
  const rate = page.document.getElementById('game-rate');
  rate.value = '80';
  page.fire(rate, 'input');
  page.fire(page.document.getElementById('game-rate'), 'keydown', { key: 'Enter' });
  await page.settle(20);
  page.document.getElementById('g-game-reset').click();
  assert.deepEqual(posts.map((p) => p.path).filter((p) => p.endsWith('reset')), [], 'one click only arms it');
  page.document.getElementById('g-game-reset').click();
  await page.settle(20);
  assert.deepEqual(posts, [
    { path: '/api/game/settings', body: { on: false } },
    { path: '/api/game/settings', body: { toasts: false } },
    { path: '/api/game/settings', body: { tokenRate: 80 } },
    { path: '/api/game/reset', body: { confirm: 'start again' } },
  ]);
});

test('the page reports its best rally and no more, and never sends an amount anywhere', async () => {
  const source = (await Promise.all(['48-game.js', '48-game-view.js', '31-office.js'].map((n) => readFile(new URL('./' + n, import.meta.url), 'utf8')))).join('\n');
  const sent = [...source.matchAll(/api\('\/api\/game[^']*',\s*(\{[^}]*\})/g)].map((m) => m[1]);
  const written = [...source.matchAll(/gameWrite\('\/api\/game[^']*',\s*(\{[^}]*\})/g)].map((m) => m[1]);
  assert.ok(sent.length + written.length >= 5);
  for (const body of [...sent, ...written]) assert.doesNotMatch(body, /\b(xp|coins|price|amount|source|kind)\b/, body);
  const { page, posts } = await gamePage();
  page.run('office.scene.rally.best = 21; officeRallyReport(); officeRallyReport();');
  page.run('office.scene.rally.best = 3; officeRallyReport();');
  await page.settle(20);
  assert.deepEqual(posts, [{ path: '/api/game/rally', body: { hits: 21 } }]);
});

test('you wander the lounge but never take a table tennis end from the agents, and a long rally happens now and then', async () => {
  const context = vm.createContext({ isNeed: () => false, console });
  for (const name of ['31-mood.js', '31-office-floor.js', '31-office-sim.js']) vm.runInContext(await readFile(new URL('./' + name, import.meta.url), 'utf8'), context);
  const you = { handle: 'office:player', player: true, prefs: ['sofa'], state: 'done', lastAt: Number.MAX_SAFE_INTEGER };
  context.agents = [you, agent(1), agent(2)];
  const plan = vm.runInContext('officePlan(agents, officeMemory(), Date.parse("2026-11-11T12:00:00Z"))', context);
  assert.deepEqual([...plan.pair].sort(), [handle(1), handle(2)]);
  assert.equal(plan.places.get('office:player').activity, 'sofa');
  const lengths = vm.runInContext('(() => { const r = officeRallyNew(7); const out = []; for (let i = 0; i < 400; i++) { officeRallyServe(r); out.push(r.missAt); } return out; })()', context);
  assert.ok(lengths.some((n) => n >= 20) && lengths.filter((n) => n >= 20).length < lengths.length / 4, 'twenty in a row is possible and rare');
  context.addons = ['office-arcade'];
  const blocks = vm.runInContext('officeLayout(6, addons).blocks.length - officeLayout(6).blocks.length', context);
  assert.equal(blocks, 1, 'the arcade machine is walked round');
});
