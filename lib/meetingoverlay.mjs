import { join } from 'node:path';
import { writePrivate } from './connector.mjs';
import { failure } from './engine.mjs';
import { readJson } from './run.mjs';
import { stateDir } from './home.mjs';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const LATE_MS = 3 * MINUTE;
const CLOSE_MS = 5 * MINUTE;
const KEPT_MS = 48 * HOUR;
export const LEADS = [30, 60, 120, 300];
export const WHICH = ['all', 'join', 'accepted'];
export const DEFAULTS = { overlay: true, overlayLead: 60, overlayWhich: 'all' };
const ACTS = ['join', 'calendar', 'snooze', 'dismiss'];

let config = {};
let shell = {};
let source = { events: () => [], settings: () => DEFAULTS };
let marks = null;
let up = new Map();
let wake = null;
let queue = Promise.resolve();

export function start(cfg, sh, from) {
  config = cfg ?? {};
  shell = sh ?? {};
  source = from;
  marks = null;
}

export function stop() {
  clearTimeout(wake);
  wake = null;
  if (up.size) shell.desktop?.closeOverlay?.();
  up = new Map();
}

export const available = () => typeof shell.desktop?.showOverlay === 'function';

export async function settled() {
  let seen;
  do {
    seen = queue;
    await seen;
  } while (seen !== queue);
}

function serial(job) {
  const run = queue.then(job);
  queue = run.catch((err) => shell.log?.(`the meeting reminder went wrong: ${err.message}`));
  return run;
}

export function check(now = Date.now()) {
  return serial(() => checkOnce(now)).catch(() => {});
}

const keyOf = (e) => `${e.id}|${e.start}`;
const markFile = () => join(config.stateDir ?? stateDir(), 'meeting-overlay.json');

function wanted(e, which) {
  if (e.allDay || e.response === 'declined') return false;
  if (which === 'join') return Boolean(e.join);
  if (which === 'accepted') return e.response === 'accepted';
  return true;
}

// A first showing waits only a little past the start, but a snoozed one may come back until the reminder would have closed itself.
function due(e, lead, now) {
  const mark = marks[keyOf(e)];
  if (mark && !(mark.snoozedUntil <= now)) return false;
  return e.start - lead <= now && now < e.start + (mark ? CLOSE_MS : LATE_MS);
}

async function checkOnce(now) {
  marks ??= await loadMarks();
  const settings = source.settings();
  const events = settings.overlay && available() ? source.events().filter((e) => wanted(e, settings.overlayWhich)) : [];
  const lead = settings.overlayLead * SECOND;
  const kept = events.filter((e) => up.has(keyOf(e)) && now < e.start + CLOSE_MS);
  const fresh = events.filter((e) => !up.has(keyOf(e)) && due(e, lead, now));
  await cover(kept, fresh, now);
  plan(events, lead, now);
}

async function cover(kept, fresh, now) {
  const next = new Map([...kept, ...fresh].sort((a, b) => a.start - b.start).map((e) => [keyOf(e), e]));
  if (fresh.length) shell.desktop.showOverlay();
  else if (up.size && !next.size) shell.desktop?.closeOverlay?.();
  const moved = fresh.length > 0 || next.size !== up.size;
  up = next;
  for (const e of fresh) marks[keyOf(e)] = { at: now };
  if (fresh.length) await saveMarks(now);
  if (moved) shell.notify?.('calendar');
}

// The calendar ticks every 30 seconds, so the next change is woken for on time rather than up to a tick late.
function plan(events, lead, now) {
  clearTimeout(wake);
  wake = null;
  const next = Math.min(...events.flatMap((e) => changesOf(e, lead)).filter((at) => at > now));
  if (!Number.isFinite(next) || next - now > HOUR) return;
  wake = setTimeout(() => check(), next - now);
  wake.unref?.();
}

function changesOf(e, lead) {
  if (up.has(keyOf(e))) return [e.start + CLOSE_MS];
  const mark = marks[keyOf(e)];
  if (!mark) return [e.start - lead];
  return mark.snoozedUntil ? [mark.snoozedUntil] : [];
}

async function loadMarks() {
  const saved = await readJson(markFile(), null);
  return saved?.v === 1 && saved.marks && typeof saved.marks === 'object' ? saved.marks : {};
}

async function saveMarks(now) {
  marks = Object.fromEntries(Object.entries(marks).filter(([, mark]) => now - mark.at < KEPT_MS));
  await writePrivate(markFile(), { v: 1, marks });
}

export function act({ act: what, key } = {}, now = Date.now()) {
  if (!ACTS.includes(what)) throw failure(400, `act is one of ${ACTS.join(', ')}`);
  return serial(() => actOnce(what, key, now));
}

async function actOnce(what, key, now) {
  const chosen = up.get(key) ?? null;
  if (what === 'snooze') await snooze([...up.values()], now);
  shell.desktop?.closeOverlay?.();
  up = new Map();
  shell.notify?.('calendar');
  await checkOnce(now);
  return follow(what, chosen);
}

async function snooze(meetings, now) {
  for (const e of meetings) marks[keyOf(e)] = { ...marks[keyOf(e)], snoozedUntil: now < e.start ? e.start : now + MINUTE };
  await saveMarks(now);
}

async function follow(what, e) {
  if (what === 'join' && e?.join) {
    await shell.desktop.openExternal(e.join.url);
    return { ok: true, text: `Joining ${e.title}` };
  }
  if (what === 'calendar' || what === 'join') {
    shell.desktop?.focus?.();
    shell.notify?.('goto:calendar');
    return { ok: true, text: 'Opened the calendar' };
  }
  return { ok: true, text: what === 'snooze' ? 'Snoozed' : 'Dismissed' };
}

export function view() {
  return up.size ? { meetings: [...up.values()].map(card) } : null;
}

function card(e) {
  return { key: keyOf(e), title: e.title, start: e.start, end: e.end, join: e.join, location: e.location, response: e.response, people: peopleOf(e) };
}

function peopleOf(e) {
  const named = (e.attendees ?? []).filter((a) => !a.self && a.response !== 'declined').map((a) => a.name);
  return named.length ? named : e.others ?? [];
}
