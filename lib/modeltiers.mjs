// Read by the engine and the worker alike, so the model each task runs on is chosen and checked in one place.
export const DEFAULT = 'default';
export const MODELS = [[DEFAULT, "Claude Code's default"], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']];
export const EFFORTS = [[DEFAULT, "Claude Code's default"], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
export const SAME = 'same';
export const TASK_EFFORTS = [[SAME, 'Same as every task'], ...EFFORTS];
const SUBAGENT_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL';
const FORCE_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE';

export const TASKS = [
  { key: 'review', label: 'Review', hint: 'reviews someone else\'s MR and queues what it finds for you. Reads a whole diff: a long run.' },
  { key: 'fix', label: 'Fix', hint: 'acts on review findings, or fixes a failed pipeline or conflicts on your MR. Writes code: a long run.' },
  { key: 'kickoff', label: 'Kickoff', hint: 'takes a ticket to a Draft MR: plans, builds, tests and raises it. The longest run there is.' },
  { key: 'ticket', label: 'Ticket agent', hint: 'starts work on a ticket in a worktree cut for it, and raises the MR. Writes code: a long run.' },
  { key: 'message', label: 'Message agent', hint: 'acts on a Slack message or an email thread for you and proposes your reply. A short run.' },
  { key: 'panel', label: 'Claude panel', hint: 'the model a new chat in the Claude panel starts on. /model inside it still changes it.' },
  { key: 'builders', label: 'Builders', hint: 'the subagents an agent spawns, such as a kickoff\'s builders. One that names its own model keeps it unless forced below; Claude Code\'s default runs the rest on the agent\'s model.', subagents: true },
  { key: 'reads', label: 'Triage and reads', hint: 'reads Slack and email for what needs you, reads a Slack thread, and sends a reply you approved. Small and frequent.' },
  { key: 'ticketDrafts', label: 'Ticket drafts', hint: 'drafts a Jira ticket from a review thread, an email or a Slack message. One small answer.' },
  { key: 'replyDrafts', label: 'Reply drafts', hint: 'writes a suggested Slack reply for you to edit. One small answer.' },
];

export const TASK_KEYS = TASKS.map((t) => t.key);
export const taskOfKind = (kind) => (kind === 'master' ? 'panel' : kind);
export const takesForce = (task) => Boolean(TASKS.find((t) => t.key === task)?.subagents);
export const takesEffort = (task) => !takesForce(task);

// What every install ran before these were settings, so a fresh one costs the same until you choose.
const FRESH = { reads: 'haiku', ticketDrafts: 'haiku', replyDrafts: 'sonnet' };
// Opus builds and fixes, Sonnet reviews and checks, Haiku does the mechanical work; builders follow the agent that spawns them.
const SUGGESTED = { review: 'sonnet', fix: 'opus', kickoff: 'opus', ticket: 'opus', message: 'sonnet', panel: 'sonnet', builders: DEFAULT, reads: 'haiku', ticketDrafts: 'haiku', replyDrafts: 'sonnet' };

const everyTask = (modelOf) => Object.fromEntries(TASK_KEYS.map((key) => [key, { model: modelOf(key), effort: takesEffort(key) ? SAME : DEFAULT }]));
export const freshModels = () => everyTask((key) => FRESH[key] ?? DEFAULT);
export const suggestedModels = () => everyTask((key) => SUGGESTED[key]);
export const defaultModels = () => everyTask(() => DEFAULT);

// A model is an argument to claude and may be typed into a terminal, so it is a name and nothing that reads as a flag or a shell word.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,119}(?:\[[a-z0-9]{1,8}\])?$/;
const EFFORT_IDS = new Set(EFFORTS.map(([id]) => id));
const TASK_EFFORT_IDS = new Set(TASK_EFFORTS.map(([id]) => id));

export function modelId(text) {
  const typed = typeof text === 'string' ? text.trim() : '';
  return MODEL_ID.test(typed) ? typed : null;
}

export const effortId = (text) => (EFFORT_IDS.has(text) ? text : null);
export const taskEffortId = (text) => (TASK_EFFORT_IDS.has(text) ? text : null);

function choiceOf(saved, fallback, task) {
  const model = modelId(saved?.model) ?? fallback.model;
  const effort = takesEffort(task) ? taskEffortId(saved?.effort) ?? fallback.effort : DEFAULT;
  return { model, effort, ...(takesForce(task) && saved?.force === true ? { force: true } : {}) };
}

export function modelsOf(saved) {
  const fresh = freshModels();
  const given = saved && typeof saved === 'object' ? saved : {};
  return Object.fromEntries(TASK_KEYS.map((key) => [key, choiceOf(given[key], fresh[key], key)]));
}

export const everyEffortOf = (saved) => effortId(saved) ?? DEFAULT;

export function effectiveModels(models, everyEffort) {
  const every = everyEffortOf(everyEffort);
  return Object.fromEntries(Object.entries(models ?? {}).map(([key, choice]) => [key, { ...choice, effort: choice?.effort === SAME ? every : choice?.effort }]));
}

// Only an effort Claude Code takes becomes a flag, so a row still marked to follow every task can never reach claude as one.
export function launchOf(choice) {
  const model = choice?.model && choice.model !== DEFAULT ? choice.model : null;
  const effort = effortId(choice?.effort) && choice.effort !== DEFAULT ? choice.effort : null;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

function subagentsOf(builders) {
  const { model } = launchOf(builders);
  return model ? { subagentModel: model, ...(builders.force === true ? { subagentForce: true } : {}) } : {};
}

export const taskLaunch = (models, task) => ({ ...launchOf(models?.[task]), ...subagentsOf(models?.builders) });

export function modelArgs(choice) {
  const { model, effort } = launchOf(choice);
  return [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
}

export function subagentEnv(choice) {
  const { model } = launchOf(choice);
  if (!model) return {};
  return { [SUBAGENT_ENV]: model, ...(choice.force === true ? { [FORCE_ENV]: '1' } : {}) };
}

const ALIAS = new Map(MODELS);
const FAMILY = /^claude-(opus|sonnet|haiku|fable)-(\d+)-(\d+)(?:-\d{8})?$/;

export function modelName(id) {
  if (!id) return ALIAS.get(DEFAULT);
  if (ALIAS.has(id)) return ALIAS.get(id);
  const [, family, major, minor] = FAMILY.exec(id) ?? [];
  return family ? `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}` : id;
}
