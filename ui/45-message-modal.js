// A source names its routes and words, so another inbox can open the same modal on its own messages.
let messageSeq = 0;

function openMessage(src, item) {
  ui.armed = null;
  ui.message = { src, key: item.key, item, conv: null, error: null, loading: false, suggesting: false, suggestError: null, suggested: null, sendError: null, sent: null, back: document.activeElement };
  render();
  document.querySelector('#message-modal .mm')?.focus({ preventScroll: true });
  loadMessageConversation(false);
}

function closeMessage() {
  const m = ui.message;
  if (ui.armed?.startsWith(m.src.name + '-')) ui.armed = null;
  ui.message = null;
  render();
  const opener = document.getElementById(m.src.opener(m.key));
  (opener ?? (m.back?.isConnected ? m.back : document.getElementById('main'))).focus({ preventScroll: true });
}

const messageDraftKey = (m) => m.src.name + '-reply:' + m.key;
const messageText = (m) => ui.drafts.get(messageDraftKey(m)) ?? '';

// Only the latest read may land, so Read again never shows an older answer over a newer one.
async function loadMessageConversation(fresh) {
  const m = ui.message;
  const seq = ++messageSeq;
  Object.assign(m, { loading: true, error: null });
  render(true);
  try {
    const conv = await api(m.src.path + '/conversation', { key: m.key, fresh });
    if (seq === messageSeq) Object.assign(m, { conv, error: null });
  } catch (e) {
    if (seq === messageSeq) m.error = e.message;
  }
  if (seq !== messageSeq || ui.message !== m) return;
  m.loading = false;
  render(true);
  if (m.conv && !fresh) document.querySelector('#message-modal .mm-msg.is-item')?.scrollIntoView({ block: 'center' });
}

async function suggestMessageReply(m) {
  Object.assign(m, { suggesting: true, suggestError: null });
  render(true);
  try {
    const answer = await api(m.src.path + '/suggest', { key: m.key });
    if (ui.message !== m) return;
    ui.drafts.set(messageDraftKey(m), answer.reply);
    m.suggested = answer.reply;
  } catch (e) {
    m.suggestError = e.message;
  }
  m.suggesting = false;
  render(true);
  if (ui.message === m && !m.suggestError) document.getElementById('mm-reply-text')?.focus({ preventScroll: true });
}

async function sendMessageReply(m, busyId) {
  ui.busy.add(busyId);
  Object.assign(m, { sendError: null, sent: null });
  render(true);
  try {
    const answer = await api(m.src.path + '/send', { key: m.key, ts: m.conv.ts, signature: m.conv.reply.signature, text: messageText(m) });
    ui.drafts.delete(messageDraftKey(m));
    Object.assign(m, { sent: answer, suggested: null });
    toast(answer.text);
    m.src.sent?.();
  } catch (e) {
    m.sendError = e.message;
  } finally {
    ui.busy.delete(busyId);
    render(true);
    refresh();
  }
}

function renderMessageModal() {
  const m = ui.message;
  let host = document.getElementById('message-modal');
  if (!m) {
    if (host) host.hidden = true;
    host?.replaceChildren();
    return;
  }
  host ??= messageHost();
  slot('messageAgentPrefill', m);
  const had = host.contains(document.activeElement);
  const scroll = host.dataset.key === m.key ? host.querySelector('.mm-body')?.scrollTop ?? 0 : 0;
  host.dataset.key = m.key;
  host.hidden = false;
  host.replaceChildren(messageModal(m, m.src.item(m.key) ?? m.item));
  host.querySelector('.mm-body').scrollTop = scroll;
  if (had && !host.contains(document.activeElement)) host.querySelector('.mm').focus({ preventScroll: true });
}

function messageHost() {
  const host = el('div', { id: 'message-modal', class: 'kb-backdrop mm-backdrop', onpointerdown: (e) => { if (e.target === host) closeMessage(); } });
  document.body.append(host);
  return host;
}

