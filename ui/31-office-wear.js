const OFFICE_PET_GAP = 0.5;
const OFFICE_PET_SPEED = 1.9;
const OFFICE_BURST_S = 1.8;
const OFFICE_TROPHIES_SHOWN = 12;
const OFFICE_SEATED = new Set(['type', 'lounge', 'relax', 'gamepad', 'beanbag', 'eat', 'recline', 'laplounge', 'laptop-sit']);
const officeWearM = officeM4();
const officeWearJ = officeM4();
const officeWearF = officeM4();

function officeWearLook(look) {
  const t = look.t;
  const m = (a, b, k) => officeLin(officeMix(a, b, k));
  return {
    gold: m(t.viz4, [1, 0.9, 0.55], 0.35), silver: m(t.muted, [1, 1, 1], 0.45), dark: m(t.consoleBg, t.lineStrong, 0.3),
    white: m(t.fg, [1, 1, 1], 0.6), pink: officeLin(t.viz5), green: officeLin(t.viz3), blue: officeLin(t.viz1), orange: officeLin(t.viz2), cyan: officeLin(t.info),
    red: officeLin(t.need), purple: officeLin(t.moved), indigo: m(t.accentStrong, t.consoleBg, 0.45), bone: m(t.fg, t.viz4, 0.15),
    mint: m(t.viz3, [1, 1, 1], 0.45), sunset: m(t.viz2, t.viz4, 0.35), sunsetHead: m(t.viz5, [1, 1, 1], 0.35),
    cat: m(t.viz2, t.muted, 0.55), dog: m(t.viz2, t.consoleBg, 0.45), fridge: m(t.panel, [1, 1, 1], look.light ? 0.2 : 0.75),
  };
}

const officeWearOf = (look) => (look.wear ??= officeWearLook(look));

function officeWearerOf(actor) {
  if (actor.manager) return 'manager';
  return actor.agent?.player ? 'player' : 'kind:' + (actor.agent?.kind ?? '');
}

function officeOutfitOf(scene, actor) {
  const slots = scene.wear?.[officeWearerOf(actor)];
  return slots && (slots.skin || slots.hat || slots.held || slots.pet) ? slots : null;
}

// A positive glow lights a part from inside and a negative one makes it metal, as the solid shader reads it.
function officeWearColours(look, outfit, base) {
  const w = officeWearOf(look);
  const plain = { ...base, glow: 0, pattern: null, aura: null };
  if (!outfit?.skin) return plain;
  const skins = {
    'skin-mint': { body: w.mint, head: officeMix(w.mint, [1, 1, 1], 0.3) },
    'skin-sunset': { body: w.sunset, head: w.sunsetHead },
    'skin-stripes': { pattern: 'stripes', stripe: w.white },
    'skin-polka': { pattern: 'dots', stripe: w.white },
    'skin-chrome': { body: w.silver, head: officeMix(w.silver, [1, 1, 1], 0.2), glow: -0.9 },
    'skin-glow': { glow: 0.55, aura: [...look.t.info, look.light ? 0.3 : 0.4] },
  };
  return { ...plain, ...skins[outfit.skin] };
}

function officeWearPattern(f, colours) {
  if (colours.pattern === 'stripes') {
    for (const y of [0.42, 0.52, 0.62]) officeLocal(f, 'cyl', colours.stripe, 0, y, 0, 0.372, 0.035, 0.352);
    return;
  }
  for (const [a, y] of [[0, 0.45], [1.1, 0.58], [2.2, 0.47], [3.3, 0.6], [4.4, 0.44], [5.4, 0.6], [0.6, 0.68], [3.9, 0.36]]) {
    officeLocal(f, 'ball', colours.stripe, Math.sin(a) * 0.178, y, Math.cos(a) * 0.168, 0.06, 0.06, 0.04);
  }
}

