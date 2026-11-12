import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAgentsMove } from './claudeagents.mjs';
import { afterFetch, engine, failure, inbox, jiraSettings, supports } from './engine.mjs';
import { ownSwitch } from './features.mjs';
import { appendLedger, buyRefusal, equipRefusal, progressOf, readLedger, removeLedger, replay, statsOf } from './game-ledger.mjs';
import { ACHIEVEMENTS, addDays, BACKFILL_DAYS, BANDS, CATALOGUE, ITEMS, levelFor, OFFICE, RALLY_MAX, REWARDS, ROOM, SLOTS, TOKEN_RATE, tokenReward, WEARERS } from './game-rules.mjs';
import { addTokenDays, agentRewards, agentTokens, findingRewards, followUps, queuePosts, questProgress, tokenRewards, waitFacts, workRewards } from './game-sources.mjs';
import { countTokens, freshCache, tokenDays } from './game-tokens.mjs';
import { dayOf, zone } from './locale.mjs';
import * as notifier from './notifier.mjs';
import { loadSettings as qaSettings } from './qa.mjs';
import { configDir, stateDir as defaultStateDir } from './home.mjs';

const MINUTE = 60_000;
const LOCAL_EVERY_MS = MINUTE;
const LOCAL_GAP_MS = 5_000;
const REMOTE_EVERY_MS = 15 * MINUTE;
const JIRA_BACKOFF_MS = 120 * MINUTE;
const CACHE_EVERY_MS = 10 * MINUTE;
const BRIEFS_KEPT = 3000;
const FOLLOW_UP_ROUNDS = 8;
const RECENT = 40;
const RESET_WORDS = 'start again';
const SETTINGS = { on: true, toasts: true, tokenRate: TOKEN_RATE.initial };

let config = {};
let shell = {};
let settings = null;
let entries = [];
let s = replay([]);
let cache = null;
let cacheSavedAt = 0;
let timers = [];
let unsubscribe = [];
let chain = Promise.resolve();
let localAt = 0;
let needsSeen = { day: null, some: false };
let waiting = new Map();
const status = { gitlab: null, jira: null, backfilling: false, readAt: null };

export const ACTIONS = {};

export const ROUTES = {
  'GET /api/game': () => fullView(),
  'POST /api/game/buy': async ({ body }) => buy(await body()),
  'POST /api/game/equip': async ({ body }) => equip(await body()),
  'POST /api/game/settings': async ({ body }) => saveSettings(await body()),
  'POST /api/game/reset': async ({ body }) => reset(await body()),
  'POST /api/game/rally': async ({ body }) => rally(await body()),
};

ownSwitch('game', { on: async () => (await loadSettings()).on, set: (on) => saveSettings({ on }) });

const stateDir = () => config.stateDir ?? defaultStateDir();
const ledgerFile = () => join(stateDir(), 'game.jsonl');
const cacheFile = () => join(stateDir(), 'game-cache.json');
const settingsFile = () => join(configDir(), 'game.json');
const iso = (ms) => new Date(ms).toISOString();
const later = (a, b) => (a > b ? a : b);

function transcriptRoots() {
  const set = config.claudeProjects;
  if (set) return [set].flat().filter((p) => typeof p === 'string');
  return [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')];
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 });
  await chmod(path + '.tmp', 0o600);
  await rename(path + '.tmp', path);
}

export async function start(cfg, sh) {
  config = cfg ?? {};
  shell = sh ?? {};
  settings = await loadSettings();
  cache = await loadCache();
  await reloadLedger();
  if (settings.on) begin();
}

// Returned so a deactivate waits for the last save, which Orca would otherwise cut off by exiting the worker.
export function stop() {
  halt();
  if (cache) return background(() => saveCache(true));
}

export function settled() {
  return chain;
}

function begin() {
  halt();
  const every = (fn, ms) => {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    timers.push(timer);
  };
  every(() => syncLocal(), LOCAL_EVERY_MS);
  every(() => syncRemote(), REMOTE_EVERY_MS);
  const nudge = () => (Date.now() - localAt >= LOCAL_GAP_MS ? syncLocal() : chain);
  unsubscribe = [afterFetch(nudge), afterAgentsMove(nudge)];
  if (s.start) {
    syncLocal();
    syncRemote();
  } else {
    background(backfill);
  }
}

