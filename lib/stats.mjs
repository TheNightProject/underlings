import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { dayIn, zoneName } from './clock.mjs';
import { afterFetch, engine, engineError, failure, forgeFor, GITLAB, inbox, MR_KEY, notify, supports } from './engine.mjs';
import * as locale from './locale.mjs';
import { APP_NAME } from './product.mjs';
import { keyOf, keyPath } from './refs.mjs';
import { stateDir } from './home.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const GITLAB_EVERY_MS = 15 * MINUTE;
const MERGE_WINDOW_MS = 30 * DAY;
const DAYS_SHOWN = 14;
const SAMPLE_EVERY_MS = HOUR;
const SAMPLE_MATCH_MS = 12 * HOUR;
const SAMPLES_KEPT_MS = 21 * DAY;
const CHANGES_REQUESTED = 'REQUESTED_CHANGES';
const LAUNCH_SIGN_MS = 6 * HOUR;

export const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR', 'NIT', 'QUESTION'];
export const STAGES = [['draft', 'Draft'], ['review', 'In review'], ['changes', 'Changes requested'], ['approved', 'Approved'], ['mergeable', 'Mergeable']];
export const AGES = [['Under 1 h', HOUR], ['1 to 4 h', 4 * HOUR], ['4 to 24 h', DAY], ['1 to 3 days', 3 * DAY], ['Over 3 days', Infinity]];
export const FATES = [['posted', 'Posted'], ['discarded', 'Discarded'], ['handedBack', 'Handed back'], ['waiting', 'Waiting'], ['withdrawn', 'Withdrawn or expired']];
export const PEOPLE_SERIES = [['sent', 'Sent'], ['handedBack', 'Handed back']];
const KIND_WORDS = { finding: ['finding', 'findings'], reply: ['reply', 'replies'], verdict: ['verdict', 'verdicts'] };

export const METRICS = [
  { id: 'waiting', label: 'Waiting on your review', unit: 'count', better: 'down', figure: waitingFigure,
    defines: 'Open MRs that list you as a reviewer and you have not approved, now, against the reading nearest 7 days ago.' },
  { id: 'firstReview', label: 'Time to your first review', unit: 'duration', better: 'down', figure: firstReviewFigure,
    defines: 'Median time from an MR that lists you as a reviewer being opened to its first review run or first queued finding, over the MRs first reviewed in the week.' },
  { id: 'findings', label: 'Findings posted', unit: 'count', better: null, figure: findingsFigure,
    defines: 'Findings raised in the week that reached GitLab; the share discarded is of the ones posted or discarded by you.' },
  { id: 'open', label: 'Your open MRs', unit: 'count', better: null, figure: openFigure,
    defines: `Your open MRs in the repos ${APP_NAME} watches, now; one waits on you when a reply waits on your answer or changes were requested.` },
  { id: 'fullAuto', label: 'Full auto sent without you', unit: 'count', better: null, figure: fullAutoFigure,
    defines: 'Findings, replies and verdicts full auto posted itself in the week.' },
  { id: 'runs', label: 'Review runs', unit: 'count', better: null, figure: runsFigure,
    defines: 'MRs whose latest review run started in the week, as the engine keeps one run per MR; a launch error is one the engine recorded, and a run that reported one still ran if items were queued on its MR within 6 hours of its start.' },
];

