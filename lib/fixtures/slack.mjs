// Made-up Slack answers in the shape the Slack connector gives, and the stream a headless read of them prints.
const SEARCH = 'mcp__claude_ai_Slack__slack_search_public_and_private';
export const ME = 'U0FRANK0001';
export const NOW = Math.floor(Date.now() / 60_000) * 60_000;

const READS = ['get_reactions', 'list_channel_members', 'list_user_channels', 'read_canvas', 'read_channel', 'read_file', 'read_list', 'read_thread', 'read_user_profile', 'search_channels', 'search_emojis', 'search_public', 'search_public_and_private', 'search_users'];
const WRITES = ['add_list_record', 'add_reaction', 'complete_file_upload', 'create_canvas', 'create_conversation', 'create_list', 'get_file_upload_url', 'schedule_message', 'send_message', 'send_message_draft', 'update_canvas', 'update_list', 'update_list_record'];
export const SLACK_READS = READS.map((n) => `mcp__claude_ai_Slack__slack_${n}`);
export const SLACK_TOOLS = [...SLACK_READS, ...WRITES.map((n) => `mcp__claude_ai_Slack__slack_${n}`)];

export const tsAgo = (minutes) => ((NOW - minutes * 60_000) / 1000).toFixed(6);
const PEOPLE = {
  [ME]: ['Frank Foster', 'frank@example.com'], U0VICTOR001: ['Victor Vale', 'victor@example.com'], U0WENDY0001: ['Wendy West', 'wendy@example.org'],
  U0WALTER001: ['Walter Wells', 'walter@example.com'], U0SYBIL0001: ['Sybil Shaw', 'sybil@example.com'], U0FELIX0001: ['Felix Fox', 'felix@example.com'],
};

export function message({ channel = 'C0PLATFORM1', place = '#platform', from = 'U0VICTOR001', ts, thread = null, replies = 0, text = '', bot = null, participants = null }) {
  return { channel, place, from, ts, thread, replies, text, bot, participants };
}

function block(m, i, n) {
  const [name, address] = PEOPLE[m.from] ?? ['Someone', 'someone@example.com'];
  const link = `https://example.slack.com/archives/${m.channel}/p${m.ts.replace('.', '')}${m.thread ? `?thread_ts=${m.thread}&cid=${m.channel}` : ''}`;
  return [
    `### Result ${i + 1} of ${n}`,
    `Channel: ${m.place} (ID: ${m.channel})`,
    m.participants ? `Participants: ${m.participants}` : null,
    m.bot ? `From: ${m.bot} (ID: ${m.from})  [BOT]` : `From: ${name} <${address}> (ID: ${m.from}) `,
    `Time: ${new Date(Number(m.ts) * 1000).toISOString().replace('T', ' ').slice(0, 19)} GMT`,
    `Message_ts: ${m.ts}`,
    m.replies ? `Reply count: ${m.replies}` : null,
    `Permalink: [link](${link})`,
    'Text: ',
    m.text,
  ].filter((line) => line !== null).join('\n');
}

export function results(messages, query = '') {
  const blocks = messages.map((m, i) => block(m, i, messages.length));
  const body = `# Search Results for: ${query}\n\n## Messages (${messages.length} results)\n${blocks.map((b) => `${b}\n\n---\n\n`).join('')}`;
  return JSON.stringify({ results: body, pagination_info: 'For the next page of results use cursor `abc=`\n' });
}

const THREAD_A = tsAgo(120);
const THREAD_INFRA = tsAgo(200);

