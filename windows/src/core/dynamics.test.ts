import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrainData, type CircuitFile } from './data.ts';
import { LIFSim } from './sim.ts';

const { circuit } = loadBrainData()!;
const SEEDS = [1, 2, 3];   // never assert against a single lucky seed

test('the giant fiber is silent across 4 s of rest', () => {
  for (const seed of SEEDS) {
    const sim = new LIFSim(circuit, null, seed);
    let gfSpikes = 0;
    for (let i = 0; i < 40; i++) {
      sim.step(100);
      if (sim.consumeGF()) gfSpikes++;
    }
    assert.equal(gfSpikes, 0, `seed ${seed}: GF fired at rest`);
    assert.equal(sim.simMs, 4000);
  }
});

test('the network is alive at rest but not seizing', () => {
  for (const seed of SEEDS) {
    const sim = new LIFSim(circuit, null, seed);
    sim.step(4000);
    const popHz = sim.totalSpikes / 4 / sim.n;
    assert.ok(popHz > 0.05 && popHz < 20,
      `seed ${seed}: population ${popHz.toFixed(2)} Hz/neuron out of band`);
  }
});

test('an abrupt loom fires the giant fiber within 10 ms', () => {
  // The escape race: electrical LC->GF drive against ~2,750 synapses of
  // delayed inhibition. Must be a step, never a ramp (CLAUDE.md).
  for (const seed of SEEDS) {
    const sim = new LIFSim(circuit, null, seed);
    sim.step(500);
    sim.consumeGF();
    let latency = -1;
    for (let ms = 0; ms < 400; ms++) {
      sim.loomL = 1.0;
      sim.loomR = 0.5;
      sim.step(1);
      if (sim.consumeGF() && latency < 0) latency = ms;
    }
    assert.ok(latency >= 0, `seed ${seed}: GF never fired on loom`);
    assert.ok(latency <= 10, `seed ${seed}: GF latency ${latency} ms > 10 ms`);
  }
});

test('the refractory period caps a hard-driven neuron at one spike per 2 ms', () => {
  // Single-neuron circuit so the count is exact: the SpikeBus samples with a
  // stride under heavy activity, so it cannot be used to count spikes.
  //
  // 2 ms, not 3: Sim.swift decrements refr in the same pass that decays v, so a
  // refractory of 2 blocks only one millisecond of spiking. Hand-traced from
  // Sim.swift:263-295 — spikes land on ms 1, 3, 5, ... 99.
  const one: CircuitFile = {
    neurons: [{ id: '0', type: 'LC4', role: 'lc4', side: 'center', pos: [0, 0, 0] }],
    edges: [],
  };
  const sim = new LIFSim(one, null, 1);
  sim.stimulate([0], 5.0, 200);   // far above threshold, held throughout
  sim.step(100);
  assert.equal(sim.totalSpikes, 50);
});

test('inhibition arrives exactly 4 ms after the presynaptic spike', () => {
  // Synthetic 2-neuron circuit: A --(inhibitory)--> B. Roles are lc4 so both
  // get the quiet 0.004 baseline and no gap-junction boost applies (the
  // boost needs a `gf` postsynaptic role).
  const tiny: CircuitFile = {
    neurons: [0, 1].map((i) => ({
      id: String(i), type: 'LC4', role: 'lc4', side: 'center', pos: [0, 0, 0],
    })),
    edges: [[0, 1, -1250]],           // -1250 * 0.0008 = -1.0
  };
  const sim = new LIFSim(tiny, null, 1);
  assert.equal(sim.edgeWeight(0, 1), Math.fround(-1.0));

  // durationMs must be >= 2 to have any effect: step() sets untilMs from the
  // pre-increment simMs, then tests `simMs < untilMs` after incrementing, so a
  // duration of 1 expires before it is ever applied. True of Swift too.
  sim.stimulate([0], 1.5, 2);          // force A over threshold on ms 1
  const trace: number[] = [];
  for (let ms = 0; ms < 8; ms++) {
    sim.step(1);
    trace.push(sim.potentialAt(1));
  }
  // B decays quietly for 4 ms, then takes the full -1.0 hit
  const drop = trace.findIndex((v) => v < -0.5);
  assert.equal(drop, 4, `inhibition landed on ms ${drop}, expected 4`);
});

test('stimulating a population raises that population rate', () => {
  // Note: do NOT assert rateMDN === 0 here. MDN rests at baseline 0.036, whose
  // steady state (0.036 / (1 - 0.9512) = 0.74) plus one 0.42 noise kick crosses
  // threshold, so MDN fires occasionally at rest by design.
  const sim = new LIFSim(circuit, null, 1);
  sim.step(2000);                       // settle
  const before = sim.rateGroom;
  sim.stimulate(sim.groom, 0.25, 600);
  sim.step(600);
  assert.ok(sim.rateGroom > before + 1,
    `DNg11 rate ${sim.rateGroom} did not rise above ${before}`);
  assert.ok(sim.ratePop > 0);
});

test('loom input reaches only the stimulated eye', () => {
  const sim = new LIFSim(circuit, null, 1);
  sim.step(500);
  const before = sim.rateDNaL - sim.rateDNaR;
  for (let i = 0; i < 1000; i++) {
    sim.loomL = 0.30;
    sim.loomR = 0;
    sim.step(1);
    sim.consumeGF();
  }
  assert.ok(sim.rateLoom > 0, 'left-eye loom should drive the LC population');
  assert.notEqual(sim.rateDNaL - sim.rateDNaR, before);
});
