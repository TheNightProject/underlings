import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-05T12:00:00Z';

function snapshot(matrix = {}, version = {}) {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1, started: 2, ...version },
    agents: [],
    artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
      ...matrix,
    },
  };
}

function serve(page, snap, answer = () => ({ ok: true, text: 'done' })) {
  const writes = [];
  page.window.fetch = async (path, init = {}) => {
    if (init.method === 'POST') writes.push([path, JSON.parse(init.body)]);
    const reply = path === '/api/state' ? snap() : await answer(path, init);
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    return { ok: status === 200, status, json: async () => reply, text: async () => reply.message ?? '' };
  };
  return writes;
}

const buttons = (page, scope, label) => page.$$(scope + ' button').filter((b) => b.textContent.startsWith(label));
const stale = (page) => page.$('#stale')?.textContent ?? null;

// assert is never handed a page node: on a failure it would print the whole document it hangs from.
async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end && !check();) await new Promise((r) => setTimeout(r, 25));
  return check();
}

test('the engine banner offers Rebuild, which shows how long it has been building, then refreshes the page', async () => {
  const page = await openPage();
  const broken = snapshot({ available: false, error: 'could not load the review engine from /engine/dist/engine.js: Cannot find module' });
  let finish;
  const writes = serve(page, () => broken, (path) => (path === '/api/rebuild' ? new Promise((r) => { finish = () => r({ ok: true, text: 'Rebuilt the review engine in 4 s' }); }) : {}));
  page.show(broken, 'merge-requests');
  assert.match(page.$('#main .banner').textContent, /Cannot find module/);
  const [rebuild] = buttons(page, '#main', 'Rebuild the engine');
  rebuild.click();
  await page.settle(50);
  assert.deepEqual(writes, [['/api/rebuild', {}]]);
  const [busy] = buttons(page, '#main', 'Rebuilding');
  assert.match(busy.textContent, /^Rebuilding… \d+ s$/);
  assert.ok(busy.disabled);
  finish();
  await page.settle(300);
  assert.match(page.$('#toast').textContent, /Rebuilt the review engine in 4 s/);
  assert.equal(buttons(page, '#main', 'Rebuilding').length, 0);
});

test('an action refused because the engine is out of date offers Rebuild in its toast', async () => {
  const page = await openPage();
  const snap = snapshot();
  serve(page, () => snap, () => Object.assign(new Error('The review engine needs rebuilding: this build has no setApproval'), { status: 501 }));
  page.show(snap, 'merge-requests');
  page.run("matrixAct('approve', {}, 'approve')");
  await page.settle(50);
  assert.equal(buttons(page, '#toast', 'Rebuild the engine').length, 1);
});

test('a read refused by a stale build toasts Rebuild once, over the drawer, and keeps it on the rail until a rebuild succeeds', async () => {
  const page = await openPage();
  const snap = snapshot();
  const refused = 'The review engine needs rebuilding: this build has no fetchOneMr';
  let stale = true;
  const writes = serve(page, () => snap, (path) => {
    if (path.startsWith('/api/matrix/mr?')) return stale ? { status: 501, message: refused } : { status: 404, message: 'gone' };
    return path === '/api/rebuild' ? { ok: true, text: 'Rebuilt the review engine in 4 s and loaded it' } : {};
  });
  page.show(snap, 'merge-requests');
  assert.equal(buttons(page, '#health', 'Rebuild the engine').length, 0);
  page.run("openMr('acme/engine!7')");
  await page.settle(50);
  assert.match(page.$('#drawer').textContent, /this build has no fetchOneMr/);
  assert.match(page.$('#toast').textContent, /this build has no fetchOneMr/);
  assert.equal(buttons(page, '#toast', 'Rebuild the engine').length, 1);
  assert.equal(buttons(page, '#health', 'Rebuild the engine').length, 1);
  page.$('#toast').hidden = true;
  page.run('loadMr()');
  await page.settle(50);
  assert.ok(page.$('#toast').hidden, 'only the first refusal toasts');
  page.run('closeMr()');
  stale = false;
  buttons(page, '#health', 'Rebuild the engine')[0].click();
  await page.settle(300);
  assert.deepEqual(writes, [['/api/rebuild', {}]]);
  assert.match(page.$('#toast').textContent, /Rebuilt the review engine in 4 s/);
  assert.equal(buttons(page, '#health', 'Rebuild').length, 0);
});

test('the rail offers Rebuild while the engine is not loaded, but not while it is still starting', async () => {
  const page = await openPage();
  page.show(snapshot({ available: false, error: 'starting' }), 'overview');
  assert.equal(buttons(page, '#health', 'Rebuild the engine').length, 0);
  page.show(snapshot({ available: false, error: 'could not load the review engine from /engine/dist/engine.js: Cannot find module' }), 'overview');
  assert.equal(buttons(page, '#health', 'Rebuild the engine').length, 1);
});

test('nothing on the page offers to start the terminal app, whatever full auto is doing', async () => {
  const page = await openPage();
  const states = ['here', 'starting', 'handover', 'terminal', 'stopped'];
  for (const view of ['overview', 'full-auto', 'review-queue', 'review-runs']) {
    for (const s of states) {
      page.show(snapshot({ fullAuto: [{ username: 'ivan', level: 'comments' }], driver: { state: s, why: 'the review engine needs rebuilding', fix: 'rebuild', recent: [], problems: 0 } }), view);
      assert.doesNotMatch(page.$('#health').textContent + page.$('#main').textContent, /Start TheMatrix|start-matrix|thematrix/i, `${view} while ${s}`);
    }
  }
  assert.equal(page.$$('button').filter((b) => /^Start\b/.test(b.textContent)).length, 0);
});

