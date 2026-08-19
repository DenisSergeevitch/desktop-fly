# DesktopFly Windows Port — M1 (Core Sim, Headless) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the 1 kHz LIF simulation of the 668-neuron FlyWire circuit, its
signal mapping, and its diagnostic suites from Swift to TypeScript, verified
headless under Node with no rendering and no dependencies.

**Architecture:** A pure-TypeScript `core/` layer (no Electron, no Three.js)
transliterated from `Sim.swift`, `main.swift`'s `SignalBuilder`, and
`Environment.swift`'s circadian curve, plus a `cli/` layer reproducing
`--simtest`. Unit tests run on Node's built-in `node:test`; the CLI suites keep
the Swift build's printed-output-and-exit-code contract.

**Tech Stack:** Node 24 (native TypeScript type stripping, `node:test`,
`node:assert/strict`). Zero npm dependencies in M1.

**Spec:** `docs/superpowers/specs/2026-08-19-windows-port-design.md`

## Global Constraints

- Node ≥ 24.0.0. Verified present: 24.19.0.
- **Zero npm dependencies in M1.** No `package-lock.json` churn, no installs.
- **No TypeScript construct requiring codegen** in `core/`, `body/`, `cli/`: no
  `enum`, no `namespace`, no constructor parameter properties, no decorators.
  Use `const` object literals with union types instead.
- **Relative imports carry explicit `.ts` extensions** (`./mathutil.ts`), as
  Node's ESM resolver requires.
- **The Swift source is normative.** Every constant is transliterated from the
  cited Swift line range, never re-derived or "improved".
- `data/*.json` is read-only and CC BY-NC 4.0. Never modified, copied into
  `windows/`, or relicensed.
- New code is MIT, matching the repo.
- Parity is behavioral and statistical, never spike-for-spike (different RNG).

## Intentional deviations from the Swift source

Four, all listed here so review does not have to rediscover them. Anything
*else* that differs from Swift is a bug.

1. **Seeded RNG.** Swift uses a non-deterministic `SystemRandomNumberGenerator`,
   which makes its own suites inherently flaky. `LIFSim` takes an optional
   `seed`; CLI suites and unit tests pass fixed seeds, the app passes none
   (time-seeded). Invariant tests run across **three** seeds so no assertion
   can be tuned to one lucky seed.
2. **No locks.** `SpikeBus`'s `NSLock` and `LIFSim`'s `stimLock` exist because
   macOS steps the sim on the SceneKit render thread. JavaScript is
   single-threaded per context; the locks are dropped, the APIs are unchanged.
3. **`SignalBuilder` consumes a structural interface** (`RateSource`) rather
   than a concrete `LIFSim`, so it is testable against a plain object. No
   behavior change.
4. **`groomDrive` gets a clamp** (`0…1.3`), matching its five siblings. The
   Swift version leaves it unclamped — behaviorally inert, because `groomDrive`
   is only ever compared against the 0.5/0.3 thresholds and never scaled.

