const SETTING_GROUPS = [
  ['GitLab', ['gitlab.host']],
  ['GitHub', ['github.on', 'github.scope', 'github.repos', 'github.host']],
  ['Repos', ['repoFilter']],
  ['Reviewing', ['holdWhileReviewing', 'closeWorkspaceWhenDone', 'reReviewOnChange']],
  ['Refresh every', ['pollSeconds']],
  ['Workspace root', ['workspaceRoot']],
  ['Jira site', ['jiraSite']],
  ['Tickets', ['jira.projects', 'jira.defaultProject', 'jira.statuses', 'jira.doneStatuses', 'jira.issueType', 'jira.ticketTemplate', 'tickets.noQaPaths']],
  ['Leaderboard', ['leaderboardDays', 'pointWeights']],
  ['Running agents', ['agentHost', 'agentPermissions', 'maxAgents', 'agentBudgetUsd']],
  ['Full auto guardrails', ['autoHoldSeconds', 'autoMaxComments', 'autoMaxDiffLines', 'autoSensitivePaths', 'autoFooter']],
  ['What reviews post as you', ['holdNote', 'postedFooter', 'autoFooterText']],
];
const GROUP_FEATURES = { Tickets: 'tickets', Leaderboard: 'leaderboard' };
const SETTING_UNITS = { pollSeconds: 'seconds', autoHoldSeconds: 'seconds', leaderboardDays: 'days', autoMaxComments: 'comments', autoMaxDiffLines: 'lines', maxAgents: 'agents' };
const REPOS_SHOWN = 12;
const WATCH_FILTERS = [['all', 'All'], ['auto', 'Auto'], ['agent', 'With an agent'], ['moved', 'Moved'], ['closed', 'Closed']];
let previewTimer;

// Read once per state the page holds, so a refresh or an action reads it again and a plain re-render does not.
function readOnce(box, path) {
  if (box.at !== state.generatedAt && !box.loading) fetchInto(box, path);
  return box.data ?? null;
}

async function fetchInto(box, path) {
  const at = state.generatedAt;
  box.loading = true;
  try {
    box.data = await api(path);
    box.error = null;
  } catch (e) {
    box.error = e.message;
  }
  Object.assign(box, { at, loading: false });
  render(true);
}

function watchingData() {
  return readOnce(ui.watching, '/api/matrix/watching');
}

function knownWatch(key) {
  return ui.watching.data?.rows.find((w) => w.key === key) ?? null;
}

function mrMenu(r) {
  const id = 'mr:' + r.key;
  const open = ui.menu === id;
  if (open) watchingData();
  return el('span', { class: 'menu-wrap' },
    el('button', { class: 'icon-only', id: 'menu-' + r.key, title: 'Watching and re-review', 'aria-label': 'More for ' + short(r.key), 'aria-haspopup': 'menu', 'aria-expanded': String(open), onclick: () => toggleMrMenu(id) }, icon('more')),
    open ? el('div', { class: 'menu', role: 'menu', 'aria-label': 'Watching ' + short(r.key) }, mrMenuItems(r)) : null);
}

function toggleMrMenu(id) {
  ui.menu = ui.menu === id ? null : id;
  render(true);
  if (ui.menu) document.querySelector('.menu-wrap .menu button')?.focus({ preventScroll: true });
}

function mrMenuItems(r) {
  const key = r.key;
  const watched = Boolean(r.watch);
  const auto = Boolean(r.watch?.auto);
  const agents = forgeAllows(key, 'agents');
  return [
    watched ? stopWatchButton(key, scheduleOf(knownWatch(key)), 'Unwatch', true)
      : mrMenuItem('watch:' + key, 'Watch', 'eye', () => matrixAct('watch', { key }, 'watch:' + key)),
    agents ? scheduleItem(key) : null,
    agents ? mrMenuItem('auto:' + key, auto ? 'Auto re-review off' : 'Auto re-review on', 'zap', () => matrixAct('auto', { key, auto: !auto }, 'auto:' + key)) : null,
    r.flags.changed ? mrMenuItem('seen:' + key, 'Mark seen', 'check', () => matrixAct('seen', { key }, 'seen:' + key)) : null,
    agents ? slot('fixMenuItem', r) : null,
    slot('muteMenuItems', key),
  ];
}

