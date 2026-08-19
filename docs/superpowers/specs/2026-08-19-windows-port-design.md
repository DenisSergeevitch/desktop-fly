# DesktopFly on Windows — design

Date: 2026-08-19
Status: approved for planning

## Goal

Run DesktopFly on Windows 11 with feature parity to the macOS build: a
transparent, click-through desktop overlay carrying a procedural 3D fly whose
behavior is driven by the same 1 kHz LIF simulation of the same 668-neuron
FlyWire circuit, plus the live brain window and the desktop-ecology senses.

The macOS build stays as it is. The five Swift files and `build.sh` remain at
the repo root and keep working; `data/` is shared by both targets.

## Non-goals

- Bit-identical spike trains with the Swift build. Different RNG and different
  float scheduling make that unachievable; see "Parity, defined".
- Windows 10 support as a hard requirement. Target Windows 11; Windows 10 22H2
  is expected to work but is not a milestone gate.
- macOS support from the new codebase. Electron would allow it later, but
  duplicating a working macOS build is not this project's problem.
- A shared cross-platform core between Swift and TypeScript. The Swift source
  is the reference; the port is a second implementation of it.

## Constraints

Verified on the development machine (2026-08-19): .NET SDK 10.0.400, Node
24.19.0, Python 3.13.14, RTX 4070 Laptop + Intel UHD hybrid graphics. **No
Swift toolchain, no Rust, no MSVC/`cl.exe`.** The absence of a C++ compiler
rules out any dependency needing a node-gyp native build; FFI must come from a
prebuilt package (koffi).

## Stack

Electron + TypeScript + Three.js.

Chosen because every SceneKit feature the project uses has a direct Three.js
analog — `SCNSphere`/`SCNCapsule`/`SCNCone` → `SphereGeometry`/
`CapsuleGeometry`/`ConeGeometry`, `SCNShape` extrusion → `ExtrudeGeometry`,
directional + ambient lights with shadow maps, orthographic camera, the
shadow-catcher plane → `ShadowMaterial`, and critically the 23,210-point
brain cloud → `Points` + `BufferGeometry` with additive blending. Electron
supplies the transparent frameless click-through window and the tray menu as
first-class features. Win32 sensing goes through koffi (prebuilt FFI, no
compiler needed).

The rejected alternative was C#/.NET, which is attractive for a native
single-exe but supplies no 3D primitives and forces either a compromised brain
window (WPF Media3D has no blend-mode control and no point rendering) or a
hand-written D3D11 + DirectComposition renderer before the fly first appears.

## Architecture

### Layering

```
windows/
  package.json  tsconfig.json  build.mjs
  src/
    core/     sim.ts  signals.ts  circadian.ts  types.ts
    body/     flyModel.ts  fly.ts
    main/     main.ts  windowSense.ts  inputSense.ts  cpuTempo.ts
    renderer/ overlay.ts  brainWindow.ts  preload.ts
    cli/      simtest.ts  behaviortest.ts  snapshot.ts  datatest.ts
```

The layering rule is what makes the test suites possible and must not be
violated:

| layer | may import | rationale |
|---|---|---|
| `core/` | Node stdlib only | runs headless; no Electron, no Three.js |
| `body/` | `core/`, `three` | scene-graph objects only — never a `WebGLRenderer` |
| `main/` | `core/`, `electron`, `koffi` | no Three.js; owns OS integration |
| `renderer/` | `core/`, `body/`, `three`, IPC bridge | owns rendering |
| `cli/` | `core/`, `body/`, `three` | `simtest`, `behaviortest`, `datatest` run under plain Node |

`cli/snapshot.ts` is the one exception: rendering needs a GL context, and the
only headless Node option (`headless-gl`) requires a native build that the
missing MSVC toolchain rules out. So `--snapshot`/`--brainshot` run under the
`electron` binary with a hidden offscreen `BrowserWindow` and `capturePage()`,
not under plain Node. The three logic suites stay Electron-free, which is what
matters — they are the ones that gate every milestone.

Three.js instantiates `Object3D`/`Geometry` without a WebGL context, so
`cli/behaviortest.ts` builds the real fly body in Node and asserts on real
transforms. This is the whole reason `body/` is separated from `renderer/`.

### Source mapping

