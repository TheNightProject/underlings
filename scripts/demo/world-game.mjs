const DAY = 86_400_000;
const ZONE = 'Europe/London';
const SOURCES = [['merged', 'Merged'], ['review', 'Reviewed'], ['finding', 'Posted a finding on'], ['approval', 'Approved'], ['agent', 'An agent finished on'], ['qa', 'Moved to QA:']];
const TARGETS = ['acme/web!18', 'acme/engine!5', 'acme/api!38', 'acme/web!21', 'acme/engine!7', 'acme/tools/cli!3', 'ABC-106', 'ABC-110', 'acme/api!41', 'acme/web!30'];

const OWNED = [
  'skin-mint', 'hat-party', 'hat-headphones', 'held-mug', 'held-chicken', 'pet-cat', 'pet-dog',
  'office-neon', 'office-beanbags', 'office-fridge', 'office-fishtank', 'office-trophy', 'office-console', 'office-arcade',
];
const WORN = [['player', 'hat', 'hat-headphones'], ['player', 'held', 'held-mug'], ['player', 'pet', 'pet-cat'], ['kind:review', 'hat', 'hat-party'], ['kind:fix', 'held', 'held-chicken'], ['manager', 'skin', 'skin-mint']];

const day = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(ms);

export function demoLedger(now = Date.now(), { xp = 53_800, coins = 6_700 } = {}) {
  const rewards = 36;
  const entries = [{ kind: 'start', key: 'start', at: new Date(now - 30 * DAY).toISOString(), days: 30 }];
  for (let n = 0; n < rewards; n += 1) {
    const at = now - (30 - n * 0.8) * DAY;
    const [source, words] = SOURCES[n % SOURCES.length];
    const share = n === rewards - 1 ? 1 : 0;
    entries.push({
      kind: 'reward', source, key: `demo:${n}`, at: new Date(at).toISOString(), day: day(at), label: `${words} ${TARGETS[n % TARGETS.length]}`,
      xp: share ? xp - Math.floor(xp / rewards) * (rewards - 1) : Math.floor(xp / rewards), coins: share ? coins - Math.floor(coins / rewards) * (rewards - 1) : Math.floor(coins / rewards),
    });
  }
  OWNED.forEach((item, n) => entries.push({ kind: 'buy', key: `buy:${item}`, item, at: new Date(now - (20 - n) * DAY / 2).toISOString() }));
  OWNED.filter((item) => item.startsWith('office-')).forEach((item, n) => entries.push({ kind: 'equip', key: `equip:office:${n}`, wearer: 'office', slot: item, item, at: new Date(now - (9 - n) * DAY / 2).toISOString() }));
  WORN.forEach(([wearer, slot, item], n) => entries.push({ kind: 'equip', key: `equip:worn:${n}`, wearer, slot, item, at: new Date(now - (6 - n) * DAY / 2).toISOString() }));
  return entries;
}
