const NEEDS_GROUPS = [['system', APP_NAME], ['others', 'Waiting on you'], ['mine', 'Your MRs'], ['agents', 'Agents waiting'], ['email', 'Email'], ['slack', 'Slack']];
const AGENTS_SHOWN = 5;
const OVERVIEW_CARDS = 6;
const PRESENCE_BEAT_MS = 15000;
const FIRST_RUN_KEY = 'cc-needs-setup-done';
const PAGE_ID = 'p' + Math.random().toString(36).slice(2, 12);
const REASON_WORDS = {
  asked: ['eyes', 'asks you'], findings: ['inbox', 'to post'], shadow: ['zap', 'shadow review'], held: ['lock', 'held back'], handed: ['undo', 'handed back'],
  replied: ['message', 'replied'], todo: ['message', 'mentioned'], verdict: ['thumbsup', 'your verdict'], rerequest: ['refresh', 'asked again'],
  reset: ['rotate-ccw', 'approval reset'], moved: ['git-branch', 'moved'], relaunch: ['alert', 're-review failed'], died: ['alert', 'review died'],
  holding: ['lock', 'holding'], 'code-moved': ['git-branch', 'code moved'], agent: ['bot', 'agent waiting'], comments: ['message', 'comments'],
  changes: ['lock', 'changes requested'], red: ['x', 'pipeline failed'], conflict: ['alert', 'conflicts'], rebase: ['git-branch', 'behind'],
  mergeable: ['merge', 'ready to merge'], approvals: ['clock', 'waiting on checks'], 'mwg-dropped': ['alert', 'merge when green dropped'],
  'fix-asks': ['wrench', 'fix agent asks'], claude: ['message', 'Claude asks'], 'claude-code': ['terminal', 'Claude needs you'], 'kickoff-asks': ['ticket', 'kickoff agent asks'], 'fix-done': ['wrench', 'fix pushed'], 'rebase-failed': ['alert', 'rebase failed'], merged: ['merge', 'merged'], driver: ['zap', 'full auto'], gitlab: ['alert', 'GitLab'], github: ['alert', 'GitHub'], email: ['mail', 'email'], slack: ['hash', 'Slack'],
};
const OPEN_WORDS = {
  findings: 'Read the findings', threads: 'Read the threads', agent: 'Answer the agent', pipeline: 'Open the pipeline', overview: 'Open it',
  'fix-threads': 'Fix with an agent', 'fix-conflicts': 'Fix conflicts', 'fix-pipeline': 'Fix the pipeline', decide: 'Approve or request changes', reply: 'Reply',
};
const shownToasts = new Set();
const shownOffers = new Set();

function attention() {
  return state?.attention ?? { cards: [], agents: [], system: [], email: [], slack: [], count: 0, prefs: {}, toasts: [], offers: [], notReaching: null };
}

function viewNeeds(d) {
  const a = attention();
  return [
    header('Needs you', 'Every MR waiting on you, with every reason it is, oldest first within each group. Agents on no MR, then email and Slack, come last.'),
    setupBanner(),
    reachBanner(a),
    needsList(a, d),
  ];
}

function reachBanner(a) {
  if (!a.notReaching) return null;
  return banner('Desktop notifications are not reaching you: ' + a.notReaching + '.', true, ' ', el('a', { class: 'fix-link', ...inPage('#settings') }, icon('settings'), 'Notification settings'));
}

function setupDone() {
  try { return localStorage.getItem(FIRST_RUN_KEY) === '1'; } catch { return false; }
}

function finishSetup() {
  try { localStorage.setItem(FIRST_RUN_KEY, '1'); } catch {}
  render(true);
}

const inApp = () => state?.shell === 'app';

