import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { COLOURS, DEFAULT_ID, newId, saveWorkspaces, validAccount } from '../lib/workspaces.mjs';

// What a new workspace takes from the one it copies: how it reads and shows things, never its tokens, its Setup or its history.
const COPIED = ['features.json', 'standup.json', 'qa.json', 'calendar.json', 'email.json', 'slack.json'];
const MAX_NAME = 40;
const PORT_TRIES = 50;

const refuse = (status, message) => Object.assign(new Error(message), { status });

/**
 * Creates, changes and removes workspaces in the list the app was started with, and starts or stops their workers to match.
 * `folders` names a workspace's config and engine state folders by id, and `agentsRunning` asks a worker how many agents it has going.
 */
export function createWorkspaceAdmin({ workspaces, file, supervisor, folders, isFree, agentsRunning, onChange = () => {} }) {
  const named = (id) => workspaces.find((w) => w.id === id) ?? null;
  const known = (id) => named(id) ?? (() => { throw refuse(404, `there is no workspace ${id}`); })();

  function saved() {
    saveWorkspaces(workspaces, file);
    onChange();
  }

  async function create({ name, account = '', colour, copyFrom = null } = {}) {
    const title = nameOf(name);
    const login = String(account ?? '').trim();
    if (!validAccount(login)) throw refuse(400, `"${login}" is not a cswap account number`);
    if (copyFrom) known(copyFrom);
    const id = newId(title, workspaces.map((w) => w.id));
    const workspace = { id, name: title, port: await freePort(), account: login, colour: COLOURS.includes(colour) ? colour : COLOURS[workspaces.length % COLOURS.length] };
    if (copyFrom) copySettings(copyFrom, id);
    workspaces.push(workspace);
    saved();
    supervisor.start(workspace);
    return { ok: true, text: `Made ${title}${copyFrom ? `, with ${named(copyFrom).name}'s settings` : ''}. It is starting`, workspace };
  }

  // A worker reads its account once, as it starts, so a new one starts it again.
  async function update({ id, name, colour, account } = {}) {
    const workspace = known(id);
    const said = [];
    if (name !== undefined && nameOf(name) !== workspace.name) {
      said.push(`renamed from ${workspace.name}`);
      workspace.name = nameOf(name);
    }
    if (colour !== undefined) {
      if (!COLOURS.includes(colour)) throw refuse(400, `a workspace's colour is one of ${COLOURS.join(', ')}`);
      if (colour !== workspace.colour) said.push(colour);
      workspace.colour = colour;
    }
    const login = account === undefined ? workspace.account : String(account).trim();
    if (!validAccount(login)) throw refuse(400, `"${login}" is not a cswap account number`);
    const moved = login !== workspace.account;
    workspace.account = login;
    if (moved) said.push(`${login ? `cswap account ${login}` : 'the default login'}, started again`);
    if (!said.length) return { ok: true, text: `Nothing about ${workspace.name} changed`, workspace };
    saved();
    if (moved) await supervisor.restart(id);
    return { ok: true, text: `Saved ${workspace.name}: ${said.join(', ')}`, workspace };
  }

  // Its folders stay, so nothing it held is lost to a slip; the reply says where they are.
  async function remove({ id } = {}) {
    if (id === DEFAULT_ID) throw refuse(409, 'Default cannot be removed');
    const workspace = known(id);
    const running = await agentsRunning(id).catch(() => 0);
    if (running) throw refuse(409, `${workspace.name} has ${running} ${running === 1 ? 'agent' : 'agents'} running. Stop ${running === 1 ? 'it' : 'them'} first`);
    await supervisor.retire(id);
    workspaces.splice(workspaces.indexOf(workspace), 1);
    saved();
    return { ok: true, text: `Removed ${workspace.name}. Its settings stay in ${folders.config(id)} and its history in ${dirname(folders.engine(id))} until you delete them` };
  }

  function copySettings(from, to) {
    const [source, target] = [folders.config(from), folders.config(to)];
    mkdirSync(target, { recursive: true });
    for (const name of COPIED) if (existsSync(join(source, name))) copyFileSync(join(source, name), join(target, name));
    const settings = readSettings(join(folders.engine(from), 'state.json'));
    if (!settings) return;
    mkdirSync(folders.engine(to), { recursive: true });
    writeFileSync(join(folders.engine(to), 'state.json'), `${JSON.stringify({ settings }, null, 2)}\n`);
  }

  async function freePort() {
    const taken = new Set(workspaces.map((w) => w.port));
    for (let port = Math.max(...taken) + 1, tries = 0; tries < PORT_TRIES; port += 1, tries += 1) {
      if (!taken.has(port) && (await isFree(port))) return port;
    }
    throw refuse(503, 'no free port near the other workspaces');
  }

  return { create, update, remove };
}

function nameOf(name) {
  const text = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (!text) throw refuse(400, 'a workspace needs a name');
  return text;
}

function readSettings(file) {
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8'))?.settings;
    return settings && typeof settings === 'object' ? settings : null;
  } catch {
    return null;
  }
}
