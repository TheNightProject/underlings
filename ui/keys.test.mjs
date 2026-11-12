import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-05T12:00:00Z';
const THEIRS = 'acme/engine!1121';
const OTHER = 'acme/engine!1130';
const MINE = 'acme/portal!88';
const READ_POSTS = new Set(['/api/matrix/refresh', '/api/attention/presence']);

function row(key, extra = {}) {
  const iid = Number(key.split('!')[1]);
  return {
    key, iid, repo: key.split('/')[1].split('!')[0], title: 'MR ' + iid, webUrl: 'https://gitlab.com/' + key.replace('!', '/-/merge_requests/'), author: 'judy', reviewers: ['frank'],
    approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: null, updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'b', sha: 'aaa111',
    agentHandle: null, watch: null, flags: { waitingOnYou: true }, phase: 'open', count: 0, mood: 'awaitingYou', verdict: null, agent: null, level: null, ...extra,
  };
}

const ROWS = [
  row(THEIRS, { title: 'Speed up the graph sync', ticket: 'ABC-12' }),
  row(OTHER, { title: 'Tidy the importer', author: 'abe' }),
  row(MINE, { title: 'Portal login copy', author: 'frank', flags: { mine: true }, mood: 'quiet', approvedBy: ['abe'] }),
];

function snapshot(over = {}) {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [{ handle: 'term-9', name: 'review-engine-1121', title: 'Reviewing the graph sync', state: 'working', mr: null, ticket: null, kind: 'Claude Code', lastAt: Date.parse(AT) }],
    artifacts: [{ url: 'https://claude.ai/artifact/abc', title: 'Release notes draft', description: 'What shipped', at: AT, hidden: false }],
    attention: { cards: [], agents: [], system: [], count: 0, prefs: {}, toasts: [], offers: [] },
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 2, rows: ROWS },
      fullAuto: [], roster: [{ username: 'judy', level: 'shadow', askingYou: 1, open: 1, reviewing: 0 }], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
      onRequest: { level: null, optedOut: [], available: true },
    },
    ...over,
  };
}

const TICKETS = { read: true, loading: false, tickets: [{ key: 'ABC-40', summary: 'Ship the palette', status: 'In Progress', epic: null, epicRead: true, mrs: [], targets: [], suggest: null }] };

function memory(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); } };
}

async function keysPage({ snap = snapshot(), hash = 'merge-requests', mac = true } = {}) {
  const posts = [];
  const page = await openPage({
    respond(path, init) {
      if (init?.method === 'POST') {
        posts.push([path, JSON.parse(init.body ?? 'null')]);
        return { ok: true, text: 'Done' };
      }
      if (path.startsWith('/api/matrix/tickets')) return TICKETS;
      if (path.startsWith('/api/matrix/settings')) return { rows: [], repos: null };
      return null;
    },
  });
  page.window.navigator.platform = mac ? 'MacIntel' : 'Linux x86_64';
  page.window.localStorage = memory();
  page.show(snap, hash);
  const writes = () => posts.filter(([path]) => !READ_POSTS.has(path));
  return Object.assign(page, { posts, writes });
}

function press(page, key, init = {}) {
  const shiftKey = /^[A-Z?]$/.test(key);
  return page.fire(init.target ?? page.document.activeElement, 'keydown', { key, shiftKey, ...init });
}

const keys = (page, ...names) => names.forEach((k) => press(page, k));
const selected = (page) => page.$$('.is-selected');
const visible = (page, id) => !page.$('#' + id).hidden;
const options = (page) => page.$$('#palette [role="option"]');
const optionLabels = (page) => options(page).map((o) => o.querySelector('.palette-label').textContent);

function search(page, text) {
  const input = page.$('#palette-q');
  input.value = text;
  page.fire(input, 'input');
}

