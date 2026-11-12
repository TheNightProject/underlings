const CLAUDE_STORE = 'cc.claude.panel';
const CLAUDE_BUSY_MS = 700;
const CLAUDE_IDLE_MS = 4000;
const CLAUDE_MIN = { w: 320, h: 320 };
const CLAUDE_SIZE = { w: 440, h: 600 };
const CLAUDE_STATES = { working: 'working', waiting: 'asks you', blocked: 'needs approval', done: 'ready' };
const CLAUDE_TONES = { working: 's-working', waiting: 's-need', blocked: 's-need' };
const claudePanel = { open: false, place: {}, handle: null, chat: null, mark: '', loading: false, timer: null, sending: false, sent: null, error: null, history: false, termShown: false };

function claudeState() {
  return state?.claude ?? null;
}

function claudeAgent() {
  return claudeState()?.current ?? null;
}

// The conversation read last is newer than the page's list, so its state and ask win once it is for the same chat.
function claudeLive(a) {
  if (!a) return null;
  const chat = claudePanel.chat?.handle === a.handle ? claudePanel.chat : null;
  return chat ? { state: chat.state, since: chat.since, alive: chat.alive, ask: chat.pending } : { state: a.state, since: a.since, alive: a.alive, ask: a.ask };
}

function claudePanelShown() {
  return claudePanel.open && !claudeState()?.poppedOut && !slot('terminalWindowOnly') && !slot('meetingWindowOnly');
}

function claudeHasFocus(target) {
  return claudePanel.open && Boolean(target?.closest?.('#claude-panel'));
}

function claudeSavePlace() {
  floatSave(CLAUDE_STORE, { ...claudePanel.place, open: claudePanel.open });
}

function claudeFit(box) {
  floatFit(box, claudePanel.place, { min: CLAUDE_MIN, size: CLAUDE_SIZE });
}

function claudeHost() {
  const found = byId('claude-panel');
  if (found) return found;
  const box = el('textarea', { id: 'claude-box', rows: '2', 'aria-label': 'Message Claude', onkeydown: claudeKeydown, oninput: claudeGrow });
  const host = el('section', { id: 'claude-panel', class: 'cpanel float', role: 'dialog', 'aria-label': 'Claude', tabindex: '-1', hidden: true },
    el('header', { class: 'cp-head', onpointerdown: (e) => claudeDrag(e, 'move') },
      el('div', { class: 'cp-title' }, el('span', { class: 'cp-badge' }, icon('message')), el('b', {}, 'Claude'), el('span', { class: 'cp-state pill' })),
      el('div', { class: 'cp-tools' })),
    el('div', { class: 'cp-history', hidden: true }),
    el('div', { class: 'cp-body chat', tabindex: '0', 'aria-label': 'The conversation with Claude' }, el('div', { class: 'log' })),
    el('div', { class: 'cp-term', id: 'claude-term', 'aria-label': 'Claude Code' }),
    el('div', { class: 'cp-foot' },
      el('div', { class: 'cp-ask' }),
      el('div', { class: 'cp-error', role: 'alert', hidden: true }),
      el('div', { class: 'cp-compose' }, box, el('div', { class: 'cp-send' }))),
    el('div', { class: 'float-grip', 'aria-hidden': 'true', onpointerdown: (e) => claudeDrag(e, 'size') }));
  floatFrontOnUse(host);
  document.body.append(host);
  return host;
}

function claudeKeydown(e) {
  if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.isComposing) return;
  e.preventDefault();
  claudeSend();
}

function claudeGrow(e) {
  const box = e?.target ?? byId('claude-box');
  if (!box?.style) return;
  box.style.height = 'auto';
  box.style.height = Math.min(box.scrollHeight || 0, 180) + 'px';
  if (claudePanel.error) {
    claudePanel.error = null;
    claudePaint();
  }
}

function claudeDrag(e, how) {
  const host = byId('claude-panel');
  floatDrag(e, how, host, (rect, done) => {
    claudePanel.place = { ...claudePanel.place, ...rect };
    if (done) claudeSavePlace();
    else claudeFit(host);
  });
}

function openClaudePanel(here = false) {
  if (here && claudeState()) state.claude.poppedOut = false;
  if (claudeState()?.poppedOut) return claudePopOut();
  claudePanel.open = true;
  claudeSavePlace();
  claudePaint();
  claudeFocusBox();
  claudeKick();
  slot('beat');
}

