const TERMINAL_STYLE_MS = 120;
const TERMINAL_PROMPT = /^\s*(?:[\u2502\u2503]\s*)?[>\u276f](?:\s|$)/;
const terminalStyle = { term: null, entries: [], seen: new Map(), mark: '', reset: true, timer: null, anchor: null, anchorAt: 0 };

const terminalRule = (text) => /\S/.test(text) && [...text].every((c) => /\s/.test(c) || TERMINAL_BORDER.test(c));

// The live prompt is the lowest line that starts like one, and what you type runs from there to the rule under it.
function terminalInputLines(rows, cursorLine) {
  const lines = new Set([cursorLine]);
  const at = rows.findLastIndex((r) => TERMINAL_PROMPT.test(r.text));
  if (at < 0) return lines;
  for (let i = at; i < rows.length && !terminalRule(rows[i].text); i += 1) lines.add(rows[i].line);
  return lines;
}

function terminalKnownMark(known) {
  const agents = known.agents.map((a) => [a.mr ?? a.ticket, a.waiting].join(':')).sort();
  return [...[...known.mrs].sort(), '|', ...[...known.projects].sort(), '|', ...agents].join(' ');
}

// Scrollback that trims its oldest lines renumbers every line under them, so what was seen moves up with them.
function terminalShifted(seen, by) {
  return new Map([...seen].filter(([line]) => line - by >= 0).map(([line, text]) => [line - by, text]));
}

// A reference may run onto the line either side, so a change marks those lines changed too.
function terminalChangedLines(rows, seen) {
  const changed = new Set();
  rows.forEach((r, i) => {
    if (seen.get(r.line) === r.text) return;
    for (const near of [rows[i - 1], r, rows[i + 1]]) if (near) changed.add(near.line);
  });
  return changed;
}

function terminalChangedRuns(rows, changed) {
  const runs = [];
  rows.forEach((r, i) => {
    if (!changed.has(r.line)) return;
    if (i > 0 && changed.has(rows[i - 1].line)) runs.at(-1).push(r);
    else runs.push([r]);
  });
  return runs;
}

function terminalStylePlan({ rows, seen, entries, input, known, width = 0, reset = false }) {
  const changed = terminalChangedLines(rows, reset ? new Map() : seen);
  const drop = entries.filter((e) => reset || e.gone || e.lines.some((l) => changed.has(l) || input.has(l)));
  const found = terminalChangedRuns(rows, changed).flatMap((run) => terminalRefs(run, known, { width })
    .map((ref) => ({ ...ref, pieces: ref.pieces.map((p) => ({ line: run[p.row].line, start: p.start, end: p.end })) })));
  const add = found.filter((ref) => !ref.pieces.some((p) => input.has(p.line)));
  return { drop, add, seen: new Map(rows.filter((r) => !input.has(r.line)).map((r) => [r.line, r.text])), scanned: [...changed] };
}

function terminalStyleStart(term) {
  Object.assign(terminalStyle, { term, entries: [], seen: new Map(), reset: true });
  term.onWriteParsed(terminalStyleSoon);
  term.onScroll(terminalStyleSoon);
  term.onResize(terminalStyleAgain);
  term.buffer.onBufferChange?.(terminalStyleAgain);
  terminalStyleSoon();
}

function terminalStyleAgain() {
  terminalStyle.reset = true;
  terminalStyleSoon();
}

// At most one pass per interval, since Claude Code's spinner writes for as long as it works and a debounce that waits for quiet would never run.
function terminalStyleSoon() {
  if (terminalStyle.term) terminalStyle.timer ??= setTimeout(terminalStyleNow, TERMINAL_STYLE_MS);
}

const terminalLinesOf = (term, from, to) => terminalRowsOf(term, from, to).map((r, i) => ({ ...r, line: from + i }));

function terminalEntryView(entry) {
  const lines = entry.parts.map((p) => p.marker?.line ?? -1);
  return { entry, lines, gone: lines.some((l) => l < 0) || entry.parts.some((p) => !p.deco || p.deco.isDisposed) };
}

function terminalStyleNow() {
  const s = terminalStyle;
  s.timer = null;
  const buffer = s.term?.buffer?.active;
  if (buffer?.type !== 'normal') return;
  const known = terminalKnown();
  const mark = terminalKnownMark(known);
  const shift = s.anchor && !s.anchor.isDisposed ? s.anchorAt - s.anchor.line : null;
  const reset = s.reset || mark !== s.mark || shift === null;
  const top = Math.max(0, buffer.viewportY - 1);
  const seen = reset ? new Map() : terminalShifted(s.seen, shift);
  const view = terminalStyleView(s.term, top);
  const plan = terminalStylePlan({ ...view, seen, entries: s.entries.map(terminalEntryView), known, width: s.term.cols, reset });
  terminalStyleApply(s, plan, known);
  Object.assign(s, { seen: plan.seen, mark, reset: false });
  terminalStyleAnchor(s, view.rows.at(-1)?.line ?? top);
}

function terminalStyleView(term, top) {
  const buffer = term.buffer.active;
  return {
    rows: terminalLinesOf(term, top, buffer.viewportY + term.rows),
    input: terminalInputLines(terminalLinesOf(term, buffer.baseY, buffer.length - 1), buffer.baseY + buffer.cursorY),
  };
}

function terminalStyleApply(s, plan, known) {
  const dropped = new Set(plan.drop.map((v) => v.entry));
  dropped.forEach((e) => e.dispose());
  s.entries = [...s.entries.filter((e) => !dropped.has(e)), ...plan.add.map((ref) => terminalDecorate(s.term, ref, known))];
}

// On the newest line, which scrollback trims last, so how far it has moved is how far every line has.
function terminalStyleAnchor(s, line) {
  s.anchor?.dispose();
  const buffer = s.term.buffer.active;
  s.anchor = s.term.registerMarker(line - (buffer.baseY + buffer.cursorY)) ?? null;
  s.anchorAt = line;
}

const terminalLinkColour = () => getComputedStyle(document.documentElement).getPropertyValue('--term-link').trim();

function terminalDecorate(term, ref, known) {
  const buffer = term.buffer.active;
  const cursor = buffer.baseY + buffer.cursorY;
  const colour = terminalLinkColour();
  const asks = Boolean(terminalAgentFor(ref, known.agents)?.waiting);
  const parts = ref.pieces.map((p, i) => {
    const marker = term.registerMarker(p.line - cursor);
    const deco = marker && term.registerDecoration({ marker, x: p.start, width: p.end - p.start, ...(colour ? { foregroundColor: colour } : {}) });
    deco?.onRender((node) => {
      node.classList.add('term-ref');
      if (asks && i === 0) node.classList.add('term-ref-asks');
    });
    return { marker, deco, start: p.start, end: p.end };
  });
  return { key: ref.key, parts, dispose: () => parts.forEach(({ marker, deco }) => { deco?.dispose(); marker?.dispose(); }) };
}

function terminalStyled(line, start) {
  return terminalStyle.entries.some((e) => e.parts.some((p) => p.marker?.line === line && p.start === start && p.deco && !p.deco.isDisposed));
}
