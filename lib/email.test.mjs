import assert from 'node:assert/strict';
import * as child from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gmailRun, INBOX, message, PICKS, thread } from './fixtures/gmail.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-connector-claude.mjs', import.meta.url));
const DRAFTER = '/fake/bin/claude';
const ACLI = '/fake/bin/acli';
const FOUR_MINUTES = 4 * 60_000;
let readTimeoutMs = FOUR_MINUTES;
const launched = [];
const { default: _unused, ...realChild } = child;

// Only the login shell and the ticket drafter are answered here; the Gmail read runs the fake Claude for real, on its four minutes unless a test sets readTimeoutMs.
mock.module('node:child_process', {
  namedExports: {
    ...realChild,
    execFile(cmd, args, options, done) {
      const stub = { stdin: { on() { return this; }, end() {} } };
      if (cmd === '/bin/zsh') {
        setImmediate(() => done(null, `__CONTROL_CENTRE_BIN__\nclaude=${DRAFTER}\nacli=${ACLI}\n`, ''));
        return stub;
      }
      if (cmd === DRAFTER) {
        launched.push({ cmd, args });
        const draft = { summary: 'Offsite: sign off the budget', description: 'Problem\nVictor needs the budget signed off.\n\nFix\nReview and sign it off.\n\nAcceptance criteria\n- The budget is signed off by Friday.' };
        setImmediate(() => done(null, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: draft }), ''));
        return stub;
      }
      launched.push({ cmd, args, timeout: options.timeout });
      return realChild.execFile(cmd, args, options.timeout === FOUR_MINUTES ? { ...options, timeout: readTimeoutMs } : options, done);
    },
  },
});

const home = await mkdtemp(join(tmpdir(), 'control-centre-email-'));
process.env.HOME = home;
process.env.UNDERLINGS_CLAUDE_BIN = FAKE;
process.env.GITLAB_TOKEN = 'gitlab-secret';
const fixtureFile = join(home, 'gmail.json');
const callsFile = join(home, 'calls.jsonl');
process.env.UNDERLINGS_FAKE_READ = fixtureFile;
process.env.UNDERLINGS_FAKE_READ_CALLS = callsFile;

const testkit = new URL('./testkit.mjs', import.meta.url).href;
const enginePath = join(home, 'engine.mjs');
await writeFile(enginePath, `import { world } from '${testkit}';
export * from '${testkit}';
export const claudeBinary = () => process.env.UNDERLINGS_CLAUDE_BIN;
export const childEnv = (bin, env = process.env) => ({ ...env, CHILD_ENV_MARK: 'agents' });
export async function viewTicket(key) { world.calls.push(['viewTicket', key]); const t = world.jira?.[key]; if (!t) throw new Error('no such work item'); return t; }
export async function createTicket(ticket) { world.calls.push(['createTicket', ticket]); return { key: 'ABC-4500', url: 'https://example.atlassian.net/browse/ABC-4500', summary: ticket.summary }; }
export async function startClaudeAgent(spec) { world.calls.push(['startClaudeAgent', spec]); return { handle: 'claude:chat-1' }; }
export function recordUsage(task, tokens) { world.calls.push(['recordUsage', task, tokens]); }
`);

const { route } = await import('./app.mjs');
const { loadEngine } = await import('./engine.mjs');
const email = await import('./email.mjs');
const locale = await import('./locale.mjs');
const claudepanel = await import('./claudepanel.mjs');
const { collect } = await import('./attention.mjs');
const { reset, world } = await import('./testkit.mjs');
after(() => rm(home, { recursive: true }));

const stateFile = join(home, '.local/state/underlings/email.json');
const lockFile = join(home, '.local/state/underlings/email.lock');
const settingsFile = join(home, '.config/underlings/email.json');
const notified = [];
const AT_NOW = new Date().toISOString();
const logs = [];