function closeClaudePanel() {
  const had = byId('claude-panel')?.contains(document.activeElement);
  claudePanel.open = false;
  claudePanel.history = false;
  claudeSavePlace();
  claudePaint();
  if (had) slot('layerHome')?.focus({ preventScroll: true });
  slot('beat');
}

function claudeFocusBox() {
  if (slot('claudeCodeHere')) return slot('claudeCodeFocus');
  byId('claude-box')?.focus({ preventScroll: true });
}

function askClaude() {
  if (!claudePanelShown() && !claudeState()?.poppedOut) return openClaudePanel();
  if (claudeState()?.poppedOut) return claudePopOut();
  if (byId('claude-panel')?.contains(document.activeElement)) return closeClaudePanel();
  claudeFocusBox();
}

async function claudeCall(path, payload, then) {
  try {
    const answer = await api(path, payload);
    then?.(answer);
    if (answer?.text) toast(answer.text);
  } catch (e) {
    toast(e.message, true);
  } finally {
    refresh();
  }
}

function claudeNewChat() {
  claudePanel.history = false;
  return claudeCall('/api/claude/new', {}, () => {
    claudeReset(null);
    if (!claudePanelShown()) openClaudePanel();
    else claudeFocusBox();
  });
}

function claudeOpenChat(handle) {
  claudePanel.history = false;
  return claudeCall('/api/claude/open', { handle }, () => claudeReset(handle));
}

function claudePopOut() {
  return claudeCall('/api/claude/popout', {}, () => {
    claudePanel.open = false;
    claudeSavePlace();
    claudePaint();
  });
}

function claudeReset(handle) {
  claudePanel.sent = null;
  claudeSwitch(handle);
}

// Following the page's list keeps what was just sent, since the list may not have the chat it started yet.
function claudeSwitch(handle) {
  claudePanel.handle = handle;
  claudePanel.chat = null;
  claudePanel.mark = '';
  claudeKick();
}

// What it saw is sent with it, so a message never answers an ask the panel had not shown yet.
async function claudeSend() {
  const box = byId('claude-box');
  const text = String(box?.value ?? '').trim();
  if (!text || claudePanel.sending) return;
  const a = claudeAgent();
  claudePanel.sending = true;
  claudePanel.error = null;
  claudePaint();
  try {
    const answer = await api('/api/claude/send', { text, expect: { handle: a?.handle ?? null, pending: claudeLive(a)?.ask?.id ?? null } });
    if (box.value.trim() === text) box.value = '';
    claudeGrow({ target: box });
    claudePanel.sent = { text };
  } catch (e) {
    claudePanel.error = e.status === 409 ? 'Nothing was sent: ' + e.message + '. Read what Claude says now, then send it again.' : e.message;
  } finally {
    claudePanel.sending = false;
    claudePaint();
    claudeKick();
    refresh();
  }
}

function claudeKick() {
  clearTimeout(claudePanel.timer);
  claudePanel.timer = setTimeout(claudeTick, 0);
}

async function claudeTick() {
  claudePanel.timer = null;
  const handle = claudeAgent()?.handle;
  if (!claudePanelShown() || !handle) return;
  if (document.visibilityState !== 'hidden') await claudeLoad(handle);
  const busy = claudePanel.chat?.alive || claudeLive(claudeAgent())?.state === 'working';
  if (!claudePanel.timer) claudePanel.timer = setTimeout(claudeTick, busy ? CLAUDE_BUSY_MS : CLAUDE_IDLE_MS);
}

async function claudeLoad(handle) {
  if (claudePanel.loading) return;
  claudePanel.loading = true;
  try {
    const chat = await api('/api/agents/conversation?' + new URLSearchParams({ handle }));
    if (handle === claudeAgent()?.handle) {
      claudePanel.chat = chat;
      claudePanel.readError = null;
    }
  } catch (e) {
    claudePanel.readError = e.message;
  } finally {
    claudePanel.loading = false;
  }
  const c = claudePanel.chat;
  const mark = c ? [c.handle, c.entries.length, c.entries.at(-1)?.at, c.partial?.length ?? 0, c.state, c.alive, c.pending?.id].join(':') : claudePanel.readError ?? '';
  if (mark === claudePanel.mark) return;
  claudePanel.mark = mark;
  claudePaint();
}

