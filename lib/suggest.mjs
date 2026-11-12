import { forgeFor, GITLAB, ticketSettings } from './engine.mjs';
import { refNumber } from './refs.mjs';

const MERGED_EVERY_MS = 15 * 60_000;
const READS_AT_ONCE = 2;
const STAGES = ['To Do', 'In Progress', 'Peer Review', 'QA', 'Done'];

let read = new Map();
let readError = null;

export function forget() {
  read = new Map();
  readError = null;
}

export async function eachAtMost(items, limit, fn) {
  const queue = [...items];
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await fn(item);
  };
  await Promise.all(Array.from({ length: limit }, worker));
}

export function mergedFor(key) {
  return read.get(key)?.mrs ?? null;
}

export function mergedError() {
  return readError;
}

// Merged MRs only matter to a ticket with none open, and dropping the others means one that just merged is read afresh.
export async function readMerged(tickets, groups, now = Date.now()) {
  if (!groups.length) return;
  for (const t of tickets) if (t.open.length) read.delete(t.key);
  const stale = (key) => now - (read.get(key)?.at ?? -Infinity) >= MERGED_EVERY_MS;
  const due = tickets.filter((t) => !t.open.length && stale(t.key)).map((t) => t.key);
  if (!due.length) return;
  let error = null;
  await eachAtMost(due, READS_AT_ONCE, async (key) => {
    try {
      read.set(key, { at: now, mrs: await forgeFor(GITLAB, 'mergedMentioning').mergedMentioning(key, groups) });
    } catch (err) {
      error = err.message;
    }
  });
  readError = error;
}

// A path names whole segments, so acme/tooling covers acme/tooling/cli and never acme/toolingx.
export function noQaPathFor(path, noQaPaths) {
  const paths = String(noQaPaths ?? '').split(',').map((p) => p.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
  return paths.find((p) => `/${path}/`.includes(`/${p}/`)) ?? null;
}

export function suggestMove({ status, targets, open, merged, noQaPaths = ticketSettings().noQaPaths }) {
  const move = byMrs(open, merged ?? [], noQaPaths);
  return move && forward(status, move.status) && targets.includes(move.status) ? move : null;
}

// A ticket can take a new MR after QA, so a suggestion only moves it further along, never from Blocked, a release status or one off this line.
const forward = (from, to) => STAGES.includes(from) && STAGES.indexOf(to) > STAGES.indexOf(from);

function byMrs(open, merged, noQaPaths) {
  const ready = open.filter((m) => !m.draft);
  if (ready.length) return { status: 'Peer Review', why: tally(ready, 'is in review', 'MRs in review') };
  if (open.length) return { status: 'In Progress', why: tally(open, 'is a draft', 'draft MRs') };
  if (!merged.length) return null;
  const noQa = merged.map((m) => noQaPathFor(m.path, noQaPaths));
  const where = noQa.every(Boolean) ? noQa[0].split('/').pop() : null;
  return { status: where ? 'Done' : 'QA', why: tally(merged, 'merged', 'MRs merged') + (where ? ` in ${where}` : '') };
}

const tally = (mrs, one, many) => (mrs.length === 1 ? `${refNumber(mrs[0])} ${one}` : `${mrs.length} ${many}`);
