const OFFICE_DPR_MAX = 1.5;
const OFFICE_SOLID_STRIDE = 20;
const OFFICE_DECAL_STRIDE = 17;
const OFFICE_FAR = 400;

const OFFICE_SOLID_VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec4 aM0;
in vec4 aM1;
in vec4 aM2;
in vec4 aM3;
in vec4 aTint;
uniform mat4 uViewProj;
out vec3 vNormal;
out vec3 vWorld;
out vec4 vTint;
void main() {
  mat4 m = mat4(aM0, aM1, aM2, aM3);
  mat3 r = mat3(m);
  vec4 world = m * vec4(aPos, 1.0);
  vNormal = r * (aNormal / vec3(dot(r[0], r[0]), dot(r[1], r[1]), dot(r[2], r[2])));
  vWorld = world.xyz;
  vTint = aTint;
  gl_Position = uViewProj * world;
}`;

const OFFICE_SOLID_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec4 vTint;
uniform vec3 uSun;
uniform vec3 uSunColour;
uniform vec3 uSky;
uniform vec3 uGround;
uniform vec3 uView;
out vec4 outColour;
void main() {
  vec3 n = normalize(vNormal);
  float sun = max(dot(n, uSun), 0.0);
  vec3 ambient = mix(uGround, uSky, n.y * 0.5 + 0.5);
  float contact = mix(mix(0.55, 1.0, clamp(vWorld.y / 0.32, 0.0, 1.0)), 1.0, max(n.y, 0.0));
  float rim = pow(1.0 - clamp(dot(n, uView), 0.0, 1.0), 4.0) * 0.18;
  float metal = clamp(-vTint.a, 0.0, 1.0);
  float shine = pow(max(dot(n, normalize(uSun + uView)), 0.0), 40.0) * metal * 1.6;
  vec3 lit = vTint.rgb * (ambient + uSunColour * sun * (1.0 - metal * 0.4)) * contact + uSky * rim * (1.0 + metal * 3.0) + (uSunColour + 0.2) * shine;
  vec3 colour = mix(lit, vTint.rgb * 1.25 + 0.04, clamp(vTint.a, 0.0, 1.0));
  outColour = vec4(pow(colour, vec3(1.0 / 2.2)), 1.0);
}`;

const OFFICE_DECAL_VS = `#version 300 es
in vec2 aCorner;
in vec3 aCentre;
in vec3 aU;
in vec3 aV;
in vec4 aColour;
in vec4 aShape;
uniform mat4 uViewProj;
out vec2 vUv;
out vec4 vColour;
out vec4 vShape;
void main() {
  vUv = aCorner;
  vColour = aColour;
  vShape = aShape;
  gl_Position = uViewProj * vec4(aCentre + aU * aCorner.x + aV * aCorner.y, 1.0);
}`;