export const CHARTS = [
  { id: 'perDay', title: 'Findings per day', build: perDayChart,
    defines: 'Findings raised each day of the last 14, by what became of them: posted, discarded by you, handed back by full auto for you to decide, still waiting for you, or never posted because full auto withdrew it for a newer pass or its MR closed first.' },
  { id: 'severity', title: 'Findings by severity', build: severityChart,
    defines: 'Findings raised in the last 7 days, by severity; raised counts every one, the ones still waiting and the ones full auto withdrew included.' },
  { id: 'stages', title: 'Your open MRs by stage', build: stagesChart,
    defines: 'Draft; mergeable when GitLab says it can merge; changes requested when a reviewer asked for them or a thread is unresolved; approved; otherwise in review.' },
  { id: 'merge', title: 'Time to merge', build: mergeChart,
    defines: 'Your MRs merged in the last 30 days, each from being opened to being merged, with their median.' },
  { id: 'ages', title: 'How long findings have waited for you', build: agesChart,
    defines: 'Everything in the review queue waiting for you to post or discard, by how long ago it was queued.' },
  { id: 'people', title: 'Full auto per person', build: peopleChart,
    defines: 'Per MR author over the last 7 days: what full auto posted without you, and what it handed back to you instead.' },
];

const WINDOWS = { name: 'Weeks and days', defines: 'A week is the 7 days ending now, against the 7 days before it; a day is a calendar day in your time zone.' };

const at = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isNaN(ms) ? null : ms;
};
const kindOf = (item) => item.kind ?? (item.replyTo ? 'reply' : 'finding');
const failed = (run) => /fail/.test(run.status ?? '');
const sentByFullAuto = (item) => item.status === 'posted' && Boolean(item.auto?.sentAuto);
const earliest = (values) => values.map(at).filter((ms) => ms != null).reduce((a, b) => Math.min(a, b), Infinity);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Rolling weeks: 0 is the 7 days ending now, 1 the 7 days before; anything else is neither.
export function weekOf(ms, now) {
  if (ms == null || ms > now) return null;
  if (ms > now - WEEK) return 0;
  return ms > now - 2 * WEEK ? 1 : null;
}

export function toneOf(change, better) {
  if (change == null) return null;
  if (change === 0 || !better) return 'flat';
  return (change > 0) === (better === 'up') ? 'good' : 'bad';
}

export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Full auto's own withdrawals are not yours, and a held item counts as handed back whatever you did with it after.
export function fateOf(item) {
  if (item.auto?.held) return 'handedBack';
  if (item.status === 'posted') return 'posted';
  if (item.status === 'pending') return 'waiting';
  return item.auto?.superseded || item.status === 'expired' ? 'withdrawn' : 'discarded';
}

export function stageOf(row) {
  if (row.draft) return 'draft';
  if (row.mergeStatus === 'MERGEABLE') return 'mergeable';
  if (row.mergeStatus === CHANGES_REQUESTED || row.unresolved > 0) return 'changes';
  return row.approvedBy?.length ? 'approved' : 'review';
}

// Stepped on the calendar rather than in milliseconds, so a clock change never skips or repeats a day.
export function lastDays(now, count, timeZone) {
  const today = Date.parse(dayIn(now, timeZone) + 'T00:00:00Z');
  return Array.from({ length: count }, (_, i) => new Date(today - (count - 1 - i) * DAY).toISOString().slice(0, 10));
}

export const zoneOr = (name) => zoneName(name) ?? locale.zone();

export function computeStats(input) {
  const s = prepare(input);
  return {
    generatedAt: new Date(s.now).toISOString(),
    timeZone: s.timeZone,
    headline: METRICS.map((metric) => headline(metric, s)),
    charts: Object.fromEntries(CHARTS.map(({ id, title, build }) => [id, { title, ...build(s) }])),
    definitions: [...METRICS.map(({ label, defines }) => ({ name: label, defines })), ...CHARTS.map(({ title, defines }) => ({ name: title, defines })), WINDOWS],
    gitlab: { fetchedAt: s.gitlab.fetchedAt ?? null, error: s.gitlab.error ?? null, loading: Boolean(s.gitlab.loading) },
  };
}

