const INTRO_NODES = 112;
const INTRO_GLYPH = [[40.3, 35.4], [40.3, 64.6], [59.7, 50]];
const INTRO_GLOW = [[0, 1], [0.1, 0.72], [0.24, 0.36], [0.48, 0.12], [0.74, 0.03], [1, 0]];
const INTRO_BOKEH = [[0, 0.38], [0.6, 0.34], [0.84, 0.3], [0.95, 0.1], [1, 0]];
const INTRO_BRANCH_SIZE = 20;
const INTRO_BRANCH_DIRS = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
const INTRO_WALK_EDGES = 48;
const INTRO_HOP = 60;

const introClamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const introEaseOut = (u) => 1 - (1 - u) ** 3;
const introEaseInOut = (u) => (u < 0.5 ? 4 * u ** 3 : 1 - (2 - 2 * u) ** 3 / 2);
const introSpan = (t, from, ms) => introClamp((t - from) / ms);

function introPainter(canvas, reduced) {
  const ctx = canvas.getContext?.('2d');
  if (!ctx) return null;
  const sc = { canvas, ctx, reduced, look: introLook(ctx), graph: introGraph(), target: null, flying: false, lit: [], seeds: [] };
  introSize(sc);
  return { draw: (t, gather, leave, lit) => introDraw(sc, t, gather, leave, lit), resize: () => introSize(sc), seed: (b) => sc.seeds[b] ?? null };
}

function introSize(sc) {
  sc.w = window.innerWidth;
  sc.h = window.innerHeight;
  sc.dpr = window.devicePixelRatio || 1;
  sc.canvas.width = Math.round(sc.w * sc.dpr);
  sc.canvas.height = Math.round(sc.h * sc.dpr);
  sc.s0 = Math.min(240, Math.max(132, Math.min(sc.w, sc.h) * 0.34)) / 100;
  sc.rx = (0.5 * sc.w) / sc.s0;
  sc.ry = (0.44 * sc.h) / sc.s0;
  sc.d0 = 1.45 * Math.max(sc.rx, sc.ry) + 60;
  sc.f = sc.s0 * sc.d0;
  sc.vignette = introVignette(sc);
  sc.canvas.parentNode?.style.setProperty('--intro-mark', sc.s0 * 100 + 'px');
  sc.target = introMeasure() ?? sc.target;
}

function introVignette(sc) {
  const g = sc.ctx.createRadialGradient(sc.w / 2, sc.h / 2, Math.min(sc.w, sc.h) * 0.25, sc.w / 2, sc.h / 2, Math.hypot(sc.w, sc.h) * 0.6);
  g.addColorStop(0, 'rgba(0, 0, 0, 0)');
  g.addColorStop(1, 'rgba(0, 0, 0, 0.45)');
  return g;
}

function introMeasure() {
  const logo = document.querySelector('.logo');
  const mark = logo?.querySelector('svg');
  const box = mark?.getBoundingClientRect();
  if (!box?.width) return null;
  const s = box.width / 100;
  const css = getComputedStyle(logo);
  return {
    x: box.left + box.width / 2, y: box.top + box.height / 2, s,
    half: logo.getBoundingClientRect().width / 2 / s, radius: parseFloat(css.borderTopLeftRadius) / s, border: parseFloat(css.borderTopWidth) / s,
  };
}

// The canvas reads any CSS colour back as hex or rgba, which is all the parsing a token needs.
function introRgb(ctx, value) {
  ctx.fillStyle = '#000';
  ctx.fillStyle = value;
  const v = ctx.fillStyle;
  return v.startsWith('#') ? [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) : v.match(/[\d.]+/g).slice(0, 3).map(Number);
}

function introLook(ctx) {
  const css = getComputedStyle(document.documentElement);
  const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  const bg = token('--bg', '#0b0e13');
  const [r, g, b] = introRgb(ctx, bg);
  const light = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.5;
  const accent = token('--accent', '#8aa8ff');
  const strong = token('--accent-strong', '#5f86ff');
  const far = token('--moved', '#c58cff');
  const stops = [...document.querySelectorAll('#logo-ring stop')].map((s) => s.getAttribute('stop-color'));
  return {
    light, bg, blend: light ? 'source-over' : 'lighter',
    near: light ? strong : accent, far, core: light ? strong : token('--fg', '#e6eaf1'),
    halo: introSprite(accent, INTRO_GLOW), haze: introSprite(far, INTRO_GLOW), bokeh: introSprite(light ? strong : accent, INTRO_BOKEH),
    pulse: introSprite(token('--info', '#55cfd2'), INTRO_GLOW, light ? strong : '#ffffff'), white: introSprite('#ecf0f7', INTRO_GLOW),
    ring: [stops[0] ?? accent, stops[1] ?? strong], shadow: introShadow(),
    branches: INTRO_STEPS.map(([, , tone]) => introTone(token(tone, accent))),
    failed: introTone(token('--need', '#ff7a66')),
  };
}

