const INTRO_SEEN_KEY = 'cc-intro-at';
const INTRO_PREF_KEY = 'cc-intro';
const INTRO_AGAIN_MS = 10 * 60 * 1000;
const INTRO_CAP_MS = 15000;
const INTRO_REDUCED_MS = 250;
const INTRO_TICKETS_POLL_MS = 1000;
// The choreography is written in its own time; the painter is handed real time divided by this.
const INTRO_PACE = 1.8;
const INTRO_AT = { collapse: 930, gather: 420, tile: 1040, nodes: 1330, stem: 1380, curve: 1430, ring: 1460, lock: 1860, mark: 1880, fly: 420 };
const INTRO_CLOUD_MS = INTRO_AT.collapse * INTRO_PACE;
const INTRO_STORY_MS = (INTRO_AT.mark - INTRO_AT.collapse) * INTRO_PACE;
const INTRO_FLY_MS = INTRO_AT.fly * INTRO_PACE;
const INTRO_GATHER_BY_MS = INTRO_CAP_MS - INTRO_STORY_MS - INTRO_FLY_MS;
const INTRO_LIGHT_GAP_MS = 300;
const INTRO_LINGER_MS = 700;
const INTRO_LIST_MS = 600;
const INTRO_LABEL_MOVE_PX = 4;
const INTRO_STEPS = [['engine', 'Engine', '--viz-3'], ['gitlab', 'GitLab', '--viz-2'], ['jira', 'Jira', '--viz-4'], ['needs', 'Needs you', '--viz-5']];
const INTRO_SIGNS = { done: '✓', failed: '✗', waiting: '…' };
const INTRO_CLOCK = {
  now: () => performance.now(),
  wall: () => Date.now(),
  frame: (fn) => requestAnimationFrame(fn),
  cancelFrame: (id) => cancelAnimationFrame(id),
  after: (ms, fn) => setTimeout(fn, ms),
  cancelAfter: (id) => clearTimeout(id),
};
let introRun = null;
let introBooted = false;

function introBoot(clock = INTRO_CLOCK) {
  if (introBooted || !introWanted(clock)) return false;
  introBooted = true;
  try { sessionStorage.setItem(INTRO_SEEN_KEY, String(clock.wall())); } catch {}
  introPlay(clock);
  return true;
}

function introReplay(clock = INTRO_CLOCK) {
  if (!introRun) introPlay(clock);
}

// A page that cannot say when it last played plays, as a cold load would.
function introWanted(clock) {
  if (new URLSearchParams(location.search).has('window') || !introOn()) return false;
  try {
    const since = clock.wall() - Number(sessionStorage.getItem(INTRO_SEEN_KEY));
    return !(since >= 0 && since < INTRO_AGAIN_MS);
  } catch {
    return true;
  }
}

function introOn() {
  try { return localStorage.getItem(INTRO_PREF_KEY) !== 'off'; } catch { return true; }
}

function introSetOn(on) {
  try { localStorage.setItem(INTRO_PREF_KEY, on ? 'on' : 'off'); } catch {}
  render(true);
}

function introSettingsGroup() {
  const on = introOn();
  return el('section', { class: 'section settings-group', id: 'intro-settings' }, el('h2', {}, 'Intro'),
    el('div', { class: 'setting' }, el('label', { for: 'intro-play' }, 'Play the intro'),
      el('div', { class: 'control' }, el('button', { id: 'intro-play', class: 'switch', role: 'switch', 'aria-checked': String(on), onclick: () => introSetOn(!on) },
        el('span', { class: 'knob' }), on ? 'On' : 'Off'),
        el('button', { id: 'intro-replay', type: 'button', title: 'Play the whole intro now, whatever the switch says', onclick: () => introReplay() }, icon('play'), 'Play it now')),
      el('p', { class: 'hint' }, 'The graph that gathers into the logo when the page first opens, in this browser. It stays until GitLab, Jira and Needs you have loaded, for 15 seconds at most. Any key or click skips it. A reload within 10 minutes does not play it again, but Play it now always does.')));
}

function introReduced() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function introPlay(clock) {
  const canvas = el('canvas', { 'aria-hidden': 'true' });
  const steps = el('p', { class: 'intro-steps', role: 'status' });
  const labels = INTRO_STEPS.map(([key]) => el('span', { class: 'intro-branch', 'data-step': key, 'aria-hidden': 'true' }));
  const node = el('div', { id: 'intro', class: 'intro' }, canvas, steps, labels);
  const reduced = introReduced();
  const run = {
    clock, node, steps, reduced, start: clock.now(), hiddenAt: null, frame: null, timer: null, gatherAt: null, leaveAt: null, settled: false, line: null, tickets: null, listeners: [],
    lit: {}, lastLight: -Infinity, labels: labels.map((label) => ({ label, text: null, on: false, x: null, y: null, left: false })),
  };
  introRun = run;
  document.body.append(node);
  introCover(true);
  try {
    run.paint = introPainter(canvas, reduced);
  } catch (e) {
    console.error('intro', e);
    return introFinish();
  }
  introListenAll(run);
  if (reduced) node.classList.add('intro-listing');
  if (document.hidden) run.hiddenAt = run.start;
  else introResume(run);
}