function halt() {
  for (const timer of timers) clearInterval(timer);
  timers = [];
  for (const off of unsubscribe) off?.();
  unsubscribe = [];
}

// One sync or write at a time, so two never read the ledger at once and both append the same reward.
function queue(job) {
  const done = chain.then(job);
  chain = done.catch(() => {});
  return done;
}

function background(job) {
  return queue(job).catch((err) => shell.log?.(`game: ${err.message}`));
}

async function loadSettings() {
  const saved = await readJson(settingsFile(), {});
  const rate = Number(saved.tokenRate);
  return {
    on: typeof saved.on === 'boolean' ? saved.on : SETTINGS.on,
    toasts: typeof saved.toasts === 'boolean' ? saved.toasts : SETTINGS.toasts,
    tokenRate: Number.isFinite(rate) && rate >= TOKEN_RATE.min && rate <= TOKEN_RATE.max ? rate : SETTINGS.tokenRate,
  };
}

async function loadCache() {
  const saved = await readJson(cacheFile(), null);
  if (saved?.v !== 1) return { v: 1, tokens: freshCache(), briefs: {}, gitlabDay: null, jiraDay: null, jiraFailedAt: 0 };
  return { ...saved, tokens: saved.tokens?.v === 1 ? saved.tokens : freshCache(), briefs: saved.briefs ?? {} };
}

async function saveCache(now = false) {
  if (!now && Date.now() - cacheSavedAt < CACHE_EVERY_MS) return;
  cacheSavedAt = Date.now();
  await writePrivate(cacheFile(), cache);
}

// Another worker on the same state folder may have written since, so the file is read afresh before every change.
async function reloadLedger() {
  entries = await readLedger(ledgerFile());
  s = replay(entries);
}

function stamp(entry, now) {
  const historic = entry.kind === 'reward' && entry.day < addDays(dayOf(now), -1);
  return historic || status.backfilling ? { ...entry, back: true } : entry;
}

function unpaid(candidates, now) {
  const keys = new Set(s.keys);
  const fresh = [];
  for (const c of candidates) {
    if (keys.has(c.key)) continue;
    keys.add(c.key);
    fresh.push(stamp(c, now));
  }
  return fresh;
}

// A reward can complete a quest, and a quest or an achievement can unlock another, so this runs until nothing more follows.
function withFollowUps(fresh, now) {
  let next = replay([...entries, ...fresh]);
  for (let round = 0; round < FOLLOW_UP_ROUNDS; round += 1) {
    const more = followUps(next, now, { drawToday: Boolean(next.start) }).filter((e) => !next.keys.has(e.key)).map((e) => stamp(e, now));
    if (!more.length) break;
    fresh = [...fresh, ...more];
    next = replay([...entries, ...fresh]);
  }
  return { fresh, next };
}

async function commit(candidates, now = Date.now()) {
  await reloadLedger();
  const { fresh, next } = withFollowUps(unpaid(candidates, now), now);
  if (!fresh.length) return [];
  await appendLedger(ledgerFile(), fresh);
  entries = [...entries, ...fresh];
  s = next;
  shell.notify?.('game');
  return fresh;
}

const since = (now) => addDays(dayOf(now), -(BACKFILL_DAYS - 1));
const inWindow = (now) => (e) => e.day >= since(now);

function queueItems() {
  if (!engine?.loadQueue) return [];
  return [...engine.loadQueue(), ...(engine.loadArchive?.({ limit: Number.MAX_SAFE_INTEGER }).items ?? [])];
}

const agentList = () => (supports('claudeAgents') ? engine.claudeAgents() : []);

async function localFacts(now) {
  const counted = await countTokens({ roots: transcriptRoots(), cache: cache.tokens, since: since(now), dayOf });
  cache.tokens = counted.cache;
  const agents = agentList();
  const days = addTokenDays(tokenDays(counted.cache), agentTokens(agents, counted.sessions));
  const waits = waitFacts(agents, now, waiting);
  waiting = waits.open;
  return [...tokenRewards(days, settings.tokenRate, now), ...findingRewards(queueItems()), ...agentRewards(agents), ...waits.facts].filter(inWindow(now));
}

