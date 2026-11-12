#!/usr/bin/env node
// Stands in for one headless Claude Code read through a connector: it replays the stream a fixture file holds, so no test ever reaches Gmail or Slack.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const said = (text) => process.stdout.write(text);

if (args[0] === 'auth') {
  said(JSON.stringify(process.env.UNDERLINGS_FAKE_ACCOUNT ? JSON.parse(process.env.UNDERLINGS_FAKE_ACCOUNT) : { loggedIn: true, email: 'frank@example.com', orgName: 'Example Ltd' }));
  process.exit(0);
}

let input = '';
for await (const chunk of process.stdin) input += chunk;
const fixture = JSON.parse(readFileSync(process.env.UNDERLINGS_FAKE_READ, 'utf8'));
if (process.env.UNDERLINGS_FAKE_READ_CALLS) {
  const env = { MCP_CONNECTION_NONBLOCKING: process.env.MCP_CONNECTION_NONBLOCKING ?? null, GITLAB_TOKEN: process.env.GITLAB_TOKEN ?? null, CHILD_ENV_MARK: process.env.CHILD_ENV_MARK ?? null };
  appendFileSync(process.env.UNDERLINGS_FAKE_READ_CALLS, JSON.stringify({ args, input, env, cwd: process.cwd() }) + '\n');
}

function settingsFrom() {
  const at = args.indexOf('--settings');
  if (at < 0 || fixture.skipHooks) return {};
  const value = args[at + 1];
  return JSON.parse(value.trim().startsWith('{') ? value : readFileSync(value, 'utf8'));
}

const preToolUse = settingsFrom().hooks?.PreToolUse ?? [];
const matches = (matcher, name) => !matcher || matcher === '*' || new RegExp(`^(?:${matcher})$`).test(name);

// As Claude Code does: exit 2 or a deny blocks the call, updatedInput replaces what the tool gets, and a hook that fails or times out lets it run.
function hooked(name, toolInput) {
  let next = toolInput;
  for (const hook of preToolUse.filter((h) => matches(h.matcher, name)).flatMap((h) => h.hooks ?? [])) {
    const payload = { session_id: 'fake', hook_event_name: 'PreToolUse', tool_name: name, tool_input: next, tool_use_id: 'fake' };
    const ran = spawnSync('/bin/sh', ['-c', hook.command], { input: JSON.stringify(payload), encoding: 'utf8', timeout: (hook.timeout ?? 60) * 1000 });
    if (ran.error || (ran.status !== 0 && ran.status !== 2)) continue;
    if (ran.status === 2) return { blocked: ran.stderr.trim() || 'blocked by a hook' };
    const out = hookSaid(ran.stdout);
    if (out?.permissionDecision === 'deny') return { blocked: out.permissionDecisionReason ?? 'denied by a hook' };
    if (out?.updatedInput) next = out.updatedInput;
  }
  return { input: next };
}

function hookSaid(stdout) {
  try {
    return JSON.parse(stdout || 'null')?.hookSpecificOutput ?? null;
  } catch {
    return null;
  }
}

// A result naming $CHANNEL or $THREAD is given the values the tool finally ran with.
const outcomes = new Map();
function replay(event) {
  for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
    if (event.type === 'assistant' && block.type === 'tool_use') {
      const outcome = hooked(block.name, block.input ?? {});
      outcomes.set(block.id, outcome);
      if (!outcome.blocked && process.env.UNDERLINGS_FAKE_SLACK_CALLS) appendFileSync(process.env.UNDERLINGS_FAKE_SLACK_CALLS, JSON.stringify({ name: block.name, input: outcome.input }) + '\n');
    }
    const outcome = event.type === 'user' && block.type === 'tool_result' ? outcomes.get(block.tool_use_id) : null;
    if (outcome?.blocked) Object.assign(block, { is_error: true, content: [{ type: 'text', text: outcome.blocked }] });
    else if (outcome) block.content = JSON.parse(JSON.stringify(block.content ?? '').replaceAll('$CHANNEL', outcome.input.channel_id ?? '').replaceAll('$THREAD', outcome.input.thread_ts ?? ''));
  }
  return event;
}

if (fixture.delayMs) await new Promise((resolve) => setTimeout(resolve, fixture.delayMs));
if (fixture.mode === 'hang') setInterval(() => {}, 1000);
else if (fixture.mode === 'garbage') said('this is not stream JSON at all\n{"half": ');
else {
  for (const event of fixture.events) said(JSON.stringify(replay(event)) + '\n');
  process.exit(fixture.exitCode ?? 0);
}
