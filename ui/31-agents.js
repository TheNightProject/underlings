const AGENT_LAYOUT_KEY = 'cc.agentLayout';

function viewAgents(d) {
  const wanted = agentLayout() === 'office';
  const scene = wanted ? slot('officeView', d) : null;
  const sub = plural(d.agents.length, 'Claude Code agent') + (scene ? ': ' + slot('officeSummary', d.agents) : ', reviewing, fixing and starting tickets.');
  return [
    header('Agents', sub, agentLayoutSwitch(), scene ? null : agentFilters(), button('Clean up', 'eraser', scanCleanup)),
    ui.cleanup ? cleanupSection(ui.cleanup) : null,
    wanted && !scene ? banner(slot('officeUnavailable') ?? 'The office did not load, so here is the list.', true) : null,
    scene ?? agentList(d),
  ];
}

function agentFilters() {
  return [
    chips([['active', 'Active'], ['needs', 'Needs you'], ['working', 'Working'], ['done', 'Done'], ['all', 'All']], ui.agentFilter, (v) => { ui.agentFilter = v; render(); }),
    searchBox('agent-q', 'Search agents, their work and what they said', ui.agentSearch, (v) => { ui.agentSearch = v; render(true); }),
  ];
}

function agentList(d) {
  const q = ui.agentSearch.toLowerCase();
  const keep = (a) => (ui.agentFilter === 'all' || (ui.agentFilter === 'active' ? a.state !== 'done' || isNeed(a) : ui.agentFilter === 'needs' ? isNeed(a) : a.state === ui.agentFilter))
    && (!q || [a.name, a.title, a.mr, a.ticket, a.said].join(' ').toLowerCase().includes(q));
  const rank = (a) => (isNeed(a) ? 0 : a.state === 'working' ? 1 : 2);
  const shown = d.agents.filter(keep).sort((a, b) => rank(a) - rank(b) || (b.lastAt || 0) - (a.lastAt || 0));
  return shown.length ? el('div', { class: 'list' }, shown.map((a) => agentRow(a))) : empty(d.agents.length ? 'No agent matches.' : 'No agent is recorded. Reviews, fixes and ticket starts each run one.');
}

function agentLayout() {
  if (!ui.agentLayout) {
    try { ui.agentLayout = localStorage.getItem(AGENT_LAYOUT_KEY) === 'office' ? 'office' : 'list'; } catch { ui.agentLayout = 'list'; }
  }
  return ui.agentLayout;
}

function agentSetLayout(layout) {
  ui.agentLayout = layout;
  try { localStorage.setItem(AGENT_LAYOUT_KEY, layout); } catch {}
  render(true);
}

function agentLayoutSwitch() {
  const node = chips([['list', 'List'], ['office', 'Office']], agentLayout(), agentSetLayout, 'agent-layout-');
  node.setAttribute('aria-label', 'Show as');
  return node;
}

const AGENT_LABELS = { working: 'working', done: 'done', blocked: 'needs approval', waiting: 'needs an answer' };
const AGENT_SCREEN_MS = 2000;
const AGENT_MAX_SCREENS = 3;
const AGENT_OPTION_SHOWN = 44;
let agentScreenLoop = null;

function agentLabel(a) {
  return a.state === 'done' && isNeed(a) ? 'asks you' : AGENT_LABELS[a.state] ?? 'needs you';
}

const AGENT_PHASES = { exploring: 'Exploring', planning: 'Planning', building: 'Building', testing: 'Testing', mr: 'Raising MR', waiting: 'Waiting on you', done: 'Done', stopped: 'Stopped' };

// An engine from before phases sends none, so its state stands in.
function agentPhase(a) {
  if (isNeed(a)) return AGENT_PHASES.waiting;
  if (a.phase === 'builders' && a.background?.length) return plural(a.background.length, 'builder') + ' running';
  if (AGENT_PHASES[a.phase]) return AGENT_PHASES[a.phase];
  if (a.state === 'working') return 'Working';
  return a.outcome === 'stopped' ? AGENT_PHASES.stopped : AGENT_PHASES.done;
}

// The pill beside it already says when an agent needs you or is done.
function agentPhaseBeside(a) {
  const phase = agentPhase(a);
  return isNeed(a) || phase.toLowerCase() === agentLabel(a) ? null : phase;
}

