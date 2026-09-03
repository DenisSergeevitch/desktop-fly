# Linux port (Electron + dGPU, per-monitor)

## Phases

| # | Phase | Status | Priority | Effort | Notes |
|---|---|---|---|---|---|
| 1 | [scaffold-linux-tree](phase-01-scaffold-linux-tree.md) | completed | P1 | 1d | fork or symlink `windows/`; keep `sim.js`/`flymodel.js` single-source |
| 2 | [linux-oses](phase-02-linux-oses.md) | completed | P1 | 0.5d | feature-gate `x11`/`wayland`/`win32` senses; pick one at runtime |
| 3 | [x11-and-wayland-senses](phase-03-x11-and-wayland-senses.md) | completed | P1 | 2d | `_NET_CLIENT_LIST` (shell-out) + Wayland no-op stub with DBus path stub |
| 4 | [per-monitor-overlay](phase-04-per-monitor-overlay.md) | completed | P1 | 2d | one Electron `BrowserWindow` per display, transparent + click-through |
| 5 | [dgpu-rendering-and-snapshots](phase-05-dgpu-rendering-and-snapshots.md) | completed | P2 | 1.5d | ANGLE→NVIDIA via EGL; `--snapshot` headless via `webglrenderer.domElement.toDataURL()` |
| 6 | [ci-and-docs](phase-06-ci-and-docs.md) | completed | P2 | 1d | `xvfb-run` test gate; `docs/ubuntu.md` install; CLAUDE.md cross-platform rule |

## Goal

Ship a Linux variant of DesktopFly using the existing Electron+three.js port
in `windows/` as the single rendering and simulation codebase. Render the
overlay on the local dGPU (NVIDIA RTX 5090 here) via ANGLE. One transparent
overlay window per display, macOS-style (the fly stays on the current display;
menu action hops it to the next). Window-terrain and tap senses work on X11
through `_NET_CLIENT_LIST` and are a documented no-op on Wayland (until a
DBus foreign-toplevel bridge lands — out of scope here).

## Scope (HOLD — user already picked options)

User-confirmed options (from prior turn):
- **GPU usage:** render the overlay through the dGPU only. No WebGPU compute for
  the LIF sim.
- **Tree:** new `linux/` directory that re-uses `windows/src/{sim,flymodel,...}.js`
  and the suites. Decide on Phase 1 whether to symlink or copy.
- **Overlay geometry:** per-monitor (macOS-style), one `BrowserWindow` per
  display, the fly stays inside the active display, menu action "Send Fly to
  Next Display" hops it across.
- **Display servers:** both X11 and Wayland must run, with graceful degrade.
  Window-list quality differs (full on X11, none on Wayland v1).

## Non-goals (out of scope for v1)

- WebGPU compute for the LIF sim. 668 neurons × 1 kHz is trivially CPU-bound;
  the dGPU only renders.
- Fullscreen overlay (Windows-style) — explicitly not in scope.
- Wayland foreign-toplevel management via DBus — stub the interface, no real
  bridge in v1. Issue left open in `docs/ubuntu.md` for the next iteration.
- Touching the macOS Swift sources.
- Drift between `linux/` and `windows/`: the two trees share `sim.js` and
  `flymodel.js` (see Phase 1). MacOS-side `Sim.swift` / `FlyModel.swift` drift
  remains the existing problem; we do not solve it here.

## Architecture

```
linux/                                  ← new tree (this plan)
├── package.json        (name: desktop-fly-linux)
├── main.js             (Electron main: tray, displays, IPC)
├── preload.mjs
├── renderer/
│   ├── overlay.js      (three.js scene per display)
│   └── brain.js
├── src/
│   ├── sim.js          ← single source (symlink or vendored copy of windows/src/sim.js)
│   ├── flymodel.js     ← single source
│   ├── signals.js      ← single source
│   ├── data.js         ← single source
│   ├── util.js         ← single source
│   ├── os.js           (NEW: pick x11|wayland|fallback)
│   ├── x11.js          (NEW: _NET_CLIENT_LIST via xprop/wmctrl)
│   ├── wayland.js      (NEW: stub; future DBus bridge)
│   ├── environment.js  ← single source
│   └── win32.js        (kept; dead code on linux, never loaded)
└── test/
    ├── simtest.js      ← single source
    └── behaviortest.js ← single source
```

