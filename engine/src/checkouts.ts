import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Checkout {
  /** The folder's name under the workspace root. */
  dir: string;
  /** The GitLab project its origin remote points at, such as acme/engine. */
  path: string | null;
}

const ORIGIN_URL = /\[remote "origin"\][^[]*?^\s*url\s*=\s*(\S+)/m;
const REMOTE_PATH = /^(?:[\w+.-]+:\/\/)?(?:[^@/]+@)?[^:/]+(?::\d+)?[:/](.+?)(?:\.git)?\/?$/;

export function remotePath(url: string): string | null {
  return url.match(REMOTE_PATH)?.[1] ?? null;
}

function isCheckout(folder: string): boolean {
  return statSync(join(folder, '.git'), { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function originOf(folder: string): string | null {
  try {
    const url = readFileSync(join(folder, '.git', 'config'), 'utf8').match(ORIGIN_URL)?.[1];
    return url ? remotePath(url) : null;
  } catch {
    return null;
  }
}

/** Linked worktrees have a .git file rather than a folder, so only the checkouts themselves are found. */
export function discoverCheckouts(root: string): Checkout[] {
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return [];
  }
  return names.filter((dir) => isCheckout(join(root, dir))).map((dir) => ({ dir, path: originOf(join(root, dir)) }));
}

// A folder named after the repo was the only rule before discovery, so it still wins among clones of the same project.
export function checkoutFor(projectPath: string, checkouts: Checkout[]): Checkout | null {
  const wanted = projectPath.toLowerCase();
  const name = wanted.split('/').pop();
  const same = (c: Checkout): boolean => c.path?.toLowerCase() === wanted;
  const named = (c: Checkout): boolean => c.dir.toLowerCase() === name;
  return checkouts.find((c) => same(c) && named(c)) ?? checkouts.find(same) ?? checkouts.find(named) ?? null;
}

export function noCheckout(projectPath: string, root: string): Error {
  const name = projectPath.split('/').pop() ?? projectPath;
  return new Error(`No checkout of ${projectPath} under ${root}. Clone it there as ${join(root, name)}, or set Workspace root in Settings to the folder your clones live in.`);
}