function renderClaudePanel() {
  claudeRail();
  claudePaint();
}

function claudePaint() {
  const host = claudeHost();
  const shown = claudePanelShown();
  const terminal = Boolean(slot('claudeCodeHere'));
  host.hidden = !shown;
  host.classList.toggle('terminal', terminal);
  if (!shown) {
    claudePanel.termShown = false;
    return;
  }
  claudeFit(host);
  if (terminal) return claudePaintTerminal(host);
  const a = claudeAgent();
  if ((a?.handle ?? null) !== claudePanel.handle) claudeSwitch(a?.handle ?? null);
  const live = claudeLive(a);
  const pill = host.querySelector('.cp-state');
  pill.textContent = live ? CLAUDE_STATES[live.state] ?? live.state : 'new chat';
  pill.className = 'cp-state pill ' + (CLAUDE_TONES[live?.state] ?? 's-done');
  host.querySelector('.cp-tools').replaceChildren(...claudeTools(a, live));
  claudePaintHistory(host.querySelector('.cp-history'));
  claudePaintLog(host.querySelector('.cp-body .log'), a);
  claudePaintFoot(host, a, live);
}

// Claude Code draws itself, so the panel only says when it asks, and attaches its terminal each time it comes into view.
function claudePaintTerminal(host) {
  const pill = host.querySelector('.cp-state');
  const asking = Boolean(state?.claudeCode?.asking);
  pill.textContent = asking ? 'asks you' : 'Claude Code';
  pill.className = 'cp-state pill ' + (asking ? 's-need' : 's-done');
  host.querySelector('.cp-tools').replaceChildren(...claudeTerminalTools());
  if (!claudePanel.termShown) slot('claudeCodeShow', byId('claude-term'));
  claudePanel.termShown = true;
}

function claudeTerminalTools() {
  const tool = (label, iconName, onclick) => el('button', { type: 'button', class: 'icon-only', title: label, 'aria-label': label, onclick }, icon(iconName));
  return [
    guarded('claude-code-new', 'New session', 'plus', 'Start a new session?', () => busyAct('/api/claude/terminal/new', {}, 'claude-code-new')),
    claudeState()?.canPopOut ? tool('Pop out into the Claude Code window', 'external', claudePopOut) : null,
    tool('Close', 'x', closeClaudePanel),
  ].filter(Boolean);
}

function claudePaintFoot(host, a, live) {
  host.querySelector('.cp-ask').replaceChildren(...[a && live?.ask ? slot('agentAskShown', { ...a, name: 'Claude' }, live) : null].filter(Boolean));
  const error = host.querySelector('.cp-error');
  error.hidden = !claudePanel.error;
  error.textContent = claudePanel.error ?? '';
  const box = byId('claude-box');
  box.setAttribute('placeholder', claudePlaceholder(live));
  box.disabled = !claudeState()?.available;
  host.querySelector('.cp-send').replaceChildren(...claudeSendButtons(a, live));
}

function claudePlaceholder(live) {
  if (!claudeState()) return 'Reload ' + APP_NAME + ' to talk to Claude';
  if (!claudeState().available) return 'The review engine needs rebuilding before Claude can start';
  if (live?.ask?.questions) return 'Or type your own answer';
  if (live?.ask) return 'Or say what it should do instead, which denies it';
  return live ? 'Message Claude. Enter sends, Shift+Enter is a new line' : 'Ask Claude anything. Enter sends, Shift+Enter is a new line';
}

function claudeTools(a, live) {
  const pop = claudeState()?.canPopOut;
  const tool = (label, iconName, onclick, extra = {}) => el('button', { type: 'button', class: 'icon-only', title: label, 'aria-label': label, onclick, ...extra }, icon(iconName));
  return [
    tool(claudePanel.history ? 'Hide earlier chats' : 'Earlier chats', 'clock', () => { claudePanel.history = !claudePanel.history; claudePaint(); }, { 'aria-expanded': String(claudePanel.history), disabled: !claudeState()?.history?.length }),
    tool('New chat', 'plus', claudeNewChat, { disabled: !a }),
    a ? claudeTerminalButton(a, live) : null,
    pop ? tool('Pop out into a window of its own', 'external', claudePopOut) : null,
    tool('Close (Esc)', 'x', closeClaudePanel),
  ].filter(Boolean);
}

