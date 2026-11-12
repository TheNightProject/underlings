const MEETING_WINDOW = new URLSearchParams(location.search).get('window') === 'meeting';
const MEETING_TICK_MS = 1000;
const MEETING_FACES = 5;
const MEETING_NAMES = 3;
const MEETING_TONES = ['s-accent', 's-info', 's-done', 's-moved', 's-working'];
const MEETING_ANSWERS = { tentative: ['You said maybe', 's-working'], 'needs-action': ['Not answered yet', 's-info'] };
const meetingBox = { mark: '', acting: false, error: null };

function meetingWindowOnly() {
  return MEETING_WINDOW;
}

function meetingStart() {
  if (!MEETING_WINDOW) return;
  document.body.classList.add('meeting-window');
  document.body.append(el('div', { class: 'mo', id: 'meeting-overlay' },
    el('div', { class: 'mo-veil', 'aria-hidden': 'true' }),
    el('div', { class: 'mo-stage', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Meeting reminder' })));
  document.addEventListener('keydown', meetingKey);
  setInterval(meetingTick, MEETING_TICK_MS);
}

function renderMeeting() {
  if (!MEETING_WINDOW) return;
  const meetings = state?.calendar?.overlay?.meetings ?? [];
  const mark = JSON.stringify([meetings, meetingBox.error]);
  if (mark !== meetingBox.mark) {
    meetingBox.mark = mark;
    const stage = byId('meeting-overlay').querySelector('.mo-stage');
    stage.replaceChildren(...meetingStage(meetings));
    stage.querySelector('[data-primary]')?.focus({ preventScroll: true });
  }
  meetingTick();
}

function meetingStage(meetings) {
  if (!meetings.length) return [];
  const together = meetings.length > 1 && meetings.every((m) => m.start === meetings[0].start);
  return [
    together ? meetingWhen(meetings[0].start) : null,
    el('div', { class: 'mo-cards' + (meetings.length > 1 ? ' several' : '') }, meetings.map((m, n) => meetingCard(m, n, !together))),
    meetingBox.error ? el('p', { class: 'mo-error', role: 'alert' }, meetingBox.error) : null,
    el('div', { class: 'mo-actions' },
      el('button', { type: 'button', id: 'mo-snooze', class: 'mo-quiet', onclick: () => meetingAct('snooze') }, icon('clock'), el('span', { class: 'mo-snooze-word' }, meetingSnoozeWord(meetings))),
      el('button', { type: 'button', id: 'mo-dismiss', class: 'mo-quiet', 'aria-keyshortcuts': 'Escape', onclick: () => meetingAct('dismiss') }, el('span', {}, 'Dismiss'), el('kbd', { 'aria-hidden': 'true' }, 'esc'))),
  ].filter(Boolean);
}

const meetingWhen = (start) => el('p', { class: 'mo-when', 'data-start': String(start) }, meetingCountdown(start, Date.now()));

function meetingCard(m, n, own) {
  const where = meetingWhere(m);
  const answer = MEETING_ANSWERS[m.response];
  return el('section', { class: 'mo-card', 'data-key': m.key, 'aria-labelledby': 'mo-title-' + n },
    own ? meetingWhen(m.start) : null,
    el('h1', { class: 'mo-title', id: 'mo-title-' + n }, m.title),
    el('p', { class: 'mo-facts' },
      el('span', { class: 'mo-fact' }, icon('clock'), timeText(m.start) + ' to ' + timeText(m.end)),
      where ? el('span', { class: 'mo-fact mo-where' }, icon(m.join ? 'video' : 'map-pin'), where) : null,
      answer ? el('span', { class: 'pill mo-answer ' + answer[1] }, answer[0]) : null),
    m.people.length ? meetingPeople(m.people) : null,
    meetingJoin(m));
}

function meetingWhere(m) {
  const call = m.join ? CAL_KINDS[m.join.kind] ?? CAL_KINDS.other : null;
  return [calWhere(m), call].filter(Boolean).join(' · ');
}

function meetingJoin(m) {
  const join = (label, iconName, act) => el('button', { type: 'button', class: 'mo-join', 'data-primary': '', 'aria-keyshortcuts': 'Enter', onclick: () => meetingAct(act, m.key) },
    icon(iconName), el('span', {}, label), el('kbd', { 'aria-hidden': 'true' }, 'return'));
  if (!m.join) return join('Open in the calendar', 'calendar', 'calendar');
  return join('Join on ' + (CAL_KINDS[m.join.kind] ?? CAL_KINDS.other), 'video', 'join');
}

function meetingPeople(names) {
  const shown = names.length > MEETING_FACES ? names.slice(0, MEETING_FACES - 1) : names;
  const more = names.length - shown.length;
  return el('div', { class: 'mo-people' },
    el('span', { class: 'mo-faces', 'aria-hidden': 'true' },
      shown.map((name) => el('span', { class: 'mo-face ' + meetingTone(name), title: name }, meetingInitials(name))),
      more ? el('span', { class: 'mo-face more' }, '+' + more) : null),
    el('span', { class: 'mo-names' }, meetingNames(names)));
}

function meetingInitials(name) {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const first = (word) => [...word][0]?.toUpperCase() ?? '';
  return words.length > 1 ? first(words[0]) + first(words.at(-1)) : first(words[0] ?? '?');
}

function meetingTone(name) {
  let sum = 0;
  for (const c of String(name)) sum = (sum * 31 + c.codePointAt(0)) % 9973;
  return MEETING_TONES[sum % MEETING_TONES.length];
}

function meetingNames(names) {
  const first = names.map((name) => String(name).trim().split(/\s+/)[0]);
  if (first.length === 1) return 'with ' + first[0];
  const shown = first.length > MEETING_NAMES ? [...first.slice(0, MEETING_NAMES - 1), (first.length - MEETING_NAMES + 1) + ' others'] : first;
  return 'with ' + shown.slice(0, -1).join(', ') + ' and ' + shown.at(-1);
}

function meetingCountdown(start, now) {
  const ms = start - now;
  if (ms > 0) {
    const seconds = Math.ceil(ms / 1000);
    return [el('span', {}, 'Starts in'), ' ', el('b', {}, Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'))];
  }
  const minutes = Math.floor(-ms / 60_000);
  return minutes < 1 ? [el('span', {}, 'Starting'), ' ', el('b', {}, 'now')] : [el('span', {}, 'Started'), ' ', el('b', {}, minutes + ' min ago')];
}

function meetingSnoozeWord(meetings) {
  const first = Math.min(...meetings.map((m) => m.start));
  return Date.now() < first ? 'Snooze until ' + timeText(first) : 'Snooze 1 min';
}

function meetingTick() {
  const now = Date.now();
  for (const when of document.querySelectorAll('.mo-when')) {
    when.replaceChildren(...meetingCountdown(Number(when.dataset.start), now));
    when.classList.toggle('started', Number(when.dataset.start) <= now);
  }
  const snooze = document.querySelector('.mo-snooze-word');
  const meetings = state?.calendar?.overlay?.meetings ?? [];
  if (snooze && meetings.length) snooze.textContent = meetingSnoozeWord(meetings);
}

function meetingKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    return meetingAct('dismiss');
  }
  if (e.key !== 'Enter' || e.target?.closest?.('button')) return;
  e.preventDefault();
  document.querySelector('.mo [data-primary]')?.click();
}

// The worker closes this window on every display once it has acted, so only a failure leaves anything here to update.
async function meetingAct(act, key) {
  if (meetingBox.acting || !state?.calendar?.overlay) return;
  meetingBox.acting = true;
  byId('meeting-overlay')?.classList.add('leaving');
  try {
    await api('/api/calendar/overlay', { act, key });
  } catch (e) {
    meetingBox.error = 'That did not work: ' + e.message;
    byId('meeting-overlay')?.classList.remove('leaving');
    renderMeeting();
  } finally {
    meetingBox.acting = false;
  }
}

meetingStart();
