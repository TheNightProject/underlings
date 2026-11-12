import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mr } from './auto/testkit.js';
import type { AgentState } from './review.js';
import { fingerprint, fingerprintDiffers, mrKey, type Mr, type Watch } from './types.js';
import { hasClosed, watchRows, type WatchRow } from './watching.js';

function watchOn(m: Mr, over: Partial<Watch> = {}): Watch {
  return { key: mrKey(m), projectPath: m.projectPath, iid: m.iid, webUrl: m.webUrl, auto: false, seen: fingerprint(m), addedAt: '', ...over };
}

// The body watchRows replaced, kept as the reference.
function oldAppRows(watches: Record<string, Watch>, mrs: Mr[], agents: Map<string, AgentState>): WatchRow[] {
  const byKey = new Map(mrs.map((m) => [mrKey(m), m]));
  return Object.values(watches)
    .map((watch) => {
      const mr = byKey.get(watch.key);
      const agent = watch.terminal ? agents.get(watch.terminal) : undefined;
      return {
        watch,
        ...(agent?.alive ? { agent: agent.working ? ('working' as const) : ('idle' as const) } : {}),
        repoLabel: mr?.repoLabel ?? watch.projectPath.split('/').pop() ?? watch.projectPath,
        stillOpen: mr !== undefined,
        moved: mr ? fingerprintDiffers(watch.seen, fingerprint(mr)) : false,
      };
    })
    .sort((a, b) => {
      const rank = (r: WatchRow): number =>
        r.watch.auto ? 0 : r.agent ? 1 : !r.stillOpen ? 2 : r.moved ? 3 : 4;
      return rank(a) - rank(b) || a.repoLabel.localeCompare(b.repoLabel);
    });
}

const plain = mr({ iid: 1, repoLabel: 'Zeta' });
const moved = mr({ iid: 2, repoLabel: 'Alpha' });
const working = mr({ iid: 3, repoLabel: 'Web' });
const idle = mr({ iid: 4, repoLabel: 'Api' });
const auto = mr({ iid: 5, repoLabel: 'Zoo' });
const deadAgent = mr({ iid: 6, repoLabel: 'Beta' });
const autoMoved = mr({ iid: 7, repoLabel: 'Abc' });

const watches: Record<string, Watch> = Object.fromEntries([
  watchOn(plain),
  watchOn(moved, { seen: { ...fingerprint(moved), sha: 'older' } }),
  watchOn(working, { terminal: 't-working' }),
  watchOn(idle, { terminal: 't-idle' }),
  watchOn(auto, { auto: true, terminal: 't-gone' }),
  watchOn(deadAgent, { terminal: 't-dead' }),
  watchOn(autoMoved, { auto: true, terminal: 't-working', seen: { ...fingerprint(autoMoved), notes: 0 } }),
  { key: 'acme/closed/thing!9', projectPath: 'acme/closed/thing', iid: 9, webUrl: 'https://x/9', auto: false, seen: fingerprint(plain), addedAt: '' },
  { key: 'acme/closed/auto!10', projectPath: 'acme/closed/auto', iid: 10, webUrl: 'https://x/10', auto: true, seen: fingerprint(plain), addedAt: '', terminal: 't-idle' },
].map((w) => [w.key, w]));

const agents = new Map<string, AgentState>([
  ['t-working', { alive: true, working: true }],
  ['t-idle', { alive: true, working: false }],
  ['t-dead', { alive: false, working: true }],
]);

const open = [plain, moved, working, idle, auto, deadAgent, autoMoved];

test('rows match the reference build, whichever MRs are still open and whichever agents are alive', () => {
  for (const mrs of [open, [], [plain, moved], open.slice().reverse()]) {
    for (const live of [agents, new Map<string, AgentState>()]) {
      assert.deepEqual(watchRows(watches, mrs, live), oldAppRows(watches, mrs, live));
    }
  }
});

test('rows come out auto first, then agents, closed, moved, the rest, each by repo', () => {
  const rows = watchRows(watches, open, agents);
  assert.deepEqual(
    rows.map((r) => [r.watch.iid, r.repoLabel, r.agent ?? null, r.stillOpen, r.moved]),
    [
      [7, 'Abc', 'working', true, true],
      [10, 'auto', 'idle', false, false],
      [5, 'Zoo', null, true, false],
      [4, 'Api', 'idle', true, false],
      [3, 'Web', 'working', true, false],
      [9, 'thing', null, false, false],
      [2, 'Alpha', null, true, true],
      [6, 'Beta', null, true, false],
      [1, 'Zeta', null, true, false],
    ],
  );
  assert.equal(rows[2]?.watch, watches[mrKey(auto)], 'each row carries the watch itself');
  assert.equal('agent' in (rows[2] ?? {}), false, 'a row without a live agent has no agent key at all');
});

test('a watch whose MR left the list is closed and never moved, whatever its baseline says', () => {
  const [row] = watchRows({ [mrKey(moved)]: watches[mrKey(moved)]! }, [], new Map());
  assert.deepEqual([row?.stillOpen, row?.moved, row?.repoLabel], [false, false, 'engine']);
});

test('a watch has closed only when GitLab says merged or closed, or no longer has it, and a failed ask says neither', async () => {
  const answers: Record<string, unknown> = {
    'acme/engine!1': { project: { mergeRequest: { state: 'merged' } } },
    'acme/engine!2': { project: { mergeRequest: { state: 'closed' } } },
    'acme/engine!3': { project: { mergeRequest: { state: 'opened' } } },
    'acme/engine!4': { project: { mergeRequest: { state: 'locked' } } },
    'acme/engine!5': { project: { mergeRequest: null } },
    'acme/gone!6': { project: null },
  };
  const queries: string[] = [];
  const realFetch = globalThis.fetch;
  process.env['GITLAB_TOKEN'] = 'not-a-real-token';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const { query, variables } = JSON.parse(String(init?.body)) as { query: string; variables: { f: string; iid: string } };
    queries.push(query);
    const key = `${variables.f}!${variables.iid}`;
    if (key === 'acme/engine!7') return new Response('', { status: 502, statusText: 'Bad Gateway' });
    return Response.json({ data: answers[key] });
  }) as typeof fetch;
  try {
    const asked = [['acme/engine', 1], ['acme/engine', 2], ['acme/engine', 3], ['acme/engine', 4], ['acme/engine', 5], ['acme/gone', 6]] as const;
    const closed = await Promise.all(asked.map(([projectPath, iid]) => hasClosed({ projectPath, iid })));
    assert.deepEqual(closed, [true, true, false, false, true, true]);
    await assert.rejects(hasClosed({ projectPath: 'acme/engine', iid: 7 }), /GitLab GraphQL 502/);
    assert.ok(queries.every((q) => q.startsWith('query ')), 'only ever a query');
  } finally {
    globalThis.fetch = realFetch;
  }
});
