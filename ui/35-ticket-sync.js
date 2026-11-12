function syncButton(t, tickets) {
  const n = tickets.filter((x) => x.suggest).length;
  return el('button', { id: 'ticket-sync', 'aria-expanded': String(Boolean(t.sync)), onclick: () => toggleSync(t, tickets) }, icon('refresh'), 'Sync statuses' + (n ? ' (' + n + ')' : ''));
}

// The list is taken when the panel opens, so each line keeps what it proposed and its result while the tickets are read again behind it.
function toggleSync(t, tickets) {
  t.sync = t.sync ? null : {
    running: false,
    lines: tickets.filter((x) => x.suggest).map((x) => ({ key: x.key, from: x.status, to: x.suggest.status, why: x.suggest.why, result: null })),
  };
  render(true);
}

function syncPanel(t) {
  const s = t.sync;
  if (!s) return null;
  const waiting = s.lines.filter((l) => !l.result);
  return el('section', { class: 'section ticket-sync', 'aria-label': 'Sync statuses' },
    el('h2', {}, icon('refresh'), 'Sync statuses', el('span', { class: 'meta' }, 'moves your tickets\' MRs suggest')),
    s.lines.length ? el('div', { class: 'list' }, s.lines.map((l) => syncLine(l, s))) : empty('Every ticket\'s status already matches its MRs.'),
    t.data?.mergedError ? el('p', { class: 'meta bad' }, 'Merged MRs could not be read from GitLab, so no move to QA or Done is suggested: ' + t.data.mergedError) : null,
    el('div', { class: 'actions' },
      waiting.length > 1 && !s.running ? guarded('ticket-sync-all', 'Apply all ' + waiting.length, 'chevron', 'Move ' + plural(waiting.length, 'ticket') + '?', () => syncLines(s, waiting), true) : null,
      button('Close', 'x', () => { t.sync = null; render(); })));
}

function syncLine(l, s) {
  return el('div', { class: 'row-head ticket-sync-line', 'data-key': l.key },
    ticketRef(l.key),
    el('span', { class: 'sync-move' }, l.from + ' to ' + l.to + ': ' + l.why),
    l.result ? [el('span', { class: 'pill ' + l.result.tone }, l.result.word), l.result.why ? el('span', { class: 'meta' }, l.result.why) : null]
      : l.queued ? el('span', { class: 'meta' }, 'waiting')
        : s.running ? null : guarded('ticket-sync:' + l.key, 'Move', 'chevron', 'Move ' + l.key + ' to ' + l.to + '?', () => syncLines(s, [l])));
}

async function syncLines(s, lines) {
  s.running = true;
  for (const l of lines) l.queued = true;
  for (const l of lines) {
    l.queued = false;
    l.result = { tone: 's-working', word: 'moving' };
    render(true);
    const r = await requestMove(l.key, l.to, l.from);
    l.result = r.moved ? { tone: 's-done', word: 'moved' } : { tone: r.skipped ? 's-quiet' : 's-need', word: r.skipped ? 'skipped' : 'refused', why: r.text };
    ui.tickets.at = 0;
  }
  s.running = false;
  render(true);
  refresh();
}
