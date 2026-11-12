const CAL_STORE = 'cc.calendar';
const CAL_EVENT_STORE = 'cc.calendarEvent';
const CAL_LAYOUTS = [['day', 'Day'], ['week', 'Week'], ['agenda', 'Agenda']];
const CAL_NARROW = '(max-width: 640px)';
const CAL_HOUR_PX = 56;
const CAL_SHORT_PX = 36;
const CAL_TOP_MINUTES = 30;
const CAL_MIN_PX = 20;
const CAL_AGENDA_DAYS = 7;
const CAL_CHIP_MS = 15 * 60_000;
const CAL_JUST_STARTED_MS = 5 * 60_000;
const CAL_EVENT_MIN = { w: 320, h: 260 };
const CAL_EVENT_SIZE = { w: 440, h: 580 };
const CAL_RESPONSES = {
  accepted: ['Accepted', 's-done', 'You accepted'], tentative: ['Maybe', 's-working', 'You said maybe'],
  'needs-action': ['Not answered', 's-info', 'You have not answered'], declined: ['Declined', 's-quiet', 'You declined'],
};
const CAL_KINDS = { meet: 'Google Meet', zoom: 'Zoom', teams: 'Teams', other: 'the call' };
const CAL_URL = /https?:\/\/[^\s<>"'()[\]]*[^\s<>"'()[\].,;:!?]/g;
const calFloat = { place: {}, back: null, mark: '' };

function calBox() {
  ui.calendar ??= { cursor: null, data: null, error: null, loading: false, at: null, asked: null, open: null, settings: null, ...calPrefs() };
  return ui.calendar;
}

function calPrefs() {
  try {
    const kept = JSON.parse(localStorage.getItem(CAL_STORE) ?? 'null') ?? {};
    return { layout: CAL_LAYOUTS.some(([id]) => id === kept.layout) ? kept.layout : 'week', weekend: kept.weekend === true, declined: kept.declined === true };
  } catch {
    return { layout: 'week', weekend: false, declined: false };
  }
}

function calKeep(box) {
  try {
    localStorage.setItem(CAL_STORE, JSON.stringify({ layout: box.layout, weekend: box.weekend, declined: box.declined }));
  } catch {}
}

function calNarrow() {
  return typeof matchMedia === 'function' && matchMedia(CAL_NARROW).matches;
}

const calLayout = (box) => (calNarrow() ? 'agenda' : box.layout);

function calAddDays(day, n) {
  const at = new Date(day + 'T12:00:00Z');
  at.setUTCDate(at.getUTCDate() + n);
  return at.toISOString().slice(0, 10);
}

const calWeekday = (day) => new Date(day + 'T12:00:00Z').getUTCDay();

// The week starts on the first working day after a day off: Monday for most, Sunday for a Sunday to Thursday week.
function calWeekStart(day) {
  const working = workDaysHere();
  const first = [1, 2, 3, 4, 5, 6, 0].find((d) => working.includes(d) && !working.includes((d + 6) % 7)) ?? 1;
  return calAddDays(day, -((calWeekday(day) - first + 7) % 7));
}

const calDays = (from, to) => Array.from({ length: Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1 }, (_, n) => calAddDays(from, n));
const calDayName = (day, brief) => dayText(day, brief ? { weekday: 'short', day: 'numeric' } : { weekday: 'long', day: 'numeric', month: 'long' });

function calWindow(box, layout) {
  const day = box.cursor ?? todayHere();
  if (layout === 'day') return [day, day];
  if (layout === 'week') return [calWeekStart(day), calAddDays(calWeekStart(day), 6)];
  return [day, calAddDays(day, CAL_AGENDA_DAYS - 1)];
}

function calData(box, from, to) {
  const want = from + '/' + to;
  if ((box.at !== state.generatedAt || box.asked !== want) && !box.loading) calLoad(box, from, to, want);
  return box.data?.from === from && box.data?.to === to ? box.data : null;
}

async function calLoad(box, from, to, want) {
  Object.assign(box, { loading: true, at: state.generatedAt, asked: want });
  try {
    box.data = await api('/api/calendar?' + new URLSearchParams({ from, to }));
    box.error = null;
  } catch (e) {
    box.error = e.message;
  }
  box.loading = false;
  render(true);
}

function viewCalendar(d) {
  const box = calBox();
  const layout = calLayout(box);
  const [from, to] = calWindow(box, layout);
  const data = calData(box, from, to);
  return [
    header('Calendar', calSubtitle(data), calNarrow() ? null : chips(CAL_LAYOUTS, box.layout, calPickLayout, 'cal-layout-'), data?.set ? calRefreshButton(data) : null),
    box.error ? banner('Could not read the calendar view: ' + box.error, true) : null,
    data && !data.set ? calSetup() : null,
    data?.set && data.error ? banner((data.fetchedAt ? 'The last read failed, so this is from ' + ago(data.fetchedAt) + ': ' : 'Could not read your calendar: ') + data.error + '.', true) : null,
    !data && !box.error ? el('p', { class: 'empty' }, icon('clock'), 'Reading the calendar…') : null,
    data?.set ? calBar(box, layout, data) : null,
    data?.set && !data.fetchedAt && !data.error ? el('p', { class: 'empty' }, icon('clock'), 'Reading your calendar…') : null,
    data?.fetchedAt ? calBody(box, layout, data, d) : null,
  ];
}

function calSubtitle(data) {
  const read = data?.fetchedAt ? ' Read ' + ago(data.fetchedAt) + '.' : '';
  return 'Your Google Calendar, read from its secret address every ' + (data?.everyMinutes ?? 5) + ' minutes. Read only: answer an invite in Google Calendar.' + read;
}

function calRefreshButton(data) {
  const busy = data.fetching || ui.busy.has('calendar-refresh');
  return el('button', { id: 'cal-refresh', disabled: busy, title: 'Read your calendar again now', onclick: calRefresh }, icon(busy ? 'clock' : 'refresh'), busy ? 'Reading…' : 'Refresh');
}

async function calRefresh() {
  if (await busyAct('/api/calendar/refresh', {}, 'calendar-refresh')) calBox().at = null;
}

function calPickLayout(layout) {
  const box = calBox();
  box.layout = layout;
  calKeep(box);
  render(true);
}

function calSetup() {
  return el('section', { class: 'section cal-setup', id: 'cal-setup' }, el('h2', {}, icon('calendar'), 'Show your calendar here'),
    el('p', {}, APP_NAME + ' reads your Google Calendar from its secret address in iCal format, the same one the Standup lists your meetings from, so you paste it once.'),
    el('ol', {},
      el('li', {}, 'Open Google Calendar on the web, then Settings (the gear, top right).'),
      el('li', {}, 'Under Settings for my calendars, pick your own calendar, then Integrate calendar.'),
      el('li', {}, 'Copy Secret address in iCal format. It ends in basic.ics.'),
      el('li', {}, 'Paste it in Settings, under Standup, Calendar address, and press Save.')),
    el('p', { class: 'hint' }, 'Treat it like a password: anyone with it can read your calendar. It stays in a settings file only you can read, and this page never sees it.'),
    el('div', { class: 'actions' }, button('Paste it in Settings', 'settings', calToAddress, true)));
}

function calToAddress() {
  reach({ find: () => byId('standup-address'), reveal: () => goView('settings'), missing: 'Settings has no Calendar address yet' }, focusControl);
}

function calShownDays(box, layout, data) {
  if (layout === 'day') return [data.from];
  const days = calDays(data.from, data.to);
  return layout === 'week' && !box.weekend ? days.filter((day) => workDaysHere().includes(calWeekday(day))) : days;
}

function calBar(box, layout, data) {
  const days = calShownDays(box, layout, data);
  const declined = data.events.filter((e) => e.response === 'declined' && e.lastDay >= days[0] && e.firstDay <= days.at(-1)).length;
  return el('div', { class: 'cal-bar' },
    el('div', { class: 'cal-step' },
      el('button', { class: 'icon-only', id: 'cal-back', title: calStepWord(layout, -1), 'aria-label': calStepWord(layout, -1), onclick: () => calStep(layout, -1) }, icon('chevron-left')),
      el('button', { id: 'cal-today', disabled: !box.cursor || box.cursor === todayHere(), onclick: () => calGo(null) }, 'Today'),
      el('button', { class: 'icon-only', id: 'cal-next', title: calStepWord(layout, 1), 'aria-label': calStepWord(layout, 1), onclick: () => calStep(layout, 1) }, icon('chevron')),
      el('h2', { class: 'cal-label' }, calLabel(layout, data))),
    el('div', { class: 'cal-toggles' },
      layout === 'week' ? calToggle('cal-weekend', 'Weekend', box.weekend, () => calFlip('weekend')) : null,
      calToggle('cal-declined', 'Declined' + (declined ? ' (' + declined + ')' : ''), box.declined, () => calFlip('declined'))));
}

function calToggle(id, label, on, onclick) {
  return el('button', { id, type: 'button', class: 'chip-toggle', 'aria-pressed': String(on), title: (on ? 'Hide ' : 'Show ') + label.toLowerCase().replace(/ \(\d+\)$/, ''), onclick }, icon(on ? 'eye' : 'eyeoff'), label);
}

function calFlip(name) {
  const box = calBox();
  box[name] = !box[name];
  calKeep(box);
  render(true);
}

const calStepWord = (layout, step) => (step < 0 ? 'Back a ' : 'Forward a ') + (layout === 'day' ? 'day' : 'week');

function calStep(layout, step) {
  calGo(calAddDays(calBox().cursor ?? todayHere(), step * (layout === 'day' ? 1 : 7)));
}

function calGo(day) {
  calBox().cursor = day === todayHere() ? null : day;
  render(true);
}

function calLabel(layout, data) {
  if (layout === 'day') return calDayName(data.from);
  const days = calShownDays(calBox(), layout, data);
  const [first, last] = [days[0], days.at(-1)];
  const month = (day) => dayText(day, { month: 'long' });
  const date = (day) => Number(day.slice(8));
  const start = date(first) + (month(first) === month(last) ? '' : ' ' + month(first));
  return start + ' to ' + date(last) + ' ' + month(last) + ' ' + last.slice(0, 4);
}

function calBody(box, layout, data, d) {
  const events = data.events.filter((e) => box.declined || e.response !== 'declined');
  const refs = calRefs(d);
  return layout === 'agenda' ? calAgenda(data, events, refs) : calGrid(calShownDays(box, layout, data), events, refs);
}

// Only the Jira projects the open MRs and tickets use count as tickets, as in the MR drawer.
function calRefs(d) {
  const rows = d?.rows ?? state.matrix?.inbox?.rows ?? [];
  const queue = d?.m?.queue ?? state.matrix?.queue ?? [];
  const tickets = ui.tickets?.data?.tickets ?? [];
  return {
    here: '',
    mrs: new Set([...rows.map((r) => r.key), ...queue.map((q) => q.key)]),
    projects: new Set([...ownProjects(), ...[...rows.map((r) => r.ticket), ...tickets.map((t) => t.key)].filter(Boolean).map((key) => key.split('-')[0])]),
  };
}

function calTitle(title, refs) {
  return slot('withRefs', title, refs) ?? title;
}

function calGrid(days, events, refs) {
  const today = todayHere();
  const columns = days.map((day) => ({ day, segs: calSegments(day, events.filter((e) => !e.allDay)) }));
  const [first, last] = calHours(columns, today);
  const allDay = days.map((day) => events.filter((e) => e.allDay && e.firstDay <= day && e.lastDay >= day));
  return el('div', { class: 'cal-grid', style: '--days:' + days.length + ';--hours:' + (last - first) },
    el('div', { class: 'cal-corner' }),
    days.map((day) => el('div', { class: 'cal-head' + (day === today ? ' today' : ''), 'data-day': day }, calDayName(day, true))),
    allDay.some((list) => list.length) ? [el('div', { class: 'cal-gutter cal-allday-label' }, 'All day'), allDay.map((list, n) => el('div', { class: 'cal-allday' }, list.map((e) => calChip(e, days[n], refs))))] : null,
    el('div', { class: 'cal-gutter cal-hours' }, Array.from({ length: last - first }, (_, n) => el('span', { class: 'cal-hour' }, hourText(first + n)))),
    columns.map(({ day, segs }) => calColumn(day, segs, first, day === today, refs)));
}

// Placed by the wall clock where you are, so no day boundary is ever worked out in milliseconds.
function calSegments(day, timed) {
  return timed.map((e) => ({ e, starts: wallOf(e.start), ends: wallOf(e.end) }))
    .filter(({ e, starts }) => starts.day <= day && wallOf(e.end - 1).day >= day)
    .map(({ e, starts, ends }) => ({ e, from: starts.day < day ? 0 : starts.minutes, to: ends.day > day ? 1440 : ends.minutes }));
}

function calWorkingHours() {
  const [from, to] = [pageLocale().hours?.from ?? '08:00', pageLocale().hours?.to ?? '18:00'].map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)));
  return from < to ? [from, to] : [0, 1440];
}

