import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { agentState, parseLines, readLog, transcript, type HostRecord, type LogRecord } from './claudelog.js';

// Recorded from claude 2.1.312 run headless with stream-json both ways: one turn asks a question, the next asks to run a command.
const recorded = (name: string): Record<string, unknown>[] =>
  parseLines<Record<string, unknown>>(readFileSync(new URL(`../fixtures/claude/${name}.jsonl`, import.meta.url), 'utf8'));

const question = recorded('question');
const permission = recorded('permission');
const typeAt = (events: Record<string, unknown>[], type: string): number => events.findIndex((e) => e['type'] === type);
const events = (list: Record<string, unknown>[], from = 0): LogRecord[] => list.map((event, n) => ({ at: from + n, event }));
const host = (at: number, record: HostRecord): LogRecord => ({ at, host: record });
const prompt = (at: number, text: string, id = `in-${at}`): LogRecord =>
  host(at, { kind: 'sent', id, message: { type: 'user', message: { role: 'user', content: text } } });

function answered(at: number, requestId: string): LogRecord {
  const response = { behavior: 'allow', updatedInput: { answers: { q: 'ready' } } };
  return host(at, { kind: 'sent', id: `answer-${at}`, answers: requestId, message: { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } } });
}

const asked = typeAt(question, 'control_request');
const requestId = String(question[asked]?.['request_id']);

test('a question the agent asks waits on you, with its options, until the answer is sent', () => {
  const log = readLog([prompt(0, 'Ask me'), ...events(question.slice(0, asked + 1), 1)]);
  assert.deepEqual(agentState(log, [], true), { state: 'waiting', since: asked + 1 });
  assert.deepEqual(log.pending[0]?.questions?.[0]?.options.map((o) => o.label), ['ready', 'steady']);
  const after = readLog([prompt(0, 'Ask me'), ...events(question.slice(0, asked + 1), 1), answered(50, requestId)]);
  assert.deepEqual(after.pending, []);
  assert.equal(agentState(after, [], true).state, 'working');
});

test('a turn is done once its result comes, and the last thing it said is kept', () => {
  const log = readLog([prompt(0, 'Ask me'), ...events(question.slice(0, asked + 1), 1), answered(50, requestId), ...events(question.slice(asked + 1), 60)]);
  assert.equal(agentState(log, [], false).state, 'done');
  assert.equal(log.said, 'ready');
});

test('a turn that ends with a builder still running in the background is working until the builder is done', () => {
  const tasks = (list: string[]) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: list.map((description, n) => ({ task_id: `t${n}`, task_type: 'local_agent', description })) });
  const result = { type: 'result', subtype: 'success', is_error: false, result: 'The builder is running.' };
  const running = readLog([prompt(0, 'Kick off ABC-1'), ...events([tasks(['Build ABC-1 in gateway']), result], 1)]);
  assert.deepEqual(agentState(running, [], true), { state: 'working', since: 1 });
  assert.deepEqual(running.background, ['Build ABC-1 in gateway']);
  assert.equal(agentState(running, [], false).state, 'done', 'once its process has gone, so has its builder');
  const finished = readLog([prompt(0, 'Kick off ABC-1'), ...events([tasks(['Build ABC-1 in gateway']), result, tasks([])], 1)]);
  assert.equal(agentState(finished, [], true).state, 'done');
});

test('a tool that needs permission reads as blocked, and a request Claude Code withdraws stops waiting on you', () => {
  const at = typeAt(permission, 'control_request');
  const id = String(permission[at]?.['request_id']);
  const log = readLog([prompt(0, 'Run it'), ...events(permission.slice(0, at + 1), 1)]);
  assert.equal(agentState(log, [], true).state, 'blocked');
  assert.deepEqual([log.pending[0]?.tool, log.pending[0]?.input['command']], ['Bash', 'touch smoke.txt']);
  const withdrawn = readLog([prompt(0, 'Run it'), ...events(permission.slice(0, at + 1), 1), { at: 40, event: { type: 'control_cancel_request', request_id: id } }]);
  assert.equal(agentState(withdrawn, [], true).state, 'working');
});

