const FLOAT_EDGE = 8;
const FLOAT_INSET = 24;
const FLOAT_NARROW = '(max-width: 640px)';

const floatClamp = (n, low, high) => Math.max(low, Math.min(high, n));

function floatNarrow() {
  return typeof matchMedia === 'function' && matchMedia(FLOAT_NARROW).matches;
}

function floatLoad(key) {
  try {
    const kept = JSON.parse(localStorage.getItem(key) ?? 'null');
    return kept && typeof kept === 'object' ? kept : {};
  } catch {
    return {};
  }
}

function floatSave(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function floatFit(box, place, { min, size }) {
  if (!box) return;
  const vw = window.innerWidth || 1400;
  const vh = window.innerHeight || 900;
  const w = floatClamp(Number(place.w) || size.w, min.w, Math.max(min.w, vw - 2 * FLOAT_EDGE));
  const h = floatClamp(Number(place.h) || size.h, min.h, Math.max(min.h, vh - 2 * FLOAT_EDGE));
  const x = floatClamp(Number.isFinite(place.x) ? place.x : vw - w - FLOAT_INSET, FLOAT_EDGE, Math.max(FLOAT_EDGE, vw - w - FLOAT_EDGE));
  const y = floatClamp(Number.isFinite(place.y) ? place.y : vh - h - FLOAT_INSET, FLOAT_EDGE, Math.max(FLOAT_EDGE, vh - h - FLOAT_EDGE));
  Object.assign(box.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' });
}

function floatDrag(e, how, host, onPlace) {
  if (floatNarrow() || e.button !== 0 || (how === 'move' && e.target.closest('button'))) return;
  e.preventDefault();
  const start = { x: e.clientX, y: e.clientY, rect: host.getBoundingClientRect() };
  let rect = null;
  const move = (m) => {
    const { left, top, width, height } = start.rect;
    const dx = m.clientX - start.x;
    const dy = m.clientY - start.y;
    rect = how === 'move' ? { x: left + dx, y: top + dy, w: width, h: height } : { x: left, y: top, w: width + dx, h: height + dy };
    onPlace(rect, false);
  };
  const end = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    host.classList.remove('moving');
    onPlace(rect, true);
  };
  host.classList.add('moving');
  addEventListener('pointermove', move);
  addEventListener('pointerup', end);
}

// The panel last used is drawn over the others, which drop to the drawer's level and so stay above it.
function floatFront(host) {
  for (const other of document.querySelectorAll('.float')) other.classList.toggle('float-back', other !== host);
}

function floatFrontOnUse(host) {
  host.addEventListener('pointerdown', () => floatFront(host), true);
  host.addEventListener('focusin', () => floatFront(host));
}
