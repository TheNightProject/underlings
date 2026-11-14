const WN_POLL_MS = 1000;
const WN_LOG_SHOWN = 300;
const WN_GROUPS = ['New', 'Fixed', 'Changed', 'Look and feel'];
const WN_CHANNELS = [['main', 'Every merge to main'], ['releases', 'Tagged releases only']];

function whatsNewBox() {
  ui.whatsNew ??= { data: null, error: null, loading: false, at: null, seen: null, dismissed: null };
  return ui.whatsNew;
}

// The worker says when anything moved, so the view reads again on every state it holds.
function whatsNewData(box) {
  if (box.at !== state.generatedAt && !box.loading) loadWhatsNew(box);
  return box.data;
}

async function loadWhatsNew(box) {
  Object.assign(box, { loading: true, at: state.generatedAt });
  try {
    box.data = await api('/api/whatsnew');
    box.error = null;
  } catch (e) {
    box.error = e.message;
  }
  box.loading = false;
  const running = Boolean(box.data?.updates?.running);
  if (running) ui.busy.add('updating');
  else ui.busy.delete('updating');
  if (running) setTimeout(() => { box.at = null; if (view() === 'whats-new') render(true); }, WN_POLL_MS);
  render(true);
}

function viewWhatsNew() {
  const box = whatsNewBox();
  const data = whatsNewData(box);
  if (data?.banner?.kind === 'updated') markReleaseSeen(box, data.banner);
  return [
    header('What\'s new', buildLine(data ?? state.release), checkUpdatesButton(data?.updates ?? state.release?.updates)),
    box.error ? banner('Could not read the release notes: ' + box.error, true) : null,
    data ? [installFailure(data), updatesSection(data), releaseNotes(data)] : el('p', { class: 'empty' }, icon('clock'), 'Reading the release notes…'),
  ];
}

function buildLine(info) {
  if (!info?.version) return 'What changed in each version, and whether a newer one is waiting.';
  const commit = info.commit ? ', built from ' + info.commit.slice(0, 8) + (info.builtAt ? ' ' + ago(info.builtAt) : '') : '';
  return 'Version ' + info.version + commit + '.';
}

function checkUpdatesButton(u) {
  const busy = Boolean(u?.checking) || ui.busy.has('updates-check');
  return el('button', { id: 'updates-check', disabled: busy || u?.running, title: 'Check origin now for what has landed since this build', onclick: checkForUpdates },
    icon(busy ? 'clock' : 'refresh'), busy ? 'Checking…' : 'Check for updates');
}

function checkForUpdates() {
  return busyAct('/api/updates/check', {}, 'updates-check');
}

// Opening the notes is reading them, so the banner that sent you here does not come back.
function markReleaseSeen(box, b) {
  const key = releaseKey(b);
  if (box.seen === key) return;
  box.seen = key;
  api('/api/whatsnew/seen', {}).catch((e) => toast(e.message, true)).finally(refresh);
}

const releaseKey = (b) => [b.kind, b.version, b.commit ?? ''].join(':');

function installFailure(data) {
  const b = data.banner;
  if (b?.kind !== 'failed') return null;
  return banner('The update to ' + b.wanted.slice(0, 8) + ' did not install: ' + b.error + '. This is still ' + b.version + '.', true, ' ',
    'The install helper\'s log is in ', el('code', {}, '~/.local/state/' + APP_FOLDER + '/update-install.log'), '.');
}

function updatesSection(data) {
  const u = data.updates ?? {};
  return el('section', { class: 'section updates' },
    el('h2', {}, icon('download'), 'Updates'),
    u.mode === 'release' ? null : el('div', { class: 'updates-channel' }, el('span', { class: 'updates-label' }, 'Channel'), chips(WN_CHANNELS, u.channel ?? 'main', setUpdateChannel, 'channel-')),
    updateStatus(u),
    u.count && !u.running ? updateOffer(u) : null,
    u.job ? updateJob(u) : null);
}

function setUpdateChannel(channel) {
  if (channel === whatsNewBox().data?.updates?.channel) return;
  return busyAct('/api/updates/channel', { channel }, 'channel');
}

function updateStatus(u) {
  if (u.checking && !u.checkedAt) return el('p', { class: 'empty' }, icon('clock'), 'Checking origin for updates…');
  if (u.error) return banner('Could not check for updates: ' + u.error, true);
  if (!u.checkedAt) return el('p', { class: 'empty' }, icon('clock'), 'Not checked yet. It checks a few minutes after starting, then every three hours.');
  const when = ', checked ' + ago(u.checkedAt) + '.';
  if (!u.count) return empty((u.channel === 'releases' ? 'No newer release' : 'Up to date with main') + when);
  const what = u.channel === 'releases' && u.target?.ref ? u.target.ref + ' is out: ' + plural(u.count, 'change') + ' since this build' : plural(u.count, 'update') + ' on main since this build';
  return el('div', { class: 'updates-incoming' }, el('p', { class: 'updates-what' }, el('b', {}, what), when), incomingLines(u));
}

function incomingLines(u) {
  const groups = WN_GROUPS.filter((name) => u.lines?.[name]?.length);
  const quiet = u.leftOut ? el('p', { class: 'release-more' }, 'And ' + plural(u.leftOut, 'change') + ' that only touched tests, docs or tidying.') : null;
  return [groups.map((name) => releaseGroup(name, u.lines[name])), quiet];
}

