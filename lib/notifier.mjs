import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import * as attention from './attention.mjs';
import { afterStep } from './autoloop.mjs';
import { afterAgentsMove, listAgents } from './claudeagents.mjs';
import { currentAgent } from './claudepanel.mjs';
import { afterAsk, TARGET as TERMINAL, terminalAsk } from './claudeterm.mjs';
import { wallClock } from './clock.mjs';
import { afterEmailChange } from './email.mjs';
import { afterFetch, BAD_KEY, engine, failure, forgeFor, forgeHas, GITLAB, inbox, MR_KEY, notify, supports, workspaceRoot } from './engine.mjs';
import { isWorkDay, zone } from './locale.mjs';
import { orca } from './orca.mjs';
import { afterSlackChange } from './slack.mjs';
import { keyOf, keyParts, shortKey } from './refs.mjs';
import { KEY_PATTERN } from './ticketkeys.mjs';
import { APP_NAME } from './product.mjs';
import { stateDir as defaultStateDir } from './home.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PER_KIND_MS = 30 * MINUTE;
const PER_HOUR = 6;
const DIGEST_AT = 3;
const GAP_MS = 15 * MINUTE;
const ACK_MS = 10_000;
const FOCUS_MS = 30_000;
const PRESENCE_MS = 60_000;
const PRUNE_MS = 7 * 24 * HOUR;
const ASK_AGAIN_MS = 5 * MINUTE;
const ENDS_PER_BUILD = 4;
const TITLE_CHARS = 60;
const DIGEST_LINES = 5;
const SHOWN_TOASTS = 20;
const HOW_TO_OPEN = `Cmd+J, ${APP_NAME}: Open what needs me`;
const VIEWS = new Set(['needs-you', 'overview', 'full-auto', 'settings', 'merge-requests', 'review-queue', 'watching', 'agents', 'claude', 'email', 'slack', 'calendar', TERMINAL]);
const TABS = new Set(['overview', 'findings', 'threads', 'agent', 'pipeline', 'files']);
const TICKET_TARGET = new RegExp(`^ticket:${KEY_PATTERN}$`);
const AGENT_TARGET = /^agent:[\w:.-]{1,200}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DEFAULT_PREFS = { enabled: true, quiet: false, quietFrom: '22:00', quietTo: '07:00', weekends: false, clickable: false };

let shell = {};
let config = {};
let ledger = null;
let loaded = null;
let built = { items: [], cards: [], facts: {} };
let builtAt = null;
let buildError = null;
let building = null;
let again = false;
let unhooks = [];
let driverTurns = 0;
const presences = new Map();
const sending = new Set();
const offers = new Map();
const toasts = [];

export const ACTIONS = {};

export const ROUTES = {
  'POST /api/attention/presence': async ({ body }) => presence(await body()),
  'POST /api/attention/later': async ({ body }) => later(await body()),
  'POST /api/attention/mute': async ({ body }) => mute(await body()),
  'POST /api/attention/prefs': async ({ body }) => setPrefs(await body()),
  'POST /api/attention/ack': async ({ body }) => ack(await body()),
  'POST /api/attention/test': async () => testBanner(),
};

export function stateDir(cfg = config) {
  return cfg.stateDir ?? defaultStateDir();
}

const ledgerPath = () => join(stateDir(), 'attention.json');
const bannerAppPath = () => join(stateDir(), 'banner-app.json');

export function freshLedger() {
  return { v: 1, items: {}, prints: {}, sent: [], lastByKind: {}, later: {}, muted: {}, last: {}, gone: {}, prefs: { ...DEFAULT_PREFS }, latest: null, ranAt: null, quietHeld: false, notReaching: null };
}

export async function start(cfg, sh) {
  config = cfg;
  shell = sh ?? {};
  loaded = loadLedger();
  ledger = await loaded;
  if (shell.desktop) await claimBanners().catch((err) => shell.log?.(`banners stay with the oldest worker, as the app could not claim them: ${err.message}`));
  unhooks = [afterFetch(() => rebuild()), afterStep(() => rebuild()), afterAgentsMove(() => rebuild()), afterEmailChange(() => rebuild()), afterSlackChange(() => rebuild()), afterAsk(() => rebuild().then(idle).then(() => notify('matrix')))];
}

