const EMAIL_KINDS = { asked: ['message', 'asks you'], waiting: ['clock', 'waiting on you'], mentioned: ['at-sign', 'mentions you'], invite: ['calendar', 'invite'] };
const EMAIL_TICKETS = { name: 'email', path: '/api/email', body: (id) => ({ id }), what: 'thread' };

function emailBox() {
  ui.email ??= { data: null, error: null, loading: false, at: null, show: 'open', tickets: new Map(), skip: null, everyMinutes: null, budgetUsd: null };
  return ui.email;
}

// The worker says when a read has finished, so the page reads again on every state it holds.
function emailData(box) {
  if (box.at !== state.generatedAt && !box.loading) loadEmail(box);
  return box.data;
}

async function loadEmail(box) {
  Object.assign(box, { loading: true, at: state.generatedAt });
  try {
    box.data = await api('/api/email');
    box.error = null;
  } catch (e) {
    box.error = e.message;
  }
  box.loading = false;
  render(true);
}

function viewEmail() {
  const box = emailBox();
  const data = emailData(box);
  const threads = data?.threads ?? [];
  const open = threads.filter((t) => !t.handled);
  return [
    header('Email', 'The threads in your inbox that need you, newest first, with why. Nothing here sends mail or changes your mailbox.', data?.enabled ? emailRefreshButton(data) : null),
    box.error ? banner('Could not read the email view: ' + box.error, true) : null,
    data && !data.enabled ? emailOff() : null,
    data?.enabled && data.error ? banner((data.fetchedAt ? 'The last read failed, so this is from ' + ago(data.fetchedAt) + ': ' : 'Could not read your email: ') + data.error + '.', true) : null,
    !data && !box.error ? el('p', { class: 'empty' }, icon('clock'), 'Reading the email view…') : null,
    data?.enabled ? [emailAbout(data, open.length), emailWaiting(data), data.fetchedAt ? emailShown(box, threads, open) : null] : null,
  ];
}

function emailShown(box, threads, open) {
  const pick = (v) => {
    box.show = v;
    render(true);
  };
  return [
    chips([['open', 'Needs you (' + open.length + ')'], ['handled', 'Handled (' + (threads.length - open.length) + ')']], box.show, pick, 'email-show-'),
    emailList(box.show === 'handled' ? threads.filter((t) => t.handled) : open, box),
  ];
}

function emailOff() {
  return banner('Email is off. On, Claude Code reads your inbox through its Gmail connector every 30 minutes in your working hours and lists what needs you here.', false, ' ',
    button('Turn on', 'power', () => saveEmailSetting({ enabled: true }), true), ' ', el('a', { class: 'fix-link', ...inPage('#settings') }, icon('settings'), 'Email settings'));
}

function emailWaiting(data) {
  if (data.fetchedAt) return null;
  return el('p', { class: 'empty' }, icon('clock'), data.fetching ? 'Claude Code is reading your inbox…' : 'Nothing has been read yet.');
}

function emailRefreshButton(data) {
  const busy = data.fetching || ui.busy.has('email-refresh');
  return el('button', { id: 'email-refresh', disabled: busy, title: 'Read your inbox again now', onclick: refreshEmail }, icon(busy ? 'clock' : 'refresh'), busy ? 'Reading…' : 'Refresh');
}

async function refreshEmail() {
  if (await busyAct('/api/email/refresh', {}, 'email-refresh')) emailBox().at = null;
}

function emailAccount(account) {
  if (!account?.email) return 'the Claude account the agents use';
  return account.email + (account.org ? ' (' + account.org + ')' : '');
}

function emailAbout(data, open) {
  const run = data.lastRun;
  const w = data.window;
  const cost = run?.costUsd != null ? ' and cost $' + run.costUsd.toFixed(4) : '';
  const took = run ? ' The last read took ' + Math.max(1, Math.round(run.ms / 1000)) + ' s' + cost + '.' : '';
  const read = data.fetchedAt ? ' Read ' + ago(data.fetchedAt) + ': ' + plural(data.read, 'thread') + ' from the last ' + w.lookBackDays + ' days, ' + open + ' needing you.' : '';
  return el('p', { class: 'hint email-about', id: 'email-about' },
    'Claude Code reads it with ' + slot('modelWords', data.model) + ' as ' + emailAccount(data.account) + ', every ' + w.everyMinutes + ' minutes on ' + (w.days ?? 'weekdays') + ' from ' + w.from + ' to ' + w.to + ', and keeps only who, the subject, a snippet and why.' + read + took + ' ',
    el('a', { class: 'fix-link', ...inPage('#settings') }, 'Change your working hours'));
}

function emailList(threads, box) {
  if (!threads.length) return empty(box.show === 'handled' ? 'Nothing is marked handled.' : 'Nothing in your inbox needs you.');
  return el('div', { class: 'list email-threads' }, threads.map((t) => emailRow(t, box)));
}

function emailKindPill(kind) {
  const [iconName, words] = EMAIL_KINDS[kind] ?? ['mail', kind];
  return el('span', { class: 'pill s-need' }, icon(iconName), words);
}

