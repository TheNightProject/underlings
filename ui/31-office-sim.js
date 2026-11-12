const OFFICE_CELL = 0.25;
const OFFICE_ROW_PODS = 6;
const OFFICE_MIN_PODS = 6;
const OFFICE_SPARE_PODS = 2;
const OFFICE_TURN_MS = 45000;
const OFFICE_DUO_TURN_MS = 600000;
const OFFICE_CHEER_S = 1.4;
const OFFICE_WALK = 1.35;
const OFFICE_REACH = 0.04;
const OFFICE_BODY_R = 0.2;
const OFFICE_POD_PITCH = 1.45;
const OFFICE_POD_X0 = 1.95;
const OFFICE_ROW_GAP = 2.6;
const OFFICE_LOUNGE_X = 10.3;
const OFFICE_DESK = { w: 1.2, d: 0.62, h: 0.56 };
const OFFICE_TABLE = { x: 12.35, z: 4.05, w: 1.3, l: 2.3, h: 0.62 };
const OFFICE_SHOT_MS = 950;
const OFFICE_MISS_EVERY = [6, 19];
const OFFICE_LONG_RALLY = { chance: 0.12, hits: [20, 36] };
const OFFICE_ADDON_SPOTS = { 'office-fridge': { x: 0.32, z: 3.45, w: 0.44, d: 0.46 } };