export function stop() {
  for (const unhook of unhooks) unhook?.();
  unhooks = [];
  for (const offer of offers.values()) clearTimeout(offer.timer);
  offers.clear();
}

async function claimBanners() {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(bannerAppPath(), JSON.stringify({ pid: process.pid }));
}

async function bannerApp() {
  try {
    return JSON.parse(await readFile(bannerAppPath(), 'utf8')).pid;
  } catch {
    return null;
  }
}

async function loadLedger() {
  try {
    const read = JSON.parse(await readFile(ledgerPath(), 'utf8'));
    return { ...freshLedger(), ...read, prefs: { ...DEFAULT_PREFS, ...read.prefs } };
  } catch {
    return freshLedger();
  }
}

// Each save writes a temp file of its own and renames it, so neither a crash nor a second save at once leaves half a ledger.
async function saveLedger() {
  const path = ledgerPath();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(ledger), { mode: 0o600 });
  await rename(temp, path);
}

export async function idle() {
  while (building || sending.size) await (building ?? Promise.all(sending));
}

// One rebuild at a time; one asked for meanwhile runs once after it.
export function rebuild(now = Date.now()) {
  if (building) {
    again = true;
    return building;
  }
  building = buildOnce(now)
    .then(() => { buildError = null; })
    .catch((err) => {
      buildError = err.message;
      shell.log?.(`could not work out what needs you: ${err.message}`);
    })
    .finally(() => {
      building = null;
      if (again) {
        again = false;
        rebuild();
      }
    });
  return building;
}

async function buildOnce(now) {
  ledger ??= await (loaded ?? loadLedger());
  const input = attention.gather(now, listAgents(), { agent: currentAgent(), open: panelOpen(now), terminal: terminalAsk() });
  if (!input) return;
  driverTurns = ['stopped', 'terminal'].includes(input.driver?.state) ? driverTurns + 1 : 0;
  const openKeys = new Set(input.mrs.map(keyOf));
  const last = { ...goneFacts(ledger), ...ledger.last };
  trackGone(ledger, openKeys, now);
  await learnEnds(now);
  const next = attention.collect({ ...input, driverTurns, departed: Object.entries(ledger.gone).map(([key, g]) => ({ key, ...g })) }, last);
  // The first build always tells the page, since its intro waits on it even when nothing needs you.
  const before = builtAt ? JSON.stringify(viewCards(built.cards)) : null;
  built = next;
  builtAt = new Date(now).toISOString();
  const outcome = plan({ items: next.items, openKeys, ledger, now, focused: focusedPage(now), sender: await isSender(now) });
  ledger.last = next.facts;
  await deliver(outcome, now);
  await saveLedger();
  if (before !== JSON.stringify(viewCards(built.cards)) || outcome.toasts.length || outcome.banners.length) notify('matrix');
}

const goneFacts = (l) => Object.fromEntries(Object.entries(l.gone ?? {}).filter(([, g]) => g.facts).map(([key, g]) => [key, g.facts]));

// One failed batch drops its MRs from a poll, so a missing key is only gone, and forgotten after a week.
function trackGone(l, openKeys, now) {
  l.gone ??= {};
  for (const key of openKeys) delete l.gone[key];
  const known = [...Object.keys(l.last), ...Object.keys(l.prints), ...Object.keys(l.muted), ...Object.keys(l.later)];
  for (const key of known) if (!openKeys.has(key)) l.gone[key] ??= { at: now, facts: l.last[key] ?? null };
}

async function learnEnds(now) {
  if (!forgeHas(GITLAB, 'end')) return;
  const asking = Object.entries(ledger.gone)
    .filter(([key, g]) => !g.end && (g.facts?.autoMerge || ledger.muted[key]?.merged) && now - (g.askedAt ?? 0) >= ASK_AGAIN_MS)
    .slice(0, ENDS_PER_BUILD);
  await Promise.all(asking.map(async ([key, g]) => {
    g.askedAt = now;
    const end = await mrEnd(key);
    if (end && end.state !== 'opened') g.end = end;
  }));
}

