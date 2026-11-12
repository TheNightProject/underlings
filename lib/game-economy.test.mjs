import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { appendLedger, buyRefusal, progressOf, readLedger, replay, statsOf, streakOf } from './game-ledger.mjs';
import { ACHIEVEMENTS, BANDS, CATALOGUE, levelFor, QUESTS, REWARDS, ROOM, titleFor, xpForLevel } from './game-rules.mjs';
import { dayOf } from './locale.mjs';
import { agentRewards, agentTokens, drawQuests, findingRewards, followUps, questPlan, questProgress, queuePosts, reward, tokenRewards, waitFacts, workRewards } from './game-sources.mjs';
import { placeLocale } from './fixtures/locale.mjs';
import { MOOD_MINUTES } from './moods.mjs';

const home = await mkdtemp(join(tmpdir(), 'control-centre-game-economy-'));
process.env.HOME = home;
await placeLocale(home);
after(() => rm(home, { recursive: true }));

const NOW = Date.parse('2026-11-11T15:00:00Z');
const TODAY = '2026-11-11';
const pay = (source, key, at, xp = 100, coins = 10) => ({ ...reward(source, key, at, key), xp, coins });
const coinsFor = (coins, at = '2026-11-02T10:00:00Z', key = `merged:g/r!${coins}`) => pay('merged', key, at, coins * 10, coins);
const buy = (item, at = '2026-11-03T10:00:00Z') => ({ kind: 'buy', key: `buy:${item}`, item, at });
const equip = (wearer, slot, item, n) => ({ kind: 'equip', key: `equip:${n}`, wearer, slot, item, at: '2026-11-04T10:00:00Z' });
const worked = (...days) => new Set(days);

test('a reward written twice, by a re-read or a second worker, pays once', () => {
  const once = pay('merged', 'merged:g/atlas!45', '2026-11-10T10:00:00Z', 120, 12);
  const s = replay([once, { ...once }, once]);
  assert.deepEqual([s.xp, s.coins, s.accepted.length, s.counts.merged], [120, 12, 1, 1]);
});

test('a hand-made reward with a negative or missing amount is no reward at all', () => {
  const s = replay([{ ...coinsFor(5), coins: -500 }, { ...coinsFor(6), xp: 'lots' }, { ...coinsFor(7), coins: Infinity }]);
  assert.deepEqual([s.xp, s.coins, s.rejected], [0, 0, 3]);
});

test('levels rise on a steepening curve, with a title per band', () => {
  const steps = Array.from({ length: 60 }, (_, i) => xpForLevel(i + 2) - xpForLevel(i + 1));
  assert.ok(steps.every((step, i) => i === 0 || step > steps[i - 1]), 'each level asks more than the last');
  assert.deepEqual([xpForLevel(1), xpForLevel(2), xpForLevel(10), xpForLevel(16)], [0, 400, 18706, 45732]);
  assert.deepEqual([levelFor(0), levelFor(399), levelFor(400), levelFor(45731), levelFor(45732)], [1, 1, 2, 15, 16]);
  assert.deepEqual(BANDS.map(([from]) => titleFor(from)), ['Intern', 'Junior', 'Senior', 'Staff', 'Principal', 'Legend']);
  assert.deepEqual([titleFor(4), titleFor(9), titleFor(44), titleFor(99)], ['Intern', 'Junior', 'Principal', 'Legend']);
  assert.deepEqual(progressOf(500), { level: 2, title: 'Intern', xp: 500, levelAt: 400, nextAt: xpForLevel(3) });
});

