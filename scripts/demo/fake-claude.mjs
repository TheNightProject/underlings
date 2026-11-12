#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { gmailRun } from '../../lib/fixtures/gmail.mjs';
import { draftRun, slackRun, threadAnswer, channelAnswer, toolRun } from '../../lib/fixtures/slack.mjs';
import { gmailWorld, SLACK_ME, slackWorld } from './world-messages.mjs';

const args = process.argv.slice(2);
const epoch = Number(process.env.DEMO_EPOCH) || Date.now();
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (args[0] === 'auth') {
  out({ loggedIn: true, email: 'frank.foster@example.com', orgName: 'Acme Ltd' });
  process.exit(0);
}

async function interactive() {
  const session = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
  const emit = (event) => out({ ...event, session_id: session });
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  if ((await lines.next()).done) process.exit(0);
  emit({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'claude-sonnet-5-5', permissionMode: 'default' });
  await sleep(900);
  emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'notes/thread.md' } }] } });
  await sleep(1500);
  emit({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'I have read the thread. Working out what it asks of you before I draft anything.' }] } });
  while (!(await lines.next()).done);
}

async function headless() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const events = answer(input, args.join('\n'));
  for (const event of events) out(event);
}

const callsIn = (text) => [...text.matchAll(/(slack_read_(?:thread|channel)) (\{[^}]*\})/g)].map(([, name, json]) => [`mcp__claude_ai_Slack__${name}`, JSON.parse(json)]);

function searchName(search) {
  if (search.channel_types) return 'dm';
  if (String(search.filters).startsWith('with:')) return 'thread';
  if (String(search.filters).startsWith('from:me')) return 'own';
  return 'mention';
}

function answer(input, flags) {
  const slack = slackWorld(epoch);
  if (/^Make these \d+ searches/m.test(input)) {
    const asked = input.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((a) => ({ name: searchName(a), args: a }));
    return slackRun({ asked, me: SLACK_ME, found: slack.found, picks: slack.picks });
  }
  if (input.startsWith('Search with these arguments')) {
    const { threads, picks } = gmailWorld(epoch);
    return gmailRun({ threads, picks });
  }
  if (input.startsWith('Suggest my reply')) return draftReply(input, slack);
  if (/^Make these \d+ calls together/m.test(input)) return conversation(callsIn(input), slack);
  return toolRun([], { output: {} });
}

const heard = (messages) => messages.map((m) => ({ ...m }));

function threadOrChannel(name, input, messages) {
  if (name.endsWith('read_thread')) return threadAnswer(heard(messages));
  const after = input.oldest ? messages.filter((m) => Number(m.ts) >= Number(input.oldest)) : messages;
  return channelAnswer(after.length ? after : messages, { channel: 'DM (' + input.channel_id + ')' });
}

function conversation(calls, slack) {
  const given = calls.map(([name, input]) => [name, input, threadOrChannel(name, input, slack.conversations[input.channel_id] ?? [])]);
  return toolRun(given, {});
}

function draftReply(input, slack) {
  const channel = /\((?:C|D|G)[A-Z0-9]+\)/.exec(input.split('\n').find((l) => l.startsWith('in:')) ?? '')?.[0].slice(1, -1);
  const calls = callsIn(input).map(([name, args2]) => [name, args2, threadOrChannel(name, args2, slack.conversations[args2.channel_id] ?? [])]);
  return draftRun(slack.replies[channel] ?? 'Thanks, I will look at it today.', { calls });
}

if (args.includes('--input-format')) await interactive();
else await headless();
