// overlay.js — the desktop overlay renderer: buildScene() plus Coordinator
// from main.swift. This is where the brain runs; the main process only feeds
// it senses and tray commands.

// relative rather than bare so the same module resolves in Node (tests)
// and in the renderer without an inline importmap
import * as THREE from '../node_modules/three/build/three.module.js';
import { LIFSim, SpikeBus } from '../src/sim.js';
import { SignalBuilder } from '../src/signals.js';
import { Fly, SHADOWS_ENABLED } from '../src/flymodel.js';
import { clampf, rnd, lag } from '../src/util.js';

const api = window.flyAPI;

let bounds = { width: window.innerWidth, height: window.innerHeight };

// ---- scene ----

const scene = new THREE.Scene();

const camera = new THREE.OrthographicCamera(
  -bounds.width / 2, bounds.width / 2, bounds.height / 2, -bounds.height / 2, 1, 600);
camera.position.set(0, 0, 300);

// SCNLight .directional with eulerAngles(-0.35, 0.30, 0): the light shines
// along that node's -Z axis, so three.js gets the light placed on the opposite
// side, aiming at the origin.
// SceneKit used 1000 lm key / 550 lm ambient; three.js light units differ,
// so these are the equivalents that keep highlights from clipping to white.
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(0.2955 * 900, 0.3276 * 900, 0.8974 * 900);
key.target.position.set(0, 0, 0);
scene.add(key.target);
if (SHADOWS_ENABLED) {
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.radius = 3;
  key.shadow.bias = -0.0008;
}
scene.add(key);

const ambient = new THREE.AmbientLight(0xffffff, 0.82);
scene.add(ambient);

// invisible catcher plane: writes only the shadow, exactly like the SceneKit
// plane with an empty colorBufferWriteMask
let shadowPlane = null;
if (SHADOWS_ENABLED) {
  shadowPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(6000, 6000),
    new THREE.ShadowMaterial({ opacity: 0.30 }));
  shadowPlane.position.z = -0.6;
  shadowPlane.receiveShadow = true;
  scene.add(shadowPlane);
}

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, premultipliedAlpha: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(bounds.width, bounds.height);
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
if (SHADOWS_ENABLED) {
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
}
document.body.appendChild(renderer.domElement);

function fitShadowCamera() {
  const c = key.shadow.camera;
  const m = 260;
  c.left = -bounds.width / 2 - m; c.right = bounds.width / 2 + m;
  c.top = bounds.height / 2 + m; c.bottom = -bounds.height / 2 - m;
  c.near = 1; c.far = 2200;
  c.updateProjectionMatrix();
}
fitShadowCamera();

// ---- coordinator ----

const flies = [];
let sim = null;
let spikeBus = null;
const signalBuilder = new SignalBuilder();

let lastTime = null;
let paused = false;
let mouseScene = null;
let prevMouse = null;
const mouseVel = { x: 0, y: 0 };
const mouseVelRaw = { x: 0, y: 0 };   // last measurement, held between samples
let mouseSampleDt = 0;                // real time since that measurement
let loomOverride = 0;
let msAccumulator = 0;

let terrain = [];
let screens = null;             // scene-space rects of the real monitors
let knownWindowIds = null;      // null until the first poll, like WindowSense.first
let typingLevel = 0;
let sleepy = false;
let tempo = 1;
let activity = 1;
let windowLoomL = 0;
let windowLoomR = 0;

function addFly() {
  const hw = bounds.width / 2 - 100, hh = bounds.height / 2 - 100;
  let p = { x: rnd(-hw, hw), y: rnd(-hh, hh) };
  for (let k = 0; k < 24 && screens && !onAnyScreen(p.x, p.y, 60); k++) {
    p = { x: rnd(-hw, hw), y: rnd(-hh, hh) };
  }
  const fly = new Fly(p);
  fly.screens = screens;
  scene.add(fly.node);
  flies.push(fly);
}

function onAnyScreen(x, y, inset = 0) {
  if (!screens || !screens.length) return true;
  return screens.some((s) => x > s.x0 + inset && x < s.x1 - inset
    && y > s.y0 + inset && y < s.y1 - inset);
}

// Tray-driven stimulation of a named population: the same electrode the brain
// window's click applies, with the strengths and durations the behavior test
// uses, so "Groom" here and a click on DNg11 there do the identical thing.
const STIM_GROUPS = {
  groom: ['groom', 0.25, 600],
  walk: ['fwd', 0.25, 1200],
  backward: ['mdn', 0.3, 600],
  escape: ['gf', 0.5, 40],
  wings: ['escw', 0.3, 600],
  tap: ['sens', 0.45, 150],
  steerLeft: ['dnaL', 0.3, 900],
  steerRight: ['dnaR', 0.3, 900],
};

function stimulateGroup(name) {
  if (!sim) return;
  const spec = STIM_GROUPS[name];
  if (!spec) return;
  const [field, strength, durationMs] = spec;
  sim.stimulate(sim[field], strength, durationMs);
}