export const M = {
  deploy: message({ ts: tsAgo(60), text: '<@U0FRANK0001|Frank Foster> could you look at the deploy &amp; the rollback?' }),
  answered: message({ from: 'U0WENDY0001', ts: tsAgo(50), thread: THREAD_A, text: '<@U0FRANK0001> what do you think?' }),
  answer: message({ from: ME, ts: tsAgo(40), thread: THREAD_A, text: 'Ship it.' }),
  pipeline: message({ from: 'B0GITLAB001', bot: 'GitLab', ts: tsAgo(30), text: '<@U0FRANK0001> pipeline failed' }),
  office: message({ channel: 'C0RANDOM001', place: '#random', from: 'U0WALTER001', ts: tsAgo(45), text: '<@U0FRANK0001|Frank> fyi the office is closed on Friday' }),
  approve: message({ channel: 'C0NOISY0001', place: '#noisy', from: 'U0SYBIL0001', ts: tsAgo(20), text: '<@U0FRANK0001|Frank> please approve the change' }),
  morning: message({ channel: 'D0VICTOR001', place: 'DM', from: ME, ts: tsAgo(70), text: 'Morning', participants: 'Victor Vale (ID: U0VICTOR001), Frank Foster (ID: U0FRANK0001)' }),
  minute: message({ channel: 'D0VICTOR001', place: 'DM', ts: tsAgo(15), text: 'Have you got a minute for the budget?', participants: 'Victor Vale (ID: U0VICTOR001), Frank Foster (ID: U0FRANK0001)' }),
  release: message({ channel: 'D0WENDY0001', place: 'DM', from: 'U0WENDY0001', ts: tsAgo(90), text: 'Is the release out?', participants: 'Wendy West (ID: U0WENDY0001), Frank Foster (ID: U0FRANK0001)' }),
  released: message({ channel: 'D0WENDY0001', place: 'DM', from: ME, ts: tsAgo(80), text: 'Yes, it went out at nine', participants: 'Wendy West (ID: U0WENDY0001), Frank Foster (ID: U0FRANK0001)' }),
  lunch: message({ channel: 'C0GROUP0001', place: 'Group DM', from: 'U0WALTER001', ts: tsAgo(25), text: 'Lunch at one?', participants: 'Walter Wells (ID: U0WALTER001), Sybil Shaw (ID: U0SYBIL0001), Frank Foster (ID: U0FRANK0001)' }),
  cacheRoot: message({ channel: 'C0INFRA0001', place: '#infra', from: ME, ts: THREAD_INFRA, replies: 2, text: 'Who owns the cache?' }),
  cacheEarly: message({ channel: 'C0INFRA0001', place: '#infra', from: 'U0WALTER001', ts: tsAgo(100), thread: THREAD_INFRA, text: 'Not me' }),
  cacheTaken: message({ channel: 'C0INFRA0001', place: '#infra', from: 'U0FELIX0001', ts: tsAgo(10), thread: THREAD_INFRA, text: 'I can take it, is that ok?' }),
  incident: message({ channel: 'C0OPS000001', place: '#ops', from: 'U0SYBIL0001', ts: tsAgo(5), text: 'Incident in prod, all hands please' }),
  group: message({ channel: 'C0ENG000001', place: '#eng', from: 'U0WENDY0001', ts: tsAgo(8), text: '<!subteam^S0PLAT0001|@platform-team> please review the plan' }),
  noWord: message({ channel: 'C0OPS000001', place: '#ops', from: 'U0WALTER001', ts: tsAgo(6), text: 'All quiet here' }),
};

export const FOUND = {
  mention: [M.approve, M.pipeline, M.office, M.answered, M.deploy],
  dm: [M.minute, M.lunch, M.morning, M.released, M.release],
  thread: [M.cacheTaken, M.answer, M.answered, M.cacheEarly],
  own: [M.answer, M.morning, M.released, M.cacheRoot],
  incident: [M.incident, M.noWord],
  '@platform-team': [M.group],
};

const pick = (m, kind, reason) => ({ channel: m.channel, ts: m.ts, kind, reason });

// What Claude chose: every kind the default read can hold, plus messages the worker's own rules must still leave out, and one it made up.
export const PICKS = [
  pick(M.deploy, 'mention', 'Victor wants you to look at the deploy and the rollback.'),
  pick(M.approve, 'mention', 'Sybil needs your approval on the change.'),
  pick(M.minute, 'mention', 'Victor wants a minute about the budget.'),
  pick(M.minute, 'dm', 'Victor wants a minute about the budget.'),
  pick(M.lunch, 'dm', 'Walter asks if you are free for lunch at one.'),
  pick(M.cacheTaken, 'reply', 'Felix offers to take the cache and asks if that is ok.'),
  pick(M.answered, 'mention', 'Wendy asks what you think.'),
  pick(M.pipeline, 'mention', 'A pipeline failed.'),
  pick(M.release, 'dm', 'Wendy asks if the release is out.'),
  pick(M.cacheEarly, 'reply', 'Walter says not her.'),
  pick(M.answer, 'reply', 'You said ship it.'),
  { channel: 'C0FAKE00001', ts: '1700000000.000100', kind: 'mention', reason: 'A message Slack never returned.' },
];

export const WORD_PICKS = [pick(M.incident, 'keyword', 'Sybil calls everyone to an incident in prod.'), pick(M.group, 'group', 'Wendy wants the platform team to review the plan.'), pick(M.noWord, 'keyword', 'Walter says all is quiet.')];

const toolResult = (id, text, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: [{ type: 'text', text }] }] } });
const withMe = (args, me) => JSON.parse(JSON.stringify(args).replaceAll('<@ME>', `<@${me}>`));
const searchName = (s) => s.word ?? s.name;

export function slackRun({ asked, me = ME, found = FOUND, picks = PICKS, tools = SLACK_TOOLS, status = 'connected', result = {}, cost = 0.0234, errors = {}, skipSearch = null } = {}) {
  const made = asked.filter((s) => searchName(s) !== skipSearch);
  return [
    { type: 'system', subtype: 'init', model: 'claude-haiku-5-5', permissionMode: 'dontAsk', tools, mcp_servers: [{ name: 'claude.ai Gmail', status: 'connected' }, { name: 'claude.ai Slack', status }] },
    { type: 'assistant', message: { role: 'assistant', content: made.map((s, i) => ({ type: 'tool_use', id: `s${i}`, name: SEARCH, input: withMe(s.args, me) })) } },
    ...made.map((s, i) => toolResult(`s${i}`, errors[searchName(s)] ?? results(found[searchName(s)] ?? [], s.args.filters), Boolean(errors[searchName(s)]))),
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'out', name: 'StructuredOutput', input: { messages: picks } }] } },
    toolResult('out', 'Structured output provided successfully'),
    { type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 6000, total_cost_usd: cost, result: '', structured_output: { messages: picks }, ...result },
  ];
}

