import { readFile } from 'node:fs/promises';

const WAIT_MS = 2000;
const MAX_INPUT = 256 * 1024;

// Claude Code waits for its hooks, so whatever goes wrong this says nothing and exits 0, within two seconds.
setTimeout(() => process.exit(0), WAIT_MS).unref();

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > MAX_INPUT) throw new Error('too much input');
  }
  return JSON.parse(raw);
}

async function tell() {
  const said = await readInput();
  const where = JSON.parse(await readFile(process.argv[2] ?? '', 'utf8'));
  const body = { event: said.hook_event_name, session: said.session_id, message: said.hook_event_name === 'Notification' ? said.message : undefined };
  await fetch(`${where.url}/api/hook/claude`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cc-hook-token': where.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(WAIT_MS),
  });
}

tell().catch(() => {}).finally(() => process.exit(0));
