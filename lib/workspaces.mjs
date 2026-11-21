import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sharedConfigDir, WORKSPACE_ID } from './home.mjs';

export const DEFAULT_ID = 'default';
export const DEFAULT_PORT = 47321;
const ACCOUNT = /^\d{1,3}$/;
// Named, so the page and the menu bar colour a workspace the same way, and a saved one never names a colour that is not offered.
export const COLOURS = ['blue', 'green', 'amber', 'rose', 'violet', 'teal', 'slate'];
// What a workspace keeps for itself, so none of it is carried over from the app's own environment or your shell.
export const OWN_ENV = ['GITLAB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'UNDERLINGS_STATE_DIR', 'UNDERLINGS_CODE_FOLDER', 'CLAUDE_CONFIG_DIR'];

export const workspacesFile = () => join(sharedConfigDir(), 'workspaces.json');

/**
 * Default is always there, on the port in config.json and in the folders it always used. Every other
 * workspace names its own port, and the cswap account its agents run as; a blank account is the default login.
 */
export function readWorkspaces({ file = workspacesFile(), defaultPort = DEFAULT_PORT, log = () => {} } = {}) {
  const listed = readListed(file, log);
  const own = listed.find((w) => w?.id === DEFAULT_ID);
  const fallback = { id: DEFAULT_ID, name: 'Default', port: defaultPort, account: '', colour: COLOURS[0] };
  const workspaces = [{ ...fallback, name: nameOf(own) ?? fallback.name, account: accountOf(own), colour: colourOf(own, 0) }];
  for (const entry of listed) {
    if (entry?.id === DEFAULT_ID) continue;
    const why = refusal(entry, workspaces);
    if (why) {
      log(`left out a workspace in ${file}: ${why}`);
      continue;
    }
    workspaces.push({ id: entry.id, name: nameOf(entry) ?? entry.id, port: entry.port, account: accountOf(entry), colour: colourOf(entry, workspaces.length) });
  }
  return workspaces;
}

function readListed(file, log) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  try {
    const saved = JSON.parse(text);
    if (Array.isArray(saved?.workspaces)) return saved.workspaces;
  } catch {}
  log(`${file} is not a list of workspaces, so only Default runs`);
  return [];
}

function refusal(entry, taken) {
  if (!entry || typeof entry !== 'object') return 'an entry that is not an object';
  if (typeof entry.id !== 'string' || !WORKSPACE_ID.test(entry.id)) return `"${entry.id}" is not a workspace id: lower case letters, digits and dashes`;
  if (taken.some((w) => w.id === entry.id)) return `${entry.id} is listed twice`;
  if (!Number.isInteger(entry.port) || entry.port < 1024 || entry.port > 65535) return `${entry.id} has no port between 1024 and 65535`;
  const clash = taken.find((w) => w.port === entry.port);
  if (clash) return `${entry.id} wants port ${entry.port}, which ${clash.name} has`;
  if (entry.account !== undefined && entry.account !== '' && !ACCOUNT.test(String(entry.account))) return `${entry.id} names "${entry.account}", which is not a cswap account number`;
  return null;
}

const nameOf = (entry) => (typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim().slice(0, 40) : null);
const accountOf = (entry) => (entry?.account === undefined || entry.account === '' ? '' : String(entry.account));
const colourOf = (entry, i) => (COLOURS.includes(entry?.colour) ? entry.colour : COLOURS[i % COLOURS.length]);

export const validAccount = (account) => account === '' || ACCOUNT.test(account);

// Default's port lives in config.json, so its entry keeps only what the list adds to it.
export function saveWorkspaces(workspaces, file = workspacesFile()) {
  const entries = workspaces.map(({ id, name, port, account, colour }) => (id === DEFAULT_ID ? { id, name, account, colour } : { id, name, port, account, colour }));
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ workspaces: entries }, null, 2)}\n`);
  renameSync(temp, file);
}

// From the name, as a folder and a log are named after it, made unique against the ids already taken.
export function newId(name, taken) {
  const base = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace';
  const stem = base === DEFAULT_ID ? 'default-2' : base;
  if (!taken.includes(stem)) return stem;
  for (let n = 2; ; n += 1) if (!taken.includes(`${stem}-${n}`)) return `${stem}-${n}`;
}

// Default runs as the app always has, never as a workspace the app was somehow started as; any other workspace starts from
// the app's environment less everything it keeps for itself.
export function workerEnv(workspace, env = process.env) {
  if (workspace.id === DEFAULT_ID) {
    const { UNDERLINGS_WORKSPACE, ...rest } = env;
    return rest;
  }
  const own = Object.fromEntries(Object.entries(env).filter(([name]) => !OWN_ENV.includes(name)));
  return { ...own, UNDERLINGS_WORKSPACE: workspace.id };
}
