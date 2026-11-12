const PALETTE_SHOWN = 60;
const PALETTE_PAGE = 8;
const RECENT_KEY = 'cc.palette.recent';
const RECENT_KEPT = 20;
const RECENT_SHOWN = 6;
const NEEDS_SHOWN = 5;
const HERE_GROUPS = ['Merge request', 'Drawer', 'This view'];
const PALETTE_ORDER = ['Merge request', 'Drawer', 'This view', 'Go to', 'Merge requests', 'Tickets', 'Email', 'Slack', 'Agents', 'People', 'Artifacts', 'Actions', 'Settings', 'Everywhere'];
const PALETTE_PREFIXES = { '>': ['Actions', 'Settings', 'Merge request', 'Drawer', 'This view', 'Everywhere'], '!': ['Merge requests'], '@': ['People'], '#': ['Go to'] };
const ENTITY_KINDS = [mrEntries, ticketEntries, emailEntries, slackEntries, agentEntries, peopleEntries, artifactEntries, settingEntries];
const SHORTCUT_GROUPS = ['Everywhere', 'Go to', 'Lists', 'Merge request', 'Drawer', 'This view'];
const KEY_GLYPHS = { ArrowDown: '↓', ArrowUp: '↑' };
const ACCELERATOR_GLYPHS = { CommandOrControl: '⌘', CmdOrCtrl: '⌘', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧' };
const CONFIG_PATH = '~/.config/' + APP_FOLDER + '/config.json';
const palette = { query: '', at: 0, scope: null, shown: [], back: null, caret: null };
const shortcuts = { back: null };

function paletteEntries(cx) {
  const actions = keymap().filter((x) => x.palette !== false && live(x, cx)).map((x) => labelled(x, cx));
  if (!state) return actions;
  const d = derive();
  return [...actions, ...ENTITY_KINDS.flatMap((kind) => {
    try {
      return kind(d);
    } catch (e) {
      console.error(kind.name, e);
      return [];
    }
  })];
}

const labelled = (x, cx) => ({ ...x, label: x.title?.(cx) ?? x.label });

function mrEntries(d) {
  return d.rows.map((r) => ({
    id: 'mr:' + r.key, group: 'Merge requests', icon: 'merge', label: r.title,
    detail: [r.repo + ' ' + refNumber(r), r.author, r.ticket, MOOD[r.mood]?.label].filter(Boolean).join(' · '),
    terms: [r.key, refNumber(r), String(r.iid), r.repo, r.author, r.ticket, ...(r.reviewers ?? [])].filter(Boolean),
    run: () => slot('openMr', r.key, d.pendingByMr.has(r.key) ? 'findings' : 'overview'),
    actions: () => mrChoices(r.key),
  }));
}

function mrChoices(key) {
  return [
    ...DRAWER_TABS.map(([tab, label]) => ({ id: 'mr-tab:' + tab + ':' + key, group: 'Merge request', icon: 'open', label: label + ' tab', detail: short(key), run: () => slot('openMr', key, tab) })),
    ...MR_WRITES.map((write) => mrWrite(write, key)),
  ];
}

function ticketEntries(d) {
  const listed = ui.tickets?.data?.tickets ?? [];
  const known = new Set(listed.map((x) => x.key));
  const onMrs = [...new Set(d.rows.map((r) => r.ticket).filter((key) => key && !known.has(key)))].map((key) => ({ key }));
  return [...listed, ...onMrs].map((x) => ({
    id: 'ticket:' + x.key, group: 'Tickets', icon: 'ticket', label: x.summary || x.key,
    detail: [x.key, x.status, x.epic?.summary ?? x.epic?.key].filter(Boolean).join(' · '),
    terms: [x.key, x.status, x.epic?.key].filter(Boolean),
    run: () => slot('openTicket', x.key),
    actions: () => ticketChoices(x.key),
  }));
}

function ticketChoices(key) {
  return [
    ...TICKET_TABS.map(([tab, label]) => ({ id: 'ticket-tab:' + tab + ':' + key, group: 'Drawer', icon: 'open', label: label + ' tab', detail: key, run: () => slot('openTicket', key, tab) })),
    { id: 'ticket-start:' + key, group: 'Tickets', icon: 'bot', label: 'Start ' + key + ' with an agent', arm: () => ({ id: 'ticket-start:' + key, reveal: () => slot('openTicket', key) }) },
  ];
}

function emailEntries() {
  return slot('emailThreadEntries') ?? [];
}

function slackEntries() {
  return slot('slackMessageEntries') ?? [];
}

function settingEntries(d) {
  return slot('settingsFindEntries', d) ?? [];
}

function agentEntries(d) {
  return d.agents.filter((a) => a.handle).map((a) => ({
    id: 'agent:' + a.handle, group: 'Agents', icon: 'bot', label: a.title || a.name,
    detail: [slot('agentLabel', a), a.title && a.title !== a.name ? a.name : null, a.mr ? short(a.mr) : a.ticket].filter(Boolean).join(' · '),
    terms: [a.name, a.mr, a.ticket, a.kind].filter(Boolean),
    run: () => slot('agentWinOpen', a.handle),
  }));
}

function peopleEntries(d) {
  const roster = new Map((d.m.roster ?? []).map((p) => [p.username, p]));
  const authored = groupBy(d.rows, (r) => r.author);
  const names = [...new Set([...authored.keys(), ...roster.keys()])].filter(Boolean).sort();
  return names.map((name) => {
    const open = authored.get(name)?.length ?? 0;
    const level = roster.get(name)?.level;
    return {
      id: 'person:' + name, group: 'People', icon: 'user', label: name, terms: ['@' + name],
      detail: [open ? plural(open, 'open MR') : 'no open MR', level ? 'full auto at ' + level : null].filter(Boolean).join(' · '),
      run: open ? () => goView('merge-requests', () => { slot('scopeMrs', 'all'); ui.mrPerson = name; }) : () => goView('full-auto', () => { ui.peopleSearch = name; }),
    };
  });
}

function artifactEntries(d) {
  const windows = state.shell === 'app';
  return d.artifacts.map((a) => ({
    id: 'artifact:' + a.url, group: 'Artifacts', icon: 'sparkles', label: a.title, detail: firstLine(a.description),
    run: windows ? () => slot('openArtifactWindow', a.url) : () => showArtifact(a, false),
    actions: () => [
      windows ? { id: 'artifact-show:' + a.url, group: 'Artifacts', icon: 'sparkles', label: 'Show ' + a.title + ' in Artifacts', run: () => showArtifact(a, false) } : null,
      a.previewToken ? { id: 'artifact-preview:' + a.url, group: 'Artifacts', icon: 'eye', label: 'Preview ' + a.title, run: () => showArtifact(a, true) } : null,
      windows && a.previewToken ? { id: 'artifact-copy-window:' + a.url, group: 'Artifacts', icon: 'file', label: 'Open the copy of ' + a.title + ' in a window', run: () => slot('openArtifactWindow', a.url, true) } : null,
      { id: 'artifact-copy:' + a.url, group: 'Artifacts', icon: 'copy', label: 'Copy the link to ' + a.title, run: () => slot('copyLink', a.url) },
    ].filter(Boolean),
  }));
}

function showArtifact(a, preview) {
  if (preview) ui.open.add('artifact:' + a.url);
  selectLater('view:artifacts', 'url:' + a.url);
  goView('artifacts', () => { ui.artifactSearch = ''; });
}

function paletteTokens(query) {
  const prefix = Object.hasOwn(PALETTE_PREFIXES, query[0] ?? '') ? query[0] : null;
  return { groups: prefix ? PALETTE_PREFIXES[prefix] : null, tokens: (prefix ? query.slice(1) : query).toLowerCase().split(/\s+/).filter(Boolean) };
}

function entryScore(entry, tokens) {
  let total = 0;
  for (const token of tokens) {
    const best = Math.max(textScore(token, entry.label, true), ...(entry.terms ?? []).map((t) => termScore(token, t)), textScore(token, entry.detail, false) * 0.5);
    if (!best) return null;
    total += best;
  }
  return total;
}

function textScore(token, text, fuzzy) {
  const t = String(text ?? '').toLowerCase();
  if (!t) return 0;
  if (t === token) return 100;
  if (t.startsWith(token)) return 80;
  const at = t.indexOf(token);
  if (at > 0 && !/[a-z0-9]/.test(t[at - 1])) return 60;
  if (fuzzy && token.length > 1 && initials(t).startsWith(token)) return 55;
  if (at >= 0) return 40;
  if (!fuzzy || token.length < 2) return 0;
  const gaps = gapsInOrder(token, t);
  return gaps == null ? 0 : Math.max(4, 20 - 2 * gaps);
}

function termScore(token, term) {
  const score = textScore(token, term, false);
  return score === 100 ? 100 : score * 0.6;
}

const initials = (text) => text.split(/[^a-z0-9]+/).filter(Boolean).map((w) => w[0]).join('');

function gapsInOrder(token, text) {
  let at = -1;
  let gaps = 0;
  for (const c of token) {
    const next = text.indexOf(c, at + 1);
    if (next < 0) return null;
    if (at >= 0 && next > at + 1) gaps += 1;
    at = next;
  }
  return gaps;
}

function rankEntries(entries, query) {
  const { groups, tokens } = paletteTokens(query);
  const recents = recentIds();
  const needs = new Set((state?.attention?.cards ?? []).map((c) => 'mr:' + c.key));
  const order = (x) => PALETTE_ORDER.indexOf(x.group) >>> 0;
  return entries
    .filter((x) => !groups || groups.includes(x.group))
    .map((x, i) => ({ x, i, score: tokens.length ? entryScore(x, tokens) : 0 }))
    .filter(({ score }) => score != null)
    .map((hit) => ({ ...hit, score: hit.score + bonus(hit.x, recents, needs, query) }))
    .sort((a, b) => b.score - a.score || order(a.x) - order(b.x) || a.i - b.i)
    .slice(0, PALETTE_SHOWN)
    .map(({ x }) => x);
}

function bonus(entry, recents, needs, query) {
  const recent = recents.indexOf(entry.id);
  return (recent >= 0 ? Math.max(0, 25 - recent) : 0) + (needs.has(entry.id) ? 10 : 0) + (entry.group === 'Go to' && query.length <= 3 ? 10 : 0);
}

function paletteSections(cx) {
  if (palette.scope) {
    const actions = palette.scope.actions().filter(Boolean).filter((x) => live(x, cx)).map((x) => labelled(x, cx));
    return palette.query ? [[null, rankEntries(actions, palette.query)]] : [[palette.scope.label, actions]];
  }
  const entries = paletteEntries(cx);
  if (palette.query.trim()) return [[null, rankEntries(entries, palette.query.trim())]];
  const byId = new Map(entries.map((x) => [x.id, x]));
  const seen = new Set();
  const fresh = (list) => list.filter((x) => x && !seen.has(x.id) && seen.add(x.id));
  return [
    ['Recent', fresh(recentIds().map((id) => byId.get(id))).slice(0, RECENT_SHOWN)],
    ['Here', fresh(entries.filter((x) => HERE_GROUPS.includes(x.group)))],
    ['Needs you', fresh((state?.attention?.cards ?? []).slice(0, NEEDS_SHOWN).map((c) => byId.get('mr:' + c.key)))],
    ['Go to', fresh(entries.filter((x) => x.group === 'Go to'))],
    ['Actions', fresh(entries.filter((x) => x.group === 'Actions' || x.group === 'Everywhere'))],
  ].filter(([, list]) => list.length);
}

function recentIds() {
  try {
    const kept = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(kept) ? kept.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function rememberPick(id) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentIds().filter((x) => x !== id)].slice(0, RECENT_KEPT)));
  } catch {}
}

