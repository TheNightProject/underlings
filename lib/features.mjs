import { join } from 'node:path';
import { writePrivate } from './connector.mjs';
import { failure } from './engine.mjs';
import { readJson } from './run.mjs';
import { configDir } from './home.mjs';

export const FEATURES = ['tickets', 'standup', 'qa', 'calendar', 'email', 'slack', 'game', 'leaderboard', 'artifacts'];
export const FRESH = { tickets: true, standup: true, qa: false, calendar: true, leaderboard: true, artifacts: true };
const LABELS = { tickets: 'Tickets', standup: 'Standup', qa: 'QA', calendar: 'Calendar', email: 'Email', slack: 'Slack', game: 'The game', leaderboard: 'Leaderboard', artifacts: 'Artifacts' };
const switches = new Map();
let shell = {};

export const featuresFile = () => join(configDir(), 'features.json');

export const ROUTES = {
  'GET /api/features': () => view(),
  'POST /api/features': async ({ body }) => save(await body()),
};

export function start(cfg, sh) {
  shell = sh ?? {};
}

// Email, Slack and the game had a switch of their own already, so theirs stays the one that counts.
export function ownSwitch(name, { on, set }) {
  switches.set(name, { on, set });
}

export async function readFeatures() {
  return (await readJson(featuresFile(), null)) ?? {};
}

const savedOn = (file, name) => (typeof file[name] === 'boolean' ? file[name] : FRESH[name]);

// Read afresh each time, so a switch flipped in another window is honoured by the next tick here.
export async function isOn(name) {
  const own = switches.get(name);
  if (own) return Boolean(await own.on().catch(() => false));
  return savedOn(await readFeatures(), name);
}

export async function view() {
  const file = await readFeatures();
  const own = await Promise.all(FEATURES.map((name) => (switches.has(name) ? isOn(name) : savedOn(file, name))));
  return Object.fromEntries(FEATURES.map((name, i) => [name, own[i]]));
}

async function save({ feature, on } = {}) {
  if (!FEATURES.includes(feature) || typeof on !== 'boolean') throw failure(400, `features takes { feature, on }, the feature one of ${FEATURES.join(', ')}`);
  const own = switches.get(feature);
  if (own) await own.set(on);
  else await writePrivate(featuresFile(), { ...(await readFeatures()), [feature]: on });
  shell.notify?.('features');
  return { ok: true, text: `${LABELS[feature]} ${on ? 'is on' : 'is off'}`, features: await view() };
}