// Two processes on one session would both write to it, so a running chat is stopped here first, and that takes a second click.
function claudeTerminalButton(a, live) {
  const id = 'claude-terminal:' + a.handle;
  const run = () => matrixAct('agent-terminal', { handle: a.handle }, id);
  if (live?.alive) return guarded(id, 'Terminal', 'terminal', 'Stop it and open in Terminal?', run);
  return el('button', { type: 'button', class: 'icon-only', title: 'Open in Terminal, with the full Claude Code interface', 'aria-label': 'Open in Terminal', disabled: ui.busy.has(id), onclick: run }, icon('terminal'));
}

function claudeSendButtons(a, live) {
  const stopId = 'claude-stop';
  return [
    live?.alive ? el('button', { type: 'button', title: 'Stop what Claude is doing', disabled: ui.busy.has(stopId), onclick: () => matrixAct('agent-stop', { handle: a.handle }, stopId) }, icon('square'), 'Stop') : null,
    el('button', { type: 'button', class: 'primary', title: 'Send (Enter)', disabled: claudePanel.sending || !claudeState()?.available, onclick: claudeSend }, icon('send'), claudePanel.sending ? 'Sending…' : 'Send'),
  ].filter(Boolean);
}

function claudePaintHistory(node) {
  const history = claudeState()?.history ?? [];
  node.hidden = !claudePanel.history || !history.length;
  if (node.hidden) return node.replaceChildren();
  node.replaceChildren(el('h3', {}, 'Earlier chats'), el('ul', {}, history.map((h) => el('li', {},
    el('button', { type: 'button', class: 'cp-old', title: 'Go back to this chat', onclick: () => claudeOpenChat(h.handle) },
      el('span', { class: 'cp-old-title' }, h.title || 'Untitled chat'),
      el('span', { class: 'meta' }, [CLAUDE_STATES[h.state] ?? h.state, h.lastAt ? ago(h.lastAt) : ''].filter(Boolean).join(' · ')))))));
}

// Repainted only when the conversation moved, so a selection or a folded run survives the reads in between.
function claudePaintLog(log, a) {
  const chat = claudePanel.chat?.handle === a?.handle ? claudePanel.chat : null;
  const sent = claudePanel.sent;
  const echoed = sent && chat?.entries.some((e) => e.kind === 'you' && e.text === sent.text);
  if (echoed) claudePanel.sent = null;
  const mark = [claudePanel.mark, a?.handle, claudePanel.sent?.text, claudePanel.readError, claudeState()?.tools].join('|');
  if (log.dataset.mark === mark) return;
  log.dataset.mark = mark;
  const waiting = claudePanel.sent && !echoed ? el('div', { class: 'you sending' }, el('span', { class: 'who' }, 'You'), claudePanel.sent.text) : null;
  if (!a && !waiting) return log.replaceChildren(claudeEmpty());
  log.replaceChildren(...[
    claudePanel.readError ? el('div', { class: 'note' }, 'Could not read the chat: ' + claudePanel.readError) : null,
    ...(chat ? slot('agentChatLog', chat.entries.filter((e) => !(e.kind === 'asked' && e.id === chat.pending?.id)), 'claude:' + a.handle, chat.partial) ?? [] : [a ? el('div', { class: 'note' }, 'Reading the chat…') : null]),
    waiting,
  ].filter(Boolean));
}

function claudeEmpty() {
  const s = claudeState();
  return el('div', { class: 'cp-empty' },
    el('p', {}, el('b', {}, 'Ask Claude anything.')),
    el('p', {}, 'It works in ' + (s?.cwd ?? 'your workspace root') + ', with that folder\'s CLAUDE.md, skills and memory, and it can read ' + APP_NAME + ': what needs you, MRs, the review queue, agents, tickets, standup and QA.'),
    el('p', {}, 'It can also start reviews, fixes and kickoffs, answer agents, queue, post or discard findings, merge and move tickets, and every one of those asks you here first.'),
    s && !s.tools ? el('p', { class: 'hint bad' }, 'Its ' + APP_NAME + ' tools need the worker restarted once.') : null);
}

