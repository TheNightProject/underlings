import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { Mr } from '../types.js';
import type { AutoIntent, AutoSeat } from './lock.js';

type Reply = Record<string, unknown>;
type Command = Record<string, unknown> & { op: string };

/** A front end in a process of its own, against the state folder it is given, for tests that need two. */
export class TestProc {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly replies: ((reply: Reply) => void)[] = [];
  readonly exited: Promise<void>;

  constructor(stateDir: string) {
    const loader = import.meta.resolve('tsx');
    this.child = spawn(process.execPath, ['--import', loader, fileURLToPath(import.meta.url), 'child'], {
      cwd: stateDir,
      env: { ...process.env, UNDERLINGS_STATE_DIR: stateDir, GITLAB_TOKEN: '' },
    });
    this.child.stderr.on('data', (d: Buffer) => process.stderr.write(d));
    createInterface({ input: this.child.stdout }).on('line', (line) => this.replies.shift()?.(JSON.parse(line) as Reply));
    this.exited = new Promise((resolve) => this.child.once('exit', () => resolve()));
  }

  get pid(): number {
    return this.child.pid ?? -1;
  }

  send(command: Command): Promise<Reply> {
    return new Promise((resolve) => {
      this.replies.push(resolve);
      this.child.stdin.write(`${JSON.stringify(command)}\n`);
    });
  }

  turn(intent: AutoIntent, now: number): Promise<{ held: boolean; event: string | null; token: string | null }> {
    return this.send({ op: 'turn', intent, now }) as Promise<{ held: boolean; event: string | null; token: string | null }>;
  }

  async kill(): Promise<void> {
    this.child.kill('SIGKILL');
    await this.exited;
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await this.exited;
  }
}

interface SendCommand {
  mrs: Mr[];
  people: string;
  claimBy: string;
  log: string;
  delayMs: number;
  crashOnPost: boolean;
}

interface HammerCommand {
  what: 'watches' | 'people' | 'pause' | 'settings';
  count: number;
  go: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function sendDueAs(command: SendCommand): Promise<Reply> {
  const { sendDue } = await import('./send.js');
  const { updateQueueItem } = await import('../data/store.js');
  const { context, fakeWorld } = await import('./testkit.js');
  const fake = fakeWorld({ mrs: command.mrs });
  const ports = {
    ...fake.ports,
    post: async (item: { id: string }) => {
      appendFileSync(command.log, `${item.id}\n`);
      if (command.crashOnPost) process.kill(process.pid, 'SIGKILL');
      await sleep(command.delayMs);
      updateQueueItem(item.id, { status: 'posted', postedAt: new Date().toISOString(), sending: undefined });
      return { id: item.id, ok: true };
    },
    now: () => Date.now(),
  };
  const report = await sendDue({ ...context(fake.world, command.people), claimBy: command.claimBy }, ports);
  return { ...report };
}

async function hammer(command: HammerCommand): Promise<Reply> {
  const { toggleWatch } = await import('../actions/watch.js');
  const { setPersonLevel, toggleFullAutoPause } = await import('../commands.js');
  const { updateSettings } = await import('../settingsedit.js');
  const { mr } = await import('./testkit.js');
  while (!existsSync(command.go)) await sleep(2);
  for (let i = 0; i < command.count; i += 1) {
    if (command.what === 'watches') toggleWatch(mr({ iid: 10_000 + i }));
    else if (command.what === 'people') setPersonLevel(`person${i}`, 'shadow');
    else if (command.what === 'settings') updateSettings({ pollSeconds: 60 + (i % 2) });
    else toggleFullAutoPause();
  }
  return {};
}

async function serve(): Promise<void> {
  let lock = await import('./lock.js');
  let generation = 0;
  let seat: AutoSeat | null = null;
  const ops: Record<string, (command: Command) => Promise<Reply> | Reply> = {
    turn: (c) => {
      const result = lock.takeAutoTurn(seat, c['intent'] as AutoIntent, c['now'] as number);
      seat = JSON.parse(JSON.stringify(result.seat)) as AutoSeat;
      return { held: result.held, event: result.event, token: seat.token };
    },
    held: (c) => ({ held: lock.autoTurnHeld(seat, c['now'] as number) }),
    release: (c) => {
      if (seat) seat = lock.releaseAutoTurn(seat, { keepLock: c['keepLock'] === true });
      return {};
    },
    reimport: async () => {
      generation += 1;
      lock = (await import(`./lock.ts?generation=${generation}`)) as typeof lock;
      return {};
    },
    forget: () => {
      seat = null;
      return {};
    },
    claim: async (c) => (await import('../data/store.js')).claimToSend(c['id'] as string, c['by'] as string, Date.now()),
    mark: async (c) => ({ marked: (await import('../data/store.js')).setEditing(c['id'] as string, c['by'] as string, c['until'] as number | null) }),
    send: (c) => sendDueAs(c as unknown as SendCommand),
    hammer: (c) => hammer(c as unknown as HammerCommand),
  };
  for await (const line of createInterface({ input: process.stdin })) {
    const command = JSON.parse(line) as Command;
    const reply = await ops[command.op]?.(command);
    process.stdout.write(`${JSON.stringify(reply ?? { error: `no op ${command.op}` })}\n`);
  }
}

if (process.argv[2] === 'child' && process.argv[1] === fileURLToPath(import.meta.url)) await serve();