// tray command: nudge the fly across to another monitor
function flyToNextDisplay() {
  const fly = flies[0];
  if (!fly || !screens || screens.length < 2) return;
  const here = screens.findIndex((s) => fly.pos.x > s.x0 && fly.pos.x < s.x1
    && fly.pos.y > s.y0 && fly.pos.y < s.y1);
  const next = screens[(Math.max(0, here) + 1) % screens.length];
  fly.startFlight(bounds, {
    target: {
      x: rnd(next.x0 + 120, next.x1 - 120),
      y: rnd(next.y0 + 120, next.y1 - 120),
    },
  });
}

function removeFly() {
  if (flies.length <= 1) return;          // fly #1 carries the brain
  const fly = flies.pop();
  scene.remove(fly.node);
}

function scareAll() {
  loomOverride = 0.6;                     // real stimulus into the real circuit for fly #1
  for (const fly of flies.slice(1)) {
    if (fly.state !== 'flying') fly.startFlight(bounds);
  }
}

// a window appeared near the fly: a real looming object
function injectWindowLoom(strength, p) {
  const fly = flies[0];
  if (!fly) return;
  const rel = { x: p.x - fly.pos.x, y: p.y - fly.pos.y };
  const dist = Math.max(1, Math.hypot(rel.x, rel.y));
  const f = { x: Math.cos(fly.heading), y: Math.sin(fly.heading) };
  const crossZ = (f.x * rel.y - f.y * rel.x) / dist;
  windowLoomL = Math.max(windowLoomL, strength * clampf(0.5 + 0.5 * crossZ, 0.12, 1));
  windowLoomR = Math.max(windowLoomR, strength * clampf(0.5 - 0.5 * crossZ, 0.12, 1));
}

// a global mouse click: a tap on the fly's substrate -> sensory pathway
function injectTap(p) {
  const fly = flies[0];
  if (!sim || !fly) return;
  const d = Math.hypot(p.x - fly.pos.x, p.y - fly.pos.y);
  const strength = clampf(1 - d / 520, 0, 1);
  if (strength > 0.05) sim.stimulate(sim.sens, 0.15 + strength * 0.35, 130);
}

// Cursor kinematics -> looming drive for each eye of fly #1 + air puff.
// This is the sensory transduction step; everything downstream of the
// LC4/LPLC2 population is the real connectome.
function computeLoom(fly, mouse, dt) {
  if (!mouse) return { l: 0, r: 0, puff: 0 };
  if (prevMouse && dt > 0) {
    // The cursor arrives from a 30 Hz poll in the main process while this runs
    // once per rendered frame (up to 120), so most frames see the same
    // position. Dividing by the render dt turned one 30 Hz step into a spike
    // whose height scaled with refresh rate; measure over the real interval
    // between samples instead, and re-measure if the cursor goes quiet so a
    // stopped cursor decays to zero rather than holding its last speed.
    mouseSampleDt += dt;
    if (mouse.x !== prevMouse.x || mouse.y !== prevMouse.y || mouseSampleDt >= 1 / 30) {
      mouseVelRaw.x = (mouse.x - prevMouse.x) / mouseSampleDt;
      mouseVelRaw.y = (mouse.y - prevMouse.y) / mouseSampleDt;
      prevMouse = { x: mouse.x, y: mouse.y };
      mouseSampleDt = 0;
    }
    // Smoothing runs every frame, frame-rate-corrected: 24/60 = the old fixed
    // per-frame 0.4, so 60 Hz is unchanged.
    const k = lag(24, dt);
    mouseVel.x += (mouseVelRaw.x - mouseVel.x) * k;
    mouseVel.y += (mouseVelRaw.y - mouseVel.y) * k;
  } else {
    prevMouse = { x: mouse.x, y: mouse.y };
    mouseSampleDt = 0;
  }
  const rel = { x: mouse.x - fly.pos.x, y: mouse.y - fly.pos.y };
  const dist = Math.max(20, Math.hypot(rel.x, rel.y));
  // radial approach speed (positive = cursor closing in)
  const approach = -(rel.x * mouseVel.x + rel.y * mouseVel.y) / dist;
  // loom ~ rate of angular expansion, attenuated with distance
  let loom = clampf(approach / dist * 6, 0, 1) * clampf(1 - dist / 800, 0, 1);
  loom += clampf((130 - dist) / 130, 0, 1) * 0.5;          // hovering close = big object
  loom = clampf(loom + loomOverride, 0, 1);
  // split between eyes by bearing relative to heading
  const f = { x: Math.cos(fly.heading), y: Math.sin(fly.heading) };
  const rd = { x: rel.x / dist, y: rel.y / dist };
  const crossZ = f.x * rd.y - f.y * rd.x;                  // >0: threat on the left
  const lw = clampf(0.5 + 0.5 * crossZ, 0.12, 1);
  const rw = clampf(0.5 - 0.5 * crossZ, 0.12, 1);
  const puff = clampf(Math.hypot(mouseVel.x, mouseVel.y) / 1500, 0, 1)
    * clampf(1 - dist / 500, 0, 1);
  return { l: loom * lw, r: loom * rw, puff };
}