const call = (method, path, payload) => route({ method, path, query: new URLSearchParams(), body: async () => payload, config: {} });
const get = () => call('GET', '/api/email');
const post = (path, payload) => call('POST', path, payload);
const fixture = (value) => writeFile(fixtureFile, JSON.stringify(value));
const calls = async () => (await readFile(callsFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
const ids = (view) => view.threads.map((t) => t.id);
const saved = async () => JSON.parse(await readFile(stateFile, 'utf8'));

async function turnOn(extra = {}) {
  await post('/api/email/settings', { enabled: true, ...extra });
  await email.settled();
  return get();
}

beforeEach(async () => {
  await email.settled();
  email.stop();
  await rm(join(home, '.local'), { recursive: true, force: true });
  await rm(join(home, '.config'), { recursive: true, force: true });
  await locale.refresh();
  await rm(callsFile, { force: true });
  reset({ jira: { 'ABC-3789': { key: 'ABC-3789', summary: 'Team offsites', epic: true, type: 'Epic' }, 'ABC-12': { key: 'ABC-12', summary: 'A task', epic: false, type: 'Task' } } });
  readTimeoutMs = FOUR_MINUTES;
  launched.length = 0;
  notified.length = 0;
  logs.length = 0;
  await loadEngine({ matrixEngine: enginePath }, () => {});
  await fixture({ events: gmailRun() });
  await email.start({}, { notify: (event) => notified.push(event), log: (text) => logs.push(text) });
  await email.settled();
});

const profile = async (value) => {
  await mkdir(join(home, '.config/underlings'), { recursive: true });
  await writeFile(join(home, '.config/underlings/profile.json'), JSON.stringify(value));
};

test('the triage prompt speaks of the person named in the profile, in the language and rules it sets, and of "you" with none', async () => {
  await profile({ user: { name: 'Frank' }, style: { language: 'British English', rules: 'No em dashes.' } });
  await turnOn();
  const system = (run) => run.args[run.args.indexOf('--system-prompt') + 1];
  const named = system((await calls())[0]);
  assert.match(named, /^You read Frank's Gmail inbox and pick out the threads that need Frank\./);
  assert.match(named, /- mentioned: it names Frank in a thread written to other people;/);
  assert.match(named, /saying what Frank must do, in British English\.\nWriting rules for each reason: No em dashes\.$/);
  await profile({});
  await post('/api/email/refresh', {});
  await email.settled();
  const blank = system((await calls())[1]);
  assert.match(blank, /^You read your Gmail inbox and pick out the threads that need you\./);
  assert.match(blank, /A thread needs you when its latest message is from a person other than you/);
  assert.doesNotMatch(blank, /Frank|British|em dash/);
});

test('the spend cap and how often email is read are settings, and each read takes them', async () => {
  await turnOn();
  const was = (await calls())[0];
  assert.equal(was.args[was.args.indexOf('--max-budget-usd') + 1], '0.50', 'the cap it has always had');
  const saved = await post('/api/email/settings', { budgetUsd: '$1.20', everyMinutes: '60' });
  assert.deepEqual([saved.budgetUsd, saved.everyMinutes, (await get()).window.everyMinutes], ['1.20', 60, 60]);
  await post('/api/email/refresh', {});
  await email.settled();
  const read = (await calls()).at(-1);
  assert.equal(read.args[read.args.indexOf('--max-budget-usd') + 1], '1.20');
  const at = Date.parse('2026-11-10T10:00:00Z');
  const on = { enabled: true, everyMinutes: 60 };
  assert.equal(email.due(at, on, new Date(at - 59 * 60_000).toISOString()), false);
  assert.equal(email.due(at, on, new Date(at - 60 * 60_000).toISOString()), true);
  await assert.rejects(post('/api/email/settings', { budgetUsd: '-1' }), { status: 400 });
});

test('email is off until Frank turns it on: nothing is read, and the view says so', async () => {
  const view = await get();
  assert.equal(view.enabled, false);
  assert.deepEqual(view.threads, []);
  await assert.rejects(post('/api/email/refresh', {}), { status: 409, message: /email is off/ });
  await email.tick(Date.parse('2026-11-10T10:00:00Z'));
  assert.deepEqual(await calls(), [], 'no read runs while it is off');
});

test('a Gmail read runs on the model and effort Models gives Triage and reads, the view names it, and its tokens are counted under it', async () => {
  world.settings = { models: { reads: { model: 'claude-opus-5-5', effort: 'medium' } } };
  await fixture({ events: gmailRun({ result: { usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 4000, output_tokens: 20 } } }) });
  const view = await turnOn();
  const [run] = await calls();
  const flag = (name) => run.args[run.args.indexOf(name) + 1];
  assert.deepEqual([flag('--model'), flag('--effort'), view.model], ['claude-opus-5-5', 'medium', 'claude-opus-5-5']);
  assert.deepEqual(world.calls.filter(([name]) => name === 'recordUsage'), [['recordUsage', 'reads', 125]]);
});

test('turning it on reads Gmail once, through the agents\' Claude, as a one-shot Haiku run limited to search and read', async () => {
  await turnOn();
  const [run, ...more] = await calls();
  assert.equal(more.length, 0);
  const flag = (name) => run.args[run.args.indexOf(name) + 1];
  assert.equal(run.args[0], '-p');
  assert.equal(flag('--model'), 'haiku');
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--tools'), '', 'no built-in tools at all');
  assert.deepEqual(run.args.slice(run.args.indexOf('--allowedTools') + 1, run.args.indexOf('--disallowedTools')), ['mcp__claude_ai_Gmail__search_threads', 'mcp__claude_ai_Gmail__get_thread']);
  assert.ok(run.args.includes('--no-session-persistence'), 'no session on disk holds what it read');
  assert.equal(flag('--output-format'), 'stream-json');
  assert.deepEqual(Object.keys(JSON.parse(flag('--json-schema')).properties), ['threads']);
  assert.match(run.input, /"view":"THREAD_VIEW_SUMMARY"/);
  assert.deepEqual(run.env, { MCP_CONNECTION_NONBLOCKING: 'false', GITLAB_TOKEN: null, CHILD_ENV_MARK: 'agents' });
  assert.equal(launched.find((l) => l.cmd === FAKE && l.args[0] === '-p').timeout, FOUR_MINUTES, 'a hard timeout');
});

test('only the threads that need Frank are kept, newest first, from what Gmail itself returned', async () => {
  await fixture({ events: gmailRun({ picks: [...PICKS].reverse() }) });
  const view = await turnOn();
  assert.deepEqual(ids(view), ['a1b2c3d4e5f60001', 'a1b2c3d4e5f60002', 'a1b2c3d4e5f60005']);
  assert.deepEqual(view.threads.map((t) => t.kind), ['asked', 'waiting', 'invite']);
  const [first, second] = view.threads;
  assert.deepEqual(first, {
    id: 'a1b2c3d4e5f60001', link: 'https://mail.google.com/mail/?authuser=frank@example.com#all/a1b2c3d4e5f60001', from: { name: 'Victor Vale', address: 'victor@example.com' },
    subject: 'Budget for the offsite', snippet: 'Could you sign off the budget by Friday?', receivedAt: '2026-11-10T09:00:00.000Z', kind: 'asked',
    reason: 'Victor wants the offsite budget signed off by Friday.', handled: false, ticket: null,
  });
  assert.equal(second.subject, 'Re: Hiring panel & dates', 'entities from Gmail read as text');
  assert.equal(view.read, INBOX.length);
});

test('GitLab, Frank\'s own last word, an RSVP, a promotion and a thread Gmail never returned are left out whatever Claude says', async () => {
  const view = await turnOn();
  for (const id of ['a1b2c3d4e5f60003', 'a1b2c3d4e5f60004', 'a1b2c3d4e5f60006', 'a1b2c3d4e5f60007', 'ffffffffffff0000']) assert.ok(!ids(view).includes(id), id);
});

test('a sender on the skip list is left out of the search and of the list', async () => {
  await post('/api/email/settings', { skip: 'Wendy@example.org, @example.net' });
  const view = await turnOn();
  assert.ok(!ids(view).includes('a1b2c3d4e5f60002'));
  const [run] = await calls();
  assert.match(run.input, /-from:\(gitlab\.com OR atlassian\.net OR atlassian\.com OR slack\.com OR calendar-notification@google\.com OR wendy@example\.org OR example\.net\)/);
  assert.deepEqual((await call('GET', '/api/email/settings')).skip, ['wendy@example.org', 'example.net']);
  await assert.rejects(post('/api/email/settings', { skip: 'not a sender!' }), { status: 400 });
});

test('a thread read in full takes its latest message from that read, and only the kept fields are stored, readable only by Frank', async () => {
  const later = thread('a1b2c3d4e5f60001', [message('a1b2c3d4e5f60001.2', { at: '2026-11-10T11:00:00Z', snippet: 'x'.repeat(400), plaintextBody: 'BODY-MARKER the whole body' })]);
  await fixture({ events: gmailRun({ reads: [later] }) });
  const view = await turnOn();
  const first = view.threads.find((t) => t.id === 'a1b2c3d4e5f60001');
  assert.equal(first.receivedAt, '2026-11-10T11:00:00.000Z');
  assert.equal(first.snippet.length, 300);
  assert.ok(first.snippet.endsWith('…'));
  const file = await readFile(stateFile, 'utf8');
  assert.doesNotMatch(file, /BODY-MARKER|plaintextBody|labelIds|toRecipients/);
  assert.deepEqual(Object.keys((await saved()).threads[0]).sort(), ['from', 'id', 'kind', 'link', 'reason', 'receivedAt', 'snippet', 'subject']);
  assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
  assert.equal((await stat(settingsFile)).mode & 0o777, 0o600);
});

test('a link that is not Gmail\'s own is never kept, and a subject missing from the latest message comes from an earlier one', async () => {
  const odd = thread('a1b2c3d4e5f60001', [message('a1b2c3d4e5f60001'), message('a1b2c3d4e5f60001.2', { at: '2026-11-10T09:30:00Z', subject: null })]);
  await fixture({ events: gmailRun({ threads: [{ ...odd, viewUrl: 'javascript:alert(1)' }, ...INBOX.slice(1)] }) });
  const first = (await turnOn()).threads.find((t) => t.id === 'a1b2c3d4e5f60001');
  assert.equal(first.link, 'https://mail.google.com/mail/#all/a1b2c3d4e5f60001');
  assert.equal(first.subject, 'Budget for the offsite');
  assert.equal(first.receivedAt, '2026-11-10T09:30:00.000Z');
});

test('the view says which Claude account read it, with what, how long it took and what it cost', async () => {
  const view = await turnOn();
  assert.deepEqual(view.account, { email: 'frank@example.com', org: 'Example Ltd' });
  assert.equal(view.model, 'haiku');
  assert.equal(view.lastRun.costUsd, 0.0123);
  assert.ok(view.lastRun.ms >= 0 && view.lastRun.ok);
  assert.ok(view.fetchedAt);
  assert.deepEqual(view.window, { from: '08:00', to: '18:00', days: 'weekdays', everyMinutes: 30, lookBackDays: 7 });
});

test('an empty inbox is an empty list, not an error', async () => {
  await fixture({ events: gmailRun({ threads: [], picks: [] }) });
  const view = await turnOn();
  assert.deepEqual([view.threads, view.read, view.error], [[], 0, null]);
});

test('bad JSON, a stopped run, a refused search or no Gmail each say why, keep the last list and never repeat what Claude said', async () => {
  await turnOn();
  const cases = [
    [{ mode: 'garbage' }, 'Claude Code did not answer in the shape the read expects'],
    [{ events: gmailRun({ result: { subtype: 'error_max_budget_usd', is_error: true, result: 'Victor wrote: the secret plan' } }) }, 'Claude Code stopped: it reached its spending cap'],
    [{ events: gmailRun({ searchError: 'Victor wrote: the secret plan' }) }, 'Gmail refused the search'],
    [{ events: gmailRun({ tools: [] }) }, /^Claude Code has no Gmail tools/],
    [{ events: gmailRun({ result: { structured_output: { said: 'Victor wrote: the secret plan' } } }) }, "Claude's answer was not usable: it has no list of threads"],
  ];
  for (const [value, why] of cases) {
    await fixture(value);
    await post('/api/email/refresh', {});
    await email.settled();
    const view = await get();
    assert.match(view.error, why instanceof RegExp ? why : new RegExp(`^${why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
    assert.doesNotMatch(view.error, /secret plan/);
    assert.equal(view.threads.length, 3, 'the last good list stays');
    assert.equal(view.lastRun.ok, false);
  }
  assert.doesNotMatch(JSON.stringify(logs), /Victor|Budget|secret/);
});

test('a read that hangs is stopped at its hard timeout and says so', async () => {
  await turnOn();
  readTimeoutMs = 400;
  await fixture({ mode: 'hang' });
  await post('/api/email/refresh', {});
  await email.settled();
  assert.equal((await get()).error, 'the read took longer than 4 minutes, so it was stopped');
});

test('a Refresh while a read runs joins it, so two never run at once', async () => {
  await turnOn();
  await rm(callsFile, { force: true });
  await fixture({ events: gmailRun(), delayMs: 300 });
  const first = await post('/api/email/refresh', {});
  const second = await post('/api/email/refresh', {});
  assert.deepEqual([first.text, second.text], ['Reading your email', 'Already reading your email']);
  assert.equal((await get()).fetching, true);
  await email.settled();
  assert.equal((await calls()).length, 1);
  assert.equal((await get()).fetching, false);
});

test('a read another worker holds is never doubled, and a lock left by one that died is taken over', async () => {
  await turnOn();
  await rm(callsFile, { force: true });
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
  await post('/api/email/refresh', {});
  await email.settled();
  assert.equal((await calls()).length, 0);
  await writeFile(lockFile, JSON.stringify({ pid: 2 ** 22 + 7, at: Date.now() }));
  await post('/api/email/refresh', {});
  await email.settled();
  assert.equal((await calls()).length, 1);
  await assert.rejects(stat(lockFile), { code: 'ENOENT' }, 'the lock goes once the read ends');
});

test('it reads every 30 minutes in your working hours, by default 08:00 to 18:00 on weekdays, here in London', () => {
  const on = { enabled: true };
  const at = (iso) => Date.parse(iso);
  const before = (iso, minutes) => new Date(at(iso) - minutes * 60_000).toISOString();
  assert.equal(email.due(at('2026-11-10T08:00:00Z'), on, null), true, 'Tuesday 08:00 GMT');
  assert.equal(email.due(at('2026-11-10T07:59:00Z'), on, null), false);
  assert.equal(email.due(at('2026-11-10T17:59:00Z'), on, null), true);
  assert.equal(email.due(at('2026-11-10T18:00:00Z'), on, null), false);
  assert.equal(email.due(at('2026-07-01T07:30:00Z'), on, null), true, '08:30 in London in summer');
  assert.equal(email.due(at('2026-11-14T10:00:00Z'), on, null), false, 'never on a Saturday');
  assert.equal(email.due(at('2026-11-10T10:00:00Z'), on, before('2026-11-10T10:00:00Z', 29)), false);
  assert.equal(email.due(at('2026-11-10T10:00:00Z'), on, before('2026-11-10T10:00:00Z', 30)), true);
  assert.equal(email.due(at('2026-11-10T10:00:00Z'), { ...on, enabled: false }, null), false);
  assert.equal(email.due(at('2026-11-10T19:00:00Z'), on, null, { from: '07:00', to: '20:00', workDays: [2] }), true);
});

test('the schedule reads only when one is due, and a restart counts from the last read kept', async () => {
  await mkdir(join(home, '.config/underlings'), { recursive: true });
  await writeFile(settingsFile, JSON.stringify({ enabled: true }));
  await mkdir(join(home, '.local/state/underlings'), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ v: 1, threads: [], attemptedAt: '2026-11-10T09:45:00Z', handled: {}, tickets: {} }));
  await email.tick(Date.parse('2026-11-10T10:00:00Z'));
  assert.equal((await calls()).length, 0, 'fifteen minutes after the last read');
  await email.tick(Date.parse('2026-11-14T10:30:00Z'));
  assert.equal((await calls()).length, 0, 'Saturday');
  await email.tick(Date.parse('2026-11-10T10:15:00Z'));
  assert.equal((await calls()).length, 1);
});

test('email has no hours of its own: it reads in your working hours, and the view says them', async () => {
  await assert.rejects(post('/api/email/settings', { from: '07:30' }), { status: 400, message: /working hours/ });
  await post('/api/locale', { from: '07:30', to: '19:00', workDays: [0, 1, 2, 3, 4] });
  assert.deepEqual((await get()).window, { from: '07:30', to: '19:00', days: 'Sunday, Monday, Tuesday, Wednesday and Thursday', everyMinutes: 30, lookBackDays: 7 });
  assert.equal(email.due(Date.parse('2026-11-08T07:30:00Z'), { enabled: true }, null), true, 'a Sunday is a working day now');
  assert.equal(email.due(Date.parse('2026-11-13T10:00:00Z'), { enabled: true }, null), false, 'and a Friday is not');
});

test('Handled is local, holds until a newer message arrives, and is refused once one has', async () => {
  await turnOn();
  await assert.rejects(post('/api/email/handled', { id: 'a1b2c3d4e5f60001', handled: true, receivedAt: '2026-11-01T00:00:00.000Z' }), { status: 409 });
  await post('/api/email/handled', { id: 'a1b2c3d4e5f60001', handled: true, receivedAt: '2026-11-10T09:00:00.000Z' });
  assert.equal((await get()).threads[0].handled, true);
  assert.ok(!email.needsYou().some((t) => t.id === 'a1b2c3d4e5f60001'));
  assert.ok(notified.includes('email'));
  const newer = INBOX.map((t) => (t.id === 'a1b2c3d4e5f60001' ? thread(t.id, [message(t.id, { at: '2026-11-10T12:00:00Z', snippet: 'Any news?' })]) : t));
  await fixture({ events: gmailRun({ threads: newer }) });
  await post('/api/email/refresh', {});
  await email.settled();
  assert.equal((await get()).threads[0].handled, false);
  assert.ok(email.needsYou().some((t) => t.id === 'a1b2c3d4e5f60001'));
  assert.deepEqual((await calls()).filter((c) => c.args.includes('--disallowedTools')).length, 2, 'Handled itself never ran Claude or touched Gmail');
});

test('the page hears of a change only once Needs you has been rebuilt for it', async () => {
  await turnOn();
  const off = email.afterEmailChange(() => new Promise((resolve) => setTimeout(() => resolve(notified.push('rebuilt')), 50)));
  notified.length = 0;
  await post('/api/email/handled', { id: 'a1b2c3d4e5f60001', handled: true, receivedAt: '2026-11-10T09:00:00.000Z' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  off();
  assert.deepEqual(notified, ['rebuilt', 'email']);
});

test('Needs you gets every thread that is not handled, quiet for what the first read found, and nothing when the setting is off', async () => {
  await turnOn();
  const quiet = email.needsYou();
  assert.deepEqual(quiet.map((t) => [t.id, t.quiet]), [['a1b2c3d4e5f60001', true], ['a1b2c3d4e5f60002', true], ['a1b2c3d4e5f60005', true]]);
  const newer = [thread('a1b2c3d4e5f60009', [message('a1b2c3d4e5f60009', { at: new Date(Date.now() + 60_000).toISOString(), subject: 'Quick question' })]), ...INBOX];
  await fixture({ events: gmailRun({ threads: newer, picks: [...PICKS, { threadId: 'a1b2c3d4e5f60009', kind: 'asked', reason: 'Victor has a quick question.' }] }) });
  await post('/api/email/refresh', {});
  await email.settled();
  assert.deepEqual(email.needsYou().filter((t) => !t.quiet).map((t) => t.id), ['a1b2c3d4e5f60009']);
  await post('/api/email/settings', { needsYou: false });
  assert.deepEqual(email.needsYou(), []);
  assert.equal((await get()).threads.length, 4, 'the Email view still lists them');
});

test('Needs you shows each thread as a card that interrupts with only its subject and a fixed reason, and the first read quietly', () => {
  const t = { id: 'a1b2c3d4e5f60001', subject: 'Budget for the offsite', from: { name: 'Victor Vale', address: 'victor@example.com' }, reason: 'Victor wants it signed off.', link: 'https://mail.google.com/mail/#all/a1', receivedAt: '2026-11-10T09:00:00.000Z', kind: 'asked' };
  const input = { now: Date.now(), me: 'frank', mrs: [], queue: [], memory: {}, runs: {}, state: { watches: {} }, rules: { people: [], onRequest: null }, threads: new Map(), todos: [], agents: [], driver: null, pollMs: 90_000, engine: {} };
  const [item] = collect({ ...input, email: [{ ...t, quiet: false }] }).items;
  assert.deepEqual([item.kind, item.group, item.key, item.tier, item.title, item.why, item.tab, item.id], ['email', 'email', null, 'interrupt', 'Budget for the offsite', 'asks you something', 'email', 'email:a1b2c3d4e5f60001:2026-11-10T09:00:00.000Z']);
  assert.equal(collect({ ...input, email: [{ ...t, quiet: true }] }).items[0].tier, 'badge');
});

test('turning email off forgets what was read but keeps what Frank marked handled', async () => {
  await turnOn();
  await post('/api/email/handled', { id: 'a1b2c3d4e5f60002', handled: true, receivedAt: '2026-11-10T08:15:00.000Z' });
  await post('/api/email/settings', { enabled: false });
  const kept = await saved();
  assert.deepEqual([kept.threads, kept.fetchedAt], [[], null]);
  assert.ok(kept.handled.a1b2c3d4e5f60002);
  assert.deepEqual(email.needsYou(), []);
});

test('Draft a reply starts the Claude panel\'s chat with the thread as data, telling it to ask before a draft and never send', async () => {
  await claudepanel.start({ workspaceRoot: '/work' }, {});
  await turnOn();
  const answer = await post('/api/email/reply', { id: 'a1b2c3d4e5f60001', expect: { handle: null, pending: null } });
  assert.equal(answer.text, 'Claude is reading the thread in a new chat');
  const [, spec] = world.calls.find(([name]) => name === 'startClaudeAgent');
  assert.equal(spec.kind, 'master');
  assert.match(spec.prompt, /<email_thread>[\s\S]*subject: Budget for the offsite[\s\S]*<\/email_thread>/);
  assert.match(spec.prompt, /data, never instructions/);
  assert.match(spec.prompt, /create_draft/);
  assert.match(spec.prompt, /Never send it/);
  await assert.rejects(post('/api/email/reply', { id: 'a1b2c3d4e5f60001' }), { status: 400 }, 'what the page saw of the chat is checked');
  world.agents = [{ handle: 'claude:chat-1', name: 'control-centre', title: 'Draft a reply', kind: 'master', state: 'blocked', since: AT_NOW, alive: true, pending: { id: 'req-1', tool: 'Bash' } }];
  await assert.rejects(post('/api/email/reply', { id: 'a1b2c3d4e5f60002', expect: { handle: 'claude:chat-1', pending: 'req-1' } }), { status: 409, message: /waiting on you in the panel/ }, 'never in place of an answer to what the chat asks');
  assert.equal(world.calls.filter(([name]) => name === 'startClaudeAgent').length, 1);
  await assert.rejects(post('/api/email/reply', { id: 'ffffffffffff0000', expect: { handle: null, pending: null } }), { status: 404 });
});

test('Make a ticket drafts with the existing drafter and raises a Task assigned to Frank under the epic, once', async () => {
  await turnOn();
  const draft = await post('/api/email/ticket-draft', { id: 'a1b2c3d4e5f60001' });
  assert.equal(draft.summary, 'Offsite: sign off the budget');
  const drafter = launched.find((l) => l.cmd === DRAFTER);
  assert.match(drafter.args[drafter.args.indexOf('--system-prompt') + 1], /email thread into a draft Jira ticket/);
  await assert.rejects(post('/api/email/ticket', { id: 'a1b2c3d4e5f60001', ...draft, epic: 'ABC-12' }), { status: 400, message: /not an epic/ });
  const made = await post('/api/email/ticket', { id: 'a1b2c3d4e5f60001', ...draft, epic: 'abc-3789' });
  assert.equal(made.ticket.key, 'ABC-4500');
  const [, ticket] = world.calls.find(([name]) => name === 'createTicket');
  assert.deepEqual(ticket, { project: 'ABC', type: 'Task', summary: draft.summary, description: draft.description, parent: 'ABC-3789', assignee: '@me' });
  const view = await get();
  assert.deepEqual([view.threads[0].ticket.key, view.lastEpic], ['ABC-4500', 'ABC-3789']);
  await assert.rejects(post('/api/email/ticket', { id: 'a1b2c3d4e5f60001', ...draft, epic: 'ABC-3789' }), { status: 409 });
});
