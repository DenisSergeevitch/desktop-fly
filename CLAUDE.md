# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A 3D fruit fly on a transparent macOS overlay, behavior-driven by a 1 kHz
leaky-integrate-and-fire (LIF) simulation of a 668-neuron circuit extracted
from the real FlyWire connectome (FAFB v783). The body is procedural
SceneKit; the brain data is real.

## Files

| file | contents |
|---|---|
| `main.swift` | overlay scene, CLI modes, `SignalBuilder` (rates→commands), `Coordinator` (render-loop hub), `AppDelegate` (menu, timers, display switching) |
| `FlyModel.swift` | procedural fly body + `Fly` behavior (states, gait, flight, ledges, sleep) |
| `Sim.swift` | data loading, `BrainSignals`, `SpikeBus`, `LIFSim` (CSR network, stimulation API) |
| `BrainView.swift` | brain window: point clouds, click-to-stimulate, spike flashes |
| `Environment.swift` | permission-free senses: `WindowSense` (ledges/looms), circadian curve, user idle, thermal tempo |
| `etl.py` | raw Codex dumps → `data/brain_points.json` + `data/circuit.json` |
| `data/` | shipped derived data (CC BY-NC 4.0 — see `data/DATA_LICENSE.md`) |
| `windows/` | Electron + TypeScript + Three.js port: `src/core` the sim, sense rules and transductions, `src/body` the body + `Fly` + `Coordinator`, `src/main` the Electron shell + `win32.ts` (koffi FFI), `src/renderer` the WebGL renderer, `src/cli` the suites (design: `docs/superpowers/specs/2026-08-19-windows-port-design.md`) |

## Build, run, verify

```sh
./build.sh                     # bare swiftc, -swift-version 5, no Xcode project
./DesktopFly                   # menu-bar 🪰; quit from there
./DesktopFly --simtest         # circuit invariants (MUST pass after sim/etl changes)
./DesktopFly --behaviortest    # 17 end-to-end sim→body checks (MUST pass after behavior changes)
./DesktopFly --snapshot f.png  # offscreen fly render
./DesktopFly --brainshot b.png # offscreen brain render
```

Always run **both** suites after any change; they are the ground truth.
Both binaries locate `data/` next to the executable or in the cwd
(`findDataDir`) — run them from the repo root or they exit "no data/".
`DESKTOPFLY_FPS=1 ./DesktopFly` logs frame rate to stderr every 5 s.

`--simtest` exits non-zero only on these five (`main.swift:223`): zero GF
spikes over 4 s of rest · ≥1 GF spike during an abrupt loom · walk-drive
crosses its threshold at least once in 20 s · GF-cluster click stimulation
produces a spike · siesta (activityScale 0.84) walk-drive duty > 3%.
Everything else it prints — loom→GF latency (~4 ms), LC/DNa/pop rates,
left-eye steering diff, air-puff GF count — is a **diagnostic, not an
assertion**: read the numbers, don't rely on the exit code to catch a drift
in them. `--behaviortest` is 17 hard checks (7 stimulate-the-sim scenarios +
10 hand-built-signal body checks, incl. no per-frame scale/z snap at landing).

**Platform**: two targets share `data/`. The root Swift build is macOS-only
(Cocoa/SceneKit, bare `swiftc`, macOS 13+) and cannot be built or tested on
Windows — say so plainly rather than implying its suites passed. The `windows/`
subtree is the Electron/TypeScript port and IS verifiable here:
`cd windows && node --test && npm run simtest:strict && npm run behaviortest`.
`etl.py` and the
`data/*.json` invariants are checkable on either platform.

**Windows port gotchas** (each cost real debugging time):
- `THREE.Color(r, g, b)` reads its arguments as **linear**-sRGB; the Swift
  `NSColor(calibratedRed:)` values are sRGB. Convert with
  `setRGB(..., THREE.SRGBColorSpace)` or the whole fly washes out.
- `import.meta.url` is undefined in esbuild's CommonJS output, so anything
  resolving paths from it must also handle `__dirname`.
- Main must not *push* startup data to the renderer on `did-finish-load`: the
  renderer subscribes after that fires. Use `invoke`/`handle`.
- A GUI Electron process on Windows has no usable stdout — renderer errors go to
  `windows/renderer.log`, and `capturePage()` on a *visible* window needs an
  interactive desktop surface (use a hidden window to capture headlessly).
- `backgroundThrottling: false` is load-bearing: the sim clock runs off
  `requestAnimationFrame`, which Chromium throttles to ~1 Hz when occluded.
- **Native modules must be `external` in esbuild**, never bundled — `koffi`
  included. Bundling it rewrote its own `createRequire(import.meta.url)` and hung
  the app at load.