test('a purchase needs the coins and the level, and the same thing cannot be bought twice', () => {
  const hat = CATALOGUE.find((i) => i.id === 'hat-party');
  const crown = CATALOGUE.find((i) => i.id === 'hat-crown');
  assert.match(buyRefusal(replay([]), 'hat-party'), /costs 80 coins and you have 0/);
  assert.match(buyRefusal(replay([coinsFor(5000)]), 'hat-crown'), /unlocks at level 30/);
  assert.match(buyRefusal(replay([]), 'hat-sombrero'), /no such item/);
  const s = replay([coinsFor(100), buy('hat-party'), buy('hat-party')]);
  assert.deepEqual([s.coins, [...s.owned], s.bought], [100 - hat.price, ['hat-party'], 1]);
  assert.match(buyRefusal(s, 'hat-party'), /already have the party hat/);
  assert.ok(crown.price > hat.price && crown.level > hat.level);
});

test('a purchase the coins did not cover where it was written never happened, and does not block buying it later', () => {
  const s = replay([coinsFor(50), buy('hat-party'), coinsFor(60, '2026-11-05T10:00:00Z', 'merged:g/r!late'), buy('hat-party', '2026-11-06T10:00:00Z')]);
  assert.deepEqual([s.coins, [...s.owned], s.rejected], [110 - 80, ['hat-party'], 1]);
});

test('prices rise with the level each item waits for, within its kind', () => {
  for (const slot of ['skin', 'hat', 'held', 'pet', 'office', ROOM]) {
    const items = CATALOGUE.filter((i) => i.slot === slot).sort((a, b) => a.level - b.level);
    assert.ok(items.every((item, i) => i === 0 || item.price > items[i - 1].price), slot);
  }
  assert.equal(CATALOGUE.length, 33);
});

test('something is worn only once bought, in the place it goes, and the latest choice wins', () => {
  const owned = [coinsFor(1000), buy('hat-party'), buy('hat-headphones'), buy('office-neon')];
  const s = replay([
    ...owned,
    equip('player', 'hat', 'hat-wizard', 1), equip('player', 'held', 'hat-party', 2), equip('nobody', 'hat', 'hat-party', 3),
    equip('kind:review', 'hat', 'hat-party', 4), equip('kind:review', 'hat', 'hat-headphones', 5), equip('player', 'hat', 'hat-party', 6),
    equip('office', 'office-neon', 'office-neon', 7), equip('office', 'office-fridge', 'office-fridge', 8), equip('player', 'hat', null, 9),
  ]);
  assert.deepEqual(s.equipped, { office: { 'office-neon': 'office-neon' }, 'kind:review': { hat: 'hat-headphones' }, player: { hat: null } });
  assert.equal(s.rejected, 4);
});

test('a streak counts days worked, skips weekends unworked, and breaks on a weekday missed', () => {
  assert.equal(streakOf(worked('2026-11-09', '2026-11-10', '2026-11-11'), '2026-11-11'), 3);
  assert.equal(streakOf(worked('2026-11-09', '2026-11-10'), '2026-11-11'), 2, 'today not worked yet keeps yesterday\'s streak');
  assert.equal(streakOf(worked('2026-11-06', '2026-11-09'), '2026-11-09'), 2, 'Friday to Monday over an unworked weekend');
  assert.equal(streakOf(worked('2026-11-06', '2026-11-07', '2026-11-09'), '2026-11-09'), 3, 'a Saturday worked counts');
  assert.equal(streakOf(worked('2026-11-05', '2026-11-09'), '2026-11-09'), 1, 'Friday missed');
  assert.equal(streakOf(worked('2026-11-05'), '2026-11-11'), 0);
  assert.equal(streakOf(worked(), '2026-11-11'), 0);
  const s = replay(['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-05'].map((day, i) => pay('agent', `agent:${i}`, `${day}T10:00:00Z`)));
  assert.deepEqual([statsOf(s, '2026-11-05').streak, statsOf(s, '2026-11-05').bestStreak], [1, 7]);
});

test('the ledger file is readable only by you, and a line torn by a crash is skipped', async () => {
  const path = join(home, 'state', 'game.jsonl');
  await appendLedger(path, [coinsFor(1)]);
  await writeFile(path, (await readFile(path, 'utf8')) + '{"kind":"reward","key":"merged:g/r!9","xp":');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual((await readLedger(path)).map((e) => e.key), ['merged:g/r!1']);
  assert.deepEqual(await readLedger(join(home, 'none.jsonl')), []);
});

