// main/main.ts — the Electron shell, from main.swift:714-812 (AppDelegate).
//
// This process is the macOS main thread's counterpart: timers, window
// lifecycle, and OS integration. It never touches Three.js or the sim; it just
// converts OS state into scene coordinates and ships it over one IPC channel.
// The renderer process is the SceneKit render thread's counterpart.

import { app, BrowserWindow, ipcMain, powerMonitor, screen } from 'electron';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import os from 'node:os';
import { loadBrainData } from '../core/data.ts';
import { WindowTerrain } from '../core/windowTerrain.ts';
import { toSceneRects, unionBounds, type ScreenRect } from '../core/arena.ts';
import { InputSense, isSleepy } from '../core/idle.ts';
import { CpuSampler, tempoFromLoad } from '../core/tempo.ts';
import { circadianActivity } from '../core/circadian.ts';
import {
  enumerateWindows, lastInputTick, leftButtonClicked, tickCount,
} from './win32.ts';

const CURSOR_HZ = 30;         // main.swift:761 — the same poll rate
const WINDOW_POLL_MS = 700;   // main.swift:780 — window terrain at ~1.4 Hz
const CPU_POLL_MS = 2000;     // no macOS equivalent: thermalState is free to read

const terrain = new WindowTerrain();
const input = new InputSense();
const cpuSampler = new CpuSampler();
let tempo = 1;

// --capture=out.png renders the overlay to a PNG and exits. The window stays
// HIDDEN in that mode: capturePage() on a visible window needs a real
// interactive desktop surface, so it hangs forever in a non-interactive shell.
const capArg = process.argv.find((a) => a.startsWith('--capture='));
const capturePath = capArg === undefined
  ? process.env.DESKTOPFLY_CAPTURE
  : capArg.slice('--capture='.length);

let win: BrowserWindow | null = null;
let cursorTimer: NodeJS.Timeout | null = null;
let windowTimer: NodeJS.Timeout | null = null;
let cpuTimer: NodeJS.Timeout | null = null;

// The fly's arena spans EVERY display: on Windows the desktop is one continuous
// space, unlike macOS where the overlay lives on one screen and hops on command.
//
// Work areas rather than full bounds, for two reasons: Windows clamps a normal
// window to the work area anyway (the overlay came out 1392 tall when asked for
// 1440), and the taskbar is a poor place for a fly.
//
// The window must be the rectangular bounding box, but the monitors may not tile
// it — so core/arena.ts keeps the fly on the union of the real rectangles while
// the window covers the box.
function workAreas(): ScreenRect[] {
  return screen.getAllDisplays().map((d) => d.workArea);
}

function arenaBox(): ScreenRect {
  return unionBounds(workAreas());
}

// Screen (DIP, origin top-left of the primary display, y down)
//   -> scene (origin at the centre of the fly's display, y UP).
// Working in DIPs makes Chromium absorb per-monitor DPI scaling, so the body
// math keeps operating in macOS-equivalent "points".
// Screen (DIP, y down) -> scene (origin at the centre of the arena box, y UP).
function toScene(p: { x: number; y: number }, box: ScreenRect) {
  return {
    x: p.x - (box.x + box.width / 2),
    y: (box.y + box.height / 2) - p.y,
  };
}

function arenaMessage() {
  const areas = workAreas();
  const box = unionBounds(areas);
  return {
    box: { width: box.width, height: box.height },
    rects: toSceneRects(areas),
  };
}

// Resize the window to the union box and tell the renderer. PUSH is only correct
// for LATER layout changes: at startup the renderer has not subscribed yet, so
// the initial value is PULLED via ipcMain.handle('arena') — the same race that
// silently broke the circuit handoff in M2b.
function sendArena(): void {
  if (win === null || win.isDestroyed()) return;
  const box = unionBounds(workAreas());
  win.setBounds({ x: box.x, y: box.y, width: box.width, height: box.height });
  win.webContents.send('arena', arenaMessage());
}

