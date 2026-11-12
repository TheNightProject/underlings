import { capital } from './profile.mjs';
import { APP_NAME, FOLDER } from './product.mjs';

export const SERVER = FOLDER;
// What the server was called before, still met in the transcripts of agents that ran under it.
const OLD_SERVER = 'control-centre';

const MR = { type: 'string', description: 'The MR as group/repo!iid, or owner/repo#iid for a GitHub pull request, as list_mrs gives it' };
const SHA = { type: 'string', description: 'The full head sha get_mr gave you, so nothing is done to a head you have not read' };
const TICKET = { type: 'string', description: 'A Jira key such as ABC-1234' };
const HANDLE = { type: 'string', description: 'The agent as list_agents gives it, claude: then its session id' };
const ITEM = { type: 'string', description: 'A review queue item id, as review_queue gives it' };
const SEVERITY = { type: 'string', enum: ['CRITICAL', 'MAJOR', 'MINOR', 'NIT', 'QUESTION'] };

const shape = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

// A tool that names an action writes through it, and every one of those asks first, whatever mode the session is in.
export const TOOLS = [
  {
    name: 'needs_me', title: 'Read what needs you',
    description: (p) => `What needs ${p.who} now, as ${p.whose} Needs you page shows it: one card per MR with every reason, agents waiting on ${p.who}, and anything wrong with ${APP_NAME} itself.`,
    inputSchema: shape({}),
  },
  {
    name: 'list_mrs', title: 'List merge requests',
    description: (p) => `The open MRs ${APP_NAME} tracks. scope asking is MRs waiting on ${p.whose} review, mine is ${p.whose} own, watched is the reviewed ones on ${p.whose} watch list.`,
    inputSchema: shape({
      scope: { type: 'string', enum: ['all', 'asking', 'mine', 'watched'] },
      repo: { type: 'string', description: 'A repo name or group/repo path' },
      author: { type: 'string', description: 'A GitLab username' },
      search: { type: 'string', description: 'Words in the title, key or ticket' },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }),
  },
  {
    name: 'get_mr', title: 'Read an MR',
    description: 'One MR in full: its state and head sha, merge status and how it can merge, failing jobs, files changed, description, every thread with its notes, and the findings queued on it.',
    inputSchema: shape({ mr: MR }, ['mr']),
  },
  {
    name: 'review_queue', title: 'Read the review queue',
    description: (p) => `Findings and replies in ${p.whose} review queue, waiting to be posted, for every MR or one.`,
    inputSchema: shape({ mr: MR }),
  },
  {
    name: 'list_agents', title: 'List agents',
    description: 'Every review, fix, kickoff and message agent, with its state, what it works for, what it last said and any question or permission it waits on.',
    inputSchema: shape({ state: { type: 'string', enum: ['working', 'waiting', 'blocked', 'done'] } }),
  },
  {
    name: 'get_agent', title: 'Read an agent',
    description: 'One agent\'s recent conversation: its words, the tools it ran and what it asks.',
    inputSchema: shape({ handle: HANDLE }, ['handle']),
  },
  {
    name: 'list_tickets', title: 'List tickets',
    description: (p) => `${capital(p.whose)} open Jira tickets, with their epic, status, MRs and the statuses each can move to.`,
    inputSchema: shape({}),
  },
  {
    name: 'standup', title: 'Read a standup',
    description: 'The standup for a day: the last working day, which is what a standup covers, unless a day is given.',
    inputSchema: shape({ day: { type: 'string', description: 'A day such as 2026-11-09' } }),
  },
  {
    name: 'qa_board', title: 'Read the QA board',
    description: 'The team\'s QA board: tickets waiting on QA, in QA and done, with their MRs.',
    inputSchema: shape({}),
  },
  {
    name: 'propose_reply', title: 'Propose a reply', draft: true,
    description: 'The last step of an agent acting on a Slack message or an email thread: keeps the reply to send, and one line on what you did, to be read, edited and sent from the page. Nothing is sent.',
    inputSchema: shape({
      item: { type: 'string', description: 'The item your task names, such as slack:C0123ABCD:1794301200.000100 or email:19a2b3c4d5e6f708' },
      reply: { type: 'string', description: 'The reply, in the voice of the person you act for' },
      summary: { type: 'string', description: 'One line on what you did, or that there was nothing to do' },
    }, ['item', 'reply', 'summary']),
  },
  {
    name: 'start_review', title: 'Start a review', action: 'review',
    description: (p) => `Starts a review agent on an MR. What it finds waits in ${p.whose} review queue.`,
    inputSchema: shape({ mr: MR }, ['mr']),
  },
  {
    name: 'start_fix', title: 'Start a fix agent', action: 'fix',
    description: (p) => `Starts a fix agent on one of ${p.whose} own MRs, for its open threads, one thread, or its merge conflicts. It asks before it pushes.`,
    inputSchema: shape({ mr: MR, sha: SHA, thread: { type: 'string', description: 'One thread id from get_mr, or leave it out for every thread left to fix' }, conflicts: { type: 'boolean' } }, ['mr', 'sha']),
  },
  {
    name: 'start_kickoff', title: 'Start a ticket', action: 'ticket-start',
    description: (p) => `Starts a kickoff agent on one of ${p.whose} open tickets. It asks before it pushes, raises an MR or touches Jira.`,
    inputSchema: shape({ ticket: TICKET }, ['ticket']),
  },
  {
    name: 'reply_to_agent', title: 'Reply to an agent', action: 'agent-reply',
    description: 'Answers another agent: text as a message, or answer for the option it offers, or allow true or false for the permission it waits on. pending is the id of the ask list_agents showed, or null if it was asking nothing.',
    inputSchema: shape({ handle: HANDLE, pending: { type: ['string', 'null'] }, text: { type: 'string' }, answer: { type: 'string' }, allow: { type: 'boolean' } }, ['handle', 'pending']),
  },
  {
    name: 'queue_finding', title: 'Queue a finding', action: 'queue-finding',
    description: (p) => `Queues a finding on an MR as a whole, not on a line. It waits in ${p.whose} review queue until it is posted.`,
    inputSchema: shape({ mr: MR, severity: SEVERITY, body: { type: 'string' } }, ['mr', 'severity', 'body']),
  },
  {
    name: 'post_finding', title: 'Post a finding', action: 'post',
    description: 'Posts one queued finding or reply to GitLab.',
    inputSchema: shape({ id: ITEM }, ['id']),
  },
  {
    name: 'post_all_findings', title: 'Post every finding on an MR', action: 'post-all',
    description: 'Posts every finding and reply queued on one MR to GitLab.',
    inputSchema: shape({ mr: MR }, ['mr']),
  },
  {
    name: 'discard_finding', title: 'Discard a finding', action: 'discard',
    description: 'Throws one queued finding or reply away, so it is never posted.',
    inputSchema: shape({ id: ITEM }, ['id']),
  },
  {
    name: 'merge_mr', title: 'Merge an MR', action: 'merge',
    description: (p) => `Merges one of ${p.whose} own MRs at the head you read: when now, if get_mr says it can merge now, or green, to merge once its pipeline passes.`,
    inputSchema: shape({ mr: MR, sha: SHA, when: { type: 'string', enum: ['now', 'green'] } }, ['mr', 'sha', 'when']),
  },
  {
    name: 'move_ticket', title: 'Move a ticket', action: 'ticket-status',
    description: (p) => `Moves one of ${p.whose} open tickets from the status you read to one list_tickets offers.`,
    inputSchema: shape({ ticket: TICKET, from: { type: 'string' }, to: { type: 'string' } }, ['ticket', 'from', 'to']),
  },
];

