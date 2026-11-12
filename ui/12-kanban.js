function kanban(label, kind, lanes, cardOf, laneProps = () => ({})) {
  return el('div', { class: 'kanban ' + kind, role: 'region', 'aria-label': label, tabindex: '0' },
    lanes.map((lane) => el('section', { ...laneProps(lane), class: 'lane', 'data-lane': lane.id, 'aria-label': lane.label + ', ' + lane.items.length },
      el('h2', {}, lane.label, el('span', { class: 'pill ' + lane.tone }, String(lane.items.length))),
      lane.items.length ? lane.items.map(cardOf) : el('p', { class: 'lane-empty' }, 'Nothing here'))));
}

function storedLayout(key) {
  try { return localStorage.getItem(key) === 'board' ? 'board' : 'list'; } catch { return 'list'; }
}

function storeLayout(key, layout) {
  try { localStorage.setItem(key, layout); } catch {}
}

function layoutSwitch(current, onPick, idPrefix) {
  const node = chips([['list', 'List'], ['board', 'Board']], current, onPick, idPrefix);
  node.setAttribute('aria-label', 'Show as');
  return node;
}
