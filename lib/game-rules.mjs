export { addDays } from './clock.mjs';

export const BACKFILL_DAYS = 30;
export const TOKENS_PER_BLOCK = 1_000_000;
export const TOKEN_RATE = { initial: 40, min: 0, max: 400 };
export const RALLY_MAX = 500;

export const REWARDS = {
  merged: { xp: 120, coins: 12, what: 'Your MR merged' },
  review: { xp: 40, coins: 4, what: "A review of someone else's MR: you commented on it or approved it, once per MR per day" },
  comment: { xp: 8, coins: 1, cap: 10, what: 'Each comment in that review, up to 10 per MR per day, less the findings and replies the review queue posted there' },
  approval: { xp: 30, coins: 3, what: "Approving someone else's MR, once per MR" },
  finding: { xp: 15, coins: 2, what: 'A finding the review queue posted, by you or by full auto' },
  qa: { xp: 60, coins: 6, what: 'A ticket you moved to QA, once per ticket' },
  done: { xp: 40, coins: 4, what: 'A ticket you moved to Done, once per ticket' },
  agent: { xp: 10, coins: 1, what: 'An agent finishing its first turn without an error, once per agent' },
  quest: { xp: 100, coins: 15, what: 'A daily quest completed' },
  achievement: { xp: 250, coins: 30, what: 'An achievement unlocked' },
  tokens: { xp: TOKEN_RATE.initial, coins: TOKEN_RATE.initial / 10, what: 'Each million input and output tokens Claude Code spent in a day, cache reads left out' },
};

export const WORK_SOURCES = new Set(['merged', 'review', 'comment', 'approval', 'finding', 'qa', 'done', 'agent', 'tokens']);

export function tokenReward(rate) {
  const xp = Math.round(rate);
  return { xp, coins: Math.round(xp / 10) };
}

const LEVEL_BASE = 400;
const LEVEL_POWER = 1.75;
export const BANDS = [[1, 'Intern'], [5, 'Junior'], [10, 'Senior'], [20, 'Staff'], [30, 'Principal'], [45, 'Legend']];

export const xpForLevel = (level) => (level <= 1 ? 0 : Math.round(LEVEL_BASE * (level - 1) ** LEVEL_POWER));

export function levelFor(xp) {
  let level = 1;
  while (xpForLevel(level + 1) <= xp) level += 1;
  return level;
}

export const titleFor = (level) => BANDS.filter(([from]) => level >= from).at(-1)[1];

export const SLOTS = ['skin', 'hat', 'held', 'pet'];
export const WEARERS = [
  ['player', 'You'], ['manager', 'The manager'], ['kind:review', 'Review agents'], ['kind:fix', 'Fix agents'],
  ['kind:kickoff', 'Kickoff agents'], ['kind:ticket', 'Ticket agents'], ['kind:message', 'Message agents'],
];
export const OFFICE = 'office';
export const ROOM = 'room';

const item = (id, slot, name, level, price, blurb, extra = {}) => ({ id, slot, name, level, price, blurb, ...extra });
export const CATALOGUE = [
  item('skin-mint', 'skin', 'Mint', 1, 60, 'A cool mint body.'),
  item('skin-sunset', 'skin', 'Sunset', 1, 90, 'Warm orange with a pink head.'),
  item('skin-stripes', 'skin', 'Stripes', 5, 220, 'Bands round the body and limbs.'),
  item('skin-polka', 'skin', 'Polka dots', 8, 320, 'Spots all over.'),
  item('skin-chrome', 'skin', 'Chrome', 15, 900, 'Polished metal that catches the light.'),
  item('skin-glow', 'skin', 'Neon glow', 25, 1800, 'Lit from inside, with a glow on the floor.'),
  item('hat-party', 'hat', 'Party hat', 1, 80, 'A striped cone with a pompom.'),
  item('hat-headphones', 'hat', 'Headphones', 3, 160, 'For deep work.'),
  item('hat-wizard', 'hat', 'Wizard hat', 6, 300, 'Tall, starred and slightly bent.'),
  item('hat-viking', 'hat', 'Viking helmet', 12, 650, 'Horns included.'),
  item('hat-crown', 'hat', 'Crown', 30, 2600, 'Gold, with gems.'),
  item('held-mug', 'held', 'Coffee mug', 1, 50, 'Never empty.'),
  item('held-chicken', 'held', 'Rubber chicken', 4, 180, 'Held by the feet.'),
  item('held-wrench', 'held', 'Wrench', 7, 280, 'For fix agents, or anyone.'),
  item('held-sword', 'held', 'Foam sword', 10, 450, 'Soft but serious.'),
  item('held-saber', 'held', 'Lightsaber', 20, 1500, 'A glowing blade.'),
  item('pet-cat', 'pet', 'Cat', 5, 400, 'Follows you about, tail up.'),
  item('pet-dog', 'pet', 'Dog', 10, 750, 'Never far behind.'),
  item('pet-drone', 'pet', 'Robot drone', 22, 1700, 'Hovers at your shoulder.'),
  item('office-neon', OFFICE, 'Neon sign', 2, 140, 'A glowing </> on the wall by the door.'),
  item('office-beanbags', OFFICE, 'Bean bags', 4, 200, 'Two squashy bean bags by the door, for an idle agent to sink into.'),
  item('office-fridge', OFFICE, 'Mini fridge', 6, 260, 'By the whiteboard.'),
  item('office-fishtank', OFFICE, 'Fish tank', 8, 360, 'Fish, weed and bubbles by the door. Idle agents stop to watch.'),
  item('office-trophy', OFFICE, 'Trophy shelf', 9, 420, 'A trophy for each achievement you have.'),
  item('office-console', OFFICE, 'Games console', 12, 800, 'A TV and a console. Two idle agents sit and play together.'),
  item('office-arcade', OFFICE, 'Arcade machine', 16, 1100, 'An idle agent plays it, and wins now and then.'),
  item('office-foosball', OFFICE, 'Foosball table', 18, 1500, 'Two idle agents play, ball and all.'),
  item('office-vr', OFFICE, 'VR station', 21, 2000, 'A headset and a glowing ring, where an idle agent waves at things only it can see.'),
  item('office-disco', OFFICE, 'Disco ball', 35, 3000, 'Over the lounge, throwing colour on the floor.'),
  item('room-kitchen', ROOM, 'Kitchen', 18, 6000, 'A counter, coffee machine, fridge, microwave and a table for lunch. The coffee run moves here.'),
  item('room-games', ROOM, 'Games room', 20, 7500, 'A room for the games machines, which move in from the lounge.'),
  item('room-terrace', ROOM, 'Roof terrace', 22, 9000, 'Decking, deck chairs, a parasol and string lights, off the games room or the extension.', { needs: ['room-games', 'room-extension'] }),
  item('room-extension', ROOM, 'Extension', 24, 12000, "Twelve more pods past the manager's desk, so a busy day never runs out of desks."),
];
export const ITEMS = new Map(CATALOGUE.map((i) => [i.id, i]));

