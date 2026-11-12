const LEVELS = [[null, 'Off'], ['shadow', 'Shadow'], ['comments', 'Comments'], ['verdict', 'Comments + verdict']];
const PASS_TONES = { reviewing: 's-working', finishing: 's-working', finished: 's-done', failed: 's-need', superseded: 's-quiet', expired: 's-quiet', closed: 's-quiet' };
const RUN_TONES = { launching: 's-working', working: 's-working', idle: 's-info', ended: 's-quiet', 'launch failed': 's-need' };
const BUSY_NOTED_MS = 120_000;
const EDIT_RENEW_MS = 30_000;
const AUTO_LOG_SHOWN = 10;
const RUN_PLACES_MS = 30_000;
const runScreens = new Map();
const runPlaces = { at: 0, loading: false, byKey: {}, error: null };
let editRenewal = null;

function viewFullAuto(d) {
  const m = d.m;
  const q = ui.peopleSearch.trim().replace(/^@/, '').toLowerCase();
  const people = (m.roster || []).filter((p) => !q || p.username.includes(q));
  const typed = /^[a-z0-9][a-z0-9_.-]*$/.test(q) && !(m.roster || []).some((p) => p.username === q) ? q : null;
  return [
    header('Full auto', 'Pick whose MRs get reviewed without you, and how far it goes. Full auto runs here, in ' + APP_NAME + ', whether or not this page is open.',
      m.available ? button(m.paused ? 'Resume full auto' : 'Pause full auto', m.paused ? 'play' : 'pause', () => matrixAct('pause', {}, 'pause'), m.paused) : null),
    matrixBanners(m),
    m.driver ? driverBanner(m) : null,
    section('People',
      el('div', { class: 'filters' },
        searchBox('people-q', 'Find someone, or type a GitLab username to add them', ui.peopleSearch, (v) => { ui.peopleSearch = v; render(true); }),
        typed ? button('Add ' + typed + ' at shadow', 'plus', () => { ui.peopleSearch = ''; matrixAct('level', { username: typed, level: 'shadow' }, 'level:' + typed); }) : null),
      people.length ? el('div', { class: 'tablewrap' }, el('table', {},
        el('thead', {}, el('tr', {}, ['Person', 'Asking you', 'Open', 'Reviewing', 'Level'].map((h) => el('th', {}, h)))),
        el('tbody', {}, slot('onRequestRow', m), people.map((p) => el('tr', {},
          el('td', {}, el('a', { class: 'chip', title: 'Show their merge requests', ...inPage('#merge-requests', () => { scopeMrs('all'); ui.mrPerson = p.username; }) }, p.username)),
          el('td', { class: 'num' }, p.askingYou || ''),
          el('td', { class: 'num' }, p.open || ''),
          el('td', { class: 'num' }, p.reviewing || ''),
          el('td', {}, personLevel(m, p))))))) : empty(q ? 'Nobody matches.' : 'Nobody with an open MR yet.'),
      el('p', { class: 'meta' }, 'Shadow does everything and sends nothing. Comments posts reviews, replies and re-reviews. Comments + verdict also approves or requests changes, behind the gates. The first row reviews any other MR that asks for you, at shadow only, and never a draft, one you approved, your own or a bot\'s.')),
    m.available ? section('Sending soon', sendingSoon(m)) : null,
    m.driver ? section('Activity', activityList(m.driver)) : null,
    m.available ? section('Sent without you', sentWithoutYou(m)) : null,
    section('Latest pass per MR', passTable(d)),
    m.driver?.stateDir ? el('p', { class: 'meta' }, 'Shared state in ' + homeShort(m.driver.stateDir)) : null,
  ];
}

// With the default row on, a person with no row of their own follows it, and Off on their row means never.
function personLevel(m, p) {
  const byDefault = m.onRequest?.level;
  const never = (m.onRequest?.optedOut ?? []).includes(p.username);
  const set = (level) => matrixAct('level', { username: p.username, level: level === null && byDefault ? 'off' : level }, 'level:' + p.username);
  const current = p.level ?? (byDefault && !never ? 'default' : null);
  const options = byDefault ? [['default', 'Default (' + byDefault + ')'], ...LEVELS] : LEVELS;
  return chips(options, current, (level) => (level === 'default' ? matrixAct('level', { username: p.username, level: null }, 'level:' + p.username) : set(level)));
}

