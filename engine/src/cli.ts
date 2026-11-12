#!/usr/bin/env node
import type { RepoSpec } from './config.js';
import { forgeOf, GITLAB } from './data/forge.js';
import { listAgentTerminals, listWorktrees, removeWorktree } from './agents/index.js';
import { labelKey, outOfScope, reapable } from './gc.js';
import { isWatched } from './actions/watch.js';
import { takeChange } from './auto/rereview.js';
import { addToQueue, loadQueue, markPassDone, loadRuns, loadState } from './data/store.js';
import { queueInput } from './queueinput.js';
import { currentRepos } from './inbox.js';
import { keyOf, refNumber } from './refs.js';
import type { Mr } from './types.js';

const USAGE = `underlings - the review queue and journal, for agents and hooks

  underlings --once [--json]          print the MR list and exit
  underlings queue add --json         read queued comments from stdin
  underlings queue list [--json]      show what is waiting to be posted
  underlings queue done <pass>        a full-auto review agent saying it has finished
  underlings changed <repoPath> <iid> exit 0 if the MR moved since last seen
  underlings runs [<repoPath>!<iid>]  what each review agent printed, from the journal
  underlings gc [--finished] [--yes]  close review workspaces there is nothing left to do in

The queue subcommand is the seam for a review agent: it reports findings in chat,
then pipes them here. Nothing reaches GitLab until it is posted from the review queue,
except for an author you have put in full auto, and then only after the hold window.
`;

async function openMrs(repos: RepoSpec[]): Promise<Mr[]> {
  return (await forgeOf(GITLAB).listOpen(repos)).mrs;
}

/**
 * A review workspace is named for its MR, so the MR list is what says whether there is
 * anything left to do in it. Nothing is removed without --yes, and the rules in gc.ts
 * keep ticket workspaces out of it entirely.
 */
