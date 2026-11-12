const LOCALE_CLOCKS = [['', 'As the region'], ['24', '24 hour'], ['12', '12 hour']];
const LOCALE_WEEK = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
const localeBox = { drafts: {}, zones: null };

function localeSettingsGroup() {
  const l = state.locale;
  if (!l) return null;
  return el('section', { class: 'section settings-group', id: 'locale-settings' }, el('h2', {}, 'Time and region'),
    localeTextRow('timeZone', 'Time zone', l.zoneSet, "blank, so this Mac's", localeZoneHint(l), localeZoneList()),
    localeTextRow('region', 'Region', l.region, "blank, so your system's", localeRegionHint(l)),
    el('div', { class: 'setting' }, el('label', {}, 'Clock'),
      el('div', { class: 'control' }, chips(LOCALE_CLOCKS, l.clock, (clock) => localeSave({ clock }), 'locale-clock-')),
      el('p', { class: 'hint' }, 'How times are written. As the region uses whichever clock the region above writes times in.')));
}

function localeZoneHint(l) {
  const here = l.zoneSet ? 'Times are shown in ' + l.zoneSet + '. This Mac is in ' + l.machineZone + '.' : 'Blank follows this Mac, now in ' + l.machineZone + '.';
  return 'The zone every time, day and working hour is read in, such as Europe/London or America/New_York. ' + here;
}

function localeRegionHint(l) {
  const system = new Intl.DateTimeFormat().resolvedOptions().locale;
  const now = 'Now written as ' + whenText(Date.now()) + ' and ' + numberText(1234.5) + '.';
  return 'How dates and numbers are written, such as en-GB or en-US. ' + (l.region ? now : 'Blank writes them as your system does, now ' + system + '. ' + now);
}

// Built once, as the page is drawn again on every key.
function localeZoneList() {
  if (typeof Intl.supportedValuesOf !== 'function') return null;
  localeBox.zones ??= el('datalist', { id: 'locale-zones' }, Intl.supportedValuesOf('timeZone').map((zone) => el('option', { value: zone })));
  return localeBox.zones;
}

function localeTextRow(key, label, saved, placeholder, hint, extra = null) {
  const draft = localeBox.drafts[key];
  const value = draft ?? saved ?? '';
  const save = () => localeSave({ [key]: value.trim() });
  return el('div', { class: 'setting' }, el('label', { for: 'locale-' + key }, label),
    el('div', { class: 'control' },
      el('input', {
        id: 'locale-' + key, type: 'text', value, placeholder, spellcheck: 'false', autocomplete: 'off', list: extra ? 'locale-zones' : null, readonly: ui.busy.has('locale'),
        oninput: (e) => { localeBox.drafts[key] = e.target.value; render(true); },
        onkeydown: (e) => { if (e.key === 'Enter' && draft !== undefined) save(); },
      }),
      extra,
      draft !== undefined && draft !== saved ? button('Save', 'check', save, true) : null),
    el('p', { class: 'hint' }, hint));
}

function hoursSettingsGroup() {
  const hours = state.locale?.hours;
  if (!hours) return null;
  const days = new Set(hours.workDays);
  const flip = (day) => localeSave({ workDays: days.has(day) ? hours.workDays.filter((d) => d !== day) : [...hours.workDays, day] });
  return el('section', { class: 'section settings-group', id: 'hours-settings' }, el('h2', {}, 'Working hours'),
    el('div', { class: 'setting' }, el('label', { for: 'hours-from' }, 'Hours'),
      el('div', { class: 'control' },
        el('input', { id: 'hours-from', type: 'time', value: hours.from, onchange: (e) => localeSave({ from: e.target.value }) }),
        el('span', { class: 'unit' }, 'to'),
        el('input', { id: 'hours-to', type: 'time', value: hours.to, 'aria-label': 'Until', onchange: (e) => localeSave({ to: e.target.value }) })),
      el('p', { class: 'hint' }, 'Email and Slack are read only in these hours, on the days below, and the calendar opens on them.')),
    el('div', { class: 'setting' }, el('label', {}, 'Working days'),
      el('div', { class: 'control' }, el('div', { class: 'chips', role: 'group', 'aria-label': 'Working days' },
        LOCALE_WEEK.map(([day, name]) => el('button', { class: 'chip', id: 'hours-day-' + day, 'aria-pressed': String(days.has(day)), disabled: ui.busy.has('locale') || (days.has(day) && days.size === 1), onclick: () => flip(day) }, name)))),
      el('p', { class: 'hint' }, 'The Standup looks back to your last working day, the calendar week shows these days, and banners can stay quiet on the rest.')));
}

async function localeSave(patch) {
  if (ui.busy.has('locale')) return;
  const answer = await busyAct('/api/locale', patch, 'locale');
  if (!answer) return;
  for (const key of Object.keys(patch)) delete localeBox.drafts[key];
  const { ok, text, ...view } = answer;
  if (view.hours) state.locale = view;
  render(true);
}