function calHours(columns, today) {
  const segs = columns.flatMap((c) => c.segs);
  const now = columns.some((c) => c.day === today) ? [wallOf(Date.now()).minutes] : [];
  const [from, to] = calWorkingHours();
  const earliest = Math.min(from, ...segs.map((s) => s.from), ...now);
  const latest = Math.max(to, ...segs.map((s) => s.to), ...now.map((m) => m + 30));
  return [Math.floor(earliest / 60), Math.min(24, Math.ceil(latest / 60))];
}

function calPlace(segs) {
  const minutes = (CAL_MIN_PX / CAL_HOUR_PX) * 60;
  const sorted = [...segs].sort((a, b) => a.from - b.from || b.to - a.to);
  const clusters = [];
  let lanes = [];
  let until = -1;
  sorted.forEach((seg, order) => {
    if (seg.from >= until) {
      clusters.push([]);
      lanes = [];
    }
    const shown = Math.max(seg.to, seg.from + minutes);
    let lane = lanes.findIndex((end) => end <= seg.from);
    if (lane < 0) lane = lanes.push(0) - 1;
    lanes[lane] = shown;
    until = Math.max(until, shown);
    clusters.at(-1).push({ ...seg, shown, lane, order });
  });
  return clusters.flatMap(calSpread);
}