function prepare(input) {
  const queue = input.queue ?? [];
  const runs = (input.runs ?? []).filter((r) => MR_KEY.test(r.key ?? ''));
  const s = {
    now: input.now,
    timeZone: zoneOr(input.timeZone),
    me: input.me ?? null,
    rows: input.rows ?? null,
    queue,
    findings: queue.filter((i) => kindOf(i) === 'finding'),
    queueFrom: earliest(queue.map((i) => i.createdAt)),
    runs,
    memory: input.memory ?? {},
    history: input.history ?? [],
    gitlab: input.gitlab ?? {},
  };
  s.firstReviews = firstReviewsOf(s);
  return s;
}

function headline(metric, s) {
  const { value = null, previous = null, note = null, alert = false, empty = null, before = null } = metric.figure(s);
  const change = value != null && previous != null ? value - previous : null;
  const { id, label, unit, better } = metric;
  return { id, label, unit, better, value, previous, change, tone: toneOf(change, better), note, alert, empty, before: change == null && value != null ? before : null };
}

const covers = (from, s) => from <= s.now - 2 * WEEK;
const previousIfCovered = (from, s, previous) => (covers(from, s) ? { previous } : { before: 'The records do not reach back to the week before' });

function nearestSample(history, target) {
  let best = null;
  for (const sample of history) {
    const off = Math.abs(sample.at - target);
    if (off <= SAMPLE_MATCH_MS && (!best || off < Math.abs(best.at - target))) best = sample;
  }
  return best;
}

function previousReading(s, field) {
  const sample = nearestSample(s.history, s.now - WEEK);
  return Number.isFinite(sample?.[field]) ? { previous: sample[field] } : { before: 'No reading from a week ago yet' };
}

function waitingFigure(s) {
  if (!s.rows) return { empty: 'The MR list has not loaded yet' };
  return { value: s.rows.filter((r) => r.flags?.waitingOnYou).length, ...previousReading(s, 'waiting') };
}

function firstReviewFigure(s) {
  const gap = gitlabGap(s, 'reviewed');
  if (gap) return { empty: gap };
  const [now, before] = [0, 1].map((week) => s.firstReviews.filter((r) => weekOf(r.at, s.now) === week).map((r) => r.wait));
  if (!now.length) return { empty: 'No MR had its first review from you this week' };
  const previous = median(before);
  return { value: median(now), previous, note: 'over ' + plural(now.length, 'MR'), before: previous == null ? 'No first review the week before' : null };
}

function firstReviewsOf(s) {
  if (!s.gitlab.reviewed) return [];
  const first = new Map();
  const see = (key, ms) => {
    const known = first.get(key);
    if (ms != null && (known === undefined || ms < known)) first.set(key, ms);
  };
  for (const item of s.queue) see(keyOf(item), at(item.createdAt));
  for (const run of s.runs) if (!failed(run)) see(run.key, at(run.startedAt));
  return s.gitlab.reviewed
    .filter((mr) => mr.author !== s.me && first.has(mr.key) && at(mr.createdAt) != null)
    .map((mr) => ({ key: mr.key, at: first.get(mr.key), wait: first.get(mr.key) - at(mr.createdAt) }))
    .filter((r) => r.wait >= 0);
}

const noFates = () => Object.fromEntries(FATES.map(([id]) => [id, 0]));

function countFates(items) {
  const counts = noFates();
  for (const item of items) counts[fateOf(item)] += 1;
  return counts;
}

function findingsInWeek(s, week) {
  return s.findings.filter((i) => weekOf(at(i.createdAt), s.now) === week);
}

function findingsFigure(s) {
  if (!s.queue.length) return { empty: 'No findings recorded yet' };
  const now = countFates(findingsInWeek(s, 0));
  const decided = now.posted + now.discarded;
  const note = decided ? Math.round((now.discarded / decided) * 100) + '% discarded' : null;
  return { value: now.posted, note, ...previousIfCovered(s.queueFrom, s, countFates(findingsInWeek(s, 1)).posted) };
}

const waitsOnMe = (row) => stageOf(row) === 'changes' || row.threads?.awaitingYou > 0;

