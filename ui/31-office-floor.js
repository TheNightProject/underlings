const OFFICE_STARTER = { id: 'starter', x0: 0, x1: 14.2, z0: 0, z1: 8.4, floor: 'floor' };
const OFFICE_ROOMS = {
  'room-kitchen': { x0: 14.2, x1: 19.4, z0: 0, z1: 4.2, floor: 'tile' },
  'room-games': { x0: 14.2, x1: 19.4, z0: 4.2, z1: 8.4, floor: 'carpet' },
  'room-extension': { x0: 0, x1: 14.2, z0: 8.4, z1: 13.8, floor: 'floor' },
  'room-terrace': { x0: 14.2, x1: 19.4, z0: 8.4, z1: 13.8, floor: 'deck', needs: ['room-games', 'room-extension'] },
};
const OFFICE_ROOM_IDS = Object.keys(OFFICE_ROOMS);
const OFFICE_EDGES = [
  { a: 'starter', b: 'room-kitchen', x: 14.2, from: 0, to: 4.2, doors: [[1.2, 2.3]] },
  { a: 'starter', b: 'room-games', x: 14.2, from: 4.2, to: 8.4, doors: [[5.7, 6.8]] },
  { a: 'room-kitchen', b: 'room-games', z: 4.2, from: 14.2, to: 19.4, doors: [[15.7, 16.8]] },
  { a: 'starter', b: 'room-extension', z: 8.4, from: 0, to: 14.2, doors: [[0.3, 1.5], [9.7, 11.5]] },
  { a: 'room-extension', b: 'room-terrace', x: 14.2, from: 8.4, to: 13.8, doors: [[10.4, 11.5]] },
  { a: 'room-games', b: 'room-terrace', z: 8.4, from: 14.2, to: 19.4, doors: [[16.9, 18.0]] },
];
const OFFICE_ROOM_WALLS = {
  'room-kitchen': [{ z: 0, from: 14.2, to: 19.4, kind: 'outer', window: [16.1, 17.5] }],
  'room-extension': [{ x: 0, from: 8.4, to: 13.8, kind: 'outer', window: [10.2, 12.2] }],
  'room-terrace': [{ x: 19.4, from: 8.4, to: 13.8, kind: 'rail' }, { z: 13.8, from: 14.2, to: 19.4, kind: 'rail' }],
};
const OFFICE_PODS_PER_ROOM = 12;
const OFFICE_IDLE_BASE = 6;
const OFFICE_IDLE_MORE = { 'room-kitchen': 2, 'room-games': 2, 'room-terrace': 3 };
const OFFICE_BASE_ACTS = ['coffee', 'sofa', 'chat', 'board', 'sofa', 'wander'];
const OFFICE_DUO_ACTS = ['ping', 'console', 'foos'];
const OFFICE_FUN = {
  'office-arcade': { act: 'arcade', lounge: [13.72, 3.2, 0], games: [14.95, 4.78, 0] },
  'office-console': { act: 'console', lounge: [11.39, 2.05, Math.PI], games: [17.7, 4.46, 0] },
  'office-foosball': { act: 'foos', lounge: [8.8, 6.05, 0], games: [15.85, 7.25, 0] },
  'office-vr': { act: 'vr', lounge: [12.2, 7.1, 0], games: [18.5, 7.05, 0] },
  'office-beanbags': { act: 'beanbag', lounge: [2.9, 5.3, 0] },
  'office-fishtank': { act: 'fish', lounge: [0.3, 4.9, Math.PI / 2] },
};
const OFFICE_KITCHEN = { counter: [14.9, 18.55], fridge: [18.97, 0.36], coffee: 15.45, sink: 16.75, microwave: 17.8, table: { x: 17.1, z: 2.6, w: 1.5, d: 0.85, h: 0.74 } };
const OFFICE_TERRACE = { chairs: [[15.5, 12.1], [16.6, 12.1]], parasol: [16.05, 11.3], planters: [[19.0, 9.0, 0.9], [19.0, 13.35, 1.1], [14.75, 13.35, 1]], rail: [18.75, 10.6] };

const officeOwns = (rooms, id) => id === 'starter' || rooms.includes(id);

// A room whose way in is not built yet is left out, so the floor never has an island nobody can walk to.
function officeBuilt(rooms = []) {
  return OFFICE_ROOM_IDS.filter((id) => rooms.includes(id) && (!OFFICE_ROOMS[id].needs || OFFICE_ROOMS[id].needs.some((n) => rooms.includes(n))));
}

