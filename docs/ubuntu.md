# DesktopFly on Ubuntu 24.04

A Linux variant of [DesktopFly](../) — the same 3D fruit fly on a
transparent desktop overlay, driven by the same 1 kHz leaky-integrate-and-fire
simulation of 668 real neurons from the FlyWire connectome (FAFB v783).

The brain is shared with the macOS and Windows ports; the rendering and OS
layers are an Electron + three.js port that talks to the local NVIDIA dGPU
through ANGLE on EGL.

## System packages

```sh
sudo apt-get update
sudo apt-get install -y \
  nodejs npm \
  xvfb x11-utils xdotool wmctrl \
  nvidia-driver-580 libegl1 libgl1 libvulkan1
```

Versions: Node 22+ (Node 24 LTS tested), NVIDIA driver 580+ (anything that
exposes the RTX 5090 via `nvidia_icd.json`).

`xprop` is in `x11-utils`, `wmctrl` provides `_NET_CLIENT_LIST` for the ledge
sensor on X11, and `xdotool` is used for the global-tap fallback.

## Verify the GPU

```sh
nvidia-smi -L                                # should list at least one dGPU
ls /usr/share/vulkan/icd.d/nvidia_icd.json  # must exist
```

If `nvidia_icd.json` is missing, install the matching driver and
`nvidia-vulkan-icd` (or the equivalent for your distro).

## Install

```sh
git clone https://github.com/DenisSergeevitch/desktop-fly.git
cd desktop-fly/linux
npm install
```

The shared sim and body code is symlinked from `../windows/src/...` — you
should see them as symlinks in `linux/src/`:

```sh
ls -l src/    # sim.js -> ../../windows/src/sim.js, etc.
```

## Run

```sh
npm start
```

A 🪰 item appears in the system tray; the overlay opens on the primary
display. Click **Send Fly to Next Display** to hop the fly across monitors.

## Test

```sh
npm test
```

Both suites (`simtest`, `behaviortest`) run on bare Node, with three.js
operating headless. The `xvfb` wrapper is only needed if a host renderer
init requires a window object — the suites are self-contained.

## Snapshot (dGPU)

```sh
npm run snapshot -- /tmp/fly.png         # 720x720 body render
npm run brainshot -- /tmp/brain.png      # 720x560 brain render
```

Both paths use Electron's headless `BrowserWindow` with `offscreen: true` and
write a PNG via `webContents.capturePage()`. Verify the renderer really hit
the dGPU while the snapshot runs:

```sh
nvidia-smi pmon -c 5 -d 0 | grep electron
```

The MiB column should be > 0 for the electron process during the render.

## Wayland v1 (no ledges)

Wayland deliberately withholds foreign-toplevel information from clients
without a DBus bridge. In v1 the `wayland.js` sense is a typed no-op: the
fly still walks, grooms, and flees the cursor, but it cannot walk on real
window edges.

### Future work: DBus foreign-toplevel bridge

The intended v2 path is a small DBus daemon (e.g. a Python wrapper around
`wlr-foreign-toplevel-management-v1`) exposed over a Unix socket that
`wayland.js` reads. Tracked in this doc for the next iteration; out of
scope for v1 per `plans/20260903-linux-port-electron-dgpu-per-monitor/plan.md`.

## Multi-monitor

The overlay is per-monitor (macOS-style): one `BrowserWindow` per display,
the active display is visible, the rest are hidden to save GPU memory.
"Send Fly to Next Display" in the tray menu rotates the active display and
re-anchors the camera.

X11 + xrandr work out of the box. Wayland on Mutter (GNOME 46+), KWin (KDE
Plasma 6), and wlroots compositors report logical outputs through the
`UseOzonePlatform` feature flag.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Tray icon 🪰 does not appear | `echo $XDG_CURRENT_DESKTOP`; on headless hosts the tray is hidden |
| Black overlay on X11 | `export ELECTRON_OZONE_PLATFORM_HINT=x11`; the default on X11 is native X, not XWayland |
| Black overlay on Wayland | `export ELECTRON_OZONE_PLATFORM_HINT=wayland`; ensure `nvidia_icd.json` is installed |
| `Cannot find module 'koffi'` | koffi is Windows-only; linux/ does not depend on it. If you see this, an old `package.json` leaked. Re-run `npm install`. |
| `xprop` not found | `apt install x11-utils`; the app still runs, just without window ledges |
| Fly flickers / GPU error | `nvidia-smi` to check the driver; on Optimus laptops, force NVIDIA via `prime-run npm start` |
| Tests fail with `EACCES: /dev/dri` | run under `xvfb-run -a npm test` (no real GPU needed) |
