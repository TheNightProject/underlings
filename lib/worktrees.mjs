import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { run } from './run.mjs';

export const GIT = '/usr/bin/git';

export function git(path, ...args) {
  return run(GIT, ['-C', path, ...args]);
}

// The repos are the git checkouts directly under the workspace root, and their linked worktrees are what agents and people cut beside them.
export async function listGitWorktrees(root) {
  const repos = await reposUnder(root);
  const lists = await Promise.all(repos.map((repo) => worktreesOf(repo).catch(() => [])));
  return lists.flat();
}

async function reposUnder(root) {
  const names = root ? await readdir(root).catch(() => []) : [];
  const found = await Promise.all(names.map(async (name) => ((await stat(join(root, name, '.git')).catch(() => null))?.isDirectory() ? join(root, name) : null)));
  return found.filter(Boolean);
}

async function worktreesOf(repo) {
  const linked = parseWorktrees(await git(repo, 'worktree', 'list', '--porcelain')).slice(1).filter((w) => !w.prunable);
  return Promise.all(linked.map(async (w) => ({ ...w, repo: basename(repo), activityAt: await activityOf(w.path) })));
}

export function parseWorktrees(porcelain) {
  return porcelain.split('\n\n').filter((block) => block.startsWith('worktree ')).map((block) => {
    const lines = block.split('\n');
    const value = (name) => lines.find((l) => l === name || l.startsWith(`${name} `))?.slice(name.length + 1);
    return { path: value('worktree'), branch: value('branch')?.replace(/^refs\/heads\//, '') ?? '', locked: value('locked') !== undefined, prunable: value('prunable') !== undefined };
  });
}

// git moves a worktree's index and HEAD log on every checkout, commit, reset and stage, which is as near to "last used" as it keeps.
async function activityOf(path) {
  const gitdir = (await readFile(join(path, '.git'), 'utf8').catch(() => '')).replace(/^gitdir: /, '').trim();
  if (!gitdir) return null;
  const times = await Promise.all(['index', 'logs/HEAD', 'HEAD'].map((file) => stat(join(gitdir, file)).then((s) => s.mtimeMs, () => 0)));
  return Math.max(...times) || null;
}

// Removed from its main checkout, never with --force, so git still refuses one with changes or untracked files.
export async function removeGitWorktree(path) {
  const common = (await git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
  await git(dirname(common), 'worktree', 'remove', path);
}
