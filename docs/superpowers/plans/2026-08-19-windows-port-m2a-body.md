# DesktopFly Windows Port — M2a (Body, Headless) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the procedural fly body and its behavior state machine to
TypeScript + Three.js, verified headless by all 17 `--behaviortest` checks — a
fully alive fly with no rendering yet.

**Architecture:** `body/flyModel.ts` builds the Three.js `Object3D` tree
(thorax, abdomen, head, six capsule legs, wings) from Three's built-in
primitives; `body/fly.ts` holds the `Fly` class — state machine, `brainBehavior`
consuming M1's `BrainSignals`, gait, flight, ledges. Three.js constructs scene
graphs without a WebGL context, so `cli/behaviortest.ts` asserts on real
`Object3D` transforms under plain Node.

**Tech Stack:** Node 24, `three` 0.185 (first runtime dependency).

**Spec:** `docs/superpowers/specs/2026-08-19-windows-port-design.md`
**Predecessor:** `docs/superpowers/plans/2026-08-19-windows-port-m1-core-sim.md` (complete)

## Global Constraints

- Everything from M1's Global Constraints still applies: Node ≥ 24, no codegen
  TypeScript constructs, explicit `.ts` extensions on relative imports, the
  Swift source is normative, `data/` is read-only, MIT.
- **`body/` may import `three` but must never construct a `WebGLRenderer`**, or
  the headless suites break. Geometry, materials, `Object3D`, textures only.
- `three` is a **runtime** dependency (M1's zero-dependency property ends here).
  A `package-lock.json` is now expected and committed.
- Parity is behavioral, never spike-for-spike or pixel-for-pixel.

## Deviation from the writing-plans skill, stated up front

This plan gives **full code for every test** but cites Swift line ranges instead
of duplicating implementation bodies. Rationale: the implementation is a
transliteration of ~700 lines whose normative source is already in this repo,
and copying it into the plan creates a second source of truth that can drift
from `FlyModel.swift` — the exact failure mode M1's plan warned about for
constants. The tests are where "done" is defined, so they are written out in
full. If this plan is ever handed to a fresh engineer instead of executed
in-session, expand the implementation steps first.

## Intentional deviations from the Swift source

1. **Euler-angle order must be verified, not assumed.** SceneKit's
   `eulerAngles` applies roll→yaw→pitch; Three.js `Object3D.rotation` defaults
   to order `'XYZ'`, which composes as `Rx·Ry·Rz` — the same order. This looks
   equivalent but Task 2 proves it numerically rather than trusting the reading.
2. **Geometry offsets replace pivot-relative node positions where needed.**
   Three's `CapsuleGeometry` is centered on its origin and runs along **+Y**,
   while `SCNCapsule` also centers but the Swift code rotates each segment by
   `-π/2` about Z to lay it along +X. Transliterate the rotation, do not
   "simplify" it — the leg chain's yaw/lift pivots depend on it.
3. **`abdomenTexture()` becomes a `DataTexture`**, not a canvas draw: four
   horizontal dark bands over a base color, written into a `Uint8Array`. No
   canvas exists headless, and the texture is four filled rectangles.
4. **`savePNG` is not ported here.** It belongs to the snapshot CLI (M2b), which
   runs under Electron.
5. **`Fly` takes an optional `seed`**, threaded into a `Rng` for all `rnd()`
   calls, for the same reproducibility reason as `LIFSim`. Behavior tests that
   depend on random state pass a fixed seed.

---

### Task 1: Dependency, constants, and the two missing math helpers

**Files:**
- Modify: `windows/package.json` (add `three`)
- Create: `windows/package-lock.json` (generated)
- Modify: `windows/src/core/mathutil.ts` (add `angleDiff`, `smoothstep`)
- Create: `windows/src/core/mathutil.test.ts`
- Create: `windows/src/body/constants.ts`

**Interfaces:**
- Consumes: `core/mathutil.ts` from M1.
- Produces: `angleDiff(from: number, to: number): number`,
  `smoothstep(t: number): number`;
  `FLY_SCALE = 1.15`, `EDGE_MARGIN = 50`, `SCARE_RADIUS = 110`,
  `NERVOUS_RADIUS = 240` from `body/constants.ts`.

- [ ] **Step 1: Write the failing test**

Create `windows/src/core/mathutil.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { angleDiff, smoothstep, clampf, makeRng, rnd } from './mathutil.ts';

test('angleDiff returns the shortest signed turn', () => {
  // FlyModel.swift:16-21
  assert.ok(Math.abs(angleDiff(0, 0.5) - 0.5) < 1e-12);
  assert.ok(Math.abs(angleDiff(0.5, 0) + 0.5) < 1e-12);
  // wrapping: from just under 2pi to just over 0 is a small positive turn
  const d = angleDiff(Math.PI * 2 - 0.1, 0.1);
  assert.ok(Math.abs(d - 0.2) < 1e-9, `${d}`);
  // never returns more than half a turn
  for (let a = -10; a < 10; a += 0.37) {
    for (let b = -10; b < 10; b += 0.41) {
      assert.ok(Math.abs(angleDiff(a, b)) <= Math.PI + 1e-9);
    }
  }
});

test('smoothstep is clamped, symmetric, and flat at both ends', () => {
  // FlyModel.swift:22
  assert.equal(smoothstep(-5), 0);
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(0.5), 0.5);
  assert.equal(smoothstep(1), 1);
  assert.equal(smoothstep(5), 1);
  assert.ok(Math.abs(smoothstep(0.25) + smoothstep(0.75) - 1) < 1e-12);
  // monotonic
  let prev = -1;
  for (let t = 0; t <= 1; t += 0.05) {
    const v = smoothstep(t);
    assert.ok(v >= prev);
    prev = v;
  }
});

test('clampf and the seeded rng still behave (M1 regression)', () => {
  assert.equal(clampf(5, 0, 1), 1);
  const a = makeRng(42);
  const b = makeRng(42);
  assert.equal(a(), b());
  const r = makeRng(7);
  for (let i = 0; i < 1000; i++) {
    const v = rnd(r, -3, 9);
    assert.ok(v >= -3 && v < 9);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src/core/mathutil.test.ts`
Expected: FAIL — `angleDiff is not a function`

- [ ] **Step 3: Install `three` and implement**

```bash
cd windows && npm install three@^0.185
```

Add to `windows/src/core/mathutil.ts`, transliterating `FlyModel.swift:16-22`
(`angleDiff` takes the remainder against 2π then folds into ±π; `smoothstep` is
`x*x*(3-2x)` over a clamped input).

Create `windows/src/body/constants.ts` with the four constants from
`FlyModel.swift:8-12`, each keeping its Swift comment (`SCARE_RADIUS` and
`NERVOUS_RADIUS` are legacy-behavior-only — extra, brainless flies).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test`
Expected: PASS, 33 tests (30 from M1 + 3).

- [ ] **Step 5: Commit**

```bash
git add windows/package.json windows/package-lock.json windows/src
git commit -m "Windows port M2a: three dependency, angleDiff/smoothstep, body constants"
```

---

### Task 2: The fly body — geometry, legs, wings

**Files:**
- Create: `windows/src/body/flyModel.ts`
- Create: `windows/src/body/flyModel.test.ts`

**Interfaces:**
- Consumes: `body/constants.ts`, `core/mathutil.ts`.
- Produces: `class Leg` (fields `root: THREE.Object3D`, `baseYaw`, `swingSign`,
  `phase: number`, `isFront: boolean`, `angle`, `lift`; method `apply(): void`);
  `interface FlyModelParts { root, foldedWings, blurWingL, blurWingR, abdomen:
  THREE.Object3D; legs: Leg[] }`; `buildFlyModel(): FlyModelParts`;
  `abdomenTexture(): THREE.DataTexture`.

- [ ] **Step 1: Write the failing test**

Create `windows/src/body/flyModel.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildFlyModel } from './flyModel.ts';
import { FLY_SCALE } from './constants.ts';

