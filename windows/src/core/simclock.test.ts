import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimClock } from './simclock.ts';

test('a 60 Hz frame yields 16 or 17 ms, averaging the true rate', () => {
  const c = new SimClock();
  let total = 0;
  for (let i = 0; i < 600; i++) {
    const ms = c.advance(1 / 60);
    assert.ok(ms === 16 || ms === 17, `got ${ms}`);
    total += ms;
  }
  // 600 frames at 1/60 s is 10 s; the accumulator must not drift
  assert.ok(Math.abs(total - 10_000) <= 1, `accumulated ${total} ms over 10 s`);
});

test('fractional milliseconds accumulate rather than being lost', () => {
  const c = new SimClock();
  let total = 0;
  for (let i = 0; i < 1000; i++) total += c.advance(0.0004);   // 0.4 ms frames
  assert.ok(Math.abs(total - 400) <= 1, `accumulated ${total} ms, expected ~400`);
});

test('a long hitch is clamped to 50 ms so the sim never chases the renderer', () => {
  const c = new SimClock();
  assert.equal(c.advance(2.0), 50);
  // the surplus is discarded, not banked: the next frame is normal
  assert.ok(c.advance(1 / 60) <= 17);
});

test('zero and negative dt produce no steps', () => {
  const c = new SimClock();
  assert.equal(c.advance(0), 0);
  assert.equal(c.advance(-1), 0);
});

test('reset drops the pending fraction', () => {
  const c = new SimClock();
  c.advance(0.0009);              // 0.9 ms banked, 0 returned
  c.reset();
  assert.equal(c.advance(0.0005), 0, 'the banked 0.9 ms should be gone');
});