function openFigure(s) {
  if (!s.rows) return { empty: 'The MR list has not loaded yet' };
  const mine = s.rows.filter((r) => r.flags?.mine);
  return { value: mine.length, note: mine.filter(waitsOnMe).length + ' wait on you', ...previousReading(s, 'open') };
}

function sentInWeek(s, week) {
  return s.queue.filter((i) => sentByFullAuto(i) && weekOf(at(i.postedAt), s.now) === week);
}

function fullAutoFigure(s) {
  if (!s.queue.length) return { empty: 'Nothing recorded yet' };
  const now = sentInWeek(s, 0);
  return { value: now.length, note: kindsNote(now), ...previousIfCovered(s.queueFrom, s, sentInWeek(s, 1).length) };
}

function kindsNote(items) {
  const said = Object.entries(KIND_WORDS).map(([kind, [one, many]]) => {
    const n = items.filter((i) => kindOf(i) === kind).length;
    return n ? `${n} ${n === 1 ? one : many}` : null;
  });
  return said.filter(Boolean).join(', ') || null;
}

function runsFigure(s) {
  if (!s.runs.length) return { empty: 'No review run recorded yet' };
  const inWeek = (week) => s.runs.filter((r) => weekOf(at(r.startedAt), s.now) === week);
  const now = inWeek(0);
  const from = earliest(s.runs.map((r) => r.startedAt));
  return { value: now.length, ...launchNote(s, now), ...previousIfCovered(from, s, inWeek(1).length) };
}

function launchNote(s, runs) {
  const errored = runs.filter(failed);
  if (!errored.length) return { note: runs.length ? 'No launch errors' : null };
  const ran = errored.filter((run) => queuedSoonAfter(s, run)).length;
  return { alert: true, note: `${errored.length} of ${runs.length} reported a launch error` + (ran ? `, ${ran} ran anyway` : '') };
}

// The engine records a launch error whenever its send to the terminal errors, even when the review then ran.
function queuedSoonAfter(s, run) {
  const from = at(run.startedAt);
  return s.queue.some((item) => {
    const ms = at(item.createdAt);
    return keyOf(item) === run.key && ms != null && ms >= from && ms - from <= LAUNCH_SIGN_MS;
  });
}

function perDayChart(s) {
  if (!s.findings.length || !Number.isFinite(s.queueFrom)) return { empty: 'No findings recorded yet', series: FATES, days: [] };
  const firstDay = dayIn(s.queueFrom, s.timeZone);
  const days = lastDays(s.now, DAYS_SHOWN, s.timeZone).filter((day) => day >= firstDay).map((day) => ({ day, ...noFates() }));
  const byDay = new Map(days.map((d) => [d.day, d]));
  for (const item of s.findings) {
    const ms = at(item.createdAt);
    const day = ms != null && ms <= s.now ? byDay.get(dayIn(ms, s.timeZone)) : null;
    if (day) day[fateOf(item)] += 1;
  }
  return { series: FATES, days };
}

const titleCase = (word) => word.charAt(0) + word.slice(1).toLowerCase();

function severityChart(s) {
  if (!s.findings.length) return { empty: 'No findings recorded yet', series: FATES, rows: [] };
  const week = findingsInWeek(s, 0);
  if (!week.length) return { empty: 'No findings raised in the last 7 days', series: FATES, rows: [] };
  const others = [...new Set(week.map((i) => i.severity ?? 'UNSET'))].filter((name) => !SEVERITIES.includes(name));
  const rows = [...SEVERITIES, ...others].map((severity) => {
    const items = week.filter((i) => (i.severity ?? 'UNSET') === severity);
    return { severity, label: titleCase(severity), total: items.length, ...countFates(items) };
  });
  return { series: FATES, rows };
}

