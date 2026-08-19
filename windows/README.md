# DesktopFly for Windows

A Windows port of DesktopFly. The brain is the same brain: the same `data/`
files, the same 668-neuron FlyWire v783 circuit, the same 1 kHz
leaky-integrate-and-fire dynamics. Only the presentation layer is new —
Cocoa/SceneKit became Electron + Three.js, and the macOS senses became Win32
ones.

**Status: feature parity with the macOS build.** A transparent, click-through,
always-on-top overlay spanning every monitor; your cursor is a real looming
stimulus into the LC4/LPLC2 population; window title bars are walkable ledges;
going idle at night puts the fly to sleep; clicks are substrate taps; a busy PC
makes it faster; a second window shows the actual brain with live spikes and
click-to-stimulate; and a tray menu drives all of it.

## Requirements

- **Node 24+** — the suites run TypeScript directly through Node's native type
  stripping, with no build step.
- `npm install`.

Runtime dependencies are just **`three`** and **`koffi`**. `electron`,
`esbuild`, `electron-builder` and the type packages are dev dependencies —
electron-builder supplies the Electron runtime to packaged builds itself.

**If your npm blocks package install scripts** (`npm warn allow-scripts`), the
packages differ in whether that matters:

- **`electron` genuinely needs its postinstall**, which downloads the ~360 MB
  Chromium binary. Without it `node_modules/electron/dist/electron.exe` does not
  exist and nothing runs. Fetch it explicitly:
  `node node_modules/electron/install.js`.
