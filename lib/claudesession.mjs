import { copyFile, cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { run } from './run.mjs';

const WHERE = '__CC_CONFIG_DIR__';
const CSWAP_MS = 20_000;

export const defaultConfigDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

const isFile = (path) => stat(path).then((s) => s.isFile(), () => false);
const isDir = (path) => stat(path).then((s) => s.isDirectory(), () => false);

// Claude Code keeps each session under its config dir, in a folder named after the directory it ran in.
export async function findSession(id, configDir) {
  const projects = join(configDir, 'projects');
  for (const folder of await readdir(projects).catch(() => [])) {
    if (await isFile(join(projects, folder, `${id}.jsonl`))) return { folder, file: join(projects, folder, `${id}.jsonl`) };
  }
  return null;
}

// An account that is not the default login runs in a cswap profile of its own, so cswap is asked which, through a claude that only says.
export async function cswapConfigDir({ cswap, account, env, shimDir }) {
  await mkdir(shimDir, { recursive: true });
  await writeFile(join(shimDir, 'claude'), `#!/bin/sh\nprintf '%s%s' '${WHERE}' "$CLAUDE_CONFIG_DIR"\n`, { mode: 0o755 });
  const out = await run(cswap, ['run', account, '--'], { ...env, PATH: `${shimDir}${delimiter}${env.PATH ?? ''}` }, { timeout: CSWAP_MS });
  const at = out.lastIndexOf(WHERE);
  if (at < 0) throw new Error('cswap did not start claude');
  return out.slice(at + WHERE.length).trim() || defaultConfigDir(env);
}

// Copied, never moved, so the config dir it came from keeps the session whole.
export async function carrySession(id, from, to) {
  const found = await findSession(id, from);
  if (!found) return false;
  if (resolve(from) === resolve(to) || (await findSession(id, to))) return true;
  const target = join(to, 'projects', found.folder);
  await mkdir(target, { recursive: true });
  await copyFile(found.file, join(target, `${id}.jsonl`));
  const extra = join(from, 'projects', found.folder, id);
  if (await isDir(extra)) await cp(extra, join(target, id), { recursive: true });
  return true;
}
