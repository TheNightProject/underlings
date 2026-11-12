const DAY_MS = 86_400_000;
const CACHE_MAX = 2000;
export const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
export const CLOCKS = ['', '24', '12'];
export const DEFAULT_HOURS = { from: '08:00', to: '18:00', workDays: [1, 2, 3, 4, 5] };

export const machineZone = () => new Intl.DateTimeFormat().resolvedOptions().timeZone;

export const systemRegion = () => new Intl.DateTimeFormat().resolvedOptions().locale;

export function zoneName(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

export function regionName(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const [tag] = Intl.getCanonicalLocales(value.trim());
    return tag && Intl.DateTimeFormat.supportedLocalesOf(tag).length ? tag : null;
  } catch {
    return null;
  }
}

export function workDaysOf(value) {
  if (!Array.isArray(value) || !value.length || !value.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => value.includes(d));
}

export function localeOf(saved) {
  const locale = saved?.locale ?? {};
  const hours = saved?.hours ?? {};
  return {
    timeZone: zoneName(locale.timeZone) ?? '',
    region: regionName(locale.region) ?? '',
    clock: CLOCKS.includes(locale.clock) ? locale.clock : '',
    hours: {
      from: CLOCK.test(hours.from ?? '') ? hours.from : DEFAULT_HOURS.from,
      to: CLOCK.test(hours.to ?? '') ? hours.to : DEFAULT_HOURS.to,
      workDays: workDaysOf(hours.workDays) ?? [...DEFAULT_HOURS.workDays],
    },
  };
}

const wallFormats = new Map();

function wallFormat(zone) {
  let format = wallFormats.get(zone);
  if (!format) {
    // Read by part type, so this locale fixes only the digits and the 24 hour clock.
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    wallFormats.set(zone, format);
  }
  return format;
}

function partsAt(ms, zone) {
  const p = {};
  for (const { type, value } of wallFormat(zone).formatToParts(ms)) p[type] = value;
  return p;
}

export function wallClock(ms, zone) {
  const p = partsAt(ms, zone);
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export const dayIn = (ms, zone) => wallClock(ms, zone).date;

export const hourIn = (ms, zone) => Math.floor(wallClock(ms, zone).minutes / 60);

function offsetAt(ms, zone) {
  const p = partsAt(ms, zone);
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(ms / 1000) * 1000;
}

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

export const isWorkDay = (day, workDays = DEFAULT_HOURS.workDays) => workDays.includes(weekdayOf(day));

export function workingDay(day, step, workDays = DEFAULT_HOURS.workDays) {
  const working = workDays.length ? workDays : DEFAULT_HOURS.workDays;
  let at = addDays(day, step);
  while (!working.includes(weekdayOf(at))) at = addDays(at, step);
  return at;
}

// As RFC 5545 reads a local time: the first of two when the clocks go back, on the earlier offset when they skip it.
export function zonedTime(day, time, zone) {
  const guess = Date.parse(`${day}T${time}:00Z`);
  const before = offsetAt(guess - DAY_MS, zone);
  const after = offsetAt(guess + DAY_MS, zone);
  const fits = [guess - before, guess - after].filter((at) => {
    const wall = wallClock(at, zone);
    return wall.date === day && wall.time === time;
  });
  return fits.length ? Math.min(...fits) : guess - before;
}

const starts = new Map();

// Where midnight is skipped, 00:00 on the earlier offset is the instant the clocks jump, so the day still starts there.
export function startOfDay(day, zone) {
  const key = `${zone}|${day}`;
  if (!starts.has(key)) {
    if (starts.size >= CACHE_MAX) starts.clear();
    starts.set(key, zonedTime(day, '00:00', zone));
  }
  return starts.get(key);
}

const minutesOf = (clock) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

export function inHours(ms, { from, to, workDays }, zone) {
  const wall = wallClock(ms, zone);
  if (!workDays.includes(weekdayOf(wall.date))) return false;
  const [start, end] = [minutesOf(from), minutesOf(to)];
  return start <= end ? wall.minutes >= start && wall.minutes < end : wall.minutes >= start || wall.minutes < end;
}

const CYCLES = { 24: 'h23', 12: 'h12' };
const formats = new Map();

export function dateFormat({ timeZone, region, clock } = {}, options = {}) {
  const all = { timeZone: timeZone || undefined, ...(CYCLES[clock] ? { hourCycle: CYCLES[clock] } : {}), ...options };
  const key = `${region ?? ''}|${JSON.stringify(all)}`;
  if (!formats.has(key)) {
    if (formats.size >= CACHE_MAX) formats.clear();
    formats.set(key, built(region || undefined, all));
  }
  return formats.get(key);
}

// A 12 hour clock reads 2:05 pm, not 02:05 pm.
function built(region, options) {
  const format = new Intl.DateTimeFormat(region, options);
  const twelve = options.hour === '2-digit' && ['h11', 'h12'].includes(format.resolvedOptions().hourCycle);
  return twelve ? new Intl.DateTimeFormat(region, { ...options, hour: 'numeric' }) : format;
}

// A day as written, not an instant, so no zone can move it to the day either side.
export const dayText = (locale, day, options) => dateFormat(locale, { ...options, timeZone: 'UTC' }).format(Date.parse(`${day}T12:00:00Z`));

export const numberText = ({ region } = {}, n) => new Intl.NumberFormat(region || undefined).format(n);
