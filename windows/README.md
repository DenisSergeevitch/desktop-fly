# DesktopFly for Windows

Windows port of DesktopFly. The brain is the same: the same `data/` files, the
same 668-neuron FlyWire v783 circuit, the same 1 kHz LIF dynamics.

**Status: M2b — the fly is on screen.** A transparent, click-through,
always-on-top overlay, with your cursor as a real looming stimulus into the
LC4/LPLC2 population. Window terrain, sleep, taps and the tray menu are still to
come (M3 and M5), so for now quit with Ctrl+C in the launching terminal.

## Requirements

Node >= 24 (for native TypeScript type stripping) and `npm install`.

Runtime dependencies: `three` (M2a) and `electron` (M2b).

**On npm's `allow-scripts` warnings.** If your npm blocks package install
scripts, the two dependencies behave differently:

- **`electron` genuinely needs its postinstall** — that step downloads the
  ~360 MB Chromium binary. Without it `dist/electron.exe` is missing and nothing
  runs. Fetch it explicitly with `node node_modules/electron/install.js`.
- **`esbuild`'s warning is safe to ignore.** Its Windows binary ships inside the
  `@esbuild/win32-x64` package, so `npm run build` works with the postinstall
  still unapproved. Approving it is optional.

## Commands

```sh
cd windows
node --test               # unit tests (93)
npm run datatest          # data invariants (668 neurons / 18,968 edges / 23,210 points)
npm run simtest           # circuit diagnostics, Swift-parity exit conditions
npm run simtest:strict    # also asserts the ranges the Swift suite only prints
npm run behaviortest      # 17 end-to-end checks: stimulate neurons -> body reacts
npm run typecheck         # tsc --noEmit

npm start                 # the overlay: a fly on your desktop (Ctrl+C to quit)
npm run snapshot          # offscreen fly render -> fly.png
```

To check the overlay without watching the screen — useful on a remote or
non-interactive session — render it straight to a PNG:

```sh
npm run build && electron dist/main.cjs --capture=overlay.png
```

The capture uses a hidden window on purpose: `capturePage()` on a *visible*
window needs a real interactive desktop surface and hangs without one. Renderer
diagnostics go to `renderer.log`, because a GUI Electron process on Windows has
no usable stdout — without that file a renderer exception is completely silent
and looks like a hung window.

`--seed=N` picks the RNG seed for any of the three suites (default 1).

## The body

`src/body/` is a transliteration of `FlyModel.swift`: procedural geometry
(thorax, abdomen with banded texture, head, eyes, antennae, proboscis, six
three-segment capsule legs, extruded wings, wing-blur discs) plus the `Fly`
behavior — tripod gait, ledge walking, flight with an effort-scaled altitude
curve and a flare landing, grooming, sleep, and `brainBehavior`, where every
decision reads a real neuron population's rate.

Because Three.js builds scene graphs without a WebGL context, all 17 behavior
checks assert on real `Object3D` transforms under plain Node — no rendering, no
screenshots, no GPU.

**Not yet verified:** how the fly *looks*. The geometry is numerically faithful
to the Swift source, but nothing has been rendered, so any visual discrepancy
against `assets/fly.png` is still unknown. Expect the legs and wings to need
tuning once M2b can draw them.

## What the overlay is

One transparent full-screen window per display, `setIgnoreMouseEvents(true)` so
every click passes through to whatever is underneath, and
`setAlwaysOnTop(true, 'screen-saver')` to float above ordinary windows. Two
settings in there are correctness issues rather than preferences, and both carry
comments saying so:

- `backgroundThrottling: false` — Chromium throttles `requestAnimationFrame` to
  ~1 Hz for background or occluded windows, and the 1 kHz sim clock is driven
  from the frame loop, so throttling would freeze the fly *and* stall the brain.
- `setIgnoreMouseEvents(true)` without `forward: true` — the cursor is polled
  globally at 30 Hz, so event forwarding (and its focus quirks) is unnecessary.

Verified by capture: the overlay is fully transparent except for the fly itself
(one 78x70 px region in a 3840x2160 frame).

## Visual verdict against the macOS render

`npm run snapshot` next to `assets/fly.png`: **close match.** Dark brown
three-segment legs, brown thorax, banded abdomen with a dark tip, red eyes, and
one translucent wing folded over the abdomen all line up. Two small deviations
remain: the wing reads slightly greyer and shorter than SceneKit's, and the
framing sits marginally off-centre.

Getting there required fixing a colour-space bug that no test could see —
`THREE.Color(r, g, b)` interprets its arguments in the linear working space,
while the Swift source specifies sRGB via `NSColor(calibratedRed:)`. Passing
sRGB numbers through as linear washed the entire fly out.

## Verified against the macOS build's documented invariants

- Giant fiber silent across 4 s of rest.
- Giant fiber fires **4 ms** after an abrupt loom — at every seed tested (1-8),
  matching the ~4 ms the root README claims.
- Siesta (`activityScale` 0.84) slows the fly without silencing it.
- Population rate ~5-7 Hz/neuron at rest.

## Differences from the macOS build

- **Seeded RNG.** `LIFSim` takes a seed so the suites are reproducible; the
  Swift build uses a non-deterministic system RNG.
- **`groomDrive` is clamped** to 0..1.3 like its five siblings. Behaviorally
  inert: it is only compared against the 0.5/0.3 hysteresis thresholds.
- **No locks.** `SpikeBus` and the stimulation queue need none — a JS context is
  single-threaded, where macOS steps the sim on the SceneKit render thread.
- Parity with the macOS build is behavioral and statistical, never
  spike-for-spike.

One finding worth recording: **walk-drive duty is seed-dependent**, spanning
17-43% (mean 32%) across seeds 1-8, because the circuit's 330 partner neurons
draw random baselines that set the drive onto DNp09. `CLAUDE.md` describes it as
"20-50%", which is a typical run rather than a bound — the Swift build has the
same spread, reshuffled every run by its system RNG. The 20-50% claim is
asserted here as a mean across seeds (`dynamics.test.ts`); the per-run gate in
`--simtest --strict` is 10-60%.

See `docs/superpowers/specs/2026-08-19-windows-port-design.md` for the full
design, including the Win32 sensing substitutions planned for M3.
