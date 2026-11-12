import { appendFile, chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { addDays, ITEMS, levelFor, OFFICE, SLOTS, titleFor, WEARERS, WORK_SOURCES, xpForLevel } from './game-rules.mjs';
import { hourOf, isWorkDay } from './locale.mjs';
import { MOOD_MINUTES } from './moods.mjs';

const WEARER_IDS = new Set(WEARERS.map(([id]) => id));
const late = (hour) => hour >= 22 || hour < 5;
const NIGHT_SOURCES = new Set(['merged', 'review', 'comment', 'approval']);
const CALM_ASKS = 5;

export async function readLedger(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const entry = JSON.parse(line);
      return entry && typeof entry.key === 'string' ? [entry] : [];
    } catch {
      return [];
    }
  });
}

export async function appendLedger(path, entries) {
  if (!entries.length) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, entries.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function removeLedger(path) {
  await rm(path, { force: true });
}

function blank() {
  return {
    keys: new Set(), accepted: [], xp: 0, coins: 0, owned: new Set(), equipped: { [OFFICE]: {} }, unlocked: {}, quests: {}, questDone: {}, needs: new Set(),
    earned: { xp: 0, coins: 0, rewards: 0, tokens: 0 }, days: new Map(), counts: Object.fromEntries([...WORK_SOURCES, 'quest', 'achievement'].map((s) => [s, 0])), rallyBest: 0, nightOwl: 0, bought: 0, start: null, rejected: 0,
    waits: {}, angry: new Set(),
  };
}

function dayOf(s, day) {
  if (!s.days.has(day)) s.days.set(day, Object.fromEntries([...WORK_SOURCES].map((x) => [x, 0])));
  return s.days.get(day);
}

const APPLY = {
  reward(s, e) {
    if (!Number.isFinite(e.xp) || !Number.isFinite(e.coins) || e.xp < 0 || e.coins < 0) return false;
    s.xp += e.xp;
    s.coins += e.coins;
    s.earned = { xp: s.earned.xp + e.xp, coins: s.earned.coins + e.coins, rewards: s.earned.rewards + 1, tokens: s.earned.tokens + (e.source === 'tokens' ? 1 : 0) };
    s.counts[e.source] = (s.counts[e.source] ?? 0) + 1;
    if (WORK_SOURCES.has(e.source)) dayOf(s, e.day)[e.source] += 1;
    if (NIGHT_SOURCES.has(e.source) && late(hourOf(Date.parse(e.at)))) s.nightOwl += 1;
    if (e.source === 'achievement') s.unlocked[e.key.slice('achievement:'.length)] = e.at;
    if (e.source === 'quest') (s.questDone[e.day] ??= new Set()).add(e.key.split(':')[2]);
    return true;
  },
  quests(s, e) {
    if (!Array.isArray(e.quests)) return false;
    s.quests[e.day] = e.quests;
    return true;
  },
  event(s, e) {
    if (e.what === 'needs') s.needs.add(e.day);
    else if (e.what === 'rally' && Number.isFinite(e.value)) s.rallyBest = Math.max(s.rallyBest, e.value);
    else if (e.what === 'wait' && Number.isFinite(e.minutes)) countWait(s, e);
    else if (e.what === 'angry') s.angry.add(e.day);
    else return false;
    return true;
  },
  buy(s, e) {
    if (buyRefusal(s, e.item)) return false;
    const { price } = ITEMS.get(e.item);
    s.coins -= price;
    s.owned.add(e.item);
    s.bought += 1;
    return true;
  },
  equip(s, e) {
    if (equipRefusal(s, e)) return false;
    (s.equipped[e.wearer] ??= {})[e.slot] = e.item ?? null;
    return true;
  },
  start(s, e) {
    s.start = e.at;
    return true;
  },
};

function countWait(s, e) {
  const day = (s.waits[e.day] ??= { asked: 0, quick: 0 });
  day.asked += 1;
  if (e.answered && e.minutes < MOOD_MINUTES.impatient) day.quick += 1;
  if (e.minutes >= MOOD_MINUTES.angry) s.angry.add(e.day);
}

const nameOf = (id) => ITEMS.get(id).name.toLowerCase();

export function buyRefusal(s, id) {
  const item = ITEMS.get(id);
  if (!item) return 'there is no such item';
  if (s.owned.has(id)) return `you already have the ${item.name.toLowerCase()}`;
  if (item.needs && !item.needs.some((need) => s.owned.has(need))) return `the ${item.name.toLowerCase()} opens off the ${item.needs.map(nameOf).join(' or the ')}, so build one of those first`;
  if (levelFor(s.xp) < item.level) return `the ${item.name.toLowerCase()} unlocks at level ${item.level}`;
  if (s.coins < item.price) return `the ${item.name.toLowerCase()} costs ${item.price} coins and you have ${s.coins}`;
  return null;
}

export function equipRefusal(s, { wearer, slot, item }) {
  if (wearer === OFFICE) {
    if (!ITEMS.get(slot) || ITEMS.get(slot).slot !== OFFICE) return 'that is not something for the office';
    if (item != null && item !== slot) return 'an office add-on goes in its own place';
  } else {
    if (!WEARER_IDS.has(wearer)) return 'there is nobody of that name to dress';
    if (!SLOTS.includes(slot)) return 'there is no such place to wear something';
    if (item != null && ITEMS.get(item)?.slot !== slot) return 'that does not go there';
  }
  if (item != null && !s.owned.has(item)) return 'buy it first';
  return null;
}

// Replayed in the order written: a key seen before is skipped, and a purchase the coins or level did not cover at its place in the list never happened.
export function replay(entries) {
  const s = blank();
  for (const e of entries) {
    if (!e?.key || s.keys.has(e.key) || !APPLY[e.kind]) continue;
    if (!APPLY[e.kind](s, e)) {
      s.rejected += 1;
      continue;
    }
    s.keys.add(e.key);
    s.accepted.push(e);
  }
  return s;
}

export function workedDays(s) {
  return new Set([...s.days].filter(([, c]) => Object.values(c).some(Boolean)).map(([day]) => day));
}

// A day off neither breaks a streak nor needs working, though a day worked on one still counts.
export function streakOf(worked, today) {
  if (!worked.size) return 0;
  const first = [...worked].sort()[0];
  let n = 0;
  for (let day = worked.has(today) ? today : addDays(today, -1); day >= first; day = addDays(day, -1)) {
    if (worked.has(day)) n += 1;
    else if (isWorkDay(day)) break;
  }
  return n;
}

export function bestStreak(worked) {
  const days = [...worked].sort();
  let best = 0;
  let run = 0;
  for (let day = days[0]; day && day <= days.at(-1); day = addDays(day, 1)) {
    if (worked.has(day)) best = Math.max(best, (run += 1));
    else if (isWorkDay(day)) run = 0;
  }
  return best;
}

function fullOutfit(equipped) {
  return Object.entries(equipped).some(([wearer, slots]) => wearer !== OFFICE && slots.hat && slots.held && slots.pet);
}

// A day still under way is not over yet, so only one before today can be a calm one.
function calmDays(s, today) {
  return Object.entries(s.waits).filter(([day, w]) => day < today && w.asked >= CALM_ASKS && !s.angry.has(day)).length;
}

export function statsOf(s, today) {
  const worked = workedDays(s);
  const tokenDays = [...s.days.values()].map((c) => c.tokens);
  const sweeps = Object.entries(s.quests).filter(([day, list]) => list.length && list.every((q) => s.questDone[day]?.has(q.id))).length;
  return {
    ...s.counts, bestTokenDay: Math.max(0, ...tokenDays), streak: streakOf(worked, today), bestStreak: bestStreak(worked),
    rallyBest: s.rallyBest, questSweeps: sweeps, level: levelFor(s.xp), nightOwl: s.nightOwl, fullOutfit: fullOutfit(s.equipped), bought: s.bought,
    calmDays: calmDays(s, today),
  };
}

export function progressOf(xp) {
  const level = levelFor(xp);
  return { level, title: titleFor(level), xp, levelAt: xpForLevel(level), nextAt: xpForLevel(level + 1) };
}
