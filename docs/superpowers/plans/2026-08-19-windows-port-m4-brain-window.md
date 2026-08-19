# DesktopFly Windows Port — M4 (Brain Window) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the fly's actual brain — 23,210 real soma positions as a rotating
point cloud, the 668-neuron circuit highlighted on top, live spikes flashing at
their true locations, and click-to-stimulate that makes the body react.

**Architecture:** A second, ordinary (interactive) Electron window. The sim stays
in the overlay renderer where M2b put it, so spikes travel overlay → main → brain
and stimulation requests travel back; only *visuals* cross IPC, never the escape
pathway. Colour mapping and click-picking are pure `core/` modules with tests;
the point-cloud rendering is verified by capture.

**Tech Stack:** Node 24, `three`, `electron`, `koffi`, `esbuild`.

**Spec:** `docs/superpowers/specs/2026-08-19-windows-port-design.md`
**Predecessors:** M1, M2a, M2b, M3 — all complete.

## Global Constraints

- Everything from M1–M3 still applies: Node ≥ 24, no codegen TypeScript
  constructs, explicit `.ts` extensions, the Swift source is normative, `data/`
  read-only, MIT, `core/`+`body/` free of Electron/koffi/`WebGLRenderer`.
- **The sim must not move.** Stepping it in main, or duplicating it in the brain
  window, would put the LC→GF escape race behind IPC. Spikes are cosmetic and may
  lag; the giant fiber may not.
- Additive blending and depth-write-off are what make 23k points read as a brain
  rather than a grey fog. `writesToDepthBuffer = false` in Swift maps to
  `depthWrite: false`.

## Deviation from the writing-plans skill

As before: full code for every test, implementation cited by Swift line range.
Task 3's rendering has no unit test — it is verified by rendering the window to a
PNG and looking at it.

---

### Task 1: The colour palettes — `core/brainColors.ts`

**Files:**
- Create: `windows/src/core/brainColors.ts`
- Create: `windows/src/core/brainColors.test.ts`

**Interfaces:**
- Produces: `SUPER_CLASS_COLORS: ReadonlyArray<[number, number, number]>` (sRGB
  0..1, index order from `etl.py`'s `SUPER_CLASSES`);
  `superClassColor(index: number): [number, number, number]`;
  `roleColor(role: string): [number, number, number]`.

- [ ] **Step 1: Write the failing test**

Create `windows/src/core/brainColors.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrainData } from './data.ts';
import { roleColor, superClassColor, SUPER_CLASS_COLORS } from './brainColors.ts';

test('there is a colour for every super-class the ETL emits', () => {
  // etl.py:143 lists nine; data/brain_points.json carries the same list, and a
  // point whose classIndex has no colour would render as a grey smudge.
  const { points } = loadBrainData()!;
  assert.equal(points.classes.length, 9);
  assert.equal(SUPER_CLASS_COLORS.length, points.classes.length);
});

test('every point in the real data maps to a defined colour', () => {
  const { points } = loadBrainData()!;
  const seen = new Set<number>();
  for (const p of points.points) seen.add(p[3]);
  for (const ci of seen) {
    const c = superClassColor(ci);
    assert.equal(c.length, 3);
    assert.ok(c.every((v) => v >= 0 && v <= 1), `class ${ci} colour out of range`);
  }
  // optic dominates the cloud and is deliberately the dimmest, so the rest read
  const optic = superClassColor(0);
  const descending = superClassColor(5);
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  assert.ok(lum(optic) < lum(descending),
    'optic must stay subtler than descending');
});

test('an out-of-range class index falls back instead of throwing', () => {
  assert.deepEqual(superClassColor(99).length, 3);
  assert.deepEqual(superClassColor(-1).length, 3);
});

test('every circuit role has its own distinguishable colour', () => {
  // BrainView.swift:81-90. Clicking a region should be identifiable by colour,
  // so no two roles may share one.
  const roles = ['lc4', 'lplc2', 'gf', 'dna01', 'dna02', 'dnp09', 'dng11',
    'mdn', 'escw', 'other'];
  const seen = new Map<string, string>();
  for (const r of roles) {
    const key = roleColor(r).map((v) => v.toFixed(3)).join(',');
    // lc4 and lplc2 intentionally share one colour: they are one population
    if (r === 'lplc2') {
      assert.equal(key, seen.get('lc4'), 'lc4 and lplc2 should look alike');
      continue;
    }
    if (r === 'dna02') {
      assert.equal(key, seen.get('dna01'), 'DNa01 and DNa02 are one group');
      continue;
    }
    assert.equal(seen.has(key), false, `${r} reuses another role's colour`);
    seen.set(key, key);
    seen.set(r, key);
  }
  // the giant fiber is the brightest thing in the circuit
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  for (const r of roles.filter((x) => x !== 'gf')) {
    assert.ok(lum(roleColor('gf')) > lum(roleColor(r)),
      `GF should outshine ${r}`);
  }
});

