// simtest.js — port of runSimtest() from main.swift.
// Circuit invariants. MUST pass after any sim/etl change.
//   node test/simtest.js

import { loadBrainData } from '../src/data.js';
import { LIFSim } from '../src/sim.js';

const data = loadBrainData();
if (!data) { process.stderr.write('no data/ — run etl.py first\n'); process.exit(1); }
const sim = new LIFSim(data.circuit, null);
const f = (x, d = 1) => x.toFixed(d);

console.log(`circuit: ${sim.n} neurons | loom L/R: ${sim.loomLeft.length}/${sim.loomRight.length}`
  + ` | GF: ${sim.gf.length} | DNa L/R: ${sim.dnaL.length}/${sim.dnaR.length} | MDN: ${sim.mdn.length}`
  + ` | DNp09: ${sim.fwd.length} | DNg11: ${sim.groom.length} | escW: ${sim.escw.length}`
  + ` | ascend: ${sim.ascend.length} | sens: ${sim.sens.length}`);

// Phase 1: 4 s spontaneous activity
let gfSpont = 0;
for (let i = 0; i < 40; i++) { sim.step(100); if (sim.consumeGF()) gfSpont++; }
const popHz = sim.totalSpikes / 4.0 / sim.n;
console.log(`spontaneous 4s: pop ${f(popHz, 2)} Hz/neuron, LC ${f(sim.rateLoom)} Hz, `
  + `DNa02 L/R ${f(sim.rateDNaL)}/${f(sim.rateDNaR)} Hz, MDN ${f(sim.rateMDN)} Hz, GF spikes: ${gfSpont}`);

// Phase 2: abrupt loom, as produced by a cursor lunge (step, not ramp)
let gfLatencyMs = -1;
let gfLoom = 0;
for (let ms = 0; ms < 400; ms++) {
  sim.loomL = 1.0;
  sim.loomR = 0.5;
  sim.step(1);
  if (sim.consumeGF()) {
    gfLoom++;
    if (gfLatencyMs < 0) gfLatencyMs = ms;
  }
}
sim.loomL = 0; sim.loomR = 0;
console.log(`abrupt loom 0.4s: LC rate ${f(sim.rateLoom)} Hz, GF spikes ${gfLoom}, `
  + `first at ${gfLatencyMs} ms`);

// Phase 3: 20 s with walking proprioception; do behavior states emerge?
let walkOn = 0, groomOn = 0, samples = 0;
let fwdMin = Infinity, fwdMax = 0;
for (let ms = 0; ms < 20000; ms++) {
  sim.gaitDrive = 0.5;
  sim.gaitPhase = (ms % 125) / 125;    // 8 Hz gait
  sim.step(1);
  if (ms % 10 === 0) {
    samples++;
    if (sim.rateFwd / 10 > 0.22) walkOn++;
    if (sim.rateGroom / 8 > 0.5) groomOn++;
    fwdMin = Math.min(fwdMin, sim.rateFwd); fwdMax = Math.max(fwdMax, sim.rateFwd);
  }
}
console.log(`behavior 20s: walk-drive on ${f(100 * walkOn / samples, 0)}%, `
  + `groom-drive on ${f(100 * groomOn / samples, 0)}%, `
  + `DNp09 ${f(fwdMin)}-${f(fwdMax)} Hz, pop ${f(sim.ratePop)} Hz`);

// Phase 3b: midday siesta must slow the fly down, not paralyze it
sim.activityScale = 1 - (1 - 0.55) * 0.35;   // = 0.84, the compressed siesta scale
let siestaWalkOn = 0, siestaSamples = 0;
for (let ms = 0; ms < 15000; ms++) {
  sim.step(1);
  if (ms % 10 === 0) {
    siestaSamples++;
    if (sim.rateFwd / 10 > 0.22) siestaWalkOn++;
  }
}
sim.activityScale = 1;
const siestaPct = 100 * siestaWalkOn / siestaSamples;
console.log(`siesta 15s (scale 0.84): walk-drive on ${f(siestaPct, 0)}%`);

// Phase 4: air puff (fast cursor whoosh) for 1 s — wind startle pathway
let gfPuff = 0;
for (let i = 0; i < 1000; i++) {
  sim.airPuff = 1.0;
  sim.step(1);
  if (sim.consumeGF()) gfPuff++;
}
sim.airPuff = 0;
console.log(`air puff 1s: GF spikes ${gfPuff}`);

// Phase 5: gentle left-eye-only loom 1 s — steering response probe
for (let i = 0; i < 500; i++) { sim.step(1); sim.consumeGF(); }   // settle
const diff0 = sim.rateDNaL - sim.rateDNaR;
for (let i = 0; i < 1000; i++) {
  sim.loomL = 0.30; sim.loomR = 0;
  sim.step(1);
  sim.consumeGF();
}
const diff1 = sim.rateDNaL - sim.rateDNaR;
sim.loomL = 0;
const sign = (x) => (x >= 0 ? '+' : '') + f(x);
console.log(`left-eye loom: DNa L-R rate diff ${sign(diff0)} -> ${sign(diff1)} Hz, `
  + `LC ${f(sim.rateLoom)} Hz`);

// Phase 6: click-stimulation probes (what the interactive brain window does)
sim.stimulate(sim.gf, 0.5, 40);
sim.step(60);
const gfStim = sim.consumeGF();
sim.stimulate(sim.groom, 0.25, 400);
sim.step(400);
const groomStim = sim.rateGroom;
sim.consumeGF();
console.log(`click probes: GF cluster -> spike ${gfStim ? 'yes' : 'NO'}, `
  + `DNg11 cluster -> groom rate ${f(groomStim, 0)} Hz`);

const pass = gfSpont === 0 && gfLoom > 0 && walkOn > 0 && gfStim && siestaPct > 3;
console.log(pass
  ? 'PASS: GF silent at rest, fires on loom; locomotor drive fluctuates; stim works; siesta alive'
  : 'FAIL: tune weights/noise');
process.exit(pass ? 0 : 1);
