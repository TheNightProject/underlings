const OFFICE_KIND_LABELS = { review: 'Review', fix: 'Fix', kickoff: 'Kickoff', ticket: 'Ticket', message: 'Message' };
const OFFICE_MANAGER = 'office:manager';
const OFFICE_PLAYER = 'office:player';
const OFFICE_PLAYER_PREFS = ['sofa', 'wander', 'coffee', 'sofa', 'board', 'wander'];
const OFFICE_RALLY_REPORTED = 5;
const OFFICE_YAW0 = Math.PI / 4;
const OFFICE_YAW_SPAN = 0.55;
const OFFICE_PITCHES = [0.42, 0.98];
const OFFICE_PITCH0 = 0.62;
const OFFICE_ZOOMS = [1, 2.8];
const OFFICE_FOLLOW_ZOOM = 2.2;
const OFFICE_PLAN_MS = 1000;
const OFFICE_DRAG_PX = 4;
const OFFICE_TAG_MOVE_PX = 0.3;
const OFFICE_BANG_PX = 34;
const OFFICE_NARROW_PX = 640;
const OFFICE_WHERE = {
  pod: 'at its desk', wave: 'at its desk', ping: 'playing table tennis', coffee: 'getting a coffee', sofa: 'on the sofa',
  chat: 'chatting', board: 'at the whiteboard', wander: 'stretching its legs', home: 'gone home', leave: 'left the office',
  arcade: 'at the arcade machine', console: 'playing on the console', foos: 'playing foosball', vr: 'in VR', beanbag: 'on a bean bag',
  fish: 'watching the fish', lunch: 'having lunch in the kitchen', terrace: 'out on the terrace', hot: 'on a laptop, with no desk free', remote: 'working from home, with no desk free',
};
const OFFICE_BOSS_WORDS = { wave: 'asks you', pod: 'working', idle: 'idle' };
const office = {
  stage: null, canvas: null, tags: null, rally: null, caption: null, gl: null, frame: null, look: null, cam: null, lost: false, failed: false, broken: null,
  scene: officeScene(), agents: [], main: null, still: false, inView: true, size: { w: 0, h: 0 }, loop: null, last: 0, planAt: 0, dirty: true,
  view: { yaw: OFFICE_YAW0, pitch: OFFICE_PITCH0, zoom: 1, pan: [0, 0], follow: null, target: null, zoomNow: null },
  hover: null, focus: null, selected: null, drag: null, tagNodes: new Map(), rallySent: 0,
};

function officeReduced() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// The stage outlives every render, so the canvas, its context and the people walking about are made once and moved back in.
function officeView(d) {
  if (!officeStage()) return null;
  officeFeed(d.agents, officeMain());
  const card = officeCard();
  return el('section', { class: 'office' + (card ? ' has-card' : ''), 'data-motion': office.still ? 'still' : 'live', 'aria-label': 'The office' },
    el('div', { class: 'office-floor' }, slot('gameHud'), office.stage, officeWaiting(d.agents), officeGone(d.agents)),
    card,
    officePeople(d.agents));
}

function officeUnavailable() {
  if (office.broken) return 'The office could not draw (' + office.broken + '), so here is the list.';
  if (office.lost) return 'The office lost its drawing context, so here is the list until it is back.';
  return 'The office needs WebGL, which this browser does not offer, so here is the list.';
}

function officeStage() {
  if (office.stage) return !office.lost && !office.broken;
  if (office.failed) return false;
  const canvas = el('canvas', { class: 'office-canvas', 'aria-hidden': 'true' });
  try {
    office.gl = officeGl(canvas);
  } catch (e) {
    console.error('office', e);
  }
  if (!office.gl) {
    office.failed = true;
    return false;
  }
  officeBuildStage(canvas);
  return true;
}

