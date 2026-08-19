// sim.js — port of Sim.swift. Loads real FlyWire v783 data and runs a
// leaky-integrate-and-fire simulation of the escape/steering circuit
// (LC4/LPLC2 -> DNp01 giant fiber, DNa02 steering, MDN backward walking)
// with real signed synapse weights.
//
// Runs unchanged in Electron's renderer and in bare Node (the test suites).

// What the brain tells the body each frame.
export function makeSignals() {
  return {
    escape: false,     // giant fiber spiked -> takeoff NOW
    nervous: 0,        // looming-detector population rate, 0..1
    turnBias: 0,       // rad/s steering from DNa01/DNa02 left-right rate difference
    backward: false,   // MDN burst -> backward walking
    walkDrive: 0,      // DNp09 forward-walking command rate, ~0..1.5
    groomDrive: 0,     // DNg11 grooming command rate, ~0..1.5
    wingDrive: 0,      // DNp02/04/11 escape-maneuver DN rate, ~0..1.3
    arousal: 0,        // whole-population activity, ~0..1
    tempo: 1,          // thermal "temperature" scaling of locomotion
    sleep: false,      // circadian + idle -> sleep-like state
  };
}

// Spike hand-off from the sim to the brain view. Single-threaded here, but the
// bounded queue of the Swift SpikeBus is kept so the brain window never floods
// when frames are slow.
export class SpikeBus {
  constructor() { this.events = []; }
  push(list) {
    if (!list.length) return;
    for (const e of list) this.events.push(e);
    if (this.events.length > 256) this.events.splice(0, this.events.length - 256);
  }
  popAll() { const e = this.events; this.events = []; return e; }
}

export class LIFSim {
  constructor(circuit, spikeBus = null) {
    this.spikeBus = spikeBus;
    const neurons = circuit.neurons;
    const n = neurons.length;
    this.n = n;
    this.roles = neurons.map((x) => x.role);
    this.types = neurons.map((x) => x.type);

    // flat xyz, 3 floats per neuron
    this.positions = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      const p = neurons[i].pos;
      if (p && p.length === 3) {
        this.positions[3 * i] = p[0];
        this.positions[3 * i + 1] = p[1];
        this.positions[3 * i + 2] = p[2];
      }
    }

    // LIF state
    this.v = new Float32Array(n);
    this.refr = new Float32Array(n);
    this.inhQueue = Array.from({ length: 5 }, () => new Float32Array(n));
    this.qHead = 0;

    // groups
    this.loomLeft = []; this.loomRight = [];
    this.gf = [];
    this.dnaL = []; this.dnaR = [];
    this.mdn = []; this.fwd = []; this.groom = []; this.escw = [];
    this.ascend = []; this.sens = [];

    for (let i = 0; i < n; i++) {
      const nr = neurons[i];
      switch (nr.role) {
        case 'lc4': case 'lplc2':
          (nr.side === 'left' ? this.loomLeft : this.loomRight).push(i); break;
        case 'gf': this.gf.push(i); break;
        case 'dna01': case 'dna02':
          (nr.side === 'left' ? this.dnaL : this.dnaR).push(i); break;
        case 'mdn': this.mdn.push(i); break;
        case 'dnp09': this.fwd.push(i); break;
        case 'dng11': this.groom.push(i); break;
        case 'escw': this.escw.push(i); break;
        case 'other':
          // partners keep their super_class as `type`
          if (nr.type === 'ascending') this.ascend.push(i);
          else if (nr.type === 'sensory') this.sens.push(i);
          break;
        default: break;
      }
    }
    this.ascendPhase = new Float32Array(this.ascend.length);
    for (let k = 0; k < this.ascend.length; k++) this.ascendPhase[k] = Math.random() * 2 * Math.PI;

