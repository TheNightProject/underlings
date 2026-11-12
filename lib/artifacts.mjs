import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { failure } from './engine.mjs';
import { readJson } from './run.mjs';
import { APP_NAME } from './product.mjs';
import { stateDir } from './home.mjs';

const artifactsFile = () => join(stateDir(), 'artifacts.jsonl');
const hiddenFile = () => join(stateDir(), 'hidden.json');
const copiesDir = () => join(stateDir(), 'artifacts');
const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9-]+)/;
const ARTIFACT_ID = /^[A-Za-z0-9-]+$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
};
// The framed page is sandboxed to an opaque origin, so reading its own data files is a cross-origin fetch that only the token guards.
const PREVIEW_HEADERS = {
  'content-security-policy': 'sandbox allow-scripts',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};
let shell = {};

export function start(config, options) {
  shell = options ?? {};
}

export async function readArtifacts(sign) {
  const latest = new Map();
  for (const line of (await readFile(artifactsFile(), 'utf8').catch(() => '')).split('\n')) {
    const row = parseLine(line);
    if (row && ARTIFACT_URL.test(row.url)) latest.set(row.url, { ...latest.get(row.url), ...row });
  }
  const hidden = await readJson(hiddenFile(), []);
  const rows = [...latest.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return Promise.all(rows.map(async (a) => ({ ...a, title: a.title || a.url, hidden: hidden.includes(a.url), ...(await copyOf(a, sign)) })));
}

// The row only says a copy was taken, so a folder cleared since then gets no preview.
async function copyOf(a, sign) {
  const id = a.url.match(ARTIFACT_URL)[1];
  const dir = join(copiesDir(), id);
  if (!a.dir || !(await isFile(join(dir, 'index.html')))) return { dir: undefined };
  return { dir, previewToken: sign ? sign(previewClaim(id)) : undefined };
}

export async function setHidden({ url, hidden }) {
  const list = new Set(await readJson(hiddenFile(), []));
  if (hidden) list.add(url);
  else list.delete(url);
  await mkdir(stateDir(), { recursive: true });
  await writeFile(hiddenFile(), JSON.stringify([...list], null, 2));
  return { ok: true };
}

// The token rides in the path, so the page's relative links to its own files carry it too.
export async function preview(path, sign) {
  const [id, token, ...rest] = path.split('/').slice(2);
  if (!sign || !ARTIFACT_ID.test(id ?? '') || !sameToken(token, sign(previewClaim(id)))) throw failure(403, 'this preview link is not valid');
  const file = copyPath(id, rest.join('/'));
  if (!file) throw failure(400, 'that path is outside the artifact');
  if (!(await isFile(file))) throw failure(404, 'that file is not in the copy kept of this artifact');
  return new Response(await readFile(file), { headers: { ...PREVIEW_HEADERS, 'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream' } });
}

// Only an artifact the worker has recorded opens, and a copy is named by its preview path, so no page hands the window an address.
async function openWindow({ url, copy = false } = {}, sign) {
  const { openArtifact, openArtifactCopy } = shell.desktop ?? {};
  if (typeof openArtifact !== 'function') throw failure(400, `only the ${APP_NAME} app opens an artifact in a window of its own`);
  const artifact = (await readArtifacts(sign)).find((a) => a.url === url);
  if (!artifact) throw failure(404, 'that artifact is not recorded here');
  if (!copy) await openArtifact({ url, title: artifact.title });
  else if (artifact.previewToken) await openArtifactCopy({ url, title: artifact.title, path: previewPath(artifact) });
  else throw failure(404, 'no copy of that artifact is kept');
  return { ok: true };
}

function previewPath(a) {
  return `/preview/${a.url.match(ARTIFACT_URL)[1]}/${a.previewToken}/index.html?v=${encodeURIComponent(a.at)}`;
}

function previewClaim(id) {
  return 'preview:' + id;
}

function sameToken(given, wanted) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(wanted);
  return a.length === b.length && timingSafeEqual(a, b);
}

function copyPath(id, encoded) {
  let published;
  try {
    published = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  const root = join(copiesDir(), id);
  const file = resolve(root, !published || published.endsWith('/') ? published + 'index.html' : published);
  return !isAbsolute(published) && file.startsWith(root + sep) ? file : null;
}

async function isFile(path) {
  return Boolean((await stat(path).catch(() => null))?.isFile());
}

function parseLine(line) {
  try {
    return line.trim() ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

export const ROUTES = {
  'POST /api/hide': async ({ body }) => setHidden(await body()),
  'POST /api/artifacts/window': async ({ body, sign }) => openWindow(await body(), sign),
  'GET /preview/*': ({ path, sign }) => preview(path, sign),
};
