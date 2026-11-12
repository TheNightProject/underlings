const GO_LETTERS = {
  overview: 'o', 'needs-you': 'n', tickets: 't', standup: 'd', calendar: 'c', email: 'e', slack: 'l', agents: 'a', artifacts: 'p', 'merge-requests': 'm',
  'review-queue': 'q', 'full-auto': 'f', 'review-runs': 'r', watching: 'w', leaderboard: 'b', settings: 's', game: 'x',
};
const KEY_ROWS = '.row, .mr, .agent, .item, .kanban-card, a.stat, a.line, .file-row, .setting, .standup-line, .cal-event, .fthread, tbody tr';
const KEY_FIELDS = 'input, textarea, select';
const KEY_CONTROLS = 'button, a[href], summary, input, select, textarea, [role="tab"], [role="switch"], [role="menuitem"]';
const UNTYPED = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file']);
const ROW_DATA = ['key', 'handle', 'url', 'path', 'queueId', 'thread', 'epic', 'id'];
const ANYWHERE = new Set(['Mod+K', 'Esc']);
const ARROWS = new Set(['ArrowDown', 'ArrowUp']);
const SEQUENCE_MS = 1500;
const REACH_MS = 5000;
const MR_WRITES = [['review', 'r', 'Review', 'eyes'], ['approve', 'v', 'Approve or withdraw approval', 'thumbsup'], ['hold', 'h', 'Hold or release', 'lock'], ['postall', 'P', 'Post all findings', 'send']];
const LAYOUTS = { 'merge-requests': ['Merge requests', 'mrLayout', 'setMrLayout', 'board'], tickets: ['Tickets', 'ticketLayout', 'setTicketLayout', 'board'], agents: ['Agents', 'agentLayout', 'agentSetLayout', 'office'] };
const LAYOUT_ACTIONS = { board: (label) => label + ' as a board', list: (label) => label + ' as a list', office: () => 'Open the office' };
const MR_OFFERED = {
  review: (r) => !r.agent && !r.agentStarting,
  approve: (r) => !r.flags.mine,
  hold: (r) => !r.flags.mine && !(r.flags.held && r.flags.heldByMe === false),
  postall: (r) => (state.matrix.queue ?? []).some((q) => q.key === r.key && q.status === 'pending' && q.kind !== 'verdict'),
};
const MR_SCOPES = [['asking', 'Merge requests asking me'], ['mine', 'My merge requests'], ['watched', 'Watched merge requests']];
const KEY_PROVIDERS = [drawerKeys, mrKeys, viewKeys, listKeys, goKeys, everywhereKeys, actionKeys];
const keyState = { sel: new Map(), overlay: null, pending: null, pendingTimer: null, refocus: false, waiting: null, armedByKey: null };

const onMac = () => /Mac|iPhone|iPad/.test(navigator.platform ?? navigator.userAgent ?? '');

// Order is priority: the first live entry for a key wins, so the drawer's and the selected MR's keys come before the view's and the page's.
function keymap() {
  return KEY_PROVIDERS.flatMap((provide) => {
    try {
      return provide().filter(Boolean);
    } catch (e) {
      console.error(provide.name, e);
      return [];
    }
  });
}

function live(entry, cx) {
  try {
    return !entry.when || Boolean(entry.when(cx));
  } catch {
    return false;
  }
}

function drawerKeys() {
  const tabs = (list, layer, go) => list.map(([tab, label], i) => ({
    id: layer + '-tab:' + tab, group: 'Drawer', fold: 'tabs', keys: [String(i + 1)], label: label + ' tab', icon: 'open',
    when: (cx) => cx.layer === layer, run: () => go(tab),
  }));
  const inDrawer = (cx) => cx.layer === 'drawer' || cx.layer === 'ticket';
  return [
    ...tabs(DRAWER_TABS, 'drawer', (tab) => slot('openMr', ui.mr.key, tab)),
    ...tabs(TICKET_TABS, 'ticket', (tab) => slot('openTicket', ui.ticket.key, tab)),
    { id: 'tab-next', group: 'Drawer', keys: [']'], label: 'Next tab', icon: 'chevron', when: inDrawer, run: () => stepTab(1) },
    { id: 'tab-prev', group: 'Drawer', keys: ['['], label: 'Previous tab', icon: 'chevron', when: inDrawer, run: () => stepTab(-1) },
  ];
}