function stagesChart(s) {
  if (!s.rows) return { empty: 'The MR list has not loaded yet', rows: [] };
  const mine = s.rows.filter((r) => r.flags?.mine);
  if (!mine.length) return { empty: `You have no open MRs in the repos ${APP_NAME} watches`, rows: [] };
  const rows = STAGES.map(([stage, label]) => {
    const mrs = mine.filter((r) => stageOf(r) === stage);
    return { stage, label, count: mrs.length, mrs: mrs.map((r) => ({ key: r.key, title: r.title })) };
  });
  return { rows };
}

function gitlabGap(s, field) {
  if (s.gitlab[field]) return null;
  if (s.gitlab.waiting) return 'Waiting for ' + s.gitlab.waiting;
  return s.gitlab.error ? 'GitLab did not answer: ' + s.gitlab.error : 'Reading GitLab';
}

function mergeChart(s) {
  const gap = gitlabGap(s, 'merged');
  if (gap) return { empty: gap, points: [] };
  const from = s.now - MERGE_WINDOW_MS;
  const points = s.gitlab.merged
    .map((mr) => ({ key: mr.key, title: mr.title, mergedAt: mr.mergedAt, ms: at(mr.mergedAt) - at(mr.createdAt) }))
    .filter((p) => at(p.mergedAt) > from && at(p.mergedAt) <= s.now && p.ms >= 0)
    .sort((a, b) => at(a.mergedAt) - at(b.mergedAt));
  if (!points.length) return { empty: 'None of your MRs merged in the last 30 days', points };
  return { points, median: median(points.map((p) => p.ms)), from: new Date(from).toISOString(), to: new Date(s.now).toISOString() };
}

export const ageBucket = (ms) => AGES.findIndex(([, under]) => ms < under);

function agesChart(s) {
  const waiting = s.queue.filter((i) => i.status === 'pending' && at(i.createdAt) != null);
  if (!waiting.length) return { empty: 'Nothing is waiting for you to post or discard', rows: [] };
  const rows = AGES.map(([label]) => ({ label, count: 0 }));
  for (const item of waiting) rows[ageBucket(Math.max(0, s.now - at(item.createdAt)))].count += 1;
  return { rows, oldestAt: new Date(earliest(waiting.map((i) => i.createdAt))).toISOString() };
}

function authorOf(s, key) {
  return s.memory[key]?.pass?.author ?? s.rows?.find((r) => r.key === key)?.author ?? s.gitlab.reviewed?.find((mr) => mr.key === key)?.author ?? 'Unknown';
}

function peopleChart(s) {
  const byFullAuto = s.queue.filter((i) => i.auto);
  if (!byFullAuto.length) return { empty: 'Full auto has not reviewed anything yet', series: PEOPLE_SERIES, rows: [] };
  const people = new Map();
  const add = (item, field) => {
    const person = authorOf(s, keyOf(item));
    const row = people.get(person) ?? { person, sent: 0, handedBack: 0 };
    row[field] += 1;
    people.set(person, row);
  };
  for (const item of byFullAuto) {
    if (sentByFullAuto(item) && weekOf(at(item.postedAt), s.now) === 0) add(item, 'sent');
    if (item.auto.held && weekOf(at(item.createdAt), s.now) === 0) add(item, 'handedBack');
  }
  const rows = [...people.values()].sort((a, b) => b.sent + b.handedBack - (a.sent + a.handedBack) || a.person.localeCompare(b.person));
  return rows.length ? { series: PEOPLE_SERIES, rows } : { empty: 'Full auto sent and handed back nothing in the last 7 days', series: PEOPLE_SERIES, rows };
}

export const ROUTES = {
  'GET /api/stats': ({ query }) => readStats(query.get('tz')),
};

export const ACTIONS = {};

let unsubscribe = null;
let sampling = null;
const gitlab = { me: null, merged: null, reviewed: null, error: null, fetchedAt: null, triedAt: 0, loading: null };

export function start() {
  unsubscribe = afterFetch(sample);
}

