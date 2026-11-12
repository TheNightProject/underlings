const SLACK_KINDS = { mention: ['at-sign', 'mentions you'], group: ['users', 'your group'], dm: ['message', 'DM'], reply: ['reply', 'replied'], keyword: ['search', 'watch word'] };
const SLACK_PLACES = { dm: 'DM', group: 'Group DM' };
const SLACK_TICKETS = { name: 'slack', path: '/api/slack', body: (key) => ({ key }), what: 'message' };
const SLACK_MODAL = {
  name: 'slack', path: '/api/slack', service: 'Slack',
  item: (key) => ui.slack?.data?.items?.find((m) => m.key === key) ?? null,
  title: (m) => slackPlace(m) + ' · ' + m.from.name,
  opener: (key) => 'slack-more-' + key,
  unsigned: 'Not signed: signing is off under Slack in Settings.',
  sent: () => { slackBox().at = null; },
  handoff: { label: 'Draft with Claude in the panel', title: 'Start or carry on the Claude panel\'s chat with this message instead', run: (m) => draftSlackReply(m) },
};

function slackBox() {
  ui.slack ??= { data: null, error: null, loading: false, at: null, show: 'open', tickets: new Map(), keywords: null, skip: null, signature: null, everyMinutes: null, budgetUsd: null };
  return ui.slack;
}

// The worker says when a read has finished, so the page reads again on every state it holds.
function slackData(box) {
  if (box.at !== state.generatedAt && !box.loading) loadSlack(box);
  return box.data;
}

async function loadSlack(box) {
  Object.assign(box, { loading: true, at: state.generatedAt });
  try {
    box.data = await api('/api/slack');
    box.error = null;
  } catch (e) {
    box.error = e.message;
  }
  box.loading = false;
  render(true);
}

const slackPlace = (m) => SLACK_PLACES[m.channel.type] ?? m.channel.name;

function viewSlack() {
  const box = slackBox();
  const data = slackData(box);
  const items = data?.items ?? [];
  const open = items.filter((m) => !m.handled);
  return [
    header('Slack', 'The messages that need you, newest first, with why. Nothing here posts to Slack or changes it.', data?.enabled ? slackRefreshButton(data) : null),
    box.error ? banner('Could not read the Slack view: ' + box.error, true) : null,
    data && !data.enabled ? slackOff() : null,
    data?.enabled && data.error ? banner((data.fetchedAt ? 'The last read failed, so this is from ' + ago(data.fetchedAt) + ': ' : 'Could not read Slack: ') + data.error + '.', true) : null,
    !data && !box.error ? el('p', { class: 'empty' }, icon('clock'), 'Reading the Slack view…') : null,
    data?.enabled ? [slackAbout(data, open.length), slackWaiting(data), data.fetchedAt ? slackShown(box, items, open) : null] : null,
  ];
}

function slackShown(box, items, open) {
  const pick = (v) => {
    box.show = v;
    render(true);
  };
  return [
    chips([['open', 'Needs you (' + open.length + ')'], ['handled', 'Handled (' + (items.length - open.length) + ')']], box.show, pick, 'slack-show-'),
    slackList(box.show === 'handled' ? items.filter((m) => m.handled) : open, box),
  ];
}

function slackOff() {
  return banner('Slack is off. On, Claude Code reads your Slack through its Slack connector every 15 minutes in your working hours and lists what needs you here.', false, ' ',
    button('Turn on', 'power', () => saveSlackSetting({ enabled: true }), true), ' ', el('a', { class: 'fix-link', ...inPage('#settings') }, icon('settings'), 'Slack settings'));
}

function slackWaiting(data) {
  if (data.fetchedAt) return null;
  return el('p', { class: 'empty' }, icon('clock'), data.fetching ? 'Claude Code is reading Slack…' : 'Nothing has been read yet.');
}

function slackRefreshButton(data) {
  const busy = data.fetching || ui.busy.has('slack-refresh');
  return el('button', { id: 'slack-refresh', disabled: busy, title: 'Read Slack again now', onclick: refreshSlack }, icon(busy ? 'clock' : 'refresh'), busy ? 'Reading…' : 'Refresh');
}

