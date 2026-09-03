---
phase: 5
title: "dGPU-rendering-and-snapshots"
status: completed
priority: P2
effort: "1.5d"
dependencies: [4]
---

# Phase 5: dGPU-rendering-and-snapshots

## Overview
Force the dGPU on the renderer process, verify it via `nvidia-smi`, and
ship an offscreen `--snapshot` / `--brainshot` path that uses the
local GPU through Electron's headless mode (not `xvfb-run`).

## Requirements
- Functional:
  - `npm run snapshot -- out.png [--top] [--flying] [--beetle]`
    produces a PNG of the fly body using the real dGPU.
  - `npm run brainshot -- out.png` produces a PNG of the brain window
    using the real dGPU.
  - The renderer's GPU device is the NVIDIA dGPU, not SwiftShader or
    llvmpipe.
- Non-functional:
  - Snapshot latency < 5 s on the host RTX 5090.
  - No `xvfb-run` dependency. Electron 32 supports `--headless` and
    `--enable-gpu` simultaneously; the snapshot path uses Electron's
    offscreen rendering (`BrowserWindow.capturePage()` with
    `webPreferences.offscreen: true`).

## Architecture
```
npm run snapshot ──> electron . --headless --snapshot=out.png
                   │
                   ├──> main.js dispatches into runSnapshot()
                   │      (reuses windows/main.js pattern)
                   ├──> renderer paints one frame into a 720x720
                   │    offscreen BrowserWindow
                   └──> capturePage() → PNG

npm run brainshot ──> electron . --headless --brainshot=out.png
                   │
                   ├──> main.js dispatches into runBrainshot()
                   ├──> loads data/brain_points.json + circuit.json
                   ├──> brain renderer paints 40 fake spikes + 1 GF
                   └──> capturePage() → PNG
```

The dGPU is selected by:
- `app.commandLine.appendSwitch('use-gl', 'egl')` so Electron uses
  EGL, which on Linux picks the NVIDIA ICD directly via
  `/usr/share/vulkan/icd.d/nvidia_icd.json`.
- `app.commandLine.appendSwitch('enable-gpu', '1')` is the default
  in Electron 32; just don't disable it.
- `app.commandLine.appendSwitch('disable-gpu', '0')` belt-and-braces.
- A `--no-sandbox` flag is **not** added; Electron 32 on Linux runs
  unprivileged fine on Wayland with the right `OZONE_PLATFORM_HINT`.

Verification command:
```
nvidia-smi pmon -c 5 -d 0 | grep electron
```
Should show `MiB` column > 0 for the renderer process during a
snapshot.

## Related Code Files
- Create: `linux/main.js` snapshot/brainshot dispatch (Phase 4 lays
  the foundation; Phase 5 adds the CLI flags)
- Create: `linux/snapshot.js` (off-screen scene graph builder;
  mirrors `main.swift runSnapshot()`)
- Modify: `linux/package.json` (add `snapshot` and `brainshot` scripts)
- Modify: `docs/ubuntu.md` (add the `nvidia-smi` verification recipe)

## Implementation Steps
1. Add to `linux/main.js` an early CLI dispatch that handles
   `--snapshot=path` and `--brainshot=path` before `app.whenReady()`.
2. The snapshot path opens a hidden offscreen `BrowserWindow`
   (`show: false, paintWhenInitiallyHidden: true,
   webPreferences: { offscreen: true, contextIsolation: true }`).
3. After `did-finish-load`, `webContents.executeJavaScript('window.__snapshot(opts)')`
   triggers the renderer to call its `runSnapshot()` (mirrors
   `windows/renderer/overlay.js` `__snapshot`).
4. `win.webContents.on('paint', ...)` waits one paint, then
   `win.webContents.capturePage()` → PNG via `nativeImage.toPNG()`.
5. Same for `--brainshot`. The brain renderer accepts a query
   parameter that forces a fixed-pose snapshot.
6. Add `process.on('SIGINT')` handler that exits cleanly so the script
   doesn't hang after writing the PNG.
7. Add `linux/test/snapshot.test.js` that runs
   `npm run snapshot /tmp/test.png` and asserts the file exists and is
   a non-zero PNG. Marked as optional in CI (only runs on a host
   with a real GPU).

## Success Criteria
- [ ] `npm run snapshot -- /tmp/out.png` writes a 720×720 PNG; the
      renderer process is reported by `nvidia-smi pmon` with MiB > 0
      during the run.
- [ ] `npm run brainshot -- /tmp/brain.png` writes a 720×560 PNG.
- [ ] Both scripts exit cleanly (`echo $?` is 0).
- [ ] `linux/test/snapshot.test.js` is wired into `npm test` as an
      opt-in step (gated on `process.env.RUN_SNAPSHOT_TESTS`).

## Risk Assessment
- **`--headless` + ANGLE on a headless server.** Some headless servers
  have no `/dev/dri` nodes; ANGLE falls back to SwiftShader. The
  snapshot still works, just slower. Detect via
  `app.getGPUInfo('complete')` and log the renderer string in a
  one-line startup banner; the user can confirm "ANGLE (NVIDIA)"
  vs "ANGLE (SwiftShader)".
- **`BrowserWindow` paint vs capture race.** `capturePage()` after
  the first `paint` event is reliable in Electron 32; the recipe in
  the Electron docs is the one we follow.
- **Vulkan vs OpenGL.** Electron on Linux defaults to OpenGL; ANGLE
  translates to Vulkan. If the user has only `swrast` Mesa, ANGLE
  falls back. Document the required `nvidia-driver-580` and
  `libegl1` packages in `docs/ubuntu.md`.
