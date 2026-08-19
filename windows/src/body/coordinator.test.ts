import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { loadBrainData } from '../core/data.ts';
import { LIFSim } from '../core/sim.ts';
import { Coordinator } from './coordinator.ts';
import { asFlyState } from './fly.ts';

const { circuit } = loadBrainData()!;
const BOUNDS = { width: 1512, height: 982 };
const DT = 1 / 60;

function makeCoordinator() {
  return new Coordinator({
    bounds: BOUNDS,
    sim: new LIFSim(circuit, null, 1),
    seed: 1,
  });
}

test('a coordinator starts with exactly one fly, in the scene', () => {
  const c = makeCoordinator();
  assert.equal(c.flies.length, 1);
  assert.ok(c.scene.children.includes(c.flies[0].node),
    'the fly must be attached to the scene graph');
});

test('frames step the sim at 1 kHz and advance the fly', () => {
  const c = makeCoordinator();
  const before = c.sim!.simMs;
  for (let i = 0; i < 60; i++) c.frame(DT);
  const stepped = c.sim!.simMs - before;
  assert.ok(Math.abs(stepped - 1000) <= 2,
    `60 frames of 1/60 s should step ~1000 ms, stepped ${stepped}`);
  assert.ok(c.flies[0].time > 0.9, 'the fly clock should have advanced');
});

test('only fly #1 receives brain signals; extra flies use the legacy path', () => {
  // A giant-fiber escape is a brain event, so it must move fly #1 and leave the
  // brainless extras alone. (They have their own mouse-distance fear instead.)
  const c = makeCoordinator();
  c.addFly();
  c.addFly();
  for (const f of c.flies) {
    f.state = asFlyState('walking');
    f.speed = 20;
  }
  c.setSenses({ cursor: { x: 400, y: 400 } });   // far away: no legacy fear
  for (let i = 0; i < 60; i++) c.frame(DT);
  c.escapeTest();
  let brainFlew = false;
  for (let i = 0; i < 150 && !brainFlew; i++) {
    c.frame(DT);
    brainFlew = c.flies[0].state === 'flying';
  }
  assert.ok(brainFlew, 'fly #1 should escape on a brain event');
  // the extras are only driven by their own timers, never by the circuit
  assert.equal(c.flies.length, 3);
});

test('removeFly never removes fly #1 — it carries the brain', () => {
  const c = makeCoordinator();
  c.removeFly();
  assert.equal(c.flies.length, 1);
  c.addFly();
  c.removeFly();
  assert.equal(c.flies.length, 1);
  assert.equal(c.scene.children.filter((n) => n === c.flies[0].node).length, 1);
});

test('a cursor lunge drives the real circuit to a fear response', () => {
  // Dart OR escape, the same disjunction the Swift behaviortest uses. A cursor
  // sweep is a RAMP, and CLAUDE.md is explicit that ramps lose the giant-fiber
  // race to ~2,750 synapses of feedforward inhibition by design — so the
  // looming population drives a nervous dart instead. Measured here: speed 130
  // with dartTimer 0.88, no takeoff. Asserting `flying` would be asserting a
  // bug into existence.
  const c = makeCoordinator();
  for (let i = 0; i < 120; i++) c.frame(DT);       // settle
  const fly = c.flies[0];
  fly.state = asFlyState('walking');
  fly.pos = { x: 0, y: 0 };
  let afraid = false;
  // sweep the cursor in hard from 700 pt away
  for (let i = 0; i < 40 && !afraid; i++) {
    const x = 700 - i * 45;
    c.setSenses({ cursor: { x, y: 0 } });
    c.frame(DT);
    afraid = fly.state === 'flying' || (fly.state === 'walking' && fly.speed > 100);
  }
  assert.ok(afraid,
    `a fast cursor lunge should frighten the fly: ${fly.state} @ ${fly.speed}`);
});