function paletteHost() {
  const found = byId('palette');
  if (found) return found;
  const host = el('div', { id: 'palette', class: 'kb-backdrop', hidden: true, onpointerdown: (e) => { if (e.target === host) closePalette(); } },
    el('div', { class: 'palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Jump to' },
      el('div', { class: 'palette-bar' }, icon('search'), el('span', { class: 'palette-crumb', hidden: true }),
        el('input', {
          id: 'palette-q', type: 'text', role: 'combobox', autocomplete: 'off', spellcheck: 'false', 'aria-expanded': 'true', 'aria-controls': 'palette-list',
          'aria-autocomplete': 'list', 'aria-label': 'Jump to', placeholder: 'Jump to a view, MR, ticket, agent, person or action', oninput: onPaletteInput, onkeydown: onPaletteKey,
        })),
      el('ul', { id: 'palette-list', class: 'palette-list', role: 'listbox', 'aria-label': 'Results' }),
      el('div', { class: 'palette-foot' },
        el('span', {}, keyCaps('ArrowUp'), keyCaps('ArrowDown'), ' move'), el('span', {}, keyCaps('Enter'), ' open'),
        el('span', {}, keyCaps('Tab'), ' what you can do with it'), el('span', {}, keyCaps('Esc'), ' close'),
        el('span', {}, '> actions · ! MRs · @ people · # views'))));
  document.body.append(host);
  return host;
}

