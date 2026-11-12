const SELF_RELOAD_KEY = 'cc-reloaded-at';
const HEAL_RETRY_MS = 2000;
let healTimer = null;

function rebuildButton() {
  const busy = ui.busy.has('rebuild');
  return el('button', { class: 'primary', disabled: busy, title: 'Runs npm run build in the engine folder it loads from, then loads the new build here', onclick: rebuildMatrix },
    icon(busy ? 'clock' : 'wrench'), busy ? el('span', { class: 'rebuild-elapsed' }, rebuildLabel()) : 'Rebuild the engine');
}

function rebuildLabel() {
  return 'Rebuilding… ' + Math.round((Date.now() - ui.rebuildAt) / 1000) + ' s';
}

// Rebuild is toasted too because a drawer makes the rail inert, but only once, or a panel that polls would keep the toast up.
function onStaleEngine(e) {
  if (!ui.staleEngine) toast(e.message, true, rebuildButton());
  ui.staleEngine = true;
}

function railRebuild(m) {
  const unloaded = !m.available && m.error !== 'starting';
  return ui.staleEngine || unloaded ? rebuildButton() : null;
}

async function rebuildMatrix() {
  ui.rebuildAt = Date.now();
  toast('Rebuilding the review engine, then loading the new build.', false, el('span', { class: 'rebuild-elapsed' }, rebuildLabel()));
  const tick = setInterval(() => { for (const n of document.querySelectorAll('.rebuild-elapsed')) n.textContent = rebuildLabel(); }, 1000);
  try {
    if (await busyAct('/api/rebuild', {}, 'rebuild')) ui.staleEngine = false;
  } finally {
    clearInterval(tick);
  }
}

function gitlabBanner(error) {
  const busy = ui.busy.has('gitlab-retry');
  const tokenTrouble = /GITLAB_TOKEN|401|403|unauthori[sz]ed|invalid.token|insufficient.scope/i.test(error);
  return healable(banner('GitLab: ' + error, true, el('div', { class: 'actions heal' },
    el('button', { disabled: busy, onclick: retryGitLab }, icon('refresh'), busy ? 'Retrying…' : 'Retry'),
    tokenTrouble ? tokenField() : null,
    tokenTrouble ? el('a', { class: 'fix-link', ...inPage('#setup') }, icon('list-checks'), 'Set up') : null)));
}

function retryGitLab() {
  return busyAct('/api/gitlab/retry', {}, 'gitlab-retry');
}

// GitHub's own card, so its failing never covers GitLab's rows or reads as GitLab failing.
function githubBanner(error) {
  const busy = ui.busy.has('github-retry');
  const tokenTrouble = /token|401|single sign-on/i.test(error);
  return healable(banner(githubSays(error), true, el('div', { class: 'actions heal' },
    el('button', { disabled: busy, onclick: retryGitHub }, icon('refresh'), busy ? 'Retrying…' : 'Retry GitHub'),
    tokenTrouble ? el('a', { class: 'fix-link', ...inPage('#setup') }, icon('list-checks'), 'Set up') : null)));
}

function retryGitHub() {
  return busyAct('/api/github/retry', {}, 'github-retry');
}

function tokenField() {
  return el('div', { class: 'token-field' },
    el('input', {
      type: 'password', id: 'gitlab-token', placeholder: 'Paste a GitLab token', 'aria-label': 'GitLab personal access token', autocomplete: 'off', spellcheck: 'false',
      value: ui.gitlabToken ?? '', oninput: (e) => { ui.gitlabToken = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') saveToken(); },
    }),
    el('button', { disabled: ui.busy.has('gitlab-token'), onclick: saveToken }, icon('lock'), ui.busy.has('gitlab-token') ? 'Saving…' : 'Save token'),
    el('span', { class: 'meta' }, 'Kept in ~/.config/' + APP_FOLDER + '/gitlab-token, readable only by you, and used instead of the one in your shell profile.'));
}

async function saveToken() {
  const token = (ui.gitlabToken ?? '').trim();
  if (!token) return toast('Paste a token first.', true);
  if (await busyAct('/api/gitlab/token', { token }, 'gitlab-token')) ui.gitlabToken = '';
}

// Runs on every render, so a page that changed underneath reloads the moment nothing is open or half typed.
function versionCheck(version) {
  if (pageChanged() && pageIdle() && mayReloadNow()) location.reload();
  if (!(version?.worker > version?.started)) return null;
  return el('span', { class: 'off changed', title: 'Only a change to worker.mjs needs this; everything else reloads in place' },
    state.shell === 'app' ? 'The worker has changed. Quit the app and open it again.' : 'The worker has changed. In Orca, Settings, Plugins, turn ' + APP_NAME + ' off and on.');
}

function pageIdle() {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  const telling = !document.getElementById('toast').hidden;
  return !typing && !telling && !ui.mr && !ui.ticket && !ui.file && !ui.armed && !ui.menu && !ui.cleanup && !ui.busy.size && !ui.editing.size && !ui.drafts.size;
}

// A file still being written could otherwise reload the page over and over.
function mayReloadNow() {
  try {
    if (Date.now() - (Number(sessionStorage.getItem(SELF_RELOAD_KEY)) || 0) < 15000) return false;
    sessionStorage.setItem(SELF_RELOAD_KEY, String(Date.now()));
  } catch {}
  return true;
}

function onStale(e) {
  const reconnecting = e.status === 403;
  const down = e.status === undefined && /Failed to fetch|NetworkError|Load failed/.test(e.message);
  if (!reconnecting && !down) return false;
  clearTimeout(healTimer);
  healTimer = setTimeout(refresh, HEAL_RETRY_MS);
  showStale(reconnecting ? 'Reconnecting…' : 'Waiting for the worker', reconnecting
    ? 'This tab carries an old link. ' + APP_NAME + ' points it at the current one when its worker starts, and this page keeps trying until then.'
    : 'The ' + APP_NAME + ' worker is not answering. This page keeps trying, and carries on where it was once the worker is back.');
  return true;
}

function showStale(title, detail) {
  const node = healable(banner(el('b', {}, title), true, ' ', detail));
  node.id = 'stale';
  node.setAttribute('role', 'status');
  const shown = document.getElementById('stale');
  if (shown) shown.replaceWith(node);
  else document.getElementById('main').prepend(node);
}

function healable(node) {
  node.classList.add('healable');
  return node;
}

// Views pass a stand-in matrix while the engine is missing, so the reason is read from the state itself.
function engineBanner() {
  const error = state.matrix.error;
  if (error === 'starting') return banner('The review engine is loading.');
  return healable(banner('The review engine is not loaded: ' + (error || 'unknown error'), true, el('div', { class: 'actions heal' }, rebuildButton())));
}
