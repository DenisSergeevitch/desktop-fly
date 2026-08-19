import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputSense, isSleepy } from './idle.ts';

test('sleep needs either a long night idle or a very long idle', () => {
  // Environment.swift + main.swift:774
  assert.equal(isSleepy(700, 23), true, 'idle at night');
  assert.equal(isSleepy(700, 3), true, 'idle in the small hours');
  assert.equal(isSleepy(700, 14), false, 'the same idle at 2pm is just a break');
  assert.equal(isSleepy(2000, 14), true, 'half an hour idle sleeps any time');
  assert.equal(isSleepy(100, 23), false, 'briefly idle at night is not sleep');
  // the night window is 22:00-06:00 inclusive of 22, exclusive of 6
  assert.equal(isSleepy(700, 22), true);
  assert.equal(isSleepy(700, 21.9), false);
  assert.equal(isSleepy(700, 5.9), true);
  assert.equal(isSleepy(700, 6), false);
});

test('idle seconds come from the tick difference', () => {
  const s = new InputSense();
  const out = s.sample(1_000_000, 1_004_500, { x: 0, y: 0 });
  assert.equal(out.idleSeconds, 4.5);
});

test('input with a still cursor is read as typing; input with movement is not', () => {
  // The substitution for macOS's keyboard-only idle query. It preserves the
  // privacy property exactly: we learn WHEN keys were pressed, never which.
  const s = new InputSense();
  s.sample(1000, 1000, { x: 10, y: 10 });          // prime

  // last input advanced, cursor unchanged => keyboard
  const typed = s.sample(1100, 1100, { x: 10, y: 10 });
  assert.equal(typed.keyboardActive, true);
  assert.ok(typed.typing > 0, `typing level ${typed.typing}`);

  // last input advanced, cursor moved => mouse, not typing
  const moved = new InputSense();
  moved.sample(1000, 1000, { x: 10, y: 10 });
  const out = moved.sample(1100, 1100, { x: 40, y: 10 });
  assert.equal(out.keyboardActive, false);
});

test('the typing level rises and decays smoothly', () => {
  const s = new InputSense();
  let tick = 1000;
  s.sample(tick, tick, { x: 0, y: 0 });
  // 30 polls of steady typing
  for (let i = 0; i < 30; i++) {
    tick += 100;
    s.sample(tick, tick, { x: 0, y: 0 });
  }
  const hot = s.typing;
  assert.ok(hot > 0.8, `sustained typing should approach 1, got ${hot}`);

  // then 60 polls of nothing: the tick stops advancing
  let out = { typing: hot };
  for (let i = 0; i < 60; i++) out = s.sample(tick, tick + 1000 * i, { x: 0, y: 0 });
  assert.ok(out.typing < 0.2, `typing should decay, got ${out.typing}`);
  assert.ok(out.typing >= 0);
});
