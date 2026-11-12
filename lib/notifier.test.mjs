import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, mock, test } from 'node:test';

const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca';
const commands = [];
mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      commands.push([cmd, ...args]);
      setImmediate(() => done(cmd === ORCA ? null : Object.assign(new Error('stubbed'), { code: 1 }), cmd === ORCA ? JSON.stringify({ ok: true, result: {} }) : '', ''));
    },
  },
});

const { freshLedger, idle, inQuietHours, plan, rebuild, start, stop, validTarget, view } = await import('./notifier.mjs');
const { loadEngine, refreshInbox } = await import('./engine.mjs');
const { mr, reset, world } = await import('./testkit.mjs');

const NOW = Date.parse('2026-11-04T12:00:00');
const MIN = 60_000;
const open = new Set(['acme/a!1', 'acme/b!2', 'acme/c!3', 'acme/d!4']);
const it = (key, kind, extra = {}) => ({ id: `${key}:${kind}`, key, kind, tier: 'interrupt', settled: true, why: `${kind} on ${key}`, tab: 'threads', prints: null, settleAfterMs: 0, group: 'others', ...extra });
const seeded = (items = []) => {
  const l = freshLedger();
  plan({ items, openKeys: open, ledger: l, now: NOW - MIN });
  return l;
};
const run = (l, items, now = NOW, extra = {}) => plan({ items, openKeys: open, ledger: l, now, ...extra });

test('the first run seeds every item silently', () => {
  const l = freshLedger();
  const out = run(l, [it('acme/a!1', 'replied'), it('acme/b!2', 'asked')]);
  assert.deepEqual([out.banners, out.toasts], [[], []]);
  assert.equal(l.items['acme/a!1:replied'].via, 'seed');
});

test('no item fires twice, across a restart too', () => {
  const l = seeded();
  assert.equal(run(l, [it('acme/a!1', 'replied')]).banners.length, 1);
  const restarted = JSON.parse(JSON.stringify(l));
  assert.deepEqual(run(restarted, [it('acme/a!1', 'replied')], NOW + MIN).banners, []);
});

test('new ids carrying the same prints stay quiet', () => {
  const l = seeded();
  assert.equal(run(l, [it('acme/a!1', 'findings', { id: 'f1', prints: ['src/a.ts|null check'] })]).banners.length, 1);
  assert.deepEqual(run(l, [it('acme/a!1', 'findings', { id: 'f2', prints: ['src/a.ts|null check'] })], NOW + 40 * MIN).banners, []);
  assert.equal(run(l, [it('acme/a!1', 'findings', { id: 'f3', prints: ['src/a.ts|null check', 'src/b.ts|retry'] })], NOW + 80 * MIN).banners.length, 1, 'one new print is news');
});

test('one MR gets one banner naming its top reason, with how to open it', () => {
  const l = seeded();
  const [banner, ...rest] = run(l, [it('acme/a!1', 'replied', { why: 'Judy replied' }), it('acme/a!1', 'findings', { why: '3 to post' })]).banners;
  assert.deepEqual(rest, []);
  assert.equal(banner.title, 'a!1: Judy replied');
  assert.equal(banner.body, '3 to post\nCmd+J, Underlings: Open what needs me');
  assert.equal(banner.target, 'mr:acme/a!1:threads');
  assert.equal(l.latest.target, 'mr:acme/a!1:threads');
});

test('an email banner names only its subject and a fixed reason, and opens the Email view; a quiet one never fires', () => {
  const l = seeded();
  const email = (id, extra = {}) => ({ id: `email:${id}:t`, key: null, kind: 'email', group: 'email', tier: 'interrupt', settled: true, title: 'Budget for the offsite', why: 'asks you something', tab: 'email', from: 'Victor Vale', reason: 'Victor wants it signed off.', prints: null, settleAfterMs: 0, ...extra });
  const out = run(l, [email('a1'), email('a2', { tier: 'badge', title: 'Old news' })]);
  assert.deepEqual(out.banners.map(({ title, target }) => [title, target]), [['Budget for the offsite: asks you something', 'email']]);
  assert.doesNotMatch(JSON.stringify(out.banners), /Victor/);
  assert.equal(validTarget('email'), true, 'a click on it may open the Email view');
});

