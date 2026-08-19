// Headless sim -> 3D body end-to-end checks — the port of
// `./DesktopFly --behaviortest` (main.swift:231-457).
//
// Seven scenarios stimulate a real neuron population and assert the body
// reacts; ten more drive the body with hand-built signals. Every check prints
// PASS/FAIL and the suite exits non-zero if any fails.

import { loadBrainData } from '../core/data.ts';
import { LIFSim } from '../core/sim.ts';
import { SignalBuilder } from '../core/signals.ts';
import { circadianActivity } from '../core/circadian.ts';
import { defaultSignals, type Ledge } from '../core/types.ts';
import { Fly, asFlyState } from '../body/fly.ts';
import { FLY_SCALE } from '../body/constants.ts';

const seedArg = process.argv.find((a) => a.startsWith('--seed='));
const SEED = seedArg === undefined ? 1 : Number(seedArg.slice('--seed='.length));

const data = loadBrainData();
if (data === null) {
  console.error('no data/ — run etl.py first');
  process.exit(1);
}

const BOUNDS = { width: 1512, height: 982 };
const DT = 1 / 60;
let failures = 0;

function scenario(
  name: string,
  stim: (sim: LIFSim) => void,
  hold: number,
  check: (fly: Fly) => boolean,
  describe: (fly: Fly) => string,
  setup?: (fly: Fly) => void,
): void {
  const sim = new LIFSim(data!.circuit, null, SEED);
  const builder = new SignalBuilder();
  const fly = new Fly({ x: 0, y: 0 }, SEED);
  fly.state = asFlyState('idle');
  fly.speed = 0;
  setup?.(fly);
  // settle the network, drain any startup GF latch
  sim.step(400);
  sim.consumeGF();
  stim(sim);
  let passed = false;
  let frames = Math.round(hold / DT);
  while (frames > 0) {
    frames--;
    sim.step(Math.round(DT * 1000));
    const s = builder.make(sim, DT);
    fly.update(DT, BOUNDS, null, s);
    if (check(fly)) {
      passed = true;
      break;
    }
  }
  if (!passed) failures++;
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}: ${describe(fly)}`);
}

scenario('GF stim -> escape flight',
  (s) => s.stimulate(s.gf, 0.5, 40), 0.5,
  (f) => f.state === 'flying',
  (f) => `state=${f.state}`);

scenario('DNg11 stim -> grooming',
  (s) => s.stimulate(s.groom, 0.25, 600), 1.5,
  (f) => f.state === 'grooming',
  (f) => `state=${f.state}`);

scenario('DNp09 stim -> walks, speed rises (capped)',
  (s) => s.stimulate(s.fwd, 0.25, 1200), 1.5,
  (f) => f.state === 'walking' && f.speed > 40 && f.speed < 100,
  (f) => `state=${f.state} speed=${Math.round(f.speed)}`);

scenario('MDN stim (from idle) -> backward walk',
  (s) => s.stimulate(s.mdn, 0.3, 600), 1.2,
  (f) => f.backwardTimer > 0,
  (f) => `backwardTimer=${f.backwardTimer.toFixed(2)}`);

let heading0 = 0;
scenario('DNa-left stim -> left (CCW) turn while walking',
  (s) => s.stimulate(s.dnaL, 0.3, 900), 1.4,
  (f) => f.heading - heading0 > 0.25,
  (f) => `heading change ${(f.heading - heading0).toFixed(2)} rad`,
  (f) => {
    f.state = asFlyState('walking');
    f.speed = 30;
    f.heading = 0;
    heading0 = 0;
  });

scenario('moderate loom -> fear response (dart or escape)',
  (s) => {
    s.loomL = 0.45;
    s.loomR = 0.45;
  }, 1.0,
  (f) => (f.state === 'walking' && f.speed > 100) || f.state === 'flying',
  (f) => `state=${f.state} speed=${Math.round(f.speed)}`);

scenario('tap near fly -> startle escape via sensory pathway',
  (s) => s.stimulate(s.sens, 0.45, 150), 0.8,
  (f) => f.state === 'flying',
  (f) => `state=${f.state}`);

// ---- body-level environment checks (hand-built signals, no sim) ----
function bodyCheck(name: string, run: () => [boolean, string]): void {
  const [ok, detail] = run();
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

function walkSignals() {
  const s = defaultSignals();
  s.walkDrive = 0.6;
  return s;
}

bodyCheck('ledge attach + follow window edge', () => {
  const fly = new Fly({ x: 0, y: -55 }, SEED);
  fly.state = asFlyState('walking');
  fly.speed = 30;
  fly.heading = 0;
  fly.terrain = [{ y: -40, x0: -300, x1: 300, id: 1 }];
  for (let i = 0; i < 240; i++) {
    fly.update(DT, BOUNDS, null, walkSignals());
    if (fly.ledge !== null && Math.abs(fly.pos.y + 40) < 8) {
      return [true, `attached, y=${Math.round(fly.pos.y)}`];
    }
  }
  return [false, `state=${fly.state} y=${Math.round(fly.pos.y)} `
    + `ledge=${fly.ledge !== null}`];
});

bodyCheck('window closes underfoot -> takeoff', () => {
  const fly = new Fly({ x: 0, y: -40 }, SEED);
  fly.state = asFlyState('walking');
  fly.speed = 25;
  fly.heading = 0;
  const L: Ledge = { y: -40, x0: -300, x1: 300, id: 1 };
  fly.terrain = [L];
  fly.ledge = L;
  fly.terrain = [];
  for (let i = 0; i < 60; i++) {
    fly.update(DT, BOUNDS, null, walkSignals());
    if (fly.state === 'flying') return [true, 'took off'];
  }
  return [false, `state=${fly.state}`];
});

bodyCheck('sleep signal -> sleeping; wake -> grooming', () => {
  const fly = new Fly({ x: 0, y: 0 }, SEED);
  fly.state = asFlyState('idle');
  const s = defaultSignals();
  s.sleep = true;
  for (let i = 0; i < 60; i++) fly.update(DT, BOUNDS, null, s);
  if (fly.state !== 'sleeping') return [false, `no sleep: ${fly.state}`];
  s.sleep = false;
  fly.update(DT, BOUNDS, null, s);
  const woke = asFlyState(fly.state);
  return [woke === 'grooming', `woke to ${woke}`];
});

bodyCheck('thermal tempo scales walking speed', () => {
  const fly = new Fly({ x: 0, y: 0 }, SEED);
  fly.state = asFlyState('walking');
  fly.speed = 20;
  fly.heading = 0;
  const cool = walkSignals();
  cool.tempo = 1.0;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, cool);
  const coolSpeed = fly.speed;
  const hot = walkSignals();
  hot.tempo = 1.5;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, hot);
  const hotSpeed = fly.speed;
  return [fly.state === 'walking' && hotSpeed > coolSpeed + 10,
    `cool ${Math.round(coolSpeed)} -> hot ${Math.round(hotSpeed)} pt/s`];
});

bodyCheck('flight: altitude drives scale; escape flies higher than casual', () => {
  function flight(escape: boolean, effort?: number) {
    const fly = new Fly({ x: 0, y: 0 }, SEED);
    fly.state = asFlyState('idle');
    fly.startFlight({ bounds: BOUNDS, escape, effort });
    let maxAlt = 0;
    let maxScale = 0;
    let frames = 0;
    while (fly.state === 'flying' && frames < 400) {
      frames++;
      fly.update(DT, BOUNDS, null, defaultSignals());
      maxAlt = Math.max(maxAlt, fly.alt);
      maxScale = Math.max(maxScale, fly.node.scale.x);
    }
    return { alt: maxAlt, scale: maxScale };
  }
  const esc = flight(true);
  const casual = flight(false, 0.45);
  const ok = esc.alt > casual.alt + 0.15 && esc.scale > FLY_SCALE * 1.5
    && Math.abs(esc.scale - FLY_SCALE * (1 + 0.8 * esc.alt)) < 0.15;
  return [ok, `escape alt ${esc.alt.toFixed(2)} scale ${esc.scale.toFixed(2)} `
    + `| casual alt ${casual.alt.toFixed(2)} scale ${casual.scale.toFixed(2)}`];
});

bodyCheck('flight: wings actually beat', () => {
  const fly = new Fly({ x: 0, y: 0 }, SEED);
  fly.state = asFlyState('idle');
  fly.startFlight({ bounds: BOUNDS, effort: 0.8 });
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 30 && fly.state === 'flying'; i++) {
    fly.update(DT, BOUNDS, null, defaultSignals());
    const z = fly.model.foldedWings.children[0].rotation.z;
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  return [hi - lo > 0.25, `wing sweep ${(hi - lo).toFixed(2)} rad over 0.5 s`];
});

bodyCheck('escape-DN activity mid-flight raises wing-beat effort', () => {
  const fly = new Fly({ x: 0, y: 0 }, SEED);
  fly.state = asFlyState('idle');
  fly.startFlight({ bounds: BOUNDS, effort: 0.5 });
  for (let i = 0; i < 12; i++) fly.update(DT, BOUNDS, null, defaultSignals());
  const calmEffort = fly.effortCurrent;
  const hot = defaultSignals();
  hot.wingDrive = 1.0;
  hot.arousal = 0.6;
  for (let i = 0; i < 12 && fly.state === 'flying'; i++) {
    fly.update(DT, BOUNDS, null, hot);
  }
  return [fly.state === 'flying' && fly.effortCurrent > calmEffort + 0.2,
    `effort ${calmEffort.toFixed(2)} -> ${fly.effortCurrent.toFixed(2)}`];
});

bodyCheck('threat while grounded raises the wings (no takeoff)', () => {
  const fly = new Fly({ x: 0, y: 0 }, SEED);
  fly.state = asFlyState('walking');
  fly.speed = 20;
  fly.dartCooldown = 99;   // isolate the posture from darting
  const threat = defaultSignals();
  threat.wingDrive = 0.9;
  threat.walkDrive = 0.4;
  for (let i = 0; i < 40; i++) fly.update(DT, BOUNDS, null, threat);
  const x = fly.model.foldedWings.children[0].rotation.x;
  return [fly.state !== 'flying' && fly.wingRaise > 0.6 && x < -0.2,
    `raise ${fly.wingRaise.toFixed(2)}, wing tilt ${x.toFixed(2)} rad`];
});

bodyCheck('landing is smooth: no scale/height snap at touchdown', () => {
  const fly = new Fly({ x: 0, y: 0 }, SEED);
  fly.state = asFlyState('idle');
  fly.startFlight({ bounds: BOUNDS, escape: true });
  let prevScale = fly.node.scale.x;
  let prevZ = fly.node.position.z;
  let maxDS = 0;
  let maxDZ = 0;
  let post = 20;
  let frames = 0;
  let landed = false;
  while (post > 0 && frames < 600) {
    frames++;
    fly.update(DT, BOUNDS, null, defaultSignals());
    maxDS = Math.max(maxDS, Math.abs(fly.node.scale.x - prevScale));
    maxDZ = Math.max(maxDZ, Math.abs(fly.node.position.z - prevZ));
    prevScale = fly.node.scale.x;
    prevZ = fly.node.position.z;
    if (fly.state !== 'flying') {
      landed = true;
      post--;
    }
  }
  return [landed && maxDS < 0.2 && maxDZ < 25,
    `landed=${landed ? 'yes' : 'NO'}, max per-frame dScale `
    + `${maxDS.toFixed(2)}, dz ${maxDZ.toFixed(1)}`];
});

bodyCheck('circadian curve: siesta + night dips, dawn/dusk peaks', () => {
  const night = circadianActivity(3);
  const dawn = circadianActivity(9);
  const siesta = circadianActivity(14);
  const dusk = circadianActivity(18);
  const ok = night < 0.4 && dawn > 0.9 && siesta < 0.7 && siesta > 0.3 && dusk > 0.9;
  return [ok, `3h ${night.toFixed(2)}, 9h ${dawn.toFixed(2)}, `
    + `14h ${siesta.toFixed(2)}, 18h ${dusk.toFixed(2)}`];
});

console.log(failures === 0 ? 'ALL BEHAVIOR TESTS PASS' : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
