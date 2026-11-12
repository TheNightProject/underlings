import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_BUFFER = 32 * 1024 * 1024;
const AT_ONCE = 3;

export type AcliPriority = 'now' | 'background';

export interface AcliOptions {
  priority?: AcliPriority;
}

interface AcliRun extends AcliOptions {
  timeout?: number;
}

type AcliOutput = { stdout: string; stderr: string };

const waiting: Record<AcliPriority, (() => Promise<void>)[]> = { now: [], background: [] };
let running = 0;
let background = 0;

// A plugin worker starts without the login shell's PATH, so it names acli's absolute path here.
function acliPath(): string {
  return process.env['UNDERLINGS_ACLI'] || 'acli';
}

/** Jira answers slower the more acli processes ask at once, so they take turns, and a timeout counts only once its process has started. */
export function runAcli(args: string[], { timeout, priority = 'now' }: AcliRun = {}): Promise<AcliOutput> {
  return new Promise((resolve, reject) => {
    waiting[priority].push(() => runInTurn(args, timeout, priority).then(resolve, reject));
    startWaiting();
  });
}

async function runInTurn(args: string[], timeout: number | undefined, priority: AcliPriority): Promise<AcliOutput> {
  try {
    return await run(acliPath(), args, { maxBuffer: MAX_BUFFER, timeout });
  } finally {
    running -= 1;
    if (priority === 'background') background -= 1;
    startWaiting();
  }
}

// Background reads never take the last slot, so a read someone is waiting on never queues behind slow searches.
function startWaiting(): void {
  while (running < AT_ONCE) {
    const urgent = waiting.now.length > 0;
    if (!urgent && (background >= AT_ONCE - 1 || waiting.background.length === 0)) return;
    const next = (urgent ? waiting.now : waiting.background).shift() as () => Promise<void>;
    running += 1;
    if (!urgent) background += 1;
    void next();
  }
}