test('a Slack banner names only the channel, the sender and a fixed reason, and opens the Slack view; a quiet one never fires', () => {
  const l = seeded();
  const slack = (id, extra = {}) => ({ id: `slack:${id}:t`, key: null, kind: 'slack', group: 'slack', tier: 'interrupt', settled: true, title: '#platform · Victor Vale', why: 'mentions you', tab: 'slack', from: 'Victor Vale', reason: 'Victor wants the deploy checked.', prints: null, settleAfterMs: 0, ...extra });
  const out = run(l, [slack('c1'), slack('c2', { tier: 'badge', title: 'DM · Wendy West' })]);
  assert.deepEqual(out.banners.map(({ title, body, target }) => [title, body, target]), [['#platform · Victor Vale: mentions you', 'Cmd+J, Underlings: Open what needs me', 'slack']]);
  assert.doesNotMatch(JSON.stringify(out.banners), /deploy|Wendy/);
  assert.equal(validTarget('slack'), true, 'a click on it may open the Slack view');
});

test('a target may name a ticket or an agent, which is how the Claude Code window hands a click to the dashboard', () => {
  for (const target of ['ticket:ABC-2871', 'agent:claude:00000000-0000-4000-8000-000000000201']) assert.equal(validTarget(target), true, target);
  for (const target of ['ticket:abc-1', 'ticket:ABC-1:agent', 'ticket:ABC-0', 'agent:', 'agent:a b', 'agent:../x/y', 'agent:' + 'a'.repeat(201)]) assert.equal(validTarget(target), false, target);
});

test('three MRs at once make one digest, one line per MR', () => {
  const l = seeded();
  const out = run(l, [it('acme/a!1', 'replied'), it('acme/b!2', 'asked'), it('acme/c!3', 'red'), it('acme/c!3', 'comments')]);
  assert.equal(out.banners.length, 1);
  assert.equal(out.banners[0].title, '4 things need you on 3 MRs');
  assert.equal(out.banners[0].body.split('\n').length, 4);
  assert.equal(out.banners[0].target, 'needs-you');
  assert.equal(run(seeded(), [it('acme/a!1', 'replied'), it('acme/b!2', 'asked')]).banners.length, 2, 'two MRs are two banners');
});

test('at most one banner per MR and kind every 30 minutes, the later one waiting rather than lost', () => {
  const l = seeded();
  run(l, [it('acme/a!1', 'replied', { id: 'r1' })]);
  assert.deepEqual(run(l, [it('acme/a!1', 'replied', { id: 'r2' })], NOW + 10 * MIN).banners, []);
  assert.equal(run(l, [it('acme/a!1', 'replied', { id: 'r2' })], NOW + 31 * MIN).banners.length, 1);
});

test('at most six banners an hour, the overflow going in one digest once there is room', () => {
  const l = seeded();
  for (let n = 0; n < 6; n += 1) assert.equal(run(l, [it('acme/a!1', `k${n}`)], NOW + n * MIN).banners.length, 1);
  for (const at of [7, 20, 35, 50]) assert.deepEqual(run(l, [it('acme/b!2', 'asked')], NOW + at * MIN).banners, [], `full at ${at} min`);
  const later = run(l, [it('acme/b!2', 'asked')], NOW + 61 * MIN);
  assert.equal(later.banners.length, 1);
  assert.match(later.banners[0].title, /^1 thing needs you on 1 MR$/);
});

test('a focused page gets a toast, and that item never fires a banner later', () => {
  const l = seeded();
  const out = run(l, [it('acme/a!1', 'replied')], NOW, { focused: { page: 'p1' } });
  assert.deepEqual([out.banners.length, out.toasts.map((t) => t.target)], [0, ['mr:acme/a!1:threads']]);
  assert.deepEqual(run(l, [it('acme/a!1', 'replied')], NOW + MIN).banners, []);
});