function officeHash(text) {
  let h = 2166136261;
  for (const c of String(text)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function officeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function officeRole(a) {
  if (a.outcome === 'stopped' && !a.alive) return 'leave';
  if (a.state === 'working') return 'pod';
  return isNeed(a) ? 'wave' : 'idle';
}

function officeMemory() {
  return { order: new Map(), seq: 0, pods: new Map(), pair: null, idle: new Map() };
}

function officeRemember(memory, agents) {
  const present = new Set(agents.map((a) => a.handle));
  for (const handle of [...memory.order.keys()]) {
    if (present.has(handle)) continue;
    memory.order.delete(handle);
    memory.pods.delete(handle);
  }
  for (const a of agents) if (!memory.order.has(a.handle)) memory.order.set(a.handle, memory.seq++);
}

function officePlan(agents, memory, now, floor = officeFloor()) {
  officeRemember(memory, agents);
  const L = memory.L?.floor === floor ? memory.L : (memory.L = officeLayout(floor.capacity, floor));
  const byArrival = (list) => [...list].sort((a, b) => memory.order.get(a.handle) - memory.order.get(b.handle));
  const roles = new Map(agents.map((a) => [a.handle, officeRole(a)]));
  const seated = byArrival(agents.filter((a) => roles.get(a.handle) === 'pod' || roles.get(a.handle) === 'wave'));
  const idleAll = agents.filter((a) => roles.get(a.handle) === 'idle').sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  const idle = byArrival(idleAll.slice(0, floor.idleShown));
  const { pods, over } = officeAssignPods(seated, memory, floor.capacity);
  const places = new Map();
  const used = new Set();
  for (const [pod, handle] of pods) places.set(handle, { role: roles.get(handle), spot: (roles.get(handle) === 'pod' ? 'pod:' : 'stand:') + pod, pod });
  for (const [handle, spot] of officeHot(over, L, used)) places.set(handle, { role: roles.get(handle), spot, activity: spot === 'door' ? 'remote' : 'hot' });
  const pairs = officeDuos(idle.filter((a) => !a.player), memory, now, floor, L, used);
  for (const [act, pair] of Object.entries(pairs)) pair.forEach((handle, end) => places.set(handle, { role: 'idle', spot: act + ':' + end, activity: act }));
  const paired = new Set(Object.values(pairs).flat());
  const rest = idle.filter((a) => !paired.has(a.handle));
  for (const [handle, spot] of officeActivities(rest, memory, now, L, used)) places.set(handle, { role: 'idle', spot, activity: spot.split(':')[0] });
  for (const a of agents) if (!places.has(a.handle)) places.set(a.handle, { role: roles.get(a.handle) === 'leave' ? 'leave' : 'home', spot: 'door' });
  return { pods: officePodCount(seated.length, pods, floor), places, pair: pairs.ping ?? null, pairs };
}

function officePodCount(seated, pods, floor) {
  if (floor.capacity > OFFICE_PODS_PER_ROOM) return floor.capacity;
  return Math.min(floor.capacity, Math.max(OFFICE_MIN_PODS, seated + OFFICE_SPARE_PODS, ...[...pods.keys()].map((i) => i + 1)));
}

// A newcomer passes over pods idle agents still hold, so one called back to work finds its own desk free.
function officeAssignPods(seated, memory, capacity) {
  const taken = new Map();
  const newcomers = [];
  for (const a of seated) {
    const mine = memory.pods.get(a.handle);
    if (mine != null && mine < capacity && !taken.has(mine)) taken.set(mine, a.handle);
    else newcomers.push(a);
  }
  const held = new Set([...memory.pods].filter(([handle]) => !seated.some((a) => a.handle === handle)).map(([, pod]) => pod));
  const room = Math.min(capacity, Math.max(OFFICE_MIN_PODS, seated.length + OFFICE_SPARE_PODS));
  const over = [];
  for (const a of newcomers) {
    const pod = officeFreePod(taken, held, room, capacity);
    if (pod < 0) {
      over.push(a);
      continue;
    }
    taken.set(pod, a.handle);
    memory.pods.set(a.handle, pod);
  }
  return { pods: taken, over };
}

function officeFreePod(taken, held, room, capacity) {
  for (let i = 0; i < room; i++) if (!taken.has(i) && !held.has(i)) return i;
  for (let i = 0; i < capacity; i++) if (!taken.has(i)) return i;
  return -1;
}

function officeHot(over, L, used) {
  const out = new Map();
  const free = Array.from({ length: L.hot ?? 0 }, (_, i) => 'hot:' + i);
  for (const a of over) {
    const spot = free.find((key) => !used.has(officeBase(L, key)));
    out.set(a.handle, spot ?? 'door');
    if (spot) used.add(officeBase(L, spot));
  }
  return out;
}

const officeBase = (L, spot) => L.alias?.[spot] ?? spot;

// Table tennis always comes first, and the other games take turns, so a busy lounge plays more than one and still has room for the rest.
function officeDuos(idle, memory, now, floor, L, used) {
  let free = idle.map((a) => a.handle);
  const most = free.length < 2 ? 0 : free.length < 5 ? 1 : free.length < 8 ? 2 : 3;
  const others = floor.duos.slice(1);
  const turn = Math.floor(now / OFFICE_DUO_TURN_MS);
  const order = ['ping', ...others.map((_, i) => others[(i + turn) % others.length])];
  const pairs = {};
  for (const act of order) {
    const ends = [act + ':0', act + ':1'].map((spot) => officeBase(L, spot));
    if (Object.keys(pairs).length >= most || !L.spots[act + ':0'] || ends.some((spot) => used.has(spot))) continue;
    const pair = officePair(free, (memory.pairs ?? {})[act]);
    if (!pair) continue;
    pairs[act] = pair;
    free = free.filter((h) => !pair.includes(h));
    ends.forEach((spot) => used.add(spot));
  }
  memory.pairs = pairs;
  memory.pair = pairs.ping ?? null;
  return pairs;
}

// A player whose partner is called away keeps its end of the table, so it does not walk round to the other.
function officePair(handles, was) {
  const pair = (was ?? [null, null]).map((h) => (handles.includes(h) ? h : null));
  const free = handles.filter((h) => !pair.includes(h));
  for (const end of [0, 1]) pair[end] ??= free.shift() ?? null;
  return pair.every(Boolean) ? pair : null;
}

function officeTurnOf(handle, now) {
  return Math.floor((now + (officeHash(handle) % OFFICE_TURN_MS)) / OFFICE_TURN_MS);
}

function officePrefs(handle, turn, prefs) {
  const start = (officeHash(handle) + turn) % prefs.length;
  return [...prefs.slice(start), ...prefs.slice(0, start)];
}

// Each idle agent keeps its spot until its own turn comes round, so one going idle never moves the others along.
function officeActivities(rest, memory, now, L, used) {
  const out = new Map();
  for (const a of rest) {
    const was = memory.idle.get(a.handle);
    if (!was || was.turn !== officeTurnOf(a.handle, now) || !L.spots[was.spot] || used.has(officeBase(L, was.spot))) continue;
    out.set(a.handle, was.spot);
    used.add(officeBase(L, was.spot));
  }
  for (const a of rest) if (!out.has(a.handle)) officeChoose(a, rest, out, used, now, L);
  memory.idle = new Map([...out].map(([handle, spot]) => [handle, { spot, turn: officeTurnOf(handle, now) }]));
  return out;
}

function officeChoose(a, rest, out, used, now, L) {
  for (const act of officePrefs(a.handle, officeTurnOf(a.handle, now), officeIdlePrefs(a.prefs ?? OFFICE_BASE_ACTS, L.floor))) {
    const spots = officeFreeSpots(L, act, used);
    const mate = act === 'chat' ? rest.find((b) => b !== a && !out.has(b.handle)) : null;
    if (!spots.length || (act === 'chat' && (!mate || spots.length < 2))) continue;
    out.set(a.handle, spots[0]);
    used.add(officeBase(L, spots[0]));
    if (mate) {
      out.set(mate.handle, spots[1]);
      used.add(officeBase(L, spots[1]));
    }
    return;
  }
}

function officeFreeSpots(L, act, used) {
  return Array.from({ length: officeSpotCount(L, act) }, (_, i) => act + ':' + i).filter((spot) => !used.has(officeBase(L, spot)));
}

function officeRows(pods) {
  return Math.ceil(pods / OFFICE_ROW_PODS);
}

function officeLayout(pods, floor = [], rooms = []) {
  if (Array.isArray(floor)) floor = officeFloor(floor, rooms);
  const kitchen = floor.rooms.includes('room-kitchen');
  const d = OFFICE_STARTER.z1;
  const bossZ = d - 2.25;
  const doorZ = d - 1.35;
  const rects = officeRoomRects(floor);
  const layout = {
    w: Math.max(...rects.map((r) => r.x1)), d: Math.max(...rects.map((r) => r.z1)), rooms: rects, floor, walls: officeWallsFor(floor),
    pods: Array.from({ length: pods }, (_, i) => officePodPlace(i)), rows: officeRows(Math.min(pods, OFFICE_PODS_PER_ROOM)),
    boss: { x: OFFICE_POD_X0 + 2.5 * OFFICE_POD_PITCH, z: bossZ, w: 2.3, dd: 0.85, h: 0.6 },
    door: { z: doorZ, inside: { x: 0.7, z: doorZ }, outside: { x: -0.6, z: doorZ } },
    table: OFFICE_TABLE,
    sofa: { x: 11.75, z: 0.5, w: 2.3, dd: 0.8 },
    coffee: kitchen ? null : { x: 13.55, z: 0.45, w: 1.1, dd: 0.62, h: 0.92 },
    chat: { x: 10.6, z: d - 1.25, r: 0.32 },
    board: { z: 2.2, w: 1.6 },
    plants: [[10.25, 0.45, 1.2], [13.75, d - 0.45, 1.35], [0.5, doorZ - 1.05, 1], ...(kitchen ? [] : [[13.85, 1.6, 0.9]])],
  };
  layout.spots = officeSpots(layout);
  const furnished = officeFurnish(layout, floor);
  layout.alias = furnished.alias;
  layout.blocks = [...officeBlocks(layout), ...furnished.blocks, ...officeWallBlocks(layout.walls), ...(floor.addons ?? []).filter((id) => OFFICE_ADDON_SPOTS[id]).map((id) => officeAddonBlock(OFFICE_ADDON_SPOTS[id]))];
  return layout;
}

function officePodPlace(i) {
  const row = Math.floor(i / OFFICE_ROW_PODS);
  const z = i < OFFICE_PODS_PER_ROOM ? 0.62 + row * OFFICE_ROW_GAP : 9.3 + (row - 2) * OFFICE_ROW_GAP;
  return officePod(i, OFFICE_POD_X0 + (i % OFFICE_ROW_PODS) * OFFICE_POD_PITCH, z);
}

function officeAddonBlock({ x, z, w, d }) {
  return { x0: x - d / 2, x1: x + d / 2, z0: z - w / 2, z1: z + w / 2 };
}

function officePod(i, x, z) {
  return { i, x, z, seat: { x, z: z + 0.66 }, stand: { x: x + 0.62, z: z + 0.95 } };
}

function officeBlocks(L) {
  const box = (x, z, w, d) => ({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2 });
  return [
    ...L.pods.map((p) => box(p.x, p.z, OFFICE_DESK.w, OFFICE_DESK.d)),
    box(L.boss.x, L.boss.z, L.boss.w, L.boss.dd),
    box(L.table.x, L.table.z, L.table.w, L.table.l),
    box(L.sofa.x, L.sofa.z, L.sofa.w, L.sofa.dd),
    ...(L.coffee ? [box(L.coffee.x, L.coffee.z, L.coffee.w, L.coffee.dd)] : []),
    box(L.chat.x, L.chat.z, L.chat.r * 2, L.chat.r * 2),
    ...L.plants.map(([x, z, s]) => box(x, z, 0.55 * s, 0.55 * s)),
  ];
}

function officeSpots(L) {
  const spots = { door: { x: L.door.outside.x, z: L.door.outside.z, facing: -Math.PI / 2, pose: 'walk', via: [L.door.inside] } };
  const t = L.table;
  for (const p of L.pods) {
    spots['pod:' + p.i] = { ...p.seat, facing: Math.PI, pose: 'type', via: [{ x: p.x, z: p.z + 1.2 }] };
    spots['stand:' + p.i] = { ...p.stand, facing: Math.PI / 4, pose: 'wave' };
  }
  spots['ping:0'] = { x: t.x, z: t.z - t.l / 2 - 0.45, facing: 0, pose: 'play' };
  spots['ping:1'] = { x: t.x, z: t.z + t.l / 2 + 0.45, facing: Math.PI, pose: 'play' };
  if (L.coffee) spots['coffee:0'] = { x: L.coffee.x - 0.1, z: L.coffee.z + 0.78, facing: Math.PI, pose: 'sip' };
  for (let i = 0; i < 3; i++) spots['sofa:' + i] = { x: L.sofa.x + (i - 1) * 0.72, z: L.sofa.z + 0.14, facing: 0, pose: 'lounge', via: [{ x: L.sofa.x + (i - 1) * 0.72, z: L.sofa.z + 0.95 }] };
  spots['chat:0'] = { x: L.chat.x - 0.62, z: L.chat.z, facing: Math.PI / 2, pose: 'chat' };
  spots['chat:1'] = { x: L.chat.x + 0.62, z: L.chat.z, facing: -Math.PI / 2, pose: 'chat' };
  spots['board:0'] = { x: 0.62, z: L.board.z, facing: -Math.PI / 2, pose: 'draw' };
  spots.boss = { x: L.boss.x, z: L.boss.z + 0.72, facing: Math.PI, pose: 'type' };
  spots['boss:rest'] = { ...spots.boss, pose: 'relax' };
  spots['boss:stand'] = { x: L.boss.x + L.boss.w / 2 + 0.45, z: L.boss.z + 0.55, facing: Math.PI / 4, pose: 'wave' };
  const d = OFFICE_STARTER.z1;
  [[OFFICE_LOUNGE_X - 0.1, 2.6], [8.4, d - 0.9], [OFFICE_LOUNGE_X + 2.9, d - 1.0], [1.7, d - 0.8]].forEach(([x, z], i) => {
    spots['wander:' + i] = { x, z, facing: Math.PI / 4, pose: 'stand' };
  });
  return spots;
}

function officeGrid(layout) {
  const x0 = -1;
  const cols = Math.ceil((layout.w - x0) / OFFICE_CELL);
  const rows = Math.ceil(layout.d / OFFICE_CELL);
  const grid = { x0, cols, rows, blocked: new Uint8Array(cols * rows) };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) grid.blocked[r * cols + c] = officeOutside(layout, officeCellCentre(grid, c, r)) ? 1 : 0;
  }
  for (const b of layout.blocks) officeMarkBlock(grid, b);
  return grid;
}