// The plugin needs Orca's permission and Orca's banners; the app only needs macOS to allow its own.
function setupSteps() {
  if (inApp()) return [el('li', {}, 'In macOS System Settings, Notifications, ' + APP_NAME + ': allow notifications and choose Banners, or Alerts to keep them on screen.')];
  return [
    el('li', {}, 'In Orca, Settings, Plugins, ' + APP_NAME + ': approve “Show desktop notifications labeled with the plugin name”. Until you do, the plugin does not run at all, full auto included.'),
    el('li', {}, 'In the same place, turn ' + APP_NAME + ' off and on once, as its worker has changed.'),
    el('li', {}, 'In macOS System Settings, Notifications, Orca: allow notifications and choose Banners, or Alerts to keep them on screen.'),
    el('li', {}, 'Optional: in Orca, Settings, Keybindings, Plugins, bind “' + APP_NAME + ': Open what needs me”, which opens what the last banner named.'),
    el('li', {}, 'Optional: turn on clickable banners under Notifications in Settings, so a banner opens its MR here.'),
  ];
}

function setupBanner() {
  if (setupDone()) return null;
  return el('section', { class: 'banner setup', 'aria-label': 'Set up desktop notifications' }, icon('bell'), el('div', {},
    el('b', {}, 'Once, so banners reach you'),
    el('ol', {}, setupSteps()),
    el('div', { class: 'actions' }, button('Done', 'check', finishSetup, true))));
}

function needsList(a, d) {
  const email = a.email ?? [];
  const slack = a.slack ?? [];
  if (!a.cards.length && !a.agents.length && !a.system.length && !email.length && !slack.length) return empty('Nothing is waiting on you.');
  return NEEDS_GROUPS.map(([group, title]) => {
    const cards = group === 'agents' ? [] : group === 'email' ? email.map((i) => slot('emailNeedsCard', i)) : group === 'slack' ? slack.map((i) => slot('slackNeedsCard', i)) : group === 'system' ? a.system.map(systemCard) : a.cards.filter((c) => c.group === group).map((c) => needsCard(c, d));
    const agents = group === 'agents' ? agentCards(a.agents, d) : [];
    const shown = [...cards, ...agents];
    return shown.length ? el('section', { class: 'section needs-group', 'data-group': group }, el('h2', {}, title), el('div', { class: 'list' }, shown)) : null;
  });
}

function reasonPill(r) {
  const [iconName, words] = REASON_WORDS[r.kind] ?? ['info', r.kind];
  return el('span', { class: 'pill ' + (r.tier === 'interrupt' ? 's-need' : 's-info'), title: r.why }, icon(iconName), words);
}

function needsCard(card, d) {
  const openKey = 'need:' + card.key;
  const expanded = ui.open.has(openKey);
  return el('div', { class: 'row need-card' + (card.interrupt ? ' hot' : ''), 'data-key': card.key },
    el('div', { class: 'row-head' }, card.reasons.map(reasonPill), mrRef(card.key, card.title, card.top.tab), card.muted ? el('span', { class: 'pill s-quiet' }, icon('eyeoff'), 'muted') : null),
    el('div', { class: 'meta need-why' }, [short(card.key), card.reasons.map((r) => r.why).join(' · '), ago(card.since)].filter(Boolean).join(' · ')),
    expanded ? null : cardAsk(card, d),
    el('div', { class: 'actions' },
      nextStep(card, d),
      laterButton(card),
      muteMenu(card),
      el('button', { type: 'button', class: 'disclose', 'aria-expanded': String(expanded), onclick: () => toggle(ui.open, openKey) }, icon('chevron'), expanded ? 'Hide' : 'Show here')),
    expanded ? needsBehind(card, d) : null);
}

// An agent's question or permission is answered on the card itself; Show here opens its whole conversation.
function cardAsk(card, d) {
  const handles = new Set(card.reasons.map((r) => r.handle).filter(Boolean));
  const agent = d.agents.find((a) => handles.has(a.handle) && a.ask);
  return agent ? slot('agentAskOnly', agent) : null;
}

function rowOf(key) {
  return state.matrix.inbox?.rows?.find((r) => r.key === key) ?? null;
}

