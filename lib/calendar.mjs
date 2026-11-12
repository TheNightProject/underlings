import { join } from 'node:path';
import { writePrivate } from './connector.mjs';
import { failure, requireEngine } from './engine.mjs';
import { isOn } from './features.mjs';
import * as overlay from './meetingoverlay.mjs';
import * as notifier from './notifier.mjs';
import { readJson } from './run.mjs';
import { addDays } from './clock.mjs';
import * as locale from './locale.mjs';
import { loadSettings as standupSettings } from './standup.mjs';
import { configDir, stateDir } from './home.mjs';

const MINUTE = 60_000;
const DAY_MS = 24 * 60 * MINUTE;
export const EVERY_MS = 5 * MINUTE;
const TICK_MS = 30_000;
const BACK_DAYS = 14;
const AHEAD_DAYS = 42;
const MAX_DAYS = 62;
const REMINDED_KEPT_MS = 2 * DAY_MS;
const NAMES_SHOWN = 3;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SECRET = /private-[0-9a-f]{8,}/gi;
export const JOIN_TARGET = 'join:';
export const LEADS = [0, 1, 2, 5, 10, 15];
export const DEFAULT_SETTINGS = { remindMinutes: 5, ...overlay.DEFAULTS };
const SETTINGS = {
  remindMinutes: [(v) => LEADS.includes(v), `remindMinutes is one of ${LEADS.join(', ')}`],
  overlay: [(v) => typeof v === 'boolean', 'overlay is true or false'],
  overlayLead: [(v) => overlay.LEADS.includes(v), `overlayLead is one of ${overlay.LEADS.join(', ')} seconds`],
  overlayWhich: [(v) => overlay.WHICH.includes(v), `overlayWhich is one of ${overlay.WHICH.join(', ')}`],
};
const WHICH_WORDS = { all: 'each meeting you have not declined', join: 'each meeting with a join link', accepted: 'each meeting you accepted' };
const KIND_NAMES = { meet: 'Google Meet', zoom: 'Zoom', teams: 'Teams', other: 'the call' };

let config = {};
let shell = {};
let cache = null;
let error = null;
let tried = { address: null, at: 0 };
let addressSet = false;
let fetching = null;
let ticking = null;
let timer = null;
let memo = null;
let settings = { ...DEFAULT_SETTINGS };

export const ACTIONS = {};

export const ROUTES = {
  'GET /api/calendar': ({ query }) => read(query),
  'POST /api/calendar/refresh': () => refreshNow(),
  'GET /api/calendar/settings': () => settingsView(),
  'POST /api/calendar/settings': async ({ body }) => saveSettings(await body()),
  'POST /api/calendar/overlay': async ({ body }) => overlay.act(await body()),
};

export async function start(cfg, sh) {
  config = cfg ?? {};
  shell = sh ?? {};
  overlay.start(config, shell, { events: () => cache?.events ?? [], settings: () => settings });
  settings = await loadSettings();
  timer = setInterval(scheduled, TICK_MS);
  timer.unref?.();
  scheduled();
}

export function stop() {
  overlay.stop();
  clearInterval(timer);
  timer = null;
  cache = null;
  error = null;
  memo = null;
  addressSet = false;
  tried = { address: null, at: 0 };
}

export async function settled() {
  while (ticking || fetching) await Promise.allSettled([ticking, fetching]);
  await overlay.settled();
}

function scheduled() {
  ticking ??= tick().catch(() => {}).finally(() => { ticking = null; });
}

const stateFile = () => join(config.stateDir ?? stateDir(), 'calendar.json');
const settingsFile = () => join(configDir(), 'calendar.json');

export async function loadSettings() {
  const saved = (await readJson(settingsFile(), {})) ?? {};
  return Object.fromEntries(Object.entries(SETTINGS).map(([name, [ok]]) => [name, ok(saved[name]) ? saved[name] : DEFAULT_SETTINGS[name]]));
}

async function currentAddress() {
  const { calendarAddress } = await standupSettings();
  addressSet = Boolean(calendarAddress);
  if (!calendarAddress && (cache || error)) forget();
  return calendarAddress;
}

function forget() {
  cache = null;
  error = null;
  memo = null;
  tried = { address: null, at: 0 };
  changed();
}

function offNow() {
  if (cache || error) forget();
}

const due = (address, now) => address !== tried.address || now - tried.at >= EVERY_MS;