function officeMarkBlock(grid, b) {
  const pad = OFFICE_BODY_R;
  for (let r = Math.max(0, Math.floor((b.z0 - pad) / OFFICE_CELL)); r < grid.rows && (r + 0.5) * OFFICE_CELL < b.z1 + pad; r++) {
    for (let c = Math.max(0, Math.floor((b.x0 - pad - grid.x0) / OFFICE_CELL)); c < grid.cols && grid.x0 + (c + 0.5) * OFFICE_CELL < b.x1 + pad; c++) {
      const p = officeCellCentre(grid, c, r);
      if (p.x > b.x0 - pad && p.z > b.z0 - pad) grid.blocked[r * grid.cols + c] = 1;
    }
  }
}

function officeCellCentre(grid, c, r) {
  return { x: grid.x0 + (c + 0.5) * OFFICE_CELL, z: (r + 0.5) * OFFICE_CELL };
}

// A point is inside when a body round it fits within the rooms built, so the seam between two rooms is open floor.
function officeOutside(layout, p) {
  const pad = OFFICE_BODY_R;
  const rooms = layout.rooms ?? [{ x0: 0, x1: layout.w, z0: 0, z1: layout.d }];
  const within = (x, z) => rooms.some((r) => x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1);
  if ([[-pad, -pad], [pad, -pad], [-pad, pad], [pad, pad]].every(([dx, dz]) => within(p.x + dx, p.z + dz))) return false;
  return !(p.x < pad && Math.abs(p.z - layout.door.z) < 0.5 - pad / 2 && p.x > layout.door.outside.x - 0.4);
}

