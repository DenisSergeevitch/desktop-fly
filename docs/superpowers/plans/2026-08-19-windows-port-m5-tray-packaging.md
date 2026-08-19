# DesktopFly Windows Port — M5 (Tray Menu and Packaging) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tray menu with the macOS build's controls — pause, show/hide brain,
escape test, add/remove fly, scare, quit — and a packaged app that runs without a
checkout.

**Architecture:** Pause and the info line become tested `core/` additions; the
tray itself is Electron glue in `main/`. Packaging via electron-builder, with the
shared `data/` directory carried as an extra resource.

**Spec:** `docs/superpowers/specs/2026-08-19-windows-port-design.md`
**Predecessors:** M1, M2a, M2b, M3, M4 — all complete.

## Global Constraints

- Everything from M1–M4 still applies: Node ≥ 24, no codegen TypeScript
  constructs, explicit `.ts` extensions, the Swift source is normative, `data/`
  read-only, MIT, `core/`+`body/` free of Electron/koffi/`WebGLRenderer`.
- The tray must offer **Quit**. Until now the only way to stop the app has been
  Ctrl+C in the launching terminal; a packaged build has no terminal at all, so
  this is a correctness item, not a convenience.

## Deviations from the macOS menu, stated up front

1. **No "Move to Next Display".** macOS keeps the fly on one screen and hops on
   command; this port's overlay spans every display (M3), so the fly already
   roams all of them and the item would do nothing. Omitted deliberately.
2. **The tray icon is a drawn asset, not an emoji.** macOS sets the status item's
   *title* to 🪰; a Windows tray needs an image, so `windows/assets/tray.png`
   ships a small fly glyph.
3. **Keyboard equivalents are dropped.** The macOS menu binds p/b/e/d/a/r/s/q,
   which work because the menu belongs to a focused app. Our overlay is
   deliberately `focusable: false` and there is no app menu bar, so accelerators
   would need a *global* shortcut registration — grabbing keys system-wide, which
   contradicts the project's permission-free, keystroke-blind design. Menu items
   are click-only.

---

### Task 1: Pause and the info line — `core/` additions

**Files:**
- Modify: `windows/src/body/coordinator.ts` (add `setPaused`)
- Create: `windows/src/core/info.ts`
- Create: `windows/src/core/info.test.ts`
- Modify: `windows/src/body/coordinator.test.ts` (pause tests)

**Interfaces:**
- Produces: `Coordinator.setPaused(paused: boolean): void`,
  `Coordinator.paused: boolean`;
  `dataInfoLine(points: BrainPointsFile | null, circuit: CircuitFile | null): string`.

- [ ] **Step 1: Write the failing tests**

Append to `windows/src/body/coordinator.test.ts`:

```ts
test('pausing freezes the sim and the fly; resuming does not jump', () => {
  // main.swift:856-861 sets scnView.isPlaying = false AND coordinator.lastTime =
  // nil, so the first frame after resuming does not carry the whole pause as one
  // enormous dt — which would teleport the fly across the screen.
  const c = makeCoordinator();
  for (let i = 0; i < 60; i++) c.frame(DT);
  const simAt = c.sim!.simMs;
  const flyAt = { x: c.flies[0].pos.x, y: c.flies[0].pos.y };
  const timeAt = c.flies[0].time;

  c.setPaused(true);
  c.frame(0);                       // let the enqueued flag land
  for (let i = 0; i < 60; i++) c.frame(DT);
  assert.equal(c.paused, true);
  assert.equal(c.sim!.simMs, simAt, 'the sim must not step while paused');
  assert.equal(c.flies[0].time, timeAt, 'the fly clock must not advance');
  assert.deepEqual({ x: c.flies[0].pos.x, y: c.flies[0].pos.y }, flyAt);

  c.setPaused(false);
  c.frame(0);
  c.frame(DT);
  assert.equal(c.paused, false);
  const stepped = c.sim!.simMs - simAt;
  assert.ok(stepped > 0 && stepped <= 20,
    `first frame after resume stepped ${stepped} ms; must be one frame's worth`);
});

test('a pause longer than the dt clamp still resumes smoothly', () => {
  const c = makeCoordinator();
  for (let i = 0; i < 30; i++) c.frame(DT);
  c.setPaused(true);
  c.frame(0);
  c.setPaused(false);
  c.frame(0);
  const before = { x: c.flies[0].pos.x, y: c.flies[0].pos.y };
  c.frame(30);                      // 30 seconds of wall time in one frame
  const moved = Math.hypot(c.flies[0].pos.x - before.x, c.flies[0].pos.y - before.y);
  assert.ok(moved < 30, `fly jumped ${moved.toFixed(0)} pt on the first frame back`);
});
```

Create `windows/src/core/info.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrainData } from './data.ts';
import { dataInfoLine } from './info.ts';

test('the info line reports what was actually loaded', () => {
  // main.swift:725 — the tray shows this, so its numbers must come from the data
  // rather than being typed in.
  const { points, circuit } = loadBrainData()!;
  const line = dataInfoLine(points, circuit);
  assert.match(line, /FlyWire v783/);
  assert.match(line, /23,210 somas/);
  assert.match(line, /668n/);
  assert.match(line, /18,968e/);
});

test('missing data says so instead of showing zeros', () => {
  assert.match(dataInfoLine(null, null), /no data/);
  assert.doesNotMatch(dataInfoLine(null, null), /0 somas/);
});