- koffi's `.d.ts` omits `proto`/`register`/`unregister`/`address` though all exist
  at runtime, and `register()` needs `pointer(proto)`, not the bare proto.
  `LASTINPUTINFO` must be declared `_Inout_` or `dwTime` comes back 0.
- Window ids must be **HWNDs**: with array indices every poll reports every
  window as newly appeared, and ledge tracking breaks.

**Caveat on the walk-duty invariant**: "walk-drive duty 20–50%" is a typical
run, not a bound. The 330 partner neurons draw random baselines that set the
drive onto DNp09, so duty spans ~17–43% across RNG seeds (measured in the
Windows port, which can pin the seed; the Swift build reshuffles it every run).
Treat a single low reading as normal variance, not a regression.

**SourceKit note**: the IDE reports "Cannot find type ..." across files —
false positives. The five .swift files compile as one module via build.sh;
trust the compiler, not single-file diagnostics.

## Threading model

- SceneKit render thread: `Coordinator.renderer(_:updateAtTime:)` steps the
  sim and updates flies. All cross-thread mutation goes through
  `Coordinator.enqueue {}` (lock + pending-actions queue, drained per frame).
- Main thread: timers (mouse 30 Hz, windows 0.7 s), menu actions, global
  click monitor — these only call enqueue/setters.
- Brain window has its own render delegate; spikes cross via `SpikeBus` (locked).
- `LIFSim.stimulate()` is thread-safe (pending list merged at `step()`).

## Frame contract (`Coordinator.renderer`, main.swift:632)

The one place the body↔brain loop closes; read it top-to-bottom before changing
any sense or signal.

1. **senses → sim inputs** — `loomL/loomR` = max(cursor loom, exponentially
   decaying window loom); `airPuff` = max(cursor whoosh, `typingLevel × 0.30`);
   `gaitDrive`/`gaitPhase` = fly #1's `walkingIntensity`/`gaitPhasePublic`
   (body→brain proprioception, injected onto ascending neurons with per-neuron
   phase offsets); `activityScale` = `(1 − (1−activity)×0.35) × (sleepy ? 0.75 : 1)`;
   `sensoryGate` = 0.55 asleep. `computeLoom` (radial approach ÷ distance,
   split between eyes by bearing sign) is the last non-connectome step —
   everything downstream of LC4/LPLC2 is real wiring.
2. **fixed 1 kHz stepping** — `msAccumulator` turns frame dt into whole
   milliseconds, clamped to 50 per frame, so the sim never chases a stalled
   render thread. `sim.simMs` therefore drifts behind wall time after a hitch.
3. **rates → commands** — `SignalBuilder.make`, shared verbatim with
   `--behaviortest` (that's what makes the suite meaningful).
4. **commands → body** — `fly.update(...)`: fly #1 gets `signals`, the rest `nil`.

`SignalBuilder` normalizations — change a divisor and every threshold in
`brainBehavior` shifts with it:

| signal | formula | clamp |
|---|---|---|
| `escape` | `consumeGF()` — latch, drained once per frame | bool |
| `nervous` | `rateLoom / 80` | 0…1 |
| `turnBias` | `(rateDNaL − rateDNaR − 8 s EMA baseline) × 0.04` | ±1 |
| `walkDrive` | `rateFwd / 10` | 0…1.3 |
| `groomDrive` | `rateGroom / 8` | **none** — add one if you touch it |
| `wingDrive` | `rateEscW / 10` | 0…1.3 |
| `arousal` | `ratePop / 20` | 0…1 |
| `backward` | `rateMDN > 8` | bool |

`tempo` and `sleep` are set by the coordinator afterwards, not by the sim.

## Body state machine (`FlyModel.swift`)

`State = walking | idle | grooming | flying | sleeping`. `Fly.update` routes
three ways: `flying` → `updateFlight` only, so brain signals reach the **wings**
(`brainLive`/`liveArousal`/`liveWing` → `effortCurrent`) but never the
trajectory — flight is ballistic from `startFlight` to the flare; grounded with
signals → `brainBehavior`; grounded without signals → the legacy
mouse-distance path (`SCARE_RADIUS`/`NERVOUS_RADIUS`, extra flies only).

Inside `brainBehavior` the order is load-bearing: `escape` is tested first and
interrupts even sleep; `sleep` then returns early, so nothing else can fire
while asleep (waking always routes through `.grooming`). Ledge attachment lives
in `updateWalk`, and `heading += turnBias·dt` is suppressed while on a ledge.

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
  Current truth (checkable without a Mac):
  `python -c "import json;c=json.load(open('data/circuit.json'));print(len(c['neurons']),len(c['edges']))"`
  → 668 neurons, 18,968 edges (~203k synapses), 23,210 brain points.
- `.gitignore` covers the binary, logs, and root-level PNGs (diagnostics
  outputs); intentional images live in `assets/`.
- Local folder is `fly-brain`; the remote is `desktop-fly` — harmless.