function calSpread(cluster) {
  const lanes = Math.max(...cluster.map((p) => p.lane)) + 1;
  return cluster.map((p) => ({ ...p, lanes, span: calSpan(p, cluster, lanes) }));
}

// A meeting widens over the lanes to its right while nothing there starts in its first half hour, so a later one only overlaps its tail.
function calSpan(p, cluster, lanes) {
  let span = 1;
  const covers = (q) => q.lane === p.lane + span && q.from < p.from + CAL_TOP_MINUTES && q.shown > p.from;
  while (p.lane + span < lanes && !cluster.some(covers)) span += 1;
  return span;
}

function calColumn(day, segs, first, today, refs) {
  return el('div', { class: 'cal-col' + (today ? ' today' : ''), 'data-day': day },
    calPlace(segs).map((p) => calBlock(p, day, first, refs)),
    today ? calNowLine(first) : null);
}

const calTop = (minutes, first) => ((minutes - first * 60) / 60) * CAL_HOUR_PX;

function calNowLine(first) {
  return el('div', { class: 'cal-now', style: 'top:' + calTop(wallOf(Date.now()).minutes, first).toFixed(1) + 'px', 'aria-hidden': 'true' });
}

function calBlock(p, day, first, refs) {
  const { e } = p;
  const height = Math.max(CAL_MIN_PX, ((p.to - p.from) / 60) * CAL_HOUR_PX - 2);
  const style = 'top:' + calTop(p.from, first).toFixed(1) + 'px;height:' + height.toFixed(1) + 'px;left:calc(' + p.lane + ' * 100% / ' + p.lanes + ' + 2px);width:calc(' + p.span + ' * 100% / ' + p.lanes + ' - 4px);z-index:' + (p.order + 1);
  const title = el('span', { class: 'cal-title' }, calTitle(e.title, refs));
  const join = e.join ? calJoin(e, true) : null;
  if (height < CAL_SHORT_PX) return el('div', { class: 'cal-event short ' + calTone(e), 'data-id': e.id, style }, calHit(e, day), title, el('span', { class: 'cal-when' }, timeText(e.start)), join);
  return el('div', { class: 'cal-event ' + calTone(e), 'data-id': e.id, style },
    calHit(e, day),
    el('div', { class: 'cal-top' }, title, join),
    el('span', { class: 'cal-when' }, timeText(e.start) + ' to ' + timeText(e.end) + (e.others.length ? ' · ' + calNames(e.others) : '')));
}

