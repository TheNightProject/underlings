import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-10T10:00:00Z';
const DEPLOY = 'C0PLATFORM1:1794301200.000100';
const MAIL = 'a1b2c3d4e5f60001';
const MAIL_LINK = 'https://mail.google.com/mail/#all/' + MAIL;
const HANDLE = 'claude:00000000-0000-4000-8000-000000000101';
const REPLY = 'Done, all four are ready.';

const slackItem = {
  key: DEPLOY, channel: { id: 'C0PLATFORM1', type: 'channel', name: '#frontend' }, from: { id: 'U0HEIDI0001', name: 'Heidi' }, ts: '1794301200.000100', threadTs: '1794300000.000100',
  at: '2026-11-10T09:00:00.000Z', link: 'https://example.slack.com/archives/C0PLATFORM1/p1794301200000100', kind: 'mention', reason: 'Heidi asks you to mark the Packages MRs ready for review.',
  snippet: '@Frank mark frontend Packages MRs !1689 to !1692 ready for review', handled: false, ticket: null, appLink: null,
};
const thread = {
  id: MAIL, link: MAIL_LINK, from: { name: 'Victor Vale', address: 'victor@example.com' }, subject: 'Budget for the offsite', snippet: 'Could you sign off the budget by Friday?',
  receivedAt: '2026-11-10T09:00:00.000Z', kind: 'asked', reason: 'Victor wants the offsite budget signed off by Friday.', handled: false, ticket: null,
};
const working = (extra = {}) => ({ handle: HANDLE, listed: true, status: 'working', startedAt: AT, proposal: null, ...extra });
const done = (extra = {}) => working({ status: 'done', proposal: { reply: REPLY, summary: 'Took !1689 to !1692 out of Draft.', at: AT, handle: HANDLE }, ...extra });

function snapshot(items = {}, model = 'default') {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, artifacts: [], claude: { available: true, tools: true, current: null, history: [], titles: {} },
    agents: [{ handle: HANDLE, name: 'message-slack-202611101000', title: 'Slack: #frontend · Heidi', kind: 'message', mr: null, ticket: null, worktree: null, cwd: '/work', state: 'working', since: 1, lastAt: Date.parse(AT), alive: true, said: '', outcome: null, ask: null }],
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
    messageAgents: { model, items },
    attention: { cards: [], agents: [], system: [], email: [], slack: [], count: 0, prefs: {}, toasts: [], offers: [] },
  };
}

const conversation = {
  key: DEPLOY, ts: slackItem.ts, readAt: new Date().toISOString(), cached: true, more: false, ms: 3000, costUsd: 0.01,
  messages: [{ ts: slackItem.ts, at: slackItem.at, from: slackItem.from, mine: false, bot: false, text: slackItem.snippet }],
  reply: { channel: 'C0PLATFORM1', threadTs: slackItem.threadTs, where: '#frontend, in the thread', signature: null, model: 'sonnet' },
};

async function open({ items = {}, hash = 'slack', answers = {}, globals } = {}) {
  const posts = [];
  const page = await openPage({
    globals,
    respond(path, init) {
      const url = new URL(path, 'http://page');
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push([url.pathname, body]);
        return answers[url.pathname]?.(body) ?? { ok: true, text: 'Done' };
      }
      if (url.pathname === '/api/slack') return { enabled: true, needsYou: true, keywords: [], window: { from: '08:00', to: '18:00', everyMinutes: 15, lookBackDays: 7 }, fetchedAt: AT, read: 1, lastRun: null, account: null, model: 'haiku', items: [slackItem] };
      if (url.pathname === '/api/email') return { enabled: true, needsYou: true, window: { from: '08:00', to: '18:00', everyMinutes: 30, lookBackDays: 7 }, fetchedAt: AT, read: 1, lastRun: null, account: null, model: 'haiku', threads: [thread] };
      if (url.pathname === '/api/agents/conversation') return { handle: HANDLE, entries: [], state: 'working', alive: true, partial: null, pending: null };
      if (url.pathname.endsWith('/settings')) return { rows: [], repos: { filter: '', matching: [], total: 0, perRefresh: 0, perMinute: 0 }, enabled: true, skip: [], keywords: [], defaults: {} };
      return null;
    },
  });
  page.show(snapshot(items), hash);
  await page.settle(60);
  return Object.assign(page, { posts });
}