test('Three.js default Euler order matches SceneKit roll-yaw-pitch', () => {
  // SceneKit applies eulerAngles as roll(z) -> yaw(y) -> pitch(x), which is the
  // composition Rx*Ry*Rz. Three's default order 'XYZ' claims the same. Prove it
  // against a hand-built matrix product rather than trusting the docs.
  const n = new THREE.Object3D();
  assert.equal(n.rotation.order, 'XYZ');
  n.rotation.set(0.3, -0.7, 1.1);
  n.updateMatrix();

  const rx = new THREE.Matrix4().makeRotationX(0.3);
  const ry = new THREE.Matrix4().makeRotationY(-0.7);
  const rz = new THREE.Matrix4().makeRotationZ(1.1);
  const expected = new THREE.Matrix4().multiply(rx).multiply(ry).multiply(rz);
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(n.matrix.elements[i] - expected.elements[i]) < 1e-12,
      `element ${i}: ${n.matrix.elements[i]} vs ${expected.elements[i]}`);
  }
});

test('the body has six legs at the Swift attach points', () => {
  const m = buildFlyModel();
  assert.equal(m.legs.length, 6);
  // FlyModel.swift:204-211 — three pairs, mirrored in x, all at z = 4.5
  const attach = m.legs.map((l) => l.root.position);
  assert.deepEqual(attach.map((p) => Number(p.z.toFixed(2))),
    [4.5, 4.5, 4.5, 4.5, 4.5, 4.5]);
  assert.deepEqual(attach.map((p) => Number(p.x.toFixed(1))),
    [3.1, -3.1, 3.7, -3.7, 3.3, -3.3]);
  assert.deepEqual(attach.map((p) => Number(p.y.toFixed(1))),
    [5.3, 5.3, 2.0, 2.0, -1.2, -1.2]);
  // only the front pair grooms
  assert.deepEqual(m.legs.map((l) => l.isFront),
    [true, true, false, false, false, false]);
  // swingSign mirrors left/right
  assert.deepEqual(m.legs.map((l) => l.swingSign), [1, -1, 1, -1, 1, -1]);
  // tripod gait: alternating phase offsets
  assert.deepEqual(m.legs.map((l) => l.phase), [0.0, 0.5, 0.5, 0.0, 0.0, 0.5]);
});

test('each leg is a femur-knee-tibia-ankle-tarsus chain', () => {
  const m = buildFlyModel();
  for (const leg of m.legs) {
    // root -> [femurMesh, knee]; knee -> [tibiaMesh, ankle]; ankle -> [tarsus]
    const knee = leg.root.children.find((c) => c.children.length > 0);
    assert.ok(knee, 'leg root should carry a knee with descendants');
    const ankle = knee.children.find((c) => c.children.length > 0);
    assert.ok(ankle, 'knee should carry an ankle');
    assert.ok(ankle.children.length >= 1, 'ankle should carry a tarsus');
  }
});