function calChip(e, day, refs) {
  return el('div', { class: 'cal-event cal-allday-event ' + calTone(e), 'data-id': e.id },
    calHit(e, 'all-' + day), el('span', { class: 'cal-title' }, calTitle(e.title, refs)));
}

const calTone = (e) => 'r-' + (e.response ?? 'own');

// The hit area is a sibling under the title, so the title's ticket and MR buttons stay buttons of their own.
function calHit(e, place) {
  return el('button', { type: 'button', id: 'cal-hit-' + place + '-' + e.id, class: 'cal-hit', 'data-primary': '', 'aria-label': calAria(e), onclick: (ev) => calOpen(e, ev.currentTarget) });
}

function calAria(e) {
  const answer = CAL_RESPONSES[e.response]?.[2];
  return ['Details of ' + e.title, calRange(e), answer, e.others.length ? 'with ' + calNames(e.others) : null].filter(Boolean).join(', ');
}

function calRange(e, day) {
  if (e.allDay) return e.firstDay === e.lastDay ? 'all day' : 'all day, ' + calDayName(e.firstDay, true) + ' to ' + calDayName(e.lastDay, true);
  const ends = wallOf(e.end - 1).day;
  const startDay = wallOf(e.start).day;
  const start = (day && day !== startDay ? calDayName(startDay, true) + ' ' : '') + timeText(e.start);
  return start + ' to ' + (ends !== (day ?? startDay) ? calDayName(ends, true) + ' ' : '') + timeText(e.end);
}