function introListenAll(run) {
  introListen(run, window, 'keydown', introSkip, true);
  introListen(run, run.node, 'click', introSkip);
  introListen(run, document, 'visibilitychange', introVisibility);
  introListen(run, window, 'resize', () => run.paint?.resize());
}

function introListen(run, target, type, fn, capture = false) {
  target.addEventListener(type, fn, capture);
  run.listeners.push([target, type, fn, capture]);
}

function introCover(on) {
  document.documentElement.classList.toggle('intro-on', on);
  const app = document.querySelector('.app');
  if (app) app.inert = on;
}

const introElapsed = (run) => run.clock.now() - run.start;
const introLeaveMs = (run) => (run.reduced ? INTRO_REDUCED_MS : INTRO_FLY_MS);

function introResume(run) {
  run.timer = run.clock.after(Math.max(0, INTRO_CAP_MS - introElapsed(run)), introFinish);
  introTick();
}

function introHalt(run) {
  run.clock.cancelFrame(run.frame);
  run.clock.cancelAfter(run.timer);
}

function introTick() {
  const run = introRun;
  if (!run) return;
  const t = introElapsed(run);
  introWatch(run, t);
  introPlan(run, t);
  if (introAsksName(run, t) && introHoldForName(run)) return;
  if (run.leaveAt != null && t >= run.leaveAt) run.node.classList.add('intro-leaving');
  if (t >= introEnd(run) || !introDrew(run, t)) return introFinish();
  if (!run.reduced) introLabels(run, t);
  run.frame = run.clock.frame(introTick);
}

// A frame that throws hands the page back at once, rather than leaving it covered and inert until the cap.
function introDrew(run, t) {
  const pace = run.reduced ? 1 : INTRO_PACE;
  const beat = (ms) => (ms == null ? null : ms / pace);
  const lit = INTRO_STEPS.map(([key]) => (run.lit[key] ? { state: run.lit[key].state, at: beat(run.lit[key].at) } : null));
  try {
    run.paint?.draw(t / pace, beat(run.gatherAt), beat(run.leaveAt), lit);
    return true;
  } catch (e) {
    console.error('intro', e);
    return false;
  }
}

function introPlan(run, t) {
  if (run.reduced) introPlanStill(run, t);
  else if (run.gatherAt == null && introMayGather(run, t)) introGatherAt(run, Math.min(t, INTRO_GATHER_BY_MS));
}

function introAsksName(run, t) {
  return !run.named && run.leaveAt != null && t >= run.leaveAt && Boolean(slot('nameAskDue'));
}

// The logo holds where it formed, with the clock stopped as it is for a hidden tab, until the name is saved or skipped.
function introHoldForName(run) {
  run.named = true;
  const form = slot('nameAskForm');
  if (!form) return false;
  Object.assign(run, { asking: true, heldAt: run.clock.now() });
  introHalt(run);
  introDrew(run, run.leaveAt);
  run.node.classList.add('intro-asking');
  run.node.append(el('div', { class: 'name-ask name-ask-intro' }, form));
  document.getElementById('name-ask-input')?.focus({ preventScroll: true });
  return true;
}

function introNameDone() {
  const run = introRun;
  if (!run?.asking) return;
  run.asking = false;
  run.start += run.clock.now() - run.heldAt;
  run.node.querySelector('.name-ask')?.remove();
  run.node.classList.remove('intro-asking');
  introResume(run);
}

function introPlaying() {
  return Boolean(introRun);
}

function introPlanStill(run, t) {
  if (run.leaveAt == null && (run.settled || t >= INTRO_CAP_MS - INTRO_REDUCED_MS)) run.leaveAt = Math.min(t, INTRO_CAP_MS - INTRO_REDUCED_MS);
}

// The cloud stays until every step has loaded or failed and the last branch to light has been seen, but must collapse in time to land inside the cap.
function introMayGather(run, t) {
  return t >= INTRO_GATHER_BY_MS || (run.settled && t >= run.lastLight + INTRO_LINGER_MS);
}

function introGatherAt(run, at) {
  run.gatherAt = at;
  run.leaveAt = at + INTRO_STORY_MS;
  run.node.classList.add('intro-gathering');
}

function introEnd(run) {
  return run.leaveAt == null ? INTRO_CAP_MS : run.leaveAt + introLeaveMs(run);
}

function introWatch(run, t) {
  const steps = introSteps(run);
  if (steps.engine === 'done' && steps.jira === 'waiting' && !run.tickets) introAskTickets(run);
  run.settled = INTRO_STEPS.every(([key]) => steps[key] !== 'waiting');
  for (const [key] of INTRO_STEPS) if (steps[key] !== 'waiting' && !run.lit[key]) introLight(run, key, steps[key], t);
  introList(run, steps, t);
}

