import { engine, failure, requireEngine, supports } from './engine.mjs';
import { DEFAULT, effectiveModels, EFFORTS, everyEffortOf, freshModels, MODELS, modelArgs, modelName, modelsOf, SAME, suggestedModels, takesEffort, takesForce, TASK_EFFORTS, taskLaunch, TASKS } from './modeltiers.mjs';

let shell = {};

export const ROUTES = {
  'GET /api/models': () => view(),
  'POST /api/models': async ({ body }) => save(await body()),
};

export function start(cfg, sh) {
  shell = sh ?? {};
}

const savedSettings = () => (supports('loadSettings') ? engine.loadSettings() : null);

function launchModels() {
  const saved = savedSettings();
  return effectiveModels(modelsOf(saved?.models), saved?.everyEffort);
}

export const taskChoice = (task) => launchModels()[task];
export const taskArgs = (task) => modelArgs(taskChoice(task));
export const panelLaunch = () => taskLaunch(launchModels(), 'panel');

// In the app the panel is Claude Code in a terminal, which writes no turn of its own here.
const terminalPanel = () => typeof shell.desktop?.openTerminal === 'function';

function uncounted(key) {
  if (key === 'builders') return 'counted in the agent that spawned them';
  return key === 'panel' && terminalPanel() ? 'not counted while the panel runs Claude Code in a terminal' : null;
}

export function view() {
  const saved = savedSettings();
  const models = modelsOf(saved?.models);
  const [fresh, suggested] = [freshModels(), suggestedModels()];
  const usage = supports('modelUsage') ? engine.modelUsage() : null;
  const tasks = TASKS.map(({ key, label, hint }) => ({
    key, label, hint, effort: takesEffort(key), force: takesForce(key), current: models[key], fresh: fresh[key], suggested: suggested[key], tokens: usage ? usage.tokens[key] ?? 0 : null, uncounted: uncounted(key),
  }));
  return { tasks, models: MODELS, efforts: EFFORTS, taskEfforts: TASK_EFFORTS, everyEffort: everyEffortOf(saved?.everyEffort), usageDays: usage?.days ?? null };
}

const PRESETS_SAID = {
  suggested: 'Each task runs on its suggested model, at the effort for every task, from its next start',
  default: 'Each task runs on Claude Code\'s default model and effort from its next start',
};
const effortWords = (effort) => {
  if (effort === SAME) return 'the effort for every task';
  return effort === DEFAULT ? 'Claude Code\'s default effort' : `${EFFORTS.find(([id]) => id === effort)[1].toLowerCase()} effort`;
};

const forceSaid = (label, force) => `${label} ${force ? 'override a subagent\'s own model' : 'leave a subagent\'s own model alone'} from their next start`;

function savedSaid({ task, model, effort, force }) {
  const label = TASKS.find((t) => t.key === task).label;
  if (force !== undefined) return forceSaid(label, force);
  const on = [model === undefined ? null : modelName(model), effort === undefined ? null : effortWords(effort)].filter(Boolean).join(' at ');
  return `${label} runs on ${on} from its next start`;
}

const everySaid = (effort) => `Every task set to Same as every task runs on ${effortWords(effort)} from its next start`;

function savedText(body) {
  if (body.preset !== undefined) return PRESETS_SAID[body.preset];
  if (body.every !== undefined) return everySaid(body.every);
  const current = taskChoice(body.task) ?? {};
  return savedSaid({ task: body.task, model: body.model === undefined ? undefined : current.model, effort: body.effort, force: body.force });
}

function save(body = {}) {
  const { applyModelPreset, saveEveryEffort, saveModel } = requireEngine('saveModel', 'applyModelPreset', 'saveEveryEffort');
  try {
    if (body.preset !== undefined) applyModelPreset(body.preset);
    else if (body.every !== undefined) saveEveryEffort(body.every);
    else saveModel(body.task, { model: body.model, effort: body.effort, force: body.force });
  } catch (err) {
    throw failure(400, err.message);
  }
  return { ok: true, text: savedText(body), ...view() };
}

const count = (n) => (Number.isFinite(n) && n > 0 ? n : 0);

// Counted as the game counts a transcript: fresh input, cache writes and output, across every model the run used.
export function resultTokens(result) {
  const byModel = result?.modelUsage;
  if (byModel && typeof byModel === 'object') return Object.values(byModel).reduce((sum, m) => sum + count(m?.inputTokens) + count(m?.cacheCreationInputTokens) + count(m?.outputTokens), 0);
  const u = result?.usage ?? {};
  return count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.output_tokens);
}

export function noteUsage(task, result) {
  if (!task || !result || !supports('recordUsage')) return;
  try {
    engine.recordUsage(task, resultTokens(result));
  } catch {}
}
