import { homedir, userInfo } from 'node:os';
import { delimiter } from 'node:path';
import { run } from './run.mjs';

const MARK = '__CONTROL_CENTRE__';

// Orca starts plugin workers with a scrubbed environment, so anything set in the shell profile is read from a login shell.
export async function adoptShellEnv(names, { force = false } = {}) {
  const wanted = force ? names : names.filter((name) => !process.env[name]);
  if (!wanted.length) return;
  const script = `print -rn -- ${MARK}; ` + wanted.map((name) => `printf '%s\\0' "$${name}"`).join('; ');
  const out = await inLoginShell(script);
  const values = out.slice(out.lastIndexOf(MARK) + MARK.length).split('\0');
  wanted.forEach((name, i) => {
    if (values[i]) process.env[name] = values[i];
    else if (force) delete process.env[name];
  });
}

// An app opened from Finder gets only the system PATH, so the shell's comes first and tools such as acli and glab are found.
export async function adoptShellPath() {
  const out = await inLoginShell(`print -rn -- ${MARK}; print -rn -- "$PATH"`);
  const shellPath = out.slice(out.lastIndexOf(MARK) + MARK.length).split(delimiter).filter(Boolean);
  if (!shellPath.length) return;
  const own = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir && !shellPath.includes(dir));
  process.env.PATH = [...shellPath, ...own].join(delimiter);
}

export function inLoginShell(script, options) {
  const env = { HOME: homedir(), USER: userInfo().username, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  return run('/bin/zsh', ['-ilc', script], env, options);
}
