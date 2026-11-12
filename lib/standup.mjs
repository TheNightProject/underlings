import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { addDays } from './clock.mjs';
import { failure, jiraSettings, requireEngine } from './engine.mjs';
import { isOn } from './features.mjs';
import * as locale from './locale.mjs';
import { exampleKey, TICKET_KEY as KEY } from './ticketkeys.mjs';
import { configDir, stateDir } from './home.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REPO = /^[\w.-]+(?:\/[\w.-]+)*$/;
export const DEFAULT_EXCLUDED = [];
const DAYS_KEPT = 60;
const MAX_ADDRESS = 2000;
const MAX_REPOS = 50;
const MAX_IDS = 300;
const NO_TICKET = '?';

let config = {};
let shell = {};
const generating = new Map();
const failed = new Map();
let saving = Promise.resolve();

export const ACTIONS = {};

export const ROUTES = {
  'GET /api/standup': ({ query }) => read(query.get('day')),
  'POST /api/standup/generate': async ({ body }) => generate((await body()).day),
  'POST /api/standup/tick': async ({ body }) => tick(await body()),
  'POST /api/standup/tag': async ({ body }) => tag(await body()),
  'GET /api/standup/settings': () => settingsView(),
  'POST /api/standup/settings': async ({ body }) => saveSettings(await body()),
};

export function start(cfg, sh) {
  config = cfg ?? {};
  shell = sh ?? {};
}

export function stop() {
  generating.clear();
  failed.clear();
}

export function settled() {
  return Promise.all([...generating.values(), saving]);
}

const stateFile = () => join(config.stateDir ?? stateDir(), 'standup.json');
const settingsFile = () => join(configDir(), 'standup.json');

function checkDay(day) {
  if (typeof day !== 'string' || !DAY.test(day) || addDays(day, 0) !== day) throw failure(400, 'a day looks like 2026-11-09');
  if (day > locale.today()) throw failure(400, 'that day has not happened yet');
  return day;
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
  await writeFile(path + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(path + '.tmp', 0o600);
  await rename(path + '.tmp', path);
}

async function loadDays() {
  const saved = await readJson(stateFile(), null);
  return saved?.v === 1 && saved.days && typeof saved.days === 'object' ? saved.days : {};
}

// One write at a time, and each reads the file afresh, so a second window or a reload never drops a change.
function update(day, change) {
  saving = saving.catch(() => {}).then(async () => {
    const days = await loadDays();
    days[day] = change({ standup: null, ticks: {}, tags: {}, ...days[day] });
    const kept = Object.keys(days).sort().slice(-DAYS_KEPT);
    await writePrivate(stateFile(), { v: 1, days: Object.fromEntries(kept.map((d) => [d, days[d]])) });
  });
  return saving;
}

export async function loadSettings() {
  const saved = await readJson(settingsFile(), {});
  return {
    calendarAddress: typeof saved.calendarAddress === 'string' && saved.calendarAddress ? saved.calendarAddress : null,
    excludedRepos: Array.isArray(saved.excludedRepos) ? saved.excludedRepos.filter((r) => typeof r === 'string') : DEFAULT_EXCLUDED,
  };
}

// The address is a secret, so the page only ever learns whether there is one.
async function settingsView() {
  const { calendarAddress, excludedRepos } = await loadSettings();
  return { calendarSet: Boolean(calendarAddress), excludedRepos };
}

async function saveSettings(patch) {
  const next = await loadSettings();
  const said = [];
  if (patch?.calendarAddress !== undefined) {
    next.calendarAddress = checkAddress(patch.calendarAddress);
    said.push(next.calendarAddress ? 'Saved the calendar address' : 'Removed the calendar address');
  }
  if (patch?.excludedRepos !== undefined) {
    next.excludedRepos = checkRepos(patch.excludedRepos);
    said.push(next.excludedRepos.length ? `Standups leave out ${next.excludedRepos.join(', ')}` : 'Standups leave out no repos');
  }
  if (!said.length) throw failure(400, 'settings takes calendarAddress or excludedRepos');
  await writePrivate(settingsFile(), next);
  return { ok: true, text: said.join('. '), ...(await settingsView()) };
}

function checkAddress(value) {
  if (value === null || value === '') return null;
  const address = typeof value === 'string' ? value.trim() : '';
  let url = null;
  try {
    url = new URL(address);
  } catch {
    url = null;
  }
  if (!url || !['https:', 'webcal:'].includes(url.protocol) || address.length > MAX_ADDRESS) {
    throw failure(400, "that is not a calendar address: paste the Secret address in iCal format from your Google Calendar's settings");
  }
  return address;
}

function checkRepos(value) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/)).map((r) => String(r).trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
  if (list.length > MAX_REPOS || list.some((r) => !REPO.test(r) || r.length > 200)) throw failure(400, 'name each repo by its path, such as acme/tooling');
  return [...new Set(list)];
}

