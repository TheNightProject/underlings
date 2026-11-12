import { FOLDER } from '../../lib/product.mjs';
import { FINISH_TOOL, QUEUE_TOOL } from './agentprompts.js';
import { addToQueue, markPassDone } from './data/store.js';
import { queueInput } from './queueinput.js';
import { SEVERITY_ORDER } from './types.js';

export const REVIEW_SERVER = FOLDER;
export const REVIEW_TOOL_RULES = [QUEUE_TOOL, FINISH_TOOL].map((name) => `mcp__${REVIEW_SERVER}__${name}`);
const PROTOCOL = '2025-06-18';
const QUEUED_BY = 'review-agent';

const POSITION = {
  type: 'object',
  description: 'Where on the diff, from the merge request\'s latest version. Leave it out for a point about the change as a whole.',
  properties: {
    base_sha: { type: 'string' }, start_sha: { type: 'string' }, head_sha: { type: 'string' },
    new_path: { type: 'string' }, new_line: { type: 'integer' }, old_path: { type: 'string' }, old_line: { type: 'integer' },
  },
};

const ITEM = {
  type: 'object',
  properties: {
    projectPath: { type: 'string', description: 'The project as group/repo' },
    projectId: { type: 'integer' },
    iid: { type: 'integer', description: 'The merge request\'s number in its project' },
    webUrl: { type: 'string' },
    severity: { type: 'string', enum: SEVERITY_ORDER },
    body: { type: 'string', description: 'The comment exactly as it would be posted' },
    diffHunk: { type: 'string', description: 'The lines of the diff it is about, as shown in chat' },
    position: POSITION,
    kind: { type: 'string', enum: ['finding', 'reply'] },
    replyTo: { type: 'string', description: 'For a reply, the discussion id it answers' },
    outcome: { type: 'string', enum: ['fixed', 'not-fixed', 'disagree'] },
    createdBy: { type: 'string' },
  },
  required: ['projectPath', 'projectId', 'iid', 'body'],
};

export const REVIEW_TOOLS = [
  {
    name: QUEUE_TOOL,
    title: 'Queue review findings',
    description: 'Queues findings on a merge request, and replies on its open threads, for the user to read and post. Nothing is posted: they wait in the review queue.',
    inputSchema: { type: 'object', properties: { findings: { type: 'array', items: ITEM, minItems: 1 } }, required: ['findings'], additionalProperties: false },
  },
  {
    name: FINISH_TOOL,
    title: 'Finish a review pass',
    description: 'Says an unattended review pass has finished, whether or not it queued anything.',
    inputSchema: { type: 'object', properties: { pass: { type: 'string' } }, required: ['pass'], additionalProperties: false },
  },
];

function queueFindings(args: Record<string, unknown>): string {
  const findings = Array.isArray(args['findings']) ? (args['findings'] as unknown[]) : [];
  if (!findings.length) throw new Error('findings is a list of at least one finding');
  const added = addToQueue(findings.map((item, i) => queueInput({ createdBy: QUEUED_BY, ...(item as object) }, i)));
  return `Queued ${added.length} for the user to read. Nothing was posted: each waits in the review queue until they post it.`;
}

function finishReview(args: Record<string, unknown>): string {
  const pass = typeof args['pass'] === 'string' ? args['pass'] : '';
  if (!markPassDone(pass)) throw new Error(`there is no review pass ${pass}`);
  return `Pass ${pass} marked finished`;
}

const CALLS: Record<string, (args: Record<string, unknown>) => string> = { [QUEUE_TOOL]: queueFindings, [FINISH_TOOL]: finishReview };

type Said = { content: { type: 'text'; text: string }[]; isError?: true };
const said = (text: string, isError = false): Said => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true as const } : {}) });

export function callReviewTool(name: unknown, args: unknown): Said {
  const call = typeof name === 'string' ? CALLS[name] : undefined;
  if (!call) return said(`There is no tool called ${String(name)}.`, true);
  try {
    return said(call(args && typeof args === 'object' ? (args as Record<string, unknown>) : {}));
  } catch (err) {
    return said(err instanceof Error ? err.message : String(err), true);
  }
}

interface Request {
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: unknown; name?: unknown; arguments?: unknown };
}

const METHODS: Record<string, (params: Request['params']) => unknown> = {
  initialize: (params) => ({
    protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL,
    capabilities: { tools: {} },
    serverInfo: { name: REVIEW_SERVER, version: '1.0.0' },
  }),
  ping: () => ({}),
  'tools/list': () => ({ tools: REVIEW_TOOLS.map((t) => ({ ...t, annotations: { title: t.title, readOnlyHint: false, destructiveHint: false, openWorldHint: false } })) }),
  'tools/call': (params) => callReviewTool(params?.name, params?.arguments ?? {}),
};

export function answerLine(line: string): Record<string, unknown> | null {
  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'that line is not JSON' } };
  }
  if (request.id === undefined || request.id === null) return null;
  const method = request.method ? METHODS[request.method] : undefined;
  if (!method) return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `no method ${request.method}` } };
  return { jsonrpc: '2.0', id: request.id, result: method(request.params) };
}
