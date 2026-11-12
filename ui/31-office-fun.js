const OFFICE_BUILD_S = 2.2;
const OFFICE_GLASS_H = 0.9;
const OFFICE_WIN_EVERY_S = 9;
const officeFunF = officeM4();
const officeFunJ = officeM4();
const officeFunM = officeM4();

function officeFunLook(look) {
  const t = look.t;
  const m = (a, b, k) => officeLin(officeMix(a, b, k));
  const wood = officeMix(t.viz2, t.viz4, 0.45);
  return {
    tile: look.light ? m(t.panel, [1, 1, 1], 0.6) : m(t.lineStrong, t.muted, 0.3),
    grout: look.light ? m(t.lineStrong, t.muted, 0.1) : m(t.line, t.bg, 0.4),
    carpet: m(t.moved, t.consoleBg, look.light ? 0.5 : 0.66),
    rug: m(t.viz1, t.moved, 0.5),
    deck: m(wood, t.lineStrong, look.light ? 0.3 : 0.48),
    plank: m(wood, t.consoleBg, look.light ? 0.5 : 0.62),
    cabinet: look.light ? m(t.panel, t.viz3, 0.18) : m(t.viz3, t.line, 0.72),
    worktop: look.light ? m(t.lineStrong, t.fg, 0.25) : m(t.muted, t.fg, 0.2),
    wood: m(wood, t.lineStrong, 0.35),
    felt: m(t.viz3, t.consoleBg, 0.3),
    water: m(t.info, t.accentStrong, 0.35),
    sand: m(t.viz4, [1, 1, 1], 0.35),
    canvas: m(t.viz5, [1, 1, 1], 0.15),
    stripe: m(t.fg, [1, 1, 1], 0.7),
    steam: m(t.fg, [1, 1, 1], 0.75),
    cloud: look.light ? m(t.muted, t.lineStrong, 0.15) : m(t.muted, t.fg, 0.2),
    rain: officeLin(t.info),
    bulbs: [t.viz4, t.viz5, t.info, t.viz3].map(officeLin),
    tones: [t.viz1, t.viz2, t.viz3, t.viz4, t.viz5, t.moved].map(officeLin),
  };
}

const officeFunOf = (look) => (look.fun ??= officeFunLook(look));

function officeAt(f, mesh, rgb, x, y, z, sx, sy, sz, glow = 0, yaw = 0, pitch = 0, roll = 0) {
  officePose(officeFunJ, x, y, z, yaw, pitch, roll, sx, sy, sz);
  officeSolid(f, mesh, officeMul(officeFunM, officeFunF, officeFunJ), rgb, glow);
}

function officeFrameAt(x, z, facing = 0) {
  officePose(officeFunF, x, 0, z, facing);
}

function officeMark(f) {
  return { solids: Object.fromEntries(Object.entries(f.solids).map(([name, b]) => [name, b.n])), floor: f.floor.n, glow: f.glow.n };
}

function officeEachSince(f, mark, each) {
  for (const [name, b] of Object.entries(f.solids)) for (let i = mark.solids[name]; i < b.n; i++) each(b.data, i * b.stride, 'solid');
  for (const kind of ['floor', 'glow']) for (let i = mark[kind]; i < f[kind].n; i++) each(f[kind].data, i * f[kind].stride, kind);
}

function officeLift(f, mark, dy) {
  if (dy) officeEachSince(f, mark, (data, at, kind) => (data[at + (kind === 'solid' ? 13 : 1)] += dy));
}

function officeGhost(f, mark, rgb) {
  officeEachSince(f, mark, (data, at, kind) => {
    const tint = kind === 'solid' ? at + 16 : at + 9;
    data.set(rgb, tint);
    if (kind === 'solid') data[at + 19] = 0.55;
    else data[tint + 3] *= 0.45;
  });
}

const officeEase = (u) => 1 - (1 - u) ** 3;
const officeClamp = (u) => Math.min(1, Math.max(0, u));

function officeBounce(u) {
  if (u < 0.6) return (u / 0.6) ** 2;
  const v = (u - 0.6) / 0.4;
  return 1 - Math.sin(v * Math.PI) * 0.12 * (1 - v);
}

function officeGrowth(scene, room, time) {
  const at = scene.building?.get(room);
  if (at == null || time.still) return { slide: 1, drop: 0, landed: Infinity };
  const u = (time.t - at) / OFFICE_BUILD_S;
  if (u >= 1.5) scene.building.delete(room);
  const fall = officeClamp((u - 0.3) / 0.7);
  return { slide: officeEase(officeClamp(u / 0.45)), drop: (1 - officeBounce(fall)) * 3.4, landed: u - 1 };
}

function officeRooms(f, look, scene, time, ghost = null) {
  const L = scene.layout;
  for (const room of L.rooms.slice(1)) {
    const grow = officeGrowth(scene, room.id, time);
    const mark = officeMark(f);
    officeRoomFloor(f, look, room);
    OFFICE_ROOM_DRAW[room.id]?.(f, look, scene, time);
    if (grow.landed > 0 && grow.landed < 0.6) officeDust(f, look, room, grow.landed);
    if (ghost?.ids.has(room.id)) officeGhost(f, mark, ghost.tint);
    else officeLift(f, mark, grow.drop);
  }
  for (const w of L.walls) {
    const mark = ghost?.ids.has(w.room) ? officeMark(f) : null;
    officeWall(f, look, w, officeGrowth(scene, w.room, time).slide);
    if (mark) officeGhost(f, mark, ghost.tint);
  }
}

function officeDust(f, look, room, age) {
  const cx = (room.x0 + room.x1) / 2;
  const cz = (room.z0 + room.z1) / 2;
  const [rx, rz] = [(room.x1 - room.x0) / 2, (room.z1 - room.z0) / 2].map((half) => half * (1.05 + age * 0.6));
  officeDecal(f.glow, [cx, 0.02, cz], [rx, 0, 0], [0, 0, rz], [...look.t.fg, 0.28 * (1 - age / 0.6)], [1, 0.1, 0.9, 1]);
}

