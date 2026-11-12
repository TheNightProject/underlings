const PROFILE_FIELDS = {
  name: { label: 'Name', placeholder: 'blank, so prompts say you', hint: 'What prompts call you when they speak of you. Blank, they say "you".', read: (p) => p.name },
  language: { label: 'Language', placeholder: 'your own language', hint: 'The language prompts ask replies, reasons, tickets and review findings to be written in, such as British English. Blank leaves it to your own.', read: (p) => p.style.language },
  rules: { label: 'Writing rules', placeholder: 'none', hint: 'Added to every prompt that writes for you, such as "No em dashes." A rule against em dashes also takes them out of the replies and tickets Claude writes.', read: (p) => p.style.rules },
};
const profileBox = { data: null, error: null, loading: null, at: null, answered: false, saving: false, card: null, drafts: {} };

function profileLoad() {
  profileBox.loading ??= api('/api/profile')
    .then((data) => Object.assign(profileBox, { data, error: null }), (e) => { profileBox.error = e.message; })
    .finally(() => {
      profileBox.loading = null;
      nameAskPlain();
      render(true);
    });
  return profileBox.loading;
}

// A window the app opens for one thing, such as Claude Code's terminal, leaves the asking to the page itself.
function nameAskDue() {
  return Boolean(profileBox.data?.ask) && !profileBox.answered && !new URLSearchParams(location.search).has('window');
}

// Built once and left alone by render(), so typing into it never loses the caret.
function nameAskForm() {
  const input = el('input', {
    id: 'name-ask-input', type: 'text', value: profileBox.data?.suggested ?? '', maxlength: '60', autocomplete: 'given-name', spellcheck: 'false', 'aria-describedby': 'name-ask-why',
    onkeydown: (e) => nameAskKeys(e, input),
  });
  return el('div', { class: 'name-ask-form', role: 'group', 'aria-labelledby': 'name-ask-q' },
    el('label', { id: 'name-ask-q', class: 'name-ask-q', for: 'name-ask-input' }, 'What should we call you?'),
    el('div', { class: 'name-ask-row' }, input,
      el('button', { id: 'name-ask-save', type: 'button', class: 'primary', onclick: () => nameAskAnswer({ name: input.value }) }, 'Save'),
      el('button', { id: 'name-ask-skip', type: 'button', class: 'linkish', onclick: () => nameAskAnswer({ skip: true }) }, 'Skip')),
    el('p', { id: 'name-ask-why', class: 'name-ask-why' }, 'Prompts use it when they speak of you. Skip, and they say "you" until you set it in Settings.'));
}

function nameAskKeys(e, input) {
  if (e.key !== 'Enter' && e.key !== 'Escape') return;
  e.preventDefault();
  nameAskAnswer(e.key === 'Enter' ? { name: input.value } : { skip: true });
}

// An empty name is a skip, and a save that fails still lets the page go on: it asks again on the next load.
async function nameAskAnswer(patch) {
  if (profileBox.saving) return;
  profileBox.saving = true;
  const asked = patch.name !== undefined && !patch.name.trim() ? { skip: true } : patch;
  try {
    profileBox.data = await api('/api/profile', asked);
    toast(profileBox.data.text);
  } catch (e) {
    toast('Could not save your name: ' + e.message, true);
  }
  Object.assign(profileBox, { saving: false, answered: true, drafts: {} });
  nameAskClose();
}

function nameAskClose() {
  profileBox.card?.remove();
  profileBox.card = null;
  slot('introNameDone');
  render(true);
}

// With the intro off, or once it has gone without asking, the same field sits in a corner of the page and blocks nothing.
function nameAskPlain() {
  if (!nameAskDue() || profileBox.card || slot('introPlaying')) return;
  profileBox.card = el('section', { id: 'name-ask', class: 'name-ask name-ask-card', 'aria-label': 'Your name' }, nameAskForm());
  document.body.append(profileBox.card);
  document.getElementById('name-ask-input')?.focus({ preventScroll: true });
}

function profileSettingsGroup() {
  if (profileBox.at !== state.generatedAt && !profileBox.loading) {
    profileBox.at = state.generatedAt;
    profileLoad();
  }
  const data = profileBox.data;
  return el('section', { class: 'section settings-group', id: 'profile-settings' }, el('h2', {}, 'You'),
    !data && profileBox.error ? banner('Could not read your profile: ' + profileBox.error, true) : null,
    data ? Object.keys(PROFILE_FIELDS).map((key) => profileRow(key, data)) : empty('Reading your profile…'));
}

function profileRow(key, data) {
  const field = PROFILE_FIELDS[key];
  const saved = field.read(data) ?? '';
  const draft = profileBox.drafts[key];
  const value = draft ?? saved;
  const save = () => profileSave(key, value);
  return el('div', { class: 'setting' }, el('label', { for: 'profile-' + key }, field.label),
    el('div', { class: 'control' },
      el('input', {
        id: 'profile-' + key, type: 'text', value, placeholder: field.placeholder, spellcheck: 'false', autocomplete: 'off', readonly: profileBox.saving,
        oninput: (e) => { profileBox.drafts[key] = e.target.value; render(true); },
        onkeydown: (e) => { if (e.key === 'Enter' && draft !== undefined) save(); },
      }),
      draft !== undefined && draft !== saved ? button('Save', 'check', save, true) : null),
    el('p', { class: 'hint' }, field.hint));
}

async function profileSave(key, value) {
  if (profileBox.saving) return;
  profileBox.saving = true;
  try {
    profileBox.data = await api('/api/profile', { [key]: value });
    delete profileBox.drafts[key];
    toast(profileBox.data.text);
  } catch (e) {
    toast(e.message, true);
  }
  profileBox.saving = false;
  render(true);
}

if (typeof requestAnimationFrame === 'function') profileLoad();
