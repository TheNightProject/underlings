#!/usr/bin/env node
// Stands in for Claude Code run headless with stream-json: one review turn, in the shapes the real one streams, then it waits for its input to close.
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const session = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const emit = (event) => process.stdout.write(`${JSON.stringify({ ...event, session_id: session })}\n`);
const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();

if ((await lines.next()).done) process.exit(0);
emit({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'claude-haiku-5-5', permissionMode: 'default' });
emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'git diff origin/main' } }] } });
emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: process.env.UNDERLINGS_FAKE_CLAUDE_SAYS ?? 'Nothing to raise.' }] } });
emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', num_turns: 1, queued_turn_count: 0 });
while (!(await lines.next()).done);
