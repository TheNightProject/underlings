import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { dayOf } from './locale.mjs';
import { countTokens, freshCache, tokenDays, usageLine } from './game-tokens.mjs';

const home = await mkdtemp(join(tmpdir(), 'control-centre-game-tokens-'));
after(() => rm(home, { recursive: true }));
const SECRET = 'TOP SECRET PLAN';
let n = 0;
const fresh = async () => {
  const root = join(home, `projects-${++n}`);
  await mkdir(join(root, '-Users-frank-ws'), { recursive: true });
  return root;
};

function said(id, at, usage, extra = {}) {
  return JSON.stringify({
    parentUuid: 'p', isSidechain: false, cwd: '/work', sessionId: 's1', type: 'assistant', uuid: `u-${id}-${Math.random()}`, timestamp: at,
    message: { model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content: [{ type: 'text', text: `${SECRET} "usage":{"input_tokens":999999}` }], usage: { cache_creation: { ephemeral_5m_input_tokens: 0 }, ...usage } },
    ...extra,
  });
}

const usage = (input, write, output, read = 0) => ({ input_tokens: input, cache_creation_input_tokens: write, output_tokens: output, cache_read_input_tokens: read, service_tier: 'standard' });
const user = (at) => JSON.stringify({ type: 'user', timestamp: at, message: { role: 'user', content: [{ type: 'tool_result', content: SECRET }] }, toolUseResult: { type: 'assistant', message: { id: 'msg_inner', usage: usage(500000, 0, 0) } } });
const write = (path, lines) => writeFile(path, lines.map((l) => l + '\n').join(''));
const count = (root, cache) => countTokens({ roots: [root], cache, since: '2026-06-01', dayOf });

test('a message counts its input, what it wrote to the cache and its output, not cache reads, on its London day', async () => {
  const root = await fresh();
  await write(join(root, '-Users-frank-ws', 'a.jsonl'), [
    said('msg_1', '2026-07-01T10:00:00Z', usage(3, 1000, 200, 900000)),
    said('msg_2', '2026-07-01T23:30:00Z', usage(1, 50, 10)),
    user('2026-07-01T10:01:00Z'),
  ]);
  const { cache } = await count(root);
  assert.deepEqual(tokenDays(cache), { '2026-07-01': 1203, '2026-07-02': 61 }, 'half past eleven UTC in July is the next day in London');
});

test('a message Claude Code wrote over several lines, or copied into a second session file, counts once', async () => {
  const root = await fresh();
  const line = said('msg_split', '2026-07-03T09:00:00Z', usage(2, 400, 100));
  await write(join(root, '-Users-frank-ws', 'one.jsonl'), [line, line, said('msg_split', '2026-07-03T09:00:01Z', usage(2, 400, 100))]);
  await mkdir(join(root, '-Users-frank-ws', 'one', 'subagents'), { recursive: true });
  await write(join(root, '-Users-frank-ws', 'one', 'subagents', 'agent-1.jsonl'), [said('msg_sub', '2026-07-03T09:05:00Z', usage(1, 9, 0))]);
  await write(join(root, '-Users-frank-ws', 'resumed.jsonl'), [line, said('msg_new', '2026-07-03T10:00:00Z', usage(0, 0, 8))]);
  const { cache, sessions } = await count(root);
  assert.deepEqual(tokenDays(cache), { '2026-07-03': 502 + 10 + 8 });
  assert.deepEqual([...sessions].sort(), ['agent-1', 'one', 'resumed']);
});

test('reading again adds only what was written since, and a line half written is read once it is whole', async () => {
  const root = await fresh();
  const path = join(root, '-Users-frank-ws', 'live.jsonl');
  await write(path, [said('msg_a', '2026-07-04T09:00:00Z', usage(1, 1, 1))]);
  const first = await count(root);
  const again = await count(root, first.cache);
  assert.equal(again.changed, false);
  const next = said('msg_b', '2026-07-04T09:30:00Z', usage(10, 10, 10));
  await appendFile(path, next.slice(0, 40));
  assert.deepEqual(tokenDays((await count(root, first.cache)).cache), { '2026-07-04': 3 }, 'the torn line waits');
  await appendFile(path, next.slice(40) + '\n');
  const whole = await count(root, first.cache);
  assert.deepEqual(tokenDays(whole.cache), { '2026-07-04': 33 });
  const restarted = await count(root, JSON.parse(JSON.stringify(whole.cache)));
  assert.deepEqual(tokenDays(restarted.cache), { '2026-07-04': 33 }, 'a cache saved and loaded again counts nothing twice');
});

