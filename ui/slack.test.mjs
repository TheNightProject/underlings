import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-10T10:00:00Z';
const LINK = (channel, ts) => `https://example.slack.com/archives/${channel}/p${ts.replace('.', '')}`;

function snapshot(attention = {}) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [], claude: { available: true, tools: true, current: null, history: [], titles: {} },
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
    attention: { cards: [], agents: [], system: [], email: [], slack: [], count: 0, prefs: {}, toasts: [], offers: [], ...attention },
  };
}

const message = (key, extra = {}) => {
  const [channel] = key.split(':');
  const ts = extra.ts ?? '1794301200.000100';
  return {
    key, channel: { id: channel, type: 'channel', name: '#platform' }, from: { id: 'U0VICTOR001', name: 'Victor Vale' }, ts, threadTs: null, at: '2026-11-10T09:00:00.000Z',
    link: LINK(channel, ts), kind: 'mention', reason: 'Victor wants you to look at the deploy.', snippet: '@Frank could you look at the deploy?', handled: false, ticket: null, appLink: null, ...extra,
  };
};

const DEPLOY = 'C0PLATFORM1:1794301200.000100';
const DM = 'D0VICTOR001:';
const DONE = 'C0INFRA0001:1794290000.000100';

function slackView(extra = {}) {
  return {
    enabled: true, needsYou: true, keywords: [], window: { from: '08:00', to: '18:00', everyMinutes: 15, lookBackDays: 7 }, fetching: false, error: null, fetchedAt: '2026-11-10T09:55:00Z',
    read: 64, lastRun: { at: '2026-11-10T09:55:00Z', ms: 8400, costUsd: 0.0412, ok: true }, account: { email: 'frank@example.com', org: 'Example Ltd' }, model: 'haiku', lastEpic: 'ABC-3789',
    items: [
      message(DEPLOY, { appLink: 'slack://channel?team=T0EXAMPLE01&id=C0PLATFORM1&message=1794301200.000100' }),
      message(DM, { channel: { id: 'D0VICTOR001', type: 'dm', name: null }, ts: '1794300000.000200', kind: 'dm', reason: 'Victor wants a minute about the budget.', snippet: '', at: '2026-11-10T08:40:00.000Z' }),
      message(DONE, { channel: { id: 'C0INFRA0001', type: 'channel', name: '#infra' }, ts: '1794295000.000300', kind: 'reply', threadTs: '1794290000.000100', reason: 'Felix offers to take the cache.', handled: true, at: '2026-11-10T07:16:00.000Z' }),
    ],
    ...extra,
  };
}

const SETTINGS = { enabled: true, needsYou: true, keywords: ['incident'], skip: ['#random'], window: { from: '08:00', to: '18:00' }, defaults: {} };

async function open({ data = slackView(), hash = 'slack', attention, settings = SETTINGS, answers = {} } = {}) {
  const posts = [];
  const page = await openPage({
    respond(path, init) {
      const url = new URL(path, 'http://page');
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push([url.pathname, body]);
        if (answers[url.pathname]) return answers[url.pathname](body);
        if (url.pathname === '/api/slack/ticket-draft') return { summary: 'Deploy: check the rollback', description: 'Problem\nA.\n\nFix\nB.\n\nAcceptance criteria\n- C.' };
        if (url.pathname === '/api/slack/ticket') return { ok: true, text: 'Raised ABC-4600', ticket: { key: 'ABC-4600', url: 'https://example.atlassian.net/browse/ABC-4600', summary: body.summary } };
        if (url.pathname === '/api/slack/reply') return { ok: true, handle: 'claude:chat-1', text: 'Claude is reading the conversation in a new chat' };
        if (url.pathname === '/api/slack/settings') return { ok: true, text: 'Saved', ...settings, ...body, ...Object.fromEntries(['keywords', 'skip'].filter((f) => f in body).map((f) => [f, body[f].split(/[\s,]+/)])) };
        return { ok: true, text: 'Done' };
      }
      if (url.pathname === '/api/slack') return data;
      if (url.pathname === '/api/slack/settings') return settings;
      if (url.pathname === '/api/email/settings') return { enabled: false, needsYou: true, from: '08:00', to: '18:00', skip: [], defaults: {} };
      if (url.pathname === '/api/qa/settings') return { jql: 'x', defaultJql: 'x' };
      if (url.pathname === '/api/standup/settings') return { calendarSet: false, excludedRepos: [] };
      if (url.pathname === '/api/matrix/settings') return { rows: [], repos: { filter: '', matching: [], total: 0, perRefresh: 0, perMinute: 0 } };
      if (url.pathname === '/api/agents/conversation') return { handle: 'claude:chat-1', entries: [], state: 'working', alive: true, partial: null, pending: null };
      return null;
    },
  });
  page.show(snapshot(attention), hash);
  await page.settle(60);
  return Object.assign(page, { posts });
}

