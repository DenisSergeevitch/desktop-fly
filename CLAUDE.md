# DesktopFly — agent notes

A 3D fruit fly on a transparent macOS overlay, with a 668-neuron female
FlyWire v783 brain circuit and a 1,045-neuron male MaleCNS v1.0 locomotor
circuit. A modeled homologous population-rate interface joins the simulations;
there are no cross-specimen synapses in the extracted data. Wiring and contact
counts are measured; neural dynamics, senses, body mechanics and behavior are
models. Do not claim biologically calibrated walking from anatomical checks.

## Files

| file | contents |
|---|---|
| `main.swift` | overlay scene, CLI modes, `SignalBuilder` (rates→commands), `Coordinator` (render-loop hub), `AppDelegate` (menu, timers, display switching) |
| `FlyModel.swift` | `BodyForm` switch, procedural fly body + `Fly` behavior (states, gait, flight, ledges, sleep) |
| `BeetleModel.swift` | procedural stag-beetle body — alternate skin for the same `FlyModel` contract |
| `Sim.swift` | data loading, `BrainSignals`, `SpikeBus`, `LIFSim` (CSR network, stimulation API) |
| `Locomotor.swift` | MaleCNS neural dynamics, homolog-rate input, leg-local sensory input, motor-channel output |
| `LocomotorTests.swift` | causal checks of the actual MaleCNS → articulated body → sensory feedback loop |
| `LegDynamics.swift` | modeled articulated joints, foot contact and resulting grounded body motion |
| `BrainView.swift` | brain window: point clouds, click-to-stimulate, spike flashes |
| `Environment.swift` | permission-free senses: `WindowSense` (ledges/looms), circadian curve, user idle, thermal tempo |
| `etl.py` | raw Codex dumps → `data/brain_points.json` + `data/circuit.json` |
| `etl_malecns.py` | public MaleCNS Feather tables → `data/locomotor_circuit.json` + `data/locomotor_report.json` |
| `data/` | FlyWire CC BY-NC 4.0 and MaleCNS CC BY 4.0 data; see `DATA_LICENSE.md` and `LOCOMOTOR_PROVENANCE.md` |

## Build, run, verify

```sh
./build.sh                     # bare swiftc, -swift-version 5, no Xcode project
./DesktopFly                   # menu-bar 🪰; quit from there
./DesktopFly --simtest         # circuit invariants (MUST pass after sim/etl changes)
./DesktopFly --behaviortest    # end-to-end sim→body checks (MUST pass after behavior changes)
./DesktopFly --locomotortest   # active MaleCNS/body loop (MUST pass after shared motor changes)
./DesktopFly --snapshot f.png  # offscreen body render (3/4 perspective)
./DesktopFly --snapshot f.png --top [--flying] [--beetle]  # the app's own top-down
                               # orthographic view — the only one users see
./DesktopFly --brainshot b.png # offscreen brain render
./DesktopFly --snapshot walk.png --top --walking # pose driven by active motor neurons
```

Run **all three** suites after changes to simulation, extraction or behavior,
and `npm test` in `windows/` for the corresponding three JS suites. They check software
invariants, not fidelity to measured animal physiology. The legacy brain uses
noise; investigate failures and distinguish stochastic variation from sustained
motor collapse. A short motion transient is not evidence of sustained walking.
Key invariants: GF silent over 4 s of rest, GF fires ≤ ~10 ms after abrupt
loom, walk-drive duty 20–50%, siesta (scale 0.84) walk-drive > 3%,
no per-frame scale/z snap at landing.

Keep the complete closed loop on `SimulationClock` (120 Hz): sensing, neural
updates, motor outputs, body integration and feedback. Advancing just the brain
or mechanics at a fixed rate while holding feedback per display frame changes
the model at 60 vs 120 Hz. MaleCNS state uses Double/Float64 on both platforms.

**SourceKit note**: the IDE reports "Cannot find type ..." across files —
false positives. The .swift files compile as one module via build.sh;
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

The table describes the original FlyWire interface. Its sinusoidal ascending
input is only a fallback when the MaleCNS circuit is absent. In the main
locomotor path, `BrainSignals.legCommands` carries six `LegMotorCommand`s;
actual modeled joint/contact feedback is returned to `LocomotorSim`. The leg
order is **RF, LF, RM, LM, RH, LH** throughout data, simulation and body.

## MaleCNS data and model boundaries

