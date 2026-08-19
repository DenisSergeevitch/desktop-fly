# DesktopFly Windows Port — M2b (Overlay Window) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the fly on the desktop — a transparent, click-through,
always-on-top Electron overlay driven by the live sim, with the cursor as a real
looming stimulus.

**Architecture:** Two pure-logic modules (`core/loom.ts`, `core/simclock.ts`) and
a headless-testable `body/coordinator.ts` carry everything that can be verified
without a GPU; `main/` and `renderer/` hold only the Electron shell and the
WebGL renderer, which are verified by rendering a snapshot and looking at it.

**Tech Stack:** Node 24, `three`, `electron` (new runtime dependency), `esbuild`
(dev) for bundling the main/preload/renderer entry points.

**Spec:** `docs/superpowers/specs/2026-08-19-windows-port-design.md`
**Predecessors:** M1 (`...-m1-core-sim.md`), M2a (`...-m2a-body.md`) — both complete.

## Global Constraints

- Everything from M1 and M2a still applies: Node ≥ 24, no codegen TypeScript
  constructs (`enum`, `namespace`, parameter properties, decorators), explicit
  `.ts` extensions on relative imports, the Swift source is normative, `data/`
  read-only, MIT.
- **`core/` and `body/` must stay free of Electron and of `WebGLRenderer`.** All
  four existing suites must keep passing headless; a GPU import anywhere in
  those layers breaks them.
- The scene coordinate convention is fixed and must not be revisited: origin at
  the centre of the fly's display, **y up**, height in `position.z`, yaw in
  `rotation.z`. The camera is built to match.
- Assign `fly.state` through `asFlyState()` (M2a deviation 1) wherever TS
  narrowing would otherwise make later comparisons unreachable.

## Deviation from the writing-plans skill

As in M2a: **full code for every test**, but implementation cited by Swift line
range rather than duplicated, because the normative source is in this repo and a
second copy drifts. Tasks 4 and 5 have no tests at all — their deliverable is a
window on screen — so they carry explicit manual verification steps instead.

## Deviations from the spec's file list, stated up front

1. **`Coordinator` lives in `body/coordinator.ts`, not `renderer/overlay.ts`.**
   The spec put the frame-loop hub in the renderer layer, but it needs no WebGL
   at all — only a Three.js scene graph, `Fly`, and `LIFSim`. Moving it into
   `body/` makes the entire sim→signals→body chain unit-testable headless and
   leaves `renderer/` holding just the renderer, the canvas, and the IPC bridge.
   This is the same reasoning that made M2a's 17 behavior checks possible.
2. **`computeLoom` and the millisecond accumulator become their own `core/`
   modules** (`loom.ts`, `simclock.ts`) instead of private `Coordinator`
   members. Both are pure functions of their inputs, both encode tuned
   constants, and both are exactly the kind of thing that silently drifts —
   so both get direct tests.
3. **Tray menu, window terrain, idle/sleep, and taps are NOT in M2b.** They are
   M3 (senses) and M5 (shell). M2b's overlay is quit with Ctrl+C in the
   terminal that launched it; `npm start` runs it in the foreground.

---

### Task 1: Cursor transduction — `core/loom.ts`

**Files:**
- Create: `windows/src/core/loom.ts`
- Create: `windows/src/core/loom.test.ts`

**Interfaces:**
- Consumes: `clampf` from `core/mathutil.ts`.
- Produces: `interface LoomOutput { l: number; r: number; puff: number }`;
  `class LoomTransducer` with
  `compute(flyPos: {x,y}, heading: number, mouse: {x,y} | null, dt: number, loomOverride?: number): LoomOutput`
  and `reset(): void`.

This is the last non-connectome step in the whole chain: everything downstream of
the value it produces is real FlyWire wiring.

- [ ] **Step 1: Write the failing test**