function officeRoomFloor(f, look, r) {
  const fun = officeFunOf(look);
  const [w, d, cx, cz] = [r.x1 - r.x0, r.z1 - r.z0, (r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2];
  const top = { tile: fun.tile, carpet: fun.carpet, deck: fun.deck }[r.floor] ?? look.floor;
  officeBox(f, top, cx, -0.12, cz, w, 0.24, d);
  officeBox(f, look.slab, cx, -0.3, cz, w - 0.04, 0.12, d - 0.04);
  if (r.floor === 'tile') {
    for (let x = r.x0 + 0.5; x < r.x1; x += 0.5) officeBox(f, fun.grout, x, 0.001, cz, 0.02, 0.004, d);
    for (let z = r.z0 + 0.5; z < r.z1; z += 0.5) officeBox(f, fun.grout, cx, 0.001, z, w, 0.004, 0.02);
  }
  if (r.floor === 'deck') for (let z = r.z0 + 0.3; z < r.z1; z += 0.3) officeBox(f, fun.plank, cx, 0.001, z, w, 0.004, 0.025);
  if (r.floor === 'carpet') officeDecal(f.floor, [cx + 0.6, 0.003, cz + 0.4], [1.7, 0, 0], [0, 0, 1.2], [...officeMix(look.t.moved, look.t.viz1, 0.5), 0.35], [3, 0, 0.3, 1.7 / 1.2]);
}

// A wall goes up from the end that meets the office, so a new room seems to unfold out of the old one.
function officeWall(f, look, w, slide) {
  if (slide <= 0.01) return;
  const end = w.from + (w.to - w.from) * slide;
  const off = w.kind === 'outer' ? -0.08 : w.kind === 'rail' ? -0.05 : 0;
  const seg = (a, b, y, h, t, rgb, glow = 0) => {
    const [lo, hi] = [Math.max(a, w.from), Math.min(b, end)];
    if (hi - lo < 0.01) return;
    if (w.axis === 'x') officeBox(f, rgb, w.at + off, y, (lo + hi) / 2, t, h, hi - lo, 0, glow);
    else officeBox(f, rgb, (lo + hi) / 2, y, w.at + off, hi - lo, h, t, 0, glow);
  };
  if (w.kind === 'outer') return officeOuterWall(f, look, w, seg, end);
  if (w.kind === 'rail') return officeRail(f, look, w, seg, end, off);
  officeGlassWall(f, look, w, seg, end);
}

function officeOuterWall(f, look, w, seg, end) {
  const h = OFFICE_WALL_H;
  seg(w.from, w.to, h / 2, h, 0.16, look.wall);
  seg(w.from, w.to, h + 0.02, 0.04, 0.2, look.cap);
  if (!w.window || end < w.window[1]) return;
  const [a, b] = w.window;
  const mid = (a + b) / 2;
  const at = (x, y, z, sx, sy, sz, rgb, glow = 0) => (w.axis === 'x' ? officeBox(f, rgb, w.at + x, y, z, sx, sy, sz, 0, glow) : officeBox(f, rgb, z, y, w.at + x, sz, sy, sx, 0, glow));
  at(0.0, 1.38, mid, 0.03, 0.92, b - a, look.glass, look.light ? 0.25 : 0.35);
  at(0.04, 0.9, mid, 0.1, 0.05, b - a + 0.1, look.cap);
  at(0.02, 1.86, mid, 0.05, 0.05, b - a + 0.1, look.cap);
  for (const dz of [a, mid, b]) at(0.02, 1.38, dz, 0.05, 0.96, 0.05, look.cap);
}

function officeDoorGaps(w) {
  const runs = [];
  let from = w.from;
  for (const [a, b] of [...w.doors, [w.to, w.to]]) {
    if (a > from) runs.push([from, a]);
    from = b;
  }
  return runs;
}

// The partition is low and glazed above, so a room behind it still shows through from the camera's side.
function officeGlassWall(f, look, w, seg, end) {
  for (const [a, b] of officeDoorGaps(w)) {
    seg(a, b, OFFICE_GLASS_H / 2, OFFICE_GLASS_H, 0.1, look.wall);
    seg(a, b, OFFICE_GLASS_H + 0.02, 0.04, 0.14, look.cap);
    seg(a, b, 2.0, 0.05, 0.08, look.cap);
    const [lo, hi] = [a, Math.min(b, end)];
    if (hi - lo < 0.05) continue;
    const n = Math.max(1, Math.ceil((hi - lo) / 1.3));
    for (let k = 0; k <= n; k++) seg(lo + (k * (hi - lo)) / n - 0.025, lo + (k * (hi - lo)) / n + 0.025, (OFFICE_GLASS_H + 2.0) / 2, 2.0 - OFFICE_GLASS_H, 0.06, look.cap);
    const mid = (lo + hi) / 2;
    const u = w.axis === 'x' ? [0, 0, (hi - lo) / 2] : [(hi - lo) / 2, 0, 0];
    const centre = w.axis === 'x' ? [w.at, (OFFICE_GLASS_H + 2.0) / 2, mid] : [mid, (OFFICE_GLASS_H + 2.0) / 2, w.at];
    officeDecal(f.floor, centre, u, [0, (2.0 - OFFICE_GLASS_H) / 2, 0], [...officeMix(look.t.info, look.t.panel, 0.4), look.light ? 0.18 : 0.14], [0, 0.02, 0.02, 1]);
  }
}

function officeRail(f, look, w, seg, end, off) {
  seg(w.from, w.to, 1.0, 0.05, 0.07, look.cap);
  seg(w.from, w.to, 0.06, 0.12, 0.08, look.cap);
  for (let at = w.from + 0.1; at <= end; at += 1.0) seg(at - 0.03, at + 0.03, 0.5, 1.0, 0.06, look.cap);
  const len = end - w.from;
  const centre = w.axis === 'x' ? [w.at + off, 0.55, w.from + len / 2] : [w.from + len / 2, 0.55, w.at + off];
  const u = w.axis === 'x' ? [0, 0, len / 2] : [len / 2, 0, 0];
  officeDecal(f.floor, centre, u, [0, 0.42, 0], [...officeMix(look.t.info, look.t.panel, 0.4), 0.16], [0, 0.02, 0.02, 1]);
}

const OFFICE_ROOM_DRAW = {
  'room-kitchen': (f, look, scene, time) => officeKitchen(f, look, scene, time),
  'room-games': (f, look, scene, time) => officeFacilities(f, look, scene, time, 'games'),
  'room-extension': (f, look, scene, time) => {
    officePods(f, look, scene, time, (p) => p.i >= OFFICE_PODS_PER_ROOM);
    for (const [x, z, s] of [[13.75, 13.35, 1.3], [0.5, 13.3, 1.1], [13.8, 8.85, 0.9]]) officePlant(f, look, x, z, s, 0);
  },
  'room-terrace': (f, look, scene, time) => officeTerrace(f, look, scene, time),
};

function officeUser(scene, spot) {
  const actor = [...scene.actors.values()].find((a) => a.spot === spot);
  return actor && !actor.path.length ? actor : null;
}

function officeKitchen(f, look, scene, time) {
  const k = scene.layout.kitchen;
  const fun = officeFunOf(look);
  const w = officeWearOf(look);
  const [x0, x1] = k.counter;
  const mid = (x0 + x1) / 2;
  officeShadow(f, look, mid, 0.32, x1 - x0 + 0.2, 0.8, 0.25);
  officeBox(f, fun.cabinet, mid, 0.43, 0.3, x1 - x0, 0.86, 0.6);
  officeBox(f, fun.worktop, mid, 0.885, 0.32, x1 - x0 + 0.04, 0.05, 0.66);
  for (let x = x0 + 0.6; x < x1 - 0.1; x += 0.6) officeBox(f, look.leg, x, 0.43, 0.605, 0.015, 0.78, 0.01);
  for (const [a, b] of [[x0, 16.0], [17.6, x1]]) officeBox(f, fun.cabinet, (a + b) / 2, 1.78, 0.18, b - a, 0.5, 0.34);
  officeKitchenMachines(f, look, k, scene, time);
  officeFridgeTall(f, look, w, k.fridge, time);
  officeLunchTable(f, look, k.table, scene);
  officePlant(f, look, 14.65, 3.7, 1.0, 0);
}

function officeKitchenMachines(f, look, k, scene, time) {
  const w = officeWearOf(look);
  const top = 0.91;
  officeBox(f, look.machine, k.coffee, top + 0.24, 0.24, 0.4, 0.46, 0.34);
  officeBox(f, look.leg, k.coffee, top + 0.06, 0.42, 0.26, 0.04, 0.12);
  officeCyl(f, look.board, k.coffee, top + 0.13, 0.42, 0.045, 0.09);
  officeSolid(f, 'ball', officePose(officeM, k.coffee + 0.13, top + 0.4, 0.415, 0, 0, 0, 0.04, 0.04, 0.04), officeLin(look.t.done), 1);
  if (officeUser(scene, 'coffee:0') && !time.still) officeSteam(f, look, k.coffee, top + 0.25, 0.44, time.t, 2);
  officeBox(f, look.leg, k.sink, top - 0.01, 0.3, 0.55, 0.02, 0.4);
  officeBox(f, look.screen, k.sink, top + 0.002, 0.3, 0.48, 0.01, 0.33);
  officeCyl(f, w.silver, k.sink, top + 0.15, 0.1, 0.018, 0.3);
  officeBox(f, w.silver, k.sink, top + 0.29, 0.18, 0.03, 0.03, 0.17);
  const lunch = [0, 1, 2, 3].some((i) => officeUser(scene, 'lunch:' + i)) && !time.still;
  officeBox(f, look.machine, k.microwave, top + 0.17, 0.3, 0.55, 0.32, 0.38);
  officeBox(f, lunch ? officeLin(look.t.viz4) : look.screen, k.microwave - 0.06, top + 0.17, 0.492, 0.34, 0.22, 0.01, 0, lunch ? 0.55 + 0.1 * Math.sin(time.t * 6) : 0);
  for (let i = 0; i < 3; i++) officeBox(f, look.board, k.microwave + 0.2, top + 0.24 - i * 0.07, 0.492, 0.06, 0.035, 0.01);
}

function officeFridgeTall(f, look, w, [x, z], time) {
  officeShadow(f, look, x, z, 0.75, 0.8, 0.25);
  officeBox(f, w.fridge, x, 0.88, z, 0.62, 1.76, 0.66);
  officeBox(f, w.dark, x, 1.18, z + 0.335, 0.6, 0.012, 0.01);
  officeBox(f, w.silver, x - 0.24, 1.42, z + 0.35, 0.03, 0.34, 0.03, 0, -0.8);
  officeBox(f, w.silver, x - 0.24, 0.8, z + 0.35, 0.03, 0.3, 0.03, 0, -0.8);
  const tones = officeFunOf(look).tones;
  [[0.05, 1.55], [0.18, 1.38], [-0.02, 1.32], [0.15, 0.7]].forEach(([dx, y], i) => officeBox(f, tones[i], x + dx, y, z + 0.337, 0.07, 0.07, 0.012, 0, 0.3));
}

function officeLunchTable(f, look, t, scene) {
  const fun = officeFunOf(look);
  officeShadow(f, look, t.x, t.z, t.w + 0.2, t.d + 0.2, 0.3);
  officeBox(f, fun.wood, t.x, t.h - 0.025, t.z, t.w, 0.05, t.d);
  for (const dx of [-1, 1]) for (const dz of [-1, 1]) officeBox(f, look.leg, t.x + dx * (t.w / 2 - 0.08), (t.h - 0.05) / 2, t.z + dz * (t.d / 2 - 0.08), 0.05, t.h - 0.05, 0.05);
  officeCyl(f, look.board, t.x, t.h + 0.03, t.z, 0.13, 0.06);
  [[0, 0.05, 0, 'gold'], [0.06, 0.06, 0.03, 'red'], [-0.05, 0.06, -0.02, 'green']].forEach(([dx, dy, dz, tone]) => officeSolid(f, 'ball', officePose(officeM, t.x + dx, t.h + dy + 0.03, t.z + dz, 0, 0, 0, 0.07, 0.07, 0.07), officeWearOf(look)[tone]));
  for (let i = 0; i < 4; i++) {
    const spot = scene.layout.spots['lunch:' + i];
    const sat = officeUser(scene, 'lunch:' + i);
    officeChair(f, look, spot.x, spot.z, spot.facing + (sat ? 0 : 0.3), 0.95);
    if (sat?.pose !== 'eat') continue;
    const side = Math.cos(spot.facing) > 0 ? 1 : -1;
    officeCyl(f, look.board, spot.x, t.h + 0.012, spot.z + side * 0.42, 0.13, 0.015);
    officeCyl(f, officeFunOf(look).sand, spot.x, t.h + 0.03, spot.z + side * 0.42, 0.08, 0.025);
  }
  officePendant(f, look, t.x, t.z);
}

function officePendant(f, look, x, z) {
  officeCyl(f, look.leg, x, 1.95, z, 0.008, 0.5);
  officeSolid(f, 'cone', officePose(officeM, x, 1.62, z, 0, 0, 0, 0.36, 0.2, 0.36), officeFunOf(look).cabinet);
  officeSolid(f, 'ball', officePose(officeM, x, 1.53, z, 0, 0, 0, 0.1, 0.1, 0.1), look.board, 1);
  officeFloorGlow(f, [...look.t.viz4, look.light ? 0.12 : 0.2], x, z, 1.4);
}

function officeSteam(f, look, x, y, z, t, puffs) {
  const fun = officeFunOf(look);
  for (let i = 0; i < puffs; i++) {
    const age = (t * 0.8 + i / puffs) % 1;
    const s = 0.05 + age * 0.08;
    officeSolid(f, 'ball', officePose(officeM, x + Math.sin(t * 2 + i) * 0.04, y + age * 0.45, z, 0, 0, 0, s * (1 - age * 0.6), s, s), fun.steam, 0.4);
  }
}

function officeTerrace(f, look, scene, time) {
  const t = scene.layout.terrace;
  t.chairs.forEach(([x, z], i) => officeLounger(f, look, x, z, i));
  officeParasol(f, look, t.parasol);
  for (const [x, z, s] of t.planters) {
    officeBox(f, officeFunOf(look).wood, x, 0.22 * s, z, 0.6 * s, 0.44 * s, 0.6 * s);
    officePlant(f, look, x, z, s * 0.9, 0.44 * s);
  }
  officeStringLights(f, look, time);
}

function officeLounger(f, look, x, z, i) {
  const fun = officeFunOf(look);
  officeShadow(f, look, x, z, 0.75, 1.5, 0.3);
  officeFrameAt(x, z);
  for (const side of [-1, 1]) officeAt(f, 'box', look.leg, side * 0.28, 0.2, 0, 0.04, 0.04, 1.4);
  for (const [dz, y] of [[-0.6, 0.1], [0.6, 0.1]]) for (const side of [-1, 1]) officeAt(f, 'box', look.leg, side * 0.28, y, dz, 0.04, 0.2, 0.04);
  for (let k = 0; k < 4; k++) officeAt(f, 'box', k % 2 ? fun.stripe : i ? fun.canvas : fun.water, -0.21 + k * 0.14, 0.23, 0.2, 0.14, 0.03, 0.85);
  for (let k = 0; k < 4; k++) officeAt(f, 'box', k % 2 ? fun.stripe : i ? fun.canvas : fun.water, -0.21 + k * 0.14, 0.42, -0.42, 0.14, 0.03, 0.55, 0, 0, -0.85);
}

function officeParasol(f, look, [x, z]) {
  const fun = officeFunOf(look);
  officeShadow(f, look, x + 0.25, z + 0.35, 2.0, 2.0, 0.8, 0.6);
  officeCyl(f, look.leg, x, 0.04, z, 0.18, 0.08);
  officeCyl(f, look.board, x, 1.1, z, 0.02, 2.2);
  officeSolid(f, 'cone', officePose(officeM, x, 2.1, z, 0.3, 0, 0, 2.1, 0.42, 2.1), fun.canvas);
  officeSolid(f, 'cone', officePose(officeM, x, 2.12, z, 0.3, 0, 0, 1.2, 0.24, 1.2), fun.stripe);
  officeSolid(f, 'ball', officePose(officeM, x, 2.35, z, 0, 0, 0, 0.07, 0.07, 0.07), fun.stripe);
}

function officeStringLights(f, look, time) {
  const fun = officeFunOf(look);
  const posts = [[14.35, 8.55], [19.25, 8.55], [19.25, 13.65], [14.35, 13.65]];
  const strands = [[posts[0], posts[1]], [posts[1], posts[2]], [posts[2], posts[3]]];
  for (const [x, z] of posts) officeCyl(f, look.leg, x, 1.15, z, 0.025, 2.3);
  strands.forEach(([a, b], s) => {
    const n = Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.42);
    const at = (u) => [a[0] + (b[0] - a[0]) * u, 2.25 - Math.sin(u * Math.PI) * 0.35, a[1] + (b[1] - a[1]) * u];
    for (let i = 0; i < n; i++) officeWire(f, look.leg, at(i / n), at((i + 1) / n));
    for (let i = 1; i < n; i++) {
      const [x, y, z] = at(i / n);
      const twinkle = time.still ? 0.9 : 0.75 + 0.25 * Math.sin(time.t * 2.5 + i * 1.7 + s);
      officeSolid(f, 'ball', officePose(officeM, x, y - 0.06, z, 0, 0, 0, 0.07, 0.09, 0.07), fun.bulbs[(i + s) % 4], twinkle);
    }
  });
}