export const describe = (tool, who) => (typeof tool.description === 'function' ? tool.description(who) : tool.description);

export const toolRule = (name) => `mcp__${SERVER}__${name}`;
export const gmailRule = (name) => `mcp__claude_ai_Gmail__${name}`;
export const calendarRule = (name) => `mcp__claude_ai_Google_Calendar__${name}`;

// Gmail and the calendar are the user's own claude.ai connectors, so whatever changes them asks first, whatever mode the panel runs in, and nothing sends.
const GMAIL_ASK = { create_draft: 'Save a Gmail draft', update_draft: 'Change a Gmail draft' };
const GMAIL_CHANGES = {
  trash_message: 'Bin a Gmail message', trash_thread: 'Bin a Gmail thread', untrash_message: 'Take a Gmail message out of the bin', untrash_thread: 'Take a Gmail thread out of the bin',
  mark_message_spam: 'Mark a Gmail message as spam', mark_thread_spam: 'Mark a Gmail thread as spam', unmark_message_spam: 'Say a Gmail message is not spam', unmark_thread_spam: 'Say a Gmail thread is not spam',
  label_message: 'Label a Gmail message', label_thread: 'Label a Gmail thread', unlabel_message: 'Take a label off a Gmail message', unlabel_thread: 'Take a label off a Gmail thread',
  update_message_labels: 'Change a Gmail message\'s labels', apply_sensitive_message_label: 'Mark a Gmail message sensitive', apply_sensitive_thread_label: 'Mark a Gmail thread sensitive',
  create_label: 'Make a Gmail label', update_label: 'Change a Gmail label', delete_label: 'Delete a Gmail label', delete_draft: 'Delete a Gmail draft',
};
const CALENDAR_CHANGES = { create_event: 'Add a calendar event', update_event: 'Change a calendar event', delete_event: 'Delete a calendar event', respond_to_event: 'Answer a calendar invitation' };
export const GMAIL_SENDS = ['send_message', 'reply', 'forward'];
export const slackRule = (name) => `mcp__claude_ai_Slack__${name}`;