// One guarded step per card, the same buttons the row and drawer offer, so the worker's checks are the ones that run.
function nextStep(card, d) {
  const r = rowOf(card.key);
  const next = card.top.next;
  if (next === 'review' && r) return guarded('need-review:' + card.key, 'Review', 'eye', 'Review ' + refNumber(r) + ' and hold it?', () => matrixAct('review', { key: card.key }, 'need-review:' + card.key), true);
  if (next === 'post-all') return slot('postAllButton', card.key, queuedFor(card.key)) ?? openStep(card, 'findings');
  if (next === 'release' && r) return guarded('need-release:' + card.key, 'Release', 'unlock', 'Lift your hold on ' + refNumber(r) + '?', () => matrixAct('hold', { key: card.key, held: false }, 'need-release:' + card.key), true);
  if (['merge', 'merge-green', 'rebase', 'fix-conflicts'].includes(next) && r) return slot('ownMrActions', r, d) ?? openStep(card, 'overview');
  if (next === 'dismiss') return null;
  if (next === 'retry-gitlab') return button('Retry GitLab', 'refresh', () => matrixAct('refresh', {}, 'refresh'), true);
  if (next === 'retry-github') return button('Retry GitHub', 'refresh', () => slot('retryGitHub'), true);
  return openStep(card, OPEN_WORDS[next] ? next : card.top.tab);
}

function openStep(card, what) {
  const tab = card.top.tab ?? 'overview';
  return button(OPEN_WORDS[what] ?? 'Open it', 'chevron', () => slot('openMr', card.key, tab), true);
}

function laterButton(card) {
  const later = card.reasons.find((r) => r.later);
  if (!later) return null;
  return button(later.kind === 'verdict' ? 'Later' : 'Dismiss', later.kind === 'verdict' ? 'clock' : 'x', () => attentionCall('later', { key: card.key, mark: later.later }));
}

function muteMenu(card) {
  if (card.muted) return button('Unmute', 'bell', () => attentionCall('mute', { key: card.key, until: null }));
  const id = 'mute:' + card.key;
  if (!ui.open.has(id)) return el('button', { type: 'button', 'aria-expanded': 'false', onclick: () => toggle(ui.open, id) }, icon('eyeoff'), 'Mute');
  const pick = (until) => () => { ui.open.delete(id); render(true); attentionCall('mute', { key: card.key, until }); };
  return [button('Mute for a day', 'eyeoff', pick('day')), button('Mute until it merges', 'eyeoff', pick('merged'))];
}

function muteMenuItems(key) {
  const muted = attention().cards.find((c) => c.key === key)?.muted;
  const item = (label, until) => el('button', { role: 'menuitem', onclick: () => { ui.menu = null; attentionCall('mute', { key, until }); } }, icon(until === null ? 'bell' : 'eyeoff'), label);
  return muted ? item('Unmute', null) : [item('Mute for a day', 'day'), item('Mute until it merges', 'merged')];
}

async function attentionCall(name, payload) {
  try {
    const answer = await api('/api/attention/' + name, payload);
    if (answer.text) toast(answer.text);
  } catch (e) {
    toast(e.message, true);
  }
  refresh();
}

// What is behind the card, shown in place: the findings to post, the threads to answer, the agent's question or the verdict.
function needsBehind(card, d) {
  const kinds = new Set(card.reasons.map((r) => r.kind));
  const parts = [];
  if (['findings', 'shadow', 'held'].some((k) => kinds.has(k))) {
    const items = queuedFor(card.key).filter(waitsToPost);
    parts.push(items.length ? el('div', { class: 'list' }, items.map((q) => slot('queueItem', q, false, 'needs-'))) : null);
  }
  if (['replied', 'handed', 'comments', 'todo'].some((k) => kinds.has(k))) parts.push(slot('handedBackThreads', card.key, rowOf(card.key), kinds.has('comments')));
  if (['verdict', 'reset', 'rerequest', 'shadow'].some((k) => kinds.has(k))) parts.push(verdictControls(card));
  for (const r of card.reasons.filter((x) => x.handle)) {
    const agent = d.agents.find((a) => a.handle === r.handle);
    if (agent) parts.push(slot('agentRow', agent, { pinned: true }));
  }
  return el('div', { class: 'need-behind' }, parts.filter(Boolean).length ? parts : el('p', { class: 'meta' }, 'Open it for the rest.'));
}