test('g then a letter goes to each view in the rail, and a letter that goes nowhere is swallowed', async () => {
  const page = await keysPage({ hash: 'overview' });
  const go = { m: 'merge-requests', t: 'tickets', n: 'needs-you', q: 'review-queue', a: 'agents', p: 'artifacts', f: 'full-auto', r: 'review-runs', w: 'watching', b: 'leaderboard', s: 'settings', o: 'overview' };
  for (const [letter, view] of Object.entries(go)) {
    keys(page, 'g', letter);
    assert.equal(page.window.location.hash, '#' + view, 'g ' + letter);
  }
  press(page, 'g');
  assert.equal(visible(page, 'keyhint'), true, 'the letters that can follow are shown');
  assert.match(page.$('#keyhint').textContent, /^g then.*gFirst row.*oOverview.*nNeeds you.*mMerge requests/);
  assert.equal(press(page, 'z'), false, 'the stray letter is consumed');
  assert.equal(page.window.location.hash, '#overview');
  assert.equal(visible(page, 'keyhint'), false);
});

test('no key does anything while you type in a field, except Esc and Cmd+K', async () => {
  const page = await keysPage();
  page.run("document.getElementById('main').append(el('textarea', { id: 'scratch-text' }), el('select', { id: 'scratch-pick' }), el('div', { id: 'scratch-edit', contenteditable: 'true' }))");
  for (const id of ['mr-q', 'scratch-text', 'scratch-pick', 'scratch-edit']) {
    const field = page.$('#' + id);
    field.focus();
    for (const k of ['g', 'm', 'j', 'k', 'r', 'v', 'h', 'P', 'b', 'R', '?', '/', ',', '1', 'G', 'Enter']) assert.equal(press(page, k, { target: field }), true, `${k} in #${id}`);
    assert.equal(page.window.location.hash, '#merge-requests');
    assert.deepEqual(selected(page), []);
    assert.equal(page.run('ui.armed'), null);
  }
  const box = page.$('#mr-q');
  box.focus();
  press(page, 'k', { metaKey: true, target: box });
  assert.equal(visible(page, 'palette'), true, 'Cmd+K still opens the palette from a field');
  press(page, 'Escape', { target: page.$('#palette-q') });
  assert.equal(page.document.activeElement.id, 'mr-q', 'and closing it puts you back in the field');
});

test('Esc in a search box clears it first, then leaves it; in any other field it leaves at once and keeps what you typed', async () => {
  const page = await keysPage();
  const box = page.$('#mr-q');
  box.focus();
  box.value = 'graph';
  page.fire(box, 'input');
  assert.equal(page.$$('#main .mr').length, 1);
  press(page, 'Escape');
  assert.equal(page.run('ui.mrSearch'), '');
  assert.equal(page.$$('#main .mr').length, 3, 'the filter went with the text');
  assert.equal(page.document.activeElement.id, 'mr-q');
  press(page, 'Escape');
  assert.equal(page.document.activeElement.id, 'main');
  page.run("document.querySelector('#main .mr').append(el('textarea', { id: 'scratch-text' }))");
  const text = page.$('#scratch-text');
  text.focus();
  text.value = 'half a reply';
  press(page, 'Escape');
  assert.ok(page.document.activeElement.classList.contains('mr'), 'focus goes to the row the field is in');
  assert.equal(text.value, 'half a reply');
});

test('j and k select rows in page order, the selection survives a render with new rows, and Enter opens the MR', async () => {
  const page = await keysPage();
  press(page, 'j');
  const first = selected(page);
  assert.equal(first.length, 1);
  assert.equal(page.document.activeElement, first[0], 'the row takes focus');
  assert.equal(first[0].querySelector('.ref').dataset.key, THEIRS);
  keys(page, 'j', 'j', 'j');
  assert.equal(selected(page)[0].querySelector('.ref').dataset.key, MINE, 'j stops at the last row');
  press(page, 'k');
  assert.equal(selected(page)[0].querySelector('.ref').dataset.key, OTHER);
  page.show(snapshot({ matrix: { ...snapshot().matrix, inbox: { ...snapshot().matrix.inbox, rows: [...ROWS].reverse() } } }), 'merge-requests');
  const kept = selected(page);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].querySelector('.ref').dataset.key, OTHER, 'the same MR, though its row moved');
  assert.equal(page.document.activeElement, kept[0], 'a render after a key puts focus back on the row');
  press(page, 'Enter');
  assert.equal(page.run('ui.mr.key'), OTHER);
  assert.deepEqual(page.writes(), []);
});

