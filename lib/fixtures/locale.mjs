import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as locale from '../locale.mjs';

// British dates on the 24 hour clock, on a working week of Monday to Friday.
export const LONDON = { locale: { timeZone: '', region: 'en-GB', clock: '24' }, hours: { from: '08:00', to: '18:00', workDays: [1, 2, 3, 4, 5] } };

export async function placeLocale(home, saved = LONDON) {
  const dir = join(home, '.config/underlings');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'locale.json'), JSON.stringify(saved));
  return locale.refresh();
}