async function refreshSlack() {
  if (await busyAct('/api/slack/refresh', {}, 'slack-refresh')) slackBox().at = null;
}

function slackAbout(data, open) {
  const run = data.lastRun;
  const w = data.window;
  const account = data.account?.email ? data.account.email + (data.account.org ? ' (' + data.account.org + ')' : '') : 'the Claude account the agents use';
  const cost = run?.costUsd != null ? ' and cost $' + run.costUsd.toFixed(4) : '';
  const took = run ? ' The last read took ' + Math.max(1, Math.round(run.ms / 1000)) + ' s' + cost + '.' : '';
  const read = data.fetchedAt ? ' Read ' + ago(data.fetchedAt) + ': ' + plural(data.read, 'message') + ', ' + open + ' needing you.' : '';
  return el('p', { class: 'hint slack-about', id: 'slack-about' },
    'Claude Code reads it with ' + slot('modelWords', data.model) + ' as ' + account + ', every ' + w.everyMinutes + ' minutes on ' + (w.days ?? 'weekdays') + ' from ' + w.from + ' to ' + w.to + ', and keeps only where, who, a snippet and why.' + read + took + ' ',
    el('a', { class: 'fix-link', ...inPage('#settings') }, 'Change what it reads'));
}

function slackList(items, box) {
  if (!items.length) return empty(box.show === 'handled' ? 'Nothing is marked handled.' : 'Nothing in Slack needs you.');
  return el('div', { class: 'list slack-messages' }, items.map((m) => slackRow(m, box)));
}

function slackKindPill(kind) {
  const [iconName, words] = SLACK_KINDS[kind] ?? ['message', kind];
  return el('span', { class: 'pill s-need' }, icon(iconName), words);
}

function slackRow(m, box) {
  const flow = box.tickets.get(m.key);
  return el('div', { class: 'row slack-message' + (m.handled ? ' handled' : ''), 'data-key': m.key },
    el('div', { class: 'row-head' }, slackKindPill(m.kind), el('span', { class: 'title' }, slackPlace(m)), m.ticket ? slot('ticketLink', m.ticket.key, m.ticket.url, m.ticket.summary, 'slack-ticket-chip-' + m.key) : null),
    el('div', { class: 'meta' }, m.from.name, ' · ', el('span', { title: whenText(m.at) }, ago(m.at)), m.threadTs ? ' · in a thread' : ''),
    el('p', { class: 'slack-reason' }, m.reason),
    m.snippet ? el('p', { class: 'slack-snippet' }, m.snippet) : null,
    slot('messageAgentLine', 'slack', m.key, { review: () => openMessage(SLACK_MODAL, m) }),
    flow ? messageTicketPanel(SLACK_TICKETS, m.key, flow, box) : null,
    el('div', { class: 'actions' },
      el('button', { id: 'slack-more-' + m.key, type: 'button', class: 'primary', 'data-primary': '', title: 'Read the conversation around it, and write and send your reply from there', onclick: () => openMessage(SLACK_MODAL, m) }, icon('file-text'), 'Read more'),
      slot('messageAgentButton', 'slack', m.key, 'slack-agent-' + m.key),
      slackOpenButton(m, 'slack-open-' + m.key, false),
      m.appLink ? el('button', { id: 'slack-app-' + m.key, type: 'button', title: 'Opens the message in the Slack app', onclick: () => openOutside(m.appLink) }, icon('open'), 'Open in the app') : null,
      slackHandledButton(m, 'slack-handled-' + m.key),
      el('button', { id: 'slack-reply-' + m.key, type: 'button', disabled: ui.busy.has('slack-reply:' + m.key), title: 'Start or carry on the Claude panel\'s chat with this message, to draft a reply that it posts only once you agree', onclick: () => draftSlackReply(m) }, icon('message'), 'Draft a reply with Claude'),
      m.ticket || flow ? null : el('button', { id: 'slack-ticket-make-' + m.key, type: 'button', title: 'Draft a Jira ticket from this message', onclick: () => startMessageTicket(SLACK_TICKETS, m.key, box) }, icon('ticket'), 'Make a ticket')));
}