function createWindow(): void {
  const box = arenaBox();
  win = new BrowserWindow({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    transparent: true,       // per-pixel alpha; the desktop shows through
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,        // never steals focus from real work
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    show: capturePath === undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      // CORRECTNESS, not a preference: Chromium throttles requestAnimationFrame
      // to ~1 Hz for background or occluded windows. The 1 kHz sim clock is
      // driven from the frame loop, so throttling would freeze the fly AND
      // stall the brain.
      backgroundThrottling: false,
    },
  });

  // ~ NSWindow.Level.floating: above ordinary windows.
  win.setAlwaysOnTop(true, 'screen-saver');
  // Click-through. No `forward: true` — we never interact with the overlay and
  // the cursor is polled globally, so event forwarding (and its focus quirks)
  // is unnecessary.
  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Windows gives a GUI Electron process no usable stdout, so renderer
  // diagnostics go to a file. Without this a renderer exception is completely
  // silent and looks like a hung window.
  win.webContents.on('console-message', (e) => {
    // Event-object form: the positional (event, level, message, line, source)
    // signature is deprecated as of Electron 43.
    appendFileSync('renderer.log',
      `[${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})
`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    appendFileSync('renderer.log', `render process gone: ${details.reason}
`);
  });
  win.webContents.on('preload-error', (_e, path, error) => {
    appendFileSync('renderer.log', `preload error in ${path}: ${error.message}
`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    appendFileSync('renderer.log', `did-fail-load ${code}: ${desc}
`);
  });

  void win.loadFile(join(__dirname, 'index.html'));

  win.webContents.once('did-finish-load', () => {
    const startBox = arenaBox();
    win?.setBounds({
      x: startBox.x, y: startBox.y,
      width: startBox.width, height: startBox.height,
    });
  });
}

function startCursorPoll(): void {
  cursorTimer = setInterval(() => {
    if (win === null || win.isDestroyed()) return;
    const box = arenaBox();
    const screenCursor = screen.getCursorScreenPoint();
    const cursor = toScene(screenCursor, box);

    // Idle, and typing inferred from input-without-cursor-movement. This is the
    // privacy-preserving substitution for macOS's keyboard-only idle query: we
    // learn WHEN keys were pressed, never which.
    const s = input.sample(lastInputTick(), tickCount(), screenCursor);
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;

    // A click is a tap on the fly's substrate (main.swift:795-800).
    const taps = leftButtonClicked() ? [cursor] : [];

    win.webContents.send('senses', {
      cursor,
      taps,
      typing: s.typing,
      sleepy: isSleepy(s.idleSeconds, hour),
      tempo,
      activity: circadianActivity(hour),
    });
  }, Math.round(1000 / CURSOR_HZ));
}

// main.swift:780-792 — window terrain plus looms from newly appeared windows
function startWindowPoll(): void {
  windowTimer = setInterval(() => {
    if (win === null || win.isDestroyed()) return;
    const box = arenaBox();
    // GetWindowRect returns PHYSICAL pixels. With per-monitor scaling (150% and
    // 125% here) one divisor cannot be right for both, so let Electron convert
    // each rect: screenToDipRect knows which display each window is on.
    const raw = enumerateWindows().map((w) => {
      const dip = screen.screenToDipRect(null, {
        x: w.x, y: w.y, width: w.width, height: w.height,
      });
      return { ...w, x: dip.x, y: dip.y, width: dip.width, height: dip.height };
    });
    const snap = terrain.poll(raw, box);
    win.webContents.send('senses', {
      ledges: snap.ledges,
      newWindows: snap.newWindows,
    });
  }, WINDOW_POLL_MS);
}

// SUBSTITUTION for thermalTempo(): a busy PC is a faster fly.
function startCpuPoll(): void {
  cpuSampler.sample(os.cpus());
  cpuTimer = setInterval(() => {
    tempo = tempoFromLoad(cpuSampler.sample(os.cpus()));
  }, CPU_POLL_MS);
}

function onDisplaysChanged(): void {
  sendArena();
}

app.whenReady().then(() => {
  createWindow();
  startCursorPoll();
  startWindowPoll();
  startCpuPoll();

  // if the current display disappears or is rescaled (main.swift:803-811)
  screen.on('display-metrics-changed', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-added', onDisplaysChanged);

  // after a machine sleep the first frame delta is meaningless
  powerMonitor.on('resume', () => {
    win?.webContents.send('command', 'resetClock');
  });

  // data/ is read here, in the process that can reach the filesystem, and
  // handed over on request. Never copied or modified — it stays CC BY-NC.
  ipcMain.handle('arena', () => arenaMessage());

  ipcMain.handle('circuit', () => {
    const data = loadBrainData();
    if (data === null) {
      appendFileSync('renderer.log', 'no data/ - run etl.py first\n');
    }
    return data?.circuit ?? null;
  });

  ipcMain.on('quit', () => app.quit());

  // Diagnostic: DESKTOPFLY_CAPTURE=out.png renders the live overlay for a few
  // seconds, writes a PNG, and exits. The only way to check the overlay path
  // (main -> preload -> renderer -> coordinator -> data) without a human at the
  // screen; also useful on a machine you cannot watch.
  if (capturePath !== undefined && capturePath !== '') {
    setTimeout(() => {
      void (async () => {
        if (win === null || win.isDestroyed()) return app.quit();
        const img = await win.webContents.capturePage();
        await writeFile(capturePath, img.toPNG());
        console.log(`overlay capture written to ${capturePath}`);
        app.quit();
      })();
    }, 4000);
  }
}).catch((e: unknown) => {
  console.error('failed to start:', e);
  app.quit();
});

app.on('window-all-closed', () => {
  for (const t of [cursorTimer, windowTimer, cpuTimer]) {
    if (t !== null) clearInterval(t);
  }
  app.quit();
});
