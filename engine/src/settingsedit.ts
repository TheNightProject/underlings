import { readFileSync } from 'node:fs';
import { planBatches } from './batching.js';
import { REPO_CACHE_FILE, type RepoSpec } from './config.js';
import { forgeOf, GITLAB } from './data/forge.js';
import { changeSettings, loadSettings, saveRepoCache } from './data/store.js';
import {
  applyFilter,
  BUILT_IN_COMMANDS,
  DEFAULT_SETTINGS,
  NESTED_ROWS,
  requestRate,
  SETTING_ROWS,
  type AgentCommands,
  type NestedGroup,
  type NestedKey,
  type NestedRow,
  type SettingRow,
  type Settings,
} from './settings.js';

const TEXT_MAX = 500;
const LINES_MAX = 2000;
const NESTED = new Map(NESTED_ROWS.map((row) => [row.key as string, row]));
type Nested = Pick<Settings, NestedGroup>;
// Who is in full auto changes only through setPersonLevel, which checks each name.
const EDITABLE = new Map(
  SETTING_ROWS.filter((row) => row.kind !== 'people').map((row) => [row.key as string, row]),
);
const NUMBER_ROWS = SETTING_ROWS.filter((row) => row.kind === 'number');
const AGENT_KEYS = Object.keys(BUILT_IN_COMMANDS);

export interface SettingsUpdate {
  settings: Settings;
  applied: (keyof Settings | NestedKey)[];
  dropped: string[];
}

type NestedValue = string | boolean;

export function updateSettings(patch: Record<string, unknown>): SettingsUpdate {
  const { values, nested, applied, dropped } = coercePatch(patch);
  const settings =
    applied.length > 0
      ? changeSettings((current) => withNumbersClamped({ ...current, ...values, agents: { ...current.agents, ...values.agents }, ...withNested(current, nested) }))
      : withNumbersClamped(loadSettings());
  return { settings, applied, dropped };
}

function withNested(current: Settings, nested: [NestedKey, NestedValue][]): Nested {
  const next: Nested = { jira: { ...current.jira }, gitlab: { ...current.gitlab }, github: { ...current.github }, tickets: { ...current.tickets } };
  for (const [key, value] of nested) {
    const [group, name] = key.split('.') as [keyof Nested, string];
    (next[group] as unknown as Record<string, NestedValue>)[name] = value;
  }
  return next;
}

function nestedValue(row: NestedRow, value: unknown): NestedValue | undefined {
  if (row.kind === 'toggle') return toggle(value);
  if (row.kind === 'choice') return row.choices?.some(([choice]) => choice === value) ? (value as string) : undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = row.kind === 'lines' ? String(value).replace(/\r\n?/g, '\n').trim().slice(0, LINES_MAX) : String(value).replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
  if (!row.tidy) return text;
  return row.tidy(text) ?? undefined;
}

function coercePatch(patch: Record<string, unknown>): Omit<SettingsUpdate, 'settings'> & { values: Partial<Settings>; nested: [NestedKey, NestedValue][] } {
  const values: Record<string, unknown> = {};
  const nested: [NestedKey, NestedValue][] = [];
  const applied: (keyof Settings | NestedKey)[] = [];
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const row = NESTED.get(key);
    const coerced = row ? nestedValue(row, value) : key === 'agents' ? agentCommandsPatch(value) : rowValue(key, value);
    if (coerced === undefined) {
      dropped.push(key);
      continue;
    }
    if (row) nested.push([row.key, coerced as NestedValue]);
    else values[key] = coerced;
    applied.push(key as keyof Settings | NestedKey);
  }
  return { values: values as Partial<Settings>, nested, applied, dropped };
}

function rowValue(key: string, value: unknown): unknown {
  const row = EDITABLE.get(key);
  return row ? coerce(row, value) : undefined;
}

function coerce(row: SettingRow, value: unknown): unknown {
  if (row.kind === 'toggle') return toggle(value);
  if (row.kind === 'number') return clamp(row, value);
  if (row.kind === 'choice') return row.choices?.some(([choice]) => choice === value) ? value : undefined;
  const plain = typeof value === 'string' || typeof value === 'number';
  const text = plain ? String(value).trim().slice(0, TEXT_MAX) : undefined;
  return text === undefined || !row.pattern || row.pattern.test(text) ? text : undefined;
}

// A command is typed into a terminal by the Orca fallback, where a newline would submit it early.
function agentCommandsPatch(value: unknown): Partial<AgentCommands> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.length || entries.some(([k, v]) => !AGENT_KEYS.includes(k) || typeof v !== 'string')) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [k, (v as string).replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX)]));
}

function toggle(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return undefined;
}

function clamp(row: SettingRow, value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n) || !row.bounds) return undefined;
  return Math.min(Math.max(Math.round(n), row.bounds.min), row.bounds.max);
}

// A typed edit may arrive as text, so a saved '15' becomes 15 here whichever row the patch named.
function withNumbersClamped(settings: Settings): Settings {
  const fixed: Record<string, unknown> = { ...settings };
  for (const row of NUMBER_ROWS) fixed[row.key] = clamp(row, settings[row.key]) ?? DEFAULT_SETTINGS[row.key];
  return fixed as unknown as Settings;
}

export async function rediscoverRepos(): Promise<RepoSpec[]> {
  const found = await forgeOf(GITLAB).discoverRepos();
  // discoverRepos swallows each page's error, so an empty answer is a failed look and the known list stays.
  if (found.length > 0) saveRepoCache(found);
  return found;
}

export interface RepoMatch {
  total: number;
  matching: string[];
  perRefresh: number;
  perMinute: number;
  heavy: boolean;
  discoveredAt: string | null;
}

export function repoMatch(filter: string, pollSeconds: unknown): RepoMatch {
  const { at, repos } = repoCache();
  const matched = applyFilter(repos, filter);
  const rate = requestRate(planBatches(matched).length, pollFor(pollSeconds));
  return { total: repos.length, matching: matched.map((r) => r.path), ...rate, discoveredAt: at };
}

function pollFor(value: unknown): number {
  const row = NUMBER_ROWS.find((r) => r.key === 'pollSeconds');
  return (row && clamp(row, value)) ?? DEFAULT_SETTINGS.pollSeconds;
}

// Read whatever age it is: loadRepoCache drops a day-old list, and the filter still needs one to match against.
function repoCache(): { at: string | null; repos: RepoSpec[] } {
  try {
    const cached = JSON.parse(readFileSync(REPO_CACHE_FILE, 'utf8')) as { at?: string; repos?: RepoSpec[] };
    return { at: cached.at ?? null, repos: cached.repos ?? [] };
  } catch {
    return { at: null, repos: [] };
  }
}
