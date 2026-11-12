import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MASTER, masterAgents } from './claudeagents.mjs';
import { typeIn } from './claudeterm.mjs';
import { engine, failure, requireEngine, still, supports, workspaceRoot } from './engine.mjs';
import { permissionRules, SERVER, toolTitles } from './mcptools.mjs';
import { loadSigning, signingHooks } from './slacksign.mjs';
import { APP_NAME, FOLDER } from './product.mjs';
import { stateDir } from './home.mjs';

const SERVER_SCRIPT = fileURLToPath(new URL('./mcpserver.mjs', import.meta.url));
const HISTORY_KEPT = 8;
const TITLE_CHARS = 60;
const MAX_TEXT = 8000;

let config = {};
let shell = {};
let current = null;
let writes = 0;

export const ACTIONS = {};

export const ROUTES = {
  'POST /api/claude/send': async ({ body }) => send(await body()),
  'POST /api/claude/new': () => newChat(),
  'POST /api/claude/open': async ({ body }) => reopen(await body()),
  'POST /api/claude/popout': () => popOut(),
  'POST /api/claude/dock': () => dock(),
  'POST /api/claude/on-top': async ({ body }) => keepOnTop(await body()),
};

export async function start(cfg, sh) {
  config = cfg ?? {};
  shell = sh ?? {};
  current = (await readJson(files().panel))?.current ?? null;
  await writeSessionFiles();
}

export function files() {
  const dir = join(config.stateDir ?? stateDir(), 'claude');
  return { dir, panel: join(dir, 'panel.json'), mcp: join(dir, 'mcp.json'), settings: join(dir, 'settings.json'), endpoint: join(dir, 'endpoint.json') };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

// Each write has a temp file of its own, since the panel and the terminal can both rewrite a file at once.
export async function writePrivate(path, value) {
  writes += 1;
  const temp = `${path}.${process.pid}.${writes}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

// Rewritten at every start: the session reads them again on each resume, and the port and the tool token change.
export async function writeSessionFiles() {
  const f = files();
  await mkdir(f.dir, { recursive: true, mode: 0o700 });
  await writePrivate(f.endpoint, shell.mcp ?? {});
  await writePrivate(f.settings, { permissions: permissionRules(), hooks: signingHooks(await loadSigning()) });
  const server = { type: 'stdio', command: process.execPath, args: [SERVER_SCRIPT], env: { ELECTRON_RUN_AS_NODE: '1', UNDERLINGS_MCP_ENDPOINT: f.endpoint } };
  await writePrivate(f.mcp, { mcpServers: { [SERVER]: server } });
}

// In the app the chat is Claude Code's, in the panel's terminal, so the headless chat is never run or waited on there.
const terminalApp = () => typeof shell.desktop?.openTerminal === 'function';

export function lastChat() {
  return masterAgents().find((a) => a.handle === current) ?? null;
}

export function currentAgent() {
  return terminalApp() ? null : lastChat();
}

export function forgetChat() {
  return setCurrent(null);
}

const byLatest = (a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0);

function homeShort(path) {
  const home = homedir();
  return path && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

export function view() {
  const win = shell.desktop?.claudeWindow?.() ?? null;
  const agents = terminalApp() ? [] : masterAgents();
  const now = currentAgent();
  const history = agents.filter((a) => a.handle !== now?.handle).sort(byLatest).slice(0, HISTORY_KEPT).map(({ handle, title, state, lastAt, alive }) => ({ handle, title, state, lastAt, alive }));
  return {
    available: supports('startClaudeAgent'),
    tools: Boolean(shell.mcp),
    current: now,
    history,
    cwd: homeShort(workspaceRoot(config)),
    canPopOut: typeof shell.desktop?.popOut === 'function',
    poppedOut: Boolean(win?.shown),
    onTop: win ? Boolean(win.onTop) : null,
    titles: toolTitles(),
  };
}

async function setCurrent(handle) {
  current = handle;
  await mkdir(files().dir, { recursive: true, mode: 0o700 });
  await writePrivate(files().panel, { current });
}

function titleOf(text) {
  const line = text.trim().split('\n')[0].replace(/\s+/g, ' ');
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

const sessionName = (now = new Date()) => `${FOLDER}-${now.toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;

// What the page saw is checked, so a message never answers a permission it was not shown, nor lands in a chat another window started.
export async function send({ text, expect } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw failure(400, 'type a message first');
  if (text.length > MAX_TEXT) throw failure(400, `a message is at most ${MAX_TEXT} characters`);
  if (terminalApp()) return typeIn(text);
  const agent = currentAgent();
  still(expect, { handle: agent?.handle ?? null, pending: agent?.ask?.id ?? null }, 'the Claude chat');
  if (!agent) return startSession(text);
  try {
    requireEngine('replyToAgent').replyToAgent(agent.handle, { text });
  } catch (err) {
    throw failure(409, err.message);
  }
  return { ok: true, handle: agent.handle, text: agent.ask ? 'Sent, in place of an answer to what it asked' : 'Sent' };
}

async function startSession(text) {
  const { startClaudeAgent } = requireEngine('startClaudeAgent');
  const cwd = workspaceRoot(config);
  if (!cwd) throw failure(409, 'no workspace root is set, so Claude has nowhere to work: set one in Settings');
  await writeSessionFiles();
  const f = files();
  const { handle } = await startClaudeAgent({ name: sessionName(), title: titleOf(text), prompt: text, cwd, kind: MASTER, args: ['--mcp-config', f.mcp, '--settings', f.settings] });
  await setCurrent(handle);
  return { ok: true, handle, text: 'Started a new chat' };
}

// A chat that falls off the history is only forgotten here; its session stays on disk, so claude --resume still finds it.
async function forgetOldest() {
  const old = masterAgents().filter((a) => a.handle !== current).sort(byLatest).slice(HISTORY_KEPT);
  for (const a of old.filter((x) => !x.alive)) await engine.removeWorktree(a.handle).catch(() => {});
}

async function newChat() {
  await setCurrent(null);
  if (supports('removeWorktree')) await forgetOldest();
  return { ok: true, text: 'New chat: what you send next starts it' };
}

async function reopen({ handle } = {}) {
  const agent = masterAgents().find((a) => a.handle === handle);
  if (!agent) throw failure(404, 'that chat is not kept any more');
  await setCurrent(handle);
  return { ok: true, text: `Back to ${agent.title}` };
}

function desktopCall(name) {
  const fn = shell.desktop?.[name];
  if (typeof fn !== 'function') throw failure(501, `only the ${APP_NAME} app opens Claude in a window of its own`);
  return fn;
}

export async function popOut() {
  await desktopCall('popOut')();
  shell.notify?.('matrix');
  return { ok: true };
}

// The page may not have heard the window was docked, so it is told to open the panel in place rather than bring the window back.
async function dock() {
  await desktopCall('dockClaude')();
  shell.notify?.('goto:claude-here');
  return { ok: true };
}

async function keepOnTop({ on } = {}) {
  if (typeof on !== 'boolean') throw failure(400, 'on is true or false');
  await desktopCall('claudeOnTop')(on);
  return { ok: true, text: on ? 'Claude stays on top of every window' : 'Claude no longer stays on top' };
}
