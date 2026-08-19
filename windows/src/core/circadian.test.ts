import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circadianActivity } from './circadian.ts';

test('Drosophila rhythm: dawn and dusk peaks, midday siesta, night quiet', () => {
  // The four assertions the Swift --behaviortest makes (main.swift:448-453).
  const night = circadianActivity(3);
  const dawn = circadianActivity(9);
  const siesta = circadianActivity(14);
  const dusk = circadianActivity(18);
  assert.ok(night < 0.4, `night ${night}`);
  assert.ok(dawn > 0.9, `dawn ${dawn}`);
  assert.ok(siesta > 0.3 && siesta < 0.7, `siesta ${siesta}`);
  assert.ok(dusk > 0.9, `dusk ${dusk}`);
});

test('interpolates linearly between knot points', () => {
  assert.equal(circadianActivity(8), 1.0);                     // exact knot
  assert.ok(Math.abs(circadianActivity(13) - 0.55) < 1e-9);    // exact knot
  const mid = circadianActivity(11.5);          // halfway 10 -> 13
  assert.ok(Math.abs(mid - 0.775) < 1e-6, `${mid}`);
});

test('is defined across the whole day and outside it', () => {
  for (let h = 0; h <= 24; h += 0.25) {
    const a = circadianActivity(h);
    assert.ok(a > 0 && a <= 1, `hour ${h} gave ${a}`);
  }
  assert.equal(circadianActivity(-1), 0.25);
  assert.equal(circadianActivity(99), 0.25);
});