function introTone(colour) {
  return { colour, halo: introSprite(colour, INTRO_GLOW), hot: introSprite(colour, INTRO_GLOW, '#ffffff') };
}

function introSprite(colour, stops, centre) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [at, a] of stops) grad.addColorStop(at, `rgba(255, 255, 255, ${a})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = colour;
  g.fillRect(0, 0, 64, 64);
  if (!centre) return c;
  const hot = g.createRadialGradient(32, 32, 0, 32, 32, 8);
  hot.addColorStop(0, centre);
  hot.addColorStop(1, 'rgba(255, 255, 255, 0)');
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = hot;
  g.fillRect(0, 0, 64, 64);
  return c;
}

// The tile's 0 6px 18px box-shadow, drawn once at three times its size, since a live canvas shadow that wide costs milliseconds a frame.
function introShadow() {
  const c = document.createElement('canvas');
  c.width = c.height = 384;
  const g = c.getContext('2d');
  g.shadowColor = 'rgba(0, 0, 0, 0.35)';
  g.shadowBlur = 67;
  g.shadowOffsetX = 1000;
  g.beginPath();
  g.roundRect(128 - 1000, 128, 128, 128, 37.5);
  g.fill();
  return c;
}

function introRandom(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function introGraph() {
  const rand = introRandom(5);
  const spread = () => (rand() + rand() + rand() - 1.5) * 0.3;
  const hubs = Array.from({ length: 8 }, (_, i) => introFibonacci(i, 8, 0.6));
  const nodes = Array.from({ length: INTRO_NODES }, (_, i) => {
    const loose = i % 4 === 3;
    const p = loose ? introInBall(rand, 0.95) : hubs[i % 8].map((v) => v + spread());
    return { p, r: loose ? 0.8 + rand() * 0.4 : 1 + rand() * 0.9, at: 30 + rand() * 360, glyph: -1, aim: 0, gatherAt: 0, swirl: 0, x: 0, y: 0, trail: null, k: 0, d: 0, alpha: 0, e: 0, far: 0, flash: 0, glow: INTRO_UNLIT, branch: -1, hop: 0, parent: -1, reach: 0 };
  });
  const mid = introCentre(nodes);
  const dust = Array.from({ length: 150 }, () => ({ p: introInBall(rand, 1.7), r: 0.35 + rand() * 0.5, at: rand() * 500 }));
  const edges = introEdges(nodes, rand);
  const links = introLinks(nodes, edges);
  const clouds = hubs.map((p, i) => ({ p: p.map((v, axis) => v - mid[axis]), tone: i % 2 }));
  const branches = introBranches(nodes, edges, links);
  return { nodes, dust, clouds, edges, branches, walks: introWalks(nodes, links, rand), order: nodes.map((_, i) => i), gathered: false };
}

function introLinks(nodes, edges) {
  const links = nodes.map(() => []);
  for (const { a, b } of edges) links[a].push(b), links[b].push(a);
  return links;
}

// Each branch grows outward from its seed one node per turn, so the four stay connected, apart and about the same size.
function introBranches(nodes, edges, links) {
  const owner = nodes.map(() => -1);
  const branches = INTRO_BRANCH_DIRS.map((dir, b) => {
    const seed = introFarthest(nodes, owner, dir);
    owner[seed] = b;
    Object.assign(nodes[seed], { branch: b, hop: 0, parent: -1 });
    return { seed, members: [seed] };
  });
  for (let grew = true; grew;) {
    grew = false;
    for (const [b, branch] of branches.entries()) if (branch.members.length < INTRO_BRANCH_SIZE && introGrow(nodes, links, owner, branch, b)) grew = true;
  }
  return branches.map((branch, b) => ({ ...branch, edges: introBranchEdges(nodes, edges, b), runs: introRuns(nodes, branch.members) }));
}

function introFarthest(nodes, owner, dir) {
  const norm = Math.hypot(...dir);
  let best = -1;
  nodes.forEach((n, i) => {
    const reach = (n.p[0] * dir[0] + n.p[1] * dir[1] + n.p[2] * dir[2]) / norm;
    if (owner[i] < 0 && (best < 0 || reach > nodes[best].reach)) best = i;
    n.reach = reach;
  });
  return best;
}

function introGrow(nodes, links, owner, branch, b) {
  const seed = nodes[branch.seed].p;
  const near = (i) => Math.hypot(nodes[i].p[0] - seed[0], nodes[i].p[1] - seed[1], nodes[i].p[2] - seed[2]);
  for (const from of branch.members) {
    const free = links[from].filter((i) => owner[i] < 0).sort((i, j) => near(i) - near(j));
    if (!free.length) continue;
    owner[free[0]] = b;
    Object.assign(nodes[free[0]], { branch: b, hop: nodes[from].hop + 1, parent: from });
    branch.members.push(free[0]);
    return true;
  }
  return false;
}

function introBranchEdges(nodes, edges, b) {
  return edges.filter((e) => nodes[e.a].branch === b && nodes[e.b].branch === b)
    .map((e) => (nodes[e.a].hop <= nodes[e.b].hop ? [e.a, e.b] : [e.b, e.a]));
}

function introRuns(nodes, members) {
  const deepest = [...members].sort((i, j) => nodes[j].hop - nodes[i].hop).slice(0, 3);
  return deepest.map((leaf) => {
    const path = [leaf];
    while (nodes[path[0]].parent >= 0) path.unshift(nodes[path[0]].parent);
    return path;
  });
}

function introFibonacci(i, count, radius) {
  const y = 1 - (2 * (i + 0.5)) / count;
  const r = Math.sqrt(1 - y * y);
  const a = i * 2.399963;
  return [Math.cos(a) * r * radius, y * radius, Math.sin(a) * r * radius];
}

function introInBall(rand, radius) {
  const z = rand() * 2 - 1;
  const a = rand() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  const d = Math.cbrt(rand()) * radius;
  return [Math.cos(a) * r * d, Math.sin(a) * r * d, z * d];
}

function introCentre(nodes) {
  const mid = [0, 1, 2].map((axis) => nodes.reduce((sum, n) => sum + n.p[axis], 0) / nodes.length);
  for (const n of nodes) n.p = n.p.map((v, axis) => v - mid[axis]);
  return mid;
}

function introEdges(nodes, rand) {
  const seen = new Set();
  const edges = [];
  const dist = (a, b) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]);
  nodes.forEach((n, i) => {
    const near = nodes.map((m, j) => [j, dist(n, m)]).filter(([j]) => j !== i).sort((a, b) => a[1] - b[1]).slice(0, 3);
    for (const [j] of near) {
      const id = Math.min(i, j) + ':' + Math.max(i, j);
      if (seen.has(id)) continue;
      seen.add(id);
      edges.push({ a: i, b: j, at: Math.max(n.at, nodes[j].at) + 90 + rand() * 260 });
    }
  });
  return edges;
}

// Each pulse walks the graph edge to edge, worked out ahead so a frame only reads where it is.
function introWalks(nodes, links, rand) {
  return Array.from({ length: 30 }, () => {
    const path = [Math.floor(rand() * nodes.length)];
    while (path.length <= INTRO_WALK_EDGES) {
      const options = links[path.at(-1)].filter((n) => n !== path.at(-2));
      const pool = options.length ? options : links[path.at(-1)];
      path.push(pool[Math.floor(rand() * pool.length)]);
    }
    return { path, at: 340 + rand() * 420, rate: 2.4 + rand() * 2.2 };
  });
}

// While the page loads the camera wanders a little, and the wander eases out as the collapse starts, so the glyph lands where the mark is drawn.
function introCamera(sc, t, story) {
  const k = introEaseOut(introClamp(t / 1150));
  const wander = introEaseInOut(introSpan(t, 500, 900)) * (1 - introEaseInOut(introSpan(story, INTRO_AT.collapse, 320)));
  return {
    dist: sc.d0 * (0.4 + 0.6 * k) * (1 + 0.04 * wander * Math.sin(t * 0.0011)),
    x: sc.rx * (0.16 * (1 - k) + 0.06 * wander * Math.sin(t * 0.0007 + 1.3)),
    yaw: -1.25 + 1.5 * introEaseOut(introClamp(t / 1700)) + t * 0.00022, pitch: 0.38 - 0.24 * k + 0.08 * wander * Math.sin(t * 0.0009 + 0.4),
  };
}

// Each node streams to the glyph node in its own direction, so the cloud falls in as three converging streams.
function introAssign(sc, t, cam) {
  const g = sc.graph;
  g.gathered = true;
  const counts = [0, 0, 0];
  for (const n of g.nodes) {
    const [x, y] = introRotate(sc, n.p, cam);
    const a = Math.atan2(y, x);
    n.glyph = Math.abs(a) < 1.07 ? 2 : a < 0 ? 0 : 1;
    n.aim = counts[n.glyph]++;
    n.gatherAt = t + Math.min(1, Math.hypot(x / sc.rx, y / sc.ry)) * 190 + (sc.lit[n.branch] ? 150 : 0);
    n.swirl = 1.5 + (n.aim % 3) * 0.25;
  }
  for (const n of g.nodes) n.aim = (n.aim / counts[n.glyph]) * Math.PI * 2;
}

function introRotate(sc, [px, py, pz], cam, scale = 1) {
  const x0 = px * sc.rx * scale;
  const y0 = py * sc.ry * scale;
  const z0 = pz * sc.rx * scale;
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const x1 = x0 * cy + z0 * sy;
  const z1 = z0 * cy - x0 * sy;
  const cp = Math.cos(cam.pitch);
  const sp = Math.sin(cam.pitch);
  return [x1, y0 * cp - z1 * sp, y0 * sp + z1 * cp];
}

function introPlace(sc, n, t, story, cam) {
  const [x, y, z] = introRotate(sc, n.p, cam);
  const e = n.glyph < 0 ? 0 : introEaseInOut(introSpan(story, n.gatherAt, INTRO_AT.gather));
  n.e = e;
  n.flash = 0;
  introProject(sc, n, e > 0 ? introGather(n, x, y, z, e) : [x, y, z], cam, e);
  n.trail = e > 0 && e < 1 ? introTrail(sc, n, [x, y, z], story, cam) : null;
  if (n.alpha === 0) return;
  const fog = introClamp((sc.d0 + sc.rx - n.d) / (2 * sc.rx));
  const near = introClamp((n.d - 0.05 * sc.d0) / (0.2 * sc.d0));
  const settled = n.glyph < 0 ? 1 : 1 - introSpan(story, n.gatherAt + INTRO_AT.gather - 60, 220);
  n.far = (1 - fog) * (1 - e);
  n.glow = introBranchGlow(sc, n, t);
  n.alpha = introEaseOut(introSpan(t, n.at, 320)) * near * (0.3 + 0.7 * Math.max(fog, e)) * settled * (1 - 0.6 * n.glow.dim);
}

function introBranchGlow(sc, n, t) {
  const lit = sc.lit[n.branch];
  if (!lit) return INTRO_UNLIT;
  const k = introEaseOut(introSpan(t, lit.at + n.hop * INTRO_HOP, 180));
  return lit.state === 'done' ? { tone: k, dim: 0, flicker: 0 } : { tone: 0, dim: k, flicker: introFlicker(t, lit.at) };
}

const INTRO_UNLIT = { tone: 0, dim: 0, flicker: 0 };

function introFlicker(t, at) {
  const fade = 1 - introSpan(t, at, 420);
  return fade * (0.5 + 0.5 * Math.sin((t - at) * 0.09)) ** 2;
}

function introProject(sc, n, [x, y, z], cam, e) {
  n.d = z + cam.dist;
  n.alpha = n.d < 1 ? 0 : 1;
  if (!n.alpha) return;
  n.k = sc.f / n.d;
  n.x = sc.w / 2 + (x - cam.x * (1 - e)) * n.k;
  n.y = sc.h / 2 + y * n.k;
}

function introTrail(sc, n, at, t, cam) {
  return [80, 64, 48, 32, 16].map((lag) => {
    const [x, y, z] = introGather(n, ...at, introEaseInOut(introSpan(t - lag, n.gatherAt, INTRO_AT.gather)));
    const k = sc.f / Math.max(1, z + cam.dist);
    return [sc.w / 2 + x * k, sc.h / 2 + y * k];
  });
}

function introGather(n, x, y, z, e) {
  const [gx, gy] = INTRO_GLYPH[n.glyph];
  const tx = gx - 50 + Math.cos(n.aim) * 5;
  const ty = gy - 50 + Math.sin(n.aim) * 5;
  const turn = n.swirl * e;
  const dx = (x - tx) * (1 - e);
  const dy = (y - ty) * (1 - e);
  return [tx + dx * Math.cos(turn) - dy * Math.sin(turn), ty + dx * Math.sin(turn) + dy * Math.cos(turn), z * (1 - e)];
}

// The cloud runs on the clock for as long as the page loads; everything from the collapse on runs on the story, which waits for it.
function introDraw(sc, t, gather, leaveAt, lit) {
  const { ctx } = sc;
  ctx.setTransform(sc.dpr, 0, 0, sc.dpr, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, sc.w, sc.h);
  if (sc.reduced) return introDrawStill(sc, t, leaveAt);
  const gathering = gather != null && t >= gather;
  const story = gathering ? INTRO_AT.collapse + t - gather : Math.min(t, INTRO_AT.collapse);
  sc.lit = lit ?? [];
  if (leaveAt != null && t >= leaveAt && !sc.flying) {
    sc.flying = true;
    sc.target = introMeasure() ?? sc.target;
  }
  const leave = leaveAt == null ? 0 : introEaseInOut(introSpan(t, leaveAt, INTRO_AT.fly * 0.75));
  introBackdrop(sc, story, 1 - leave);
  const pose = introPose(sc, t, leaveAt);
  introDrawTile(sc, pose, introEaseOut(introSpan(story, INTRO_AT.tile, 180)), 0.72 + 0.28 * introEaseOut(introSpan(story, INTRO_AT.tile, 420)));
  if (story < INTRO_AT.collapse + 1000) introCloud(sc, t, story, gathering);
  introDrawMark(sc, pose, introProgress(story), 1 - leave);
}

function introBackdrop(sc, t, alpha) {
  const { ctx, look } = sc;
  if (alpha <= 0) return;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = look.bg;
  ctx.fillRect(0, 0, sc.w, sc.h);
  if (!look.light) {
    ctx.fillStyle = sc.vignette;
    ctx.fillRect(0, 0, sc.w, sc.h);
  }
  const glow = 0.1 + 0.18 * introSpan(t, INTRO_AT.collapse, 700);
  const size = sc.s0 * 100 * 4.2;
  ctx.globalCompositeOperation = look.blend;
  ctx.globalAlpha = alpha * glow * (look.light ? 0.5 : 1);
  ctx.drawImage(look.halo, sc.w / 2 - size / 2, sc.h / 2 - size / 2, size, size);
  ctx.globalCompositeOperation = 'source-over';
}

function introCloud(sc, t, story, gathering) {
  const g = sc.graph;
  const cam = introCamera(sc, t, story);
  if (!g.gathered && gathering) introAssign(sc, story, cam);
  for (const n of g.nodes) introPlace(sc, n, t, story, cam);
  sc.ctx.globalCompositeOperation = sc.look.blend;
  introDrawDust(sc, t, story, cam);
  introDrawClouds(sc, t, story, cam);
  introDrawEdges(sc, t);
  introDrawBranches(sc, t);
  const pulses = introPulses(sc, t);
  introDrawNodes(sc);
  introDrawPulses(sc, pulses);
  introDrawBranchPulses(sc, t);
  sc.ctx.globalCompositeOperation = 'source-over';
  introSeeds(sc);
}

function introSeeds(sc) {
  sc.seeds = sc.graph.branches.map(({ seed }) => {
    const n = sc.graph.nodes[seed];
    return { x: n.x, y: n.y, shown: n.alpha > 0.12 && n.e < 0.05 && n.k / sc.s0 < 2.6 };
  });
}

function introDrawDust(sc, t, story, cam) {
  const { ctx, look } = sc;
  const pull = introEaseInOut(introSpan(story, INTRO_AT.collapse - 80, 560));
  for (const mote of sc.graph.dust) {
    const [x, y, z] = introRotate(sc, mote.p, cam, 1 - pull * 0.85);
    const d = z + cam.dist;
    if (d < 20) continue;
    const k = sc.f / d;
    const alpha = introEaseOut(introSpan(t, mote.at, 400)) * introClamp((d - 0.08 * sc.d0) / (0.25 * sc.d0)) * (1 - pull) * 0.55;
    introSpriteAt(ctx, look.haze, sc.w / 2 + (x - cam.x) * k, sc.h / 2 + y * k, Math.max(2, mote.r * k * 7), alpha);
  }
}

function introDrawClouds(sc, t, story, cam) {
  const { ctx, look } = sc;
  const fade = introEaseOut(introSpan(t, 80, 600)) * (1 - introSpan(story, INTRO_AT.collapse, 380));
  if (fade <= 0) return;
  for (const cloud of sc.graph.clouds) {
    const [x, y, z] = introRotate(sc, cloud.p, cam);
    const d = z + cam.dist;
    if (d < 0.15 * sc.d0) continue;
    const k = sc.f / d;
    introSpriteAt(ctx, cloud.tone ? look.haze : look.halo, sc.w / 2 + (x - cam.x) * k, sc.h / 2 + y * k, sc.rx * 0.75 * k, fade * (look.light ? 0.07 : 0.11));
  }
}

const INTRO_EDGE_BANDS = [[0.55, 0.14], [0.8, 0.24], [1.05, 0.38], [1.4, 0.56]];

function introDrawEdges(sc, t) {
  const { ctx, graph, look } = sc;
  const bands = INTRO_EDGE_BANDS.map(() => []);
  for (const edge of graph.edges) {
    const a = graph.nodes[edge.a];
    const b = graph.nodes[edge.b];
    const grow = introEaseOut(introSpan(t, edge.at, 300));
    const strength = Math.min(a.alpha, b.alpha) * grow * (1 - Math.max(a.e, b.e)) ** 2;
    if (strength > 0.04) bands[Math.min(3, Math.floor(strength * 4))].push([a, b, grow]);
  }
  ctx.lineCap = 'round';
  bands.forEach((band, i) => {
    if (!band.length) return;
    ctx.strokeStyle = i < 2 ? look.far : look.near;
    ctx.lineWidth = INTRO_EDGE_BANDS[i][0];
    ctx.globalAlpha = INTRO_EDGE_BANDS[i][1] * (look.light ? 0.85 : 1);
    ctx.beginPath();
    for (const [a, b, grow] of band) {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(a.x + (b.x - a.x) * grow, a.y + (b.y - a.y) * grow);
    }
    ctx.stroke();
  });
}

function introDrawBranches(sc, t) {
  const { ctx, graph, look } = sc;
  ctx.lineWidth = 1.7;
  ctx.lineCap = 'round';
  graph.branches.forEach((branch, b) => {
    const lit = sc.lit[b];
    if (!lit || t < lit.at) return;
    const failed = lit.state !== 'done';
    const tone = failed ? look.failed : look.branches[b];
    const strength = failed ? introFlicker(t, lit.at) : 0.8;
    if (strength <= 0.01) return;
    ctx.strokeStyle = tone.colour;
    ctx.globalAlpha = strength;
    ctx.beginPath();
    const fronts = introBranchPath(ctx, graph, branch, lit, t);
    ctx.stroke();
    if (!failed) for (const [x, y, alpha] of fronts) introSpriteAt(ctx, tone.hot, x, y, sc.s0 * 14, alpha);
  });
}

function introBranchPath(ctx, graph, branch, lit, t) {
  const fronts = [];
  for (const [from, to] of branch.edges) {
    const a = graph.nodes[from];
    const b = graph.nodes[to];
    const u = introSpan(t, lit.at + a.hop * INTRO_HOP, INTRO_HOP);
    const shown = Math.min(a.alpha, b.alpha) * (1 - Math.max(a.e, b.e));
    if (u <= 0 || shown < 0.05) continue;
    const x = a.x + (b.x - a.x) * u;
    const y = a.y + (b.y - a.y) * u;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(x, y);
    if (u < 1) fronts.push([x, y, shown]);
  }
  return fronts;
}

// Each pulse fades at both ends of its path, so going back to the seed for the next run is never seen as a jump.
function introDrawBranchPulses(sc, t) {
  const { ctx, graph, look } = sc;
  graph.branches.forEach((branch, b) => {
    const lit = sc.lit[b];
    if (!lit || lit.state !== 'done' || t < lit.at + 200) return;
    branch.runs.forEach((path, j) => {
      const span = path.length - 1;
      const s = (((t - lit.at - 200) / 1000) * 6 + j * 1.7) % span;
      const i = Math.floor(s);
      const from = graph.nodes[path[i]];
      const to = graph.nodes[path[i + 1]];
      const u = s - i;
      const alpha = Math.sin((Math.PI * s) / span) * Math.min(from.alpha, to.alpha) * (1 - Math.max(from.e, to.e));
      introSpriteAt(ctx, look.branches[b].hot, from.x + (to.x - from.x) * u, from.y + (to.y - from.y) * u, sc.s0 * 20 * Math.sqrt(from.k / sc.s0), alpha);
    });
  });
}

function introPulses(sc, t) {
  const { nodes } = sc.graph;
  const shown = [];
  for (const w of sc.graph.walks) {
    const s = ((t - w.at) / 1000) * w.rate;
    if (s < 0) continue;
    const i = Math.floor(s) % (w.path.length - 1);
    const from = nodes[w.path[i]];
    const to = nodes[w.path[i + 1]];
    const u = s - Math.floor(s);
    from.flash = Math.max(from.flash, Math.exp(-u / w.rate / 0.16));
    const alpha = Math.min(from.alpha, to.alpha) * introSpan(t, w.at, 200) * (1 - Math.max(from.e, to.e));
    const tone = from.branch === to.branch && from.glow.tone > 0 && to.glow.tone > 0 ? from.branch : -1;
    if (alpha > 0.03) shown.push([from, to, u, alpha, tone]);
  }
  return shown;
}

function introDrawNodes(sc) {
  const { graph } = sc;
  const max = Math.min(sc.w, sc.h) * 0.3;
  graph.order.sort((i, j) => graph.nodes[j].d - graph.nodes[i].d);
  for (const i of graph.order) if (graph.nodes[i].alpha > 0.01) introDrawNode(sc, graph.nodes[i], max);
}

// Nodes well in front of the mark's plane are out of focus, so they draw as soft discs rather than points.
function introDrawNode(sc, n, max) {
  const { ctx, look } = sc;
  const blur = introClamp((n.k / sc.s0 - 2.1) / 1.6);
  const r = n.r * n.k * (1 + 0.35 * n.flash) * (1 - 0.5 * n.e);
  const lit = n.alpha * (0.62 + 0.9 * n.flash) * (1 - blur);
  if (blur > 0) introSpriteAt(ctx, look.bokeh, n.x, n.y, Math.min(max, r * 5), n.alpha * 0.4 * blur);
  if (blur >= 1) return;
  if (n.trail) introStreak(ctx, look, n, r);
  const halo = Math.min(max, r * 11);
  const tone = n.glow.tone * (1 - n.e);
  introSpriteAt(ctx, look.halo, n.x, n.y, halo, lit * (1 - n.far) * (1 - n.e) * (1 - tone));
  introSpriteAt(ctx, look.haze, n.x, n.y, halo, lit * n.far * (1 - tone));
  if (tone > 0) introSpriteAt(ctx, look.branches[n.branch].halo, n.x, n.y, halo * 1.25, lit * tone * 1.3);
  if (n.glow.flicker > 0) introSpriteAt(ctx, look.failed.halo, n.x, n.y, halo, n.alpha * n.glow.flicker);
  introSpriteAt(ctx, look.white, n.x, n.y, halo * 0.5, lit * n.e * (n.branch >= 0 && sc.lit[n.branch] ? 0.45 : 0.28));
  ctx.globalAlpha = n.alpha * (1 - blur);
  ctx.fillStyle = n.e > 0.5 ? '#ecf0f7' : look.core;
  ctx.beginPath();
  ctx.arc(n.x, n.y, Math.max(0.6, r), 0, Math.PI * 2);
  ctx.fill();
}

function introStreak(ctx, look, n, r) {
  const points = [...n.trail, [n.x, n.y]];
  ctx.globalAlpha = n.alpha * 0.6;
  ctx.strokeStyle = look.near;
  ctx.lineWidth = Math.max(0.8, r);
  ctx.beginPath();
  ctx.moveTo(...points[0]);
  for (let i = 1; i < points.length - 1; i += 1) {
    ctx.quadraticCurveTo(...points[i], (points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2);
  }
  ctx.lineTo(n.x, n.y);
  ctx.stroke();
}

function introDrawPulses(sc, pulses) {
  const { ctx, look } = sc;
  for (const [from, to, u, alpha, tone] of pulses) {
    const lit = tone >= 0;
    const sprite = lit ? look.branches[tone].hot : look.pulse;
    const size = sc.s0 * (lit ? 21 : 16) * Math.sqrt(from.k / sc.s0);
    for (let j = 0; j < 5; j += 1) {
      const at = u - j * 0.055;
      if (at < 0) break;
      introSpriteAt(ctx, sprite, from.x + (to.x - from.x) * at, from.y + (to.y - from.y) * at, size * (1 - j * 0.16), alpha * (lit ? 1.4 : 1) * (1 - j * 0.2));
    }
  }
}

function introSpriteAt(ctx, sprite, x, y, size, alpha) {
  if (alpha <= 0.005) return;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
}

function introProgress(t) {
  return {
    nodes: introEaseOut(introSpan(t, INTRO_AT.nodes, 200)),
    bloom: introSpan(t, INTRO_AT.nodes, 140) * (1 - introSpan(t, INTRO_AT.nodes + 160, 320)),
    stem: introEaseInOut(introSpan(t, INTRO_AT.stem, 260)),
    curve: introEaseInOut(introSpan(t, INTRO_AT.curve, 270)),
    track: introSpan(t, INTRO_AT.ring, 160),
    sweep: introEaseInOut(introSpan(t, INTRO_AT.ring + 20, INTRO_AT.lock - INTRO_AT.ring - 20)),
    lock: introSpan(t, INTRO_AT.lock, 420),
  };
}

function introPose(sc, t, leaveAt) {
  const home = { x: sc.w / 2, y: sc.h / 2, s: sc.s0, alpha: 1, k: 0 };
  if (leaveAt == null) return home;
  const k = introEaseInOut(introSpan(t, leaveAt, INTRO_AT.fly));
  const to = sc.target;
  if (!to) return { ...home, alpha: 1 - k, k };
  const bend = { x: home.x + (to.x - home.x) * 0.3, y: home.y + (to.y - home.y) * 0.78 };
  const along = (a, b, c) => (1 - k) ** 2 * a + 2 * (1 - k) * k * b + k ** 2 * c;
  return { x: along(home.x, bend.x, to.x), y: along(home.y, bend.y, to.y), s: home.s * (to.s / home.s) ** k, alpha: 1, k };
}

function introInMark(sc, pose) {
  const s = pose.s * sc.dpr;
  sc.ctx.setTransform(s, 0, 0, s, (pose.x - 50 * pose.s) * sc.dpr, (pose.y - 50 * pose.s) * sc.dpr);
}

function introTile(sc) {
  const rest = sc.target ?? { half: 53.125, radius: 31.25, border: 3.125 };
  return { half: rest.half, radius: rest.radius, border: rest.border, drop: rest.half * (6 / 17) };
}

function introDrawTile(sc, pose, alpha, grow) {
  const { ctx, look } = sc;
  if (alpha <= 0) return;
  const tile = introTile(sc);
  const half = tile.half * grow;
  const shadow = half * 6;
  introInMark(sc, pose);
  ctx.globalAlpha = alpha * pose.alpha;
  ctx.drawImage(look.shadow, 50 - shadow / 2, 50 - shadow / 2 + tile.drop * grow, shadow, shadow);
  const fill = ctx.createLinearGradient(0, 50 - half, 0, 50 + half);
  fill.addColorStop(0, '#222938');
  fill.addColorStop(1, '#0b0e13');
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(50 - half, 50 - half, half * 2, half * 2, tile.radius * grow);
  ctx.fill();
  const b = tile.border * grow;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = b;
  ctx.beginPath();
  ctx.roundRect(50 - half + b / 2, 50 - half + b / 2, half * 2 - b, half * 2 - b, Math.max(0, tile.radius * grow - b / 2));
  ctx.stroke();
  ctx.setTransform(sc.dpr, 0, 0, sc.dpr, 0, 0);
}

function introDrawMark(sc, pose, p, glow) {
  const { ctx } = sc;
  introInMark(sc, pose);
  ctx.globalAlpha = pose.alpha;
  ctx.lineCap = 'round';
  introDrawRing(sc, p, pose.alpha);
  introDrawStrokes(sc, p, pose.alpha);
  introDrawGlyphNodes(sc, p, pose.alpha);
  introDrawGlints(sc, p, pose.alpha * glow);
  ctx.setTransform(sc.dpr, 0, 0, sc.dpr, 0, 0);
  ctx.globalAlpha = 1;
}

function introDrawRing(sc, p, alpha) {
  const { ctx, look } = sc;
  if (p.track <= 0) return;
  ctx.globalAlpha = alpha * p.track;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.arc(50, 50, 32.5, 0, Math.PI * 2);
  ctx.stroke();
  if (p.sweep <= 0) return;
  const grad = ctx.createLinearGradient(17.5, 17.5, 82.5, 72.98);
  grad.addColorStop(0, look.ring[0]);
  grad.addColorStop(1, look.ring[1]);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = grad;
  ctx.beginPath();
  ctx.arc(50, 50, 32.5, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * p.sweep));
  ctx.stroke();
}

function introDrawStrokes(sc, p, alpha) {
  const { ctx } = sc;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = '#ecf0f7';
  ctx.lineWidth = 4.2;
  ctx.beginPath();
  if (p.stem > 0) {
    ctx.moveTo(40.3, 35.4);
    ctx.lineTo(40.3, 35.4 + 29.2 * p.stem);
  }
  if (p.curve > 0) {
    const u = p.curve;
    ctx.moveTo(40.3, 35.4);
    ctx.quadraticCurveTo(40.3, 35.4 + 14.6 * u, 40.3 + 19.4 * u * u, 35.4 + 14.6 * (2 * u - u * u));
  }
  ctx.stroke();
}

function introDrawGlyphNodes(sc, p, alpha) {
  const { ctx } = sc;
  if (p.nodes <= 0) return;
  ctx.globalAlpha = alpha * p.nodes;
  ctx.lineWidth = 4.2;
  ctx.fillStyle = '#1a202b';
  ctx.strokeStyle = '#ecf0f7';
  for (const [x, y] of INTRO_GLYPH) {
    ctx.beginPath();
    ctx.arc(x, y, 5 * (0.6 + 0.4 * p.nodes), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function introDrawGlints(sc, p, alpha) {
  const { ctx, look } = sc;
  if (alpha <= 0) return;
  const spark = look.light ? look.white : look.pulse;
  ctx.globalCompositeOperation = 'lighter';
  for (const [x, y] of INTRO_GLYPH) {
    introSpriteAt(ctx, look.halo, x, y, 36, alpha * p.bloom * 0.75);
    introSpriteAt(ctx, look.white, x, y, 14, alpha * p.bloom * 0.35);
  }
  if (p.stem > 0 && p.stem < 1) introSpriteAt(ctx, spark, 40.3, 35.4 + 29.2 * p.stem, 24, alpha);
  if (p.curve > 0 && p.curve < 1) introSpriteAt(ctx, spark, 40.3 + 19.4 * p.curve ** 2, 35.4 + 14.6 * (2 * p.curve - p.curve ** 2), 24, alpha);
  if (p.sweep > 0 && p.sweep < 1) introRingGlint(ctx, spark, p.sweep, 30, alpha * Math.sin(Math.PI * p.sweep) ** 0.5);
  ctx.globalCompositeOperation = look.blend;
  if (p.lock > 0 && p.lock < 1) introShock(ctx, look, p.lock, alpha);
  ctx.globalCompositeOperation = 'source-over';
}

function introRingGlint(ctx, sprite, at, size, alpha) {
  const a = Math.PI * (0.75 + 1.5 * at);
  introSpriteAt(ctx, sprite, 50 + Math.cos(a) * 32.5, 50 + Math.sin(a) * 32.5, size, alpha);
}

function introShock(ctx, look, k, alpha) {
  introSpriteAt(ctx, look.halo, 50, 50, 150 + 60 * k, alpha * 0.32 * (1 - k));
  ctx.globalAlpha = alpha * 0.3 * (1 - k) ** 2;
  ctx.strokeStyle = look.ring[0];
  ctx.lineWidth = 1.6 * (1 - k) + 0.3;
  ctx.beginPath();
  ctx.arc(50, 50, 38 + 40 * introEaseOut(k), 0, Math.PI * 2);
  ctx.stroke();
}

function introDrawStill(sc, t, leaveAt) {
  const fade = leaveAt == null ? 1 : 1 - introEaseOut(introSpan(t, leaveAt, INTRO_REDUCED_MS));
  introBackdrop(sc, 0, fade);
  const pose = { x: sc.w / 2, y: sc.h / 2, s: sc.s0, alpha: fade, k: 0 };
  introDrawTile(sc, pose, 1, 1);
  introDrawMark(sc, pose, { nodes: 1, bloom: 0, stem: 1, curve: 1, track: 1, sweep: 1, lock: 0 }, 0);
}
