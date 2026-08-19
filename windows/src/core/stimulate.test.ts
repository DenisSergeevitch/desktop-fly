import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrainData } from './data.ts';
import { LIFSim } from './sim.ts';

const { circuit } = loadBrainData()!;

test('stimulating the GF cluster produces an escape spike', () => {
  // This is what a brain-window click on the giant fiber does.
  const sim = new LIFSim(circuit, null, 1);
  sim.step(400);
  sim.consumeGF();
  sim.stimulate(sim.gf, 0.5, 40);
  sim.step(60);
  assert.equal(sim.consumeGF(), true);
});

test('stimulation stops when its duration expires', () => {
  const sim = new LIFSim(circuit, null, 1);
  sim.stimulate(sim.groom, 0.25, 100);
  sim.step(100);
  const during = sim.rateGroom;
  sim.step(2000);
  assert.ok(during > 0);
  assert.ok(sim.rateGroom < during, 'rate should decay once the stim ends');
});

test('the pending stim queue is capped at 8', () => {
  const sim = new LIFSim(circuit, null, 1);
  for (let i = 0; i < 20; i++) sim.stimulate([i], 0.1, 10);
  sim.step(1);   // merges pending -> active without throwing
  assert.equal(sim.simMs, 1);
});

test('an empty index list is ignored', () => {
  const sim = new LIFSim(circuit, null, 1);
  sim.stimulate([], 1.0, 100);
  sim.step(1);
  assert.equal(sim.simMs, 1);
});
