import { createHmac, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import module from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDir, migrateHome, stateDir } from './lib/home.mjs';
import { APP_NAME, branded } from './lib/product.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const UI = join(ROOT, 'ui');
// The host reaps a worker idle for five minutes; any host call counts as activity.
const KEEPALIVE_MS = 240_000;
const MAX_BODY = 64 * 1024;
const PREVIEW = '/preview/';
const TOOLS = '/api/mcp/';
const HOOKS = '/api/hook/';

// A reload imports lib/app.mjs?cc=N, and this hands N to every relative import under it, so the whole graph is new.
const reloadable = typeof module.registerHooks === 'function';
if (reloadable) module.registerHooks({ resolve: sameGeneration });

const listeners = new Set();
let server;
let token;
let toolToken;
let hookToken;
let origin;
let config;
let app;
let generation = 0;
let keepalive;
let host = null;
let desktop = null;
let pageUrl;
let log = () => {};

export default async function activate(ctx) {
  log = (text) => ctx.log(text);
  movedHome(ctx);
  config = { port: 47321, ...(await readJson(join(configDir(), 'config.json'), {})) };
  host = ctx.host;
  desktop = ctx.desktop ?? null;
  if (desktop?.port) config.port = desktop.port;
  token = await loadToken();
  toolToken = randomBytes(18).toString('base64url');
  hookToken = randomBytes(18).toString('base64url');
  app = await import('./lib/app.mjs');
  origin = `http://127.0.0.1:${await listen(config.port)}`;
  pageUrl = `${origin}/?t=${token}`;
  ctx.log(`${APP_NAME} at ${pageUrl}`);
  await saveUrl(pageUrl);
  desktop?.showPage(pageUrl);
  ctx.commands.register('open', () => app.openPage(config, pageUrl));
  ctx.commands.register('latest', () => app.openPage(config, pageUrl, app.latestTarget?.()));
  if (desktop) ctx.commands.register('goto', (target) => app.openPage(config, pageUrl, target));
  if (desktop) ctx.commands.register('claude', () => app.openClaude());
  keepalive = setInterval(() => ctx.host.call('storage.keys').catch(() => {}), KEEPALIVE_MS);
  // Not awaited: activation has a ten second budget and the first MR fetch alone can use most of it.
  app.start(config, shellFor(null)).catch((err) => log(`could not start: ${err.message}`));
}

// Orca exits the worker once this returns, so a full auto step still writing gets the wait that app.stop bounds.
export async function deactivate() {
  clearInterval(keepalive);
  await app?.stop?.();
  server?.close();
}

function shellFor(carried) {
  return { notify: broadcast, log, uiStamp, carried, sign, alert, desktop, mcp: { url: origin, token: toolToken }, hooks: { url: origin, token: hookToken } };
}

function alert(title, body = '', target) {
  const banner = { title: title.slice(0, 120), body: body.slice(0, 1000) };
  if (!desktop) return host.call('notifications.show', banner);
  return desktop.notify({ ...banner, open: () => app.openPage(config, pageUrl, target) });
}

function sign(text) {
  return createHmac('sha256', token).update(text).digest('base64url');
}

function sameGeneration(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  const parent = context.parentURL?.startsWith('file:') ? new URL(context.parentURL) : null;
  const wanted = parent?.searchParams.get('cc');
  if (!wanted || !specifier.startsWith('.') || !resolved.url.startsWith('file:')) return resolved;
  const url = new URL(resolved.url);
  url.searchParams.set('cc', wanted);
  return { ...resolved, url: url.href };
}

// The server, token, open event streams and keepalive stay; a broken import leaves the running code in place.
async function reload() {
  if (!reloadable) throw Object.assign(new Error(`this Node cannot re-import modules, so restart ${APP_NAME}`), { status: 501 });
  generation += 1;
  const next = await import(`./lib/app.mjs?cc=${generation}`);
  await next.start(config, shellFor(app.carry()));
  const previous = app;
  app = next;
  previous.stop?.();
  broadcast('reload');
  return { ok: true, generation, pid: process.pid, text: `Reloaded the code of ${APP_NAME} (generation ${generation})`, version: await app.versions() };
}

// Before anything reads a setting, so the first run of a new version finds its settings and state in their new folders.
function movedHome(ctx) {
  for (const [part, { outcome, why, from, to }] of Object.entries(migrateHome())) {
    if (outcome === 'moved') ctx.log(`moved ${from.join(' and ')} to ${to}`);
    if (outcome === 'waiting' || outcome === 'failed') ctx.log(`kept the ${part} where it was, as ${why}; it moves on a later start`);
  }
}