function fullAutoLabel(m) {
  if (!m?.available || !m.driver) return autoLabel('Full auto stopped', 'off', 'The review engine is not loaded' + (m?.error ? ': ' + m.error : '') + '.');
  const base = driverLabel(m.driver, m);
  const notes = [busyNote(m.driver), m.driver.problems ? plural(m.driver.problems, 'problem') : null].filter(Boolean);
  return { ...base, text: [base.text, ...notes].join(', ') };
}

function driverLabel(d, m) {
  const why = d.why ? d.why.charAt(0).toUpperCase() + d.why.slice(1) + '.' : '';
  if (d.state === 'stopped') return autoLabel('Full auto stopped', 'off', why);
  if (d.state !== 'here') return autoLabel('Full auto starting', 'warn', why);
  if (m.paused) return autoLabel('Full auto paused', 'warn', 'Nothing launches, sends or re-reviews on its own until you resume it. Run output is still read.');
  if (!m.fullAuto.length) return autoLabel('Full auto off', 'idle', 'Nobody is in full auto. Auto re-review and run output still run here.');
  return { ...autoLabel('Full auto on', '', autoDoing(d)), text: 'Full auto on for ' + m.fullAuto.length };
}

function autoLabel(brief, tone, title) {
  return { brief, text: brief, tone, title };
}

function busyNote(d) {
  const ms = d.busy ? Date.now() - d.busy.since : 0;
  return ms > BUSY_NOTED_MS ? 'busy ' + Math.round(ms / 60000) + ' min' : null;
}

function autoDoing(d) {
  if (d.busy) return (d.busy.step === 'poll' ? 'Checking the MRs' : 'Sending what is due') + ' since ' + timeText(d.busy.since);
  if (!d.lastPollAt) return 'Waiting for the first check';
  return 'Checked ' + timeText(d.lastPollAt) + (d.nextPollAt ? ', next at ' + timeText(d.nextPollAt) : '');
}

function homeShort(path) {
  return path.replace(/^\/Users\/[^/]+/, '~');
}

function matrixHealth(m) {
  if (!m.available) return el('span', { class: 'off' }, 'Review engine: ' + (m.error || 'not loaded'));
  const label = fullAutoLabel(m);
  return el('a', { class: 'health-link', title: label.title, ...inPage('#full-auto') }, el('span', { class: label.tone || null }, label.text));
}

function driverBanner(m) {
  const d = m.driver;
  if (d.state === 'stopped') return banner('Full auto is stopped: ' + d.why + '.', true, driverFix(d));
  if (d.state !== 'here') return banner('Full auto is starting: ' + d.why + '.');
  return m.fullAuto.length && !m.paused ? banner(`Live for ${m.fullAuto.length} ${m.fullAuto.length === 1 ? 'person' : 'people'}. Anything it queues waits ${m.holdSeconds ?? 120} s in the review queue before it sends, and you can discard it until then.`) : null;
}

function driverFix(d) {
  if (d.fix === 'rebuild') return el('div', { class: 'actions heal' }, slot('rebuildButton'));
  if (d.fix === 'settings') return el('div', { class: 'actions' }, el('a', { class: 'fix-link', ...inPage('#settings') }, icon('settings'), 'Open Settings to set the workspace root'));
  if (d.fix === 'token') return slot('tokenField');
  return null;
}

function activityList(d) {
  if (!d.recent.length) return empty('Nothing yet. Each step full auto takes shows here, newest first, until the worker restarts.');
  return el('ol', { class: 'activity' }, d.recent.map((r) => el('li', { class: r.error ? 'bad' : null },
    el('span', { class: 'meta' }, timeText(r.at, true)),
    el('span', {}, r.text, r.times > 1 ? el('span', { class: 'meta' }, ' · ' + r.times + ' times') : null))));
}