function officeOnHead(f, mesh, rgb, x, y, z, sx, sy, sz, glow = 0, yaw = 0, pitch = 0, roll = 0) {
  officePose(officeWearJ, x, y, z, yaw, pitch, roll, sx, sy, sz);
  officeSolid(f, mesh, officeMul(officeWearM, officePart, officeWearJ), rgb, glow);
}

const OFFICE_HATS = {
  'hat-party': (f, w) => {
    officeOnHead(f, 'cone', w.pink, 0, 0.33, 0, 0.22, 0.34, 0.22);
    officeOnHead(f, 'cyl', w.white, 0, 0.27, 0, 0.152, 0.025, 0.152);
    officeOnHead(f, 'cyl', w.white, 0, 0.38, 0, 0.088, 0.022, 0.088);
    officeOnHead(f, 'ball', w.gold, 0, 0.51, 0, 0.075, 0.075, 0.075, 0.25);
  },
  'hat-headphones': (f, w) => {
    for (let i = 0; i <= 6; i++) {
      const a = -1.4 + (i / 6) * 2.8;
      officeOnHead(f, 'box', w.dark, Math.sin(a) * 0.235, 0.02 + Math.cos(a) * 0.235, 0, 0.075, 0.035, 0.06, 0, 0, 0, -a);
    }
    for (const side of [-1, 1]) {
      officeOnHead(f, 'cyl', w.blue, side * 0.215, 0, 0, 0.16, 0.07, 0.16, 0, 0, 0, Math.PI / 2);
      officeOnHead(f, 'cyl', w.dark, side * 0.252, 0, 0, 0.11, 0.02, 0.11, 0, 0, 0, Math.PI / 2);
    }
  },
  'hat-wizard': (f, w, t) => {
    officeOnHead(f, 'cyl', w.indigo, 0, 0.17, 0, 0.5, 0.025, 0.5);
    officeOnHead(f, 'cone', w.indigo, 0, 0.42, -0.02, 0.3, 0.52, 0.3, 0, 0, -0.18);
    officeOnHead(f, 'cyl', w.gold, 0, 0.205, 0, 0.31, 0.05, 0.31);
    officeOnHead(f, 'gem', w.gold, 0.07, 0.38, 0.1, 0.08, 0.08, 0.08, 0.75 + 0.25 * Math.sin(t * 3));
  },
  'hat-viking': (f, w) => {
    officeOnHead(f, 'ball', w.silver, 0, 0.11, 0, 0.46, 0.3, 0.46, -0.7);
    officeOnHead(f, 'cyl', w.dog, 0, 0.07, 0, 0.47, 0.04, 0.47, -0.4);
    officeOnHead(f, 'box', w.silver, 0, 0.03, 0.225, 0.03, 0.12, 0.02, -0.7);
    for (const side of [-1, 1]) officeOnHead(f, 'cone', w.bone, side * 0.23, 0.21, 0, 0.075, 0.22, 0.075, 0, 0, 0, -side * 0.75);
  },
  'hat-crown': (f, w, t) => {
    officeOnHead(f, 'cyl', w.gold, 0, 0.19, 0, 0.32, 0.08, 0.32, -0.85);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      officeOnHead(f, 'cone', w.gold, Math.sin(a) * 0.14, 0.27, Math.cos(a) * 0.14, 0.06, 0.1, 0.06, -0.85);
      officeOnHead(f, 'gem', i % 2 ? w.blue : w.red, Math.sin(a + 0.63) * 0.162, 0.19, Math.cos(a + 0.63) * 0.162, 0.045, 0.045, 0.045, 0.35 + 0.2 * Math.sin(t * 2 + i));
    }
  },
};

function officeWearHat(f, look, hat, time) {
  OFFICE_HATS[hat]?.(f, officeWearOf(look), time.t);
}

function officeInHand(f, mesh, rgb, x, y, z, sx, sy, sz, glow = 0, pitch = 0, roll = 0) {
  officePose(officeWearJ, x, y, z, 0, pitch, roll, sx, sy, sz);
  officeSolid(f, mesh, officeMul(officeWearM, officeWearF, officeWearJ), rgb, glow);
}

