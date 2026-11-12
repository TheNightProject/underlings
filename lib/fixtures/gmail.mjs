// Made-up Gmail answers in the shapes the Gmail connector gives, and the stream a headless read of them prints.
const SEARCH = 'mcp__claude_ai_Gmail__search_threads';
const READ = 'mcp__claude_ai_Gmail__get_thread';
export const GMAIL_TOOLS = [SEARCH, READ, 'mcp__claude_ai_Gmail__create_draft', 'mcp__claude_ai_Gmail__send_message'];

export function message(id, { from = 'victor@example.com', name = 'Victor Vale', at = '2026-11-10T09:00:00Z', subject = 'Budget for the offsite', snippet = 'Could you sign off the budget by Friday?', labels = ['INBOX', 'UNREAD'], ...extra } = {}) {
  return {
    id, threadId: id.split('.')[0], sender: from, addressDisplayNames: [{ displayName: name, emailAddress: from }], toRecipients: ['frank@example.com'],
    date: at, internalDate: String(Date.parse(at)), labelIds: labels, subject, snippet, viewUrl: `https://mail.google.com/mail/?authuser=frank@example.com#all/${id}`, ...extra,
  };
}

export function thread(id, messages) {
  return { id, messageCount: messages.length, messages, viewUrl: `https://mail.google.com/mail/?authuser=frank@example.com#all/${id}` };
}

export const INBOX = [
  thread('a1b2c3d4e5f60001', [message('a1b2c3d4e5f60001', { at: '2026-11-10T09:00:00Z' })]),
  thread('a1b2c3d4e5f60002', [message('a1b2c3d4e5f60002', { from: 'wendy@example.org', name: 'Wendy West', at: '2026-11-10T08:15:00Z', subject: 'Re: Hiring panel &amp; dates', snippet: 'Frank, are you free to sit on the panel?' })]),
  thread('a1b2c3d4e5f60003', [message('a1b2c3d4e5f60003', { from: 'noreply@gitlab.com', name: 'GitLab', subject: 'Pipeline failed', snippet: 'Your pipeline failed.' })]),
  thread('a1b2c3d4e5f60004', [message('a1b2c3d4e5f60004', { from: 'frank@example.com', name: 'Frank', subject: 'Re: Supplier call', snippet: 'Thanks, all sorted.', labels: ['SENT'] })]),
  thread('a1b2c3d4e5f60005', [message('a1b2c3d4e5f60005', { from: 'walter@example.com', name: 'Walter Wells', at: '2026-11-09T16:30:00Z', subject: 'Invitation: Roadmap review @ Thu 13 Nov', snippet: 'You have been invited to Roadmap review.' })]),
  thread('a1b2c3d4e5f60006', [message('a1b2c3d4e5f60006', { from: 'walter@example.com', name: 'Walter Wells', subject: 'Accepted: Roadmap review @ Thu 13 Nov', snippet: 'Walter Wells has accepted this invitation.' })]),
  thread('a1b2c3d4e5f60007', [message('a1b2c3d4e5f60007', { from: 'deals@shop.example.net', name: 'Shop', subject: 'Half price today', snippet: 'Everything must go.', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] })]),
  thread('a1b2c3d4e5f60008', [message('a1b2c3d4e5f60008', { from: 'news@digest.example.com', name: 'Weekly digest', subject: 'This week in tools', snippet: 'Five things to read.' })]),
];

// What Claude chose: every kind once, plus threads the worker's own rules must still leave out, and one it made up.
export const PICKS = [
  { threadId: 'a1b2c3d4e5f60001', kind: 'asked', reason: 'Victor wants the offsite budget signed off by Friday.' },
  { threadId: 'a1b2c3d4e5f60002', kind: 'waiting', reason: 'Wendy is waiting to hear if you can sit on the panel.' },
  { threadId: 'a1b2c3d4e5f60005', kind: 'invite', reason: 'Walter invited you to the roadmap review on Thursday.' },
  { threadId: 'a1b2c3d4e5f60003', kind: 'asked', reason: 'A pipeline failed.' },
  { threadId: 'a1b2c3d4e5f60004', kind: 'waiting', reason: 'You replied last.' },
  { threadId: 'a1b2c3d4e5f60006', kind: 'invite', reason: 'Walter accepted.' },
  { threadId: 'a1b2c3d4e5f60007', kind: 'mentioned', reason: 'A sale.' },
  { threadId: 'ffffffffffff0000', kind: 'asked', reason: 'A thread Gmail never returned.' },
];

const textResult = (id, value, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }] } });
const toolUse = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });

export function gmailRun({ threads = INBOX, picks = PICKS, reads = [], searchError = null, tools = GMAIL_TOOLS, result = {}, cost = 0.0123 } = {}) {
  const search = searchError ? textResult('t1', searchError, true) : textResult('t1', threads.length ? { resultCountEstimate: String(threads.length), threads } : {});
  return [
    { type: 'system', subtype: 'init', model: 'claude-haiku-5-5', permissionMode: 'dontAsk', tools },
    toolUse('t1', SEARCH, { query: 'in:inbox', pageSize: 50, view: 'THREAD_VIEW_SUMMARY' }),
    search,
    ...reads.flatMap((t, i) => [toolUse(`r${i}`, READ, { threadId: t.id, messageFormat: 'MINIMAL' }), textResult(`r${i}`, t)]),
    toolUse('t9', 'StructuredOutput', { threads: picks }),
    textResult('t9', 'Structured output provided successfully'),
    { type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 9000, total_cost_usd: cost, result: '', structured_output: { threads: picks }, ...result },
  ];
}
