import { engine, forgeFor, forgeHas, supports } from './engine.mjs';

const PIPELINE_WORDS = { SUCCESS: 'pipeline passed', FAILED: 'pipeline failed', CANCELED: 'pipeline cancelled', SKIPPED: 'pipeline skipped', MANUAL: 'pipeline waiting on a manual job' };
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function changeOf(watch, mr) {
  return watch?.seen && mr && supports('changeSince') ? engine.changeSince(watch, mr) : null;
}

export function pipelineWords(status) {
  return status ? PIPELINE_WORDS[status] ?? 'pipeline running' : null;
}

export function movedWords(change) {
  if (!change) return null;
  const parts = [
    change.headMoved ? 'new commits' : null,
    change.notes > 0 ? plural(change.notes, 'new comment') : null,
    change.resolved > 0 ? `${plural(change.resolved, 'thread')} resolved` : null,
    change.approvals > 0 ? plural(change.approvals, 'new approval') : null,
    pipelineWords(change.pipeline),
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export function reviewedAt(watch) {
  if (Number.isFinite(watch?.seenAt)) return new Date(watch.seenAt).toISOString();
  return watch?.reviewedAt ?? watch?.addedAt ?? null;
}

const people = (d, me) => d.notes.filter((n) => !n.system && n.author !== me);

function repliesSince(discussions, me, at) {
  const counts = new Map();
  for (const d of discussions) {
    if (!d.notes.some((n) => n.author === me)) continue;
    const who = new Set(people(d, me).filter((n) => !at || n.createdAt > at).map((n) => n.author));
    for (const name of who) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([author, threads]) => ({ author, threads }));
}

export async function sinceReview(watch, mr, discussions, me) {
  const change = changeOf(watch, mr);
  if (!change) return null;
  const at = reviewedAt(watch);
  const from = watch.seen.sha;
  const compared = change.headMoved && from && mr.sha && forgeHas(mr, 'since') ? await forgeFor(mr).since(mr, from, mr.sha).catch(() => null) : null;
  const mine = discussions.filter((d) => d.resolvable !== false && d.notes.some((n) => n.author === me));
  const resolved = mine.filter((d) => d.resolved).length;
  const replies = repliesSince(discussions, me, at);
  const parts = [
    change.headMoved ? (compared ? plural(compared.commits, 'commit') : 'new commits') : null,
    ...replies.map((r) => `${r.author} replied on ${plural(r.threads, 'thread')}`),
    resolved ? `${resolved} of your ${plural(mine.length, 'thread')} resolved` : null,
    pipelineWords(change.pipeline),
  ].filter(Boolean);
  return { at, words: parts.length ? parts.join(', ') : null, paths: compared?.paths ?? [], headMoved: change.headMoved };
}