const OFFICE_HELD = {
  'held-mug': (f, w) => {
    officeInHand(f, 'cyl', w.blue, 0, 0.04, 0, 0.1, 0.11, 0.1);
    officeInHand(f, 'cyl', w.dark, 0, 0.096, 0, 0.085, 0.004, 0.085);
    officeInHand(f, 'box', w.blue, 0.06, 0.04, 0, 0.025, 0.06, 0.035);
  },
  'held-chicken': (f, w, t) => {
    const swing = Math.sin(t * 4) * 0.25;
    officeInHand(f, 'box', w.orange, 0, 0, 0, 0.05, 0.03, 0.03);
    officeInHand(f, 'ball', w.gold, 0, -0.13, 0, 0.12, 0.17, 0.1, 0, 0, swing);
    officeInHand(f, 'ball', w.gold, 0, -0.26, 0.01, 0.085, 0.085, 0.085, 0, 0, swing);
    officeInHand(f, 'box', w.red, 0, -0.21, 0.01, 0.015, 0.04, 0.04, 0, 0, swing);
    officeInHand(f, 'cone', w.orange, 0, -0.32, 0.02, 0.04, 0.07, 0.04, 0, Math.PI, swing);
  },
  'held-wrench': (f, w) => {
    officeInHand(f, 'box', w.silver, 0, 0.1, 0, 0.035, 0.26, 0.02, -0.8, 0.35);
    officeInHand(f, 'box', w.silver, 0, 0.25, 0.04, 0.035, 0.05, 0.1, -0.8, 0.35);
    for (const dz of [-0.03, 0.12]) officeInHand(f, 'box', w.silver, 0, 0.29, dz, 0.035, 0.06, 0.03, -0.8, 0.35);
  },
  'held-sword': (f, w) => {
    officeInHand(f, 'box', w.dark, 0, 0.02, 0, 0.035, 0.11, 0.035, 0, 0.4);
    officeInHand(f, 'box', w.pink, 0, 0.09, 0.03, 0.04, 0.03, 0.16, 0, 0.4);
    officeInHand(f, 'box', w.green, 0, 0.32, 0.12, 0.05, 0.44, 0.03, 0.15, 0.4);
  },
  'held-saber': (f, w, t, look) => {
    officeInHand(f, 'cyl', w.silver, 0, 0.04, 0, 0.045, 0.17, 0.045, -0.85, 0.35);
    officeInHand(f, 'cyl', w.cyan, 0, 0.47, 0.17, 0.035, 0.66, 0.035, 0.95 + 0.05 * Math.sin(t * 40), 0.35);
    const up = [officeWearF[4], officeWearF[5], officeWearF[6]];
    const across = [officeWearF[0], officeWearF[1], officeWearF[2]];
    const at = [officeWearF[12], officeWearF[13], officeWearF[14]].map((v, i) => v + up[i] * 0.47);
    officeDecal(f.glow, at, across.map((v) => v * 0.09), up.map((v) => v * 0.4), [...look.t.info, 0.4], [2, 0, 0, 1]);
  },
};

function officeWearHeld(f, look, held, [x, y, z], yaw, time) {
  if (!OFFICE_HELD[held]) return;
  officePose(officeWearF, x, y, z, yaw);
  OFFICE_HELD[held](f, officeWearOf(look), time.t, look);
}

function officePetsStep(scene, dt, still) {
  scene.pets ??= new Map();
  const live = new Set();
  for (const actor of [...scene.actors.values(), scene.boss].filter(Boolean)) {
    const pet = officeOutfitOf(scene, actor)?.pet;
    if (!pet) continue;
    live.add(actor.handle);
    officePetFollow(scene.pets, actor, pet, dt, still);
  }
  for (const handle of [...scene.pets.keys()]) if (!live.has(handle)) scene.pets.delete(handle);
}