function frame(tMs) {
  requestAnimationFrame(frame);
  if (paused) { lastTime = null; return; }
  const t = tMs / 1000;
  if (lastTime === null) { lastTime = t; return; }
  const dt = Math.min(0.05, Math.max(0, t - lastTime));
  lastTime = t;

  let signals = null;
  const first = flies[0];
  if (sim && first) {
    const sensory = computeLoom(first, mouseScene, dt);
    const decayF = Math.exp(-4 * dt);
    windowLoomL *= decayF;
    windowLoomR *= decayF;
    sim.loomL = Math.max(sensory.l, windowLoomL);
    sim.loomR = Math.max(sensory.r, windowLoomR);
    sim.airPuff = Math.max(sensory.puff, typingLevel * 0.30);
    // body -> brain: leg proprioception from the current gait
    sim.gaitDrive = first.walkingIntensity;
    sim.gaitPhase = first.gaitPhasePublic;
    // circadian + sleep neuromodulation. Compressed: the LIF neurons sit
    // just below threshold, so a raw multiplier silences them entirely —
    // siesta should mean "less active", not comatose.
    sim.activityScale = (1 - (1 - activity) * 0.35) * (sleepy ? 0.75 : 1);
    sim.sensoryGate = sleepy ? 0.55 : 1;
    loomOverride = Math.max(0, loomOverride - dt * 1.2);   // override decays
    msAccumulator += dt * 1000;
    const steps = Math.min(50, Math.floor(msAccumulator));
    msAccumulator -= steps;
    sim.step(steps);

    signals = signalBuilder.make(sim, dt);
    signals.tempo = tempo;
    signals.sleep = sleepy;

    if (spikeBus) {
      const events = spikeBus.popAll();
      if (events.length) api.sendSpikes(events);
    }
  }

  for (let i = 0; i < flies.length; i++) {
    flies[i].terrain = terrain;
    flies[i].update(dt, bounds, mouseScene, i === 0 ? signals : null);
  }

  renderer.render(scene, camera);
}

// ---- wiring ----

api.onAmbient((a) => {
  mouseScene = a.mouse;
  typingLevel = a.typing;
  sleepy = a.sleepy;
  tempo = a.tempo;
  activity = a.activity;
});

api.onTerrain((snap) => {
  terrain = snap.ledges;
  const ids = new Set(snap.windows.map((w) => w.id));
  if (knownWindowIds !== null) {
    const fly = flies[0];
    for (const w of snap.windows) {
      if (knownWindowIds.has(w.id)) continue;
      if (!fly) continue;
      const d = Math.hypot(w.center.x - fly.pos.x, w.center.y - fly.pos.y);
      const strength = clampf(1 - d / 480, 0, 1) * 0.75;
      if (strength > 0.08) injectWindowLoom(strength, w.center);
    }
  }
  knownWindowIds = ids;
});

api.onTap((p) => injectTap(p));

api.onCommand((c) => {
  switch (c.name) {
    case 'pause': paused = c.value; lastTime = null; break;
    case 'escapeTest': loomOverride = 0.6; break;
    case 'addFly': addFly(); break;
    case 'removeFly': removeFly(); break;
    case 'scareAll': scareAll(); break;
    case 'flyToNextDisplay': flyToNextDisplay(); break;
    case 'stim': stimulateGroup(c.group); break;
    default: break;
  }
});

api.onRetarget((size) => {
  bounds = { width: size.width, height: size.height };
  if (size.screens) screens = size.screens;
  for (const fly of flies) fly.screens = screens;
  terrain = [];                       // stale until the next window poll
  camera.left = -bounds.width / 2; camera.right = bounds.width / 2;
  camera.top = bounds.height / 2; camera.bottom = -bounds.height / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(bounds.width, bounds.height);
  fitShadowCamera();
  // keep flies on a real screen after the desktop changed shape
  for (const fly of flies) {
    fly.ledge = null;
    fly.pos.x = clampf(fly.pos.x, -bounds.width / 2 + 40, bounds.width / 2 - 40);
    fly.pos.y = clampf(fly.pos.y, -bounds.height / 2 + 40, bounds.height / 2 - 40);
    if (!onAnyScreen(fly.pos.x, fly.pos.y)) {
      const c = fly.nearestScreenCenter(fly.pos.x, fly.pos.y);
      fly.pos.x = c.x; fly.pos.y = c.y;
    }
  }
});

api.onStimulate((req) => {
  if (sim) sim.stimulate(req.indices, req.strength, req.durationMs);
});

(async () => {
  const data = await api.getBrainData();
  if (data) {
    spikeBus = new SpikeBus();
    sim = new LIFSim(data.circuit, spikeBus);
  } else {
    console.warn('no data/ — the fly falls back to legacy distance-based behavior');
  }
  addFly();
  requestAnimationFrame(frame);
})();