function stepTab(step) {
  const open = ui.mr ?? ui.ticket;
  const [list, go] = ui.mr ? [DRAWER_TABS, (tab) => slot('openMr', open.key, tab)] : [TICKET_TABS, (tab) => slot('openTicket', open.key, tab)];
  const at = list.findIndex(([id]) => id === open.tab);
  go(list[(at + step + list.length) % list.length][0]);
}

function mrKeys() {
  return MR_WRITES.map((write) => mrWrite(write, null));
}

function mrWrite([action, key, label, iconName], fixed) {
  const target = (cx) => fixed ?? cx.mrKey;
  return {
    id: 'mr-' + action + (fixed ? ':' + fixed : ''), group: 'Merge request', keys: fixed ? [] : [key], label, icon: iconName,
    title: (cx) => label + ' ' + short(target(cx)),
    when: (cx) => Boolean(target(cx)) && (fixed || cx.layer === 'main' || cx.layer === 'drawer') && offered(action, target(cx)),
    arm: (cx) => ({ id: action + ':' + target(cx), reveal: () => slot('openMr', target(cx), 'overview') }),
  };
}

// Mirrors when 20-mr.js draws each button, so neither a key nor the palette offers one that is missing.
function offered(action, key) {
  const r = (state?.matrix?.inbox?.rows ?? []).find((x) => x.key === key);
  return Boolean(r) && MR_OFFERED[action](r);
}

function viewKeys() {
  return [{
    id: 'layout', group: 'This view', keys: ['b'], label: 'Board, office or list', icon: 'dashboard', palette: false,
    when: (cx) => cx.layer === 'main' && Object.hasOwn(LAYOUTS, cx.view), run: (cx) => flipLayout(cx.view),
  }];
}

function flipLayout(name) {
  const [, get, set, other] = LAYOUTS[name];
  slot(set, slot(get) === other ? 'list' : other);
}

function listKeys() {
  return [
    { id: 'row-next', group: 'Lists', keys: ['j', 'ArrowDown'], label: 'Next row', repeat: true, palette: false, run: () => moveSelection(1) },
    { id: 'row-prev', group: 'Lists', keys: ['k', 'ArrowUp'], label: 'Previous row', repeat: true, palette: false, run: () => moveSelection(-1) },
    { id: 'row-first', group: 'Lists', keys: ['g g'], label: 'First row', palette: false, run: () => moveSelection(-Infinity) },
    { id: 'row-last', group: 'Lists', keys: ['G'], label: 'Last row', palette: false, run: () => moveSelection(Infinity) },
    { id: 'row-open', group: 'Lists', keys: ['Enter'], label: 'Open the selected row', palette: false, when: (cx) => Boolean(cx.row) && !onControl(), run: (cx) => openRow(cx.row) },
  ];
}

function goKeys() {
  return [...railViews().map(({ name, label, letter, count }) => ({
    id: 'go:' + name, group: 'Go to', keys: letter ? ['g ' + letter] : [], label, icon: VIEW_ICONS[name] ?? 'dashboard', count,
    run: () => goView(name),
  })), {
    id: 'go:whats-new', group: 'Go to', keys: [], label: 'What\'s new', icon: VIEW_ICONS['whats-new'], terms: ['changelog', 'release notes', 'version', 'updates'],
    detail: state?.release?.version ? 'Version ' + state.release.version : null, run: () => goView('whats-new'),
  }, {
    id: 'go:setup', group: 'Go to', keys: [], label: 'Set up', icon: VIEW_ICONS.setup, terms: ['setup', 'first run', 'checks', 'token', 'hook', 'agent commands'], run: () => goView('setup'),
  }];
}

function railViews() {
  const taken = new Set(Object.values(GO_LETTERS));
  return [...document.querySelectorAll('.navlink')].filter((a) => !a.hidden).map((a) => {
    const name = a.getAttribute('href').slice(1);
    const label = a.querySelector('.label')?.textContent ?? name;
    return { name, label, letter: GO_LETTERS[name] ?? freeLetter(label, taken), count: a.querySelector('.count')?.textContent ?? '' };
  });
}

function freeLetter(label, taken) {
  const letter = [...label.toLowerCase()].find((c) => /[a-z]/.test(c) && c !== 'g' && !taken.has(c));
  if (letter) taken.add(letter);
  return letter ?? null;
}