function calNames(names) {
  if (names.length <= 2) return names.join(' and ');
  return names.slice(0, 2).join(', ') + ' +' + (names.length - 2);
}

function calJoin(e, compact) {
  const where = CAL_KINDS[e.join.kind] ?? CAL_KINDS.other;
  return el('button', { type: 'button', class: 'cal-join' + (compact ? ' compact' : ' primary'), title: 'Join on ' + where + ': opens ' + e.join.url + ' in your browser', onclick: () => openOutside(e.join.url) },
    icon('video'), el('span', { class: 'cal-join-word' }, compact ? 'Join' : 'Join on ' + where));
}

function calAgenda(data, events, refs) {
  const today = todayHere();
  const days = calDays(data.from, data.to).map((day) => ({ day, list: events.filter((e) => e.firstDay <= day && e.lastDay >= day) }));
  const shown = days.filter(({ day, list }) => list.length || day === today);
  if (!shown.length) return empty('Nothing in your calendar for these days.');
  return el('div', { class: 'cal-agenda' }, shown.map(({ day, list }) => el('section', { class: 'section cal-agenda-day' + (day === today ? ' today' : ''), 'data-day': day },
    el('h2', {}, calDayName(day), day === today ? el('span', { class: 'pill s-accent' }, 'Today') : null),
    list.length ? el('div', { class: 'list' }, list.map((e) => calItem(e, day, refs))) : empty('Nothing else today.'))));
}

function calItem(e, day, refs) {
  const answer = CAL_RESPONSES[e.response];
  return el('div', { class: 'row cal-item ' + calTone(e), 'data-id': e.id },
    calHit(e, 'agenda-' + day),
    el('div', { class: 'cal-item-when' }, e.allDay ? 'All day' : calRange(e, day)),
    el('div', { class: 'cal-item-main' },
      el('div', { class: 'row-head' }, el('span', { class: 'title cal-title' }, calTitle(e.title, refs)), answer && e.response !== 'accepted' ? el('span', { class: 'pill ' + answer[1] }, answer[0]) : null),
      e.others.length || calWhere(e) ? el('div', { class: 'meta' }, [e.others.length ? 'with ' + calNames(e.others) : null, calWhere(e)].filter(Boolean).join(' · ')) : null),
    e.join ? el('div', { class: 'actions' }, calJoin(e, false)) : null);
}

const calWhere = (e) => (e.location && !(e.join && e.location.trim() === e.join.url) ? e.location : null);

function calOpen(e, from) {
  calBox().open = e;
  calFloat.back = (from ?? document.activeElement)?.id || null;
  calFloat.mark = '';
  render(true);
  const host = byId('cal-event');
  if (!host) return;
  floatFront(host);
  host.focus({ preventScroll: true });
}

function calendarEventShown() {
  return Boolean(calBox().open);
}

function calendarClose() {
  calBox().open = null;
  render(true);
  (byId(calFloat.back) ?? byId('main'))?.focus({ preventScroll: true });
}