async function gitlabFacts(now) {
  const floor = since(now);
  try {
    const work = await engine.readGitlabWork(later(cache.gitlabDay ?? floor, floor), dayOf(now), cache.briefs, zone());
    cache.briefs = Object.fromEntries(Object.entries(work.briefs).slice(-BRIEFS_KEPT));
    cache.gitlabDay = dayOf(now);
    status.gitlab = null;
    return workRewards({ ...work, moves: [] }, queuePosts(queueItems()));
  } catch (err) {
    status.gitlab = err.message;
    return [];
  }
}

// The QA board's status and the first finished one, so a workflow with other names still earns for the same two moves.
export async function moveStatuses() {
  const done = jiraSettings().doneStatuses.split(',').map((s) => s.trim()).find(Boolean) ?? 'Done';
  return { qa: (await qaSettings()).status, done };
}

async function jiraFacts(now) {
  if (now - (cache.jiraFailedAt ?? 0) < JIRA_BACKOFF_MS) return [];
  const floor = since(now);
  try {
    const statuses = await moveStatuses();
    const moves = await engine.readTicketMoves(later(cache.jiraDay ?? floor, floor), dayOf(now), Object.values(statuses));
    cache.jiraDay = dayOf(now);
    status.jira = null;
    return workRewards({ merged: [], reviews: [], moves }, {}, statuses);
  } catch (err) {
    status.jira = err.message;
    cache.jiraFailedAt = now;
    return [];
  }
}

async function remoteFacts(now) {
  if (!supports('readGitlabWork') || !supports('readTicketMoves')) {
    status.gitlab = status.jira = 'the review engine needs rebuilding before the game can read GitLab and Jira';
    return [];
  }
  const found = [...(await gitlabFacts(now)), ...(await jiraFacts(now))];
  status.readAt = iso(now);
  return found.filter(inWindow(now));
}

// Needs you is only ever read now, so clearing it is noticed as it happens: some cards earlier in the day, then none.
export function needsFacts(now, needs = notifier.view(now)) {
  if (!needs.builtAt) return [];
  const day = dayOf(now);
  if (needsSeen.day !== day) needsSeen = { day, some: false };
  if (needs.count > 0) needsSeen.some = true;
  return needsSeen.some && needs.count === 0 ? [{ kind: 'event', what: 'needs', key: `needs:${day}`, day, at: iso(now) }] : [];
}

async function backfill() {
  const now = Date.now();
  status.backfilling = true;
  try {
    const [local, remote] = await Promise.all([localFacts(now), remoteFacts(now)]);
    await commit([...local, ...remote, { kind: 'start', key: 'start', at: iso(now), days: BACKFILL_DAYS }], now);
  } finally {
    status.backfilling = false;
    await saveCache(true);
  }
}

export function syncLocal() {
  if (!settings?.on) return chain;
  localAt = Date.now();
  return background(async () => {
    if (!s.start) return;
    const now = Date.now();
    await commit([...(await localFacts(now)), ...needsFacts(now)], now);
    await saveCache();
  });
}

export function syncRemote() {
  if (!settings?.on) return chain;
  return background(async () => {
    if (!s.start) return;
    const now = Date.now();
    await commit(await remoteFacts(now), now);
    await saveCache();
  });
}

function itemWord(id) {
  const item = ITEMS.get(id);
  if (!item) return id;
  return item.name.toLowerCase() + (item.slot === 'skin' ? ' skin' : '');
}

function bought(item, now) {
  const entry = { kind: 'buy', key: `buy:${item.id}`, item: item.id, at: iso(now), coins: -item.price };
  if (item.slot === ROOM) return { entries: [entry], text: `Built the ${itemWord(item.id)} for ${item.price} coins` };
  const office = item.slot === OFFICE;
  const wear = office ? { wearer: OFFICE, slot: item.id } : { wearer: 'player', slot: item.slot };
  return { entries: [entry, equipEntry({ ...wear, item: item.id }, now)], text: `Bought the ${itemWord(item.id)} for ${item.price} coins ${office ? 'and put it in the office' : 'and put it on'}` };
}