const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim();
const rows = (page) => page.$$('#main .slack-message');
const buttons = (row) => row.querySelector('.actions').querySelectorAll('button').map((b) => text(b));
const tap = (row, label) => row.querySelectorAll('button').find((b) => text(b) === label).click();

test('Slack sits under Work and lists what needs you, newest first, each with where, who, why and a snippet, handled ones apart', async () => {
  const page = await open();
  assert.deepEqual(page.errors, []);
  assert.equal(text(page.$('#main .head h1')), 'Slack');
  assert.deepEqual(rows(page).map((r) => r.dataset.key), [DEPLOY, DM]);
  const [deploy, dm] = rows(page);
  assert.equal(text(deploy.querySelector('.pill')), 'mentions you');
  assert.equal(text(deploy.querySelector('.title')), '#platform');
  assert.match(text(deploy.querySelector('.meta')), /^Victor Vale · \d+ (min|h|d) ago$/);
  assert.equal(text(deploy.querySelector('.slack-reason')), 'Victor wants you to look at the deploy.');
  assert.equal(text(deploy.querySelector('.slack-snippet')), '@Frank could you look at the deploy?');
  assert.deepEqual(buttons(deploy), ['Read more', 'Action with agent', 'Open in Slack', 'Open in the app', 'Handled', 'Draft a reply with Claude', 'Make a ticket']);
  assert.equal(text(dm.querySelector('.title')), 'DM');
  assert.equal(dm.querySelector('.slack-snippet'), null, 'no empty snippet');
  assert.ok(!buttons(dm).includes('Open in the app'), 'only where the app is signed in to that workspace');
  assert.deepEqual(page.$$('#main .chips .chip').map(text), ['Needs you (2)', 'Handled (1)']);
  page.$('#slack-show-handled').click();
  assert.deepEqual(rows(page).map((r) => r.dataset.key), [DONE]);
  assert.match(text(rows(page)[0].querySelector('.meta')), / · in a thread$/);
  assert.deepEqual(buttons(rows(page)[0]).slice(0, 4), ['Read more', 'Action with agent', 'Open in Slack', 'Not handled']);
});

test('it says which Claude account reads it, with what, when, how long the read took and what it cost', async () => {
  const page = await open();
  const about = text(page.$('#slack-about'));
  assert.match(about, /^Claude Code reads it with Haiku as frank@example\.com \(Example Ltd\), every 15 minutes on weekdays from 08:00 to 18:00/);
  assert.match(about, /64 messages, 2 needing you\./);
  assert.match(about, /The last read took 8 s and cost \$0\.0412\./);
});

test('Open in Slack goes to the browser, Open in the app to the Slack app, Handled marks it here only with what the page saw, and Refresh reads again', async () => {
  const page = await open();
  tap(rows(page)[0], 'Open in Slack');
  tap(rows(page)[0], 'Open in the app');
  tap(rows(page)[0], 'Handled');
  page.$('#slack-refresh').click();
  await page.settle(60);
  assert.deepEqual(page.posts, [
    ['/api/open', { url: LINK('C0PLATFORM1', '1794301200.000100') }],
    ['/api/open', { url: 'slack://channel?team=T0EXAMPLE01&id=C0PLATFORM1&message=1794301200.000100' }],
    ['/api/slack/handled', { key: DEPLOY, handled: true, ts: '1794301200.000100' }],
    ['/api/slack/refresh', {}],
  ]);
});

test('Draft a reply with Claude hands the message to the panel\'s chat, with what the page saw of it, and opens the panel', async () => {
  const page = await open();
  tap(rows(page)[0], 'Draft a reply with Claude');
  await page.settle(60);
  assert.deepEqual(page.posts[0], ['/api/slack/reply', { key: DEPLOY, expect: { handle: null, pending: null } }]);
  assert.equal(page.$('#claude-panel')?.hidden, false, 'the panel is open');
});