function mrMenuItem(id, label, iconName, run) {
  return el('button', { id: 'mi-' + id, role: 'menuitem', disabled: ui.busy.has(id), onclick: () => { ui.menu = null; run(); } }, icon(iconName), label);
}

function menuGuarded(...args) {
  const node = guarded(...args);
  node.setAttribute('role', 'menuitem');
  return node;
}

// What the worker checks a schedule action against, so a change since the page read it is refused.
function scheduleOf(w) {
  return { daily: w?.daily ?? null, automation: w?.automation ?? null };
}

function scheduleItem(key) {
  const expect = scheduleOf(knownWatch(key));
  if (expect.automation) return moveButton(key, expect, true);
  const name = expect.daily ? 'unschedule' : 'schedule';
  const run = () => { ui.menu = null; matrixAct(name, { key, expect }, name + ':' + key); };
  return expect.daily
    ? menuGuarded(name + ':' + key, 'Stop the daily re-review', 'clock', 'Stop it?', run)
    : menuGuarded(name + ':' + key, 'Re-review daily', 'clock', 'Look once a day, and review on days it moved?', run);
}

function moveButton(key, expect, inMenu) {
  const id = 'move-automation:' + key;
  const run = () => { ui.menu = null; matrixAct('move-automation', { key, expect }, id); };
  return (inMenu ? menuGuarded : guarded)(id, 'Move to the schedule here', 'clock', 'Move ' + expect.automation + ' here?', run, !inMenu);
}

function stopWatchButton(key, expect, label, inMenu) {
  const id = 'unwatch:' + key;
  const run = () => { ui.menu = null; matrixAct('unwatch', { key, expect }, id); };
  if (expect.daily || expect.automation) return (inMenu ? menuGuarded : guarded)(id, label, 'eyeoff', 'Stop, and its daily re-review?', run);
  return inMenu ? mrMenuItem(id, label, 'eyeoff', run) : el('button', { id: 'b-' + id, disabled: ui.busy.has(id), onclick: run }, icon('eyeoff'), label);
}

// Daily re-reviews an older build scheduled as Orca automations, each with its two-click move onto the schedule here.
function orcaSchedules(rows) {
  const left = rows.filter((w) => w.automation && w.stillOpen);
  if (!left.length) return null;
  return section('Daily re-reviews Orca still runs',
    banner('These were scheduled as Orca automations. Moving one puts it on the schedule here, which whichever worker drives full auto runs. The automation itself is left for you to delete from Orca.'),
    el('div', { class: 'list' }, left.map((w) => el('div', { class: 'row' },
      el('div', { class: 'row-head' }, el('span', { class: 'pill s-info', title: w.automation }, icon('clock'), 'Orca'), mrRef(w.key, w.title ?? short(w.key))),
      el('div', { class: 'actions' }, moveButton(w.key, scheduleOf(w), false))))));
}

function closeMrMenu(e) {
  if (!ui.menu?.startsWith('mr:') || e.target.closest?.('.menu-wrap')) return;
  ui.menu = null;
  render(true);
}

function mrMenuKeys(e) {
  if (!ui.menu?.startsWith('mr:')) return;
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  const items = [...document.querySelectorAll('.menu-wrap .menu button')];
  const at = items.indexOf(document.activeElement);
  if (!step || at < 0) return;
  e.preventDefault();
  items[(at + step + items.length) % items.length].focus({ preventScroll: true });
}

function escapeMrMenu() {
  const key = ui.menu.slice(3);
  ui.menu = null;
  render();
  document.getElementById('menu-' + key)?.focus({ preventScroll: true });
}

document.addEventListener('click', closeMrMenu);
addEventListener('keydown', mrMenuKeys);