function buy(body) {
  const id = typeof body?.item === 'string' ? body.item : '';
  return run(async () => {
    const refused = buyRefusal(s, id);
    if (refused) throw failure(ITEMS.has(id) ? 409 : 400, refused.charAt(0).toUpperCase() + refused.slice(1));
    const now = Date.now();
    const { entries: made, text } = bought(ITEMS.get(id), now);
    await commit(made, now);
    return { ok: true, text, game: fullView() };
  });
}

function equipEntry({ wearer, slot, item }, now) {
  return { kind: 'equip', key: `equip:${now}:${Math.random().toString(36).slice(2, 10)}`, wearer, slot, item: item ?? null, at: iso(now) };
}

function equip(body) {
  const asked = { wearer: body?.wearer, slot: body?.slot, item: body?.item ?? null };
  return run(async () => {
    const refused = equipRefusal(s, asked);
    if (refused) throw failure(409, refused.charAt(0).toUpperCase() + refused.slice(1));
    const now = Date.now();
    await commit([equipEntry(asked, now)], now);
    const who = WEARERS.find(([id]) => id === asked.wearer)?.[1] ?? 'The office';
    const text = asked.wearer === OFFICE ? `${asked.item ? 'Put the' : 'Put away the'} ${itemWord(asked.slot)}` : asked.item ? `${who}: ${itemWord(asked.item)} on` : `${who}: nothing in the ${asked.slot} slot`;
    return { ok: true, text, game: fullView() };
  });
}

// The page only ever reports the longest rally it saw, and the badge it can unlock pays nothing.
function rally(body) {
  const hits = Number(body?.hits);
  if (!Number.isInteger(hits) || hits < 1 || hits > RALLY_MAX) throw failure(400, `a rally is a whole number of hits from 1 to ${RALLY_MAX}`);
  return run(async () => {
    if (hits <= s.rallyBest) return { ok: true, best: s.rallyBest };
    const now = Date.now();
    const day = dayOf(now);
    await commit([{ kind: 'event', what: 'rally', key: `rally:${hits}`, value: hits, day, at: iso(now) }], now);
    return { ok: true, best: s.rallyBest };
  });
}

function run(job) {
  if (!settings?.on) throw failure(409, 'The game is off. Turn it on in Settings, Game.');
  if (!s.start) throw failure(409, `The game is still counting your last ${BACKFILL_DAYS} days.`);
  return queue(async () => {
    await reloadLedger();
    return job();
  });
}

function refuse(why) {
  throw failure(400, why);
}

const SETTING_RULES = {
  on: { take: (v) => (typeof v === 'boolean' ? v : refuse('on is true or false')), say: (v) => (v ? 'The game is on' : 'The game is off') },
  toasts: { take: (v) => (typeof v === 'boolean' ? v : refuse('toasts is true or false')), say: (v) => (v ? 'Reward toasts are on' : 'Reward toasts are off') },
  tokenRate: {
    take: (v) => {
      const rate = Number(v);
      const fits = Number.isFinite(rate) && rate >= TOKEN_RATE.min && rate <= TOKEN_RATE.max;
      return fits ? Math.round(rate) : refuse(`the token rate is ${TOKEN_RATE.min} to ${TOKEN_RATE.max} XP for each million tokens`);
    },
    say: (v) => `Each million tokens from now on pays ${v} XP and ${tokenReward(v).coins} coins`,
  },
};

function settingChanges(patch) {
  const changes = Object.keys(SETTING_RULES).filter((key) => patch?.[key] !== undefined).map((key) => [key, SETTING_RULES[key].take(patch[key])]);
  return changes.length ? changes : refuse('the game settings are on, toasts and tokenRate');
}

async function saveSettings(patch) {
  const changes = settingChanges(patch);
  const next = { ...settings, ...Object.fromEntries(changes) };
  const turnedOn = next.on && !settings.on;
  await writePrivate(settingsFile(), next);
  settings = next;
  if (turnedOn) begin();
  if (!next.on) halt();
  shell.notify?.('game');
  return { ok: true, text: changes.map(([key, value]) => SETTING_RULES[key].say(value)).join('. '), settings };
}