function officeCellOf(grid, p) {
  return officeCellAt(grid, Math.floor((p.x - grid.x0) / OFFICE_CELL), Math.floor(p.z / OFFICE_CELL));
}

const officeCellFree = (grid, cell) => cell >= 0 && !grid.blocked[cell];

// A start or end inside furniture is moved to the nearest open cell, so a seat or a spot by a desk is always reachable.
function officeNearestOpen(grid, cell) {
  if (officeCellFree(grid, cell)) return cell;
  for (let ring = 1; ring < 8; ring++) {
    const open = officeRing(grid, cell, ring).find((c) => officeCellFree(grid, c));
    if (open !== undefined) return open;
  }
  return -1;
}

function officeRing(grid, cell, ring) {
  const c0 = cell % grid.cols;
  const r0 = Math.floor(cell / grid.cols);
  const cells = [];
  for (let dr = -ring; dr <= ring; dr++) {
    for (let dc = -ring; dc <= ring; dc++) if (Math.max(Math.abs(dr), Math.abs(dc)) === ring) cells.push(officeCellAt(grid, c0 + dc, r0 + dr));
  }
  return cells;
}

function officeCellAt(grid, c, r) {
  return c >= 0 && r >= 0 && c < grid.cols && r < grid.rows ? r * grid.cols + c : -1;
}