function releaseGroup(name, lines) {
  return el('div', { class: 'release-group' }, el('span', { class: 'release-tag', 'data-group': name }, name),
    el('ul', {}, lines.map((line) => el('li', {}, markdown(line)))));
}

// A copy installed from a release has no checkout to build in, so Homebrew brings the next one.
function updateOffer(u) {
  if (u.mode === 'release') return el('div', { class: 'updates-offer' }, el('p', { class: 'meta' }, 'To update, run ', el('code', {}, u.upgrade), ' in a terminal, then open the app again.'));
  const to = u.channel === 'releases' ? u.target?.ref : 'main at ' + (u.target?.sha ?? '').slice(0, 8);
  return el('div', { class: 'updates-offer' },
    guarded('update-now', 'Update now', 'download', 'Update to ' + to + ' now?', applyUpdate, true),
    el('p', { class: 'meta' }, updatePlan(u)));
}

function updatePlan(u) {
  const pull = u.channel === 'releases' ? 'Fast-forwards ' + u.repo + ' to ' + (u.target?.ref ?? 'the release') : 'Pulls main into ' + u.repo;
  const then = { app: ', builds the app, then quits, puts the new build in place and opens it again.', dev: '. Then quit the app and run npm start again.', plugin: '. Then Reload loads it.' }[u.mode] ?? '.';
  return pull + ' and runs npm run setup and npm run build' + then + ' A checkout that is dirty or not on main is left as it is.';
}

async function applyUpdate() {
  if (await busyAct('/api/updates/apply', {}, 'update-now')) ui.busy.add('updating');
  whatsNewBox().at = null;
  render(true);
}

function updateJob(u) {
  const { outcome, step, log = [] } = u.job;
  const shown = log.slice(-WN_LOG_SHOWN).join('\n');
  const printed = shown ? el('pre', { class: 'console updates-log', tabindex: '0', 'aria-label': 'What the update printed' }, el('span', {}, shown)) : null;
  if (u.running) return [el('p', { class: 'updates-step' }, icon('clock'), 'Running ', el('code', {}, step ?? 'the update'), '…'), printed];
  if (!outcome) return null;
  if (outcome.refused) return banner(outcome.error, true);
  if (!outcome.ok) return [banner('The update stopped at ' + (outcome.step ?? 'its first step') + ': ' + outcome.error + '. This version keeps running.', true), printed];
  return [banner(outcome.text, false, ' ', u.mode === 'plugin' ? reloadButton() : null), printed ? el('details', {}, el('summary', {}, 'What it printed'), printed) : null];
}

function releaseNotes(data) {
  if (!data.changelog) return banner('There is no CHANGELOG.md beside the worker, so there are no release notes to show.', true);
  const intro = data.changelog.intro.replace(/^# .*\n*/, '').trim();
  return [
    intro ? el('div', { class: 'release-intro' }, markdown(intro)) : null,
    data.changelog.sections.map((s) => el('section', { class: 'section release', id: 'release-' + s.version },
      el('h2', {}, 'Version ' + s.version, s.date ? el('span', { class: 'meta' }, releaseDate(s.date)) : null, s.version === data.version ? el('span', { class: 'pill release-here' }, 'Running') : null),
      markdown(s.body))),
  ];
}

const releaseDate = (day) => dayText(day, { day: 'numeric', month: 'long', year: 'numeric' });

function releaseBanner() {
  const b = state?.release?.banner;
  if (!b || view() === 'whats-new' || whatsNewBox().dismissed === releaseKey(b)) return null;
  const actions = el('div', { class: 'actions' },
    el('a', { class: 'release-link', ...inPage('#whats-new') }, 'What\'s new'),
    el('button', { class: 'icon-only', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => dismissRelease(b) }, icon('x')));
  return b.kind === 'failed' ? failedReleaseBanner(b, actions) : updatedReleaseBanner(b, actions);
}

function failedReleaseBanner(b, actions) {
  return el('div', { class: 'banner warn release-banner', role: 'status' }, icon('alert'),
    el('div', { class: 'release-body' }, el('b', {}, 'The update did not install'), ' ', b.error + '. This is still ' + b.version + '.'), actions);
}

function updatedReleaseBanner(b, actions) {
  const groups = WN_GROUPS.filter((name) => b.groups?.[name]?.length);
  return el('div', { class: 'banner release-banner', role: 'status' }, icon('sparkles'),
    el('div', { class: 'release-body' },
      el('b', {}, 'Updated to ' + b.version + (b.commit ? ' at ' + b.commit.slice(0, 8) : '')),
      groups.map((name) => releaseGroup(name, b.groups[name])),
      b.more ? el('p', { class: 'release-more' }, 'And ' + plural(b.more, 'more change') + ' in What\'s new.') : null),
    actions);
}

function dismissRelease(b) {
  whatsNewBox().dismissed = releaseKey(b);
  render(true);
  api('/api/whatsnew/seen', {}).catch((e) => toast(e.message, true)).finally(refresh);
}

function releaseFooter(release) {
  if (!release?.version) return null;
  const u = release.updates ?? {};
  if (!u.running) ui.busy.delete('updating');
  const waiting = u.running ? 'Updating…' : u.count ? plural(u.count, 'update') : null;
  return el('div', { class: 'release-foot' },
    el('a', { class: 'release-version', title: 'What\'s new in this version', ...inPage('#whats-new') }, 'Version ' + release.version),
    waiting ? el('a', { class: 'release-waiting', title: 'What has landed since this build', ...inPage('#whats-new') }, waiting) : null);
}