async function mrEnd(key) {
  const ref = keyParts(key);
  try {
    return ref ? await forgeFor(ref).end(ref) : null;
  } catch {
    return null;
  }
}

// A running app sends, else the oldest live worker, so a second worker, or one holding the full auto turn, never doubles or silences a banner.
async function isSender(now) {
  if (!supports('readAutoDriver')) return true;
  const ours = engine.readAutoDriver(now).frontends.filter((f) => f.live);
  if (!ours.length) return true;
  const app = await bannerApp();
  const sender = ours.find((f) => f.pid === app) ?? ours.reduce((a, b) => ((a.startedAt ?? a.beatAt) <= (b.startedAt ?? b.beatAt) ? a : b));
  return sender.pid === process.pid;
}

function focusedPage(now) {
  for (const p of presences.values()) if (p.focused && now - p.focusedAt < FOCUS_MS) return p;
  return null;
}

function panelOpen(now) {
  for (const p of presences.values()) if (p.panel && p.visible && now - p.at < PRESENCE_MS) return true;
  return false;
}

function clickablePage(now) {
  if (!ledger.prefs.clickable) return null;
  for (const p of presences.values()) if (p.visible !== undefined && p.permission === 'granted' && now - p.at < PRESENCE_MS) return p;
  return null;
}

const minutes = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

export function inQuietHours(prefs, now) {
  const at = wallClock(now, zone());
  if (prefs.weekends && !isWorkDay(at.date)) return true;
  if (!prefs.quiet) return false;
  const nowMin = at.minutes;
  const from = minutes(prefs.quietFrom);
  const to = minutes(prefs.quietTo);
  return from <= to ? nowMin >= from && nowMin < to : nowMin >= from || nowMin < to;
}

const isMuted = (l, key, now) => {
  const m = key && l.muted[key];
  return Boolean(m && (m.merged || m.until > now));
};

// The app's banners open their item when clicked, so only Orca's need the way back spelt out.
const howToOpen = () => (shell.desktop ? null : HOW_TO_OPEN);
const short = (key) => (key ? shortKey(key) : '');
const clip = (text, n) => (text.length > n ? text.slice(0, n - 1) + '…' : text);
const knownPrints = (l, i) => Boolean(i.prints?.length) && i.prints.every((p) => (l.prints[i.key] ?? []).includes(p));

// Decides who hears about what, and marks it in the ledger; deliver() then sends what it returns.
export function plan({ items, openKeys, ledger: l, now, focused = null, sender = true }) {
  const out = { banners: [], toasts: [] };
  const present = new Set(items.map((i) => i.id));
  for (const i of items) {
    const entry = (l.items[i.id] ??= { firstSeenAt: now, key: i.key, kind: i.kind });
    delete entry.goneAt;
  }
  prune(l, present, openKeys, now);
  const firstRun = !l.ranAt;
  const gap = !firstRun && now - l.ranAt > GAP_MS;
  l.ranAt = now;
  if (firstRun) {
    for (const i of items) seen(l, i, now, 'seed');
    return out;
  }
  if (!sender) return out;
  const due = [];
  for (const i of items) {
    const entry = l.items[i.id];
    if (i.tier !== 'interrupt' || !i.settled || entry.notifiedAt || now - entry.firstSeenAt < (i.settleAfterMs ?? 0) || isMuted(l, i.key, now)) continue;
    if (knownPrints(l, i)) seen(l, i, now, 'repeat');
    else due.push(i);
  }
  if (!due.length) return out;
  if (!l.prefs.enabled) {
    for (const i of due) seen(l, i, now, 'off');
    return out;
  }
  if (inQuietHours(l.prefs, now)) {
    l.quietHeld = true;
    return out;
  }
  if (focused) {
    for (const i of due) {
      seen(l, i, now, 'toast');
      out.toasts.push({ id: i.id, title: titleFor([i]), target: targetFor(i), at: now });
    }
    return out;
  }
  return banners(l, due, now, gap, out);
}