function messageModal(m, item) {
  return el('div', { class: 'mm', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mm-title', tabindex: '-1' },
    el('div', { class: 'mm-head' },
      el('div', { class: 'mm-title' }, el('h2', { id: 'mm-title' }, m.src.title(item)), el('p', { class: 'meta', id: 'mm-meta' }, messageMeta(m))),
      el('div', { class: 'actions' },
        el('button', { type: 'button', id: 'mm-again', disabled: m.loading, title: 'Read the conversation from ' + m.src.service + ' again now', onclick: () => loadMessageConversation(true) }, icon(m.loading ? 'clock' : 'refresh'), m.loading ? 'Reading…' : 'Read again'),
        el('button', { type: 'button', id: 'mm-open', title: 'Opens the message in ' + m.src.service + ' in your browser', onclick: () => openOutside(item.link) }, icon('external'), 'Open in ' + m.src.service),
        el('button', { type: 'button', id: 'mm-close', class: 'icon-only', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeMessage }, icon('x')))),
    el('div', { class: 'mm-body' }, messageConversation(m, item)),
    messageReply(m, item));
}

function messageMeta(m) {
  if (!m.conv) return m.loading ? 'Claude Code is reading the conversation…' : '';
  const took = m.conv.cached ? 'kept from ' + ago(m.conv.readAt) : 'read ' + ago(m.conv.readAt) + (m.conv.ms ? ' in ' + Math.max(1, Math.round(m.conv.ms / 1000)) + ' s' : '');
  return plural(m.conv.messages.length, 'message') + ', ' + took;
}

function messageConversation(m, item) {
  if (m.error && !m.conv) return [banner('Could not read the conversation: ' + m.error + '.', true, ' ', button('Try again', 'rotate-ccw', () => loadMessageConversation(true)))];
  if (!m.conv) return el('p', { class: 'empty', role: 'status' }, icon('clock'), 'Reading the conversation…');
  return [
    m.error ? banner('Could not read it again, so this is the last read: ' + m.error + '.', true) : null,
    m.conv.messages.length ? el('ol', { class: 'mm-msgs' }, m.conv.messages.map((msg) => messageEntry(m, msg, item))) : empty(m.src.service + ' returned no messages here.'),
    m.conv.more ? el('p', { class: 'hint' }, 'This is only the start of a long thread. Open it in ' + m.src.service + ' for the rest.') : null,
  ];
}

function messageEntry(m, msg, item) {
  const own = msg.ts === item.ts;
  const when = whenText(msg.at);
  return el('li', { class: 'mm-msg' + (own ? ' is-item' : '') + (msg.mine ? ' mine' : ''), 'aria-current': own ? 'true' : null },
    el('div', { class: 'mm-from' }, el('b', {}, msg.mine ? 'You' : msg.from.name), el('span', { class: 'meta', title: when }, ago(msg.at)), own ? el('span', { class: 'pill s-need' }, 'This message') : null),
    markdown(msg.text),
    own ? el('div', { class: 'actions' }, el('button', { type: 'button', id: 'mm-open-item', title: 'Opens this message in ' + m.src.service + ' in your browser', onclick: () => openOutside(item.link) }, icon('external'), 'Open in ' + m.src.service)) : null);
}

const messageSendId = (m) => m.src.name + '-send:' + m.key;

function messageReply(m, item) {
  const reply = m.conv?.reply;
  const text = messageText(m);
  return el('section', { class: 'mm-reply', 'aria-label': 'Your reply' },
    el('div', { class: 'mm-reply-head' }, el('label', { for: 'mm-reply-text' }, 'Your reply'), el('span', { class: 'meta', id: 'mm-where' }, reply ? 'To ' + reply.where : 'Where it goes shows once the conversation is read')),
    m.sent ? messageSent(m) : null,
    messageBox(m, reply, text),
    messageNotes(m, reply),
    el('div', { class: 'actions' }, messageSendButton(m, reply, text), messageSuggestButton(m, reply, text), slot('messageAgentButton', m.src.name, m.key, 'mm-agent'), messageHandoff(m, item)));
}

function messageBox(m, reply, text) {
  const sendId = messageSendId(m);
  const typed = (e) => {
    ui.drafts.set(messageDraftKey(m), e.target.value);
    if (ui.armed === sendId) return disarmMessageSend();
    document.getElementById('g-' + sendId).disabled = ui.busy.has(sendId) || !reply || !e.target.value.trim();
  };
  return el('textarea', { id: 'mm-reply-text', rows: 4, maxlength: 5000, readonly: ui.busy.has(sendId) || m.suggesting, spellcheck: 'true', placeholder: 'Write your reply, or ask Claude to suggest one. It goes exactly as written here.', oninput: typed }, text);
}

function messageNotes(m, reply) {
  return [
    slot('messageAgentNote', m),
    el('p', { class: 'meta mm-sig', id: 'mm-sig' }, !reply ? null : reply.signature ? ['Ends with ', el('em', {}, reply.signature), ' on a line of its own.'] : m.src.unsigned),
    m.sendError ? el('p', { class: 'meta bad', role: 'alert', id: 'mm-send-error' }, 'Not sent: ' + m.sendError + '. Your text is still here.') : null,
    m.suggestError ? el('p', { class: 'meta bad', role: 'alert', id: 'mm-suggest-error' }, 'No suggestion: ' + m.suggestError + '.') : null,
  ];
}

function messageSendButton(m, reply, text) {
  const sendId = messageSendId(m);
  const send = guarded(sendId, 'Send', 'send', 'Send to ' + (reply?.where ?? m.src.service) + '?', () => sendMessageReply(m, sendId), true);
  send.disabled = ui.busy.has(sendId) || !reply || !text.trim();
  return send;
}

function messageHandoff(m, item) {
  if (!m.src.handoff) return null;
  return el('button', { type: 'button', id: 'mm-handoff', title: m.src.handoff.title, onclick: () => { closeMessage(); m.src.handoff.run(item); } }, icon('message'), m.src.handoff.label);
}

function disarmMessageSend() {
  ui.armed = null;
  render(true);
}

// A suggestion over words you wrote yourself would lose them, so then it takes a second click.
function messageSuggestButton(m, reply, text) {
  const model = reply?.model && reply.model !== 'default' ? ' (' + slot('modelWords', reply.model) + ')' : '';
  const label = m.suggesting ? 'Claude is writing…' : (m.suggested ? 'Suggest another' : 'Suggest a reply') + model;
  if (text.trim() && text !== m.suggested && !m.suggesting) return guarded(m.src.name + '-suggest:' + m.key, label, 'sparkles', 'Replace your text with a suggestion?', () => suggestMessageReply(m));
  return el('button', { type: 'button', id: 'mm-suggest', disabled: m.suggesting, title: 'Claude reads the conversation and writes a reply for you to edit. Nothing is sent.', onclick: () => suggestMessageReply(m) }, icon(m.suggesting ? 'clock' : 'sparkles'), label);
}

function messageSent(m) {
  return el('div', { class: 'banner mm-sent', role: 'status' }, icon('check-circle'),
    el('div', {}, m.sent.text + '.', m.sent.link ? [' ', el('button', { type: 'button', id: 'mm-sent-link', onclick: () => openOutside(m.sent.link) }, icon('external'), 'Open the sent message')] : null));
}
