# DesktopFly — agent notes

A 3D fruit fly on a transparent macOS overlay, behavior-driven by a 1 kHz
leaky-integrate-and-fire (LIF) simulation of a 668-neuron circuit extracted
from the real FlyWire connectome (FAFB v783). The body is procedural
SceneKit; the brain data is real.

## Files

| file | contents |
|---|---|
| `main.swift` | overlay scene, CLI modes, `SignalBuilder` (rates→commands), `Coordinator` (render-loop hub), `AppDelegate` (menu, timers, display switching) |
| `FlyModel.swift` | `BodyForm` switch, procedural fly body + `Fly` behavior (states, gait, flight, ledges, sleep) |
| `BeetleModel.swift` | procedural stag-beetle body — alternate skin for the same `FlyModel` contract |
| `Sim.swift` | data loading, `BrainSignals`, `SpikeBus`, `LIFSim` (CSR network, stimulation API) |
| `BrainView.swift` | brain window: point clouds, click-to-stimulate, spike flashes |
| `Environment.swift` | permission-free senses: `WindowSense` (ledges/looms), circadian curve, user idle, thermal tempo |
| `etl.py` | raw Codex dumps → `data/brain_points.json` + `data/circuit.json` |
| `data/` | shipped derived data (CC BY-NC 4.0 — see `data/DATA_LICENSE.md`) |

## Build, run, verify

```sh
./build.sh                     # bare swiftc, -swift-version 5, no Xcode project
./DesktopFly                   # menu-bar 🪰; quit from there
./DesktopFly --simtest         # circuit invariants (MUST pass after sim/etl changes)
./DesktopFly --behaviortest    # 22 end-to-end sim→body checks (MUST pass after behavior changes)
./DesktopFly --snapshot f.png  # offscreen body render (3/4 perspective)
./DesktopFly --snapshot f.png --top [--flying] [--beetle]  # the app's own top-down
                               # orthographic view — the only one users see
./DesktopFly --brainshot b.png # offscreen brain render
```

Always run **both** suites after any change; they are the ground truth.
Note they are **stochastic** — on unmodified HEAD roughly 16 runs in 100 show a
failure (`ledge attach` ~10%, `DNp09 stim` ~6%; both are random-walk / sim-noise
margins). Judge a change by comparing failure *rates* over ~100 runs, not by a
single red run.
Key invariants: GF silent over 4 s of rest, GF fires ≤ ~10 ms after abrupt
loom, walk-drive duty 20–50%, siesta (scale 0.84) walk-drive > 3%,
no per-frame scale/z snap at landing.

**SourceKit note**: the IDE reports "Cannot find type ..." across files —
false positives. The six .swift files compile as one module via build.sh;
trust the compiler, not single-file diagnostics.

## Body forms

The behavior layer talks to the body through **one contract**, the `FlyModel`
struct: `root`, `legs[6]`, `foldedWings` (exactly 2 children — the surfaces that
beat), `blurWingL/R`, `abdomen`, and optional `elytraL/R`. Nothing in `Fly`
branches on which form is built; `BODY_FORM` (default `.fly`) + `buildBody()` pick the geometry
and `Fly.swapBody()` rebuilds it in place, keeping every behavior variable.

- Add a form → new `build<X>Model() -> FlyModel`, a `BodyForm` case, a
  `buildBody()` arm. Satisfy the contract and no behavior code changes.
- `updateElytra` is display-only: it reads `state == .flying` and the existing
  `wingRaise`, adds no signal and makes no decision. The elytra hold a steady
  open angle — they must NOT be driven by `flapPhase`.
- The beetle's hindwing outline is pre-rotated by `-side*0.13` to cancel the
  fixed fold `land()` applies, so folded wings stay tucked under the shell.
- `--behaviortest` runs the whole grounded suite under the default form and
  re-runs the gait/wingbeat checks under **both**.

## Threading model

- SceneKit render thread: `Coordinator.renderer(_:updateAtTime:)` steps the
  sim and updates flies. All cross-thread mutation goes through
  `Coordinator.enqueue {}` (lock + pending-actions queue, drained per frame).
- Main thread: timers (mouse 30 Hz, windows 0.7 s), menu actions, global
  click monitor — these only call enqueue/setters.
- Brain window has its own render delegate; spikes cross via `SpikeBus` (locked).
- `LIFSim.stimulate()` is thread-safe (pending list merged at `step()`).

## Neuron → behavior mapping (current)