function officePetFollow(pets, actor, kind, dt, still) {
  const side = actor.facing + (OFFICE_SEATED.has(actor.pose) ? 0.9 : 2.4);
  const goal = { x: actor.x + (actor.lane ?? 0) + Math.sin(side) * OFFICE_PET_GAP, z: actor.z + Math.cos(side) * OFFICE_PET_GAP };
  let pet = pets.get(actor.handle);
  if (!pet || pet.kind !== kind || still) {
    pet = { kind, x: goal.x, z: goal.z, facing: actor.facing, moving: false, t: pet?.t ?? 0 };
    pets.set(actor.handle, pet);
    return;
  }
  pet.t += dt;
  const dx = goal.x - pet.x;
  const dz = goal.z - pet.z;
  const far = Math.hypot(dx, dz);
  pet.moving = far > 0.06;
  if (!pet.moving) return void (pet.facing = officeTurn(pet.facing, actor.facing, dt * 2));
  const step = Math.min(far, OFFICE_PET_SPEED * dt * Math.min(1, far * 2.5));
  pet.x += (dx / far) * step;
  pet.z += (dz / far) * step;
  pet.facing = officeTurn(pet.facing, Math.atan2(dx, dz), dt * 8);
}

function officeLocalPart(f, mesh, rgb, x, y, z, sx, sy, sz, glow = 0, yaw = 0, pitch = 0, roll = 0) {
  officePose(officeWearJ, x, y, z, yaw, pitch, roll, sx, sy, sz);
  officeSolid(f, mesh, officeMul(officeWearM, officeWearF, officeWearJ), rgb, glow);
}

function officePetLegs(f, rgb, w, h, along, step) {
  [[-1, 1], [1, 1], [-1, -1], [1, -1]].forEach(([sx, sz], i) => officeLocalPart(f, 'box', rgb, sx * w, h / 2, sz * along, 0.035, h, 0.035, 0, 0, Math.sin(step + i * Math.PI / 2) * 0.5));
}

const OFFICE_PETS = {
  'pet-cat': (f, w, pet, look) => {
    const step = pet.moving ? pet.t * 14 : 0;
    officePetLegs(f, w.cat, 0.04, 0.08, 0.06, step);
    officeLocalPart(f, 'pill', w.cat, 0, 0.12, 0, 0.13, 0.13, 0.13, 0, 0, Math.PI / 2);
    officeLocalPart(f, 'ball', w.cat, 0, 0.2, 0.13, 0.12, 0.11, 0.11);
    for (const side of [-1, 1]) {
      officeLocalPart(f, 'cone', w.cat, side * 0.035, 0.27, 0.13, 0.04, 0.06, 0.03);
      officeLocalPart(f, 'ball', look.eye, side * 0.025, 0.215, 0.185, 0.02, 0.022, 0.01);
    }
    officeLocalPart(f, 'box', w.cat, 0, 0.21, -0.14, 0.025, 0.18, 0.025, 0, Math.sin(pet.t * 2) * 0.3, -0.5);
  },
  'pet-dog': (f, w, pet, look) => {
    const step = pet.moving ? pet.t * 12 : 0;
    officePetLegs(f, w.dog, 0.055, 0.12, 0.08, step);
    officeLocalPart(f, 'pill', w.dog, 0, 0.17, 0, 0.17, 0.17, 0.16, 0, 0, Math.PI / 2);
    officeLocalPart(f, 'ball', w.dog, 0, 0.28, 0.17, 0.15, 0.14, 0.14);
    officeLocalPart(f, 'box', w.dog, 0, 0.255, 0.255, 0.07, 0.06, 0.09);
    officeLocalPart(f, 'ball', look.eye, 0, 0.275, 0.3, 0.03, 0.025, 0.02);
    for (const side of [-1, 1]) {
      officeLocalPart(f, 'box', w.dark, side * 0.075, 0.26, 0.16, 0.03, 0.1, 0.06, 0, 0, 0, side * 0.3);
      officeLocalPart(f, 'ball', look.eye, side * 0.035, 0.3, 0.235, 0.022, 0.024, 0.01);
    }
    officeLocalPart(f, 'box', w.dog, 0, 0.25, -0.17, 0.025, 0.14, 0.025, 0, Math.sin(pet.t * 14) * 0.5, -0.9);
  },
  'pet-drone': (f, w, pet, look, time) => {
    const y = 1.2 + Math.sin(pet.t * 2.2) * 0.05;
    officeLocalPart(f, 'ball', w.silver, 0, y, 0, 0.2, 0.11, 0.2, -0.8);
    officeLocalPart(f, 'ball', w.cyan, 0, y, 0.09, 0.05, 0.05, 0.03, 0.9);
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      officeLocalPart(f, 'box', w.dark, Math.sin(a) * 0.11, y + 0.02, Math.cos(a) * 0.11, 0.025, 0.015, 0.16, 0, a);
      officeLocalPart(f, 'box', w.silver, Math.sin(a) * 0.19, y + 0.045, Math.cos(a) * 0.19, 0.13, 0.004, 0.018, 0, time.t * 30 + i);
    }
    officeDecal(f.floor, [officeWearF[12], 0.006, officeWearF[14]], [0.14, 0, 0], [0, 0, 0.14], [...look.shadow.slice(0, 3), look.shadow[3] * 0.5], [0, 0.5, 0.5, 1]);
  },
};