function officeWire(f, rgb, p, q) {
  const [dx, dy, dz] = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const flat = Math.hypot(dx, dz);
  officeSolid(f, 'box', officePose(officeM, (p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2, Math.atan2(dx, dz), -Math.atan2(dy, flat), 0, 0.012, 0.012, Math.hypot(flat, dy)), rgb);
}

function officeFacilities(f, look, scene, time, where = 'lounge') {
  for (const fac of Object.values(scene.layout.floor.fun)) {
    if (fac.where !== where) continue;
    officeFrameAt(fac.x, fac.z, fac.facing);
    OFFICE_FUN_DRAW[fac.act](f, look, fac, scene, time);
  }
}

const officeInUse = (scene, spots, pose) => scene.preview || spots.every((k) => officeUser(scene, k)?.pose === pose);

const OFFICE_FUN_DRAW = {
  arcade: (f, look, fac, scene, time) => officeArcade(f, look, fac, officeInUse(scene, ['arcade:0'], 'arcade'), time),
  console: (f, look, fac, scene, time) => officeConsole(f, look, fac, officeInUse(scene, ['console:0', 'console:1'], 'gamepad'), time),
  foos: (f, look, fac, scene, time) => officeFoosball(f, look, fac, officeInUse(scene, ['foos:0', 'foos:1'], 'foos'), time),
  vr: (f, look, fac, scene, time) => officeVr(f, look, fac, !scene.preview && officeInUse(scene, ['vr:0'], 'vr'), time),
  beanbag: (f, look, fac) => officeBeanbags(f, look, fac),
  fish: (f, look, fac, scene, time) => officeFishTank(f, look, fac, time),
};

function officeArcade(f, look, fac, player, time) {
  const w = officeWearOf(look);
  const t = officeTurnTo(fac, 0, 0);
  officeShadow(f, look, t.x, t.z, 0.8, 0.8, 0.3);
  officeAt(f, 'box', w.dark, 0, 0.75, 0, 0.6, 1.5, 0.55);
  for (const side of [-1, 1]) officeAt(f, 'box', w.blue, side * 0.31, 0.8, 0, 0.02, 1.42, 0.57);
  officeAt(f, 'box', w.pink, 0, 1.42, 0.27, 0.56, 0.12, 0.04, 0.9);
  officeAt(f, 'box', w.dark, 0, 1.06, 0.285, 0.5, 0.42, 0.02);
  officeAt(f, 'box', w.dark, 0, 1.06, 0.296, 0.44, 0.34, 0.006, player ? 0.35 : 0.2);
  const frame = time.still ? 0 : Math.floor(time.t * (player ? 9 : 4));
  for (let i = 0; i < 6; i++) officeAt(f, 'box', i % 2 ? w.green : w.gold, -0.15 + ((i + frame) % 6) * 0.06, 1.16 - Math.floor(i / 3) * 0.08, 0.3, 0.035, 0.035, 0.004, 0.9);
  officeAt(f, 'box', w.cyan, -0.12 + (frame % 5) * 0.06, 0.93, 0.3, 0.05, 0.03, 0.004, 0.9);
  officeAt(f, 'box', w.indigo, 0, 0.8, 0.35, 0.56, 0.05, 0.2, 0, 0, 0.25);
  officeAt(f, 'cyl', w.dark, -0.12, 0.86, 0.38, 0.02, 0.08, 0.02);
  officeAt(f, 'ball', w.red, -0.12, 0.91, 0.38, 0.05, 0.05, 0.05);
  for (const [dx, rgb] of [[0.06, w.gold], [0.15, w.pink]]) officeAt(f, 'cyl', rgb, dx, 0.85, 0.38, 0.05, 0.02, 0.05, 0.7);
  if (player && !time.still) officeWinBurst(f, look, fac, time);
}

function officeWinBurst(f, look, fac, time) {
  const age = (time.t + officeHash(fac.id) % 7) % OFFICE_WIN_EVERY_S;
  if (age > 1.3) return;
  const w = officeWearOf(look);
  const top = officeTurnTo(fac, 0, 0.27);
  for (let i = 0; i < 12; i++) {
    const a = i * 2.4;
    const up = age * (1.4 + (i % 3) * 0.3) - age * age * 1.1;
    const out = 0.12 + age * 0.4;
    const s = 0.06 * (1 - age / 1.3);
    officeSolid(f, 'gem', officePose(officeM, top.x + Math.sin(a) * out, 1.55 + up, top.z + Math.cos(a) * out, a, age * 5, 0, s, s, s), i % 3 ? w.gold : w.pink, 1);
  }
  officeDecal(f.glow, [top.x, 1.45, top.z], [0.5, 0, 0], [0, 0.5, 0], [...look.t.viz4, 0.5 * (1 - age / 1.3)], [2, 0, 0, 1]);
}

function officeConsole(f, look, fac, playing, time) {
  const w = officeWearOf(look);
  const fun = officeFunOf(look);
  const c = officeTurnTo(fac, 0, 0);
  officeShadow(f, look, c.x, c.z, 1.3, 0.55, 0.25);
  officeAt(f, 'box', fun.wood, 0, 0.2, 0, 1.1, 0.4, 0.36);
  officeAt(f, 'box', look.leg, 0, 0.2, 0.181, 1.0, 0.32, 0.01);
  officeAt(f, 'box', w.white, 0.3, 0.44, 0.02, 0.26, 0.06, 0.2);
  officeAt(f, 'ball', w.cyan, 0.4, 0.475, 0.12, 0.02, 0.02, 0.02, 1);
  officeAt(f, 'box', w.dark, 0, 0.45, -0.04, 0.2, 0.06, 0.12);
  officeAt(f, 'box', w.dark, 0, 0.82, -0.04, 1.0, 0.6, 0.05);
  officeConsoleScreen(f, look, playing, time);
  if (!playing) for (const dx of [-0.3, -0.12]) officeAt(f, 'box', w.dark, dx, 0.43, 0.08, 0.14, 0.035, 0.07);
  if (fac.couch) officeCouch(f, look, fac.couch);
  if (playing && fac.where === 'lounge' && !time.still) officeDecal(f.glow, [c.x, 0.6, c.z - 0.9], [0.9, 0, 0], [0, 0.5, 0], [...officeMix(look.t.info, look.t.viz5, 0.5 + 0.5 * Math.sin(time.t * 3)), 0.25], [2, 0, 0, 1]);
}

function officeConsoleScreen(f, look, playing, time) {
  const w = officeWearOf(look);
  officeAt(f, 'box', playing ? w.indigo : look.screen, 0, 0.82, -0.013, 0.92, 0.52, 0.005, playing ? 0.5 : 0.1);
  if (!playing) return;
  const t = time.still ? 0 : time.t;
  officeAt(f, 'box', w.green, 0, 0.6, -0.009, 0.92, 0.06, 0.004, 0.7);
  for (const [i, rgb] of [[0, w.pink], [1, w.cyan]]) {
    const x = Math.sin(t * 1.3 + i * 2.2) * 0.32;
    const hop = Math.abs(Math.sin(t * 3.1 + i)) * 0.16;
    officeAt(f, 'box', rgb, x, 0.68 + hop, -0.008, 0.06, 0.09, 0.004, 0.9);
  }
  officeAt(f, 'ball', w.gold, Math.sin(t * 2.6) * 0.38, 0.92 + Math.abs(Math.sin(t * 4.2)) * 0.08, -0.008, 0.035, 0.035, 0.004, 1);
}

function officeCouch(f, look, couch) {
  officeFrameAt(couch.x, couch.z, Math.PI);
  officeShadow(f, look, couch.x, couch.z, 1.9, 1.0, 0.3);
  officeAt(f, 'box', look.sofa, 0, 0.17, 0, 1.7, 0.24, 0.75);
  officeAt(f, 'box', look.sofa, 0, 0.47, -0.27, 1.7, 0.48, 0.2);
  for (const side of [-1, 1]) officeAt(f, 'box', look.sofa, side * 0.77, 0.35, 0.02, 0.16, 0.3, 0.73);
  for (const dx of [-0.38, 0.38]) officeAt(f, 'box', look.cushion, dx, 0.33, 0.07, 0.68, 0.09, 0.5);
}

function officeFoosball(f, look, fac, playing, time) {
  const w = officeWearOf(look);
  const fun = officeFunOf(look);
  const c = officeTurnTo(fac, 0, 0);
  officeShadow(f, look, c.x, c.z, 1.45, 0.95, 0.3);
  officeAt(f, 'box', fun.wood, 0, 0.66, 0, 1.25, 0.18, 0.72);
  officeAt(f, 'box', fun.felt, 0, 0.752, 0, 1.15, 0.01, 0.62);
  officeAt(f, 'box', w.white, 0, 0.758, 0, 0.012, 0.004, 0.6);
  for (const side of [-1, 1]) {
    officeAt(f, 'box', w.white, side * 0.57, 0.76, 0, 0.02, 0.06, 0.2);
    for (const dz of [-1, 1]) officeAt(f, 'box', look.leg, side * 0.52, 0.29, dz * 0.28, 0.07, 0.58, 0.07);
  }
  const spin = playing && !time.still ? time.t : 0;
  [-0.42, -0.14, 0.14, 0.42].forEach((x, i) => {
    const twist = playing ? Math.sin(spin * (5 + i) + i) * 0.9 : 0;
    const slide = playing ? Math.sin(spin * 1.7 + i * 1.3) * 0.08 : 0;
    officeAt(f, 'cyl', w.silver, x, 0.82, slide, 0.025, 1.2, 0.025, -0.6, 0, Math.PI / 2);
    officeAt(f, 'box', i % 2 ? w.red : w.blue, x, 0.82, slide + (i % 2 ? 0.62 : -0.62), 0.05, 0.05, 0.12);
    for (const dz of [-0.18, 0, 0.18]) officeAt(f, 'box', i < 2 ? w.blue : w.red, x, 0.79, dz + slide, 0.04, 0.12, 0.05, 0, 0, twist);
  });
  if (!playing) return;
  const bx = Math.sin(spin * 2.3) * 0.45 + Math.sin(spin * 5.1) * 0.08;
  officeAt(f, 'ball', w.white, bx, 0.78, Math.sin(spin * 3.7) * 0.2, 0.05, 0.05, 0.05);
}

function officeVr(f, look, fac, playing, time) {
  const w = officeWearOf(look);
  const c = officeTurnTo(fac, 0, 0);
  const pulse = time.still ? 0.85 : 0.7 + 0.3 * Math.sin(time.t * (playing ? 4 : 1.5));
  officeDecal(f.floor, [c.x, 0.004, c.z], [0.62, 0, 0], [0, 0, 0.62], [...officeMix(look.t.consoleBg, look.t.lineStrong, 0.4), 0.75], [3, 0, 0.3, 1]);
  officeDecal(f.glow, [c.x, 0.008, c.z], [0.55, 0, 0], [0, 0, 0.55], [...look.t.info, (playing ? 0.9 : 0.45) * pulse], [1, 0.08, 0.85, 1]);
  if (playing) officeFloorGlow(f, [...look.t.info, 0.3 * pulse], c.x, c.z, 0.9);
  for (const [lx, lz] of [[-0.62, -0.52], [0.62, 0.52]]) {
    officeAt(f, 'cyl', look.leg, lx, 0.8, lz, 0.025, 1.6, 0.025);
    officeAt(f, 'box', w.dark, lx, 1.65, lz, 0.1, 0.08, 0.1, 0, Math.atan2(-lx, -lz));
    officeAt(f, 'ball', w.cyan, lx, 1.65, lz, 0.03, 0.03, 0.03, pulse);
  }
  if (playing) return;
  officeAt(f, 'cyl', look.leg, 0.62, 0.5, -0.1, 0.02, 1.0, 0.02);
  officeAt(f, 'box', w.dark, 0.62, 1.04, -0.1, 0.2, 0.09, 0.1, -0.4);
  officeAt(f, 'box', w.cyan, 0.62, 1.04, -0.045, 0.16, 0.05, 0.01, 0.6);
}

function officeBeanbags(f, look, fac) {
  const w = officeWearOf(look);
  const rug = officeTurnTo(fac, 0, 0.1);
  officeDecal(f.floor, [rug.x, 0.003, rug.z], [1.25, 0, 0], [0, 0, 0.75], [...officeMix(look.t.viz4, look.t.panel, 0.7), 1], [3, 0, 0.5, 1.25 / 0.75]);
  [[-0.5, 0, w.pink], [0.5, 0.12, w.blue]].forEach(([lx, lz, rgb]) => {
    const c = officeTurnTo(fac, lx, lz);
    officeShadow(f, look, c.x, c.z, 0.85, 0.85, 0.3);
    officeAt(f, 'ball', rgb, lx, 0.17, lz, 0.78, 0.36, 0.74);
    officeAt(f, 'ball', rgb, lx, 0.3, lz - 0.2, 0.62, 0.42, 0.34);
  });
}

function officeFishTank(f, look, fac, time) {
  const w = officeWearOf(look);
  const fun = officeFunOf(look);
  const c = officeTurnTo(fac, 0, 0);
  officeShadow(f, look, c.x, c.z, 0.6, 1.15, 0.25);
  officeAt(f, 'box', fun.wood, 0, 0.28, 0, 1.0, 0.56, 0.42);
  officeAt(f, 'box', look.cap, 0, 0.58, 0, 1.02, 0.04, 0.44);
  officeAt(f, 'box', fun.water, 0, 0.82, -0.17, 0.98, 0.44, 0.04, 0.45);
  officeAt(f, 'box', fun.sand, 0, 0.63, 0, 0.96, 0.05, 0.38);
  for (const [lx, h] of [[-0.3, 0.3], [-0.22, 0.22], [0.32, 0.26]]) officeAt(f, 'gem', look.leaf, lx, 0.64 + h / 2, -0.05, 0.06, h, 0.05, 0.1);
  officeFishSwim(f, w, time.still ? 0 : time.t);
  for (const [lx, lz, sx, sz] of [[0, 0.19, 1.0, 0.02], [0, -0.19, 1.0, 0.02], [0.49, 0, 0.02, 0.4], [-0.49, 0, 0.02, 0.4]]) officeAt(f, 'box', look.cap, lx, 1.05, lz, sx, 0.03, sz);
  const front = officeTurnTo(fac, 0, 0.205);
  const across = [Math.cos(fac.facing) * 0.49, 0, -Math.sin(fac.facing) * 0.49];
  officeDecal(f.floor, [front.x, 0.83, front.z], across, [0, 0.22, 0], [...officeMix(look.t.info, look.t.panel, 0.3), 0.28], [0, 0.02, 0.02, 1]);
  officeDecal(f.glow, [front.x, 0.83, front.z], across, [0, 0.22, 0], [...look.t.info, 0.12], [2, 0, 0, 1]);
}

function officeFishSwim(f, w, t) {
  [[w.orange, 0.7, 0.3, 0], [w.gold, 1.1, 0.25, 2], [w.pink, 0.85, 0.35, 4]].forEach(([rgb, speed, span, phase], i) => {
    const u = Math.sin(t * speed + phase);
    const dir = Math.cos(t * speed + phase) >= 0 ? 0 : Math.PI;
    const lx = u * span;
    const ly = 0.78 + i * 0.07 + Math.sin(t * 1.7 + phase) * 0.02;
    officeAt(f, 'ball', rgb, lx, ly, -0.02 + i * 0.05, 0.11, 0.06, 0.035, 0.25, dir);
    officeAt(f, 'cone', rgb, lx - (dir ? -0.07 : 0.07), ly, -0.02 + i * 0.05, 0.05, 0.05, 0.02, 0.25, 0, 0, dir ? -Math.PI / 2 : Math.PI / 2);
  });
  for (let i = 0; i < 4; i++) {
    const age = (t * 0.5 + i * 0.25) % 1;
    officeAt(f, 'ball', w.white, 0.3 + Math.sin(t * 3 + i) * 0.02, 0.66 + age * 0.36, 0.05, 0.025, 0.025, 0.025, 0.4);
  }
}

// Name tags sit above every head, so a mood's cloud or steam is drawn beside the head where the tag never covers it.
const OFFICE_ASIDE = [Math.cos(Math.PI / 4), 0, -Math.sin(Math.PI / 4)];

function officeMoodFx(f, look, actor, time) {
  const mood = actor.mood?.mood;
  if (time.still || !mood) return;
  const [x, y, z] = officeHeadAt(actor);
  const t = time.t + (officeHash(actor.handle) % 10);
  if (mood === 'grumpy') officeCloud(f, look, x + OFFICE_ASIDE[0] * 0.48, y + 0.02, z + OFFICE_ASIDE[2] * 0.48, t);
  if (mood === 'angry') officeFume(f, look, actor, x, y, z, t);
  if (mood === 'cheer') officeConfetti(f, look, x, y, z, (Date.now() - (actor.answeredAt ?? 0)) / 1000);
  if (mood === 'happy' && actor.pulse > 0.05) officeSparkle(f, look, x, y, z, actor.pulse, time.t);
}

function officeFume(f, look, actor, x, y, z, t) {
  const fun = officeFunOf(look);
  officeFloorGlow(f, [...look.t.need, 0.32 + 0.12 * Math.sin(t * 6)], actor.x, actor.z, 0.85);
  for (const side of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const age = (t * 1.6 + i * 0.5 + (side > 0 ? 0.25 : 0)) % 1;
      const out = 0.24 + age * 0.3;
      const s = (0.09 + age * 0.11) * (1 - age * 0.45);
      officeSolid(f, 'ball', officePose(officeM, x + OFFICE_ASIDE[0] * side * out, y - 0.06 + age * 0.2, z + OFFICE_ASIDE[2] * side * out, 0, 0, 0, s, s, s), fun.steam, 0.5);
    }
  }
}