test('leg.apply drives yaw and lift, and the foot ends up below the body', () => {
  const m = buildFlyModel();
  const leg = m.legs[0];              // right front, swingSign +1
  leg.angle = 0;
  leg.lift = 0;
  leg.apply();
  assert.ok(Math.abs(leg.root.rotation.z - leg.baseYaw) < 1e-12);
  assert.equal(leg.root.rotation.y, 0);

  // lift raises the leg: rotation.y = -lift (FlyModel.swift:75)
  leg.lift = 0.5;
  leg.apply();
  assert.ok(Math.abs(leg.root.rotation.y + 0.5) < 1e-12);

  // swing displaces yaw by swingSign * angle
  leg.lift = 0;
  leg.angle = 0.3;
  leg.apply();
  assert.ok(Math.abs(leg.root.rotation.z - (leg.baseYaw + 0.3)) < 1e-12);

  // and the whole chain must reach outward and downward from its attachment:
  // the foot tip is farther from the body midline than the hip, and lower.
  m.root.updateMatrixWorld(true);
  const tip = deepestDescendant(leg.root);
  const tipWorld = new THREE.Vector3().setFromMatrixPosition(tip.matrixWorld);
  const hipWorld = new THREE.Vector3().setFromMatrixPosition(leg.root.matrixWorld);
  assert.ok(Math.abs(tipWorld.x) > Math.abs(hipWorld.x),
    `foot x ${tipWorld.x} should be outboard of hip x ${hipWorld.x}`);
  assert.ok(tipWorld.z < hipWorld.z,
    `foot z ${tipWorld.z} should be below hip z ${hipWorld.z}`);
});

function deepestDescendant(n: THREE.Object3D): THREE.Object3D {
  let cur = n;
  for (;;) {
    const next = cur.children.find((c) => c.children.length > 0)
      ?? cur.children[0];
    if (next === undefined) return cur;
    cur = next;
  }
}

test('wings: two folded shapes plus two hidden blur discs', () => {
  const m = buildFlyModel();
  assert.equal(m.foldedWings.children.length, 2);
  // FlyModel.swift:221-226 — mirrored in x, slightly different z per side
  const [wl, wr] = m.foldedWings.children;
  assert.ok(wl.position.x < 0 && wr.position.x > 0);
  assert.ok(Math.abs(wl.rotation.z + 0.13) < 1e-12);
  assert.ok(Math.abs(wr.rotation.z - 0.13) < 1e-12);
  // blur discs start hidden (FlyModel.swift:240)
  assert.equal(m.blurWingL.visible, false);
  assert.equal(m.blurWingR.visible, false);
});

test('root carries FLY_SCALE and the abdomen is a distinct node', () => {
  const m = buildFlyModel();
  assert.ok(Math.abs(m.root.scale.x - FLY_SCALE) < 1e-12);
  assert.ok(Math.abs(m.root.scale.y - FLY_SCALE) < 1e-12);
  assert.ok(Math.abs(m.root.scale.z - FLY_SCALE) < 1e-12);
  // abdomen scale is set every frame for breathing (FlyModel.swift:434)
  assert.ok(m.abdomen.position.y < 0, 'abdomen sits behind the thorax');
});

test('the abdomen texture has banding, not a flat fill', () => {
  const m = buildFlyModel();
  const tex = (m.abdomen as THREE.Mesh).material as THREE.MeshPhongMaterial;
  const data = (tex.map!.image as { data: Uint8Array }).data;
  const rowColor = (y: number) => data[(y * 64) * 4];   // red channel, x = 0
  // FlyModel.swift:43-58: dark bands at y 0-26, 38-48, 60-70, 82-91 over a
  // lighter base. Sample inside a band and inside the base.
  assert.ok(rowColor(10) < rowColor(32),
    `band row ${rowColor(10)} should be darker than base row ${rowColor(32)}`);
  assert.ok(rowColor(64) < rowColor(100));
});