const emailFrom = (t) => t.from.name ? t.from.name + ' <' + t.from.address + '>' : t.from.address;

function emailRow(t, box) {
  const flow = box.tickets.get(t.id);
  return el('div', { class: 'row email-thread' + (t.handled ? ' handled' : ''), 'data-thread': t.id },
    el('div', { class: 'row-head' }, emailKindPill(t.kind), el('span', { class: 'title' }, t.subject || '(no subject)'), t.ticket ? slot('ticketLink', t.ticket.key, t.ticket.url, t.ticket.summary, 'email-ticket-chip-' + t.id) : null),
    el('div', { class: 'meta' }, emailFrom(t), ' · ', el('span', { title: whenText(t.receivedAt) }, ago(t.receivedAt))),
    el('p', { class: 'email-reason' }, t.reason),
    t.snippet ? el('p', { class: 'email-snippet' }, t.snippet) : null,
    slot('messageAgentLine', 'email', t.id, { link: t.link }),
    flow ? messageTicketPanel(EMAIL_TICKETS, t.id, flow, box) : null,
    el('div', { class: 'actions' },
      emailOpenButton(t, 'email-open-' + t.id, true),
      slot('messageAgentButton', 'email', t.id, 'email-agent-' + t.id),
      emailHandledButton(t, 'email-handled-' + t.id),
      el('button', { id: 'email-reply-' + t.id, type: 'button', disabled: ui.busy.has('email-reply:' + t.id), title: 'Start or carry on the Claude panel\'s chat with this thread, to draft a reply that it saves to Gmail only once you allow it', onclick: () => draftEmailReply(t) }, icon('message'), 'Draft a reply with Claude'),
      t.ticket || flow ? null : el('button', { id: 'email-ticket-make-' + t.id, type: 'button', title: 'Draft a Jira ticket from this thread', onclick: () => startMessageTicket(EMAIL_TICKETS, t.id, box) }, icon('ticket'), 'Make a ticket')));
}

function emailOpenButton(t, id, primary) {
  return el('button', { id, type: 'button', class: primary ? 'primary' : null, 'data-primary': primary ? '' : null, title: 'Opens the thread in Gmail in your browser', onclick: () => openOutside(t.link) }, icon('external'), 'Open in Gmail');
}

function emailHandledButton(t, id) {
  const busy = ui.busy.has('email-handled:' + t.id);
  const label = t.handled ? 'Not handled' : 'Handled';
  return el('button', { id, type: 'button', disabled: busy, title: t.handled ? 'List it as needing you again' : 'Only here: it comes back when a newer message arrives, and Gmail is not touched', onclick: () => markEmail(t, !t.handled) }, icon(t.handled ? 'undo' : 'check'), label);
}

async function markEmail(t, handled) {
  if (await busyAct('/api/email/handled', { id: t.id, handled, receivedAt: t.receivedAt }, 'email-handled:' + t.id)) emailBox().at = null;
}

async function draftEmailReply(t) {
  const a = state.claude?.current ?? null;
  const live = slot('claudeLive', a);
  const answer = await busyAct('/api/email/reply', { id: t.id, expect: { handle: a?.handle ?? null, pending: live?.ask?.id ?? null } }, 'email-reply:' + t.id);
  if (!answer) return;
  if (answer.handle && answer.handle !== a?.handle) slot('claudeReset', answer.handle);
  slot('openClaudePanel');
}

function emailNeedsCard(i) {
  const t = { id: i.thread, link: i.link, receivedAt: i.receivedAt, handled: false };
  return el('div', { class: 'row need-card email-need' + (i.tier === 'interrupt' ? ' hot' : ''), 'data-thread': i.thread },
    el('div', { class: 'row-head' }, slot('reasonPill', i), el('span', { class: 'title' }, i.title)),
    el('div', { class: 'meta need-why' }, [i.from, i.reason, ago(i.since)].filter(Boolean).join(' · ')),
    el('div', { class: 'actions' }, emailOpenButton(t, 'need-email-open-' + i.thread, true), emailHandledButton(t, 'need-email-handled-' + i.thread),
      el('a', { class: 'fix-link', ...inPage('#email') }, icon('chevron'), 'Show in Email')));
}

function emailThreadEntries() {
  const listed = ui.email?.data?.threads?.filter((t) => !t.handled) ?? (state?.attention?.email ?? []).map((i) => ({ id: i.thread, subject: i.title, from: { name: i.from, address: '' }, reason: i.reason, link: i.link, receivedAt: i.receivedAt }));
  return listed.map((t) => ({
    id: 'email:' + t.id, group: 'Email', icon: 'mail', label: t.subject || '(no subject)', detail: [t.from.name || t.from.address, t.reason].filter(Boolean).join(' · '),
    terms: [t.from.name, t.from.address].filter(Boolean),
    run: () => { selectLater('view:email', 'thread:' + t.id); goView('email', () => { emailBox().show = 'open'; }); },
    actions: () => [
      { id: 'email-open:' + t.id, group: 'Email', icon: 'external', label: 'Open ' + (t.subject || 'the thread') + ' in Gmail', run: () => openOutside(t.link) },
      { id: 'email-handled:' + t.id, group: 'Email', icon: 'check', label: 'Mark ' + (t.subject || 'the thread') + ' handled', run: () => markEmail(t, true) },
      { id: 'email-reply:' + t.id, group: 'Email', icon: 'message', label: 'Draft a reply to ' + (t.subject || 'the thread') + ' with Claude', run: () => draftEmailReply(t) },
    ],
  }));
}