function officePath(grid, from, to) {
  const start = officeNearestOpen(grid, officeCellOf(grid, from));
  const goal = officeNearestOpen(grid, officeCellOf(grid, to));
  if (start < 0 || goal < 0) return null;
  const cells = officeAStar(grid, start, goal);
  if (!cells) return null;
  const points = cells.map((cell) => officeCellCentre(grid, cell % grid.cols, Math.floor(cell / grid.cols)));
  return officeSmooth(grid, [from, ...points.slice(1, -1), to]);
}

const OFFICE_STEPS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

function officeAStar(grid, start, goal) {
  const { cols } = grid;
  const gc = goal % cols;
  const gr = Math.floor(goal / cols);
  const guess = (cell) => Math.hypot((cell % cols) - gc, Math.floor(cell / cols) - gr);
  const cost = new Float32Array(cols * grid.rows).fill(Infinity);
  const from = new Int32Array(cols * grid.rows).fill(-1);
  const open = officeHeap();
  cost[start] = 0;
  open.push(start, guess(start));
  while (open.size()) {
    const cell = open.pop();
    if (cell === goal) return officeTrace(from, goal);
    for (const next of officeNeighbours(grid, cell)) {
      const g = cost[cell] + next.step;
      if (g >= cost[next.cell]) continue;
      cost[next.cell] = g;
      from[next.cell] = cell;
      open.push(next.cell, g + guess(next.cell));
    }
  }
  return null;
}

