import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { failure, requireEngine } from './engine.mjs';
import { noteUsage } from './models.mjs';
import { readJson, run, withoutForgeTokens } from './run.mjs';

const MINUTE = 60_000;
const ACCOUNT_TIMEOUT_MS = 15_000;
const STOPPED = { error_max_budget_usd: 'it reached its spending cap', error_during_execution: 'it failed part way', error_max_structured_output_retries: 'it never gave its answer in the agreed shape' };
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
let writes = 0;

// Each write has a temp file of its own, since a second worker can rewrite the same file at once.
export async function writePrivate(path, value) {
  writes += 1;
  const temp = `${path}.${process.pid}.${writes}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, JSON.stringify(value) + '\n', { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

const BUDGET = /^\d{1,2}(?:\.\d{1,2})?$/;
const EVERY = { min: 5, max: 240 };

export const budgetOf = (value, fallback) => (typeof value === 'string' && BUDGET.test(value) && Number(value) > 0 ? value : fallback);
export const everyOf = (value, fallback) => (Number.isInteger(value) && value >= EVERY.min && value <= EVERY.max ? value : fallback);

export function checkBudget(value) {
  const typed = String(value ?? '').trim().replace(/^\$/, '');
  if (!budgetOf(typed, null)) throw failure(400, 'the spend cap is an amount of US dollars above nothing, such as 0.30');
  return typed;
}

export function checkEvery(value) {
  const minutes = Number(value);
  if (!everyOf(minutes, null)) throw failure(400, `reads run every ${EVERY.min} to ${EVERY.max} minutes`);
  return minutes;
}

// A lock in the state folder, so a second worker, or this one just after a reload, never runs the same read at once.
export async function takeLock(path, heldMs, now = Date.now()) {
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify({ pid: process.pid, at: now }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const held = await readJson(path, null);
    if (held && alive(held.pid) && now - held.at < heldMs) return false;
    await rm(path, { force: true });
  }
  return false;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// The claude.ai connectors would otherwise still be connecting when the one turn starts, so theirs would not be there.
export function fetchEnv(env) {
  return { ...withoutForgeTokens(env), MCP_CONNECTION_NONBLOCKING: 'false' };
}

// bin and env come back even when the run fails, so the account it ran as can still be read.
export async function headlessRun(task, args, input, timeoutMs, what = 'the read') {
  let bin = null;
  let env = null;
  try {
    const engine = requireEngine('claudeBinary', 'childEnv');
    bin = engine.claudeBinary();
    env = fetchEnv(engine.childEnv(bin));
    const stdout = await run(bin, args, env, { timeout: timeoutMs, cwd: tmpdir(), input }).catch(stoppedRun(bin, timeoutMs, what));
    noteUsage(task, streamEvents(stdout).findLast((e) => e.type === 'result'));
    return { bin, env, stdout };
  } catch (err) {
    return { bin, env, error: err.message };
  }
}

// Nothing Claude says is passed on, as its words may quote what it read.
function stoppedRun(bin, timeoutMs, what) {
  return (err) => {
    if (err.killed) throw failure(504, `${what} took longer than ${timeoutMs / MINUTE} minutes, so it was stopped`);
    if (err.code === 'ENOENT') throw failure(503, `Claude Code is not at ${bin}`);
    if (err.stdout) return err.stdout;
    throw failure(502, `Claude Code did not run${Number.isInteger(err.code) ? ` (exit ${err.code})` : ''}`);
  };
}

export function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

export const streamEvents = (stdout) => String(stdout ?? '').split('\n').map(parseJson).filter(Boolean);

export function finishedRun(events, { tool, missing }) {
  const result = events.findLast((e) => e.type === 'result');
  if (!result) throw failure(502, 'Claude Code did not answer in the shape the read expects');
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  if (Array.isArray(init?.tools) && !init.tools.includes(tool)) throw failure(503, missing(init));
  if (result.is_error || result.subtype !== 'success') throw failure(502, `Claude Code stopped: ${STOPPED[result.subtype] ?? result.subtype ?? 'it gave no reason'}`);
  return result;
}

export function toolCalls(events, names) {
  const uses = new Map();
  const calls = [];
  for (const e of events) {
    for (const block of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (e.type === 'assistant' && block.type === 'tool_use') uses.set(block.id, block);
      const use = uses.get(block.tool_use_id);
      if (e.type === 'user' && block.type === 'tool_result' && use) calls.push({ name: use.name, input: use.input ?? {}, error: Boolean(block.is_error), body: resultText(block.content) });
    }
  }
  return calls.filter((c) => names.includes(c.name));
}

function resultText(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part) => (part?.type === 'text' ? part.text : '')).join('') : '';
}

export function plain(text, max) {
  const decoded = String(text ?? '').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
  });
  const flat = decoded.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

export const reasonOf = (text, max) => plain(text, max).replace(/\s*\u2014\s*/g, ', ');

export async function readAccount(bin, env) {
  if (!bin) return null;
  try {
    const out = JSON.parse(await run(bin, ['auth', 'status', '--json'], env, { timeout: ACCOUNT_TIMEOUT_MS, cwd: tmpdir() }));
    return out?.loggedIn ? { email: typeof out.email === 'string' ? out.email : null, org: typeof out.orgName === 'string' ? out.orgName : null } : null;
  } catch {
    return null;
  }
}
