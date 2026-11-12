import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { buildInfo, ROOT, statePath, writePrivate } from './build.mjs';
import { compareVersions, HEADLINE, linesSince, parseChangelog } from './changelog.mjs';
import { readJson } from './run.mjs';
import * as selfupdate from './selfupdate.mjs';

const BANNER_LINES = 8;
let config = {};

export const ACTIONS = {};

export const ROUTES = {
  'GET /api/whatsnew': () => view(),
  'POST /api/whatsnew/seen': () => markSeen(),
};

export function start(cfg) {
  config = cfg ?? {};
}

const changelogFile = () => join(config.buildRoot ?? ROOT, 'CHANGELOG.md');

export async function summary() {
  const info = await buildInfo(config);
  return { ...info, banner: await bannerFor(info), updates: selfupdate.brief() };
}

async function view() {
  const info = await buildInfo(config);
  const text = await readFile(changelogFile(), 'utf8').catch(() => null);
  const { intro, sections } = parseChangelog(text ?? '');
  return {
    ...info,
    banner: await bannerFor(info),
    changelog: text === null ? null : { intro, sections: sections.map(({ version, date, body }) => ({ version, date, body })) },
    updates: selfupdate.status(),
  };
}

async function bannerFor(info) {
  const [seen, pending, install] = await Promise.all(['release-seen.json', 'update.json', 'update-install.json'].map((name) => readJson(statePath(config, name))));
  if (pending?.phase === 'installing' && pending.to !== info.commit && !superseded(info, pending)) return failedBanner(info, pending, install);
  if (pending?.to && pending.to === info.commit) return headline(info, pending.lines ?? {}, true);
  if (!info.version || compareVersions(info.version, seen?.version ?? '0.0.0') <= 0) return null;
  const { sections } = parseChangelog(await readFile(changelogFile(), 'utf8').catch(() => ''));
  return headline(info, linesSince(sections, seen?.version, info.version), false);
}

function headline(info, lines, fromUpdate) {
  const all = HEADLINE.flatMap((name) => (lines[name] ?? []).map((line) => [name, line]));
  const shown = all.slice(0, BANNER_LINES);
  const total = Object.values(lines).reduce((n, list) => n + list.length, 0);
  return {
    kind: 'updated', version: info.version, commit: fromUpdate ? info.commit : null,
    groups: Object.fromEntries(HEADLINE.map((name) => [name, shown.filter(([group]) => group === name).map(([, line]) => line)])),
    more: total - shown.length,
  };
}

// A build made after the update was asked for has replaced whatever that update did, so its record says nothing about this one.
const superseded = (info, pending) => Boolean(info.builtAt && pending.at && Date.parse(info.builtAt) > Date.parse(pending.at));

function failedBanner(info, pending, install) {
  const error = install?.phase === 'done' && install.ok === false ? install.error : 'the install did not finish';
  return { kind: 'failed', version: info.version, commit: info.commit, wanted: pending.to, error };
}

async function markSeen() {
  const info = await buildInfo(config);
  await writePrivate(statePath(config, 'release-seen.json'), { version: info.version, commit: info.commit, at: new Date().toISOString() });
  await Promise.all(['update.json', 'update-install.json'].map((name) => rm(statePath(config, name), { force: true })));
  return { ok: true, text: `Marked ${info.version ?? 'this version'} as seen` };
}