// A diagonal step needs both cells beside it open, so nobody cuts the corner of a desk.
function officeNeighbours(grid, cell) {
  const c = cell % grid.cols;
  const r = Math.floor(cell / grid.cols);
  const at = (dc, dr) => officeCellAt(grid, c + dc, r + dr);
  return OFFICE_STEPS.filter(([dc, dr]) => officeCellFree(grid, at(dc, dr)) && (dc === 0 || dr === 0 || (officeCellFree(grid, at(dc, 0)) && officeCellFree(grid, at(0, dr)))))
    .map(([dc, dr, step]) => ({ cell: at(dc, dr), step }));
}

function officeTrace(from, goal) {
  const cells = [goal];
  while (from[cells[0]] >= 0) cells.unshift(from[cells[0]]);
  return cells;
}

function officeHeap() {
  const items = [];
  const swap = (i, j) => ([items[i], items[j]] = [items[j], items[i]]);
  const up = (i) => {
    for (let p = (i - 1) >> 1; i > 0 && items[p][1] > items[i][1]; i = p, p = (i - 1) >> 1) swap(i, p);
  };
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1;
      const best = [i, l, l + 1].filter((k) => k < items.length).reduce((a, b) => (items[b][1] < items[a][1] ? b : a));
      if (best === i) return;
      swap(i, best);
      i = best;
    }
  };
  return {
    size: () => items.length,
    push(cell, score) { items.push([cell, score]); up(items.length - 1); },
    pop() { const top = items[0][0]; const last = items.pop(); if (items.length) { items[0] = last; down(0); } return top; },
  };
}

function officeSmooth(grid, points) {
  const out = [points[0]];
  let at = 0;
  while (at < points.length - 1) {
    let next = points.length - 1;
    while (next > at + 1 && !officeClear(grid, points[at], points[next])) next--;
    out.push(points[next]);
    at = next;
  }
  return out;
}

function officeClear(grid, a, b) {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (OFFICE_CELL / 3));
  for (let i = 1; i < n; i++) {
    const p = { x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n };
    if (!officeCellFree(grid, officeCellOf(grid, p))) return false;
  }
  return true;
}

function officeScene() {
  return { memory: officeMemory(), actors: new Map(), layout: null, grid: null, pods: 0, rally: officeRallyNew(1), started: false, boss: null, door: 0 };
}

function officeSync(scene, agents, now, { still = false } = {}) {
  const floor = officeFloorOf(scene, still);
  const plan = officePlan(agents, scene.memory, now, floor);
  if (plan.pods !== scene.pods || floor !== scene.layout?.floor) officeRelayout(scene, plan.pods, still, floor);
  const arriving = scene.started && !still;
  for (const a of agents) officeSyncActor(scene, a, plan.places.get(a.handle), { arriving, still, now });
  for (const actor of scene.actors.values()) if (!plan.places.has(actor.handle)) officeSend(scene, actor, { role: 'home', spot: 'door' }, still);
  officePrune(scene);
  scene.started = true;
  scene.plan = plan;
  return plan;
}

// A room built while the office is on screen is noted with the time, so it can be seen going up; one there from the start just stands.
function officeFloorOf(scene, still) {
  const key = (scene.addons ?? []).join() + '|' + (scene.rooms ?? []).join();
  if (scene.floor?.key === key) return scene.floor;
  const floor = { ...officeFloor(scene.addons, scene.rooms), key };
  const before = scene.floor?.rooms;
  scene.building = new Map([...(scene.building ?? [])].filter(([id]) => floor.rooms.includes(id)));
  if (before && scene.started && !still) for (const id of floor.rooms.filter((r) => !before.includes(r))) scene.building.set(id, scene.clock ?? 0);
  scene.floor = floor;
  return floor;
}

// A bigger room keeps every pod where it was, so only someone whose spot moved, or who is on the way, sets off again.
function officeRelayout(scene, pods, still, floor = officeFloorOf(scene, still)) {
  scene.pods = pods;
  scene.layout = officeLayout(pods, floor);
  scene.grid = officeGrid(scene.layout);
  for (const actor of [...scene.actors.values(), scene.boss].filter(Boolean)) {
    const spot = scene.layout.spots[actor.spot];
    if (!spot) continue;
    if (still) officePlace(scene, actor);
    else if (actor.path.length || Math.hypot(spot.x - actor.x, spot.z - actor.z) > OFFICE_REACH) officeRoute(scene, actor, actor.spot);
  }
}