function officeBuildStage(canvas) {
  office.canvas = canvas;
  office.frame = officeFrame();
  office.tags = el('div', { class: 'office-tags', 'aria-hidden': 'true', onclick: officeTagClick });
  office.rally = el('div', { class: 'office-rally', 'aria-hidden': 'true', hidden: true });
  office.caption = el('div', { class: 'office-caption', 'aria-hidden': 'true', hidden: true });
  const hint = el('div', { class: 'office-hint', 'aria-hidden': 'true' }, 'Drag to look round, scroll to zoom, double-click someone to follow them');
  office.stage = el('div', { class: 'office-stage' }, canvas, office.tags, office.rally, office.caption, hint);
  officeListen(canvas);
}

function officeListen(canvas) {
  canvas.addEventListener('pointerdown', officeDown);
  canvas.addEventListener('pointermove', officeMove);
  canvas.addEventListener('pointerup', officeUp);
  canvas.addEventListener('pointercancel', officeCancel);
  canvas.addEventListener('pointerleave', () => officeHover(null));
  canvas.addEventListener('dblclick', officeDouble);
  canvas.addEventListener('wheel', officeWheel, { passive: false });
  canvas.addEventListener('webglcontextlost', officeLost);
  canvas.addEventListener('webglcontextrestored', officeRestored);
  document.addEventListener('visibilitychange', officeWake);
  if (typeof matchMedia === 'function') matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', officeRetheme);
  if (typeof ResizeObserver === 'function') new ResizeObserver(officeResized).observe(office.stage);
  if (typeof IntersectionObserver === 'function') new IntersectionObserver(officeSeen).observe(office.stage);
}

function officeResized() {
  office.size = { w: office.stage.clientWidth, h: office.stage.clientHeight };
  officeDirty();
}

function officeSeen(entries) {
  office.inView = entries.at(-1)?.isIntersecting ?? true;
  officeWake();
}

function officeRetheme() {
  office.look = null;
  officeDirty();
}

function officeLost(e) {
  e.preventDefault();
  office.lost = true;
  render(true);
}

function officeRestored() {
  try {
    office.gl = officeGl(office.canvas);
    office.lost = !office.gl;
  } catch (e) {
    console.error('office', e);
  }
  render(true);
}

function officeMain() {
  const current = state.claude?.current;
  return { ...current, state: current?.state ?? 'done', ask: current?.ask ?? null, asking: Boolean(state.claudeCode?.asking) };
}

function officePlayer() {
  const game = state.game;
  if (!game?.on || !game.started) return null;
  return {
    handle: OFFICE_PLAYER, name: game.me, title: '', kind: 'player', player: true, prefs: OFFICE_PLAYER_PREFS, level: game.level, rank: game.title,
    state: 'done', alive: false, outcome: 'success', lastAt: Number.MAX_SAFE_INTEGER,
  };
}

function officeDress(scene) {
  const game = state.game?.on ? state.game : null;
  scene.wear = game?.equipped ?? null;
  scene.addons = Object.entries(game?.equipped?.office ?? {}).filter(([, item]) => item).map(([id]) => id).sort();
  scene.trophies = game?.trophies ?? [];
  scene.rooms = game?.rooms ?? [];
  scene.limits = state.moods ?? null;
}

function officeFeed(agents, main) {
  office.still = officeReduced();
  const player = officePlayer();
  office.agents = player ? [...agents, player] : agents;
  office.main = main;
  officeDress(office.scene);
  office.scene.clock = (typeof performance === 'object' ? performance.now() : Date.now()) / 1000;
  officeSync(office.scene, office.agents, Date.now(), { still: office.still });
  officeSyncBoss(office.scene, main, { still: office.still });
  officePetsStep(office.scene, 0, office.still);
  officePulses(office.scene);
  officeDirty();
}

function officeLevelUp() {
  if (!office.stage || office.still) return;
  office.scene.burst = (typeof performance === 'object' ? performance.now() : Date.now()) / 1000;
  officeDirty();
}

// The rally is only ever seen here, so the page tells the game its best, which unlocks a badge and pays nothing.
function officeRallyReport() {
  const best = office.scene.rally.best;
  if (best < OFFICE_RALLY_REPORTED || best <= office.rallySent || !state.game?.started) return;
  office.rallySent = best;
  api('/api/game/rally', { hits: best }).catch(() => {});
}

