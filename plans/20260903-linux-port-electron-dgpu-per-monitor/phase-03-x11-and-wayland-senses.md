---
phase: 3
title: "x11-and-wayland-senses"
status: completed
priority: P1
effort: "2d"
dependencies: [2]
---

# Phase 3: x11-and-wayland-senses

## Overview
Wire the X11 window-list senses (`x11.js`) and ship a no-op Wayland stub
(`wayland.js`). Feature-gated: if the helper CLIs are missing, we
degrade to "no ledges" and print a one-time warning, matching the
Windows port's behavior without `koffi`.

## Requirements
- Functional:
  - `x11.js` polls the X11 root window via `xprop -root _NET_CLIENT_LIST`
    and returns `{ledges, newWindows}` matching the Windows port's
    `WindowSense.Snapshot` shape.
  - Coordinate conversion: X11's top-left-of-primary origin → macOS-style
    bottom-left-of-screen, y-up, origin at the fly's current display.
  - First call also snapshots `_NET_NUMBER_OF_DESKTOPS` / `_NET_CURRENT_DESKTOP`
    so we don't false-alarm "new window" on the first poll.
  - `wayland.js` is a typed no-op: returns `{ledges:[], newWindows:[]}`,
    `isAvailable: false`, prints one info-level line at startup
    ("Window list unavailable on Wayland in this build; see docs/ubuntu.md
    for the planned DBus bridge").
- Non-functional:
  - No native modules. Only `node:child_process` shell-outs to
    `xprop` / `wmctrl` / `xdotool`. All are apt-installable on Ubuntu 24.04
    and ship by default on most desktop distros.
  - Poll cost: < 30 ms per call on a 50-window desktop.

## Architecture

```
os.js (Phase 2) ──> x11.js  ──> execFile('xprop',  ['-root', '_NET_CLIENT_LIST'])
                            └─> execFile('xprop',  ['-id', '<wid>', '_NET_WM_WINDOW_TYPE', ...])
                            └─> execFile('xdotool', ['getmouselocation'])
              └──> wayland.js (no-op)
```

`x11.js` mirrors `windows/src/win32.js` API:
```ts
poll(screen: {x, y, width, height}): { ledges: Ledge[], newWindows: NewWindow[] }
```

The fly's current display is `{x, y, width, height}` from Electron's
`screen.getDisplayMatching(rect)`. The conversion math lives in
`x11.js`; macOS-style origin is computed in the same step that decides
which windows are "on the fly's screen."

`Ledge` invariant (carried from the macOS port): the fly can only walk
ledges with `width > 100` and within `±(screen.height/2 - 8)` of the
display center. This keeps walking stable on multi-monitor setups where
X11 spans all displays as one root.

## Related Code Files
- Create: `linux/src/x11.js`
- Create: `linux/src/wayland.js`
- Create: `linux/test/x11.test.js` (skips if `xprop` missing)
- Modify: `linux/main.js` to wire `os.sense.poll(...)` into
  `coordinator.setTerrain(...)` (mirrors Windows port's timer cadence)
- Modify: `linux/package.json` (document `xprop`/`wmctrl`/`xdotool` as
  soft deps in the README, not in `dependencies`)

## Implementation Steps
1. `which xprop`, `which wmctrl`, `which xdotool` — note absence, fall
   back gracefully. If any are missing, set `isAvailable: false` and
   return empty arrays. The graceful-degrade pattern is identical to
   the Windows port's `koffi` check.
2. `xprop -root _NET_CLIENT_LIST` returns a space-separated list of
   X window IDs (hex). Parse them into integers. For each, fetch
   `_NET_WM_WINDOW_TYPE`, `_NET_FRAME_EXTENTS`, `WM_NAME`, `_NET_WM_STATE`.
   Filter to `_NET_WM_WINDOW_TYPE_NORMAL` (skip docks, panels, menus).
3. For each surviving window, get geometry via
   `xwininfo -id <wid> -shell` or `_NET_WM_ICON_GEOMETRY`. Skip if
   `width < 160` or `height < 60` (matches the macOS port filter).
4. Build `Ledge` with `y = primaryHeight - window.maxY - screen.midY`,
   `x0/x1` clamped to `±(screen.width/2 - 15)`. Same constants as
   `Environment.swift`.
5. Track `seenIDs` between polls; first poll records the current set
   without firing `newWindows` (avoids the cold-start flood).
6. `wayland.js` v1: literally `{poll: () => ({ledges:[], newWindows:[]}),
   isAvailable: false, tap: () => {}}`. Print once at first import.
   File a follow-up issue in `docs/ubuntu.md` §"Future work" describing
   the planned DBus foreign-toplevel bridge (a Python `wlr-foreign-toplevel`
   daemon exposed over a Unix socket that the Node side talks to).

## Success Criteria
- [ ] On an X11 host with `xprop` installed, opening 3 normal windows
      and 1 panel: poll returns 3 ledges, 0 spurious new-windows on
      the first poll, 0 new-windows on the second poll with no changes,
      and 1 new-window on the third poll when a 4th window appears.
- [ ] On a host without `xprop` (CI), `x11.js` returns
      `isAvailable: false` and does not throw. The app still starts.
- [ ] `linux/test/x11.test.js` covers all four assertions above, gated
      on `xprop` availability.
- [ ] `wayland.js` test asserts no-op behavior + the once-only log line.
- [ ] Doc note in `docs/ubuntu.md` about the Wayland no-op and the
      planned DBus bridge.

## Risk Assessment
- **Wayland v1 has no ledge support at all.** This is documented
  graceful-degrade, not a bug. The fly still walks, grooms, and decides
  to flee the cursor; it just can't walk on real window edges in
  Wayland. A regression in `sim.js` / `flymodel.js` that assumes ledges
  exist would only show up in X11; Phase 6's CI gate catches it there.
- **X11 races with window manager.** `xprop` reads can race with window
  creation/destruction. The existing Windows port lives with the same
  races (`EnumWindows` snapshot is not transactional); we do too.
- **`xdotool getmouselocation` may be missing on minimal installs.**
  `tap()` is best-effort; if `xdotool` is gone, log once and disable.
