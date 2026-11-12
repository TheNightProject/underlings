import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { delimiter, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { forgetChat, lastChat, files as panelFiles, writePrivate, writeSessionFiles } from './claudepanel.mjs';
import { carrySession, cswapConfigDir, defaultConfigDir } from './claudesession.mjs';
import { failure, requireEngine, workspaceRoot } from './engine.mjs';
import { permissionRules } from './mcptools.mjs';
import { panelLaunch } from './models.mjs';
import { modelArgs, subagentEnv } from './modeltiers.mjs';
import { readJson, run, shellQuoted } from './run.mjs';
import { loadSigning, signingHooks } from './slacksign.mjs';
import { APP_NAME } from './product.mjs';

const HOOK_SCRIPT = fileURLToPath(new URL('./claudehook.mjs', import.meta.url));
export const HOOKED = ['Notification', 'Stop', 'UserPromptSubmit'];
const HOOK_TIMEOUT_S = 5;
const MESSAGE_CHARS = 200;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ASSET_TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const OTHER_TERMINAL = /^(TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|ITERM_\w+|LC_TERMINAL\w*)$/;
export const TARGET = 'claude-code';
const HANDLE = 'claude:';

let config = {};
let shell = {};
let ask = null;
let unhook = null;
const listeners = new Set();

export const ACTIONS = {};

export const ROUTES = {
  'POST /api/claude/terminal/open': () => open(),
  'POST /api/claude/terminal/new': () => newSession(),
  'POST /api/hook/claude': async ({ body }) => heard(await body()),
  'GET /api/claude/account': () => accountView(),
  'POST /api/claude/account': async ({ body }) => saveAccount(await body()),
  'GET /vendor/*': ({ path }) => asset(path),
};

export function start(cfg, sh) {
  config = cfg ?? {};
  shell = sh ?? {};
  unhook = shell.desktop?.onTerminalTyped?.(typed) ?? null;
}

export function stop() {
  unhook?.();
  unhook = null;
}

export const available = () => typeof shell.desktop?.openTerminal === 'function';
export const terminalAsk = () => ask;

export function view() {
  return { available: available(), asking: Boolean(ask) };
}

export function afterAsk(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function files() {
  const { dir, mcp } = panelFiles();
  return { dir, mcp, settings: join(dir, 'terminal-settings.json'), hooks: join(dir, 'hook-endpoint.json'), session: join(dir, 'terminal.json'), account: join(dir, 'account.json') };
}

export function terminalSettings(hookEndpoint, signing, node = process.execPath) {
  const command = ['ELECTRON_RUN_AS_NODE=1', ...[node, HOOK_SCRIPT, hookEndpoint].map(shellQuoted)].join(' ');
  const hook = { hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] };
  return { permissions: permissionRules(), hooks: { ...Object.fromEntries(HOOKED.map((event) => [event, [hook]])), ...signingHooks(signing, node) } };
}

async function writeFiles() {
  await writeSessionFiles();
  const f = files();
  await writePrivate(f.hooks, shell.hooks ?? {});
  await writePrivate(f.settings, terminalSettings(f.hooks, await loadSigning()));
  return f;
}

const accountOf = (cfg) => String(cfg.claudeAccount ?? '').trim();

// The choice made in Settings wins, and config.json's claudeAccount covers a machine that never made one.
async function account() {
  const saved = await readJson(files().account, null);
  return typeof saved?.account === 'string' ? saved.account : accountOf(config);
}

async function cswapAccounts() {
  const cswap = await onPath('cswap', process.env.PATH);
  if (!cswap) return null;
  const listed = JSON.parse(await run(cswap, ['list', '--json'], process.env, { timeout: 10_000 }));
  return (listed.accounts ?? []).map((a) => ({ number: String(a.number), email: a.email ?? '', org: a.organizationName ?? '', active: Boolean(a.active) }));
}

async function accountView() {
  const accounts = await cswapAccounts().catch(() => null);
  return { account: await account(), accounts: accounts ?? [], cswap: accounts !== null };
}

async function saveAccount(body) {
  const chosen = String(body?.account ?? '').trim();
  const view = await accountView();
  if (chosen && !view.accounts.some((a) => a.number === chosen)) throw failure(400, `cswap has no account ${chosen}`);
  await writePrivate(files().account, { account: chosen });
  const text = chosen ? `Claude Code runs as account ${chosen} from its next start` : 'Claude Code uses the default login from its next start';
  return { ok: true, text, ...view, account: chosen };
}

// Each account keeps its own history under cswap, so a session is only resumed under the account that made it.
async function session(current, launch) {
  const saved = await readJson(files().session);
  if (saved && SESSION.test(saved.id) && saved.account === current) return saved;
  const carried = saved ? null : await carryPanelChat(current, launch).catch((err) => shell.log?.(`the panel's chat did not carry over: ${err.message}`));
  return saveSession(carried ?? freshSession(current));
}

// The model goes on the session, so opening it again resumes it on the model it started with.
const freshSession = (account) => ({ id: randomUUID(), resumable: false, account, ...panelLaunch() });

const launchOfChat = ({ model, effort, subagentModel, subagentForce }) => Object.fromEntries(Object.entries({ model, effort, subagentModel, subagentForce }).filter(([, v]) => v));

// The first time, the panel's chat carries on here, its runner stopped first, since two processes on one session would collide.
async function carryPanelChat(account, { env, cswap }) {
  const chat = lastChat();
  if (!chat) return null;
  const id = chat.handle.slice(HANDLE.length);
  if (chat.alive) await requireEngine('stopAgent').stopAgent(chat.handle);
  const to = account && cswap ? await cswapConfigDir({ cswap, account, env, shimDir: join(files().dir, 'where') }) : defaultConfigDir(env);
  if (!(await carrySession(id, defaultConfigDir(process.env), to))) return null;
  await forgetChat();
  return { id, resumable: true, account, ...launchOfChat(chat) };
}

async function saveSession(value) {
  await writePrivate(files().session, value);
  return value;
}

export function launchSpec({ id, resumable, account, cswap, claude, mcp, settings, model, effort }) {
  const args = ['--mcp-config', mcp, '--settings', settings, ...modelArgs({ model, effort }), ...(resumable ? ['--resume', id] : ['--session-id', id])];
  if (!account) return { file: claude, args, notice: null };
  if (!cswap) return { file: claude, args, notice: `cswap is not on your PATH, so this is plain claude rather than account ${account}.` };
  return { file: cswap, args: ['run', account, '--', ...args], notice: null };
}

export async function onPath(name, path = '') {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    const file = join(dir, name);
    if (await access(file, constants.X_OK).then(() => true, () => false)) return file;
  }
  return null;
}