async function reset(body) {
  if (body?.confirm !== RESET_WORDS) throw failure(400, `a reset is confirmed with { "confirm": "${RESET_WORDS}" }`);
  await queue(async () => {
    await removeLedger(ledgerFile());
    entries = [];
    s = replay([]);
    Object.assign(cache, { gitlabDay: null, jiraDay: null, jiraFailedAt: 0 });
  });
  shell.notify?.('game');
  if (settings.on) background(backfill);
  return { ok: true, text: `Cleared your level, XP, coins, streak, quests, achievements and everything bought and worn. Counting your last ${BACKFILL_DAYS} days of work again.` };
}

function nameOf(me) {
  const first = String(me ?? '').split(/[._-]/)[0];
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'You';
}

function entryView(e, seq) {
  return { seq, kind: e.kind, source: e.source ?? null, key: e.key, label: e.label ?? null, xp: e.xp ?? 0, coins: e.coins ?? 0, at: e.at, back: Boolean(e.back), item: e.item ?? null };
}

export function view(now = Date.now()) {
  if (!settings) return null;
  if (!settings.on) return { on: false, toasts: settings.toasts };
  const today = dayOf(now);
  const stats = statsOf(s, today);
  const first = Math.max(0, s.accepted.length - RECENT);
  return {
    on: true, toasts: settings.toasts, started: Boolean(s.start), epoch: s.start, backfilling: status.backfilling, me: nameOf(inbox?.me),
    ...progressOf(s.xp), coins: s.coins, streak: stats.streak, quests: s.start ? questProgress(s, today) : [],
    equipped: s.equipped, rooms: CATALOGUE.filter((i) => i.slot === ROOM && s.owned.has(i.id)).map((i) => i.id), trophies: ACHIEVEMENTS.filter((a) => s.unlocked[a.id]).map((a) => ({ id: a.id, secret: Boolean(a.secret) })),
    seq: s.accepted.length, earned: s.earned, recent: s.accepted.slice(first).map((e, i) => entryView(e, first + i + 1)),
  };
}

function buildFirst(item) {
  if (!item.needs || item.needs.some((id) => s.owned.has(id))) return null;
  return item.needs.map((id) => ITEMS.get(id).name);
}

function achievementView(a) {
  const at = s.unlocked[a.id] ?? null;
  if (a.secret && !at) return { id: a.id, name: '???', blurb: 'A secret achievement.', secret: true, at: null, badge: false };
  return { id: a.id, name: a.name, blurb: a.blurb, secret: Boolean(a.secret), at, badge: Boolean(a.badge) };
}

function rewardTable() {
  const rate = tokenReward(settings.tokenRate);
  return Object.entries(REWARDS).map(([source, r]) => ({ source, what: r.what, ...(source === 'tokens' ? rate : { xp: r.xp, coins: r.coins }) }));
}

function exactTokens(now) {
  const days = tokenDays(cache?.tokens ?? freshCache());
  return { today: days[dayOf(now)] ?? 0, window: Object.values(days).reduce((a, b) => a + b, 0) };
}

export function fullView(now = Date.now()) {
  const base = view(now);
  if (!base?.on) return { ...base, settings };
  const level = levelFor(s.xp);
  return {
    ...base,
    settings,
    status: { ...status },
    stats: { ...statsOf(s, dayOf(now)), exactTokens: exactTokens(now) },
    catalogue: CATALOGUE.map((i) => ({ ...i, owned: s.owned.has(i.id), locked: level < i.level, short: s.coins < i.price, buildFirst: buildFirst(i) })),
    wearers: WEARERS.map(([id, label]) => ({ id, label })),
    slots: SLOTS,
    achievements: ACHIEVEMENTS.map(achievementView),
    rewards: rewardTable(),
    bands: BANDS.map(([from, title]) => ({ from, title })),
    tokenRate: { ...TOKEN_RATE, value: settings.tokenRate },
  };
}
