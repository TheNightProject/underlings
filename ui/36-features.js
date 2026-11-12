const FEATURE_HINTS = {
  tickets: 'your open Jira tickets, read through acli.',
  standup: 'yesterday and today, worked out from GitLab, Jira and your calendar.',
  qa: 'every ticket waiting for testing, joined to the MRs merged for it.',
  calendar: 'your meetings, read every five minutes, with a banner before each.',
  email: 'the threads in your inbox that need you, read through Claude Code.',
  slack: 'the Slack messages that need you, read through Claude Code.',
  game: 'XP and coins for the work you do, and an office to spend them on.',
  leaderboard: 'points for opening, reviewing and approving MRs, built when you ask.',
  artifacts: 'the artifacts you publish from Claude Code.',
};

async function setFeature(name, on) {
  if (await busyAct('/api/features', { feature: name, on }, 'feature:' + name)) Object.assign((state.features ??= {}), { [name]: on });
  render(true);
}

// The same switch shows in Features and in the feature's own group, so its id carries where it is drawn.
function featureSwitch(name, where = 'own') {
  const on = featureOn(name);
  const id = 'feature-' + where + '-' + name;
  return el('div', { class: 'setting' },
    el('label', { for: id }, where === 'own' ? 'On' : FEATURE_NAMES[name]),
    el('div', { class: 'control' }, el('button', { id, class: 'switch', role: 'switch', 'aria-checked': String(on), 'aria-disabled': ui.busy.has('feature:' + name) ? 'true' : null, onclick: () => setFeature(name, !on) },
      el('span', { class: 'knob' }), on ? 'On' : 'Off')),
    el('p', { class: 'hint' }, where === 'own' ? 'Off takes it off the rail and stops what it reads in the background.' : FEATURE_HINTS[name].charAt(0).toUpperCase() + FEATURE_HINTS[name].slice(1)));
}

function featureSettingsGroup() {
  return el('section', { class: 'section settings-group', id: 'feature-settings' }, el('h2', {}, 'Features'),
    el('p', { class: 'hint' }, 'What the rail shows. A feature that is off leaves the rail and does no work in the background.'),
    Object.keys(FEATURE_NAMES).map((name) => featureSwitch(name, 'all')));
}

function artifactSettingsGroup() {
  return el('section', { class: 'section settings-group', id: 'artifact-settings' }, el('h2', {}, 'Artifacts'), featureSwitch('artifacts'));
}