- **`esbuild` and `koffi` are fine unapproved.** Both ship prebuilt Windows
  binaries (`@esbuild/win32-x64`, and koffi's own bundled build), so the build
  and every Win32 call work without running their scripts.

## Quick start

```sh
cd windows
npm install
npm start
```

A 🪰 icon appears in the notification area and a fly starts walking your
desktop. **To quit: right-click the tray icon → Quit.** (Ctrl+C in the launching
terminal also works, but a packaged build has no terminal.)

## The overlay

**One** transparent window covering the bounding box of every display —
`setIgnoreMouseEvents(true)`, so every click passes straight through to whatever
is underneath, and always-on-top so the fly appears above ordinary windows.

Measured on this machine: the capture is 6144×2319 device px and **only 1,206
pixels are non-transparent — 0.0085% of the frame** — the fly itself, about
47×50 px. Everything else is fully see-through.

Two settings in there are correctness issues rather than preferences, and both
carry comments in the source saying so:

- `backgroundThrottling: false` — Chromium throttles `requestAnimationFrame` to
  ~1 Hz for background or occluded windows, and the 1 kHz sim clock is driven
  from the frame loop, so throttling would freeze the fly *and* stall the brain.
- `setIgnoreMouseEvents(true)` **without** `forward: true` — the cursor is polled
  globally at 30 Hz, so event forwarding (and its focus quirks) is unnecessary.

## The brain window

Opens bottom-right at startup when `data/` is present. Unlike the overlay it is
an ordinary interactive window.

- **23,210 real soma positions** from FlyWire v783, coloured by super-class and
  drawn additively so the optic lobes glow and internal structure shows through.
- **The 668-neuron circuit** on top, brighter and larger, coloured per role —
  cyan looming detectors, orange steering, green walking, magenta moonwalker,
  and the two Giant Fibers as glowing gold markers.
- **Live spikes** flash at their true anatomical positions. A giant-fiber spike
  flashes 3.2× larger and lingers twice as long, so an escape is unmissable.
- **Hovering pauses the rotation**, so you can aim at a target.
- **Clicking stimulates** the ~60 nearest circuit neurons for 400 ms and names
  what you hit. The fly's reaction is whatever the real network does downstream:
  click the gold Giant Fiber markers and it escapes, DNg11 and it grooms, one
  side's DNa01/02 and it turns.

If the window ever goes missing, it has a **taskbar button** — Windows demotes
always-on-top windows for full-screen apps, and that button is the way back.
Always-on-top is also re-asserted automatically on the 0.7 s window poll.

The simulation stays in the *overlay* process. Spikes travel overlay → main →
brain and stimulation requests travel back, so only visuals cross IPC — the
LC→GF escape race, where 4 ms decides whether the fly gets away, never does.

## The tray menu

Left-click the icon toggles the brain window; right-click opens the menu:

| item | effect |
|---|---|
| Pause / Resume | freezes the sim and the body; resuming does not jump |
| Show/Hide Brain | toggles the brain window, re-creating it if you closed it |
| Escape Test (loom) | injects a looming stimulus; watch the giant fiber fire |
| Add / Remove Fly | extra flies (only fly #1 carries the brain) |
| Scare Flies | startles everyone |
| Quit | exits |

Three deliberate differences from the macOS menu:

- **No "Move to Next Display".** macOS keeps the fly on one screen and hops on
  command; here the overlay spans every display, so the fly already roams all of
  them and the item would do nothing.
- **A drawn icon rather than an emoji.** macOS sets the status item's *title* to
  🪰; a Windows tray needs an image, so `assets/tray.png` ships a small glyph.
- **No keyboard shortcuts.** macOS binds p/b/e/a/r/s/q, which works because the
  menu belongs to a focused app. Our overlay is deliberately unfocusable and
  there is no menu bar, so accelerators would need *global* shortcut
  registration — grabbing keys system-wide, which contradicts this project's
  permission-free, keystroke-blind design.

## Desktop ecology (all permission-free)

| sense | how | measured on this machine |
|---|---|---|
| window terrain | `EnumWindows` + `GetWindowRect`, filtered by `DWMWA_CLOAKED`, `WS_EX_TOOLWINDOW`, title and size | 658 windows → 15 visible → **7 walkable ledges** (varies with what is open) |
| window looms | newly appeared windows feed the looming pathway | ids are HWNDs, so closing and reopening counts as new |
| sleep | `GetLastInputInfo`; idle > 10 min at night, or > 30 min any time | idle tracked to 0.1 s |
| typing "vibration" | input advancing while the cursor stays still | typing level rose to 0.83 while typing |
| substrate taps | `GetAsyncKeyState(VK_LBUTTON)` polled at 30 Hz | one click = one tap |
| tempo | CPU busy fraction from `os.cpus()` deltas | 14% → tempo 1.00 |

Nothing here needs elevation, installs a hook, or can observe **which** key was
pressed — only *when*, exactly as the macOS build guarantees. `core/` holds all
the decision rules and is unit-tested; `main/win32.ts` is the only file that
touches the FFI, and it degrades to empty results on any failure so the fly keeps
walking.

Two of these are **substitutions**, not equivalents, and are labelled as such in
the code:

- **CPU load stands in for `ProcessInfo.thermalState`.** Windows exposes no
  dependable thermal API — laptop ACPI thermal zones are frequently absent or
  simply wrong — so "a hot Mac is a fast fly" becomes "a busy PC is a fast fly".
  This is not a temperature reading.
- **Typing is inferred.** `GetLastInputInfo` reports combined input, while macOS
  can ask about the keyboard alone, so input advancing without cursor movement is
  read as typing. The privacy property is unchanged: when, never what.

## Multi-monitor (a deliberate departure from macOS)

macOS keeps the fly on one display and offers a "Move to Next Display" menu item.
On Windows the desktop is one continuous space, so **the overlay spans every
display** instead.

That creates a problem the macOS build never has: a window must be rectangular,
but monitors of different sizes or vertical offsets do not tile a rectangle. On
this machine the bounding box is 4096×1545 while the two monitors (2560×1392 at
the origin, and 1536×912 offset *down* by 633) leave large parts of that box on
no display at all — a fly walking there would simply vanish. `core/arena.ts`
therefore confines the fly to the **union of the real monitor rectangles**: it
turns around at the invisible wall between screens, flight targets are drawn only
from covered area, and even its starting position is clamped, because the scene
origin itself falls in the gap here.

**Known cost:** one window carries a single scale factor, so with mixed DPI (150%
and 125% here) the fly renders about 20% larger on the lower-scaled screen.
Window rectangles are converted per-monitor via `screen.screenToDipRect`, so the
terrain itself is correct on both.

## Commands

```sh
node --test               # 146 unit tests, no build step
npm run datatest          # data invariants: 668 neurons / 18,968 edges / 23,210 points
npm run simtest           # circuit diagnostics, Swift-parity exit conditions
npm run simtest:strict    # also asserts the ranges the Swift suite only prints
npm run behaviortest      # 17 end-to-end checks: stimulate neurons -> body reacts
npm run sensetest         # what the Win32 senses see on this machine right now
npm run typecheck         # tsc --noEmit

npm start                 # the overlay plus the brain window
npm run snapshot          # offscreen fly render   -> fly.png
npm run brainshot         # offscreen brain render -> brain.png
npm run dist              # package to release/win-unpacked/
```

`--seed=N` sets the RNG seed for `simtest`, `simtest:strict` and `behaviortest`
(default 1). `snapshot` also takes `--size=WxH` and `--brain`, and `--nospikes`
for reproducible brain renders.

To check the overlay without watching the screen — useful over remote desktop or
in a non-interactive shell:

```sh
npm run build && electron dist/main.cjs --capture=overlay.png
```

That capture deliberately uses a hidden window: `capturePage()` on a *visible*
window needs a real interactive desktop surface and hangs without one. Renderer
diagnostics go to `renderer.log`, because a GUI Electron process on Windows has
no usable stdout — without that file a renderer exception is completely silent
and merely looks like a hung window.

## Packaging

```sh
npm run dist        # -> release/win-unpacked/DesktopFly.exe
```

A `--dir` build rather than an installer: an installer needs code-signing
decisions that are out of scope here.

**The data travels with the build, but not inside the .exe.** The connectome
lands in `release/win-unpacked/resources/data/` (1.0 MB), alongside a 235 MB
executable and a 28 MB `app.asar` — 405 MB in 145 files altogether. The whole
folder is the distributable unit: copying `DesktopFly.exe` alone fails with
`Invalid file descriptor to ICU data received`, because Chromium cannot start
without its sibling resources. Verified self-contained by renaming the repo's
`data/` away and confirming the packaged build still loaded all 23,210 somas and
668 circuit neurons.

**Licensing:** the code is MIT, but `data/` is **CC BY-NC 4.0** under FlyWire's
terms. Packaging copies those files into the build, so anything you distribute
carries the non-commercial restriction with it. `DATA_LICENSE.md` ships beside
them in `resources/data/`, which keeps the split intact.

## How this was verified against the macOS build

The macOS build cannot be compiled on Windows, so parity is checked against the
invariants its own suites assert, plus its committed renders:

- **Giant fiber silent across 4 s of rest** — holds at every seed tested.
- **Giant fiber fires 4 ms after an abrupt loom** — at all 8 seeds tested,
  matching the ~4 ms the root README claims. A slow *ramp* correctly loses the
  race to feedforward inhibition and produces a dart instead of a takeoff.
- **Siesta** (`activityScale` 0.84) slows the fly without silencing it.
- **Population rate ~5–7 Hz/neuron** at rest.
- All **17 `behaviortest` checks** pass — stimulate a real population, assert the
  body reacts.
- `npm run snapshot` beside `assets/fly.png`: **close match** — dark brown
  three-segment legs, brown thorax, banded abdomen with a dark tip, red eyes, one
  translucent wing folded over the abdomen. The wing reads slightly greyer and
  shorter than SceneKit's, and framing sits marginally off-centre.
- `npm run brainshot` beside `assets/brain.png`: **close match** — pale
  blue-white optic lobes, gold central brain, teal sensory fringe, cyan looming
  clusters.

Two rendering bugs were found only by comparing those images, and no test could
have caught either: `THREE.Color(r, g, b)` reads its arguments as *linear* while
the Swift source specifies sRGB (which washed the whole fly out), and point
clouds need **screen-space clamped** sizing like SceneKit's, or the 23k somas
either vanish below a pixel or saturate to solid white.

## Differences from the macOS build

- **Seeded RNG.** `LIFSim` takes a seed so the suites are reproducible; the Swift
  build uses a non-deterministic system RNG. Parity is therefore behavioural and
  statistical, never spike-for-spike.
- **No locks.** `SpikeBus` and the stimulation queue need none — a JS context is
  single-threaded, where macOS steps the sim on the SceneKit render thread.
- **`groomDrive` is clamped** to 0..1.3 like its five siblings. Behaviourally
  inert: it is only ever compared against the 0.5/0.3 hysteresis thresholds.
- **The overlay spans all displays**, and the tray menu drops the display hop.
- **Neither build lets the fly hide behind windows.** Both overlays float above
  ordinary windows; the fly walking *along* a window's top edge is the ledge
  behaviour, not occlusion.

One finding worth recording: **walk-drive duty is seed-dependent**, spanning
17–43% (mean 32%) across seeds 1–8, because the circuit's 330 partner neurons
draw random baseline drive that sets the input to DNp09. `CLAUDE.md` describes it
as "20–50%", which is a typical run rather than a bound — the Swift build has the
same spread, reshuffled every run by its system RNG. Here the 20–50% claim is
asserted as a *mean across seeds* (`dynamics.test.ts`), while the per-run gate in
`simtest --strict` is 10–60%.

## Layout

| directory | contents |
|---|---|
| `src/core/` | the sim (`sim.ts`, from `Sim.swift`), signal mapping, circadian curve, cursor→loom transduction, sim clock, arena, window-terrain rules, idle/typing, tempo, brain palettes, click picking |
| `src/body/` | procedural fly geometry and the `Fly` behaviour (from `FlyModel.swift`), plus `Coordinator`, the frame-loop hub (from `main.swift`) |
| `src/main/` | the Electron shell, tray, and `win32.ts` — the only file that touches the FFI |
| `src/renderer/` | the overlay and brain renderers: the only place a `WebGLRenderer` exists |
| `src/cli/` | the diagnostic suites |
| `assets/` | the tray icon |

The layering rule is what makes the suites possible: `core/` imports Node stdlib
only, `body/` may use Three.js scene graphs but never a renderer, and only
`main/`+`renderer/` touch Electron. That is why 146 unit tests and all 17
behaviour checks run headless, with no GPU and no screenshots.

See `docs/superpowers/specs/2026-08-19-windows-port-design.md` for the design,
and `docs/superpowers/plans/` for the milestone-by-milestone implementation
plans.