test('Make a ticket drafts with Claude, fills the form with the last epic, and creates only on the second click', async () => {
  const page = await open();
  tap(rows(page)[0], 'Make a ticket');
  await page.settle(60);
  assert.equal(page.document.getElementById(`slack-ticket-summary-${DEPLOY}`).getAttribute('value'), 'Deploy: check the rollback');
  assert.equal(page.document.getElementById(`slack-ticket-epic-${DEPLOY}`).getAttribute('value'), 'ABC-3789');
  const create = () => page.document.getElementById(`g-slack-ticket:${DEPLOY}`);
  create().click();
  assert.equal(text(create()), 'Create a ticket under ABC-3789?');
  assert.equal(page.posts.filter(([path]) => path === '/api/slack/ticket').length, 0, 'one click only arms it');
  create().click();
  await page.settle(60);
  assert.deepEqual(page.posts.at(-1), ['/api/slack/ticket', { key: DEPLOY, summary: 'Deploy: check the rollback', description: 'Problem\nA.\n\nFix\nB.\n\nAcceptance criteria\n- C.', epic: 'ABC-3789' }]);
  assert.match(text(page.$('#toast')), /Raised ABC-4600/);
});

test('off, it says so and turns on from here; a failed read keeps the last list and says why', async () => {
  const off = await open({ data: slackView({ enabled: false, items: [], fetchedAt: null }) });
  assert.match(text(off.$('#main .banner')), /^Slack is off\./);
  off.$$('#main .banner button').find((b) => text(b) === 'Turn on').click();
  await off.settle(60);
  assert.deepEqual(off.posts, [['/api/slack/settings', { enabled: true }]]);
  const failed = await open({ data: slackView({ error: 'Slack needs signing in again in Claude Code: run /mcp in Claude Code and sign in to claude.ai Slack' }) });
  assert.match(text(failed.$('#main .banner.warn')), /^The last read failed, so this is from .* ago: Slack needs signing in again in Claude Code/);
  assert.equal(rows(failed).length, 2);
});

test('Needs you has a Slack group, a card per message with where, who and why, to open or mark handled', async () => {
  const item = { kind: 'slack', group: 'slack', key: null, tier: 'interrupt', id: `slack:${DEPLOY}:1794301200.000100`, title: '#platform · Victor Vale', why: 'mentions you', since: '2026-11-10T09:00:00.000Z', conversation: DEPLOY, from: 'Victor Vale', reason: 'Victor wants the deploy checked.', link: LINK('C0PLATFORM1', '1794301200.000100'), ts: '1794301200.000100' };
  const page = await open({ hash: 'needs-you', attention: { slack: [item], count: 1 } });
  const group = page.$('#main .needs-group[data-group="slack"]');
  assert.equal(text(group.querySelector('h2')), 'Slack');
  const card = group.querySelector('.need-card');
  assert.equal(card.classList.contains('hot'), true);
  assert.equal(text(card.querySelector('.title')), '#platform · Victor Vale');
  assert.match(text(card.querySelector('.meta')), /^Victor wants the deploy checked\. · /);
  assert.equal(text(page.$('[data-count="slack"]')), '1');
  tap(card, 'Handled');
  await page.settle(60);
  assert.deepEqual(page.posts, [['/api/slack/handled', { key: DEPLOY, handled: true, ts: '1794301200.000100' }]]);
});

test('Jump to lists each message that needs you, with Open, Handled and Draft a reply, and g l goes to Slack', async () => {
  const page = await open({ hash: 'overview' });
  page.run("ui.slack = { data: " + JSON.stringify(slackView()) + ", at: 'x', loading: false, show: 'open', tickets: new Map(), keywords: null, skip: null }");
  const entries = JSON.parse(page.run("JSON.stringify(paletteEntries({ layer: 'main', view: 'overview' }).filter((x) => x.group === 'Slack').map((x) => [x.label, x.detail, x.actions().map((a) => a.label)]))"));
  assert.deepEqual(entries[0], ['#platform · Victor Vale', 'Victor wants you to look at the deploy.', ['Open #platform · Victor Vale in Slack', 'Mark #platform · Victor Vale handled', 'Draft a reply to #platform · Victor Vale with Claude']]);
  assert.equal(entries.length, 2, 'not the handled one');
  const actions = JSON.parse(page.run("JSON.stringify(paletteEntries({ layer: 'main', view: 'overview' }).filter((x) => x.id === 'act-slack' || x.id === 'act-settings:Slack').map((x) => x.label))"));
  assert.deepEqual(actions, ['Read Slack now', 'Settings: Slack']);
  page.fire(page.document.activeElement ?? page.document.body, 'keydown', { key: 'g' });
  page.fire(page.document.activeElement ?? page.document.body, 'keydown', { key: 'l' });
  assert.equal(page.window.location.hash, '#slack');
});

