// Synchronous and standalone, so the engine, the hooks and the app's main process can each find the folders before anything else runs.
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { APP_NAME, FOLDER } from './product.mjs';

// The names the app and its engine had before, which only the move from them may use.
const OLD_FOLDER = 'control-centre';
const OLD_ENGINE = 'thematrix';
export const OLD_APP_NAME = 'Control Centre';

export const MARKER = 'migrated.json';
export const LEFT_NOTE = 'README-MOVED.txt';
const STALE_MS = 30_000;
const ENGINE = 'engine';
const CACHES = /(?:^|\/)(?:Singleton[^/]*|[^/]*Cache|blob_storage|Crashpad)$/;

export function places(home = homedir(), userData = join(home, 'Library/Application Support', APP_NAME)) {
  const state = join(home, '.local/state');
  return {
    config: { target: join(home, '.config', FOLDER), from: [{ dir: join(home, '.config', OLD_FOLDER), into: '' }], rewrite: rewriteConfig(home) },
    state: { target: join(state, FOLDER), from: [{ dir: join(state, OLD_FOLDER), into: '' }, { dir: join(state, OLD_ENGINE), into: ENGINE }], rewrite: rewriteAgents(home) },
    logs: { target: join(home, 'Library/Logs', APP_NAME), from: [{ dir: join(home, 'Library/Logs', OLD_APP_NAME), into: '' }] },
    appData: { target: userData, from: [{ dir: join(dirname(userData), OLD_APP_NAME), into: '' }], skip: CACHES },
  };
}

const moved = (dir) => existsSync(join(dir, LEFT_NOTE));
// Electron makes the app's own folder, empty, before any of its code runs, so an empty folder is one nothing has used yet.
const used = (dir) => existsSync(dir) && readdirSync(dir).length > 0;
const stillOld = (place) => !used(place.target) && place.from.some((f) => existsSync(f.dir) && !moved(f.dir));

// Until the move has happened the old folders stay the live ones, so nothing ever writes a new folder the move would then refuse to fill.
export function configDir(home = homedir()) {
  const place = places(home).config;
  return stillOld(place) ? place.from[0].dir : place.target;
}

export function stateDir(home = homedir()) {
  const place = places(home).state;
  return stillOld(place) ? place.from[0].dir : place.target;
}

export function engineStateDir(home = homedir()) {
  const place = places(home).state;
  return stillOld(place) ? place.from[1].dir : join(place.target, ENGINE);
}

export function logsDir(home = homedir()) {
  return places(home).logs.target;
}

export function migrateHome({ home = homedir(), parts = ['config', 'state'], userData, now = Date.now() } = {}) {
  const all = places(home, userData);
  const waitFor = () => olderStillRunning(all.state.from[1].dir, now);
  return Object.fromEntries(parts.map((part) => [part, migrateFolder(all[part], part === 'logs' || part === 'appData' ? () => null : waitFor)]));
}

export function migrateFolder(place, waitFor = () => null) {
  const { target, from, skip, rewrite } = place;
  if (used(target)) return { outcome: 'present', to: target };
  const sources = from.filter((f) => existsSync(f.dir));
  if (!sources.length) return { outcome: 'fresh', to: target };
  if (sources.some((f) => moved(f.dir))) return { outcome: 'moved before', to: target };
  const why = waitFor();
  if (why) return { outcome: 'waiting', why, to: target };
  const temp = join(dirname(target), `.${basename(target)}.moving-${process.pid}`);
  try {
    rmSync(temp, { recursive: true, force: true });
    for (const source of sources) copyChecked(source.dir, join(temp, source.into), skip);
    const rewritten = rewrite?.(temp) ?? [];
    writeFileSync(join(temp, MARKER), `${JSON.stringify({ from: sources.map((s) => s.dir), at: new Date().toISOString(), rewritten }, null, 2)}\n`, { mode: 0o600 });
    mkdirSync(dirname(target), { recursive: true });
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { recursive: true, force: true });
    return used(target) ? { outcome: 'present', to: target } : { outcome: 'failed', why: err.message, to: target };
  }
  for (const source of sources) leaveNote(source.dir, target);
  return { outcome: 'moved', from: sources.map((s) => s.dir), to: target };
}

function copyChecked(src, dest, skip) {
  const kept = (path) => !skip?.test(relative(src, path).split(sep).join('/'));
  cpSync(src, dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true, force: false, filter: (path) => kept(path) && copyable(path) });
  for (const entry of entries(src, kept)) checkCopy(join(src, entry), join(dest, entry), entry);
}

function copyable(path) {
  const info = lstatSync(path);
  return info.isFile() || info.isDirectory() || info.isSymbolicLink();
}