function verdictControls(card) {
  const r = rowOf(card.key);
  if (!r || r.flags.mine) return null;
  const id = (verdict) => 'need-decide-' + verdict + ':' + card.key;
  const send = (verdict) => matrixAct('decide', { key: card.key, verdict, expect: { sha: r.sha } }, id(verdict));
  return el('div', { class: 'decide', role: 'group', 'aria-label': 'Your verdict on ' + short(card.key) },
    el('div', { class: 'row-head' }, el('span', { class: 'pill s-done' }, icon('check-circle'), 'Your verdict')),
    el('div', { class: 'actions' },
      guarded(id('approve'), 'Approve', 'thumbsup', 'Approve ' + refNumber(r) + '?', () => send('approve'), true),
      guarded(id('changes'), 'Request changes', 'lock', 'Request changes on ' + refNumber(r) + '?', () => send('changes'))));
}

function systemCard(item) {
  return el('div', { class: 'row need-card hot' },
    el('div', { class: 'row-head' }, reasonPill(item), el('span', { class: 'title' }, item.title)),
    el('div', { class: 'meta' }, item.why),
    el('div', { class: 'actions' }, item.next === 'retry-gitlab' ? button('Retry GitLab', 'refresh', () => matrixAct('refresh', {}, 'refresh'), true)
      : item.next === 'retry-github' ? button('Retry GitHub', 'refresh', () => slot('retryGitHub'), true)
        : el('a', { class: 'fix-link', ...inPage('#' + (item.tab ?? 'needs-you')) }, icon('chevron'), 'Open it')));
}

function agentCards(items, d) {
  const all = ui.open.has('needs-agents');
  const agents = d.agents;
  const shown = (all ? items : items.slice(0, AGENTS_SHOWN)).map((i) => {
    if (i.kind === 'claude') return slot('claudeNeedsCard', i);
    if (i.kind === 'claude-code') return slot('claudeCodeNeedsCard', i);
    const agent = agents.find((a) => a.handle === i.handle);
    return agent ? slot('agentRow', agent) : el('div', { class: 'row' }, el('div', { class: 'meta' }, i.why));
  });
  const more = items.length > AGENTS_SHOWN ? el('div', {}, button(all ? 'Fewer' : 'All ' + items.length, 'chevron', () => toggle(ui.open, 'needs-agents'))) : null;
  return [...shown, more].filter(Boolean);
}

function needsNow() {
  const a = attention();
  const cards = a.cards.slice(0, OVERVIEW_CARDS);
  const lines = cards.map((c) => ({ tone: c.interrupt ? 's-need' : 's-info', count: c.reasons.length === 1 ? (REASON_WORDS[c.top.kind] ?? [, c.top.kind])[1] : plural(c.reasons.length, 'reason'), title: c.title + ': ' + c.reasons.map((r) => r.why).join(', '), at: c.since, hash: '#needs-you' }));
  const extra = [a.cards.length > OVERVIEW_CARDS ? plural(a.cards.length - OVERVIEW_CARDS, 'more MR') : null, a.agents.length ? plural(a.agents.length, 'agent') + ' waiting' : null].filter(Boolean);
  return { lines, more: extra.length ? 'and ' + extra.join(' and ') : null };
}