| Swift | TypeScript |
|---|---|
| `Sim.swift` | `core/sim.ts` (`BrainSignals`, `SpikeBus`, `LIFSim`, data loading) |
| `main.swift` `SignalBuilder` | `core/signals.ts` |
| `Environment.swift` `circadianActivity` | `core/circadian.ts` |
| `Environment.swift` `Ledge` | `core/types.ts` |
| `FlyModel.swift` geometry half | `body/flyModel.ts` |
| `FlyModel.swift` `Fly` class | `body/fly.ts` |
| `Environment.swift` `WindowSense` | `main/windowSense.ts` |
| `Environment.swift` idle | `main/inputSense.ts` |
| `Environment.swift` `thermalTempo` | `main/cpuTempo.ts` (substituted — see below) |
| `main.swift` `AppDelegate` | `main/main.ts` |
| `main.swift` `buildScene` + `Coordinator` | `renderer/overlay.ts` |
| `BrainView.swift` | `renderer/brainWindow.ts` |
| `main.swift` `runSimtest`/`runBehaviorTest`/snapshots | `cli/*.ts` |

### Process split

Electron's process model maps onto the existing threading model rather than
replacing it:

- **Renderer process ≡ SceneKit render thread.** The sim steps and the flies
  update inside the `requestAnimationFrame` callback, exactly as
  `Coordinator.renderer(_:updateAtTime:)` does today. Keeping the sim here
  keeps the escape pathway off IPC, which matters because a Giant Fiber spike
  reaching the body late is the one failure the project's whole premise rests
  on.
- **Main process ≡ macOS main thread.** Timers at the existing cadences
  (cursor 30 Hz, `EnumWindows` 0.7 s, click poll 30 Hz, CPU sample ~2 s), tray
  menu, app lifecycle.
- **IPC ≡ `Coordinator.enqueue`.** Messages are drained at the top of the
  frame into the same pending-actions pattern.

### IPC contract

One channel each direction.

`senses` (main → renderer, coalesced, sent at the cursor cadence):

```ts
{ ledges: Ledge[], newWindows: {center: Pt, size: number}[],
  cursor: Pt | null, typing: number, sleepy: boolean,
  tempo: number, activity: number, taps: Pt[] }
```

`command` (main → renderer): `pause | resume | escapeTest | addFly |
removeFly | scareAll | moveToDisplay | showBrain | hideBrain`.

No renderer → main channel in the hot path. Two deliberate simplifications
against the Swift design, neither changing behavior:

1. **Tap proximity is decided in the renderer.** Main reports where a click
   happened; the renderer knows where the fly is. This deletes the
   `flyPosition()` lock round-trip that macOS needs because its click monitor
   lives on the main thread.
2. **The overlay uses `setIgnoreMouseEvents(true)` without `forward: true`.**
   We never interact with the overlay and poll the cursor globally instead, so
   event forwarding — and its known focus quirks — is unnecessary. The brain
   window is a separate ordinary window and stays fully interactive.

### Coordinates

Two systems, converted exactly once, in main, before IPC:

- **Screen space**: Electron DIP coordinates, origin top-left of the primary
  display, y down. Working in DIPs (not physical pixels) makes Chromium absorb
  per-monitor DPI scaling, so the behavior math keeps operating in
  macOS-equivalent "points".
- **Scene space**: origin at the center of the fly's current display, y up —
  identical to the Swift convention.

This is where `WindowSense.poll(screen:)` already does its CG→scene
conversion, so the boundary is unchanged. Preserving scene space verbatim is
what lets `brainBehavior`, `updateWalk`, `computeLoom`, the ledge math, and all
tuned constants port without re-derivation.

### Two Electron settings that are correctness issues

Both look like tuning knobs and are not; both get explanatory comments:

- `webPreferences.backgroundThrottling: false` — Chromium throttles
  `requestAnimationFrame` to roughly 1 Hz for occluded or background windows.
  Since the sim clock is driven from the frame loop, throttling would freeze
  the fly *and* stall the brain.
- `setAlwaysOnTop(true, 'screen-saver')` — reproduces
  `NSWindow.Level.floating`, keeping the overlay above normal windows.

Also required on the overlay window: `transparent: true`, `frame: false`,
`skipTaskbar: true`, `focusable: false`, `hasShadow: false`, `resizable: false`.

## Sensing: Win32 substitutions

