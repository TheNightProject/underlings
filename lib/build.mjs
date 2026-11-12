import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './run.mjs';
import { stateDir } from './home.mjs';

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export function statePath(config, name) {
  return join(config.stateDir ?? stateDir(), name);
}

// The app's bundle has no package.json beside its worker, so there the version comes from the stamp the build left.
export async function buildInfo(config) {
  const root = config.buildRoot ?? ROOT;
  const [pkg, stamp] = await Promise.all([readJson(join(root, 'package.json')), readJson(join(root, 'build.json'))]);
  return { version: pkg?.version ?? stamp?.version ?? null, commit: stamp?.commit ?? null, builtAt: stamp?.builtAt ?? null };
}

export async function writePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 });
  await chmod(path + '.tmp', 0o600);
  await rename(path + '.tmp', path);
}