test('quiet hours hold everything, then send it as one digest when they end', () => {
  const l = seeded();
  l.prefs = { ...l.prefs, quiet: true, quietFrom: '11:00', quietTo: '13:00' };
  assert.deepEqual(run(l, [it('acme/a!1', 'replied')]).banners, []);
  const after = run(l, [it('acme/a!1', 'replied')], NOW + 61 * MIN);
  assert.equal(after.banners.length, 1);
  assert.equal(after.banners[0].target, 'needs-you', 'a digest, even for one MR');
  assert.equal(inQuietHours({ quiet: true, quietFrom: '22:00', quietTo: '07:00' }, Date.parse('2026-11-04T23:30:00')), true, 'a window over midnight');
  assert.equal(inQuietHours({ quiet: false, weekends: true }, Date.parse('2026-11-07T12:00:00')), true, 'and weekends');
});

test('a muted MR is silent, and Unmute lets the next reason through', () => {
  const l = seeded();
  l.muted['acme/a!1'] = { until: NOW + 24 * 60 * MIN };
  l.muted['acme/b!2'] = { merged: true };
  assert.deepEqual(run(l, [it('acme/a!1', 'replied'), it('acme/b!2', 'asked')]).banners, []);
  delete l.muted['acme/a!1'];
  assert.equal(run(l, [it('acme/a!1', 'replied')], NOW + MIN).banners.length, 1);
});

test('badges, unsettled items and a change request inside its 45 minutes never fire', () => {
  const l = seeded();
  const items = [it('acme/a!1', 'up', { tier: 'badge' }), it('acme/b!2', 'replied', { settled: false }), it('acme/c!3', 'changes', { settleAfterMs: 45 * MIN })];
  assert.deepEqual(run(l, items).banners, []);
  assert.deepEqual(run(l, items, NOW + 46 * MIN).banners.map((b) => b.ids), [['acme/c!3:changes']]);
});

test('a process that is not the sender plans nothing and marks nothing', () => {
  const l = seeded();
  assert.deepEqual(run(l, [it('acme/a!1', 'replied')], NOW, { sender: false }).banners, []);
  assert.equal(l.items['acme/a!1:replied'].notifiedAt, undefined);
});

test('a start more than 15 minutes after the last run sends one catch-up digest', () => {
  const l = seeded();
  const out = run(l, [it('acme/a!1', 'replied')], NOW + 20 * MIN);
  assert.equal(out.banners.length, 1);
  assert.match(out.banners[0].title, /^While Underlings was off: 1 thing needs you on 1 MR$/);
});

test('with notifications off nothing goes, and nothing floods in when they come back on', () => {
  const l = seeded();
  l.prefs.enabled = false;
  assert.deepEqual(run(l, [it('acme/a!1', 'replied')]).banners, []);
  l.prefs.enabled = true;
  assert.deepEqual(run(l, [it('acme/a!1', 'replied')], NOW + MIN).banners, []);
});

test('a poll that misses MRs, as one failed batch does, keeps what was sent, Later and the mutes, so nothing repeats and a mute holds', () => {
  const l = seeded();
  l.muted['acme/b!2'] = { merged: true };
  l.muted['acme/c!3'] = { until: NOW + 24 * 60 * MIN };
  assert.equal(run(l, [it('acme/a!1', 'replied')]).banners.length, 1);
  l.later['acme/a!1'] = 'mark';
  plan({ items: [], openKeys: new Set(['acme/d!4']), ledger: l, now: NOW + MIN });
  assert.deepEqual([l.muted['acme/b!2'], l.muted['acme/c!3']?.until, l.later['acme/a!1']], [{ merged: true }, NOW + 24 * 60 * MIN, 'mark']);
  const back = run(l, [it('acme/a!1', 'replied'), it('acme/b!2', 'asked'), it('acme/c!3', 'asked')], NOW + 2 * MIN);
  assert.deepEqual(back.banners, []);
  assert.deepEqual(run(l, [it('acme/a!1', 'replied'), it('acme/b!2', 'asked'), it('acme/c!3', 'asked')], NOW + 40 * MIN).banners, [], 'and not half an hour later either');
});