function banners(l, due, now, gap, out) {
  const ready = due.filter((i) => !(now - (l.lastByKind[`${i.key}:${i.kind}`] ?? 0) < PER_KIND_MS));
  if (!ready.length) return out;
  l.sent = l.sent.filter((at) => now - at < HOUR);
  const room = PER_HOUR - l.sent.length;
  if (room <= 0) {
    l.overflow = true;
    return out;
  }
  const groups = [...groupByMr(ready).values()];
  const digest = gap || l.quietHeld || l.overflow || groups.length >= DIGEST_AT || groups.length > room;
  const made = digest ? [digestBanner(groups, gap)] : groups.map(mrBanner);
  for (const banner of made) {
    l.sent.push(now);
    for (const i of banner.items) {
      seen(l, i, now, 'desktop');
      if (i.key) l.lastByKind[`${i.key}:${i.kind}`] = now;
    }
    out.banners.push({ title: banner.title, body: banner.body, target: banner.target, ids: banner.items.map((i) => i.id) });
  }
  l.latest = { target: made[made.length - 1].target, at: now };
  l.quietHeld = false;
  l.overflow = false;
  return out;
}

function seen(l, i, now, via) {
  Object.assign(l.items[i.id] ??= { firstSeenAt: now, key: i.key, kind: i.kind }, { notifiedAt: now, via });
  if (i.key && i.prints?.length) l.prints[i.key] = [...new Set([...(l.prints[i.key] ?? []), ...i.prints])];
}

function prune(l, present, openKeys, now) {
  for (const [id, entry] of Object.entries(l.items)) {
    if (present.has(id)) continue;
    entry.goneAt ??= now;
    if (now - entry.goneAt > PRUNE_MS) delete l.items[id];
  }
  for (const [key, m] of Object.entries(l.muted)) if (!m.merged && m.until <= now) delete l.muted[key];
  if (!openKeys) return;
  trackGone(l, openKeys, now);
  for (const [key, g] of Object.entries(l.gone)) {
    if (g.end && l.muted[key]?.merged) delete l.muted[key];
    if (now - g.at > PRUNE_MS) forget(l, key);
  }
}

function forget(l, key) {
  delete l.gone[key];
  delete l.prints[key];
  delete l.later[key];
  delete l.muted[key];
}

function groupByMr(items) {
  const groups = new Map();
  for (const i of items) groups.set(i.key ?? i.id, [...(groups.get(i.key ?? i.id) ?? []), i]);
  return groups;
}

function targetFor(i) {
  if (i.key) return i.tab ? `mr:${i.key}:${i.tab}` : 'needs-you';
  return i.tab ?? 'needs-you';
}
const subject = (i) => (i.key ? short(i.key) : i.title ?? APP_NAME);

function titleFor(items) {
  return clip(`${subject(items[0])}: ${items[0].why}`, TITLE_CHARS);
}

function mrBanner(items) {
  if (items[0].banner) return { items, ...items[0].banner, target: targetFor(items[0]) };
  const rest = items.slice(1).map((i) => i.why);
  return { items, title: titleFor(items), body: [rest.join('; '), howToOpen()].filter(Boolean).join('\n'), target: targetFor(items[0]) };
}

function digestBanner(groups, gap) {
  const items = groups.flat();
  const mrs = groups.filter((g) => g[0].key).length;
  const lines = groups.slice(0, DIGEST_LINES).map((g) => `${subject(g[0])}: ${g.map((i) => i.why).join(', ')}`);
  const more = groups.length > DIGEST_LINES ? [`+${groups.length - DIGEST_LINES} more`] : [];
  const what = `${items.length} ${items.length === 1 ? 'thing needs' : 'things need'} you${mrs ? ` on ${mrs} ${mrs === 1 ? 'MR' : 'MRs'}` : ''}`;
  return { items, title: clip(gap ? `While ${APP_NAME} was off: ${what}` : what, TITLE_CHARS), body: [...lines, ...more, howToOpen()].filter(Boolean).join('\n'), target: 'needs-you' };
}

