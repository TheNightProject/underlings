#!/usr/bin/env node
// Stands in for a review agent: connects to the MCP server --mcp-config names, queues the finding it is given, then ends its turn.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const session = flag('--resume') ?? flag('--session-id');
const record = (entry) => appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify(entry)}\n`);
const input = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
const prompt = JSON.parse((await input.next()).value).message.content;

const [name, server] = Object.entries(JSON.parse(flag('--mcp-config')).mcpServers)[0];
const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
let id = 0;
async function call(method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: (id += 1), method, params })}\n`);
  return JSON.parse((await replies.next()).value).result;
}
await call('initialize', { protocolVersion: '2025-06-18' });
const tools = (await call('tools/list', {})).tools.map((t) => t.name);
const queued = await call('tools/call', { name: 'queue_findings', arguments: { findings: [JSON.parse(process.env.FAKE_REVIEW_FINDING)] } });
child.stdin.end();
record({ argv: args, prompt, server: name, tools, queued });

const say = (event) => process.stdout.write(`${JSON.stringify({ ...event, session_id: session })}\n`);
say({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: tools.map((t) => `mcp__${name}__${t}`), model: 'fake', permissionMode: 'auto' });
say({ type: 'assistant', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Queued one finding.' }] }, parent_tool_use_id: null });
say({ type: 'result', subtype: 'success', is_error: false, result: 'Queued one finding.', num_turns: 1 });
while (!(await input.next()).done);