function officeSyncActor(scene, a, place, { arriving, still, now }) {
  let actor = scene.actors.get(a.handle);
  if (!actor && place.spot === 'door') return;
  if (!actor) {
    actor = officeActor(a, arriving ? scene.layout.door.outside : scene.layout.spots[place.spot]);
    scene.actors.set(a.handle, actor);
  }
  actor.agent = a;
  officeFeel(scene, actor, a, place, now);
  officeSend(scene, actor, place, !arriving);
}

// One seen waving and now sent to work was answered, so it stops to cheer before it walks back to its desk.
function officeFeel(scene, actor, a, place, now) {
  if (actor.role === 'wave' && place.role === 'pod') Object.assign(actor, { answeredAt: now, hold: OFFICE_CHEER_S });
  actor.mood = moodOf(a, now, scene.limits, actor.answeredAt);
}

function officeActor(a, at) {
  return { handle: a.handle, agent: a, x: at.x, z: at.z, facing: at.facing ?? 0, path: [], spot: null, role: null, pose: 'stand', t: 0, gone: false, pulse: 0, lastAt: a.lastAt || 0 };
}

function officeSend(scene, actor, place, still) {
  actor.role = place.role;
  actor.activity = place.activity ?? null;
  if (actor.spot === place.spot) return;
  actor.spot = place.spot;
  if (still) return officePlace(scene, actor);
  officeRoute(scene, actor, place.spot);
}

function officePlace(scene, actor) {
  const spot = scene.layout.spots[actor.spot];
  Object.assign(actor, { x: spot.x, z: spot.z, facing: spot.facing, path: [], pose: spot.pose, t: 0, gone: actor.spot === 'door' });
}

function officeRoute(scene, actor, key) {
  const spot = scene.layout.spots[key];
  const via = spot.via ?? [];
  const legs = [{ x: actor.x, z: actor.z }, ...via, spot];
  const path = [];
  for (let i = 1; i < legs.length; i++) {
    const leg = i === legs.length - 1 && via.length ? [legs[i - 1], legs[i]] : officePath(scene.grid, legs[i - 1], legs[i]) ?? [legs[i - 1], legs[i]];
    path.push(...leg.slice(1));
  }
  Object.assign(actor, { path, pose: 'walk', gone: false, lane: 0, swing: 0 });
}

function officeStep(scene, dt) {
  for (const actor of scene.actors.values()) officeStepActor(scene, actor, dt);
  officePrune(scene);
  if (scene.boss) officeStepActor(scene, scene.boss, dt);
  officeRallyStep(scene, dt);
  officeDoorStep(scene, dt);
}

function officePrune(scene) {
  for (const [handle, actor] of scene.actors) if (actor.gone) scene.actors.delete(handle);
}

function officeDoorStep(scene, dt) {
  const z = scene.layout.door.z;
  const near = [...scene.actors.values()].some((a) => a.path.length && Math.hypot(a.x, a.z - z) < 1.2);
  scene.door += ((near ? 1 : 0) - scene.door) * Math.min(1, dt * 5);
}

const OFFICE_BOSS_SPOTS = { pod: 'boss', wave: 'boss:stand', idle: 'boss:rest' };

function officeBossRole(main) {
  if (main?.ask || main?.asking) return 'wave';
  return main?.state === 'working' ? 'pod' : 'idle';
}

function officeSyncBoss(scene, main, { still = false, now = Date.now() } = {}) {
  const role = officeBossRole(main);
  const spot = OFFICE_BOSS_SPOTS[role];
  if (!scene.boss) scene.boss = { ...officeActor({ handle: 'office:manager' }, scene.layout.spots[spot]), manager: true };
  scene.boss.agent = main;
  officeFeel(scene, scene.boss, { ...main, state: role === 'wave' ? 'waiting' : main?.state }, { role }, now);
  officeSend(scene, scene.boss, { role, spot }, still || !scene.boss.spot);
  return scene.boss;
}