    // Heterogeneous baseline drive: interneurons get enough to crackle at a
    // few Hz; sensory and command neurons stay quiet unless driven.
    this.baseline = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      switch (neurons[i].role) {
        case 'other': this.baseline[i] = 0.010 + Math.random() * 0.060; break;
        case 'lc4': case 'lplc2': this.baseline[i] = 0.004; break;
        // command DNs get deterministic, side-symmetric baselines: their
        // asymmetries and bursts must come from network dynamics, not luck
        case 'dna01': case 'dna02': case 'mdn': case 'dng11': case 'escw':
          this.baseline[i] = 0.036; break;
        case 'dnp09': this.baseline[i] = 0.038; break;
        default: this.baseline[i] = 0.002; break;   // gf: quiet unless synaptically driven
      }
    }

    // hot-loop lookups (Swift used string switches and dnaL.contains)
    // 1 loom, 2 dnaL, 3 dnaR, 4 mdn, 5 fwd, 6 groom, 7 escw, 8 gf
    this.roleCode = new Uint8Array(n);
    for (const i of this.loomLeft) this.roleCode[i] = 1;
    for (const i of this.loomRight) this.roleCode[i] = 1;
    for (const i of this.dnaL) this.roleCode[i] = 2;
    for (const i of this.dnaR) this.roleCode[i] = 3;
    for (const i of this.mdn) this.roleCode[i] = 4;
    for (const i of this.fwd) this.roleCode[i] = 5;
    for (const i of this.groom) this.roleCode[i] = 6;
    for (const i of this.escw) this.roleCode[i] = 7;
    for (const i of this.gf) this.roleCode[i] = 8;

    // CSR adjacency, weights pre-scaled
    const edges = circuit.edges;
    const counts = new Int32Array(n);
    for (const e of edges) counts[e[0]]++;
    this.rowStart = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.rowStart[i + 1] = this.rowStart[i] + counts[i];
    this.colIdx = new Int32Array(edges.length);
    this.w = new Float32Array(edges.length);
    // LC4/LPLC2 -> GF and the wind pathway (JO sensory) -> GF couple via
    // electrical (gap-junction) synapses, which chemical synapse counts
    // under-represent; boost that drive.
    const gapJunctionBoost = 6.0;
    const fill = Int32Array.from(this.rowStart.subarray(0, n));
    for (const e of edges) {
      const pre = e[0] | 0, post = e[1] | 0;
      let weight = e[2] * this.weightScale;
      const preRole = this.roles[pre];
      const electrical = preRole === 'lc4' || preRole === 'lplc2'
        || (preRole === 'other' && this.types[pre] === 'sensory');
      if (electrical && this.roles[post] === 'gf') weight *= gapJunctionBoost;
      this.colIdx[fill[pre]] = post;
      this.w[fill[pre]] = weight;
      fill[pre]++;
    }

    // inputs (0..1), set each frame by the coordinator
    this.loomL = 0;
    this.loomR = 0;
    this.gaitDrive = 0;      // body walking intensity -> ascending neurons
    this.gaitPhase = 0;      // body gait phase 0..1 -> rhythmic proprioception
    this.airPuff = 0;        // fast cursor motion near the fly -> sensory neurons
    this.activityScale = 1;  // circadian / sleep neuromodulation of baseline+noise
    this.sensoryGate = 1;    // sleep gates sensory input (raised arousal threshold)

    // outputs
    this.rateLoom = 0;       // Hz per LC neuron (EMA)
    this.rateDNaL = 0;
    this.rateDNaR = 0;
    this.rateMDN = 0;
    this.rateFwd = 0;
    this.rateGroom = 0;
    this.rateEscW = 0;
    this.ratePop = 0;        // whole-population Hz per neuron
    this.gfLatch = false;
    this.simMs = 0;
    this.totalSpikes = 0;

    this.burstUntil = 0;     // occasional "arousal" noise bursts
    this.burstNext = 12000;

    // "optogenetic" stimulation from brain-window clicks
    this.pendingStims = [];
    this.activeStims = [];

    this._spiked = new Int32Array(n);
  }

  // GABA/Glut synapses deliver with a few ms delay; the LC->GF electrical
  // coupling is instantaneous. This latency window is what lets the giant
  // fiber fire before feedforward inhibition arrives.
  get inhDelayMs() { return 4; }
  // params
  get decay() { return 0.9512; }         // exp(-1/20): 20 ms membrane tau, 1 ms step
  get threshold() { return 1.0; }
  get refractoryMs() { return 2; }
  get weightScale() { return 0.0008; }
  get pNoise() { return 0.0022; }
  get noiseKick() { return 0.42; }
  get loomGain() { return 0.30; }
  get rateAlpha() { return 1 / 120; }

  pos(i) {
    return [this.positions[3 * i], this.positions[3 * i + 1], this.positions[3 * i + 2]];
  }

  stimulate(indices, strength, durationMs) {
    if (!indices || !indices.length) return;
    this.pendingStims.push({ idx: indices, strength, durationMs, untilMs: 0 });
    if (this.pendingStims.length > 8) this.pendingStims.shift();
  }

  consumeGF() { const s = this.gfLatch; this.gfLatch = false; return s; }

  step(ms) {
    if (!(ms > 0)) return;
    for (const p of this.pendingStims) {
      p.untilMs = this.simMs + p.durationMs;
      this.activeStims.push(p);
    }
    this.pendingStims.length = 0;
    this.activeStims = this.activeStims.filter((s) => this.simMs < s.untilMs);

    const n = this.n, v = this.v, refr = this.refr, base = this.baseline;
    const decay = this.decay, threshold = this.threshold, refractoryMs = this.refractoryMs;
    const spiked = this._spiked;
    const spikedNow = [];

    for (let t = 0; t < ms; t++) {
      this.simMs++;
      if (this.simMs >= this.burstNext) {
        this.burstUntil = this.simMs + 400;
        this.burstNext = this.simMs + 15000 + Math.floor(Math.random() * 25001);
      }
      const p = (this.simMs < this.burstUntil ? this.pNoise * 6 : this.pNoise) * this.activityScale;

      for (let i = 0; i < n; i++) {
        if (refr[i] > 0) { refr[i] -= 1; v[i] *= decay; continue; }
        let vi = v[i] * decay + base[i] * this.activityScale;
        if (Math.random() < p) vi += this.noiseKick;
        v[i] = vi;
      }
      if (this.loomL > 0.001) {
        const d = this.loomL * this.loomGain * this.sensoryGate;
        for (const i of this.loomLeft) v[i] += d;
      }
      if (this.loomR > 0.001) {
        const d = this.loomR * this.loomGain * this.sensoryGate;
        for (const i of this.loomRight) v[i] += d;
      }
      // body -> brain: gait rhythm into ascending (proprioceptive) neurons
      if (this.gaitDrive > 0.001) {
        const ph = this.gaitPhase * 2 * Math.PI;
        for (let k = 0; k < this.ascend.length; k++) {
          v[this.ascend[k]] += this.gaitDrive * 0.09
            * (0.5 + 0.5 * Math.sin(ph + this.ascendPhase[k]));
        }
      }
      // fast air movement near the fly -> sensory pathway
      if (this.airPuff > 0.001) {
        const d = this.airPuff * 0.12 * this.sensoryGate;
        for (const i of this.sens) v[i] += d;
      }
      // brain-window click stimulation
      for (const s of this.activeStims) {
        if (this.simMs >= s.untilMs) continue;
        for (const i of s.idx) v[i] += s.strength;
      }

      // deliver delayed inhibition scheduled for this millisecond
      const q = this.inhQueue[this.qHead];
      for (let j = 0; j < n; j++) {
        if (q[j] !== 0) { v[j] = Math.max(-2, v[j] + q[j]); q[j] = 0; }
      }

      let nSpiked = 0;
      for (let i = 0; i < n; i++) {
        if (refr[i] <= 0 && v[i] >= threshold) {
          v[i] = 0; refr[i] = refractoryMs;
          spiked[nSpiked++] = i;
        }
      }
      this.totalSpikes += nSpiked;
      const inh = this.inhQueue[(this.qHead + this.inhDelayMs) % this.inhQueue.length];
      for (let s = 0; s < nSpiked; s++) {
        const i = spiked[s];
        const end = this.rowStart[i + 1];
        for (let k = this.rowStart[i]; k < end; k++) {
          const j = this.colIdx[k], wk = this.w[k];
          if (wk >= 0) v[j] = Math.max(-2, v[j] + wk);
          else inh[j] += wk;
        }
      }
      this.qHead = (this.qHead + 1) % this.inhQueue.length;

      // group rates (Hz per neuron, EMA)
      let cLoom = 0, cDL = 0, cDR = 0, cM = 0, cF = 0, cG = 0, cW = 0;
      for (let s = 0; s < nSpiked; s++) {
        switch (this.roleCode[spiked[s]]) {
          case 1: cLoom++; break;
          case 2: cDL++; break;
          case 3: cDR++; break;
          case 4: cM++; break;
          case 5: cF++; break;
          case 6: cG++; break;
          case 7: cW++; break;
          case 8: this.gfLatch = true; break;
          default: break;
        }
      }
      const a = this.rateAlpha;
      const nLoom = Math.max(1, this.loomLeft.length + this.loomRight.length);
      this.rateLoom += (cLoom * 1000 / nLoom - this.rateLoom) * a;
      this.rateDNaL += (cDL * 1000 / Math.max(1, this.dnaL.length) - this.rateDNaL) * a;
      this.rateDNaR += (cDR * 1000 / Math.max(1, this.dnaR.length) - this.rateDNaR) * a;
      this.rateMDN += (cM * 1000 / Math.max(1, this.mdn.length) - this.rateMDN) * a;
      this.rateFwd += (cF * 1000 / Math.max(1, this.fwd.length) - this.rateFwd) * a;
      this.rateGroom += (cG * 1000 / Math.max(1, this.groom.length) - this.rateGroom) * a;
      this.rateEscW += (cW * 1000 / Math.max(1, this.escw.length) - this.rateEscW) * a;
      this.ratePop += (nSpiked * 1000 / Math.max(1, n) - this.ratePop) * a;

      if (this.spikeBus) {
        const stride = Math.max(1, Math.floor(nSpiked / 12));   // sample under heavy activity
        for (let i = 0; i < nSpiked; i += stride) {
          spikedNow.push({ neuron: spiked[i], isGF: this.roleCode[spiked[i]] === 8 });
        }
      }
    }
    if (this.spikeBus) this.spikeBus.push(spikedNow);
  }
}