function togglePalette() {
  if (keyState.overlay === 'palette') closePalette();
  else openPalette();
}

function openPalette(query = '') {
  if (keyState.overlay === 'palette') return paletteHost().querySelector('input').focus();
  const from = keyState.overlay === 'help' ? shortcuts.back : document.activeElement;
  if (keyState.overlay === 'help') closeShortcuts(false);
  clearPending();
  keyState.waiting = null;
  Object.assign(palette, { query, at: 0, scope: null, back: from, caret: typingIn(from) ? from.selectionStart ?? null : null });
  slot('ticketList');
  const host = paletteHost();
  const input = host.querySelector('input');
  input.value = query;
  keyState.overlay = 'palette';
  host.hidden = false;
  paintPalette();
  input.focus();
  holdOverlays();
}

function closePalette(restore = true) {
  if (keyState.overlay !== 'palette') return;
  keyState.overlay = null;
  paletteHost().hidden = true;
  holdOverlays();
  if (restore) backTo(palette.back, palette.caret);
}

function backTo(node, caret = null) {
  const home = node?.isConnected && node !== document.body ? node : layerHome();
  home?.focus({ preventScroll: true });
  if (home === node && caret != null) node.setSelectionRange?.(caret, caret);
}

function layerHome() {
  const layer = keyLayer();
  if (layer.name === 'modal') return document.querySelector('#message-modal .mm');
  if (layer.name === 'sheet') return document.querySelector('#sheet .sheet');
  if (layer.name !== 'main') return document.querySelector('#drawer .drawer');
  return document.querySelector('#main .is-selected') ?? byId('main');
}

