const VIZ_NS = 'http://www.w3.org/2000/svg';
const VIZ_WIDTH = 560;
const VIZ_BAR_MAX = 24;
const VIZ_BAR_ROW = 14;
const VIZ_GAP = 2;
const VIZ_RADIUS = 4;
const VIZ_DOT = 4;
const VIZ_HIT = 12;
const VIZ_CHAR_PX = 6.8;
const VIZ_DURATION_TICKS = [[60e3, '1 min'], [6e5, '10 min'], [36e5, '1 h'], [144e5, '4 h'], [864e5, '1 d'], [2592e5, '3 d'], [6048e5, '1 w'], [12096e5, '2 w'], [24192e5, '4 w'], [48384e5, '8 w']];
const vizWidths = new Map();
let vizResizeTimer = null;
let vizTipAnchor = null;

function vizSvg(tag, attrs = {}, ...kids) {
  const node = document.createElementNS(VIZ_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, String(v));
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) node.append(kid);
  return node;
}

const vizPx = (v) => Math.round(v * 10) / 10;
const vizSum = (values) => values.reduce((a, b) => a + b, 0);

function vizTicks(max, most = 4) {
  if (!(max > 0)) return [0, 1];
  const rough = max / most;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * power).find((s) => s >= rough));
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, i) => i * step);
}

function vizCompact(n) {
  return n >= 1000 ? (Math.round(n / 100) / 10).toString().replace(/\.0$/, '') + 'K' : String(n);
}

function vizDuration(ms) {
  const minutes = ms / 6e4;
  if (minutes < 59.5) return Math.max(1, Math.round(minutes)) + ' min';
  const hours = minutes / 60;
  if (hours < 47.5) return (hours < 9.95 ? Math.round(hours * 10) / 10 : Math.round(hours)) + ' h';
  const days = hours / 24;
  return (days < 9.95 ? Math.round(days * 10) / 10 : Math.round(days)) + ' d';
}

// Square at the baseline and rounded only at the data end, so a bar reads as growing from the axis.
function vizColumnPath(x, y, w, h) {
  const r = Math.min(VIZ_RADIUS, w / 2, h);
  return `M${vizPx(x)},${vizPx(y + h)}V${vizPx(y + r)}A${r},${r} 0 0 1 ${vizPx(x + r)},${vizPx(y)}H${vizPx(x + w - r)}A${r},${r} 0 0 1 ${vizPx(x + w)},${vizPx(y + r)}V${vizPx(y + h)}Z`;
}

function vizBarPath(x, y, w, h) {
  const r = Math.min(VIZ_RADIUS, h / 2, w);
  return `M${vizPx(x)},${vizPx(y)}H${vizPx(x + w - r)}A${r},${r} 0 0 1 ${vizPx(x + w)},${vizPx(y + r)}V${vizPx(y + h - r)}A${r},${r} 0 0 1 ${vizPx(x + w - r)},${vizPx(y + h)}H${vizPx(x)}Z`;
}

function vizFit(text, px) {
  const most = Math.max(1, Math.floor(px / VIZ_CHAR_PX));
  return text.length > most ? text.slice(0, Math.max(1, most - 1)) + '…' : text;
}

function vizTip() {
  let tip = document.getElementById('viz-tip');
  if (!tip) {
    tip = el('div', { id: 'viz-tip', class: 'viz-tip', 'aria-hidden': 'true' });
    tip.hidden = true;
    document.body.append(tip);
  }
  return tip;
}

function vizShowTip(readout, x, y) {
  const tip = vizTip();
  tip.replaceChildren(...[
    el('div', { class: 'viz-tip-title' }, readout.title),
    ...readout.rows.map(([value, label, tone]) => el('div', { class: 'viz-tip-row' }, tone ? el('span', { class: 'viz-key ' + tone }) : null, el('b', {}, value), el('span', {}, label))),
    readout.note ? el('div', { class: 'viz-tip-note' }, readout.note) : null,
  ].filter(Boolean));
  tip.hidden = false;
  vizMoveTip(x, y);
}

function vizMoveTip(x, y) {
  const tip = document.getElementById('viz-tip');
  if (!tip || tip.hidden) return;
  const wide = window.innerWidth || 1e4;
  const tall = window.innerHeight || 1e4;
  const w = tip.offsetWidth || 0;
  const h = tip.offsetHeight || 0;
  const above = y - h - 12;
  tip.style.left = Math.max(8, Math.min(x + 14, wide - w - 8)) + 'px';
  tip.style.top = Math.max(8, above >= 8 ? above : Math.min(y + 18, tall - h - 8)) + 'px';
}

