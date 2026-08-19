import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fly, asFlyState } from './fly.ts';
import { defaultSignals } from '../core/types.ts';

const BOUNDS = { width: 1512, height: 982 };
const DT = 1 / 60;

test('a GF spike takes off immediately, even out of sleep', () => {
  for (const from of ['idle', 'walking', 'grooming', 'sleeping'] as const) {
    const fly = new Fly({ x: 0, y: 0 }, 1);
    fly.state = from;
    const s = defaultSignals();
    s.escape = true;
    fly.update(DT, BOUNDS, null, s);
    assert.equal(fly.state, 'flying', `escape failed from ${from}`);
  }
});

test('sleep holds the fly still and waking triggers grooming', () => {
  // main.swift:340-349
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = asFlyState('idle');
  const s = defaultSignals();
  s.sleep = true;
  for (let i = 0; i < 60; i++) fly.update(DT, BOUNDS, null, s);
  assert.equal(fly.state, 'sleeping');
  assert.equal(fly.speed, 0);
  s.sleep = false;
  fly.update(DT, BOUNDS, null, s);
  assert.equal(fly.state, 'grooming');
});

test('walk drive starts and stops walking with hysteresis', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = asFlyState('idle');
  fly.speed = 0;
  const go = defaultSignals();
  go.walkDrive = 0.6;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, go);
  assert.equal(fly.state, 'walking');
  assert.ok(fly.speed > 40 && fly.speed < 100, `speed ${fly.speed}`);

  const stop = defaultSignals();
  stop.walkDrive = 0.05;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, stop);
  assert.equal(fly.state, 'idle');
  assert.equal(fly.speed, 0);
});

test('groom drive has a dead band between 0.3 and 0.5', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = asFlyState('idle');
  const mid = defaultSignals();
  mid.groomDrive = 0.4;              // inside the dead band: no change
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, mid);
  assert.equal(fly.state, 'idle');

  const on = defaultSignals();
  on.groomDrive = 0.6;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, on);
  assert.equal(fly.state, 'grooming');

  const off = defaultSignals();
  off.groomDrive = 0.2;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, off);
  assert.equal(fly.state, 'idle');
});

test('tempo scales walking speed', () => {
  // main.swift:351-362
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = asFlyState('walking');
  fly.speed = 20;
  fly.heading = 0;
  const cool = defaultSignals();
  cool.walkDrive = 0.6;
  cool.tempo = 1.0;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, cool);
  const coolSpeed = fly.speed;
  const hot = defaultSignals();
  hot.walkDrive = 0.6;
  hot.tempo = 1.5;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, hot);
  assert.ok(fly.state === 'walking' && fly.speed > coolSpeed + 10,
    `cool ${coolSpeed} -> hot ${fly.speed} pt/s`);
});

test('a hot looming population darts the fly away from the cursor', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = asFlyState('idle');
  const s = defaultSignals();
  s.nervous = 0.8;
  fly.update(DT, BOUNDS, { x: 100, y: 0 }, s);
  assert.equal(fly.state, 'walking');
  assert.ok(fly.speed > 100, `dart speed ${fly.speed}`);
  // heading points away from the cursor: cos(heading) should be negative
  assert.ok(Math.cos(fly.heading) < 0.4, `heading ${fly.heading} not away`);
});

test('MDN backward bursts fire from every grounded state', () => {
  // MDN was once dead from idle — regression guard
  for (const from of ['idle', 'walking', 'grooming'] as const) {
    const fly = new Fly({ x: 0, y: 0 }, 1);
    fly.state = from;
    const s = defaultSignals();
    s.backward = true;
    fly.update(DT, BOUNDS, null, s);
    assert.ok(fly.backwardTimer > 0, `MDN dead from ${from}`);
  }
});

test('turnBias steers while walking but not while on a ledge', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = asFlyState('walking');
  fly.speed = 30;
  fly.heading = 0;
  const s = defaultSignals();
  s.walkDrive = 0.6;
  s.turnBias = 0.9;
  for (let i = 0; i < 84; i++) fly.update(DT, BOUNDS, null, s);
  assert.ok(fly.heading > 0.25, `heading change ${fly.heading} rad`);

  const onLedge = new Fly({ x: 0, y: -40 }, 1);
  onLedge.state = asFlyState('walking');
  onLedge.speed = 30;
  onLedge.heading = 0;
  onLedge.terrain = [{ y: -40, x0: -300, x1: 300, id: 1 }];
  onLedge.ledge = onLedge.terrain[0];
  for (let i = 0; i < 30; i++) onLedge.update(DT, BOUNDS, null, s);
  assert.ok(Math.abs(onLedge.heading) < 0.25,
    `ledge walking should not be steered: ${onLedge.heading}`);
});

test('high arousal makes spontaneous takeoff likely', () => {
  const fly = new Fly({ x: 0, y: 0 }, 5);
  fly.state = asFlyState('walking');
  fly.speed = 40;
  const s = defaultSignals();
  s.walkDrive = 0.6;
  s.arousal = 0.9;
  // flightChance 0.6/s => ~1% per frame; 600 frames leaves a 0.2% miss rate,
  // where 300 would fail roughly 1 run in 20.
  let took = false;
  for (let i = 0; i < 600 && !took; i++) {
    fly.update(DT, BOUNDS, null, s);
    took = fly.state === 'flying';
  }
  assert.ok(took, 'aroused fly never took off in 10 s');
});
