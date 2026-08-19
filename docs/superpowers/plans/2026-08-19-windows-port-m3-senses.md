# DesktopFly Windows Port — M3 (Desktop Senses) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the fly its desktop ecology on Windows — your window title bars
become walkable ledges, going idle at night puts it to sleep, clicks are
substrate taps, and a busy CPU makes it faster.

**Architecture:** Every decision rule lives in a pure `core/` module with tests
(window filtering and coordinate conversion, sleep thresholds, typing inference,
CPU→tempo mapping). `main/win32.ts` is a thin koffi binding that only *gathers*
raw values and degrades to empty results on any failure.

**Tech Stack:** Node 24, `three`, `electron`, `koffi` 3.1.5 (prebuilt FFI — no
compiler needed, verified calling `kernel32!GetTickCount`).

**Spec:** `docs/superpowers/specs/2026-08-19-windows-port-design.md`
**Predecessors:** M1, M2a, M2b — all complete.

## Global Constraints

- Everything from M1/M2a/M2b still applies: Node ≥ 24, no codegen TypeScript
  constructs, explicit `.ts` extensions, the Swift source is normative, `data/`
  read-only, MIT, `core/` and `body/` free of Electron and `WebGLRenderer`.
- **`core/` must not import koffi either.** The FFI is `main/`-only, so the
  suites keep running on any machine.
- **Permission-free only.** Every API used here must work without elevation, a
  TCC-style prompt, or an installed hook: `EnumWindows`, `GetWindowRect`,
  `GetLastInputInfo`, `GetAsyncKeyState`, `DwmGetWindowAttribute`. No
  `SetWindowsHookEx`, no keyloggers, nothing that records *which* key was
  pressed — only *when*, matching the macOS build's privacy property.

## Deviation from the writing-plans skill

As in M2a/M2b: full code for every test; implementation cited by Swift line
range. Task 4's koffi binding has no unit test — it is verified by a diagnostic
CLI that prints what the senses actually see on this machine.

## Substitutions, stated up front

1. **`ProcessInfo.thermalState` → CPU load.** Windows has no dependable thermal
   API (laptop ACPI thermal zones are frequently absent or lie). Busy fraction
   from `os.cpus()` deltas is bucketed into the same 1.0 / 1.15 / 1.35 / 1.5
   steps. This is a *substitution*, not a sensor reading, and must be documented
   as such in the README — "a busy PC is a faster fly."
2. **Key-only idle → inferred typing.** macOS asks
   `CGEventSource.secondsSinceLastEventType(.keyDown)` for keyboard-only
   idleness. `GetLastInputInfo` reports *combined* input, so keyboard activity is
   inferred as "last-input advanced while the cursor did not move". This
   preserves the privacy property exactly: when, never what.
3. **Global click monitor → `GetAsyncKeyState` polling** at 30 Hz. No hook is
   installed, so nothing needs elevation and nothing can record keystrokes.

---

### Task 1: Window terrain — `core/windowTerrain.ts`

**Files:**
- Create: `windows/src/core/windowTerrain.ts`
- Create: `windows/src/core/windowTerrain.test.ts`

**Interfaces:**
- Produces: `interface RawWindow { id, x, y, width, height: number; visible,
  toolWindow, cloaked, hasTitle, ownProcess: boolean }`;
  `interface DisplayRect { x, y, width, height: number }`;
  `interface TerrainSnapshot { ledges: Ledge[]; newWindows: Array<{ center:
  { x, y: number }; size: number }> }`;
  `class WindowTerrain` with `poll(windows: RawWindow[], display: DisplayRect):
  TerrainSnapshot`.

