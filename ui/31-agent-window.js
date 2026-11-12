const AGENT_WIN_STORE = 'cc.agentWindow';
const AGENT_WIN_MIN = { w: 360, h: 360 };
const AGENT_WIN_SIZE = { w: 640, h: Infinity };
const agentWin = { handle: null, opener: null, place: {}, mark: '' };

function agentWinAgent(handle) {
  return handle ? state?.agents?.find((a) => a.handle === handle) ?? null : null;
}

function agentWinShown() {
  return Boolean(agentWinAgent(agentWin.handle));
}

function agentWinHasFocus(target) {
  return agentWinShown() && Boolean(target?.closest?.('#agent-window'));
}

function agentWinHost() {
  const found = byId('agent-window');
  if (found) return found;
  const host = el('section', { id: 'agent-window', class: 'awin float', role: 'dialog', 'aria-label': 'Agent', tabindex: '-1', hidden: true },
    el('header', { class: 'aw-head', onpointerdown: (e) => agentWinDrag(e, 'move') },
      el('div', { class: 'aw-title' }),
      el('div', { class: 'aw-tools' },
        el('button', { type: 'button', class: 'icon-only', id: 'agent-window-close', title: 'Close (Esc)', 'aria-label': 'Close the agent window', onclick: () => agentWinClose() }, icon('x')))),
    el('div', { class: 'aw-body' }),
    el('div', { class: 'float-grip', 'aria-hidden': 'true', onpointerdown: (e) => agentWinDrag(e, 'size') }));
  floatFrontOnUse(host);
  document.body.append(host);
  return host;
}

function agentWinDrag(e, how) {
  const host = agentWinHost();
  floatDrag(e, how, host, (rect, done) => {
    agentWin.place = { ...agentWin.place, ...rect };
    if (done) floatSave(AGENT_WIN_STORE, agentWin.place);
    else agentWinFit(host);
  });
}

function agentWinFit(host) {
  floatFit(host, agentWin.place, { min: AGENT_WIN_MIN, size: AGENT_WIN_SIZE });
}

// Focus goes back where it came from on close, unless it came from inside the window, as a switch to another agent does.
function agentWinOpen(handle) {
  if (!agentWinAgent(handle)) return;
  const from = document.activeElement;
  if (!agentWinHost().contains(from)) agentWin.opener = from?.id || null;
  if (agentWin.handle !== handle) agentWin.mark = '';
  agentWin.handle = handle;
  slot('officeOpen', handle);
  render(true);
  floatFront(agentWinHost());
  agentWinHost().focus({ preventScroll: true });
}

function agentWinClose() {
  const had = agentWinForget();
  render(true);
  if (had) agentWinBack();
}

function agentWinForget() {
  const host = byId('agent-window');
  const had = Boolean(host?.contains(document.activeElement));
  slot('officeLetGo', agentWin.handle);
  Object.assign(agentWin, { handle: null, mark: '' });
  host?.querySelector('.aw-body').replaceChildren();
  return had;
}

function agentWinBack() {
  (byId(agentWin.opener) ?? slot('layerHome'))?.focus({ preventScroll: true });
}

function renderAgentWindow() {
  const host = agentWinHost();
  const a = agentWinAgent(agentWin.handle);
  if (agentWin.handle && !a && agentWinForget()) agentWinBack();
  host.hidden = !a;
  if (!a) return;
  agentWinFit(host);
  const mark = agentWinMark(a);
  if (mark === agentWin.mark) return;
  agentWin.mark = mark;
  agentWinPaint(host, a);
}

// Repainting drops a text selection and the reader's place, so the window is only redrawn when something it shows has moved.
function agentWinMark(a) {
  const s = ui.screens.get(a.handle);
  const draft = (ui.drafts.get('agent:' + a.handle) ?? '').trim();
  return JSON.stringify([a, s?.mark, s?.menu, s?.error, ui.armed, [...ui.busy], Boolean(draft), state.claude?.titles, Math.floor(Date.now() / 60000)]);
}

function agentWinPaint(host, a) {
  const body = host.querySelector('.aw-body');
  const same = host.dataset.handle === a.handle;
  const kept = [body.scrollTop, body.querySelector('.chat')?.scrollTop ?? 0];
  host.dataset.handle = a.handle;
  host.setAttribute('aria-label', a.name);
  host.querySelector('.aw-title').replaceChildren(
    el('span', { class: 'aw-kind', 'data-kind': a.kind ?? '' }, agentWinKind(a.kind)),
    el('h2', {}, a.name));
  body.replaceChildren(...agentWinBody(a));
  if (!same) return;
  body.scrollTop = kept[0];
  const chat = body.querySelector('.chat');
  if (chat) chat.scrollTop = kept[1];
}

function agentWinKind(kind) {
  return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Agent';
}

function agentWinBody(a) {
  const text = a.title || firstLine(a.said);
  return [
    el('div', { class: 'row-head aw-meta' },
      el('span', { class: 'pill ' + agentClass(a) }, slot('agentLabel', a)),
      slot('agentPhaseShown', a),
      slot('agentWorksFor', a, 'overview'),
      slot('modelAgentLine', a),
      el('span', { class: 'meta' }, a.since ? 'since ' + ago(a.since) : '')),
    text && text !== a.name ? el('p', { class: 'aw-said' }, text) : null,
    slot('agentBackground', a),
    slot('agentConsole', a, true),
  ].flat().filter(Boolean);
}

function agentWinStart() {
  agentWin.place = floatLoad(AGENT_WIN_STORE);
  addEventListener('resize', () => agentWinShown() && agentWinFit(byId('agent-window')));
}

agentWinStart();