test('an MR gone for a week is forgotten, and a mute until it merges ends once GitLab says it has', () => {
  const l = seeded([it('acme/a!1', 'replied')]);
  l.muted['acme/b!2'] = { merged: true };
  l.prints['acme/a!1'] = ['src/a.ts|null check'];
  plan({ items: [], openKeys: new Set(), ledger: l, now: NOW });
  assert.deepEqual(l.muted['acme/b!2'], { merged: true }, 'missing is not merged');
  l.gone['acme/b!2'].end = { state: 'merged', mergedBy: 'frank' };
  plan({ items: [], openKeys: new Set(), ledger: l, now: NOW + MIN });
  assert.equal(l.muted['acme/b!2'], undefined);
  plan({ items: [], openKeys: new Set(), ledger: l, now: NOW + 8 * 24 * 60 * MIN });
  assert.deepEqual([l.items['acme/a!1:replied'], l.prints['acme/a!1'], l.gone['acme/a!1']], [undefined, undefined, undefined]);
});

// The worker side: the real rebuild against the stand-in engine, with the alert and Orca stubbed.
const dir = await mkdtemp(join(tmpdir(), 'control-centre-notifier-'));
after(() => rm(dir, { recursive: true }));
const alerts = [];
let alertFails = null;
const shell = { alert: async (title, body) => { if (alertFails) throw new Error(alertFails); alerts.push([title, body]); return { delivered: true }; }, notify: () => {}, log: () => {} };
const config = { stateDir: dir, orcaUserDataPath: '/orca', workspaceRoot: '/ws-root', port: 47480 };

beforeEach(async () => {
  stop();
  await idle();
  await rm(join(dir, 'attention.json'), { force: true });
  await rm(join(dir, 'banner-app.json'), { force: true });
  alerts.length = 0;
  commands.length = 0;
  alertFails = null;
  reset({ mrs: [mr('acme/engine', 1121, { author: 'ivan' })], settings: { workspaceRoot: '/ws-root' } });
  await loadEngine({ matrixEngine: new URL('./testkit.mjs', import.meta.url).pathname }, () => {});
  await refreshInbox();
  await start(config, shell);
});
afterEach(() => mock.timers.reset());

async function firstRunThenNew() {
  await rebuild();
  world.mrs.push(mr('acme/engine', 1130, { author: 'judy', sha: 'bbb222' }));
  await refreshInbox();
  await rebuild(Date.now() + 1);
  await idle();
}

test('a worker\'s first rebuild seeds, and a review asked of you later sends one banner', async () => {
  await firstRunThenNew();
  assert.deepEqual(alerts.map(([title]) => title), ['engine!1130: asks for your review']);
  const saved = JSON.parse(await readFile(join(dir, 'attention.json'), 'utf8'));
  assert.equal(saved.items['acme/engine!1130:asked:bbb222'].via, 'desktop');
  assert.equal(view().latest.target, 'mr:acme/engine!1130:overview');
});

test('merge when green merging your MR sends one banner once it leaves the list, read as merged from GitLab, and stays in Needs you to dismiss', async () => {
  world.mrs.push(mr('acme/portal', 88, { author: 'frank', autoMerge: true, title: 'Ship the portal' }));
  await refreshInbox();
  await rebuild();
  world.mrs = world.mrs.filter((m) => m.iid !== 88);
  world.ends['acme/portal!88'] = { state: 'merged', mergedBy: 'frank' };
  await refreshInbox();
  await rebuild(Date.now() + 1);
  await idle();
  assert.deepEqual(alerts.map(([title]) => title), ['portal!88: merge when green merged it']);
  assert.deepEqual(world.calls.filter(([n]) => n === 'fetchMrEnd'), [['fetchMrEnd', 'acme/portal', 88]]);
  const card = view().cards.find((c) => c.key === 'acme/portal!88');
  assert.deepEqual([card.title, card.reasons.map((r) => [r.kind, r.next, r.later])], ['Ship the portal', [['merged', 'dismiss', 'merged']]]);
  assert.equal(view().latest.target, 'needs-you', 'it has no drawer to open');
  await rebuild(Date.now() + 2);
  await idle();
  assert.equal(alerts.length, 1, 'once');
  const { ROUTES } = await import('./notifier.mjs');
  await ROUTES['POST /api/attention/later']({ body: async () => ({ key: 'acme/portal!88', mark: 'merged' }) });
  assert.deepEqual([view().later['acme/portal!88'], view().cards.some((c) => c.key === 'acme/portal!88')], ['merged', false], 'Dismiss puts it away, and the page can read that');
});