Coordinate conversion is the part most likely to be subtly wrong, so it is
asserted numerically: screen DIPs (origin top-left of the primary display,
y **down**) → scene (origin at the centre of the fly's display, y **up**).

- [ ] **Step 1: Write the failing test**

Create `windows/src/core/windowTerrain.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowTerrain, type RawWindow } from './windowTerrain.ts';

// A 1920x1080 primary display at the origin: scene centre is screen (960, 540).
const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };

function win(over: Partial<RawWindow> = {}): RawWindow {
  return {
    id: 1, x: 400, y: 300, width: 800, height: 600,
    visible: true, toolWindow: false, cloaked: false,
    hasTitle: true, ownProcess: false, ...over,
  };
}

test('a normal window top edge becomes a ledge in scene coordinates', () => {
  const t = new WindowTerrain();
  const snap = t.poll([win()], DISPLAY);
  assert.equal(snap.ledges.length, 1);
  const L = snap.ledges[0];
  // screen y 300 is 240 above the centre line (540 - 300)
  assert.equal(L.y, 240);
  // x 400..1200 in screen space is -560..240 relative to centre 960
  assert.equal(L.x0, -560);
  assert.equal(L.x1, 240);
  assert.equal(L.id, 1);
});

test('windows that must be ignored are ignored', () => {
  const t = new WindowTerrain();
  const cases: Array<[string, Partial<RawWindow>]> = [
    ['invisible', { visible: false }],
    ['tool window', { toolWindow: true }],
    ['cloaked (a background UWP app)', { cloaked: true }],
    ['untitled', { hasTitle: false }],
    ['our own overlay', { ownProcess: true }],
    ['too narrow', { width: 100 }],
    ['too short', { height: 40 }],
  ];
  for (const [why, over] of cases) {
    assert.equal(t.poll([win(over)], DISPLAY).ledges.length, 0,
      `should skip: ${why}`);
  }
});

test('windows off this display are ignored', () => {
  const t = new WindowTerrain();
  // entirely to the right of a 1920-wide display
  assert.equal(t.poll([win({ x: 2400 })], DISPLAY).ledges.length, 0);
  // and a second display's window is picked up when that display is active
  const second = { x: 1920, y: 0, width: 1920, height: 1080 };
  const snap = new WindowTerrain().poll([win({ x: 2400 })], second);
  assert.equal(snap.ledges.length, 1);
});

test('ledges are clipped to the display with a 15 pt inset', () => {
  const t = new WindowTerrain();
  // a window wider than the screen
  const snap = t.poll([win({ x: -500, width: 3000 })], DISPLAY);
  assert.equal(snap.ledges[0].x0, -1920 / 2 + 15);
  assert.equal(snap.ledges[0].x1, 1920 / 2 - 15);
});

test('edges too close to the top or bottom of the screen are skipped', () => {
  const t = new WindowTerrain();
  // top edge above the visible band (scene y >= H/2 - 8 = 532)
  assert.equal(t.poll([win({ y: 2 })], DISPLAY).ledges.length, 0);
  // and one below it
  assert.equal(t.poll([win({ y: 1078, height: 600 })], DISPLAY).ledges.length, 0);
});

test('a ledge narrower than 100 pt is not walkable', () => {
  const t = new WindowTerrain();
  assert.equal(t.poll([win({ width: 170 })], DISPLAY).ledges.length, 1);
  // 160 is the minimum window width, but after clipping a near-edge window can
  // leave under 100 pt of walkable span
  const clipped = t.poll([win({ x: 1830, width: 200 })], DISPLAY);
  assert.equal(clipped.ledges.length, 0);
});

test('at most 12 ledges are reported', () => {
  const t = new WindowTerrain();
  const many = Array.from({ length: 30 },
    (_, i) => win({ id: i + 1, y: 200 + i * 10 }));
  assert.equal(t.poll(many, DISPLAY).ledges.length, 12);
});

test('the first poll reports no new windows, later polls do', () => {
  const t = new WindowTerrain();
  // Environment.swift:58 — the first poll must not treat every existing window
  // as having just appeared, or the fly panics the moment it starts.
  assert.equal(t.poll([win({ id: 1 })], DISPLAY).newWindows.length, 0);
  assert.equal(t.poll([win({ id: 1 })], DISPLAY).newWindows.length, 0);
  const appeared = t.poll([win({ id: 1 }), win({ id: 2 })], DISPLAY);
  assert.equal(appeared.newWindows.length, 1);
  // centre in scene coordinates, and size = the longer edge
  assert.equal(appeared.newWindows[0].center.x, 400 + 400 - 960);
  assert.equal(appeared.newWindows[0].center.y, 540 - (300 + 300));
  assert.equal(appeared.newWindows[0].size, 800);
});

test('a window that closes and reopens counts as new again', () => {
  const t = new WindowTerrain();
  t.poll([win({ id: 1 }), win({ id: 2 })], DISPLAY);
  t.poll([win({ id: 1 })], DISPLAY);                    // 2 closed
  const back = t.poll([win({ id: 1 }), win({ id: 2 })], DISPLAY);
  assert.equal(back.newWindows.length, 1);
});

test('new windows are reported even when they are not walkable', () => {
  // A small dialog cannot be stood on, but it still looms.
  const t = new WindowTerrain();
  t.poll([win({ id: 1 })], DISPLAY);
  // 120x90 is under the 160x60 minimum, so it can never be a ledge
  const snap = t.poll([win({ id: 1 }), win({ id: 9, width: 120, height: 90 })],
    DISPLAY);
  assert.equal(snap.ledges.filter((l) => l.id === 9).length, 0);
  assert.equal(snap.newWindows.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd windows && node --test src/core/windowTerrain.test.ts`
Expected: FAIL — `Cannot find module ... windowTerrain.ts`

- [ ] **Step 3: Write the implementation**

Create `windows/src/core/windowTerrain.ts`, transliterating
`Environment.swift:16-68`. Keep the filter order and every constant: minimum
160×60, the 15 pt horizontal inset, the ±8 pt vertical band, the 100 pt minimum
walkable span, the 12-ledge cap, and the first-poll suppression via a
`knownIds: Set<number>`.

The `newWindows` list is built from ids absent from `knownIds`. It applies the
**visibility** filters (`visible`, `!cloaked`, `!toolWindow`, `hasTitle`,
`!ownProcess`, on this display) but **not** the walkability ones (size, vertical
band, 100 pt span): a small dialog still looms even though it cannot be walked
on. A cloaked or hidden window has not visibly appeared, so it must not loom.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test`
Expected: PASS, 103 tests (93 + 10).

- [ ] **Step 5: Commit**

```bash
git add windows/src/core
git commit -m "Windows port M3: window terrain rules, pure and tested"
```

---

### Task 2: Idle, typing, and tempo — `core/idle.ts` + `core/tempo.ts`

**Files:**
- Create: `windows/src/core/idle.ts`
- Create: `windows/src/core/tempo.ts`
- Create: `windows/src/core/idle.test.ts`
- Create: `windows/src/core/tempo.test.ts`

**Interfaces:**
- Produces: `isSleepy(idleSeconds: number, hour: number): boolean`;
  `class InputSense` with a public `typing: number` field and
  `sample(lastInputTick: number, nowTick: number, cursor: { x, y: number }):
  { idleSeconds: number; keyboardActive: boolean; typing: number }`;
  `tempoFromLoad(busy: number): number`;
  `class CpuSampler` with `sample(cpus: Array<{ times: Record<string, number> }>):
  number` returning the busy fraction since the previous sample.

- [ ] **Step 1: Write the failing tests**

Create `windows/src/core/idle.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputSense, isSleepy } from './idle.ts';