test('G and g g go to the last and first rows, and Esc drops the selection last of all', async () => {
  const page = await keysPage();
  press(page, 'G');
  assert.equal(selected(page)[0].querySelector('.ref').dataset.key, MINE);
  keys(page, 'g', 'g');
  assert.equal(selected(page)[0].querySelector('.ref').dataset.key, THEIRS);
  press(page, 'Escape');
  assert.deepEqual(selected(page), []);
});

test('the drawer takes its tabs by number and by [ and ], and Esc leaves a field in it before it closes', async () => {
  const page = await keysPage();
  page.run(`openMr(${JSON.stringify(THEIRS)})`);
  press(page, '3');
  assert.equal(page.run('ui.mr.tab'), 'threads');
  press(page, ']');
  assert.equal(page.run('ui.mr.tab'), 'pipeline');
  keys(page, '[', '[');
  assert.equal(page.run('ui.mr.tab'), 'findings');
  press(page, '1');
  page.run("document.querySelector('#drawer .drawer-body').append(el('textarea', { id: 'scratch-text' }))");
  page.$('#scratch-text').focus();
  press(page, 'Escape');
  assert.ok(page.run('ui.mr'), 'the first Esc only leaves the field');
  assert.ok(page.document.activeElement.classList.contains('drawer'));
  press(page, 'Escape');
  assert.equal(page.run('ui.mr'), null);
});

test('a key that writes only arms the button; the same key again sends it once, and nothing in between does', async () => {
  const page = await keysPage();
  press(page, 'j');
  press(page, 'r');
  assert.deepEqual(page.writes(), []);
  assert.equal(page.run('ui.armed'), 'review:' + THEIRS);
  assert.equal(page.document.activeElement.id, 'g-review:' + THEIRS, 'Enter would press the armed button');
  press(page, 'r', { repeat: true });
  assert.deepEqual(page.writes(), [], 'holding the key down never confirms');
  press(page, 'r');
  await page.settle();
  assert.deepEqual(page.writes(), [['/api/matrix/review', { key: THEIRS }]]);
});

test('Esc, a move or the mouse between the two presses leaves nothing sent', async () => {
  const page = await keysPage();
  press(page, 'j');
  keys(page, 'v', 'Escape');
  assert.equal(page.run('ui.armed'), null);
  assert.ok(page.document.activeElement.classList.contains('is-selected'), 'cancelling hands focus back to the row, so Enter opens it');
  keys(page, 'j', 'k', 'v', 'j');
  assert.equal(page.run('ui.armed'), null, 'moving the selection disarms');
  page.$(`[id="g-hold:${THEIRS}"]`).click();
  assert.equal(page.run('ui.armed'), 'hold:' + THEIRS, 'armed with the mouse');
  press(page, 'k');
  assert.equal(page.run('ui.armed'), null);
  page.$(`[id="g-hold:${THEIRS}"]`).click();
  press(page, 'h');
  await page.settle();
  assert.deepEqual(page.writes(), [], 'a key never confirms what the mouse armed');
  assert.equal(page.document.activeElement.id, 'g-hold:' + THEIRS);
});

test('the keys that write reach the drawer\'s MR, and offer nothing it does not draw', async () => {
  const page = await keysPage();
  page.run(`openMr(${JSON.stringify(MINE)})`);
  assert.equal(press(page, 'v'), true, 'your own MR has no Approve, so v is left alone');
  assert.equal(page.run('ui.armed'), null);
  press(page, 'r');
  assert.equal(page.run('ui.armed'), 'review:' + MINE);
  assert.ok(page.$('#drawer').contains(page.document.activeElement));
  assert.deepEqual(page.writes(), []);
});

test('on a card with no buttons of its own, a key that writes opens the drawer and arms it there', async () => {
  const page = await keysPage();
  press(page, 'b');
  keys(page, 'j', 'j', 'r');
  assert.equal(page.run('ui.mr.key'), THEIRS);
  assert.equal(page.run('ui.armed'), 'review:' + THEIRS);
  assert.ok(page.$('#drawer').contains(page.document.activeElement), 'the armed button in the drawer has focus');
  assert.deepEqual(page.writes(), []);
});

