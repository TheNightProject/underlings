const SETUP_MARKS = { pass: ['check-circle', 'Ready'], fail: ['alert', 'Needs you'], off: ['circle', 'Off'] };
const AGENT_COMMANDS = [
  ['reviewCommand', 'Review', 'Reviews an MR and queues what it finds for you. Your own command is run with the MR link after it.'],
  ['selfReviewCommand', 'Self-review', 'Checks an agent\'s own change before it pushes: the diff, the repo\'s checks and tests, a simpler shape.'],
  ['kickoffCommand', 'Kickoff', 'Takes a ticket from reading it to a Draft MR. Your own command is run with the ticket key after it.'],
];

function setupBox() {
  ui.setup ??= { data: null, error: null, loading: false, drafts: {} };
  return ui.setup;
}

async function loadSetup() {
  const box = setupBox();
  box.loading = true;
  render(true);
  try {
    box.data = await api('/api/setup');
    box.error = null;
  } catch (e) {
    box.error = e.message;
  }
  box.loading = false;
  render(true);
}

// The worker says when an install is new; the page goes there once a load, and only from where a fresh tab starts.
function openSetupOnFirstRun(setup) {
  if (!setup?.pending || ui.setupShown) return;
  ui.setupShown = true;
  if (!location.hash || location.hash === '#') slot('goTo', 'setup');
}

function viewSetup() {
  const box = setupBox();
  if (!box.data && !box.loading && !box.error) loadSetup();
  const checks = box.data?.checks ?? [];
  return [
    header('Set up', 'What the app needs to run your agents, and what is optional. Each check says how to put it right.', checkAgainButton(box)),
    box.error ? banner('Could not run the checks: ' + box.error, true) : null,
    !box.data ? el('p', { class: 'empty' }, icon('clock'), 'Checking…') : [setupSummary(checks), el('ol', { class: 'setup-list' }, checks.map(setupCheck)), setupDoneRow(box.data)],
  ];
}

function checkAgainButton(box) {
  return el('button', { id: 'setup-again', disabled: box.loading, onclick: loadSetup }, icon(box.loading ? 'clock' : 'refresh'), box.loading ? 'Checking…' : 'Check again');
}

function setupSummary(checks) {
  const needed = checks.filter((c) => !c.optional);
  const ready = needed.filter((c) => c.state === 'pass').length;
  const all = ready === needed.length;
  return el('p', { class: 'setup-summary' + (all ? ' all' : '') }, icon(all ? 'check-circle' : 'list-checks'),
    all ? 'Everything the app needs is ready.' : ready + ' of ' + needed.length + ' ready.',
    ' ', el('span', { class: 'setup-note' }, 'The app opens and reads your MRs with GitLab alone; the rest adds agents, tickets and artifacts.'));
}

function setupCheck(c) {
  const [mark, label] = SETUP_MARKS[c.state] ?? SETUP_MARKS.fail;
  return el('li', { class: 'setup-check s-' + c.state, id: 'setup-' + c.id },
    el('span', { class: 'setup-mark', 'aria-hidden': 'true' }, icon(mark)),
    el('div', { class: 'setup-body' },
      el('div', { class: 'setup-head' }, el('h2', {}, c.title), el('span', { class: 'setup-state' }, c.optional && c.state === 'off' ? 'Optional' : label)),
      el('p', { class: 'setup-detail' }, c.detail),
      slot(SETUP_FIXES[c.id], c)));
}

const SETUP_FIXES = { claude: 'setupClaudeFix', gitlab: 'setupGitlabFix', github: 'setupGithubFix', jira: 'setupJiraFix', workspace: 'setupWorkspaceFix', agents: 'setupAgentsFix', hook: 'setupHookFix' };
const GITHUB_SOURCE_WORDS = { saved: 'pasted here', GITHUB_TOKEN: 'GITHUB_TOKEN', GH_TOKEN: 'GH_TOKEN', gh: 'gh' };

function setupClaudeFix(c) {
  if (c.state === 'pass') return null;
  return el('div', { class: 'setup-fix' }, c.command ? setupCommand(c.command) : null, c.link ? outside(c.link, 'How to install Claude Code', !c.command) : null);
}

function setupCommand(command) {
  return el('span', { class: 'setup-command' }, el('code', {}, command),
    el('button', { type: 'button', title: 'Copy it, then run it in a terminal', onclick: async () => toast((await copyText(command)) ? 'Copied: run it in a terminal' : 'Could not copy it', false) }, icon('copy'), 'Copy'));
}