test('sleep needs either a long night idle or a very long idle', () => {
  // Environment.swift + main.swift:774
  assert.equal(isSleepy(700, 23), true, 'idle at night');
  assert.equal(isSleepy(700, 3), true, 'idle in the small hours');
  assert.equal(isSleepy(700, 14), false, 'the same idle at 2pm is just a break');
  assert.equal(isSleepy(2000, 14), true, 'half an hour idle sleeps any time');
  assert.equal(isSleepy(100, 23), false, 'briefly idle at night is not sleep');
  // the night window is 22:00-06:00 inclusive of 22, exclusive of 6
  assert.equal(isSleepy(700, 22), true);
  assert.equal(isSleepy(700, 21.9), false);
  assert.equal(isSleepy(700, 5.9), true);
  assert.equal(isSleepy(700, 6), false);
});

test('idle seconds come from the tick difference', () => {
  const s = new InputSense();
  const out = s.sample(1_000_000, 1_004_500, { x: 0, y: 0 });
  assert.equal(out.idleSeconds, 4.5);
});

test('input with a still cursor is read as typing; input with movement is not', () => {
  // The substitution for macOS's keyboard-only idle query. It preserves the
  // privacy property exactly: we learn WHEN keys were pressed, never which.
  const s = new InputSense();
  s.sample(1000, 1000, { x: 10, y: 10 });          // prime

  // last input advanced, cursor unchanged => keyboard
  const typed = s.sample(1100, 1100, { x: 10, y: 10 });
  assert.equal(typed.keyboardActive, true);
  assert.ok(typed.typing > 0, `typing level ${typed.typing}`);

  // last input advanced, cursor moved => mouse, not typing
  const moved = new InputSense();
  moved.sample(1000, 1000, { x: 10, y: 10 });
  const out = moved.sample(1100, 1100, { x: 40, y: 10 });
  assert.equal(out.keyboardActive, false);
});

test('the typing level rises and decays smoothly', () => {
  const s = new InputSense();
  let tick = 1000;
  s.sample(tick, tick, { x: 0, y: 0 });
  // 30 polls of steady typing
  for (let i = 0; i < 30; i++) {
    tick += 100;
    s.sample(tick, tick, { x: 0, y: 0 });
  }
  const hot = s.typing;
  assert.ok(hot > 0.8, `sustained typing should approach 1, got ${hot}`);

  // then 60 polls of nothing: the tick stops advancing
  let out = { typing: hot };
  for (let i = 0; i < 60; i++) out = s.sample(tick, tick + 1000 * i, { x: 0, y: 0 });
  assert.ok(out.typing < 0.2, `typing should decay, got ${out.typing}`);
  assert.ok(out.typing >= 0);
});
```

Create `windows/src/core/tempo.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CpuSampler, tempoFromLoad } from './tempo.ts';