const CONTEXTS = {
  'a list with nothing selected': (page) => page.show(snapshot(), 'merge-requests'),
  'a selected MR': (page) => { page.show(snapshot(), 'merge-requests'); press(page, 'j'); },
  'the drawer': (page) => { page.show(snapshot(), 'merge-requests'); page.run(`openMr(${JSON.stringify(THEIRS)})`); },
  'the Overview': (page) => page.show(snapshot(), 'overview'),
  'Tickets': (page) => page.show(snapshot(), 'tickets'),
};

test('one press of any bound key, in any of these places, writes nothing', async () => {
  const page = await keysPage();
  const bound = [...new Set(page.run('keymap().flatMap((x) => x.keys ?? [])'))];
  assert.ok(bound.length > 20, bound.join(' '));
  for (const [where, setUp] of Object.entries(CONTEXTS)) {
    for (const sequence of bound) {
      page.run("ui.armed = null; ui.mr = null; ui.ticket = null; ui.file = null; ui.menu = null; keyState.sel.clear(); closePalette(false); closeShortcuts(false)");
      setUp(page);
      for (const k of sequence.split(' ')) press(page, k === 'Mod+K' ? 'k' : k === 'Esc' ? 'Escape' : k, k === 'Mod+K' ? { metaKey: true } : {});
      await page.settle(20);
      assert.deepEqual(page.writes(), [], `${sequence} on ${where}`);
    }
  }
});

test('Cmd+K and Ctrl+K open the palette over the drawer, the page behind goes inert, and Esc gives focus back', async () => {
  const page = await keysPage();
  page.run(`openMr(${JSON.stringify(THEIRS)})`);
  const drawer = page.document.activeElement;
  assert.ok(drawer.classList.contains('drawer'));
  press(page, 'k', { metaKey: true });
  assert.equal(visible(page, 'palette'), true);
  assert.equal(page.document.activeElement.id, 'palette-q');
  assert.equal(page.$('.app').inert, true);
  assert.equal(page.$('#drawer').inert, true);
  page.run('render(true)');
  assert.equal(page.$('#drawer').inert, true, 'a render behind it keeps the page inert');
  press(page, 'Escape');
  assert.equal(visible(page, 'palette'), false);
  assert.equal(page.$('#drawer').inert, false);
  assert.ok(page.document.activeElement.classList.contains('drawer'), 'focus is back where it was');
  press(page, 'k', { ctrlKey: true });
  assert.equal(visible(page, 'palette'), true);
  press(page, 'k', { ctrlKey: true, target: page.$('#palette-q') });
  assert.equal(visible(page, 'palette'), false, 'the same keys close it');
});

test('the palette finds views by initials, MRs by title, !iid, author or ticket, tickets, agents, people and artifacts', async () => {
  const page = await keysPage({ hash: 'overview' });
  press(page, 'k', { metaKey: true });
  await page.settle();
  const top = (text) => {
    search(page, text);
    return optionLabels(page)[0];
  };
  assert.equal(top('rq'), 'Review queue');
  assert.equal(top('rvw qu'), 'Review queue', 'letters in order');
  assert.deepEqual(page.$$('#palette [aria-selected="true"] .palette-label b').map((b) => b.textContent), ['R', 'v', 'w', 'qu'], 'and those letters are marked');
  assert.equal(top('graph sync'), 'Speed up the graph sync');
  assert.equal(top('!1130'), 'Tidy the importer');
  search(page, 'abc-12');
  assert.deepEqual(optionLabels(page).slice(0, 2), ['Speed up the graph sync', 'ABC-12'], 'the MR that carries the ticket, and the ticket');
  assert.equal(top('ship palette'), 'Ship the palette');
  assert.equal(top('reviewing the graph'), 'Reviewing the graph sync');
  assert.equal(top('release notes'), 'Release notes draft');
  assert.equal(top('@abe'), 'abe');
  search(page, 'abe');
  assert.ok(optionLabels(page).includes('Tidy the importer'), 'an author finds their MRs');
  assert.equal(top('zzqx'), undefined);
  assert.match(page.$('#palette').textContent, /Nothing matches/);
  search(page, 'graph');
  assert.deepEqual(page.$$('#palette [aria-selected="true"] .palette-label b').map((b) => b.textContent), ['graph'], 'the letters that matched are marked');
});

