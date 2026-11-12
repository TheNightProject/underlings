const MODEL_WORDS = { default: 'Claude Code\'s default', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const MODEL_FAMILY = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)(?:-\d{8})?$/;
const MODEL_CUSTOM = 'custom';
const MODEL_SAME = 'same';
const modelsBox = { data: null, at: null, loading: false, error: null, custom: {} };

function modelWords(id) {
  if (!id) return MODEL_WORDS.default;
  if (MODEL_WORDS[id]) return MODEL_WORDS[id];
  const m = MODEL_FAMILY.exec(id);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) + ' ' + m[2] + '.' + m[3] : id;
}

const modelIsCustom = (id) => !MODEL_WORDS[id];
const modelSame = (a, b) => a.model === b.model && a.effort === b.effort;

function modelSettingsGroup() {
  const data = readOnce(modelsBox, '/api/models');
  return el('section', { class: 'section settings-group', id: 'model-settings' }, el('h2', {}, 'Models'),
    el('p', { class: 'hint' }, 'The model each kind of task starts on, and how hard it thinks. A run already going keeps its own. Claude Code\'s default is whatever your Claude Code picks, usually its most capable and dearest model.'),
    modelsBox.error ? banner('Could not read the models: ' + modelsBox.error, true) : null,
    data ? [modelEveryEffort(data), modelPresets(data), data.tasks.map((t) => modelRow(t, data))] : empty(modelsBox.error ? 'Nothing to show yet.' : 'Reading the models…'));
}

function modelEveryEffort(data) {
  return el('div', { class: 'setting model-every', id: 'model-every' },
    el('label', { for: 'model-every-' + data.everyEffort }, 'Effort for every task'),
    el('div', { class: 'control' }, chips(data.efforts, data.everyEffort, (value) => { if (value !== data.everyEffort) modelSave({ every: value }); }, 'model-every-')),
    el('p', { class: 'hint' }, 'How hard each task set to Same as every task thinks. A task with its own effort keeps it, and Claude Code\'s default passes no effort, so Claude Code picks.'));
}

const modelEffortWords = (id, data) => data.efforts.find(([value]) => value === id)?.[1] ?? id;

function modelPresets(data) {
  const differs = data.tasks.filter((t) => !modelSame(t.current, t.suggested)).length;
  return el('div', { class: 'model-presets' },
    el('div', { class: 'actions' },
      guarded('models-suggested', 'Use suggested tiers', 'sparkles', 'Put every task on its suggested model, at the effort for every task?', () => modelSave({ preset: 'suggested' }), true),
      guarded('models-default', 'Reset to Claude Code\'s default', 'undo', 'Put every task and the effort for every task on Claude Code\'s default?', () => modelSave({ preset: 'default' }))),
    el('p', { class: 'hint' }, 'Suggested: Opus builds and fixes, Sonnet reviews and checks, Haiku does the mechanical work, and builders follow the agent that spawns them. Each task takes the effort for every task. ',
      differs ? plural(differs, 'task') + ' differ from it now.' : 'Every task is on it now.'));
}

function modelRow(t, data) {
  const picked = modelsBox.custom[t.key] !== undefined || modelIsCustom(t.current.model) ? MODEL_CUSTOM : t.current.model;
  return el('div', { class: 'setting model-row', id: 'model-row-' + t.key },
    el('label', { for: 'model-' + t.key + '-' + picked }, t.label),
    el('div', { class: 'control' },
      chips([...data.models, [MODEL_CUSTOM, 'Custom']], picked, (value) => modelPick(t, value), 'model-' + t.key + '-'),
      picked === MODEL_CUSTOM ? modelCustomField(t) : null,
      t.effort ? modelEffort(t, data) : null,
      modelSuggested(t),
      t.force ? modelForce(t) : null),
    el('p', { class: 'hint' }, t.hint.charAt(0).toUpperCase() + t.hint.slice(1), ' ', el('span', { class: 'model-usage', id: 'model-usage-' + t.key }, modelUsageWords(t, data))));
}

function modelPick(t, value) {
  if (value !== MODEL_CUSTOM) {
    delete modelsBox.custom[t.key];
    if (value !== t.current.model) modelSave({ task: t.key, model: value });
    else render(true);
    return;
  }
  modelsBox.custom[t.key] = modelIsCustom(t.current.model) ? t.current.model : '';
  render(true);
  byId('model-' + t.key + '-id')?.focus();
}

