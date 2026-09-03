---
phase: 6
title: "ci-and-docs"
status: completed
priority: P2
effort: "1d"
dependencies: [5]
---

# Phase 6: ci-and-docs

## Overview
CI gate that runs both suites on every push, and a complete
`docs/ubuntu.md` so a new user goes from a clean Ubuntu 24.04 install
to a working tray icon in ten commands.

## Requirements
- Functional:
  - `cd linux && npm test` runs both suites in < 30 s on a CI box
    (no GPU, no display server).
  - `docs/ubuntu.md` covers: system packages, `npm install`, runtime
    expectations, troubleshooting, Wayland v1 limitations, dGPU
    verification.
  - `CLAUDE.md` cross-platform section is up to date and points at
    the new tree.
- Non-functional:
  - CI box needs no special privileges; runs as a stock GitHub Actions
    `ubuntu-24.04` runner.
  - `docs/ubuntu.md` < 200 lines, scannable in 60 s.

## Architecture

CI workflow (`.github/workflows/linux.yml`):
```yaml
name: linux
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - name: install os deps
        run: |
          sudo apt-get update
          sudo apt-get install -y xvfb xprop wmctrl xdotool
      - name: install
        working-directory: linux
        run: npm ci
      - name: simtest
        working-directory: linux
        run: xvfb-run -a npm run simtest
      - name: behaviortest
        working-directory: linux
        run: xvfb-run -a npm run behaviortest
```

`xvfb-run -a` is needed for the renderer-side three.js setup even
though the suites are headless (the import-time check
`typeof window !== 'undefined'` in three.js needs a DOM; xvfb gives
it one). The snapshot test is opt-in via `RUN_SNAPSHOT_TESTS=1` and
runs in a self-hosted runner with a real GPU.

## Related Code Files
- Create: `.github/workflows/linux.yml`
- Create: `docs/ubuntu.md`
- Modify: `CLAUDE.md` §"Windows port" → §"Cross-platform Electron port
  (Windows + Linux)"
- Modify: `README.md` (add Linux to the install matrix; point at
  `docs/ubuntu.md`)
- Modify: `HANDOFF.md` (note that the V5 brainstorm is paused, the
  Linux port is the current focus; reference the plan)

## Implementation Steps
1. Write `.github/workflows/linux.yml` (above).
2. Write `docs/ubuntu.md` covering:
   - System packages: `apt install nodejs npm xvfb xprop wmctrl xdotool nvidia-driver-580`
   - Headless verification: `nvidia-smi -L` lists the dGPU.
   - Install: `git clone … && cd desktop-fly/linux && npm install`
   - Run: `npm start` (tray icon appears).
   - Tests: `npm test`.
   - Wayland v1: no ledges; future DBus bridge issue link.
   - Snapshot: `npm run snapshot -- /tmp/out.png`; verify with
     `nvidia-smi pmon -c 5`.
   - Troubleshooting: black overlay → set
     `ELECTRON_OZONE_PLATFORM_HINT=x11`; missing `koffi` → install
     build-essential; missing `xprop` → app still works, no ledges.
3. Update `CLAUDE.md` to point at the new tree and the symlink rule.
4. Add a one-line note in `README.md` between the macOS and Windows
   install blocks: "Linux: see `docs/ubuntu.md`."
5. Update `HANDOFF.md` with the current state (V5 paused, this plan
   active).

## Success Criteria
- [ ] `.github/workflows/linux.yml` runs on push and is green.
- [ ] `docs/ubuntu.md` exists, links from `README.md`, and walks a
      new user from zero to tray in < 10 commands.
- [ ] `CLAUDE.md` cross-platform section is current; references the
      plan and the new symlink rule.
- [ ] The "any change to sim/behavior must touch both suites" rule
      is preserved in the new wording.

## Risk Assessment
- **GitHub Actions ubuntu-24.04 runner has no GPU.** Snapshot test
  is opt-in; the suites run under `xvfb-run` and need no GPU. This
  is already the situation on macOS and Windows CI; no new risk.
- **Network access for `npm install`.** GH Actions has it; we do not
  pin a registry. Same posture as the existing Windows workflow (if
  one exists; if not, this is the first).
- **Symlinks in `git clone` on CI.** GitHub Actions `actions/checkout`
  v4 honors symlinks; verified. If a future Windows self-hosted
  runner clones, the vendor-copy fallback in Phase 1 is the
  alternative.