function officeWearPet(f, look, kind, pet, time) {
  if (!pet || !OFFICE_PETS[kind]) return;
  officePose(officeWearF, pet.x, 0, pet.z, pet.facing);
  if (kind !== 'pet-drone') officeShadow(f, look, pet.x, pet.z, 0.3, 0.3, 0.25, 0.7);
  OFFICE_PETS[kind](f, officeWearOf(look), pet, look, time);
}

function officeAddonPart(f, mesh, rgb, x, y, z, sx, sy, sz, glow = 0, yaw = 0, pitch = 0, roll = 0) {
  officeSolid(f, mesh, officePose(officeWearM, x, y, z, yaw, pitch, roll, sx, sy, sz), rgb, glow);
}

const OFFICE_ADDONS = {
  'office-neon': (f, w, scene, time, look) => {
    const [y, z] = [1.45, 4.6];
    const flicker = time.still ? 1 : 0.85 + 0.15 * Math.sin(time.t * 9) * Math.sin(time.t * 2.3);
    officeAddonPart(f, 'box', w.dark, 0.02, y, z, 0.03, 0.46, 1.05);
    const arms = [[-0.376, 0.051, -0.6], [-0.376, -0.051, 0.6], [0.376, 0.051, 0.6], [0.376, -0.051, -0.6]];
    for (const [dz, dy, tilt] of arms) officeAddonPart(f, 'box', w.pink, 0.045, y + dy, z + dz, 0.02, 0.035, 0.18, flicker, 0, tilt);
    officeAddonPart(f, 'box', w.pink, 0.045, y, z, 0.02, 0.035, 0.32, flicker, 0, 1.1);
    officeDecal(f.glow, [0.06, y, z], [0, 0, 0.75], [0, 0.4, 0], [...look.t.viz5, 0.35 * flicker], [2, 0, 0, 1]);
  },
  'office-fridge': (f, w, scene, time, look) => {
    const s = OFFICE_ADDON_SPOTS['office-fridge'];
    officeShadow(f, look, s.x, s.z, s.d + 0.15, s.w + 0.15, 0.25);
    officeAddonPart(f, 'box', w.fridge, s.x, 0.41, s.z, s.d, 0.82, s.w);
    officeAddonPart(f, 'box', w.dark, s.x + s.d / 2, 0.58, s.z, 0.005, 0.012, s.w - 0.02);
    officeAddonPart(f, 'box', w.silver, s.x + s.d / 2 + 0.015, 0.42, s.z + s.w / 2 - 0.06, 0.02, 0.2, 0.025, -0.8);
    officeAddonPart(f, 'ball', w.green, s.x + s.d / 2 + 0.005, 0.7, s.z - 0.1, 0.03, 0.03, 0.03, 0.8);
    for (const dz of [-0.08, 0.06]) officeAddonPart(f, 'cyl', dz < 0 ? w.red : w.blue, s.x, 0.88, s.z + dz, 0.07, 0.12, 0.07, -0.5);
  },
  'office-trophy': (f, w, scene, time) => {
    for (const y of [1.08, 1.52]) {
      officeAddonPart(f, 'box', w.dog, 0.95, y, 0.11, 1.2, 0.03, 0.2);
      for (const x of [0.42, 1.48]) officeAddonPart(f, 'box', w.dark, x, y - 0.06, 0.04, 0.03, 0.1, 0.06);
    }
    (scene.trophies ?? []).slice(0, OFFICE_TROPHIES_SHOWN).forEach((trophy, i) => {
      const x = 0.47 + (i % 6) * 0.19;
      const y = i < 6 ? 1.095 : 1.535;
      const colour = trophy.secret ? w.purple : w.gold;
      const glow = trophy.secret ? 0.35 + 0.15 * Math.sin(time.t * 2 + i) : -0.85;
      officeAddonPart(f, 'box', w.dark, x, y + 0.015, 0.11, 0.07, 0.03, 0.07);
      officeAddonPart(f, 'cyl', colour, x, y + 0.055, 0.11, 0.02, 0.05, 0.02, glow);
      officeAddonPart(f, 'cyl', colour, x, y + 0.11, 0.11, 0.085, 0.07, 0.085, glow);
      for (const side of [-1, 1]) officeAddonPart(f, 'ball', colour, x + side * 0.05, y + 0.115, 0.11, 0.025, 0.035, 0.015, glow);
    });
  },
  'office-disco': (f, w, scene, time, look) => {
    const [x, y, z] = [12.2, 2.05, 2.75];
    const spin = time.still ? 0 : time.t * 0.7;
    officeAddonPart(f, 'cyl', w.dark, x, y + 0.5, z, 0.012, 0.7, 0.012);
    officeAddonPart(f, 'gem', w.silver, x, y, z, 0.38, 0.38, 0.38, -1, spin);
    for (let i = 0; i < 6; i++) {
      const a = spin * 1.3 + i * 1.05;
      officeAddonPart(f, 'box', w.white, x + Math.sin(a) * 0.19, y + ((i % 3) - 1) * 0.1, z + Math.cos(a) * 0.19, 0.03, 0.03, 0.03, 1, a);
    }
    const tones = [look.t.viz1, look.t.viz5, look.t.viz3, look.t.viz4, look.t.moved];
    for (let i = 0; i < 10; i++) {
      const a = spin * (i % 2 ? 0.5 : -0.4) + i * 0.63;
      const r = 1.1 + (i % 3) * 0.55;
      officeDecal(f.glow, [x + Math.sin(a) * r, 0.012, z + Math.cos(a) * r], [0.34, 0, 0], [0, 0, 0.34], [...tones[i % 5], look.light ? 0.5 : 0.6], [2, 0, 0, 1]);
    }
  },
};