function officeCloud(f, look, x, y, z, t) {
  const fun = officeFunOf(look);
  const bob = Math.sin(t * 1.3) * 0.03;
  for (const [dx, dy, s] of [[-0.12, 0, 0.17], [0.02, 0.05, 0.21], [0.15, 0, 0.16], [0.03, -0.03, 0.18]]) officeSolid(f, 'ball', officePose(officeM, x + dx * OFFICE_ASIDE[0], y + dy + bob, z + dx * OFFICE_ASIDE[2], 0, 0, 0, s, s * 0.8, s * 0.85), fun.cloud, 0.15);
  for (let i = 0; i < 3; i++) {
    const age = (t * 1.4 + i / 3) % 1;
    officeSolid(f, 'box', officePose(officeM, x + (i - 1) * 0.1 * OFFICE_ASIDE[0], y - 0.1 - age * 0.32 + bob, z + (i - 1) * 0.1 * OFFICE_ASIDE[2], 0, 0, 0, 0.014, 0.07, 0.014), fun.rain, 0.6);
  }
}

function officeConfetti(f, look, x, y, z, age) {
  const fun = officeFunOf(look);
  if (age < 0 || age > 2.8) return;
  for (let i = 0; i < 26; i++) {
    const a = i * 2.39;
    const up = age * (2.4 + (i % 4) * 0.45) - age * age * 1.5;
    const out = 0.2 + age * (0.45 + (i % 3) * 0.15);
    officeSolid(f, 'box', officePose(officeM, x + Math.sin(a) * out, y + 0.1 + Math.max(-1.2, up), z + Math.cos(a) * out, a, age * 6 + i, age * 4, 0.075, 0.075, 0.015), fun.tones[i % 6], 0.7);
  }
}