function viewWatching(d) {
  const data = watchingData();
  const rows = data?.rows ?? [];
  const pick = {
    all: () => true, auto: (w) => w.auto, agent: (w) => w.agent, moved: (w) => w.moved && w.stillOpen, closed: (w) => !w.stillOpen,
  };
  const count = (f) => rows.filter(pick[f]).length;
  const shown = rows.filter(pick[ui.watching.filter] ?? pick.all);
  return [
    header('Watching', watchingSummary(rows, data), allAutoButton(rows.filter((w) => w.stillOpen && !w.auto)), clearClosedButton(rows.filter(pick.closed))),
    matrixBanners(d.m),
    ui.watching.error ? banner('Could not read the watches: ' + ui.watching.error, true) : null,
    orcaSchedules(rows),
    rows.length ? el('div', { class: 'filters' }, chips(WATCH_FILTERS.map(([f, label]) => [f, f === 'all' ? label : label + ' ' + count(f)]), ui.watching.filter, (f) => { ui.watching.filter = f; render(); })) : null,
    !data ? empty(ui.watching.error ? 'Nothing to show yet.' : 'Reading the watches…')
      : shown.length ? el('div', { class: 'list' }, shown.map(watchRow))
        : empty(rows.length ? 'No watch matches.' : 'Nothing is being watched. Watch an MR from its menu in Merge requests, or review one.'),
  ];
}

function watchingSummary(rows, data) {
  if (!data) return 'The MRs you watch for changes.';
  const autos = rows.filter((w) => w.auto).length;
  const agents = rows.filter((w) => w.agent).length;
  return [plural(rows.length, 'MR') + ' watched', autos ? autos + ' re-reviewing on their own' : null, agents ? agents + ' with an agent' : null].filter(Boolean).join(', ') + '.';
}

// Each watch is switched by the worker's own auto action, one after another, so a refusal stops the rest and is said.
function allAutoButton(off) {
  if (off.length < 2) return null;
  return guarded('auto-all', 'Turn on for all ' + off.length, 'zap', 'Re-review all ' + off.length + ' when they change?', async () => {
    for (const w of off) if (!(await matrixAct('auto', { key: w.key, auto: true }, 'auto-all'))) break;
  });
}

function clearClosedButton(closed) {
  if (!closed.length) return null;
  const keys = closed.map((w) => w.key).sort((a, b) => a.localeCompare(b));
  return guarded('clear-closed', 'Clear ' + closed.length + ' closed', 'eraser', 'Stop watching ' + plural(closed.length, 'closed MR') + '?',
    () => matrixAct('unwatch', { closed: true, expect: { keys } }, 'clear-closed'));
}

function watchRow(w) {
  return el('div', { class: 'row watch' + (w.auto ? ' auto' : '') },
    el('div', { class: 'row-head' },
      w.auto ? el('span', { class: 'pill s-working' }, icon('zap'), 'auto') : null,
      w.daily ? el('span', { class: 'pill s-info', title: 'Next looks ' + fullText(w.daily) }, icon('clock'), 'daily') : null,
      w.agent ? el('span', { class: 'pill s-working' }, icon('bot'), 'agent ' + w.agent) : null,
      !w.stillOpen ? el('span', { class: 'pill s-done', title: 'Not in the open list: merged, closed, or outside the repo filter' }, 'closed') : w.moved ? el('span', { class: 'pill s-moved', title: w.movedWhy ? 'Since your review: ' + w.movedWhy : null }, 'moved') : null,
      w.stillOpen ? mrRef(w.key, w.title ?? short(w.key)) : el('span', { class: 'title' }, short(w.key))),
    el('div', { class: 'foot' },
      metaLine(w.repo + ' ' + refNumber(w), w.reviewedAt ? 'reviewed ' + ago(w.reviewedAt) : 'not reviewed', w.addedAt ? 'watched since ' + ago(w.addedAt) : null),
      el('div', { class: 'actions' }, watchActions(w))));
}

function watchActions(w) {
  const key = w.key;
  return [
    w.agent && w.stillOpen ? button('Agent', 'bot', () => slot('openMr', key, 'agent')) : null,
    w.moved && w.stillOpen ? el('button', { id: 'b-seen:' + key, disabled: ui.busy.has('seen:' + key), onclick: () => matrixAct('seen', { key }, 'seen:' + key) }, icon('check'), 'Mark seen') : null,
    w.stillOpen || w.auto ? el('button', { id: 'b-auto:' + key, class: 'auto-toggle', 'aria-pressed': String(w.auto), disabled: ui.busy.has('auto:' + key), title: w.auto ? 'Stop re-reviewing it on its own' : 'Launch a fresh review on its own whenever it moves', onclick: () => matrixAct('auto', { key, auto: !w.auto }, 'auto:' + key) },
      icon('zap'), 'Auto') : null,
    stopWatchButton(key, scheduleOf(w), 'Stop', false),
  ];
}

