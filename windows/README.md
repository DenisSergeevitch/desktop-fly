# DesktopFly for Windows

The Windows port of DesktopFly: the same 3D fruit fly on a transparent
desktop overlay, driven by the same 1 kHz leaky-integrate-and-fire simulation
of 668 real neurons from the FlyWire connectome (FAFB v783).

The brain is a line-by-line port of `Sim.swift`; the body and behavior are a
line-by-line port of `FlyModel.swift`. Both test suites came across with them
and are the ground truth here just as they are on macOS.

## Why a port and not a rebuild

macOS DesktopFly links `Cocoa` and `SceneKit`, neither of which exists on
Windows — the open-source Swift toolchain ships only stdlib, Foundation,
Dispatch and WinSDK. Everything that draws or touches the system had to be
rewritten; everything that computes came over unchanged in behavior.

| macOS | Windows |
|---|---|
| SceneKit | three.js (WebGL) |
| AppKit `NSPanel`, borderless + `ignoresMouseEvents` | Electron `BrowserWindow`, `transparent` + `setIgnoreMouseEvents` |
| `NSStatusItem` menu bar | `Tray` |
| `CGWindowListCopyWindowInfo` | `EnumWindows` + `DwmGetWindowAttribute` via koffi |
| `NSEvent` global mouse monitor | `GetAsyncKeyState(VK_LBUTTON/VK_RBUTTON)` |
| `CGEventSource` idle | `powerMonitor.getSystemIdleTime()` |
| `ProcessInfo.thermalState` | CPU load (no Windows equivalent without vendor drivers) |
| one `NSScreen`, hop via menu | one overlay across the whole virtual desktop |

## Run

```sh
npm install
npm start              # tray icon; quit from there
npm run simtest        # circuit invariants (MUST pass after sim changes)
npm run behaviortest   # 18 end-to-end sim -> body checks
npm test               # both
```

`DESKTOPFLY_DEBUG=1 npm start` logs window terrain, overlay geometry and
renderer console output to stderr.

The suites run on bare Node — three.js builds the fly's scene graph headlessly,
so behavior is testable without a GPU.

## What the fly senses

Everything is poll-only and needs no permission dialog. As on macOS, the fly
learns *when* things happen, never *what*:

- **Cursor** — position and velocity become a looming stimulus, split between
  the two eyes by bearing, fed to 314 LC4/LPLC2 neurons. A lunge drives the
  DNp01 giant fiber and the fly takes off ~4 ms later. Fast motion nearby is
  an air puff on the sensory pathway.
- **Clicks** — a global mouse-button press is a tap on the fly's substrate,
  stimulating sensory neurons with a strength that falls off with distance.
- **Windows** — top edges of real windows are walkable ledges; a window
  appearing near the fly is a looming object. Only geometry is read: the
  pixels underneath the fly are never sampled.
- **Typing** — the system idle timer says an input device was touched; if the
  cursor did not move and no button went down, that was the keyboard. No key
  is ever polled individually.
- **Clock and CPU load** — circadian activity curve and an ectotherm's tempo.

## Multi-monitor

The overlay spans the union of all displays, so walking and flying between
monitors is ordinary movement rather than a mode switch. Displays are passed
into the scene as rects, so the fly never targets the dead corners of a
non-rectangular layout. "Send Fly to Next Display" in the tray menu nudges it
across on demand.

Windows clamps a fixed-size window to one monitor's work area, which would
leave the scene believing it is wider than the window really is — the fly then
walks into coordinates that are not on screen and appears to vanish. The
overlay therefore stays resizable and the scene is always told the window's
*actual* bounds.

## Known limits

- Windows does not composite overlays above **exclusive**-fullscreen apps; the
  fly is hidden there. Borderless fullscreen is fine.
- `koffi` provides the Win32 calls. Without it the fly still runs, but loses
  window ledges and click taps (a warning is printed on startup).

## Layout

| file | contents |
|---|---|
| `main.js` | Electron main: overlay + brain windows, tray, environment senses |
| `preload.mjs` | the only main↔renderer bridge |
| `renderer/overlay.js` | `buildScene` + `Coordinator` from `main.swift` |
| `renderer/brain.js` | port of `BrainView.swift` |
| `src/sim.js` | port of `Sim.swift` (`LIFSim`, `SpikeBus`, `BrainSignals`) |
| `src/flymodel.js` | port of `FlyModel.swift` (body geometry + behavior) |
| `src/signals.js` | port of `SignalBuilder` |
| `src/win32.js` | user32/dwmapi through koffi |
| `src/environment.js` | circadian curve, CPU-load tempo |
| `src/data.js` | Node-only JSON loading (kept out of `sim.js` for the renderer) |
| `test/` | ports of `--simtest` and `--behaviortest` |

Data comes from `../data/` — the same shipped `brain_points.json` and
`circuit.json`, under the same CC BY-NC 4.0 terms.