Create `windows/src/core/loom.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoomTransducer } from './loom.ts';

const DT = 1 / 30;   // the cursor poll runs at 30 Hz

// Drag the cursor from `from` to `to` in `steps` polls and return the last
// output — the transducer needs successive samples to estimate velocity.
function sweep(from: { x: number; y: number }, to: { x: number; y: number },
               steps: number, flyPos = { x: 0, y: 0 }, heading = 0) {
  const t = new LoomTransducer();
  let out = t.compute(flyPos, heading, from, DT);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const p = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
    out = t.compute(flyPos, heading, p, DT);
  }
  return out;
}

test('no cursor means no stimulus', () => {
  const t = new LoomTransducer();
  const out = t.compute({ x: 0, y: 0 }, 0, null, DT);
  assert.deepEqual(out, { l: 0, r: 0, puff: 0 });
});

test('a cursor lunge toward the fly produces loom', () => {
  const lunge = sweep({ x: 600, y: 0 }, { x: 120, y: 0 }, 6);
  assert.ok(lunge.l + lunge.r > 0.2,
    `closing fast should loom, got l=${lunge.l} r=${lunge.r}`);
});

test('a cursor retreating produces no loom from approach', () => {
  const away = sweep({ x: 150, y: 0 }, { x: 700, y: 0 }, 6);
  // only the proximity term can contribute, and at 700 pt it is zero
  assert.ok(away.l + away.r < 0.05, `retreat should not loom: ${away.l}, ${away.r}`);
});

test('hovering close is a big object even at zero speed', () => {
  const t = new LoomTransducer();
  let out = t.compute({ x: 0, y: 0 }, 0, { x: 60, y: 0 }, DT);
  for (let i = 0; i < 5; i++) out = t.compute({ x: 0, y: 0 }, 0, { x: 60, y: 0 }, DT);
  // (130 - 60) / 130 * 0.5 = 0.269, split between the eyes
  assert.ok(out.l + out.r > 0.15, `hover close should loom: ${out.l}, ${out.r}`);
  assert.equal(out.puff, 0, 'a still cursor makes no wind');
});

test('distance attenuates loom to nothing beyond 800 pt', () => {
  const far = sweep({ x: 1400, y: 0 }, { x: 900, y: 0 }, 6);
  assert.equal(far.l, 0);
  assert.equal(far.r, 0);
});

test('the threat is split between the eyes by bearing', () => {
  // Fly faces +x (heading 0). A threat on its left (+y) must weight the left
  // eye more; cross product z of forward x relative > 0 means left.
  const left = sweep({ x: 100, y: 600 }, { x: 20, y: 120 }, 6, { x: 0, y: 0 }, 0);
  assert.ok(left.l > left.r, `threat on the left: l=${left.l} r=${left.r}`);

  const right = sweep({ x: 100, y: -600 }, { x: 20, y: -120 }, 6, { x: 0, y: 0 }, 0);
  assert.ok(right.r > right.l, `threat on the right: l=${right.l} r=${right.r}`);
});

test('neither eye is ever fully blind and loom never exceeds 1', () => {
  const head = sweep({ x: 900, y: 0 }, { x: 25, y: 0 }, 12);
  assert.ok(head.l > 0 && head.r > 0, 'the 0.12 floor keeps both eyes driven');
  assert.ok(head.l <= 1 && head.r <= 1, `clamped: ${head.l}, ${head.r}`);
});

test('a fast whoosh nearby makes wind, a slow drift does not', () => {
  // Keep it inside 500 pt: the puff term is attenuated by 1 - dist/500, so a
  // sweep ending exactly 500 pt out would read zero however fast it was.
  const fast = sweep({ x: 100, y: 0 }, { x: 100, y: 200 }, 2);   // ~3000 pt/s
  assert.ok(fast.puff > 0.1, `fast sweep should puff: ${fast.puff}`);
  const slow = sweep({ x: 300, y: 0 }, { x: 300, y: 20 }, 6);
  assert.ok(slow.puff < 0.05, `slow drift should not puff: ${slow.puff}`);
});

test('loomOverride adds a stimulus with no cursor motion at all', () => {
  const t = new LoomTransducer();
  const out = t.compute({ x: 0, y: 0 }, 0, { x: 400, y: 0 }, DT, 0.6);
  assert.ok(out.l + out.r > 0.4, `override should drive both eyes: ${out.l}, ${out.r}`);
});

test('reset clears the velocity estimate', () => {
  const t = new LoomTransducer();
  t.compute({ x: 0, y: 0 }, 0, { x: 600, y: 0 }, DT);
  t.compute({ x: 0, y: 0 }, 0, { x: 200, y: 0 }, DT);
  t.reset();
  const out = t.compute({ x: 0, y: 0 }, 0, { x: 200, y: 0 }, DT);
  assert.equal(out.puff, 0, 'after reset there is no remembered velocity');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src/core/loom.test.ts`