function viewSettings(d) {
  const body = settingsBody(d);
  const found = slot('settingsFilter', body);
  return [
    header('Settings', 'Review settings. A switch saves at once, a field on Enter or Save.'),
    slot('settingsFindBar', found),
    el('p', { class: 'settings-spend' }, icon('info'), 'Background agents, full auto and the Slack and email reads all run on your Claude plan, so they spend your Claude usage.'),
    d.m.available ? null : slot('engineBanner', d.m),
    ui.settings.error ? banner('Could not read the settings: ' + ui.settings.error, true) : null,
    body,
  ];
}

function settingsBody(d) {
  const data = readOnce(ui.settings, '/api/matrix/settings');
  const rows = new Map((data?.rows ?? []).map((row) => [row.key, row]));
  return el('div', { class: 'settings-body' },
    slot('profileSettingsGroup'),
    slot('setupSettingsGroup'),
    slot('featureSettingsGroup'),
    !data ? empty(ui.settings.error ? 'Nothing to show yet.' : 'Reading the settings…')
      : SETTING_GROUPS.map(([title, keys]) => settingGroup(title, keys.map((k) => rows.get(k)).filter(Boolean), data)),
    slot('agentSettingsGroup', data),
    slot('modelSettingsGroup'),
    slot('notificationsGroup'),
    slot('localeSettingsGroup'),
    slot('hoursSettingsGroup'),
    slot('standupSettingsGroup'),
    slot('calendarSettingsGroup'),
    slot('emailSettingsGroup'),
    slot('slackSettingsGroup'),
    slot('qaSettingsGroup'),
    slot('claudeSettingsGroup'),
    slot('introSettingsGroup'),
    slot('gameSettingsGroup'),
    slot('artifactSettingsGroup'));
}

function settingGroup(title, rows, data) {
  if (!rows.length) return null;
  return el('section', { class: 'section settings-group' }, el('h2', {}, title),
    GROUP_FEATURES[title] ? slot('featureSwitch', GROUP_FEATURES[title]) : null,
    rows.map((row) => settingRow(row)),
    title === 'Repos' ? repoSummary(data.repos) : null);
}

function settingDrafts() {
  ui.settings.draft ??= {};
  return ui.settings.draft;
}

function settingRow(row) {
  const draft = settingDrafts()[row.key];
  const unsaved = draft !== undefined && draft !== String(row.value ?? '');
  return el('div', { class: 'setting' },
    el('label', { for: 'set-' + row.key }, row.label),
    el('div', { class: 'control' }, settingControl(row, draft), unsaved ? unsavedActions(row, draft) : null),
    el('p', { class: 'hint' }, row.hint.charAt(0).toUpperCase() + row.hint.slice(1)),
    rootMissing(row) ? el('p', { class: 'hint bad' }, 'Full auto cannot launch reviews while this is blank.') : null);
}

function rootMissing(row) {
  return row.key === 'workspaceRoot' && !String(row.value ?? '').trim() && state.matrix.driver?.fix === 'settings';
}

// Number rows are text inputs too, as only those let the re-render on each key put the caret back.
function settingControl(row, draft) {
  const busy = ui.busy.has('setting:' + row.key);
  if (row.kind === 'toggle') {
    return el('button', { id: 'set-' + row.key, class: 'switch', role: 'switch', 'aria-checked': String(Boolean(row.value)), 'aria-disabled': busy ? 'true' : null, onclick: () => saveSetting(row.key, !row.value) },
      el('span', { class: 'knob' }), row.value ? 'On' : 'Off');
  }
  if (row.kind === 'choice') return chips(row.choices ?? [], row.value, (value) => saveSetting(row.key, value), 'set-' + row.key + '-');
  if (row.kind === 'lines') {
    return el('textarea', { id: 'set-' + row.key, rows: '5', readonly: busy, spellcheck: 'false', autocomplete: 'off', placeholder: 'blank',
      oninput: (e) => onSettingInput(row.key, e.target.value), onkeydown: (e) => { if (e.key === 'Escape') settingKeys(e, row.key); } }, draft ?? String(row.value ?? ''));
  }
  const number = row.kind === 'number';
  return [
    el('input', {
      id: 'set-' + row.key, type: 'text', inputmode: number ? 'numeric' : null, class: number ? 'number' : null, value: draft ?? String(row.value ?? ''),
      readonly: busy, spellcheck: 'false', autocomplete: 'off', placeholder: number ? null : 'blank',
      oninput: (e) => onSettingInput(row.key, e.target.value), onkeydown: (e) => settingKeys(e, row.key),
    }),
    number ? el('span', { class: 'unit' }, SETTING_UNITS[row.key] ?? '', row.bounds ? ' (' + row.bounds.min + ' to ' + row.bounds.max + ')' : '') : null,
  ];
}

