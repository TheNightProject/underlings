// An update from before the rename installs the build it finds under the old name, so the build is left there too; the app then moves itself to its own name.
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OLD_APP_NAME } from '../lib/home.mjs';
import { APP_NAME } from '../lib/product.mjs';

const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'desktop/dist.noindex/mac-arm64');

export function leaveForOldUpdater(out = OUT) {
  const built = join(out, `${APP_NAME}.app`);
  const old = join(out, `${OLD_APP_NAME}.app`);
  if (!existsSync(join(built, 'Contents'))) throw new Error(`there is no built app at ${built}`);
  rmSync(old, { recursive: true, force: true });
  execFileSync('/usr/bin/ditto', ['--clone', built, old]);
  return old;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(`Left a copy at ${leaveForOldUpdater()} for an update from before the rename`);