function modelCustomField(t) {
  const saved = modelIsCustom(t.current.model) ? t.current.model : '';
  const value = modelsBox.custom[t.key] ?? saved;
  const save = () => modelSave({ task: t.key, model: value.trim() });
  const cancel = () => {
    delete modelsBox.custom[t.key];
    render(true);
  };
  return [
    el('input', {
      id: 'model-' + t.key + '-id', type: 'text', class: 'model-id', value, placeholder: 'a full model ID', 'aria-label': t.label + ' model ID', spellcheck: 'false', autocomplete: 'off', readonly: ui.busy.has('models'),
      oninput: (e) => { modelsBox.custom[t.key] = e.target.value; render(true); },
      onkeydown: (e) => { if (e.key === 'Enter' && value.trim()) save(); if (e.key === 'Escape') cancel(); },
    }),
    value.trim() && value.trim() !== saved ? button('Save', 'check', save, true) : null,
  ];
}

function modelEffort(t, data) {
  return [
    el('label', { class: 'model-effort' }, 'Effort',
      el('select', { id: 'model-' + t.key + '-effort', disabled: ui.busy.has('models'), onchange: (e) => modelSave({ task: t.key, effort: e.target.value }) },
        data.taskEfforts.map(([id, label]) => el('option', { value: id, selected: id === t.current.effort }, label)))),
    t.current.effort === MODEL_SAME ? el('span', { class: 'model-effective', id: 'model-effective-' + t.key }, modelEffortWords(data.everyEffort, data) + ', from every task') : null,
  ];
}

function modelForce(t) {
  const on = Boolean(t.current.force);
  const id = 'model-' + t.key + '-force';
  return el('div', { class: 'model-force' },
    el('button', { id, type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(on), disabled: ui.busy.has('models'), onclick: () => modelSave({ task: t.key, force: !on }) },
      el('span', { class: 'knob' }), on ? 'On' : 'Off'),
    el('label', { for: id }, 'Force on every builder'),
    el('span', { class: 'model-force-hint' }, 'Overrides a subagent that picks its own model, so every builder runs on the one above. Does nothing while Builders is on Claude Code\'s default.'));
}

function modelSuggested(t) {
  const same = modelSame(t.current, t.suggested);
  const effort = [MODEL_SAME, 'default'].includes(t.suggested.effort) ? '' : ', ' + t.suggested.effort + ' effort';
  return el('span', { class: 'model-suggested' + (same ? '' : ' differs'), id: 'model-suggested-' + t.key, title: same ? 'On its suggested tier' : 'Not on its suggested tier' },
    'Suggested: ' + modelWords(t.suggested.model) + effort);
}

const modelTenths = (n) => String(Math.round(n * 10) / 10);
// Intl's compact notation differs between ICU builds (1.3M in Node, 1.3m in Chromium), so the units are fixed here.
const modelTokens = (n) => (n >= 1e6 ? modelTenths(n / 1e6) + 'M' : n >= 1e3 ? modelTenths(n / 1e3) + 'k' : String(n));

function modelUsageWords(t, data) {
  if (t.uncounted) return t.uncounted.charAt(0).toUpperCase() + t.uncounted.slice(1) + '.';
  if (t.tokens == null) return '';
  return (t.tokens ? modelTokens(t.tokens) + ' tokens' : 'No tokens') + ' in the last ' + data.usageDays + ' days.';
}

async function modelSave(payload) {
  const answer = await busyAct('/api/models', payload, 'models');
  if (!answer) return;
  if (payload.task) delete modelsBox.custom[payload.task];
  if (payload.preset) modelsBox.custom = {};
  modelsBox.data = { tasks: answer.tasks, models: answer.models, efforts: answer.efforts, taskEfforts: answer.taskEfforts, everyEffort: answer.everyEffort, usageDays: answer.usageDays };
  render(true);
}

const MODEL_EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const MODEL_TASK_NAMES = { review: 'Review', fix: 'Fix', kickoff: 'Kickoff', ticket: 'Ticket agent', message: 'Message agent', master: 'Claude panel' };

const modelAgentModel = (a) => modelWords(a.runningModel ?? a.model);
const modelAgentEffort = (a) => (MODEL_EFFORT_NAMES[a.effort] ?? 'Default') + ' effort';
const modelAgentTask = (a) => MODEL_TASK_NAMES[a.kind] ?? null;
const modelAgentBuilders = (a) => (a.subagentModel ? modelWords(a.subagentModel) + (a.subagentForce ? ', forced' : '') : null);

// The list and the window say what an agent runs on: what Claude Code said it started on, else what it was started with.
function modelAgentLine(a) {
  const builders = modelAgentBuilders(a);
  const facts = [modelAgentModel(a), modelAgentEffort(a), modelAgentTask(a), builders && 'builders on ' + builders].filter(Boolean);
  return el('span', { class: 'meta model-launch', title: modelAgentTitle(a) }, facts.map((fact, i) => [i ? ' ' : null, el('span', {}, fact)]));
}

function modelAgentTitle(a) {
  const effort = a.effort ? ', ' + modelAgentEffort(a).toLowerCase() : '';
  const builders = modelAgentBuilders(a);
  return 'Runs on ' + modelAgentModel(a) + effort + (builders ? '. Its subagents start on ' + builders + '.' : '.');
}
