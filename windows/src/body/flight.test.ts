import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fly } from './fly.ts';
import { FLY_SCALE } from './constants.ts';
import { defaultSignals } from '../core/types.ts';

const BOUNDS = { width: 1512, height: 982 };
const DT = 1 / 60;

test('altitude drives scale; escape flies higher than casual', () => {
  // main.swift:364-385
  function flight(escape: boolean, effort?: number) {
    const fly = new Fly({ x: 0, y: 0 }, 1);
    fly.state = 'idle';
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
  assert.ok(esc.alt > casual.alt + 0.15,
    `escape alt ${esc.alt} vs casual ${casual.alt}`);
  assert.ok(esc.scale > FLY_SCALE * 1.5, `escape scale ${esc.scale}`);
  // scale tracks altitude exactly: FLY_SCALE * (1 + 0.8 * alt)
  assert.ok(Math.abs(esc.scale - FLY_SCALE * (1 + 0.8 * esc.alt)) < 0.15);
});

test('wings actually beat in flight', () => {
  // main.swift:387-398
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'idle';
  fly.startFlight({ bounds: BOUNDS, effort: 0.8 });
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 30 && fly.state === 'flying'; i++) {
    fly.update(DT, BOUNDS, null, defaultSignals());
    const z = fly.model.foldedWings.children[0].rotation.z;
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  assert.ok(hi - lo > 0.25, `wing sweep ${hi - lo} rad over 0.5 s`);
});

test('escape-DN activity mid-flight raises wing-beat effort', () => {
  // main.swift:400-414 — live modifiers must never weaken takeoff
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'idle';
  fly.startFlight({ bounds: BOUNDS, effort: 0.5 });
  for (let i = 0; i < 12; i++) fly.update(DT, BOUNDS, null, defaultSignals());
  const calm = fly.effortCurrent;
  const hot = defaultSignals();
  hot.wingDrive = 1.0;
  hot.arousal = 0.6;
  for (let i = 0; i < 12 && fly.state === 'flying'; i++) {
    fly.update(DT, BOUNDS, null, hot);
  }
  assert.ok(fly.state === 'flying' && fly.effortCurrent > calm + 0.2,
    `effort ${calm} -> ${fly.effortCurrent}`);
});

test('threat while grounded raises the wings without taking off', () => {
  // main.swift:416-425
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'walking';
  fly.speed = 20;
  fly.dartCooldown = 99;            // isolate the posture from darting
  const threat = defaultSignals();
  threat.wingDrive = 0.9;
  threat.walkDrive = 0.4;
  for (let i = 0; i < 40; i++) fly.update(DT, BOUNDS, null, threat);
  const x = fly.model.foldedWings.children[0].rotation.x;
  assert.notEqual(fly.state, 'flying');
  assert.ok(fly.wingRaise > 0.6, `raise ${fly.wingRaise}`);
  assert.ok(x < -0.2, `wing tilt ${x} rad`);
});

test('landing is smooth: no scale or height snap at touchdown', () => {
  // main.swift:427-446 — landing must go through the flare, never snap
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'idle';
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
  assert.ok(landed, 'never landed');
  assert.ok(maxDS < 0.2, `max per-frame scale jump ${maxDS}`);
  assert.ok(maxDZ < 25, `max per-frame z jump ${maxDZ}`);
});

test('landing refolds the wings and hides the blur discs', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'idle';
  fly.startFlight({ bounds: BOUNDS, escape: true });
  assert.equal(fly.model.blurWingL.visible, true);
  let frames = 0;
  while (fly.state === 'flying' && frames < 600) {
    frames++;
    fly.update(DT, BOUNDS, null, defaultSignals());
  }
  assert.equal(fly.state, 'idle');
  assert.equal(fly.model.blurWingL.visible, false);
  assert.equal(fly.model.blurWingR.visible, false);
  assert.ok(Math.abs(fly.model.foldedWings.children[1].rotation.z - 0.13) < 1e-9);
  assert.equal(fly.alt, 0);
  assert.equal(fly.node.position.z, 0);
  assert.ok(Math.abs(fly.node.scale.x - FLY_SCALE) < 1e-12);
});

test('legacy path: no signals means mouse-distance fear', () => {
  // Extra, brainless flies (FlyModel.swift:405-427). A cursor inside
  // SCARE_RADIUS must launch a flight.
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'walking';
  fly.speed = 30;
  fly.update(DT, BOUNDS, { x: 40, y: 0 }, null);
  assert.equal(fly.state, 'flying');
});