| macOS | Windows | fidelity |
|---|---|---|
| `CGWindowListCopyWindowInfo` → ledges | `EnumWindows` + `GetWindowRect` + `IsWindowVisible`, filtering `WS_EX_TOOLWINDOW`, zero-length titles, and `DWMWA_CLOAKED` windows; own windows skipped by HWND | equivalent |
| cursor position | `screen.getCursorScreenPoint()` | equivalent, no FFI |
| `CGEventSource` idle → sleep | `GetLastInputInfo` | equivalent |
| "typing is vibration, never which key" | `GetLastInputInfo` advancing while the cursor has *not* moved ⇒ keyboard activity | equivalent; preserves the privacy property (when, never what) |
| global click monitor → substrate taps | `GetAsyncKeyState(VK_LBUTTON)` polled at 30 Hz — no hook, no elevation, no permissions | equivalent |
| `ProcessInfo.thermalState` → tempo | **substitution**: CPU busy fraction from `os.cpus()` time deltas, bucketed to the existing 1.0 / 1.15 / 1.35 / 1.5 steps | *not* a temperature sensor |

Windows exposes no dependable thermal-state API (laptop ACPI thermal zones are
frequently absent or lie), so the ectotherm conceit becomes "a busy PC is a
faster fly." This must be documented as a substitution in the Windows README
rather than implied to be a sensor reading.

The koffi surface is deliberately tiny: `EnumWindows`, `GetWindowRect`,
`IsWindowVisible`, `GetWindowLongPtrW`, `GetWindowTextLengthW`,
`DwmGetWindowAttribute`, `GetLastInputInfo`, `GetAsyncKeyState`. Everything
else comes from Electron or Node.

## Porting discipline

Literal transliteration first: same file names, same function names, same
constant values, same order of operations. Idiomatic TypeScript only where the
language forces it (no `struct` value semantics, no `inout`, typed arrays for
the CSR).

**The Swift source is normative.** This spec deliberately does not restate the
tuned constants — `decay`, `weightScale`, `pNoise`, `noiseKick`, `loomGain`,
`gapJunctionBoost`, `inhDelayMs`, the per-role baselines, the behavior
thresholds in `brainBehavior`, the `computeLoom` transduction, the circadian
knot points — because a second copy is a second source of truth that will
drift. Each port task cites the Swift line range it transliterates, and review
compares against that.

The razor-thin operating point (`baseline × 20.4` against threshold `1.0`) is
why transliteration beats a clean-room rewrite: drift here does not crash, it
silently makes populations quiet, which reads as vague behavioral wrongness
rather than as a failure.

Known translation hazards, called out so they are not discovered as bugs:

- **Euler angle order.** SceneKit applies `eulerAngles` as intrinsic
  ZYX-ish; Three.js `Object3D.rotation` defaults to `'XYZ'`. Any node whose
  Swift code sets two or more angles at once needs its order set explicitly.
- **Pivot anchoring.** The six-legged capsule hierarchy relies on nodes whose
  geometry is offset from their pivot (`buildLeg`'s femur/knee/tibia/ankle
  chain). Three.js geometries are centered on their origin, so each segment
  needs a `translate()` on the geometry or an intermediate `Group`.
- **`SCNShape` extrusion of an `NSBezierPath` oval** (the wings) becomes a
  hand-tuned Three.js `Shape` with bezier curves — expect this to need visual
  iteration, not mechanical translation.
- **`CGFloat`/`Float` mixing** disappears into `number`; the sim's `Float32`
  accumulation should use `Float32Array` for `v`, `w`, and the inhibition ring
  buffer so rounding behavior stays close to the original.

## Parity, defined

Parity is behavioral and statistical, never spike-for-spike. Concretely, the
port is correct when:

1. Both ported suites pass with the same exit-code semantics as the Swift
   originals.
2. The documented invariants hold: GF silent across 4 s of rest, GF fires
   within ~10 ms of an abrupt loom, walk-drive duty 20–50%, siesta at
   `activityScale` 0.84 keeps walk-drive above 3%, no per-frame scale or z snap
   at landing.
3. Printed rate summaries (population Hz/neuron, LC Hz, DNa L/R, DNp09 range)
   land in the same bands the Swift suite prints.
4. `--snapshot` and `--brainshot` are recognizably the same fly and the same
   brain as the committed `assets/fly.png` and `assets/brain.png`.

## Error handling

Every failure path mirrors an existing macOS degradation rather than inventing
new behavior:

| condition | behavior | macOS precedent |
|---|---|---|
| `data/` missing | tray reads "no data — run etl.py"; flies run the legacy distance-based path; brain window disabled | the existing `sim: nil` branch, already exercised by flies #2+ |
| koffi load fails, or `EnumWindows` throws | log once, return an empty snapshot; fly keeps walking | `CGWindowListCopyWindowInfo` returning nil |
| display added/removed/rescaled | recompute overlay bounds on `display-metrics-changed` | `retarget(size:)` / `move(to:)` |
| machine resumes from sleep | reset `lastTime` on `powerMonitor` resume, alongside the existing `min(0.05, dt)` clamp | the dt clamp |
| frame hitch | sim steps clamped to 50 ms/frame | unchanged from `Coordinator` |

