import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';

process.env['UNDERLINGS_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'standup-test-'));
process.env['UNDERLINGS_LOCALE_FILE'] = join(process.env['UNDERLINGS_STATE_DIR'], 'locale.json');
writeFileSync(process.env['UNDERLINGS_LOCALE_FILE'], JSON.stringify({ locale: { region: 'en-GB', clock: '24' } }));
process.env['UNDERLINGS_JIRA_SITE'] = 'example.atlassian.net';
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/standup/${name}`, import.meta.url), 'utf8');
const MRS = JSON.parse(fixture('mrs.json')) as Record<string, unknown>;
const EVENTS = JSON.parse(fixture('events.json')) as unknown[];
const OPEN = JSON.parse(fixture('open-mrs.json')) as unknown[];
const MERGED = JSON.parse(fixture('merged-mrs.json')) as unknown[];
const APPROVALS = JSON.parse(fixture('approvals.json')) as Record<string, string[]>;
const JIRA = JSON.parse(fixture('jira.json')) as Record<string, unknown>;
const ICS = fixture('calendar.ics');
const CALENDAR = 'https://calendar.google.com/calendar/ical/frank.foster%40example.com/private-0123456789abcdef/basic.ics';

const asked: string[] = [];
const jql: string[] = [];
let gitlabDown = false;
let jiraDown: string | null = null;
let calendarStatus = 200;
const realFetch = globalThis.fetch;

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  asked.push(url.origin === 'https://gitlab.com' ? `${url.pathname.replace('/api/v4', '')}${url.search}` : url.href);
  if (url.href === CALENDAR) return new Response(calendarStatus === 200 ? ICS : 'Not Found', { status: calendarStatus });
  if (gitlabDown) return json({ message: '500 Internal Server Error' }, 500);
  return gitlab(url);
}) as typeof fetch;

function gitlab(url: URL): Response {
  const path = url.pathname.replace('/api/v4', '');
  const query = url.searchParams;
  if (path === '/user') return json({ id: 2101, username: 'frank.foster' });
  if (path === '/events') return json(query.get('page') === '1' ? EVENTS : []);
  if (path === '/merge_requests') return json(query.get('state') === 'opened' ? OPEN : MERGED);
  const approvals = /^\/projects\/(\d+)\/merge_requests\/(\d+)\/approvals$/.exec(path);
  if (approvals) return json({ approved_by: (APPROVALS[`${approvals[1]}!${approvals[2]}`] ?? []).map((username) => ({ user: { username } })) });
  const one = /^\/projects\/(\d+)\/merge_requests\/(\d+)$/.exec(path);
  if (one) return MRS[`${one[1]}!${one[2]}`] ? json(MRS[`${one[1]}!${one[2]}`]) : json({ message: '404 Not found' }, 404);
  return json({ message: `${path} is not stubbed` }, 404);
}

const fakeExecFile = Object.assign(() => undefined, {
  [promisify.custom]: (_cmd: string, args: string[]) => {
    const query = args[args.indexOf('--jql') + 1] ?? '';
    jql.push(query);
    if (jiraDown) return Promise.reject(Object.assign(new Error('acli failed'), { stdout: jiraDown }));
    const status = /CHANGED TO "([^"]+)"/.exec(query)?.[1];
    const answer = status ? JIRA[status] : JIRA['inProgress'];
    if (typeof answer === 'string') return Promise.reject(Object.assign(new Error('acli failed'), { stdout: answer }));
    return Promise.resolve({ stdout: JSON.stringify(answer) });
  },
});
Object.assign(childProcess, { execFile: fakeExecFile });
syncBuiltinESMExports();
const { buildStandup, eventWindow, NO_CALENDAR } = await import('./standup/build.js');
type Built = Awaited<ReturnType<typeof buildStandup>>;

after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  asked.length = 0;
  jql.length = 0;
  gitlabDown = false;
  jiraDown = null;
  calendarStatus = 200;
});

function post(built: Built, onlyTicked = true): string {
  return built.sections.map((s) => [`${s.title}:`, ...s.groups.flatMap((g) => g.lines.filter((l) => !onlyTicked || l.ticked).map((l) => `- [${l.tag}] ${l.text}`))].join('\n')).join('\n');
}

const groupOf = (built: Built, id: string) => built.sections.flatMap((s) => s.groups).find((g) => g.id === id);

test('a day reads as the post, from the events, the MRs, Jira and the calendar', async () => {
  const built = await buildStandup({ day: '2026-11-09', calendarAddress: CALENDAR, excludedRepos: ['tooling/dashboard', 'tooling/sandbox'] });
  assert.equal(built.today, '2026-11-10');
  assert.equal(post(built), [
    'Yesterday:',
    "- [ABC-1234] Merged order-book !895: require the billing:write scope on the invoice routes",
    '- [ABC-4290] Merged frontend !1699: stop the login loop on refresh',
    '- [ABC-4262] Opened atlas !45: show job logs in the Jobs pane',
    '- [ABC-1234] Moved to QA: Gate invoice writes on billing:write',
    '- [ABC-4290] Moved to Done: Login loop on refresh',
    '- [ABC-4225] Moved to Done: atlas: show the Jobs pane',
    '- [Meeting: Vendor findings walkthrough] 11:00 with Ivan',
    '- [Meeting: GBAC Rundown] 14:15 with Heidi and Niaj',
    '- [Meeting: 1:1 Frank / Judy (moved)] 16:00 with Judy',
    '- [Review - ABC-4389] relay !1177, 6 comments, approved: narrow relay subscriptions',
    '- [Review - ABC-4389] relay !1180, 1 comment: count deliveries per subscriber',
    '- [Review - ABC-4401] frontend !1702, 2 comments: keep the team menu open on refresh',
    '- [Review - ABC-4410] gateway !212, approved: bump http-kit to 0.11.7',
    '- [Review - NoTicket] desk-booking !2, 5 comments, approved: use shared CI components',
    'Today:',
    '- [ABC-4262] Address the review on atlas !45 (changes requested)',
    '- [ABC-4300] Chase review on order-book !901 (awaiting review)',
    '- [ABC-4318] Merge frontend !1710 (ready to merge)',
    '- [ABC-4330] Finish gateway !215 (draft)',
    '- [ABC-4335] Fix conflicts on relay !1190 (conflict)',
    '- [?] Chase review on desk-booking !3 (awaiting review)',
    '- [ABC-4344] Engineering mail relay allowlist (In Progress)',
    '- [ABC-4380] Digest view in the dashboard (In Progress)',
    '- [Meeting: Architecture discussion] 10:30 with Niaj and Judy',
  ].join('\n'));
});

test('a meeting with nobody else in it, or none at all, is offered unticked, and what you declined or was cancelled is not offered', async () => {
  const built = await buildStandup({ day: '2026-11-09', calendarAddress: CALENDAR });
  const unticked = groupOf(built, 'meetings')?.lines.filter((l) => !l.ticked).map((l) => `[${l.tag}] ${l.text}`);
  assert.deepEqual(unticked, ['[Meeting: Working from home] all day', '[Meeting: Focus: control centre] 08:00', '[Meeting: Lunch] 12:30', '[Meeting: School Run] 15:00']);
  assert.doesNotMatch(post(built, false), /All hands|Platform sync/);
});

test('a line with no ticket is marked so it can be fixed', async () => {
  const built = await buildStandup({ day: '2026-11-09', excludedRepos: [] });
  const unknown = built.sections.flatMap((s) => s.groups).flatMap((g) => g.lines).filter((l) => l.unknown).map((l) => l.id);
  assert.deepEqual(unknown, ['merged:acme/tooling/sandbox!80', 'opened:acme/tooling/dashboard!30', 'open:acme/internal/desk-booking!3', 'open:acme/tooling/dashboard!30']);
});

test('the repos left out are not listed at all, an MR there still covers its ticket, and by default none is left out', async () => {
  const shown = post(await buildStandup({ day: '2026-11-09' }), false);
  assert.match(shown, /Opened dashboard !30/);
  assert.match(shown, /Merged sandbox !80/);
  assert.match(shown, /sandbox !88, 4 comments/);
  const kept = post(await buildStandup({ day: '2026-11-09', excludedRepos: ['tooling/dashboard', 'tooling/sandbox'] }), false);
  assert.doesNotMatch(kept, /dashboard !|sandbox !/);
});

test('without a calendar address the meetings say how to add one, and the calendar is never asked', async () => {
  const built = await buildStandup({ day: '2026-11-09' });
  assert.equal(groupOf(built, 'meetings')?.note, NO_CALENDAR);
  assert.equal(groupOf(built, 'today-meetings')?.note, NO_CALENDAR);
  assert.ok(!asked.some((url) => url.includes('calendar')));
});

test('a calendar that refuses says so in its own group, without repeating its secret address', async () => {
  calendarStatus = 404;
  const built = await buildStandup({ day: '2026-11-09', calendarAddress: CALENDAR });
  const error = groupOf(built, 'meetings')?.error ?? '';
  assert.match(error, /answered 404/);
  assert.ok(!error.includes('private-0123456789abcdef'));
  assert.ok(groupOf(built, 'merged')?.lines.length, 'GitLab is still read');
});

test('GitLab failing fails only what it feeds, and Jira failing only what Jira feeds', async () => {
  gitlabDown = true;
  const built = await buildStandup({ day: '2026-11-09' });
  for (const id of ['merged', 'opened', 'reviews', 'open']) assert.match(groupOf(built, id)?.error ?? '', /GitLab 500/, id);
  assert.equal(groupOf(built, 'moved')?.lines.length, 3);
  gitlabDown = false;
  jiraDown = 'Error: unauthorized: use "acli jira auth login" to authenticate';
  const again = await buildStandup({ day: '2026-11-09' });
  assert.match(groupOf(again, 'moved')?.error ?? '', /unauthorized/);
  assert.match(groupOf(again, 'progress')?.error ?? '', /unauthorized/);
  assert.ok(groupOf(again, 'merged')?.lines.length);
});

test('a status the Jira workflow lacks is no failure, and each status is asked for on its own for that day', async () => {
  const built = await buildStandup({ day: '2026-11-09' });
  assert.deepEqual([groupOf(built, 'moved')?.error, groupOf(built, 'moved')?.lines.length], [null, 3]);
  assert.deepEqual(jql.filter((q) => q.includes('CHANGED')), ['QA', 'Resolved', 'Done', 'Closed'].map(
    (s) => `assignee = currentUser() AND status CHANGED TO "${s}" DURING ("2026-11-09 00:00", "2026-11-09 23:59") ORDER BY updated DESC`,
  ));
  assert.ok(jql.includes('assignee = currentUser() AND statusCategory = "In Progress" ORDER BY updated DESC'));
});

test('events are asked for over every UTC day the London day touches, then trimmed to it', async () => {
  assert.deepEqual(eventWindow('2026-11-09'), { after: '2026-11-08', before: '2026-11-10' });
  assert.deepEqual(eventWindow('2026-07-01'), { after: '2026-06-29', before: '2026-07-02' });
  const built = await buildStandup({ day: '2026-11-09' });
  assert.ok(asked.includes('/events?after=2026-11-08&before=2026-11-10&per_page=100&page=1'));
  assert.match(post(built), /relay !1177, 6 comments/, 'the comment late on the 8th is left out');
});

test('a fresh install in Tokyo cuts the day at Tokyo midnight, so the evening in London is the next day there', async () => {
  assert.deepEqual(eventWindow('2026-11-09', 'Asia/Tokyo'), { after: '2026-11-07', before: '2026-11-10' });
  assert.deepEqual(eventWindow('2026-11-09', 'America/New_York'), { after: '2026-11-08', before: '2026-11-11' });
  const shown = post(await buildStandup({ day: '2026-11-09', timeZone: 'Asia/Tokyo', workDays: [1, 2, 3, 4, 5] }));
  assert.ok(asked.includes('/events?after=2026-11-07&before=2026-11-10&per_page=100&page=1'));
  assert.match(shown, /Merged order-book !895/, 'merged at 19:12 in Tokyo');
  assert.doesNotMatch(shown, /frontend !1699/, 'merged at 00:40 on the 10th in Tokyo');
  assert.match(shown, /relay !1177, 7 comments, approved/, 'the comment at 08:30 on the 9th in Tokyo counts');
  assert.doesNotMatch(shown, /gateway !212|desk-booking !2/, 'after midnight in Tokyo');
});

test('a meeting\'s time is written as your region and clock write it', async () => {
  const meetings = (built: Built) => groupOf(built, 'meetings')?.lines.map((l) => l.text);
  assert.ok(meetings(await buildStandup({ day: '2026-11-09', calendarAddress: CALENDAR }))?.includes('11:00 with Ivan'), 'with no region or clock given, London time on the 24 hour clock');
  assert.ok(meetings(await buildStandup({ day: '2026-11-09', calendarAddress: CALENDAR, region: 'en-US', clock: '' }))?.includes('11:00 AM with Ivan'));
  assert.ok(meetings(await buildStandup({ day: '2026-11-09', calendarAddress: CALENDAR, timeZone: 'America/New_York', region: 'en-US', clock: '24' }))?.includes('06:00 with Ivan'));
});

test('the next working day comes from your working week', async () => {
  assert.equal((await buildStandup({ day: '2026-11-12', workDays: [0, 1, 2, 3, 4] })).today, '2026-11-15', 'Thursday to Sunday for a Sunday to Thursday week');
  assert.equal((await buildStandup({ day: '2026-11-13' })).today, '2026-11-16', 'Friday to Monday by default');
});

test('a reviewed MR GitLab will not show is left out and said so', async () => {
  const saved = MRS['105!1702'];
  delete MRS['105!1702'];
  try {
    const built = await buildStandup({ day: '2026-11-09' });
    assert.equal(groupOf(built, 'reviews')?.note, 'GitLab would not show one MR, so it is left out.');
    assert.equal(groupOf(built, 'merged')?.note, null);
  } finally {
    MRS['105!1702'] = saved;
  }
});

test('a day that is not a date is refused before anything is asked', async () => {
  await assert.rejects(buildStandup({ day: '9 Nov' }), /looks like 2026-11-09/);
  assert.deepEqual(asked, []);
});