// Every Slack tool that posts or changes anything asks first, whatever mode the panel runs in.
const SLACK_ASK = {
  slack_send_message: 'Send a Slack message', slack_send_message_draft: 'Save a Slack draft', slack_schedule_message: 'Schedule a Slack message', slack_add_reaction: 'React in Slack',
  slack_create_canvas: 'Make a Slack canvas', slack_update_canvas: 'Change a Slack canvas', slack_create_list: 'Make a Slack list', slack_update_list: 'Change a Slack list',
  slack_add_list_record: 'Add to a Slack list', slack_update_list_record: 'Change a Slack list item', slack_get_file_upload_url: 'Upload a file to Slack', slack_complete_file_upload: 'Share a file in Slack',
  slack_create_conversation: 'Start a Slack conversation',
};
export const SLACK_WRITES = Object.keys(SLACK_ASK);

const mailAndCalendarChanges = () => [...Object.keys(GMAIL_CHANGES).map(gmailRule), ...Object.keys(CALENDAR_CHANGES).map(calendarRule)];

export function permissionRules() {
  return {
    allow: TOOLS.filter((t) => !t.action).map((t) => toolRule(t.name)),
    ask: [...TOOLS.filter((t) => t.action).map((t) => toolRule(t.name)), ...Object.keys(GMAIL_ASK).map(gmailRule), ...SLACK_WRITES.map(slackRule), ...mailAndCalendarChanges()],
    deny: GMAIL_SENDS.map(gmailRule),
  };
}

// An agent acting on a message never sends one, so its reply reaches Slack only through the page's own send.
export const SLACK_SENDS = ['slack_send_message', 'slack_schedule_message'];

// It acts on one message, so it never tidies the mailbox or moves a meeting while it does.
export function messageAgentRules() {
  const { allow, ask, deny } = permissionRules();
  const refused = [...SLACK_SENDS.map(slackRule), ...mailAndCalendarChanges()];
  return { allow, ask: ask.filter((rule) => !refused.includes(rule)), deny: [...deny, ...refused] };
}

export function toolTitles() {
  const titled = (rule, table) => Object.entries(table).map(([name, title]) => [rule(name), title]);
  return Object.fromEntries([
    ...TOOLS.flatMap((t) => [[toolRule(t.name), t.title], [`mcp__${OLD_SERVER}__${t.name}`, t.title]]), ...titled(gmailRule, GMAIL_ASK), ...titled(gmailRule, GMAIL_CHANGES), ...titled(calendarRule, CALENDAR_CHANGES), ...titled(slackRule, SLACK_ASK),
  ]);
}
