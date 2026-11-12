import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT, defaultModels, effectiveModels, effortId, modelId, suggestedModels, takesEffort, takesForce, TASK_KEYS, taskEffortId, taskLaunch, taskOfKind } from '../../lib/modeltiers.mjs';
import type { AgentKind } from './agents/host.js';
import { STATE_DIR } from './config.js';
import { assertWritableState, changeSettings, loadSettings } from './data/store.js';
import type { ModelChoice, ModelSettings, Settings } from './settings.js';

const DAY_MS = 24 * 60 * 60_000;
const USAGE_DAYS = 7;
const USAGE_KEPT_DAYS = 14;

/** What an agent was started with, kept on it so a change in Settings reaches only the agents started after it. */
export interface AgentLaunch {
  model?: string;
  effort?: string;
  subagentModel?: string;
  subagentForce?: boolean;
}

export function agentLaunch(kind: AgentKind, settings: Settings = loadSettings()): AgentLaunch {
  return taskLaunch(effectiveModels(settings.models, settings.everyEffort), taskOfKind(kind));
}

function checkTask(task: string): void {
  if (!TASK_KEYS.includes(task)) throw new Error(`a task is one of ${TASK_KEYS.join(', ')}`);
}

function forced(task: string, was: ModelChoice, patch: { force?: unknown }): boolean {
  if (patch.force === undefined) return was.force === true;
  if (!takesForce(task)) throw new Error(`${task} has no subagents to force a model on`);
  if (typeof patch.force !== 'boolean') throw new Error('force is on or off');
  return patch.force;
}

function changed(task: string, was: ModelChoice, patch: { model?: unknown; effort?: unknown; force?: unknown }): ModelChoice {
  const model = patch.model === undefined ? was.model : modelId(patch.model);
  if (!model) throw new Error('a model is Claude Code\'s default, opus, sonnet, haiku or a full model ID, one word that starts with a letter or digit');
  if (patch.effort !== undefined && !takesEffort(task)) throw new Error(`${task} takes a model only, as Claude Code has no effort setting for subagents`);
  const effort = patch.effort === undefined ? was.effort : taskEffortId(patch.effort);
  if (!effort) throw new Error('effort is same, default, low, medium, high, xhigh or max');
  return { model, effort, ...(forced(task, was, patch) ? { force: true } : {}) };
}

export function saveModel(task: string, patch: { model?: unknown; effort?: unknown; force?: unknown }): ModelSettings {
  checkTask(task);
  if (patch.model === undefined && patch.effort === undefined && patch.force === undefined) throw new Error('say the model, the effort or whether to force it');
  return changeSettings((s) => ({ ...s, models: { ...s.models, [task]: changed(task, s.models[task] ?? { model: DEFAULT, effort: DEFAULT }, patch) } })).models;
}

export function saveEveryEffort(effort: unknown): string {
  const every = effortId(effort);
  if (!every) throw new Error('effort for every task is default, low, medium, high, xhigh or max');
  return changeSettings((s) => ({ ...s, everyEffort: every })).everyEffort;
}

const PRESETS: Record<string, (s: Settings) => Settings> = {
  suggested: (s) => ({ ...s, models: suggestedModels() }),
  default: (s) => ({ ...s, models: defaultModels(), everyEffort: DEFAULT }),
};

export function applyModelPreset(preset: string): ModelSettings {
  const apply = PRESETS[preset];
  if (!apply) throw new Error('a preset is suggested or default');
  return changeSettings(apply).models;
}

const usageDir = (): string => join(STATE_DIR, 'usage');
const dayFile = (at: number): string => `${new Date(at).toISOString().slice(0, 10)}.jsonl`;

/** One line a finished turn or run, in a file a day, so pruning never rewrites a file another process is appending to. */
export function recordUsage(task: string, tokens: number, at = Date.now()): void {
  if (!TASK_KEYS.includes(task) || !(tokens > 0)) return;
  assertWritableState();
  mkdirSync(usageDir(), { recursive: true });
  const file = join(usageDir(), dayFile(at));
  if (!existsSync(file)) pruneUsage(at);
  appendFileSync(file, `${JSON.stringify({ at, task, tokens: Math.round(tokens) })}\n`);
}

function usageDays(): string[] {
  try {
    return readdirSync(usageDir()).filter((n) => /^\d{4}-\d\d-\d\d\.jsonl$/.test(n));
  } catch {
    return [];
  }
}

function pruneUsage(now: number): void {
  const oldest = dayFile(now - USAGE_KEPT_DAYS * DAY_MS);
  for (const name of usageDays().filter((n) => n < oldest)) rmSync(join(usageDir(), name), { force: true });
}

function readDay(name: string): { at: number; task: string; tokens: number }[] {
  try {
    return readFileSync(join(usageDir(), name), 'utf8').split('\n').flatMap((line) => {
      try {
        return line ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function modelUsage(now = Date.now()): { days: number; tokens: Record<string, number> } {
  const since = now - USAGE_DAYS * DAY_MS;
  const tokens: Record<string, number> = {};
  for (const name of usageDays().filter((n) => n >= dayFile(since))) {
    for (const line of readDay(name)) {
      if (line.at >= since && line.at <= now && TASK_KEYS.includes(line.task) && line.tokens > 0) tokens[line.task] = (tokens[line.task] ?? 0) + line.tokens;
    }
  }
  return { days: USAGE_DAYS, tokens };
}