function calOpenEvent() {
  const box = calBox();
  if (!box.open) return null;
  const fresh = box.data?.events.find((e) => e.id === box.open.id);
  if (fresh) box.open = fresh;
  return box.open;
}

function calEventHost() {
  const found = byId('cal-event');
  if (found) return found;
  const host = el('section', { id: 'cal-event', class: 'cal-float float', role: 'dialog', 'aria-label': 'Meeting', tabindex: '-1', hidden: true },
    el('header', { class: 'cal-float-head', onpointerdown: (e) => calDrag(e, 'move') },
      el('h2', { class: 'cal-float-title' }),
      el('button', { type: 'button', class: 'icon-only', id: 'cal-event-close', title: 'Close (Esc)', 'aria-label': 'Close the meeting', onclick: calendarClose }, icon('x'))),
    el('div', { class: 'cal-float-body' }),
    el('div', { class: 'float-grip', 'aria-hidden': 'true', onpointerdown: (e) => calDrag(e, 'size') }));
  floatFrontOnUse(host);
  document.body.append(host);
  calFloat.place = floatLoad(CAL_EVENT_STORE);
  return host;
}

function calDrag(e, how) {
  const host = calEventHost();
  floatDrag(e, how, host, (rect, done) => {
    calFloat.place = { ...calFloat.place, ...rect };
    if (done) floatSave(CAL_EVENT_STORE, calFloat.place);
    else floatFit(host, calFloat.place, { min: CAL_EVENT_MIN, size: CAL_EVENT_SIZE });
  });
}

function renderCalendarEvent() {
  const e = calOpenEvent();
  const host = e ? calEventHost() : byId('cal-event');
  if (!host) return;
  host.hidden = !e;
  if (!e) return;
  floatFit(host, calFloat.place, { min: CAL_EVENT_MIN, size: CAL_EVENT_SIZE });
  const refs = calRefs(null);
  const mark = JSON.stringify([e, [...refs.mrs], [...refs.projects]]);
  if (mark === calFloat.mark) return;
  calFloat.mark = mark;
  host.setAttribute('aria-label', e.title);
  host.querySelector('.cal-float-title').replaceChildren(...[calTitle(e.title, refs)].flat());
  host.querySelector('.cal-float-body').replaceChildren(...calDetail(e, refs));
}

function calDetail(e, refs) {
  const answer = CAL_RESPONSES[e.response];
  return [
    el('p', { class: 'cal-detail-when' }, icon('clock'), calDayName(e.firstDay) + ', ' + calRange(e) + calLength(e)),
    el('div', { class: 'row-head' }, answer ? el('span', { class: 'pill ' + answer[1] }, answer[2]) : el('span', { class: 'pill s-quiet' }, 'Your own event'),
      e.organiser && !e.attendees.find((a) => a.organiser)?.self ? el('span', { class: 'cal-plain' }, 'Organised by ' + e.organiser.name) : null),
    e.join ? el('div', { class: 'cal-detail-join' }, calJoin(e, false), el('span', { class: 'meta' }, e.join.url)) : null,
    calWhere(e) ? calFact('map-pin', 'Where', calText(calWhere(e), refs)) : null,
    e.attendees.length ? calFact('users', 'Who (' + e.attendees.length + ')', calPeople(e.attendees)) : null,
    e.description ? calFact('file-text', 'Description', calText(e.description, refs)) : null,
    el('p', { class: 'hint' }, 'Read only: answer the invite or change it in Google Calendar.'),
  ].filter(Boolean);
}

function calLength(e) {
  if (e.allDay) return '';
  const minutes = Math.round((e.end - e.start) / 60_000);
  const hours = Math.floor(minutes / 60);
  return ' (' + [hours ? hours + ' h' : null, minutes % 60 ? (minutes % 60) + ' min' : null].filter(Boolean).join(' ') + ')';
}

function calFact(iconName, label, body) {
  return el('section', { class: 'cal-fact' }, el('h3', {}, icon(iconName), label), body);
}

function calPeople(attendees) {
  return el('ul', { class: 'cal-people' }, attendees.map((a) => {
    const answer = CAL_RESPONSES[a.response] ?? CAL_RESPONSES['needs-action'];
    return el('li', { class: 'r-' + a.response },
      el('span', { class: 'cal-person' }, el('b', {}, a.name), el('span', { class: 'cal-plain' }, [a.self ? ' (you)' : '', a.organiser ? ', organiser' : '', a.optional ? ', optional' : ''].join('').replace(/^, /, ' '))),
      el('span', { class: 'meta cal-email' }, a.email),
      el('span', { class: 'pill ' + answer[1] }, answer[0]));
  }));
}