test('two flies do not share geometry state', () => {
  const a = buildFlyModel();
  const b = buildFlyModel();
  a.legs[0].angle = 1.2;
  a.legs[0].apply();
  b.legs[0].apply();
  assert.notEqual(a.legs[0].root.rotation.z, b.legs[0].root.rotation.z);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src/body/flyModel.test.ts`
Expected: FAIL — `Cannot find module ... flyModel.ts`

- [ ] **Step 3: Write the implementation**

Create `windows/src/body/flyModel.ts`, transliterating `FlyModel.swift:24-249`:

- `mat()` (`:24-31`) → a helper returning `MeshPhongMaterial` (`.blinn` is
  Phong shading; `specular` a grey, `shininess` scaled to Three's 0-100 range).
- `abdomenTexture()` (`:43-58`) → `DataTexture`, 64×128 RGBA `Uint8Array`, base
  `(184, 140, 82)`, bands `(56, 38, 23)` at the four y ranges. Set
  `needsUpdate = true`.
- `Leg` + `apply()` (`:60-77`) → `rotation.set(0, -lift, baseYaw + swingSign * angle)`.
- `buildLeg()` (`:88-128`) → `CapsuleGeometry(radius, length)` per segment; each
  segment mesh keeps its `-π/2` Z rotation and half-length +X offset, and the
  knee/ankle pivots keep their exact positions and Euler triples.
- `wingShape()` (`:130-142`) → `THREE.Shape` ellipse via `absellipse` matching
  `NSBezierPath(ovalIn:)` at x −2.6, y −15.5, w 5.2, h 16.5, extruded 0.12,
  double-sided translucent material (`opacity 0.28`, `transparent: true`).
- `buildFlyModel()` (`:144-249`) → the thorax/abdomen/head/eyes/antennae/
  proboscis spheres, cones and capsules with their exact positions and scales,
  the six legs from the `specs` table (`:204-211`, note
  `baseYaw = side > 0 ? yawOff : π - yawOff`), folded wings, and the two hidden
  blur discs.

**Watch for:** `SCNCapsule(capRadius:height:)`'s `height` is the **total**
length including caps; Three's `CapsuleGeometry(radius, length)` takes the
length of the *cylindrical section only*. Pass `height - 2 * capRadius`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test`
Expected: PASS, 41 tests.

- [ ] **Step 5: Commit**

```bash
git add windows/src/body
git commit -m "Windows port M2a: procedural fly body — legs, wings, abdomen texture"
```

---

### Task 3: Fly core — state, flight, altitude, landing

**Files:**
- Create: `windows/src/body/fly.ts`
- Create: `windows/src/body/flight.test.ts`

**Interfaces:**
- Consumes: `body/flyModel.ts`, `body/constants.ts`, `core/types.ts`,
  `core/mathutil.ts`.
- Produces: `type FlyState = 'walking' | 'idle' | 'grooming' | 'flying' | 'sleeping'`;
  `class Fly` with constructor `(at: {x, y}, seed?: number)`, public
  `pos`, `heading`, `speed`, `state`, `stateTimer`, `gaitPhase`, `time`,
  `scareCooldown`, `dartCooldown`, `backwardTimer`, `dartTimer`, `stateAge`,
  `terrain: Ledge[]`, `ledge: Ledge | null`, `alt`, `pitch`, `flapPhase`,
  `wingRaise`, `flightEffort`, `effortCurrent`, getters `node`, `model`,
  `gaitPhasePublic`, `walkingIntensity`; methods
  `syncNode()`, `startFlight(opts: { bounds, awayFrom?, escape?, effort? })`,
  `update(dt, bounds, mouse, signals)`.

Note the one signature change from Swift: `startFlight` takes an options object
rather than four defaulted parameters, because TypeScript has no named
arguments and positional booleans at call sites are unreadable.

- [ ] **Step 1: Write the failing test**

Create `windows/src/body/flight.test.ts` — these are the five flight-related
checks from the Swift `--behaviortest` (`main.swift:364-446`), plus a state
machine check:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fly } from './fly.ts';
import { FLY_SCALE } from './constants.ts';
import { defaultSignals } from '../core/types.ts';

const BOUNDS = { width: 1512, height: 982 };
const DT = 1 / 60;

test('altitude drives scale; escape flies higher than casual', () => {
  // main.swift:364-385
  function flight(escape: boolean, effort?: number) {
    const fly = new Fly({ x: 0, y: 0 }, 1);
    fly.state = 'idle';
    fly.startFlight({ bounds: BOUNDS, escape, effort });
    let maxAlt = 0;
    let maxScale = 0;
    let frames = 0;
    while (fly.state === 'flying' && frames < 400) {
      frames++;
      fly.update(DT, BOUNDS, null, defaultSignals());
      maxAlt = Math.max(maxAlt, fly.alt);
      maxScale = Math.max(maxScale, fly.node.scale.x);
    }
    return { alt: maxAlt, scale: maxScale };
  }
  const esc = flight(true);
  const casual = flight(false, 0.45);
  assert.ok(esc.alt > casual.alt + 0.15,
    `escape alt ${esc.alt} vs casual ${casual.alt}`);
  assert.ok(esc.scale > FLY_SCALE * 1.5, `escape scale ${esc.scale}`);
  // scale tracks altitude exactly: FLY_SCALE * (1 + 0.8 * alt)
  assert.ok(Math.abs(esc.scale - FLY_SCALE * (1 + 0.8 * esc.alt)) < 0.15);
});

test('wings actually beat in flight', () => {
  // main.swift:387-398
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'idle';
  fly.startFlight({ bounds: BOUNDS, effort: 0.8 });
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 30 && fly.state === 'flying'; i++) {
    fly.update(DT, BOUNDS, null, defaultSignals());
    const z = fly.model.foldedWings.children[0].rotation.z;
    lo = Math.min(lo, z);
    hi = Math.max(hi, z);
  }
  assert.ok(hi - lo > 0.25, `wing sweep ${hi - lo} rad over 0.5 s`);
});

test('escape-DN activity mid-flight raises wing-beat effort', () => {
  // main.swift:400-414 — live modifiers must never weaken takeoff
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'idle';
  fly.startFlight({ bounds: BOUNDS, effort: 0.5 });
  for (let i = 0; i < 12; i++) fly.update(DT, BOUNDS, null, defaultSignals());
  const calm = fly.effortCurrent;
  const hot = defaultSignals();
  hot.wingDrive = 1.0;
  hot.arousal = 0.6;
  for (let i = 0; i < 12 && fly.state === 'flying'; i++) {
    fly.update(DT, BOUNDS, null, hot);
  }
  assert.ok(fly.state === 'flying' && fly.effortCurrent > calm + 0.2,
    `effort ${calm} -> ${fly.effortCurrent}`);
});

