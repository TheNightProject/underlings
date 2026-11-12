import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../../lib/home.mjs';
import { UNDER_TEST_RUNNER } from './data/store.js';

export interface WritingStyle {
  language: string;
  rules: string;
}

const NONE: WritingStyle = { language: '', rules: '' };
const oneLine = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

// The app's Settings keep the profile; a test that sets no file of its own must never read yours.
function profileFile(): string | null {
  return process.env['UNDERLINGS_PROFILE_FILE'] ?? (UNDER_TEST_RUNNER ? null : join(configDir(), 'profile.json'));
}

export function writingStyle(): WritingStyle {
  const file = profileFile();
  if (!file) return NONE;
  try {
    const { style } = JSON.parse(readFileSync(file, 'utf8')) as { style?: Partial<WritingStyle> };
    return { language: oneLine(style?.language), rules: oneLine(style?.rules) };
  } catch {
    return NONE;
  }
}

/** Each on one line, as the review prompt is typed into a terminal by the Orca fallback. */
export function styleLines(what: string, style: WritingStyle = writingStyle()): string[] {
  return [style.language ? `Write ${what} in ${style.language}.` : null, style.rules ? `Writing rules for ${what}: ${style.rules}` : null].filter((line): line is string => line !== null);
}
