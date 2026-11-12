import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishedRun, headlessRun, parseJson, streamEvents, toolCalls } from './connector.mjs';
import { failure } from './engine.mjs';
import { SLACK_WRITES, slackRule } from './mcptools.mjs';
import { taskArgs } from './models.mjs';
import { shellQuoted } from './run.mjs';
import { missingSlack } from './slackreply.mjs';
import { MAX_MESSAGE, signedMessage } from './slacksigned.mjs';

const MINUTE = 60_000;
const SEND_TIMEOUT_MS = 2 * MINUTE;
const SEND_BUDGET_USD = '0.20';
const HOOK_TIMEOUT_S = 15;
const HOOK = fileURLToPath(new URL('./slacksendhook.mjs', import.meta.url));
const SEND = slackRule('slack_send_message');
const LINK = /https:\/\/[a-z0-9-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{16})(?:\?[\w.=&%-]*)?/g;
const ERROR_CODE = /^[a-z][a-z_]{1,60}$/;

const SEND_PROMPT = [
  'You send one Slack message, exactly as it was written.',
  'Call slack_send_message once, with exactly the arguments the user message gives, then answer with the one word done.',
  'Make no other calls, and never change, add to or shorten the message.',
].join('\n');

export function finalMessage(text, { sign, signature }) {
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body) throw failure(400, 'write the reply first');
  const signed = sign ? signedMessage(body, signature) ?? (body.endsWith(`_${signature}_`) ? body : null) : body;
  if (!signed || signed.length > MAX_MESSAGE) throw failure(400, `a Slack message holds at most ${MAX_MESSAGE} characters${sign ? ', the signature included' : ''}`);
  return signed;
}

export function sendSettings(approvedFile, node = process.execPath) {
  const command = ['ELECTRON_RUN_AS_NODE=1', ...[node, HOOK, approvedFile].map(shellQuoted)].join(' ');
  return { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }] } };
}

function sendArgs(approvedFile) {
  return [
    '-p',
    ...taskArgs('reads'),
    '--permission-mode', 'dontAsk',
    '--tools', '',
    '--allowedTools', SEND,
    '--disallowedTools', ...SLACK_WRITES.filter((name) => slackRule(name) !== SEND).map(slackRule),
    '--settings', JSON.stringify(sendSettings(approvedFile)),
    '--system-prompt', SEND_PROMPT,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-budget-usd', SEND_BUDGET_USD,
    '--no-session-persistence',
    '--disable-slash-commands',
    '--setting-sources', '',
  ];
}

const approvedOf = ({ channel, threadTs, message }) => ({ channel_id: channel, ...(threadTs ? { thread_ts: threadTs } : {}), message });

const sendPrompt = (target) => `slack_send_message ${JSON.stringify(approvedOf(target))}`;

const exists = (path) => stat(path).then(() => true, () => false);

// The model is told the approved values too, but only the hook decides what reaches Slack, and it lets one send through.
export async function sendApproved(target) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-slack-send-'));
  const approved = join(dir, 'approved.json');
  try {
    await writeFile(approved, JSON.stringify(approvedOf(target)), { mode: 0o600 });
    const started = Date.now();
    const ran = await headlessRun('reads', sendArgs(approved), sendPrompt(target), SEND_TIMEOUT_MS, 'the send');
    const passed = await exists(`${approved}.used`);
    if (ran.error) throw failure(502, passed ? 'Claude Code stopped after the message went to Slack, so it may have been sent: check Slack before sending again' : `Nothing was sent: ${ran.error}`);
    return { ...sentIn(ran.stdout, target, passed), ms: Date.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sentIn(stdout, target, passed) {
  const events = streamEvents(stdout);
  const sends = toolCalls(events, [SEND]);
  const taken = sends.filter((c) => !c.error);
  if (taken.length && !passed) throw failure(502, 'Slack took a message the send check never saw, so it may not be what you approved: check Slack');
  if (!taken.length) {
    finishedRun(events, { tool: SEND, missing: missingSlack });
    throw failure(502, sends.length ? 'Slack did not take the message, so nothing was sent' : 'Claude never sent the message, so nothing was sent');
  }
  const result = events.findLast((e) => e.type === 'result');
  return { link: confirmedLink(taken[0].body, target), costUsd: Number(result?.total_cost_usd) || null };
}

const stringsIn = (value) => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(stringsIn) : []);

// Slack answers with JSON whose slashes are escaped, naming where the message went; a DM sent to a user id lands in the DM channel Slack gives it.
function confirmedLink(body, target) {
  const answer = parseJson(body);
  const code = typeof answer?.error === 'string' && ERROR_CODE.test(answer.error) ? ` (${answer.error})` : '';
  if (answer?.ok === false || code) throw failure(502, `Slack did not take the message${code}, so nothing was sent`);
  const ours = (id) => id === target.channel || (target.channel.startsWith('U') && id.startsWith('D'));
  return linkIn(answer ? stringsIn(answer) : [String(body)], ours) ?? linkBuilt(answer?.message_context ?? answer, ours, target);
}

function linkIn(texts, ours) {
  const links = texts.flatMap((text) => [...text.matchAll(LINK)]);
  if (links.some((m) => !ours(m[1]))) throw failure(502, 'Slack says the message went to another conversation: check Slack');
  return links[0]?.[0] ?? null;
}

function linkBuilt(where, ours, { threadTs, host }) {
  const ts = [where?.message_ts, where?.ts].find((v) => typeof v === 'string' && /^\d{9,10}\.\d{6}$/.test(v));
  const at = [where?.channel_id, where?.channel].find((v) => typeof v === 'string' && ours(v));
  if (!ts || !at || !host) return null;
  return `https://${host}/archives/${at}/p${ts.replace('.', '')}${threadTs ? `?thread_ts=${threadTs}&cid=${at}` : ''}`;
}