test('the arrows and Enter run the highlighted entry, and what you picked is listed first next time', async () => {
  const page = await keysPage({ hash: 'overview' });
  press(page, 'k', { metaKey: true });
  search(page, 'watch');
  const input = page.$('#palette-q');
  assert.equal(options(page)[0].getAttribute('aria-selected'), 'true');
  press(page, 'ArrowDown', { target: input });
  assert.equal(options(page)[1].getAttribute('aria-selected'), 'true');
  assert.equal(input.getAttribute('aria-activedescendant'), options(page)[1].id);
  press(page, 'ArrowUp', { target: input });
  press(page, 'Enter', { target: input });
  assert.equal(visible(page, 'palette'), false);
  assert.equal(page.window.location.hash, '#watching');
  press(page, 'k', { metaKey: true });
  assert.equal(page.$('#palette .palette-head').textContent, 'Recent');
  assert.equal(optionLabels(page)[0], 'Watching');
  page.window.localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  search(page, '');
  assert.ok(optionLabels(page).includes('Merge requests'), 'storage that refuses still leaves a working palette');
});

test('a write from the palette brings its button up armed and sends nothing, even picked twice', async () => {
  const page = await keysPage();
  press(page, 'k', { metaKey: true });
  search(page, '!1121');
  const input = page.$('#palette-q');
  press(page, 'Tab', { target: input });
  assert.match(page.$('#palette .palette-crumb').textContent, /Speed up the graph sync/);
  search(page, 'review');
  assert.equal(optionLabels(page)[0], 'Review engine!1121');
  assert.ok(options(page)[0].querySelector('.twice'), 'it says it takes two presses');
  press(page, 'Enter', { target: input });
  assert.equal(page.run('ui.armed'), 'review:' + THEIRS);
  assert.equal(page.document.activeElement.id, 'g-review:' + THEIRS);
  press(page, 'k', { metaKey: true });
  search(page, '!1121');
  press(page, 'Tab', { target: input });
  search(page, 'review');
  press(page, 'Enter', { target: input });
  await page.settle();
  assert.deepEqual(page.writes(), []);
  assert.equal(page.run('ui.armed'), 'review:' + THEIRS);
});

test('a one-click write from the palette, such as a test banner, is only brought into focus', async () => {
  const page = await keysPage({ hash: 'overview' });
  press(page, 'k', { metaKey: true });
  search(page, 'test banner');
  press(page, 'Enter', { target: page.$('#palette-q') });
  assert.equal(page.window.location.hash, '#settings');
  page.run('render()');
  await page.settle(20);
  assert.equal(page.document.activeElement.id, 'note-test');
  assert.deepEqual(page.writes(), []);
});

test('Shift+Tab or Backspace on an empty box backs out of an MR\'s actions, and Esc backs out before it closes', async () => {
  const page = await keysPage();
  press(page, 'k', { metaKey: true });
  const input = page.$('#palette-q');
  search(page, 'tidy');
  press(page, 'Tab', { target: input });
  assert.ok(optionLabels(page).includes('Findings tab'));
  press(page, 'Backspace', { target: input });
  assert.equal(page.$('#palette .palette-crumb').hidden, true);
  search(page, 'tidy');
  press(page, 'Tab', { target: input });
  press(page, 'Tab', { target: input, shiftKey: true });
  assert.equal(page.$('#palette .palette-crumb').hidden, true);
  search(page, 'tidy');
  press(page, 'Tab', { target: input });
  press(page, 'Escape', { target: input });
  assert.equal(visible(page, 'palette'), true);
  press(page, 'Escape', { target: input });
  assert.equal(visible(page, 'palette'), false);
});