test('the worker hands the page the mark of each verdict card, so the decide card can share its Later', async () => {
  world.mrs = [mr('acme/engine', 1121, { author: 'ivan', sha: 'bbb222' })];
  world.watches = {};
  world.queue = [{ id: 'p1', status: 'posted', projectPath: 'acme/engine', iid: 1121, kind: 'finding', postedAt: '2026-11-05T11:00:00Z', createdAt: '2026-11-05T10:00:00Z' }];
  await refreshInbox();
  await rebuild();
  assert.deepEqual(view().verdictMarks, { 'acme/engine!1121': 'bbb222||2026-11-05T11:00:00Z' });
});

test('an MR merely missing from one poll is asked about, and nothing is said while GitLab has it open', async () => {
  world.mrs.push(mr('acme/portal', 88, { author: 'frank', autoMerge: true }));
  await refreshInbox();
  await rebuild();
  world.mrs = world.mrs.filter((m) => m.iid !== 88);
  await refreshInbox();
  await rebuild(Date.now() + 1);
  await idle();
  assert.deepEqual(alerts, []);
  assert.equal(view().cards.some((c) => c.key === 'acme/portal!88'), false);
});

test('only the oldest live worker sends, whichever worker holds the full auto turn', async () => {
  const now = Date.now();
  world.lock.holder = { owner: 'control-centre', pid: process.pid, token: 't', startedAt: now, beatAt: now };
  world.lock.frontends = {
    older: { owner: 'control-centre', pid: process.pid + 1, startedAt: now - 60_000, beatAt: now },
    ours: { owner: 'control-centre', pid: process.pid, startedAt: now, beatAt: now },
  };
  await firstRunThenNew();
  assert.deepEqual(alerts, [], 'an older worker is the sender');
  delete world.lock.frontends.older;
  world.mrs.push(mr('acme/engine', 1140, { author: 'judy', sha: 'ccc333' }));
  await refreshInbox();
  await rebuild(Date.now() + 2);
  await idle();
  assert.equal(alerts.length, 2, 'and once it has gone, this one sends both');
});

test('the app sends while it runs, though the plugin started first', async () => {
  const now = Date.now();
  world.lock.frontends = {
    plugin: { owner: 'control-centre', pid: process.pid + 1, startedAt: now - 60_000, beatAt: now },
    app: { owner: 'control-centre', pid: process.pid, startedAt: now, beatAt: now },
  };
  stop();
  await start(config, { ...shell, desktop: {} });
  await firstRunThenNew();
  assert.equal(alerts.length, 1);
});

test('the plugin stays quiet while the app runs, and sends again once the app has gone', async () => {
  const now = Date.now();
  await writeFile(join(dir, 'banner-app.json'), JSON.stringify({ pid: process.pid + 1 }));
  world.lock.frontends = {
    plugin: { owner: 'control-centre', pid: process.pid, startedAt: now - 60_000, beatAt: now },
    app: { owner: 'control-centre', pid: process.pid + 1, startedAt: now, beatAt: now },
  };
  await firstRunThenNew();
  assert.deepEqual(alerts, [], 'the app is the sender');
  delete world.lock.frontends.app;
  world.mrs.push(mr('acme/engine', 1140, { author: 'judy', sha: 'ccc333' }));
  await refreshInbox();
  await rebuild(Date.now() + 2);
  await idle();
  assert.equal(alerts.length, 2, 'its pid left in the file no longer counts');
});

test('a test banner goes out from this worker even when another is the sender, and says when it did not', async () => {
  const now = Date.now();
  world.lock.frontends = {
    older: { owner: 'control-centre', pid: process.pid + 1, startedAt: now - 60_000, beatAt: now },
    ours: { owner: 'control-centre', pid: process.pid, startedAt: now, beatAt: now },
  };
  const { ROUTES } = await import('./notifier.mjs');
  assert.deepEqual(await ROUTES['POST /api/attention/test'](), { text: 'Test banner sent.' });
  assert.deepEqual(alerts, [['Underlings', 'Banners from Underlings show here.']]);
  alertFails = 'notifications are turned off for Underlings';
  assert.deepEqual(await ROUTES['POST /api/attention/test'](), { text: 'The test banner did not go out: notifications are turned off for Underlings.' });
  assert.equal(view().notReaching, 'notifications are turned off for Underlings');
});