function goTo(target) {
  if (typeof target !== 'string' || slot('meetingWindowOnly')) return;
  if (target === 'jump') return slot('openPalette');
  if (target === 'keys') return slot('openShortcuts');
  if (target === 'claude' || target === 'claude-here') return slot('openClaudePanel', target === 'claude-here');
  if (target === 'claude-code') return slot('openClaudeCode');
  // The Claude Code window draws only the terminal, so a drawer opened there would cover it; the dashboard opens it instead.
  if (slot('terminalWindowOnly')) return;
  const ticket = new RegExp('^ticket:(' + TICKET_KEY_SOURCE + ')$').exec(target);
  if (ticket) return slot('openTicket', ticket[1]);
  if (target.startsWith('agent:')) return slot('agentWinOpen', target.slice('agent:'.length));
  const m = /^mr:(.+):([a-z]+)$/.exec(target);
  if (m) {
    if (location.hash.startsWith('#mr:') && typeof history === 'object') history.replaceState(null, '', '#needs-you');
    slot('openMr', m[1], m[2]);
    return;
  }
  if (ui.mr || ui.ticket) slot('closeDrawer');
  location.hash = '#' + target;
}

function faviconData(count) {
  const dot = count ? '<circle cx="25" cy="7" r="6" fill="%23e5484d"/>' : '';
  return 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="4" width="26" height="24" rx="6" fill="%234f6bed"/>' + dot + '</svg>';
}

function tabBadge(count) {
  const title = count ? '(' + count + ') ' + APP_NAME : APP_NAME;
  if (document.title !== title) document.title = title;
  const link = document.getElementById('favicon');
  const want = count ? 'dot' : 'plain';
  if (!link || link.dataset.state === want) return;
  link.replaceWith(el('link', { rel: 'icon', id: 'favicon', 'data-state': want, href: faviconData(count) }));
}

const pageFocused = () => typeof document.hasFocus === 'function' && document.hasFocus();

function notificationPermission() {
  return typeof Notification === 'function' ? Notification.permission : 'denied';
}

function beat() {
  api('/api/attention/presence', { page: PAGE_ID, focused: pageFocused(), visible: document.visibilityState === 'visible', permission: notificationPermission(), panel: Boolean(slot('claudePanelShown')) }).catch(() => {});
}

// A toast for whatever the worker held back from a banner because this page had focus, shown once each.
function onAttention() {
  const a = attention();
  tabBadge(a.count);
  for (const t of a.toasts) {
    if (shownToasts.has(t.id)) continue;
    shownToasts.add(t.id);
    if (!pageFocused()) continue;
    toast(t.title, false, t.join ? outside(t.join, 'Join', true) : button('Open', 'chevron', () => goTo(t.target), true));
    if (t.kind !== 'meeting') document.querySelector('[data-count="needs"]')?.classList.add('pulse');
  }
  for (const o of a.offers) if (o.page === PAGE_ID && !shownOffers.has(o.id)) clickableBanner(o);
}

function clickableBanner(offer) {
  shownOffers.add(offer.id);
  if (notificationPermission() !== 'granted') return;
  const shown = new Notification(offer.title, { body: offer.body, tag: offer.id });
  shown.onclick = () => {
    api('/api/summon', { target: offer.target }).catch(() => {});
    goTo(offer.target);
  };
  api('/api/attention/ack', { id: offer.id }).catch(() => {});
}

function onAttentionEvent(data) {
  const offered = /^attention:offer:([\w-]+):([\w-]+)$/.exec(data);
  if (offered && offered[1] === PAGE_ID) refresh();
}

async function turnOnClickable() {
  if (typeof Notification !== 'function') return toast('This browser tab cannot show notifications of its own.', true);
  const permission = await Notification.requestPermission();
  beat();
  if (permission !== 'granted') return toast('The tab was not allowed to show notifications, so Orca\'s banners stay.', true);
  attentionCall('prefs', { clickable: true });
}