function officeStepActor(scene, actor, dt) {
  actor.t += dt;
  actor.pulse = Math.max(0, actor.pulse - dt * 1.6);
  if (actor.hold > 0) return void (actor.hold -= dt);
  if (!actor.path.length) return officeSettle(scene, actor, dt);
  const next = actor.path[0];
  const dx = next.x - actor.x;
  const dz = next.z - actor.z;
  const far = Math.hypot(dx, dz);
  const step = OFFICE_WALK * dt;
  if (far > OFFICE_REACH) actor.facing = officeTurn(actor.facing, Math.atan2(dx, dz), dt * 10);
  if (far <= step) {
    Object.assign(actor, { x: next.x, z: next.z });
    actor.path.shift();
    if (!actor.path.length) officeArrive(scene, actor);
    return;
  }
  actor.x += (dx / far) * step;
  actor.z += (dz / far) * step;
}

function officeArrive(scene, actor) {
  const spot = scene.layout.spots[actor.spot];
  actor.pose = spot.pose;
  actor.t = 0;
  if (actor.spot === 'door') actor.gone = true;
}

function officeSettle(scene, actor, dt) {
  const spot = scene.layout.spots[actor.spot];
  if (spot) actor.facing = officeTurn(actor.facing, spot.facing, dt * 6);
}

function officeTurn(from, to, amount) {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * Math.min(1, amount);
}

function officeRallyNew(seed) {
  return { from: 0, t: 0, count: 0, best: 0, missAt: OFFICE_MISS_EVERY[0], rand: officeRandom(seed), lane: [0, 0], miss: false, playing: false, rest: 0 };
}

function officePlayers(scene) {
  const pair = scene.plan?.pair;
  if (!pair) return null;
  const players = pair.map((h) => scene.actors.get(h));
  return players.every((p) => p && !p.path.length && p.pose === 'play') ? players : null;
}

function officeRallyStep(scene, dt) {
  const rally = scene.rally;
  rally.playing = Boolean(officePlayers(scene));
  if (!rally.playing) return Object.assign(rally, { count: 0, t: 0, miss: false, rest: 0, lane: [0, 0] });
  if (rally.rest > 0) return (rally.rest -= dt * 1000);
  rally.t += dt * 1000;
  if (rally.t < OFFICE_SHOT_MS) return;
  if (rally.miss) return officeRallyServe(rally);
  rally.t -= OFFICE_SHOT_MS;
  rally.from = 1 - rally.from;
  rally.count += 1;
  rally.best = Math.max(rally.best, rally.count);
  rally.lane = [rally.lane[1], (rally.rand() - 0.5) * 0.8];
  rally.miss = rally.count >= rally.missAt;
}

// Now and then a rally runs long, so twenty in a row happens but stays rare.
function officeRallyServe(rally) {
  const [low, high] = rally.rand() < OFFICE_LONG_RALLY.chance ? OFFICE_LONG_RALLY.hits : OFFICE_MISS_EVERY;
  Object.assign(rally, { t: 0, count: 0, miss: false, rest: 900, missAt: low + Math.floor(rally.rand() * (high - low)), lane: [0, (rally.rand() - 0.5) * 0.8] });
}

function officeBall(scene) {
  const rally = scene.rally;
  if (!rally.playing || rally.rest > 0) return null;
  const t = scene.layout.table;
  const u = Math.min(1, rally.t / OFFICE_SHOT_MS);
  const dir = rally.from === 0 ? 1 : -1;
  const z0 = t.z - (dir * t.l) / 2 - dir * 0.3;
  const reach = rally.miss ? t.l + 1.8 : t.l + 0.6;
  const x = t.x + rally.lane[0] + (rally.lane[1] - rally.lane[0]) * u;
  const z = z0 + dir * reach * u;
  return { x, y: officeBallHeight(t.h, u, rally.miss), z };
}

function officeBallHeight(top, u, miss) {
  const bounce = 0.62;
  if (u < bounce) return top + 0.03 + 0.28 * Math.sin((Math.PI * u) / bounce) + 0.2 * (1 - u / bounce);
  const v = (u - bounce) / (1 - bounce);
  return miss ? Math.max(0.03, top + 0.03 + 0.25 * Math.sin(Math.PI * v * 0.7) - 0.9 * v * v) : top + 0.03 + 0.3 * Math.sin(Math.PI * v * 0.75);
}