test('an unknown role gets the neutral partner colour', () => {
  assert.deepEqual(roleColor('nonsense'), roleColor('other'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src/core/brainColors.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write the implementation**

Transliterate `BrainView.swift:39-49` (super-class palette) and `:81-90` (role
colours). Keep the comments explaining why optic is dim: it is the majority class
and would otherwise drown everything else.

- [ ] **Step 4: Run tests** — `node --test`, expect 131 tests.
- [ ] **Step 5: Commit** — `"Windows port M4: brain colour palettes"`

---

### Task 2: Click picking — `core/pick.ts`

**Files:**
- Create: `windows/src/core/pick.ts`
- Create: `windows/src/core/pick.test.ts`

**Interfaces:**
- Produces: `nearestToRay(positions: Float32Array, n: number, origin: Vec3,
  dir: Vec3): number`;
  `pickCluster(positions: Float32Array, n: number, anchor: number): number[]`;
  `regionName(roles: string[], types: string[], positions: Float32Array,
  picked: number[]): string`;
  `interface Vec3 { x: number; y: number; z: number }`.

- [ ] **Step 1: Write the failing test**

Create `windows/src/core/pick.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails** — module missing.

- [ ] **Step 3: Write the implementation**

Transliterate `BrainView.swift:264-322`, minus the SceneKit unprojection (the
renderer supplies the ray). `positions` is the flat `Float32Array` that `LIFSim`
already exposes, so no conversion is needed.

- [ ] **Step 4: Run tests** — expect 141 tests.
- [ ] **Step 5: Commit** — `"Windows port M4: brain click picking and region naming"`

---

### Task 3: The brain window

**Files:**
- Create: `windows/src/renderer/brain.ts`
- Create: `windows/src/renderer/brain.html`
- Modify: `windows/src/main/main.ts` (create the window, relay IPC)
- Modify: `windows/src/renderer/preload.ts` (brain channels)
- Modify: `windows/src/renderer/overlay.ts` (spike bus + stimulation intake)
- Modify: `windows/build.mjs` (bundle `brain.ts`, copy `brain.html`)

**Interfaces:**
- IPC: overlay → main → brain on `spikes` (`Array<{ neuron, isGF }>`);
  brain → main → overlay on `stimulate` (`{ indices: number[], strength: number,
  durationMs: number }`); brain pulls `getCircuit`/`getPoints` like the overlay.

- [ ] **Step 1: Build the scene**

`renderer/brain.ts`, from `BrainView.swift:58-140`:

- background `rgb(0.03, 0.035, 0.06)`, near-black so additive points glow.
- **cloud**: one `THREE.Points` with 23,210 vertices, per-vertex colours from
  `superClassColor`, `PointsMaterial({ vertexColors: true, blending:
  THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true })`.
- **circuit overlay**: a second `Points` of 668 vertices, `roleColor`, larger.
- **giant fibers**: two additive emissive spheres, radius 0.28, opacity 0.35.
- **flash pool**: 48 hidden additive spheres, radius 0.16, reused round-robin.
- rotation 0.35 rad / 6 s about Y, group tilted `x = -0.15`.
- camera: perspective, fov 46, at `(0, 0.6, 29)`, near 1, far 120.

Colour space: use `setRGB(..., THREE.SRGBColorSpace)` as M2b established, or the
palette will look washed out exactly as the fly did.

- [ ] **Step 2: Wire spikes and clicks**

- Overlay: construct `LIFSim` with a `SpikeBus`, drain it every frame and forward
  at most 24 events per ~33 ms batch (the pool is only 48 deep, and the bus can
  emit thousands per second). Send nothing when the batch is empty.
- Brain: on `spikes`, flash each neuron — GF flashes are 3.2× larger and fade over
  0.6 s versus 0.28 s (`BrainView.swift:161-163`).
- Brain: on click, unproject to a ray, convert it into the rotating group's local
  space, then `nearestToRay` → `pickCluster` → send `stimulate` with strength
  0.25 and 400 ms, flash the first 16, pulse the ring, and show the
  `regionName` label for 2.2 s.
- Brain: pointer enter/leave pauses and resumes the rotation, so a moving target
  can be aimed at (`BrainView.swift:258-260`).

- [ ] **Step 3: Create the window in main**

340×280, ordinary titled window (NOT click-through), `alwaysOnTop` at `floating`,
positioned bottom-right of the primary work area with an 18 px margin, title
`"Fly Brain — FlyWire v783 (click = stimulate)"`. Shown at startup when `data/`
loaded, exactly as `main.swift:753-757` does. Relay both IPC channels between the
two renderers.

- [ ] **Step 4: Verify by rendering it**

Add `npm run brainshot` — the parity item for `./DesktopFly --brainshot`
(`main.swift:111-123`), an offscreen render of the brain scene through a hidden
Electron window, same mechanism as `npm run snapshot`. The Swift version decorates
the preview with a burst of synthetic spikes so the flashes show; do the same.

Then **look at the image** beside `assets/brain.png`. Check: the cloud reads as a
brain shape rather than a fog, the circuit points stand out, the two GF markers
glow, and the background is near-black.

Then run `npm start` and confirm interactively: hovering pauses the rotation,
clicking a region shows a label naming it, and clicking the yellow GF markers
makes the fly take off.

- [ ] **Step 5: Commit** with the verdict in the message.

---

### Task 4: Documentation, including the deferred multi-monitor note

- [ ] **Step 1** `windows/README.md`: status M4; the brain window and what
  clicking does; **and the multi-monitor behaviour deferred from M3** — that the
  overlay spans every display (a deliberate departure from macOS's
  one-screen-at-a-time plus "Move to Next Display"), that the fly is confined to
  the union of real monitor rectangles, and the known cost that one window has a
  single scale factor so the fly renders ~20% larger on a 125% display beside a
  150% one.
- [ ] **Step 2** `CLAUDE.md`: the brain window's process split (sim stays in the
  overlay; only visuals cross IPC) and the `arena` concept.
- [ ] **Step 3** Verify every documented command runs.
- [ ] **Step 4** Commit.

---

## M4 Definition of Done

- [ ] `node --test` — all pass (expected 141)
- [ ] `behaviortest` 17/17; `simtest:strict` exit 0; `typecheck` clean
- [ ] `npm run brainshot` renders a recognisable brain, inspected against
      `assets/brain.png`, verdict recorded
- [ ] Clicking the GF markers makes the fly escape (the end-to-end payoff)
- [ ] `core/` still free of Electron, koffi and `WebGLRenderer`
- [ ] `data/` unmodified

## Next

M5: the tray menu (pause, show/hide brain, escape test, add/remove fly, scare),
plus packaging via electron-builder.