function paintPalette() {
  const host = paletteHost();
  const sections = paletteSections(keyContext());
  palette.shown = sections.flatMap(([, list]) => list);
  palette.at = Math.max(0, Math.min(palette.at, palette.shown.length - 1));
  const { tokens } = paletteTokens(palette.query);
  let n = 0;
  const rows = sections.flatMap(([title, list]) => [
    title ? el('li', { class: 'palette-head', role: 'presentation' }, title) : null,
    ...list.map((entry) => paletteOption(entry, n++, tokens, !title)),
  ]).filter(Boolean);
  if (!palette.shown.length) rows.push(el('li', { class: 'palette-none', role: 'presentation' }, 'Nothing matches. Try a view, !iid, a ticket key or a name.'));
  host.querySelector('.palette-list').replaceChildren(...rows);
  const crumb = host.querySelector('.palette-crumb');
  crumb.hidden = !palette.scope;
  crumb.textContent = palette.scope ? palette.scope.label + ' ›' : '';
  markPaletteActive();
}

function paletteOption(entry, i, tokens, typed) {
  return el('li', {
    id: 'palette-opt-' + i, role: 'option', class: 'palette-opt', 'aria-selected': 'false',
    onpointerdown: (e) => e.preventDefault(), onclick: () => choose(entry), onpointermove: () => hoverPalette(i),
  },
  el('span', { class: 'palette-icon' }, icon(entry.icon ?? 'chevron')),
  el('span', { class: 'palette-text' }, el('span', { class: 'palette-label' }, markedLabel(entry.label, tokens)), entry.detail ? el('span', { class: 'palette-detail' }, entry.detail) : null),
  el('span', { class: 'palette-tags' },
    entry.count ? el('span', { class: 'count' }, entry.count) : null,
    typed && tokens.length ? el('span', { class: 'palette-group' }, entry.group) : null,
    entry.arm || entry.focus ? el('span', { class: 'twice', title: 'Takes two presses: this one brings it up, the next sends it' }, '2×') : null,
    entry.actions ? el('span', { class: 'palette-more', title: 'Tab shows what you can do with it' }, 'Tab ›') : null,
    entry.keys?.[0] ? keyCaps(entry.keys[0]) : null));
}

function markedLabel(label, tokens) {
  const text = String(label ?? '');
  const lower = text.toLowerCase();
  const hit = new Set();
  for (const token of tokens) for (const at of matchedAt(token, lower)) hit.add(at);
  const runs = [];
  for (let i = 0; i < text.length; i += 1) {
    const on = hit.has(i);
    if (runs.at(-1)?.on === on) runs.at(-1).text += text[i];
    else runs.push({ on, text: text[i] });
  }
  return runs.map((r) => (r.on ? el('b', {}, r.text) : r.text));
}

function matchedAt(token, text) {
  const at = text.indexOf(token);
  if (at >= 0) return [...token].map((_, i) => at + i);
  if (gapsInOrder(token, text) == null) return [];
  let from = -1;
  return [...token].map((c) => (from = text.indexOf(c, from + 1)));
}

