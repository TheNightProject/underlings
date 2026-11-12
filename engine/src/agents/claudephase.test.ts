import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { agentState, parseLines, readLog, type LogRecord } from './claudelog.js';
import { agentPhase, mrKeys, PHASE_HOLD_MS, toolWork, type Phase } from './claudephase.js';

const recorded = (name: string): Record<string, unknown>[] =>
  parseLines<Record<string, unknown>>(readFileSync(new URL(`../fixtures/claude/${name}.jsonl`, import.meta.url), 'utf8'));

const GAP = PHASE_HOLD_MS + 1000;
let ids = 0;

function call(name: string, input: Record<string, unknown> = {}, id = `toolu_${++ids}`): Record<string, unknown> {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null };
}

const bash = (command: string, id?: string): Record<string, unknown> => call('Bash', { command, description: 'run it' }, id);
const said = (text: string): Record<string, unknown> => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
const output = (id: string, content: unknown, parent: string | null = null): Record<string, unknown> =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, parent_tool_use_id: parent });
const result = { type: 'result', subtype: 'success', is_error: false, result: 'Done.' };
const tasks = (list: string[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: list.map((description, n) => ({ task_id: `t${n}`, task_type: 'local_agent', description })) });
const prompt: LogRecord = { at: 0, host: { kind: 'sent', id: 'in-0', message: { type: 'user', message: { role: 'user', content: 'Kick off ABC-2753' } } } };

const spaced = (events: Record<string, unknown>[], gap = GAP, from = 1): LogRecord[] => events.map((event, n) => ({ at: from + n * gap, event }));

function phaseOf(records: LogRecord[], { alive = true, now = (records.at(-1)?.at ?? 0) + 1 } = {}): Phase | null {
  const log = readLog(records);
  return agentPhase(log, agentState(log, [], alive, now).state, alive, now);
}

const read = (path: string) => call('Read', { file_path: path });
const edit = (path: string) => call('Edit', { file_path: path, old_string: 'a', new_string: 'b' });
const EDITS = [edit('/work/engine/src/agents/claudelog.ts'), call('Write', { file_path: '/work/engine/src/agents/claudephase.ts', content: '' }), call('MultiEdit', { file_path: '/work/ui/31-office.js', edits: [] }), edit('/work/ui/31-agents.js')];

test('each phase is read from the calls the agent makes, as Claude Code streams them', () => {
  const phases = {
    exploring: [read('/work/engine/src/agents/claudelog.ts'), call('Grep', { pattern: 'officeTagText' }), bash('cd /work/control-centre && git log --oneline -5'), call('Glob', { pattern: 'ui/*.js' })],
    planning: [read('/work/README.md'), call('Grep', { pattern: 'phase' }), call('TodoWrite', { todos: [{ content: 'Phase function', status: 'pending' }] })],
    'planning a file': [read('/work/README.md'), call('Write', { file_path: '/work/control-centre-plans/agent-phase-plan.md', content: '# Plan' })],
    building: [read('/work/ui/31-office.js'), ...EDITS],
    testing: [...EDITS, bash('cd /work && npm --prefix engine test 2>&1 | tail -20'), bash('style-gate --profile comments --diff origin/main')],
    mr: [...EDITS, bash('npm test'), bash('git add -A && git commit -m "✨ Say what each agent is doing" && git push --no-verify -u origin feat/agent-phase')],
  };
  const seen = Object.fromEntries(Object.entries(phases).map(([name, events]) => [name, phaseOf([prompt, ...spaced(events)])]));
  assert.deepEqual(seen, { exploring: 'exploring', planning: 'planning', 'planning a file': 'planning', building: 'building', testing: 'testing', mr: 'mr' });
  assert.equal(phaseOf([prompt]), null, 'nothing to go on yet');
});