test('an alert that throws marks the dashboard\'s workspace unread, never with a comment, and says why', async () => {
  alertFails = 'notifications are turned off for Orca';
  await firstRunThenNew();
  const marked = commands.filter((c) => c[1] === 'worktree' && c[2] === 'set');
  assert.deepEqual(marked.map((c) => c.slice(1, 6)), [['worktree', 'set', '--worktree', 'path:/ws-root', '--unread']]);
  assert.ok(!commands.flat().includes('--comment'));
  assert.equal(view().notReaching, 'notifications are turned off for Orca');
});

test('a clickable offer the page does not confirm within 10 s goes out as Orca\'s banner', async () => {
  const { ROUTES } = await import('./notifier.mjs');
  await ROUTES['POST /api/attention/prefs']({ body: async () => ({ clickable: true }) });
  await ROUTES['POST /api/attention/presence']({ body: async () => ({ page: 'page-1', focused: false, visible: false, permission: 'granted' }) });
  mock.timers.enable({ apis: ['setTimeout'] });
  await firstRunThenNew();
  assert.deepEqual(alerts, []);
  assert.equal(view().offers.length, 1);
  mock.timers.tick(10_000);
  await idle();
  assert.equal(alerts.length, 1);
  assert.equal(view().offers.length, 0);
});

test('a confirmed clickable offer sends no Orca banner', async () => {
  const { ROUTES } = await import('./notifier.mjs');
  await ROUTES['POST /api/attention/prefs']({ body: async () => ({ clickable: true }) });
  await ROUTES['POST /api/attention/presence']({ body: async () => ({ page: 'page-1', focused: false, visible: false, permission: 'granted' }) });
  mock.timers.enable({ apis: ['setTimeout'] });
  await firstRunThenNew();
  await ROUTES['POST /api/attention/ack']({ body: async () => ({ id: view().offers[0].id }) });
  mock.timers.tick(10_000);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(alerts, []);
});

test('a focused page is shown a toast, not a banner', async () => {
  const { ROUTES } = await import('./notifier.mjs');
  await rebuild();
  await ROUTES['POST /api/attention/presence']({ body: async () => ({ page: 'page-2', focused: true, visible: true, permission: 'default' }) });
  world.mrs.push(mr('acme/engine', 1150, { author: 'judy', sha: 'ddd444' }));
  await refreshInbox();
  await rebuild(Date.now() + 1);
  await idle();
  assert.deepEqual(alerts, []);
  assert.deepEqual(view().toasts.map((t) => t.title), ['engine!1150: asks for your review']);
});

test('mute, later and the notification settings are checked and clamped', async () => {
  const { ROUTES } = await import('./notifier.mjs');
  const call = (route, body) => ROUTES[`POST /api/attention/${route}`]({ body: async () => body });
  await assert.rejects(call('mute', { key: 'not a key', until: 'day' }), { status: 400 });
  await assert.rejects(call('mute', { key: 'acme/engine!1121', until: 'forever' }), { status: 400 });
  await assert.rejects(call('prefs', { quietFrom: '25:00' }), { status: 400 });
  await assert.rejects(call('presence', { page: '<script>' }), { status: 400 });
  await call('mute', { key: 'acme/engine!1121', until: 'merged' });
  await call('prefs', { quiet: true, quietFrom: '21:30', enabled: 'yes' });
  const saved = JSON.parse(await readFile(join(dir, 'attention.json'), 'utf8'));
  assert.deepEqual(saved.muted['acme/engine!1121'], { merged: true });
  assert.deepEqual([saved.prefs.quiet, saved.prefs.quietFrom, saved.prefs.enabled], [true, '21:30', true]);
});

