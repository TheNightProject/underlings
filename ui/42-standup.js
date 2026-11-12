const STANDUP_GREETING = 'Morning';

function standupBox() {
  ui.standup ??= { day: null, asked: null, data: null, error: null, loading: false, at: null, fixing: new Map(), settings: null, address: '', repos: null };
  return ui.standup;
}

// The worker says when a day it was working out is ready, so a read follows every state the page holds.
function standupData(box) {
  const want = box.day ?? '';
  if ((box.at !== state.generatedAt || box.asked !== want) && !box.loading) loadStandup(box, want);
  return box.asked === want ? box.data : null;
}

async function loadStandup(box, want) {
  Object.assign(box, { loading: true, at: state.generatedAt, asked: want });
  try {
    box.data = await api('/api/standup' + (want ? '?day=' + encodeURIComponent(want) : ''));
    box.error = null;
  } catch (e) {
    box.error = e.message;
  }
  box.loading = false;
  render(true);
}

function viewStandup() {
  const box = standupBox();
  const data = standupData(box);
  const day = box.day ?? data?.day ?? '';
  return [
    header('Standup', 'Worked out from GitLab, Jira and your calendar. Untick what to leave out, then copy the rest for Slack.',
      standupDayPicker(box, data, day), standupGenerate(data, day), data?.standup ? button('Copy for Slack', 'copy', () => copyStandup(data), true) : null),
    box.error ? banner('Could not read the standup: ' + box.error, true) : null,
    data?.error ? banner('Could not work out ' + dayName(day) + ': ' + data.error, true) : null,
    standupWaiting(box, data, day),
    data?.standup ? data.standup.sections.map((s) => standupSection(data, s)) : null,
    data?.standup ? el('details', { class: 'section standup-preview' }, el('summary', {}, 'What Copy for Slack copies'), el('pre', {}, slackText(data))) : null,
  ];
}

function standupWaiting(box, data, day) {
  if (data?.generating) return el('p', { class: 'empty' }, icon('clock'), (data.standup ? 'Working out ' : 'Working out the standup for ') + dayName(day) + ' from GitLab, Jira and your calendar…');
  if (!data && !box.error) return el('p', { class: 'empty' }, icon('clock'), 'Reading the standup…');
  return null;
}

const dayName = (day) => (day ? dayText(day, { weekday: 'long', day: 'numeric', month: 'long' }) : '');

function workingDayFrom(day, step) {
  const at = new Date(day + 'T12:00:00Z');
  const working = workDaysHere();
  do at.setUTCDate(at.getUTCDate() + step); while (!working.includes(at.getUTCDay()));
  return at.toISOString().slice(0, 10);
}

function standupDayPicker(box, data, day) {
  const later = day ? workingDayFrom(day, 1) : '';
  return el('div', { class: 'standup-day' },
    el('button', { class: 'icon-only', id: 'standup-before', title: 'The working day before', 'aria-label': 'The working day before', disabled: !day, onclick: () => pickStandupDay(workingDayFrom(day, -1)) }, icon('chevron-left')),
    el('input', { type: 'date', id: 'standup-day', value: day, max: data?.latest ?? null, 'aria-label': 'Standup day', onchange: (e) => pickStandupDay(e.target.value) }),
    el('button', { class: 'icon-only', id: 'standup-after', title: 'The working day after', 'aria-label': 'The working day after', disabled: !day || !data || later > data.latest, onclick: () => pickStandupDay(later) }, icon('chevron')),
    data && day !== data.defaultDay ? el('button', { class: 'linkish', onclick: () => pickStandupDay(data.defaultDay) }, 'Back to ' + dayName(data.defaultDay)) : null);
}

function pickStandupDay(day) {
  const box = standupBox();
  if (!day || day === box.day) return;
  Object.assign(box, { day, data: null, error: null, at: null });
  render(true);
}

function standupGenerate(data, day) {
  const busy = Boolean(data?.generating) || ui.busy.has('standup-generate');
  return el('button', { id: 'standup-generate', disabled: busy || !day, title: 'Read GitLab, Jira and your calendar again. What you unticked stays unticked.', onclick: () => generateStandup(day) },
    icon(busy ? 'clock' : 'refresh'), busy ? 'Working…' : data?.standup ? 'Generate again' : 'Generate');
}

