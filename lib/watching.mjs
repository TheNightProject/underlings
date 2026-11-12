import { BAD_KEY, engine, failure, inbox, MR_KEY, mrFor, requireEngine, still, supports } from './engine.mjs';
import { keyOf as mrKey, shortKey as named } from './refs.mjs';
import { adoptGitHubEnv } from './selfheal.mjs';
import { changeOf, movedWords } from './since.mjs';

const MAX_FILTER = 500;
const UNITS = { pollSeconds: 's', autoHoldSeconds: 's', leaderboardDays: ' days', autoMaxDiffLines: ' lines', maxAgents: ' at once' };

export const ACTIONS = {
  watch,
  unwatch: { verify: verifyUnwatch, run: unwatch },
  auto,
  seen,
  schedule: { verify: verifySchedule, run: schedule },
  unschedule: { verify: verifyUnschedule, run: unschedule },
  'move-automation': { verify: verifyMove, run: moveAutomation },
  settings,
  discover,
};

export const ROUTES = {
  'GET /api/matrix/watching': () => readWatching(),
  'GET /api/matrix/settings': ({ query }) => readSettings(query.get('filter'), query.get('poll')),
};

export function readWatching() {
  const { watchRows } = requireEngine('watchRows');
  if (!inbox) throw failure(503, 'the MR list has not loaded yet');
  const mrs = new Map(inbox.mrs.map((mr) => [mrKey(mr), mr]));
  const rows = watchRows(engine.loadState().watches, inbox.mrs, inbox.agents ?? new Map());
  return { fetchedAt: inbox.fetchedAt, rows: rows.map((row) => summariseWatchRow(row, mrs)) };
}

function summariseWatchRow({ watch, repoLabel, stillOpen, moved, agent }, mrs) {
  const mr = mrs.get(watch.key);
  return {
    key: watch.key,
    iid: watch.iid,
    repo: repoLabel,
    title: mr?.title ?? null,
    webUrl: watch.webUrl,
    auto: Boolean(watch.auto),
    automation: watch.automation ?? null,
    daily: watch.daily?.nextAt ?? null,
    agent: agent ?? null,
    stillOpen,
    moved,
    movedWhy: moved && mr ? movedWords(changeOf(watch, mr)) : null,
    reviewedAt: watch.reviewedAt ?? null,
    addedAt: watch.addedAt ?? null,
  };
}

export function readSettings(filter, poll) {
  const { repoMatch } = requireEngine('repoMatch', 'updateSettings');
  if (filter != null && filter.length > MAX_FILTER) throw failure(400, 'that filter is too long');
  const saved = engine.loadSettings();
  const rows = editableRows().map(({ key, label, hint, kind, bounds, choices }) => ({ key, label, hint, kind, bounds: bounds ?? null, choices: choices ?? null, value: valueOf(saved, key) }));
  const asked = filter ?? saved.repoFilter ?? '';
  return { rows, agents: saved.agents ?? null, repos: { filter: asked, ...repoMatch(asked, poll ?? saved.pollSeconds) } };
}

function editableRows() {
  return [...(engine.SETTING_ROWS ?? []), ...(engine.NESTED_ROWS ?? [])].filter((row) => row.kind !== 'people');
}

const valueOf = (saved, key) => (key.includes('.') && supports('nestedValue') ? engine.nestedValue(saved, key) : saved[key] ?? null);

function keyOf({ key }) {
  if (typeof key !== 'string' || !MR_KEY.test(key)) throw failure(400, BAD_KEY);
  return key;
}

const watchOf = (key) => engine.loadState().watches[key] ?? null;

function watch(payload) {
  const key = keyOf(payload);
  const mr = mrFor(key);
  if (engine.isWatched(key)) return `Already watching ${named(key)}`;
  engine.toggleWatch(mr);
  return `Watching ${named(key)}, so it shows as moved when it changes`;
}

const scheduleOf = (watch) => ({ daily: watch?.daily?.nextAt ?? null, automation: watch?.automation ?? null });

function verifyUnwatch(payload) {
  if (payload.closed) return verifyClosed(payload);
  const key = keyOf(payload);
  const live = watchOf(key);
  if (!live) throw failure(404, `${named(key)} is not being watched`);
  still(payload.expect ?? { daily: null, automation: null }, scheduleOf(live), `the daily re-review on ${named(key)}`);
  return { key, ...scheduleOf(live) };
}

function unwatch(payload, live) {
  if (payload.closed) return clearClosed(live);
  engine.stopWatching(live.key);
  return [`Stopped watching ${named(live.key)}`, live.daily && 'and its daily re-review', orcaLeft(live.automation)].filter(Boolean).join(', ');
}

// Orca's own automations are never deleted from here, so a watch that had one says where it still runs.
function orcaLeft(automation) {
  return automation ? `Orca still has its automation ${automation}: delete it from Orca's automations, or it runs there too` : null;
}

async function verifyClosed(payload) {
  const { hasClosed } = requireEngine('hasClosed');
  if (!inbox?.mrs.length) throw failure(503, 'the MR list has not loaded, so which MRs have closed is not known');
  const missing = missingWatches();
  still(payload.expect, { keys: missing.map((w) => w.key) }, 'the closed watches');
  const asked = await Promise.allSettled(missing.map((w) => hasClosed(w)));
  const sorted = { closed: [], open: [], unasked: [] };
  missing.forEach((w, n) => sorted[gitlabSays(asked[n])].push(w));
  return sorted;
}