test('the palette offers the open MR\'s tabs and writes, a layout switch and the Settings sections', async () => {
  const page = await keysPage();
  page.run(`openMr(${JSON.stringify(THEIRS)})`);
  press(page, 'k', { metaKey: true });
  const here = optionLabels(page);
  for (const label of ['Findings tab', 'Pipeline tab', 'Review engine!1121', 'Approve or withdraw approval engine!1121', 'Hold or release engine!1121']) assert.ok(here.includes(label), label);
  assert.ok(!here.some((label) => label.startsWith('Post all')), 'nothing is waiting to post, so Post all is not offered');
  search(page, 'notifications');
  assert.equal(optionLabels(page)[0], 'Settings: Notifications');
  search(page, 'merge requests as');
  assert.equal(optionLabels(page)[0], 'Merge requests as a board');
  press(page, 'Enter', { target: page.$('#palette-q') });
  assert.equal(page.run('ui.mrLayout'), 'board');
  assert.equal(page.run('ui.mr'), null, 'a jump closes the drawer');
});

test('b turns the merge requests and tickets between list and board', async () => {
  const page = await keysPage();
  keys(page, 'j', 'j', 'b');
  assert.equal(page.run('ui.mrLayout'), 'board');
  assert.ok(page.$('#main .mr-board'));
  assert.ok(selected(page)[0].classList.contains('kanban-card'), 'cards are rows too');
  assert.equal(selected(page)[0].dataset.key, OTHER, 'the MR selected in the list is the card selected on the board');
  press(page, 'b');
  assert.equal(page.run('ui.mrLayout'), 'list');
  page.show(snapshot(), 'tickets');
  await page.settle();
  press(page, 'b');
  assert.equal(page.run('ui.tickets.layout'), 'board');
});

test('/ goes to the view\'s search box, and opens the palette where there is none', async () => {
  const page = await keysPage();
  press(page, '/');
  assert.equal(page.document.activeElement.id, 'mr-q');
  page.show(snapshot(), 'overview');
  page.$('#main').focus();
  press(page, '/');
  assert.equal(visible(page, 'palette'), true);
});

test('? opens the shortcuts, which list every bound key and dim the ones that do nothing here', async () => {
  const page = await keysPage();
  press(page, '?');
  assert.equal(visible(page, 'keyhelp'), true);
  assert.equal(page.document.activeElement.classList.contains('keyhelp'), true);
  const text = page.$('#keyhelp').textContent;
  const labels = page.run('keymap().filter((x) => x.keys?.length && !x.fold).map((x) => x.label)');
  for (const label of labels) assert.ok(text.includes(label), label);
  assert.match(text, /Drawer tab: Overview, Findings, Threads, Pipeline, Files, Agent/);
  const idle = page.$$('#keyhelp .kh-row.idle').map((r) => r.querySelector('dd').textContent);
  assert.ok(idle.some((t) => t.startsWith('Review')), 'nothing is selected, so Review does nothing');
  assert.ok(!idle.includes('Board or list'));
  press(page, 'j');
  assert.deepEqual(selected(page), [], 'keys behind it are paused');
  press(page, '?');
  assert.equal(visible(page, 'keyhelp'), false);
  press(page, '?');
  press(page, 'Escape');
  assert.equal(visible(page, 'keyhelp'), false);
  assert.equal(page.$('.app').inert, false);
});

test('in the app the shortcuts say which shortcut shows the window, and when it could not be had', async () => {
  const hotkeys = { show: { accelerator: 'Control+Alt+Command+K', registered: false, why: 'macOS would not give it to the app' }, menu: [['Merge requests', 'CommandOrControl+3']] };
  const page = await keysPage({ snap: snapshot({ shell: 'app', hotkeys }) });
  press(page, '?');
  const text = page.$('#keyhelp').textContent;
  assert.match(text, /⌃⌥⌘KShow Underlings from any app/);
  assert.match(text, /⌘3Merge requests/);
  assert.match(text, /Could not use ⌃⌥⌘K: macOS would not give it to the app\. Set showShortcut in ~\/\.config\/underlings\/config\.json/);
  page.show(snapshot({ shell: 'plugin', hotkeys }), 'merge-requests');
  press(page, '?');
  press(page, '?');
  assert.doesNotMatch(page.$('#keyhelp').textContent, /Mac app/, 'the plugin has no such shortcut');
});