// Calendar text is never markup: a link becomes a button that leaves the page only when asked, and the rest stays text.
function calText(text, refs) {
  const parts = [];
  let at = 0;
  for (const m of text.matchAll(CAL_URL)) {
    parts.push(calTitle(text.slice(at, m.index), refs), slot('linkRef', m[0], m[0], refs) ?? mdLink(m[0]));
    at = m.index + m[0].length;
  }
  parts.push(calTitle(text.slice(at), refs));
  return el('p', { class: 'cal-text' }, parts.flat().filter((part) => part !== ''));
}

function calNow() {
  const c = state?.calendar;
  if (!c?.set) return null;
  const now = Date.now();
  return { current: (c.current ?? []).filter((e) => e.start <= now && now < e.end), next: c.next && c.next.start > now ? c.next : null, error: c.error };
}

function calendarChip() {
  const c = calNow();
  if (!c) return '';
  const now = Date.now();
  if (c.current.some((e) => now - e.start < CAL_JUST_STARTED_MS)) return 'now';
  if (!c.next || c.next.start - now > CAL_CHIP_MS) return '';
  return 'in ' + Math.max(1, Math.ceil((c.next.start - now) / 60_000)) + 'm';
}

function calSoon(e) {
  const now = Date.now();
  if (e.start <= now) return 'now, until ' + timeText(e.end);
  const minutes = Math.ceil((e.start - now) / 60_000);
  if (minutes < 60) return 'in ' + minutes + ' min';
  const day = wallOf(e.start).day;
  const today = todayHere();
  if (day === today) return 'at ' + timeText(e.start);
  return (day === calAddDays(today, 1) ? 'tomorrow' : calDayName(day, true)) + ' at ' + timeText(e.start);
}

function calendarNextUp() {
  const c = calNow();
  if (!c) return null;
  const shown = [...c.current, c.next].filter(Boolean);
  const refs = calRefs(null);
  return section('Next up',
    c.error && !shown.length ? el('p', { class: 'meta bad' }, 'Could not read your calendar: ' + c.error) : null,
    shown.length ? el('div', { class: 'lines cal-next' }, shown.map((e) => calNextLine(e, refs))) : empty('Nothing else in your calendar.'),
    el('a', { class: 'line-more', ...inPage('#calendar', () => calGo(null)) }, 'Open the calendar'));
}

function calNextLine(e, refs) {
  return el('div', { class: 'cal-next-line ' + calTone(e), 'data-id': e.id },
    el('span', { class: 'pill ' + (e.start <= Date.now() ? 's-working' : 's-accent') }, calSoon(e)),
    el('span', { class: 'line-title cal-title' }, calTitle(e.title, refs)),
    el('span', { class: 'meta' }, timeText(e.start) + ' to ' + timeText(e.end) + (e.others?.length ? ' · ' + calNames(e.others) : '')),
    e.join ? calJoin(e, true) : null);
}

function calJoinable() {
  const c = calNow();
  if (!c) return null;
  const on = c.current.filter((e) => e.join).sort((a, b) => b.start - a.start)[0];
  return on ?? (c.next?.join ? c.next : null);
}

function calendarActions() {
  const join = calJoinable();
  return [
    { id: 'act-calendar', group: 'Actions', label: 'Open the calendar', icon: 'calendar', terms: ['meetings', 'agenda', 'schedule', 'diary'], run: () => goView('calendar', () => calGo(null)) },
    join ? { id: 'act-calendar-join', group: 'Actions', label: 'Join the next meeting', detail: join.title + ' · ' + calSoon(join), icon: 'video', terms: ['meet', 'zoom', 'teams', 'call'], run: () => openOutside(join.join.url) } : null,
  ].filter(Boolean);
}