function agentPhaseShown(a) {
  const phase = agentPhaseBeside(a);
  return phase ? el('span', { class: 'agent-phase' }, phase) : null;
}

// The ask sits on the row, so a question is answered without opening the conversation, and pinned rows show the conversation whole.
function agentRow(a, { pinned = false } = {}) {
  const text = a.title || firstLine(a.said);
  return el('div', { class: 'agent ' + agentClass(a), 'data-handle': a.handle },
    el('span', { class: 'avatar', title: (a.kind ?? 'Claude Code') + ' agent' }, icon(a.state === 'working' ? 'bot' : isNeed(a) ? 'bell' : 'check')),
    el('div', { class: 'row-head' },
      el('span', { class: 'pill ' + agentClass(a) }, agentLabel(a)),
      agentPhaseShown(a),
      el('span', { class: 'title' }, a.name),
      agentWorksFor(a),
      slot('modelAgentLine', a),
      a.lastAt ? el('span', { class: 'meta' }, ago(a.lastAt)) : null),
    text && text !== a.name ? el('div', { class: 'text clamp', title: text }, text) : null,
    agentBackground(a),
    agentConsole(a, pinned));
}

// The agent window reads this as well as the list, so the mood is said wherever an agent is shown.
function agentBackground(a) {
  const tasks = a.background ?? [];
  return [slot('agentMoodLine', a), tasks.length ? el('div', { class: 'meta agent-background' }, icon('clock'), 'In the background: ' + tasks.join(', ')) : null];
}

function agentConsole(a, pinned = false) {
  const open = pinned || ui.open.has('agent:' + a.handle);
  const live = agentLive(a, open);
  return [agentAskShown(a, live), agentActions(a, live, { pinned, open }), open ? agentChat(a, live) : null];
}

// Focusing an agent is opening the drawer of what it works for, at its Agent tab unless the agent is already in view.
function agentWorksFor(a, tab = 'agent') {
  if (a.mr) return [mrRef(a.mr, short(a.mr), tab), agentRaised(a, tab)];
  if (a.ticket) return [el('button', { type: 'button', class: 'ticket-ref', 'data-ticket': a.ticket, title: 'Open ' + a.ticket + ' here', onclick: () => slot('openTicket', a.ticket, tab) }, a.ticket), agentRaised(a, tab)];
  return agentRaised(a, tab);
}

// A pull request on GitHub has no drawer here, so it is only named.
function agentRaised(a, tab) {
  if (!a.raisedMr || a.raisedMr === a.mr) return null;
  return GITLAB_KEY.test(a.raisedMr) ? mrRef(a.raisedMr, short(a.raisedMr), tab) : el('span', { class: 'meta' }, short(a.raisedMr));
}

// What the conversation last read is newer than the page's list, but only while it is open and being read again.
function agentLive(a, open) {
  const chat = open ? ui.screens.get(a.handle)?.chat : null;
  return chat ? { state: chat.state, since: chat.since, alive: chat.alive, ask: chat.pending } : { state: a.state, since: a.since, alive: a.alive, ask: a.ask };
}

function agentAskShown(a, live) {
  const { ask } = live;
  if (!ask) return null;
  const what = ask.questions ? ask.questions.map((q) => q.question).join(' ') : agentAskWords(ask);
  return el('div', { class: 'ask' }, el('p', { class: 'asked' }, icon('bell'), what), agentAsk(a, live), agentAskInput(ask));
}

const agentToolTitle = (tool) => state?.claude?.titles?.[tool] ?? null;

function agentToolName(tool) {
  return agentToolTitle(tool) ?? String(tool).replace(/^mcp__.+?__/, '');
}

function agentAskWords(ask) {
  const title = agentToolTitle(ask.tool);
  return (title ? 'Asks to ' + title.charAt(0).toLowerCase() + title.slice(1) : 'Asks to use ' + ask.tool) + ': ' + ask.summary;
}

// A write through the app's own tools is approved on exactly what it will send, so that is open from the start.
function agentAskInput(ask) {
  if (!ask.input || ask.input === '{}') return null;
  return el('details', { class: 'ask-input', open: Boolean(agentToolTitle(ask.tool)) }, el('summary', {}, 'What it will send'), el('pre', {}, ask.input));
}