// A tool call shows as its agent's last word moving on, or its open conversation growing, and either flashes its screen.
function officePulses(scene) {
  for (const actor of scene.actors.values()) {
    const said = actor.agent?.lastAt || 0;
    const heard = ui.screens.get(actor.handle)?.chat?.entries?.length ?? 0;
    if ((said > actor.lastAt || heard > (actor.heard ?? heard)) && actor.role === 'pod') actor.pulse = 1;
    actor.lastAt = Math.max(actor.lastAt, said);
    actor.heard = heard;
  }
}

function officeDirty() {
  office.dirty = true;
  officeWake();
}

function officeAwake() {
  return Boolean(office.stage?.isConnected) && !document.hidden && office.inView && !office.lost && !office.broken;
}

function officeWake() {
  if (office.loop || !officeAwake() || typeof requestAnimationFrame !== 'function') return;
  if (office.still && !office.dirty) return;
  office.loop = requestAnimationFrame(officeTick);
}

function officeTick(now) {
  office.loop = null;
  if (!officeAwake()) {
    office.last = 0;
    return;
  }
  const dt = office.last ? Math.min(0.05, (now - office.last) / 1000) : 0;
  office.last = now;
  try {
    if (!office.still) officeAdvance(now, dt);
    officeDraw(now, dt);
  } catch (e) {
    return officeBroke(e);
  }
  office.dirty = false;
  if (!office.still) office.loop = requestAnimationFrame(officeTick);
}

// A frame that throws would throw again on every one after, so the page goes back to the list rather than freeze or spam.
function officeBroke(e) {
  console.error('office', e);
  office.broken = e.message;
  render(true);
}

function officeAdvance(now, dt) {
  office.scene.clock = now / 1000;
  if (now - office.planAt > OFFICE_PLAN_MS) {
    office.planAt = now;
    officeSync(office.scene, office.agents, Date.now());
  }
  officeStep(office.scene, dt);
  officePetsStep(office.scene, dt, false);
  officeRallyReport();
}

function officeDraw(now, dt) {
  if (!office.size.w) officeResized();
  const { w, h } = office.size;
  if (!w || !h) return;
  officeResize(office.gl, w, h);
  office.look ??= officeLook();
  office.cam = officeCamera(officeCamView(w / h, dt), w / h);
  const time = { t: now / 1000, wall: Date.now(), still: office.still };
  officeBuild(office.frame, office.look, office.scene, time, new Set([office.hover, office.focus, office.selected].filter(Boolean)));
  officeRender(office.gl, office.frame, office.cam, office.look);
  officeTagsPlace(w, h);
  officeRallyPlace(w, h);
}

function officeFit(L, aspect, yaw, pitch) {
  const axes = officeCamera({ yaw, pitch, zoom: 1, target: [0, 0, 0] }, 1);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const corners = [];
  for (const x of [-0.2, L.w]) for (const z of [-0.2, L.d]) for (const y of [-0.36, OFFICE_WALL_H + 0.5]) corners.push([x, y, z]);
  const xs = corners.map((c) => dot(c, axes.right));
  const ys = corners.map((c) => dot(c, axes.up));
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const hh = Math.max((y1 - y0) / 2, (x1 - x0) / 2 / aspect) * 1.04;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { hh, axes, target: axes.right.map((r, i) => r * cx + axes.up[i] * cy) };
}

function officeCamView(aspect, dt) {
  const v = office.view;
  const fit = officeFit(office.scene.layout, aspect, v.yaw, v.pitch);
  const follow = v.follow ? officeActorBy(v.follow) : null;
  if (v.follow && !follow) v.follow = null;
  const goal = follow ? [follow.x + (follow.lane ?? 0), 0.55, follow.z] : fit.target.map((t, i) => t + fit.axes.right[i] * v.pan[0] + fit.axes.up[i] * v.pan[1]);
  const k = office.still || !v.target ? 1 : Math.min(1, dt * 6);
  v.target = v.target ? v.target.map((t, i) => t + (goal[i] - t) * k) : goal;
  v.zoomNow = v.zoomNow == null ? v.zoom : v.zoomNow + (v.zoom - v.zoomNow) * k;
  v.fit = fit;
  return { yaw: v.yaw, pitch: v.pitch, zoom: fit.hh / v.zoomNow, target: v.target };
}

