import { readFileSync, writeFileSync } from 'node:fs';

const SEND = 'mcp__claude_ai_Slack__slack_send_message';
const WAIT_MS = 4000;
const MAX_INPUT = 256 * 1024;

// Claude Code runs a tool whose hook fails or times out, so every way out of here but the one approved send blocks the call.
setTimeout(() => refuse('the send check took too long'), WAIT_MS).unref();

function refuse(why) {
  process.exitCode = 2;
  process.stderr.write(`${why}\n`, () => process.exit(2));
}

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > MAX_INPUT) throw new Error('too much input');
  }
  return JSON.parse(raw);
}

async function check() {
  const approvedFile = process.argv[2];
  const call = await readInput();
  if (call?.tool_name !== SEND) return refuse('Only the one approved message may be sent, and no other tool may run.');
  const approved = JSON.parse(readFileSync(approvedFile, 'utf8'));
  writeFileSync(`${approvedFile}.used`, '', { flag: 'wx', mode: 0o600 });
  const updatedInput = { channel_id: approved.channel_id, message: approved.message, ...(approved.thread_ts ? { thread_ts: approved.thread_ts } : {}), reply_broadcast: false };
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } }));
}

check().catch(() => refuse('The approved message was sent once already, or could not be read, so nothing more is sent.'));
