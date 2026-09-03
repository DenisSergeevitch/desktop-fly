---
phase: 1
title: "scaffold-linux-tree"
status: completed
priority: P1
effort: "1d"
dependencies: []
---

# Phase 1: scaffold-linux-tree

## Overview
Create the `linux/` tree, decide single-source strategy for shared
modules, and update `CLAUDE.md` so the project's "mirror changes or
drift" rule has a real answer for a third platform.

## Requirements
- Functional:
  - `cd linux && npm install && npm test` runs both suites against
    `../data/`.
  - `linux/` reuses `windows/src/{sim,flymodel,signals,data,util,environment}.js`
    and `windows/test/{simtest,behaviortest}.js` without copy-paste.
  - `CLAUDE.md` describes the new rule and links to this plan.
- Non-functional:
  - No new dependencies beyond what `windows/` already pulls.
  - CI gate (`npm test`) works on a clean Ubuntu 24.04 LTS box.

## Architecture
```
linux/                       ← new tree, mostly a thin shell over windows/
├── package.json             (copy of windows/package.json with name/description edited)
├── main.js                  (Electron main; multi-display per-monitor; tray) — NOT shared
├── preload.mjs              (symlink: ../windows/preload.mjs)
├── assets/                  (symlink to ../windows/assets)
├── renderer/
│   ├── overlay.js           (single three.js scene shared across N BrowserWindows)
│   └── brain.js             (symlink or copy of windows/renderer/brain.js)
├── src/
│   ├── os.js                (NEW; pick x11|wayland|fallback)
│   ├── x11.js               (NEW; xprop/wmctrl shell-out)
│   ├── wayland.js           (NEW; no-op stub)
│   ├── sim.js               ← SHARED (see "Single-source" below)
│   ├── flymodel.js          ← SHARED
│   ├── signals.js           ← SHARED
│   ├── data.js              ← SHARED
│   ├── util.js              ← SHARED
│   ├── environment.js       ← SHARED
│   └── win32.js             (kept; never required on linux)
└── test/
    ├── simtest.js           ← SHARED
    └── behaviortest.js      ← SHARED
```

**Single-source rule.** `linux/src/{sim,flymodel,signals,data,util,environment}.js`
and `linux/test/{simtest,behaviortest}.js` are **git-tracked symlinks** into
`../windows/...`. If symlinks break the CI checkout (e.g. Windows developers
or zip-without-symlinks), fall back to vendor copies and add
`scripts/sync-from-windows.sh` + a pre-commit `git diff --stat` check.

## Related Code Files
- Create: `linux/` (entire tree)
- Create: `linux/src/{os,x11,wayland}.js`
- Create: `scripts/sync-from-windows.sh` (only if option B chosen)
- Modify: `CLAUDE.md` (replace the `windows/`-only mirror rule)
- Modify: `.gitignore` (allow `linux/` symlinks)

## Implementation Steps
1. `mkdir -p linux/{src,renderer,test,assets}` and `cd linux`.
2. `git init` is not needed — the existing repo at `/tmp/desktop-fly` covers
   it. `linux/` becomes a sub-tree of the same repo.
3. Symlink shared files: from `linux/src/`,
   `ln -s ../../windows/src/sim.js .` (and the other 5).
   Same for `test/`. Same for `assets/` → `../../windows/assets`.
4. `cp windows/package.json linux/package.json`, then edit:
   - `name`: `desktop-fly-linux`
   - `description`: `DesktopFly for Linux — a 3D fly on your desktop, driven by the real FlyWire connectome`
   - keep `type: "module"`, the same `dependencies` (three, koffi), and
     the same `devDependencies` (electron).
5. Add `scripts/lint-mirror.sh` that runs `git diff --stat
   linux/src/sim.js windows/src/sim.js` and fails if non-empty. The
   pre-commit hook invokes it. (Optional; only matters if we ever fall
   back from symlinks to vendor copies.)
6. Update `CLAUDE.md` §"Windows port" to become "Cross-platform Electron
   port (Windows + Linux)" and add a one-paragraph note that
   `linux/src/{sim,flymodel,signals,data,util,environment}.js` and
   `linux/test/{simtest,behaviortest}.js` are shared with `windows/`
   (symlinks) so sim/behavior changes touch **one** file, not two.
7. Add the new rule: "any change to `sim.js` or `flymodel.js` requires
   `cd windows && npm test` AND `cd linux && npm test` both green; the
   shared files are the test gate, the rest is per-platform."

## Success Criteria
- [ ] `cd linux && npm install` completes without errors on Ubuntu 24.04.
- [ ] `cd linux && npm run simtest` passes.
- [ ] `cd linux && npm run behaviortest` passes.
- [ ] `cd windows && npm test` still passes (no regression in shared files).
- [ ] `git ls-files linux/src/sim.js` shows the symlink (mode 120000).
- [ ] `CLAUDE.md` updated; the new rule is in the Cross-Platform section.

## Risk Assessment
- **Symlinks in git on Windows checkouts.** Risk: `git clone` of a tree
  with symlinks on Windows without admin can break. Mitigation: vendor
  copies + sync script as documented fallback (option B).
- **Drift between symlink target and the project that "owns" it.** If
  Windows code is updated, Linux tree follows the symlink. No code drift
  is possible by construction. CI gate keeps the suite green.
- **koffi ABI.** If `koffi` is `require()`d unconditionally in
  `win32.js`, `npm install` on a non-x64 Linux box fails at post-install.
  Mitigation: import inside a runtime check (`if (process.platform ===
  'win32') require('koffi')`) in `os.js`. Phase 2.
