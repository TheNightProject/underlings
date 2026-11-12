import { createInterface } from 'node:readline';
import { answerLine } from './reviewtools.js';

for await (const line of createInterface({ input: process.stdin })) {
  const answer = line.trim() ? answerLine(line) : null;
  if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
}
