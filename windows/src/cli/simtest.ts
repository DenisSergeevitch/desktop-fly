// Headless circuit diagnostics — the port of `./DesktopFly --simtest`.
// Five conditions gate the exit code, exactly as in the Swift original
// (main.swift:125-227). `--strict` additionally asserts the ranges the Swift
// suite only prints.

import { loadBrainData } from '../core/data.ts';
import { LIFSim } from '../core/sim.ts';

const strict = process.argv.includes('--strict');
const seedArg = process.argv.find((a) => a.startsWith('--seed='));
const seed = seedArg === undefined ? 1 : Number(seedArg.slice('--seed='.length));

const data = loadBrainData();
if (data === null) {
  console.error('no data/ — run etl.py first');
  process.exit(1);
}
const sim = new LIFSim(data.circuit, null, seed);
const f = (x: number, d = 1) => x.toFixed(d);

console.log(`circuit: ${sim.n} neurons | loom L/R: ${sim.loomLeft.length}/`
  + `${sim.loomRight.length} | GF: ${sim.gf.length} | DNa L/R: `
  + `${sim.dnaL.length}/${sim.dnaR.length} | MDN: ${sim.mdn.length} | DNp09: `
  + `${sim.fwd.length} | DNg11: ${sim.groom.length} | escW: ${sim.escw.length}`
  + ` | ascend: ${sim.ascend.length} | sens: ${sim.sens.length}`);

// Phase 1: 4 s spontaneous activity
let gfSpont = 0;
for (let i = 0; i < 40; i++) {
  sim.step(100);
  if (sim.consumeGF()) gfSpont++;
}
const popHz = sim.totalSpikes / 4 / sim.n;
console.log(`spontaneous 4s: pop ${f(popHz, 2)} Hz/neuron, LC ${f(sim.rateLoom)} Hz, `
  + `DNa02 L/R ${f(sim.rateDNaL)}/${f(sim.rateDNaR)} Hz, MDN ${f(sim.rateMDN)} Hz, `
  + `GF spikes: ${gfSpont}`);

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
sim.loomL = 0;
sim.loomR = 0;
console.log(`abrupt loom 0.4s: LC rate ${f(sim.rateLoom)} Hz, GF spikes ${gfLoom}, `
  + `first at ${gfLatencyMs} ms`);

// Phase 3: 20 s with walking proprioception; do behavior states emerge?
let walkOn = 0, groomOn = 0, samples = 0;
let fwdMin = Number.POSITIVE_INFINITY, fwdMax = 0;
for (let ms = 0; ms < 20_000; ms++) {
  sim.gaitDrive = 0.5;
  sim.gaitPhase = (ms % 125) / 125;   // 8 Hz gait
  sim.step(1);
  if (ms % 10 === 0) {
    samples++;
    if (sim.rateFwd / 10 > 0.22) walkOn++;
    if (sim.rateGroom / 8 > 0.5) groomOn++;
    fwdMin = Math.min(fwdMin, sim.rateFwd);
    fwdMax = Math.max(fwdMax, sim.rateFwd);
  }
}
const walkPct = 100 * walkOn / samples;
console.log(`behavior 20s: walk-drive on ${f(walkPct, 0)}%, groom-drive on `
  + `${f(100 * groomOn / samples, 0)}%, DNp09 ${f(fwdMin)}-${f(fwdMax)} Hz, `
  + `pop ${f(sim.ratePop)} Hz`);

// Phase 3b: midday siesta must slow the fly down, not paralyze it
sim.activityScale = 1 - (1 - 0.55) * 0.35;   // = 0.84, the compressed scale
let siestaWalkOn = 0, siestaSamples = 0;
for (let ms = 0; ms < 15_000; ms++) {
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
for (let i = 0; i < 500; i++) {
  sim.step(1);
  sim.consumeGF();
}
const diff0 = sim.rateDNaL - sim.rateDNaR;
for (let i = 0; i < 1000; i++) {
  sim.loomL = 0.30;
  sim.loomR = 0;
  sim.step(1);
  sim.consumeGF();
}
const diff1 = sim.rateDNaL - sim.rateDNaR;
sim.loomL = 0;
console.log(`left-eye loom: DNa L-R rate diff ${diff0 >= 0 ? '+' : ''}${f(diff0)}`
  + ` -> ${diff1 >= 0 ? '+' : ''}${f(diff1)} Hz, LC ${f(sim.rateLoom)} Hz`);

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

// --- exit conditions -------------------------------------------------------
const core: Array<[string, boolean]> = [
  ['GF silent at rest', gfSpont === 0],
  ['GF fires on loom', gfLoom > 0],
  ['locomotor drive fluctuates', walkOn > 0],
  ['click stimulation works', gfStim],
  ['siesta alive', siestaPct > 3],
];

// Ranges the Swift suite prints without asserting. Documented invariants
// (latency, walk duty) are cross-platform expectations; the population-rate
// band is a regression guard against this port's own measured baseline.
const strictChecks: Array<[string, boolean]> = [
  [`GF loom latency ${gfLatencyMs} ms <= 10 ms`, gfLatencyMs >= 0 && gfLatencyMs <= 10],
  // CLAUDE.md documents walk duty as 20-50%, but that is a per-run
  // observation, not a bound: the 330 partner neurons draw random baselines
  // that set the drive onto DNp09, so duty is seed-dependent. Measured here
  // across seeds 1-8: 17, 35, 28, 29, 36, 35, 43, 34 (mean 32%). The Swift
  // build has the same spread — its system RNG just reshuffles it every run.
  // Gated wide enough to be a real regression check; the distributional
  // version of this claim is asserted across seeds in dynamics.test.ts.
  [`walk-drive duty ${f(walkPct, 0)}% in 10-60%`, walkPct >= 10 && walkPct <= 60],
  [`population rate ${f(popHz, 2)} Hz/neuron in 0.05-20`, popHz > 0.05 && popHz < 20],
];
// Deliberately NOT gated: the air-puff -> GF spike count. The Swift suite only
// prints it, so there is no reference value to assert against, and a gate we
// cannot ground would fail for reasons unrelated to fidelity. It stays a
// printed diagnostic; if it reads 0, investigate the sensory -> GF boost.

const checks = strict ? [...core, ...strictChecks] : core;
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(failed.length === 0
  ? (strict ? 'PASS (strict): all invariants hold' : 'PASS: all invariants hold')
  : `FAIL: ${failed.length} invariant(s) broken — tune weights/noise`);
process.exit(failed.length === 0 ? 0 : 1);
