import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.js';

/** The worker taking turns: the app, or the Orca plugin, each under its own pid. */
export type AutoOwner = string;

export const AUTO_BEAT_MS = 5_000;
export const AUTO_STALE_MS = 30_000;
export const AUTO_CONFIRM_MS = 5_000;
export const AUTO_HOLD_MS = 15_000;

const LOCK_FILE = join(STATE_DIR, 'auto.lock');
const FRONTENDS = join(STATE_DIR, 'frontends');

/** Plain JSON the host keeps between turns, so a re-imported engine carries on with the same turn. */
export interface AutoSeat {
  owner: AutoOwner;
  pid: number;
  startedAt: number;
  token: string | null;
  beatOkAt: number | null;
  probation: boolean;
  yielding: boolean;
  staleSeen: { mark: string; at: number } | null;
}

export interface AutoIntent {
  owner: AutoOwner;
  wants: boolean;
  why: string;
  busy: boolean;
}

export interface AutoTurn {
  seat: AutoSeat;
  held: boolean;
  event: string | null;
}

export interface AutoLock {
  v: 1;
  owner: AutoOwner;
  pid: number;
  token: string;
  startedAt: number;
  beatAt: number;
}

export interface AutoPresence {
  v: 1;
  owner: AutoOwner;
  pid: number;
  ppid: number;
  wants: boolean;
  why: string;
  startedAt: number;
  beatAt: number;
}

export interface AutoDriver {
  holder: (AutoLock & { live: boolean }) | null;
  frontends: (AutoPresence & { live: boolean })[];
  stateDir: string;
}

type LockRead = { kind: 'absent' } | { kind: 'garbled'; mtimeMs: number } | { kind: 'held'; lock: AutoLock };

export function newAutoSeat(owner: AutoOwner, now: number, pid = process.pid): AutoSeat {
  return { owner, pid, startedAt: now, token: null, beatOkAt: null, probation: false, yielding: false, staleSeen: null };
}

/** EPERM means the process is there but not ours to signal, which is still alive. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function parsed<T>(raw: string, valid: (value: Record<string, unknown>) => boolean): T | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return value && typeof value === 'object' && valid(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

const isLock = (v: Record<string, unknown>): boolean =>
  v['v'] === 1 && typeof v['owner'] === 'string' && typeof v['token'] === 'string' &&
  typeof v['pid'] === 'number' && typeof v['beatAt'] === 'number';

const isPresence = (v: Record<string, unknown>): boolean =>
  v['v'] === 1 && typeof v['owner'] === 'string' && typeof v['pid'] === 'number' && typeof v['beatAt'] === 'number';

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function readLock(): LockRead {
  const raw = readText(LOCK_FILE);
  if (raw === null) return { kind: 'absent' };
  const lock = parsed<AutoLock>(raw, isLock);
  if (lock) return { kind: 'held', lock };
  const mtimeMs = statSync(LOCK_FILE, { throwIfNoEntry: false })?.mtimeMs;
  return mtimeMs === undefined ? { kind: 'absent' } : { kind: 'garbled', mtimeMs };
}

function isStale(read: LockRead, now: number): boolean {
  if (read.kind === 'held') return now - read.lock.beatAt > AUTO_STALE_MS;
  return read.kind === 'garbled' && now - read.mtimeMs > AUTO_STALE_MS;
}

function markOf(read: LockRead): string {
  if (read.kind === 'held') return `${read.lock.token}@${read.lock.beatAt}`;
  return read.kind === 'garbled' ? `unreadable@${read.mtimeMs}` : 'absent';
}

function writeLock(lock: AutoLock): void {
  const tmp = `${LOCK_FILE}.${lock.pid}.${lock.token}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock));
  renameSync(tmp, LOCK_FILE);
}

function presencePath(owner: AutoOwner, pid: number): string {
  return join(FRONTENDS, `${owner}-${pid}.json`);
}

function writePresence(seat: AutoSeat, intent: AutoIntent, now: number): void {
  mkdirSync(FRONTENDS, { recursive: true });
  const path = presencePath(seat.owner, seat.pid);
  const record: AutoPresence = {
    v: 1,
    owner: seat.owner,
    pid: seat.pid,
    ppid: process.ppid,
    wants: intent.wants,
    why: intent.why,
    startedAt: seat.startedAt,
    beatAt: now,
  };
  writeFileSync(`${path}.tmp`, JSON.stringify(record));
  renameSync(`${path}.tmp`, path);
}

function presenceFiles(): string[] {
  try {
    return readdirSync(FRONTENDS).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
}

function readPresences(): AutoPresence[] {
  return presenceFiles().flatMap((name) => {
    const record = parsed<AutoPresence>(readText(join(FRONTENDS, name)) ?? '', isPresence);
    return record ? [record] : [];
  });
}

function presenceLive(p: AutoPresence, now: number): boolean {
  return now - p.beatAt < AUTO_STALE_MS && pidAlive(p.pid);
}

function cleared(seat: AutoSeat): AutoSeat {
  return { ...seat, token: null, beatOkAt: null, probation: false, yielding: false, staleSeen: null };
}

function takenBy(read: LockRead): string {
  if (read.kind === 'held') return `${read.lock.owner} pid ${read.lock.pid} took over`;
  return read.kind === 'absent' ? 'the full auto lock was removed' : 'the full auto lock was overwritten';
}

function stillOurs(seat: AutoSeat, read: LockRead): { seat: AutoSeat; event: string | null } {
  if (!seat.token || (read.kind === 'held' && read.lock.token === seat.token)) return { seat, event: null };
  return { seat: cleared(seat), event: takenBy(read) };
}

function beat(seat: AutoSeat, read: LockRead, now: number, event: string | null): AutoTurn {
  if (read.kind !== 'held') return { seat, held: false, event };
  writeLock({ ...read.lock, beatAt: now });
  const next = { ...seat, beatOkAt: now, probation: false, yielding: false, staleSeen: null };
  return { seat: next, held: autoTurnHeld(next, now), event };
}

function releaseLock(seat: AutoSeat): void {
  const read = readLock();
  if (seat.token && read.kind === 'held' && read.lock.token === seat.token) rmSync(LOCK_FILE, { force: true });
}

/** Busy, it keeps beating so nobody steals the step it is on, and lets go once that step is done. */
function stepAside(seat: AutoSeat, read: LockRead, busy: boolean, now: number, event: string | null): AutoTurn {
  if (busy) {
    const beaten = beat(seat, read, now, event);
    return { seat: { ...beaten.seat, yielding: true }, held: false, event };
  }
  releaseLock(seat);
  return { seat: cleared(seat), held: false, event: event ?? 'handed full auto over' };
}