test('threat while grounded raises the wings without taking off', () => {
  // main.swift:416-425
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'walking';
  fly.speed = 20;
  fly.dartCooldown = 99;            // isolate the posture from darting
  const threat = defaultSignals();
  threat.wingDrive = 0.9;
  threat.walkDrive = 0.4;
  for (let i = 0; i < 40; i++) fly.update(DT, BOUNDS, null, threat);
  const x = fly.model.foldedWings.children[0].rotation.x;
  assert.notEqual(fly.state, 'flying');
  assert.ok(fly.wingRaise > 0.6, `raise ${fly.wingRaise}`);
  assert.ok(x < -0.2, `wing tilt ${x} rad`);
});

test('landing is smooth: no scale or height snap at touchdown', () => {
  // main.swift:427-446 — landing must go through the flare, never snap
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'idle';
  fly.startFlight({ bounds: BOUNDS, escape: true });
  let prevScale = fly.node.scale.x;
  let prevZ = fly.node.position.z;
  let maxDS = 0;
  let maxDZ = 0;
  let post = 20;
  let frames = 0;
  let landed = false;
  while (post > 0 && frames < 600) {
    frames++;
    fly.update(DT, BOUNDS, null, defaultSignals());
    maxDS = Math.max(maxDS, Math.abs(fly.node.scale.x - prevScale));
    maxDZ = Math.max(maxDZ, Math.abs(fly.node.position.z - prevZ));
    prevScale = fly.node.scale.x;
    prevZ = fly.node.position.z;
    if (fly.state !== 'flying') {
      landed = true;
      post--;
    }
  }
  assert.ok(landed, 'never landed');
  assert.ok(maxDS < 0.2, `max per-frame scale jump ${maxDS}`);
  assert.ok(maxDZ < 25, `max per-frame z jump ${maxDZ}`);
});

test('landing refolds the wings and hides the blur discs', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'idle';
  fly.startFlight({ bounds: BOUNDS, escape: true });
  assert.equal(fly.model.blurWingL.visible, true);
  let frames = 0;
  while (fly.state === 'flying' && frames < 600) {
    frames++;
    fly.update(DT, BOUNDS, null, defaultSignals());
  }
  assert.equal(fly.state, 'idle');
  assert.equal(fly.model.blurWingL.visible, false);
  assert.equal(fly.model.blurWingR.visible, false);
  assert.ok(Math.abs(fly.model.foldedWings.children[1].rotation.z - 0.13) < 1e-9);
  assert.equal(fly.alt, 0);
  assert.equal(fly.node.position.z, 0);
  assert.ok(Math.abs(fly.node.scale.x - FLY_SCALE) < 1e-12);
});