export function stop() {
  unsubscribe?.();
  unsubscribe = null;
}

export async function readStats(zone, now = Date.now()) {
  if (!engine) throw failure(503, engineError);
  const me = inbox?.me ?? null;
  return computeStats({
    now,
    timeZone: zone,
    me,
    rows: inbox ? engine.rowsFor(inbox).map(statRow) : null,
    queue: [...engine.loadQueue(), ...archived()],
    runs: Object.values(engine.loadRuns()),
    memory: engine.loadAutoMemory(),
    history: await readHistory(),
    gitlab: gitlabFor(me, now),
  });
}

// Clean up moves settled items out of the queue, and the weekly figures still count them.
function archived() {
  return engine.loadArchive?.({ limit: Number.MAX_SAFE_INTEGER }).items ?? [];
}

function statRow({ mr, key, flags }) {
  return {
    key, title: mr.title, author: mr.author, draft: mr.draft, mergeStatus: mr.mergeStatus ?? null, unresolved: mr.unresolvedThreads ?? 0,
    approvedBy: mr.approvedBy ?? [], flags: flags ?? {}, threads: inbox.threads?.get(key) ?? null,
  };
}

function gitlabFor(me, now) {
  if (!me) return { waiting: 'the MR list to load' };
  const due = gitlab.me !== me || now - gitlab.triedAt >= GITLAB_EVERY_MS;
  if (due && !gitlab.loading) readGitLabInBackground(me, now);
  return { ...gitlab, loading: Boolean(gitlab.loading) };
}

function readGitLabInBackground(me, now) {
  if (gitlab.me !== me) Object.assign(gitlab, { me, merged: null, reviewed: null, error: null, fetchedAt: null });
  gitlab.triedAt = now;
  gitlab.loading = readGitLab(me, now)
    .then(({ merged, reviewed }) => Object.assign(gitlab, { merged, reviewed, error: null, fetchedAt: new Date().toISOString() }))
    .catch((err) => { gitlab.error = err.message; })
    .finally(() => {
      gitlab.loading = null;
      notify('stats');
    });
}

async function readGitLab(me, now) {
  const watched = await watchedPaths();
  const kept = (mr) => !watched || watched.has(keyPath(mr.key));
  const forge = forgeFor(GITLAB, 'mergedBy', 'reviewedBy');
  const [merged, reviewed] = await Promise.all([
    forge.mergedBy(me, new Date(now - MERGE_WINDOW_MS).toISOString()),
    forge.reviewedBy(me, new Date(now - 2 * WEEK).toISOString()),
  ]);
  return { merged: merged.filter(kept), reviewed: reviewed.filter(kept) };
}

async function watchedPaths() {
  if (!supports('currentRepos')) return null;
  const repos = await engine.currentRepos().catch(() => null);
  return repos?.length ? new Set(repos.map((r) => r.path)) : null;
}

const historyFile = () => join(stateDir(), 'stats-history.json');

async function readHistory() {
  try {
    const list = JSON.parse(await readFile(historyFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// The counts that only exist as "now" are kept once an hour, so a week later there is something to compare them with.
function sample(data) {
  if (!engine) return;
  const rows = engine.rowsFor(data);
  const reading = { at: Date.now(), waiting: rows.filter((r) => r.flags?.waitingOnYou).length, open: rows.filter((r) => r.flags?.mine).length };
  sampling = (sampling ?? Promise.resolve()).then(() => keepSample(reading)).catch(() => {});
}

async function keepSample(reading) {
  const history = await readHistory();
  const last = history.at(-1);
  if (last && reading.at - last.at < SAMPLE_EVERY_MS) return;
  const kept = [...history.filter((s) => reading.at - s.at < SAMPLES_KEPT_MS), reading];
  await mkdir(dirname(historyFile()), { recursive: true });
  await writeFile(historyFile(), JSON.stringify(kept) + '\n');
}
