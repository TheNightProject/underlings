const terminalRefsPattern = () => new RegExp([mrUrlPattern(), JIRA_URL, MR_SHORT_REF, new RegExp('\\b(' + TICKET_KEY_SOURCE + ')\\b'), ...githubRefSources()].map((r) => r.source).join('|'), 'g');
const TERMINAL_BORDER = /[\u2500-\u257f]/;
const TERMINAL_REF_CHAR = /[\w./:?#=&%~+!-]/;
const TERMINAL_CELL_SLACK = 1;
const TERMINAL_LINE_SLACK = 2;
const TERMINAL_KIND = /^[a-z]+$/;
let terminalTip = null;

function terminalKnowing({ mrs = [], tickets = [], agents = [], jiraSite = null, projects = ownProjects() } = {}) {
  const keys = new Set([...mrs, ...agents.map((a) => a.mr)].filter(Boolean));
  const pathsOn = (provider) => new Set([...keys].filter((k) => keyProvider(k) === provider).map(keyPath));
  const paths = pathsOn('gitlab');
  return {
    mrs: keys,
    paths,
    githubPaths: pathsOn('github'),
    groups: new Set([...paths].map((p) => p.split('/')[0])),
    projects: new Set([...projects, ...[...tickets, ...agents.map((a) => a.ticket)].filter(Boolean).map((k) => k.split('-')[0])]),
    agents,
    jiraSite,
  };
}

function terminalKnown() {
  const rows = state?.matrix?.inbox?.rows ?? [];
  const listed = ui.tickets.data?.tickets ?? [];
  return terminalKnowing({
    mrs: [...rows.map((r) => r.key), ...(state?.matrix?.queue ?? []).map((q) => q.key), ...listed.flatMap((t) => (t.mrs ?? []).map((m) => m.key))],
    tickets: [...rows.map((r) => r.ticket), ...listed.map((t) => t.key)],
    agents: (state?.agents ?? []).filter((a) => a.handle).map((a) => ({ ...a, waiting: isNeed(a) })),
    jiraSite: state?.matrix?.jiraSite ?? null,
  });
}

function terminalLayout(text, width) {
  const cells = [];
  const borders = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (!TERMINAL_BORDER.test(text[i])) continue;
    borders.push(i);
    if (i > start) cells.push({ start, end: i });
    start = i + 1;
  }
  const end = Math.max(text.length, width);
  if (end > start) cells.push({ start, end });
  return { cells, borders: borders.join(','), boxed: borders.length > 0 };
}

function terminalContent(text, { start, end }) {
  let s = start;
  let e = Math.min(end, text.length);
  while (s < e && /\s/.test(text[s])) s += 1;
  while (e > s && /\s/.test(text[e - 1])) e -= 1;
  return { s, e };
}

function terminalRefOf([text, urlProject, urlIid, jiraKey, project, iid, ticket, prProject, prIid, ghProject, ghIid], known) {
  if (prProject) return { kind: 'mr', key: keyOf({ provider: 'github', projectPath: prProject, iid: prIid }), url: terminalCleanUrl(text), text };
  if (ghIid) return terminalPrRef(text, ghProject, ghIid, known);
  if (urlProject) return { kind: 'mr', key: keyOf({ projectPath: urlProject, iid: urlIid }), url: terminalCleanUrl(text), text };
  if (jiraKey) return { kind: 'ticket', key: jiraKey, url: terminalCleanUrl(text), text };
  if (ticket) return known.projects.has(ticket.split('-')[0]) ? { kind: 'ticket', key: ticket, url: null, text } : null;
  const key = terminalMrKey(project, iid, known);
  return isKey(key) ? { kind: 'mr', key, url: null, text } : null;
}