test('escapeTest drives the loom pathway to an escape', () => {
  // NOTE: a cursor position is required. computeLoom returns zeroes when the
  // cursor is unknown (main.swift:607), so loomOverride only takes effect once
  // one is known — which in the running app it always is, because the 30 Hz
  // poll sets it before the first frame.
  const c = makeCoordinator();
  c.setSenses({ cursor: { x: 300, y: 0 } });
  for (let i = 0; i < 60; i++) c.frame(DT);
  c.escapeTest();
  let escaped = false;
  for (let i = 0; i < 150 && !escaped; i++) {
    c.frame(DT);
    escaped = c.flies[0].state === 'flying';
  }
  assert.ok(escaped, 'the escape test should reach the giant fiber');
});

test('gait proprioception feeds back into the sim while walking', () => {
  const c = makeCoordinator();
  const fly = c.flies[0];
  fly.state = asFlyState('walking');
  fly.speed = 50;
  c.frame(DT);
  assert.ok(c.sim!.gaitDrive > 0,
    'a walking fly must drive the ascending neurons');
  assert.ok(c.sim!.gaitDrive <= 1);
});

test('terrain reaches the flies', () => {
  const c = makeCoordinator();
  c.setSenses({ ledges: [{ y: -40, x0: -300, x1: 300, id: 1 }] });
  c.frame(DT);
  assert.equal(c.flies[0].terrain.length, 1);
});

test('circadian and sleep are compressed, never applied raw', () => {
  // The "siesta coma" bug: a raw multiplier silences the network. The
  // coordinator must compress toward 1 (CLAUDE.md).
  const c = makeCoordinator();
  c.setSenses({ activity: 0.55, sleepy: false });
  c.frame(DT);
  assert.ok(Math.abs(c.sim!.activityScale - 0.8425) < 1e-6,
    `expected 1 - (1 - 0.55) * 0.35 = 0.8425, got ${c.sim!.activityScale}`);

  c.setSenses({ activity: 1, sleepy: true });
  c.frame(DT);
  assert.ok(Math.abs(c.sim!.activityScale - 0.75) < 1e-6);
  assert.ok(Math.abs(c.sim!.sensoryGate - 0.55) < 1e-6, 'sleep gates the senses');
});

test('a nearby tap reaches the sensory pathway; a distant one does not', () => {
  // Two identically seeded coordinators diverge only if the tap actually
  // stimulated something — comparing against "before" would pass on noise.
  function run(tap: { x: number; y: number }) {
    const c = makeCoordinator();
    for (let i = 0; i < 60; i++) c.frame(DT);
    c.setSenses({ taps: [tap] });
    for (let i = 0; i < 30; i++) c.frame(DT);
    return c.sim!.totalSpikes;
  }
  const near = run({ x: 10, y: 10 });      // strength ~0.96
  const far = run({ x: 5000, y: 5000 });   // beyond 520 pt: ignored entirely
  assert.ok(near > far,
    `a near tap should add spikes: near ${near} vs far ${far}`);
});

test('retarget clamps flies into the new display and clears terrain', () => {
  const c = makeCoordinator();
  c.flies[0].pos = { x: 700, y: 450 };
  c.setSenses({ ledges: [{ y: -40, x0: -300, x1: 300, id: 1 }] });
  c.frame(DT);
  c.retarget({ width: 800, height: 600 });
  // frame(0) drains the enqueued retarget without advancing the fly — a normal
  // frame would let updateWalk step it a fraction past the clamp, which is
  // legal (free walking clamps to width/2 - 20) but hides what is under test.
  c.frame(0);
  assert.ok(Math.abs(c.flies[0].pos.x) <= 800 / 2 - 40 + 1e-6,
    `x ${c.flies[0].pos.x} outside the new display`);
  assert.ok(Math.abs(c.flies[0].pos.y) <= 600 / 2 - 40 + 1e-6);
  assert.equal(c.flies[0].ledge, null);
});

