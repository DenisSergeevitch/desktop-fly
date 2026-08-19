import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Arena, toSceneRects, unionBounds } from './arena.ts';
import { makeRng } from './mathutil.ts';

// The development machine's real layout: a 2560x1440 primary at 150% and a
// 1536x960 secondary at 125%, offset DOWN by 633 px. Work areas, so the taskbar
// is excluded. This layout is the whole reason the arena cannot be one rectangle.
const PRIMARY = { x: 0, y: 0, width: 2560, height: 1392 };
const SECOND = { x: 2560, y: 633, width: 1536, height: 912 };

test('unionBounds is the bounding box of every display', () => {
  const b = unionBounds([PRIMARY, SECOND]);
  assert.deepEqual(b, { x: 0, y: 0, width: 4096, height: 1545 });
});

test('a single display gives back itself', () => {
  assert.deepEqual(unionBounds([PRIMARY]), PRIMARY);
});

test('screen rects convert to scene rects around the union centre', () => {
  // centre of the 4096x1545 box is screen (2048, 772.5); scene y is UP
  const [p, s] = toSceneRects([PRIMARY, SECOND]);
  assert.deepEqual(p, { x0: -2048, x1: 512, y0: -619.5, y1: 772.5 });
  assert.deepEqual(s, { x0: 512, x1: 2048, y0: -772.5, y1: 139.5 });
});

test('the arena reports the bounding box size, not the covered area', () => {
  const a = new Arena(toSceneRects([PRIMARY, SECOND]));
  assert.equal(a.width, 4096);
  assert.equal(a.height, 1545);
});

test('dead space between offset monitors is not inside the arena', () => {
  const a = new Arena(toSceneRects([PRIMARY, SECOND]));
  // screen (3000, 100): inside the bounding box, but above the secondary
  // monitor's top edge (y=633) and to the right of the primary. On no display.
  assert.equal(a.contains(3000 - 2048, 772.5 - 100), false);
  // screen (100, 1450): below the primary work area, left of the secondary
  assert.equal(a.contains(100 - 2048, 772.5 - 1450), false);
  // and two points that ARE on a display
  assert.equal(a.contains(100 - 2048, 772.5 - 100), true);
  assert.equal(a.contains(3000 - 2048, 772.5 - 1000), true);
});

test('a margin shrinks every rectangle', () => {
  const a = new Arena([{ x0: -100, x1: 100, y0: -50, y1: 50 }]);
  assert.equal(a.contains(95, 0), true);
  assert.equal(a.contains(95, 0, 20), false);
  assert.equal(a.contains(0, 0, 20), true);
});

test('clamp returns the point itself when already inside', () => {
  const a = new Arena(toSceneRects([PRIMARY, SECOND]));
  const p = a.clamp(-1000, 100);
  assert.deepEqual(p, { x: -1000, y: 100 });
});

test('clamp pushes a point in dead space onto the nearest display', () => {
  const a = new Arena(toSceneRects([PRIMARY, SECOND]));
  // screen (2700, 100) is just right of the primary and above the secondary.
  // The nearest covered point is the primary's right edge at the same height.
  const p = a.clamp(2700 - 2048, 772.5 - 100);
  assert.equal(a.contains(p.x, p.y), true);
  assert.ok(Math.abs(p.x - 512) < 1e-9, `expected the primary edge, got ${p.x}`);
  assert.equal(p.y, 772.5 - 100);
});

test('clamp keeps a point that leaves the whole arena inside it', () => {
  const a = new Arena(toSceneRects([PRIMARY, SECOND]));
  for (const [x, y] of [[-9999, 0], [9999, 0], [0, 9999], [0, -9999]]) {
    const p = a.clamp(x, y, 20);
    assert.equal(a.contains(p.x, p.y, 20 - 1e-6), true,
      `clamp(${x},${y}) landed outside the arena at ${p.x},${p.y}`);
  }
});

test('random points always land on a real display', () => {
  const a = new Arena(toSceneRects([PRIMARY, SECOND]));
  const rng = makeRng(7);
  let onSecondary = 0;
  for (let i = 0; i < 2000; i++) {
    const p = a.randomPoint(rng, 40);
    assert.equal(a.contains(p.x, p.y), true,
      `random point ${p.x},${p.y} is in dead space`);
    if (p.x > 512) onSecondary++;
  }
  // the secondary is about 28% of the covered area, so it must get a fair share
  assert.ok(onSecondary > 200 && onSecondary < 1200,
    `secondary share looks wrong: ${onSecondary}/2000`);
});

test('an empty arena degrades to a zero box without throwing', () => {
  const a = new Arena([]);
  assert.equal(a.width, 0);
  assert.equal(a.contains(0, 0), false);
  assert.deepEqual(a.clamp(5, 5), { x: 5, y: 5 });
  assert.deepEqual(unionBounds([]), { x: 0, y: 0, width: 0, height: 0 });
});
