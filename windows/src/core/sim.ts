// core/sim.ts — transliteration of Sim.swift. Runs the leaky-integrate-and-fire
// simulation of the real FlyWire v783 escape/steering circuit with real signed
// synapse weights. Constants come from Sim.swift:127-145 and must not be
// re-derived; the Swift source is normative.

import type { CircuitFile } from './data.ts';
import { makeRng, rnd, type Rng } from './mathutil.ts';

export interface SpikeEvent {
  neuron: number;
  isGF: boolean;
}

// Spike hand-off to the brain window. macOS needs an NSLock here because the
// sim steps on the SceneKit render thread; a JS context is single-threaded.
export class SpikeBus {
  private events: SpikeEvent[] = [];

  push(e: SpikeEvent[]): void {
    if (e.length === 0) return;
    for (const x of e) this.events.push(x);
    if (this.events.length > 256) {
      this.events.splice(0, this.events.length - 256);
    }
  }

  popAll(): SpikeEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }
}

// --- LIF parameters (Sim.swift:127-145) -------------------------------------
const DECAY = 0.9512;          // exp(-1/20): 20 ms membrane tau, 1 ms step
const THRESHOLD = 1.0;
const REFRACTORY_MS = 2;
const WEIGHT_SCALE = 0.0008;
const P_NOISE = 0.0022;
const NOISE_KICK = 0.42;
const LOOM_GAIN = 0.30;
const RATE_ALPHA = 1 / 120;
const INH_DELAY_MS = 4;        // GABA/Glut delay; LC->GF coupling is instant
const INH_QUEUE_LEN = 5;
const GAP_JUNCTION_BOOST = 6.0;
const V_FLOOR = -2;

interface Stim {
  idx: number[];
  strength: number;
  durationMs: number;
  untilMs: number;
}

export class LIFSim {
  readonly n: number;
  readonly roles: string[];
  readonly types: string[];
  readonly positions: Float32Array;   // 3 per neuron

  // LIF state
  private v: Float32Array;
  private refr: Float32Array;
  private baseline: Float32Array;

  // CSR adjacency, weights pre-scaled
  private rowStart: Int32Array;
  private colIdx: Int32Array;
  private w: Float32Array;

  // groups
  loomLeft: number[] = [];
  loomRight: number[] = [];
  gf: number[] = [];
  dnaL: number[] = [];      // DNa01 + DNa02, left
  dnaR: number[] = [];      // DNa01 + DNa02, right
  mdn: number[] = [];
  fwd: number[] = [];       // DNp09
  groom: number[] = [];     // DNg11
  escw: number[] = [];      // DNp02/04/11 escape-maneuver (wing) DNs
  ascend: number[] = [];    // ascending partners (leg proprioception)
  sens: number[] = [];      // sensory partners (air-puff pathway)
  private ascendPhase: Float32Array;
  private dnaLSet: Set<number>;

  // inputs (0..1), set each frame by the coordinator
  loomL = 0;
  loomR = 0;
  gaitDrive = 0;
  gaitPhase = 0;
  airPuff = 0;
  activityScale = 1;
  sensoryGate = 1;

  // outputs — Hz per neuron, exponential moving averages
  rateLoom = 0;
  rateDNaL = 0;
  rateDNaR = 0;
  rateMDN = 0;
  rateFwd = 0;
  rateGroom = 0;
  rateEscW = 0;
  ratePop = 0;
  simMs = 0;
  totalSpikes = 0;

  private gfLatch = false;
  private inhQueue: Float32Array[];
  private qHead = 0;
  private burstUntil = 0;
  private burstNext = 12_000;
  private pendingStims: Stim[] = [];
  private activeStims: Stim[] = [];
  private readonly rng: Rng;
  readonly spikeBus: SpikeBus | null;