function setupField(id, label, value, placeholder, save, busyId) {
  const box = setupBox();
  const draft = box.drafts[id] ?? value ?? '';
  return el('span', { class: 'setup-field' },
    label ? el('label', { class: 'offscreen', for: id }, label) : null,
    el('input', { id, type: id.endsWith('token') ? 'password' : 'text', value: draft, placeholder, spellcheck: 'false', autocomplete: 'off',
      oninput: (e) => { box.drafts[id] = e.target.value; }, onkeydown: (e) => { if (e.key === 'Enter') save(box.drafts[id] ?? draft); } }),
    el('button', { type: 'button', disabled: ui.busy.has(busyId), onclick: () => save(box.drafts[id] ?? draft) }, icon('check'), ui.busy.has(busyId) ? 'Saving…' : 'Save'));
}

async function setupSaved(answer, id) {
  if (!answer) return;
  delete setupBox().drafts[id];
  await loadSetup();
}

function setupGitlabHost(c) {
  const own = c.host && c.host !== c.defaultHost ? c.host : '';
  return [setupField('setup-gitlab-host', 'GitLab host', own, c.defaultHost ?? 'https://gitlab.com', saveSettingFrom('gitlab.host', 'setup-gitlab-host'), 'setup-gitlab.host'),
    el('p', { class: 'hint' }, 'Blank for gitlab.com, or where your own GitLab lives.')];
}

function setupGitlabFix(c) {
  if (c.state === 'pass') return el('div', { class: 'setup-fix' }, outside(c.link, 'Make another token'), setupGitlabHost(c));
  const save = async (token) => {
    if (!String(token).trim()) return toast('Paste a token first.', true);
    setupSaved(await busyAct('/api/gitlab/token', { token: String(token).trim() }, 'setup-token'), 'setup-token');
  };
  return el('div', { class: 'setup-fix' },
    outside(c.link, 'Make a token with the ' + c.scope + ' scope', true),
    setupField('setup-token', 'GitLab personal access token', '', 'Paste the token', save, 'setup-token'),
    el('p', { class: 'hint' }, 'Kept in ~/.config/' + APP_FOLDER + '/gitlab-token, readable only by you.'),
    setupGitlabHost(c));
}

// Opt in only: the switch is the one way on, whatever gh says.
function setupGithubFix(c) {
  const busy = ui.busy.has('setup-github.on');
  const flip = async () => setupSaved(await matrixAct('settings', { patch: { 'github.on': !c.on } }, 'setup-github.on'), 'setup-github-on');
  return el('div', { class: 'setup-fix setup-github' },
    el('button', { id: 'setup-github-on', class: 'switch', role: 'switch', 'aria-checked': String(Boolean(c.on)), 'aria-disabled': busy ? 'true' : null, onclick: flip },
      el('span', { class: 'knob' }), c.on ? 'On' : 'Off'),
    c.on ? githubTokenFacts(c) : null,
    c.on && c.state !== 'pass' ? githubTokenFix(c) : null);
}

function githubTokenFacts(c) {
  if (!c.source) return null;
  const scopes = c.scopes ? (c.scopes.length ? c.scopes.join(', ') : 'none') : 'not listed, as for any fine-grained token';
  return el('dl', { class: 'kv setup-facts' },
    el('dt', {}, 'Token from'), el('dd', {}, GITHUB_SOURCE_WORDS[c.source] ?? c.source),
    el('dt', {}, 'Signed in as'), el('dd', {}, c.user ?? 'unknown'),
    el('dt', {}, 'Scopes'), el('dd', {}, scopes, c.missing?.length ? el('span', { class: 'meta bad' }, ' (needs ' + c.missing.join(', ') + ')') : null));
}

function githubTokenFix(c) {
  const save = async (token) => {
    if (!String(token).trim()) return toast('Paste a token first.', true);
    setupSaved(await busyAct('/api/github/token', { token: String(token).trim() }, 'setup-github-token'), 'setup-github-token');
  };
  return [
    c.command ? setupCommand(c.command) : null,
    c.link ? outside(c.link, 'Make a token with ' + (c.needs ?? ['repo', 'read:org']).join(' and '), !c.command) : null,
    setupField('setup-github-token', 'GitHub token', '', 'Paste a token', save, 'setup-github-token'),
    el('p', { class: 'hint' }, 'Kept in ~/.config/' + APP_FOLDER + '/github-token, readable only by you, and used before GITHUB_TOKEN, GH_TOKEN and gh.'),
  ];
}

function saveSettingFrom(key, id) {
  return async (value) => setupSaved(await matrixAct('settings', { patch: { [key]: String(value).trim() } }, 'setup-' + key), id);
}

