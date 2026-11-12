import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'control-centre-game-'));
process.env.HOME = home;
delete process.env.CLAUDE_CONFIG_DIR;
const testkit = new URL('./testkit.mjs', import.meta.url).href;
const enginePath = join(home, 'engine.mjs');
await writeFile(enginePath, `import { world } from '${testkit}';
export * from '${testkit}';
const within = (list, from, to) => (list ?? []).filter((x) => x.day >= from && x.day <= to);
export async function readGitlabWork(from, to, known) {
  world.calls.push(['readGitlabWork', from, to]);
  if (world.gitlabFails) throw new Error(world.gitlabFails);
  return { me: world.me, briefs: { ...known }, merged: within(world.work?.merged, from, to), reviews: within(world.work?.reviews, from, to) };
}
export async function readTicketMoves(from, to) {
  world.calls.push(['readTicketMoves', from, to]);
  if (world.jiraFails) throw new Error(world.jiraFails);
  return within(world.moves, from, to);
}
`);

const { route, snapshot } = await import('./app.mjs');
const { loadEngine } = await import('./engine.mjs');
const game = await import('./game.mjs');
const { reset, world } = await import('./testkit.mjs');
const { addDays, CATALOGUE, REWARDS, xpForLevel } = await import('./game-rules.mjs');
const { dayOf } = await import('./locale.mjs');
const { appendLedger } = await import('./game-ledger.mjs');
const { MOOD_MINUTES } = await import('./moods.mjs');
after(() => rm(home, { recursive: true }));

const stateDir = join(home, 'state');
const projects = join(home, 'transcripts');
const config = { stateDir, claudeProjects: projects };
const ledger = join(stateDir, 'game.jsonl');
const today = dayOf(Date.now());
const ago = (n) => addDays(today, -n);
const noon = (day) => `${day}T12:00:00.000Z`;
const notified = [];
let msg = 0;