function markPaletteActive() {
  const host = paletteHost();
  const options = [...host.querySelectorAll('[role="option"]')];
  options.forEach((node, i) => node.setAttribute('aria-selected', String(i === palette.at)));
  host.querySelector('input').setAttribute('aria-activedescendant', options[palette.at]?.id ?? '');
  options[palette.at]?.scrollIntoView({ block: 'nearest' });
}

function hoverPalette(i) {
  if (palette.at === i) return;
  palette.at = i;
  markPaletteActive();
}

function movePalette(step) {
  const n = palette.shown.length;
  if (!n) return;
  palette.at = Math.abs(step) === 1 ? (palette.at + step + n) % n : Math.max(0, Math.min(n - 1, palette.at + step));
  markPaletteActive();
}

function onPaletteInput(e) {
  palette.query = e.target.value;
  palette.at = 0;
  paintPalette();
}

const PALETTE_MOVES = { ArrowDown: 1, ArrowUp: -1, PageDown: PALETTE_PAGE, PageUp: -PALETTE_PAGE };

function onPaletteKey(e) {
  const emacs = onMac() && e.ctrlKey && !e.metaKey ? { n: 1, p: -1 }[e.key] : null;
  const move = emacs ?? (e.metaKey || e.ctrlKey ? null : PALETTE_MOVES[e.key]);
  if (move) return stop(e, () => movePalette(move));
  if (e.key === 'Enter') return stop(e, () => choose(palette.shown[palette.at]));
  if (e.key === 'Tab') return stop(e, () => (e.shiftKey ? leaveScope() : enterScope(palette.shown[palette.at])));
  if (e.key === 'Backspace' && palette.scope && !e.target.value) return stop(e, leaveScope);
  if (e.key === 'Escape') return stop(e, () => (palette.scope ? leaveScope() : closePalette()));
}

function stop(e, then) {
  e.preventDefault();
  then();
}

function enterScope(entry) {
  if (!entry?.actions) return;
  palette.scope = entry;
  resetQuery();
}

function leaveScope() {
  if (!palette.scope) return;
  palette.scope = null;
  resetQuery();
}

function resetQuery() {
  palette.query = '';
  palette.at = 0;
  paletteHost().querySelector('input').value = '';
  paintPalette();
}

function choose(entry) {
  if (!entry) return;
  rememberPick(palette.scope?.id ?? entry.id);
  const back = palette.back;
  closePalette(false);
  performEntry(entry, keyContext(), 'palette');
  if (document.activeElement === document.body) backTo(back);
}

function keyCaps(seq) {
  return el('span', { class: 'caps' }, String(seq).split(' ').map((k) => el('kbd', {}, capLabel(k))));
}

function capLabel(k) {
  if (k === 'Mod+K') return (onMac() ? '⌘' : 'Ctrl ') + 'K';
  return KEY_GLYPHS[k] ?? k;
}

function acceleratorText(accelerator) {
  return accelerator.split('+').map((part) => ACCELERATOR_GLYPHS[part] ?? part).join('');
}

function shortcutsHost() {
  const found = byId('keyhelp');
  if (found) return found;
  const host = el('div', { id: 'keyhelp', class: 'kb-backdrop', hidden: true, onpointerdown: (e) => { if (e.target === host) closeShortcuts(); } },
    el('div', { class: 'keyhelp', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'keyhelp-title', tabindex: '-1', onkeydown: trapShortcutsTab },
      el('div', { class: 'keyhelp-head' },
        el('h2', { id: 'keyhelp-title' }, 'Keyboard shortcuts'),
        el('button', { type: 'button', id: 'keyhelp-close', class: 'icon-only', title: 'Close (Esc)', 'aria-label': 'Close the shortcuts', onclick: () => closeShortcuts() }, icon('x'))),
      el('div', { class: 'keyhelp-body' })));
  document.body.append(host);
  return host;
}

function trapShortcutsTab(e) {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  byId('keyhelp-close').focus();
}

function openShortcuts() {
  if (keyState.overlay === 'help') return;
  const from = keyState.overlay === 'palette' ? palette.back : document.activeElement;
  if (keyState.overlay === 'palette') closePalette(false);
  clearPending();
  shortcuts.back = from;
  const cx = keyContext();
  const host = shortcutsHost();
  paintShortcuts(host, cx);
  keyState.overlay = 'help';
  host.hidden = false;
  host.querySelector('.keyhelp').focus();
  holdOverlays();
}