function officeActors() {
  return [...office.scene.actors.values(), office.scene.boss].filter(Boolean);
}

function officeActorBy(handle) {
  if (handle === OFFICE_PLAYER) return office.scene.actors.get(OFFICE_PLAYER) ?? null;
  return handle === OFFICE_MANAGER ? office.scene.boss : office.scene.actors.get(handle) ?? null;
}

function officeKindLabel(kind) {
  return OFFICE_KIND_LABELS[kind] ?? (kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Agent');
}

// A message agent's title starts with where the message came from, which is all its tag has room for.
function officeWork(a) {
  const work = a.mr ? short(a.mr) : a.ticket || (a.kind === 'message' && a.title ? a.title.split(':')[0] : a.name);
  return a.raisedMr && a.raisedMr !== a.mr ? work + ' · ' + short(a.raisedMr) : work;
}

// The tag's colour already says its kind, so the kind is spelt out only on hover and to screen readers.
function officeTagText(a, { kind = false, phase = true } = {}) {
  if (a.player) return a.name + ' · Lv ' + a.level + ' ' + a.rank;
  return [kind ? officeKindLabel(a.kind) : null, officeWork(a), phase ? slot('agentPhase', a) : null].filter(Boolean).join(' · ');
}

// A phone has no room for every tag, so only the ones asking or picked out are shown there.
function officeTagsPlace(w, h) {
  const narrow = w < OFFICE_NARROW_PX;
  const live = officeActors().map((actor) => ({ actor, tag: officeTagFor(actor), at: officeProject(office.cam, officeHeadAt(actor), w, h), quiet: narrow && officeTagRank(actor) > 1 }));
  officeUnstack(live.filter((item) => !item.quiet).sort((a, b) => officeTagRank(a.actor) - officeTagRank(b.actor) || b.at.y - a.at.y));
  for (const { actor, tag, at, lift = 0, quiet } of live) officeTagPlace(tag, actor, at, lift, quiet, w);
  officeTagsPrune(new Set(live.map(({ actor }) => actor.handle)));
}

function officeTagsPrune(handles) {
  for (const [handle, tag] of office.tagNodes) {
    if (handles.has(handle)) continue;
    tag.node.remove();
    office.tagNodes.delete(handle);
  }
}

function officeTagRank(actor) {
  if ([office.hover, office.focus, office.selected].includes(actor.handle)) return 0;
  if (actor.agent?.player) return 1;
  return actor.role === 'wave' ? 1 : actor.role === 'pod' ? 2 : 3;
}

// Tags are laid down most important first, and one that would cover another climbs above it rather than hide it.
function officeUnstack(items) {
  const placed = [];
  for (const item of items) {
    const size = officeTagSize(item.tag);
    const grow = officeTagRank(item.actor) === 0 ? 1.3 : 1;
    const box = { x: item.at.x, w: size.w * grow, h: size.h * grow + (item.actor.role === 'wave' ? 30 : 0) };
    const bottom = officeClimb(placed, box, item.at.y);
    item.lift = bottom - item.at.y;
    placed.push({ ...box, top: bottom - box.h, bottom });
  }
}

function officeClimb(placed, box, bottom) {
  for (let tries = 0; tries < 8; tries++) {
    const hit = placed.find((r) => Math.abs(r.x - box.x) < (r.w + box.w) / 2 + 3 && bottom > r.top - 1 && bottom - box.h < r.bottom + 1);
    if (!hit) break;
    bottom = hit.top - 2;
  }
  return bottom;
}

// A tag measured before the stage is laid out reads as nothing, so only a real size is kept.
function officeTagSize(tag) {
  if (tag.sizedFor === tag.text) return tag.size;
  const w = tag.node.offsetWidth;
  if (w) Object.assign(tag, { size: { w, h: tag.node.offsetHeight }, sizedFor: tag.text });
  return w ? tag.size : { w: 120, h: 18 };
}

function officeTagFor(actor) {
  let tag = office.tagNodes.get(actor.handle);
  const text = actor.manager ? 'Claude · manager' : officeTagText(actor.agent, { kind: officeTagRank(actor) === 0 });
  if (!tag) {
    const node = el('div', { class: 'office-tag', 'data-handle': actor.handle, 'data-kind': officeKindOf(actor) ?? '' },
      el('div', { class: 'office-chip' }, el('span', { class: 'office-dot' }), el('span', { class: 'office-name' })));
    tag = { node, x: null, y: null, text: null, cls: null, lift: 0 };
    office.tagNodes.set(actor.handle, tag);
    office.tags.append(node);
  }
  if (tag.text !== text) tag.node.querySelector('.office-name').textContent = tag.text = text;
  return tag;
}

function officeTagClass(actor, quiet) {
  const mood = actor.mood?.mood;
  const marks = { 'is-asking': actor.role === 'wave', 'is-working': actor.role === 'pod', 'is-out': quiet || actor.x < 0.35,
    'is-impatient': mood === 'impatient', 'is-grumpy': mood === 'grumpy', 'is-angry': mood === 'angry',
    'is-hover': office.hover === actor.handle, 'is-focus': office.focus === actor.handle, 'is-selected': office.selected === actor.handle };
  return ['office-tag', ...Object.keys(marks).filter((k) => marks[k])].join(' ');
}

// A big floor on a small screen puts the back row's tags near the edge, so each is kept inside the stage, bubble and all.
function officeTagPlace(tag, actor, at, lift, quiet, width = Infinity) {
  const asking = actor.role === 'wave';
  const cls = officeTagClass(actor, quiet);
  if (cls !== tag.cls) {
    tag.node.className = tag.cls = cls;
    officeBang(tag.node, asking);
  }
  tag.lift = office.still ? lift : tag.lift + (lift - tag.lift) * 0.25;
  const size = officeTagSize(tag);
  const y = Math.max(at.y + tag.lift, size.h + (asking ? OFFICE_BANG_PX : 4));
  const x = Math.min(Math.max(at.x, size.w / 2 + 4), Math.max(size.w / 2 + 4, width - size.w / 2 - 4));
  if (tag.x != null && Math.abs(x - tag.x) < OFFICE_TAG_MOVE_PX && Math.abs(y - tag.y) < OFFICE_TAG_MOVE_PX) return;
  Object.assign(tag, { x, y });
  tag.node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
  tag.node.style.zIndex = String(Math.round(at.y) + (asking ? 10000 : 0));
}

function officeBang(node, asking) {
  const bang = node.querySelector('.office-bang');
  if (asking && !bang) node.querySelector('.office-chip').append(el('b', { class: 'office-bang' }, '!'));
  if (!asking) bang?.remove();
}

function officeRallyPlace(w, h) {
  const rally = office.scene.rally;
  office.rally.hidden = !rally.playing;
  if (!rally.playing) return;
  const t = office.scene.layout.table;
  const p = officeProject(office.cam, [t.x, 1.6, t.z], w, h);
  const text = 'Rally ' + rally.count + (rally.best ? ' · best ' + rally.best : '');
  if (office.rally.textContent !== text) office.rally.textContent = text;
  office.rally.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
}

function officePoint(e) {
  return { x: e.offsetX, y: e.offsetY };
}

function officeSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
}