export async function tick(now = Date.now()) {
  if (!(await isOn('calendar'))) return offNow();
  settings = await loadSettings();
  const address = await currentAddress();
  if (address && !fetching && due(address, now)) await fetchCalendar(address, now);
  await remind(now);
  await overlay.check(now);
}

function fetchCalendar(address, now = Date.now()) {
  fetching ??= fetchOnce(address, now).finally(() => {
    fetching = null;
    changed();
  });
  return fetching;
}

// The address is a secret, so it is kept only in memory here and scrubbed from anything said about a failure.
async function fetchOnce(address, now) {
  tried = { address, at: now };
  try {
    const engine = requireEngine('fetchCalendar', 'calendarEvents');
    const ics = await engine.fetchCalendar(address);
    const window = cachedWindow(now);
    const events = await engine.calendarEvents(ics, window.from, window.to, window.zone);
    cache = { address, ics, events, ...window, fetchedAt: new Date().toISOString() };
    memo = null;
    error = null;
  } catch (err) {
    error = scrub(err?.message ?? String(err), address);
    if (cache?.address !== address) cache = null;
  }
}

function cachedWindow(now) {
  const today = locale.today(now);
  return { from: addDays(today, -BACK_DAYS), to: addDays(today, AHEAD_DAYS), zone: locale.zone() };
}

export function scrub(message, address) {
  const plain = String(address ?? '').trim();
  const https = plain.replace(/^webcal:/i, 'https:');
  const variants = new Set([plain, https, encodeURI(https), safeDecode(https), pathOf(https)].filter((v) => v && v.length > 8));
  let text = String(message ?? '');
  for (const variant of [...variants].sort((a, b) => b.length - a.length)) text = text.replaceAll(variant, 'the calendar address');
  return text.replace(SECRET, 'private-…');
}

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function pathOf(text) {
  try {
    return new URL(text).pathname;
  } catch {
    return null;
  }
}

function changed() {
  shell.notify?.('calendar');
}

function checkWindow(query, now) {
  const today = locale.today(now);
  const from = query.get('from') || today;
  const to = query.get('to') || from;
  const real = (day) => DAY.test(day) && addDays(day, 0) === day;
  if (!real(from) || !real(to) || to < from) throw failure(400, 'a calendar window looks like from=2026-11-09&to=2026-11-13');
  if (addDays(from, MAX_DAYS - 1) < to) throw failure(400, `a calendar window is at most ${MAX_DAYS} days`);
  return { from, to, today };
}

async function read(query) {
  const now = Date.now();
  const window = checkWindow(query, now);
  const address = await currentAddress();
  const base = { ...window, now, set: Boolean(address), everyMinutes: EVERY_MS / MINUTE, remindMinutes: settings.remindMinutes };
  if (!address) return { ...base, fetching: false, fetchedAt: null, error: null, events: [] };
  const current = cache?.address === address ? cache : null;
  if (!current && !fetching && due(address, now)) fetchCalendar(address, now);
  return { ...base, fetching: Boolean(fetching), fetchedAt: current?.fetchedAt ?? null, error, events: current ? await eventsBetween(current, window) : [] };
}

const overlaps = (e, from, to) => e.lastDay >= from && e.firstDay <= to;

// A window outside the one kept is read from the calendar already fetched, never by asking Google again.
async function eventsBetween(current, { from, to }) {
  const zone = locale.zone();
  if (from >= current.from && to <= current.to && zone === current.zone) return current.events.filter((e) => overlaps(e, from, to));
  const key = `${current.fetchedAt}|${from}|${to}|${zone}`;
  if (memo?.key !== key) memo = { key, events: await requireEngine('calendarEvents').calendarEvents(current.ics, from, to, zone) };
  return memo.events;
}

async function refreshNow() {
  if (!(await isOn('calendar'))) throw failure(409, 'the calendar is off: turn it on in Settings first');
  const address = await currentAddress();
  if (!address) throw failure(409, 'there is no calendar address yet: add it in Settings, under Standup');
  const busy = Boolean(fetching);
  fetchCalendar(address);
  return { ok: true, text: busy ? 'Already reading your calendar' : 'Reading your calendar' };
}

const meeting = (e) => !e.allDay && e.response !== 'declined';
const brief = ({ id, title, start, end, join, response, others, location }) => ({ id, title, start, end, join, response, others, location });

