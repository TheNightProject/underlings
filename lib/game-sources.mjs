import { ACHIEVEMENTS, addDays, BACKFILL_DAYS, QUESTS, QUESTS_A_DAY, REWARDS, tokenReward, TOKENS_PER_BLOCK } from './game-rules.mjs';
import { statsOf } from './game-ledger.mjs';
import { dayOf, dayText } from './locale.mjs';
import { MOOD_MINUTES, waitsOnYou } from './moods.mjs';
import { keyOf, shortKey } from './refs.mjs';

const KIND_WORDS = { review: 'Review', fix: 'Fix', kickoff: 'Kickoff', ticket: 'Ticket', message: 'Message' };
const MASTER = 'master';
const MINUTE = 60_000;

export const short = shortKey;
const iso = (ms) => new Date(ms).toISOString();
const middayOf = (day) => `${day}T12:00:00.000Z`;
const dateWords = (day) => dayText(day, { day: 'numeric', month: 'short' });

export function reward(source, key, at, label, amounts = REWARDS[source]) {
  return { kind: 'reward', source, key, at, day: dayOf(Date.parse(at)), xp: amounts.xp, coins: amounts.coins, label };
}

function reviewRewards(r, posted) {
  const ref = short(r.key);
  const comments = Math.min(REWARDS.comment.cap, Math.max(0, r.comments - (posted[`${r.key}@${r.day}`] ?? 0)));
  return [
    reward('review', `review:${r.key}:${r.day}`, r.at, `Reviewed ${ref}`),
    ...Array.from({ length: comments }, (_, n) => reward('comment', `comment:${r.key}:${r.day}:${n + 1}`, r.at, `Commented on ${ref}`)),
    ...(r.approved ? [reward('approval', `approval:${r.key}`, r.at, `Approved ${ref}`)] : []),
  ];
}

export const MOVE_STATUSES = { qa: 'QA', done: 'Done' };

export function workRewards(work, posted = {}, statuses = MOVE_STATUSES) {
  const source = Object.fromEntries(Object.entries(statuses).map(([kind, status]) => [status, kind]).reverse());
  return [
    ...work.merged.map((m) => reward('merged', `merged:${m.key}`, m.at, `Merged ${short(m.key)}`)),
    ...work.reviews.flatMap((r) => reviewRewards(r, posted)),
    ...work.moves.filter((m) => source[m.status]).map((m) => reward(source[m.status], `ticket:${m.key}:${m.status}`, middayOf(m.day), `Moved ${m.key} to ${m.status}`)),
  ];
}

const isFinding = (q) => (q.kind ?? (q.replyTo ? 'reply' : 'finding')) === 'finding';
const posted = (q) => q.status === 'posted' && Boolean(q.postedAt) && !Number.isNaN(Date.parse(q.postedAt));

export function findingRewards(queue) {
  return queue.filter((q) => posted(q) && isFinding(q)).map((q) => reward('finding', `finding:${q.id}`, q.postedAt, `Posted a finding on ${short(keyOf(q))}`));
}

// GitLab counts every note the review queue posts as a comment of yours, so those are taken off the review's comments rather than paid twice.
export function queuePosts(queue) {
  const out = {};
  for (const q of queue.filter((x) => posted(x) && ['finding', 'reply'].includes(x.kind ?? (x.replyTo ? 'reply' : 'finding')))) {
    const at = `${keyOf(q)}@${dayOf(Date.parse(q.postedAt))}`;
    out[at] = (out[at] ?? 0) + 1;
  }
  return out;
}

function agentWords(a) {
  const kind = KIND_WORDS[a.kind] ?? 'An';
  const on = a.mr ? ` on ${short(a.mr)}` : a.ticket ? ` on ${a.ticket}` : '';
  return `${kind} agent finished${on}`;
}

export function agentRewards(agents) {
  return agents.filter((a) => a.kind !== MASTER && a.sessionId).flatMap((a) => {
    const first = (a.turns ?? []).find((t) => t.ok && Number.isFinite(t.at));
    return first ? [reward('agent', `agent:${a.sessionId}`, iso(first.at), agentWords(a))] : [];
  });
}

// An agent's own transcript is already counted, so its recorded turns stand in only for one whose transcript was not found.
export function agentTokens(agents, sessions) {
  const days = {};
  for (const a of agents) {
    if (!a.sessionId || sessions.has(a.sessionId)) continue;
    for (const t of a.turns ?? []) {
      if (!Number.isFinite(t.at) || !(t.tokens > 0)) continue;
      const day = dayOf(t.at);
      days[day] = (days[day] ?? 0) + t.tokens;
    }
  }
  return days;
}