function officeSparkle(f, look, x, y, z, pulse, t) {
  const w = officeWearOf(look);
  for (let i = 0; i < 4; i++) {
    const a = t * 2 + i * (Math.PI / 2);
    const s = 0.055 * pulse;
    officeSolid(f, 'gem', officePose(officeM, x + Math.sin(a) * 0.32, y + 0.05 + (1 - pulse) * 0.4, z + Math.cos(a) * 0.32, a, t * 3, 0, s, s * 1.4, s), i % 2 ? w.gold : w.white, 1);
  }
}

const OFFICE_FUN_PREVIEW = { 'office-console': [0, -0.7, 0, 1.75], 'office-fishtank': [0, 0, Math.PI / 2, 1.2], 'office-vr': [0, 0, 0, 1.45], 'office-beanbags': [0, 0, 0, 1.35] };

const officePreviewZoom = (id) => OFFICE_FUN_PREVIEW[id]?.[3] ?? 1.2;

function officeFunPreview(f, look, id, time) {
  const [x, z, facing] = OFFICE_FUN_PREVIEW[id] ?? [0, 0, 0];
  const fac = { id, act: OFFICE_FUN[id].act, x, z, facing, where: 'games', couch: id === 'office-console' ? { x, z: z + 1.4 } : null };
  officeFrameAt(x, z, facing);
  OFFICE_FUN_DRAW[fac.act](f, look, fac, { actors: new Map(), preview: true }, time);
}