function entries(root, kept, under = '') {
  return readdirSync(join(root, under), { withFileTypes: true }).flatMap((d) => {
    const entry = join(under, d.name);
    const path = join(root, entry);
    if (!kept(path) || !copyable(path)) return [];
    return d.isDirectory() ? [entry, ...entries(root, kept, entry)] : [entry];
  });
}

export function checkCopy(from, to, entry) {
  const was = lstatSync(from);
  const is = lstatSync(to, { throwIfNoEntry: false });
  if (!is) throw new Error(`${entry} did not copy`);
  if (was.isSymbolicLink()) {
    if (!is.isSymbolicLink() || readlinkSync(from) !== readlinkSync(to)) throw new Error(`the link ${entry} did not copy`);
    return;
  }
  if ((was.mode & 0o777) !== (is.mode & 0o777)) chmodSync(to, was.mode & 0o777);
  if (was.isDirectory()) return;
  if (was.size !== is.size || digest(from) !== digest(to)) throw new Error(`${entry} changed or did not copy whole`);
}

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function leaveNote(dir, target) {
  const note = [
    `${APP_NAME} copied this folder to ${target} on ${new Date().toISOString().slice(0, 10)}, and no longer reads it.`,
    'It is left here, untouched, as a way back. Once you are happy everything came across, you can delete it.',
    '',
  ].join('\n');
  try {
    writeFileSync(join(dir, LEFT_NOTE), note);
  } catch {}
}

// A runner or a worker still on the old code writes the old folders, so moving now would leave what it writes behind.
export function olderStillRunning(engineDir, now = Date.now()) {
  const agents = liveRunners(join(engineDir, 'agents'));
  if (agents.length) return `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} still running from before (pid ${agents.join(', ')})`;
  const workers = liveWorkers(engineDir, now);
  if (workers.length) return `another copy of the app still uses the old folders (pid ${workers.join(', ')})`;
  return null;
}

function liveRunners(dir) {
  const names = existsSync(dir) ? readdirSync(dir) : [];
  return names.map((name) => Number(readText(join(dir, name, 'runner.lock')).trim())).filter(alive);
}

function liveWorkers(engineDir, now) {
  const frontends = join(engineDir, 'frontends');
  const records = [join(engineDir, 'auto.lock'), ...(existsSync(frontends) ? readdirSync(frontends).map((n) => join(frontends, n)) : [])].map(readRecord);
  const pids = records.filter((r) => r && now - r.beatAt < STALE_MS && r.pid !== process.pid && alive(r.pid)).map((r) => r.pid);
  return [...new Set(pids)];
}

function readRecord(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return Number.isInteger(value?.pid) && typeof value.beatAt === 'number' ? value : null;
  } catch {
    return null;
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function movedPath(value, home = homedir()) {
  if (typeof value !== 'string') return value;
  const swaps = [
    [join(home, '.local/state', OLD_ENGINE), join(home, '.local/state', FOLDER, ENGINE)],
    [join(home, '.local/state', OLD_FOLDER), join(home, '.local/state', FOLDER)],
    [join(home, '.config', OLD_FOLDER), join(home, '.config', FOLDER)],
    [`/Applications/${OLD_APP_NAME}.app`, `/Applications/${APP_NAME}.app`],
  ];
  for (const [was, is] of swaps) {
    if (value === was || value.startsWith(`${was}/`)) return is + value.slice(was.length);
  }
  return value;
}

function deepMoved(value, home) {
  if (Array.isArray(value)) return value.map((v) => deepMoved(v, home));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepMoved(v, home)]));
  return movedPath(value, home);
}

function rewriteJson(path, change) {
  let before;
  try {
    before = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return false;
  }
  const after = change(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return false;
  writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);
  return true;
}

// A signature saved as the old default would keep signing with the old name, so it goes back to following the default.
const OLD_SIGNATURE = `Sent with ${OLD_APP_NAME}`;

function rewriteConfig(home) {
  return (root) => [
    ...(rewriteJson(join(root, 'config.json'), (c) => deepMoved(c, home)) ? ['config.json'] : []),
    ...(rewriteJson(join(root, 'slack.json'), withoutOldSignature) ? ['slack.json'] : []),
  ];
}

function withoutOldSignature(saved) {
  if (saved?.signature !== OLD_SIGNATURE) return saved;
  const { signature, ...rest } = saved;
  return rest;
}

// A resumed agent is started again with the arguments it was first given, which name its settings files by their old paths.
function rewriteAgents(home) {
  return (root) => {
    const dir = join(root, ENGINE, 'agents');
    const names = existsSync(dir) ? readdirSync(dir) : [];
    return names.map((n) => join(ENGINE, 'agents', n, 'agent.json'))
      .filter((file) => rewriteJson(join(root, file), (a) => (Array.isArray(a?.args) ? { ...a, args: a.args.map((x) => movedPath(x, home)) } : a)));
  };
}
