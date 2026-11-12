import { DEFAULT_SETTINGS, SETTING_ROWS, type Settings } from '../settings.js';
import type { AutoLevel } from '../types.js';
import { peopleRules, type AutoPerson } from './people.js';

export const MAX_REPLIES_PER_THREAD = 3;
export const MAX_LAUNCHES_PER_POLL = 2;
export const PASS_TIMEOUT_MS = 45 * 60 * 1000;

export interface AutoConfig {
  people: AutoPerson[];
  onRequest: AutoLevel | null;
  optedOut: Set<string>;
  holdMs: number;
  maxComments: number;
  maxDiffLines: number;
  sensitive: string[];
  footer: boolean;
  paused: boolean;
}

/** Typed text can arrive here, and a NaN cap compares false against everything and stops capping. */
function bounded(settings: Partial<Settings>, key: keyof Settings): number {
  const fallback = DEFAULT_SETTINGS[key] as number;
  const bounds = SETTING_ROWS.find((r) => r.key === key)?.bounds;
  const value = Number(settings[key]);
  if (!Number.isFinite(value) || !bounds) return fallback;
  return Math.max(bounds.min, Math.min(value, bounds.max));
}

export function autoConfig(settings: Partial<Settings>): AutoConfig {
  return {
    ...peopleRules(String(settings.fullAuto ?? '')),
    holdMs: bounded(settings, 'autoHoldSeconds') * 1000,
    maxComments: bounded(settings, 'autoMaxComments'),
    maxDiffLines: bounded(settings, 'autoMaxDiffLines'),
    sensitive: String(settings.autoSensitivePaths ?? DEFAULT_SETTINGS.autoSensitivePaths)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    footer: settings.autoFooter === true,
    paused: settings.autoPaused === true,
  };
}