function unsavedActions(row, draft) {
  return el('span', { class: 'actions' },
    button('Save', 'check', () => saveSetting(row.key, draft), true),
    button('Undo', 'undo', () => undoSetting(row.key)));
}

function settingKeys(e, key) {
  const draft = settingDrafts()[key];
  if (draft === undefined) return;
  if (e.key === 'Enter') saveSetting(key, draft);
  if (e.key !== 'Escape') return;
  e.preventDefault();
  undoSetting(key);
}

function undoSetting(key) {
  delete settingDrafts()[key];
  render(true);
}

function onSettingInput(key, value) {
  settingDrafts()[key] = value;
  render(true);
  if (key !== 'repoFilter') return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => previewRepos(value), 250);
}

async function previewRepos(filter) {
  try {
    const { repos } = await api('/api/matrix/settings?' + new URLSearchParams({ filter }));
    ui.settings.preview = repos;
  } catch (e) {
    ui.settings.preview = { filter, error: e.message };
  }
  render(true);
}

// The draft stays until the saved value is read back, so the field never flashes the old one.
async function saveSetting(key, value) {
  if (ui.busy.has('setting:' + key)) return;
  const focused = document.activeElement?.id;
  const saved = await matrixAct('settings', { patch: { [key]: value } }, 'setting:' + key);
  await fetchInto(ui.settings, '/api/matrix/settings');
  if (saved && settingDrafts()[key] === value) delete settingDrafts()[key];
  render(true);
  if (focused && document.activeElement === document.body) document.getElementById(focused)?.focus({ preventScroll: true });
}

function repoSummary(saved) {
  const draft = settingDrafts().repoFilter;
  const preview = ui.settings.preview;
  const repos = draft !== undefined && preview?.filter === draft ? preview : saved;
  if (repos.error) return banner('Could not match the filter: ' + repos.error, true);
  const shown = ui.settings.allRepos ? repos.matching : repos.matching.slice(0, REPOS_SHOWN);
  return el('div', { class: 'repos' },
    el('p', { class: 'match' }, el('b', {}, String(repos.matching.length)), ' of ', String(repos.total), ' repos match',
      draft !== undefined && repos === preview ? ' as typed' : '', '. ',
      el('span', { class: 'meta' }, repos.perRefresh + (repos.perRefresh === 1 ? ' query' : ' queries') + ' a refresh, ' + repos.perMinute + ' a minute')),
    repos.heavy ? banner('That is more than GitLab will take for long. Narrow the filter or refresh less often, or GitLab will start refusing with 429s.', true) : null,
    repos.total ? null : banner('No repo list yet. Look for repos again to fetch one from GitLab.'),
    shown.length ? el('ul', { class: 'repo-list' }, shown.map((path) => el('li', {}, path))) : null,
    repos.matching.length > REPOS_SHOWN ? el('button', { class: 'linkish', onclick: () => { ui.settings.allRepos = !ui.settings.allRepos; render(true); } },
      ui.settings.allRepos ? 'Show fewer' : 'Show all ' + repos.matching.length) : null,
    el('div', { class: 'foot' }, el('span', { class: 'meta' }, plural(repos.total, 'repo') + ' found' + (repos.discoveredAt ? ' ' + ago(repos.discoveredAt) : '')), discoverButton()));
}

function discoverButton() {
  return el('button', { id: 'b-discover', disabled: ui.busy.has('discover'), title: 'Ask GitLab again which repos have open MRs, to pick up one added since', onclick: () => matrixAct('discover', {}, 'discover').then(() => { ui.settings.at = null; }) },
    icon('refresh'), ui.busy.has('discover') ? 'Looking…' : 'Look for repos again');
}
