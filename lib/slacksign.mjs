import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { failure } from './engine.mjs';
import { slackRule } from './mcptools.mjs';
import { readJson, shellQuoted } from './run.mjs';
import { APP_NAME } from './product.mjs';
import { configDir } from './home.mjs';

const SIGN_SCRIPT = fileURLToPath(new URL('./slacksignhook.mjs', import.meta.url));
const SIGNED_TOOLS = ['slack_send_message', 'slack_send_message_draft', 'slack_schedule_message'];
export const DEFAULT_SIGNATURE = `Sent with ${APP_NAME}`;
const MAX_SIGNATURE = 80;
const HOOK_TIMEOUT_S = 5;
const ITALIC_LINE = /^[^\p{Cc}_]+$/u;

export const slackSettingsFile = () => join(configDir(), 'slack.json');

const validSignature = (text) => typeof text === 'string' && text.length <= MAX_SIGNATURE && text === text.trim() && ITALIC_LINE.test(text);

export function signingOf(saved) {
  return { sign: saved?.sign !== false, signature: validSignature(saved?.signature) ? saved.signature : DEFAULT_SIGNATURE };
}

export const loadSigning = async () => signingOf(await readJson(slackSettingsFile(), {}));

export function checkSignature(value) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return DEFAULT_SIGNATURE;
  if (!validSignature(text)) throw failure(400, `sign with one line of at most ${MAX_SIGNATURE} characters and no underscores`);
  return text;
}

export function signingHooks({ sign, signature }, node = process.execPath) {
  if (!sign) return {};
  const command = ['ELECTRON_RUN_AS_NODE=1', ...[node, SIGN_SCRIPT, signature].map(shellQuoted)].join(' ');
  return { PreToolUse: [{ matcher: SIGNED_TOOLS.map(slackRule).join('|'), hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] }] };
}