const READ_THREAD = 'mcp__claude_ai_Slack__slack_read_thread';
const READ_CHANNEL = 'mcp__claude_ai_Slack__slack_read_channel';
const SEND = 'mcp__claude_ai_Slack__slack_send_message';
const stamp = (ts) => new Date(Number(ts) * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' GMT';

function said(m) {
  const [name, address] = PEOPLE[m.from] ?? ['Someone', 'someone@example.com'];
  return [m.bot ? `From: ${m.bot} (${m.from}) [BOT]` : `From: ${name} <${address}> (${m.from})`, `Time: ${stamp(m.ts)}`, `Message TS: ${m.ts}`, m.text].join('\n');
}

// The shape slack_read_thread answers in: the parent, then each reply numbered out of the total.
export function threadAnswer([parent, ...replies], { more = false, total = replies.length } = {}) {
  const body = [`=== THREAD PARENT MESSAGE ===\n${said(parent)}`, `=== THREAD REPLIES (${total} total) ===`, ...replies.map((m, i) => `--- Reply ${i + 1} of ${total} ---\n${said(m)}`)].join('\n\n');
  return JSON.stringify({ messages: body, pagination_info: more ? 'There are more replies: use cursor `abc=` for the next page.' : 'There are no more messages in this thread.' });
}

// The shape slack_read_channel answers in, seen on a real DM: newest first, sender and time in the heading, which ends in a space.
export function channelAnswer(messages, { channel = 'DM (D0TEST0001)' } = {}) {
  const heading = (m) => {
    const [name, address] = PEOPLE[m.from] ?? ['Someone', 'someone@example.com'];
    return m.bot ? `${m.bot} (${m.from}) [BOT]` : `${name} <${address}> (${m.from})`;
  };
  const newest = [...messages].sort((a, b) => Number(b.ts) - Number(a.ts));
  const body = newest.map((m) => `=== Message from ${heading(m)} at ${stamp(m.ts)} === \nMessage TS: ${m.ts}\n${m.text}`).join('\n\n');
  return JSON.stringify({ messages: `Channel: ${channel}\n\n${body}`, pagination_info: 'There are no more messages available.\n' });
}

const init = (tools = SLACK_TOOLS, status = 'connected') => ({ type: 'system', subtype: 'init', model: 'claude-haiku-5-5', permissionMode: 'dontAsk', tools, mcp_servers: [{ name: 'claude.ai Slack', status }] });
const finished = (cost, extra = {}) => ({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 4000, total_cost_usd: cost, result: 'done', ...extra });

export function toolRun(calls, { tools, status, cost = 0.0123, result = {}, output = null } = {}) {
  return [
    init(tools, status),
    { type: 'assistant', message: { role: 'assistant', content: calls.map(([name, input], i) => ({ type: 'tool_use', id: `t${i}`, name, input })) } },
    ...calls.map(([, , answer, isError], i) => toolResult(`t${i}`, answer, Boolean(isError))),
    ...(output ? [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'out', name: 'StructuredOutput', input: output }] } }, toolResult('out', 'Structured output provided successfully')] : []),
    finished(cost, { ...(output ? { structured_output: output } : {}), ...result }),
  ];
}

export const THREAD_CALL = { channel_id: M.cacheRoot.channel, message_ts: M.cacheRoot.ts, limit: 100 };
export const INFRA_THREAD = [M.cacheRoot, M.cacheEarly, { ...M.cacheTaken, text: '<@U0FRANK0001|Frank Foster> I can take it, is that ok? See <https://example.com/cache|the plan> &amp; <@U0WALTER001>' }];
export const threadRead = (messages = INFRA_THREAD, options = {}) => toolRun([[READ_THREAD, THREAD_CALL, threadAnswer(messages, options)]], options);
export const readChannel = (input, messages) => [READ_CHANNEL, input, channelAnswer(messages)];
export const draftRun = (reply, options = {}) => toolRun(options.calls ?? [[READ_THREAD, THREAD_CALL, threadAnswer(INFRA_THREAD)]], { cost: 0.0841, output: { reply }, ...options });

// The shape a real send came back in, slashes escaped; whether a reply's link names its thread is a guess.
export const SENT_ANSWER = JSON.stringify({ message_link: 'https://example.slack.com/archives/$CHANNEL/p1794312800000200?thread_ts=$THREAD&cid=$CHANNEL', message_context: { message_ts: '1794312800.000200', channel_id: '$CHANNEL' } }).replaceAll('/', '\\/');
export const sendRun = (inputs, options = {}) => toolRun(inputs.map(([name, input, answer = SENT_ANSWER, isError]) => [name ?? SEND, input, answer, isError]), { cost: 0.0102, ...options });