test('Settings has a Slack group: on and off, in Needs you, watch words and the channels left out', async () => {
  const page = await open({ hash: 'settings' });
  await page.settle(60);
  const group = page.$('#slack-settings');
  assert.deepEqual(group.querySelectorAll('.setting').map((row) => text(row.querySelector('label'))), ['Slack', 'In Needs you', 'Watch words', 'Channels left out', 'Sign messages sent from Underlings', 'Signature', 'Reads every', 'Spend cap a read']);
  assert.match(text(group.querySelector('.setting .hint')), /in your working hours \(08:00 to 18:00 on weekdays\)/);
  assert.equal(page.$('#slack-keywords').getAttribute('value'), 'incident');
  assert.equal(page.$('#slack-skip').getAttribute('value'), '#random');
  page.$('#slack-needs').click();
  await page.settle(60);
  const words = page.$('#slack-keywords');
  words.value = 'incident, @platform-team';
  page.fire(words, 'input');
  page.fire(page.$('#slack-keywords'), 'keydown', { key: 'Enter' });
  await page.settle(60);
  const skip = page.$('#slack-skip');
  skip.value = '#random, #noisy';
  page.fire(skip, 'input');
  page.fire(page.$('#slack-skip'), 'keydown', { key: 'Enter' });
  await page.settle(60);
  assert.deepEqual(page.posts, [['/api/slack/settings', { needsYou: false }], ['/api/slack/settings', { keywords: 'incident, @platform-team' }], ['/api/slack/settings', { skip: '#random, #noisy' }]]);
  assert.equal(page.$('#slack-model-sonnet'), null, 'the reply drafts\' model is chosen under Models');
});

test('Settings signs Slack messages sent from the app, on by default, with words of your own, from the next session', async () => {
  const words = 'Sent with Underlings';
  const page = await open({ hash: 'settings', settings: { ...SETTINGS, sign: true, signature: words, defaults: { sign: true, signature: words } } });
  await page.settle(60);
  const sign = page.$('#slack-sign');
  assert.equal(sign.getAttribute('aria-checked'), 'true');
  assert.match(text(sign.closest('.setting').querySelector('.hint')), /ends with the signature below, in italics on a line of its own, and the ask shows it before anything posts\. A change takes effect for chats and Claude Code sessions started after it\./);
  assert.deepEqual([page.$('#slack-signature').getAttribute('value'), page.$('#slack-signature').getAttribute('placeholder')], [words, words]);
  sign.click();
  await page.settle(60);
  assert.equal(page.$('#slack-sign').getAttribute('aria-checked'), 'false');
  const field = page.$('#slack-signature');
  field.value = 'Sent from my desk';
  page.fire(field, 'input');
  page.fire(page.$('#slack-signature'), 'keydown', { key: 'Enter' });
  await page.settle(60);
  assert.deepEqual(page.posts, [['/api/slack/settings', { sign: false }], ['/api/slack/settings', { signature: 'Sent from my desk' }]]);
  assert.equal(page.$('#slack-signature').getAttribute('value'), 'Sent from my desk');
  assert.equal(page.$('#slack-settings').querySelectorAll('button').some((b) => text(b) === 'Save'), false, 'nothing is left unsaved');
});