function officeFloor(addons = [], rooms = []) {
  const built = officeBuilt(rooms);
  const games = built.includes('room-games');
  const fun = Object.fromEntries(addons.filter((id) => OFFICE_FUN[id]).map((id) => {
    const [x, z, facing] = (games && OFFICE_FUN[id].games) || OFFICE_FUN[id].lounge;
    return [id, { id, act: OFFICE_FUN[id].act, x, z, facing, where: games && OFFICE_FUN[id].games ? 'games' : 'lounge' }];
  }));
  const acts = Object.values(fun).map((f) => f.act);
  const solo = [...acts.filter((a) => !OFFICE_DUO_ACTS.includes(a)), ...(built.includes('room-kitchen') ? ['lunch'] : []), ...(built.includes('room-terrace') ? ['terrace'] : [])];
  return {
    addons, rooms: built, fun, solo, duos: ['ping', ...OFFICE_DUO_ACTS.slice(1).filter((a) => acts.includes(a))],
    capacity: OFFICE_PODS_PER_ROOM * (built.includes('room-extension') ? 2 : 1),
    idleShown: OFFICE_IDLE_BASE + built.reduce((n, id) => n + (OFFICE_IDLE_MORE[id] ?? 0), 0),
  };
}

// Two owned facilities come between each of the usual pastimes, so what was bought is used most without queueing for one.
function officeIdlePrefs(base, floor) {
  const extra = floor?.solo ?? [];
  if (!extra.length) return base;
  const out = [];
  let next = 0;
  for (const act of base) out.push(act, extra[next++ % extra.length], extra[next++ % extra.length]);
  return out;
}

function officeRoomRects(floor) {
  return [OFFICE_STARTER, ...floor.rooms.map((id) => ({ id, ...OFFICE_ROOMS[id] }))];
}

function officeWallsFor(floor) {
  const rooms = floor.rooms;
  const walls = [];
  for (const e of OFFICE_EDGES) {
    if (!officeOwns(rooms, e.b)) continue;
    const both = officeOwns(rooms, e.a);
    walls.push({ room: e.b, axis: e.x != null ? 'x' : 'z', at: e.x ?? e.z, from: e.from, to: e.to, kind: both ? 'glass' : 'outer', doors: both ? e.doors : [] });
  }
  for (const id of rooms) {
    for (const w of OFFICE_ROOM_WALLS[id] ?? []) walls.push({ room: id, axis: w.x != null ? 'x' : 'z', at: w.x ?? w.z, from: w.from, to: w.to, kind: w.kind, doors: [], window: w.window });
  }
  return walls;
}

// Only a glass partition stands inside the floor; an outer wall or a rail is the floor's own edge, which the grid already keeps everyone off.
function officeWallBlocks(walls) {
  const blocks = [];
  for (const w of walls.filter((x) => x.kind === 'glass')) {
    let from = w.from;
    for (const [a, b] of [...w.doors, [w.to, w.to]]) {
      if (a > from) blocks.push(w.axis === 'x' ? { x0: w.at - 0.05, x1: w.at + 0.05, z0: from, z1: a } : { x0: from, x1: a, z0: w.at - 0.05, z1: w.at + 0.05 });
      from = b;
    }
  }
  return blocks;
}

function officeTurnTo(f, lx, lz) {
  return { x: f.x + lx * Math.cos(f.facing) + lz * Math.sin(f.facing), z: f.z - lx * Math.sin(f.facing) + lz * Math.cos(f.facing) };
}

function officeFunBox(f, w, d, lx = 0, lz = 0) {
  const c = officeTurnTo(f, lx, lz);
  const across = Math.abs(Math.sin(f.facing)) > 0.5;
  const [hw, hd] = across ? [d / 2, w / 2] : [w / 2, d / 2];
  return { x0: c.x - hw, x1: c.x + hw, z0: c.z - hd, z1: c.z + hd };
}

function officeFunSpot(f, lx, lz, turn, pose, via) {
  const at = officeTurnTo(f, lx, lz);
  return { x: at.x, z: at.z, facing: f.facing + turn, pose, ...(via ? { via: [officeTurnTo(f, via[0], via[1])] } : {}) };
}

const OFFICE_FUN_SHAPES = {
  arcade: (f) => ({ blocks: [officeFunBox(f, 0.6, 0.55)], spots: { 'arcade:0': officeFunSpot(f, 0, 0.64, Math.PI, 'arcade') } }),
  console: (f, L) => (f.where === 'lounge' ? officeConsoleLounge(f, L) : officeConsoleGames(f)),
  foos: (f) => ({ blocks: [officeFunBox(f, 1.25, 0.72)], spots: { 'foos:0': officeFunSpot(f, 0, -0.68, 0, 'foos'), 'foos:1': officeFunSpot(f, 0, 0.68, Math.PI, 'foos') } }),
  vr: (f) => ({ blocks: [officeFunBox(f, 0.14, 0.14, -0.62, -0.52), officeFunBox(f, 0.14, 0.14, 0.62, 0.52)], spots: { 'vr:0': officeFunSpot(f, 0, 0, 0, 'vr') } }),
  beanbag: (f) => ({
    blocks: [officeFunBox(f, 0.7, 0.7, -0.5, 0), officeFunBox(f, 0.7, 0.7, 0.5, 0.12)],
    spots: { 'beanbag:0': officeFunSpot(f, -0.5, -0.02, 0, 'beanbag', [-0.5, 0.75]), 'beanbag:1': officeFunSpot(f, 0.5, 0.1, 0, 'beanbag', [0.5, 0.87]) },
  }),
  fish: (f) => ({ blocks: [officeFunBox(f, 1.0, 0.42)], spots: { 'fish:0': officeFunSpot(f, 0.15, 0.72, Math.PI, 'fish') } }),
};

