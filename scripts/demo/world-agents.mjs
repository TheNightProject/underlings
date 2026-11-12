const MINUTE = 60_000;
const uuid = (n) => `d3a0${String(n).padStart(4, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const REPO = '/work/acme';

const say = (text) => ({ say: text });
const tool = (name, input) => ({ tool: name, input });
const bash = (command) => tool('Bash', { command });
const read = (file_path) => tool('Read', { file_path });
const edit = (file_path) => tool('Edit', { file_path, old_string: 'a', new_string: 'b' });

const mrPrompt = (path, iid, title) => `Review https://gitlab.com/${path}/-/merge_requests/${iid} (${title}) and queue what you find.`;

const SPECS = [
  {
    n: 1, name: 'review-engine-7', title: 'review engine!7', kind: 'review', mr: 'acme/engine!7', model: 'sonnet', effort: 'high', running: 'claude-sonnet-5-5', start: 9, stand: 'working',
    prompt: mrPrompt('acme/engine', 7, 'ABC-101 Cache the token lookup'),
    steps: [[8, say('Reading the diff first, then the callers of lookup.')], [7, bash('git diff origin/main --stat')], [6, read(`${REPO}/engine/src/token.ts`)], [4, read(`${REPO}/engine/src/cache.ts`)], [2, tool('Grep', { pattern: 'fetchToken', path: 'src' })]],
  },
  {
    n: 2, name: 'fix-web-22', title: 'fix web!22', kind: 'fix', mr: 'acme/web!22', model: 'opus', effort: 'high', running: 'claude-opus-5-1', start: 14, stand: 'working',
    prompt: 'Fix the merge conflicts on acme/web!22 and push.',
    steps: [[13, bash('git fetch origin main')], [12, bash('git rebase origin/main')], [10, say('Two conflicts, both in the settings routes. Keeping the moved page and the new guard.')], [7, edit(`${REPO}/web/src/routes/settings.tsx`)], [5, edit(`${REPO}/web/src/routes/index.tsx`)], [2, edit(`${REPO}/web/src/nav.ts`)]],
  },
  {
    n: 3, name: 'abc-102', title: 'ABC-102', kind: 'ticket', ticket: 'ABC-102', model: 'opus', effort: 'medium', running: 'claude-opus-5-1', start: 22, stand: 'working',
    prompt: 'Start work on ABC-102 Retry the upload, in its own worktree, and raise a Draft MR.',
    steps: [[21, read(`${REPO}/engine/src/upload.ts`)], [17, edit(`${REPO}/engine/src/upload.ts`)], [12, edit(`${REPO}/engine/src/upload.test.ts`)], [4, bash('npm test -- upload')], [1, say('Three green, one still failing on the backoff timer. Looking at it now.')]],
  },
  {
    n: 4, name: 'kickoff-abc-118', title: 'kickoff ABC-118', kind: 'kickoff', ticket: 'ABC-118', model: 'opus', effort: 'high', running: 'claude-opus-5-1', start: 6, stand: 'working',
    prompt: 'Kick off ABC-118 Add an SSO session timeout: plan it, build it, test it, raise a Draft MR.',
    steps: [[5, tool('Skill', { skill: 'plan' })], [4, tool('TodoWrite', { todos: [{ content: 'Read the session code', status: 'completed' }, { content: 'Add the timeout setting', status: 'in_progress' }, { content: 'Test it', status: 'pending' }] })], [2, tool('EnterPlanMode', {})], [1, tool('TodoWrite', { todos: [] })]],
  },
  {
    n: 5, name: 'review-api-41', title: 'review api!41', kind: 'review', mr: 'acme/api!41', model: 'sonnet', effort: 'high', running: 'claude-sonnet-5-5', start: 18, stand: 'working',
    prompt: mrPrompt('acme/api', 41, 'ABC-112 Paginate the audit endpoint'),
    steps: [[17, bash('git diff origin/main')], [12, read(`${REPO}/api/src/audit/list.ts`)], [6, bash('npm test -- audit')], [2, bash('git push origin HEAD')]],
  },
  {
    n: 6, name: 'review-mobile-15', title: 'review mobile!15', kind: 'review', mr: 'acme/mobile!15', model: 'sonnet', effort: 'high', running: 'claude-sonnet-5-5', start: 16, stand: 'blocked', askedMinutesAgo: 12,
    prompt: mrPrompt('acme/mobile', 15, 'ABC-114 Offline queue for uploads'),
    steps: [[15, bash('git diff origin/main')], [13, read(`${REPO}/mobile/src/queue.ts`)], [12, say('The queue tests need an IndexedDB double. I would like to install one just for this run.')]],
    ask: { tool: 'Bash', input: { command: 'npm install --no-save fake-indexeddb', description: 'Install a test double so the queue tests can run' } },
  },
  {
    n: 7, name: 'abc-113', title: 'ABC-113', kind: 'ticket', ticket: 'ABC-113', model: 'opus', effort: 'medium', running: 'claude-opus-5-1', start: 40, stand: 'waiting', askedMinutesAgo: 27,
    prompt: 'Start work on ABC-113 Rate limit by tenant, in its own worktree, and raise a Draft MR.',
    steps: [[39, read(`${REPO}/api/src/limits.ts`)], [33, say('The limiter keys on the API token today. A tenant can own several tokens, so I need to know which you want counted.')]],
    ask: { tool: 'AskUserQuestion', input: { questions: [{ question: 'Which limit should win when a tenant has several tokens?', header: 'Limit', options: [{ label: 'Per tenant', description: 'All tokens share one budget' }, { label: 'Per token', description: 'Each token keeps its own budget' }] }] } },
  },
  {
    n: 8, name: 'fix-cli-3', title: 'fix cli!3', kind: 'fix', mr: 'acme/tools/cli!3', model: 'opus', effort: 'high', running: 'claude-opus-5-1', start: 70, stand: 'blocked', askedMinutesAgo: 58,
    prompt: 'Fix the failing pipeline on acme/tools/cli!3.',
    steps: [[69, bash('git fetch origin')], [64, read(`${REPO}/cli/src/flags.ts`)], [61, edit(`${REPO}/cli/src/flags.ts`)], [60, say('Fixed the flag parsing and the tests pass here. The branch has moved on from the failed run, so I need to force push over it.')]],
    ask: { tool: 'Bash', input: { command: 'git push --force-with-lease origin feat/ABC-105-dry-run', description: 'Push the fix over the failed run' } },
  },
  {
    n: 9, name: 'fix-engine-12', title: 'fix engine!12', kind: 'fix', mr: 'acme/engine!12', model: 'opus', effort: 'high', running: 'claude-opus-5-1', start: 50, stand: 'done', endedMinutesAgo: 22,
    prompt: 'Fix the review threads on acme/engine!12.',
    steps: [[49, read(`${REPO}/engine/src/upload.ts`)], [40, edit(`${REPO}/engine/src/upload.ts`)], [30, bash('npm test')], [22, say('Backoff added and the thread replied to. All 41 tests pass.')]],
  },
  {
    n: 10, name: 'review-web-30', title: 'review web!30', kind: 'review', mr: 'acme/web!30', model: 'sonnet', effort: 'high', running: 'claude-sonnet-5-5', start: 45, stand: 'done', endedMinutesAgo: 35,
    prompt: mrPrompt('acme/web', 30, 'Bump the linter'),
    steps: [[44, bash('git diff origin/main')], [38, say('One question for the author about generated files. Nothing else to raise.')]],
  },
  {
    n: 11, name: 'abc-110', title: 'ABC-110', kind: 'ticket', ticket: 'ABC-110', model: 'opus', effort: 'medium', running: 'claude-opus-5-1', start: 95, stand: 'done', endedMinutesAgo: 60,
    prompt: 'Start work on ABC-110 Export the audit log.',
    steps: [[94, read(`${REPO}/api/src/audit/export.ts`)], [75, edit(`${REPO}/api/src/audit/export.ts`)], [60, say('Raised acme/api!38 as a Draft.')]],
  },
  {
    n: 12, name: 'review-web-21', title: 'review web!21', kind: 'review', mr: 'acme/web!21', model: 'sonnet', effort: 'high', running: 'claude-sonnet-5-5', start: 130, stand: 'done', endedMinutesAgo: 110,
    prompt: mrPrompt('acme/web', 21, 'ABC-103 Show the empty state'),
    steps: [[128, bash('git diff origin/main')], [112, say('Looks good. Approving.')]],
  },
  {
    n: 13, name: 'kickoff-abc-117', title: 'kickoff ABC-117', kind: 'kickoff', ticket: 'ABC-117', model: 'opus', effort: 'high', running: 'claude-opus-5-1', start: 25, stand: 'builders',
    prompt: 'Kick off ABC-117 Colourise the help output.',
    steps: [[24, tool('TodoWrite', { todos: [{ content: 'Colour the usage line', status: 'in_progress' }] })], [20, tool('Agent', { subagent_type: 'general-purpose', description: 'Build the colour helper' })]],
    background: ['Build the colour helper', 'Write the snapshot tests', 'Update the man page'],
  },
  {
    n: 14, name: 'review-engine-9', title: 'review engine!9', kind: 'review', mr: 'acme/engine!9', model: 'sonnet', effort: 'high', running: 'claude-sonnet-5-5', start: 180, stand: 'done', endedMinutesAgo: 170,
    prompt: mrPrompt('acme/engine', 9, 'ABC-115 Speed up the cold start'),
    steps: [[178, bash('git diff origin/main')], [171, say('Nothing to raise.')]],
  },
  {
    n: 15, name: 'abc-121', title: 'ABC-121', kind: 'ticket', ticket: 'ABC-121', model: 'opus', effort: 'medium', running: 'claude-opus-5-1', start: 240, stand: 'done', endedMinutesAgo: 200,
    prompt: 'Start work on ABC-121 Fix the flaky upload test.',
    steps: [[238, read(`${REPO}/engine/src/upload.test.ts`)], [205, edit(`${REPO}/engine/src/upload.test.ts`)], [200, say('Fixed the race by awaiting the retry timer. Raised acme/engine!13.')]],
  },
];

