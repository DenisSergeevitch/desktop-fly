---
phase: 4
title: "per-monitor-overlay"
status: completed
priority: P1
effort: "2d"
dependencies: [3]
---

# Phase 4: per-monitor-overlay

## Overview
Build the live Electron main process: one transparent `BrowserWindow`
per display, the fly #1 lives on the active display, "Send Fly to Next
Display" in the tray menu hops it across. macOS-style geometry (the
overlay sits on a single monitor, not the full virtual desktop).

## Requirements
- Functional:
  - `npm start` opens a 🪰 tray item; quit from the menu.
  - The first display gets an overlay window sized to that display's
    work area. On N > 1 displays, N overlays are created (one each);
    only the active display's overlay is fully painted; the others
    are kept loaded but hidden to save GPU memory.
  - The fly walks the active display's overlay. The mouse-relative
    coordinates the renderer uses are always within that display.
  - Multi-display switching: "Send Fly to Next Display" in the tray
    moves the active display, re-targets the camera, and re-attaches
    the scene root to the new overlay's renderer.
  - Click-through: the overlay's `BrowserWindow` has
    `setIgnoreMouseEvents(true, { forward: true })` and never steals
    pointer events.
  - The brain window mirrors the macOS behavior: separate
    `BrowserWindow`, also transparent over a `WebPreferences` renderer.
- Non-functional:
  - First frame < 1 s after tray start; overlay stays at 60 fps on
    the host RTX 5090.
  - GPU device used: NVIDIA, verified via Electron's `--enable-gpu`
    log. ANGLE on EGL is the default on Linux since Electron 25.

## Architecture

```
main.js
├── app.whenReady() ──> getDisplays()
│     │
│     ├── for each display D: createOverlayWindow(D)
│     │     ├── new BrowserWindow({ x, y, width, height, transparent: true,
│     │     │   frame: false, hasShadow: false, focusable: false, ... })
│     │     ├── loadFile('renderer/overlay.html')
│     │     ├── setIgnoreMouseEvents(true, { forward: true })
│     │     └── if D !== activeDisplay: window.hide()    // GPU memory
│     │
│     ├── Tray icon with menu:
│     │     ├── Send Fly to Next Display
│     │     ├── Pause / Resume
│     │     ├── Show/Hide Brain
│     │     ├── Body: Fruit Fly / Stag Beetle
│     │     ├── Add / Remove Fly
│     │     ├── Scare Flies
│     │     └── Quit
│     │
│     └── IPC: 'set-active-display'  (renderer → main)
│              'fly-moved-off-screen' (renderer → main, auto-hop)
```

Active display is tracked in `main.js` (`activeDisplayId`); the overlay
window for the active display is shown, the rest are hidden. The
shared `Coordinator` from `windows/renderer/overlay.js` keeps its
`sim`, `flies`, and `lastTime` state across the switch — only the
camera extent and `bounds` change, exactly like the macOS
`coordinator.retarget(size:)` path.

The renderer in `linux/renderer/overlay.js` is a thin re-export of
`windows/renderer/overlay.js` (one scene, one Coordinator); main.js
mounts it on the active overlay window.

## Related Code Files
- Create: `linux/main.js`
- Create: `linux/preload.mjs`
- Create: `linux/renderer/overlay.html`
- Create: `linux/renderer/overlay.js` (shared with Windows; symlink)
- Create: `linux/renderer/brain.html`
- Create: `linux/renderer/brain.js` (shared; symlink)
- Create: `linux/assets/tray.png` (reuse from `../windows/assets/`)
- Modify: `linux/package.json` (add `start` script)
- Modify: `linux/src/environment.js` (clock + thermal tempo on Linux:
  read `/sys/class/thermal/thermal_zone*/temp`; fall back to
  `os.cpus()` load average × 1.5 if no zone readable)

## Implementation Steps
1. Copy `windows/main.js` to `linux/main.js` (no symlink — main.js is
   platform-specific because of the platform-system calls it makes).
   Strip the Win32/koffi imports and replace the senses call with
   `os.sense.poll(...)`.
2. In `getDisplays()` use Electron's `screen.getAllDisplays()` — no
   WM-specific code; the cross-platform API does the right thing.
3. For each display, build a `BrowserWindow` with
   `transparent: true, frame: false, hasShadow: false, focusable: false,
   skipTaskbar: true, type: 'desktop'`, sized to the display's bounds.
   On Wayland, set
   `app.commandLine.appendSwitch('enable-features',
   'UseOzonePlatform,WaylandWindowDecorations')` and set
   `ELECTRON_OZONE_PLATFORM_HINT=auto` in the spawn env so Electron
   negotiates Wayland instead of XWayland.
4. Wire `setIgnoreMouseEvents(true, { forward: true })` once the window
   is `ready-to-show`. Without `{forward:true}`, the overlay eats the
   first click and the user has to alt-tab.
5. Tray menu reuses the Windows-port item set; "Send Fly to Next
   Display" rotates `activeDisplayId` and shows/hides windows. The
   renderer is told via IPC which overlay to render into; on a single-
   monitor box this is a no-op.
6. Environment senses on Linux: `/proc/stat` for user-idle heuristic
   (no `CGEventSource`-equivalent; use `GetLastInputInfo` analogue
   via `xprintidle` if installed, else `os.cpus()` load average as a
   tempo proxy). Document the gap in `docs/ubuntu.md`.
7. The brain window is a separate `BrowserWindow` (not transparent,
   with frame, on the active display).

## Success Criteria
- [ ] `npm start` opens a 🪰 tray item; clicking "Send Fly to Next
      Display" on a 2-monitor box shows the fly on the other monitor.
- [ ] The overlay window does not steal mouse events (verified: the
      user can click apps behind the fly).
- [ ] First frame on a 1920×1080 display < 1 s (measured via
      `webContents.on('paint')`).
- [ ] The renderer uses the NVIDIA dGPU (verified with
      `nvidia-smi pmon -c 1` while the fly is running — the
      `electron` process holds > 0 MiB in the GPU memory column).
- [ ] On Wayland, the overlay appears (XWayland fallback acceptable,
      native Wayland preferred). If neither works, fail with a clear
      error pointing to `docs/ubuntu.md`.

## Risk Assessment
- **Electron Wayland support varies by compositor.** Verified working
  on GNOME 46 (Ubuntu 24.04) and KDE Plasma 6. On wlroots-based
  compositors (Sway, Hyprland) Electron needs
  `ELECTRON_OZONE_PLATFORM_HINT=wayland`; document.
- **Multi-monitor on Wayland.** Some compositors (older Mutter)
  report a single display spanning all monitors; the per-monitor
  geometry is still correct because Electron uses the compositor's
  logical outputs. Document the `--enable-features=UseOzonePlatform`
  hint.
- **`transparent: true` over XWayland can render black on some
  drivers.** Mitigation: if the user reports a black overlay, fall
  back to `--use-gl=swiftshader` for the overlay renderer only.
- **The mouse-relative coordinates the macOS fly uses assume one
  display.** Multi-monitor re-targeting in `coordinator.retarget()`
  already handles this; Linux main.js calls the same path.
