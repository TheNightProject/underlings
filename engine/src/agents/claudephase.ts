import { keysInText } from '../refs.js';
import type { AgentLog, ClaudeState } from './claudelog.js';

export type Work = 'exploring' | 'planning' | 'building' | 'testing' | 'mr';
export type Phase = Work | 'builders' | 'waiting' | 'done' | 'stopped';

export interface WorkCall {
  at: number;
  work: Work;
}

const RANK: Record<Work, number> = { exploring: 1, planning: 2, building: 3, testing: 4, mr: 5 };
const WEIGHT: Record<Work, number> = { exploring: 0.8, building: 2, planning: 2.5, testing: 3, mr: 6 };
const WINDOW = 6;
const DECAY = 0.6;
export const PHASE_HOLD_MS = 15_000;

const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch']);
const PLANS = new Set(['TodoWrite', 'ExitPlanMode', 'EnterPlanMode', 'TaskCreate', 'TaskUpdate']);
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SUBAGENTS = new Set(['Agent', 'Task']);
const PLAN_FILE = /(?:^|[\\/._-])plan(?:s|ning)?(?:[\\/._-]|$)/i;

const HTTP_CLIENT = /^(?:curl|wget|https?|xh|gh\s+api|glab\s+api)\b/;
const MR_ENDPOINT = /merge_requests(?:\/\d+)?(?=$|[\s"'?])|\/pulls(?:\/\d+)?(?=$|[\s"'?])/;
const WRITES = [
  /\s(?:-X\s*|--request[\s=]|--method[\s=])['"]?(?:POST|PUT|PATCH)\b/,
  /\s(?:-d|-F|--data(?:-\w+)?|--form|--post-data|--post-file)[\s=]/,
  /^(?:https?|xh)\s+(?:POST|PUT|PATCH|post|put|patch)\b/,
  /^(?:gh|glab)\s+api\b.*\s(?:-f|--field|--raw-field)[\s=]/,
];
const HEREDOC = /(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g;
const GIT = String.raw`^git(?:\s+(?:-[Cc]\s+\S+|--[\w-]+(?:=\S+)?))*\s+`;

const SEGMENT_RULES: [Work, RegExp][] = [
  ['mr', new RegExp(`${GIT}push\\b`)],
  ['mr', /^gh\s+pr\s+(?:create|edit|ready|reopen)\b/],
  ['mr', /^glab\s+mr\s+(?:create|update|reopen)\b/],
  ['testing', /^(?:npm|pnpm|yarn|bun)\s(?:.*\s)?(?:test|tests|lint|typecheck|type-check|check|e2e|verify)[\w:-]*(?:\s|$)/],
  ['testing', /^(?:make|gmake|just|task)\s(?:.*\s)?(?:test|tests|check|lint|typecheck|verify)[\w:-]*(?:\s|$)/],
  ['testing', /^(?:pytest|py\.test|tox|nox|mypy|pyright|flake8|pylint|ruff|eslint|tsc|vitest|jest|mocha|ava|pre-commit|prose-gate|shellcheck|hadolint|golangci-lint|rspec|phpunit|stylelint|biome)\b/],
  ['testing', /^(?:playwright\s+test|cypress\s+run|go\s+(?:test|vet)|cargo\s+(?:test|clippy|check|nextest)|deno\s+(?:test|lint|check))\b/],
  ['testing', /^(?:prettier|black)\b.*\s--check\b/],
  ['testing', /^(?:node|tsx|bun)\s(?:.*\s)?--test\b/],
  ['testing', /^(?:gradle|gradlew|mvn|mvnw|dotnet|swift|mix|sbt)\s(?:.*\s)?test\b/],
  ['building', /^(?:sed|perl)\s(?:.*\s)?-(?:[a-zA-Z]*i\b|-in-place)/],
  ['building', /^(?:patch\b|git\s+apply\b)/],
  ['building', /^(?:cat|echo|printf)\b.*\s>>?\s*(?!&|\/dev\/)\S/],
  ['exploring', new RegExp(`${GIT}(?:log|diff|show|status|blame|branch|grep|ls-files|ls-tree|rev-parse|rev-list|describe|shortlog|reflog|remote|fetch|cat-file|merge-base)\\b`)],
  ['exploring', /^(?:cat|head|tail|less|ls|tree|find|fd|grep|egrep|rg|ag|wc|file|stat|du|which|sed|awk|jq|yq|diff|realpath|readlink)\b/],
  ['exploring', /^(?:gh|glab)\s+(?:pr|mr|issue|repo|run|ci)\s+(?:view|list|diff|checks|status)\b/],
  ['exploring', /^(?:npm|pnpm|yarn)\s+(?:ls|list|view|info|outdated|why)\b/],
];

const WRAPPERS = [
  /^[({]\s*/,
  /^\w+=(?:"[^"]*"|'[^']*'|\S*)\s+/,
  /^(?:sudo|time|nohup|exec|command|env)\s+/,
  /^timeout\s+\S+\s+/,
  /^(?:\S*\/)?(?:npx|pnpx|bunx|uvx)\s+(?:--?[\w-]+(?:=\S+)?\s+)*/,
  /^(?:uv|poetry|pipenv|pdm|hatch|rye)\s+run\s+/,
  /^(?:\S*\/)?python[\d.]*\s+-m\s+/,
  /^bundle\s+exec\s+/,
  /^(?:\.{0,2}\/|~\/)?(?:[\w.-]+\/)+(?=[\w.-]+(?:\s|$))/,
];

function bare(segment: string): string {
  let text = segment.trim();
  for (let was = ''; was !== text; ) {
    was = text;
    for (const wrapper of WRAPPERS) text = text.replace(wrapper, '');
  }
  return text;
}

const higher = (a: Work | null, b: Work | null): Work | null => (!a || (b && RANK[b] > RANK[a]) ? b : a);

function segmentWork(segment: string): Work | null {
  const text = bare(segment);
  if (!HTTP_CLIENT.test(text)) return SEGMENT_RULES.find(([, rule]) => rule.test(text))?.[0] ?? null;
  if (!WRITES.some((write) => write.test(text))) return 'exploring';
  return MR_ENDPOINT.test(text) ? 'mr' : null;
}

function commandWork(command: string): Work | null {
  return command.replace(HEREDOC, '$1').split(/&&|\|\||[;|\n]/).map(segmentWork).reduce(higher, null);
}

function subagentWork(input: Record<string, unknown>): Work | null {
  const type = String(input['subagent_type'] ?? '');
  const said = `${type} ${String(input['description'] ?? '')}`;
  if (/\bexplore|research|investigat|survey/i.test(said)) return 'exploring';
  if (/\bplan/i.test(said)) return 'planning';
  if (/\breview|skeptic|verif|test|audit|check/i.test(said)) return 'testing';
  return 'building';
}

function mcpWork(tool: string): Work | null {
  if (/merge_?request|pull_?request|_mr$|_pr$/i.test(tool) && /create|update|edit|open|raise/i.test(tool)) return 'mr';
  return /^(?:get|list|search|read|fetch|query|find|view|lookup|describe)/i.test(tool) ? 'exploring' : null;
}

export function toolWork(name: string, input: Record<string, unknown> = {}): Work | null {
  const path = String(input['file_path'] ?? input['notebook_path'] ?? '');
  if (EDITS.has(name)) return PLAN_FILE.test(path) ? 'planning' : 'building';
  if (READS.has(name)) return 'exploring';
  if (PLANS.has(name)) return 'planning';
  if (name === 'Bash' && typeof input['command'] === 'string') return commandWork(input['command']);
  if (SUBAGENTS.has(name)) return subagentWork(input);
  if (name === 'Skill') return /pre-mr-review|test|lint|verify|check/i.test(String(input['skill'] ?? '')) ? 'testing' : null;
  if (name.startsWith('mcp__')) return mcpWork(name.slice(name.lastIndexOf('__') + 2));
  return null;
}

export const mrKeys = keysInText;

// A tie keeps the phase it has, so a phase only moves on what outweighs it.
function leader(calls: WorkCall[], end: number, current: Work | null): Work | null {
  const recent = calls.slice(Math.max(0, end - WINDOW + 1), end + 1);
  const scores = new Map<Work, number>();
  recent.forEach(({ work }, i) => scores.set(work, (scores.get(work) ?? 0) + WEIGHT[work] * DECAY ** (recent.length - 1 - i)));
  let best = current;
  let top = current ? scores.get(current) ?? 0 : -1;
  for (const [work, score] of scores) {
    if (score > top) [best, top] = [work, score];
  }
  return best;
}

// Replayed from the first call, so a phase is held for a while before another can take over.
function workPhase(calls: WorkCall[], now: number): Work | null {
  let phase: Work | null = null;
  let since = 0;
  const consider = (end: number, at: number): void => {
    const next = leader(calls, end, phase);
    if (next === phase || (phase && at - since < PHASE_HOLD_MS)) return;
    phase = next;
    since = at;
  };
  calls.forEach((call, end) => consider(end, call.at));
  if (calls.length) consider(calls.length - 1, now);
  return phase;
}

export function agentPhase(log: AgentLog, state: ClaudeState, alive: boolean, now = Date.now()): Phase | null {
  if (state === 'waiting' || state === 'blocked') return 'waiting';
  if (state === 'done') return log.outcome === 'stopped' ? 'stopped' : 'done';
  if (alive && !log.turnOpen && log.background.length) return 'builders';
  return workPhase(log.calls, now);
}
