import { stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ANY_KEY, keyOf, keyParts } from './refs.mjs';

const MIN_POLL_MS = 60_000;
// The app packs the build at this same place beside lib/, so a checkout and the app each load their own.
const BUILT_ENGINE = fileURLToPath(new URL('../engine/dist/engine.js', import.meta.url));
export const MR_KEY = ANY_KEY;
export const BAD_KEY = 'key must look like group/repo!123 or owner/repo#123';

export let engine = null;
export let engineError = 'starting';
export let inbox = null;
export let fetchError = null;
export let fetchErrors = null;
let enginePath = null;
let engineUrl = null;
let engineStamp = null;
let fetching = null;
let inFlight = null;
let again = false;
let staleTimer = null;
let onFetched = () => {};
const afterFetches = new Set();

// A reload hands over the inbox, any fetch in flight and the engine module, so the page keeps its rows and GitLab is asked once.
export async function loadEngine(config, onChange, carried = null) {
  onFetched = onChange;
  inbox = carried?.inbox ?? null;
  fetchError = carried?.fetchError ?? null;
  fetchErrors = carried?.fetchErrors ?? null;
  enginePath = engineFile(config);
  try {
    const stamp = (await stat(enginePath)).mtimeMs;
    const url = engineUrlFor(carried, stamp);
    engine = await import(url);
    engineUrl = url;
    engineStamp = stamp;
    engineError = null;
    const sameEngine = url === carried?.engineUrl;
    if (sameEngine && carried.fetching) track(carried.fetching);
    else if (!sameEngine || !inbox) refreshInbox();
  } catch (err) {
    const error = `could not load the review engine from ${enginePath}: ${err.message}`;
    if (carried?.engineLoaded) throw failure(500, `${error}, so the running code stays`);
    engine = null;
    engineError = error;
  }
}

export function engineFile(config) {
  return config.matrixEngine ?? BUILT_ENGINE;
}

export async function reloadEngine(config) {
  await loadEngine(config, onFetched, { ...carry(), fetching: null });
  if (!engine) throw failure(500, engineError);
}

// Node remembers a failed import by its URL, so only an engine that loaded is imported again under the same one.
function engineUrlFor(carried, stamp) {
  const plain = pathToFileURL(enginePath).href;
  if (!carried) return plain;
  const unchanged = carried.engineLoaded && carried.enginePath === enginePath && carried.engineStamp === stamp;
  return unchanged ? carried.engineUrl : `${plain}?cc=${stamp}-${Date.now()}`;
}

export function retire() {
  again = false;
  clearTimeout(staleTimer);
  onFetched = () => {};
  afterFetches.clear();
}

export function carry() {
  return { inbox, fetchError, fetchErrors, enginePath, engineUrl, engineStamp, engineLoaded: Boolean(engine), fetching };
}

// A refresh asked for mid-fetch runs again afterwards, or an action's effect waits a whole poll to show.
export function refreshInbox() {
  if (!engine) return Promise.resolve();
  if (inFlight) {
    again = true;
    return inFlight;
  }
  return track(engine.fetchInbox(inbox));
}

// Full auto's poll joins a fetch in flight rather than asking for another after it.
export function freshInbox(maxAgeMs) {
  if (inFlight) return inFlight;
  const age = inbox ? Date.now() - Date.parse(inbox.fetchedAt) : Infinity;
  return age > maxAgeMs ? refreshInbox() : Promise.resolve();
}

function track(fetch) {
  fetching = fetch;
  inFlight = fetch
    .then((data) => {
      inbox = data;
      fetchError = null;
      fetchErrors = null;
      for (const fn of afterFetches) Promise.resolve().then(() => fn(data)).catch(() => {});
    })
    .catch((err) => {
      fetchError = err.message;
      fetchErrors = err.errors ?? null;
    })
    .finally(() => {
      inFlight = null;
      fetching = null;
      onFetched('matrix');
      if (again) {
        again = false;
        refreshInbox();
      }
    });
  return inFlight;
}

// The page asks only every 30 s, so a shorter saved poll needs the worker to wake itself; each page read sets it again.
export function refreshIfStale(settings) {
  clearTimeout(staleTimer);
  if (inFlight) return;
  const wait = inbox ? Date.parse(inbox.fetchedAt) + pollEveryMs(settings) - Date.now() : 0;
  if (Number.isNaN(wait)) return;
  if (wait > 0) staleTimer = setTimeout(refreshIfStale, wait, settings).unref();
  else refreshInbox();
}

export function pollEveryMs(settings) {
  return Math.max(Number(settings?.pollSeconds) * 1000 || 0, pollFloorMs());
}

// The engine's own lowest setting, so a saved poll is honoured; an engine too old to say keeps the old minute.
function pollFloorMs() {
  const min = engine?.SETTING_ROWS?.find((row) => row.key === 'pollSeconds')?.bounds?.min;
  return min ? min * 1000 : MIN_POLL_MS;
}

export function notify(event) {
  onFetched(event);
}

export function loading() {
  return Boolean(inFlight);
}

