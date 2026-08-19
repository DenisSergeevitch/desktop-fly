import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrainData } from './data.ts';
import { LIFSim } from './sim.ts';
import { nearestToRay, pickCluster, regionName } from './pick.ts';

const { circuit } = loadBrainData()!;
const sim = new LIFSim(circuit, null, 1);

test('a ray aimed at a neuron picks that neuron', () => {
  // BrainView.swift:272-280 — perpendicular distance to the ray, not to the
  // camera, so a neuron behind another is still reachable.
  const target = 100;
  const p = {
    x: sim.positions[3 * target],
    y: sim.positions[3 * target + 1],
    z: sim.positions[3 * target + 2],
  };
  // fire from far away straight at it
  const origin = { x: p.x, y: p.y, z: p.z + 50 };
  const dir = { x: 0, y: 0, z: -1 };
  assert.equal(nearestToRay(sim.positions, sim.n, origin, dir), target);
});

test('picking is by perpendicular distance, not depth', () => {
  const positions = new Float32Array([
    0, 0, 0,        // 0: dead centre, far from the ray
    5, 0, -20,      // 1: exactly on the ray but much further away
  ]);
  const origin = { x: 5, y: 0, z: 20 };
  const dir = { x: 0, y: 0, z: -1 };
  assert.equal(nearestToRay(positions, 2, origin, dir), 1);
});

test('an unnormalized direction still works', () => {
  const positions = new Float32Array([0, 0, 0, 10, 0, 0]);
  const origin = { x: 10, y: 5, z: 0 };
  assert.equal(nearestToRay(positions, 2, origin, { x: 0, y: -7, z: 0 }), 1);
});

test('a cluster is everything within 2.2 units of the anchor', () => {
  // BrainView.swift:283
  const positions = new Float32Array([
    0, 0, 0,      // anchor
    1, 0, 0,      // inside
    2, 0, 0,      // inside
    3, 0, 0,      // outside
    0, 2.1, 0,    // inside
  ]);
  const picked = pickCluster(positions, 5, 0);
  assert.deepEqual([...picked].sort((a, b) => a - b), [0, 1, 2, 4]);
});

test('a sparse anchor still yields at least 4 neurons', () => {
  // BrainView.swift:284-287 — otherwise clicking empty space does nothing at all
  const positions = new Float32Array([
    0, 0, 0,
    50, 0, 0,
    0, 50, 0,
    0, 0, 50,
    100, 100, 100,
    -100, 0, 0,
    0, -100, 0,
  ]);
  const picked = pickCluster(positions, 7, 0);
  assert.equal(picked.length, 6, 'falls back to the 6 nearest');
  assert.ok(picked.includes(0));
});

test('a dense anchor is capped at 60 neurons, nearest first', () => {
  // BrainView.swift:288-292
  const n = 200;
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) positions[3 * i] = i * 0.01;   // all within 2 units
  const picked = pickCluster(positions, n, 0);
  assert.equal(picked.length, 60);
  assert.deepEqual(picked.slice(0, 3), [0, 1, 2], 'nearest first');
});

test('clicking the real giant fiber picks it and names it', () => {
  const gf = sim.gf[0];
  const picked = pickCluster(sim.positions, sim.n, gf);
  assert.ok(picked.includes(gf));
  const name = regionName(sim.roles, sim.types, sim.positions, [gf, sim.gf[1]]);
  assert.match(name, /Giant Fiber/);
  assert.match(name, /escape/);
});

test('region names follow the majority role', () => {
  const roles = ['lc4', 'lc4', 'lc4', 'other'];
  const types = ['LC4', 'LC4', 'LC4', 'central'];
  const positions = new Float32Array(12);
  assert.match(regionName(roles, types, positions, [0, 1, 2, 3]),
    /Looming detectors/);

  const walk = regionName(['dnp09', 'dnp09'], ['DNp09', 'DNp09'],
    new Float32Array(6), [0, 1]);
  assert.match(walk, /Walking command/);

  const groom = regionName(['dng11'], ['DNg11'], new Float32Array(3), [0]);
  assert.match(groom, /Grooming command/);

  const moon = regionName(['mdn'], ['MDN'], new Float32Array(3), [0]);
  assert.match(moon, /Moonwalker/);
});

test('a lopsided pick gets a side suffix, a balanced one does not', () => {
  // BrainView.swift:304-308 — x < 0 is the left side
  const roles = ['dna01', 'dna01', 'dna01'];
  const types = ['DNa01', 'DNa01', 'DNa01'];
  const left = new Float32Array([-5, 0, 0, -6, 0, 0, -7, 0, 0]);
  assert.match(regionName(roles, types, left, [0, 1, 2]), /left/);

  const right = new Float32Array([5, 0, 0, 6, 0, 0, 7, 0, 0]);
  assert.match(regionName(roles, types, right, [0, 1, 2]), /right/);

  const both = new Float32Array([-5, 0, 0, 5, 0, 0]);
  const name = regionName(['dna01', 'dna01'], ['DNa01', 'DNa01'], both, [0, 1]);
  assert.doesNotMatch(name, /left|right/);
});

test('a partner-dominated pick is named by its super-class', () => {
  const name = regionName(['other', 'other'], ['ascending', 'ascending'],
    new Float32Array(6), [0, 1]);
  assert.match(name, /ascending/);
  // an empty or unknown type must not produce a blank label
  const blank = regionName(['other'], [''], new Float32Array(3), [0]);
  assert.match(blank, /central/);
});