const WORK = {
  merged: [{ key: 'tooling/atlas!45', title: 'Tidy', at: '2026-11-10T15:00:00Z', day: '2026-11-10' }],
  reviews: [
    { key: 'tooling/engine!12', title: 'Graph', day: '2026-11-09', at: '2026-11-09T09:00:00Z', comments: 14, approved: true },
    { key: 'tooling/engine!12', title: 'Graph', day: '2026-11-10', at: '2026-11-10T09:00:00Z', comments: 3, approved: true },
  ],
  moves: [{ key: 'ABC-9', status: 'QA', day: '2026-11-10', summary: 'x' }, { key: 'ABC-9', status: 'Done', day: '2026-11-11', summary: 'x' }, { key: 'ABC-8', status: 'Closed', day: '2026-11-11', summary: 'y' }],
};

test('each GitLab and Jira source pays what the table says, under a key that never pays twice', () => {
  const found = workRewards(WORK, { 'tooling/engine!12@2026-11-10': 2 });
  const of = (source) => found.filter((e) => e.source === source);
  assert.deepEqual(of('merged').map((e) => [e.key, e.label, e.xp, e.coins, e.day]), [['merged:tooling/atlas!45', 'Merged atlas!45', REWARDS.merged.xp, REWARDS.merged.coins, '2026-11-10']]);
  assert.deepEqual(of('review').map((e) => e.key), ['review:tooling/engine!12:2026-11-09', 'review:tooling/engine!12:2026-11-10']);
  assert.equal(of('comment').filter((e) => e.day === '2026-11-09').length, REWARDS.comment.cap, 'at most ten comments a day on one MR');
  assert.deepEqual(of('comment').filter((e) => e.day === '2026-11-10').map((e) => e.key), ['comment:tooling/engine!12:2026-11-10:1'], 'less the two the queue posted');
  assert.deepEqual(of('approval').map((e) => e.key), ['approval:tooling/engine!12', 'approval:tooling/engine!12']);
  assert.equal(replay(found).counts.approval, 1, 'an approval is paid once per MR');
  assert.deepEqual([...of('qa'), ...of('done')].map((e) => [e.key, e.label, e.day]), [['ticket:ABC-9:QA', 'Moved ABC-9 to QA', '2026-11-10'], ['ticket:ABC-9:Done', 'Moved ABC-9 to Done', '2026-11-11']]);
  assert.equal(found.some((e) => e.key.includes('ABC-8')), false, 'only QA and Done pay');
});

const item = (id, extra) => ({ id, projectPath: 'tooling/engine', iid: 12, status: 'posted', postedAt: '2026-11-10T11:00:00Z', ...extra });

test('a finding the queue posted pays once, and its comment on GitLab is not paid again', () => {
  const queue = [item('f1'), item('f2', { kind: 'finding' }), item('r1', { kind: 'reply', replyTo: 'd1' }), item('v1', { kind: 'verdict' }), item('f3', { status: 'pending', postedAt: undefined }), item('f4', { status: 'discarded' })];
  assert.deepEqual(findingRewards(queue).map((e) => [e.key, e.label]), [['finding:f1', 'Posted a finding on engine!12'], ['finding:f2', 'Posted a finding on engine!12']]);
  assert.deepEqual(queuePosts(queue), { 'tooling/engine!12@2026-11-10': 3 });
});

const turn = (at, ok = true, tokens = 0) => ({ at: Date.parse(at), ok, tokens });
const agentOf = (sessionId, kind, turns, extra = {}) => ({ sessionId, kind, mr: 'tooling/engine!12', ticket: null, turns, ...extra });