async function collectWorkspaces(argv: string[], json: boolean): Promise<void> {
  const [workspaces, mrs, terminals] = await Promise.all([
    listWorktrees(),
    currentRepos().then(openMrs),
    listAgentTerminals().catch(() => []),
  ]);

  const watches = loadState().watches;
  const queue = loadQueue();
  const live = new Set(
    terminals.filter((t) => t.agent && t.connected && !t.orphaned).map((t) => t.handle),
  );
  // The workspace name carries a repo label; the queue and the watches are keyed by path.
  const keyByLabel = new Map(
    mrs.map((m) => [labelKey(m.repoLabel, m.iid), keyOf(m)]),
  );
  const look = (repoLabel: string, iid: number): string | undefined =>
    keyByLabel.get(labelKey(repoLabel, iid));

  const repoLabels = (await currentRepos()).map((r) => r.label);
  const candidates = reapable(workspaces, mrs, {
    knownRepoLabels: repoLabels,
    agentAlive: (repoLabel, iid) => {
      const handle = watches[look(repoLabel, iid) ?? '']?.terminal;
      return Boolean(handle && live.has(handle));
    },
    pending: (repoLabel, iid) => {
      const key = look(repoLabel, iid);
      return key === undefined
        ? 0
        : queue.filter((c) => c.status === 'pending' && keyOf(c) === key).length;
    },
    includeFinished: argv.includes('--finished'),
  });

  if (json) {
    const rows = candidates.map((c) => ({
      id: c.workspace.id,
      name: c.workspace.displayName,
      reason: c.reason,
    }));
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  const skipped = outOfScope(workspaces, repoLabels);
  for (const w of skipped) {
    process.stdout.write(`${w.displayName.padEnd(30)} skipped, repo not in the core set\n`);
  }
  if (candidates.length === 0) {
    process.stdout.write('nothing to close\n');
    return;
  }
  for (const c of candidates) {
    process.stdout.write(`${c.workspace.displayName.padEnd(30)} ${c.reason}\n`);
  }
  if (!argv.includes('--yes')) {
    process.stdout.write(
      `\n${candidates.length} workspace(s) would be closed. Re-run with --yes to do it.\n`,
    );
    return;
  }
  for (const c of candidates) {
    try {
      await removeWorktree(c.workspace.id);
      process.stdout.write(`closed ${c.workspace.displayName}\n`);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      process.stdout.write(`kept ${c.workspace.displayName}: ${why}\n`);
    }
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }

  if (argv[0] === 'queue') {
    if (argv[1] === 'add') {
      const raw = await readStdin();
      const parsed = JSON.parse(raw) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const added = addToQueue(items.map(queueInput));
      process.stdout.write(
        json
          ? `${JSON.stringify({ added: added.length, ids: added.map((a) => a.id) }, null, 2)}\n`
          : `queued ${added.length} comment(s); they wait in the review queue until they are posted\n`,
      );
      return;
    }
    if (argv[1] === 'done') {
      if (markPassDone(argv[2] ?? '')) {
        process.stdout.write('pass marked finished\n');
      } else {
        process.stderr.write(`no full-auto pass ${argv[2] ?? ''}\n`);
        process.exitCode = 1;
      }
      return;
    }
    const pending = loadQueue().filter((c) => c.status === 'pending');
    if (json) {
      process.stdout.write(`${JSON.stringify(pending, null, 2)}\n`);
    } else {
      for (const c of pending) {
        process.stdout.write(
          `${c.severity.padEnd(9)} ${keyOf(c)}  ${c.body.split('\n')[0]}\n`,
        );
      }
      if (pending.length === 0) process.stdout.write('nothing queued\n');
    }
    return;
  }

  if (argv[0] === 'runs') {
    const runs = loadRuns();
    const key = argv[1];
    if (json) {
      process.stdout.write(`${JSON.stringify(key ? runs[key] ?? null : runs, null, 2)}\n`);
      return;
    }
    if (key) {
      const run = runs[key];
      if (!run) {
        process.stderr.write(`no review journal for ${key}\n`);
        process.exitCode = 1;
        return;
      }
      process.stdout.write(`${run.tail?.join('\n') ?? ''}\n`);
      return;
    }
    const entries = Object.values(runs).sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    for (const run of entries) {
      process.stdout.write(
        `${run.key.padEnd(52)} ${(run.status ?? '?').padEnd(10)} ${run.tail?.length ?? 0} lines\n`,
      );
    }
    if (entries.length === 0) process.stdout.write('no reviews have run yet\n');
    return;
  }

  if (argv[0] === 'gc') {
    await collectWorkspaces(argv, json);
    return;
  }

  if (argv[0] === 'changed') {
    const repoPath = argv[1];
    const iid = Number(argv[2]);
    if (!repoPath || !Number.isFinite(iid)) {
      process.stderr.write('usage: underlings changed <repoPath> <iid>\n');
      process.exitCode = 2;
      return;
    }
    const ref = { projectPath: repoPath, iid };
    const mr = await forgeOf(ref).one(ref);
    if (!mr) {
      process.stderr.write(`no open MR ${keyOf({ projectPath: repoPath, iid })}\n`);
      process.exitCode = 2;
      return;
    }
    const moved = !isWatched(keyOf({ projectPath: repoPath, iid })) || takeChange(mr, { autoOnly: false });
    process.stdout.write(`${moved ? 'changed' : 'unchanged'}\n`);
    process.exitCode = moved ? 0 : 1;
    return;
  }

  if (argv.includes('--once')) {
    const mrs = await openMrs(await currentRepos());
    if (json) {
      process.stdout.write(`${JSON.stringify(mrs, null, 2)}\n`);
    } else {
      for (const m of mrs) {
        process.stdout.write(
          `${m.repoLabel.padEnd(16)} ${refNumber(m).padEnd(7)} ${(m.pipeline ?? 'none').padEnd(10)} ${m.author.padEnd(18)} ${m.title}\n`,
        );
      }
      process.stdout.write(`\n${mrs.length} open\n`);
    }
    return;
  }

  process.stdout.write(USAGE);
  if (argv.length > 0) process.exitCode = 2;
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
