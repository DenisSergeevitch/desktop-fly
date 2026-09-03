---
phase: 2
title: "linux-oses"
status: completed
priority: P1
effort: "0.5d"
dependencies: [1]
---

# Phase 2: linux-oses

## Overview
Introduce a single `os.js` shim that the rest of the Electron main process
imports instead of `windows/src/win32.js`. Picks X11, Wayland, or no-op
fallback at runtime, and never `require()`s `koffi` on Linux.

## Requirements
- Functional:
  - `import { sense } from './src/os.js'` returns the correct backend
    for the host: x11 on X11, wayland-stub on Wayland, no-op fallback
    if neither is detected.
  - `windows/src/win32.js` exists in the shared module graph (via the
    symlink in Phase 1) but is never imported on Linux; the `os.js`
    backend selection means koffi never loads.
- Non-functional:
  - All detection runs in <50 ms at startup.
  - No native modules are loaded on Linux; `npm install` works on a
    stock Ubuntu 24.04 with no compiler toolchain.

## Architecture
```js
// linux/src/os.js
import { execFile } from 'node:child_process';
import { platform } from 'node:process';

let backend;
if (platform !== 'linux') {
  // never reached; linux/main.js is the only caller on this tree
  throw new Error('os.js is linux-only');
} else if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
  // Wayland path: stub for v1, real DBus bridge later
  const m = await import('./wayland.js');
  backend = m.default;
} else if (process.env.DISPLAY) {
  const m = await import('./x11.js');
  backend = m.default;
} else {
  // Headless / no display server; let the test suites still pass
  backend = { poll: () => ({ ledges: [], newWindows: [] }), tap: () => {} };
}

export const sense = backend;
```

`x11.js` and `wayland.js` each export the same shape:
```ts
interface Backend {
  poll(): { ledges: Ledge[]; newWindows: NewWindow[] };
  tap(x: number, y: number): void;
  isAvailable: boolean;
}
```

`Ledge` and `NewWindow` are pure-data shapes — no native handles cross
the boundary. `x11.js` shells out to `xprop` / `wmctrl`; `wayland.js` v1
returns empty arrays and logs once at startup.

## Related Code Files
- Create: `linux/src/os.js`
- Create: `linux/src/x11.js` (Phase 3 fills the body)
- Create: `linux/src/wayland.js` (Phase 3 fills the body)
- Create: `linux/src/sense-types.d.ts` (shared interface, used by both backends)
- Modify: `linux/main.js` (import path change from `win32.js` to `os.js`)

## Implementation Steps
1. Define `sense-types.d.ts` with the `Ledge` and `NewWindow` shapes that
   match the Windows port (`Ledge: { y, x0, x1, id }`).
2. Write `os.js` with the platform/session-type detection above.
3. Stub `x11.js` and `wayland.js` with `poll: () => ({ledges:[], newWindows:[]})`
   and `isAvailable: false`. Phase 3 fills in the X11 body.
4. Confirm `linux/main.js` does not `require('koffi')` directly —
   it goes through `os.js`. This is a forward guard; Phase 4 writes
   `main.js` with this in mind.
5. Add a quick unit test: `linux/test/os.test.js` asserts that on
   X11+`DISPLAY` it picks x11.js, on Wayland it picks wayland.js, on
   neither it picks no-op.

## Success Criteria
- [ ] `linux/src/os.js` correctly selects backend on a Wayland session,
      an X11 session, and a headless env.
- [ ] `koffi` is **not** in the Linux require graph (verified with
      `node --trace-warnings -e "import('./src/os.js')"` — no `koffi`
      entries in the output on Linux).
- [ ] `linux/test/os.test.js` passes.
- [ ] `linux/main.js` builds and starts in headless mode (`xvfb-run
      node -e "import('./main.js')"` without a crash).

## Risk Assessment
- **Session-type detection timing.** `process.env.WAYLAND_DISPLAY` and
  `XDG_SESSION_TYPE` are set by the DE login, not the Electron process.
  If a user runs `npm start` over SSH with no forwarded display, both
  are absent — we fall into the headless branch, the tray tries to
  create, Electron exits. Mitigation: the headless backend returns
  empty `poll()`, the sim still runs in tests.
- **XWayland confusion.** A Wayland session with `DISPLAY=:0` (XWayland)
  will be picked as X11. The window list from `xprop` will only show
  XWayland-aware X clients; native Wayland windows are invisible to it.
  This is the same blind spot the user already accepts on X11 from
  inside Wayland; document it in `docs/ubuntu.md`.
