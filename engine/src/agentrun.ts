import { runAgent } from './agents/runner.js';

await runAgent(process.argv[2] ?? '');