function agentAskOnly(a) {
  return agentAskShown(a, agentLive(a, false));
}

function agentActions(a, live, { pinned, open }) {
  const { alive, state, since } = live;
  const id = (what) => agentKeyId(a, what);
  const toTerminal = () => agentAct('agent-terminal', { handle: a.handle }, id('terminal'));
  return el('div', { class: 'actions' },
    pinned ? null : el('button', { id: 'agent-open-' + a.handle, title: 'Open it in a window, with its whole conversation', onclick: () => slot('agentWinOpen', a.handle) }, icon('open'), 'Open'),
    pinned ? null : el('button', { class: 'disclose quiet', 'aria-expanded': String(open), title: open ? 'Hide the conversation' : 'Show what it has said and done', onclick: () => agentToggleScreen('agent:' + a.handle) }, icon('chevron'), icon('message'), 'Conversation'),
    alive ? guarded(id('stop'), 'Stop', 'square', 'Stop ' + a.name + '?', () => agentAct('agent-stop', { handle: a.handle }, id('stop'))) : null,
    alive
      ? guarded(id('terminal'), 'Open in Terminal', 'terminal', 'Stop it here and open it in Terminal?', toTerminal)
      : el('button', { title: 'Open its session in a Terminal window, with the full Claude Code interface', disabled: ui.busy.has(id('terminal')), onclick: toTerminal }, icon('terminal'), 'Open in Terminal'),
    alive ? null : guarded(id('remove'), 'Remove', 'trash', a.worktree ? 'Remove ' + a.name + ' and its worktree?' : 'Remove ' + a.name + '?', () => agentAct('agent-remove', { handle: a.handle, expect: { state, since } }, id('remove'))));
}

function agentChat(a, live) {
  agentWatchScreens();
  const s = ui.screens.get(a.handle);
  const chat = s?.chat;
  return el('div', { class: 'screen' },
    s?.error ? banner('Could not read the conversation: ' + s.error, true) : null,
    el('div', { class: 'console chat', id: 'chat-' + a.handle, 'data-handle': a.handle, tabindex: '0', 'aria-label': 'The conversation with ' + a.name },
      el('div', { class: 'log' }, !chat ? 'Reading the conversation…' : chat.entries.length ? agentChatLog(chat.entries, 'agent:' + a.handle) : 'Nothing has been said yet.')),
    agentReplyForm(a, live, agentChatPrompt(live.ask, live.state)));
}

// A run of tool calls folds to one line, so the words around it stay together.
function agentChatLog(entries, place, partial = null) {
  const out = [];
  let calls = [];
  const fold = () => {
    if (calls.length) out.push(calls.length > 1 ? agentCallRun(calls, place) : agentChatEntry(calls[0]));
    calls = [];
  };
  for (const e of entries) {
    if (e.kind === 'tool') calls.push(e);
    else {
      fold();
      out.push(agentChatEntry(e));
    }
  }
  fold();
  if (partial) out.push(el('div', { class: 'said streaming', 'aria-busy': 'true' }, markdown(partial)));
  return out;
}

function agentCallRun(calls, place) {
  const id = place + ':calls:' + calls[0].at + ':' + calls[0].name;
  const names = [...new Set(calls.map((c) => agentToolName(c.name)))];
  const listed = names.slice(0, 3).join(', ') + (names.length > 3 ? ' and ' + plural(names.length - 3, 'more') : '');
  return el('details', { class: 'calls', open: ui.open.has(id), ontoggle: (e) => (e.target.open ? ui.open.add(id) : ui.open.delete(id)) },
    el('summary', { title: names.join(', ') }, icon('wrench'), el('span', {}, plural(calls.length, 'tool call') + ': ' + listed)), calls.map(agentChatEntry));
}

function agentChatEntry(e) {
  if (e.kind === 'said') return el('div', { class: 'said' }, markdown(e.text));
  if (e.kind === 'you') return el('div', { class: 'you' }, el('span', { class: 'who' }, 'You'), e.text);
  if (e.kind === 'tool') return el('div', { class: 'call' }, icon('wrench'), e.summary && e.summary !== e.name ? agentToolName(e.name) + ': ' + e.summary : agentToolName(e.name));
  if (e.kind === 'asked') return el('div', { class: 'asked' }, icon('bell'), e.questions ? e.questions.map((q) => q.question).join(' ') : agentAskWords(e));
  return el('div', { class: 'note' }, e.text);
}

