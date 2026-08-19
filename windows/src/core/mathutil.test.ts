import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angleDiff, smoothstep, clampf, makeRng, rnd } from './mathutil.ts';

test('angleDiff returns the shortest signed turn', () => {
  // FlyModel.swift:16-21
  assert.ok(Math.abs(angleDiff(0, 0.5) - 0.5) < 1e-12);
  assert.ok(Math.abs(angleDiff(0.5, 0) + 0.5) < 1e-12);
  // wrapping: from just under 2pi to just over 0 is a small positive turn
  const d = angleDiff(Math.PI * 2 - 0.1, 0.1);
  assert.ok(Math.abs(d - 0.2) < 1e-9, `${d}`);
  // never returns more than half a turn
  for (let a = -10; a < 10; a += 0.37) {
    for (let b = -10; b < 10; b += 0.41) {
      assert.ok(Math.abs(angleDiff(a, b)) <= Math.PI + 1e-9);
    }
  }
});

test('smoothstep is clamped, symmetric, and flat at both ends', () => {
  // FlyModel.swift:22
  assert.equal(smoothstep(-5), 0);
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(0.5), 0.5);
  assert.equal(smoothstep(1), 1);
  assert.equal(smoothstep(5), 1);
  assert.ok(Math.abs(smoothstep(0.25) + smoothstep(0.75) - 1) < 1e-12);
  // monotonic
  let prev = -1;
  for (let t = 0; t <= 1; t += 0.05) {
    const v = smoothstep(t);
    assert.ok(v >= prev);
    prev = v;
  }
});

test('clampf and the seeded rng still behave (M1 regression)', () => {
  assert.equal(clampf(5, 0, 1), 1);
  const a = makeRng(42);
  const b = makeRng(42);
  assert.equal(a(), b());
  const r = makeRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = rnd(r, -3, 9);
    assert.ok(v >= -3 && v < 9);
  }
});
