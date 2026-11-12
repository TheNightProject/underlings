import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { describe, SERVER, TOOLS } from './mcptools.mjs';
import { loadProfile, person } from './profile.mjs';
import { APP_NAME } from './product.mjs';

const PROTOCOL = '2025-06-18';
const CALL_MS = 180_000;
const NOT_RUNNING = `${APP_NAME} is not running, so its tools cannot be reached until it is opened again.`;

// Read on every list, so a name changed in Settings reaches a session already running.
async function listed() {
  const who = person(await loadProfile());
  return TOOLS.map((tool) => {
    const { name, title, inputSchema, action, draft } = tool;
    return { name, title, description: describe(tool, who), inputSchema, annotations: { title, readOnlyHint: !action && !draft, destructiveHint: Boolean(action), openWorldHint: true } };
  });
}

const METHODS = {
  initialize: (params) => ({
    protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
    capabilities: { tools: {} },
    serverInfo: { name: SERVER, version: '1.0.0' },
  }),
  ping: () => ({}),
  'tools/list': async () => ({ tools: await listed() }),
  'tools/call': (params) => callTool(params?.name, params?.arguments ?? {}),
};

const said = (text, isError = false) => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

// Read on every call, so a worker restarted on another port, or with a new token, is found without restarting the session.
async function endpoint() {
  try {
    return JSON.parse(await readFile(process.env.UNDERLINGS_MCP_ENDPOINT ?? '', 'utf8'));
  } catch {
    return null;
  }
}

async function callTool(name, args) {
  if (!TOOLS.some((t) => t.name === name)) return said(`There is no tool called ${name}.`, true);
  const where = await endpoint();
  if (!where?.url || !where?.token) return said(NOT_RUNNING, true);
  try {
    const res = await fetch(`${where.url}/api/mcp/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cc-mcp-token': where.token },
      body: JSON.stringify({ tool: name, args }),
      signal: AbortSignal.timeout(CALL_MS),
    });
    const text = await res.text();
    if (!res.ok) return said(text || `${APP_NAME} answered ${res.status}.`, true);
    return said(JSON.parse(text).text ?? '');
  } catch (err) {
    return said(err.name === 'TimeoutError' ? `${APP_NAME} took over ${CALL_MS / 1000} s to answer.` : NOT_RUNNING, true);
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function answer(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'that line is not JSON' } });
  }
  if (message.id === undefined || message.id === null) return;
  const method = METHODS[message.method];
  if (!method) return write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no method ${message.method}` } });
  try {
    write({ jsonrpc: '2.0', id: message.id, result: await method(message.params) });
  } catch (err) {
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: err.message } });
  }
}

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim()) answer(line);
}
