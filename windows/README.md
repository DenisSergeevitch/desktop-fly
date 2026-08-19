# DesktopFly for Windows

Windows port of DesktopFly. The brain is the same: the same `data/` files, the
same 668-neuron FlyWire v783 circuit, the same 1 kHz LIF dynamics.

**Status: M4 — the brain is visible.** A transparent, click-through,
always-on-top overlay spanning every monitor; your cursor is a real looming
stimulus into the LC4/LPLC2 population; your window title bars are walkable
ledges; going idle at night puts it to sleep; clicks are substrate taps; a busy
PC makes it faster; and a second window shows the actual brain, with live spikes
and click-to-stimulate. The tray menu is still to come (M5), so quit with Ctrl+C
in the launching terminal.

## Requirements

Node >= 24 (for native TypeScript type stripping) and `npm install`.

Runtime dependencies: `three` (M2a), `electron` (M2b) and `koffi` (M3).

**On npm's `allow-scripts` warnings.** If your npm blocks package install
scripts, the two dependencies behave differently:

- **`electron` genuinely needs its postinstall** — that step downloads the
  ~360 MB Chromium binary. Without it `dist/electron.exe` is missing and nothing
  runs. Fetch it explicitly with `node node_modules/electron/install.js`.
- **`esbuild`'s and `koffi`'s warnings are safe to ignore.** Both ship prebuilt
  Windows binaries (`@esbuild/win32-x64`, and koffi's own bundled build), so the
  build and the Win32 calls work with their install scripts unapproved.

## Commands

```sh
cd windows
node --test               # unit tests (141)
npm run datatest          # data invariants (668 neurons / 18,968 edges / 23,210 points)
npm run simtest           # circuit diagnostics, Swift-parity exit conditions
npm run simtest:strict    # also asserts the ranges the Swift suite only prints
npm run behaviortest      # 17 end-to-end checks: stimulate neurons -> body reacts
npm run typecheck         # tsc --noEmit

npm start                 # the overlay: a fly on your desktop (Ctrl+C to quit)
npm run snapshot          # offscreen fly render -> fly.png
npm run brainshot         # offscreen brain render -> brain.png
npm run sensetest         # what the Win32 senses see on this machine
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

## The brain window

Opens automatically beside the fly (bottom-right) when `data/` is present, and
unlike the overlay it is an ordinary interactive window.

- **23,210 real soma positions** from FlyWire v783, coloured by super-class, drawn
  additively so the optic lobes glow and internal structure shows through.
- **The 668-neuron circuit** on top, brighter and larger, coloured per role — cyan
  looming detectors, orange steering, green walking, magenta moonwalker, and the
  two Giant Fibers as glowing gold markers.
- **Live spikes** flash at their true anatomical positions. A giant-fiber spike
  flashes 3.2x larger and lingers twice as long, so an escape is unmissable.
- **Hovering pauses the rotation**, so you can aim at a target.
- **Clicking stimulates** the ~60 nearest circuit neurons for 400 ms and names
  what you hit. The fly's reaction is whatever the real network does downstream:
  click the gold Giant Fiber markers and it escapes; click DNg11 and it grooms;
  click one side's DNa01/02 and it turns.

The simulation stays in the *overlay* process. Spikes travel overlay → main →
brain and stimulation requests travel back, so only visuals cross IPC — the
LC→GF escape race, where 4 ms decides whether the fly gets away, never does.

## Multi-monitor behaviour (a deliberate departure from macOS)

macOS keeps the fly on one display and offers a "Move to Next Display" menu item.
On Windows the desktop is one continuous space, so **the overlay spans every
display** instead.

That creates a problem the macOS build never has: a window must be rectangular,
but monitors of different sizes or vertical offsets do not tile a rectangle. On
the development machine the bounding box is 4096x1545 while the two monitors
(2560x1392 at the origin, 1536x912 offset *down* by 633) leave large parts of it
on no display at all — a fly walking there would simply vanish. `core/arena.ts`
therefore constrains the fly to the **union of the real monitor rectangles**: it
turns around at the invisible wall between screens, flight targets are drawn from
covered area only, and even its start position is clamped, because the scene
origin itself can fall in the gap.

**Known cost:** one window has a single scale factor, so with mixed DPI (150% and
125% here) the fly renders about 20% larger on the lower-scaled screen. Window
rectangles are converted per-monitor via `screen.screenToDipRect`, so the terrain
is correct on both regardless.

## Desktop ecology (all permission-free)

| sense | how | verified on this machine |
|---|---|---|
| window terrain | `EnumWindows` + `GetWindowRect`, filtered by `DWMWA_CLOAKED`, `WS_EX_TOOLWINDOW`, title and size | 653 windows → 15 visible → **3 walkable ledges** |
| window looms | newly appeared windows feed the looming pathway | ids are HWNDs, so reopening counts as new |
| sleep | `GetLastInputInfo`; idle > 10 min at night, or > 30 min any time | idle tracked to 0.1 s |
| typing "vibration" | input advancing while the cursor is still | typing level rose to 0.83 while typing |
| substrate taps | `GetAsyncKeyState(VK_LBUTTON)` polled at 30 Hz | one click = one tap |
| tempo | CPU busy fraction from `os.cpus()` deltas | 14% → tempo 1.00 |

Nothing here needs elevation, installs a hook, or can observe **which** key was
pressed — only when, exactly as the macOS build guarantees. `core/` holds all the
decision rules (and is tested); `main/win32.ts` is the only file that touches the
FFI, and it degrades to empty results on any failure so the fly keeps walking.

Two of these are **substitutions**, not equivalents, and are labelled as such in
the code:

- **CPU load stands in for `ProcessInfo.thermalState`.** Windows exposes no
  dependable thermal API — laptop ACPI thermal zones are frequently absent or
  wrong — so "a hot Mac is a fast fly" becomes "a busy PC is a fast fly". This is
  not a temperature reading.
- **Typing is inferred**, because `GetLastInputInfo` reports combined input while
  macOS can ask about the keyboard alone. Input advancing without cursor movement
  is read as typing.

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