function closeShortcuts(restore = true) {
  if (keyState.overlay !== 'help') return;
  keyState.overlay = null;
  shortcutsHost().hidden = true;
  holdOverlays();
  if (restore) backTo(shortcuts.back);
}

function paintShortcuts(host, cx) {
  const keyed = keymap().filter((x) => x.keys?.length);
  const cards = SHORTCUT_GROUPS.map((group) => {
    const rows = shortcutRows(keyed.filter((x) => x.group === group), cx);
    return rows.length ? el('section', { class: 'kh-card' }, el('h3', {}, group), el('dl', {}, rows)) : null;
  });
  host.querySelector('.keyhelp-body').replaceChildren(
    el('p', { class: 'kh-lead' }, 'A key that writes takes two presses: the first arms the button and says what it will do, the second, or Enter, does it. Esc cancels.'),
    el('div', { class: 'kh-grid' }, [...cards, appShortcuts()].filter(Boolean)),
    el('p', { class: 'meta kh-foot' }, 'Keys pause while you type. Esc leaves the field and keeps what you typed.'));
}

function shortcutRows(entries, cx) {
  const folds = new Map();
  for (const x of entries.filter((e) => e.fold)) folds.set(x.fold, [...(folds.get(x.fold) ?? []), x]);
  const drawn = new Set();
  return entries.flatMap((x) => {
    if (!x.fold) return [shortcutRow(x.keys.map(keyCaps), x.label, live(x, cx), Boolean(x.arm))];
    if (drawn.has(x.fold)) return [];
    drawn.add(x.fold);
    const group = folds.get(x.fold);
    const last = Math.max(...group.map((g) => Number(g.keys[0])));
    return [shortcutRow([keyCaps('1'), el('span', { class: 'kh-or' }, 'to'), keyCaps(String(last))], 'Drawer tab: ' + DRAWER_TABS.map(([, label]) => label).join(', '), group.some((g) => live(g, cx)), false)];
  });
}

function shortcutRow(caps, label, here, twice) {
  const joined = caps.flatMap((cap, i) => (i && cap.classList?.contains('caps') && caps[i - 1].classList?.contains('caps') ? [el('span', { class: 'kh-or' }, 'or'), cap] : [cap]));
  return el('div', { class: 'kh-row' + (here ? '' : ' idle'), title: here ? null : 'Does nothing here' },
    el('dt', {}, joined),
    el('dd', {}, label, twice ? el('span', { class: 'twice', title: 'Takes two presses' }, '2×') : null));
}

function appShortcuts() {
  const hot = state?.shell === 'app' ? state.hotkeys : null;
  if (!hot) return null;
  const globals = [[hot.show ?? {}, 'showShortcut', 'Show ' + APP_NAME + ' from any app', 'shows the window'], [hot.claude, 'claudeShortcut', 'Open Claude Code from any app', 'opens Claude Code']];
  const shown = globals.filter(([bound]) => bound);
  return el('section', { class: 'kh-card' }, el('h3', {}, 'Mac app'),
    el('dl', {},
      shown.map(([bound, , label]) => (bound.accelerator ? shortcutRow([el('span', { class: 'caps' }, el('kbd', {}, acceleratorText(bound.accelerator)))], label, Boolean(bound.registered), false) : null)),
      (hot.menu ?? []).map(([label, accelerator]) => shortcutRow([el('span', { class: 'caps' }, el('kbd', {}, acceleratorText(accelerator)))], label, true, false))),
    shown.map(([bound, key, , does]) => globalNote(bound, key, does)));
}

function globalNote(bound, key, does) {
  const where = 'Set ' + key + ' in ' + CONFIG_PATH + ', then quit and open the app again.';
  if (!bound.accelerator) return el('p', { class: 'hint bad' }, 'No shortcut ' + does + ' from another app. ' + where);
  return bound.registered ? null : el('p', { class: 'hint bad' }, 'Could not use ' + acceleratorText(bound.accelerator) + ': ' + (bound.why ?? 'macOS refused it') + '. ' + where);
}

function railJump() {
  const brand = document.querySelector('.rail .brand');
  if (!brand || byId('jump')) return;
  brand.after(el('button', { type: 'button', id: 'jump', class: 'jump', title: 'Jump to a view, MR, ticket, agent, person or action', onclick: () => openPalette() },
    icon('search'), el('span', { class: 'jump-label' }, 'Jump to…'), el('span', { class: 'caps' }, el('kbd', {}, capLabel('Mod+K')))));
}

railJump();