// Left by the terminal the app was started from, these would describe a terminal Claude Code is not in.
function terminalEnv(env) {
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !OTHER_TERMINAL.test(name)));
  return { ...kept, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: kept.LANG || 'en_GB.UTF-8' };
}

export async function prepare() {
  const cwd = workspaceRoot(config);
  if (!cwd) throw failure(409, 'no workspace root is set, so Claude Code has nowhere to work: set one in Settings');
  const engine = requireEngine('claudeBinary', 'childEnv');
  const f = await writeFiles();
  const claude = engine.claudeBinary();
  const env = terminalEnv(engine.childEnv(claude));
  const current = await account();
  const cswap = current ? await onPath('cswap', env.PATH) : null;
  const s = await session(current, { env, cswap });
  return { ...launchSpec({ ...s, cswap, claude, mcp: f.mcp, settings: f.settings }), cwd, env: { ...env, ...subagentEnv({ model: s.subagentModel, force: s.subagentForce }) } };
}

function desktopCall(name) {
  const fn = shell.desktop?.[name];
  if (typeof fn !== 'function') throw failure(501, `only the ${APP_NAME} app runs Claude Code in a window of its own`);
  return fn;
}

export async function open() {
  const openTerminal = desktopCall('openTerminal');
  await openTerminal(await prepare());
  return { ok: true };
}

// Opened from outside the page, by a shortcut or a banner, so the page is told to show the panel it lives in.
export async function summon() {
  await open();
  shell.notify?.('goto:claude');
  return { ok: true };
}

// The page's own drafts land in Claude Code's prompt for you to read and send, never sent for you.
export async function typeIn(text) {
  if (ask) throw failure(409, 'Claude Code is waiting on you, so answer it there first');
  await summon();
  const typed = await desktopCall('pasteTerminal')(text);
  return { ok: true, text: typed ? 'It is in Claude Code\'s prompt: read it and press Enter to send' : 'Claude Code did not reach its prompt in time, so nothing was put in it' };
}

async function newSession() {
  const restartTerminal = desktopCall('restartTerminal');
  await saveSession(freshSession(await account()));
  setAsk(null);
  await restartTerminal(await prepare());
  return { ok: true, text: 'Started a new Claude Code session' };
}

function setAsk(next) {
  if (!ask && !next) return;
  ask = next;
  for (const fn of listeners) Promise.resolve().then(fn).catch(() => {});
}

function typed() {
  if (ask) setAsk(null);
}

const clip = (text) => (text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS - 1)}…` : text);

// Claude Code says why it waits, so its words are the card and the banner, and nothing else it sends is kept.
async function heard({ event, session: id, message } = {}) {
  if (!HOOKED.includes(event)) throw failure(400, `event is one of ${HOOKED.join(', ')}`);
  if (event === 'Notification') {
    const said = typeof message === 'string' ? message.trim().replace(/\s+/g, ' ') : '';
    setAsk({ message: clip(said || 'Claude Code is waiting for you'), at: Date.now() });
    return { ok: true };
  }
  setAsk(null);
  await markResumable(id);
  return { ok: true };
}

// A session id with nothing said in it cannot be resumed, so it is only resumed once a hook shows it has a turn.
async function markResumable(id) {
  const saved = await readJson(files().session);
  if (!saved || saved.id !== id || saved.resumable) return;
  await saveSession({ ...saved, resumable: true });
}

async function asset(path) {
  const name = path.slice('/vendor/'.length);
  const file = shell.desktop?.terminalAssets?.[name];
  if (!file) throw failure(404, 'not found');
  return new Response(await readFile(file), { headers: { 'content-type': ASSET_TYPES[extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store' } });
}