export function view(now = Date.now()) {
  const live = (cache?.events ?? []).filter(meeting);
  const next = live.find((e) => e.start > now);
  return {
    set: addressSet,
    error,
    fetchedAt: cache?.fetchedAt ?? null,
    current: live.filter((e) => e.start <= now && now < e.end).map(brief),
    next: next ? brief(next) : null,
    overlay: overlay.view(),
  };
}

export function joinLink(target) {
  if (typeof target !== 'string' || !target.startsWith(JOIN_TARGET)) return null;
  const id = target.slice(JOIN_TARGET.length);
  return cache?.events.find((e) => e.id === id)?.join?.url ?? null;
}

const remindKey = (e) => `${e.id}|${e.start}`;

async function loadReminded() {
  const saved = await readJson(stateFile(), null);
  return saved?.v === 1 && saved.reminded && typeof saved.reminded === 'object' ? saved.reminded : {};
}

// Only the worker that sends marks a meeting, and each reads the file afresh, so two workers never both remind.
async function remind(now) {
  const lead = settings.remindMinutes * MINUTE;
  if (!lead || !cache) return;
  const soon = cache.events.filter((e) => meeting(e) && e.start > now && e.start - lead <= now);
  if (!soon.length) return;
  const reminded = await loadReminded();
  let marked = 0;
  for (const e of soon.filter((x) => !reminded[remindKey(x)])) {
    if ((await notifier.remindMeeting(bannerFor(e, now), now)) === 'elsewhere') continue;
    reminded[remindKey(e)] = now;
    marked += 1;
  }
  if (!marked) return;
  const kept = Object.entries(reminded).filter(([, at]) => now - at < REMINDED_KEPT_MS);
  await writePrivate(stateFile(), { v: 1, reminded: Object.fromEntries(kept) });
}

export function bannerFor(e, now) {
  const minutes = Math.max(1, Math.round((e.start - now) / MINUTE));
  const names = namesLine(e.others ?? []);
  const when = `${locale.timeText(e.start)} to ${locale.timeText(e.end)}${names ? ` with ${names}` : ''}`;
  const join = e.join ? (shell.desktop ? `Click to join on ${KIND_NAMES[e.join.kind] ?? KIND_NAMES.other}` : `Join on ${KIND_NAMES[e.join.kind] ?? KIND_NAMES.other} from the Calendar view`) : null;
  return {
    id: `meeting:${remindKey(e)}`,
    title: `In ${minutes} min: ${e.title}`,
    body: [when, join].filter(Boolean).join('\n'),
    target: e.join ? JOIN_TARGET + e.id : 'calendar',
    join: e.join?.url ?? null,
  };
}

function namesLine(names) {
  if (names.length <= 1) return names[0] ?? '';
  const shown = names.length > NAMES_SHOWN ? [...names.slice(0, NAMES_SHOWN - 1), `${names.length - NAMES_SHOWN + 1} others`] : names;
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

async function settingsView() {
  return { ...settings, leads: LEADS, overlayLeads: overlay.LEADS, overlayWhichOptions: overlay.WHICH, overlayHere: overlay.available(), calendarSet: Boolean(await currentAddress()) };
}

async function saveSettings(patch = {}) {
  const names = Object.keys(SETTINGS).filter((name) => patch?.[name] !== undefined);
  if (!names.length) throw failure(400, `settings are ${Object.keys(SETTINGS).join(', ')}`);
  const wrong = names.find((name) => !SETTINGS[name][0](patch[name]));
  if (wrong) throw failure(400, SETTINGS[wrong][1]);
  settings = { ...(await loadSettings()), ...Object.fromEntries(names.map((name) => [name, patch[name]])) };
  await writePrivate(settingsFile(), settings);
  changed();
  overlay.check();
  return { ok: true, text: names.includes('remindMinutes') ? bannerSaid(settings) : overlaySaid(settings), ...(await settingsView()) };
}

const bannerSaid = (s) => (s.remindMinutes ? `A banner comes ${s.remindMinutes} min before each meeting` : 'No banner before meetings');

function overlaySaid(s) {
  if (!s.overlay) return 'No full-screen reminder before meetings';
  const lead = s.overlayLead < 60 ? `${s.overlayLead} s` : `${s.overlayLead / 60} min`;
  return `The screen is covered ${lead} before ${WHICH_WORDS[s.overlayWhich]}`;
}
