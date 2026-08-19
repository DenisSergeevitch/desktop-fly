// brain.js — port of BrainView.swift: live visualization of the real FlyWire
// v783 brain. 23k real soma positions as a rotating point cloud, the escape
// circuit highlighted, LIF spikes flashing at real neuron locations, and
// click-to-stimulate.
//
// The sim itself lives in the overlay renderer; spikes arrive over IPC and
// stimulation requests go back the same way.

// relative rather than bare so the same module resolves in Node (tests)
// and in the renderer without an inline importmap
import * as THREE from '../node_modules/three/build/three.module.js';

const api = window.flyAPI;
const labelEl = document.getElementById('label');

// super_class palette (index order from etl.py)
const CLASS_COLORS = [
  [0.16, 0.22, 0.34],   // optic — dim blue (majority, keep subtle)
  [0.45, 0.33, 0.16],   // central — amber
  [0.14, 0.36, 0.34],   // sensory — teal
  [0.10, 0.48, 0.62],   // visual_projection — cyan
  [0.38, 0.22, 0.55],   // visual_centrifugal — violet
  [0.62, 0.28, 0.10],   // descending — orange
  [0.20, 0.45, 0.18],   // ascending — green
  [0.55, 0.14, 0.14],   // motor — red
  [0.50, 0.25, 0.40],   // endocrine — pink
];

const ROLE_COLORS = {
  lc4: [0.15, 0.85, 1.0], lplc2: [0.15, 0.85, 1.0],
  dna01: [1.0, 0.55, 0.10], dna02: [1.0, 0.55, 0.10],
  mdn: [1.0, 0.20, 0.80],
  dnp09: [0.25, 1.0, 0.35],
  dng11: [0.75, 0.55, 1.0],
  escw: [1.0, 0.35, 0.25],
  gf: [1.0, 0.95, 0.4],
};

function pointCloud(positions, colors, size) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const m = new THREE.PointsMaterial({
    size,
    sizeAttenuation: true,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
  });
  return new THREE.Points(g, m);
}

const scene = new THREE.Scene();
scene.background = new THREE.Color().setRGB(0.03, 0.035, 0.06, THREE.SRGBColorSpace);

const group = new THREE.Group();
group.rotation.x = -0.15;
scene.add(group);

const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 1, 120);
camera.position.set(0, 0.6, 29);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

let neurons = null;     // { n, roles, types, positions: Float32Array }
const flashPool = [];
const flashState = [];  // {node, ttl, dur, isGF}
let flashNext = 0;
let stimRing = null;
let stimRingT = 0;
let idleSince = 0;        // seconds of no pointer activity before auto-rotate resumes
let hovering = false;     // pointer is over the canvas: hold still for aiming
let dragging = false;
let dragMoved = 0;
let dragX = 0, dragY = 0;
let labelTimer = null;