Expected: FAIL — `Cannot find module ... loom.ts`

- [ ] **Step 3: Write the implementation**

Create `windows/src/core/loom.ts`, transliterating `main.swift:603-630`. The
`prevMouse`/`mouseVel` EMA (factor 0.4) is instance state; the radial approach
term is `-(rel · vel) / dist`, scaled `approach / dist * 6` and clamped, times a
`1 - dist/800` attenuation, plus the `(130 - dist)/130 * 0.5` proximity term,
plus `loomOverride`, all clamped to 0…1. The eye split uses the cross product of
the heading with the normalized relative vector, weights clamped to 0.12…1. The
puff is `|vel| / 1500` attenuated by `1 - dist/500`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test`
Expected: PASS, 74 tests (64 from M2a + 10).

- [ ] **Step 5: Commit**

```bash
git add windows/src/core
git commit -m "Windows port M2b: cursor -> looming transduction"
```

---

### Task 2: Fixed-timestep clock — `core/simclock.ts`

**Files:**
- Create: `windows/src/core/simclock.ts`
- Create: `windows/src/core/simclock.test.ts`

**Interfaces:**
- Produces: `class SimClock` with `advance(dt: number): number` (whole
  milliseconds to step this frame) and `reset(): void`.

- [ ] **Step 1: Write the failing test**

Create `windows/src/core/simclock.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SimClock } from './simclock.ts';

test('a 60 Hz frame yields 16 or 17 ms, averaging the true rate', () => {
  const c = new SimClock();
  let total = 0;
  for (let i = 0; i < 600; i++) {
    const ms = c.advance(1 / 60);
    assert.ok(ms === 16 || ms === 17, `got ${ms}`);
    total += ms;
  }
  // 600 frames at 1/60 s is 10 s; the accumulator must not drift
  assert.ok(Math.abs(total - 10_000) <= 1, `accumulated ${total} ms over 10 s`);
});

test('fractional milliseconds accumulate rather than being lost', () => {
  const c = new SimClock();
  let total = 0;
  for (let i = 0; i < 1000; i++) total += c.advance(0.0004);   // 0.4 ms frames
  assert.ok(Math.abs(total - 400) <= 1, `accumulated ${total} ms, expected ~400`);
});

test('a long hitch is clamped to 50 ms so the sim never chases the renderer', () => {
  const c = new SimClock();
  assert.equal(c.advance(2.0), 50);
  // the surplus is discarded, not banked: the next frame is normal
  assert.ok(c.advance(1 / 60) <= 17);
});

test('zero and negative dt produce no steps', () => {
  const c = new SimClock();
  assert.equal(c.advance(0), 0);
  assert.equal(c.advance(-1), 0);
});

