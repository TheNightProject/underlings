#!/usr/bin/env node
// Claude Code PostToolUse hook: records each artifact publish, with a copy of its page to preview. Never fails the tool call.
import { appendFile, copyFile, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { stateDir } from './home.mjs';

const STATE_DIR = stateDir();
const LOG = join(STATE_DIR, 'artifacts.jsonl');
const COPIES = join(STATE_DIR, 'artifacts');
const URL_PATTERN = /https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9-]+)/;
const MAX_BYTES = 16 * 1024 * 1024;

async function main() {
  const event = JSON.parse(await readStdin());
  const input = event.tool_input ?? {};
  if (event.tool_name !== 'Artifact' || !isPagePublish(input)) return;
  const url = (JSON.stringify(event.tool_response ?? '').match(URL_PATTERN) ?? [])[0] ?? input.url;
  if (!url) return;
  const id = idOf(url);
  const typed = Boolean(input.type_url) || (await madeFromType(id));
  const cwd = event.cwd || process.cwd();
  const row = {
    at: new Date().toISOString(),
    url,
    title: input.title || (typed ? undefined : await fileTitle(input.file_path, cwd)),
    description: input.description,
    cwd: event.cwd,
    session: event.session_id,
    source: 'claude-code',
  };
  if (typed) row.typed = true;
  const dir = typed ? null : await copySources(id, input, cwd).catch(() => null);
  if (dir) row.dir = dir;
  await mkdir(STATE_DIR, { recursive: true });
  await appendFile(LOG, JSON.stringify(row) + '\n');
}

// An update by url does not say it came from a type, but the create that made it was recorded as typed.
async function madeFromType(id) {
  if (!id) return false;
  const rows = (await readFile(LOG, 'utf8').catch(() => '')).split('\n').map(parseRow);
  return rows.some((row) => row?.typed === true && idOf(row.url) === id);
}

function idOf(url) {
  return String(url).match(URL_PATTERN)?.[1];
}

function parseRow(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function isPagePublish(input) {
  return (input.action ?? 'publish') === 'publish' && !input.asset;
}

// Mirrors the publish: the page lands at index.html, each file at its published path, a null removes one and the rest are kept.
async function copySources(id, input, cwd) {
  const dir = id ? join(COPIES, id) : null;
  if (!dir || !(await keepsPage(dir, input.file_path))) return null;
  const base = resolve(cwd, input.root ?? '');
  if (input.file_path) await copyInto(dir, 'index.html', resolve(cwd, input.file_path));
  for (const [published, source] of fileEntries(input.files)) {
    if (source === null) await removeFrom(dir, published);
    else await copyInto(dir, published, sourcePath(source, base));
  }
  return (await isFile(join(dir, 'index.html'))) ? dir : null;
}

// A typed artifact's data file is not a page, and an update that names no page keeps the copy it already has.
function keepsPage(dir, page) {
  return page === undefined ? isFile(join(dir, 'index.html')) : /\.html?$/i.test(String(page));
}

function fileEntries(files) {
  if (Array.isArray(files)) return files.filter((f) => typeof f?.path === 'string').map((f) => [f.path, f.path]);
  return files && typeof files === 'object' ? Object.entries(files) : [];
}

function sourcePath(source, base) {
  if (typeof source === 'string') return resolve(base, source);
  if (typeof source?.from === 'string') return resolve(base, source.from);
  const other = idOf(source?.artifact);
  return other && typeof source.path === 'string' ? inside(join(COPIES, other), source.path) : null;
}

async function copyInto(dir, published, source) {
  const target = inside(dir, published);
  const info = source && (await stat(source).catch(() => null));
  if (!target || !info?.isFile() || info.size > MAX_BYTES) return;
  await mkdir(dirname(target), { recursive: true }).then(() => copyFile(source, target)).catch(() => {});
}

async function removeFrom(dir, published) {
  const target = inside(dir, published);
  if (target) await rm(target, { force: true });
}

function inside(dir, published) {
  if (typeof published !== 'string' || isAbsolute(published)) return null;
  const target = resolve(dir, published);
  return target.startsWith(dir + sep) ? target : null;
}

async function isFile(path) {
  return Boolean((await stat(path).catch(() => null))?.isFile());
}

async function fileTitle(file, cwd) {
  return (await pageTitle(file && resolve(cwd, file))) || (file ? basename(file) : undefined);
}

async function pageTitle(file) {
  if (!file?.endsWith('.html')) return null;
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return null;
  const { buffer, bytesRead } = await handle.read(Buffer.alloc(8192), 0, 8192, 0);
  await handle.close();
  return buffer.subarray(0, bytesRead).toString('utf8').match(/<title>([^<]{1,200})<\/title>/i)?.[1]?.trim() ?? null;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data || '{}'));
  });
}

main().catch(() => {}).finally(() => process.exit(0));