5. **`core/` is split into five files, not three.** The spec lists
   `sim.ts`/`signals.ts`/`circadian.ts`/`types.ts`; this plan also adds
   `data.ts` (loading, split out of `sim.ts` so `core/sim.ts` stays about
   dynamics) and `mathutil.ts` (`clampf` plus the seeded RNG, shared by
   `signals.ts` and M2's `fly.ts`). Same layering rule, finer files.

Two test-support accessors are added to `LIFSim` (`potentialAt`, `edgeWeight`).
They are read-only, exist to test the inhibitory delay ring and the
gap-junction boost, and must not be used by app code.

---

### Task 1: Scaffold, data loading, and data invariants

**Files:**
- Create: `windows/package.json`
- Create: `windows/tsconfig.json`
- Create: `windows/src/core/mathutil.ts`
- Create: `windows/src/core/types.ts`
- Create: `windows/src/core/data.ts`
- Create: `windows/src/core/data.test.ts`
- Create: `windows/src/cli/datatest.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `type Rng = () => number`, `makeRng(seed: number): Rng`,
  `rnd(rng: Rng, lo: number, hi: number): number`,
  `clampf(v: number, lo: number, hi: number): number`;
  `interface Ledge { y, x0, x1, id: number }`;
  `interface BrainSignals { escape, backward, sleep: boolean; nervous,
  turnBias, walkDrive, groomDrive, wingDrive, arousal, tempo: number }`,
  `defaultSignals(): BrainSignals`;
  `interface CircuitNeuron { id, type, role, side: string; pos: number[] }`,
  `interface CircuitFile { neurons: CircuitNeuron[]; edges: number[][] }`,
  `interface BrainPointsFile { classes: string[]; points: number[][] }`,
  `findDataDir(): string | null`,
  `loadBrainData(): { points: BrainPointsFile; circuit: CircuitFile } | null`.

- [ ] **Step 1: Write the failing test**

Create `windows/src/core/data.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src`
Expected: FAIL — `Cannot find module ... data.ts`

- [ ] **Step 3: Write the scaffold and implementation**

Create `windows/package.json`:

```json
{
  "name": "desktopfly-windows",
  "version": "0.1.0",
  "private": true,
  "description": "Windows port of DesktopFly — real FlyWire connectome, live LIF sim",
  "license": "MIT",
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "test": "node --test src",
    "datatest": "node src/cli/datatest.ts",
    "simtest": "node src/cli/simtest.ts"
  }
}
```

Create `windows/tsconfig.json` (type-checking only — Node strips types at
runtime, nothing is emitted):

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ES2023", "DOM"]
  },
  "include": ["src/**/*.ts"]
}
```

`erasableSyntaxOnly` makes the compiler reject `enum`/`namespace`/parameter
properties — it mechanically enforces the Global Constraint instead of relying
on reviewer memory.

Create `windows/src/core/mathutil.ts`:

```ts
// Small numeric helpers. `angleDiff` and `smoothstep` (FlyModel.swift:16-22)
// arrive with the body port in M2; M1 needs only these.

export function clampf(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export type Rng = () => number;

// mulberry32. Swift uses a non-deterministic SystemRandomNumberGenerator;
// a seeded PRNG makes the invariant suites reproducible. See the plan's
// "Intentional deviations" section.
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Half-open [lo, hi), matching Swift's `Float.random(in: lo..<hi)` usage.
export function rnd(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}
```

Create `windows/src/core/types.ts`:

```ts
// What the brain tells the body each frame. Transliterated from Sim.swift:9-20.
export interface BrainSignals {
  escape: boolean;      // giant fiber spiked -> takeoff NOW
  nervous: number;      // looming-detector population rate, 0..1
  turnBias: number;     // rad/s steering from DNa01/DNa02 left-right difference
  backward: boolean;    // MDN burst -> backward walking
  walkDrive: number;    // DNp09 forward-walking command rate, ~0..1.5
  groomDrive: number;   // DNg11 grooming command rate, ~0..1.5
  wingDrive: number;    // DNp02/04/11 escape-maneuver DN rate, ~0..1.3
  arousal: number;      // whole-population activity, ~0..1
  tempo: number;        // thermal "temperature" scaling of locomotion
  sleep: boolean;       // circadian + idle -> sleep-like state
}

export function defaultSignals(): BrainSignals {
  return {
    escape: false, nervous: 0, turnBias: 0, backward: false, walkDrive: 0,
    groomDrive: 0, wingDrive: 0, arousal: 0, tempo: 1, sleep: false,
  };
}

// A walkable window top edge, in scene coordinates (origin at screen center).
// Environment.swift:9-14.
export interface Ledge {
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
  readonly id: number;
}
```

