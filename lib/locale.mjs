import { join } from 'node:path';
import * as clock from './clock.mjs';
import { writePrivate } from './connector.mjs';
import { failure } from './engine.mjs';
import { readJson } from './run.mjs';
import { configDir } from './home.mjs';

const DAY_NAMES = { 0: 'Sunday', 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday' };
const CLOCK_WORDS = { '': "your region's clock", 24: 'the 24 hour clock', 12: 'the 12 hour clock' };

let saved = clock.localeOf({});
let shell = {};

export const ROUTES = {
  'GET /api/locale': () => refresh().then(view),
  'POST /api/locale': async ({ body }) => save(await body()),
};

export async function start(cfg, sh) {
  shell = sh ?? {};
  await refresh();
}

export const localeFile = () => join(configDir(), 'locale.json');

export async function refresh() {
  saved = clock.localeOf(await readJson(localeFile(), {}));
  return saved;
}

export const zone = () => saved.timeZone || clock.machineZone();
export const workDays = () => saved.hours.workDays;
export const formatting = () => ({ timeZone: zone(), region: saved.region, clock: saved.clock });

export const today = (now = Date.now()) => clock.dayIn(now, zone());
export const dayOf = (ms) => clock.dayIn(ms, zone());
export const hourOf = (ms) => clock.hourIn(ms, zone());
export const workingDay = (day, step) => clock.workingDay(day, step, workDays());
export const isWorkDay = (day) => clock.isWorkDay(day, workDays());
export const inWorkingHours = (now, hours = saved.hours) => clock.inHours(now, hours, zone());

export const timeText = (ms, seconds = false) => clock.dateFormat(formatting(), { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }).format(ms);
export const dayText = (day, options) => clock.dayText(formatting(), day, options);
export const numberText = (n) => clock.numberText(formatting(), n);

export function daysSaid(days) {
  const names = days.map((d) => DAY_NAMES[d]);
  if (days.join() === '1,2,3,4,5') return 'weekdays';
  return names.length === 1 ? names[0] + 's' : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

export const hoursSaid = () => ({ from: saved.hours.from, to: saved.hours.to, days: daysSaid(saved.hours.workDays) });

export function view() {
  return { timeZone: zone(), zoneSet: saved.timeZone, machineZone: clock.machineZone(), region: saved.region, clock: saved.clock, hours: saved.hours, days: daysSaid(saved.hours.workDays) };
}

async function save(patch = {}) {
  const file = (await readJson(localeFile(), null)) ?? {};
  const next = patched(clock.localeOf(file), patch);
  const said = changes(patch).map((say) => say(next));
  if (!said.length) throw failure(400, 'the locale takes timeZone, region, clock, from, to or workDays');
  if (next.hours.from === next.hours.to) throw failure(400, 'working hours need a start and an end that differ');
  await writePrivate(localeFile(), { ...file, locale: { timeZone: next.timeZone, region: next.region, clock: next.clock }, hours: next.hours });
  saved = next;
  shell.notify?.('locale');
  return { ok: true, text: said.join('. '), ...view() };
}

const clockTime = (value) => (typeof value === 'string' && clock.CLOCK.test(value) ? value : null);
const blankOr = (valid) => (value) => (value === '' ? '' : valid(value));

const CHECKS = {
  timeZone: [blankOr(clock.zoneName), "a time zone is a name such as Europe/London or America/New_York, or blank for this Mac's"],
  region: [blankOr(clock.regionName), "a region is a language and country such as en-GB or en-US, or blank for your system's"],
  clock: [(value) => (clock.CLOCKS.includes(value) ? value : null), "the clock is 24, 12, or blank for your region's"],
  from: [clockTime, 'from is a time such as 08:00'],
  to: [clockTime, 'to is a time such as 18:00'],
  workDays: [clock.workDaysOf, 'working days are a list of at least one day, 0 for Sunday to 6 for Saturday'],
};

function patched(was, patch) {
  const field = (key, current) => {
    if (patch[key] === undefined) return current;
    const [valid, why] = CHECKS[key];
    const value = valid(patch[key]);
    if (value === null) throw failure(400, why);
    return value;
  };
  return {
    timeZone: field('timeZone', was.timeZone),
    region: field('region', was.region),
    clock: field('clock', was.clock),
    hours: { from: field('from', was.hours.from), to: field('to', was.hours.to), workDays: field('workDays', was.hours.workDays) },
  };
}

function changes(patch) {
  const typed = (key) => patch[key] !== undefined;
  return [
    typed('timeZone') ? (n) => (n.timeZone ? `Times are shown in ${n.timeZone}` : `Times follow this Mac, now ${clock.machineZone()}`) : null,
    typed('region') ? (n) => (n.region ? `Dates and numbers are written as in ${n.region}` : 'Dates and numbers are written as your system writes them') : null,
    typed('clock') ? (n) => `Times use ${CLOCK_WORDS[n.clock]}` : null,
    typed('from') || typed('to') || typed('workDays') ? (n) => `You work ${n.hours.from} to ${n.hours.to} on ${daysSaid(n.hours.workDays)}` : null,
  ].filter(Boolean);
}