const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim();
const byId = (page, id) => page.document.getElementById(id);
const starts = (page) => page.posts.filter(([path]) => path === '/api/message-agent/start');

test('Action with agent on a Slack message starts its agent at one click, and the item then says it is working with a way to the agent', async () => {
  const page = await open();
  assert.deepEqual(page.errors, []);
  const button = byId(page, 'slack-agent-' + DEPLOY);
  assert.equal(text(button), 'Action with agent');
  assert.equal(page.$('.msg-agent'), null, 'no agent, no line');
  button.click();
  await page.settle(60);
  assert.deepEqual(starts(page), [['/api/message-agent/start', { source: 'slack', key: DEPLOY }]]);
  page.show(snapshot({ ['slack:' + DEPLOY]: working() }), 'slack');
  await page.settle(30);
  assert.equal(text(byId(page, 'slack-agent-' + DEPLOY)), 'Agent working');
  assert.match(text(byId(page, 'msg-agent-slack-' + DEPLOY)), /^Agent workingIt asks you before anything that writes\.Show the agentStop$/);
  byId(page, 'msg-agent-show-slack-' + DEPLOY).click();
  await page.settle(30);
  assert.deepEqual([page.window.location.hash, page.$('#agent-window').hidden, page.run('agentWin.handle')], ['#slack', false, HANDLE], 'its agent window opens over the message');
});

test('one agent per item: while it works the button opens it rather than starting another, and a start the worker hands back opens the one on it', async () => {
  const page = await open({ items: { ['slack:' + DEPLOY]: working({ status: 'asks' }) } });
  assert.equal(text(byId(page, 'slack-agent-' + DEPLOY)), 'Agent asks you');
  byId(page, 'slack-agent-' + DEPLOY).click();
  await page.settle(30);
  assert.deepEqual(starts(page), []);
  assert.equal(page.run('agentWin.handle'), HANDLE);
  const again = await open({ answers: { '/api/message-agent/start': () => ({ ok: true, already: true, handle: HANDLE, text: 'An agent is already on the Slack message' }) } });
  byId(again, 'slack-agent-' + DEPLOY).click();
  await again.settle(60);
  assert.equal(again.run('agentWin.handle'), HANDLE);
});

test('Stop on the item takes two clicks and stops its agent through the page\'s own action', async () => {
  const page = await open({ items: { ['slack:' + DEPLOY]: working() } });
  const stop = () => byId(page, 'g-message-agent-stop:slack-' + DEPLOY);
  stop().click();
  assert.equal(text(stop()), 'Stop the agent?');
  assert.deepEqual(page.posts, []);
  stop().click();
  await page.settle(60);
  assert.deepEqual(page.posts, [['/api/matrix/agent-stop', { handle: HANDLE }]]);
  page.show(snapshot({ ['slack:' + DEPLOY]: working({ status: 'stopped' }) }), 'slack');
  assert.match(text(byId(page, 'msg-agent-slack-' + DEPLOY)), /^Agent stoppedIt proposed no reply\.Show the agent$/);
  assert.equal(text(byId(page, 'slack-agent-' + DEPLOY)), 'Action with agent', 'it can be started again');
});