// Kept across restarts so an open dashboard tab keeps working when the worker comes back.
async function loadToken() {
  const file = join(stateDir(), 'token');
  const saved = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (saved) return saved;
  const fresh = randomBytes(18).toString('base64url');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, fresh + '\n', { mode: 0o600 });
  return fresh;
}

async function saveUrl(url) {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(join(stateDir(), 'url'), url + '\n', { mode: 0o600 });
}

function listen(port) {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => handle(req, res).catch((err) => fail(res, err.status ?? 500, err.message)));
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function handle(req, res) {
  const url = new URL(req.url, origin);
  const refused = refusal(req, url);
  if (refused) return fail(res, 403, refused);
  const key = `${req.method} ${url.pathname}`;
  if (key === 'GET /') return send(res, 200, 'text/html; charset=utf-8', await assemblePage());
  if (key === 'GET /api/events') return stream(req, res);
  if (key === 'POST /api/reload') return json(res, await reload());
  const result = await app.route({ method: req.method, path: url.pathname, query: url.searchParams, body: () => readBody(req), config });
  return result instanceof Response ? sendResponse(res, result) : json(res, result);
}

// The query token is for links and event streams; a framed page on another origin must not be able to write.
function refusal(req, url) {
  if (req.headers.host !== new URL(origin).host) return 'wrong host';
  if (url.pathname.startsWith(TOOLS)) return toolRefusal(req);
  if (url.pathname.startsWith(HOOKS)) return hookRefusal(req);
  const headerToken = req.headers['x-cc-token'] === token;
  if (url.pathname.startsWith(PREVIEW)) return previewRefusal(req, url, headerToken);
  if (req.method === 'GET') return headerToken || url.searchParams.get('t') === token ? null : 'missing token';
  if (!headerToken) return 'missing token: a write carries it in the x-cc-token header';
  return req.headers.origin === origin ? null : `a write must come from the ${APP_NAME} page`;
}

// The chat's tools carry a token of their own that opens nothing else, and a page never sends one.
function toolRefusal(req) {
  if (req.method !== 'POST') return 'a tool call is a POST';
  if (req.headers['x-cc-mcp-token'] !== toolToken) return 'missing token: a tool call carries the tool token';
  return req.headers.origin ? 'a tool call comes from the Claude session, not from a page' : null;
}

function hookRefusal(req) {
  if (req.method !== 'POST') return 'a hook is a POST';
  if (req.headers['x-cc-hook-token'] !== hookToken) return 'missing token: a hook carries the hook token';
  return req.headers.origin ? 'a hook comes from Claude Code, not from a page' : null;
}

// A preview checks its own token, signed from this one, and never takes this one, so a framed page cannot learn it from its own address.
function previewRefusal(req, url, headerToken) {
  if (req.method !== 'GET') return 'a preview is read only';
  return headerToken || url.searchParams.get('t') === token ? 'a preview takes its own token, not the page\'s' : null;
}

// One tag per file, so a syntax error in one script leaves the others running.
export async function assemblePage() {
  const names = await uiFiles();
  const [html, ...sources] = await Promise.all([readFile(join(ROOT, 'dashboard.html'), 'utf8'), ...names.map((n) => readFile(join(UI, n), 'utf8'))]);
  const tags = (ext, wrap) => names.map((n, i) => (n.endsWith(ext) ? wrap(n, sources[i]) : '')).join('');
  const head = `<meta name="cc-ui" content="${await uiStamp()}">\n` + tags('.css', (n, text) => `<style>\n${text}</style>\n`);
  const body = tags('.js', (n, text) => `<script>\n${text.replaceAll('</script', '<\\/script')}\n//# sourceURL=ui/${n}\n</script>\n`);
  return branded(html).replace('</head>', () => head + '</head>').replace('</body>', () => body + '</body>');
}

async function uiFiles() {
  return (await readdir(UI)).filter((n) => /\.(css|js)$/.test(n)).sort();
}

async function uiStamp() {
  const paths = [join(ROOT, 'dashboard.html'), ...(await uiFiles()).map((n) => join(UI, n))];
  return Math.max(...(await Promise.all(paths.map(async (p) => (await stat(p)).mtimeMs))));
}

function stream(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  res.write('retry: 5000\n\n');
  listeners.add(res);
  req.on('close', () => listeners.delete(res));
}

function broadcast(event) {
  for (const res of listeners) res.write(`data: ${event}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('the body is not JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function json(res, value) {
  send(res, 200, 'application/json', JSON.stringify(value));
}

async function sendResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function send(res, status, type, content) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(content);
}

function fail(res, status, message) {
  if (!res.headersSent) send(res, status, 'text/plain', message);
}
