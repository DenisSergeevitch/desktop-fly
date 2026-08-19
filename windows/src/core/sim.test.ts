import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrainData } from './data.ts';
import { LIFSim, SpikeBus } from './sim.ts';

const { circuit } = loadBrainData()!;
const WEIGHT_SCALE = 0.0008;
const GAP_JUNCTION_BOOST = 6;

test('populations are grouped by role and side', () => {
  const sim = new LIFSim(circuit, null, 1);
  assert.equal(sim.n, 668);
  assert.equal(sim.loomLeft.length + sim.loomRight.length, 314);
  assert.equal(sim.gf.length, 2);
  assert.equal(sim.dnaL.length, 2);   // DNa01 + DNa02, left
  assert.equal(sim.dnaR.length, 2);   // DNa01 + DNa02, right
  assert.equal(sim.mdn.length, 4);
  assert.equal(sim.fwd.length, 2);
  assert.equal(sim.groom.length, 6);
  assert.equal(sim.escw.length, 6);
  assert.equal(sim.ascend.length, 27);
  assert.equal(sim.sens.length, 16);
  // no neuron lands in two loom groups
  assert.equal(new Set([...sim.loomLeft, ...sim.loomRight]).size, 314);
});

test('command DNs get deterministic, side-symmetric baselines', () => {
  // Sim.swift:199-210 — asymmetry must come from wiring, not from luck,
  // so the two sides must be seed-independent and identical.
  for (const seed of [1, 2, 3]) {
    const sim = new LIFSim(circuit, null, seed);
    const at = (i: number) => sim.baselineAt(i);
    for (const i of [...sim.dnaL, ...sim.dnaR, ...sim.mdn, ...sim.groom,
                     ...sim.escw]) {
      assert.equal(at(i), Math.fround(0.036));
    }
    for (const i of sim.fwd) assert.equal(at(i), Math.fround(0.038));
    for (const i of sim.gf) assert.equal(at(i), Math.fround(0.002));
    for (const i of [...sim.loomLeft, ...sim.loomRight]) {
      assert.equal(at(i), Math.fround(0.004));
    }
  }
});

test('CSR adjacency holds every edge exactly once', () => {
  const sim = new LIFSim(circuit, null, 1);
  let total = 0;
  for (let i = 0; i < sim.n; i++) total += sim.outDegree(i);
  assert.equal(total, circuit.edges.length);
  // spot-check one row against the raw edge list
  const pre = circuit.edges[0][0];
  const expected = circuit.edges.filter((e) => e[0] === pre).length;
  assert.equal(sim.outDegree(pre), expected);
});

test('electrical drive onto the giant fiber is boosted, chemical is not', () => {
  const sim = new LIFSim(circuit, null, 1);
  const isGF = (i: number) => sim.roles[i] === 'gf';
  const isLoom = (i: number) => sim.roles[i] === 'lc4' || sim.roles[i] === 'lplc2';

  const boosted = circuit.edges.find((e) => isLoom(e[0]) && isGF(e[1]))!;
  assert.equal(
    sim.edgeWeight(boosted[0], boosted[1]),
    Math.fround(boosted[2] * WEIGHT_SCALE * GAP_JUNCTION_BOOST),
  );

  // a loom -> non-GF edge must carry the plain weight
  const plain = circuit.edges.find((e) => isLoom(e[0]) && !isGF(e[1]))!;
  assert.equal(
    sim.edgeWeight(plain[0], plain[1]),
    Math.fround(plain[2] * WEIGHT_SCALE),
  );

  assert.equal(sim.edgeWeight(0, 0), null);   // absent edge
});

test('SpikeBus drains and caps at 256 events', () => {
  const bus = new SpikeBus();
  bus.push([{ neuron: 7, isGF: true }]);
  assert.deepEqual(bus.popAll(), [{ neuron: 7, isGF: true }]);
  assert.deepEqual(bus.popAll(), []);

  bus.push(Array.from({ length: 300 },
    (_, i) => ({ neuron: i, isGF: false })));
  const drained = bus.popAll();
  assert.equal(drained.length, 256);
  assert.equal(drained[0].neuron, 44);   // oldest 44 dropped
});