test('saves at once each land a whole ledger, as mutes clicked while a build is saving do', async () => {
  const { ROUTES } = await import('./notifier.mjs');
  const keys = Array.from({ length: 8 }, (_, n) => `acme/engine!${n + 1}`);
  await Promise.all(keys.map((key) => ROUTES['POST /api/attention/mute']({ body: async () => ({ key, until: 'merged' }) })));
  const saved = JSON.parse(await readFile(join(dir, 'attention.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.muted).sort(), [...keys].sort());
});

const claudeAgent = (handle, name, state, since, ask = null) => ({ handle, name, title: name, state, since, lastAt: since, alive: true, said: '', ask, pending: ask });
// An earlier test leaves a focused page behind, which would turn every banner into a toast.
const unfocus = async () => (await import('./notifier.mjs')).ROUTES['POST /api/attention/presence']({ body: async () => ({ page: 'page-2', focused: false, visible: false, permission: 'default' }) });

test('every agent asking you counts on the badge beside the MR cards, kickoff or not, and nothing is asked of Orca', async () => {
  world.agents = [claudeAgent('claude:kick', 'kickoff-ABC-12', 'waiting', 1), claudeAgent('claude:other', 'scratch', 'blocked', 2, { id: 'r1', tool: 'Bash', summary: 'ls' }), claudeAgent('claude:busy', 'busy', 'working', 3)];
  world.runs = { 'ticket:ABC-12': { key: 'ticket:ABC-12', status: 'running', startedAt: '2026-11-04T11:00:00Z', terminal: 'claude:kick', kickoff: true } };
  await rebuild(Date.now() + 60 * MIN);
  const v = view();
  assert.deepEqual(v.agents.map((i) => i.kind).sort(), ['agent', 'kickoff-asks']);
  assert.equal(v.count, v.cards.length + 2);
  assert.deepEqual(commands.filter(([cmd]) => cmd === ORCA), []);
});

test('an agent that asks sends a banner, as a fix agent\'s ask does, and the next question sends another', async () => {
  await unfocus();
  await firstRunThenNew();
  alerts.length = 0;
  world.agents = [claudeAgent('claude:scratch', 'review-Engine-9', 'blocked', 5, { id: 'r1', tool: 'Bash', summary: 'git push' })];
  await rebuild(Date.now() + 2);
  await idle();
  assert.deepEqual(alerts.map(([title]) => title), ['review-Engine-9: review-Engine-9 asks to use Bash']);
  world.agents = [claudeAgent('claude:scratch', 'review-Engine-9', 'waiting', 6, { id: 'r2', tool: 'AskUserQuestion', questions: [] })];
  await rebuild(Date.now() + 31 * MIN);
  await idle();
  assert.equal(alerts.length, 2);
});

test('in the app a banner that throws leaves Orca alone, as there is no Orca workspace to mark', async () => {
  await unfocus();
  stop();
  await start(config, { ...shell, desktop: { notify() {} } });
  alertFails = 'macOS will not show notifications for the app';
  await firstRunThenNew();
  assert.deepEqual(commands.filter(([cmd]) => cmd === ORCA), []);
  assert.equal(view().notReaching, 'macOS will not show notifications for the app');
});

test('the page can tell Needs you has been built once, and is told even when the first build finds nothing', async () => {
  const fresh = await import('./notifier.mjs?first-build');
  const events = [];
  world.mrs = [];
  await loadEngine({ matrixEngine: new URL('./testkit.mjs', import.meta.url).pathname }, (event) => events.push(event));
  await refreshInbox();
  stop();
  // The refresh set the shared notifier building, so what it tells the page must land before the fresh one's events are counted.
  await idle();
  await fresh.start(config, shell);
  try {
    assert.deepEqual([fresh.view().builtAt, fresh.view().buildError], [null, null]);
    events.length = 0;
    await fresh.rebuild(NOW);
    await fresh.idle();
    assert.deepEqual([fresh.view().builtAt, fresh.view().cards], [new Date(NOW).toISOString(), []]);
    assert.deepEqual(events, ['matrix'], 'an empty first build still sends the page a change');
    await fresh.rebuild(NOW + 1);
    await fresh.idle();
    assert.deepEqual(events, ['matrix'], 'a later build that changes nothing stays quiet');
  } finally {
    fresh.stop();
  }
});

test('a build that throws is in the view until one succeeds', async () => {
  const settings = world.settings;
  Object.defineProperty(world, 'settings', { configurable: true, get() { throw new Error('settings unreadable'); } });
  try {
    await rebuild();
    await idle();
    assert.equal(view().buildError, 'settings unreadable');
  } finally {
    Object.defineProperty(world, 'settings', { configurable: true, writable: true, enumerable: true, value: settings });
  }
  await rebuild(Date.now() + 1);
  await idle();
  assert.equal(view().buildError, null);
});