function sendingSoon(m) {
  const due = (m.queue ?? []).filter((q) => q.sendsItself);
  if (!due.length) return empty('Nothing is waiting to send itself.');
  return el('div', { class: 'list' }, due.map((q) => el('div', { class: 'row', 'data-id': q.id },
    el('div', { class: 'row-head' }, autoPill(q, m), mrRef(q.key, short(q.key), 'findings'), el('span', { class: 'text clamp two-lines' }, firstLine(q.body))),
    el('div', { class: 'actions' }, q.sending ? null : guarded('discard:' + q.id, 'Discard', 'trash', 'Discard it before it sends?', () => matrixAct('discard', { id: q.id }, 'discard:' + q.id))))));
}

function sentWithoutYou(m) {
  const c = m.autoCounts ?? { sent: 0, waiting: 0, shadow: 0 };
  const log = m.autoLog ?? [];
  const all = ui.open.has('auto-log');
  const rows = all ? log : log.slice(0, AUTO_LOG_SHOWN);
  return [
    el('div', { class: 'row-head' }, countPill(c.sent, 'sent', 's-done'), countPill(c.waiting, 'handed back', 's-need'), countPill(c.shadow, 'shadow waiting', 's-info')),
    rows.length ? el('div', { class: 'tablewrap' }, el('table', { class: 'sent-log' },
      el('thead', {}, el('tr', {}, ['When', 'Merge request', 'What', 'First line'].map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((r) => el('tr', {},
        el('td', { class: 'meta' }, ago(r.at)),
        el('td', {}, mrRef(r.key, r.mr)),
        el('td', {}, r.what),
        el('td', { class: 'text' }, el('div', { class: 'clamp two-lines' }, firstLine(r.text)))))))) : empty('Nothing has been sent without you yet.'),
    log.length > AUTO_LOG_SHOWN ? el('button', { class: 'linkish', 'aria-expanded': String(all), onclick: () => toggle(ui.open, 'auto-log') }, all ? 'Show fewer' : 'Show all ' + log.length) : null,
  ];
}

function countPill(n, label, tone) {
  return el('span', { class: 'pill ' + (n ? tone : 's-quiet') }, n + ' ' + label);
}

function passTable(d) {
  const passes = d.m.autoPasses.filter((p) => p.state && p.state !== 'none');
  if (!passes.length) return empty('No full-auto passes yet.');
  return el('div', { class: 'tablewrap' }, el('table', { class: 'passes' },
    el('thead', {}, el('tr', {}, ['Merge request', 'Author', 'Trigger', 'Result', 'Handed back', 'When'].map((h) => el('th', {}, h)))),
    el('tbody', {}, passes.map((p) => passRow(p, d)))));
}

function passRow(p, d) {
  const key = 'pass:' + p.key;
  const open = ui.open.has(key);
  return [
    el('tr', {},
      el('td', {}, el('span', { class: 'pass-ref' },
        el('button', { class: 'disclose quiet icon-only', 'aria-expanded': String(open), 'aria-label': (open ? 'Hide' : 'Show') + ' what this pass on ' + short(p.key) + ' queued', onclick: () => toggle(ui.open, key) }, icon('chevron')),
        mrRef(p.key, short(p.key)))),
      el('td', {}, p.author || ''),
      el('td', {}, p.trigger || ''),
      el('td', {}, el('span', { class: 'pill ' + (PASS_TONES[p.state] ?? 's-quiet') }, p.state)),
      el('td', { class: 'num' }, p.handedBack.length || '', p.handedBack.length ? el('span', { class: 'narrow-only' }, ' handed back') : null),
      el('td', { class: 'meta' }, ago(p.doneAt || p.launchedAt))),
    open ? el('tr', { class: 'pass-detail' }, el('td', { colspan: '6' }, passDetail(p, d))) : null,
  ];
}

function passDetail(p, d) {
  const items = d.m.queue.filter((q) => p.id && q.auto?.pass === p.id);
  const row = d.rows.find((r) => r.key === p.key);
  return [
    items.length ? el('div', { class: 'list' }, items.map((q) => slot('queueItem', q, Boolean(row), 'pass-'))) : empty('Nothing this pass queued is in the queue now.'),
    p.handedBack.length ? slot('handedBackThreads', p.key, row) : null,
  ];
}

function autoPill(q, m) {
  if (!q.auto) return null;
  const [tone, text] = autoPillText(q, m ?? {});
  return el('span', { class: 'pill ' + tone }, icon('zap'), text);
}

function autoPillText(q, m) {
  const a = q.auto;
  if (q.status === 'posted') return ['s-done', a.sentAuto ? 'sent without you' : 'auto, posted by hand'];
  if (q.status === 'discarded') return ['s-quiet', a.superseded ? 'dropped: ' + a.superseded : 'auto, discarded'];
  if (q.status === 'expired') return ['s-quiet', 'not posted: ' + (q.expiredReason || 'MR closed')];
  if (a.held) return ['s-need', 'auto, handed back'];
  if (a.level === 'shadow') return ['s-quiet', 'shadow, never sends'];
  if (q.sending) return ['s-working', 'auto, sending now'];
  if (q.editing && Date.parse(q.editing.until) > Date.now()) return ['s-working', 'auto, being edited'];
  if (m.paused) return ['s-working', 'auto, paused'];
  if (m.driver?.state === 'stopped') return ['s-need', 'auto, waits: full auto stopped'];
  if (q.kind === 'verdict' && waitsForItsComments(q, m.queue ?? [])) return ['s-info', 'auto, after its comments'];
  return ['s-info', Date.parse(a.sendAt) > Date.now() ? 'auto, sends ' + until(a.sendAt) : 'auto, sending now'];
}

// The engine sends a pass's verdict only once everything else it queued has gone.
function waitsForItsComments(q, queue) {
  return queue.some((o) => o.id !== q.id && o.kind !== 'verdict' && o.status === 'pending' && o.auto?.pass === q.auto.pass && !o.auto.held && o.auto.level !== 'shadow');
}

// Whichever process drives leaves a marked item alone; the mark lapses 90 s after the last renewal, so a closed tab frees it.
function markEditing(id, on) {
  if (!on) api('/api/matrix/editing', { id, editing: false }).catch(() => {});
  else {
    holdForEditing(id);
    renewEditMarks();
  }
}

// Refused while a send has it, since what was claimed goes out whatever the editor says.
function holdForEditing(id) {
  api('/api/matrix/editing', { id, editing: true }).catch((e) => {
    if (e.status !== 409 || !ui.editing.has(id)) return;
    ui.editing.delete(id);
    toast(e.message, true);
    render(true);
  });
}

function renewEditMarks() {
  if (editRenewal) return;
  editRenewal = setTimeout(() => {
    editRenewal = null;
    if (!ui.editing.size) return;
    for (const id of ui.editing.keys()) holdForEditing(id);
    renewEditMarks();
  }, EDIT_RENEW_MS);
}

function viewRuns(d) {
  const places = d.m.available && d.m.runs.length ? runWorkspaces() : {};
  return [
    header('Review runs', 'The latest review, fix or ticket agent on each MR or ticket, newest first, with what it last said.'),
    d.m.available ? null : slot('engineBanner', d.m),
    runPlaces.error ? banner('Could not check the review workspaces: ' + runPlaces.error, true) : null,
    d.m.runs.length ? el('div', { class: 'list' }, d.m.runs.map((r) => runRow(r, d, places[r.key]))) : empty('No review runs recorded.'),
  ];
}

// Clean-up's own verdict on each run's workspace, asked for again once it is a refresh old.
function runWorkspaces() {
  if (!runPlaces.loading && Date.now() - runPlaces.at > RUN_PLACES_MS) loadRunWorkspaces();
  return runPlaces.byKey;
}

async function loadRunWorkspaces() {
  runPlaces.loading = true;
  runPlaces.at = Date.now();
  try {
    runPlaces.byKey = await api('/api/matrix/run-workspaces');
    runPlaces.error = null;
  } catch (e) {
    runPlaces.error = e.message;
  } finally {
    runPlaces.loading = false;
  }
  render(true);
}

function runRow(r, d, place) {
  const agent = r.live ? d.agents.find((a) => a.handle && a.handle === r.terminal) : null;
  const subject = runSubject(r.key);
  return el('div', { class: 'row run' },
    el('div', { class: 'row-head' },
      el('span', { class: 'pill ' + (RUN_TONES[r.status] ?? 's-quiet') }, r.status),
      subject.mr ? mrRef(subject.mr, subject.fix ? 'fix ' + subject.mr : subject.mr, subject.fix ? 'agent' : undefined) : ticketRef(ticketOf(r.key)),
      el('span', { class: 'meta' }, ['started ' + ago(r.startedAt), r.endedAt ? 'ended ' + ago(r.endedAt) : null].filter(Boolean).join(' · '))),
    r.worktreePath ? el('div', { class: 'meta' }, homeShort(r.worktreePath)) : null,
    agent ? slot('agentConsole', agent) : lastScreen(r),
    runActions(r, d, subject, place));
}

function runSubject(key) {
  const fix = key.startsWith('fix:');
  const mr = fix ? key.slice('fix:'.length) : key;
  return isKey(mr) ? { mr, fix } : { mr: null, fix: false };
}

function ticketOf(key) {
  return key.replace(/^ticket:/, '');
}

function lastScreen(r) {
  const key = 'run:' + r.key;
  const open = ui.open.has(key);
  const seen = r.startedAt + '|' + (r.endedAt ?? '') + '|' + r.tail.length;
  const whole = runScreens.get(r.key);
  if (open && whole?.seen !== seen) loadRunScreen(r.key, seen);
  const tail = whole?.tail ?? r.tail;
  if (!tail.length && !open) return null;
  return el('div', { class: 'screen' },
    el('button', { class: 'disclose quiet', 'aria-expanded': String(open), title: open ? 'Hide what it last said' : 'Show what was last captured from the agent', onclick: () => toggle(ui.open, key) }, icon('chevron'), icon('terminal'), 'Last words'),
    open ? [
      whole?.error ? banner('Could not read the run: ' + whole.error, true) : null,
      el('pre', { class: 'console', tabindex: '0', 'aria-label': 'What was last captured from the review of ' + r.key }, tail.length ? tail.join('\n') : 'Nothing was captured from the agent.'),
    ] : null);
}

async function loadRunScreen(key, seen) {
  const was = runScreens.get(key);
  runScreens.set(key, { ...was, seen });
  try {
    const run = await api('/api/matrix/run?' + new URLSearchParams({ key }));
    runScreens.set(key, { seen, tail: run.tail, error: null });
  } catch (e) {
    runScreens.set(key, { seen, tail: was?.tail ?? null, error: e.message });
  }
  render(true);
}

function runActions(r, d, subject, place) {
  const row = subject.mr && !subject.fix ? d.rows.find((x) => x.key === r.key) : null;
  const target = subject.mr ? refNumber(subject.mr) : ticketOf(r.key);
  const shown = [
    row && !row.agent && !row.agentStarting ? guarded('run-retry:' + r.key, 'Retry', 'rotate-ccw', 'Retry the review of ' + target + '?', () => matrixAct('review', { key: r.key }, 'run-retry:' + r.key)) : null,
    place?.removable ? runRemoveButton(place) : null,
  ].filter(Boolean);
  return [
    shown.length ? el('div', { class: 'actions' }, shown) : null,
    place && !place.removable ? el('div', { class: 'meta' }, place.name + ' stays: ' + place.blocker) : null,
  ];
}

function runRemoveButton(place) {
  const id = 'run-rm:' + place.id;
  return guarded(id, 'Remove workspace', 'trash', 'Remove ' + place.name + '?', () => busyAct('/api/agents/cleanup', { remove: [place.id], close: [] }, id).finally(() => { runPlaces.at = 0; }));
}