// Nearest to the camera wins, so someone standing in front of a desk is picked over the one sitting behind it.
function officePick(p) {
  const cam = office.cam;
  if (!cam) return null;
  const { w, h } = office.size;
  const unit = h / (2 * cam.hh);
  let best = null;
  for (const actor of officeActors()) {
    const x = actor.x + (actor.lane ?? 0);
    const far = officeSegment(p, officeProject(cam, [x, 0.12, actor.z], w, h), officeProject(cam, [x, 1.05, actor.z], w, h));
    const depth = x * cam.back[0] + actor.z * cam.back[2];
    if (far < 0.3 * unit && (!best || depth > best.depth)) best = { handle: actor.handle, depth };
  }
  return best?.handle ?? officePodOwner(officeUnproject(cam, p.x, p.y, w, h, OFFICE_DESK.h));
}

function officePodOwner(p) {
  const L = office.scene.layout;
  const b = L.boss;
  if (Math.abs(p.x - b.x) < b.w / 2 + 0.2 && p.z > b.z - b.dd / 2 && p.z < b.z + 1.2) return OFFICE_MANAGER;
  const pod = L.pods.find((q) => Math.abs(p.x - q.x) < OFFICE_POD_PITCH / 2 && p.z > q.z - OFFICE_DESK.d / 2 && p.z < q.z + 1.1);
  if (!pod) return null;
  return [...office.scene.actors.values()].find((a) => a.spot === 'pod:' + pod.i || a.spot === 'stand:' + pod.i)?.handle ?? null;
}