const THREAD = 'C0INFRA0001:1794290000.000100';
const conversation = (extra = {}) => ({
  key: DEPLOY, ts: '1794301200.000100', readAt: new Date().toISOString(), cached: false, more: false, ms: 4200, costUsd: 0.019,
  messages: [
    { ts: '1794301100.000100', at: '2026-11-10T08:58:20.000Z', from: { id: 'U0FRANK0001', name: 'Frank Foster' }, mine: true, bot: false, text: 'Deploying now' },
    { ts: '1794301200.000100', at: '2026-11-10T09:00:00.000Z', from: { id: 'U0VICTOR001', name: 'Victor Vale' }, mine: false, bot: false, text: '@Frank Foster could you look at the [rollback plan](https://example.com/plan)? <b>not markup</b>' },
  ],
  reply: { channel: 'C0PLATFORM1', threadTs: '1794301200.000100', where: '#platform, in a thread under the message', signature: 'Sent with Underlings', model: 'sonnet' },
  ...extra,
});
const SENT = { ok: true, text: 'Sent to #platform, in a thread under the message, and marked handled', link: 'https://example.slack.com/archives/C0PLATFORM1/p1794301300000100?thread_ts=1794301200.000100&cid=C0PLATFORM1' };

async function readMore(answers = {}, options = {}) {
  const page = await open({ answers: { '/api/slack/conversation': () => conversation(), ...answers }, ...options });
  tap(rows(page)[0], 'Read more');
  await page.settle(60);
  return page;
}

const modal = (page) => page.$('#message-modal .mm');
const typeReply = (page, value) => {
  const box = page.$('#mm-reply-text');
  box.value = value;
  page.fire(box, 'input');
};

test('Read more opens a dialog over the page with the conversation around the message, its own message marked, and where a reply goes', async () => {
  const page = await readMore();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.posts[0], ['/api/slack/conversation', { key: DEPLOY, fresh: false }]);
  assert.equal(modal(page).getAttribute('role'), 'dialog');
  assert.equal(page.$('.app').inert, true, 'the page behind cannot be used');
  assert.equal(text(page.$('#mm-title')), '#platform · Victor Vale');
  assert.equal(text(page.$('#mm-meta')), '2 messages, read just now in 4 s');
  const msgs = page.$$('#message-modal .mm-msg');
  assert.deepEqual(msgs.map((m) => text(m.querySelector('.mm-from b'))), ['You', 'Victor Vale']);
  assert.ok(msgs[0].classList.contains('mine'));
  assert.ok(msgs[1].classList.contains('is-item') && !msgs[0].classList.contains('is-item'));
  assert.equal(text(msgs[1].querySelector('.pill')), 'This message');
  assert.equal(msgs[1].querySelector('.md a'), null, 'a link in a message is never an anchor');
  assert.equal(text(msgs[1].querySelector('.md-link')), 'rollback plan');
  assert.match(text(msgs[1].querySelector('.md')), /<b>not markup<\/b>/);
  assert.equal(text(page.$('#mm-where')), 'To #platform, in a thread under the message');
  assert.equal(text(page.$('#mm-sig')), 'Ends with Sent with Underlings on a line of its own.');
  page.$('#mm-open-item').click();
  await page.settle(30);
  assert.deepEqual(page.posts.at(-1), ['/api/open', { url: LINK('C0PLATFORM1', '1794301200.000100') }]);
});

test('Esc leaves the reply box first, then closes the dialog and hands focus back to Read more; Read again asks for a fresh read', async () => {
  const page = await readMore();
  page.$('#mm-again').click();
  await page.settle(60);
  assert.deepEqual(page.posts.at(-1), ['/api/slack/conversation', { key: DEPLOY, fresh: true }]);
  page.$('#mm-reply-text').focus();
  typeReply(page, 'On it');
  page.fire(page.$('#mm-reply-text'), 'keydown', { key: 'Escape' });
  assert.ok(page.$('#message-modal').hidden === false && page.document.activeElement === modal(page), 'still open, focus on the dialog');
  page.fire(modal(page), 'keydown', { key: 'Escape' });
  assert.equal(page.$('#message-modal').hidden, true);
  assert.equal(page.$('.app').inert, false);
  assert.equal(page.document.activeElement.id, 'slack-more-' + DEPLOY);
  tap(rows(page)[0], 'Read more');
  await page.settle(60);
  assert.equal(page.$('#mm-reply-text').value ?? text(page.$('#mm-reply-text')), 'On it', 'what you typed is kept until it is sent');
});