const call = async (method, path, payload) => route({ method, path, query: new URLSearchParams(), body: async () => payload, config });
const post = (path, payload) => call('POST', path, payload);
const lines = async () => (await readFile(ledger, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const asked = (name) => world.calls.filter(([n]) => n === name);

function said(day, tokens) {
  msg += 1;
  return JSON.stringify({ type: 'assistant', timestamp: noon(day), sessionId: 's', message: { id: `msg_${msg}`, content: [{ type: 'text', text: 'private' }], usage: { input_tokens: 0, cache_creation_input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 5e9 } } }) + '\n';
}

async function transcript(name, text) {
  await mkdir(join(projects, '-ws'), { recursive: true });
  await appendFile(join(projects, '-ws', `${name}.jsonl`), text);
}

const queued = (id, day, extra = {}) => ({ id, projectPath: 'tooling/engine', iid: 12, status: 'posted', postedAt: noon(day), kind: 'finding', ...extra });
const turn = (day, tokens = 0) => ({ at: Date.parse(noon(day)), ok: true, tokens });

function realWork() {
  reset({
    queue: [queued('f1', ago(2)), queued('f-old', ago(40)), queued('f-pending', ago(1), { status: 'pending', postedAt: undefined })],
    agents: [
      { sessionId: 'agent-review', kind: 'review', mr: 'tooling/engine!12', turns: [turn(ago(1), 1_000_000)] },
      { sessionId: 'agent-lost', kind: 'fix', mr: 'tooling/engine!13', turns: [turn(ago(1), 1_500_000)] },
      { sessionId: 'panel', kind: 'master', turns: [turn(ago(1))] },
    ],
    work: {
      merged: [{ key: 'tooling/atlas!45', title: 'Tidy', at: noon(ago(3)), day: ago(3) }, { key: 'tooling/atlas!1', title: 'Old', at: noon(ago(31)), day: ago(31) }],
      reviews: [{ key: 'tooling/engine!12', title: 'Graph', at: noon(ago(1)), day: ago(1), comments: 3, approved: true }],
    },
    moves: [{ key: 'ABC-9', status: 'QA', day: ago(2), summary: 'Ship' }],
  });
}

async function begin() {
  await game.start(config, { notify: (e) => notified.push(e), log: () => {} });
  await game.settled();
}

beforeEach(async () => {
  game.stop();
  await game.settled();
  await rm(stateDir, { recursive: true, force: true });
  await rm(projects, { recursive: true, force: true });
  await rm(join(home, '.config'), { recursive: true, force: true });
  notified.length = 0;
  realWork();
  await loadEngine({ matrixEngine: enginePath }, () => {});
  await transcript('agent-review', said(ago(1), 2_500_000) + said(today, 1_200_000));
});

test('the first run counts the last 30 days so you start with a level, and marks it all as history', async () => {
  await begin();
  const written = await lines();
  const keys = written.map((e) => e.key);
  for (const key of ['merged:tooling/atlas!45', `review:tooling/engine!12:${ago(1)}`, 'approval:tooling/engine!12', 'ticket:ABC-9:QA', 'finding:f1', 'agent:agent-review', `tokens:${ago(1)}:2`, `tokens:${today}:1`, `tokens:${ago(1)}:3`, 'start']) {
    assert.ok(keys.includes(key), `${key} was not paid`);
  }
  for (const key of ['merged:tooling/atlas!1', 'finding:f-old', 'finding:f-pending', 'agent:panel']) assert.ok(!keys.includes(key), `${key} was paid`);
  assert.equal(keys.filter((k) => k.startsWith(`tokens:${ago(1)}`)).length, 4, 'the lost agent\'s 1.5 million join its day, the found one\'s transcript is not counted twice');
  assert.ok(written.filter((e) => e.kind === 'reward').every((e) => e.back), 'nothing from the backfill toasts on its own');
  assert.equal((await stat(ledger)).mode & 0o777, 0o600);
  assert.deepEqual(asked('readGitlabWork').map(([, from, to]) => [from, to]), [[ago(29), today]]);
  assert.deepEqual(asked('readTicketMoves').map(([, from, to]) => [from, to]), [[ago(29), today]]);
  const view = game.view();
  assert.ok(view.started && view.level > 1 && view.coins > 0, JSON.stringify(view));
  assert.equal(view.quests.length, 3);
  assert.ok(notified.includes('game'));
  assert.doesNotMatch(await readFile(join(stateDir, 'game-cache.json'), 'utf8'), /private/);
});

test('a restart or a second read pays nothing again, and later reads add only what is new', async () => {
  await begin();
  const first = await lines();
  game.stop();
  await game.settled();
  await begin();
  assert.deepEqual((await lines()).length, first.length, 'a restart re-reads everything and pays nothing');
  world.calls.length = 0;
  world.work.merged.push({ key: 'tooling/atlas!46', title: 'More', at: new Date().toISOString(), day: today });
  await transcript('agent-review', said(today, 900_000));
  await game.syncRemote();
  await game.syncLocal();
  await game.settled();
  const added = (await lines()).slice(first.length);
  assert.deepEqual(added.filter((e) => e.kind === 'reward').map((e) => [e.key, Boolean(e.back)]).filter(([k]) => !k.startsWith('quest') && !k.startsWith('achievement')), [['merged:tooling/atlas!46', false], [`tokens:${today}:2`, false]]);
  assert.deepEqual(asked('readGitlabWork').map(([, from]) => from), [today], 'GitLab is asked only from the last day it answered for');
});

test('stop returns once its last save of the cache has landed, so a worker that exits on deactivate keeps it', async () => {
  await begin();
  await rm(join(stateDir, 'game-cache.json'));
  await game.stop();
  assert.equal(JSON.parse(await readFile(join(stateDir, 'game-cache.json'), 'utf8')).v, 1);
});

test('the page cannot write a reward: no route takes an amount, and anything it sends pays nothing', async () => {
  await begin();
  const before = game.view();
  const forged = { kind: 'reward', source: 'merged', key: 'merged:forged!1', xp: 1e9, coins: 1e9, label: 'Forged', item: 'hat-party', price: -1e9, hits: 20, on: true, confirm: 'nope' };
  const writes = Object.keys(game.ROUTES).filter((k) => k.startsWith('POST'));
  assert.deepEqual(writes.sort(), ['POST /api/game/buy', 'POST /api/game/equip', 'POST /api/game/rally', 'POST /api/game/reset', 'POST /api/game/settings']);
  for (const name of writes) await post(name.slice(5), forged).catch(() => null);
  await game.settled();
  const after = game.view();
  assert.ok(after.coins <= before.coins, `coins went from ${before.coins} to ${after.coins}`);
  assert.equal(after.xp, before.xp);
  assert.ok(!(await lines()).some((e) => e.key === 'merged:forged!1' || e.xp >= 1e9));
  await assert.rejects(post('/api/matrix/game', forged), { status: 404 });
  assert.deepEqual(Object.keys(game.ACTIONS), []);
});

test('buying takes the coins, needs the level, puts the thing on, and never buys twice', async () => {
  world.work.merged.push(...Array.from({ length: 10 }, (_, i) => ({ key: `tooling/atlas!${100 + i}`, title: 'More', at: noon(ago(4)), day: ago(4) })));
  await begin();
  const coins = game.view().coins;
  const locked = CATALOGUE.find((i) => i.level > game.view().level);
  await assert.rejects(post('/api/game/buy', { item: locked.id }), { status: 409, message: new RegExp(`unlocks at level ${locked.level}`) });
  await assert.rejects(post('/api/game/buy', { item: 'hat-fez' }), { status: 400 });
  const answer = await post('/api/game/buy', { item: 'hat-party' });
  assert.match(answer.text, /Bought the party hat for 80 coins and put it on/);
  assert.equal(game.view().coins, coins - 80);
  assert.equal(game.view().equipped.player.hat, 'hat-party');
  await assert.rejects(post('/api/game/buy', { item: 'hat-party' }), { status: 409, message: /already have/ });
  await assert.rejects(post('/api/game/equip', { wearer: 'kind:review', slot: 'hat', item: 'hat-wizard' }), { status: 409, message: /Buy it first/ });
  await post('/api/game/equip', { wearer: 'kind:review', slot: 'hat', item: 'hat-party' });
  await post('/api/game/buy', { item: 'office-neon' });
  assert.deepEqual([game.view().equipped['kind:review'].hat, game.view().equipped.office['office-neon']], ['hat-party', 'office-neon']);
  await post('/api/game/equip', { wearer: 'office', slot: 'office-neon', item: null });
  assert.equal(game.view().equipped.office['office-neon'], null);
  const shop = await call('GET', '/api/game');
  assert.deepEqual(shop.catalogue.filter((i) => i.owned).map((i) => i.id).sort(), ['hat-party', 'office-neon']);
  assert.ok(shop.catalogue.find((i) => i.id === locked.id).locked);
});

test('too few coins for something unlocked is refused, and says how many you have', async () => {
  reset({ work: { merged: [], reviews: [] }, moves: [], queue: [], agents: [] });
  await rm(projects, { recursive: true, force: true });
  await begin();
  await assert.rejects(post('/api/game/buy', { item: 'held-mug' }), { status: 409, message: /costs 50 coins and you have 0/ });
});

test('turned off, the game reads nothing and shows nothing, and on again it carries on', async () => {
  await begin();
  const answer = await post('/api/game/settings', { on: false });
  assert.match(answer.text, /The game is off/);
  world.calls.length = 0;
  await game.syncRemote();
  await game.settled();
  assert.deepEqual(asked('readGitlabWork'), []);
  assert.deepEqual(game.view(), { on: false, toasts: true });
  assert.equal((await snapshot()).game.on, false);
  await assert.rejects(post('/api/game/buy', { item: 'hat-party' }), { status: 409, message: /The game is off/ });
  await post('/api/game/settings', { on: true, toasts: false });
  await game.settled();
  assert.equal(asked('readGitlabWork').length, 1);
  assert.equal(game.view().toasts, false);
  const saved = JSON.parse(await readFile(join(home, '.config/underlings/game.json'), 'utf8'));
  assert.deepEqual(saved, { on: true, toasts: false, tokenRate: REWARDS.tokens.xp });
});

test('the token rate is tuned within bounds and pays from then on', async () => {
  await begin();
  await assert.rejects(post('/api/game/settings', { tokenRate: 9999 }), { status: 400 });
  await assert.rejects(post('/api/game/settings', { tokenRate: 'lots' }), { status: 400 });
  const answer = await post('/api/game/settings', { tokenRate: 100 });
  assert.match(answer.text, /pays 100 XP and 10 coins/);
  await transcript('agent-review', said(today, 1_000_000));
  await game.syncLocal();
  await game.settled();
  const paid = (await lines()).find((e) => e.key === `tokens:${today}:2`);
  assert.deepEqual([paid.xp, paid.coins], [100, 10]);
  assert.equal((await lines()).find((e) => e.key === `tokens:${today}:1`).xp, REWARDS.tokens.xp, 'the million paid before keeps its rate');
});

test('a reset takes the exact words, clears everything bought and earned, and counts the last 30 days again', async () => {
  await begin();
  const before = game.view();
  await post('/api/game/buy', { item: 'hat-party' });
  await assert.rejects(post('/api/game/reset', {}), { status: 400 });
  await assert.rejects(post('/api/game/reset', { confirm: 'yes' }), { status: 400 });
  const answer = await post('/api/game/reset', { confirm: 'start again' });
  assert.match(answer.text, /Cleared your level, XP, coins, streak, quests, achievements and everything bought and worn/);
  await game.settled();
  const now = game.view();
  assert.deepEqual([now.xp, now.coins, now.equipped.player], [before.xp, before.coins, undefined]);
  assert.equal((await lines()).filter((e) => e.kind === 'buy').length, 0);
});

test('the rally only ever records the longest, and its badge pays nothing', async () => {
  await begin();
  const before = game.view();
  await assert.rejects(post('/api/game/rally', { hits: 0 }), { status: 400 });
  await assert.rejects(post('/api/game/rally', { hits: 1e6 }), { status: 400 });
  await assert.rejects(post('/api/game/rally', { hits: 2.5 }), { status: 400 });
  assert.equal((await post('/api/game/rally', { hits: 22 })).best, 22);
  assert.equal((await post('/api/game/rally', { hits: 12 })).best, 22);
  const written = await lines();
  assert.deepEqual(written.filter((e) => e.kind === 'event').map((e) => e.key), ['rally:22']);
  assert.deepEqual(written.filter((e) => e.key === 'achievement:rally-20').map((e) => [e.xp, e.coins]), [[0, 0]]);
  assert.deepEqual([game.view().xp, game.view().coins], [before.xp, before.coins]);
});

test('Needs you counts as cleared only once it had something in it that day', () => {
  const now = Date.now();
  assert.deepEqual(game.needsFacts(now, { builtAt: null, count: 0 }), []);
  assert.deepEqual(game.needsFacts(now, { builtAt: 'x', count: 0 }), []);
  assert.deepEqual(game.needsFacts(now, { builtAt: 'x', count: 2 }), []);
  assert.deepEqual(game.needsFacts(now, { builtAt: 'x', count: 0 }).map((e) => [e.key, e.what]), [[`needs:${today}`, 'needs']]);
});

test('Jira that keeps failing is left alone for two hours, and GitLab still pays meanwhile', async () => {
  world.jiraFails = 'acli is not logged in';
  await begin();
  assert.equal((await call('GET', '/api/game')).status.jira, 'acli is not logged in');
  world.calls.length = 0;
  await game.syncRemote();
  await game.settled();
  assert.deepEqual([asked('readGitlabWork').length, asked('readTicketMoves').length], [1, 0]);
  assert.ok((await lines()).some((e) => e.key === 'merged:tooling/atlas!45'));
});

test('the page snapshot carries the HUD: level, coins, streak, quests, what is worn and the latest rewards', async () => {
  await begin();
  const { game: hud } = await snapshot();
  for (const key of ['level', 'title', 'xp', 'levelAt', 'nextAt', 'coins', 'streak', 'quests', 'equipped', 'recent', 'seq', 'epoch', 'me']) assert.ok(key in hud, key);
  assert.equal(hud.recent.at(-1).seq, hud.seq);
  const full = await call('GET', '/api/game');
  assert.equal(full.achievements.filter((a) => a.secret && !a.at).every((a) => a.name === '???'), true);
  assert.ok(full.rewards.find((r) => r.source === 'tokens').what.includes('cache reads left out'));
});

test('a room is built in the shop with the level and the coins, puts nothing on, reaches the office, and is never built twice', async () => {
  await appendLedger(ledger, [{ kind: 'start', key: 'start', at: noon(ago(5)) }, { kind: 'reward', source: 'merged', key: 'merged:rich', day: ago(1), at: noon(ago(1)), xp: xpForLevel(20), coins: 14_000 }]);
  await begin();
  await assert.rejects(post('/api/game/buy', { item: 'room-extension' }), { status: 409, message: /unlocks at level 24/ });
  await assert.rejects(post('/api/game/buy', { item: 'room-terrace' }), { status: 409, message: /opens off the games room or the extension/ });
  const coins = game.view().coins;
  assert.match((await post('/api/game/buy', { item: 'room-kitchen' })).text, /^Built the kitchen for 6000 coins$/);
  await assert.rejects(post('/api/game/buy', { item: 'room-kitchen' }), { status: 409, message: /already have the kitchen/ });
  await post('/api/game/buy', { item: 'room-games' });
  assert.equal(game.view().coins, coins - 6000 - 7500);
  assert.deepEqual(game.view().rooms, ['room-kitchen', 'room-games']);
  assert.deepEqual((await lines()).filter((e) => e.kind === 'buy').map((e) => e.key), ['buy:room-kitchen', 'buy:room-games']);
  assert.equal((await lines()).filter((e) => e.kind === 'equip').length, 0, 'a room is not worn or placed');
  await assert.rejects(post('/api/game/equip', { wearer: 'office', slot: 'room-kitchen', item: null }), { status: 409, message: /not something for the office/ });
  const shop = await call('GET', '/api/game');
  assert.deepEqual(shop.catalogue.find((i) => i.id === 'room-terrace').buildFirst, null, 'the terrace now has a way in');
  const { game: hud, moods } = await snapshot();
  assert.deepEqual([hud.rooms, moods], [['room-kitchen', 'room-games'], MOOD_MINUTES]);
});

test('the worker counts how long each agent waited on you as the waits end, from the agents it already reads', async () => {
  const since = Date.now() - 3 * 60_000;
  world.agents = [{ handle: 'claude:w', sessionId: 'w', kind: 'review', state: 'waiting', since, turns: [] }];
  await begin();
  await game.syncLocal();
  world.agents = [{ ...world.agents[0], state: 'working', since: Date.now() }];
  await game.syncLocal();
  const waits = (await lines()).filter((e) => e.what === 'wait');
  assert.deepEqual(waits.map((e) => [e.key, e.answered, e.minutes >= 3 && e.minutes < MOOD_MINUTES.impatient]), [[`wait:claude:w:${since}`, true, true]]);
});