  constructor(
    circuit: CircuitFile,
    spikeBus: SpikeBus | null = null,
    seed: number = (Date.now() & 0x7fffffff) || 1,
  ) {
    this.spikeBus = spikeBus;
    this.rng = makeRng(seed);
    const n = circuit.neurons.length;
    this.n = n;
    this.roles = circuit.neurons.map((x) => x.role);
    this.types = circuit.neurons.map((x) => x.type);

    this.positions = new Float32Array(3 * n);
    for (let i = 0; i < n; i++) {
      const p = circuit.neurons[i].pos;
      if (p.length === 3) {
        this.positions[3 * i] = p[0];
        this.positions[3 * i + 1] = p[1];
        this.positions[3 * i + 2] = p[2];
      }
    }

    this.v = new Float32Array(n);
    this.refr = new Float32Array(n);
    this.inhQueue = Array.from({ length: INH_QUEUE_LEN },
      () => new Float32Array(n));

    for (let i = 0; i < n; i++) {
      const nr = circuit.neurons[i];
      switch (nr.role) {
        case 'lc4':
        case 'lplc2':
          if (nr.side === 'left') this.loomLeft.push(i);
          else this.loomRight.push(i);
          break;
        case 'gf': this.gf.push(i); break;
        case 'dna01':
        case 'dna02':
          if (nr.side === 'left') this.dnaL.push(i);
          else this.dnaR.push(i);
          break;
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
    this.dnaLSet = new Set(this.dnaL);

    this.ascendPhase = new Float32Array(this.ascend.length);
    for (let k = 0; k < this.ascend.length; k++) {
      this.ascendPhase[k] = rnd(this.rng, 0, 2 * Math.PI);
    }

    // Heterogeneous baseline drive: interneurons crackle at a few Hz; sensory
    // and command neurons stay quiet unless driven (Sim.swift:196-211).
    this.baseline = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      switch (circuit.neurons[i].role) {
        case 'other': this.baseline[i] = rnd(this.rng, 0.010, 0.070); break;
        case 'lc4':
        case 'lplc2': this.baseline[i] = 0.004; break;
        // command DNs get deterministic, side-symmetric baselines: their
        // asymmetries and bursts must come from network dynamics, not luck
        case 'dna01':
        case 'dna02':
        case 'mdn':
        case 'dng11':
        case 'escw': this.baseline[i] = 0.036; break;
        case 'dnp09': this.baseline[i] = 0.038; break;
        default: this.baseline[i] = 0.002; break;   // gf: quiet unless driven
      }
    }

    // CSR build. LC4/LPLC2 -> GF and the wind (JO sensory) -> GF pathways
    // couple electrically; chemical synapse counts under-represent that, so
    // boost those weights (Sim.swift:213-236).
    const counts = new Int32Array(n);
    for (const e of circuit.edges) counts[e[0]]++;
    this.rowStart = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.rowStart[i + 1] = this.rowStart[i] + counts[i];
    this.colIdx = new Int32Array(circuit.edges.length);
    this.w = new Float32Array(circuit.edges.length);
    const fill = Int32Array.from(this.rowStart);
    for (const e of circuit.edges) {
      const pre = e[0];
      const post = e[1];
      let weight = e[2] * WEIGHT_SCALE;
      const electrical = this.roles[pre] === 'lc4' || this.roles[pre] === 'lplc2'
        || (this.roles[pre] === 'other' && this.types[pre] === 'sensory');
      if (electrical && this.roles[post] === 'gf') weight *= GAP_JUNCTION_BOOST;
      this.colIdx[fill[pre]] = post;
      this.w[fill[pre]] = weight;
      fill[pre]++;
    }
  }

  consumeGF(): boolean {
    const s = this.gfLatch;
    this.gfLatch = false;
    return s;
  }

  // "optogenetic" stimulation from brain-window clicks (Sim.swift:149-161).
  // The stimLock is dropped: a JS context is single-threaded.
  stimulate(indices: number[], strength: number, durationMs: number): void {
    if (indices.length === 0) return;
    this.pendingStims.push({ idx: indices, strength, durationMs, untilMs: 0 });
    if (this.pendingStims.length > 8) this.pendingStims.shift();
  }

  // Sim.swift:243-341. Order of operations inside the millisecond loop is
  // load-bearing — decay/refractory, sensory injection, stimulation, delayed
  // inhibition delivery, threshold detection, then propagation.
  step(ms: number): void {
    if (ms <= 0) return;

    for (const p of this.pendingStims) {
      p.untilMs = this.simMs + p.durationMs;
      this.activeStims.push(p);
    }
    this.pendingStims.length = 0;
    this.activeStims = this.activeStims.filter((s) => this.simMs < s.untilMs);

    const spikedNow: SpikeEvent[] = [];
    for (let t = 0; t < ms; t++) {
      this.simMs++;
      if (this.simMs >= this.burstNext) {
        this.burstUntil = this.simMs + 400;
        this.burstNext = this.simMs + Math.floor(rnd(this.rng, 15_000, 40_001));
      }
      const p = (this.simMs < this.burstUntil ? P_NOISE * 6 : P_NOISE)
        * this.activityScale;

      for (let i = 0; i < this.n; i++) {
        if (this.refr[i] > 0) {
          this.refr[i] -= 1;
          this.v[i] *= DECAY;
          continue;
        }
        let vi = this.v[i] * DECAY + this.baseline[i] * this.activityScale;
        if (this.rng() < p) vi += NOISE_KICK;
        this.v[i] = vi;
      }

      if (this.loomL > 0.001) {
        for (const i of this.loomLeft) {
          this.v[i] += this.loomL * LOOM_GAIN * this.sensoryGate;
        }
      }
      if (this.loomR > 0.001) {
        for (const i of this.loomRight) {
          this.v[i] += this.loomR * LOOM_GAIN * this.sensoryGate;
        }
      }
      // body -> brain: gait rhythm into ascending (proprioceptive) neurons
      if (this.gaitDrive > 0.001) {
        const ph = this.gaitPhase * 2 * Math.PI;
        for (let k = 0; k < this.ascend.length; k++) {
          this.v[this.ascend[k]] += this.gaitDrive * 0.09
            * (0.5 + 0.5 * Math.sin(ph + this.ascendPhase[k]));
        }
      }
      // fast air movement near the fly -> sensory pathway
      if (this.airPuff > 0.001) {
        for (const i of this.sens) {
          this.v[i] += this.airPuff * 0.12 * this.sensoryGate;
        }
      }
      // brain-window click stimulation
      for (const s of this.activeStims) {
        if (this.simMs < s.untilMs) {
          for (const i of s.idx) this.v[i] += s.strength;
        }
      }

      // deliver delayed inhibition scheduled for this millisecond
      const q = this.inhQueue[this.qHead];
      for (let j = 0; j < this.n; j++) {
        if (q[j] !== 0) {
          this.v[j] = Math.max(V_FLOOR, this.v[j] + q[j]);
          q[j] = 0;
        }
      }

      const spiked: number[] = [];
      for (let i = 0; i < this.n; i++) {
        if (this.refr[i] <= 0 && this.v[i] >= THRESHOLD) {
          this.v[i] = 0;
          this.refr[i] = REFRACTORY_MS;
          spiked.push(i);
        }
      }
      this.totalSpikes += spiked.length;

      const inhSlot = (this.qHead + INH_DELAY_MS) % INH_QUEUE_LEN;
      for (const i of spiked) {
        for (let k = this.rowStart[i]; k < this.rowStart[i + 1]; k++) {
          const j = this.colIdx[k];
          if (this.w[k] >= 0) this.v[j] = Math.max(V_FLOOR, this.v[j] + this.w[k]);
          else this.inhQueue[inhSlot][j] += this.w[k];
        }
      }
      this.qHead = (this.qHead + 1) % INH_QUEUE_LEN;

      // group rates (Hz per neuron, EMA)
      let cLoom = 0, cDL = 0, cDR = 0, cM = 0, cF = 0, cG = 0, cW = 0;
      for (const i of spiked) {
        switch (this.roles[i]) {
          case 'lc4':
          case 'lplc2': cLoom++; break;
          case 'dna01':
          case 'dna02': if (this.dnaLSet.has(i)) cDL++; else cDR++; break;
          case 'mdn': cM++; break;
          case 'dnp09': cF++; break;
          case 'dng11': cG++; break;
          case 'escw': cW++; break;
          case 'gf': this.gfLatch = true; break;
          default: break;
        }
      }
      const nLoom = Math.max(1, this.loomLeft.length + this.loomRight.length);
      this.rateLoom += (cLoom * 1000 / nLoom - this.rateLoom) * RATE_ALPHA;
      this.rateDNaL += (cDL * 1000 / Math.max(1, this.dnaL.length) - this.rateDNaL) * RATE_ALPHA;
      this.rateDNaR += (cDR * 1000 / Math.max(1, this.dnaR.length) - this.rateDNaR) * RATE_ALPHA;
      this.rateMDN += (cM * 1000 / Math.max(1, this.mdn.length) - this.rateMDN) * RATE_ALPHA;
      this.rateFwd += (cF * 1000 / Math.max(1, this.fwd.length) - this.rateFwd) * RATE_ALPHA;
      this.rateGroom += (cG * 1000 / Math.max(1, this.groom.length) - this.rateGroom) * RATE_ALPHA;
      this.rateEscW += (cW * 1000 / Math.max(1, this.escw.length) - this.rateEscW) * RATE_ALPHA;
      this.ratePop += (spiked.length * 1000 / Math.max(1, this.n) - this.ratePop) * RATE_ALPHA;

      if (this.spikeBus !== null) {
        const stride = Math.max(1, Math.floor(spiked.length / 12));
        for (let i = 0; i < spiked.length; i += stride) {
          spikedNow.push({
            neuron: spiked[i],
            isGF: this.roles[spiked[i]] === 'gf',
          });
        }
      }
    }
    this.spikeBus?.push(spikedNow);
  }

  // --- test support: read-only, never used by app code ----------------------
  potentialAt(i: number): number { return this.v[i]; }
  baselineAt(i: number): number { return this.baseline[i]; }
  outDegree(i: number): number { return this.rowStart[i + 1] - this.rowStart[i]; }

  edgeWeight(pre: number, post: number): number | null {
    for (let k = this.rowStart[pre]; k < this.rowStart[pre + 1]; k++) {
      if (this.colIdx[k] === post) return this.w[k];
    }
    return null;
  }
}