test('the command a call runs says what it is doing, and one that says nothing is left out', () => {
  const cases: [string, Record<string, unknown>, string | null][] = [
    ['Bash', { command: 'git -C /work/control-centre diff origin/main --stat' }, 'exploring'],
    ['Bash', { command: 'sed -n 1,80p ui/31-office.js' }, 'exploring'],
    ['Bash', { command: "sed -i '' 's/Kickoff/Kick off/' ui/31-office.js" }, 'building'],
    ['Bash', { command: "cat > notes.txt <<'EOF'\ngit push\nEOF" }, 'building'],
    ['Bash', { command: 'TZ=Europe/London LC_ALL=en_US.UTF-8 npx tsc --noEmit' }, 'testing'],
    ['Bash', { command: 'cd gateway && .venv/bin/python -m pytest tests/ -q' }, 'testing'],
    ['Bash', { command: 'uvx pre-commit run --from-ref origin/main' }, 'testing'],
    ['Bash', { command: 'go test ./...' }, 'testing'],
    ['Bash', { command: 'cargo test --workspace' }, 'testing'],
    ['Bash', { command: 'make -C engine lint' }, 'testing'],
    ['Bash', { command: 'npm run test:cc' }, 'testing'],
    ['Bash', { command: 'npm run build' }, null],
    ['Bash', { command: 'npm i -D vitest' }, null],
    ['Bash', { command: 'git -C /work/control-centre push --no-verify origin feat/agent-phase' }, 'mr'],
    ['Bash', { command: 'git commit -m "Say when to git push"' }, null],
    ['Bash', { command: 'curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/12345678/merge_requests?state=opened"' }, 'exploring'],
    ['Bash', { command: 'curl -s --request POST --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/projects/12345678/merge_requests" --data-urlencode "title=Draft: phases"' }, 'mr'],
    ['Bash', { command: 'curl -s -X PUT "https://gitlab.com/api/v4/projects/12345678/merge_requests/58" -d "squash=false"' }, 'mr'],
    ['Bash', { command: 'curl -s -X POST "https://gitlab.com/api/v4/projects/12345678/merge_requests/58/notes" -d "body=Fixed"' }, null],
    ['Bash', { command: 'gh pr create --draft --fill' }, 'mr'],
    ['Bash', { command: 'glab mr create --draft --title phases' }, 'mr'],
    ['Bash', { command: 'gh api repos/acme/engine/pulls -f title=phases -f head=feat/agent-phase' }, 'mr'],
    ['Bash', { command: 'gh pr view 12 --comments' }, 'exploring'],
    ['Edit', { file_path: '/work/control-centre-plans/p14.md' }, 'planning'],
    ['Write', { file_path: '/work/docs/explanation.md' }, 'building'],
    ['NotebookEdit', { notebook_path: '/work/analysis.ipynb' }, 'building'],
    ['ExitPlanMode', { plan: 'Do it' }, 'planning'],
    ['Agent', { subagent_type: 'Explore', description: 'Find the tag code' }, 'exploring'],
    ['Agent', { subagent_type: 'general-purpose', description: 'Build the phase function', run_in_background: true }, 'building'],
    ['Agent', { subagent_type: 'general-purpose', description: 'Skeptic review of the diff' }, 'testing'],
    ['Skill', { skill: 'ws:pre-mr-review' }, 'testing'],
    ['mcp__gitlab__create_merge_request', {}, 'mr'],
    ['mcp__claude_ai_Atlassian_Rovo__getJiraIssue', { issueIdOrKey: 'ABC-2753' }, 'exploring'],
    ['mcp__underlings__queue_findings', {}, null],
    ['AskUserQuestion', { questions: [] }, null],
  ];
  assert.deepEqual(cases.map(([name, input]) => toolWork(name, input)), cases.map(([, , work]) => work));
});

test('one stray call does not flip the phase, and a run of them does', () => {
  const building = [...EDITS, edit('/work/ui/31-agent-window.js')];
  assert.equal(phaseOf([prompt, ...spaced([...building, read('/work/ui/00-core.js')])]), 'building', 'a stray Read');
  assert.equal(phaseOf([prompt, ...spaced([...building, bash('git diff --stat')])]), 'building', 'a stray look at the diff');
  assert.equal(phaseOf([prompt, ...spaced([...building, call('TodoWrite', { todos: [] })])]), 'building', 'ticking off a todo');
  assert.equal(phaseOf([prompt, ...spaced([...building, read('/work/a.ts'), call('Grep', { pattern: 'x' }), read('/work/b.ts')])]), 'exploring', 'three reads in a row');
});

test('a new phase is held back until the last has shown for the minimum time, then takes over without another call', () => {
  const quick = [prompt, ...spaced([read('/work/README.md'), ...EDITS], 1000)];
  assert.equal(phaseOf(quick, { now: 4002 }), 'exploring');
  assert.equal(phaseOf(quick, { now: 1 + PHASE_HOLD_MS }), 'building');
  const tested = [prompt, ...spaced([read('/work/README.md')]), ...spaced([edit('/work/a.ts'), bash('npm test')], 1000, 1 + GAP)];
  assert.equal(phaseOf(tested, { now: 1 + GAP + 1500 }), 'building', 'tests run moments into building wait');
  assert.equal(phaseOf(tested, { now: 1 + GAP + PHASE_HOLD_MS }), 'testing', 'and show once building has had its time');
  const stray = [...tested, { at: 1 + GAP + 2000, event: edit('/work/b.ts') }];
  assert.equal(phaseOf(stray, { now: 1 + 10 * GAP }), 'building', 'a test run between two quick edits never shows');
});