function records(spec, now) {
  const at = (minutesAgo) => now - minutesAgo * MINUTE;
  const out = [];
  const add = (minutesAgo, record) => out.push({ at: at(minutesAgo), ...record });
  add(spec.start, { host: { kind: 'sent', id: `in-${spec.n}`, message: { type: 'user', message: { role: 'user', content: spec.prompt } } } });
  add(spec.start, { event: { type: 'system', subtype: 'init', model: spec.running, cwd: `${REPO}/${spec.name}` } });
  spec.steps.forEach(([minutesAgo, step], i) => {
    const content = step.say ? [{ type: 'text', text: step.say }] : [{ type: 'tool_use', id: `tu-${spec.n}-${i}`, name: step.tool, input: step.input }];
    add(minutesAgo, { event: { type: 'assistant', message: { role: 'assistant', content } } });
  });
  if (spec.ask) add(spec.askedMinutesAgo, { event: { type: 'control_request', request_id: `ask-${spec.n}`, request: { subtype: 'can_use_tool', tool_name: spec.ask.tool, input: spec.ask.input } } });
  if (spec.stand === 'done' || spec.stand === 'builders') add(spec.endedMinutesAgo ?? 1, { event: { type: 'result', subtype: 'success', is_error: false, queued_turn_count: 0, usage: { input_tokens: 4200, output_tokens: 900 } } });
  if (spec.background) add(1, { event: { type: 'system', subtype: 'background_tasks_changed', tasks: spec.background.map((description) => ({ description })) } });
  return out.sort((a, b) => a.at - b.at);
}

const alive = (spec) => spec.stand !== 'done';

export function demoAgents(now = Date.now()) {
  return SPECS.map((spec) => ({
    id: uuid(spec.n),
    alive: alive(spec),
    file: {
      id: uuid(spec.n), name: spec.name, title: spec.title, cwd: `${REPO}/${spec.name}`, createdAt: new Date(now - spec.start * MINUTE).toISOString(), kind: spec.kind,
      ...(spec.mr ? { mr: spec.mr } : {}), ...(spec.ticket ? { ticket: spec.ticket } : {}), permissions: 'ask', model: spec.model, effort: spec.effort,
      ...(spec.kind === 'kickoff' ? { subagentModel: 'sonnet' } : {}),
    },
    records: records(spec, now),
  }));
}

export const AGENT_HANDLE = (n) => `claude:${uuid(n)}`;
