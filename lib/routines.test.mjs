import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { cronText, fetchArgs, LIST_ONLY_HOOK, routinesFrom, systemPrompt } from './routines.mjs';

const RAW = {
  id: 'trig_01', name: 'Nightly report', cron_expression: '0 8-19 * * 1-5', enabled: true, next_run_at: '2026-11-16T10:03:14.906492Z', last_fired_at: '2026-11-16T09:04:22Z',
  last_run: { fired_at: '2026-11-16T09:04:22Z', finished_at: '2026-11-16T09:04:38Z', status: 'ROUTINE_RUN_STATUS_SUCCEEDED' },
  derived_state: { prompt: 'You keep one report current. Change nothing else.' },
};

const events = (calls, init = { tools: ['RemoteTrigger'] }) => [
  { type: 'system', subtype: 'init', ...init },
  ...calls.flatMap((c, i) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u' + i, name: 'RemoteTrigger', input: c.input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u' + i, is_error: Boolean(c.error), content: c.body ?? '' }] } },
  ]),
  { type: 'result', subtype: 'success', is_error: false },
];
const listing = (data) => ({ input: { action: 'list' }, body: 'HTTP 200\n' + JSON.stringify({ data }) });

test('the routines come from what the tool returned, soonest first, paused last', () => {
  const later = { ...RAW, id: 'trig_02', name: 'Weekly digest', next_run_at: '2026-11-20T09:00:00Z' };
  const paused = { ...RAW, id: 'trig_03', name: 'Old job', enabled: false, next_run_at: null };
  const found = routinesFrom(events([listing([paused, later, RAW])]));
  assert.deepEqual(found.map((r) => r.name), ['Nightly report', 'Weekly digest', 'Old job']);
  assert.deepEqual(found[0], {
    id: 'trig_01', name: 'Nightly report', about: 'You keep one report current.', cron: '0 8-19 * * 1-5', schedule: 'Hourly, 8am to 7pm, weekdays', enabled: true,
    nextRunAt: '2026-11-16T10:03:14.906Z', lastRunAt: '2026-11-16T09:04:22.000Z', lastFinishedAt: '2026-11-16T09:04:38.000Z', lastStatus: 'succeeded',
  });
  assert.equal(found[2].enabled, false);
});

test('a routine with no cron says it runs when triggered, and a failed run is named', () => {
  const [one] = routinesFrom(events([listing([{ ...RAW, cron_expression: undefined, last_run: { ...RAW.last_run, status: 'ROUTINE_RUN_STATUS_FAILED' } }])]));
  assert.equal(one.schedule, 'no schedule, runs when triggered');
  assert.equal(one.lastStatus, 'failed');
});

test('a call that is not a plain list fails the read, whatever Claude says afterwards', () => {
  assert.throws(() => routinesFrom(events([{ input: { action: 'run', trigger_id: 'trig_01' }, body: 'HTTP 200\n{}' }])), /something other than a list/);
  assert.throws(() => routinesFrom(events([listing([RAW]), listing([RAW])])), /2 RemoteTrigger calls instead of one/);
  assert.throws(() => routinesFrom(events([])), /0 RemoteTrigger calls/);
});

test('a refused or oddly shaped answer is an error, not an empty list', () => {
  assert.throws(() => routinesFrom(events([{ input: { action: 'list' }, error: true, body: 'denied' }])), /refused the routines list/);
  assert.throws(() => routinesFrom(events([{ input: { action: 'list' }, body: 'HTTP 200\n{"nope":1}' }])), /shape this does not know/);
  assert.throws(() => routinesFrom(events([listing([])], { tools: ['Read'] })), /no routines tool/);
});

test('words in a routine are kept as short plain text, never markup the page would run', () => {
  const [one] = routinesFrom(events([listing([{ ...RAW, name: 'x'.repeat(300) + '<img src=x>', derived_state: { prompt: '<script>alert(1)</script> ' + 'y'.repeat(400) } }])]));
  assert.ok(one.name.length <= 120);
  assert.ok(one.about.length <= 160);
});

test('the usual cron shapes read as a sentence and anything stranger stays as the cron', () => {
  assert.equal(cronText('0 8-19 * * 1-5'), 'Hourly, 8am to 7pm, weekdays');
  assert.equal(cronText('7 13 * * 4,5'), '1:07pm, Thu, Fri');
  assert.equal(cronText('30 9 * * *'), '9:30am, every day');
  assert.equal(cronText('3 * * * 1-5'), 'Hourly at :03, weekdays');
  assert.equal(cronText('*/5 * * * *'), '*/5 * * * *');
  assert.equal(cronText('0 9 1 * *'), '0 9 1 * *');
});

test('Claude is given only the routines tool, and told to list and nothing else', () => {
  const args = fetchArgs();
  assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', 'RemoteTrigger']);
  assert.deepEqual(args.slice(args.indexOf('--allowedTools'), args.indexOf('--allowedTools') + 2), ['--allowedTools', 'RemoteTrigger']);
  assert.match(systemPrompt(), /exactly \{"action": "list"\}/);
});

// The hook is shell, so it runs here as it does for Claude, with the fields Claude Code puts before tool_input.
const verdict = (toolInput) => {
  const payload = JSON.stringify({ session_id: 's1', cwd: '/tmp', hook_event_name: 'PreToolUse', tool_name: 'RemoteTrigger', tool_input: toolInput, tool_use_id: 'u1' });
  const out = execFileSync('/bin/sh', ['-c', LIST_ONLY_HOOK.hooks.PreToolUse[0].hooks[0].command], { input: payload, encoding: 'utf8' });
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : 'allow';
};

test('the hook lets a plain list through and refuses every other call, including one hiding a list in its body', () => {
  assert.equal(verdict({ action: 'list' }), 'allow');
  for (const input of [
    { action: 'run', trigger_id: 'trig_01' },
    { action: 'get', trigger_id: 'trig_01' },
    { action: 'update', trigger_id: 'trig_01', body: { enabled: false } },
    { action: 'create', body: { tool_input: { action: 'list' } } },
    { action: 'get_run_log', session_id: 'cse_1' },
    {},
  ]) assert.equal(verdict(input), 'deny', JSON.stringify(input));
});