test('a file replaced or cut short is read again from the start without counting what it held twice', async () => {
  const root = await fresh();
  const path = join(root, '-Users-frank-ws', 'swap.jsonl');
  await write(path, [said('msg_x', '2026-07-05T09:00:00Z', usage(5, 5, 5)), said('msg_y', '2026-07-05T09:01:00Z', usage(5, 5, 5))]);
  const { cache } = await count(root);
  await write(path + '.new', [said('msg_x', '2026-07-05T09:00:00Z', usage(5, 5, 5)), said('msg_z', '2026-07-05T09:02:00Z', usage(1, 0, 0))]);
  await rename(path + '.new', path);
  assert.deepEqual(tokenDays((await count(root, cache)).cache), { '2026-07-05': 31 });
  await write(path, [said('msg_y', '2026-07-05T09:01:00Z', usage(5, 5, 5))]);
  assert.deepEqual(tokenDays((await count(root, cache)).cache), { '2026-07-05': 31 });
});

test('what a message says is never parsed: only the usage numbers and the id are, and nothing of it is kept', async () => {
  const root = await fresh();
  const tool = { type: 'tool_use', id: 'toolu_1', name: 'Write', input: { usage: { input_tokens: 7000000 }, note: `${SECRET} \\"type\\":\\"assistant\\"` } };
  const line = JSON.stringify({ type: 'assistant', timestamp: '2026-07-06T09:00:00Z', message: { id: 'msg_t', content: [tool, { type: 'text', text: SECRET }], usage: usage(1, 2, 3) } });
  await write(join(root, '-Users-frank-ws', 'p.jsonl'), [line, user('2026-07-06T09:00:00Z'), `{"type":"assistant","message":{"content":"${SECRET}`]);
  const parsed = [];
  const real = JSON.parse;
  JSON.parse = function spy(text, ...rest) {
    parsed.push(String(text));
    return real.call(this, text, ...rest);
  };
  let result;
  try {
    result = await count(root);
  } finally {
    JSON.parse = real;
  }
  assert.deepEqual(tokenDays(result.cache), { '2026-07-06': 6 });
  assert.ok(parsed.length > 0);
  assert.deepEqual(parsed.filter((t) => t.includes(SECRET) || t.includes('content')), []);
  assert.doesNotMatch(JSON.stringify(result.cache), new RegExp(`${SECRET}|msg_t`));
});

test('a line is read only for an assistant message at the top, whatever is nested inside other lines', () => {
  assert.equal(usageLine(user('2026-07-06T09:00:00Z')), null);
  assert.equal(usageLine('{"type":"summary","summary":"x"}'), null);
  assert.equal(usageLine('not json at all'), null);
  assert.deepEqual(usageLine(said('msg_q', '2026-07-06T09:00:00Z', usage(1, 2, 3))), { id: 'msg_q', at: Date.parse('2026-07-06T09:00:00Z'), tokens: 6 });
});

test('days before the window are left out, and a file not touched since is not even opened', async () => {
  const root = await fresh();
  const old = join(root, '-Users-frank-ws', 'old.jsonl');
  await write(old, [said('msg_o', '2026-07-07T09:00:00Z', usage(9, 9, 9))]);
  const longAgo = new Date('2026-05-01T00:00:00Z');
  await utimes(old, longAgo, longAgo);
  await write(join(root, '-Users-frank-ws', 'mixed.jsonl'), [said('msg_m1', '2026-05-20T09:00:00Z', usage(4, 4, 4)), said('msg_m2', '2026-07-07T09:00:00Z', usage(1, 1, 1))]);
  const { cache } = await count(root, freshCache());
  assert.deepEqual(tokenDays(cache), { '2026-07-07': 3 });
  assert.equal(cache.files[old], undefined);
  assert.equal((await readFile(old, 'utf8')).length > 0, true);
});