function calendarSettingsGroup() {
  const box = calBox();
  if (box.settingsAt !== state.generatedAt && !box.settingsLoading) calLoadSettings(box);
  const s = box.settings;
  return el('section', { class: 'section settings-group', id: 'calendar-settings' }, el('h2', {}, 'Calendar'),
    slot('featureSwitch', 'calendar'),
    box.settingsError ? banner('Could not read the calendar settings: ' + box.settingsError, true) : null,
    el('div', { class: 'setting' }, el('label', { for: 'cal-address-go' }, 'Calendar address'),
      el('div', { class: 'control' },
        el('span', { class: 'pill ' + (s?.calendarSet ? 's-done' : 's-quiet') }, s?.calendarSet ? 'Set' : 'Not set'),
        el('button', { id: 'cal-address-go', type: 'button', onclick: calToAddress }, icon('settings'), s?.calendarSet ? 'Change it under Standup' : 'Add it under Standup')),
      el('p', { class: 'hint' }, 'The Calendar reads the one address the Standup uses, so it is set in one place, under Standup.')),
    el('div', { class: 'setting' }, el('label', { for: 'cal-remind' }, 'Banner before a meeting'),
      el('div', { class: 'control' }, el('select', { id: 'cal-remind', disabled: !s || ui.busy.has('calendar-settings'), onchange: (e) => calSaveSettings({ remindMinutes: Number(e.target.value) }) },
        (s?.leads ?? [0, 1, 2, 5, 10, 15]).map((n) => el('option', { value: String(n), selected: n === (s?.remindMinutes ?? 5) }, n ? n + ' min before' : 'Off')))),
      el('p', { class: 'hint' }, 'A desktop banner this long before each meeting you have not declined, once each, with Join. Never for all-day events. Desktop banners, under Notifications, has to be on too.')),
    calOverlaySetting(s));
}

const CAL_OVERLAY_WHICH = { all: 'Every meeting I have not declined', join: 'Only ones with a join link', accepted: 'Only ones I accepted' };

function calOverlaySetting(s) {
  const busy = !s || ui.busy.has('calendar-settings');
  const on = s?.overlay ?? true;
  const lead = (n) => (n < 60 ? n + ' s' : n / 60 + ' min') + ' before';
  return el('div', { class: 'setting' }, el('label', { for: 'cal-overlay' }, 'Full-screen reminder'),
    el('div', { class: 'control' },
      el('button', { id: 'cal-overlay', type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(on), disabled: busy, onclick: () => calSaveSettings({ overlay: !on }) }, el('span', { class: 'knob' }), on ? 'On' : 'Off'),
      el('select', { id: 'cal-overlay-lead', 'aria-label': 'How long before the meeting', disabled: busy || !on, onchange: (e) => calSaveSettings({ overlayLead: Number(e.target.value) }) },
        (s?.overlayLeads ?? [30, 60, 120, 300]).map((n) => el('option', { value: String(n), selected: n === (s?.overlayLead ?? 60) }, lead(n)))),
      el('select', { id: 'cal-overlay-which', 'aria-label': 'Which meetings', disabled: busy || !on, onchange: (e) => calSaveSettings({ overlayWhich: e.target.value }) },
        (s?.overlayWhichOptions ?? Object.keys(CAL_OVERLAY_WHICH)).map((id) => el('option', { value: id, selected: id === (s?.overlayWhich ?? 'all') }, CAL_OVERLAY_WHICH[id] ?? id)))),
    el('p', { class: 'hint' }, s && !s.overlayHere
      ? 'Only the ' + APP_NAME + ' app can cover the screen, so here in Orca the banner above is your reminder. These settings apply once you run the app.'
      : 'Covers every display, full-screen apps included, this long before each meeting picked here, once each: Join (Enter), Snooze or Dismiss (Esc). It keeps its own lead time, so the banner above can come earlier.'));
}

async function calLoadSettings(box) {
  Object.assign(box, { settingsLoading: true, settingsAt: state.generatedAt });
  try {
    box.settings = await api('/api/calendar/settings');
    box.settingsError = null;
  } catch (e) {
    box.settingsError = e.message;
  }
  box.settingsLoading = false;
  render(true);
}

async function calSaveSettings(patch) {
  const answer = await busyAct('/api/calendar/settings', patch, 'calendar-settings');
  if (answer) {
    const { ok, text, ...saved } = answer;
    calBox().settings = saved;
  }
  render(true);
}

function calStart() {
  if (typeof matchMedia !== 'function') return;
  matchMedia(CAL_NARROW).addEventListener?.('change', () => view() === 'calendar' && render(true));
}

calStart();