test('a question or a permission ask is waiting on you, whatever the agent was doing', () => {
  const question = recorded('question');
  const permission = recorded('permission');
  const asked = (events: Record<string, unknown>[]) => events.slice(0, events.findIndex((e) => e['type'] === 'control_request') + 1);
  assert.equal(phaseOf([prompt, ...spaced([...EDITS, bash('npm test'), ...asked(question)])]), 'waiting');
  assert.equal(phaseOf([prompt, ...spaced([...EDITS, bash('git push'), ...asked(permission)])]), 'waiting');
});

test('builders running in the background while its own turn is idle are what it is doing, until they or it stop', () => {
  const kickoff = [prompt, ...spaced([read('/work/a.ts'), call('Agent', { description: 'Build ABC-2753 in engine', run_in_background: true }), tasks(['Build ABC-2753 in engine', 'Build ABC-2753 in ui'])])];
  assert.equal(phaseOf(kickoff), 'building', 'its turn is still open');
  assert.equal(phaseOf([...kickoff, { at: 1 + 3 * GAP, event: result }]), 'builders');
  assert.equal(phaseOf([...kickoff, { at: 1 + 3 * GAP, event: result }], { alive: false }), 'done', 'its process has gone, and its builders with it');
  assert.equal(phaseOf([...kickoff, { at: 1 + 3 * GAP, event: result }, { at: 2 + 3 * GAP, event: tasks([]) }]), 'done');
  assert.equal(agentPhase(readLog([...kickoff, { at: 1 + 3 * GAP, event: result }]), 'working', false), 'building', 'a follow-up starting a new process inherits no builders from the old one');
});

test('a finished agent is done, or stopped when it was stopped', () => {
  assert.equal(phaseOf([prompt, ...spaced([...EDITS, result])]), 'done');
  assert.equal(phaseOf([prompt, ...spaced(EDITS), { at: 1 + 4 * GAP, host: { kind: 'stopped' } }], { alive: false }), 'stopped');
});

test('the MR it raised is read from what its own push or MR call returned, or what it said after one', () => {
  const pushed = 'remote:\nremote: View merge request for feat/agent-phase:\nremote:   https://gitlab.com/acme/tooling/control-centre/-/merge_requests/58\nremote:\nTo gitlab.com:acme/tooling/control-centre.git';
  const raised = (events: Record<string, unknown>[]) => readLog([prompt, ...spaced(events)]).raisedMr;
  assert.equal(raised([bash('git push -u origin feat/agent-phase', 'p1'), output('p1', pushed)]), 'acme/tooling/control-centre!58');
  const created = JSON.stringify({ iid: 59, web_url: 'https://gitlab.com/acme/platform/relay/-/merge_requests/59', author: { web_url: 'https://gitlab.com/frank' } });
  assert.equal(raised([bash('curl -s -X POST "https://gitlab.com/api/v4/projects/1/merge_requests" -d "title=x"', 'c1'), output('c1', [{ type: 'text', text: created }])]), 'acme/platform/relay!59');
  assert.equal(raised([bash('gh pr create --fill', 'g1'), output('g1', 'https://github.com/acme/engine/pull/12\n')]), 'acme/engine#12');
  const offered = 'remote: To create a merge request for feat/agent-phase, visit:\nremote:   https://gitlab.com/acme/tooling/control-centre/-/merge_requests/new?merge_request%5Bsource_branch%5D=feat%2Fagent-phase';
  assert.equal(raised([bash('git push -u origin feat/agent-phase', 'p2'), output('p2', offered)]), null, 'a link to make one is not one');
  assert.equal(raised([bash('git push -u origin feat/agent-phase', 'p3'), output('p3', offered), said('Raised the Draft MR: https://gitlab.com/acme/tooling/control-centre/-/merge_requests/60')]), 'acme/tooling/control-centre!60');
});

test('an MR it only read about or mentioned before raising one is not the MR it raised', () => {
  const reviewed = 'https://gitlab.com/acme/platform/relay/-/merge_requests/57';
  const raised = (events: Record<string, unknown>[]) => readLog([prompt, ...spaced(events)]).raisedMr;
  assert.equal(raised([bash('curl -s "https://gitlab.com/api/v4/projects/1/merge_requests/57"', 'r1'), output('r1', JSON.stringify({ web_url: reviewed }))]), null);
  assert.equal(raised([said(`This builds on ${reviewed}.`), bash('git push', 'p1'), output('p1', 'Everything up-to-date')]), null);
  assert.equal(raised([bash('git push', 'p2'), output('p2', reviewed, 'toolu_builder')]), null, 'a builder\'s own call is its own');
});

test('MR links are keyed as the rest of the app keys them, in the order they appear', () => {
  assert.deepEqual(mrKeys('see https://gitlab.example.com:8443/a/b/c/-/merge_requests/3 and https://github.com/o/r/pull/9, then https://gitlab.com/x/y/-/merge_requests/4/diffs'), ['a/b/c!3', 'o/r#9', 'x/y!4']);
});
