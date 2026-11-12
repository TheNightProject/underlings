import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export function run(cmd, args, env = process.env, { timeout = 15_000, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { env, cwd, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stdout, stderr })) : resolve(stdout),
    );
    // The callback reports the exit, so a child that quits before reading its input must not take the worker down.
    if (input !== undefined) child.stdin.on('error', () => {}).end(input);
  });
}

// The forge tokens are the worker's alone: nothing it starts for an agent or a headless read is handed one.
export const withoutForgeTokens = ({ GITLAB_TOKEN, GITHUB_TOKEN, GH_TOKEN, ...rest }) => rest;

export const shellQuoted = (word) => `'${String(word).replace(/'/g, `'\\''`)}'`;

export async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}