// A question with one part gets its options as buttons; several parts at once are answered in words.
function agentAsk(a, live) {
  const pending = live.ask;
  if (!pending.questions) {
    return el('div', { class: 'actions options', role: 'group', 'aria-label': 'Allow or deny what the agent asks' },
      guarded(agentKeyId(a, 'allow'), 'Allow ' + agentToolName(pending.tool), 'check', 'Allow ' + agentToolName(pending.tool) + ' for ' + a.name + '?', () => agentReply(a, live, { allow: true }, agentKeyId(a, 'allow'))),
      guarded(agentKeyId(a, 'deny'), 'Deny', 'x', 'Deny ' + agentToolName(pending.tool) + ' for ' + a.name + '?', () => agentReply(a, live, { allow: false }, agentKeyId(a, 'deny'))));
  }
  if (pending.questions.length > 1) {
    return el('div', { class: 'meta' }, pending.questions.map((q) => el('p', {}, q.question + ' ' + q.options.map((o) => o.label).join(' / '))), el('p', {}, 'It asks these together, so answer them in words in its conversation.'));
  }
  const [{ question, options }] = pending.questions;
  return el('div', { class: 'actions options', role: 'group', 'aria-label': 'Answers the agent offers' }, options.map((o, i) => {
    const label = agentOptionLabel(o.label);
    const id = agentKeyId(a, String(i + 1));
    return guarded(id, label, 'circle', 'Answer “' + label + '” to ' + a.name + '?', () => agentReply(a, live, { answer: { question, label: o.label } }, id));
  }));
}

function agentOptionLabel(label) {
  return label.length > AGENT_OPTION_SHOWN ? label.slice(0, AGENT_OPTION_SHOWN).replace(/\s+\S*$/, '') + '…' : label;
}

function agentChatPrompt(pending, state) {
  if (pending?.questions) return 'Or type your own answer';
  if (pending) return 'Or say what it should do instead, which denies it';
  return state === 'done' ? 'Follow up, which picks its session up again' : 'Reply to the agent';
}

function agentReplyForm(a, live, placeholder) {
  const draft = 'agent:' + a.handle;
  const sendId = 'agent-send:' + a.handle;
  const text = ui.drafts.get(draft) ?? '';
  return el('div', { class: 'reply' },
    el('textarea', { id: 'agent-reply-' + a.handle, placeholder, 'aria-label': 'Reply to ' + a.name, oninput: (e) => agentEditDraft(draft, sendId, e.target.value) }, text),
    el('div', { class: 'actions' },
      text.trim()
        ? guarded(sendId, 'Send', 'send', 'Send “' + agentClipped(text, 40) + '” to ' + a.name + '?', () => agentSend(a, live, draft), true)
        : el('button', { class: 'primary', disabled: true, title: 'Type a reply first' }, icon('send'), 'Send')));
}

function agentClipped(text, n) {
  const line = text.trim().replace(/\s+/g, ' ');
  return line.length > n ? line.slice(0, n) + '…' : line;
}

function agentKeyId(a, key) {
  return 'agent-key:' + a.handle + ':' + key;
}

// An edit after arming disarms Send, so what is sent is always what the confirm named.
function agentEditDraft(draft, sendId, value) {
  const was = ui.drafts.get(draft) ?? '';
  if (value) ui.drafts.set(draft, value);
  else ui.drafts.delete(draft);
  const disarmed = ui.armed === sendId;
  if (disarmed) ui.armed = null;
  if (disarmed || Boolean(was.trim()) !== Boolean(value.trim())) render(true);
}

// The agent may have moved on since the page drew what is answered, so the worker checks against what it showed.
function agentReply(a, { state, since, ask }, reply, busyId) {
  return agentAct('agent-reply', { handle: a.handle, ...reply, expect: { state, since, pending: ask?.id ?? null } }, busyId);
}

async function agentSend(a, live, draft) {
  const text = ui.drafts.get(draft) ?? '';
  const sent = await agentReply(a, live, { text }, 'agent-send:' + a.handle);
  if (sent && ui.drafts.get(draft) === text) ui.drafts.delete(draft);
  render(true);
}