const OFFICE_DECAL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColour;
in vec4 vShape;
out vec4 outColour;
float roundRect(vec2 p, vec2 extent, float r) {
  vec2 q = abs(p) - extent + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
void main() {
  float kind = vShape.x;
  float soft = vShape.y;
  vec2 p = vUv * vec2(vShape.w, 1.0);
  float a;
  if (kind < 0.5) a = 1.0 - smoothstep(-soft, 0.0, roundRect(p, vec2(vShape.w, 1.0), vShape.z));
  else if (kind < 1.5) a = 1.0 - smoothstep(0.0, soft, abs(length(vUv) - vShape.z));
  else if (kind < 2.5) a = pow(clamp(1.0 - length(vUv), 0.0, 1.0), 2.0);
  else a = 1.0 - smoothstep(-0.02, 0.0, roundRect(p, vec2(vShape.w, 1.0), vShape.z));
  a *= vColour.a;
  float add = step(3.5, kind) + step(0.5, kind) * step(kind, 2.5);
  outColour = vec4(vColour.rgb * a, a * (1.0 - add));
}`;

function officeGl(canvas) {
  const gl = canvas.getContext?.('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'low-power' });
  if (!gl) return null;
  const solid = officeProgram(gl, OFFICE_SOLID_VS, OFFICE_SOLID_FS, ['aPos', 'aNormal', 'aM0', 'aM1', 'aM2', 'aM3', 'aTint'], ['uViewProj', 'uSun', 'uSunColour', 'uSky', 'uGround', 'uView']);
  const decal = officeProgram(gl, OFFICE_DECAL_VS, OFFICE_DECAL_FS, ['aCorner', 'aCentre', 'aU', 'aV', 'aColour', 'aShape'], ['uViewProj']);
  const meshes = Object.fromEntries(Object.entries(OFFICE_SHAPES).map(([name, make]) => [name, officeSolidVao(gl, make())]));
  return { gl, solid, decal, meshes, quad: officeDecalVao(gl), canvas, w: 0, h: 0 };
}

// Attributes take their slots in the order named, which is the order the vertex arrays below fill them.
function officeProgram(gl, vs, fs, attributes, names) {
  const program = gl.createProgram();
  attributes.forEach((name, i) => gl.bindAttribLocation(program, i, name));
  for (const [type, source] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('office shader: ' + gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('office program: ' + gl.getProgramInfoLog(program));
  return { program, at: Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)])) };
}

function officeSolidVao(gl, { positions, normals, indices }) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  officeAttrib(gl, new Float32Array(positions), 0, 3);
  officeAttrib(gl, new Float32Array(normals), 1, 3);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
  const instances = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  for (let i = 0; i < 5; i++) officeInstanced(gl, 2 + i, 4, OFFICE_SOLID_STRIDE, i * 4);
  gl.bindVertexArray(null);
  return { vao, instances, count: indices.length, capacity: 0 };
}

function officeDecalVao(gl) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  officeAttrib(gl, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), 0, 2);
  const instances = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  [[1, 3, 0], [2, 3, 3], [3, 3, 6], [4, 4, 9], [5, 4, 13]].forEach(([loc, size, at]) => officeInstanced(gl, loc, size, OFFICE_DECAL_STRIDE, at));
  gl.bindVertexArray(null);
  return { vao, instances, capacity: 0 };
}

function officeAttrib(gl, data, loc, size) {
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
}

function officeInstanced(gl, loc, size, stride, at) {
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, at * 4);
  gl.vertexAttribDivisor(loc, 1);
}

function officeResize(r, width, height) {
  const dpr = Math.min(window.devicePixelRatio || 1, OFFICE_DPR_MAX);
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  if (w === r.w && h === r.h) return;
  Object.assign(r, { w, h });
  r.canvas.width = w;
  r.canvas.height = h;
}

function officeRender(r, frame, cam, look) {
  const { gl } = r;
  gl.viewport(0, 0, r.w, r.h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.disable(gl.BLEND);
  gl.depthMask(true);
  officeDrawSolids(r, frame, cam, look);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.depthMask(false);
  gl.enable(gl.POLYGON_OFFSET_FILL);
  gl.polygonOffset(-2, -2);
  officeDrawDecals(r, frame.floor, cam);
  gl.disable(gl.POLYGON_OFFSET_FILL);
  officeDrawDecals(r, frame.glow, cam);
  gl.depthMask(true);
}

function officeDrawSolids(r, frame, cam, look) {
  const { gl, solid } = r;
  gl.useProgram(solid.program);
  gl.uniformMatrix4fv(solid.at.uViewProj, false, cam.viewProj);
  gl.uniform3fv(solid.at.uSun, look.sun);
  gl.uniform3fv(solid.at.uSunColour, look.sunColour);
  gl.uniform3fv(solid.at.uSky, look.sky);
  gl.uniform3fv(solid.at.uGround, look.ground);
  gl.uniform3fv(solid.at.uView, cam.back);
  for (const [name, mesh] of Object.entries(r.meshes)) {
    const batch = frame.solids[name];
    if (!batch?.n) continue;
    gl.bindVertexArray(mesh.vao);
    officeUpload(gl, mesh, batch);
    gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, batch.n);
  }
  gl.bindVertexArray(null);
}

function officeDrawDecals(r, batch, cam) {
  if (!batch.n) return;
  const { gl, decal, quad } = r;
  gl.useProgram(decal.program);
  gl.uniformMatrix4fv(decal.at.uViewProj, false, cam.viewProj);
  gl.bindVertexArray(quad.vao);
  officeUpload(gl, quad, batch);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, batch.n);
  gl.bindVertexArray(null);
}

// The buffer only grows, so a frame with fewer instances than the last reuses it in place.
function officeUpload(gl, holder, batch) {
  const used = batch.data.subarray(0, batch.n * batch.stride);
  gl.bindBuffer(gl.ARRAY_BUFFER, holder.instances);
  if (used.length > holder.capacity) {
    holder.capacity = batch.data.length;
    gl.bufferData(gl.ARRAY_BUFFER, batch.data.byteLength, gl.DYNAMIC_DRAW);
  }
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, used);
}

function officeBatch(stride) {
  return { stride, data: new Float32Array(stride * 128), n: 0 };
}

function officeSlot(batch) {
  if ((batch.n + 1) * batch.stride > batch.data.length) {
    const grown = new Float32Array(batch.data.length * 2);
    grown.set(batch.data);
    batch.data = grown;
  }
  return batch.n++ * batch.stride;
}

function officeFrame() {
  return { solids: Object.fromEntries(Object.keys(OFFICE_SHAPES).map((name) => [name, officeBatch(OFFICE_SOLID_STRIDE)])), floor: officeBatch(OFFICE_DECAL_STRIDE), glow: officeBatch(OFFICE_DECAL_STRIDE) };
}

function officeClearFrame(frame) {
  for (const batch of Object.values(frame.solids)) batch.n = 0;
  frame.floor.n = 0;
  frame.glow.n = 0;
}

function officeSolid(frame, mesh, m, rgb, glow = 0) {
  const batch = frame.solids[mesh];
  const at = officeSlot(batch);
  batch.data.set(m, at);
  batch.data[at + 16] = rgb[0];
  batch.data[at + 17] = rgb[1];
  batch.data[at + 18] = rgb[2];
  batch.data[at + 19] = glow;
}

function officeDecal(batch, centre, u, v, rgba, shape) {
  const at = officeSlot(batch);
  const d = batch.data;
  d.set(centre, at);
  d.set(u, at + 3);
  d.set(v, at + 6);
  d.set(rgba, at + 9);
  d.set(shape, at + 13);
}

function officeM4() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

// Yaw, then pitch, then roll, then scale, so a limb swings in the frame of the body it hangs from.
function officePose(out, x, y, z, yaw = 0, pitch = 0, roll = 0, sx = 1, sy = 1, sz = 1) {
  const cy = Math.cos(yaw), sy0 = Math.sin(yaw), cx = Math.cos(pitch), sx0 = Math.sin(pitch), cz = Math.cos(roll), sz0 = Math.sin(roll);
  const r00 = cy * cz + sy0 * sx0 * sz0, r01 = -cy * sz0 + sy0 * sx0 * cz, r02 = sy0 * cx;
  const r10 = cx * sz0, r11 = cx * cz, r12 = -sx0;
  const r20 = -sy0 * cz + cy * sx0 * sz0, r21 = sy0 * sz0 + cy * sx0 * cz, r22 = cy * cx;
  out[0] = r00 * sx; out[1] = r10 * sx; out[2] = r20 * sx; out[3] = 0;
  out[4] = r01 * sy; out[5] = r11 * sy; out[6] = r21 * sy; out[7] = 0;
  out[8] = r02 * sz; out[9] = r12 * sz; out[10] = r22 * sz; out[11] = 0;
  out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
  return out;
}

function officeMul(out, a, b) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
    for (let r = 0; r < 4; r++) out[c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
  }
  return out;
}

function officeCamera(view, aspect) {
  const { yaw, pitch, zoom, target } = view;
  const back = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [-Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch), -Math.sin(pitch) * Math.cos(yaw)];
  const eye = target.map((t, i) => t + back[i] * OFFICE_FAR / 2);
  const hh = zoom;
  const hw = zoom * aspect;
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const k = 2 / OFFICE_FAR;
  const m = new Float32Array(16);
  [right.map((v) => v / hw), up.map((v) => v / hh), back.map((v) => -k * v)].forEach((row, r) => row.forEach((v, c) => { m[c * 4 + r] = v; }));
  m[12] = -dot(right, eye) / hw;
  m[13] = -dot(up, eye) / hh;
  m[14] = k * dot(back, eye) - 1;
  m[15] = 1;
  return { viewProj: m, back, right, up, eye, hw, hh };
}

function officeProject(cam, p, width, height) {
  const m = cam.viewProj;
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  return { x: (x * 0.5 + 0.5) * width, y: (0.5 - y * 0.5) * height };
}

// A click is a ray straight into the room, since the camera is orthographic, met with the plane at the height asked for.
function officeUnproject(cam, sx, sy, width, height, planeY) {
  const nx = (sx / width) * 2 - 1;
  const ny = 1 - (sy / height) * 2;
  const o = cam.eye.map((e, i) => e + cam.right[i] * nx * cam.hw + cam.up[i] * ny * cam.hh);
  const t = (o[1] - planeY) / cam.back[1];
  return { x: o[0] - cam.back[0] * t, z: o[2] - cam.back[2] * t };
}

const OFFICE_SHAPES = {
  box: officeBoxShape,
  cyl: () => officeCylShape(18),
  ball: () => officeSphereShape(16, 12, false),
  gem: () => officeSphereShape(7, 5, true),
  pill: () => officeCapsuleShape(0.3, 14, 10),
  limb: () => officeCapsuleShape(1, 8, 6),
  cone: () => officeConeShape(14),
};

function officeBoxShape() {
  const positions = [];
  const normals = [];
  const indices = [];
  const faces = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
  for (const [axis, sign] of faces) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 0, 0];
      p[axis] = 0.5 * sign;
      p[u] = 0.5 * a * sign;
      p[v] = 0.5 * b;
      positions.push(...p);
      const n = [0, 0, 0];
      n[axis] = sign;
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices };
}

function officeCylShape(seg) {
  const positions = [];
  const normals = [];
  const indices = [];
  const ring = (i) => [Math.cos((i / seg) * Math.PI * 2), Math.sin((i / seg) * Math.PI * 2)];
  for (let i = 0; i <= seg; i++) {
    const [c, s] = ring(i);
    positions.push(c * 0.5, -0.5, s * 0.5, c * 0.5, 0.5, s * 0.5);
    normals.push(c, 0, s, c, 0, s);
  }
  for (let i = 0; i < seg; i++) indices.push(i * 2, i * 2 + 1, i * 2 + 3, i * 2, i * 2 + 3, i * 2 + 2);
  for (const y of [-0.5, 0.5]) {
    const centre = positions.length / 3;
    positions.push(0, y, 0);
    normals.push(0, Math.sign(y), 0);
    for (let i = 0; i <= seg; i++) {
      const [c, s] = ring(i);
      positions.push(c * 0.5, y, s * 0.5);
      normals.push(0, Math.sign(y), 0);
    }
    for (let i = 0; i < seg; i++) indices.push(...(y > 0 ? [centre, centre + i + 2, centre + i + 1] : [centre, centre + i + 1, centre + i + 2]));
  }
  return { positions, normals, indices };
}

function officeSphereShape(seg, rings, faceted) {
  const grid = [];
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      grid.push([Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)]);
    }
  }
  const tris = [];
  for (let r = 0; r < rings; r++) {
    for (let i = 0; i < seg; i++) {
      const a = r * (seg + 1) + i;
      const b = a + seg + 1;
      if (r) tris.push([a, a + 1, b]);
      if (r < rings - 1) tris.push([a + 1, b + 1, b]);
    }
  }
  return faceted ? officeFacets(grid, tris, 0.5) : officeSmoothShape(grid, tris, 0.5);
}

function officeCapsuleShape(halfLength, seg, rings) {
  const grid = [];
  const half = rings / 2;
  for (let r = 0; r <= rings + 1; r++) {
    const cap = r <= half ? r : r - 1;
    const phi = (cap / rings) * Math.PI;
    const lift = r <= half ? halfLength : -halfLength;
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      grid.push([Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th), lift]);
    }
  }
  const tris = [];
  for (let r = 0; r <= rings; r++) {
    for (let i = 0; i < seg; i++) {
      const a = r * (seg + 1) + i;
      const b = a + seg + 1;
      tris.push([a, a + 1, b], [a + 1, b + 1, b]);
    }
  }
  const positions = grid.flatMap(([x, y, z, lift]) => [x * 0.5, y * 0.5 + lift, z * 0.5]);
  const normals = grid.flatMap(([x, y, z]) => [x, y, z]);
  return { positions, normals, indices: tris.flat() };
}

function officeConeShape(seg) {
  const grid = [[0, 1, 0], ...Array.from({ length: seg }, (_, i) => [Math.cos((i / seg) * Math.PI * 2), -1, Math.sin((i / seg) * Math.PI * 2)]), [0, -1, 0]];
  const tris = [];
  for (let i = 0; i < seg; i++) tris.push([0, 1 + ((i + 1) % seg), 1 + i], [seg + 1, 1 + i, 1 + ((i + 1) % seg)]);
  return officeFacets(grid.map(([x, y, z]) => [x, y, z]), tris, 0.5);
}

function officeSmoothShape(grid, tris, scale) {
  return { positions: grid.flatMap((p) => p.map((v) => v * scale)), normals: grid.flat(), indices: tris.flat() };
}

function officeFacets(grid, tris, scale) {
  const positions = [];
  const normals = [];
  for (const [a, b, c] of tris) {
    const [pa, pb, pc] = [grid[a], grid[b], grid[c]];
    const e1 = pb.map((v, i) => v - pa[i]);
    const e2 = pc.map((v, i) => v - pa[i]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(...n) || 1;
    for (const p of [pa, pb, pc]) {
      positions.push(...p.map((v) => v * scale));
      normals.push(...n.map((v) => v / len));
    }
  }
  return { positions, normals, indices: Array.from({ length: positions.length / 3 }, (_, i) => i) };
}