test('once the agent is done, the item says what it did, and Read more fills the reply box with its reply for the usual two-click send', async () => {
  const page = await open({ items: { ['slack:' + DEPLOY]: done() }, answers: { '/api/slack/conversation': () => conversation, '/api/slack/send': () => ({ ok: true, text: 'Sent' }) } });
  assert.match(text(byId(page, 'msg-agent-slack-' + DEPLOY)), /^Agent doneTook !1689 to !1692 out of Draft\.Show the agentReview its reply$/);
  byId(page, 'msg-agent-review-slack-' + DEPLOY).click();
  await page.settle(60);
  assert.equal(text(page.$('#mm-reply-text')), REPLY);
  assert.equal(text(page.$('#mm-agent-note')), 'Agent done: Took !1689 to !1692 out of Draft. Its reply is in the box.');
  assert.equal(text(page.$('#mm-agent')), 'Action with agent', 'the dialog has the button too');
  const send = () => byId(page, 'g-slack-send:' + DEPLOY);
  send().click();
  assert.equal(page.posts.some(([path]) => path === '/api/slack/send'), false, 'the first click only arms it');
  send().click();
  await page.settle(60);
  assert.deepEqual(page.posts.find(([path]) => path === '/api/slack/send'), ['/api/slack/send', { key: DEPLOY, ts: slackItem.ts, signature: null, text: REPLY }]);
});

test('a reply of the agent\'s never replaces words Frank wrote himself: it waits behind Use its reply, which asks first', async () => {
  const page = await open({ items: { ['slack:' + DEPLOY]: working() }, answers: { '/api/slack/conversation': () => conversation } });
  byId(page, 'slack-more-' + DEPLOY).click();
  await page.settle(60);
  assert.equal(text(page.$('#mm-agent')), 'Agent working');
  const box = page.$('#mm-reply-text');
  box.value = 'On it after lunch';
  page.fire(box, 'input');
  page.show(snapshot({ ['slack:' + DEPLOY]: done() }), 'slack');
  await page.settle(30);
  assert.equal(page.$('#mm-reply-text').value ?? text(page.$('#mm-reply-text')), 'On it after lunch');
  const use = () => byId(page, 'g-slack-agent-use:' + DEPLOY);
  use().click();
  assert.equal(text(use()), 'Replace your text with its reply?');
  use().click();
  assert.equal(text(page.$('#mm-reply-text')), REPLY);
});

test('Email has the button too, and with no Gmail send to fill, the agent\'s reply is shown to copy, with Open in Gmail, and nothing to send it', async () => {
  const copied = [];
  const page = await open({ hash: 'email', items: { ['email:' + MAIL]: done() }, globals: { navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } } } });
  assert.deepEqual(page.errors, []);
  const row = page.$('#main .email-thread');
  assert.equal(text(byId(page, 'email-agent-' + MAIL)), 'Action with agent');
  assert.equal(text(byId(page, 'msg-agent-text-email-' + MAIL)), REPLY);
  byId(page, 'msg-agent-copy-email-' + MAIL).click();
  await page.settle(30);
  assert.deepEqual(copied, [REPLY]);
  byId(page, 'msg-agent-open-email-' + MAIL).click();
  await page.settle(30);
  assert.deepEqual(page.posts.at(-1), ['/api/open', { url: MAIL_LINK }]);
  assert.equal(row.querySelectorAll('button').some((b) => /^Send/.test(text(b))), false);
  page.show(snapshot({}), 'email');
  byId(page, 'email-agent-' + MAIL).click();
  await page.settle(60);
  assert.deepEqual(starts(page), [['/api/message-agent/start', { source: 'email', key: MAIL }]]);
});

test('every top-level name the file declares is its own, so it cannot replace another file\'s', async () => {
  const source = await readFile(new URL('./47-message-agent.js', import.meta.url), 'utf8');
  const declared = [...source.matchAll(/^(?:async\s+)?function\s*\*?\s*(\w+)|^(?:const|let|var|class)\s+(\w+)/gm)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(declared.filter((name) => !/^(?:messageAgent|MESSAGE_AGENT_)/i.test(name) && !/^(?:start|show)MessageAgent$/.test(name)), []);
});