function claudeRail() {
  const jump = byId('jump');
  let button = byId('ask-claude');
  if (!button && jump) {
    button = el('button', { type: 'button', id: 'ask-claude', class: 'jump ask-claude', title: 'Ask Claude, which can read and act on ' + APP_NAME, onclick: () => askClaude() },
      icon('message'), el('span', { class: 'jump-label' }, 'Ask Claude'), el('span', { class: 'cp-dot', hidden: true }), el('span', { class: 'caps' }, el('kbd', {}, 'c')));
    jump.after(button);
  }
  if (!button) return;
  const code = slot('claudeCodeHere');
  const live = claudeLive(claudeAgent());
  const dot = button.querySelector('.cp-dot');
  const tone = code ? (state.claudeCode.asking ? 'hot' : '') : { 's-working': 'busy', 's-need': 'hot' }[CLAUDE_TONES[live?.state]] ?? '';
  button.setAttribute('title', code ? 'Claude Code, which can read and act on ' + APP_NAME : 'Ask Claude, which can read and act on ' + APP_NAME);
  dot.hidden = !tone;
  dot.className = 'cp-dot ' + tone;
  button.setAttribute('aria-pressed', String(claudePanelShown()));
}

function claudeNeedsCard(i) {
  const a = claudeAgent();
  const live = a?.handle === i.handle ? claudeLive(a) : null;
  return el('div', { class: 'agent s-need', 'data-handle': i.handle },
    el('span', { class: 'avatar', title: 'Claude' }, icon('message')),
    el('div', { class: 'row-head' }, el('span', { class: 'pill s-need' }, live?.state === 'waiting' ? 'asks you' : 'needs approval'), el('span', { class: 'title' }, 'Claude'), el('span', { class: 'meta' }, a?.title ?? '')),
    live?.ask ? slot('agentAskShown', { ...a, name: 'Claude' }, live) : el('div', { class: 'text' }, 'Claude ' + i.why),
    el('div', { class: 'actions' }, el('button', { type: 'button', 'data-primary': true, onclick: openClaudePanel }, icon('message'), 'Open the Claude panel')));
}

function claudeStart() {
  const kept = floatLoad(CLAUDE_STORE);
  claudePanel.place = { x: kept.x, y: kept.y, w: kept.w, h: kept.h };
  claudePanel.open = Boolean(kept.open);
  claudeHost();
  claudeRail();
  addEventListener('resize', () => claudeFit(byId('claude-panel')));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && claudePanelShown()) claudeKick(); });
}

claudeStart();

function claudeAccountBox() {
  ui.claudeAccount ??= { data: null, error: null, loading: false, at: null };
  return ui.claudeAccount;
}

function claudeSettingsGroup() {
  const box = claudeAccountBox();
  if (box.at !== state.generatedAt && !box.loading) loadClaudeAccount(box);
  const s = box.data;
  const label = (a) => a.number + ': ' + a.email + (a.org && a.org !== a.email ? ' (' + a.org + ')' : '');
  return el('section', { class: 'section settings-group', id: 'claude-settings' }, el('h2', {}, 'Claude'),
    box.error ? banner('Could not read the Claude account: ' + box.error, true) : null,
    el('div', { class: 'setting' }, el('label', { for: 'claude-account' }, 'Account'),
      el('div', { class: 'control' },
        el('select', { id: 'claude-account', disabled: !s || !s.cswap, onchange: (e) => saveClaudeAccount(e.target.value) },
          el('option', { value: '', selected: !s?.account }, 'The default login'),
          (s?.accounts ?? []).map((a) => el('option', { value: a.number, selected: s.account === a.number }, label(a))))),
      el('p', { class: 'hint' }, s && !s.cswap
        ? 'cswap is not on the PATH, so Claude Code uses the default login.'
        : 'The cswap account the app\'s Claude Code window runs as. It applies from Claude Code\'s next start, so New session switches now.')));
}

async function loadClaudeAccount(box) {
  Object.assign(box, { loading: true, at: state.generatedAt });
  try {
    box.data = await api('/api/claude/account');
    box.error = null;
  } catch (e) {
    box.error = e.message;
  }
  box.loading = false;
  render(true);
}

async function saveClaudeAccount(account) {
  const answer = await busyAct('/api/claude/account', { account }, 'claude-account');
  if (answer) Object.assign(claudeAccountBox(), { data: answer });
  render(true);
}