function everywhereKeys() {
  return [
    { id: 'palette', group: 'Everywhere', keys: ['Mod+K'], label: 'Jump to…', palette: false, run: togglePalette },
    { id: 'shortcuts', group: 'Everywhere', keys: ['?'], label: 'Keyboard shortcuts', icon: 'help', run: () => (keyState.overlay === 'help' ? closeShortcuts() : openShortcuts()) },
    { id: 'escape', group: 'Everywhere', keys: ['Esc'], label: 'Close the field, menu, file or drawer on top', palette: false, run: () => escapeOne(document.activeElement) },
    { id: 'search', group: 'Everywhere', keys: ['/'], label: 'Search this view', palette: false, run: focusSearch },
    { id: 'refresh', group: 'Everywhere', keys: ['R'], label: 'Refresh now', icon: 'refresh', run: () => refresh() },
    { id: 'settings-key', group: 'Everywhere', keys: [','], label: 'Settings', palette: false, run: () => goView('settings') },
    { id: 'claude', group: 'Everywhere', keys: ['c'], label: 'Ask Claude', detail: 'open the Claude panel, or go to it', icon: 'message', run: () => slot('askClaude') },
  ];
}

function actionKeys() {
  const m = state?.matrix;
  return [
    m?.available ? { id: 'act-gitlab', group: 'Actions', label: 'Refresh GitLab', detail: 'read every open MR again', icon: 'refresh', run: () => matrixAct('refresh', {}, 'refresh') } : null,
    { id: 'act-cleanup', group: 'Actions', label: 'Scan agents for clean up', icon: 'eraser', run: () => goView('agents', () => slot('scanCleanup')) },
    m?.available ? {
      id: 'act-pause', group: 'Actions', label: m.paused ? 'Resume full auto' : 'Pause full auto', icon: m.paused ? 'play' : 'pause',
      focus: () => ({ find: () => headerButton(/^(?:Pause|Resume) full auto$/), reveal: () => goView('full-auto') }),
    } : null,
    ...claudeActions(),
    { id: 'act-email', group: 'Actions', label: 'Read email now', detail: 'Claude Code reads your inbox again', icon: 'mail', run: () => goView('email', () => slot('refreshEmail')) },
    ...(slot('calendarActions') ?? []),
    { id: 'act-slack', group: 'Actions', label: 'Read Slack now', detail: 'Claude Code reads what needs you in Slack again', icon: 'hash', run: () => goView('slack', () => slot('refreshSlack')) },
    { id: 'act-test-banner', group: 'Actions', label: 'Send a test banner', icon: 'bell', focus: () => ({ find: () => byId('note-test'), reveal: () => goView('settings') }) },
    { id: 'act-discover', group: 'Actions', label: 'Look for repos again', icon: 'refresh', focus: () => ({ find: () => byId('b-discover'), reveal: () => goView('settings') }) },
    { id: 'act-updates-check', group: 'Actions', label: 'Check for updates', icon: 'refresh', run: () => goView('whats-new', () => slot('checkForUpdates')) },
    { id: 'act-intro', group: 'Actions', label: 'Play the intro', detail: 'the graph that gathers into the logo, now', icon: 'play', run: () => slot('introReplay') },
    state?.release?.updates?.count ? { id: 'act-update-now', group: 'Actions', label: 'Update ' + APP_NAME + ' now', icon: 'download', arm: () => ({ id: 'update-now', reveal: () => goView('whats-new') }) } : null,
    ...Object.entries(LAYOUTS).map(([name, [label, get, set, other]]) => {
      const next = slot(get) === other ? 'list' : other;
      const terms = other === 'office' ? ['3d', 'desks', 'table tennis', 'agents'] : undefined;
      return { id: 'act-layout:' + name, group: 'Actions', label: LAYOUT_ACTIONS[next](label), icon: other === 'office' ? 'bot' : 'dashboard', terms, run: () => goView(name, () => slot(set, next)) };
    }),
    ...MR_SCOPES.map(([scope, label]) => ({ id: 'act-scope:' + scope, group: 'Actions', label, icon: 'merge', run: () => goView('merge-requests', () => slot('scopeMrs', scope)) })),
    ...settingsSections(),
  ].filter(Boolean);
}