- `data/locomotor_circuit.json`: 1,045 neurons, 17,224 directed source edges,
  708,689 contacts. Roles: 16 descending, 622 premotor/VNC interneurons,
  220 motor, 153 sensory and 34 ascending. `premotor` includes connecting
  interneurons; it is not a claim that each cell directly contacts a motor neuron.
- Each neuron retains source annotations, transmitter predictions and confidence.
  `edges` stores `[preIndex, postIndex, signedCount]`; aligned
  `rawSynapseCounts` preserves original counts. Unknown/modulatory signs are
  zero current, not deleted anatomy. The source metadata pins URLs and SHA-256.
- Motor leg assignments use explicit `fl`/`ml`/`hl` plus `somaSide`. Sensory
  assignments use explicit ProLN/MesoLN/MetaLN plus `rootSide`. Never infer
  anatomical side, leg or function from body-ID parity or connectivity alone.
- Literal muscle names establish Ti/Tr flexor/extensor channels and named
  coxal channels. Named coxa promotors occur only for the front legs in this
  extract; all six legs also have sternal anterior/posterior rotator channels.
  The anatomical interpretation is cited in `provenance.muscleFunctionSource`.
  Combining rotation and promotion/remotion into one body axis is a mechanical
  simplification; do not relabel rotators as measured promotor neurons.
- Receptor class is annotated, but neuron-specific joint and direction tuning
  are not. `sensoryJoint` and `sensoryDirection` are null. Angle/velocity/load
  transduction, muscle force, oscillator/reflex parameters and rate transfer
  between specimens must be labeled as modeling choices.
- The graph has real descending→VNC→motor and sensory/VNC→ascending→descending
  paths. Exact retained motor input coverage is in the extraction report.
  Neither the graph nor a source-based path proves a functioning gait; watch for tonic co-contraction,
  one-time movement followed by joint saturation, and missing stance/swing cycles.

To regenerate, install numpy/pandas/pyarrow, then run:

```sh
python3 etl_malecns.py /tmp/fly-male-cns --download
```

Raw public tables (~1.11 GB) stay outside the repository. `--out` can write a
reproducibility run elsewhere; compare both output files byte-for-byte.
The extractor asserts real paths to all six legs' coxal rotator/Ti/Tr antagonist channels,
per-leg sensory presence and ascending return paths, and writes coverage/path
evidence to `data/locomotor_report.json`. Preserve existing FlyWire files.
See `data/LOCOMOTOR_PROVENANCE.md` for the full source and modeling contract.

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
   body reaction) and, if sim-level, a `--simtest` probe. Cover active motor
   changes in `--locomotortest`; run all three suites.

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

## Windows port (`windows/`)

An Electron + three.js port lives in `windows/`. `Sim.swift` and
`FlyModel.swift` are ported to `windows/src/sim.js` and
`windows/src/flymodel.js`. `Locomotor.swift` and `LegDynamics.swift` have matching
`windows/src/locomotor.js` and `windows/src/legdynamics.js` implementations.
All three suites are mirrored (`npm run simtest`, `npm run behaviortest`,
`npm run locomotortest` — corresponding invariants).
**Any change to the sim or to behavior must be mirrored there and `npm test`
re-run**, otherwise the two platforms drift apart silently.

The rendering and OS layers are rewrites, not ports: SceneKit -> three.js,
NSPanel -> transparent `BrowserWindow`, `CGWindowList` -> `EnumWindows` via
koffi. See `windows/README.md` for the full mapping table and its gotchas
(the big one: Windows clamps a fixed-size window to one monitor, so the
overlay must stay resizable and the scene must trust `getBounds()`).

Unlike macOS, the Windows overlay spans the whole virtual desktop, so the fly
walks and flies between monitors on its own; `Fly.screens` keeps it out of the
dead corners of a non-rectangular layout.

## Repo conventions

- Public repo: `DenisSergeevitch/desktop-fly` (master). Code MIT; original
  FlyWire data CC BY-NC 4.0; MaleCNS data CC BY 4.0 — preserve the license split.
- README numeric claims (neuron/edge/synapse counts, latencies) must match
  `data/*.json` and suite output — reviewers falsify them against the data.
- `.gitignore` covers the binary, logs, and root-level PNGs (diagnostics
  outputs); intentional images live in `assets/`.
- Local folder is `fly-brain`; the remote is `desktop-fly` — harmless.