function vizHideTip() {
  vizTipAnchor = null;
  const tip = document.getElementById('viz-tip');
  if (tip) tip.hidden = true;
}

function vizTipAt(node, readout) {
  const box = node.getBoundingClientRect();
  vizShowTip(readout, box.left + box.width / 2, box.top);
  vizTipAnchor = { node, readout };
}

// The tip is fixed to the window, so a scroll carries a focused mark's tip with it and drops a pointer's.
addEventListener('scroll', () => {
  const anchor = vizTipAnchor;
  if (anchor?.node.isConnected && document.activeElement === anchor.node) vizTipAt(anchor.node, anchor.readout);
  else vizHideTip();
}, true);

function vizReadoutText(readout) {
  return readout.title + ': ' + [...readout.rows.map(([value, label]) => value + ' ' + label), readout.note].filter(Boolean).join(', ');
}

function vizFocus(node, readout) {
  node.setAttribute('tabindex', '0');
  node.setAttribute('role', 'img');
  node.setAttribute('aria-label', vizReadoutText(readout));
  node.addEventListener('focus', () => vizTipAt(node, readout));
  node.addEventListener('blur', vizHideTip);
  return node;
}

function vizHover(node, readout) {
  node.addEventListener('pointerenter', (e) => vizShowTip(readout, e.clientX, e.clientY));
  node.addEventListener('pointermove', (e) => vizMoveTip(e.clientX, e.clientY));
  node.addEventListener('pointerleave', vizHideTip);
  return vizFocus(node, readout);
}

// Dense dots overlap, so the pointer only has to be nearest a dot, within the 24px a fingertip needs, not on it.
function vizNearest(svg, marks) {
  const reach = VIZ_HIT * 2;
  let hot = null;
  const heat = (node) => {
    hot?.classList.remove('hot');
    hot = node;
    hot?.classList.add('hot');
  };
  svg.addEventListener('pointermove', (e) => {
    const box = svg.getBoundingClientRect();
    const near = marks.reduce((best, m) => {
      const d = Math.hypot(m.x - (e.clientX - box.left), m.y - (e.clientY - box.top));
      return d < reach && (!best || d < best.d) ? { ...m, d } : best;
    }, null);
    heat(near?.node ?? null);
    if (near) vizShowTip(near.readout, e.clientX, e.clientY);
    else vizHideTip();
  });
  svg.addEventListener('pointerleave', () => {
    heat(null);
    vizHideTip();
  });
  return svg;
}

// Drawn at the width it last had, then again once it is on the page and its real width is known, so text never scales.
function vizPlot(id, draw) {
  const host = el('div', { class: 'viz-plot', 'data-viz': id });
  host.vizPaint = (width) => {
    vizWidths.set(id, width);
    host.replaceChildren(draw(width));
  };
  host.vizPaint(vizWidths.get(id) ?? VIZ_WIDTH);
  Promise.resolve().then(() => vizRefit(host));
  return host;
}

function vizRefit(host) {
  const width = Math.floor(host.clientWidth || 0);
  if (host.isConnected && width > 0 && width !== vizWidths.get(host.dataset.viz)) host.vizPaint(width);
}

addEventListener('resize', () => {
  clearTimeout(vizResizeTimer);
  vizResizeTimer = setTimeout(() => document.querySelectorAll('.viz-plot').forEach(vizRefit), 120);
});

function vizLegend(series) {
  return el('ul', { class: 'viz-legend' }, series.map(([label, tone]) => el('li', {}, el('span', { class: 'viz-swatch ' + tone }), label)));
}

const vizNumeric = (text) => /^[\d.,]+(?: ?(?:min|h|d|K))?$/.test(text);

function vizDisclosure(key, attrs, summary, ...body) {
  const keep = (e) => (e.currentTarget.open ? ui.open.add(key) : ui.open.delete(key));
  return el('details', { ...attrs, open: ui.open.has(key), ontoggle: keep }, summary, ...body);
}

function vizTable(id, head, rows) {
  const numeric = head.map((h, i) => i > 0 && rows.every((cells) => vizNumeric(cells[i])));
  return vizDisclosure('viz-table:' + id, { class: 'viz-table' }, el('summary', { id: 'viz-' + id + '-table' }, 'Table'),
    el('div', { class: 'tablewrap' }, el('table', {},
      el('thead', {}, el('tr', {}, head.map((h, i) => el('th', { scope: 'col', class: numeric[i] ? 'num' : null }, h)))),
      el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((c, i) => el(i ? 'td' : 'th', { scope: i ? null : 'row', class: numeric[i] ? 'num' : null }, c))))))));
}