async function generateStandup(day) {
  if (await busyAct('/api/standup/generate', { day }, 'standup-generate')) standupBox().at = null;
}

function standupSection(data, s) {
  return el('section', { class: 'section standup-section', 'data-section': s.id },
    el('h2', {}, icon(s.id === 'today' ? 'play' : 'check-circle'), s.title, el('span', { class: 'meta' }, dayName(s.day))),
    s.groups.map((g) => standupGroup(data, g)));
}

function standupGroup(data, g) {
  const ticked = g.lines.filter((l) => l.ticked).length;
  const all = g.lines.length > 0 && ticked === g.lines.length;
  return el('div', { class: 'standup-group', 'data-group': g.id },
    el('label', { class: 'standup-group-head' },
      g.lines.length ? standupCheck('sg-' + g.id, all, ticked > 0 && !all, 'Tick every line under ' + g.title, () => tickStandup(data, g.lines.map((l) => l.id), !all)) : null,
      el('span', { class: 'standup-group-title' }, g.title),
      el('span', { class: 'meta' }, g.lines.length ? ticked + ' of ' + g.lines.length : 'none')),
    g.error ? el('p', { class: 'hint bad' }, g.error) : null,
    g.note ? el('p', { class: 'hint' }, g.note, data.calendarSet ? null : [' ', el('a', { class: 'fix-link', ...inPage('#settings') }, icon('settings'), 'Settings')]) : null,
    g.lines.length ? el('ul', { class: 'standup-lines' }, g.lines.map((l) => standupLine(data, l))) : null);
}

// An indeterminate box can only be set as a property, so a part-ticked group says so in both.
function standupCheck(id, checked, mixed, label, onChange) {
  const box = el('input', { type: 'checkbox', id, checked, 'aria-label': label, 'aria-checked': mixed ? 'mixed' : null, onchange: onChange });
  box.indeterminate = mixed;
  return box;
}

function standupLine(data, l) {
  return el('li', { class: 'standup-line' + (l.unknown ? ' unknown' : '') + (l.ticked ? '' : ' off'), 'data-line': l.id },
    el('label', {},
      standupCheck('sl-' + l.id, l.ticked, false, null, () => tickStandup(data, [l.id], !l.ticked)),
      el('span', { class: 'standup-body' }, el('span', { class: 'standup-tag' }, '[' + l.tag + ']'), ' ', el('span', { class: 'standup-text' }, l.text))),
    l.unknown ? standupFix(data, l) : null);
}

function standupFix(data, l) {
  const box = standupBox();
  const save = () => tagStandup(data.day, l.id, box.fixing.get(l.id) ?? '');
  return el('span', { class: 'standup-fix' },
    el('input', { id: 'sf-' + l.id, type: 'text', value: box.fixing.get(l.id) ?? '', placeholder: exampleKey(), spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Ticket for ' + l.text,
      oninput: (e) => box.fixing.set(l.id, e.target.value), onkeydown: (e) => { if (e.key === 'Enter') save(); } }),
    el('button', { id: 'sf-save-' + l.id, disabled: ui.busy.has('standup-tag:' + l.id), onclick: save }, icon('tag'), 'Set ticket'));
}

// The box moves at once, and the worker's answer replaces the page's copy so a second window agrees.
async function tickStandup(data, ids, ticked) {
  const box = standupBox();
  const wanted = new Set(ids);
  for (const s of data.standup.sections) for (const g of s.groups) for (const l of g.lines) if (wanted.has(l.id)) l.ticked = ticked;
  render(true);
  try {
    box.data = await api('/api/standup/tick', { day: data.day, ids, ticked });
  } catch (e) {
    toast(e.message, true);
    box.at = null;
  }
  render(true);
}

async function tagStandup(day, id, ticket) {
  const box = standupBox();
  ui.busy.add('standup-tag:' + id);
  render(true);
  try {
    box.data = await api('/api/standup/tag', { day, id, ticket });
    box.fixing.delete(id);
  } catch (e) {
    toast(e.message, true);
  } finally {
    ui.busy.delete('standup-tag:' + id);
    render(true);
  }
}