test('legacy path: no signals means mouse-distance fear', () => {
  // Extra, brainless flies (FlyModel.swift:405-427). A cursor inside
  // SCARE_RADIUS must launch a flight.
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'walking';
  fly.speed = 30;
  fly.update(DT, BOUNDS, { x: 40, y: 0 }, null);
  assert.equal(fly.state, 'flying');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src/body/flight.test.ts`
Expected: FAIL — `Cannot find module ... fly.ts`

- [ ] **Step 3: Write the implementation**

Create `windows/src/body/fly.ts` with the `Fly` class covering
`FlyModel.swift:253-363` (fields, `syncNode`, `startFlight`, `land`,
`pickNextState`), `:507`, `:557-600` (`effectiveSpeed`, `applyAltitude`,
`updateFlight`), `:602-681` (`updateLegs`, `updateWings`), and the `update`
dispatch at `:386-436` including the legacy mouse-distance branch.

**Coordinate note:** the Swift code puts height in `node.position.z` and yaw in
`eulerAngles.z` because the overlay camera looks down −Z at an XY plane. Keep
that convention exactly — M2b's camera is built to match, and every altitude and
gait-bob assertion above depends on it.

**Do not** let `land()` snap scale or z outside the flare: `updateFlight` decays
`alt` and only calls `land()` once `alt < 0.035` (`:575`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test`
Expected: PASS, 48 tests.

- [ ] **Step 5: Commit**

```bash
git add windows/src/body
git commit -m "Windows port M2a: Fly core — flight, altitude, flare landing, legs, wings"
```

---

### Task 4: Walking, ledges, and window terrain

**Files:**
- Modify: `windows/src/body/fly.ts` (add `updateWalk`)
- Create: `windows/src/body/walk.test.ts`

**Interfaces:**
- Consumes: `Ledge` from `core/types.ts`.
- Produces: `Fly.updateWalk` behavior reachable through `update()`.

- [ ] **Step 1: Write the failing test**

Create `windows/src/body/walk.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fly } from './fly.ts';
import { defaultSignals, type Ledge } from '../core/types.ts';

const BOUNDS = { width: 1512, height: 982 };
const DT = 1 / 60;

function walkSignals() {
  const s = defaultSignals();
  s.walkDrive = 0.6;
  return s;
}

test('the fly attaches to a window edge and follows it', () => {
  // main.swift:316-325
  const fly = new Fly({ x: 0, y: -55 }, 1);
  fly.state = 'walking';
  fly.speed = 30;
  fly.heading = 0;
  fly.terrain = [{ y: -40, x0: -300, x1: 300, id: 1 }];
  let attached = false;
  for (let i = 0; i < 240; i++) {
    fly.update(DT, BOUNDS, null, walkSignals());
    if (fly.ledge !== null && Math.abs(fly.pos.y + 40) < 8) {
      attached = true;
      break;
    }
  }
  assert.ok(attached, `state=${fly.state} y=${fly.pos.y} ledge=${fly.ledge}`);
});

test('a window closing underfoot launches a flight', () => {
  // main.swift:327-338
  const fly = new Fly({ x: 0, y: -40 }, 1);
  fly.state = 'walking';
  fly.speed = 25;
  fly.heading = 0;
  const L: Ledge = { y: -40, x0: -300, x1: 300, id: 1 };
  fly.terrain = [L];
  fly.ledge = L;
  fly.terrain = [];                 // the window vanished
  let tookOff = false;
  for (let i = 0; i < 60; i++) {
    fly.update(DT, BOUNDS, null, walkSignals());
    if (fly.state === 'flying') {
      tookOff = true;
      break;
    }
  }
  assert.ok(tookOff, `state=${fly.state}`);
});

test('walking along a ledge stays within its x range', () => {
  const fly = new Fly({ x: 0, y: -40 }, 1);
  fly.state = 'walking';
  fly.speed = 120;
  fly.heading = 0;
  const L: Ledge = { y: -40, x0: -100, x1: 100, id: 7 };
  fly.terrain = [L];
  fly.ledge = L;
  for (let i = 0; i < 600; i++) {
    fly.update(DT, BOUNDS, null, walkSignals());
    if (fly.ledge === null) break;         // wandering off is allowed
    assert.ok(fly.pos.x >= L.x0 - 1e-6 && fly.pos.x <= L.x1 + 1e-6,
      `x ${fly.pos.x} left the ledge`);
  }
});

test('a dragged window carries the fly with it', () => {
  const fly = new Fly({ x: 0, y: -40 }, 1);
  fly.state = 'walking';
  fly.speed = 10;
  fly.heading = 0;
  fly.terrain = [{ y: -40, x0: -300, x1: 300, id: 3 }];
  fly.ledge = fly.terrain[0];
  // same window id, moved up 30 pt (within the 40 pt tolerance)
  fly.terrain = [{ y: -10, x0: -300, x1: 300, id: 3 }];
  for (let i = 0; i < 60; i++) fly.update(DT, BOUNDS, null, walkSignals());
  assert.equal(fly.state, 'walking');
  assert.ok(Math.abs(fly.pos.y + 10) < 8, `y ${fly.pos.y} did not follow to -10`);
});

test('free walking stays inside the screen bounds', () => {
  const fly = new Fly({ x: 700, y: 450 }, 3);
  fly.state = 'walking';
  fly.speed = 150;
  fly.heading = 0.4;                 // aimed at the corner
  for (let i = 0; i < 900; i++) {
    fly.update(DT, BOUNDS, null, walkSignals());
    if (fly.state !== 'walking') continue;
    assert.ok(Math.abs(fly.pos.x) <= BOUNDS.width / 2 - 20 + 1e-6,
      `x ${fly.pos.x} escaped`);
    assert.ok(Math.abs(fly.pos.y) <= BOUNDS.height / 2 - 20 + 1e-6,
      `y ${fly.pos.y} escaped`);
  }
});

test('backward walking moves opposite the heading', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'walking';
  fly.speed = 40;
  fly.heading = 0;                   // facing +x
  fly.backwardTimer = 0.5;
  const x0 = fly.pos.x;
  for (let i = 0; i < 20; i++) fly.update(DT, BOUNDS, null, walkSignals());
  assert.ok(fly.pos.x < x0, `moved to ${fly.pos.x}, expected less than ${x0}`);
});

test('the gait bobs the body vertically while walking', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'walking';
  fly.speed = 60;
  fly.heading = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 60; i++) {
    fly.update(DT, BOUNDS, null, walkSignals());
    lo = Math.min(lo, fly.node.position.z);
    hi = Math.max(hi, fly.node.position.z);
  }
  assert.ok(hi - lo > 0.1, `gait bob range ${hi - lo}`);
  assert.ok(hi <= 0.35 + 1e-9, `bob peaked at ${hi}, above the 0.35 cap`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src/body/walk.test.ts`
Expected: FAIL — walking does not move the fly / `updateWalk` missing.

- [ ] **Step 3: Write the implementation**

Add `updateWalk` to `body/fly.ts`, transliterating `FlyModel.swift:509-555`:
ledge refresh against `terrain` by `id` with the 40 pt tolerance (vanished ⇒
`startFlight`), on-ledge walking (heading snapped toward 0 or π, y eased onto
the edge, x clamped, 5%/s chance of wandering off), free walking (random
heading drift, turn back toward centre outside the margins, position clamped,
0.9/s chance of latching onto an overlapping ledge), and the gait bob into
`node.position.z`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test`
Expected: PASS, 55 tests.

- [ ] **Step 5: Commit**

```bash
git add windows/src/body
git commit -m "Windows port M2a: walking, ledge attachment, window terrain"
```

---

### Task 5: brainBehavior — the sim drives the body

**Files:**
- Modify: `windows/src/body/fly.ts` (add `brainBehavior`)
- Create: `windows/src/body/brainBehavior.test.ts`

**Interfaces:**
- Consumes: `BrainSignals` from `core/types.ts`.
- Produces: `Fly.brainBehavior` reachable through `update()` whenever
  `signals !== null` and the fly is grounded.

- [ ] **Step 1: Write the failing test**

Create `windows/src/body/brainBehavior.test.ts`. These use hand-built signals;
Task 6 drives the same paths from the real network:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fly } from './fly.ts';
import { defaultSignals } from '../core/types.ts';

const BOUNDS = { width: 1512, height: 982 };
const DT = 1 / 60;

test('a GF spike takes off immediately, even out of sleep', () => {
  for (const from of ['idle', 'walking', 'grooming', 'sleeping'] as const) {
    const fly = new Fly({ x: 0, y: 0 }, 1);
    fly.state = from;
    const s = defaultSignals();
    s.escape = true;
    fly.update(DT, BOUNDS, null, s);
    assert.equal(fly.state, 'flying', `escape failed from ${from}`);
  }
});

test('sleep holds the fly still and waking triggers grooming', () => {
  // main.swift:340-349
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'idle';
  const s = defaultSignals();
  s.sleep = true;
  for (let i = 0; i < 60; i++) fly.update(DT, BOUNDS, null, s);
  assert.equal(fly.state, 'sleeping');
  assert.equal(fly.speed, 0);
  s.sleep = false;
  fly.update(DT, BOUNDS, null, s);
  assert.equal(fly.state, 'grooming');
});

test('walk drive starts and stops walking with hysteresis', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'idle';
  fly.speed = 0;
  const go = defaultSignals();
  go.walkDrive = 0.6;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, go);
  assert.equal(fly.state, 'walking');
  assert.ok(fly.speed > 40 && fly.speed < 100, `speed ${fly.speed}`);

  const stop = defaultSignals();
  stop.walkDrive = 0.05;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, stop);
  assert.equal(fly.state, 'idle');
  assert.equal(fly.speed, 0);
});

test('groom drive has a dead band between 0.3 and 0.5', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'idle';
  const mid = defaultSignals();
  mid.groomDrive = 0.4;              // inside the dead band: no change
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, mid);
  assert.equal(fly.state, 'idle');

  const on = defaultSignals();
  on.groomDrive = 0.6;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, on);
  assert.equal(fly.state, 'grooming');

  const off = defaultSignals();
  off.groomDrive = 0.2;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, off);
  assert.equal(fly.state, 'idle');
});

test('tempo scales walking speed', () => {
  // main.swift:351-362
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'walking';
  fly.speed = 20;
  fly.heading = 0;
  const cool = defaultSignals();
  cool.walkDrive = 0.6;
  cool.tempo = 1.0;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, cool);
  const coolSpeed = fly.speed;
  const hot = defaultSignals();
  hot.walkDrive = 0.6;
  hot.tempo = 1.5;
  for (let i = 0; i < 120; i++) fly.update(DT, BOUNDS, null, hot);
  assert.ok(fly.state === 'walking' && fly.speed > coolSpeed + 10,
    `cool ${coolSpeed} -> hot ${fly.speed} pt/s`);
});

test('a hot looming population darts the fly away from the cursor', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'idle';
  const s = defaultSignals();
  s.nervous = 0.8;
  fly.update(DT, BOUNDS, { x: 100, y: 0 }, s);
  assert.equal(fly.state, 'walking');
  assert.ok(fly.speed > 100, `dart speed ${fly.speed}`);
  // heading points away from the cursor: cos(heading) should be negative
  assert.ok(Math.cos(fly.heading) < 0.4, `heading ${fly.heading} not away`);
});

test('MDN backward bursts fire from every grounded state', () => {
  // MDN was once dead from idle — regression guard
  for (const from of ['idle', 'walking', 'grooming'] as const) {
    const fly = new Fly({ x: 0, y: 0 }, 1);
    fly.state = from;
    const s = defaultSignals();
    s.backward = true;
    fly.update(DT, BOUNDS, null, s);
    assert.ok(fly.backwardTimer > 0, `MDN dead from ${from}`);
  }
});

test('turnBias steers while walking but not while on a ledge', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = 'walking';
  fly.speed = 30;
  fly.heading = 0;
  const s = defaultSignals();
  s.walkDrive = 0.6;
  s.turnBias = 0.9;
  for (let i = 0; i < 84; i++) fly.update(DT, BOUNDS, null, s);
  assert.ok(fly.heading > 0.25, `heading change ${fly.heading} rad`);

  const onLedge = new Fly({ x: 0, y: -40 }, 1);
  onLedge.state = 'walking';
  onLedge.speed = 30;
  onLedge.heading = 0;
  onLedge.terrain = [{ y: -40, x0: -300, x1: 300, id: 1 }];
  onLedge.ledge = onLedge.terrain[0];
  for (let i = 0; i < 30; i++) onLedge.update(DT, BOUNDS, null, s);
  assert.ok(Math.abs(onLedge.heading) < 0.25,
    `ledge walking should not be steered: ${onLedge.heading}`);
});

test('high arousal makes spontaneous takeoff likely', () => {
  const fly = new Fly({ x: 0, y: 0 }, 5);
  fly.state = 'walking';
  fly.speed = 40;
  const s = defaultSignals();
  s.walkDrive = 0.6;
  s.arousal = 0.9;
  // flightChance 0.6/s => ~1% per frame; 600 frames leaves a 0.2% miss rate,
  // where 300 would fail roughly 1 run in 20.
  let took = false;
  for (let i = 0; i < 600 && !took; i++) {
    fly.update(DT, BOUNDS, null, s);
    took = fly.state === 'flying';
  }
  assert.ok(took, 'aroused fly never took off in 10 s');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src/body/brainBehavior.test.ts`
Expected: FAIL — brain signals are ignored.

- [ ] **Step 3: Write the implementation**

Add `brainBehavior` to `body/fly.ts`, transliterating `FlyModel.swift:444-505`.
**The order is load-bearing** (and `CLAUDE.md` documents why): escape first and
it returns; then sleep, which also returns; then the nervous dart; then the
DNg11 groom hysteresis (0.5 on / 0.3 off with the `stateAge` dwell guards);
then the DNp09 walk hysteresis (0.22 on / 0.08 off); then the MDN burst, which
must work from **every** grounded state; then speed tracking
`(14 + walkDrive * 55) * tempo`; then `heading += turnBias * dt` only when
`ledge === null`; then the arousal-gated spontaneous takeoff.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test`
Expected: PASS, 64 tests.

- [ ] **Step 5: Commit**

```bash
git add windows/src/body
git commit -m "Windows port M2a: brainBehavior — real neurons drive the body"
```

---

### Task 6: The `--behaviortest` suite — sim to body, end to end

**Files:**
- Create: `windows/src/cli/behaviortest.ts`
- Modify: `windows/package.json` (add the `behaviortest` script)

**Interfaces:**
- Consumes: `LIFSim`, `SignalBuilder`, `Fly`, `circadianActivity`.
- Produces: a CLI printing 17 `PASS`/`FAIL` lines and exiting 0/1.

This is M2a's gate. No unit test — the deliverable is the test.

- [ ] **Step 1: Write the CLI**

Create `windows/src/cli/behaviortest.ts` porting `main.swift:231-457`: the
`scenario()` helper (fresh `LIFSim` + `SignalBuilder` + `Fly`, settle 400 ms,
drain the GF latch, apply the stimulus, then step the sim and the fly at 1/60
until the check passes or the hold expires), the seven stimulation scenarios
(GF→flight, DNg11→grooming, DNp09→walk with capped speed, MDN→backward from
idle, DNa-left→CCW turn, moderate loom→dart-or-escape, sensory tap→startle),
the `bodyCheck()` helper, and the ten hand-built-signal checks (ledge attach,
window closes underfoot, sleep/wake, thermal tempo, flight altitude and scale,
wing beat, mid-flight effort, grounded wing-raise, smooth landing, circadian
curve). Print `ALL BEHAVIOR TESTS PASS` or `<n> FAILURES` and exit accordingly.

Pass a fixed seed to both `LIFSim` and `Fly`, and accept `--seed=N`.

- [ ] **Step 2: Add the npm script**

```json
    "behaviortest": "node src/cli/behaviortest.ts"
```

- [ ] **Step 3: Run it and read the output**

Run: `cd windows && npm run behaviortest`
Expected: 17 `PASS` lines, `ALL BEHAVIOR TESTS PASS`, exit 0.

Then confirm it is not seed-dependent: `--seed=2` and `--seed=3`.

If a scenario fails at one seed only, treat it as a finding about the port, not
as a reason to pick a passing seed — and check whether the corresponding
quantity is genuinely seed-sensitive (as walk duty turned out to be in M1)
before adjusting any threshold.

- [ ] **Step 4: Commit**

```bash
git add windows/src/cli windows/package.json
git commit -m "Windows port M2a: --behaviortest, 17 end-to-end sim-to-body checks"
```

---

### Task 7: M2a documentation

**Files:**
- Modify: `windows/README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Windows README**

Set status to "M2a — body, headless", add `npm run behaviortest` to the command
list, note that `three` is now a runtime dependency so `npm install` is required
(M1's zero-install property applied only to the sim), and record any visual
discrepancy found against `assets/fly.png` as a known issue for M2b.

- [ ] **Step 2: Update CLAUDE.md**

Extend the `windows/` row of the Files table to mention `src/body` (procedural
body + `Fly` behavior, transliterated from `FlyModel.swift`), and add
`cd windows && npm run behaviortest` beside the existing verify commands.

- [ ] **Step 3: Verify every documented command runs**

- [ ] **Step 4: Commit**

```bash
git add windows/README.md CLAUDE.md
git commit -m "Windows port M2a: document the body port"
```

---

## M2a Definition of Done

- [ ] `cd windows && node --test` — all tests pass (expected 64)
- [ ] `npm run behaviortest` — 17/17, exit 0, at seeds 1, 2, 3
- [ ] `npm run simtest:strict` still exits 0 (no M1 regression)
- [ ] `npm install && npm run typecheck` clean
- [ ] `three` is the only runtime dependency added; `package-lock.json` committed
      (`@types/three` was also needed as a devDependency — `three` ships no
      bundled declarations, so `typecheck` cannot pass without it)
- [ ] `data/` unmodified

## Next

M2b: the Electron overlay window — transparent, click-through, always-on-top —
plus the `Coordinator` frame loop and `computeLoom` cursor transduction. That is
the milestone where the fly first appears on screen, and where the body's
appearance can finally be compared against `assets/fly.png`.