Create `windows/src/core/data.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BrainPointsFile {
  classes: string[];
  points: number[][];      // [x, y, z, classIndex]
}

export interface CircuitNeuron {
  id: string;
  type: string;            // FlyWire primary_type, or super_class for partners
  role: string;            // lc4 | lplc2 | gf | dna01 | dna02 | dnp09 |
                           // dng11 | mdn | escw | other
  side: string;            // left | right | center
  pos: number[];           // normalized [x, y, z]
}

export interface CircuitFile {
  neurons: CircuitNeuron[];
  edges: number[][];       // [preIdx, postIdx, signedSynCount]
}

// Equivalent of Sim.swift:38-47. The Windows build reads the repo's shared
// data/ in place — it is CC BY-NC 4.0 and is never copied into windows/.
export function findDataDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'data'),                        // packaged: resources/data
    resolve(here, '..', '..', 'data'),         // windows/data
    resolve(here, '..', '..', '..', 'data'),   // repo root data/
    join(process.cwd(), 'data'),
    resolve(process.cwd(), '..', 'data'),
  ];
  return candidates.find((d) => existsSync(join(d, 'circuit.json'))) ?? null;
}

export function loadBrainData():
  { points: BrainPointsFile; circuit: CircuitFile } | null {
  const dir = findDataDir();
  if (dir === null) return null;
  try {
    const points = JSON.parse(
      readFileSync(join(dir, 'brain_points.json'), 'utf8')) as BrainPointsFile;
    const circuit = JSON.parse(
      readFileSync(join(dir, 'circuit.json'), 'utf8')) as CircuitFile;
    return { points, circuit };
  } catch {
    return null;
  }
}
```

Create `windows/src/cli/datatest.ts` — the human-facing wrapper, mirroring the
Swift suites' print-then-exit contract:

```ts
import { loadBrainData } from '../core/data.ts';

const data = loadBrainData();
if (data === null) {
  console.error('no data/ — run etl.py first');
  process.exit(1);
}

const { circuit, points } = data;
const census: Record<string, number> = {};
for (const n of circuit.neurons) census[n.role] = (census[n.role] ?? 0) + 1;
const syn = circuit.edges.reduce((s, e) => s + Math.abs(e[2]), 0);

console.log(`circuit: ${circuit.neurons.length} neurons, `
  + `${circuit.edges.length} edges, ${Math.round(syn)} synapses`);
console.log(`brain cloud: ${points.points.length} points, `
  + `${points.classes.length} super-classes`);
console.log('roles:', JSON.stringify(census));

const checks: Array<[string, boolean]> = [
  ['668 neurons', circuit.neurons.length === 668],
  ['18968 edges', circuit.edges.length === 18968],
  ['23210 brain points', points.points.length === 23210],
  ['2 giant fibers', census.gf === 2],
  ['314 looming detectors', census.lc4 + census.lplc2 === 314],
  ['330 partners', census.other === 330],
];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(failed.length === 0
  ? 'ALL DATA CHECKS PASS'
  : `${failed.length} FAILURES`);
process.exit(failed.length === 0 ? 0 : 1);
```

Append to `.gitignore`:

```
# Windows port
windows/node_modules/
windows/dist/
windows/*.png
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test src`
Expected: PASS, 4 tests.

Run: `cd windows && npm run datatest`
Expected: prints the counts, ends `ALL DATA CHECKS PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add .gitignore windows/package.json windows/tsconfig.json windows/src
git commit -m "Windows port M1: scaffold, data loading, data invariants"
```

---

### Task 2: LIFSim construction — groups, baselines, CSR, gap-junction boost

**Files:**
- Create: `windows/src/core/sim.ts`
- Create: `windows/src/core/sim.test.ts`

**Interfaces:**
- Consumes: `CircuitFile` from `core/data.ts`; `makeRng`, `rnd` from
  `core/mathutil.ts`.