test('Esc closes one layer per press: the palette, then what is armed, then the drawer, then the selection', async () => {
  const page = await keysPage();
  press(page, 'j');
  press(page, 'Enter');
  press(page, 'r');
  press(page, 'k', { metaKey: true });
  press(page, 'Escape', { target: page.$('#palette-q') });
  assert.equal(visible(page, 'palette'), false);
  assert.equal(page.run('ui.armed'), 'review:' + THEIRS);
  press(page, 'Escape');
  assert.equal(page.run('ui.armed'), null);
  assert.ok(page.run('ui.mr'));
  press(page, 'Escape');
  assert.equal(page.run('ui.mr'), null);
  assert.equal(selected(page).length, 1);
  press(page, 'Escape');
  assert.deepEqual(selected(page), []);
  assert.deepEqual(page.writes(), []);
});

test('keys behind the colour key wait until it closes, and Esc closes it first', async () => {
  const page = await keysPage();
  page.$('#legend-toggle').click();
  keys(page, 'j', 'g', 'm');
  assert.deepEqual(selected(page), []);
  assert.equal(page.run('Boolean(keyState.pending)'), false);
  press(page, 'Escape');
  assert.equal(page.$('#legend').hidden, true);
  press(page, 'j');
  assert.equal(selected(page).length, 1);
});

test('the worker can open the palette and the shortcuts, which is how the app\'s menu reaches them', async () => {
  const page = await keysPage();
  page.run("goTo('jump')");
  assert.equal(visible(page, 'palette'), true);
  page.run("goTo('jump')");
  press(page, 'Escape', { target: page.$('#palette-q') });
  assert.equal(page.document.activeElement.id, 'main', 'a second open keeps where focus goes back to');
  page.run("goTo('jump')");
  page.run("goTo('keys')");
  assert.equal(visible(page, 'palette'), false);
  assert.equal(visible(page, 'keyhelp'), true);
});

test('the rail offers the palette with the pointer, labelled for this platform', async () => {
  const mac = await keysPage({ mac: true });
  mac.run('document.getElementById("jump").remove(); railJump()');
  assert.equal(mac.$('#jump kbd').textContent, '⌘K');
  mac.$('#jump').click();
  assert.equal(visible(mac, 'palette'), true);
  const other = await keysPage({ mac: false });
  other.run('document.getElementById("jump").remove(); railJump()');
  assert.equal(other.$('#jump kbd').textContent, 'Ctrl K');
});

test('picking an artifact in the palette opens it in the app\'s window, and Tab still offers it in Artifacts', async () => {
  const page = await keysPage({ snap: snapshot({ shell: 'app' }), hash: 'overview' });
  press(page, 'k', { metaKey: true });
  search(page, 'release notes');
  press(page, 'Enter', { target: page.$('#palette-q') });
  await page.settle(0);
  assert.deepEqual(page.writes(), [['/api/artifacts/window', { url: 'https://claude.ai/artifact/abc', copy: false }]]);
  assert.equal(page.window.location.hash, '#overview');
  press(page, 'k', { metaKey: true });
  search(page, 'release notes');
  press(page, 'Tab', { target: page.$('#palette-q') });
  assert.deepEqual(optionLabels(page), ['Show Release notes draft in Artifacts', 'Copy the link to Release notes draft']);
});

test('in the plugin, picking an artifact in the palette goes to it in Artifacts and opens nothing', async () => {
  const page = await keysPage({ snap: snapshot({ shell: 'plugin' }), hash: 'overview' });
  press(page, 'k', { metaKey: true });
  search(page, 'release notes');
  press(page, 'Enter', { target: page.$('#palette-q') });
  await page.settle(0);
  assert.equal(page.window.location.hash, '#artifacts');
  assert.deepEqual(page.writes(), []);
});