function slackOpenButton(m, id, primary) {
  return el('button', { id, type: 'button', class: primary ? 'primary' : null, 'data-primary': primary ? '' : null, title: 'Opens the message in Slack in your browser', onclick: () => openOutside(m.link) }, icon('external'), 'Open in Slack');
}

function slackHandledButton(m, id) {
  const busy = ui.busy.has('slack-handled:' + m.key);
  return el('button', { id, type: 'button', disabled: busy, title: m.handled ? 'List it as needing you again' : 'Only here: it comes back when a newer message arrives, and Slack is not touched', onclick: () => markSlack(m, !m.handled) }, icon(m.handled ? 'undo' : 'check'), m.handled ? 'Not handled' : 'Handled');
}

async function markSlack(m, handled) {
  if (await busyAct('/api/slack/handled', { key: m.key, handled, ts: m.ts }, 'slack-handled:' + m.key)) slackBox().at = null;
}

async function draftSlackReply(m) {
  const a = state.claude?.current ?? null;
  const live = slot('claudeLive', a);
  const answer = await busyAct('/api/slack/reply', { key: m.key, expect: { handle: a?.handle ?? null, pending: live?.ask?.id ?? null } }, 'slack-reply:' + m.key);
  if (!answer) return;
  if (answer.handle && answer.handle !== a?.handle) slot('claudeReset', answer.handle);
  slot('openClaudePanel');
}

function slackNeedsCard(i) {
  const m = { key: i.conversation, link: i.link, ts: i.ts, handled: false };
  return el('div', { class: 'row need-card slack-need' + (i.tier === 'interrupt' ? ' hot' : ''), 'data-key': i.conversation },
    el('div', { class: 'row-head' }, slot('reasonPill', i), el('span', { class: 'title' }, i.title)),
    el('div', { class: 'meta need-why' }, [i.reason, ago(i.since)].filter(Boolean).join(' · ')),
    el('div', { class: 'actions' }, slackOpenButton(m, 'need-slack-open-' + i.conversation, true), slackHandledButton(m, 'need-slack-handled-' + i.conversation),
      el('a', { class: 'fix-link', ...inPage('#slack') }, icon('chevron'), 'Show in the Slack view')));
}

function slackMessageEntries() {
  const listed = ui.slack?.data?.items?.filter((m) => !m.handled).map((m) => ({ key: m.key, title: slackPlace(m) + ' · ' + m.from.name, reason: m.reason, link: m.link, ts: m.ts, from: m.from.name }))
    ?? (state?.attention?.slack ?? []).map((i) => ({ key: i.conversation, title: i.title, reason: i.reason, link: i.link, ts: i.ts, from: i.from }));
  return listed.map((m) => ({
    id: 'slack:' + m.key, group: 'Slack', icon: 'hash', label: m.title, detail: m.reason, terms: [m.from].filter(Boolean),
    run: () => { selectLater('view:slack', 'key:' + m.key); goView('slack', () => { slackBox().show = 'open'; }); },
    actions: () => [
      { id: 'slack-open:' + m.key, group: 'Slack', icon: 'external', label: 'Open ' + m.title + ' in Slack', run: () => openOutside(m.link) },
      { id: 'slack-handled:' + m.key, group: 'Slack', icon: 'check', label: 'Mark ' + m.title + ' handled', run: () => markSlack({ ...m, handled: false }, true) },
      { id: 'slack-reply:' + m.key, group: 'Slack', icon: 'message', label: 'Draft a reply to ' + m.title + ' with Claude', run: () => draftSlackReply(m) },
    ],
  }));
}