function officeDown(e) {
  office.drag = { x: e.clientX, y: e.clientY, yaw: office.view.yaw, pitch: office.view.pitch, moved: false, id: e.pointerId };
  office.canvas.setPointerCapture?.(e.pointerId);
}

function officeMove(e) {
  const drag = office.drag;
  if (!drag) return officeHover(officePick(officePoint(e)));
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < OFFICE_DRAG_PX) return;
  drag.moved = true;
  office.canvas.classList.add('is-dragging');
  office.view.yaw = Math.max(OFFICE_YAW0 - OFFICE_YAW_SPAN, Math.min(OFFICE_YAW0 + OFFICE_YAW_SPAN, drag.yaw - dx * 0.006));
  office.view.pitch = Math.max(OFFICE_PITCHES[0], Math.min(OFFICE_PITCHES[1], drag.pitch + dy * 0.004));
  officeDirty();
}

function officeCancel(e) {
  office.drag = null;
  office.canvas.classList.remove('is-dragging');
  office.canvas.releasePointerCapture?.(e.pointerId);
}

function officeUp(e) {
  const drag = office.drag;
  officeCancel(e);
  if (!drag || drag.moved) return;
  const handle = officePick(officePoint(e));
  if (handle) officeSelect(handle);
  else if (office.selected) officeClose();
}

function officeHover(handle) {
  if (office.hover === handle) return;
  office.hover = handle;
  office.canvas?.classList.toggle('is-pointing', Boolean(handle));
  officeDirty();
}

function officeDouble(e) {
  const handle = officePick(officePoint(e));
  const v = office.view;
  Object.assign(v, handle ? { follow: handle, zoom: Math.max(v.zoom, OFFICE_FOLLOW_ZOOM) } : { follow: null, pan: [0, 0], zoom: 1, yaw: OFFICE_YAW0, pitch: OFFICE_PITCH0 });
  officeDirty();
}

// Zooming keeps the point under the pointer where it is, and a wheel at either limit scrolls the page as usual.
function officeWheel(e) {
  const v = office.view;
  const next = Math.max(OFFICE_ZOOMS[0], Math.min(OFFICE_ZOOMS[1], v.zoom * Math.exp(-e.deltaY * 0.0015)));
  if (next === v.zoom || !v.fit) return;
  e.preventDefault();
  const { w, h } = office.size;
  const nx = (e.offsetX / w) * 2 - 1;
  const ny = 1 - (e.offsetY / h) * 2;
  const hh = v.fit.hh;
  const shift = hh / v.zoom - hh / next;
  v.pan = [v.pan[0] + nx * shift * (w / h), v.pan[1] + ny * shift];
  const room = (hh * (1 - 1 / next));
  v.pan = [Math.max(-room * (w / h), Math.min(room * (w / h), v.pan[0])), Math.max(-room, Math.min(room, v.pan[1]))];
  v.zoom = next;
  officeDirty();
}