function slackText(data) {
  const lines = [STANDUP_GREETING];
  for (const s of data.standup.sections) {
    lines.push(s.title + ':');
    for (const g of s.groups) for (const l of g.lines) if (l.ticked) lines.push('- [' + l.tag + '] ' + l.text);
  }
  return lines.join('\n');
}

async function copyStandup(data) {
  const text = slackText(data);
  const count = text.split('\n').filter((line) => line.startsWith('- ')).length;
  if (await copyText(text)) toast('Copied ' + plural(count, 'line') + ' for Slack');
  else toast('Could not copy the standup', true);
}

function standupSettings() {
  const box = standupBox();
  if (box.settingsAt !== state.generatedAt && !box.settingsLoading) loadStandupSettings(box);
  return box.settings;
}

async function loadStandupSettings(box) {
  Object.assign(box, { settingsLoading: true, settingsAt: state.generatedAt });
  try {
    box.settings = await api('/api/standup/settings');
    box.settingsError = null;
  } catch (e) {
    box.settingsError = e.message;
  }
  box.settingsLoading = false;
  render(true);
}

function standupSettingsGroup() {
  const box = standupBox();
  const s = standupSettings();
  return el('section', { class: 'section settings-group', id: 'standup-settings' }, el('h2', {}, 'Standup'),
    slot('featureSwitch', 'standup'),
    box.settingsError ? banner('Could not read the standup settings: ' + box.settingsError, true) : null,
    calendarSetting(box, s), reposSetting(box, s));
}

function calendarSetting(box, s) {
  const save = () => saveStandupSetting({ calendarAddress: box.address });
  return el('div', { class: 'setting' }, el('label', { for: 'standup-address' }, 'Calendar address'),
    el('div', { class: 'control' },
      el('span', { class: 'pill ' + (s?.calendarSet ? 's-done' : 's-quiet') }, s?.calendarSet ? 'Set' : 'Not set'),
      el('input', { id: 'standup-address', type: 'password', value: box.address, placeholder: s?.calendarSet ? 'Paste a new address to replace it' : 'https://calendar.google.com/calendar/ical/…/basic.ics',
        autocomplete: 'off', spellcheck: 'false', oninput: (e) => { box.address = e.target.value; render(true); }, onkeydown: (e) => { if (e.key === 'Enter' && box.address.trim()) save(); } }),
      box.address.trim() ? button('Save', 'check', save, true) : null,
      s?.calendarSet && !box.address ? button('Remove', 'trash', () => saveStandupSetting({ calendarAddress: null })) : null),
    el('p', { class: 'hint' }, "Optional. In Google Calendar's settings, under your calendar, Integrate calendar: the Secret address in iCal format. It stays in the " + APP_NAME + " settings file, readable only by you, and this page only learns whether it is set."));
}

function reposSetting(box, s) {
  const repos = box.repos ?? s?.excludedRepos.join(', ') ?? '';
  const save = () => saveStandupSetting({ excludedRepos: repos });
  return el('div', { class: 'setting' }, el('label', { for: 'standup-repos' }, 'Repos left out'),
    el('div', { class: 'control' },
      el('input', { id: 'standup-repos', type: 'text', value: repos, spellcheck: 'false', autocomplete: 'off', placeholder: 'none',
        oninput: (e) => { box.repos = e.target.value; render(true); }, onkeydown: (e) => { if (e.key === 'Enter') save(); } }),
      box.repos !== null && s && box.repos !== s.excludedRepos.join(', ') ? button('Save', 'check', save, true) : null),
    el('p', { class: 'hint' }, 'Nothing in these repos is listed in a standup. Name each by the end of its path, separated by commas. Takes effect the next time a day is generated.'));
}

async function saveStandupSetting(patch) {
  const box = standupBox();
  const answer = await busyAct('/api/standup/settings', patch, 'standup-settings');
  if (!answer) return;
  box.settings = { calendarSet: answer.calendarSet, excludedRepos: answer.excludedRepos };
  if ('calendarAddress' in patch) box.address = '';
  if ('excludedRepos' in patch) box.repos = null;
  render(true);
}
