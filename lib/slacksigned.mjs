export const MAX_MESSAGE = 5000;

export function signedMessage(message, signature) {
  if (!signature || typeof message !== 'string' || !message.trim()) return null;
  const line = `_${signature}_`;
  const body = message.trimEnd();
  if (body.endsWith(line)) return null;
  const signed = `${body}\n\n${line}`;
  return signed.length <= MAX_MESSAGE ? signed : null;
}