function officeTagClick(e) {
  const tag = e.target.closest?.('.office-tag');
  if (tag) officeSelect(tag.dataset.handle);
}

function officeOpen(handle) {
  office.selected = handle;
}

function officeLetGo(handle) {
  if (office.selected === handle) office.selected = null;
}

const officeHasCard = (handle) => handle === OFFICE_MANAGER || handle === OFFICE_PLAYER;

function officeSelect(handle, fromKeys = false) {
  if (!officeHasCard(handle)) return slot('agentWinOpen', handle);
  office.selected = handle;
  render(true);
  if (fromKeys) document.getElementById('office-card')?.focus({ preventScroll: true });
}

function officeCardOpen() {
  return Boolean(office.selected) && view() === 'agents' && Boolean(document.getElementById('office-card'));
}

function officeClose() {
  const was = office.selected;
  if (!officeHasCard(was)) return slot('agentWinClose');
  office.selected = null;
  render(true);
  document.getElementById('office-who-' + was)?.focus({ preventScroll: true });
}

function officeFocus(handle) {
  office.focus = handle;
  const actor = handle ? officeActorBy(handle) : null;
  office.caption.hidden = !actor;
  office.caption.textContent = actor ? (actor.manager ? 'Claude, the manager' : officeTagText(actor.agent, { kind: true })) + (actor.agent?.player ? '. Enter opens your profile.' : actor.manager ? '. Enter opens its card.' : '. Enter opens its window.') : '';
  officeDirty();
}

function officeSince(a) {
  return a.since ? 'since ' + ago(a.since) : '';
}

function officeCard() {
  if (office.selected === OFFICE_MANAGER) return officeBossCard();
  if (office.selected === OFFICE_PLAYER) return officePlayerCard();
  return null;
}

function officeCardHead(kind, label, name) {
  return el('div', { class: 'office-card-head' },
    el('span', { class: 'office-kind', 'data-kind': kind ?? '' }, label),
    el('h2', {}, name),
    el('button', { class: 'icon-only', id: 'office-card-close', type: 'button', title: 'Close the card', 'aria-label': 'Close the card', onclick: officeClose }, icon('x')));
}

function officePlayerCard() {
  const game = state.game;
  if (!game?.on || !game.started) {
    office.selected = null;
    return null;
  }
  return el('aside', { class: 'office-card', id: 'office-card', tabindex: '-1', 'aria-label': game.me + ', your profile' },
    officeCardHead('player', 'You', game.me),
    slot('gameProfileCard'));
}

function officeBossCard() {
  const main = office.main ?? {};
  const role = officeBossRole(main);
  const inApp = Boolean(slot('claudeCodeHere'));
  const ask = main.ask;
  const asked = ask ? (ask.questions ? ask.questions.map((q) => q.question).join(' ') : slot('agentAskWords', ask)) : main.asking ? 'It is asking you something in Claude Code.' : null;
  return el('aside', { class: 'office-card', id: 'office-card', tabindex: '-1', 'aria-label': 'Claude, the manager' },
    officeCardHead('manager', 'Manager', 'Claude'),
    el('div', { class: 'row-head' }, el('span', { class: 'pill ' + (role === 'wave' ? 's-need' : role === 'pod' ? 's-working' : 's-done') }, OFFICE_BOSS_WORDS[role]), el('span', { class: 'meta' }, officeSince(main))),
    el('p', { class: 'office-said' }, main.title || 'The main Claude session, the one in the Claude panel.'),
    asked ? el('div', { class: 'ask' }, el('p', { class: 'asked' }, icon('bell'), asked)) : null,
    el('div', { class: 'actions' }, button(inApp ? 'Open Claude Code' : 'Open the Claude panel', inApp ? 'terminal' : 'message', () => slot(inApp ? 'openClaudeCode' : 'openClaudePanel'), true)));
}

const OFFICE_ROSTER_ORDER = ['wave', 'pod', 'idle', 'home', 'leave'];

