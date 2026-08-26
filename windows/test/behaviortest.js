// behaviortest.js — port of runBehaviorTest() from main.swift.
// 18 end-to-end sim -> body checks. MUST pass after any behavior change.
//   node test/behaviortest.js

import { loadBrainData } from '../src/data.js';
import { LIFSim, makeSignals } from '../src/sim.js';
import { SignalBuilder } from '../src/signals.js';
import { Fly, FLY_SCALE, WANDER_JITTER } from '../src/flymodel.js';
import { circadianActivity, makeLedge } from '../src/environment.js';
import { rnd, lag, TUNED_HZ } from '../src/util.js';

const data = loadBrainData();
if (!data) { process.stderr.write('no data/ — run etl.py first\n'); process.exit(1); }

const bounds = { width: 1512, height: 982 };
const dt = 1 / 60;
let failures = 0;
const f = (x, d = 2) => x.toFixed(d);
const sign = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);

function scenario(name, { stim, hold, setup = null, check, describe }) {
  const sim = new LIFSim(data.circuit, null);
  const builder = new SignalBuilder();
  const fly = new Fly({ x: 0, y: 0 });
  fly.state = 'idle';
  fly.speed = 0;
  if (setup) setup(fly);
  // settle the network, drain any startup GF latch
  sim.step(400);
  sim.consumeGF();
  stim(sim);
  let passed = false;
  let frames = Math.floor(hold / dt);
  while (frames > 0) {
    frames--;
    sim.step(Math.round(dt * 1000));
    const s = builder.make(sim, dt);
    fly.update(dt, bounds, null, s);
    if (check(fly)) { passed = true; break; }
  }
  if (!passed) failures++;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${describe(fly)}`);
}

scenario('GF stim -> escape flight', {
  stim: (s) => s.stimulate(s.gf, 0.5, 40),
  hold: 0.5,
  check: (fly) => fly.state === 'flying',
  describe: (fly) => `state=${fly.state}`,
});

scenario('DNg11 stim -> grooming', {
  stim: (s) => s.stimulate(s.groom, 0.25, 600),
  hold: 1.5,
  check: (fly) => fly.state === 'grooming',
  describe: (fly) => `state=${fly.state}`,
});

scenario('DNp09 stim -> walks, speed rises (capped)', {
  stim: (s) => s.stimulate(s.fwd, 0.25, 1200),
  hold: 1.5,
  check: (fly) => fly.state === 'walking' && fly.speed > 40 && fly.speed < 100,
  describe: (fly) => `state=${fly.state} speed=${Math.trunc(fly.speed)}`,
});

scenario('MDN stim (from idle) -> backward walk', {
  stim: (s) => s.stimulate(s.mdn, 0.3, 600),
  hold: 1.2,
  check: (fly) => fly.backwardTimer > 0,
  describe: (fly) => `backwardTimer=${f(fly.backwardTimer)}`,
});

let heading0 = 0;
scenario('DNa-left stim -> left (CCW) turn while walking', {
  stim: (s) => s.stimulate(s.dnaL, 0.3, 900),
  hold: 1.4,
  setup: (fly) => {
    fly.state = 'walking';
    fly.speed = 30;
    fly.heading = 0;
    heading0 = 0;
  },
  check: (fly) => fly.heading - heading0 > 0.25,
  describe: (fly) => `heading change ${sign(fly.heading - heading0)} rad`,
});

scenario('moderate loom -> fear response (dart or escape)', {
  stim: (s) => { s.loomL = 0.45; s.loomR = 0.45; },
  hold: 1.0,
  check: (fly) => (fly.state === 'walking' && fly.speed > 100) || fly.state === 'flying',
  describe: (fly) => `state=${fly.state} speed=${Math.trunc(fly.speed)}`,
});

scenario('tap near fly -> startle escape via sensory pathway', {
  stim: (s) => s.stimulate(s.sens, 0.45, 150),
  hold: 0.8,
  check: (fly) => fly.state === 'flying',
  describe: (fly) => `state=${fly.state}`,
});

// ---- body-level environment checks (hand-built signals, no sim) ----
function bodyCheck(name, run) {
  const [ok, detail] = run();
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const walkSignals = makeSignals();
walkSignals.walkDrive = 0.6;

bodyCheck('ledge attach + follow window edge', () => {
  const fly = new Fly({ x: 0, y: -55 });
  fly.state = 'walking'; fly.speed = 30; fly.heading = 0;
  fly.terrain = [makeLedge(-40, -300, 300, 1)];
  for (let i = 0; i < 240; i++) {
    fly.update(dt, bounds, null, walkSignals);
    if (fly.ledge && Math.abs(fly.pos.y + 40) < 8) {
      return [true, `attached, y=${Math.trunc(fly.pos.y)}`];
    }
  }
  return [false, `state=${fly.state} y=${Math.trunc(fly.pos.y)} ledge=${!!fly.ledge}`];
});

bodyCheck('window closes underfoot -> takeoff', () => {
  const fly = new Fly({ x: 0, y: -40 });
  fly.state = 'walking'; fly.speed = 25; fly.heading = 0;
  fly.terrain = [makeLedge(-40, -300, 300, 1)];
  fly.ledge = fly.terrain[0];
  fly.terrain = [];
  for (let i = 0; i < 60; i++) {
    fly.update(dt, bounds, null, walkSignals);
    if (fly.state === 'flying') return [true, 'took off'];
  }
  return [false, `state=${fly.state}`];
});

bodyCheck('sleep signal -> sleeping; wake -> grooming', () => {
  const fly = new Fly({ x: 0, y: 0 });
  fly.state = 'idle';
  const s = makeSignals(); s.sleep = true;
  for (let i = 0; i < 60; i++) fly.update(dt, bounds, null, s);
  if (fly.state !== 'sleeping') return [false, `no sleep: ${fly.state}`];
  s.sleep = false;
  fly.update(dt, bounds, null, s);
  return [fly.state === 'grooming', `woke to ${fly.state}`];
});

bodyCheck('thermal tempo scales walking speed', () => {
  const fly = new Fly({ x: 0, y: 0 });
  fly.state = 'walking'; fly.speed = 20; fly.heading = 0;
  const cool = { ...walkSignals, tempo: 1.0 };
  for (let i = 0; i < 120; i++) fly.update(dt, bounds, null, cool);
  const coolSpeed = fly.speed;
  const hot = { ...walkSignals, tempo: 1.5 };
  for (let i = 0; i < 120; i++) fly.update(dt, bounds, null, hot);
  const hotSpeed = fly.speed;
  return [fly.state === 'walking' && hotSpeed > coolSpeed + 10,
          `cool ${Math.trunc(coolSpeed)} -> hot ${Math.trunc(hotSpeed)} pt/s`];
});

bodyCheck('flight: altitude drives scale; escape flies higher than casual', () => {
  function flight(escape, effort) {
    const fly = new Fly({ x: 0, y: 0 });
    fly.state = 'idle';
    fly.startFlight(bounds, { escape, effort });
    let maxAlt = 0, maxScale = 0;
    let frames = 0;
    while (fly.state === 'flying' && frames < 400) {
      frames++;
      fly.update(dt, bounds, null, makeSignals());
      maxAlt = Math.max(maxAlt, fly.alt);
      maxScale = Math.max(maxScale, fly.node.scale.x);
    }
    return { alt: maxAlt, scale: maxScale };
  }
  const esc = flight(true, null);
  const casual = flight(false, 0.45);
  const ok = esc.alt > casual.alt + 0.15 && esc.scale > FLY_SCALE * 1.5
    && Math.abs(esc.scale - FLY_SCALE * (1 + 0.8 * esc.alt)) < 0.15;
  return [ok, `escape alt ${f(esc.alt)} scale ${f(esc.scale)} | `
    + `casual alt ${f(casual.alt)} scale ${f(casual.scale)}`];
});

bodyCheck('flight: wings actually beat', () => {
  const fly = new Fly({ x: 0, y: 0 });
  fly.state = 'idle';
  fly.startFlight(bounds, { effort: 0.8 });
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < 30 && fly.state === 'flying'; i++) {
    fly.update(dt, bounds, null, makeSignals());
    const z = fly.model.foldedWings.children[0].rotation.z;
    lo = Math.min(lo, z); hi = Math.max(hi, z);
  }
  return [hi - lo > 0.25, `wing sweep ${f(hi - lo)} rad over 0.5 s`];
});

bodyCheck('escape-DN activity mid-flight raises wing-beat effort', () => {
  const fly = new Fly({ x: 0, y: 0 });
  fly.state = 'idle';
  fly.startFlight(bounds, { effort: 0.5 });
  const calm = makeSignals();
  for (let i = 0; i < 12; i++) fly.update(dt, bounds, null, calm);
  const calmEffort = fly.effortCurrent;
  const hot = makeSignals(); hot.wingDrive = 1.0; hot.arousal = 0.6;
  for (let i = 0; i < 12 && fly.state === 'flying'; i++) fly.update(dt, bounds, null, hot);
  const hotEffort = fly.effortCurrent;
  return [fly.state === 'flying' && hotEffort > calmEffort + 0.2,
          `effort ${f(calmEffort)} -> ${f(hotEffort)}`];
});

bodyCheck('threat while grounded raises the wings (no takeoff)', () => {
  const fly = new Fly({ x: 0, y: 0 });
  fly.state = 'walking'; fly.speed = 20;
  fly.dartCooldown = 99;   // isolate the posture from darting
  const threat = makeSignals(); threat.wingDrive = 0.9; threat.walkDrive = 0.4;
  for (let i = 0; i < 40; i++) fly.update(dt, bounds, null, threat);
  const x = fly.model.foldedWings.children[0].rotation.x;
  return [fly.state !== 'flying' && fly.wingRaise > 0.6 && x < -0.2,
          `raise ${f(fly.wingRaise)}, wing tilt ${f(x)} rad`];
});

bodyCheck('landing is smooth: no scale/height snap at touchdown', () => {
  const fly = new Fly({ x: 0, y: 0 });
  fly.state = 'idle';
  fly.startFlight(bounds, { escape: true });
  let prevScale = fly.node.scale.x, prevZ = fly.node.position.z;
  let maxDS = 0, maxDZ = 0;
  let post = 20, frames = 0;
  let landed = false;
  while (post > 0 && frames < 600) {
    frames++;
    fly.update(dt, bounds, null, makeSignals());
    maxDS = Math.max(maxDS, Math.abs(fly.node.scale.x - prevScale));
    maxDZ = Math.max(maxDZ, Math.abs(fly.node.position.z - prevZ));
    prevScale = fly.node.scale.x; prevZ = fly.node.position.z;
    if (fly.state !== 'flying') { landed = true; post--; }
  }
  return [landed && maxDS < 0.2 && maxDZ < 25,
          `landed=${landed ? 'yes' : 'NO'}, max per-frame dScale ${f(maxDS)}, dz ${f(maxDZ, 1)}`];
});

bodyCheck('circadian curve: siesta + night dips, dawn/dusk peaks', () => {
  const night = circadianActivity(3), dawn = circadianActivity(9);
  const siesta = circadianActivity(14), dusk = circadianActivity(18);
  const ok = night < 0.4 && dawn > 0.9 && siesta < 0.7 && siesta > 0.3 && dusk > 0.9;
  return [ok, `3h ${f(night)}, 9h ${f(dawn)}, 14h ${f(siesta)}, 18h ${f(dusk)}`];
});

// Guards both halves of the frame-rate fix (mirrors the Swift suite). Before
// it, the first check was off by 27% at the 50 ms dt cap and the second
// differed by sqrt(2) between a 60 Hz and a 120 Hz display.
bodyCheck('body timestep is frame-rate independent', () => {
  // 0. at the rate the constants were tuned at, lag() must reproduce the old
  //    `Math.min(1, k * dt)` value exactly, or this stops being a pure bug fix
  let exact60 = true;
  for (const k of [0.05, 0.9, 3, 4, 6, 8, 9, 10]) {
    exact60 = exact60 && Math.abs(lag(k, 1 / TUNED_HZ) - k / TUNED_HZ) < 1e-12;
  }
  // 1. a first-order lag must give the same result however it is subdivided
  let fine = 0, coarse = 0;
  for (let i = 0; i < 8; i++) fine += (1 - fine) * lag(10, 0.1 / 8);
  coarse += (1 - coarse) * lag(10, 0.1);
  // 2. the heading random walk must have the same spread at any frame rate
  function spread(sdt) {
    let sum = 0;
    for (let i = 0; i < 4000; i++) {
      let h = 0, t = 0;
      while (t < 2) { h += rnd(-1, 1) * WANDER_JITTER * Math.sqrt(sdt); t += sdt; }
      sum += h * h;
    }
    return Math.sqrt(sum / 4000);
  }
  const s60 = spread(1 / 60), s120 = spread(1 / 120);
  const ok = exact60 && Math.abs(fine - coarse) < 1e-6 && Math.abs(s60 - s120) / s60 < 0.1;
  return [ok, `60Hz exact=${exact60 ? 'yes' : 'NO'}, lag 8x12.5ms ${fine.toFixed(6)} `
    + `vs 1x100ms ${coarse.toFixed(6)}, wander sd ${s60.toFixed(3)} @60Hz vs ${s120.toFixed(3)} @120Hz`];
});

console.log(failures === 0 ? 'ALL BEHAVIOR TESTS PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