export function addTokenDays(...sets) {
  const out = {};
  for (const set of sets) for (const [day, n] of Object.entries(set)) out[day] = (out[day] ?? 0) + n;
  return out;
}

export function tokenRewards(days, rate, now) {
  const today = dayOf(now);
  const amounts = tokenReward(rate);
  return Object.entries(days).sort().flatMap(([day, tokens]) => Array.from({ length: Math.floor(tokens / TOKENS_PER_BLOCK) }, (_, n) => {
    const at = day === today ? iso(now) : middayOf(day);
    return reward('tokens', `tokens:${day}:${n + 1}`, at, `${n + 1} million tokens ${day === today ? 'today' : 'on ' + dateWords(day)}`, amounts);
  }));
}

// A wait still open past angry marks its day at once, so a day is never called calm while someone on it is still waiting.
export function waitFacts(agents, now, open) {
  const waiting = new Map(agents.filter((a) => waitsOnYou(a) && Number.isFinite(a.since)).map((a) => [a.handle, a.since]));
  const facts = [];
  for (const since of new Set(waiting.values())) {
    if (now - since >= MOOD_MINUTES.angry * MINUTE) facts.push({ kind: 'event', what: 'angry', key: `angry:${dayOf(since)}`, day: dayOf(since), at: iso(now) });
  }
  for (const [handle, since] of open) {
    if (waiting.get(handle) === since) continue;
    const agent = agents.find((a) => a.handle === handle);
    const minutes = Math.round(((now - since) / MINUTE) * 10) / 10;
    facts.push({ kind: 'event', what: 'wait', key: `wait:${handle}:${since}`, day: dayOf(since), at: iso(now), minutes, answered: Boolean(agent) && agent.outcome !== 'stopped' });
  }
  return { facts, open: waiting };
}

function seeded(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function lastDays(day, n) {
  return Array.from({ length: n }, (_, i) => addDays(day, -1 - i));
}

const METRICS = {
  needs: (s, day) => (s.needs.has(day) ? 1 : 0),
  quick: (s, day) => s.waits[day]?.quick ?? 0,
};
const metricOn = (s, metric, day) => METRICS[metric]?.(s, day) ?? s.days.get(day)?.[metric] ?? 0;

export function questPlan(s, day) {
  const days = lastDays(day, BACKFILL_DAYS);
  return QUESTS.map((q) => {
    const active = days.map((d) => metricOn(s, q.metric, d)).filter((n) => n > 0);
    const [usual, low, high] = q.target;
    const target = Math.min(high, Math.max(low, Math.round(active.length ? median(active) : usual)));
    return { ...q, target, weight: Math.max(0.3, (q.core ? 2 : 0) + active.length / 10) };
  });
}

export function drawQuests(s, day) {
  const pool = questPlan(s, day);
  const rand = seeded(day);
  const picked = [];
  while (picked.length < QUESTS_A_DAY && pool.length) {
    let roll = rand() * pool.reduce((sum, q) => sum + q.weight, 0);
    const at = pool.findIndex((q) => (roll -= q.weight) < 0);
    const [q] = pool.splice(at < 0 ? pool.length - 1 : at, 1);
    picked.push({ id: q.id, target: q.target, label: q.label(q.target) });
  }
  return picked;
}

export function questProgress(s, day) {
  const done = s.questDone[day] ?? new Set();
  return (s.quests[day] ?? []).map((q) => {
    const metric = QUESTS.find((x) => x.id === q.id)?.metric;
    const have = metric ? metricOn(s, metric, day) : 0;
    return { ...q, have: Math.min(have, q.target), done: done.has(q.id) };
  });
}

export function followUps(s, now, { drawToday = true } = {}) {
  const today = dayOf(now);
  const at = iso(now);
  if (drawToday && !s.quests[today]) return [{ kind: 'quests', key: `quests:${today}`, day: today, at, quests: drawQuests(s, today) }];
  const quests = questProgress(s, today).filter((q) => !q.done && q.have >= q.target)
    .map((q) => reward('quest', `quest:${today}:${q.id}`, at, `Quest done: ${q.label}`));
  if (quests.length) return quests;
  const stats = statsOf(s, today);
  return ACHIEVEMENTS.filter((a) => !s.unlocked[a.id] && a.test(stats))
    .map((a) => reward('achievement', `achievement:${a.id}`, at, `Achievement: ${a.name}`, a.badge ? { xp: 0, coins: 0 } : REWARDS.achievement));
}