async function deliver({ banners: made, toasts: shown }, now) {
  toasts.unshift(...shown);
  toasts.length = Math.min(toasts.length, SHOWN_TOASTS);
  const page = clickablePage(now);
  for (const banner of made) {
    if (page) offer(page, banner);
    else await alert(banner);
  }
}

// The page shows it itself, so a click opens the drawer tab; one it does not confirm within 10 s goes out as a banner.
function offer(page, banner) {
  const id = `o${Date.now().toString(36)}${offers.size}`;
  const timer = setTimeout(() => {
    offers.delete(id);
    const sent = alert(banner).then(saveLedger).catch(() => {}).finally(() => sending.delete(sent));
    sending.add(sent);
  }, ACK_MS);
  timer.unref?.();
  offers.set(id, { ...banner, id, page: page.page, timer });
  notify(`attention:offer:${page.page}:${id}`);
}

async function alert(banner) {
  try {
    if (!shell.alert) throw new Error(`this worker predates desktop notifications, so restart ${APP_NAME}`);
    const reply = await shell.alert(banner.title, banner.body, banner.target);
    if (reply && reply.delivered === false) throw new Error('it was not delivered');
    if (ledger.notReaching) await markRead(false);
    ledger.notReaching = null;
  } catch (err) {
    for (const id of banner.ids) if (ledger.items[id]) ledger.items[id].via = 'marker';
    ledger.notReaching = err.message;
    await markRead(true);
  }
}

// A reminder is due now or never, so quiet hours drop it rather than hold it for a digest, and Needs you is left as it was.
export async function remindMeeting({ id, title, body, target, join }, now = Date.now()) {
  ledger ??= await (loaded ?? loadLedger());
  if (!(await isSender(now))) return 'elsewhere';
  if (!ledger.prefs.enabled) return 'off';
  if (inQuietHours(ledger.prefs, now)) return 'quiet';
  if (focusedPage(now)) {
    toasts.unshift({ id, title, target, join, kind: 'meeting', at: now });
    toasts.length = Math.min(toasts.length, SHOWN_TOASTS);
    notify('matrix');
    return 'toast';
  }
  await alert({ ids: [], title, body, target });
  await saveLedger();
  return 'banner';
}

// Sent by whichever worker served the click, sender or not, so the app's first banner makes macOS list it under Notifications.
async function testBanner() {
  ledger ??= await (loaded ?? loadLedger());
  await alert({ ids: [], title: APP_NAME, body: `Banners from ${APP_NAME} show here.`, target: 'needs-you' });
  await saveLedger();
  notify('matrix');
  return { text: ledger.notReaching ? `The test banner did not go out: ${ledger.notReaching}.` : 'Test banner sent.' };
}

// Orca's unread dot on the plugin's workspace, never --comment, which would overwrite a comment of yours on it.
async function markRead(unread) {
  const root = workspaceRoot(config);
  if (!root || shell.desktop) return;
  await orca(config, ['worktree', 'set', '--worktree', `path:${root}`, unread ? '--unread' : '--read']).catch(() => {});
}

function viewCards(cards) {
  return cards.map((card) => ({ ...card, reasons: card.reasons.filter((i) => !(i.later && ledger?.later[card.key] === i.later)) })).filter((card) => card.reasons.length);
}