async function mustBeOn() {
  if (!(await isOn('standup'))) throw failure(409, 'Standup is off: turn it on in Settings first');
}

export async function read(asked) {
  requireEngine('buildStandup');
  await mustBeOn();
  const defaultDay = locale.workingDay(locale.today(), -1);
  const day = checkDay(asked || defaultDay);
  const entry = (await loadDays())[day] ?? null;
  if (!entry?.standup && !generating.has(day) && !failed.has(day)) await generate(day);
  return view(day, defaultDay, entry);
}

async function view(day, defaultDay, entry) {
  return {
    day,
    defaultDay,
    latest: locale.today(),
    generating: generating.has(day),
    error: failed.get(day) ?? null,
    ...(await settingsView()),
    standup: entry?.standup ? overlaid(entry) : null,
  };
}

async function viewSaved(day) {
  return view(day, locale.workingDay(locale.today(), -1), (await loadDays())[day]);
}

function overlaid({ standup, ticks, tags }) {
  const line = (l) => ({ ...l, ticked: ticks[l.id] ?? l.ticked, tag: (l.unknown && tags[l.id]) || l.tag, unknown: Boolean(l.unknown && !tags[l.id]) });
  return { ...standup, sections: standup.sections.map((s) => ({ ...s, groups: s.groups.map((g) => ({ ...g, lines: g.lines.map(line) })) })) };
}

async function generate(asked) {
  const day = checkDay(asked);
  const engine = requireEngine('buildStandup');
  await mustBeOn();
  if (generating.has(day)) return { ok: true, text: `Still working out ${day}` };
  const { calendarAddress, excludedRepos } = await loadSettings();
  failed.delete(day);
  const run = engine.buildStandup({ day, today: locale.workingDay(day, 1), excludedRepos, calendarAddress, ...locale.formatting(), workDays: locale.workDays() })
    .then((standup) => update(day, (entry) => ({ ...entry, standup })))
    .catch((err) => failed.set(day, err.message))
    .finally(() => {
      generating.delete(day);
      shell.notify?.('standup');
    });
  generating.set(day, run);
  return { ok: true, text: `Working out the standup for ${day}` };
}

async function tick({ day, ids, ticked } = {}) {
  checkDay(day);
  if (!Array.isArray(ids) || !ids.length || ids.length > MAX_IDS || ids.some((id) => typeof id !== 'string' || id.length > 400)) throw failure(400, 'tick takes the ids of the lines');
  if (typeof ticked !== 'boolean') throw failure(400, 'ticked is true or false');
  await update(day, (entry) => ({ ...entry, ticks: { ...entry.ticks, ...Object.fromEntries(ids.map((id) => [id, ticked])) } }));
  return viewSaved(day);
}

async function tag({ day, id, ticket } = {}) {
  checkDay(day);
  const key = typeof ticket === 'string' ? ticket.trim().toUpperCase() : '';
  if (key && !KEY.test(key)) throw failure(400, `a ticket looks like ${exampleKey(jiraSettings().defaultProject)}`);
  const entry = (await loadDays())[day];
  const line = entry?.standup?.sections.flatMap((s) => s.groups).flatMap((g) => g.lines).find((l) => l.id === id);
  if (!line) throw failure(404, 'that line is not in the standup any more');
  if (line.tag !== NO_TICKET) throw failure(400, 'only a line with no ticket takes one');
  await update(day, (current) => {
    const tags = { ...current.tags };
    if (key) tags[id] = key;
    else delete tags[id];
    return { ...current, tags };
  });
  return viewSaved(day);
}