test('an agent pays once, when its first turn ends without an error, and the panel\'s own chat never does', () => {
  const agents = [
    agentOf('a1', 'review', [turn('2026-11-10T09:00:00Z', false), turn('2026-11-10T09:30:00Z'), turn('2026-11-10T10:00:00Z')]),
    agentOf('a2', 'master', [turn('2026-11-10T09:00:00Z')]),
    agentOf('a3', 'fix', [turn('2026-11-10T09:00:00Z', false)]),
    agentOf('a4', 'kickoff', [turn('2026-11-10T11:00:00Z')], { mr: null, ticket: 'ABC-9' }),
  ];
  assert.deepEqual(agentRewards(agents).map((e) => [e.key, e.at, e.label]), [
    ['agent:a1', '2026-11-10T09:30:00.000Z', 'Review agent finished on engine!12'],
    ['agent:a4', '2026-11-10T11:00:00.000Z', 'Kickoff agent finished on ABC-9'],
  ]);
});

test('an agent\'s recorded tokens count only when its own transcript was not found', () => {
  const agents = [agentOf('seen', 'review', [turn('2026-11-10T09:00:00Z', true, 700)]), agentOf('lost', 'fix', [turn('2026-11-10T09:00:00Z', true, 300), turn('2026-11-10T23:30:00Z', false, 50)])];
  assert.deepEqual(agentTokens(agents, new Set(['seen'])), { '2026-11-10': 350 });
});

test('tokens pay per whole million in a day, at the rate set when each million lands', () => {
  const days = { '2026-11-10': 2_999_999, '2026-11-11': 1_000_000, '2026-11-09': 999_999 };
  const found = tokenRewards(days, 40, NOW);
  assert.deepEqual(found.map((e) => [e.key, e.xp, e.coins]), [['tokens:2026-11-10:1', 40, 4], ['tokens:2026-11-10:2', 40, 4], ['tokens:2026-11-11:1', 40, 4]]);
  assert.deepEqual(found.map((e) => e.label), ['1 million tokens on 10 Nov', '2 million tokens on 10 Nov', '1 million tokens today']);
  const dearer = tokenRewards(days, 100, NOW);
  assert.deepEqual(dearer.map((e) => [e.key, e.xp, e.coins]).at(-1), ['tokens:2026-11-11:1', 100, 10]);
  assert.equal(replay([...found, ...dearer]).xp, 120, 'a million already paid is not paid again at the new rate');
});

const history = (days, source, perDay) => days.flatMap((day, d) => Array.from({ length: perDay }, (_, i) => pay(source, `${source}:${d}:${i}`, `${day}T10:00:00Z`)));
const pastDays = (n) => Array.from({ length: n }, (_, i) => new Date(Date.parse('2026-11-10T12:00:00Z') - i * 864e5).toISOString().slice(0, 10));

test('three quests a day, the same three all day, sized and chosen from what you do', () => {
  const s = replay([...history(pastDays(20), 'review', 4), ...history(pastDays(10), 'finding', 6)]);
  const plan = Object.fromEntries(questPlan(s, TODAY).map((q) => [q.id, q]));
  assert.equal(plan.review.target, 4, 'your usual four reviews a day');
  assert.equal(plan.findings.target, 6);
  assert.equal(plan.tokens.target, QUESTS.find((q) => q.id === 'tokens').target[0], 'no history keeps the usual size');
  assert.ok(plan.review.weight > plan.merge.weight && plan.merge.weight > plan.tokens.weight);
  const drawn = drawQuests(s, TODAY);
  assert.equal(drawn.length, 3);
  assert.equal(new Set(drawn.map((q) => q.id)).size, 3);
  assert.deepEqual(drawQuests(s, TODAY), drawn);
  const days = Array.from({ length: 40 }, (_, i) => drawQuests(s, `2026-12-${String((i % 28) + 1).padStart(2, '0')}`).map((q) => q.id)).flat();
  assert.ok(days.filter((id) => QUESTS.find((q) => q.id === id).core).length > days.length / 2, 'the four you named come up most');
});

