const ZONE = 'Europe/London';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ME = { name: 'Frank Foster', email: 'frank.foster@example.com' };
const PEOPLE = {
  wendy: { name: 'Wendy West', email: 'wendy.west@example.org' }, walter: { name: 'Walter Wells', email: 'walter.wells@example.com' }, sybil: { name: 'Sybil Shaw', email: 'sybil.shaw@example.com' },
  felix: { name: 'Felix Fox', email: 'felix.fox@example.com' }, ivan: { name: 'Ivan Irving', email: 'ivan.irving@example.com' }, victor: { name: 'Victor Vale', email: 'victor.vale@example.com' },
};

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const fold = (line) => line.match(/.{1,70}/g).join('\r\n ');

const londonDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(ms);

function londonAt(day, clock) {
  const [h, m] = clock.split(':').map(Number);
  const guess = Date.parse(`${day}T${clock}:00Z`);
  const shown = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(guess).split(':').map(Number);
  return guess - ((shown[0] - h) * 60 + (shown[1] - m)) * MINUTE;
}

function mondayOf(now) {
  const day = londonDay(now);
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return new Date(Date.parse(`${day}T12:00:00Z`) - ((weekday + 6) % 7) * DAY).toISOString().slice(0, 10);
}

const dayAfter = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

function event({ uid, title, start, end, response = 'ACCEPTED', who = [], meet, where, rule }) {
  const people = [['ME', ME, response], ...who.map((key) => [key, PEOPLE[key], 'ACCEPTED'])];
  return [
    'BEGIN:VEVENT',
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(end)}`,
    ...(rule ? [`RRULE:${rule}`] : []),
    `DTSTAMP:${stamp(start - DAY)}`,
    `UID:${uid}@example.com`,
    `ORGANIZER;CN=${(PEOPLE[who[0]] ?? ME).name}:mailto:${(PEOPLE[who[0]] ?? ME).email}`,
    ...people.map(([, p, answer]) => fold(`ATTENDEE;CUTYPE=INDIVIDUAL;PARTSTAT=${answer};CN=${p.name}:mailto:${p.email}`)),
    ...(meet ? [`X-GOOGLE-CONFERENCE:${meet}`] : []),
    ...(where ? [`LOCATION:${where}`] : []),
    `SUMMARY:${title}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
  ];
}

export function demoCalendar(now = Date.now(), soonSeconds = 75) {
  const monday = mondayOf(now);
  const at = (n, from, to) => [londonAt(dayAfter(monday, n), from), londonAt(dayAfter(monday, n), to)];
  const soon = now + soonSeconds * 1000;
  const events = [
    event({ uid: 'standup', title: 'Team standup', start: at(0, '09:30', '09:45')[0], end: at(0, '09:30', '09:45')[1], who: ['wendy', 'ivan', 'felix'], meet: 'https://meet.google.com/abc-defg-hij', rule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }),
    event({ uid: 'planning', title: 'Sprint planning', start: at(0, '10:30', '12:00')[0], end: at(0, '10:30', '12:00')[1], who: ['wendy', 'walter', 'ivan'], meet: 'https://meet.google.com/pln-nngg-sprt' }),
    event({ uid: 'oneone', title: '1:1 with Wendy', start: at(2, '11:00', '11:30')[0], end: at(2, '11:00', '11:30')[1], who: ['wendy'], meet: 'https://meet.google.com/one-onon-ewen' }),
    event({ uid: 'arch', title: 'Architecture discussion: ABC-4412', start: at(1, '14:00', '15:30')[0], end: at(1, '14:00', '15:30')[1], response: 'TENTATIVE', who: ['walter', 'sybil'], where: 'https://example.zoom.us/j/84512345678' }),
    event({ uid: 'roadmap', title: 'Roadmap review', start: at(3, '14:00', '15:00')[0], end: at(3, '14:00', '15:00')[1], who: ['walter', 'victor', 'wendy'], meet: 'https://meet.google.com/rdm-apre-view' }),
    event({ uid: 'learn', title: 'Lunch and learn', start: at(4, '12:30', '13:30')[0], end: at(4, '12:30', '13:30')[1], who: ['felix'], where: 'The long table' }),
    event({ uid: 'panel', title: 'Hiring panel', start: at(4, '15:00', '16:00')[0], end: at(4, '15:00', '16:00')[1], response: 'NEEDS-ACTION', who: ['wendy', 'victor'], meet: 'https://meet.google.com/hir-ingp-anel' }),
    event({ uid: 'design', title: 'Design review: agents office', start: soon, end: soon + 45 * MINUTE, who: ['wendy', 'felix', 'sybil', 'ivan', 'walter'], meet: 'https://meet.google.com/dsg-rvw-ofce' }),
  ].flat();
  return ['BEGIN:VCALENDAR', 'PRODID:-//Example//Calendar//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${ME.email}`, `X-WR-TIMEZONE:${ZONE}`, ...events, 'END:VCALENDAR', ''].join('\r\n');
}

export const CALENDAR_ADDRESS = 'https://calendar.example.com/ical/frank.foster%40example.com/private-00000000demo0000/basic.ics';
export const CALENDAR_ZONE = ZONE;