test('the conversation is what was said and done: your words, its text, one line per tool, and what it asked', () => {
  const at = typeAt(permission, 'control_request');
  const log = readLog([prompt(0, 'Run it'), ...events(permission.slice(0, at + 1), 1)]);
  assert.deepEqual(log.entries.map((e) => e.kind), ['you', 'tool', 'asked']);
  assert.deepEqual(transcript(log.entries), ['> Run it', '· Bash: touch smoke.txt', '? Allow Bash: touch smoke.txt']);
  const questionLog = readLog(events(question));
  assert.deepEqual(transcript(questionLog.entries), ['? Should I reply with the word "ready" or the word "steady"?', 'ready'], 'the question is asked once, not also as a tool call');
});

test('a subagent\'s own tool calls are left out of the conversation', () => {
  const log = readLog([{ at: 1, event: { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }] } } }]);
  assert.deepEqual(log.entries, []);
});

test('a turn that ends in error, and a claude that exits badly, are said in the conversation', () => {
  const log = readLog([
    { at: 1, event: { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'API Error: 529 overloaded' } },
    host(2, { kind: 'exit', code: 1, stderr: 'Invalid API key' }),
  ]);
  assert.deepEqual(transcript(log.entries), ['! The turn ended in an error: API Error: 529 overloaded', '! Claude Code exited with code 1: Invalid API key']);
});

test('a result with sends still queued keeps the turn open', () => {
  const log = readLog([prompt(0, 'one'), prompt(1, 'two'), { at: 2, event: { type: 'result', subtype: 'success', queued_turn_count: 1 } }]);
  assert.equal(agentState(log, [], true).state, 'working');
});

test('input not yet sent reads as a turn about to run while a runner could still pick it up, and not for ever', () => {
  const log = readLog([]);
  const queued = [{ id: 'p', at: 1000, message: {} }];
  assert.equal(agentState(log, queued, false, 2000).state, 'working', 'just started');
  assert.equal(agentState(log, queued, true, 999_999).state, 'working', 'a runner is about to send it');
  assert.equal(agentState(log, queued, false, 999_999).state, 'done', 'nothing will');
});

test('a stop clears what the agent was waiting on', () => {
  const log = readLog([prompt(0, 'Ask me'), ...events(question.slice(0, asked + 1), 1), host(40, { kind: 'stopped' })]);
  assert.equal(agentState(log, [], false).state, 'done');
  assert.equal(transcript(log.entries).at(-1), '! Stopped.');
});

test('a line torn by a write in progress is skipped rather than failing the read', () => {
  assert.deepEqual(parseLines('{"a":1}\n{"b":'), [{ a: 1 }]);
});

test('how the last turn ended is read from its result, a failed exit or a stop, and a new message clears it', () => {
  const result = (at: number, isError: boolean): LogRecord => ({ at, event: { type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: 'r' } });
  assert.equal(readLog([prompt(0, 'go')]).outcome, null, 'a turn still running has none');
  assert.equal(readLog([prompt(0, 'go'), result(1, false)]).outcome, 'success');
  assert.equal(readLog([prompt(0, 'go'), result(1, true)]).outcome, 'error');
  assert.equal(readLog([prompt(0, 'go'), host(1, { kind: 'exit', code: 1, stderr: 'boom' })]).outcome, 'error');
  assert.equal(readLog([prompt(0, 'go'), host(1, { kind: 'stopped' }), host(2, { kind: 'exit', code: 143 })]).outcome, 'stopped', 'a stop stays a stop, whatever its process exits with');
  assert.equal(readLog([prompt(0, 'go'), result(1, true), prompt(2, 'again')]).outcome, null);
});

test('each finished turn keeps when it ended, whether it worked and the tokens it spent since the last, and nothing it said', () => {
  const log = readLog([prompt(0, 'Ask me'), ...events(question, 1), prompt(100, 'And again'), ...events(permission, 101)]);
  assert.deepEqual(log.turns, [
    { at: 1 + typeAt(question, 'result'), ok: true, tokens: 4 + 18745 + 244 },
    { at: 101 + typeAt(permission, 'result'), ok: true, tokens: 4 + 2396 + 281 },
  ]);
  const older = readLog(events([{ type: 'result', is_error: true, usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 9000, output_tokens: 5 } }], 7));
  assert.deepEqual(older.turns, [{ at: 7, ok: false, tokens: 18 }], 'cache reads are not counted');
});
