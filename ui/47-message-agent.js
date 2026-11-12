const MESSAGE_AGENT_WORDS = {
  working: ['Agent working', 'It asks you before anything that writes.'],
  asks: ['Agent asks you', 'Answer it here, in Agents or in Needs you.'],
  stopped: ['Agent stopped', 'It proposed no reply.'],
  ended: ['Agent finished', 'It ended without proposing a reply.'],
};

function messageAgentOf(source, key) {
  return state?.messageAgents?.items?.[source + ':' + key] ?? null;
}

const messageAgentLive = (a) => a?.status === 'working' || a?.status === 'asks';
const messageAgentBusyId = (source, key) => 'message-agent:' + source + ':' + key;

function messageAgentButton(source, key, id) {
  const a = messageAgentOf(source, key);
  if (messageAgentLive(a)) {
    return el('button', { id, type: 'button', title: 'Show the agent working on it', onclick: () => showMessageAgent(a.handle) }, icon('bot'), MESSAGE_AGENT_WORDS[a.status][0]);
  }
  const busy = ui.busy.has(messageAgentBusyId(source, key));
  return el('button', { id, type: 'button', disabled: busy, title: 'A Claude Code agent works out what it asks of you and does it, asking before anything that writes, then proposes your reply. Nothing is sent.', onclick: () => startMessageAgent(source, key) },
    icon(busy ? 'clock' : 'sparkles'), busy ? 'Starting…' : 'Action with agent');
}

async function startMessageAgent(source, key) {
  const answer = await busyAct('/api/message-agent/start', { source, key }, messageAgentBusyId(source, key));
  if (answer?.already) showMessageAgent(answer.handle);
}

function showMessageAgent(handle) {
  if (ui.message) slot('closeMessage');
  slot('agentWinOpen', handle);
}

function messageAgentLine(source, key, { link, review } = {}) {
  const a = messageAgentOf(source, key);
  if (!a) return null;
  const done = a.status === 'done';
  const [label, words] = done ? ['Agent done', a.proposal.summary] : MESSAGE_AGENT_WORDS[a.status];
  const id = source + '-' + key;
  return el('div', { class: 'msg-agent', id: 'msg-agent-' + id },
    el('div', { class: 'msg-agent-head' },
      el('span', { class: 'pill ' + (done ? 's-done' : messageAgentLive(a) ? 's-working' : 's-need') }, icon('bot'), label),
      el('span', { class: 'msg-agent-what' }, words),
      a.listed ? el('button', { type: 'button', class: 'linkish', id: 'msg-agent-show-' + id, onclick: () => showMessageAgent(a.handle) }, 'Show the agent') : null,
      messageAgentLive(a) ? guarded('message-agent-stop:' + id, 'Stop', 'square', 'Stop the agent?', () => matrixAct('agent-stop', { handle: a.handle }, 'message-agent-stop:' + id)) : null),
    done && review ? el('div', { class: 'msg-agent-actions' }, el('button', { type: 'button', id: 'msg-agent-review-' + id, onclick: review }, icon('file-text'), 'Review its reply')) : null,
    done && !review ? messageAgentReply(id, a.proposal.reply, link) : null);
}

// There is no Gmail send here, so an email reply is shown to copy instead.
function messageAgentReply(id, reply, link) {
  const copy = async () => {
    if (await copyText(reply)) toast('Copied its reply');
    else toast('Could not copy its reply', true);
  };
  return el('div', { class: 'msg-agent-reply' },
    el('pre', { class: 'msg-agent-text', id: 'msg-agent-text-' + id }, reply),
    el('div', { class: 'msg-agent-actions' },
      el('button', { type: 'button', id: 'msg-agent-copy-' + id, onclick: copy }, icon('copy'), 'Copy'),
      link ? el('button', { type: 'button', id: 'msg-agent-open-' + id, title: 'Opens the thread in Gmail in your browser', onclick: () => openOutside(link) }, icon('external'), 'Open in Gmail') : null),
    el('p', { class: 'hint' }, 'Nothing is sent from here: paste it into your reply in Gmail.'));
}

// The box takes each new proposal once, and never over words you wrote yourself.
function messageAgentPrefill(m) {
  const p = messageAgentOf(m.src.name, m.key)?.proposal;
  if (!p || m.prefilled === p.at) return;
  const text = messageText(m);
  m.prefilled = p.at;
  if (text.trim() && text !== m.suggested) return;
  ui.drafts.set(messageDraftKey(m), p.reply);
  m.suggested = p.reply;
}

function messageAgentNote(m) {
  const a = messageAgentOf(m.src.name, m.key);
  if (a?.status !== 'done') return null;
  const theirs = messageText(m) === a.proposal.reply;
  const use = () => {
    ui.drafts.set(messageDraftKey(m), a.proposal.reply);
    m.suggested = a.proposal.reply;
    render(true);
  };
  return el('p', { class: 'meta mm-agent', id: 'mm-agent-note' }, 'Agent done: ' + a.proposal.summary + (theirs ? ' Its reply is in the box.' : ' '),
    theirs ? null : guarded(m.src.name + '-agent-use:' + m.key, 'Use its reply', 'bot', 'Replace your text with its reply?', use));
}