function link(seat: AutoSeat, now: number, event: string | null): AutoTurn {
  const token = randomUUID();
  const lock: AutoLock = { v: 1, owner: seat.owner, pid: seat.pid, token, startedAt: now, beatAt: now };
  const tmp = `${LOCK_FILE}.${seat.pid}.${token}.tmp`;
  writeFileSync(tmp, JSON.stringify(lock));
  try {
    linkSync(tmp, LOCK_FILE);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return { seat: { ...seat, staleSeen: null }, held: false, event };
  } finally {
    rmSync(tmp, { force: true });
  }
  const next = { ...seat, token, beatOkAt: now, probation: false, yielding: false, staleSeen: null };
  return { seat: next, held: true, event: event ?? 'took the full auto lock' };
}

/** Renamed over, never linked, so it is not held until a later turn finds its own token still there. */
function steal(seat: AutoSeat, mark: string, now: number, event: string | null): AutoTurn {
  const again = readLock();
  if (again.kind === 'absent') return link(seat, now, event);
  if (markOf(again) !== mark) return { seat: { ...seat, staleSeen: null }, held: false, event };
  const token = randomUUID();
  writeLock({ v: 1, owner: seat.owner, pid: seat.pid, token, startedAt: now, beatAt: now });
  const from = again.kind === 'held' ? `${again.lock.owner} pid ${again.lock.pid}` : 'an unreadable lock';
  const next = { ...seat, token, beatOkAt: now, probation: true, yielding: false, staleSeen: null };
  return { seat: next, held: false, event: `took over full auto from ${from}` };
}

/** A stale lock is taken only on a second sighting 5 s later, unless its holder is plainly dead. */
function acquire(seat: AutoSeat, read: LockRead, now: number, event: string | null): AutoTurn {
  if (read.kind === 'absent') return link(seat, now, event);
  const dead = read.kind === 'held' && !pidAlive(read.lock.pid);
  if (!dead && !isStale(read, now)) return { seat: { ...seat, staleSeen: null }, held: false, event };
  const mark = markOf(read);
  const seen = seat.staleSeen?.mark === mark ? seat.staleSeen : null;
  if (dead || (seen && now - seen.at >= AUTO_CONFIRM_MS)) return steal(seat, mark, now, event);
  return { seat: { ...seat, staleSeen: seen ?? { mark, at: now } }, held: false, event };
}

export function takeAutoTurn(seat: AutoSeat | null, intent: AutoIntent, now: number): AutoTurn {
  const start = seat ?? newAutoSeat(intent.owner, now);
  mkdirSync(STATE_DIR, { recursive: true });
  writePresence(start, intent, now);
  const read = readLock();
  const kept = stillOurs(start, read);
  const aside = !intent.wants;
  if (kept.seat.token) {
    return aside ? stepAside(kept.seat, read, intent.busy, now, kept.event) : beat(kept.seat, read, now, kept.event);
  }
  if (aside) return { seat: { ...kept.seat, staleSeen: null }, held: false, event: kept.event };
  return acquire(kept.seat, read, now, kept.event);
}

export function autoTurnHeld(seat: AutoSeat | null | undefined, now: number): boolean {
  if (!seat?.token || seat.probation || seat.yielding || seat.beatOkAt === null) return false;
  return now - seat.beatOkAt < AUTO_HOLD_MS;
}

/** `keepLock` withdraws only the presence, for a host stopping while a step may still be writing. */
export function releaseAutoTurn(seat: AutoSeat, { keepLock = false }: { keepLock?: boolean } = {}): AutoSeat {
  if (!keepLock) releaseLock(seat);
  rmSync(presencePath(seat.owner, seat.pid), { force: true });
  return cleared(seat);
}

export function readAutoDriver(now: number): AutoDriver {
  const read = readLock();
  const holder = read.kind === 'held' ? { ...read.lock, live: !isStale(read, now) && pidAlive(read.lock.pid) } : null;
  return {
    holder,
    frontends: readPresences().map((p) => ({ ...p, live: presenceLive(p, now) })),
    stateDir: STATE_DIR,
  };
}