function setupJiraFix(c) {
  const missingAcli = c.state === 'fail' && !c.command;
  return el('div', { class: 'setup-fix' },
    setupField('setup-jira', 'Atlassian site', c.site, 'yours.atlassian.net', saveSettingFrom('jiraSite', 'setup-jira'), 'setup-jiraSite'),
    c.command ? setupCommand(c.command) : null,
    missingAcli ? outside(c.link, 'Install acli') : null);
}

function setupWorkspaceFix(c) {
  return el('div', { class: 'setup-fix' },
    setupField('setup-root', 'Workspace root', c.root, '/Users/you/code', saveSettingFrom('workspaceRoot', 'setup-root'), 'setup-workspaceRoot'),
    c.names?.length ? el('p', { class: 'hint setup-names' }, c.names.join(', ') + (c.checkouts > c.names.length ? ' and ' + (c.checkouts - c.names.length) + ' more' : '')) : null);
}

function setupAgentsFix(c) {
  return el('div', { class: 'setup-fix setup-agents' }, agentCommandRows(c.commands ?? {}, 'setup-agent-', loadSetup));
}

// Shared with Settings, so a command saved in one shows in the other.
function agentCommandRows(commands, prefix, after) {
  return AGENT_COMMANDS.map(([key, label, hint]) => agentCommandRow({ key, label, hint, own: commands[key], id: prefix + key, after }));
}

function agentCommandRow({ key, label, hint, own, id, after }) {
  const busyId = 'agent:' + key;
  const save = async (value) => {
    if (!(await matrixAct('agent-commands', { agents: { [key]: String(value) } }, busyId))) return;
    delete setupBox().drafts[id];
    after?.();
  };
  return el('div', { class: 'setting' },
    el('label', { for: id }, label),
    el('div', { class: 'control' }, setupField(id, null, own, 'Built in', save, busyId), own ? el('button', { type: 'button', onclick: () => save('') }, icon('undo'), 'Use built in') : null),
    el('p', { class: 'hint' }, (own ? 'Your own: ' + own + '. ' : 'The built-in prompt. ') + hint));
}

function setupHookFix(c) {
  if (c.state === 'pass' || !c.entry) return null;
  const command = c.entry.hooks[0].command;
  const replaces = c.replaces ?? null;
  const install = async () => setupSaved(await busyAct('/api/setup/hook', { command, replaces }, 'setup-hook'), 'setup-hook');
  const busy = ui.busy.has('setup-hook');
  return el('div', { class: 'setup-fix setup-hook' },
    el('p', { class: 'hint' }, replaces ? 'Changes the command of the old entry under hooks, PostToolUse, in ' + c.file + ' to this one. Every other hook stays.' : 'Adds this one entry under hooks, PostToolUse, in ' + c.file + '. Every hook already there stays.'),
    el('pre', { class: 'setup-entry' }, JSON.stringify(c.entry, null, 2)),
    el('button', { type: 'button', class: 'primary', id: 'setup-hook-install', disabled: busy, onclick: install }, icon(replaces ? 'refresh' : 'plus'), busy ? (replaces ? 'Updating…' : 'Installing…') : (replaces ? 'Update the hook' : 'Install the hook')));
}

function setupDoneRow(data) {
  return el('div', { class: 'setup-done' },
    data.done ? el('span', { class: 'setup-note' }, 'Setup stays here, under Settings and Jump to.') : el('button', { id: 'setup-finish', onclick: finishSetupView }, icon('check'), 'Done for now'),
    el('a', { class: 'fix-link', ...inPage('#settings') }, icon('settings'), 'All settings'));
}

async function finishSetupView() {
  if (await busyAct('/api/setup/done', {}, 'setup-done')) {
    if (setupBox().data) setupBox().data.done = true;
    slot('goTo', 'overview');
  }
}

function setupSettingsGroup() {
  return el('section', { class: 'section settings-group', id: 'setup-settings' }, el('h2', {}, 'Setup'),
    el('p', { class: 'hint' }, 'Checks Claude Code, your GitLab token, GitHub, Jira, the workspace root, the agent commands and the artifact hook, with a fix for each.'),
    el('div', {}, el('a', { class: 'fix-link', ...inPage('#setup') }, icon('list-checks'), 'Open Setup')));
}

function agentSettingsGroup(data) {
  if (!data?.agents) return null;
  return el('section', { class: 'section settings-group', id: 'agent-settings' }, el('h2', {}, 'Agents'),
    el('p', { class: 'hint' }, 'Blank runs the built-in prompt. Anything else is a slash command or a prompt your own Claude Code knows.'),
    agentCommandRows(data.agents, 'set-agent-', () => { ui.settings.at = null; render(true); }));
}