test('load maps onto the same four steps as macOS thermal state', () => {
  // Environment.swift:91-99 — nominal / fair / serious / critical.
  assert.equal(tempoFromLoad(0), 1.0);
  assert.equal(tempoFromLoad(0.1), 1.0);
  assert.equal(tempoFromLoad(0.4), 1.15);
  assert.equal(tempoFromLoad(0.7), 1.35);
  assert.equal(tempoFromLoad(0.95), 1.5);
  // out-of-range input must still land on a valid step
  assert.equal(tempoFromLoad(-1), 1.0);
  assert.equal(tempoFromLoad(99), 1.5);
});

test('tempo is monotonic in load', () => {
  let prev = 0;
  for (let x = 0; x <= 1; x += 0.02) {
    const t = tempoFromLoad(x);
    assert.ok(t >= prev, `tempo dropped at load ${x}`);
    prev = t;
  }
});

function cpus(user: number, idle: number) {
  return [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }];
}

test('the first sample has no previous reading and reports no load', () => {
  const s = new CpuSampler();
  assert.equal(s.sample(cpus(1000, 9000)), 0);
});

test('busy fraction comes from the delta between samples', () => {
  const s = new CpuSampler();
  s.sample(cpus(1000, 9000));
  // 500 ms more busy, 500 ms more idle => 50% busy
  assert.ok(Math.abs(s.sample(cpus(1500, 9500)) - 0.5) < 1e-9);
  // fully busy
  assert.ok(Math.abs(s.sample(cpus(2500, 9500)) - 1) < 1e-9);
  // fully idle
  assert.ok(Math.abs(s.sample(cpus(2500, 10500)) - 0) < 1e-9);
});