| role slug | FlyWire types (count) | drives | consumed in |
|---|---|---|---|
| `lc4`, `lplc2` | LC4 (104), LPLC2 (210) | looming input → nervous darting; excite GF | `BrainSignals.nervous` |
| `gf` | DNp01 (2) | escape takeoff (spike = takeoff) | `BrainSignals.escape` |
| `dna01`, `dna02` | DNa01 (2), DNa02 (2) | steering: L−R rate → turn bias (slow-adapted) | `BrainSignals.turnBias` |
| `dnp09` | DNp09 (2) | walk/rest hysteresis + walking speed | `BrainSignals.walkDrive` |
| `dng11` | DNg11 (6) | grooming hysteresis | `BrainSignals.groomDrive` |
| `mdn` | MDN (4) | backward walking burst | `BrainSignals.backward` |
| `escw` | DNp02/DNp04/DNp11 (6) | wing-beat effort in flight, threat wing-raise | `BrainSignals.wingDrive` |
| `other`+ascending (27) | strongest ascending partners | body→brain gait proprioception (input target) | `sim.gaitDrive/gaitPhase` |
| `other`+sensory (16) | strongest sensory partners | wind/tap input; electrically boosted onto GF | `sim.airPuff`, taps |

Whole-population rate → `BrainSignals.arousal` (spontaneous-takeoff gate,
flight effort). Only fly #1 has the brain; extra flies use legacy
distance-based behavior (`signals: nil` path).

## Adding a new neuron population (recipe)

1. **Check the type exists** in v783:
   `gzcat consolidated_cell_types.csv.gz | grep -c ',TYPE,'` (raw dumps: see
   README "Regenerating the data" for the GCS URLs; don't commit raw dumps).
2. **etl.py**: add `"TYPE": "roleslug"` to `CORE_TYPES`; add the slug to the
   reserved-partner loop AND the in-degree report loop.
3. **Rerun ETL** and read the report: `in-circuit drive onto roleslug` should
   be ≥ several hundred synapses — if it's tiny, the population will be
   noise-driven, not network-driven (this bug shipped once for DNg11: 6 syn).
4. **Sim.swift**: group array (`private(set) var xyz: [Int]`), populate in the
   init role switch, baseline (command DNs: deterministic `0.036`; never
   random per-side for bilateral pairs — asymmetry must come from wiring),
   rate EMA (`rateXyz`) in the spike-counting switch.
5. **SignalBuilder** (main.swift): normalize `rateXyz` into a new
   `BrainSignals` field — **always clamp** (an unclamped walkDrive once sent
   the fly to 1,100 pt/s).
6. **FlyModel.brainBehavior**: consume the signal. Use hysteresis + the
   `stateAge` dwell guard (≥0.4 s) for state changes, cooldown timers for
   one-shot actions; make sure the action works from every grounded state
   (MDN was once dead from idle).
7. **BrainView.swift**: role color in the circuit overlay + `regionName` label
   (clicking that region should demo the behavior).
8. **Tests**: add a `--behaviortest` scenario (stimulate population → assert
   body reaction) and, if sim-level, a `--simtest` probe. Run both suites.

## Tuning gotchas (learned the hard way)

- **Operating point is razor-thin**: neurons rest at `baseline × 20.4` vs
  threshold 1.0 (tau 20 ms). Never scale baselines linearly by a mood/time
  factor — compress toward 1 (`1 − (1−a)×0.35`), or populations go silent
  (the "siesta coma" bug).
- **Escape is a race**: LC→GF electrical drive (×6 boost) vs ~1,200 syn of
  feedforward inhibition (4 ms delayed). Slow ramps lose to inhibition by
  design — test escapes with **abrupt** loom steps, not ramps.
- **Live modifiers must never weaken takeoff**: flight effort =
  `max(baseEffort, live formula)` (a regression once halved escape altitude).
- Weight scale 0.0008/synapse; refractory 2 ms; inhibitory synaptic delay
  4 ms (ring buffer); `weightScale`/`gapJunctionBoost` live in `Sim.swift`.
- Landing must go through the flare (alt decays below 0.035) — never snap
  scale/z in `land()`.

## Repo conventions

- Public repo: `DenisSergeevitch/desktop-fly` (master). Code MIT; `data/` is
  CC BY-NC 4.0 (FlyWire terms) — keep the license split intact.
- README numeric claims (neuron/edge/synapse counts, latencies) must match
  `data/*.json` and suite output — reviewers falsify them against the data.
- `.gitignore` covers the binary, logs, and root-level PNGs (diagnostics
  outputs); intentional images live in `assets/`.
- Local folder is `fly-brain`; the remote is `desktop-fly` — harmless.
