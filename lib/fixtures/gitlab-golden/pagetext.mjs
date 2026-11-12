import { openPage, LONDON_LOCALE } from '../../../ui/testkit.mjs';

const PAGE_READS = /^\/api\/(?:matrix\/|stats$|qa$|standup$)/;
const ROUNDS = 6;
const VIEWS = ['overview', 'needs-you', 'merge-requests', 'review-queue', 'tickets', 'standup', 'qa'];
const DRAWERS = [
  ['acme/engine!7', ['overview', 'findings', 'threads', 'pipeline', 'files']],
  ['acme/engine!12', ['overview', 'threads', 'pipeline']],
  ['acme/web!22', ['overview']],
  ['acme/web!30', ['overview', 'findings']],
];
const TERMINAL_LINES = [
  'Reviewed acme/engine!7 and engine!12, then ABC-102 and https://gitlab.com/acme/web/-/merge_requests/30.',
  'See !22, cli!3, acme/web!99, other/thing!4 and https://acme.atlassian.net/browse/ABC-110.',
];
const BLOCKS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BR', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TD', 'TH', 'TR', 'UL']);
const UNSEEN = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'SVG', 'TEXTAREA', 'INPUT', 'SELECT']);

// The release banner follows the changelog and the notifications card is the Setup work's, so neither is shown.
export async function pageText(snapshot, read, now) {
  const state = { ...snapshot, locale: LONDON_LOCALE, release: null };
  const capture = capturer(read, now);
  const views = {};
  for (const view of VIEWS) views[view] = await capture((page) => viewLines(page, state, view));
  const drawers = {};
  for (const [key, tabs] of DRAWERS) {
    for (const tab of tabs) drawers[`${key} ${tab}`] = await capture((page) => drawerLines(page, state, key, tab));
  }
  const terminalLinks = await capture((page) => terminalLinkLines(page, state));
  return { views, drawers, terminalLinks };
}

// The page asks the worker as it renders, and its fetch must answer at once, so each round renders afresh with what the last one asked for.
function capturer(read, now) {
  const answers = new Map();
  const FixedDate = fixedDate(now);
  return async (show) => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const missing = new Map();
      const page = await openPage({ respond: (path, init) => answer(path, init, answers, missing), storage: memory({ 'cc-needs-setup-done': '1' }), globals: { Date: FixedDate } });
      const lines = await show(page);
      if (!missing.size) return lines;
      for (const [key, { path, query }] of missing) answers.set(key, await read(path, query));
    }
    throw new Error('the page kept asking the worker for more');
  };
}

async function viewLines(page, state, view) {
  page.show(state, view);
  await page.settle(60);
  page.run('render()');
  return visibleLines(page.$('#main'));
}

async function drawerLines(page, state, key, tab) {
  page.show(state, 'merge-requests');
  page.run(`openMr(${JSON.stringify(key)}, ${JSON.stringify(tab)})`);
  await page.settle(60);
  page.run('render(true)');
  return visibleLines(page.$('#drawer'));
}

function terminalLinkLines(page, state) {
  page.show(state, 'merge-requests');
  const found = page.run(`JSON.stringify(terminalRefs(${JSON.stringify(TERMINAL_LINES)}, terminalKnown()).map((ref) => ({ ref, action: terminalAction(ref, terminalKnown()) })))`);
  return JSON.parse(found).map(({ ref, action }) => `${ref.text} -> ${ref.kind} ${ref.key}: ${action.words}${action.url ? ` (${action.url})` : ''}`);
}

function answer(path, init, answers, missing) {
  const url = new URL(path, 'http://page');
  url.searchParams.delete('t');
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' || !PAGE_READS.test(url.pathname)) return null;
  const key = url.pathname + url.search;
  if (answers.has(key)) return answers.get(key);
  missing.set(key, { path: url.pathname, query: Object.fromEntries(url.searchParams) });
  return null;
}

function memory(entries) {
  const kept = new Map(Object.entries(entries));
  return { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)), removeItem: (k) => kept.delete(k) };
}

function fixedDate(now) {
  return class extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }

    static now() {
      return now;
    }
  };
}

export function visibleLines(root) {
  if (!root || root.hidden) return [];
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === 3) return parts.push(node.textContent.replace(/\s+/g, ' '));
    if (node.nodeType !== 1 || node.hidden || UNSEEN.has(node.tagName) || node.style?.display === 'none') return;
    const block = BLOCKS.has(node.tagName);
    if (block) parts.push('\n');
    const kids = node.tagName === 'DETAILS' && !node.open ? node.childNodes.filter((c) => c.tagName === 'SUMMARY') : node.childNodes;
    kids.forEach(walk);
    if (block) parts.push('\n');
  };
  walk(root);
  return parts.join('').split('\n').map((line) => line.replace(/ {2,}/g, ' ').trim()).filter(Boolean);
}
