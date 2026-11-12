import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-12T12:00:00Z';
const MR = 'https://gitlab.com/acme/tooling/dashboard/-/merge_requests/21';
const UPDATES = { channel: 'main', count: 0, checkedAt: AT, checking: false, error: null, running: false, outcome: null };
const BANNER = { kind: 'updated', version: '1.1.0', commit: null, groups: { New: [`[Show release notes](${MR})`], Fixed: ['Stop the <img src=x onerror=alert(1)> loop'] }, more: 1 };

function snapshot(release = {}) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [],
    attention: { cards: [], agents: [], system: [], count: 0, prefs: {}, toasts: [], offers: [] },
    release: { version: '1.1.0', commit: 'c'.repeat(40), builtAt: AT, banner: null, ...release, updates: { ...UPDATES, ...release.updates } },
    matrix: {
      available: true, me: 'frank', paused: false, inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

function whatsNew(updates = {}, extra = {}) {
  return {
    version: '1.1.0', commit: 'c'.repeat(40), builtAt: AT, banner: null,
    changelog: {
      intro: '# Changelog\n\nWhat changed in each version.',
      sections: [
        { version: '1.1.0', date: '2026-11-12', body: `### New\n\n- [Show release notes](${MR})\n\n### Fixed\n\n- Stop the loop` },
        { version: '1.0.0', date: '2026-11-10', body: '### New\n\n- The first one' },
      ],
    },
    updates: { ...UPDATES, target: null, lines: null, leftOut: 0, repo: '/Users/frank/Projects/underlings', mode: 'app', job: null, ...updates },
    ...extra,
  };
}

async function page({ snap = snapshot(), view = whatsNew(), hash = 'overview' } = {}) {
  const posts = [];
  const p = await openPage({
    respond(path, init) {
      if (init?.method === 'POST') {
        posts.push([path, JSON.parse(init.body ?? 'null')]);
        return { ok: true, text: 'Done' };
      }
      if (path === '/api/whatsnew') return typeof view === 'function' ? view() : view;
      return null;
    },
  });
  p.window.navigator.platform = 'MacIntel';
  p.show(snap, hash);
  await p.settle(50);
  return Object.assign(p, { posts });
}

const texts = (nodes) => nodes.map((n) => n.textContent);
const buttonNamed = (p, label) => p.$$('#main button').find((b) => b.textContent === label);

test('the rail\'s foot says which version runs and how many updates wait, and both lead to What\'s new', async () => {
  const p = await page({ snap: snapshot({ updates: { count: 3 } }) });
  assert.deepEqual(p.$$('.release-foot a').map((a) => [a.textContent, a.getAttribute('href')]), [['Version 1.1.0', '#whats-new'], ['3 updates', '#whats-new']]);
  p.show(snapshot({ updates: { count: 3, running: true } }));
  assert.equal(p.$('.release-waiting').textContent, 'Updating…');
  p.show(snapshot());
  assert.equal(p.$$('.release-waiting').length, 0);
  p.show({ ...snapshot(), release: undefined });
  assert.equal(p.$$('.release-foot').length, 0, 'a worker from before versions shows nothing there');
});

test('a newer version brings a banner of its New and Fixed lines, safely rendered, which Dismiss puts away for good', async () => {
  const p = await page({ snap: snapshot({ banner: BANNER }) });
  const b = p.$('.release-banner');
  assert.match(b.textContent, /^Updated to 1\.1\.0New.*Show release notesFixedStop the <img src=x onerror=alert\(1\)> loopAnd 1 more change in What's new\./);
  assert.equal(b.querySelectorAll('img').length, 0, 'markup in a title stays text');
  assert.equal(b.querySelector('.md-link').getAttribute('title'), MR);
  assert.equal(b.querySelector('.release-link').getAttribute('href'), '#whats-new');
  b.querySelector('button[aria-label="Dismiss"]').click();
  assert.equal(p.$$('.release-banner').length, 0);
  assert.deepEqual(p.posts, [['/api/whatsnew/seen', {}]]);
  p.show(snapshot({ banner: BANNER }));
  assert.equal(p.$$('.release-banner').length, 0, 'it stays away while the worker catches up');
});

test('an update that did not install says so on every view and keeps its log in the state folder', async () => {
  const failed = { kind: 'failed', version: '1.1.0', commit: 'b'.repeat(40), wanted: 'c'.repeat(40), error: 'the app was still running after 120 s, so nothing was installed' };
  const p = await page({ snap: snapshot({ banner: failed }), view: whatsNew({}, { banner: failed }) });
  assert.match(p.$('.release-banner.warn').textContent, /The update did not install the app was still running after 120 s, so nothing was installed\. This is still 1\.1\.0\./);
  p.show(snapshot({ banner: failed }), 'whats-new');
  await p.settle(50);
  assert.match(p.$('#main').textContent, /The update to cccccccc did not install: .*update-install\.log/);
  assert.deepEqual(p.posts, [], 'a failure is only put away by Dismiss');
});

test('What\'s new renders each version of the changelog through the page\'s markdown, and marks the one running', async () => {
  const p = await page({ hash: 'whats-new' });
  assert.equal(p.$('#main h1').textContent, 'What\'s new');
  assert.match(p.$('#main .head p').textContent, /^Version 1\.1\.0, built from cccccccc/);
  const sections = p.$$('#main .release');
  assert.deepEqual(sections.map((s) => s.querySelector('h2').textContent), ['Version 1.1.012 November 2026Running', 'Version 1.0.010 November 2026']);
  assert.deepEqual(texts(sections[0].querySelectorAll('.md p strong')), ['New', 'Fixed']);
  assert.deepEqual(texts(sections[0].querySelectorAll('li')), ['Show release notes', 'Stop the loop']);
  assert.equal(sections[0].querySelector('.md-link').getAttribute('title'), MR);
  assert.doesNotMatch(p.$('#main').textContent, /# Changelog/);
});

test('opening What\'s new on a banner counts as reading it, once', async () => {
  const p = await page({ snap: snapshot({ banner: BANNER }), view: whatsNew({}, { banner: BANNER }), hash: 'whats-new' });
  assert.equal(p.$$('.release-banner').length, 0, 'no banner over the notes it points to');
  p.show(snapshot({ banner: BANNER }), 'whats-new');
  await p.settle(50);
  assert.deepEqual(p.posts.filter(([path]) => path === '/api/whatsnew/seen').length, 1);
});

test('waiting updates are listed as the release notes would be, and Update now takes two clicks', async () => {
  const lines = { New: [`[Show release notes](${MR})`], Fixed: [], Changed: ['Move a thing'], 'Look and feel': [] };
  const p = await page({ snap: snapshot({ updates: { count: 3 } }), view: whatsNew({ count: 3, lines, leftOut: 1, target: { ref: 'main', sha: 'd'.repeat(40) } }), hash: 'whats-new' });
  const section = p.$('#main .updates');
  assert.match(section.textContent, /3 updates on main since this build, checked .*NewShow release notesChangedMove a thingAnd 1 change that only touched tests, docs or tidying\./);
  assert.match(section.textContent, /Pulls main into \/Users\/frank\/Projects\/underlings and runs npm run setup and npm run build, builds the app, then quits/);
  const update = p.$('#g-update-now');
  update.click();
  assert.equal(p.$('#g-update-now').textContent, 'Update to main at dddddddd now?');
  assert.deepEqual(p.posts, []);
  p.$('#g-update-now').click();
  assert.deepEqual(p.posts, [['/api/updates/apply', {}]]);
});

test('Check for updates and the channel ask the worker, and a channel already picked asks nothing', async () => {
  const p = await page({ hash: 'whats-new' });
  buttonNamed(p, 'Check for updates').click();
  p.$('#channel-main').click();
  p.$('#channel-releases').click();
  await p.settle(50);
  assert.deepEqual(p.posts, [['/api/updates/check', {}], ['/api/updates/channel', { channel: 'releases' }]]);
  assert.match(p.$('#main .updates').textContent, /Up to date with main, checked/);
});

test('a first check says it is checking origin, and one that could not sign in says how to sign git in', async () => {
  const checking = { checking: true, checkedAt: null };
  const p = await page({ snap: snapshot({ updates: checking }), view: whatsNew(checking), hash: 'whats-new' });
  assert.match(p.$('#main .updates').textContent, /Checking origin for updates…/);
  assert.equal(p.$('#updates-check').getAttribute('title'), 'Check origin now for what has landed since this build');
  const signIn = 'git could not sign in to origin. While the repo is private, sign git in (gh auth setup-git or an SSH key).';
  const q = await page({ view: whatsNew({ error: signIn }), hash: 'whats-new' });
  assert.match(q.$('#main .updates').textContent, new RegExp(`Could not check for updates: ${signIn.replace(/[.()]/g, '\\$&')}`));
});

test('an update in progress shows the step and what it prints, holds the page from reloading, and its failure keeps the log', async () => {
  const job = { startedAt: 1, step: 'npm run setup', log: ['$ git pull --ff-only', 'Fast-forward', '$ npm run setup', 'added 99 packages'], outcome: null };
  const p = await page({ snap: snapshot({ updates: { running: true } }), view: whatsNew({ running: true, job }), hash: 'whats-new' });
  assert.match(p.$('.updates-step').textContent, /Running npm run setup/);
  assert.equal(p.$('.updates-log').textContent, '$ git pull --ff-only\nFast-forward\n$ npm run setup\nadded 99 packages');
  assert.equal(p.run('ui.busy.has("updating")'), true);
  assert.equal(p.$$('#g-update-now').length, 0, 'no second update while one runs');
  const failed = { ...job, outcome: { ok: false, step: 'npm run build', error: 'npm run build failed with exit code 1' } };
  const q = await page({ view: whatsNew({ job: failed }), hash: 'whats-new' });
  assert.match(q.$('#main .updates').textContent, /The update stopped at npm run build: npm run build failed with exit code 1\. This version keeps running\./);
  assert.ok(q.$('.updates-log'));
  assert.equal(q.run('ui.busy.has("updating")'), false);
  const refused = { startedAt: 1, step: null, log: [], outcome: { ok: false, refused: true, error: '/repo is on feat/x, not main, so nothing was changed. Switch it to main first.' } };
  const r = await page({ view: whatsNew({ job: refused }), hash: 'whats-new' });
  assert.match(r.$('#main .updates').textContent, /is on feat\/x, not main, so nothing was changed/);
});

test('the palette reaches What\'s new by its name or by changelog, and Update now only arms its button', async () => {
  const lines = { New: ['A thing'], Fixed: [], Changed: [], 'Look and feel': [] };
  const p = await page({ snap: snapshot({ updates: { count: 1 } }), view: whatsNew({ count: 1, lines, target: { ref: 'main', sha: 'd'.repeat(40) } }) });
  const labels = (query) => {
    p.run(`closePalette(false); openPalette(${JSON.stringify(query)}); paintPalette()`);
    return p.$$('#palette [role="option"]').map((o) => o.querySelector('.palette-label').textContent);
  };
  assert.equal(labels('changelog')[0], 'What\'s new');
  assert.equal(labels('what')[0], 'What\'s new');
  assert.ok(labels('update').includes('Update Underlings now'));
  p.run('closePalette(false); openPalette("update underlings"); paintPalette()');
  p.fire(p.$('#palette-q'), 'keydown', { key: 'Enter' });
  for (let i = 0; i < 20 && !p.$('#g-update-now'); i += 1) await p.settle(30);
  await p.settle(50);
  assert.equal(p.window.location.hash, '#whats-new');
  assert.equal(p.$('#g-update-now').textContent, 'Update to main at dddddddd now?');
  assert.deepEqual(p.posts, [], 'armed, nothing sent');
  const q = await page();
  q.run('openPalette("update underlings"); paintPalette()');
  assert.ok(!q.$$('#palette [role="option"]').some((o) => /Update Underlings now/.test(o.textContent)), 'not offered with nothing waiting');
});