export function view(now = Date.now()) {
  const cards = viewCards(built.cards).map((card) => ({ ...card, muted: isMuted(ledger ?? freshLedger(), card.key, now) ? ledger.muted[card.key] : null }));
  const agents = built.items.filter((i) => i.group === 'agents');
  const system = built.items.filter((i) => i.group === 'system');
  const email = built.items.filter((i) => i.group === 'email');
  const slack = built.items.filter((i) => i.group === 'slack');
  return {
    cards,
    agents,
    system,
    email,
    slack,
    count: cards.length + agents.filter((i) => i.tier === 'interrupt').length + email.length + slack.length,
    latest: ledger?.latest ?? null,
    notReaching: ledger?.notReaching ?? null,
    prefs: ledger?.prefs ?? { ...DEFAULT_PREFS },
    toasts: toasts.filter((t) => now - t.at < MINUTE),
    offers: [...offers.values()].map(({ id, page, title, body, target }) => ({ id, page, title, body, target })),
    quietNow: ledger ? inQuietHours(ledger.prefs, now) : false,
    later: { ...(ledger?.later ?? {}) },
    builtAt,
    buildError,
    verdictMarks: Object.fromEntries(built.items.filter((i) => i.kind === 'verdict' && i.later && i.key).map((i) => [i.key, i.later])),
  };
}

export function latestTarget() {
  return ledger?.latest?.target ?? 'needs-you';
}

export function validTarget(target) {
  if (typeof target !== 'string' || target.length > 400) return false;
  if (VIEWS.has(target) || TICKET_TARGET.test(target) || AGENT_TARGET.test(target)) return true;
  const m = /^mr:(.+):([a-z]+)$/.exec(target);
  return Boolean(m && MR_KEY.test(m[1]) && TABS.has(m[2]));
}

function presence({ page, focused, visible, permission, panel } = {}) {
  if (typeof page !== 'string' || !/^[\w-]{4,64}$/.test(page)) throw failure(400, 'presence takes { page, focused, visible, permission }');
  const now = Date.now();
  const was = presences.get(page);
  const entry = { page, at: now, focused: focused === true, visible: visible === true, panel: panel === true, permission: ['granted', 'denied', 'default'].includes(permission) ? permission : 'default', focusedAt: focused === true ? now : was?.focusedAt ?? 0 };
  presences.set(page, entry);
  for (const [id, p] of presences) if (now - p.at > PRESENCE_MS) presences.delete(id);
  if (!was || was.focused !== entry.focused || was.permission !== entry.permission || was.panel !== entry.panel || (entry.panel && was.visible !== entry.visible)) rebuild();
  return { ok: true };
}

function cardKey(key) {
  if (typeof key !== 'string' || !MR_KEY.test(key)) throw failure(400, BAD_KEY);
  return key;
}

async function later({ key, mark } = {}) {
  cardKey(key);
  if (typeof mark !== 'string' || mark.length > 400) throw failure(400, 'later takes { key, mark }');
  ledger.later[key] = mark;
  await saveLedger();
  notify('matrix');
  return { ok: true, text: `${short(key)} waits until something on it changes` };
}

async function mute({ key, until } = {}) {
  cardKey(key);
  if (until === null) delete ledger.muted[key];
  else if (until === 'day') ledger.muted[key] = { until: Date.now() + 24 * HOUR };
  else if (until === 'merged') ledger.muted[key] = { merged: true };
  else throw failure(400, "mute until 'day', 'merged' or null");
  await saveLedger();
  notify('matrix');
  return { ok: true, text: until === null ? `${short(key)} notifies you again` : until === 'day' ? `${short(key)} is quiet for a day` : `${short(key)} is quiet until it merges` };
}

async function setPrefs(patch = {}) {
  const next = { ...ledger.prefs };
  for (const name of ['enabled', 'quiet', 'weekends', 'clickable']) if (typeof patch[name] === 'boolean') next[name] = patch[name];
  for (const name of ['quietFrom', 'quietTo']) {
    if (patch[name] === undefined) continue;
    if (typeof patch[name] !== 'string' || !CLOCK.test(patch[name])) throw failure(400, `${name} is a time such as 22:00`);
    next[name] = patch[name];
  }
  ledger.prefs = next;
  await saveLedger();
  notify('matrix');
  return { ok: true, prefs: next, text: 'Notification settings saved' };
}

function ack({ id } = {}) {
  const offered = typeof id === 'string' && offers.get(id);
  if (!offered) return { ok: true, late: true };
  clearTimeout(offered.timer);
  offers.delete(id);
  return { ok: true };
}

export function carryState() {
  return { presences: [...presences.values()] };
}