function gitlabSays({ status, value }) {
  if (status === 'rejected') return 'unasked';
  return value ? 'closed' : 'open';
}

function missingWatches() {
  const open = new Set(inbox.mrs.map(mrKey));
  return Object.values(engine.loadState().watches)
    .filter((w) => !open.has(w.key))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function clearClosed({ closed, open, unasked }) {
  for (const w of closed) engine.stopWatching(w.key);
  const inOrca = closed.filter((w) => w.automation);
  return [
    `Stopped watching ${closed.length} closed MR${closed.length === 1 ? '' : 's'}`,
    inOrca.length && `Orca still has automations for ${names(inOrca)}: delete them from Orca's automations`,
    open.length && `${names(open)} kept, as GitLab still has ${open.length === 1 ? 'it' : 'them'} open`,
    unasked.length && `${names(unasked)} kept, as GitLab could not be asked about ${unasked.length === 1 ? 'it' : 'them'}`,
  ].filter(Boolean).join('. ');
}

function names(watches) {
  return watches.map((w) => named(w.key)).join(', ');
}

function auto(payload) {
  const key = keyOf(payload);
  const on = payload.auto === true;
  if (!watchOf(key)) {
    if (!on) return `${named(key)} is not being watched`;
    engine.toggleWatch(mrFor(key));
  }
  engine.setAuto(key, on);
  return on ? `Auto re-review on for ${named(key)}: a fresh review launches when it moves` : `Auto re-review off for ${named(key)}`;
}

function seen(payload) {
  const key = keyOf(payload);
  engine.markSeen([mrFor(key)]);
  return `Marked ${named(key)} seen`;
}

function verifySchedule(payload) {
  const key = keyOf(payload);
  requireEngine('scheduleReReview', 'moveAutomation');
  const mr = mrFor(key);
  const live = scheduleOf(watchOf(key));
  still(payload.expect, live, `the daily re-review on ${named(key)}`);
  if (live.daily || live.automation) throw failure(409, `${named(key)} already has a daily re-review`);
  return { key, mr };
}

// The schedule is in the review engine's state folder, and whichever front end drives full auto takes each day's look.
function schedule(payload, { key, mr }) {
  if (!engine.isWatched(key)) engine.toggleWatch(mr);
  engine.scheduleReReview(mr);
  return `Daily re-review scheduled for ${named(key)}. It looks once a day, and reviews only on days the MR has moved`;
}

function verifyUnschedule(payload) {
  const key = keyOf(payload);
  requireEngine('unscheduleReReview', 'moveAutomation');
  const live = scheduleOf(watchOf(key));
  still(payload.expect, live, `the daily re-review on ${named(key)}`);
  if (!live.daily) throw failure(404, `${named(key)} has no daily re-review here`);
  return { key };
}

function unschedule(payload, { key }) {
  engine.unscheduleReReview(key);
  return `Stopped the daily re-review on ${named(key)}`;
}

function verifyMove(payload) {
  const key = keyOf(payload);
  requireEngine('moveAutomation');
  const live = scheduleOf(watchOf(key));
  still(payload.expect, live, `the daily re-review on ${named(key)}`);
  if (!live.automation) throw failure(404, `${named(key)} has no Orca automation to move`);
  return { key };
}

function moveAutomation(payload, { key }) {
  const automation = engine.moveAutomation(key);
  return `Moved the daily re-review on ${named(key)} to the schedule here. ${orcaLeft(automation)}`;
}

function settings({ patch }) {
  const { updateSettings } = requireEngine('updateSettings');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw failure(400, 'settings takes { patch: { name: value } }');
  const { settings: saved, applied, dropped } = updateSettings(patch);
  if (!applied.length) throw failure(400, `nothing saved: ${dropped.join(', ')} ${dropped.length === 1 ? 'is' : 'are'} not a setting the page can change, or the value is not one it takes`);
  if (applied.includes('github.on') && saved.github.on) adoptGitHubEnv().catch(() => {});
  const said = applied.map((key) => describe(key, valueOf(saved, key), patch[key])).join(', ');
  return `Saved ${said}${dropped.length ? `. Ignored ${dropped.join(', ')}` : ''}`;
}

function describe(key, value, asked) {
  const row = editableRows().find((r) => r.key === key);
  const shown = typeof value === 'boolean' ? (value ? 'on' : 'off') : value === '' ? 'blank' : row?.kind === 'lines' ? 'saved' : `${value}${UNITS[key] ?? ''}`;
  const clamped = row?.kind === 'number' && Number(asked) !== value ? `, the nearest it goes to ${asked}` : '';
  return `${row?.label ?? key}: ${shown}${clamped}`;
}

async function discover() {
  const { rediscoverRepos } = requireEngine('rediscoverRepos');
  const found = await rediscoverRepos();
  if (!found.length) throw new Error('GitLab listed no repos with open MRs, so the list found before stays');
  return `Found ${found.length} repos with open MRs. The MR list refreshes with them now`;
}