function officeConsoleLounge(f, L) {
  const seats = [0, 1].map((i) => ({ ...L.spots['sofa:' + i], pose: 'gamepad' }));
  return { blocks: [officeFunBox(f, 1.1, 0.36)], spots: { 'console:0': seats[0], 'console:1': seats[1] }, alias: { 'console:0': 'sofa:0', 'console:1': 'sofa:1' } };
}

function officeConsoleGames(f) {
  const couch = { x: f.x, z: f.z + 1.4 };
  const seat = (dx) => ({ x: couch.x + dx, z: couch.z - 0.14, facing: Math.PI, pose: 'gamepad', via: [{ x: couch.x + dx, z: couch.z - 0.82 }] });
  return { blocks: [officeFunBox(f, 1.3, 0.4), { x0: couch.x - 0.85, x1: couch.x + 0.85, z0: couch.z - 0.38, z1: couch.z + 0.38 }], spots: { 'console:0': seat(-0.38), 'console:1': seat(0.38) }, couch };
}

function officeFurnish(L, floor) {
  const blocks = [];
  const alias = {};
  for (const f of Object.values(floor.fun)) {
    const shape = OFFICE_FUN_SHAPES[f.act](f, L);
    blocks.push(...shape.blocks);
    Object.assign(L.spots, shape.spots);
    Object.assign(alias, shape.alias ?? {});
    if (shape.couch) f.couch = shape.couch;
  }
  if (floor.rooms.includes('room-kitchen')) blocks.push(...officeKitchenIn(L));
  if (floor.rooms.includes('room-terrace')) blocks.push(...officeTerraceIn(L));
  Object.assign(alias, officeHotDesks(L, floor));
  return { blocks, alias };
}

function officeKitchenIn(L) {
  const k = OFFICE_KITCHEN;
  const t = k.table;
  L.kitchen = k;
  L.spots['coffee:0'] = { x: k.coffee, z: 1.12, facing: Math.PI, pose: 'sip' };
  L.spots['coffee:1'] = { x: k.coffee + 0.8, z: 1.12, facing: Math.PI, pose: 'sip' };
  [[-0.4, -0.68, 0], [0.4, -0.68, 0], [-0.4, 0.68, Math.PI], [0.4, 0.68, Math.PI]].forEach(([dx, dz, facing], i) => {
    L.spots['lunch:' + i] = { x: t.x + dx, z: t.z + dz, facing, pose: 'eat', via: [{ x: t.x + dx, z: t.z + dz * 1.85 }] };
  });
  return [
    { x0: k.counter[0], x1: k.counter[1], z0: 0, z1: 0.62 },
    { x0: k.fridge[0] - 0.32, x1: k.fridge[0] + 0.32, z0: 0, z1: 0.68 },
    { x0: t.x - t.w / 2, x1: t.x + t.w / 2, z0: t.z - t.d / 2, z1: t.z + t.d / 2 },
    { x0: 14.4, x1: 14.9, z0: 3.45, z1: 3.95 },
  ];
}

function officeTerraceIn(L) {
  const t = OFFICE_TERRACE;
  L.terrace = t;
  t.chairs.forEach(([x, z], i) => {
    L.spots['terrace:' + i] = { x, z: z + 0.22, facing: 0, pose: 'recline', via: [{ x, z: z - 0.95 }] };
  });
  L.spots['terrace:2'] = { x: t.rail[0], z: t.rail[1], facing: Math.PI / 2, pose: 'gaze' };
  return [
    ...t.chairs.map(([x, z]) => ({ x0: x - 0.3, x1: x + 0.3, z0: z - 0.7, z1: z + 0.7 })),
    { x0: t.parasol[0] - 0.08, x1: t.parasol[0] + 0.08, z0: t.parasol[1] - 0.08, z1: t.parasol[1] + 0.08 },
    ...t.planters.map(([x, z, s]) => ({ x0: x - 0.3 * s, x1: x + 0.3 * s, z0: z - 0.3 * s, z1: z + 0.3 * s })),
  ];
}

function officeHotDesks(L, floor) {
  const seats = [['chat:0', 'laptop'], ['chat:1', 'laptop'], ['sofa:0', 'laplounge'], ['sofa:1', 'laplounge'], ['sofa:2', 'laplounge']];
  if (floor.rooms.includes('room-kitchen')) seats.push(...[0, 1, 2, 3].map((i) => ['lunch:' + i, 'laptop-sit']));
  const alias = {};
  seats.forEach(([key, pose], i) => {
    L.spots['hot:' + i] = { ...L.spots[key], pose };
    alias['hot:' + i] = key;
  });
  L.hot = seats.length;
  return alias;
}

function officeSpotCount(L, act) {
  let n = 0;
  while (L.spots[act + ':' + n]) n++;
  return n;
}