// Branches light no sooner than the cloud's least time and at least a beat apart, so a page that loaded at once still shows each one.
function introLight(run, key, state, t) {
  const at = Math.max(t, INTRO_CLOUD_MS, run.lastLight + INTRO_LIGHT_GAP_MS);
  run.lit[key] = { state, at };
  run.lastLight = at;
}

function introLabels(run, t) {
  INTRO_STEPS.forEach(([key, name], b) => {
    const lit = run.lit[key];
    const on = Boolean(lit && t >= lit.at);
    introLabelText(run.labels[b], on, on ? name + ' ' + INTRO_SIGNS[lit.state] : null, lit?.state);
    if (on) introLabelPlace(run.labels[b], run.paint?.seed(b));
  });
}

function introLabelText(view, on, text, state) {
  if (view.on === on && view.text === text) return;
  Object.assign(view, { on, text });
  view.label.textContent = text ?? '';
  view.label.classList.toggle('is-on', on);
  view.label.classList.toggle('is-failed', state === 'failed');
}

// Only a move of a few pixels rewrites the label, and its transition carries it the rest of the way.
function introLabelPlace(view, seed) {
  if (!seed?.shown) return view.label.classList.add('is-hidden');
  view.label.classList.remove('is-hidden');
  if (view.x != null && Math.hypot(seed.x - view.x, seed.y - view.y) < INTRO_LABEL_MOVE_PX) return;
  const left = seed.x > window.innerWidth / 2;
  view.label.classList.toggle('is-placed', view.x != null);
  Object.assign(view, { x: seed.x, y: seed.y });
  view.label.style.transform = `translate(${Math.round(seed.x)}px, ${Math.round(seed.y)}px)`;
  if (left !== view.left) view.label.classList.toggle('is-left', (view.left = left));
}

function introList(run, steps, t) {
  const line = INTRO_STEPS.map(([key, label]) => label + ' ' + INTRO_SIGNS[steps[key]]).join(' · ');
  if (line !== run.line) run.steps.textContent = run.line = line;
  if (t >= INTRO_LIST_MS) run.node.classList.add('intro-listing');
}

function introSteps(run) {
  const engine = introEngineStep();
  const gitlab = engine === 'done' ? introGitlabStep() : engine;
  return {
    engine, gitlab,
    jira: engine === 'done' ? introJiraStep(run) : engine,
    needs: gitlab === 'done' ? introNeedsStep() : gitlab,
  };
}

function introEngineStep() {
  const m = state?.matrix;
  if (m?.available) return 'done';
  return m && m.error !== 'starting' ? 'failed' : 'waiting';
}

function introGitlabStep() {
  const inbox = state.matrix.inbox;
  if (inbox.fetchedAt && !inbox.loading) return 'done';
  return inbox.error ? 'failed' : 'waiting';
}

function introJiraStep(run) {
  const t = ui.tickets;
  if (t.data?.read) return 'done';
  if (run.tickets?.broken) return 'failed';
  if (!run.tickets?.answered) return 'waiting';
  return t.error || t.data?.error ? 'failed' : 'waiting';
}

// A worker from before builtAt cannot say, so Needs you is not waited on.
function introNeedsStep() {
  const a = state.attention;
  if (!a || a.builtAt === undefined || a.builtAt) return 'done';
  return a.buildError ? 'failed' : 'waiting';
}

// The worker reads Jira only when asked, so the intro asks through the Tickets view's own loader, which warms that view too.
function introAskTickets(run) {
  run.tickets ??= { answered: false, broken: false, timer: null };
  const asked = slot('loadTickets');
  if (asked) asked.then(() => introTicketsAnswered(run));
  else run.tickets.broken = true;
}

function introTicketsAnswered(run) {
  if (introRun !== run) return;
  run.tickets.answered = true;
  if (introJiraStep(run) === 'waiting') run.tickets.timer = run.clock.after(INTRO_TICKETS_POLL_MS, () => introAskTickets(run));
}

function introSkip(e) {
  if (introRun?.asking) return;
  e.preventDefault();
  e.stopPropagation();
  introFinish();
}

function introVisibility() {
  const run = introRun;
  if (run.asking) return;
  if (document.hidden && run.hiddenAt == null) {
    run.hiddenAt = run.clock.now();
    introHalt(run);
  } else if (!document.hidden && run.hiddenAt != null) {
    run.start += run.clock.now() - run.hiddenAt;
    run.hiddenAt = null;
    introResume(run);
  }
}

function introFinish() {
  const run = introRun;
  if (!run) return;
  introRun = null;
  introHalt(run);
  run.clock.cancelAfter(run.tickets?.timer);
  for (const [target, type, fn, capture] of run.listeners) target.removeEventListener(type, fn, capture);
  run.node.remove();
  introCover(false);
  slot('nameAskPlain');
}

if (typeof requestAnimationFrame === 'function') introBoot();