- Produces: `class SpikeBus` with `push(e: SpikeEvent[]): void` and
  `popAll(): SpikeEvent[]`; `interface SpikeEvent { neuron: number; isGF: boolean }`;
  `class LIFSim` with constructor
  `(circuit: CircuitFile, spikeBus?: SpikeBus | null, seed?: number)`,
  readonly `n`, `roles: string[]`, `types: string[]`, `positions: Float32Array`,
  group arrays `loomLeft`, `loomRight`, `gf`, `dnaL`, `dnaR`, `mdn`, `fwd`,
  `groom`, `escw`, `ascend`, `sens` (all `number[]`), and test-support
  `potentialAt(i: number): number`, `edgeWeight(pre: number, post: number): number | null`.

- [ ] **Step 1: Write the failing test**

Create `windows/src/core/sim.test.ts`:

```ts
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
```

Note the two extra read-only accessors the tests need beyond the Interfaces
block: `baselineAt(i)` and `outDegree(i)`. Both are test-support, same status as
`potentialAt`/`edgeWeight`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src`
Expected: FAIL — `Cannot find module ... sim.ts`

- [ ] **Step 3: Write the implementation**

Create `windows/src/core/sim.ts` (constructor only in this task — `step()`
arrives in Task 3, so it is stubbed to throw so nothing silently no-ops):

```ts
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

  step(_ms: number): void {
    throw new Error('LIFSim.step not implemented yet (Task 3)');
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test src`
Expected: PASS, 9 tests total.

- [ ] **Step 5: Commit**

```bash
git add windows/src/core/sim.ts windows/src/core/sim.test.ts
git commit -m "Windows port M1: LIFSim construction — groups, baselines, CSR"
```

---

### Task 3: LIF dynamics and stimulation — step(), refractory, delayed inhibition, rate EMAs

**Files:**
- Modify: `windows/src/core/sim.ts` (replace the `step()` stub, add `stimulate`)
- Create: `windows/src/core/dynamics.test.ts`
- Create: `windows/src/core/stimulate.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: working `LIFSim.step(ms: number): void`, advancing `simMs`,
  `totalSpikes`, all eight `rate*` fields, the GF latch, and the `SpikeBus`;
  `LIFSim.stimulate(indices: number[], strength: number, durationMs: number): void`.

`stimulate` lands here rather than in a task of its own because it is inert
without `step()` — a stimulus queued and never integrated does nothing — and
because the dynamics tests below need it to drive the network deterministically.

- [ ] **Step 1: Write the failing test**

Create `windows/src/core/dynamics.test.ts`:

```ts
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
```

Create `windows/src/core/stimulate.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd windows && node --test src/core`
Expected: FAIL — `LIFSim.step not implemented yet (Task 3)` and
`sim.stimulate is not a function`

- [ ] **Step 3: Write the implementation**

In `windows/src/core/sim.ts`, replace the `step()` stub with the
transliteration of `Sim.swift:243-341`. Order of operations inside the
millisecond loop is load-bearing — decay/refractory, then sensory injection,
then stimulation, then delayed inhibition delivery, then threshold detection,
then propagation:

```ts
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
```

And add `stimulate` (transliterates `Sim.swift:149-161`; the `stimLock` is
dropped per the deviations list):

```ts
  // "optogenetic" stimulation from brain-window clicks
  stimulate(indices: number[], strength: number, durationMs: number): void {
    if (indices.length === 0) return;
    this.pendingStims.push({ idx: indices, strength, durationMs, untilMs: 0 });
    if (this.pendingStims.length > 8) this.pendingStims.shift();
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test src`
Expected: PASS, 20 tests.

If the GF-at-rest or GF-latency test fails, **do not change the seed or relax
the assertion** — both are documented cross-platform invariants, so a failure
means the transliteration drifted. Re-read `Sim.swift:243-341` against the
implementation, checking the order of operations first.

- [ ] **Step 5: Commit**

```bash
git add windows/src/core/sim.ts windows/src/core/dynamics.test.ts \
        windows/src/core/stimulate.test.ts
git commit -m "Windows port M1: LIF dynamics, delayed inhibition, stimulation"
```

---

### Task 4: SignalBuilder — population rates to body commands

**Files:**
- Create: `windows/src/core/signals.ts`
- Create: `windows/src/core/signals.test.ts`

**Interfaces:**
- Consumes: `BrainSignals`, `defaultSignals` from `core/types.ts`; `clampf`
  from `core/mathutil.ts`.
- Produces: `interface RateSource` (structural: `rateLoom`, `rateDNaL`,
  `rateDNaR`, `rateMDN`, `rateFwd`, `rateGroom`, `rateEscW`, `ratePop:
  number`, `consumeGF(): boolean`);
  `class SignalBuilder` with `make(sim: RateSource, dt: number): BrainSignals`.

- [ ] **Step 1: Write the failing test**

Create `windows/src/core/signals.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalBuilder, type RateSource } from './signals.ts';

function rates(over: Partial<RateSource> = {}): RateSource {
  return {
    rateLoom: 0, rateDNaL: 0, rateDNaR: 0, rateMDN: 0, rateFwd: 0,
    rateGroom: 0, rateEscW: 0, ratePop: 0, consumeGF: () => false, ...over,
  };
}

test('rates map onto body commands with the documented divisors', () => {
  const b = new SignalBuilder();
  const s = b.make(rates({
    rateLoom: 40, rateFwd: 5, rateGroom: 4, rateEscW: 5, ratePop: 10,
  }), 1 / 60);
  assert.equal(s.nervous, 0.5);       // 40 / 80
  assert.equal(s.walkDrive, 0.5);     // 5 / 10
  assert.equal(s.groomDrive, 0.5);    // 4 / 8
  assert.equal(s.wingDrive, 0.5);     // 5 / 10
  assert.equal(s.arousal, 0.5);       // 10 / 20
  assert.equal(s.tempo, 1);
  assert.equal(s.sleep, false);
});

test('every signal is clamped — an unclamped walkDrive once sent the fly to 1,100 pt/s', () => {
  const b = new SignalBuilder();
  const s = b.make(rates({
    rateLoom: 9999, rateFwd: 9999, rateGroom: 9999, rateEscW: 9999,
    ratePop: 9999,
  }), 1 / 60);
  assert.equal(s.nervous, 1);
  assert.equal(s.walkDrive, 1.3);
  assert.equal(s.groomDrive, 1.3);
  assert.equal(s.wingDrive, 1.3);
  assert.equal(s.arousal, 1);
});

test('the giant fiber latch passes straight through', () => {
  const b = new SignalBuilder();
  assert.equal(b.make(rates({ consumeGF: () => true }), 1 / 60).escape, true);
  assert.equal(b.make(rates(), 1 / 60).escape, false);
});

test('MDN drives backward walking only above 8 Hz', () => {
  const b = new SignalBuilder();
  assert.equal(b.make(rates({ rateMDN: 8 }), 1 / 60).backward, false);
  assert.equal(b.make(rates({ rateMDN: 8.1 }), 1 / 60).backward, true);
});

test('a transient DNa asymmetry steers; a persistent one is adapted out', () => {
  // The connectome has a standing left/right wiring asymmetry. Steady-state
  // walking must be straight, so only transients reach turnBias (tau ~8 s).
  const b = new SignalBuilder();
  const skewed = rates({ rateDNaL: 20, rateDNaR: 0 });
  const first = b.make(skewed, 1 / 60);
  assert.ok(first.turnBias > 0.5, 'the onset should steer hard');

  for (let i = 0; i < 60 * 40; i++) b.make(skewed, 1 / 60);   // 40 s
  const adapted = b.make(skewed, 1 / 60);
  assert.ok(Math.abs(adapted.turnBias) < 0.05,
    `persistent asymmetry not adapted out: ${adapted.turnBias}`);

  // and a fresh asymmetry on top of the adapted baseline still steers
  const flipped = b.make(rates({ rateDNaL: 0, rateDNaR: 20 }), 1 / 60);
  assert.ok(flipped.turnBias < -0.5, 'a new transient should still steer');
});

test('turnBias is clamped to +/-1', () => {
  const b = new SignalBuilder();
  const s = b.make(rates({ rateDNaL: 9999, rateDNaR: 0 }), 1 / 60);
  assert.equal(s.turnBias, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src/core/signals.test.ts`
Expected: FAIL — `Cannot find module ... signals.ts`

- [ ] **Step 3: Write the implementation**

Create `windows/src/core/signals.ts` (transliterates `main.swift:459-483`):

```ts
// Converts sim population rates into body commands. Shared by the app loop and
// the diagnostic suites so both exercise the identical mapping.
//
// Takes a structural RateSource rather than a concrete LIFSim so the mapping is
// testable against a plain object — see the plan's "Intentional deviations".

import { clampf } from './mathutil.ts';
import { defaultSignals, type BrainSignals } from './types.ts';

export interface RateSource {
  rateLoom: number;
  rateDNaL: number;
  rateDNaR: number;
  rateMDN: number;
  rateFwd: number;
  rateGroom: number;
  rateEscW: number;
  ratePop: number;
  consumeGF(): boolean;
}

export class SignalBuilder {
  private dnaBaseline = 0;

  make(sim: RateSource, dt: number): BrainSignals {
    const diff = sim.rateDNaL - sim.rateDNaR;
    // Slow adaptation (tau ~8 s): the connectome's persistent left/right
    // wiring asymmetry is adapted out, so steady-state walking is straight and
    // only transient DNa asymmetries (visual, stimulation) steer.
    this.dnaBaseline += (diff - this.dnaBaseline) * Math.min(1, dt / 8);

    const s = defaultSignals();
    s.escape = sim.consumeGF();
    s.nervous = clampf(sim.rateLoom / 80, 0, 1);
    s.turnBias = clampf((diff - this.dnaBaseline) * 0.04, -1.0, 1.0);
    s.backward = sim.rateMDN > 8;
    s.walkDrive = clampf(sim.rateFwd / 10, 0, 1.3);
    // Swift leaves groomDrive unclamped; clamped here for consistency with its
    // five siblings. Behaviorally inert — groomDrive is only compared against
    // the 0.5/0.3 hysteresis thresholds, never scaled.
    s.groomDrive = clampf(sim.rateGroom / 8, 0, 1.3);
    s.wingDrive = clampf(sim.rateEscW / 10, 0, 1.3);
    s.arousal = clampf(sim.ratePop / 20, 0, 1);
    return s;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test src`
Expected: PASS, 26 tests.

- [ ] **Step 5: Commit**

```bash
git add windows/src/core/signals.ts windows/src/core/signals.test.ts
git commit -m "Windows port M1: SignalBuilder rate-to-command mapping"
```

---

### Task 5: Circadian activity curve

**Files:**
- Create: `windows/src/core/circadian.ts`
- Create: `windows/src/core/circadian.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `circadianActivity(hour: number): number`.

- [ ] **Step 1: Write the failing test**

Create `windows/src/core/circadian.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { circadianActivity } from './circadian.ts';

test('Drosophila rhythm: dawn and dusk peaks, midday siesta, night quiet', () => {
  // The four assertions the Swift --behaviortest makes (main.swift:448-453).
  const night = circadianActivity(3);
  const dawn = circadianActivity(9);
  const siesta = circadianActivity(14);
  const dusk = circadianActivity(18);
  assert.ok(night < 0.4, `night ${night}`);
  assert.ok(dawn > 0.9, `dawn ${dawn}`);
  assert.ok(siesta > 0.3 && siesta < 0.7, `siesta ${siesta}`);
  assert.ok(dusk > 0.9, `dusk ${dusk}`);
});

test('interpolates linearly between knot points', () => {
  assert.equal(circadianActivity(8), 1.0);                     // exact knot
  assert.ok(Math.abs(circadianActivity(13) - 0.55) < 1e-9);    // exact knot
  const mid = circadianActivity(11.5);          // halfway 10 -> 13
  assert.ok(Math.abs(mid - 0.775) < 1e-6, `${mid}`);
});

test('is defined across the whole day and outside it', () => {
  for (let h = 0; h <= 24; h += 0.25) {
    const a = circadianActivity(h);
    assert.ok(a > 0 && a <= 1, `hour ${h} gave ${a}`);
  }
  assert.equal(circadianActivity(-1), 0.25);
  assert.equal(circadianActivity(99), 0.25);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src/core/circadian.test.ts`
Expected: FAIL — `Cannot find module ... circadian.ts`

- [ ] **Step 3: Write the implementation**

Create `windows/src/core/circadian.ts` (transliterates
`Environment.swift:70-80`):

```ts
// Drosophila circadian activity: morning and evening peaks, midday siesta,
// night quiescence. Returns a multiplier for the sim's baseline drive.
//
// Never apply this to LIFSim baselines linearly — neurons rest just below
// threshold, so a raw multiplier silences the network (the "siesta coma" bug).
// The coordinator compresses it toward 1 before use.
const KNOTS: Array<[number, number]> = [
  [0, 0.25], [5, 0.25], [8, 1.0], [10, 1.0], [13, 0.55],
  [15, 0.55], [17, 1.0], [20, 1.0], [23, 0.3], [24, 0.25],
];

export function circadianActivity(hour: number): number {
  for (let i = 0; i < KNOTS.length - 1; i++) {
    const [h0, a0] = KNOTS[i];
    const [h1, a1] = KNOTS[i + 1];
    if (hour >= h0 && hour <= h1) {
      const t = (hour - h0) / Math.max(0.001, h1 - h0);
      return a0 + (a1 - a0) * t;
    }
  }
  return 0.25;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test src`
Expected: PASS, 29 tests.

- [ ] **Step 5: Commit**

```bash
git add windows/src/core/circadian.ts windows/src/core/circadian.test.ts
git commit -m "Windows port M1: circadian activity curve"
```

---

### Task 6: The `--simtest` CLI suite, with strict range assertions

**Files:**
- Create: `windows/src/cli/simtest.ts`
- Modify: `windows/package.json` (add the `simtest:strict` script)

**Interfaces:**
- Consumes: `loadBrainData`, `LIFSim`, `SignalBuilder`.
- Produces: a CLI printing the six diagnostic phases and exiting 0/1.

This task has no unit test: the deliverable *is* a test. Its verification step
is running it and reading the output.

- [ ] **Step 1: Write the CLI**

Create `windows/src/cli/simtest.ts`, reproducing `main.swift:125-227` phase for
phase and printed line for printed line:

```ts
// Headless circuit diagnostics — the port of `./DesktopFly --simtest`.
// Five conditions gate the exit code, exactly as in the Swift original.
// `--strict` additionally asserts the ranges the Swift suite only prints.

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
  [`walk-drive duty ${f(walkPct, 0)}% in 20-50%`, walkPct >= 20 && walkPct <= 50],
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
```

- [ ] **Step 2: Add the npm script**

In `windows/package.json`, add to `scripts`:

```json
    "simtest:strict": "node src/cli/simtest.ts --strict"
```

- [ ] **Step 3: Run the suite and read the output**

Run: `cd windows && npm run simtest:strict`
Expected: every line `PASS`, final line `PASS (strict): all invariants hold`,
exit 0.

Check `echo $LASTEXITCODE` (PowerShell) is 0.

Then confirm it is not seed-dependent:

Run: `node src/cli/simtest.ts --strict --seed=2` and `--seed=3`
Expected: PASS at all three seeds. If one seed fails an invariant, that is a
real finding about the port's fidelity — report it rather than picking the
seed that passes.

- [ ] **Step 4: Record the measured baseline**

Paste the printed `spontaneous 4s` and `behavior 20s` lines into the commit
message. These become the reference numbers for later milestones and for
comparison against the Swift build's output when a Mac is available.

- [ ] **Step 5: Commit**

```bash
git add windows/src/cli/simtest.ts windows/package.json
git commit -m "Windows port M1: --simtest suite with strict range assertions"
```

---

### Task 7: M1 documentation

**Files:**
- Create: `windows/README.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Write the Windows README**

Create `windows/README.md`:

```markdown
# DesktopFly for Windows

Windows port of DesktopFly. The brain is the same: the same `data/` files, the
same 668-neuron FlyWire v783 circuit, the same 1 kHz LIF dynamics.

**Status: M1 — core sim, headless.** No window and no fly yet; the simulation
and its diagnostics run under Node.

## Requirements

Node >= 24 (for native TypeScript type stripping). No dependencies.

## Commands

```sh
cd windows
node --test src           # unit tests
npm run datatest          # data invariants (668 neurons / 18,968 edges / 23,210 points)
npm run simtest           # circuit diagnostics, Swift-parity exit conditions
npm run simtest:strict    # also asserts the ranges the Swift suite only prints
```

## Differences from the macOS build

- **Seeded RNG.** `LIFSim` takes a seed so the suites are reproducible; the
  Swift build uses a non-deterministic system RNG.
- Parity with the macOS build is behavioral and statistical, never
  spike-for-spike.

See `docs/superpowers/specs/2026-08-19-windows-port-design.md` for the full
design, including the Win32 sensing substitutions planned for M3.
```

- [ ] **Step 2: Update CLAUDE.md**

In the `## Build, run, verify` section, replace the "Platform" paragraph
(which currently says Windows work is unverifiable) with:

```markdown
**Platform**: two targets share `data/`. The root Swift build is macOS-only
(Cocoa/SceneKit, bare `swiftc`, macOS 13+) and cannot be built or tested on
Windows — say so plainly rather than implying its suites passed. The
`windows/` subtree is the Electron/TypeScript port and IS verifiable here:
`cd windows && node --test src && npm run simtest:strict`. `etl.py` and the
`data/*.json` invariants are checkable on either platform.
```

Add to the `## Files` table:

```markdown
| `windows/` | Electron + TypeScript + Three.js port; `src/core` is the sim, transliterated from `Sim.swift` (see `docs/superpowers/specs/2026-08-19-windows-port-design.md`) |
```

- [ ] **Step 3: Verify the documented commands actually work**

Run each command in `windows/README.md` and confirm it behaves as documented.
A README command that does not run is a bug in this task.

- [ ] **Step 4: Commit**

```bash
git add windows/README.md CLAUDE.md
git commit -m "Windows port M1: document the port's status and commands"
```

---

## M1 Definition of Done

- [ ] `cd windows && node --test src` — all tests pass
- [ ] `npm run datatest` — exit 0
- [ ] `npm run simtest:strict` — exit 0 at seeds 1, 2, and 3
- [ ] `npx tsc --noEmit` type-checks clean (needs a one-off `npx`; skip if
      offline — Node strips types at runtime regardless)
- [ ] No npm dependencies added
- [ ] `data/` unmodified (`git status` clean for `data/`)
- [ ] The measured spontaneous/behavior rates are recorded in a commit message

## Next

M2 (body and overlay) gets its own plan, written after M1 lands, because its
tasks depend on the `LIFSim` and `SignalBuilder` interfaces this milestone
actually produced. M2's first task will add `three` — the first npm dependency.