test('an identical sample reports no load rather than dividing by zero', () => {
  const s = new CpuSampler();
  const c = cpus(1000, 9000);
  s.sample(c);
  assert.equal(s.sample(c), 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd windows && node --test src/core/idle.test.ts src/core/tempo.test.ts`
Expected: FAIL — both modules missing.

- [ ] **Step 3: Write the implementations**

`core/idle.ts`: `isSleepy` is
`(idle > 600 && (hour >= 22 || hour < 6)) || idle > 1800` (main.swift:774).
`InputSense` keeps the previous tick and cursor, infers `keyboardActive`, and
carries the typing EMA with the Swift factor 0.15 (main.swift:768).

`core/tempo.ts`: `tempoFromLoad` buckets at 0.25 / 0.55 / 0.80 onto
1.0 / 1.15 / 1.35 / 1.5. `CpuSampler` sums `times` across cores, differences
against the previous sample, and returns `busyDelta / totalDelta` (0 when there
is no previous sample or no elapsed time).

Document the substitution in `tempo.ts`'s header comment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd windows && node --test`
Expected: PASS, 112 tests.

- [ ] **Step 5: Commit**

```bash
git add windows/src/core
git commit -m "Windows port M3: idle, typing inference, and CPU tempo"
```

---

### Task 3: The koffi bindings — `main/win32.ts`

**Files:**
- Create: `windows/src/main/win32.ts`
- Create: `windows/src/cli/sensetest.ts`
- Modify: `windows/package.json` (add the `sensetest` script)

**Interfaces:**
- Produces: `enumerateWindows(): RawWindow[]`,
  `lastInputTick(): number`, `tickCount(): number`,
  `leftButtonClicked(): boolean`, `win32Available(): boolean`.

No unit test: this is the OS boundary. It is verified by `sensetest`, which
prints what the machine actually reports.

- [ ] **Step 1: Write the bindings**

`main/win32.ts` loads `user32.dll`, `kernel32.dll` and `dwmapi.dll` through
koffi and exposes only the five functions above. Requirements:

- **Every call is wrapped.** If koffi fails to load, or any call throws, the
  module logs once and returns empty/neutral values forever after
  (`win32Available()` then reports false). The fly must keep walking on a
  machine where the FFI is unavailable — this mirrors
  `CGWindowListCopyWindowInfo` returning nil on macOS.
- `enumerateWindows` uses `EnumWindows` with a koffi callback, then per HWND:
  `IsWindowVisible`, `GetWindowRect` (a `RECT` out-parameter),
  `GetWindowTextLengthW` for `hasTitle`, `GetWindowLongPtrW(GWL_EXSTYLE)` masked
  with `WS_EX_TOOLWINDOW` (0x80), `DwmGetWindowAttribute(hwnd,
  DWMWA_CLOAKED = 14, ...)` for `cloaked`, and `GetWindowThreadProcessId`
  compared against `process.pid` for `ownProcess`.
- Rects arrive in **physical pixels**; divide by the scale factor of the display
  the window is on so everything downstream stays in DIPs. Take the scale factor
  from the caller rather than querying it here.
- `leftButtonClicked` uses `GetAsyncKeyState(VK_LBUTTON = 0x01)` and reports the
  0x0001 "pressed since last call" bit, so one physical click is one tap.

- [ ] **Step 2: Write the diagnostic CLI**

`cli/sensetest.ts` runs under plain Node (koffi needs no Electron), prints for
~5 seconds: `win32Available`, the raw window count, how many survive filtering
into ledges with their scene coordinates, the current idle seconds, the inferred
typing level, clicks seen, CPU busy fraction and the resulting tempo, plus the
circadian activity for the current hour and whether `isSleepy` is true.

Add `"sensetest": "node src/cli/sensetest.ts"`.

- [ ] **Step 3: Run it and read the output**

Run: `cd windows && npm run sensetest`

Confirm against what is actually on screen: the window count is plausible, at
least one real window becomes a ledge, idle seconds behave (move the mouse and
watch it reset), and clicking is counted. **Record the output** in the commit
message — it is the only evidence this layer works.

If `win32Available()` is false, stop and report it rather than proceeding: every
sense in this milestone depends on it.

- [ ] **Step 4: Commit**

```bash
git add windows/src/main windows/src/cli windows/package.json
git commit -m "Windows port M3: koffi Win32 bindings and a sensetest diagnostic"
```

---

### Task 4: Wire the senses into the overlay

**Files:**
- Modify: `windows/src/main/main.ts`

**Interfaces:** no new exports; fills in every remaining field of `Senses`.

- [ ] **Step 1: Extend the main-process timers**

From `main.swift:761-800`, at the same cadences:

- **30 Hz** (the existing cursor timer): sample `lastInputTick`, feed
  `InputSense`, compute `isSleepy` with the current hour and `circadianActivity`,
  poll `leftButtonClicked` and turn a click into a tap at the cursor's scene
  position, and send everything with the cursor.
- **0.7 s**: `enumerateWindows()` → `WindowTerrain.poll()` → send `ledges` and
  `newWindows`.
- **2 s**: `CpuSampler.sample(os.cpus())` → `tempoFromLoad` → send `tempo`.

Coordinate conversion stays in `toScene`, the one place it already lives.

- [ ] **Step 2: Verify with a capture and by watching it**

Run: `cd windows && npm run build && electron dist/main.cjs --capture=senses.png`
and check `renderer.log` shows the overlay ready with 668 neurons.

Then run `npm start` and confirm on screen:
- the fly lands on a window title bar and walks along it
- dragging that window carries the fly with it
- closing the window under the fly makes it take off
- clicking near the fly startles it

- [ ] **Step 3: Commit**

```bash
git add windows/src/main
git commit -m "Windows port M3: window terrain, sleep, taps and tempo reach the fly"
```

---

### Task 5: M3 documentation

- [ ] **Step 1** Update `windows/README.md`: status M3, the `sensetest` command,
  the desktop-ecology list, and the two substitutions (CPU load for thermal
  state; inferred typing) stated as substitutions rather than sensor readings.
- [ ] **Step 2** Update `CLAUDE.md`: note that `core/` holds the sense *rules*
  and `main/win32.ts` the FFI, and that koffi's blocked install script is
  harmless because it ships prebuilt binaries.
- [ ] **Step 3** Verify every documented command runs.
- [ ] **Step 4** Commit.

---

## M3 Definition of Done

- [ ] `cd windows && node --test` — all pass (expected 112)
- [ ] `npm run behaviortest` — 17/17; `npm run simtest:strict` — exit 0
- [ ] `npm run typecheck` — clean
- [ ] `npm run sensetest` — reports real windows, ledges, idle, clicks, tempo
- [ ] `npm start` — the fly walks on a real window edge
- [ ] `core/` imports no koffi and no Electron
- [ ] `data/` unmodified

## Next

M4: the brain window — 23,210 points colored by super-class, live spike flashes,
hover-to-pause, and click-to-stimulate wired back into `LIFSim.stimulate`.