test('reset drops the pending fraction', () => {
  const c = new SimClock();
  c.advance(0.0009);              // 0.9 ms banked, 0 returned
  c.reset();
  assert.equal(c.advance(0.0005), 0, 'the banked 0.9 ms should be gone');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src/core/simclock.test.ts`
Expected: FAIL — `Cannot find module ... simclock.ts`

- [ ] **Step 3: Write the implementation**

Create `windows/src/core/simclock.ts` from `main.swift:670-672`: accumulate
`dt * 1000`, take `min(50, floor(accumulator))` whole milliseconds, subtract
those from the accumulator. Guard `dt <= 0`. On the clamp path, drop the surplus
(the Swift version keeps the remainder in the accumulator, but a 2 s hitch would
then take 40 frames to drain — discarding matches the intent of the clamp, which
is "never chase a stalled renderer"; document this as a deliberate refinement).

**Note on the deviation:** state it in the file comment. This is the one place
M2b knowingly diverges in behavior from the Swift original, and the reason is
that the Swift behavior is a latent bug rather than a design choice.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test`
Expected: PASS, 79 tests.

- [ ] **Step 5: Commit**

```bash
git add windows/src/core
git commit -m "Windows port M2b: fixed-timestep sim clock"
```

---

### Task 3: The frame-loop hub — `body/coordinator.ts`

**Files:**
- Create: `windows/src/body/coordinator.ts`
- Create: `windows/src/body/coordinator.test.ts`

**Interfaces:**
- Consumes: `LIFSim`, `SignalBuilder`, `LoomTransducer`, `SimClock`, `Fly`,
  `Ledge`, `THREE`.
- Produces: `interface Senses { cursor: {x,y} | null; ledges: Ledge[];
  newWindows: Array<{ center: {x,y}; size: number }>; taps: Array<{x,y}>;
  typing: number; sleepy: boolean; tempo: number; activity: number }`;
  `class Coordinator` with constructor `(opts: { bounds, sim, scene?, seed? })`,
  `readonly flies: Fly[]`, `readonly scene: THREE.Scene`,
  `readonly sim: LIFSim | null`,
  `frame(dt: number): void`, `enqueue(fn: (c: Coordinator) => void): void`,
  `setSenses(s: Partial<Senses>): void`, `escapeTest(): void`,
  `addFly(): void`, `removeFly(): void`, `scareAll(): void`,
  `retarget(bounds: { width, height }): void`, `flyPosition(): {x, y}`.

- [ ] **Step 1: Write the failing test**

Create `windows/src/body/coordinator.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrainData } from '../core/data.ts';
import { LIFSim } from '../core/sim.ts';
import { Coordinator } from './coordinator.ts';
import { asFlyState } from './fly.ts';

const { circuit } = loadBrainData()!;
const BOUNDS = { width: 1512, height: 982 };
const DT = 1 / 60;

function makeCoordinator() {
  return new Coordinator({
    bounds: BOUNDS,
    sim: new LIFSim(circuit, null, 1),
    seed: 1,
  });
}

test('a coordinator starts with exactly one fly, in the scene', () => {
  const c = makeCoordinator();
  assert.equal(c.flies.length, 1);
  assert.ok(c.scene.children.includes(c.flies[0].node),
    'the fly must be attached to the scene graph');
});

test('frames step the sim at 1 kHz and advance the fly', () => {
  const c = makeCoordinator();
  const before = c.sim!.simMs;
  for (let i = 0; i < 60; i++) c.frame(DT);
  const stepped = c.sim!.simMs - before;
  assert.ok(Math.abs(stepped - 1000) <= 2,
    `60 frames of 1/60 s should step ~1000 ms, stepped ${stepped}`);
  assert.ok(c.flies[0].time > 0.9, 'the fly clock should have advanced');
});

test('only fly #1 receives brain signals; extra flies use the legacy path', () => {
  // A giant-fiber escape is a brain event, so it must move fly #1 and leave the
  // brainless extras alone. (They have their own mouse-distance fear instead.)
  const c = makeCoordinator();
  c.addFly();
  c.addFly();
  for (const f of c.flies) {
    f.state = asFlyState('walking');
    f.speed = 20;
  }
  c.setSenses({ cursor: { x: 400, y: 400 } });   // far away: no legacy fear
  for (let i = 0; i < 60; i++) c.frame(DT);
  c.escapeTest();
  let brainFlew = false;
  for (let i = 0; i < 150 && !brainFlew; i++) {
    c.frame(DT);
    brainFlew = c.flies[0].state === 'flying';
  }
  assert.ok(brainFlew, 'fly #1 should escape on a brain event');
  // the extras are only driven by their own timers, never by the circuit
  assert.equal(c.flies.length, 3);
});

test('removeFly never removes fly #1 — it carries the brain', () => {
  const c = makeCoordinator();
  c.removeFly();
  assert.equal(c.flies.length, 1);
  c.addFly();
  c.removeFly();
  assert.equal(c.flies.length, 1);
  assert.equal(c.scene.children.filter((n) => n === c.flies[0].node).length, 1);
});

test('a cursor lunge drives the real circuit to a fear response', () => {
  // Dart OR escape, the same disjunction the Swift behaviortest uses. A cursor
  // sweep is a RAMP, and CLAUDE.md is explicit that ramps lose the giant-fiber
  // race to ~2,750 synapses of feedforward inhibition by design — so the
  // looming population drives a nervous dart instead. Measured here: speed 130
  // with dartTimer 0.88, no takeoff. Asserting `flying` would be asserting a
  // bug into existence.
  const c = makeCoordinator();
  for (let i = 0; i < 120; i++) c.frame(DT);       // settle
  const fly = c.flies[0];
  fly.state = asFlyState('walking');
  fly.pos = { x: 0, y: 0 };
  let afraid = false;
  // sweep the cursor in hard from 700 pt away
  for (let i = 0; i < 40 && !afraid; i++) {
    const x = 700 - i * 45;
    c.setSenses({ cursor: { x, y: 0 } });
    c.frame(DT);
    afraid = fly.state === 'flying' || (fly.state === 'walking' && fly.speed > 100);
  }
  assert.ok(afraid,
    `a fast cursor lunge should frighten the fly: ${fly.state} @ ${fly.speed}`);
});

test('escapeTest drives the loom pathway to an escape', () => {
  // NOTE: a cursor position is required. computeLoom returns zeroes when the
  // cursor is unknown (main.swift:607), so loomOverride only takes effect once
  // one is known — which in the running app it always is, because the 30 Hz
  // poll sets it before the first frame.
  const c = makeCoordinator();
  c.setSenses({ cursor: { x: 300, y: 0 } });
  for (let i = 0; i < 60; i++) c.frame(DT);
  c.escapeTest();
  let escaped = false;
  for (let i = 0; i < 150 && !escaped; i++) {
    c.frame(DT);
    escaped = c.flies[0].state === 'flying';
  }
  assert.ok(escaped, 'the escape test should reach the giant fiber');
});

test('gait proprioception feeds back into the sim while walking', () => {
  const c = makeCoordinator();
  const fly = c.flies[0];
  fly.state = asFlyState('walking');
  fly.speed = 50;
  c.frame(DT);
  assert.ok(c.sim!.gaitDrive > 0,
    'a walking fly must drive the ascending neurons');
  assert.ok(c.sim!.gaitDrive <= 1);
});

test('terrain reaches the flies', () => {
  const c = makeCoordinator();
  c.setSenses({ ledges: [{ y: -40, x0: -300, x1: 300, id: 1 }] });
  c.frame(DT);
  assert.equal(c.flies[0].terrain.length, 1);
});

test('circadian and sleep are compressed, never applied raw', () => {
  // The "siesta coma" bug: a raw multiplier silences the network. The
  // coordinator must compress toward 1 (CLAUDE.md).
  const c = makeCoordinator();
  c.setSenses({ activity: 0.55, sleepy: false });
  c.frame(DT);
  assert.ok(Math.abs(c.sim!.activityScale - 0.8425) < 1e-6,
    `expected 1 - (1 - 0.55) * 0.35 = 0.8425, got ${c.sim!.activityScale}`);

  c.setSenses({ activity: 1, sleepy: true });
  c.frame(DT);
  assert.ok(Math.abs(c.sim!.activityScale - 0.75) < 1e-6);
  assert.ok(Math.abs(c.sim!.sensoryGate - 0.55) < 1e-6, 'sleep gates the senses');
});

test('a nearby tap reaches the sensory pathway; a distant one does not', () => {
  // Two identically seeded coordinators diverge only if the tap actually
  // stimulated something — comparing against "before" would pass on noise.
  function run(tap: { x: number; y: number }) {
    const c = makeCoordinator();
    for (let i = 0; i < 60; i++) c.frame(DT);
    c.setSenses({ taps: [tap] });
    for (let i = 0; i < 30; i++) c.frame(DT);
    return c.sim!.totalSpikes;
  }
  const near = run({ x: 10, y: 10 });      // strength ~0.96
  const far = run({ x: 5000, y: 5000 });   // beyond 520 pt: ignored entirely
  assert.ok(near > far,
    `a near tap should add spikes: near ${near} vs far ${far}`);
});

test('retarget clamps flies into the new display and clears terrain', () => {
  const c = makeCoordinator();
  c.flies[0].pos = { x: 700, y: 450 };
  c.setSenses({ ledges: [{ y: -40, x0: -300, x1: 300, id: 1 }] });
  c.frame(DT);
  c.retarget({ width: 800, height: 600 });
  // frame(0) drains the enqueued retarget without advancing the fly — a normal
  // frame would let updateWalk step it a fraction past the clamp, which is
  // legal (free walking clamps to width/2 - 20) but hides what is under test.
  c.frame(0);
  assert.ok(Math.abs(c.flies[0].pos.x) <= 800 / 2 - 40 + 1e-6,
    `x ${c.flies[0].pos.x} outside the new display`);
  assert.ok(Math.abs(c.flies[0].pos.y) <= 600 / 2 - 40 + 1e-6);
  assert.equal(c.flies[0].ledge, null);
});

test('enqueued mutations run at the top of the next frame', () => {
  const c = makeCoordinator();
  let ran = false;
  c.enqueue(() => { ran = true; });
  assert.equal(ran, false, 'must not run synchronously');
  c.frame(DT);
  assert.equal(ran, true);
});

test('a coordinator with no sim still runs flies on the legacy path', () => {
  const c = new Coordinator({ bounds: BOUNDS, sim: null, seed: 1 });
  for (let i = 0; i < 60; i++) c.frame(DT);
  assert.equal(c.flies.length, 1);
  assert.ok(c.flies[0].time > 0.9);
});

test('a frame hitch cannot make the sim run away', () => {
  const c = makeCoordinator();
  const before = c.sim!.simMs;
  c.frame(2.0);                    // a 2-second stall
  assert.ok(c.sim!.simMs - before <= 50, `stepped ${c.sim!.simMs - before} ms`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src/body/coordinator.test.ts`
Expected: FAIL — `Cannot find module ... coordinator.ts`

- [ ] **Step 3: Write the implementation**

Create `windows/src/body/coordinator.ts` from `main.swift:485-689`, minus the
SceneKit specifics:

- `buildScene` equivalent: a `THREE.Scene` with an **orthographic** camera
  (`orthographicScale = height / 2` → `top/bottom = ±height/2`,
  `left/right = ±width/2`, near 1, far 600, positioned at z = 300 looking down
  −Z), a directional light with shadows, an ambient light, and a
  shadow-catcher plane at z = −0.6 using `ShadowMaterial` (the Three.js
  equivalent of SceneKit's `colorBufferWriteMask = []` plane).
- The `enqueue` + `pending` pattern (no lock — single-threaded).
- `frame(dt)` **applies `dt = min(0.05, max(0, dt))` itself**, rather than
  leaving that to the renderer as `main.swift:649` does. Same clamp, same value,
  but inside the unit-tested layer — the renderer then needs no clamp of its
  own, and the hitch test below actually covers it.
- `frame(dt)`: drain pending, then the sensory → sim → signals → body chain
  exactly as `renderer(_:updateAtTime:)` does (`main.swift:632-688`):
  `loomL/R = max(cursorLoom, decaying windowLoom)` with the `exp(-4 dt)` decay,
  `airPuff = max(puff, typing * 0.30)`, `gaitDrive/gaitPhase` from fly #1,
  `activityScale = (1 - (1 - activity) * 0.35) * (sleepy ? 0.75 : 1)`,
  `sensoryGate = sleepy ? 0.55 : 1`, `loomOverride` decaying at `dt * 1.2`,
  then `SimClock` → `sim.step()` → `SignalBuilder.make` → `fly.update` with
  signals for fly #1 and `null` for the rest.
- `injectTap` (`main.swift:591-600`) and `injectWindowLoom` (`:578-589`) as
  private handlers fed from `setSenses({ taps })` / `setSenses({ newWindows })`.
- `addFly`/`removeFly`/`scareAll`/`escapeTest`/`retarget` from `:528-570`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test`
Expected: PASS, 93 tests. Also re-run `npm run behaviortest` — the coordinator
must not have changed body behavior.

- [ ] **Step 5: Commit**

```bash
git add windows/src/body
git commit -m "Windows port M2b: Coordinator frame loop, headless-testable"
```

---

### Task 4: The Electron shell

**Files:**
- Create: `windows/src/main/main.ts`
- Create: `windows/src/renderer/preload.ts`
- Create: `windows/src/renderer/overlay.ts`
- Create: `windows/src/renderer/index.html`
- Create: `windows/build.mjs`
- Modify: `windows/package.json` (add `electron`, `esbuild`, `start`, `build` scripts)

**Interfaces:**
- `preload` exposes `window.desktopfly = { onSenses(cb), onCommand(cb) }` over
  `contextBridge`.
- `main` sends `senses` at 30 Hz and `command` on demand.

There is no unit test here: this task's deliverable is a window on screen. Its
verification is Task 5's snapshot plus the manual checks below.

- [ ] **Step 1: Add dependencies and the build script**

```bash
cd windows && npm install --save electron && npm install --save-dev esbuild
```

Create `windows/build.mjs` bundling three entry points to `dist/`:
`src/main/main.ts` (platform `node`, external `electron`),
`src/renderer/preload.ts` (platform `node`, external `electron`), and
`src/renderer/overlay.ts` (platform `browser`, format `iife`, bundling `three`).
Copy `src/renderer/index.html` to `dist/`.

Add scripts: `"build": "node build.mjs"`, `"start": "npm run build && electron dist/main.js"`.

- [ ] **Step 2: Write the main process**

`src/main/main.ts`, from `main.swift:714-812`:

```ts
const win = new BrowserWindow({
  x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
  transparent: true,          // per-pixel alpha
  frame: false,
  resizable: false,
  movable: false,
  focusable: false,           // never steals focus from real work
  skipTaskbar: true,
  hasShadow: false,
  webPreferences: {
    preload: join(__dirname, 'preload.js'),
    contextIsolation: true,
    // Chromium throttles requestAnimationFrame to ~1 Hz for background or
    // occluded windows. The sim clock is driven from the frame loop, so
    // throttling would freeze the fly AND stall the brain. Not a preference.
    backgroundThrottling: false,
  },
});
win.setAlwaysOnTop(true, 'screen-saver');   // ~ NSWindow.Level.floating
win.setIgnoreMouseEvents(true);             // click-through; no `forward`,
                                            // since the cursor is polled globally
```

Use `screen.getPrimaryDisplay().bounds` for placement and
`screen.getCursorScreenPoint()` on a 30 Hz timer, converting to scene
coordinates (origin display centre, **y up** — Electron's y is down, so
`y = display.bounds.y + display.bounds.height / 2 - cursor.y`). Re-place the
window on `display-metrics-changed`. Reset the renderer's clock on
`powerMonitor` `resume`.

- [ ] **Step 3: Write the preload and renderer**

`preload.ts` exposes the two subscription functions and nothing else.

`overlay.ts` creates the `WebGLRenderer` (`alpha: true`,
`setClearColor(0x000000, 0)`, `antialias: true`, `shadowMap.enabled`), builds a
`Coordinator`, subscribes to `senses`/`command`, and runs
`requestAnimationFrame` with `dt = min(0.05, max(0, now - last))` — the same
clamp as `main.swift:649`.

`index.html` is a bare page: `<canvas id="c">` with
`html,body{margin:0;background:transparent;overflow:hidden}`.

- [ ] **Step 4: Run it and verify by hand**

Run: `cd windows && npm start`

Check each of these and record the result in the commit message:
- a fly appears and walks around the desktop
- the desktop and other windows are visible through the overlay (no grey or
  black box, no visible rectangle edges)
- clicking through the overlay hits whatever is underneath — desktop icons,
  other apps' buttons — and the fly never intercepts input
- moving the cursor at the fly makes it flee; a slow approach does not
- the overlay stays above ordinary windows
- Ctrl+C in the launching terminal quits cleanly

If the window shows an opaque background, check `transparent: true` **and** that
the renderer's clear alpha is 0 — both are required.

- [ ] **Step 5: Commit**

```bash
git add windows/package.json windows/package-lock.json windows/build.mjs windows/src
git commit -m "Windows port M2b: Electron overlay window, transparent and click-through"
```

---

### Task 5: `--snapshot`, and the first look at the fly

**Files:**
- Create: `windows/src/cli/snapshot.ts`
- Modify: `windows/package.json` (add the `snapshot` script)

**Interfaces:**
- Produces a PNG of the fly rendered offscreen.

- [ ] **Step 1: Write the snapshot CLI**

`src/cli/snapshot.ts` runs under the `electron` binary (not plain Node — a GL
context is required, and the only headless Node option needs a native build the
missing MSVC cannot produce). Create a hidden `BrowserWindow`, load a page that
renders one posed fly against a light background with the same camera framing as
`runSnapshot` (`main.swift:80-109`: perspective camera, fov 42, positioned
`(30, -58, 42)` looking at the fly, key light and ambient, the six legs posed
from the fixed angle/lift table), then `capturePage()` and write the PNG.

Add the script: `"snapshot": "npm run build && electron dist/snapshot.js"`.

- [ ] **Step 2: Render and look at it**

Run: `cd windows && npm run snapshot -- fly.png`

Then **actually look at the image** side by side with `assets/fly.png` (the
macOS render). Compare: body proportions, the six legs' angles and reach, wing
shape and placement, eye size and position, the abdomen's banding.

- [ ] **Step 3: Record the visual verdict honestly**

Write down what matches and what does not. The M2a docs flagged appearance as
unverified precisely so this step has teeth. If the legs or wings are visibly
wrong, fix the geometry — the numbers came from a transliteration that no test
can fully validate, and this is the first and only check on it.

Any fix here must keep all 93 tests and the behaviortest suite green: the
geometry tests assert attach points and pivot directions, so a real fix will
either pass them or reveal that a test encoded the same misreading.

- [ ] **Step 4: Commit**

```bash
git add windows/src/cli windows/package.json
git commit -m "Windows port M2b: offscreen snapshot render"
```

---

### Task 6: M2b documentation

**Files:**
- Modify: `windows/README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Windows README**

Status becomes "M2b — the fly is on screen". Document `npm start` and
`npm run snapshot`, that `electron` is now a runtime dependency, that quitting
is Ctrl+C until the tray arrives in M5, and the visual verdict from Task 5
(including anything still off).

- [ ] **Step 2: Update CLAUDE.md**

Add `src/main`/`src/renderer` to the `windows/` row of the Files table, and note
the two Electron settings that are correctness issues rather than preferences
(`backgroundThrottling: false`, `setAlwaysOnTop(…, 'screen-saver')`).

- [ ] **Step 3: Verify every documented command runs**

- [ ] **Step 4: Commit**

```bash
git add windows/README.md CLAUDE.md
git commit -m "Windows port M2b: document the overlay"
```

---

## M2b Definition of Done

- [ ] `cd windows && node --test` — all pass (expected 93)
- [ ] `npm run behaviortest` — 17/17 at seeds 1, 2, 3
- [ ] `npm run simtest:strict` — exit 0 at seeds 1, 2, 3 (no M1 regression)
- [ ] `npm run typecheck` — clean
- [ ] `npm start` — fly visible, overlay transparent, clicks pass through,
      cursor lunge triggers escape
- [ ] `npm run snapshot -- fly.png` — rendered, inspected against
      `assets/fly.png`, verdict recorded
- [ ] `core/` and `body/` still import no Electron and construct no
      `WebGLRenderer`
- [ ] `data/` unmodified

## Next

M3 — the Win32 senses: `EnumWindows` window terrain, `GetLastInputInfo` idle and
sleep, `GetAsyncKeyState` taps, and CPU-load tempo, all through koffi. The
`Senses` interface this milestone defines is the seam M3 fills in; the
coordinator already consumes every field.