test('a quest is drawn at UK midnight, counts that day\'s work, and pays once when done', () => {
  const beforeMidnight = Date.parse('2026-07-01T22:59:00Z');
  const afterMidnight = Date.parse('2026-07-01T23:01:00Z');
  const base = [{ kind: 'start', key: 'start', at: '2026-06-01T00:00:00Z' }];
  const first = followUps(replay(base), beforeMidnight);
  assert.deepEqual(first.map((e) => [e.kind, e.day]), [['quests', '2026-07-01']]);
  const next = followUps(replay([...base, ...first]), afterMidnight);
  assert.deepEqual(next.map((e) => [e.kind, e.day]), [['quests', '2026-07-02']], 'midnight in London is 23:00 UTC in summer');
  const quests = { kind: 'quests', key: 'quests:2026-07-02', day: '2026-07-02', at: '2026-07-01T23:01:00Z', quests: [{ id: 'merge', target: 1, label: 'Merge an MR' }, { id: 'review', target: 2, label: 'Review 2 MRs' }, { id: 'needs', target: 1, label: 'Clear Needs you' }] };
  const work = [pay('merged', 'merged:g/r!1', '2026-07-01T23:30:00Z'), pay('review', 'review:g/r!2:2026-07-02', '2026-07-02T08:00:00Z'), pay('merged', 'merged:g/r!0', '2026-07-01T22:00:00Z')];
  const s = replay([...base, quests, ...work]);
  assert.deepEqual(questProgress(s, '2026-07-02').map((q) => [q.id, q.have, q.done]), [['merge', 1, false], ['review', 1, false], ['needs', 0, false]]);
  const done = followUps(s, Date.parse('2026-07-02T09:00:00Z'));
  assert.deepEqual(done.map((e) => [e.key, e.xp, e.coins]), [['quest:2026-07-02:merge', REWARDS.quest.xp, REWARDS.quest.coins]]);
  const after = replay([...base, quests, ...work, ...done]);
  assert.deepEqual(questProgress(after, '2026-07-02')[0], { id: 'merge', target: 1, label: 'Merge an MR', have: 1, done: true });
  assert.equal(followUps(after, Date.parse('2026-07-02T09:00:00Z')).some((e) => e.source === 'quest'), false);
});

test('achievements unlock once each at their mark, secrets included, and the rally badge pays nothing', () => {
  const start = { kind: 'start', key: 'start', at: '2026-11-01T00:00:00Z' };
  const quests = { kind: 'quests', key: `quests:${TODAY}`, day: TODAY, at: '2026-11-11T00:00:00Z', quests: [] };
  const merges = Array.from({ length: 25 }, (_, i) => pay('merged', `merged:g/r!${i}`, '2026-11-10T23:30:00Z', 720, 10));
  const rally = { kind: 'event', what: 'rally', key: 'rally:21', value: 21, day: TODAY, at: '2026-11-11T09:00:00Z' };
  const unlocked = followUps(replay([start, quests, ...merges, rally]), NOW);
  const byId = Object.fromEntries(unlocked.map((e) => [e.key.split(':')[1], e]));
  assert.deepEqual(Object.keys(byId).sort(), ['first-merge', 'merges-25', 'night-owl', 'rally-20']);
  assert.deepEqual([byId['rally-20'].xp, byId['rally-20'].coins], [0, 0]);
  assert.deepEqual([byId['first-merge'].xp, byId['first-merge'].coins], [REWARDS.achievement.xp, REWARDS.achievement.coins]);
  assert.ok(ACHIEVEMENTS.find((a) => a.id === 'night-owl').secret);
  const again = replay([start, quests, ...merges, rally, ...unlocked]);
  assert.deepEqual(followUps(again, NOW).filter((e) => e.source === 'achievement').map((e) => e.key), ['achievement:level-10'], 'the XP they paid reaches level 10');
  assert.ok(ACHIEVEMENTS.length >= 15 && ACHIEVEMENTS.filter((a) => a.secret).length >= 3);
});