## Testing

Suites run under Node 24's native TypeScript stripping — no build step, no test
framework, matching the Swift build's "bare compiler, no project file" spirit.

Type stripping *erases* types rather than transforming code, which imposes two
rules on `core/`, `body/`, and `cli/`: no TypeScript construct that needs
codegen (no `enum`, no `namespace`, no constructor parameter properties, no
decorators — use `const` object literals with union types instead), and
relative imports carry explicit `.ts` extensions. `renderer/` and `main/` go
through esbuild and are not restricted, but keeping one rule across the whole
port is simpler than remembering which half is which.

| command | contents |
|---|---|
| `npm run simtest` | the 6 phases of `runSimtest`, same printed lines, same 5 exit-code assertions |
| `npm run simtest -- --strict` | additionally asserts the ranges the Swift suite only prints |
| `npm run behaviortest` | all 17 checks (7 sim-stimulation scenarios + 10 body checks) |
| `npm run datatest` | asserts 668 neurons / 18,968 edges / 23,210 points |
| `npm run snapshot -- f.png` | offscreen fly render |
| `npm run brainshot -- b.png` | offscreen brain render |

`--strict` and `datatest` are additions, not parity items. They exist because
the Swift `--simtest` prints its most interesting numbers — loom→GF latency,
walk duty, population rates — without asserting any of them, so fidelity drift
currently shows up as output a human has to notice. Machine-checking them here
costs a few lines.

## Milestones

Each milestone is independently verifiable and independently stoppable.

**M1 — core sim, headless.** `core/` + `cli/simtest.ts` + `cli/datatest.ts`.
Done when: `simtest --strict` and `datatest` pass; printed rates land in the
Swift bands.

**M2 — body and overlay.** `body/` + `renderer/overlay.ts` + minimal
`main/main.ts`. Done when: all 17 behavior checks pass; the fly walks, darts,
takes off, flies, lands, and grooms on a transparent overlay; desktop icons
are clickable through the overlay; `--snapshot` resembles `assets/fly.png`.

**M3 — desktop senses.** `main/windowSense.ts`, `inputSense.ts`, `cpuTempo.ts`.
Done when: the fly lands on and walks along a real window's title bar, rides
it as the window is dragged, and startles when it closes; going idle puts the
fly to sleep and it grooms on waking; clicking near it startles it; sustained
CPU load visibly speeds it up.

**M4 — brain window.** `renderer/brainWindow.ts`. Done when: 23,210 points
render colored by super-class, live spikes flash at real neuron positions,
hovering pauses rotation, clicking a region stimulates the nearest ~60 circuit
neurons and the fly reacts downstream (GF → escape, DNg11 → groom, one-sided
DNa → turn); `--brainshot` resembles `assets/brain.png`.

**M5 — shell and packaging.** Tray menu parity (pause/resume, show/hide brain,
escape test, move to next display, add/remove fly, scare), multi-monitor hop,
`npm run dist` producing a runnable packaged app. Docs: a Windows section in
`README.md`, `data/` licensing split restated, and `CLAUDE.md` updated to
cover the `windows/` subtree — including replacing its current "changes here
are unverified until someone builds them on a Mac" note, which stops being
true for the Windows target.

## Risks

| risk | mitigation |
|---|---|
| Leg/wing pivot conventions cost more than estimated | budgeted explicitly in M2; iterate visually against `assets/fly.png` |
| Hybrid GPU (Optimus) picks the Intel adapter for the overlay | acceptable for this workload; revisit only if frame rate suffers |
| Transparent always-on-top window is covered by exclusive-fullscreen games | accepted limitation, documented |
| koffi struct marshalling for `RECT` / `LASTINPUTINFO` | isolated in `main/windowSense.ts` + `inputSense.ts`; both degrade to no-op on failure |
| Mixed-DPI multi-monitor edge cases | DIP coordinates throughout; `display-metrics-changed` recompute |
| Electron renderer module loading (ESM vs CJS) | esbuild bundles four entry points; `contextIsolation: true` with a thin preload |

## Licensing

New code is MIT, matching the repo. `data/` remains CC BY-NC 4.0 (FlyWire
terms) and is not modified, copied, or relicensed by this work — the Windows
build reads the same files in place.