async function agentAct(name, payload, busyId) {
  const done = await matrixAct(name, payload, busyId);
  if (name !== 'agent-remove') agentLoadScreen(payload.handle, true);
  return done;
}

function agentToggleScreen(key) {
  if (ui.open.has(key)) ui.open.delete(key);
  else {
    const shown = [...ui.open].filter((k) => k.startsWith('agent:'));
    if (shown.length >= AGENT_MAX_SCREENS) {
      ui.open.delete(shown[0]);
      toast('Only ' + AGENT_MAX_SCREENS + ' conversations stay open at once, so the first one you opened has closed.');
    }
    ui.open.add(key);
  }
  render(true);
}

function agentWatchScreens() {
  if (!agentScreenLoop) agentScreenLoop = setTimeout(agentPollScreens, 0);
}

function agentPollScreens() {
  const handles = agentShownScreens();
  agentScreenLoop = handles.length ? setTimeout(agentPollScreens, AGENT_SCREEN_MS) : null;
  if (document.visibilityState !== 'hidden') handles.forEach((handle) => agentLoadScreen(handle));
}

// The page behind an open drawer is covered, so only the drawer's conversation refreshes then, after the agent window's.
function agentShownScreens() {
  const shown = [...document.querySelectorAll('#agent-window .console'), ...document.querySelectorAll(ui.mr || ui.ticket ? '#drawer .console' : '#main .console')];
  return [...new Set(shown.map((p) => p.dataset.handle).filter(Boolean))].slice(0, AGENT_MAX_SCREENS);
}

// A read already under way may predate an answer, so after one the conversation is read again once that read lands.
async function agentLoadScreen(handle, afterInput = false) {
  const was = ui.screens.get(handle);
  if (was?.loading) {
    if (afterInput) was.again = true;
    return;
  }
  const reading = { ...was, loading: true };
  ui.screens.set(handle, reading);
  const next = await agentReadChat(handle, was);
  ui.screens.set(handle, next);
  if (next.menu !== was?.menu) agentDisarm(handle);
  if (next.menu !== was?.menu || next.error !== (was?.error ?? null) || next.mark !== was?.mark) render(true);
  if (reading.again) agentLoadScreen(handle);
}

// The question in the conversation is the pending one, so a new one disarms what was armed on the last.
async function agentReadChat(handle, was) {
  try {
    const chat = await api('/api/agents/conversation?' + new URLSearchParams({ handle }));
    const last = chat.entries.at(-1);
    return { chat, mark: [chat.entries.length, last?.at, chat.state, chat.alive].join(':'), menu: chat.pending?.id ?? null, at: Date.now(), error: null };
  } catch (e) {
    return { ...was, loading: false, error: e.message, at: Date.now() };
  }
}

// A button armed on one question must not carry over to the next, whose first answer may say something else.
function agentDisarm(handle) {
  const armed = ui.armed ?? '';
  if (armed.startsWith('agent-key:' + handle + ':') || armed === 'agent-send:' + handle) ui.armed = null;
}

function agentButton(r) {
  if (!r.agent) return null;
  return el('button', { title: 'Read and answer the agent reviewing this MR, here', onclick: () => slot('openMr', r.key, 'agent') }, icon('message'), 'Agent');
}

function drawerAgent(ctx) {
  const fix = slot('fixAgentPanel', ctx);
  const review = agentReviewing(ctx);
  return fix || review ? [fix, review] : empty('No agent is working on ' + short(ctx.key) + ' right now.');
}

function agentReviewing(ctx) {
  const r = ctx.row;
  if (!r?.agent) return null;
  const agent = ctx.d.agents.find((a) => a.handle && a.handle === r.agentHandle);
  if (agent) return agentRow(agent, { pinned: true });
  return [
    el('div', { class: 'row-head' }, el('span', { class: 'pill s-working' }, icon('bot'), 'agent ' + r.agent)),
    el('p', { class: 'meta' }, String(r.agentHandle ?? '').startsWith('claude:') ? 'Its agent is not listed yet, so it cannot be answered from here.' : 'Its agent is an Orca terminal, which this page does not show.'),
  ];
}