const achievement = (id, name, blurb, test, extra = {}) => ({ id, name, blurb, test, ...extra });
export const ACHIEVEMENTS = [
  achievement('first-merge', 'First merge', 'One of your MRs merged.', (s) => s.merged >= 1),
  achievement('merges-25', 'Shipper', '25 of your MRs merged.', (s) => s.merged >= 25),
  achievement('first-review', 'Second pair of eyes', "You reviewed someone else's MR.", (s) => s.review >= 1),
  achievement('reviews-100', 'Centurion', '100 reviews of other people\'s MRs.', (s) => s.review >= 100),
  achievement('approvals-25', 'Seal of approval', '25 approvals.', (s) => s.approval >= 25),
  achievement('findings-50', 'Bug hunter', '50 findings posted.', (s) => s.finding >= 50),
  achievement('tickets-10', 'Conveyor belt', '10 tickets moved to QA or Done.', (s) => s.qa + s.done >= 10),
  achievement('agents-100', 'Agent wrangler', '100 agents finished.', (s) => s.agent >= 100),
  achievement('tokens-day', 'A million in a day', 'A million tokens spent in one day.', (s) => s.bestTokenDay >= 1),
  achievement('streak-7', 'On a roll', 'A 7-day streak.', (s) => s.bestStreak >= 7),
  achievement('rally-20', 'Table tennis ace', 'A rally of 20 hits in the office.', (s) => s.rallyBest >= 20, { badge: true }),
  achievement('quests-all', 'Hat trick', 'All three quests done in one day.', (s) => s.questSweeps >= 1),
  achievement('level-10', 'Senior', 'Reached level 10.', (s) => s.level >= 10),
  achievement('streak-30', 'Unstoppable', 'A 30-day streak.', (s) => s.bestStreak >= 30, { secret: true }),
  achievement('tokens-billion', 'Furnace', 'A billion tokens spent.', (s) => s.tokens >= 1000, { secret: true }),
  achievement('night-owl', 'Night owl', 'Merged or reviewed between 10 at night and 5 in the morning.', (s) => s.nightOwl >= 1, { secret: true }),
  achievement('dressed', 'Dressed to impress', 'A hat, something to hold and a pet, all on one wearer.', (s) => s.fullOutfit, { secret: true }),
  achievement('calm-day', 'Calm office', 'A day when agents asked you at least five times and none of them got angry.', (s) => s.calmDays >= 1),
];

export const QUESTS = [
  { id: 'review', metric: 'review', core: true, target: [3, 2, 5], label: (n) => `Review ${n} MRs` },
  { id: 'merge', metric: 'merged', core: true, target: [1, 1, 1], label: () => 'Merge an MR' },
  { id: 'needs', metric: 'needs', core: true, target: [1, 1, 1], label: () => 'Clear Needs you' },
  { id: 'qa', metric: 'qa', core: true, target: [1, 1, 1], label: () => 'Move a ticket to QA' },
  { id: 'findings', metric: 'finding', target: [3, 2, 10], label: (n) => `Post ${n} findings` },
  { id: 'agents', metric: 'agent', target: [5, 2, 15], label: (n) => `Finish ${n} agent runs` },
  { id: 'tokens', metric: 'tokens', target: [5, 1, 30], label: (n) => `Spend ${n} million tokens` },
  { id: 'quick', metric: 'quick', target: [3, 1, 8], label: (n) => (n === 1 ? 'Answer an agent while it still waves' : `Answer ${n} agents while they still wave`) },
];
export const QUESTS_A_DAY = 3;
