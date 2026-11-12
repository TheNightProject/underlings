import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterFetch, failure, inbox, requireEngine, supports } from './engine.mjs';
import { isOn } from './features.mjs';
import { readJson } from './run.mjs';
import { configDir, stateDir } from './home.mjs';

export const QA_STATUS = 'QA';
export const EXAMPLE_JQL = 'project = ABC AND status = QA';
export const EVERY_MS = 15 * 60_000;
const BUILD = 'buildQaBoard';
const MAX_JQL = 1000;
const MAX_STATUS = 60;
const GROUP = /^[\w.-]+(?:\/[\w.-]+)*$/;

let config = {};
let shell = {};
let running = null;
let queued = null;
let triedAt = 0;
let error = null;
let unsubscribe = () => {};
let stops = 0;
const checks = new Set();

export const ACTIONS = {};

export const ROUTES = {
  'GET /api/qa': () => read(),
  'POST /api/qa/refresh': () => refreshNow(),
  'GET /api/qa/settings': () => settingsView(),
  'POST /api/qa/settings': async ({ body }) => saveSettings(await body()),
};

export function start(cfg, sh) {
  config = cfg ?? {};
  shell = sh ?? {};
  unsubscribe = afterFetch(checkAfterFetch);
}

export function stop() {
  unsubscribe();
  stops += 1;
  queued = null;
  triedAt = 0;
  error = null;
}

export async function settled() {
  while (running || checks.size) await (running ?? Promise.all(checks));
}

function checkAfterFetch() {
  const check = refreshIfDue().catch(() => {}).finally(() => checks.delete(check));
  checks.add(check);
}

const stateFile = () => join(config.stateDir ?? stateDir(), 'qa.json');
const settingsFile = () => join(configDir(), 'qa.json');

async function writePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 });
  await chmod(path + '.tmp', 0o600);
  await rename(path + '.tmp', path);
}

async function loadBoard() {
  const saved = await readJson(stateFile(), null);
  return saved?.v === 1 && Array.isArray(saved.board?.tickets) ? saved.board : null;
}

const savedText = (value) => (typeof value === 'string' ? value.trim() : '');

export async function loadSettings() {
  const saved = (await readJson(settingsFile(), {})) ?? {};
  return { jql: savedText(saved.jql), status: savedText(saved.status) || QA_STATUS, group: savedText(saved.group) };
}

export function groupsFor({ group }) {
  return group || [...new Set((inbox?.mrs ?? []).filter((mr) => !mr.provider).map((mr) => mr.projectPath.split('/')[0]))].sort().join(', ');
}

async function settingsView() {
  const settings = await loadSettings();
  return { ...settings, ownGroups: groupsFor({ group: '' }), example: EXAMPLE_JQL, defaultStatus: QA_STATUS, on: await isOn('qa') };
}

const typedText = (value) => (value === null ? '' : typeof value === 'string' ? value : undefined);

const CHECKS = {
  jql: (value) => {
    const jql = typedText(value);
    if (jql === undefined || jql.trim().length > MAX_JQL || /[\r\n]/.test(jql)) throw failure(400, `the QA search is one line of JQL, such as ${EXAMPLE_JQL}`);
    return jql.trim();
  },
  status: (value) => {
    const status = typedText(value)?.trim();
    if (status === undefined || status.length > MAX_STATUS || /["\r\n]/.test(status)) throw failure(400, 'the QA status is one status name, such as QA');
    return status;
  },
  group: (value) => {
    const typed = typedText(value);
    if (typed === undefined) throw failure(400, 'the groups are GitLab group paths, comma separated, such as acme or acme/platform');
    const groups = typed.split(',').map((g) => g.trim()).filter(Boolean);
    if (groups.some((g) => !GROUP.test(g)) || groups.join(', ').length > MAX_JQL) throw failure(400, 'the groups are GitLab group paths, comma separated, such as acme or acme/platform');
    return groups.join(', ');
  },
};

const SAID = {
  jql: (s) => (s.jql ? `QA lists ${s.jql}` : 'QA has no search, so the board stays empty'),
  status: (s) => `Days in QA count from the last move to ${s.status}`,
  group: (s) => (s.group ? `QA joins MRs merged in ${s.group}` : 'QA joins MRs merged in the groups your open MRs are in'),
};

async function saveSettings(patch) {
  const fields = Object.keys(CHECKS).filter((key) => patch?.[key] !== undefined);
  if (!fields.length) throw failure(400, 'settings takes jql, status or group');
  const next = { ...((await readJson(settingsFile(), {})) ?? {}) };
  for (const key of fields) next[key] = CHECKS[key](patch[key]);
  await writePrivate(settingsFile(), next);
  await refreshIfDue(true);
  const view = await settingsView();
  return { ok: true, text: fields.map((key) => SAID[key](view)).join('. '), ...view };
}

// With no group named, the groups come from your open MRs, so a read before they are listed would join no MRs.
const readable = (settings) => Boolean(settings.jql && (settings.group || inbox));

async function ready() {
  return (await isOn('qa')) && readable(await loadSettings());
}

async function read() {
  requireEngine(BUILD);
  const [board, settings, on] = await Promise.all([loadBoard(), loadSettings(), isOn('qa')]);
  const configured = Boolean(settings.jql);
  if (on && readable(settings) && supports(BUILD)) refreshKept(board);
  return {
    on,
    configured,
    jql: settings.jql,
    status: settings.status,
    group: groupsFor(settings),
    example: EXAMPLE_JQL,
    refreshing: Boolean(running),
    error: on && configured ? error : null,
    board: on && configured && board ? { generatedAt: board.generatedAt, jql: board.jql, status: board.status ?? QA_STATUS, group: board.group, windowDays: board.windowDays, buckets: board.buckets, tickets: board.tickets } : null,
  };
}

// A restarted worker counts from the board it kept, so a restart does not ask Jira and GitLab again at once.
async function refreshIfDue(now = false) {
  const asked = stops;
  if (!supports(BUILD) || !(await ready())) return;
  const board = await loadBoard();
  if (asked === stops) refreshKept(board, now);
}

function refreshKept(board, now = false) {
  const last = Math.max(triedAt, Date.parse(board?.generatedAt) || 0);
  if (now || Date.now() - last >= EVERY_MS) refresh(false);
}

async function refreshNow() {
  requireEngine(BUILD);
  if (!(await isOn('qa'))) throw failure(409, 'QA is off: turn it on in Settings first');
  if (!(await loadSettings()).jql) throw failure(409, 'QA has no search yet: set the JQL for your tickets in QA in Settings');
  const busy = Boolean(running);
  refresh(true);
  return { ok: true, text: busy ? 'Reading QA again once the read in progress ends' : 'Reading QA from Jira and GitLab' };
}

function refresh(full) {
  if (running) {
    queued = full || queued === 'full' ? 'full' : 'since';
    return running;
  }
  triedAt = Date.now();
  running = build(full)
    .then(() => { error = null; })
    .catch((err) => { error = err.message; })
    .finally(() => {
      running = null;
      shell.notify?.('qa');
      const next = queued;
      queued = null;
      if (next) refresh(next === 'full');
    });
  return running;
}

async function build(full) {
  const engine = requireEngine(BUILD);
  const [board, settings] = await Promise.all([loadBoard(), loadSettings()]);
  const fresh = await engine.buildQaBoard({ jql: settings.jql, status: settings.status, group: groupsFor(settings), merged: board?.merged ?? null, full, priority: 'background' });
  await writePrivate(stateFile(), { v: 1, board: fresh });
}