// A room that opens off another not built yet is shown with that one ghosted too, or its preview would float on its own.
function officePlanScene(p, spec) {
  const need = OFFICE_ROOMS[spec.room]?.needs;
  const first = need && !need.some((id) => spec.rooms?.includes(id)) ? [need[0]] : [];
  const ghosts = new Set(spec.rooms?.includes(spec.room) ? [] : [spec.room, ...first]);
  const key = [...ghosts, '|', ...(spec.rooms ?? []), '|', ...(spec.addons ?? [])].join();
  if (p.plan?.key === key) return p.plan;
  const floor = officeFloor(spec.addons ?? [], [...(spec.rooms ?? []), ...ghosts]);
  p.plan = { key, ghosts, layout: officeLayout(floor.capacity, floor), actors: new Map(), boss: null, addons: spec.addons ?? [], trophies: OFFICE_PREVIEW_TROPHIES, building: new Map() };
  return p.plan;
}

function officePlanPreview(p, aspect, time) {
  const { frame: f, look } = p;
  const scene = officePlanScene(p, p.spec);
  const L = scene.layout;
  officeRoom(f, look, L, time, 0);
  officeRooms(f, look, scene, time, { ids: scene.ghosts, tint: officeLin(officeMix(look.t.accent, [1, 1, 1], 0.3)) });
  officePods(f, look, scene, time);
  officeBoss(f, look, L, null, time);
  officeLounge(f, look, L);
  officeFacilities(f, look, scene, time, 'lounge');
  officeWearAddons(f, look, scene, time);
  const yaw = OFFICE_YAW0 + (time.still ? 0 : Math.sin(time.t * 0.25) * 0.08);
  const fit = officeFit(L, aspect, yaw, OFFICE_PITCH0);
  return officeCamera({ yaw, pitch: OFFICE_PITCH0, zoom: fit.hh, target: fit.target }, aspect);
}