function makeFlashMaterial(rgb) {
  return new THREE.MeshBasicMaterial({
    color: new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace),
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

function build(points, circuit) {
  // full brain: 23k real somas
  const pts = points.points;
  const pos = new Float32Array(pts.length * 3);
  const col = new Float32Array(pts.length * 3);
  let k = 0;
  for (const p of pts) {
    if (p.length < 4) continue;
    pos[3 * k] = p[0]; pos[3 * k + 1] = p[1]; pos[3 * k + 2] = p[2];
    const c = CLASS_COLORS[p[3] | 0] || [0.3, 0.3, 0.3];
    col[3 * k] = c[0]; col[3 * k + 1] = c[1]; col[3 * k + 2] = c[2];
    k++;
  }
  group.add(pointCloud(pos.subarray(0, 3 * k), col.subarray(0, 3 * k), 0.11));

  // circuit overlay: brighter points at the simulated neurons
  const n = circuit.neurons.length;
  const cpos = new Float32Array(n * 3);
  const ccol = new Float32Array(n * 3);
  const roles = [], types = [];
  for (let i = 0; i < n; i++) {
    const nr = circuit.neurons[i];
    roles.push(nr.role); types.push(nr.type);
    const p = nr.pos && nr.pos.length === 3 ? nr.pos : [0, 0, 0];
    cpos[3 * i] = p[0]; cpos[3 * i + 1] = p[1]; cpos[3 * i + 2] = p[2];
    const c = ROLE_COLORS[nr.role] || [0.45, 0.45, 0.50];
    ccol[3 * i] = c[0]; ccol[3 * i + 1] = c[1]; ccol[3 * i + 2] = c[2];
  }
  group.add(pointCloud(cpos, ccol, 0.34));
  neurons = { n, roles, types, positions: cpos };

  // the two giant fibers get actual glowing markers
  const gfGeo = new THREE.SphereGeometry(0.28, 12, 10);
  for (let i = 0; i < n; i++) {
    if (roles[i] !== 'gf') continue;
    const m = makeFlashMaterial([1.0, 0.85, 0.25]);
    m.opacity = 0.35;
    const node = new THREE.Mesh(gfGeo, m);
    node.position.set(cpos[3 * i], cpos[3 * i + 1], cpos[3 * i + 2]);
    group.add(node);
  }

  // spike flash pool
  const flashGeo = new THREE.SphereGeometry(0.16, 10, 8);
  for (let i = 0; i < 48; i++) {
    const node = new THREE.Mesh(flashGeo, makeFlashMaterial([0.75, 0.95, 1.0]));
    node.visible = false;
    group.add(node);
    flashPool.push(node);
    flashState.push({ ttl: 0, dur: 1 });
  }

  // reusable stimulation ring
  const rm = makeFlashMaterial([1.0, 0.9, 0.5]);
  rm.opacity = 0.18;
  rm.side = THREE.DoubleSide;
  stimRing = new THREE.Mesh(new THREE.SphereGeometry(2.2, 20, 14), rm);
  stimRing.visible = false;
  group.add(stimRing);
}

function flash(neuron, isGF) {
  if (!neurons || neuron >= neurons.n || !flashPool.length) return;
  const idx = flashNext;
  flashNext = (flashNext + 1) % flashPool.length;
  const node = flashPool[idx];
  const p = neurons.positions;
  node.position.set(p[3 * neuron], p[3 * neuron + 1], p[3 * neuron + 2]);
  node.visible = true;
  node.material.opacity = isGF ? 1.0 : 0.8;
  const s = isGF ? 3.2 : 1;
  node.scale.set(s, s, s);
  const dur = isGF ? 0.6 : 0.28;
  flashState[idx] = { ttl: dur, dur, peak: node.material.opacity };
}

function flashRing(x, y, z) {
  stimRing.position.set(x, y, z);
  stimRing.visible = true;
  stimRing.scale.set(0.5, 0.5, 0.5);
  stimRing.material.opacity = 1;
  stimRingT = 0.55;
}

function showLabel(text) {
  labelEl.textContent = text;
  labelEl.classList.add('on');
  clearTimeout(labelTimer);
  labelTimer = setTimeout(() => labelEl.classList.remove('on'), 2200);
}

function regionName(picked) {
  const counts = {};
  for (const i of picked) counts[neurons.roles[i]] = (counts[neurons.roles[i]] || 0) + 1;
  let major = picked.length ? neurons.roles[picked[0]] : 'other';
  let best = -1;
  for (const [role, c] of Object.entries(counts)) if (c > best) { best = c; major = role; }
  const sideSuffix = (role) => {
    const l = picked.filter((i) => neurons.roles[i] === role && neurons.positions[3 * i] < 0).length;
    const r = picked.filter((i) => neurons.roles[i] === role).length - l;
    return l === r ? '' : (l > r ? ' · left' : ' · right');
  };
  switch (major) {
    case 'lc4': case 'lplc2': return `⚡ Looming detectors (LC4/LPLC2)${sideSuffix(major)}`;
    case 'gf': return '⚡ Giant Fiber (DNp01) — escape!';
    case 'dna01': case 'dna02': return `⚡ Steering neurons (DNa01/02)${sideSuffix(major)}`;
    case 'dnp09': return '⚡ Walking command (DNp09)';
    case 'dng11': return '⚡ Grooming command (DNg11)';
    case 'escw': return '⚡ Escape-wing DNs (DNp02/04/11)';
    case 'mdn': return '⚡ Moonwalker neurons (MDN)';
    default: {
      const anyOther = picked.find((i) => neurons.roles[i] === 'other');
      let t = neurons.types[anyOther !== undefined ? anyOther : picked[0]];
      if (!t || t === '?') t = 'central';
      return `⚡ ${t} neurons`;
    }
  }
}

const raycaster = new THREE.Raycaster();

function handleClick(ev) {
  if (!neurons) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);

  // the click ray, expressed in the (rotating) brain group's own frame
  group.updateMatrixWorld();
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const a = raycaster.ray.origin.clone().applyMatrix4(inv);
  const b = raycaster.ray.origin.clone()
    .add(raycaster.ray.direction.clone().multiplyScalar(100)).applyMatrix4(inv);
  const d = b.sub(a).normalize();

  // nearest circuit neuron to the click ray
  const p = neurons.positions;
  let best = -1, bestPerp = Infinity;
  const ap = new THREE.Vector3();
  for (let i = 0; i < neurons.n; i++) {
    ap.set(p[3 * i] - a.x, p[3 * i + 1] - a.y, p[3 * i + 2] - a.z);
    const along = ap.dot(d);
    const perp = Math.hypot(ap.x - along * d.x, ap.y - along * d.y, ap.z - along * d.z);
    if (perp < bestPerp) { bestPerp = perp; best = i; }
  }
  if (best < 0) return;
  const ax = p[3 * best], ay = p[3 * best + 1], az = p[3 * best + 2];
  const dist2 = (i) => (p[3 * i] - ax) ** 2 + (p[3 * i + 1] - ay) ** 2 + (p[3 * i + 2] - az) ** 2;

  let picked = [];
  for (let i = 0; i < neurons.n; i++) if (dist2(i) < 2.2 * 2.2) picked.push(i);
  if (picked.length < 4) {
    picked = Array.from({ length: neurons.n }, (_, i) => i)
      .sort((x, y) => dist2(x) - dist2(y)).slice(0, 6);
  } else if (picked.length > 60) {
    picked = picked.sort((x, y) => dist2(x) - dist2(y)).slice(0, 60);
  }

  api.stimulate({ indices: picked, strength: 0.25, durationMs: 400 });
  for (const i of picked.slice(0, 16)) flash(i, false);
  flashRing(ax, ay, az);
  showLabel(regionName(picked));
}

// Aiming at a rotating cloud is hopeless, so any pointer activity parks the
// rotation, and dragging turns the brain by hand. A press that does not move
// is a click: stimulate. Auto-rotation resumes a couple of seconds after the
// pointer goes quiet.
const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (ev) => {
  dragging = true; dragMoved = 0;
  dragX = ev.clientX; dragY = ev.clientY;
  idleSince = 0;
  hovering = true;
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener('pointermove', (ev) => {
  hovering = true;
  idleSince = 0;
  if (!dragging) return;
  const dx = ev.clientX - dragX, dy = ev.clientY - dragY;
  dragX = ev.clientX; dragY = ev.clientY;
  dragMoved += Math.abs(dx) + Math.abs(dy);
  group.rotation.y += dx * 0.008;
  group.rotation.x = Math.max(-1.2, Math.min(1.2, group.rotation.x + dy * 0.008));
});
canvas.addEventListener('pointerup', (ev) => {
  if (dragging && dragMoved < 5) handleClick(ev);   // a press that stayed put
  dragging = false;
  idleSince = 0;
  if (canvas.hasPointerCapture(ev.pointerId)) canvas.releasePointerCapture(ev.pointerId);
});
canvas.addEventListener('pointerenter', () => { hovering = true; idleSince = 0; });
canvas.addEventListener('pointerover', () => { hovering = true; idleSince = 0; });
canvas.addEventListener('pointerleave', () => { hovering = false; dragging = false; });

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

api.onSpikes((list) => {
  for (const e of list) flash(e.neuron, e.isGF);
});

let last = null;
function frame(tMs) {
  requestAnimationFrame(frame);
  const t = tMs / 1000;
  if (last === null) { last = t; return; }
  const dt = Math.min(0.05, t - last);
  last = t;

  // slow rotation about the vertical axis; parked while the pointer is busy
  // Held still while the pointer is over the brain, so a cluster can actually
  // be aimed at. The idle timer is the safety net: if a pointerleave is ever
  // missed, rotation resumes anyway after a few quiet seconds.
  idleSince += dt;
  if (!dragging && (!hovering || idleSince > 4) && idleSince > 2) {
    group.rotation.y += (0.35 / 6) * dt;
  }

  for (let i = 0; i < flashPool.length; i++) {
    const st = flashState[i];
    if (st.ttl <= 0) continue;
    st.ttl -= dt;
    if (st.ttl <= 0) { flashPool[i].visible = false; continue; }
    flashPool[i].material.opacity = st.peak * (st.ttl / st.dur);
  }
  if (stimRingT > 0) {
    stimRingT -= dt;
    const k = Math.max(0, stimRingT / 0.55);
    const s = 0.5 + 0.9 * (1 - k);
    stimRing.scale.set(s, s, s);
    stimRing.material.opacity = k;
    if (stimRingT <= 0) stimRing.visible = false;
  }

  renderer.render(scene, camera);
}

(async () => {
  const data = await api.getBrainData();
  if (!data) { showLabel('no data/ — run etl.py first'); return; }
  build(data.points, data.circuit);
  requestAnimationFrame(frame);
})();