// In the app the panel is Claude Code, so its session is new in two presses and it pops out into the Claude Code window.
function claudeActions() {
  if (!slot('claudeCodeHere')) {
    return [
      { id: 'act-claude-new', group: 'Actions', label: 'New chat with Claude', icon: 'plus', run: () => slot('claudeNewChat') },
      state?.claude?.canPopOut ? { id: 'act-claude-window', group: 'Actions', label: 'Claude in a window of its own', detail: 'pop the panel out, on top of every app', icon: 'external', run: () => slot('claudePopOut') } : null,
    ];
  }
  return [
    { id: 'act-claude-code', group: 'Actions', label: 'Open Claude Code', detail: 'the full Claude Code, in the Claude panel', icon: 'terminal', run: () => slot('openClaudeCode') },
    { id: 'act-claude-new', group: 'Actions', label: 'New Claude Code session', icon: 'plus', arm: () => ({ id: 'claude-code-new', reveal: () => slot('openClaudePanel') }) },
    { id: 'act-claude-window', group: 'Actions', label: 'Claude Code in a window of its own', detail: 'move its session out of the panel, on top of every app', icon: 'external', run: () => slot('claudePopOut') },
  ];
}

function settingsSections() {
  const titles = [...(typeof SETTING_GROUPS === 'undefined' ? [] : SETTING_GROUPS.map(([title]) => title)), 'Features', 'Notifications', 'Standup', 'Calendar', 'Email', 'Slack', 'Models'];
  return titles.map((title) => ({
    id: 'act-settings:' + title, group: 'Settings', label: 'Settings: ' + title, icon: 'settings',
    run: () => reach({ find: () => settingsSection(title), reveal: () => goView('settings'), missing: 'Settings has no ' + title + ' section yet' }, showSection),
  }));
}

function settingsSection(title) {
  return [...document.querySelectorAll('#main .settings-group h2')].find((h) => h.textContent === title)?.closest('section') ?? null;
}

function showSection(node) {
  node.setAttribute('tabindex', '-1');
  node.scrollIntoView({ block: 'start' });
  node.focus({ preventScroll: true });
}

function headerButton(label) {
  return [...document.querySelectorAll('#main .head button')].find((b) => label.test(b.textContent)) ?? null;
}

function byId(id) {
  return document.getElementById(id);
}

function keyLayer() {
  if (ui.message) return { name: 'modal', host: byId('message-modal'), place: 'modal:' + ui.message.key };
  if (ui.file) return { name: 'sheet', host: byId('sheet'), place: 'sheet:' + ui.file.key + ':' + ui.file.path };
  if (ui.mr) return { name: 'drawer', host: byId('drawer'), place: 'mr:' + ui.mr.key + ':' + ui.mr.tab };
  if (ui.ticket) return { name: 'ticket', host: byId('drawer'), place: 'ticket:' + ui.ticket.key + ':' + ui.ticket.tab };
  return { name: 'main', host: byId('main'), place: 'view:' + view() };
}

function keyContext() {
  const layer = keyLayer();
  const row = layer.host?.querySelector('.is-selected') ?? null;
  return { layer: layer.name, place: layer.place, view: view(), row, mrKey: ui.mr?.key ?? (layer.name === 'main' ? rowMr(row) : null) };
}

// A ticket's row lists its MRs too, so only an MR's own row names the MR its keys act on.
function rowMr(row) {
  if (!row) return null;
  if (isKey(row.dataset.key)) return row.dataset.key;
  if (row.matches('.ticket-row, .ticket-card')) return null;
  return ownIn(row, '.ref')?.dataset.key ?? null;
}

function ownIn(row, selector) {
  return [...row.querySelectorAll(selector)].find((n) => n.closest(KEY_ROWS) === row && (n.tagName !== 'A' || n.getAttribute('href').startsWith('#'))) ?? null;
}

function keyName(e) {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.code === 'KeyK' || /^k$/i.test(e.key ?? ''))) return 'Mod+K';
  if (e.key === 'Escape') return 'Esc';
  if (e.metaKey || e.ctrlKey || e.altKey || !e.key) return null;
  if (/^[a-z]$/i.test(e.key)) return e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase();
  return e.key;
}

function typingIn(target) {
  if (!target?.closest) return false;
  if (target.isContentEditable) return true;
  const field = target.closest(KEY_FIELDS);
  return Boolean(field) && !(field.tagName === 'INPUT' && UNTYPED.has(field.getAttribute('type')));
}

function onControl() {
  const a = document.activeElement;
  return Boolean(a?.closest?.(KEY_CONTROLS)) && !a.classList.contains('is-selected');
}

const onSelectedRow = () => Boolean(document.activeElement?.classList?.contains('is-selected'));

