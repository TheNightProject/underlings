#!/usr/bin/env node
// Stands in for `claude -p --input-format stream-json`: replays a recorded stream, waiting wherever the real one waited on its input.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const resumed = flag('--resume');
const session = resumed ?? flag('--session-id');
const record = (entry) => process.env.FAKE_CLAUDE_LOG && appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
const recorded = readFileSync(resumed ? process.env.FAKE_CLAUDE_RESUME : process.env.FAKE_CLAUDE_FIRST, 'utf8').split('\n').filter(Boolean);
const original = JSON.parse(recorded[0]).session_id;
const events = recorded.map((line) => JSON.parse(line.split(original).join(session)));
const holdMs = Number(process.env.FAKE_CLAUDE_HOLD_MS ?? 0);
const holdAt = process.env.FAKE_CLAUDE_HOLD_AT ?? 'result';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

record({ argv: args, cwd: process.cwd(), orcaVars: Object.keys(process.env).filter((name) => name.startsWith('ORCA_')), subagentModel: process.env.CLAUDE_CODE_SUBAGENT_MODEL ?? null, subagentForce: process.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ?? null });

const inbox = [];
let ended = false;
let wake = () => {};
createInterface({ input: process.stdin })
  .on('line', (line) => {
    const message = JSON.parse(line);
    record({ stdin: message });
    inbox.push(message);
    wake();
  })
  .on('close', () => {
    ended = true;
    wake();
  });

async function next(type) {
  for (;;) {
    const at = inbox.findIndex((m) => m.type === type);
    if (at >= 0) return inbox.splice(at, 1)[0];
    if (ended) return null;
    await new Promise((resolve) => { wake = resolve; });
  }
}

if (!(await next('user'))) process.exit(0);
for (const [n, event] of events.entries()) {
  if (event.type === holdAt) await sleep(holdMs);
  if (event.type === 'result') event.queued_turn_count = inbox.filter((m) => m.type === 'user').length;
  process.stdout.write(`${JSON.stringify(event)}\n`);
  if (event.type === 'control_request' && !(await next('control_response'))) process.exit(143);
  if (event.type === 'result' && n < events.length - 1 && !(await next('user'))) process.exit(0);
}
await next('end of input');
record({ exit: 0 });
