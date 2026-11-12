import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../../lib/home.mjs';
import { dateFormat, localeOf, machineZone } from '../../lib/clock.mjs';
import { UNDER_TEST_RUNNER } from './data/store.js';

export { addDays, DAY, dayIn, startOfDay, wallClock, workingDay, zonedTime } from '../../lib/clock.mjs';

type Locale = ReturnType<typeof localeOf>;

const NONE = localeOf({});
let read: { file: string; mtime: number; locale: Locale } | null = null;

// The app's Settings keep it; a test that sets no file of its own must never read yours.
function localeFile(): string | null {
  return process.env['UNDERLINGS_LOCALE_FILE'] ?? (UNDER_TEST_RUNNER ? null : join(configDir(), 'locale.json'));
}

export function savedLocale(): Locale {
  const file = localeFile();
  if (!file) return NONE;
  try {
    const mtime = statSync(file).mtimeMs;
    if (read?.file !== file || read.mtime !== mtime) read = { file, mtime, locale: localeOf(JSON.parse(readFileSync(file, 'utf8'))) };
    return read.locale;
  } catch {
    return NONE;
  }
}

export const timeZone = (): string => savedLocale().timeZone || machineZone();

export const workDays = (): number[] => savedLocale().hours.workDays;

export const formatted = (ms: number, options: Intl.DateTimeFormatOptions, locale: { timeZone: string; region: string; clock: string } = { ...savedLocale(), timeZone: timeZone() }): string => dateFormat(locale, options).format(ms);