function emailSettingsGroup() {
  const box = emailBox();
  if (box.settingsAt !== state.generatedAt && !box.settingsLoading) loadEmailSettings(box);
  const s = box.settings;
  return el('section', { class: 'section settings-group', id: 'email-settings' }, el('h2', {}, 'Email'),
    box.settingsError ? banner('Could not read the email settings: ' + box.settingsError, true) : null,
    emailSwitch('email-enabled', 'Email', 'Claude Code reads your inbox through the Gmail connector of the account the agents use, and keeps only who wrote, the subject, a snippet and why, in a file only you can read. Off forgets what it read.', Boolean(s?.enabled), (v) => saveEmailSetting({ enabled: v })),
    emailSwitch('email-needs', 'In Needs you', 'each thread that needs you is a card there, with a banner that names only its subject. Off keeps email to its own view.', s?.needsYou !== false, (v) => saveEmailSetting({ needsYou: v })),
    emailSkipSetting(box, s),
    emailNumberSetting(box, s, 'everyMinutes', 'email-every', 'Reads every', 'minutes', 'How often it reads in your working hours, set above, from 5 to 240 minutes. Refresh in Email reads at any time.'),
    emailNumberSetting(box, s, 'budgetUsd', 'email-budget', 'Spend cap a read', 'US dollars', 'The most one read may spend of your Claude usage before Claude Code stops it.'));
}

function emailNumberSetting(box, s, field, id, label, unit, hint) {
  const value = box[field] ?? String(s?.[field] ?? '');
  const save = () => saveEmailSetting({ [field]: value });
  const typed = (e) => {
    box[field] = e.target.value;
    render(true);
  };
  return el('div', { class: 'setting' }, el('label', { for: id }, label),
    el('div', { class: 'control' },
      el('input', { id, type: 'text', inputmode: 'decimal', class: 'number', value, spellcheck: 'false', autocomplete: 'off', oninput: typed, onkeydown: (e) => { if (e.key === 'Enter') save(); } }),
      el('span', { class: 'unit' }, unit),
      box[field] != null && s && box[field] !== String(s[field]) ? button('Save', 'check', save, true) : null),
    el('p', { class: 'hint' }, hint));
}

function emailSkipSetting(box, s) {
  const skip = box.skip ?? s?.skip.join(', ') ?? '';
  const save = () => saveEmailSetting({ skip });
  const typed = (e) => {
    box.skip = e.target.value;
    render(true);
  };
  return el('div', { class: 'setting' }, el('label', { for: 'email-skip' }, 'Senders left out'),
    el('div', { class: 'control' },
      el('input', { id: 'email-skip', type: 'text', value: skip, spellcheck: 'false', autocomplete: 'off', placeholder: 'none', oninput: typed, onkeydown: (e) => { if (e.key === 'Enter') save(); } }),
      box.skip !== null && s && box.skip !== s.skip.join(', ') ? button('Save', 'check', save, true) : null),
    el('p', { class: 'hint' }, 'Addresses or domains, separated by commas, such as noreply@example.com or example.com. GitLab, Jira, Confluence, Slack and calendar notifications are always left out.'));
}

function emailSwitch(id, label, hint, on, onChange) {
  return el('div', { class: 'setting' }, el('label', { for: id }, label),
    el('div', { class: 'control' }, el('button', { id, type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(on), disabled: ui.busy.has('email-settings'), onclick: () => onChange(!on) }, el('span', { class: 'knob' }), on ? 'On' : 'Off')),
    el('p', { class: 'hint' }, hint.charAt(0).toUpperCase() + hint.slice(1)));
}

async function loadEmailSettings(box) {
  Object.assign(box, { settingsLoading: true, settingsAt: state.generatedAt });
  try {
    box.settings = await api('/api/email/settings');
    box.settingsError = null;
  } catch (e) {
    box.settingsError = e.message;
  }
  box.settingsLoading = false;
  render(true);
}

async function saveEmailSetting(patch) {
  const box = emailBox();
  const answer = await busyAct('/api/email/settings', patch, 'email-settings');
  if (!answer) return;
  box.settings = { enabled: answer.enabled, needsYou: answer.needsYou, skip: answer.skip, budgetUsd: answer.budgetUsd, everyMinutes: answer.everyMinutes };
  for (const field of ['skip', 'budgetUsd', 'everyMinutes']) if (field in patch) box[field] = null;
  box.at = null;
  render(true);
}