function officeRoster(agents) {
  const places = office.scene.plan?.places ?? new Map();
  const where = (a) => places.get(a.handle) ?? { role: 'home' };
  const rank = (a) => OFFICE_ROSTER_ORDER.indexOf(where(a).role);
  return [...agents].sort((a, b) => rank(a) - rank(b)).map((a) => {
    const place = where(a);
    const doing = OFFICE_WHERE[place.activity] ?? OFFICE_WHERE[place.role];
    const phase = slot('agentPhaseBeside', a);
    const state = slot('agentLabel', a) + (phase ? ', ' + phase.charAt(0).toLowerCase() + phase.slice(1) : '');
    return { handle: a.handle, role: place.role, label: officeTagText(a, { kind: true, phase: false }) + ', ' + state + ', ' + doing + officeMoodSaid(office.scene.actors.get(a.handle)?.mood ?? slot('agentMood', a)) };
  });
}

function officePeople(agents) {
  const roster = officeRoster(agents);
  const main = { handle: OFFICE_MANAGER, label: 'Claude, the manager, ' + OFFICE_BOSS_WORDS[officeBossRole(office.main)] + ', at the big desk' + officeMoodSaid(office.scene.boss?.mood) };
  const you = officePlayerWho();
  return el('ul', { class: 'office-people', 'aria-label': 'Who is in the office' }, [...roster, main, ...you].map(({ handle, label }) => el('li', {},
    el('button', { type: 'button', id: 'office-who-' + handle, class: 'office-who', 'aria-pressed': String(office.selected === handle), onfocus: () => officeFocus(handle), onblur: () => officeFocus(null), onclick: () => officeSelect(handle, true) }, label))));
}

function officePlayerWho() {
  const player = office.agents.find((a) => a.player);
  if (!player) return [];
  const place = office.scene.plan?.places?.get(OFFICE_PLAYER);
  return [{ handle: OFFICE_PLAYER, label: 'You, ' + player.name + ', level ' + player.level + ' ' + player.rank + ', ' + (OFFICE_WHERE[place?.activity] ?? 'in the lounge').replace('its legs', 'your legs') }];
}

function officeMoodSaid(mood) {
  const words = mood ? moodWords(mood) : '';
  return words ? ', ' + words.charAt(0).toLowerCase() + words.slice(1) : '';
}

function officeWaiting(agents) {
  const places = office.scene.plan?.places ?? new Map();
  const asking = agents.filter((a) => places.get(a.handle)?.role === 'wave').map((a) => [a.handle, officeTagText(a, { kind: true, phase: false })]);
  if (officeBossRole(office.main) === 'wave') asking.push([OFFICE_MANAGER, 'Claude · manager']);
  if (!asking.length) return null;
  const moodOfChip = (handle) => officeActorBy(handle)?.mood?.mood ?? '';
  return el('div', { class: 'office-strip office-waiting', 'aria-hidden': 'true' }, el('span', {}, icon('bell'), 'Waiting on you'),
    asking.map(([handle, text]) => el('button', { type: 'button', class: 'chip', 'data-mood': moodOfChip(handle), tabindex: '-1', onclick: () => officeSelect(handle) }, text)));
}

function officeGone(agents) {
  const places = office.scene.plan?.places ?? new Map();
  const gone = agents.filter((a) => ['home', 'leave'].includes(places.get(a.handle)?.role)).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  if (!gone.length) return null;
  return el('div', { class: 'office-strip', 'aria-hidden': 'true' }, el('span', {}, 'Off the floor'),
    gone.slice(0, 8).map((a) => el('button', { type: 'button', class: 'chip', tabindex: '-1', title: a.name, onclick: () => officeSelect(a.handle) }, officeTagText(a, { kind: true, phase: false }))),
    gone.length > 8 ? el('span', {}, 'and ' + (gone.length - 8) + ' more in the list') : null);
}

function officeSummary(agents) {
  const places = office.scene.plan?.places;
  const count = (role) => agents.filter((a) => places?.get(a.handle)?.role === role).length;
  return [plural(count('pod'), 'agent') + ' at work', count('wave') + ' waiting on you', count('idle') + ' in the lounge'].join(', ') + '.';
}