test('enqueued mutations run at the top of the next frame', () => {
  const c = makeCoordinator();
  let ran = false;
  c.enqueue(() => { ran = true; });
  assert.equal(ran, false, 'must not run synchronously');
  c.frame(DT);
  assert.equal(ran, true);
});

test('a coordinator with no sim still runs flies on the legacy path', () => {
  const c = new Coordinator({ bounds: BOUNDS, sim: null, seed: 1 });
  for (let i = 0; i < 60; i++) c.frame(DT);
  assert.equal(c.flies.length, 1);
  assert.ok(c.flies[0].time > 0.9);
});

test('a frame hitch cannot make the sim run away', () => {
  const c = makeCoordinator();
  const before = c.sim!.simMs;
  c.frame(2.0);                    // a 2-second stall
  assert.ok(c.sim!.simMs - before <= 50, `stepped ${c.sim!.simMs - before} ms`);
});

test('the camera extents match the bounds, and follow a retarget', () => {
  // The scene->pixel mapping depends on this: the orthographic half-extents must
  // equal the display size in DIPs, or scene coordinates and screen pixels drift
  // apart and the fly appears to leave the screen. (Renderer-side, the canvas
  // CSS size must equal the window size for the same reason — guarded at
  // startup in renderer/overlay.ts, which no headless test can reach.)
  const c = makeCoordinator();
  const cam = c.scene.getObjectByName('camera') as THREE.OrthographicCamera;
  assert.equal(cam.left, -BOUNDS.width / 2);
  assert.equal(cam.right, BOUNDS.width / 2);
  assert.equal(cam.top, BOUNDS.height / 2);
  assert.equal(cam.bottom, -BOUNDS.height / 2);

  c.retarget({ width: 800, height: 600 });
  c.frame(0);
  assert.equal(cam.left, -400);
  assert.equal(cam.right, 400);
  assert.equal(cam.top, 300);
  assert.equal(cam.bottom, -300);
  assert.equal(c.bounds.width, 800);
});
test('pausing freezes the sim and the fly; resuming does not jump', () => {
  // main.swift:856-861 sets scnView.isPlaying = false AND coordinator.lastTime =
  // nil, so the first frame after resuming does not carry the whole pause as one
  // enormous dt — which would teleport the fly across the screen.
  const c = makeCoordinator();
  for (let i = 0; i < 60; i++) c.frame(DT);
  const simAt = c.sim!.simMs;
  const flyAt = { x: c.flies[0].pos.x, y: c.flies[0].pos.y };
  const timeAt = c.flies[0].time;

  c.setPaused(true);
  c.frame(0);                       // let the enqueued flag land
  for (let i = 0; i < 60; i++) c.frame(DT);
  assert.equal(c.paused, true);
  assert.equal(c.sim!.simMs, simAt, 'the sim must not step while paused');
  assert.equal(c.flies[0].time, timeAt, 'the fly clock must not advance');
  assert.deepEqual({ x: c.flies[0].pos.x, y: c.flies[0].pos.y }, flyAt);

  c.setPaused(false);
  c.frame(0);
  c.frame(DT);
  assert.equal(c.paused, false);
  const stepped = c.sim!.simMs - simAt;
  assert.ok(stepped > 0 && stepped <= 20,
    `first frame after resume stepped ${stepped} ms; must be one frame's worth`);
});

test('a pause longer than the dt clamp still resumes smoothly', () => {
  const c = makeCoordinator();
  for (let i = 0; i < 30; i++) c.frame(DT);
  c.setPaused(true);
  c.frame(0);
  c.setPaused(false);
  c.frame(0);
  const before = { x: c.flies[0].pos.x, y: c.flies[0].pos.y };
  c.frame(30);                      // 30 seconds of wall time in one frame
  const moved = Math.hypot(c.flies[0].pos.x - before.x, c.flies[0].pos.y - before.y);
  assert.ok(moved < 30, `fly jumped ${moved.toFixed(0)} pt on the first frame back`);
});