function keysPaused(target, name) {
  if (slot('terminalWindowOnly') || slot('meetingWindowOnly') || target?.closest?.('.cp-term')) return true;
  if (ui.message) return name !== 'Esc';
  if (ANYWHERE.has(name)) return false;
  if (keyState.overlay === 'help') return name !== '?';
  return Boolean(keyState.overlay || ui.menu || ui.board?.legend) || typingIn(target) || (ARROWS.has(name) && !onSelectedRow());
}

function onKey(e) {
  if (e.defaultPrevented || e.isComposing || e.key === 'Process') return;
  const name = keyName(e);
  if (!name || keysPaused(e.target, name)) return;
  keyState.waiting = null;
  if (name === 'Esc') {
    if (keyState.pending) clearPending();
    else if (!escapeOne(e.target)) return;
    return e.preventDefault();
  }
  const sequence = keyState.pending ? keyState.pending + ' ' + name : name;
  const wasPending = Boolean(keyState.pending);
  clearPending();
  const cx = keyContext();
  const entry = keymap().find((x) => x.keys?.includes(sequence) && live(x, cx));
  if (!entry) return noEntry(e, name, wasPending, cx);
  e.preventDefault();
  if (e.repeat && !entry.repeat) return;
  performEntry(entry, cx, 'key');
}

function noEntry(e, name, wasPending, cx) {
  if (wasPending) return e.preventDefault();
  if (!keymap().some((x) => live(x, cx) && x.keys?.some((k) => k.startsWith(name + ' ')))) return;
  e.preventDefault();
  keyState.pending = name;
  keyState.pendingTimer = setTimeout(clearPending, SEQUENCE_MS);
  paintKeyHint(cx);
}

function clearPending() {
  clearTimeout(keyState.pendingTimer);
  keyState.pending = null;
  paintKeyHint(null);
}

function performEntry(entry, cx, via) {
  if (entry.arm) return armControl(entry.arm(cx), via);
  if (entry.focus) return reach({ missing: entry.label + ' is not on this page right now', ...entry.focus(cx) }, focusControl);
  entry.run?.(cx);
}

function paintKeyHint(cx) {
  let hint = byId('keyhint');
  if (!hint) {
    hint = el('div', { id: 'keyhint', class: 'keyhint', role: 'status', 'aria-live': 'polite', hidden: true });
    document.body.append(hint);
  }
  hint.hidden = !cx;
  if (!cx) return hint.replaceChildren();
  const next = keymap().filter((x) => live(x, cx)).flatMap((x) => (x.keys ?? []).filter((k) => k.startsWith(keyState.pending + ' ')).map((k) => [k.split(' ')[1], x.label]));
  hint.replaceChildren(el('span', {}, el('kbd', {}, keyState.pending), ' then'), ...next.map(([k, label]) => el('span', { class: 'keyhint-item' }, el('kbd', {}, k), label)));
}

function layerRows(layer) {
  return layer.host ? [...layer.host.querySelectorAll(KEY_ROWS)].filter((row) => !row.closest('[hidden]')) : [];
}

// An MR's list row and its board card both come out as key:<mr>, so switching layout keeps the same MR selected.
function rowId(row) {
  const own = ROW_DATA.find((k) => row.dataset[k]);
  if (own) return own + ':' + row.dataset[own];
  if (row.id) return 'id:' + row.id;
  const named = row.querySelector('[data-key], [data-ticket], [id]');
  if (!named) return 'text:' + row.textContent.trim().slice(0, 80);
  return named.dataset.key ? 'key:' + named.dataset.key : named.dataset.ticket ? 'ticket:' + named.dataset.ticket : 'id:' + named.id;
}

// The same MR can be listed twice on a page, so the row at the saved place wins over the first with the same name.
function findRow(rows, saved) {
  if (rows[saved.index] && rowId(rows[saved.index]) === saved.id) return saved.index;
  const at = rows.findIndex((r) => rowId(r) === saved.id);
  if (at >= 0 || saved.strict) return at;
  return rows.length ? Math.min(saved.index, rows.length - 1) : -1;
}

function firstInView(rows) {
  return Math.max(0, rows.findIndex((r) => r.getBoundingClientRect().top >= 0));
}