export function afterFetch(fn) {
  afterFetches.add(fn);
  return () => afterFetches.delete(fn);
}

// The page and the engine ship separately, so an engine built before a feature must not break the page.
export function supports(name) {
  return typeof engine?.[name] === 'function';
}

const JIRA_FALLBACK = { projects: '', defaultProject: '', statuses: '', doneStatuses: '', issueType: 'Task', ticketTemplate: '' };
export const DEFAULT_GITLAB_HOST = 'https://gitlab.com';

export function gitlabHost() {
  return supports('gitlabHost') ? engine.gitlabHost() : DEFAULT_GITLAB_HOST;
}

export function jiraSettings() {
  return { ...JIRA_FALLBACK, ...(supports('loadSettings') ? engine.loadSettings().jira : null) };
}

export function ticketSettings() {
  return { noQaPaths: '', ...(supports('loadSettings') ? engine.loadSettings().tickets : null) };
}

export function workspaceRoot(config) {
  const matrixRoot = supports('loadSettings') ? engine.loadSettings().workspaceRoot : '';
  return config.workspaceRoot || matrixRoot || process.env.ORCA_WORKSPACE_ROOT || null;
}

export function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

export function requireEngine(...names) {
  if (!engine) throw failure(503, engineError);
  const missing = names.filter((name) => !supports(name));
  if (missing.length) throw failure(501, `The review engine needs rebuilding: this build has no ${missing.join(', ')}`);
  return engine;
}

export const GITLAB = Object.freeze({ provider: 'gitlab' });

// A GitHub name is never taken for you on GitLab, nor the other way round, so a fix agent can never push to someone else's branch.
export function meFor(mr) {
  if (mr?.provider === 'github') return inbox?.accounts?.github ?? null;
  return inbox?.accounts?.gitlab ?? inbox?.me ?? null;
}

export const githubOn = () => supports('loadSettings') && engine.loadSettings().github?.on === true;

// A forge switched off answers 409, so a stale tab cannot reach one the user turned off.
function forgeOfRef(ref) {
  try {
    return requireEngine('forgeOf').forgeOf(ref);
  } catch (err) {
    throw err.status ? err : failure(409, err.message);
  }
}

// A method an older build's forge lacks answers 501, as a missing export does.
export function forgeFor(ref, ...methods) {
  const forge = forgeOfRef(ref);
  const missing = methods.filter((name) => typeof forge[name] !== 'function');
  if (missing.length) throw failure(501, `The review engine needs rebuilding: this build has no ${missing.join(', ')}`);
  return forge;
}

export function forgeHas(ref, method) {
  if (!supports('forgeOf')) return false;
  try {
    return typeof engine.forgeOf(ref)[method] === 'function';
  } catch {
    return false;
  }
}

// A flag a forge leaves out is one it can do, so only a false refuses.
export function forgeCan(forge, cap, what) {
  if (!forge.caps || forge.caps[cap] === false) throw failure(400, `${forge.name} has no way to ${what}`);
}

export function still(expected, actual, what) {
  if (expected === undefined) throw failure(400, `the page did not send what it saw of ${what}`);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw failure(409, `${what} changed since you looked`);
}

export function mrFor(key) {
  if (!inbox) throw failure(503, 'the MR list has not loaded yet');
  const row = inbox.mrs.find((mr) => keyOf(mr) === key);
  if (!row) throw failure(404, `${key} is not in the open list any more`);
  return row;
}

export function rowFor(key) {
  return engine.rowsFor(inbox).find((row) => row.key === key);
}

// The agent list predates any launch made since it was read, so a run started after it counts as an agent on the MR as well.
export function agentCheck(watches = engine.loadState().watches, runs = engine.loadRuns()) {
  if (!supports('agentOnFor') || !inbox) return () => false;
  const on = engine.agentOnFor(watches ?? {}, runs, inbox.terminals ?? [], { listedAt: inbox.listedAt });
  return (key) => {
    const ref = keyParts(key);
    return ref !== null && on(ref);
  };
}

export function agentReading(key) {
  return Boolean(rowFor(key)?.agent) || agentCheck()(key);
}

export function sendingNow(id) {
  const by = engine.loadQueue().find((c) => c.id === id)?.sending?.by ?? '';
  return by.startsWith('auto:') ? 'full auto is sending this right now' : 'this is being posted already';
}

export function pendingItem(id) {
  const item = engine.loadQueue().find((c) => c.id === id);
  if (!item || item.status !== 'pending') throw failure(409, 'that item is not waiting to be posted any more');
  return item;
}

// Posting everything for an MR that has since merged still has to work, so its queue items stand in for it.
export function mrOrQueued(key) {
  const listed = inbox?.mrs.find((mr) => keyOf(mr) === key);
  if (listed) return listed;
  const item = engine.loadQueue().find((c) => keyOf(c) === key);
  if (!item) throw failure(404, `nothing is known about ${key}`);
  return { projectPath: item.projectPath, projectId: item.projectId, iid: item.iid, webUrl: item.webUrl, mergeStatus: null, sha: null };
}
