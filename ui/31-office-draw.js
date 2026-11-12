const OFFICE_KIND_TOKENS = { review: '--viz-1', fix: '--viz-2', kickoff: '--viz-3', ticket: '--info', message: '--viz-5', master: '--moved', manager: '--moved', player: '--viz-4' };
const OFFICE_WALL_H = 2.2;
const OFFICE_DOOR_W = 1.0;
const OFFICE_DOOR_H = 1.75;
const OFFICE_HEAD_Y = 1.36;
const officeM = officeM4();
const officeRoot = officeM4();
const officeJoint = officeM4();
const officePart = officeM4();

function officeParse(value) {
  const v = String(value).trim();
  if (/^#[\da-f]{3}$/i.test(v)) return [1, 2, 3].map((i) => parseInt(v[i] + v[i], 16) / 255);
  if (/^#[\da-f]{6}/i.test(v)) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
  const parts = v.match(/[\d.]+/g)?.map(Number) ?? [0.5, 0.5, 0.5];
  return parts.slice(0, 3).map((n) => n / 255);
}

const officeLin = (c) => c.map((v) => v ** 2.2);
const officeMix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const officeLuma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

function officeTokens() {
  const css = getComputedStyle(document.documentElement);
  const read = (name, fallback) => officeParse(css.getPropertyValue(name).trim() || fallback);
  const names = {
    bg: '#0b0e13', panel: '#141922', raised: '#1a202b', hover: '#202734', line: '#232a36', lineStrong: '#2f3846', fg: '#e6eaf1', muted: '#9aa3b3', faint: '#687183',
    accent: '#8aa8ff', accentStrong: '#5f86ff', info: '#55cfd2', need: '#ff7a66', done: '#5fd394', moved: '#c58cff', consoleBg: '#06080c',
    viz1: '#3987e5', viz2: '#d95926', viz3: '#199e70', viz4: '#c98500', viz5: '#d55181',
  };
  const kebab = (k) => '--' + k.replace(/([A-Z])/g, '-$1').replace(/(\d)/, '-$1').toLowerCase();
  const t = Object.fromEntries(Object.entries(names).map(([k, fallback]) => [k, read(kebab(k), fallback)]));
  t.kinds = Object.fromEntries(Object.entries(OFFICE_KIND_TOKENS).map(([kind, token]) => [kind, read(token, '#9aa3b3')]));
  return t;
}

// Every colour is a mix of the page's own tokens, so the room follows light and dark with the rest of the page.
function officeLook() {
  const t = officeTokens();
  const light = officeLuma(t.bg) > 0.5;
  const m = (a, b, k) => officeLin(officeMix(a, b, k));
  const sun = [0.34, 0.82, 0.46];
  const n = Math.hypot(...sun);
  return {
    light, t,
    sun: sun.map((v) => v / n),
    sunColour: light ? [0.44, 0.43, 0.41] : [0.62, 0.6, 0.62],
    sky: light ? [0.66, 0.67, 0.7] : [0.62, 0.65, 0.78],
    ground: light ? [0.22, 0.22, 0.25] : [0.2, 0.19, 0.22],
    floor: light ? m(t.line, t.raised, 0.25) : m(t.hover, t.lineStrong, 0.35),
    slab: light ? m(t.lineStrong, t.muted, 0.2) : m(t.line, t.bg, 0.1),
    wall: light ? m(t.panel, t.raised, 0.3) : m(t.lineStrong, t.muted, 0.12),
    cap: light ? m(t.lineStrong, t.line, 0.3) : m(t.lineStrong, t.muted, 0.4),
    skirt: light ? m(t.lineStrong, t.muted, 0.15) : m(t.line, t.bg, 0.3),
    glass: m(t.info, light ? t.panel : t.bg, light ? 0.6 : 0.5),
    desk: light ? m(t.panel, t.raised, 0.2) : m(t.lineStrong, t.muted, 0.35),
    leg: light ? m(t.lineStrong, t.muted, 0.35) : m(t.line, t.bg, 0.2),
    partition: light ? m(t.accent, t.raised, 0.84) : m(t.accentStrong, t.raised, 0.78),
    chair: light ? m(t.accentStrong, t.lineStrong, 0.45) : m(t.accentStrong, t.line, 0.55),
    screen: m(t.consoleBg, t.line, 0.2),
    code: officeLin(t.accent),
    work: officeLin(t.info),
    ask: officeLin(t.viz4),
    lampOff: m(t.faint, t.lineStrong, 0.4),
    sofa: light ? m(t.viz5, t.lineStrong, 0.42) : m(t.viz5, t.line, 0.5),
    cushion: light ? m(t.viz5, t.panel, 0.55) : m(t.viz5, t.lineStrong, 0.4),
    table: m(t.accentStrong, t.consoleBg, light ? 0.18 : 0.3),
    chalk: officeLin(officeMix(t.fg, [1, 1, 1], light ? 1 : 0.3)),
    paddle: officeLin(t.need),
    ball: officeLin([0.98, 0.97, 0.94]),
    counter: light ? m(t.panel, t.lineStrong, 0.35) : m(t.hover, t.lineStrong, 0.6),
    machine: m(t.consoleBg, t.lineStrong, 0.25),
    pot: m(t.viz2, t.lineStrong, 0.45),
    leaf: officeLin(t.viz3),
    leafDark: m(t.viz3, t.consoleBg, 0.35),
    door: light ? m(t.accentStrong, t.lineStrong, 0.5) : m(t.accentStrong, t.line, 0.45),
    board: m(t.panel, [1, 1, 1], light ? 0.6 : 0.2),
    eye: m(t.consoleBg, t.bg, 0.2),
    kinds: Object.fromEntries(Object.entries(t.kinds).map(([kind, c]) => [kind, officeLin(c)])),
    heads: Object.fromEntries(Object.entries(t.kinds).map(([kind, c]) => [kind, officeLin(officeMix(c, [1, 1, 1], 0.45))])),
    quiet: officeLin(t.muted),
    shadow: light ? [0.09, 0.12, 0.2, 0.2] : [0, 0, 0, 0.42],
    rug: [...officeMix(t.accent, light ? t.panel : t.raised, light ? 0.84 : 0.8), 1],
    ring: [...t.accent, 0.95],
    askGlow: [...t.viz4, light ? 0.55 : 0.6],
    workGlow: [...t.info, light ? 0.16 : 0.22],
  };
}

function officeBox(f, rgb, x, y, z, w, h, d, yaw = 0, glow = 0) {
  officeSolid(f, 'box', officePose(officeM, x, y, z, yaw, 0, 0, w, h, d), rgb, glow);
}

function officeCyl(f, rgb, x, y, z, r, h, glow = 0) {
  officeSolid(f, 'cyl', officePose(officeM, x, y, z, 0, 0, 0, r * 2, h, r * 2), rgb, glow);
}

function officeShadow(f, look, x, z, w, d, soft = 0.35, strength = 1) {
  officeDecal(f.floor, [x, 0.004, z], [w / 2, 0, 0], [0, 0, d / 2], [...look.shadow.slice(0, 3), look.shadow[3] * strength], [0, soft, (Math.min(w, d) / d) * 0.5, w / d]);
}

function officeFloorGlow(f, rgba, x, z, r) {
  officeDecal(f.floor, [x, 0.005, z], [r, 0, 0], [0, 0, r], rgba, [2, 0, 0, 1]);
}

function officeRoom(f, look, L, time, door) {
  const S = OFFICE_STARTER;
  officeBox(f, look.floor, S.x1 / 2, -0.12, S.z1 / 2, S.x1, 0.24, S.z1);
  officeBox(f, look.slab, S.x1 / 2, -0.3, S.z1 / 2, S.x1 - 0.04, 0.12, S.z1 - 0.04);
  officeDecal(f.floor, [12.2, 0.003, 1.9], [1.75, 0, 0], [0, 0, 1.5], look.rug, [3, 0, 0.35, 1.75 / 1.5]);
  officeWalls(f, look, L);
  officeWindows(f, look, L);
  officeDoor(f, look, L, door);
  officeBoard(f, look, L);
  officeClock(f, look, time);
}

function officeWalls(f, look, L) {
  const h = OFFICE_WALL_H;
  const { x1: w, z1: d } = OFFICE_STARTER;
  const door0 = L.door.z - OFFICE_DOOR_W / 2;
  const door1 = L.door.z + OFFICE_DOOR_W / 2;
  officeBox(f, look.wall, w / 2 - 0.08, h / 2, -0.08, w + 0.16, h, 0.16);
  officeBox(f, look.wall, -0.08, h / 2, door0 / 2, 0.16, h, door0);
  officeBox(f, look.wall, -0.08, h / 2, (door1 + d) / 2, 0.16, h, d - door1);
  officeBox(f, look.wall, -0.08, (h + OFFICE_DOOR_H) / 2, L.door.z, 0.16, h - OFFICE_DOOR_H, OFFICE_DOOR_W);
  officeBox(f, look.cap, w / 2 - 0.08, h + 0.02, -0.08, w + 0.2, 0.04, 0.2);
  officeBox(f, look.cap, -0.08, h + 0.02, d / 2, 0.2, 0.04, d + 0.04);
  officeBox(f, look.skirt, w / 2, 0.05, 0.01, w, 0.1, 0.03);
  officeBox(f, look.skirt, 0.01, 0.05, door0 / 2, 0.03, 0.1, door0);
  officeBox(f, look.skirt, 0.01, 0.05, (door1 + d) / 2, 0.03, 0.1, d - door1);
}

function officeWindows(f, look, L) {
  for (const x of [2.7, 5.6, 8.5]) {
    officeBox(f, look.glass, x, 1.38, 0.0, 1.9, 0.92, 0.03, 0, look.light ? 0.25 : 0.35);
    officeBox(f, look.cap, x, 0.9, 0.04, 2.0, 0.05, 0.1);
    officeBox(f, look.cap, x, 1.86, 0.02, 2.0, 0.05, 0.05);
    for (const dx of [-0.97, 0, 0.97]) officeBox(f, look.cap, x + dx, 1.38, 0.02, 0.05, 0.96, 0.05);
  }
}

function officeDoor(f, look, L, open) {
  const z0 = L.door.z - OFFICE_DOOR_W / 2;
  const angle = open * 1.35;
  const half = OFFICE_DOOR_W / 2 - 0.03;
  officeBox(f, look.cap, 0.0, OFFICE_DOOR_H + 0.04, L.door.z, 0.2, 0.08, OFFICE_DOOR_W + 0.12);
  for (const z of [z0 - 0.03, z0 + OFFICE_DOOR_W + 0.03]) officeBox(f, look.cap, 0.0, OFFICE_DOOR_H / 2, z, 0.2, OFFICE_DOOR_H, 0.06);
  const hz = z0 + 0.03;
  const cx = Math.sin(angle) * half;
  const cz = hz + Math.cos(angle) * half;
  officeBox(f, look.door, cx + 0.02, OFFICE_DOOR_H / 2, cz, 0.05, OFFICE_DOOR_H - 0.04, half * 2, angle);
  officeSolid(f, 'ball', officePose(officeM, cx + 0.07 + Math.sin(angle) * 0.3, 0.92, cz + Math.cos(angle) * 0.36, 0, 0, 0, 0.06, 0.06, 0.06), look.cap);
}

function officeBoard(f, look, L) {
  const z = L.board.z;
  officeBox(f, look.cap, 0.02, 1.25, z, 0.04, 0.9, L.board.w + 0.08);
  officeBox(f, look.board, 0.045, 1.25, z, 0.02, 0.82, L.board.w);
  officeBox(f, look.cap, 0.08, 0.82, z, 0.08, 0.03, L.board.w * 0.8);
  const ink = [look.kinds.review, look.kinds.fix, look.kinds.kickoff];
  [[1.45, -0.45, 0.5], [1.32, -0.25, 0.7], [1.15, 0.2, 0.9], [1.0, 0.1, 0.5]].forEach(([y, dz, w], i) => officeBox(f, ink[i % 3], 0.06, y, z + dz, 0.01, 0.035, w));
}

function officeClock(f, look, time) {
  const x = 11.75;
  const y = 1.62;
  officeSolid(f, 'cyl', officePose(officeM, x, y, 0.02, 0, Math.PI / 2, 0, 0.46, 0.05, 0.46), look.cap);
  officeSolid(f, 'cyl', officePose(officeM, x, y, 0.05, 0, Math.PI / 2, 0, 0.4, 0.02, 0.4), look.board);
  const wall = wallOf(time.wall);
  const hours = ((wall.minutes / 60) % 12) / 12;
  const minutes = ((wall.minutes % 60) + wall.seconds / 60) / 60;
  for (const [turn, len] of [[hours, 0.11], [minutes, 0.16]]) {
    const a = -turn * Math.PI * 2;
    officeSolid(f, 'box', officePose(officeM, x - Math.sin(a) * len / 2, y + Math.cos(a) * len / 2, 0.07, 0, 0, a, 0.022, len, 0.01), look.eye);
  }
}

function officePods(f, look, scene, time, which = (p) => p.i < OFFICE_PODS_PER_ROOM) {
  const L = scene.layout;
  const owners = new Map([...scene.actors.values()].filter((a) => a.spot?.startsWith('pod:') || a.spot?.startsWith('stand:')).map((a) => [Number(a.spot.split(':')[1]), a]));
  for (const p of L.pods.filter(which)) officePodAt(f, look, p, owners.get(p.i), time, p.z > 1);
}

function officePodAt(f, look, p, actor, time, freeStanding) {
  const { w, d, h } = OFFICE_DESK;
  const asking = actor?.role === 'wave';
  const working = actor?.role === 'pod' && !actor.path.length;
  officeShadow(f, look, p.x, p.z, w + 0.2, d + 0.2, 0.3, 0.8);
  officeBox(f, look.desk, p.x, h - 0.02, p.z, w, 0.04, d);
  for (const dx of [-w / 2 + 0.04, w / 2 - 0.04]) officeBox(f, look.leg, p.x + dx, (h - 0.04) / 2, p.z, 0.05, h - 0.04, d - 0.08);
  officeBox(f, look.leg, p.x, 0.33, p.z - d / 2 + 0.06, w - 0.1, 0.32, 0.02);
  if (freeStanding) officeBox(f, look.partition, p.x, h + 0.2, p.z - d / 2 - 0.02, w + 0.1, 0.44, 0.04);
  officeBox(f, look.partition, p.x - w / 2 - 0.12, h / 2 + 0.12, p.z, 0.04, h + 0.24, d + 0.04);
  officeMonitor(f, look, p.x, p.z - 0.12, actor, working, asking, time);
  officeBox(f, look.leg, p.x, h + 0.01, p.z + 0.12, 0.42, 0.015, 0.14);
  officeLamp(f, look, p.x + w / 2 - 0.1, p.z - d / 2 + 0.12, asking, working, time);
  if (asking) officeFloorGlow(f, [...look.askGlow.slice(0, 3), look.askGlow[3] * (0.75 + 0.25 * Math.sin(time.t * 5))], p.x, p.z + 0.7, 1.15);
  else if (working) officeFloorGlow(f, look.workGlow, p.x, p.z + 0.45, 0.9);
  officeChair(f, look, p.x, p.z + 0.66, actor?.pose === 'type' ? Math.PI : Math.PI + 0.35);
  officeDeskProps(f, look, p);
}

function officeMonitor(f, look, x, z, actor, working, asking, time) {
  const h = OFFICE_DESK.h;
  officeBox(f, look.leg, x, h + 0.06, z, 0.06, 0.12, 0.04);
  officeBox(f, look.leg, x, h + 0.005, z, 0.2, 0.01, 0.12);
  officeBox(f, look.screen, x, h + 0.3, z, 0.6, 0.36, 0.035);
  const flicker = working ? 0.75 + 0.15 * Math.sin(time.t * 23 + x) * Math.sin(time.t * 7.3 + x * 3) + (actor?.pulse ?? 0) * 0.6 : 0;
  officeBox(f, working ? look.work : look.screen, x, h + 0.3, z + 0.02, 0.54, 0.3, 0.005, 0, flicker * 0.55);
  if (asking) return officeBangScreen(f, look, x, h + 0.3, z + 0.026, time);
  if (!working) return;
  const tick = Math.floor(time.t * 4 + x * 7);
  for (let i = 0; i < 5; i++) {
    const width = 0.12 + (officeHash(tick - i + ':' + x) % 30) / 100;
    officeBox(f, look.code, x - 0.24 + width / 2 + (i % 2) * 0.04, h + 0.4 - i * 0.05, z + 0.025, width, 0.018, 0.004, 0, 0.7 + (actor?.pulse ?? 0));
  }
}

function officeBangScreen(f, look, x, y, z, time) {
  const glow = 0.7 + 0.3 * Math.sin(time.t * 5);
  officeBox(f, look.ask, x, y + 0.035, z, 0.045, 0.15, 0.004, 0, glow);
  officeBox(f, look.ask, x, y - 0.09, z, 0.045, 0.045, 0.004, 0, glow);
  for (const dy of [-0.14, 0.14]) officeBox(f, look.ask, x, y + dy, z, 0.54, 0.018, 0.004, 0, glow * 0.6);
}

function officeLamp(f, look, x, z, asking, working, time) {
  const h = OFFICE_DESK.h;
  officeCyl(f, look.leg, x, h + 0.02, z, 0.05, 0.04);
  officeCyl(f, look.leg, x, h + 0.14, z, 0.012, 0.22);
  const blink = asking ? 0.65 + 0.35 * Math.sin(time.t * 6) : 0.9;
  const colour = asking ? look.ask : working ? look.work : look.lampOff;
  officeSolid(f, 'ball', officePose(officeM, x, h + 0.28, z, 0, 0, 0, 0.1, 0.1, 0.1), colour, asking || working ? blink : 0);
  if (asking || working) officeDecal(f.glow, [x, h + 0.28, z], [0.28, 0, 0], [0, 0.28, 0], [...(asking ? look.askGlow : look.workGlow).slice(0, 3), asking ? 0.5 * blink : 0.3], [2, 0, 0, 1]);
}

function officeChair(f, look, x, z, yaw, scale = 1) {
  officeShadow(f, look, x, z, 0.5 * scale, 0.5 * scale, 0.22);
  officeCyl(f, look.leg, x, 0.03, z, 0.22 * scale, 0.04);
  officeCyl(f, look.leg, x, 0.17, z, 0.025, 0.28);
  officeSolid(f, 'box', officePose(officeM, x, 0.33, z, yaw, 0, 0, 0.44 * scale, 0.07, 0.42 * scale), look.chair);
  const bx = x + Math.sin(yaw) * -0.2 * scale;
  const bz = z + Math.cos(yaw) * -0.2 * scale;
  officeSolid(f, 'box', officePose(officeM, bx, 0.58 * scale, bz, yaw, -0.12, 0, 0.42 * scale, 0.42 * scale, 0.06), look.chair);
}

function officeDeskProps(f, look, p) {
  const kind = p.i % 4;
  const { h } = OFFICE_DESK;
  if (kind === 1) officeCyl(f, look.cushion, p.x - 0.42, h + 0.05, p.z + 0.1, 0.04, 0.09);
  if (kind === 2) officePlant(f, look, p.x - 0.42, p.z - 0.12, 0.28, h);
  if (kind === 3) [0, 1].forEach((i) => officeBox(f, i ? look.chair : look.door, p.x - 0.4, h + 0.02 + i * 0.035, p.z - 0.1, 0.2, 0.03, 0.14, 0.2 * i));
}

function officeBoss(f, look, L, actor, time) {
  const b = L.boss;
  const asking = actor?.role === 'wave';
  const working = actor?.role === 'pod';
  officeShadow(f, look, b.x, b.z, b.w + 0.3, b.dd + 0.3, 0.35);
  officeBox(f, look.desk, b.x, b.h - 0.025, b.z, b.w, 0.05, b.dd);
  officeBox(f, look.partition, b.x, b.h / 2, b.z - b.dd / 2 + 0.05, b.w - 0.04, b.h - 0.05, 0.06);
  for (const dx of [-1, 1]) officeBox(f, look.partition, b.x + dx * (b.w / 2 - 0.05), b.h / 2, b.z, 0.08, b.h - 0.05, b.dd - 0.04);
  for (const dx of [-0.36, 0.36]) officeMonitor(f, look, b.x + dx, b.z - 0.18, actor, working, asking, time);
  officeLamp(f, look, b.x + b.w / 2 - 0.16, b.z - 0.25, asking, working, time);
  officeCyl(f, look.cushion, b.x - b.w / 2 + 0.25, b.h + 0.05, b.z + 0.12, 0.045, 0.1);
  officePlant(f, look, b.x - b.w / 2 + 0.2, b.z - 0.22, 0.36, b.h);
  officeChair(f, look, b.x, b.z + 0.72, Math.PI, 1.18);
  if (asking) officeFloorGlow(f, look.askGlow, b.x, b.z + 0.8, 1.3);
}

function officeLounge(f, look, L) {
  officeSofa(f, look, L.sofa);
  if (L.coffee) officeCoffee(f, look, L.coffee);
  officeTable(f, look, L.table);
  const c = L.chat;
  officeShadow(f, look, c.x, c.z, 0.7, 0.7, 0.3);
  officeCyl(f, look.leg, c.x, 0.02, c.z, 0.24, 0.04);
  officeCyl(f, look.leg, c.x, 0.45, c.z, 0.03, 0.86);
  officeCyl(f, look.desk, c.x, 0.89, c.z, c.r, 0.04);
  for (const [x, z, s] of L.plants) officePlant(f, look, x, z, s, 0);
}

function officeSofa(f, look, s) {
  officeShadow(f, look, s.x, s.z, s.w + 0.25, s.dd + 0.25, 0.3);
  officeBox(f, look.sofa, s.x, 0.17, s.z, s.w, 0.24, s.dd);
  officeBox(f, look.sofa, s.x, 0.48, s.z - s.dd / 2 + 0.1, s.w, 0.5, 0.2);
  for (const dx of [-1, 1]) officeBox(f, look.sofa, s.x + dx * (s.w / 2 - 0.08), 0.36, s.z + 0.02, 0.16, 0.3, s.dd - 0.02);
  for (let i = 0; i < 3; i++) {
    const x = s.x + (i - 1) * 0.68;
    officeBox(f, look.cushion, x, 0.33, s.z + 0.08, 0.64, 0.09, s.dd - 0.24);
    officeSolid(f, 'box', officePose(officeM, x, 0.55, s.z - s.dd / 2 + 0.24, 0, -0.18, 0, 0.6, 0.36, 0.1), look.cushion);
  }
}

function officeCoffee(f, look, c) {
  officeShadow(f, look, c.x, c.z, c.w + 0.2, c.dd + 0.2, 0.25);
  officeBox(f, look.counter, c.x, c.h / 2, c.z, c.w, c.h, c.dd);
  officeBox(f, look.desk, c.x, c.h + 0.02, c.z, c.w + 0.04, 0.04, c.dd + 0.04);
  officeBox(f, look.machine, c.x + 0.12, c.h + 0.26, c.z - 0.05, 0.38, 0.48, 0.36);
  officeBox(f, look.leg, c.x + 0.12, c.h + 0.17, c.z + 0.12, 0.2, 0.05, 0.1);
  officeCyl(f, look.board, c.x + 0.12, c.h + 0.07, c.z + 0.13, 0.04, 0.08);
  officeSolid(f, 'ball', officePose(officeM, c.x + 0.24, c.h + 0.42, c.z + 0.135, 0, 0, 0, 0.04, 0.04, 0.04), officeLin(look.t.done), 1);
  for (let i = 0; i < 3; i++) officeCyl(f, look.board, c.x - 0.3, c.h + 0.07 + i * 0.07, c.z + 0.05, 0.05, 0.065);
}

function officeTable(f, look, t) {
  officeShadow(f, look, t.x, t.z, t.w + 0.3, t.l + 0.3, 0.4);
  officeBox(f, look.table, t.x, t.h - 0.025, t.z, t.w, 0.05, t.l);
  const top = t.h + 0.001;
  officeBox(f, look.chalk, t.x, top, t.z, 0.02, 0.004, t.l - 0.04);
  for (const side of [-1, 1]) {
    officeBox(f, look.chalk, t.x + side * (t.w / 2 - 0.02), top, t.z, 0.03, 0.004, t.l);
    officeBox(f, look.chalk, t.x, top, t.z + side * (t.l / 2 - 0.02), t.w, 0.004, 0.03);
    for (const end of [-1, 1]) officeBox(f, look.leg, t.x + side * (t.w / 2 - 0.12), (t.h - 0.05) / 2, t.z + end * (t.l / 2 - 0.2), 0.05, t.h - 0.05, 0.05);
  }
  officeBox(f, look.chalk, t.x, t.h + 0.07, t.z, t.w + 0.12, 0.12, 0.012, 0, 0.15);
  for (const side of [-1, 1]) officeCyl(f, look.leg, t.x + side * (t.w / 2 + 0.06), t.h + 0.07, t.z, 0.015, 0.16);
}

function officePlant(f, look, x, z, s, base) {
  if (!base) officeShadow(f, look, x, z, 0.6 * s, 0.6 * s, 0.25);
  officeCyl(f, look.pot, x, base + 0.17 * s, z, 0.18 * s, 0.34 * s);
  officeCyl(f, look.leafDark, x, base + 0.345 * s, z, 0.16 * s, 0.01);
  [[0, 0.62, 0, 0.42], [0.1, 0.82, 0.06, 0.32], [-0.09, 0.78, -0.05, 0.3], [0.02, 1.0, -0.02, 0.24]].forEach(([dx, dy, dz, r], i) => {
    officeSolid(f, 'gem', officePose(officeM, x + dx * s, base + dy * s, z + dz * s, i * 0.9, 0.3 * i, 0, r * s, r * s * 1.1, r * s), i % 2 ? look.leafDark : look.leaf);
  });
}

function officeKindLook(look, kind) {
  return { body: look.kinds[kind] ?? look.quiet, head: look.heads[kind] ?? look.quiet };
}

function officeKindOf(actor) {
  if (actor.manager) return 'manager';
  return actor.agent?.player ? 'player' : actor.agent?.kind;
}

function officeCharacter(f, look, actor, time, marked, outfit = null) {
  const colours = officeWearColours(look, outfit, officeKindLook(look, officeKindOf(actor)));
  const pose = officeBodyPose(actor, time);
  const face = OFFICE_FACES[actor.mood?.mood] ?? OFFICE_FACES.content;
  const scale = actor.manager ? 1.3 : 1.12;
  const x = actor.x + pose.dx;
  const z = actor.z + pose.dz;
  officeShadow(f, look, x, z, 0.5 * scale, 0.5 * scale, 0.22, pose.sit ? 0.5 : 1);
  if (marked) officeDecal(f.floor, [x, 0.006, z], [0.42 * scale, 0, 0], [0, 0, 0.42 * scale], look.ring, [1, 0.05, 0.82, 1]);
  if (colours.aura) officeFloorGlow(f, colours.aura, x, z, 0.75 * scale);
  officePose(officeRoot, x, pose.lift, z, actor.facing + pose.turn, pose.lean, pose.tilt, scale, scale, scale);
  officeLimb(f, 'pill', colours.body, 0.075, 0.24, pose.legs[0], 0, 0.15, 0.24, colours.glow);
  officeLimb(f, 'pill', colours.body, -0.075, 0.24, pose.legs[1], 0, 0.15, 0.24, colours.glow);
  officeLocal(f, 'pill', colours.body, 0, 0.52, 0, 0.36, 0.35, 0.34, colours.glow);
  if (colours.pattern) officeWearPattern(f, colours);
  officeArms(f, look, pose, colours, scale, actor.facing + pose.turn, outfit?.held, time);
  if (actor.manager) officeLocal(f, 'box', look.ask, 0, 0.62, 0.175, 0.055, 0.2, 0.02);
  if (pose.hold === 'laptop') officeLaptop(f, look, pose.sit, time);
  officePose(officeJoint, 0, 0.93, 0, pose.head[0], pose.head[1], 0);
  officeMul(officePart, officeRoot, officeJoint);
  officeHead(f, look, officeFaceTint(look, colours.head, face), pose.blink, colours.glow + (face.flush ?? 0), face);
  if (pose.headset) officeHeadset(f, look, time);
  if (outfit?.hat) officeWearHat(f, look, outfit.hat, time);
}

function officeArms(f, look, pose, colours, scale, yaw, held, time) {
  const hands = [0, 1].map((i) => officeLimb(f, 'limb', colours.body, i ? -0.19 : 0.19, 0.68, pose.arms[i][0], pose.arms[i][1], 0.095, 0.31, colours.glow));
  for (const [x, y, z] of hands) officeSolid(f, 'ball', officePose(officeM, x, y, z, 0, 0, 0, 0.12 * scale, 0.12 * scale, 0.12 * scale), colours.head, colours.glow);
  const busy = pose.hold === 'paddle' ? 1 : 0;
  officeHeld(f, look, pose.hold, hands[busy], yaw, hands[1 - busy]);
  if (pose.watch) officeSolid(f, 'cyl', officePose(officeM, hands[0][0], hands[0][1] + 0.05, hands[0][2], yaw, 0, Math.PI / 2, 0.07, 0.03, 0.07), officeLin(look.t.viz4), 0.3);
  if (held && !OFFICE_BOTH_HANDS.has(pose.hold)) officeWearHeld(f, look, held, hands[1 - busy], yaw, time);
}

function officeLocal(f, mesh, rgb, x, y, z, sx, sy, sz, glow = 0) {
  officePose(officeJoint, x, y, z, 0, 0, 0, sx, sy, sz);
  officeSolid(f, mesh, officeMul(officeM, officeRoot, officeJoint), rgb, glow);
}

// A limb hangs from its joint, so it turns about the top and its mesh sits half its length below; the end it reaches is returned.
function officeLimb(f, mesh, rgb, x, y, pitch, roll, width, length, glow = 0) {
  const shapeLength = mesh === 'limb' ? 3 : 1.6;
  officePose(officeJoint, x, y, 0, 0, pitch, roll);
  officeMul(officePart, officeRoot, officeJoint);
  const p = officePart;
  const end = [p[12] - p[4] * length, p[13] - p[5] * length, p[14] - p[6] * length];
  officePose(officeJoint, 0, -length / 2, 0, 0, 0, 0, width, length / shapeLength, width);
  officeSolid(f, mesh, officeMul(officeM, officePart, officeJoint), rgb, glow);
  return end;
}

// Brows tilt by how the face feels: up at the middle when sad, down at the middle when cross.
const OFFICE_FACES = {
  happy: { brow: [0.135, 0.18], mouth: 'smile', blush: true },
  cheer: { brow: [0.145, 0.3], mouth: 'open', blush: true, eyes: 0.03 },
  content: { brow: [0.13, 0.12], mouth: 'soft' },
  fresh: { brow: [0.14, 0.22], mouth: 'soft' },
  impatient: { brow: [0.12, -0.05], mouth: 'flat', tint: ['viz4', 0.15] },
  grumpy: { brow: [0.095, -0.45], mouth: 'frown', tint: ['muted', 0.6], eyes: 0.042 },
  angry: { brow: [0.088, -0.7], mouth: 'shout', tint: ['need', 0.85], flush: 0.3, eyes: 0.04 },
  sad: { brow: [0.115, 0.55], mouth: 'frown', tint: ['viz1', 0.35], tear: true },
};
const OFFICE_BOTH_HANDS = new Set(['pad', 'phone', 'fork', 'laptop']);

function officeFaceTint(look, rgb, face) {
  if (!face.tint) return face.blush ? officeMix(rgb, [1, 1, 1], 0.08) : rgb;
  const [token, k] = face.tint;
  return officeMix(rgb, officeLin(look.t[token]), k);
}

function officeHead(f, look, rgb, blink, glow = 0, face = OFFICE_FACES.content) {
  const at = (x, y, z, sx, sy, sz, roll = 0) => officeMul(officeM, officePart, officePose(officeJoint, x, y, z, 0, 0, roll, sx, sy, sz));
  officeSolid(f, 'ball', at(0, 0, 0, 0.42, 0.4, 0.4), rgb, glow);
  for (const x of [-0.075, 0.075]) officeSolid(f, 'ball', at(x, 0.02, 0.18, 0.055, blink ? 0.008 : face.eyes ?? 0.065, 0.04), look.eye);
  const [browY, tilt] = face.brow;
  for (const side of [-1, 1]) officeSolid(f, 'box', at(side * 0.078, browY, 0.145, 0.07, 0.017, 0.04, -side * tilt), look.eye);
  OFFICE_MOUTHS[face.mouth](f, look, at);
  if (face.blush) for (const side of [-1, 1]) officeSolid(f, 'ball', at(side * 0.125, -0.035, 0.145, 0.07, 0.035, 0.03), officeLin(officeMix(look.t.viz5, [1, 1, 1], 0.35)), 0.15);
  if (face.tear) officeSolid(f, 'ball', at(0.09, -0.045, 0.172, 0.026, 0.038, 0.02), officeLin(look.t.info), 0.5);
}

const OFFICE_MOUTHS = {
  smile: (f, look, at) => {
    officeSolid(f, 'box', at(0, -0.088, 0.178, 0.05, 0.018, 0.025), look.eye);
    for (const side of [-1, 1]) officeSolid(f, 'box', at(side * 0.04, -0.077, 0.174, 0.036, 0.018, 0.025, side * 0.6), look.eye);
  },
  soft: (f, look, at) => {
    for (const side of [-1, 1]) officeSolid(f, 'box', at(side * 0.018, -0.083, 0.18, 0.04, 0.016, 0.025, side * 0.25), look.eye);
  },
  flat: (f, look, at) => officeSolid(f, 'box', at(0, -0.082, 0.18, 0.07, 0.016, 0.025), look.eye),
  frown: (f, look, at) => {
    officeSolid(f, 'box', at(0, -0.074, 0.18, 0.048, 0.018, 0.025), look.eye);
    for (const side of [-1, 1]) officeSolid(f, 'box', at(side * 0.039, -0.086, 0.175, 0.036, 0.018, 0.025, -side * 0.6), look.eye);
  },
  open: (f, look, at) => {
    officeSolid(f, 'ball', at(0, -0.082, 0.17, 0.085, 0.065, 0.04), look.eye);
    officeSolid(f, 'ball', at(0, -0.1, 0.178, 0.045, 0.022, 0.02), officeLin(look.t.viz5));
  },
  shout: (f, look, at) => {
    officeSolid(f, 'ball', at(0, -0.088, 0.168, 0.1, 0.075, 0.045), look.eye);
    officeSolid(f, 'box', at(0, -0.062, 0.185, 0.07, 0.014, 0.012), look.board);
  },
};

function officeHeadset(f, look, time) {
  const at = (x, y, z, sx, sy, sz) => officeMul(officeM, officePart, officePose(officeJoint, x, y, z, 0, 0, 0, sx, sy, sz));
  const w = officeWearOf(look);
  officeSolid(f, 'cyl', at(0, 0.04, 0, 0.45, 0.05, 0.43), w.dark);
  officeSolid(f, 'box', at(0, 0.03, 0.17, 0.32, 0.13, 0.12), w.dark, -0.4);
  officeSolid(f, 'box', at(0, 0.03, 0.232, 0.27, 0.075, 0.01), w.cyan, time.still ? 0.8 : 0.7 + 0.3 * Math.sin(time.t * 4));
}

const officeLid = officeM4();

function officeLaptop(f, look, seated, time) {
  const y = seated ? 0.46 : 0.52;
  officeLocal(f, 'box', look.leg, 0, y, 0.3, 0.3, 0.014, 0.2);
  officeSolid(f, 'box', officeMul(officeLid, officeRoot, officePose(officeJoint, 0, y + 0.1, 0.4, 0, -0.25, 0, 0.3, 0.2, 0.012)), look.leg);
  officeSolid(f, 'box', officeMul(officeLid, officeRoot, officePose(officeJoint, 0, y + 0.1, 0.393, 0, -0.25, 0, 0.26, 0.16, 0.006)), look.work, time.still ? 0.5 : 0.45 + 0.1 * Math.sin(time.t * 7));
}

function officeHeld(f, look, hold, [x, y, z], yaw, other = [x, y, z]) {
  if (hold === 'cup') officeSolid(f, 'cyl', officePose(officeM, x, y + 0.02, z, 0, 0, 0, 0.085, 0.1, 0.085), look.board);
  if (hold === 'pad' || hold === 'phone') return officeHandheld(f, look, hold, [(x + other[0]) / 2, (y + other[1]) / 2, (z + other[2]) / 2], yaw);
  if (hold === 'fork') officeSolid(f, 'box', officePose(officeM, x, y + 0.06, z, yaw, -0.3, 0, 0.02, 0.14, 0.02), officeWearOf(look).silver, -0.6);
  if (hold !== 'paddle') return;

  officeSolid(f, 'cyl', officePose(officeM, x, y + 0.1, z, yaw, Math.PI / 2, 0, 0.19, 0.025, 0.2), look.paddle);
  officeSolid(f, 'box', officePose(officeM, x, y + 0.01, z, yaw, 0, 0, 0.035, 0.08, 0.035), look.leg);
}

function officeHandheld(f, look, hold, [x, y, z], yaw) {
  const w = officeWearOf(look);
  const back = [Math.sin(yaw) * -0.012, Math.cos(yaw) * -0.012];
  if (hold === 'phone') {
    officeSolid(f, 'box', officePose(officeM, x, y + 0.03, z, yaw, -0.7, 0, 0.1, 0.16, 0.02), w.dark);
    return officeSolid(f, 'box', officePose(officeM, x - back[0], y + 0.035, z - back[1], yaw, -0.7, 0, 0.085, 0.13, 0.012), look.work, 0.7);
  }
  officeSolid(f, 'box', officePose(officeM, x, y, z, yaw, -0.4, 0, 0.2, 0.05, 0.09), w.dark);
  for (const [dx, rgb] of [[-0.055, w.red], [0.055, w.green]]) officeSolid(f, 'ball', officePose(officeM, x + Math.cos(yaw) * dx, y + 0.03, z - Math.sin(yaw) * dx, 0, 0, 0, 0.035, 0.035, 0.035), rgb, 0.6);
}

const officeWave = (t, speed, power = 1) => Math.max(0, Math.sin(t * speed)) ** power;

const OFFICE_POSES = {
  walk: (t) => {
    const s = Math.sin(t * 8.5);
    return { lift: Math.abs(s) * 0.035, legs: [s * 0.6, -s * 0.6], arms: [[-s * 0.55, 0.12], [s * 0.55, -0.12]] };
  },
  stand: (t) => ({ lift: Math.sin(t * 2) * 0.004, arms: [[0.05, 0.1], [0.05, -0.1]], head: [Math.sin(t * 0.6) * 0.35, 0] }),
  type: (t) => ({ sit: true, lift: 0.1, lean: 0.12, legs: [-1.45, -1.45], arms: [[-1.2 + Math.sin(t * 15) * 0.12, -0.3], [-1.2 + Math.sin(t * 15 + 2) * 0.12, 0.3]], head: [0, 0.12 + Math.sin(t * 1.3) * 0.03] }),
  relax: (t) => {
    const up = Math.max(0, Math.sin(t * 0.9)) ** 8;
    return { sit: true, lift: 0.1, lean: -0.16, legs: [-1.4, -1.4], arms: [[-0.9 - up * 1.0, -0.2], [-0.5, 0.3]], head: [Math.sin(t * 0.5) * 0.3, -up * 0.2], hold: 'cup' };
  },
  wave: (t) => ({ lift: Math.abs(Math.sin(t * 4.2)) * 0.07, arms: [[0.05, 0.12], [-0.35, -2.45 + Math.sin(t * 11) * 0.55]], head: [Math.sin(t * 1.7) * 0.15, -0.12] }),
  sip: (t) => {
    const up = Math.max(0, Math.sin(t * 1.2)) ** 6;
    return { arms: [[-0.95 - up * 1.1, -0.25], [0.05, -0.1]], head: [0, -up * 0.2], hold: 'cup' };
  },
  lounge: (t) => ({ sit: true, lift: 0.08, lean: -0.22, legs: [-1.35, -1.35], arms: [[-0.6, 0.35], [-0.5, -0.35]], head: [Math.sin(t * 0.4) * 0.5, -0.1] }),
  chat: (t) => ({ arms: [[-0.4 - Math.max(0, Math.sin(t * 2.4)) * 0.7, 0.3], [0.05, -0.12]], head: [Math.sin(t * 2.1) * 0.12, Math.sin(t * 3.1) * 0.08] }),
  draw: (t) => ({ arms: [[-1.7 + Math.sin(t * 5) * 0.2, 0.3 + Math.cos(t * 5) * 0.2], [0.05, -0.1]], head: [0, 0.05] }),
  tap: (t) => {
    const glance = officeWave(t, 0.8, 3);
    return { legs: [0, -officeWave(t, 9) * 0.3], arms: [[-1.2 - glance * 0.35, -0.55 - glance * 0.25], [0.1, -0.45]], head: [0.25 * glance, 0.05 + glance * 0.45], watch: true, turn: -0.15 };
  },
  cross: (t) => ({ lean: -0.05, arms: [[-1.0, -0.9], [-1.0, 0.9]], head: [0.4 + Math.sin(t * 0.5) * 0.1, -0.12], legs: [0.05, -0.05] }),
  stomp: (t) => {
    const s = Math.sin(t * 7);
    const shake = Math.sin(t * 15) * 0.12;
    return { lift: Math.abs(s) * 0.035, lean: 0.1, legs: [-Math.max(0, s) * 0.75, -Math.max(0, -s) * 0.75], arms: [[-0.3 + shake, 0.5], [-0.3 - shake, -0.5]], head: [Math.sin(t * 3) * 0.18, 0.02] };
  },
  cheer: (t, actor) => {
    const walking = actor.path.length > 0 && !(actor.hold > 0);
    const s = Math.sin(t * 8.5);
    return { lift: walking ? Math.abs(s) * 0.06 : officeWave(t, 9) * 0.16, legs: walking ? [s * 0.6, -s * 0.6] : [0, 0], arms: [[-2.75 + Math.sin(t * 12) * 0.12, 0.5], [-2.75 - Math.sin(t * 12) * 0.12, -0.5]], head: [0, -0.25] };
  },
  arcade: (t) => ({ lean: 0.1, arms: [[-1.15 + Math.sin(t * 13) * 0.07, -0.18], [-1.1 + officeWave(t, 7) * 0.14, 0.18]], head: [0, 0.1], lift: Math.abs(Math.sin(t * 3)) * 0.01 }),
  vr: (t) => ({
    headset: true, turn: Math.sin(t * 0.35) * 0.9, lift: Math.abs(Math.sin(t * 2.2)) * 0.02, legs: [Math.sin(t * 2.2) * 0.15, -Math.sin(t * 2.2) * 0.15],
    arms: [[-1.6 + Math.sin(t * 1.9) * 0.9, 0.2 + Math.sin(t * 1.3) * 0.5], [-1.3 + Math.sin(t * 1.5 + 2) * 1.0, -0.2 - Math.sin(t * 1.1) * 0.5]], head: [Math.sin(t * 0.8) * 0.5, -0.15 + Math.sin(t * 0.6) * 0.15],
  }),
  gamepad: (t) => ({ sit: true, lift: 0.08, lean: 0.12, tilt: Math.sin(t * 1.7) * 0.12, legs: [-1.4, -1.4], arms: [[-1.0 + Math.sin(t * 11) * 0.05, -0.5], [-1.0 + Math.sin(t * 9 + 1) * 0.05, 0.5]], head: [0, 0.06], hold: 'pad' }),
  foos: (t) => ({ lean: 0.22, dx: Math.sin(t * 1.3) * 0.08, arms: [[-0.8, 0.2 + Math.sin(t * 6) * 0.12], [-0.8, -0.2 - Math.sin(t * 6 + 1) * 0.12]], head: [Math.sin(t * 2) * 0.2, 0.2] }),
  beanbag: (t) => ({ sit: true, lift: 0.02, lean: -0.45, legs: [-1.1, -1.25], arms: [[-1.25, -0.35], [-1.25, 0.35]], head: [0, 0.35 + Math.sin(t * 0.4) * 0.05], hold: 'phone' }),
  fish: (t) => ({ lean: 0.12, arms: [[0.35, 0.15], [0.35, -0.15]], head: [Math.sin(t * 0.9) * 0.4, 0.08] }),
  eat: (t) => {
    const up = officeWave(t, 1.6, 4);
    return { sit: true, lift: 0.1, lean: 0.08, legs: [-1.45, -1.45], arms: [[-1.2 - up * 0.95, -0.3 - up * 0.2], [-1.15, 0.3]], head: [0, 0.12 - up * 0.12], hold: 'fork' };
  },
  recline: (t) => ({ sit: true, lift: 0.04, lean: -0.75, legs: [-1.25, -1.2], arms: [[-2.7, -0.75], [-2.7, 0.75]], head: [Math.sin(t * 0.3) * 0.25, -0.2] }),
  gaze: (t) => ({ lean: 0.12, arms: [[-1.05, 0.12], [-1.05, -0.12]], head: [Math.sin(t * 0.4) * 0.45, -0.05] }),
  laptop: (t) => ({ lean: 0.1, arms: [[-1.2 + Math.sin(t * 15) * 0.08, -0.32], [-1.2 + Math.sin(t * 15 + 2) * 0.08, 0.32]], head: [0, 0.22], hold: 'laptop' }),
  laplounge: (t) => ({ sit: true, lift: 0.08, lean: -0.05, legs: [-1.35, -1.35], arms: [[-0.95 + Math.sin(t * 15) * 0.08, -0.35], [-0.95 + Math.sin(t * 15 + 2) * 0.08, 0.35]], head: [0, 0.32], hold: 'laptop' }),
  'laptop-sit': (t) => ({ sit: true, lift: 0.1, lean: 0.1, legs: [-1.45, -1.45], arms: [[-1.15 + Math.sin(t * 15) * 0.08, -0.32], [-1.15 + Math.sin(t * 15 + 2) * 0.08, 0.32]], head: [0, 0.2], hold: 'laptop' }),
  play: (t, actor) => {
    const swing = actor.swing ?? 0;
    return { lift: Math.abs(Math.sin(t * 6)) * 0.02, lean: 0.1, legs: [0.15, -0.15], arms: [[-0.3, 0.15], [-0.7 - swing * 0.9, -0.55 + swing * 0.5]], hold: 'paddle', dx: actor.lane ?? 0 };
  },
};

const OFFICE_MOOD_POSES = { impatient: 'tap', grumpy: 'cross', angry: 'stomp' };

// With reduced motion the mood is in the face and its colour only, so the body keeps the pose its place gives it.
function officePoseOf(actor, still) {
  const mood = actor.mood?.mood;
  if (still) return actor.pose;
  if (actor.pose === 'wave' && OFFICE_MOOD_POSES[mood]) return OFFICE_MOOD_POSES[mood];
  return mood === 'cheer' && ['walk', 'wave', 'stand'].includes(actor.pose) ? 'cheer' : actor.pose;
}

function officeBodyPose(actor, time) {
  const t = time.still ? 0.6 : actor.t + (officeHash(actor.handle) % 100) / 10;
  const spec = (OFFICE_POSES[officePoseOf(actor, time.still)] ?? OFFICE_POSES.stand)(t, actor);
  const blink = !time.still && (t % 4.1) < 0.12;
  const rest = { lift: 0, lean: 0, turn: 0, tilt: 0, legs: [0, 0], arms: [[0, 0.1], [0, -0.1]], head: [0, 0], hold: null, dx: 0, dz: 0, sit: false };
  const pose = { ...rest, ...spec, blink };
  const mood = actor.mood?.mood;
  if (mood === 'happy' && actor.pose === 'type' && !time.still) pose.lift += officeWave(t * 0.5 + 1.3, 0.9, 30) * 0.09;
  if (mood === 'sad' && !pose.sit) pose.head = [pose.head[0], pose.head[1] + 0.3];
  return pose;
}

function officeBallDraw(f, look, scene) {
  const ball = officeBall(scene);
  if (!ball) return;
  officeSolid(f, 'ball', officePose(officeM, ball.x, ball.y, ball.z, 0, 0, 0, 0.07, 0.07, 0.07), look.ball, 0.2);
  const s = Math.max(0.3, 1 - (ball.y - scene.layout.table.h) * 1.2);
  const onTable = Math.abs(ball.z - scene.layout.table.z) < scene.layout.table.l / 2 && Math.abs(ball.x - scene.layout.table.x) < scene.layout.table.w / 2;
  officeDecal(f.floor, [ball.x, onTable ? scene.layout.table.h + 0.003 : 0.004, ball.z], [0.06 * s, 0, 0], [0, 0, 0.06 * s], [0, 0, 0, 0.35 * s], [0, 0.6, 0.5, 1]);
}

function officePulse(f, look, scene, actor) {
  if (!actor.pulse || !actor.spot?.startsWith('pod:')) return;
  const pod = scene.layout.pods[Number(actor.spot.split(':')[1])];
  const r = 0.2 + (1 - actor.pulse) * 0.45;
  officeDecal(f.glow, [pod.x, OFFICE_DESK.h + 0.3, pod.z - 0.05], [r, 0, 0], [0, r, 0], [...look.t.info, actor.pulse * 0.9], [1, 0.12, 0.8, 1]);
}

function officeBuild(f, look, scene, time, marks) {
  officeClearFrame(f);
  const L = scene.layout;
  officeRoom(f, look, L, time, scene.door);
  officeRooms(f, look, scene, time);
  officePods(f, look, scene, time);
  officeBoss(f, look, L, scene.boss, time);
  officeLounge(f, look, L);
  officeFacilities(f, look, scene, time, 'lounge');
  if (scene.addons?.length) officeWearAddons(f, look, scene, time);
  officeRallyPose(scene);
  for (const actor of [...scene.actors.values(), scene.boss].filter(Boolean)) {
    const outfit = officeOutfitOf(scene, actor);
    officeCharacter(f, look, actor, time, marks.has(actor.handle), outfit);
    if (outfit?.pet) officeWearPet(f, look, outfit.pet, scene.pets?.get(actor.handle), time);
    officePulse(f, look, scene, actor);
    officeMoodFx(f, look, actor, time);
  }
  officeBallDraw(f, look, scene);
  if (scene.burst != null) officeWearBurst(f, look, scene, time);
}

function officeHeadAt(actor) {
  const sitting = OFFICE_SEATED.has(actor.pose) ? 0.1 : 0;
  return [actor.x + (actor.lane ?? 0), OFFICE_HEAD_Y * (actor.manager ? 1.3 : 1.12) + sitting, actor.z];
}

function officeRallyPose(scene) {
  const rally = scene.rally;
  const players = officePlayers(scene);
  if (!players) return;
  const u = rally.rest > 0 ? 0 : Math.min(1, rally.t / OFFICE_SHOT_MS);
  const ease = (a, b, v) => Math.min(1, Math.max(0, (v - a) / (b - a)));
  const receiver = players[1 - rally.from];
  const hitter = players[rally.from];
  receiver.lane = rally.lane[1] * ease(0.1, 0.75, u);
  receiver.swing = rally.miss ? 0 : ease(0.7, 1, u);
  hitter.lane = rally.lane[0] * (1 - ease(0.2, 0.9, u));
  hitter.swing = 1 - ease(0, 0.3, u);
}
