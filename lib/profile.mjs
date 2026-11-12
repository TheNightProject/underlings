import { join } from 'node:path';
import { writePrivate } from './connector.mjs';
import { failure, forgeFor, forgeHas, GITLAB } from './engine.mjs';
import { readJson, run } from './run.mjs';
import { configDir } from './home.mjs';

const MAX_NAME = 60;
const MAX_LANGUAGE = 60;
const MAX_RULES = 1000;
const LOOKUP_MS = 5000;
const NO_EM_DASH = /\bem[\s-]?dash|\u2014/i;

let shell = {};
let suggestion = null;

export const ROUTES = {
  'GET /api/profile': () => view(),
  'POST /api/profile': async ({ body }) => save(await body()),
};

export function start(cfg, sh) {
  shell = sh ?? {};
  suggestion = null;
}

export const profileFile = () => join(configDir(), 'profile.json');

const oneLine = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const rulesText = (value) => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, MAX_RULES) : '');
const stamp = (value) => (typeof value === 'string' && Date.parse(value) ? value : null);

export function profileOf(saved) {
  return {
    user: { name: oneLine(saved?.user?.name, MAX_NAME), askedAt: stamp(saved?.user?.askedAt) },
    style: { language: oneLine(saved?.style?.language, MAX_LANGUAGE), rules: rulesText(saved?.style?.rules) },
  };
}

export async function loadProfile() {
  return profileOf(await readJson(profileFile(), {}));
}

// Every phrase that uses these reads the same with a name or with "you", so the subject is never followed by a present-tense verb.
export function person(profile) {
  const name = profile?.user?.name;
  return name ? { who: name, whose: `${name}'s` } : { who: 'you', whose: 'your' };
}

export const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

export const inLanguage = (profile) => (profile?.style?.language ? `, in ${profile.style.language}` : '');

export const writingRules = (profile, what) => (profile?.style?.rules ? `Writing rules for ${what}: ${profile.style.rules}` : null);

export function styleLines(profile, what) {
  const language = profile?.style?.language;
  return [language ? `Write ${what} in ${language}.` : null, writingRules(profile, what)].filter(Boolean);
}

export const wantsNoEmDash = (profile) => NO_EM_DASH.test(profile?.style?.rules ?? '');

export const undashed = (text, profile) => (wantsNoEmDash(profile) ? text.replace(/\s*\u2014\s*/g, ', ') : text);

export const firstName = (full) => oneLine(String(full ?? ''), MAX_NAME).split(' ')[0];

async function view() {
  const profile = await loadProfile();
  const ask = !profile.user.name && !profile.user.askedAt;
  return { name: profile.user.name, ask, suggested: ask ? await suggestedName() : '', style: profile.style };
}

const giveUp = (ms) => new Promise((resolve) => setTimeout(resolve, ms, '').unref?.());

function suggestedName() {
  suggestion ??= Promise.race([lookUpName(), giveUp(LOOKUP_MS)]).catch(() => '');
  return suggestion;
}

async function lookUpName() {
  const gitlab = firstName(forgeHas(GITLAB, 'myName') ? await forgeFor(GITLAB).myName().catch(() => '') : '');
  return gitlab || firstName(await run('git', ['config', '--global', '--get', 'user.name'], process.env, { timeout: LOOKUP_MS }).catch(() => ''));
}

const typedIn = (patch, key) => typeof patch[key] === 'string';

async function save(patch = {}) {
  const saved = (await readJson(profileFile(), null)) ?? {};
  const said = changes(patch);
  if (!said.length) throw failure(400, 'the profile takes name, skip, language or rules');
  const typed = (key) => typedIn(patch, key);
  const user = { ...saved.user, ...(typed('name') ? { name: oneLine(patch.name, MAX_NAME) } : {}), askedAt: stamp(saved.user?.askedAt) ?? new Date().toISOString() };
  const style = { ...saved.style, ...(typed('language') ? { language: oneLine(patch.language, MAX_LANGUAGE) } : {}), ...(typed('rules') ? { rules: rulesText(patch.rules) } : {}) };
  await writePrivate(profileFile(), { ...saved, user, style });
  shell.notify?.('profile');
  const answer = await view();
  return { ok: true, text: said.map((say) => say(answer)).join('. '), ...answer };
}

function changes(patch) {
  const typed = (key) => typedIn(patch, key);
  return [
    typed('name') ? (a) => (a.name ? `Prompts call you ${a.name}` : 'Prompts say "you", with no name') : null,
    patch.skip === true && !typed('name') ? () => 'Prompts say "you". Set a name in Settings whenever you like' : null,
    typed('language') ? (a) => (a.style.language ? `Prompts ask for ${a.style.language}` : 'Prompts write in your own language') : null,
    typed('rules') ? (a) => (a.style.rules ? 'Your writing rules go into every prompt' : 'Prompts carry no writing rules') : null,
  ].filter(Boolean);
}