function slackSettingsGroup() {
  const box = slackBox();
  if (box.settingsAt !== state.generatedAt && !box.settingsLoading) loadSlackSettings(box);
  const s = box.settings;
  const hours = s?.window ? s.window.from + ' to ' + s.window.to + ' on ' + (s.window.days ?? 'weekdays') : 'set above';
  return el('section', { class: 'section settings-group', id: 'slack-settings' }, el('h2', {}, 'Slack'),
    box.settingsError ? banner('Could not read the Slack settings: ' + box.settingsError, true) : null,
    slackSwitch('slack-enabled', 'Slack', 'Claude Code reads your Slack through the Slack connector of the account the agents use, every ' + (s?.everyMinutes ?? 15) + ' minutes in your working hours (' + hours + '), and keeps only where, who, a snippet and why, in a file only you can read. Off deletes what it read.', Boolean(s?.enabled), (v) => saveSlackSetting({ enabled: v })),
    slackSwitch('slack-needs', 'In Needs you', 'each message that needs you is a card there, with a banner that names only the channel and who wrote. Off keeps Slack to its own view.', s?.needsYou !== false, (v) => saveSlackSetting({ needsYou: v })),
    slackTextSetting(box, s, 'keywords', 'slack-keywords', 'Watch words', 'Up to five single words, or the @handles of groups you are in, separated by commas. Mentions of you, your DMs and replies in your threads are always read.'),
    slackTextSetting(box, s, 'skip', 'slack-skip', 'Channels left out', 'Channels as #name or by ID, separated by commas. Bots and your own messages are always left out.'),
    slackSwitch('slack-sign', 'Sign messages sent from ' + APP_NAME, 'every Slack message, draft or scheduled message that the Claude panel or Claude Code in this app sends ends with the signature below, in italics on a line of its own, and the ask shows it before anything posts. A change takes effect for chats and Claude Code sessions started after it.', s?.sign !== false, (v) => saveSlackSetting({ sign: v })),
    slackTextSetting(box, s, 'signature', 'slack-signature', 'Signature', 'One line of at most 80 characters, with no underscores. Left empty, it goes back to the default.'),
    slackTextSetting(box, s, 'everyMinutes', 'slack-every', 'Reads every', 'Minutes between reads in your working hours, from 5 to 240.'),
    slackTextSetting(box, s, 'budgetUsd', 'slack-budget', 'Spend cap a read', 'US dollars one read may spend of your Claude usage before Claude Code stops it.'));
}

const slackFieldText = (value) => (Array.isArray(value) ? value.join(', ') : String(value ?? ''));

function slackTextSetting(box, s, field, id, label, hint) {
  const value = box[field] ?? slackFieldText(s?.[field]);
  const save = () => saveSlackSetting({ [field]: value });
  const typed = (e) => {
    box[field] = e.target.value;
    render(true);
  };
  return el('div', { class: 'setting' }, el('label', { for: id }, label),
    el('div', { class: 'control' },
      el('input', { id, type: 'text', value, spellcheck: 'false', autocomplete: 'off', placeholder: slackFieldText(s?.defaults?.[field]) || 'none', oninput: typed, onkeydown: (e) => { if (e.key === 'Enter') save(); } }),
      box[field] !== null && s && box[field] !== slackFieldText(s[field]) ? button('Save', 'check', save, true) : null),
    el('p', { class: 'hint' }, hint));
}

function slackSwitch(id, label, hint, on, onChange) {
  return el('div', { class: 'setting' }, el('label', { for: id }, label),
    el('div', { class: 'control' }, el('button', { id, type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(on), disabled: ui.busy.has('slack-settings'), onclick: () => onChange(!on) }, el('span', { class: 'knob' }), on ? 'On' : 'Off')),
    el('p', { class: 'hint' }, hint.charAt(0).toUpperCase() + hint.slice(1)));
}

async function loadSlackSettings(box) {
  Object.assign(box, { settingsLoading: true, settingsAt: state.generatedAt });
  try {
    box.settings = await api('/api/slack/settings');
    box.settingsError = null;
  } catch (e) {
    box.settingsError = e.message;
  }
  box.settingsLoading = false;
  render(true);
}

async function saveSlackSetting(patch) {
  const box = slackBox();
  const answer = await busyAct('/api/slack/settings', patch, 'slack-settings');
  if (!answer) return;
  box.settings = { enabled: answer.enabled, needsYou: answer.needsYou, keywords: answer.keywords, skip: answer.skip, sign: answer.sign, signature: answer.signature, budgetUsd: answer.budgetUsd, everyMinutes: answer.everyMinutes, window: answer.window, defaults: answer.defaults };
  for (const field of ['keywords', 'skip', 'signature', 'budgetUsd', 'everyMinutes']) if (field in patch) box[field] = null;
  box.at = null;
  render(true);
}