function moveSelection(step) {
  if (ui.armed) disarmKeys();
  const layer = keyLayer();
  const rows = layerRows(layer);
  if (!rows.length) return;
  const saved = keyState.sel.get(layer.place);
  const at = saved ? findRow(rows, saved) : -1;
  const next = !Number.isFinite(step) ? (step > 0 ? rows.length - 1 : 0) : at < 0 ? firstInView(rows) : Math.max(0, Math.min(rows.length - 1, at + step));
  selectRow(layer, rows, next, true);
}

function selectRow(layer, rows, index, moved) {
  for (const old of layer.host.querySelectorAll('.is-selected')) unmarkRow(old);
  const row = rows[index];
  keyState.sel.set(layer.place, { id: rowId(row), index });
  markRow(row);
  if (!moved) return;
  document.body.classList.add('keyed');
  keyState.refocus = true;
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: 'nearest' });
}

function markRow(row) {
  row.classList.add('is-selected');
  row.setAttribute('aria-current', 'true');
  if (!row.hasAttribute('tabindex')) row.setAttribute('tabindex', '-1');
}

function unmarkRow(row) {
  row.classList.remove('is-selected');
  row.removeAttribute('aria-current');
}

function clearSelection() {
  const layer = keyLayer();
  keyState.sel.delete(layer.place);
  for (const old of layer.host.querySelectorAll('.is-selected')) unmarkRow(old);
  keyState.refocus = false;
}

function selectLater(place, id) {
  keyState.sel.set(place, { id, index: 0, strict: true, scroll: true });
  keyState.refocus = true;
  document.body.classList.add('keyed');
}

function markSelection() {
  holdOverlays();
  const layer = keyLayer();
  const saved = keyState.sel.get(layer.place);
  if (saved && layer.host) remark(layer, saved);
  settleReach();
}

function remark(layer, saved) {
  const rows = layerRows(layer);
  const at = findRow(rows, saved);
  if (at < 0) return keyState.sel.delete(layer.place);
  const row = rows[at];
  keyState.sel.set(layer.place, { id: rowId(row), index: at });
  markRow(row);
  if (saved.scroll) row.scrollIntoView({ block: 'nearest' });
  if (keyState.refocus && focusFell()) row.focus({ preventScroll: true });
}

function focusFell() {
  const a = document.activeElement;
  return !a || a === document.body || a.id === 'main' || Boolean(a.classList?.contains('drawer') || a.classList?.contains('sheet'));
}

function focusView() {
  const row = document.querySelector('#main .is-selected');
  (keyState.refocus && row ? row : byId('main')).focus({ preventScroll: true });
}

// Focus rather than a click, so changing a setting or a tick box takes a press of its own.
function openRow(row) {
  keyState.refocus = true;
  const primary = row.classList.contains('setting') ? null : rowPrimary(row);
  if (primary) return primary.click();
  row.querySelector('input, select, textarea, button')?.focus({ preventScroll: true });
}

function rowPrimary(row) {
  if (row.matches('a[href], button')) return row;
  return ownIn(row, '[data-primary]') ?? ownIn(row, '.ref') ?? ownIn(row, '.ticket-ref') ?? ownIn(row, 'a[href]') ?? ownIn(row, '[aria-expanded]') ?? ownIn(row, 'summary');
}

function focusSearch() {
  const box = keyLayer().name === 'main' ? document.querySelector('#main input[type="search"]') : null;
  if (!box) return openPalette();
  box.focus();
  const end = String(box.value ?? box.getAttribute('value') ?? '').length;
  box.setSelectionRange?.(end, end);
}

function goView(name, setup) {
  const same = location.hash === '#' + name;
  ui.menu = null;
  if (ui.file) slot('closeFile');
  setup?.();
  slot('goTo', name);
  if (same) render(true);
}

const ESC_STEPS = [
  [() => keyState.overlay === 'help', () => closeShortcuts()],
  [() => keyState.overlay === 'palette', () => closePalette()],
  [(target) => typingIn(target), leaveField],
  [(target) => Boolean(slot('claudeHasFocus', target)), () => slot('closeClaudePanel')],
  [(target) => Boolean(slot('agentWinHasFocus', target)), () => slot('agentWinClose')],
  [() => ui.board?.legend, () => slot('closeLegend', true)],
  [() => ui.armed, () => disarmKeys()],
  [() => ui.menu?.startsWith('mr:'), () => slot('escapeMrMenu')],
  [() => ui.message, () => slot('closeMessage')],
  [() => Boolean(slot('calendarEventShown')), () => slot('calendarClose')],
  [() => ui.file, () => slot('closeFile')],
  [() => ui.mr || ui.ticket, () => slot('closeDrawer')],
  [() => slot('officeCardOpen'), () => slot('officeClose')],
  [() => keyState.sel.has(keyLayer().place), clearSelection],
  [() => keyLayer().name === 'main' && Boolean(slot('settingsFindClears')), () => slot('settingsFindClear')],
];