function notificationsGroup() {
  const a = attention();
  const p = a.prefs ?? {};
  const set = (patch) => attentionCall('prefs', patch);
  const permission = notificationPermission();
  return el('section', { class: 'section settings-group', id: 'notifications' }, el('h2', {}, 'Notifications'),
    noteSwitch('note-enabled', 'Desktop banners', 'a banner when something needs you, page open or not. While this page has focus it shows a toast instead.', p.enabled !== false, (v) => set({ enabled: v })),
    el('div', { class: 'setting' }, el('label', { for: 'note-test' }, 'Test banner'),
      el('div', { class: 'control' }, el('button', { id: 'note-test', type: 'button', onclick: () => attentionCall('test', {}) }, icon('bell'), 'Send a test banner')),
      el('p', { class: 'hint' }, 'Sends one now. In the app, the first banner makes macOS ask to allow them and lists the app under System Settings, Notifications.')),
    noteSwitch('note-quiet', 'Quiet hours', 'holds banners in the window and sends one digest when it ends.', Boolean(p.quiet), (v) => set({ quiet: v })),
    p.quiet ? el('div', { class: 'setting' }, el('label', { for: 'note-from' }, 'From and to'), el('div', { class: 'control' },
      el('input', { id: 'note-from', type: 'time', value: p.quietFrom ?? '22:00', onchange: (e) => set({ quietFrom: e.target.value }) }),
      el('input', { id: 'note-to', type: 'time', value: p.quietTo ?? '07:00', 'aria-label': 'Quiet until', onchange: (e) => set({ quietTo: e.target.value }) }))) : null,
    noteSwitch('note-weekends', 'Quiet on days off', 'holds banners on the days outside your working days.', Boolean(p.weekends), (v) => set({ weekends: v })),
    inApp() ? null : el('div', { class: 'setting' }, el('label', { for: 'note-clickable' }, 'Clickable banners'),
      el('div', { class: 'control' }, p.clickable && permission === 'granted'
        ? el('button', { id: 'note-clickable', type: 'button', role: 'switch', 'aria-checked': 'true', onclick: () => set({ clickable: false }) }, 'On')
        : el('button', { id: 'note-clickable', type: 'button', onclick: turnOnClickable }, icon('bell'), 'Turn on clickable banners')),
      el('p', { class: 'hint' }, 'While this tab is open it shows the banner itself, so a click opens that MR here. Orca asks once to allow it. If the tab does not answer within 10 s, Orca\'s banner goes out instead.')),
    el('p', { class: a.notReaching ? 'hint bad' : 'hint' }, a.notReaching ? 'Banners are not reaching you: ' + a.notReaching + '.' : 'Every banner sent so far was delivered.'));
}

function noteSwitch(id, label, hint, on, onChange) {
  return el('div', { class: 'setting' }, el('label', { for: id }, label),
    el('div', { class: 'control' }, el('button', { id, type: 'button', role: 'switch', 'aria-checked': String(on), onclick: () => onChange(!on) }, on ? 'On' : 'Off')),
    el('p', { class: 'hint' }, hint.charAt(0).toUpperCase() + hint.slice(1)));
}

// The first row of Full auto's People table: anyone who asks for your review and has no row of their own, at shadow or off.
function onRequestRow(m) {
  const on = m.onRequest?.level === 'shadow';
  const pick = (level) => matrixAct('level', { username: '*', level: level === 'shadow' ? 'shadow' : 'off' }, 'level:*');
  return el('tr', { class: 'default-row' },
    el('td', {}, el('b', {}, 'Anyone else who asks for my review')),
    el('td', { class: 'num' }, ''), el('td', { class: 'num' }, ''), el('td', { class: 'num' }, ''),
    el('td', {}, m.onRequest?.available === false ? el('span', { class: 'meta' }, 'Needs a newer review engine') : chips([['off', 'Off'], ['shadow', 'Shadow']], on ? 'shadow' : 'off', pick, 'level-default-')));
}

// The terminal window and the meeting reminder are not pages to read, so focus there must not turn a banner into a toast nobody sees.
function presenceStart() {
  if (typeof document.hasFocus !== 'function' || slot('terminalWindowOnly') || slot('meetingWindowOnly')) return;
  beat();
  setInterval(beat, PRESENCE_BEAT_MS);
  addEventListener('focus', beat);
  addEventListener('blur', beat);
  document.addEventListener('visibilitychange', beat);
}
