import { appendFileSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';

const AFTER_MS = [1200, 3200];
const lines = (file) => {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const write = (dir, record) => appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ at: Date.now(), ...record })}\n`);
const assistant = (content) => ({ event: { type: 'assistant', message: { role: 'assistant', content } } });

// Stands in for each agent's runner, which would take what the page sends and carry on, so an answer on camera has an effect.
export function answerAgents(agentsDir) {
  const handled = new Set();
  const respond = (dir) => {
    const sent = new Set(lines(join(dir, 'events.jsonl')).flatMap((r) => (r.host?.kind === 'sent' ? [r.host.id] : [])));
    for (const input of lines(join(dir, 'input.jsonl'))) {
      if (sent.has(input.id) || handled.has(input.id)) continue;
      handled.add(input.id);
      write(dir, { host: { kind: 'sent', id: input.id, message: input.message, ...(input.answers ? { answers: input.answers } : {}) } });
      setTimeout(() => write(dir, assistant([{ type: 'tool_use', id: `tu-${input.id}`, name: 'Read', input: { file_path: 'src/flags.ts' } }])), AFTER_MS[0]);
      setTimeout(() => write(dir, assistant([{ type: 'text', text: 'Thanks, carrying on with that.' }])), AFTER_MS[1]);
    }
  };
  const watcher = watch(agentsDir, { recursive: true }, (_event, name) => {
    if (String(name).endsWith('input.jsonl')) respond(join(agentsDir, String(name).split('/')[0]));
  });
  return () => watcher.close();
}