function officeWearAddons(f, look, scene, time) {
  const w = officeWearOf(look);
  for (const id of scene.addons ?? []) OFFICE_ADDONS[id]?.(f, w, scene, time, look);
}

function officeWearBurst(f, look, scene, time) {
  const actor = scene.actors.get(OFFICE_PLAYER);
  const age = time.t - scene.burst;
  if (!actor || age < 0 || age > OFFICE_BURST_S || time.still) return;
  const w = officeWearOf(look);
  const fade = 1 - age / OFFICE_BURST_S;
  for (let k = 0; k < 3; k++) {
    const r = 0.3 + (age * 1.6 + k * 0.35) % 1.8;
    officeDecal(f.glow, [actor.x, 0.02, actor.z], [r, 0, 0], [0, 0, r], [...look.t.viz4, 0.7 * fade], [1, 0.1, 0.85, 1]);
  }
  for (let i = 0; i < 14; i++) {
    const a = i * 2.39;
    const lift = age * (1.2 + (i % 4) * 0.35);
    const out = 0.25 + age * 0.55;
    officeSolid(f, 'gem', officePose(officeM, actor.x + Math.sin(a) * out, 0.5 + lift, actor.z + Math.cos(a) * out, a * 3, age * 4, 0, 0.07 * fade, 0.07 * fade, 0.07 * fade), i % 2 ? w.gold : w.white, 1);
  }
}

