import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { fetchDiscussions } = await import('./data/gitlab.js');

let reply: unknown = [];
const realFetch = globalThis.fetch;

globalThis.fetch = (async () =>
  new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});

const author = { username: 'ivan' };
const note = (extra: object) => ({ author, body: 'Hm.', created_at: '2026-11-05T10:00:00Z', system: false, ...extra });

test('a general thread stays resolvable once resolved, and a plain comment never is', async () => {
  reply = [
    { id: 'line', notes: [note({ type: 'DiffNote', resolvable: true, resolved: false, position: { new_path: 'a.ts', new_line: 3 } })] },
    { id: 'general-open', notes: [note({ type: 'DiscussionNote', resolvable: true, resolved: false })] },
    { id: 'general-resolved', notes: [note({ type: 'DiscussionNote', resolvable: true, resolved: true }), note({ type: 'DiscussionNote', resolvable: true, resolved: true })] },
    { id: 'plain', individual_note: true, notes: [note({ type: null, resolvable: false })] },
  ];
  const shaped = await fetchDiscussions(1, 82);
  assert.deepEqual(
    shaped.map((d) => [d.id, d.resolved, d.resolvable]),
    [
      ['line', false, true],
      ['general-open', false, true],
      ['general-resolved', true, true],
      ['plain', true, false],
    ],
  );
});

test('each note keeps its id, so a thread can be linked to', async () => {
  reply = [{ id: 'line', notes: [note({ id: 41, resolvable: true, resolved: false }), note({ id: 42, resolvable: true, resolved: false }), note({ id: 43, system: true })] }];
  const [thread] = await fetchDiscussions(1, 82);
  assert.deepEqual(thread?.notes.map((n) => n.id), [41, 42]);
});