function vizEmpty(text) {
  return el('p', { class: 'viz-empty' }, icon('info'), text);
}

function vizFigure({ id, title, sub, wide, legend, empty: none, draw, table }) {
  return el('figure', { class: 'viz' + (wide ? ' wide' : ''), id: 'viz-' + id },
    el('figcaption', {}, el('h3', {}, title), sub ? el('span', { class: 'meta' }, sub) : null),
    none ? vizEmpty(none) : [legend ? vizLegend(legend) : null, vizPlot(id, draw), table]);
}

function vizAxisY(ticks, y, left, right, label = vizCompact) {
  return ticks.map((t) => [
    t ? vizSvg('line', { class: 'viz-grid', x1: left, x2: right, y1: vizPx(y(t)), y2: vizPx(y(t)) }) : null,
    vizSvg('text', { class: 'viz-tick', x: left - 6, y: vizPx(y(t)), 'text-anchor': 'end', 'dominant-baseline': 'middle' }, label(t)),
  ]);
}

function vizColumns({ id, columns, tones, width, height = 190 }) {
  const pad = { top: 10, right: 6, bottom: 26, left: 32 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const ticks = vizTicks(Math.max(0, ...columns.map((c) => vizSum(c.values))));
  const y = (v) => pad.top + plotH - (v / ticks.at(-1)) * plotH;
  const band = plotW / Math.max(1, columns.length);
  const barW = Math.min(VIZ_BAR_MAX, band * 0.62);
  const every = Math.max(1, Math.ceil(46 / band));
  const baseline = y(0);
  return vizSvg('svg', { class: 'viz-svg', width, height, viewBox: `0 0 ${width} ${height}` },
    vizAxisY(ticks, y, pad.left, width - pad.right),
    columns.map((c, i) => vizStack(c.values, tones, pad.left + i * band + (band - barW) / 2, barW, y)),
    vizSvg('line', { class: 'viz-axis', x1: pad.left, x2: width - pad.right, y1: vizPx(baseline), y2: vizPx(baseline) }),
    columns.map((c, i) => ((columns.length - 1 - i) % every ? null
      : vizSvg('text', { class: 'viz-label', x: vizPx(pad.left + (i + 0.5) * band), y: height - 8, 'text-anchor': 'middle' }, c.label))),
    columns.map((c, i) => vizHover(vizSvg('rect', { class: 'viz-hit', id: 'viz-' + id + '-' + i, x: vizPx(pad.left + i * band), y: pad.top, width: vizPx(band), height: plotH }), c.readout)));
}

function vizStack(values, tones, x, w, y) {
  const last = values.findLastIndex((v) => v > 0);
  let base = 0;
  return values.map((v, j) => {
    if (!(v > 0)) return null;
    const top = y(base + v);
    const h = Math.max(1, y(base) - top - (j === last ? 0 : VIZ_GAP));
    base += v;
    return j === last
      ? vizSvg('path', { class: 'viz-mark ' + tones[j], d: vizColumnPath(x, top, w, h) })
      : vizSvg('rect', { class: 'viz-mark ' + tones[j], x: vizPx(x), y: vizPx(top), width: vizPx(w), height: vizPx(h) });
  });
}

function vizBars({ id, rows, width }) {
  const rowH = 30;
  const longest = Math.max(...rows.map((r) => r.label.length));
  const labelW = Math.min(Math.round(width * 0.42), Math.ceil(longest * VIZ_CHAR_PX) + 12);
  const plotW = Math.max(40, width - labelW - 44);
  const top = Math.max(1, ...rows.map((r) => vizSum(r.values)));
  const height = rows.length * rowH + 4;
  return vizSvg('svg', { class: 'viz-svg', width, height, viewBox: `0 0 ${width} ${height}` },
    rows.map((r, i) => vizBarRow(r, i * rowH, rowH, labelW, (v) => (v / top) * plotW)),
    vizSvg('line', { class: 'viz-axis', x1: labelW, x2: labelW, y1: 2, y2: height - 2 }),
    rows.map((r, i) => vizHover(vizSvg('rect', { class: 'viz-hit', id: 'viz-' + id + '-' + i, x: 0, y: i * rowH, width, height: rowH }), r.readout)));
}

function vizBarRow(row, top, rowH, labelW, x) {
  const mid = top + rowH / 2;
  const total = vizSum(row.values);
  const last = row.values.findLastIndex((v) => v > 0);
  let base = 0;
  const marks = row.values.map((v, j) => {
    if (!(v > 0)) return null;
    const left = labelW + x(base);
    const w = Math.max(1, x(v) - (j === last ? 0 : VIZ_GAP));
    base += v;
    const y = mid - VIZ_BAR_ROW / 2;
    return j === last
      ? vizSvg('path', { class: 'viz-mark ' + row.tones[j], d: vizBarPath(left, y, w, VIZ_BAR_ROW) })
      : vizSvg('rect', { class: 'viz-mark ' + row.tones[j], x: vizPx(left), y: vizPx(y), width: vizPx(w), height: VIZ_BAR_ROW });
  });
  return [
    vizSvg('text', { class: 'viz-label', x: labelW - 8, y: mid, 'text-anchor': 'end', 'dominant-baseline': 'middle' }, vizFit(row.label, labelW - 10)),
    marks,
    vizSvg('text', { class: 'viz-value', x: vizPx(labelW + x(total) + 6), y: mid, 'dominant-baseline': 'middle' }, vizCompact(total)),
  ];
}

function vizLogScale(values) {
  const lowest = Math.min(...values);
  const highest = Math.max(...values);
  const below = VIZ_DURATION_TICKS.filter(([ms]) => ms <= lowest).at(-1) ?? VIZ_DURATION_TICKS[0];
  const above = VIZ_DURATION_TICKS.find(([ms]) => ms >= highest && ms > below[0]) ?? VIZ_DURATION_TICKS.at(-1);
  const ticks = VIZ_DURATION_TICKS.filter(([ms]) => ms >= below[0] && ms <= above[0]);
  const [lo, hi] = [Math.log(below[0]), Math.log(above[0])];
  return { ticks, at: (ms) => (Math.log(Math.min(Math.max(ms, below[0]), above[0])) - lo) / (hi - lo) };
}

// Dots that would overlap are pushed off the centre line in turn, so every MR stays its own mark.
function vizSwarm(xs, pitch) {
  const placed = [];
  return xs.map((x) => {
    for (let n = 0; ; n += 1) {
      const offset = Math.ceil(n / 2) * pitch * (n % 2 ? -1 : 1);
      if (placed.every((p) => Math.hypot(p.x - x, p.offset - offset) >= pitch)) {
        placed.push({ x, offset });
        return offset;
      }
    }
  });
}

function vizDots({ id, points, median, width }) {
  const pad = { left: 14, right: 14, top: 24, bottom: 26 };
  const scale = vizLogScale([...points.map((p) => p.ms), median]);
  const x = (ms) => pad.left + scale.at(ms) * (width - pad.left - pad.right);
  const pitch = VIZ_DOT * 2 + VIZ_GAP;
  const order = points.map((p, i) => [x(p.ms), i]).sort((a, b) => a[0] - b[0]);
  const offsets = vizSwarm(order.map(([px]) => px), pitch);
  const spread = Math.max(pitch, ...offsets.map(Math.abs));
  const height = pad.top + spread * 2 + pitch + pad.bottom;
  const mid = pad.top + spread + pitch / 2;
  const place = new Map(order.map(([px, i], n) => [i, { x: px, y: mid + offsets[n] }]));
  const marks = points.map((p, i) => ({
    ...place.get(i),
    readout: p.readout,
    node: vizFocus(vizSvg('circle', { class: 'viz-dot viz-c1', id: 'viz-' + id + '-' + i, cx: vizPx(place.get(i).x), cy: vizPx(place.get(i).y), r: VIZ_DOT }), p.readout),
  }));
  const ticks = scale.ticks.filter((t, i) => (width - pad.left - pad.right) / scale.ticks.length >= 44 || i % 2 === 0);
  const medianX = vizPx(x(median));
  return vizNearest(vizSvg('svg', { class: 'viz-svg', width, height, viewBox: `0 0 ${width} ${height}` },
    ticks.map(([ms, label]) => [
      vizSvg('line', { class: 'viz-grid', x1: vizPx(x(ms)), x2: vizPx(x(ms)), y1: pad.top - 6, y2: height - pad.bottom }),
      vizSvg('text', { class: 'viz-tick', x: vizPx(x(ms)), y: height - 8, 'text-anchor': 'middle' }, label),
    ]),
    vizSvg('line', { class: 'viz-median', x1: medianX, x2: medianX, y1: pad.top - 6, y2: height - pad.bottom }),
    vizSvg('text', { class: 'viz-value', x: medianX, y: pad.top - 10, 'text-anchor': medianX > width - 90 ? 'end' : medianX < 90 ? 'start' : 'middle' }, 'median ' + vizDuration(median)),
    marks.map((m) => m.node)), marks);
}