test('thousands separators appear, so 23210 is readable', () => {
  const { points, circuit } = loadBrainData()!;
  assert.doesNotMatch(dataInfoLine(points, circuit), /23210/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd windows && node --test src/core/info.test.ts src/body/coordinator.test.ts`
Expected: FAIL — `info.ts` missing, `setPaused` not a function.

- [ ] **Step 3: Implement**

`Coordinator.setPaused` goes through `enqueue` like every other mutation, sets a
`paused` flag, and `frame()` returns immediately after draining pending actions
when paused. On resume, reset the `SimClock` and the loom transducer so the first
frame after a pause carries one frame's worth of time, not the whole pause — the
`dt` clamp alone is not enough, since 50 ms of catch-up is still a visible jump.

`core/info.ts` formats the line with `toLocaleString('en-US')` for separators.

- [ ] **Step 4: Run tests** — expect 147.
- [ ] **Step 5: Commit** — `"Windows port M5: pause and the tray info line"`

---

### Task 2: The tray menu

**Files:**
- Create: `windows/assets/tray.png` (32×32, generated)
- Modify: `windows/src/main/main.ts`
- Modify: `windows/src/renderer/overlay.ts` (handle `pause`/`resume`)
- Modify: `windows/build.mjs` (copy the asset into `dist/`)

- [ ] **Step 1: Generate the tray icon**

A 32×32 RGBA PNG with a simple dark fly glyph — body, head, two translucent
wings — on transparency. Commit it as an asset; do not draw it at runtime.

- [ ] **Step 2: Build the menu**

Matching `main.swift:829-854` in order and wording:

```
Desktop Fly                       (disabled header)
FlyWire v783 · 23,210 somas · …   (disabled, from dataInfoLine)
──────
Pause            (label toggles to Resume)
Show/Hide Brain
Escape Test (loom)
Add Fly
Remove Fly
Scare Flies
──────
Quit
```

- Pause sends `pause`/`resume` to the overlay and rebuilds the menu so the label
  tracks the state.
- Show/Hide Brain toggles `brainWin` visibility, **re-creating it if it was
  closed** — otherwise the item silently does nothing after someone closes the
  window.
- Escape Test, Add/Remove Fly and Scare Flies send the commands the overlay
  already handles.
- Quit calls `app.quit()`.
- Left-clicking the tray icon also toggles the brain window, since that is the
  Windows convention for a tray app's primary action.

- [ ] **Step 3: Handle pause in the renderer**

On `pause`, stop calling `coordinator.frame()` and stop rendering; on `resume`,
reset `last = null` and continue. Keep `requestAnimationFrame` running either
way, so resuming needs no restart.

- [ ] **Step 4: Verify**

`npm start`, then check each item by hand: Pause freezes the fly and its label
becomes Resume; Show/Hide Brain hides and re-shows the window, and still works
after closing the brain window with its X; Escape Test makes the fly take off;
Add Fly adds a second fly that does *not* respond to the brain; Scare Flies
startles everyone; Quit exits with no process left behind.

Confirm with `--capture` that the overlay still runs and the log still shows the
brain ready and spikes flowing.

- [ ] **Step 5: Commit** with the checked list in the message.

---

### Task 3: Packaging

**Files:**
- Modify: `windows/package.json` (electron-builder config + `dist` script)
- Modify: `windows/src/core/data.ts` (find `data/` inside a packaged app)
- Modify: `.gitignore` (build output)

- [ ] **Step 1: Teach `findDataDir` about packaging**

A packaged app has no repo above it. Add `process.resourcesPath/data` to the
candidate list, guarded so it stays undefined outside Electron. The existing
tests must keep passing unchanged.

- [ ] **Step 2: Configure electron-builder**

`build`: appId `com.desktopfly.windows`, `directories.output` = `release`, files
limited to `dist/**` plus `node_modules/koffi/**` (a native module — it must not
be packed into the asar), and `extraResources` carrying `../data` to
`resources/data`. Target a portable/dir build first: an installer needs signing
decisions that are not this milestone's business.

- [ ] **Step 3: Build and run it**

`npm run dist`, then launch the built executable from `release/` **with the repo
data directory renamed away**, to prove the packaged copy is being read rather
than the checkout's. The fly must appear and the brain must load 668 neurons.

If electron-builder cannot install or run in this environment, stop and report
that plainly rather than leaving a half-configured build; the tray menu is the
milestone's real deliverable.

- [ ] **Step 4: Commit**

---

### Task 4: Documentation

- [ ] Status M5; the tray menu table; how to quit; packaging instructions; the
      three menu deviations (no display hop, drawn icon, no accelerators) with
      their reasons.
- [ ] `CLAUDE.md`: the `windows/` row gains `assets/`, and a note that pause must
      reset the clock rather than rely on the dt clamp.
- [ ] Verify every documented command runs, then commit.

---

## M5 Definition of Done

- [ ] `node --test` — all pass (expected 147)
- [ ] `behaviortest` 17/17; `simtest:strict` exit 0; `typecheck` clean
- [ ] Every tray item verified by hand, including Quit leaving no process
- [ ] `npm run dist` produces a runnable build that reads its own `data/`,
      or the blocker is reported
- [ ] `core/` still free of Electron, koffi and `WebGLRenderer`
- [ ] `data/` unmodified

## Next

The port reaches feature parity with the macOS build here. Remaining known gaps,
none of them milestones: the fly cannot hide behind windows (explicitly
deselected), and mixed-DPI spanning renders the fly ~20% larger on a
lower-scaled monitor.