function officePreview(canvas) {
  const gl = officeGl(canvas);
  return gl && { gl, frame: officeFrame(), look: null, spec: null, loop: null, angle: 0.4, last: 0 };
}

function officePreviewDraw(p, now) {
  const { w, h } = { w: p.gl.canvas.clientWidth || 280, h: p.gl.canvas.clientHeight || 280 };
  officeResize(p.gl, w, h);
  p.look ??= officeLook();
  const still = officeReduced();
  const dt = p.last ? Math.min(0.05, (now - p.last) / 1000) : 0;
  p.last = now;
  if (!still) p.angle += dt * 0.6;
  const time = { t: now / 1000, wall: Date.now(), still };
  officeClearFrame(p.frame);
  if (p.spec?.room) return officeRender(p.gl, p.frame, officePlanPreview(p, w / h, time), p.look);
  officePreviewScene(p, time);
  const cam = officeCamera({ yaw: Math.PI / 4, pitch: 0.42, zoom: p.spec?.addon ? officePreviewZoom(p.spec.addon) : 1.05, target: [0, p.spec?.addon ? 0.85 : 0.62, 0] }, w / h);
  officeRender(p.gl, p.frame, cam, p.look);
}

function officePreviewScene(p, time) {
  const { look, frame: f } = p;
  const spec = p.spec ?? {};
  officeCyl(f, look.slab, 0, -0.04, 0, 0.75, 0.08);
  officeCyl(f, look.floor, 0, 0.0, 0, 0.7, 0.01);
  if (spec.addon) return officePreviewAddon(f, look, spec.addon, time);
  const kind = spec.wearer === 'manager' ? null : spec.wearer?.startsWith('kind:') ? spec.wearer.slice(5) : 'player';
  const actor = { handle: 'office:preview', x: 0, z: 0, facing: p.angle, pose: 'stand', t: time.t, manager: spec.wearer === 'manager', agent: { kind, player: kind === 'player' } };
  const outfit = spec.outfit ?? {};
  officeCharacter(f, look, actor, time, false, outfit);
  if (outfit.pet) {
    const a = p.angle + 1.1;
    officeWearPet(f, look, outfit.pet, { kind: outfit.pet, x: Math.sin(a) * 0.45, z: Math.cos(a) * 0.45, facing: p.angle, moving: false, t: time.t }, time);
  }
}

// An add-on is drawn where it stands in the office, then moved to the middle of the turntable.
function officePreviewAddon(f, look, id, time) {
  if (OFFICE_FUN[id]) return officeFunPreview(f, look, id, time);
  const where = OFFICE_ADDON_PREVIEW[id];
  const batches = [...Object.values(f.solids).map((batch) => [batch, 12]), [f.floor, 0], [f.glow, 0]];
  const from = batches.map(([batch]) => batch.n);
  OFFICE_ADDONS[id]?.(f, officeWearOf(look), { trophies: OFFICE_PREVIEW_TROPHIES }, time, look);
  batches.forEach(([batch, at], b) => {
    for (let i = from[b]; i < batch.n; i++) for (let k = 0; k < 3; k++) batch.data[i * batch.stride + at + k] -= where[k];
  });
}

const OFFICE_ADDON_PREVIEW = {
  'office-neon': [0.05, 0.7, 4.6], 'office-fridge': [0.32, 0, 3.45], 'office-trophy': [0.95, 0.75, 0.11], 'office-disco': [12.2, 0.85, 2.75],
};
const OFFICE_PREVIEW_TROPHIES = Array.from({ length: 9 }, (_, i) => ({ id: 'preview-' + i, secret: i === 4 }));