function escapeOne(target) {
  const step = ESC_STEPS.find(([applies]) => applies(target));
  step?.[1](target);
  return Boolean(step);
}

function leaveField(field) {
  const value = field.value ?? field.getAttribute('value') ?? '';
  if (field.getAttribute('type') === 'search' && value) {
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const row = field.closest(KEY_ROWS);
  const home = row ?? field.closest('.drawer, .sheet, .cpanel, .awin, .mm') ?? byId('main');
  if (!home.hasAttribute('tabindex')) home.setAttribute('tabindex', '-1');
  home.focus({ preventScroll: true });
}

// A key moved focus onto the armed button, so cancelling hands it back to the row.
function disarmKeys() {
  const onArmed = document.activeElement?.id === 'g-' + ui.armed;
  ui.armed = null;
  keyState.armedByKey = null;
  render(true);
  if (onArmed) layerHome()?.focus({ preventScroll: true });
}

function controlIn(id) {
  const layer = keyLayer();
  const scopes = layer.name === 'main' ? [keyContext().row, byId('main'), document] : [layer.host];
  for (const scope of scopes.filter(Boolean)) {
    const node = [...scope.querySelectorAll('[id]')].find((n) => n.id === id);
    if (node) return node;
  }
  return null;
}

function armControl({ id, reveal }, via) {
  reach({ find: () => controlIn('g-' + id), reveal, missing: 'That is not offered here right now' }, (node) => pressGuarded(node, id, via));
}

// Only a key's own arm is confirmed by a key; the palette, or an arm made with the mouse, leaves the button focused for Enter.
function pressGuarded(node, id, via) {
  if (node.disabled) return;
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: 'nearest' });
  if (ui.armed === id) {
    if (via === 'key' && keyState.armedByKey === id) node.click();
    return;
  }
  keyState.armedByKey = id;
  node.click();
}

function focusControl(node) {
  keyState.refocus = false;
  node.scrollIntoView({ block: 'center' });
  node.focus({ preventScroll: true });
}

// A control behind a drawer tab or a Jira read may only appear a render or two later, so it is waited for, never pressed blind.
function reach({ find, reveal, missing }, then) {
  const now = find();
  if (now) return then(now);
  if (!reveal) return toast(missing, true);
  reveal();
  const after = find();
  if (after) return then(after);
  const waiting = { find, then, missing };
  keyState.waiting = waiting;
  setTimeout(() => {
    if (keyState.waiting !== waiting) return;
    keyState.waiting = null;
    toast(missing, true);
  }, REACH_MS);
}

// Pressed after this render returns, and looked up again then, since a read landing in between draws the control anew.
function settleReach() {
  const waiting = keyState.waiting;
  if (!waiting?.find()) return;
  keyState.waiting = null;
  setTimeout(() => {
    const node = waiting.find();
    if (node) waiting.then(node);
  }, 0);
}

// Repeats renderDrawer's inert rule, which this runs after, adding the palette and the shortcuts.
function holdOverlays() {
  const held = Boolean(keyState.overlay);
  const app = document.querySelector('.app');
  if (app) app.inert = held || Boolean(ui.mr || ui.ticket || ui.file || ui.message);
  byId('drawer').inert = held || Boolean(ui.file);
  byId('sheet').inert = held;
  const panel = byId('claude-panel');
  if (panel) panel.inert = held || Boolean(ui.message);
}

function onPointer(e) {
  keyState.refocus = false;
  document.body.classList.remove('keyed');
  const row = e.target?.closest?.(KEY_ROWS);
  const layer = keyLayer();
  if (!row || !layer.host?.contains(row)) return;
  const rows = layerRows(layer);
  const index = rows.indexOf(row);
  if (index >= 0) selectRow(layer, rows, index, false);
}

addEventListener('keydown', onKey);
document.addEventListener('pointerdown', onPointer, true);
document.addEventListener('focusin', (e) => {
  if (!e.target?.classList?.contains('is-selected')) keyState.refocus = false;
});