`os.js` exports `getWindows()` and `globalClick()`. On Linux it returns
`{ledges, newWindows}` (X11) or `{ledges:[], newWindows:[]}` (Wayland v1)
and translates `globalClick` to a `WM_TAKE_FOCUS`-less shell-out to
`xdotool getactivewindow` (X11) or a no-op (Wayland). The X11/win32 modules
are *feature-gated* by a `process.platform` check in `os.js`, so on Linux
`win32.js` is not loaded and `koffi` is never imported.

## Cross-tree single-source rule (replaces CLAUDE.md single-platform rule)

CLAUDE.md today says: "any change to the sim or to behavior must be mirrored
[in `windows/`] and both JS suites re-run, otherwise the two platforms drift
apart silently." With a third tree, that rule becomes unmaintainable
(copy-paste between `windows/` and `linux/` is a real risk). Phase 1
implements one of two options and updates CLAUDE.md:

- **A (recommended):** `linux/src/{sim,flymodel,signals,data,util,environment}.js`
  and `linux/test/{simtest,behaviortest}.js` are **symlinks** into
  `../windows/src/` and `../windows/test/`. The two trees share one source
  for sim + body + tests. macOS-Swift drift remains the existing problem
  between the .swift files and `windows/src/`.
- **B (fallback if symlinks misbehave on Windows checkouts):** vendor copies,
  with a `scripts/sync-from-windows.sh` and a pre-commit hook that fails if
  drift > N bytes.

Both options keep the suites running once. Phase 1 acceptance picks the
option and updates CLAUDE.md.

## Red Team Review

### Session — 2026-09-03 (pre-write, inlined above)
**Findings:** 7 (6 accepted, 1 noted)
**Severity breakdown:** 0 Critical, 3 High, 3 Medium, 1 Low

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | CLAUDE.md single-platform mirror rule breaks with a third tree | High | Accept | Phase 1 + plan §Cross-tree rule |
| 2 | `koffi` loaded eagerly on Linux would break `npm install` if no build tools | High | Accept | Phase 2 (lazy-load) |
| 3 | Wayland foreign-toplevel requires DBus daemon, not Node-API | High | Accept | Phase 3 (no-op stub + issue) |
| 4 | YAGNI: per-monitor + X11+Wayland = 4 branches; fullscreen is creep | Medium | Accept | plan §Non-goals |
| 5 | Electron transparent overlay on Wayland needs ozone hints | Medium | Accept | Phase 4 |
| 6 | `--snapshot` already trivial in three.js via `toDataURL()` | Medium | Accept | Phase 5 (drop xvfb) |
| 7 | Multi-user X11: overlay must respect `$DISPLAY` | Low | Note | Phase 4 |

## Risks

- **Electron Wayland support** is stable from Electron 25+; pinning to ^32 (matching
  `windows/`) is enough. Fallback: launch with `ELECTRON_OZONE_PLATFORM_HINT=x11`
  to force XWayland.
- **koffi** ships prebuilt `napi-v3` binaries for `linux-x64`; no rebuild needed,
  but never `require()` it on Linux to keep `npm install` ABI-agnostic.
- **gnome-shell** is already using 76 MiB on the dGPU here; the fly's overlay
  adds <30 MiB. No concern unless a future WebGPU compute path lands.
- **Cloning `windows/` sim/body** risks drift. Symlink option eliminates it.

## Open questions

1. Does the user want to vendor (option B) or symlink (option A) the shared
   sim/body modules? Default A unless checkouts span filesystems without
   symlink support.
2. Should the `docs/ubuntu.md` document both `apt` and `pacman` paths, or
   only the Ubuntu path the host runs? (User's host is Ubuntu 24.04.)
3. Tray icon asset: reuse `windows/assets/*.png` or new Linux one?
   Resolved: reuse Windows asset to keep tree small; the 🪰 is the 🪰.
