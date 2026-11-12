import { engine, engineError, failure, notify, requireEngine, supports } from './engine.mjs';
import { isOn } from './features.mjs';

const NEEDS = ['buildBoard', 'currentRepos', 'loadSettings', 'parseWeights'];
const PUSH_MS = 2000;
const LEGENDS = { review: 'REVIEW_LEGEND', tickets: 'TICKET_LEGEND', pipeline: 'PIPELINE_LEGEND' };

let running = null;
let last = null;
let lastError = null;

export const ACTIONS = {};

export const ROUTES = {
  'GET /api/matrix/board': () => readBoard(),
  'POST /api/matrix/board': async ({ body }) => startBoard(await body()),
  'GET /api/matrix/legend': () => readLegend(),
};

export function readBoard() {
  return {
    board: last,
    progress: running?.progress ?? null,
    startedAt: running?.startedAt ?? null,
    bots: running?.bots ?? last?.bots ?? false,
    error: running ? null : lastError,
    stages: [...(engine?.BOARD_STAGES ?? [])],
    missing: engine ? NEEDS.filter((name) => !supports(name)) : [],
  };
}

// A build reads GitLab for about a minute, so a second ask joins the one running, whatever it asked to count.
export async function startBoard({ bots } = {}) {
  const live = requireEngine(...NEEDS);
  if (!(await isOn('leaderboard'))) throw failure(409, 'the leaderboard is off: turn it on in Settings first');
  if (running) return { ...readBoard(), text: 'The board is already building, so this waits for that build' };
  running = launch(live, bots === true);
  notify('board');
  return { ...readBoard(), text: 'Building the board, which reads GitLab for about a minute' };
}

export function stop() {
  if (!running) return;
  running.stopped = true;
  clearTimeout(running.timer);
  running = null;
}

function launch(live, bots) {
  const build = { bots, startedAt: Date.now(), progress: null, pushedAt: Date.now(), timer: null, stopped: false };
  Promise.resolve()
    .then(() => buildWith(live, build))
    .then((board) => finish(build, board, null), (err) => finish(build, null, err.message));
  return build;
}

async function buildWith(live, build) {
  const settings = live.loadSettings();
  const weights = live.parseWeights(String(settings.pointWeights ?? ''));
  const repos = await live.currentRepos();
  const onProgress = (progress) => report(build, progress);
  const board = await live.buildBoard(repos, settings.leaderboardDays, { includeAutomated: build.bots, weights, onProgress });
  return { ...board, bots: build.bots, weights };
}

// Every push makes each open page read its whole state again, so progress goes out at most every two seconds.
function report(build, progress) {
  if (build.stopped) return;
  build.progress = progress;
  if (build.timer) return;
  build.timer = setTimeout(() => {
    build.timer = null;
    build.pushedAt = Date.now();
    notify('board');
  }, Math.max(0, build.pushedAt + PUSH_MS - Date.now()));
}

function finish(build, board, error) {
  clearTimeout(build.timer);
  if (build.stopped) return;
  running = null;
  if (board) last = board;
  lastError = error;
  notify('board');
}

export function readLegend() {
  if (!engine) throw failure(503, engineError);
  const legend = { moods: Object.entries(engine.MOOD_LABELS ?? {}).map(([mood, label]) => ({ mood, label })), missing: [] };
  for (const [group, name] of Object.entries(LEGENDS)) {
    if (!Array.isArray(engine[name])) legend.missing.push(name);
    legend[group] = (engine[name] ?? []).map(({ phase, glyph, colour, label }) => ({ phase: phase ?? null, glyph, colour, label }));
  }
  return legend;
}