test('a refused token shows one Reconnecting notice and keeps trying, and a worker that is down shows Waiting until it is back', async () => {
  const page = await openPage();
  const snap = snapshot();
  page.show(snap);
  let calls = 0;
  let fail = Object.assign(new Error('missing token'), { status: 403 });
  serve(page, () => {
    calls += 1;
    if (fail) throw fail;
    return snap;
  });
  page.run('refresh()');
  assert.ok(await until(() => calls >= 2), `tried ${calls} times`);
  assert.equal(page.$$('#main #stale').length, 1);
  assert.match(stale(page), /^Reconnecting…/);
  assert.doesNotMatch(page.$('#main').textContent, /Cmd J|Settings/);
  fail = new TypeError('Failed to fetch');
  const before = calls;
  assert.ok(await until(() => calls > before && /^Waiting for the worker/.test(stale(page))), stale(page));
  assert.equal(page.$$('#main #stale').length, 1);
  fail = null;
  assert.ok(await until(() => stale(page) === null), stale(page));
  assert.equal(page.$$('#main .banner').length, 0);
});

test('any other failure is not taken for a lost connection, so it is shown and not retried', async () => {
  const page = await openPage();
  page.show(snapshot());
  let calls = 0;
  serve(page, () => {
    calls += 1;
    throw Object.assign(new Error('the MR list has not loaded yet'), { status: 503 });
  });
  page.run('refresh()');
  await page.settle(2600);
  assert.equal(calls, 1);
  assert.equal(stale(page), null);
  assert.match(page.$('#main').textContent, /Could not load: the MR list has not loaded yet/);
});

test('a page whose files changed reloads itself once nothing is open or being typed, and not again within 15 s', async () => {
  const page = await openPage();
  let reloads = 0;
  const stored = new Map();
  page.window.location.reload = () => { reloads += 1; };
  page.window.sessionStorage = { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)) };
  page.show(snapshot(), 'merge-requests');
  assert.equal(reloads, 0);
  page.run('ui.bootVersion = 0.5');
  page.run("ui.mr = { key: 'acme/engine!7' }");
  page.run('render()');
  assert.equal(reloads, 0);
  page.run('ui.mr = null');
  page.run('ui.bootVersion = 1; render(); ui.bootVersion = 0.5');
  page.$('#main input[type=search]').focus();
  page.run('render(true)');
  assert.equal(page.document.activeElement.tagName, 'INPUT');
  assert.equal(reloads, 0);
  page.document.focused = null;
  page.run('render()');
  assert.equal(reloads, 1);
  page.run('render()');
  assert.equal(reloads, 1);
  stored.set('cc-reloaded-at', String(Date.now() - 16000));
  page.run('render()');
  assert.equal(reloads, 2);
});

test('a page whose files changed waits for the toast of a write it just made to go before it reloads itself', async () => {
  const page = await openPage();
  let reloads = 0;
  page.window.location.reload = () => { reloads += 1; };
  page.window.sessionStorage = { getItem: () => null, setItem() {} };
  const snap = snapshot();
  serve(page, () => snap, () => ({ status: 409, message: 'acme/engine!7 changed since you looked' }));
  page.show(snap, 'merge-requests');
  page.run('ui.bootVersion = 0.5');
  page.run("matrixAct('probe', {}, 'probe')");
  await page.settle(300);
  assert.match(page.$('#toast').textContent, /changed since you looked/);
  assert.equal(reloads, 0);
  page.$('#toast').hidden = true;
  page.run('render()');
  assert.equal(reloads, 1);
});

test('only a worker.mjs newer than the running worker asks for the plugin to be turned off and on', async () => {
  const page = await openPage();
  page.show(snapshot({}, { worker: 1, started: 2 }));
  assert.doesNotMatch(page.$('#health').textContent, /Settings/);
  page.show(snapshot({}, { worker: 3, started: 2 }));
  assert.match(page.$('#health').textContent, /The worker has changed\. In Orca, Settings, Plugins, turn Underlings off and on\./);
});

test('the very first GitLab error about the token shows the field to paste one, beside Retry and a link to Setup, and saves it', async () => {
  const page = await openPage();
  const missing = 'GITLAB_TOKEN is not set. Add it to your shell profile, or paste a token into Underlings.';
  const snap = snapshot({ inbox: { fetchedAt: null, loading: false, error: missing, repoCount: 0, rows: [] } });
  const writes = serve(page, () => snap, () => ({ ok: true, text: 'GitLab answered' }));
  page.show(snap, 'merge-requests');
  const field = page.$('#gitlab-token');
  assert.equal(field?.getAttribute('type'), 'password', 'no Retry needed first');
  assert.equal(buttons(page, '#main', 'Retry').length, 1);
  assert.ok(page.$$('#main .banner a.fix-link').some((a) => a.getAttribute('href') === '#setup' && a.textContent === 'Set up'));
  field.value = ' gl-fake-abcdefghijklmnopqrst ';
  page.fire(field, 'input');
  buttons(page, '#main', 'Save token')[0].click();
  await page.settle(50);
  assert.deepEqual(writes, [['/api/gitlab/token', { token: 'gl-fake-abcdefghijklmnopqrst' }]]);
  for (const refused of ['GitLab answered 401 Unauthorized', 'insufficient_scope: the token needs api']) {
    page.show(snapshot({ inbox: { fetchedAt: null, loading: false, error: refused, repoCount: 0, rows: [] } }), 'merge-requests');
    assert.ok(page.$('#gitlab-token'), refused);
  }
  page.show(snapshot({ inbox: { fetchedAt: null, loading: false, error: 'fetch failed: getaddrinfo ENOTFOUND gitlab.com', repoCount: 0, rows: [] } }), 'merge-requests');
  assert.equal(page.$('#gitlab-token'), null, 'a GitLab that is down is not a token to replace');
});