test('a hundred reviews, a million tokens in a day and a seven-day streak each unlock', () => {
  const start = { kind: 'start', key: 'start', at: '2026-11-01T00:00:00Z' };
  const quests = { kind: 'quests', key: `quests:${TODAY}`, day: TODAY, at: '2026-11-11T00:00:00Z', quests: [] };
  const reviews = Array.from({ length: 100 }, (_, i) => pay('review', `review:g/r!${i}:2026-11-10`, '2026-11-10T10:00:00Z', 0, 0));
  const streak = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'].map((day, i) => pay('agent', `agent:${i}`, `${day}T10:00:00Z`, 0, 0));
  const ids = (list) => followUps(replay([start, quests, ...list]), NOW).map((e) => e.key);
  assert.ok(ids(reviews).includes('achievement:reviews-100'));
  assert.ok(!ids(reviews.slice(1)).includes('achievement:reviews-100'));
  assert.ok(ids(tokenRewards({ '2026-11-10': 1_000_000 }, 0, NOW)).includes('achievement:tokens-day'));
  assert.ok(!ids(streak).includes('achievement:streak-7'));
  assert.ok(ids([...streak, pay('agent', 'agent:x', '2026-11-10T10:00:00Z', 0, 0)]).includes('achievement:streak-7'));
});

test('the day of every reward is its day where you are, London here', () => {
  assert.equal(pay('merged', 'merged:x', '2026-07-01T23:30:00Z').day, '2026-07-02');
  assert.equal(dayOf(Date.parse('2026-12-31T23:30:00Z')), '2026-12-31');
});

const MIN = 60_000;
const rich = (coins, level) => pay('merged', 'merged:rich', '2026-11-02T10:00:00Z', xpForLevel(level), coins);

test('a room is bought like anything else, with the level and the coins, only off a room already there, and only once', () => {
  assert.match(buyRefusal(replay([rich(50_000, 17)]), 'room-kitchen'), /the kitchen unlocks at level 18/);
  assert.match(buyRefusal(replay([rich(100, 18)]), 'room-kitchen'), /the kitchen costs 6000 coins and you have 100/);
  assert.equal(buyRefusal(replay([rich(6000, 18)]), 'room-kitchen'), null);
  assert.match(buyRefusal(replay([rich(50_000, 30)]), 'room-terrace'), /the roof terrace opens off the games room or the extension, so build one of those first/);
  const s = replay([rich(50_000, 30), buy('room-games'), buy('room-terrace'), buy('room-terrace'), buy('room-games')]);
  assert.deepEqual([...s.owned], ['room-games', 'room-terrace']);
  assert.deepEqual([s.coins, s.bought], [50_000 - 7500 - 9000, 2], 'each paid once however often the purchase is written');
  const early = replay([rich(50_000, 30), buy('room-terrace'), buy('room-extension'), buy('room-terrace', '2026-11-05T10:00:00Z')]);
  assert.deepEqual([[...early.owned], early.rejected], [['room-extension', 'room-terrace'], 1], 'a terrace written before its way in never happened, and is bought once there is one');
  const rooms = CATALOGUE.filter((i) => i.slot === ROOM);
  assert.deepEqual(rooms.map((i) => i.id), ['room-kitchen', 'room-games', 'room-terrace', 'room-extension']);
  assert.ok(rooms[0].price < rooms.at(-1).price && rooms[0].level < rooms.at(-1).level, 'the kitchen first, the extension last');
});

