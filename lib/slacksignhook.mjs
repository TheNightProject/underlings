import { signedMessage } from './slacksigned.mjs';

const WAIT_MS = 2000;
const MAX_INPUT = 256 * 1024;

// Claude Code waits for its hooks, so whatever goes wrong this leaves the message as it was and exits 0, within two seconds.
setTimeout(() => process.exit(0), WAIT_MS).unref();

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > MAX_INPUT) throw new Error('too much input');
  }
  return JSON.parse(raw);
}

async function sign() {
  const input = (await readInput()).tool_input;
  const message = signedMessage(input?.message, process.argv[2]);
  if (message) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, message } } }));
}

sign().catch(() => {});
