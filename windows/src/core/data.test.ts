import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrainData } from './data.ts';

test('data/ loads and matches the counts the README claims', () => {
  const data = loadBrainData();
  assert.ok(data, 'data/ not found — run from the repo or windows/ directory');
  assert.equal(data.circuit.neurons.length, 668);
  assert.equal(data.circuit.edges.length, 18968);
  assert.equal(data.points.points.length, 23210);
});

test('role census matches the neuron -> behavior mapping', () => {
  const { circuit } = loadBrainData()!;
  const census: Record<string, number> = {};
  for (const n of circuit.neurons) census[n.role] = (census[n.role] ?? 0) + 1;
  assert.deepEqual(census, {
    lc4: 104, lplc2: 210, gf: 2, dna01: 2, dna02: 2,
    dnp09: 2, dng11: 6, mdn: 4, escw: 6, other: 330,
  });
  const partners = circuit.neurons.filter((n) => n.role === 'other');
  assert.equal(partners.filter((n) => n.type === 'ascending').length, 27);
  assert.equal(partners.filter((n) => n.type === 'sensory').length, 16);
});

test('the escape race is present in the wiring', () => {
  const { circuit } = loadBrainData()!;
  const role = circuit.neurons.map((n) => n.role);
  const type = circuit.neurons.map((n) => n.type);
  const isGF = (i: number) => role[i] === 'gf';
  const isLoom = (i: number) => role[i] === 'lc4' || role[i] === 'lplc2';
  const isSens = (i: number) => role[i] === 'other' && type[i] === 'sensory';

  const loomGF = circuit.edges.filter((e) => isLoom(e[0]) && isGF(e[1]));
  assert.equal(loomGF.length, 216);
  assert.equal(loomGF.reduce((s, e) => s + Math.abs(e[2]), 0), 1527);
  assert.equal(circuit.edges.filter((e) => isSens(e[0]) && isGF(e[1])).length, 14);

  // signed by neurotransmitter prediction: both signs must be present
  assert.equal(circuit.edges.filter((e) => e[2] < 0).length, 7797);
  assert.equal(circuit.edges.filter((e) => e[2] > 0).length, 11171);
  assert.equal(circuit.edges.filter((e) => e[2] === 0).length, 0);
  assert.equal(circuit.edges.filter((e) => e[0] === e[1]).length, 0);
});

test('every neuron has a 3-component position', () => {
  const { circuit } = loadBrainData()!;
  assert.ok(circuit.neurons.every((n) => n.pos.length === 3));
});