test('a wait is counted when it ends, under the day it began, and one left open past angry marks its day at once', () => {
  const since = Date.parse('2026-11-10T09:00:00Z');
  const asking = { handle: 'a', state: 'waiting', since };
  const first = waitFacts([asking, { handle: 'b', state: 'working', since }], since + 3 * MIN, new Map());
  assert.deepEqual(first.facts, [], 'nothing until a wait ends');
  assert.deepEqual([...first.open], [['a', since]]);
  const answered = waitFacts([{ ...asking, state: 'working', since: since + 4 * MIN }], since + 4 * MIN, first.open);
  assert.deepEqual(answered.facts.map((e) => [e.what, e.key, e.day, e.minutes, e.answered]), [['wait', `wait:a:${since}`, '2026-11-10', 4, true]]);
  assert.deepEqual([...answered.open], []);
  const left = waitFacts([{ handle: 'c', state: 'blocked', since }], since + MOOD_MINUTES.angry * MIN, new Map());
  assert.deepEqual(left.facts.map((e) => [e.what, e.key]), [['angry', 'angry:2026-11-10']]);
  const stopped = waitFacts([{ handle: 'c', state: 'done', outcome: 'stopped', since: since + 50 * MIN }], since + 50 * MIN, left.open);
  assert.deepEqual(stopped.facts.map((e) => [e.what, e.answered]), [['wait', false]], 'stopped is not an answer');
  const removed = waitFacts([], since + 9 * MIN, first.open);
  assert.equal(removed.facts[0].answered, false, 'nor is an agent removed while it waited');
  const late = Date.parse('2026-11-10T23:50:00Z');
  const overnight = waitFacts([{ handle: 'd', state: 'working', since: late + 40 * MIN }], late + 40 * MIN, new Map([['d', late]]));
  assert.deepEqual(overnight.facts.map((e) => [e.day, e.minutes]), [['2026-11-10', 40]], 'a wait that runs past midnight belongs to the day it began');
});

const wait = (day, n, minutes, answered = true) => ({ kind: 'event', what: 'wait', key: `wait:${day}:${n}`, day, at: `${day}T15:00:00Z`, minutes, answered });

test('quick answers fill the quick quest, and a day when agents asked and none got angry unlocks Calm office', () => {
  const start = { kind: 'start', key: 'start', at: '2026-11-01T00:00:00Z' };
  const yesterday = '2026-11-10';
  const calm = [1, 2, 3, 12, 30].map((m, i) => wait(yesterday, i, m));
  const stats = (entries) => statsOf(replay([start, ...entries]), TODAY);
  assert.equal(stats(calm).calmDays, 1);
  assert.equal(stats(calm.slice(1)).calmDays, 0, 'four asks are not enough to call a day calm');
  assert.equal(stats([...calm, wait(yesterday, 9, MOOD_MINUTES.angry)]).calmDays, 0, 'one wait answered late made it angry');
  assert.equal(stats([...calm, { kind: 'event', what: 'angry', key: `angry:${yesterday}`, day: yesterday, at: '2026-11-10T18:00:00Z' }]).calmDays, 0, 'so did one still waiting past angry');
  assert.equal(stats(calm.map((e) => ({ ...e, day: TODAY }))).calmDays, 0, 'today is not over yet');
  const quests = { kind: 'quests', key: `quests:${TODAY}`, day: TODAY, at: '2026-11-11T00:00:00Z', quests: [{ id: 'quick', target: 3, label: 'Answer 3 agents while they still wave' }] };
  const slow = [wait(TODAY, 1, 1), wait(TODAY, 2, MOOD_MINUTES.impatient), wait(TODAY, 3, 2, false), wait(TODAY, 4, 4.9)];
  const nearly = replay([start, quests, ...calm, ...slow]);
  assert.deepEqual(questProgress(nearly, TODAY).map((q) => [q.id, q.have, q.done]), [['quick', 2, false]], 'only answered, and only before impatient');
  assert.ok(!followUps(nearly, NOW).some((e) => e.source === 'quest'));
  const today = [...slow, wait(TODAY, 5, 0.5)];
  const s = replay([start, quests, ...calm, ...today]);
  assert.deepEqual(followUps(s, NOW).map((e) => e.key), ['quest:2026-11-11:quick']);
  const later = replay([start, quests, ...calm, ...today, ...followUps(s, NOW)]);
  assert.ok(followUps(later, NOW).some((e) => e.key === 'achievement:calm-day'));
  assert.ok(!followUps(replay([start, quests, ...calm.slice(1), ...today]), NOW).some((e) => e.key === 'achievement:calm-day'));
  assert.ok(QUESTS.some((q) => q.metric === 'quick') && ACHIEVEMENTS.some((a) => a.id === 'calm-day'));
});