test('Suggest a reply fills the box for you to edit, and over words of your own it asks first', async () => {
  const page = await readMore({ '/api/slack/suggest': () => ({ ok: true, reply: 'Yes, looking at it now.', model: 'sonnet' }) });
  assert.equal(text(page.$('#mm-suggest')), 'Suggest a reply (Sonnet)');
  page.$('#mm-suggest').click();
  await page.settle(60);
  assert.deepEqual(page.posts.at(-1), ['/api/slack/suggest', { key: DEPLOY }]);
  assert.equal(text(page.$('#mm-reply-text')), 'Yes, looking at it now.');
  typeReply(page, 'Yes, looking at it after lunch.');
  render(page);
  const again = page.document.getElementById('g-slack-suggest:' + DEPLOY);
  again.click();
  assert.equal(text(page.document.getElementById('g-slack-suggest:' + DEPLOY)), 'Replace your text with a suggestion?');
  assert.equal(page.posts.filter(([path]) => path === '/api/slack/suggest').length, 1, 'one click only arms it');
});

function render(page) {
  page.run('render(true)');
}

test('Send takes two clicks and posts exactly the text in the box with the message it was read for; then it says so, links the message and empties the box', async () => {
  const page = await readMore({ '/api/slack/send': () => SENT });
  const send = () => page.document.getElementById('g-slack-send:' + DEPLOY);
  assert.equal(send().disabled, true, 'nothing to send yet');
  typeReply(page, 'Looking now, give me ten minutes.');
  render(page);
  assert.equal(send().disabled, false);
  send().click();
  assert.equal(text(send()), 'Send to #platform, in a thread under the message?');
  assert.ok(!page.posts.some(([path]) => path === '/api/slack/send'), 'the first click only arms it');
  send().click();
  await page.settle(60);
  assert.deepEqual(page.posts.find(([path]) => path === '/api/slack/send'), ['/api/slack/send', { key: DEPLOY, ts: '1794301200.000100', signature: 'Sent with Underlings', text: 'Looking now, give me ten minutes.' }]);
  assert.match(text(page.$('.mm-sent')), /^Sent to #platform, in a thread under the message, and marked handled\. Open the sent message$/);
  assert.equal(text(page.$('#mm-reply-text')), '');
  page.$('#mm-sent-link').click();
  await page.settle(30);
  assert.deepEqual(page.posts.at(-1), ['/api/open', { url: SENT.link }]);
});

test('a send that fails keeps your text in the box and says why, and typing after arming disarms it', async () => {
  const page = await readMore({ '/api/slack/send': () => null });
  typeReply(page, 'Looking now.');
  render(page);
  page.document.getElementById('g-slack-send:' + DEPLOY).click();
  typeReply(page, 'Looking now!');
  assert.equal(text(page.document.getElementById('g-slack-send:' + DEPLOY)), 'Send', 'a change after arming needs arming again');
  page.document.getElementById('g-slack-send:' + DEPLOY).click();
  page.document.getElementById('g-slack-send:' + DEPLOY).click();
  await page.settle(60);
  assert.match(text(page.$('#mm-send-error')), /^Not sent: .+\. Your text is still here\.$/);
  assert.equal(page.$('#mm-reply-text').value ?? text(page.$('#mm-reply-text')), 'Looking now!');
  assert.equal(page.$('.mm-sent'), null);
});

test('a read that fails says why with Try again, an empty one says so, a long thread says there is more, and signing off says unsigned', async () => {
  const failed = await readMore({ '/api/slack/conversation': () => null });
  assert.match(text(failed.$('#message-modal .banner')), /^Could not read the conversation: .+\. Try again$/);
  assert.equal(failed.document.getElementById('g-slack-send:' + DEPLOY).disabled, true, 'no send before it is read');
  const quiet = await readMore({ '/api/slack/conversation': () => conversation({ messages: [], more: true, reply: { ...conversation().reply, signature: null } }) });
  assert.equal(text(quiet.$('#message-modal .empty')), 'Slack returned no messages here.');
  assert.match(text(quiet.$('#message-modal .hint')), /only the start of a long thread/);
  assert.equal(text(quiet.$('#mm-sig')), 'Not signed: signing is off under Slack in Settings.');
});

test('the panel hand-off stays: Draft with Claude in the panel closes the dialog and starts the chat', async () => {
  const page = await readMore();
  page.$('#mm-handoff').click();
  await page.settle(60);
  assert.equal(page.$('#message-modal').hidden, true);
  assert.deepEqual(page.posts.find(([path]) => path === '/api/slack/reply'), ['/api/slack/reply', { key: DEPLOY, expect: { handle: null, pending: null } }]);
});