const terminalCleanUrl = (text) => text.replace(/[.,;:!?'"]+$/, '');

// owner/repo with a number always names one, repo with a number only when the pull requests the page knows leave one owner, and a bare number is a heading, a colour or an item, never a link.
function terminalPrRef(text, project, iid, known) {
  if (!project) return null;
  const owners = project.includes('/') ? [project] : [...known.githubPaths].filter((p) => p.split('/').pop() === project);
  if (owners.length !== 1) return null;
  const key = keyOf({ provider: 'github', projectPath: owners[0], iid });
  return isKey(key) ? { kind: 'mr', key, url: null, text } : null;
}

// With no project of its own to read !12 against, a short reference counts only when the MRs the page knows leave one answer.
function terminalMrKey(project, iid, known) {
  if (project?.includes('/')) return known.paths.has(project) || known.groups.has(project.split('/')[0]) ? keyOf({ projectPath: project, iid }) : null;
  const paths = [...known.paths].filter((p) => !project || p.split('/').pop() === project);
  const open = paths.map((p) => keyOf({ projectPath: p, iid })).filter((k) => known.mrs.has(k));
  if (open.length === 1) return open[0];
  return project && paths.length === 1 ? keyOf({ projectPath: paths[0], iid }) : null;
}

function terminalScan(text, known) {
  return [...text.matchAll(terminalRefsPattern())].map((m) => ({ at: m.index, length: m[0].length, ref: terminalRefOf(m, known) })).filter((x) => x.ref);
}

function terminalSingles(rows, layouts, known) {
  return layouts.flatMap((layout, row) => layout.cells.flatMap((cell) => terminalScan(rows[row].text.slice(cell.start, cell.end), known)
    .map(({ at, length, ref }) => ({ ...ref, pieces: [{ row, start: cell.start + at, end: cell.start + at + length }] }))));
}

// A row xterm.js wrapped carries straight on; one Claude Code broke itself carries on only when it was full, in the same cell below.
function terminalJoins(rows, layouts, r) {
  const [a, b] = [layouts[r], layouts[r + 1]];
  if (rows[r + 1].wrapped) return a.cells.length && b.cells.length ? [{ a: a.cells.at(-1), b: b.cells[0], soft: true }] : [];
  if (a.borders !== b.borders) return [];
  const slack = a.boxed ? TERMINAL_CELL_SLACK : TERMINAL_LINE_SLACK;
  return a.cells.map((cell, i) => ({ a: cell, b: b.cells[i], slack, soft: false })).filter((j) => j.b);
}

function terminalCrossing(rows, r, { a, b, slack, soft }, known) {
  const [top, below] = [rows[r].text, rows[r + 1].text];
  const end = soft ? Math.min(a.end, top.length) : terminalContent(top, a).e;
  const start = soft ? b.start : terminalContent(below, b).s;
  if (!soft && a.end - end > slack) return [];
  let tail = end;
  while (tail > a.start && TERMINAL_REF_CHAR.test(top[tail - 1])) tail -= 1;
  let head = start;
  while (head < Math.min(b.end, below.length) && TERMINAL_REF_CHAR.test(below[head])) head += 1;
  const left = end - tail;
  if (!left || head === start) return [];
  return terminalScan(top.slice(tail, end) + below.slice(start, head), known)
    .filter(({ at, length }) => at < left && at + length > left)
    .map(({ at, length, ref }) => ({ ...ref, pieces: [{ row: r, start: tail + at, end }, { row: r + 1, start, end: start + at + length - left }] }));
}

const terminalOverlap = (x, y) => x.pieces.some((p) => y.pieces.some((q) => p.row === q.row && p.start < q.end && q.start < p.end));

function terminalRefs(lines, known, { width = 0 } = {}) {
  const rows = lines.map((line) => (typeof line === 'string' ? { text: line, wrapped: false } : line));
  const layouts = rows.map((row) => terminalLayout(row.text, width));
  const crossing = rows.slice(0, -1).flatMap((_, r) => terminalJoins(rows, layouts, r).flatMap((join) => terminalCrossing(rows, r, join, known)));
  const kept = [];
  for (const ref of [...crossing, ...terminalSingles(rows, layouts, known)]) if (!kept.some((k) => terminalOverlap(k, ref))) kept.push(ref);
  return kept.sort((x, y) => x.pieces[0].row - y.pieces[0].row || x.pieces[0].start - y.pieces[0].start);
}

const terminalBusy = (a) => a.state === 'working' || Boolean(a.background?.length);
const terminalRank = (a) => (a.waiting ? 0 : terminalBusy(a) ? 1 : 2);

function terminalAgentFor(ref, agents) {
  const mine = agents.filter((a) => (ref.kind === 'mr' ? a.mr : a.ticket) === ref.key);
  return mine.sort((x, y) => terminalRank(x) - terminalRank(y) || (y.lastAt || 0) - (x.lastAt || 0))[0] ?? null;
}

function terminalAgentWords(a) {
  const kind = TERMINAL_KIND.test(a.kind ?? '') ? a.kind + ' ' : '';
  return 'open its ' + kind + 'agent (' + (a.waiting ? 'waiting on you' : terminalBusy(a) ? 'working' : 'done') + ')';
}

function terminalUrlFor(ref, known) {
  if (ref.url) return ref.url;
  if (ref.kind === 'ticket') return known.jiraSite ? 'https://' + known.jiraSite + '/browse/' + ref.key : null;
  const parts = keyParts(ref.key);
  // GitHub sends an issue link on to the pull request when the number is one, so a number it cannot tell apart still lands.
  if (parts.provider === 'github' && !known.mrs.has(ref.key)) return githubWeb() + '/' + parts.projectPath + '/issues/' + parts.iid;
  return mrUrl(parts);
}

function terminalAction(ref, known, { outside = false } = {}) {
  const url = terminalUrlFor(ref, known);
  const go = (kind, words, extra = {}) => ({ kind, label: ref.kind === 'mr' ? short(ref.key) : ref.key, words, url, ...extra });
  if (outside && url) return go('browser', 'open it in your browser');
  const agent = terminalAgentFor(ref, known.agents);
  if (agent) return go('agent', terminalAgentWords(agent), { handle: agent.handle });
  if (ref.kind === 'ticket' && known.projects.has(ref.key.split('-')[0])) return go('ticket', 'open the ticket (no agent yet)', { key: ref.key });
  if (ref.kind === 'mr' && known.mrs.has(ref.key)) return go('mr', keyProvider(ref.key) === 'github' ? 'open the pull request' : 'open the MR', { key: ref.key });
  return go('browser', ref.kind === 'ticket' ? 'open it in Jira' : 'open it on ' + forgeName(ref.key));
}

function terminalTarget(action) {
  if (action.kind === 'agent') return 'agent:' + action.handle;
  return action.kind === 'ticket' ? 'ticket:' + action.key : 'mr:' + action.key + ':overview';
}

function terminalLinkGo(action) {
  terminalTipHide();
  if (action.kind === 'browser') return action.url ? openOutside(action.url) : null;
  if (!slot('terminalWindowOnly')) return slot('goTo', terminalTarget(action));
  return api('/api/summon', { target: terminalTarget(action) }).catch((e) => toast(e.message, true));
}

// Each cell becomes one character, so a string index is a column even past a wide character.
function terminalRowOf(line, cols, cell) {
  let text = '';
  for (let x = 0; x < cols; x += 1) {
    const chars = line?.getCell(x, cell)?.getChars() ?? '';
    text += chars.length === 1 ? chars : chars ? '\ufffd' : ' ';
  }
  return { text, wrapped: Boolean(line?.isWrapped) };
}

function terminalLink(term, ref, piece, y) {
  return {
    range: { start: { x: piece.start + 1, y }, end: { x: piece.end, y } },
    text: ref.text,
    decorations: { pointerCursor: true, underline: !slot('terminalStyled', y - 1, piece.start) },
    activate: (event) => terminalLinkGo(terminalAction(ref, terminalKnown(), { outside: Boolean(event?.metaKey) })),
    hover: (event) => terminalTipShow(term, event, terminalAction(ref, terminalKnown())),
    leave: terminalTipHide,
  };
}

function terminalRowsOf(term, from, to) {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const rows = [];
  for (let i = from; i <= Math.min(to, buffer.length - 1); i += 1) rows.push(terminalRowOf(buffer.getLine(i), term.cols, cell));
  return rows;
}

function terminalLinks(term) {
  return {
    provideLinks(y, done) {
      const top = Math.max(0, y - 2);
      const links = terminalRefs(terminalRowsOf(term, top, y), terminalKnown(), { width: term.cols })
        .flatMap((ref) => ref.pieces.filter((p) => top + p.row === y - 1).map((p) => terminalLink(term, ref, p, y)));
      done(links.length ? links : undefined);
    },
  };
}

function terminalTipShow(term, event, action) {
  terminalTipHide();
  if (!term.element) return;
  const hint = action.kind !== 'browser' && action.url ? el('span', { class: 'term-tip-hint' }, '⌘-click opens it in your browser') : null;
  terminalTip = el('div', { class: 'xterm-hover term-tip', role: 'tooltip' }, el('b', {}, action.label), ' · ' + action.words, hint);
  term.element.append(terminalTip);
  terminalTipPlace(terminalTip, term.element.getBoundingClientRect(), event);
}

function terminalTipPlace(tip, box, event) {
  const [w, h] = [tip.offsetWidth || 0, tip.offsetHeight || 0];
  const below = event.clientY - box.top + 16;
  const top = below + h > box.height ? event.clientY - box.top - h - 8 : below;
  Object.assign(tip.style, { left: Math.max(0, Math.min(event.clientX - box.left, box.width - w - 4)) + 'px', top: Math.max(0, top) + 'px' });
}

function terminalTipHide() {
  terminalTip?.remove();
  terminalTip = null;
}
