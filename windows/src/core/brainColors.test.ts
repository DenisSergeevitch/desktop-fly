import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrainData } from './data.ts';
import { roleColor, superClassColor, SUPER_CLASS_COLORS } from './brainColors.ts';

test('there is a colour for every super-class the ETL emits', () => {
  // etl.py:143 lists nine; data/brain_points.json carries the same list, and a
  // point whose classIndex has no colour would render as a grey smudge.
  const { points } = loadBrainData()!;
  assert.equal(points.classes.length, 9);
  assert.equal(SUPER_CLASS_COLORS.length, points.classes.length);
});

test('every point in the real data maps to a defined colour', () => {
  const { points } = loadBrainData()!;
  const seen = new Set<number>();
  for (const p of points.points) seen.add(p[3]);
  for (const ci of seen) {
    const c = superClassColor(ci);
    assert.equal(c.length, 3);
    assert.ok(c.every((v) => v >= 0 && v <= 1), `class ${ci} colour out of range`);
  }
  // optic dominates the cloud and is deliberately the dimmest, so the rest read
  const optic = superClassColor(0);
  const descending = superClassColor(5);
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  assert.ok(lum(optic) < lum(descending),
    'optic must stay subtler than descending');
});

test('an out-of-range class index falls back instead of throwing', () => {
  assert.deepEqual(superClassColor(99).length, 3);
  assert.deepEqual(superClassColor(-1).length, 3);
});

test('every circuit role has its own distinguishable colour', () => {
  // BrainView.swift:81-90. Clicking a region should be identifiable by colour,
  // so no two roles may share one.
  const roles = ['lc4', 'lplc2', 'gf', 'dna01', 'dna02', 'dnp09', 'dng11',
    'mdn', 'escw', 'other'];
  const seen = new Map<string, string>();
  for (const r of roles) {
    const key = roleColor(r).map((v) => v.toFixed(3)).join(',');
    // lc4 and lplc2 intentionally share one colour: they are one population
    if (r === 'lplc2') {
      assert.equal(key, seen.get('lc4'), 'lc4 and lplc2 should look alike');
      continue;
    }
    if (r === 'dna02') {
      assert.equal(key, seen.get('dna01'), 'DNa01 and DNa02 are one group');
      continue;
    }
    assert.equal(seen.has(key), false, `${r} reuses another role's colour`);
    seen.set(key, key);
    seen.set(r, key);
  }
  // the giant fiber is the brightest thing in the circuit
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  for (const r of roles.filter((x) => x !== 'gf')) {
    assert.ok(lum(roleColor('gf')) > lum(roleColor(r)),
      `GF should outshine ${r}`);
  }
});

test('an unknown role gets the neutral partner colour', () => {
  assert.deepEqual(roleColor('nonsense'), roleColor('other'));
});
