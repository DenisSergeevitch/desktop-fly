// main.js — DesktopFly Linux entry point.
//
// Per-monitor overlay (macOS-style): one transparent BrowserWindow per
// display, the active display's overlay is visible, others are hidden to
// save GPU memory. Tray menu hops the fly across displays.
//
// CLI flags (pre-whenReady, useful for headless rendering):
//   --snapshot=PATH       offscreen 720x720 PNG of the fly
//   --brainshot=PATH      offscreen 720x560 PNG of the brain window
//
// The GPU stack is forced onto EGL so Electron talks to the NVIDIA ICD
// directly via the Vulkan translation layer in ANGLE. On Wayland we set
// OZONE_PLATFORM_HINT=auto; the user can override via env if a non-GNOME
// compositor misbehaves.
//
// koffi is never required on Linux; OS senses (Phase 2/3) live in src/os.js
// and shell out to xprop/xdotool when on X11.

import { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage, powerMonitor } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { sense } from './src/os.js';
import { loadBrainData } from './src/data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ----- GPU / Wayland switches (must run before app.whenReady) -----
app.commandLine.appendSwitch('use-gl', 'egl');
app.commandLine.appendSwitch('enable-gpu', '1');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch(
  'enable-features',
  'UseOzonePlatform,WaylandWindowDecorations',
);
if (process.env.ELECTRON_OZONE_PLATFORM_HINT) {
  app.commandLine.appendSwitch('ozone-platform', process.env.ELECTRON_OZONE_PLATFORM_HINT);
}

// ----- CLI dispatch -----
// Must be parsed before whenReady so offscreen / non-GUI flags short-circuit
// the whole app loop.
const args = process.argv.slice(2);
function argValue(name) {
  const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return null;
  const a = args[i];
  const eq = a.indexOf('=');
  return eq >= 0 ? a.slice(eq + 1) : (args[i + 1] ?? '');
}
const snapshotPath = argValue('snapshot');
const brainshotPath = argValue('brainshot');

// Activity knobs: CLI --key=value wins, env FLY_KEY falls back, default last.
//   walk-speed   multiplier on tempo (>=0); 1.0 = normal, 2.0 = zippy fly.
//   escape-rate  multiplier on spontaneous-takeoff probability.
//   idle-ms      milliseconds of system-idle time before the fly goes sleepy.
function numFlag(name, envName, def) {
  const cli = argValue(name);
  if (cli !== null && cli !== '') { const v = Number(cli); if (Number.isFinite(v)) return v; }
  if (envName && process.env[envName] != null) { const v = Number(process.env[envName]); if (Number.isFinite(v)) return v; }
  return def;
}
const cfgWalkSpeed  = numFlag('walk-speed',  'FLY_WALK_SPEED',  1.0);
const cfgEscapeRate = numFlag('escape-rate', 'FLY_ESCAPE_RATE', 1.0);
const cfgIdleMs     = numFlag('idle-ms',     'FLY_IDLE_MS',     90_000);

// ----- Pure helpers (exported for tests) -----

/**
 * Plan one BrowserWindow per display. Each entry is a description; main()
 * turns it into a real window.
 * @param {Electron.Display[]} allDisplays
 * @param {number} activeDisplayId
 * @returns {Array<{id:number, bounds:object, hidden:boolean}>}
 */
export function planOverlays(allDisplays, activeDisplayId) {
  return allDisplays.map(d => ({
    id: d.id,
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    hidden: d.id !== activeDisplayId,
  }));
}

/**
 * Build the tray menu. The "Send Fly to Next Display" item is hidden on
 * single-monitor hosts.
 * @param {{
 *   onMove: () => void,
 *   onTogglePause: () => void,
 *   onToggleBrain: () => void,
 *   onAddFly: () => void,
 *   onRemoveFly: () => void,
 *   onScare: () => void,
 *   onQuit: () => void,
 *   activeDisplayId: number,
 *   displayCount: number,
 *   paused: boolean,
 *   brainVisible: boolean,
 * }} ctx
 */
export function buildTrayMenu(ctx) {
  return Menu.buildFromTemplate([
    { label: 'DesktopFly (Linux)', enabled: false },
    { type: 'separator' },
    { label: ctx.paused ? 'Resume' : 'Pause', click: ctx.onTogglePause },
    { label: ctx.brainVisible ? 'Hide Brain' : 'Show Brain', click: ctx.onToggleBrain },
    {
      label: 'Send Fly to Next Display',
      visible: ctx.displayCount > 1,
      click: ctx.onMove,
    },
    { type: 'separator' },
    { label: 'Add Fly', click: ctx.onAddFly },
    { label: 'Remove Fly', click: ctx.onRemoveFly },
    { label: 'Scare Flies', click: ctx.onScare },
    { type: 'separator' },
    { label: 'Quit', click: ctx.onQuit },
  ]);
}

/**
 * One transparent, click-through overlay per display. macOS-style geometry.
 * @param {Electron.Display} display
 * @param {string} linuxDir
 * @param {boolean} hidden
 */
export function createOverlayWindow(display, linuxDir, hidden) {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    focusable: false,
    skipTaskbar: true,
    type: 'desktop',
    show: false,
    webPreferences: {
      preload: resolve(linuxDir, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,            // preload.mjs is ESM; sandbox:true strips it
    },
  });
  win.loadFile(resolve(linuxDir, 'renderer/overlay.html'));
  win.once('ready-to-show', () => {
    win.setIgnoreMouseEvents(true, { forward: true });
    if (!hidden) win.show();
  });
  return win;
}

// ----- App state (used by the live loop; tests do not touch this) -----
let tray = null;
const windows = new Map();   // displayId -> BrowserWindow
let brainWindow = null;      // separate 340x300 panel that shows spike flashes
let activeDisplayId = null;
let paused = false;
let brainVisible = true;

/**
 * The brain panel. Same shape as windows/main.js#createBrain: 340x300, top-right
 * of the primary display, dark background, closes by hide (tray keeps the app
 * alive). On Linux we never have a parent NSPanel to mimic, so this is just a
 * normal always-on-top window with no taskbar entry.
 * @param {Electron.Display} primary
 * @param {string} linuxDir
 */
export function createBrainWindow(primary, linuxDir) {
  const W = 340, H = 300;
  const win = new BrowserWindow({
    x: primary.workArea.x + primary.workArea.width - W - 18,
    y: primary.workArea.y + primary.workArea.height - H - 18,
    width: W,
    height: H,
    title: 'Fly Brain — FlyWire v783 (click = stimulate)',
    backgroundColor: '#080a10',
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: resolve(linuxDir, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenu(null);
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); brainVisible = false; refreshTray(); }
  });
  win.loadFile(resolve(linuxDir, 'renderer/brain.html'));
  win.once('ready-to-show', () => { if (brainVisible) win.show(); });
  return win;
}

// ----- IPC bridge: the renderer (windows/renderer/overlay.js, symlinked)
// expects 8 channels. Without them, its async IIFE rejects on
// `api.getBrainData()` and the scene stays empty (white PNG).
let brainData = null;       // FlyWire data; null on disk-miss → legacy fly
const idleSinceMs = () => powerMonitor.getSystemIdleTime() * 1000;
function pushAmbientToAll() {
  // The renderer uses ambient for: mouse pos, typing-level, sleep, tempo, activity.
  // Linux gives us system-idle time; we proxy it as typingLevel=0, sleepy=after idleMs.
  const idle = idleSinceMs();
  const sleepy = idle > cfgIdleMs;
  const ambient = {
    mouse: { x: 0, y: 0 },            // TODO: track real cursor (xdotool getmouselocation)
    typing: 0,                        // TODO: hook xkb / libinput key events
    sleepy,
    // tempo carries the user-controllable activity multiplier (default 1.0);
    // escapeRate multiplies the spontaneous-takeoff probability in renderer.
    tempo: cfgWalkSpeed,
    activity: 1.0,
    escapeRateMul: cfgEscapeRate,
    idleMs: cfgIdleMs,
  };
  for (const win of windows.values()) win.webContents.send('ambient', ambient);
}
setInterval(pushAmbientToAll, 500);

function pushRetargetToAll() {
  // The renderer uses retarget to size the ortho camera to the active display
  // and to know screen rectangles (for fly initial placement).
  const primary = screen.getPrimaryDisplay();
  const size = {
    width: primary.bounds.width,
    height: primary.bounds.height,
    screens: screen.getAllDisplays().map(d => ({
      id: d.id,
      x0: d.bounds.x, y0: d.bounds.y,
      x1: d.bounds.x + d.bounds.width,
      y1: d.bounds.y + d.bounds.height,
    })),
  };
  for (const win of windows.values()) win.webContents.send('retarget', size);
}

ipcMain.handle('brain-data', () => brainData);
// Overlay renderer pushes spike events on 'spikes'; we fan them out to the
// brain panel which subscribes via preload.mjs#onSpikes. Same wire as Windows.
ipcMain.on('spikes', (_e, list) => {
  if (brainWindow && !brainWindow.isDestroyed() && list && list.length) {
    brainWindow.webContents.send('spikes', list);
  }
});
// Brain window's click-to-stimulate -> forward to the overlay (the only one
// with the sim) so the user gets the same effect as Windows.
ipcMain.on('stimulate', (_e, req) => {
  for (const w of windows.values()) {
    if (!w.isDestroyed()) w.webContents.send('stimulate', req);
  }
});

async function run() {
  // Snapshot / brainshot short-circuit before we touch Tray or BrowserWindow.
  if (snapshotPath) return runSnapshot(snapshotPath);
  if (brainshotPath) return runBrainshot(brainshotPath);

  // Try to load the FlyWire data. On miss we fall through and the renderer
  // uses legacy distance-based behavior.
  try { brainData = loadBrainData(); } catch (e) {
    console.warn('[desktop-fly] no data/ found; running without brain:', e.message);
  }

  const allDisplays = screen.getAllDisplays();
  activeDisplayId = screen.getPrimaryDisplay().id;

  for (const d of allDisplays) {
    windows.set(d.id, createOverlayWindow(d, __dirname, d.id !== activeDisplayId));
  }

  // Brain panel mirrors the macOS/Windows one: a 340x300 dark window in the
  // bottom-right of the primary display. Only created when data was found —
  // without a brain there's nothing to render in there.
  if (brainData) brainWindow = createBrainWindow(screen.getPrimaryDisplay(), __dirname);

  // Send the display layout to every overlay so the ortho camera sizes right
  // and `addFly()` picks a starting point on a real monitor.
  pushRetargetToAll();
  screen.on('display-added', pushRetargetToAll);
  screen.on('display-removed', pushRetargetToAll);
  screen.on('display-metrics-changed', pushRetargetToAll);

  tray = new Tray(resolve(__dirname, 'assets/tray.png'));
  refreshTray();

  ipcMain.on('fly-moved-off-screen', () => moveToNextDisplay());

  // 0.7 Hz window terrain poll — same cadence as the Windows port.
  setInterval(async () => {
    try {
      const display = screen.getDisplayMatching(activeWindowBounds());
      const r = await sense.poll({
        x: display.bounds.x, y: display.bounds.y,
        width: display.bounds.width, height: display.bounds.height,
      });
      for (const win of windows.values()) {
        win.webContents.send('terrain', r);
      }
    } catch (e) {
      // sense.poll is best-effort; don't crash on transient errors.
    }
  }, 700);
}

function activeWindowBounds() {
  const allDisplays = screen.getAllDisplays();
  const d = allDisplays.find(x => x.id === activeDisplayId) ?? allDisplays[0];
  return d.bounds;
}

// Send a single command to every overlay window. The renderer's onCommand
// (preload.mjs#onCommand) handles the named actions — see windows/renderer/overlay.js.
function broadcastCmd(payload) {
  for (const w of windows.values()) {
    if (!w.isDestroyed()) w.webContents.send('cmd', payload);
  }
}

function togglePause() {
  paused = !paused;
  broadcastCmd({ name: 'pause', value: paused });
  refreshTray();
}

function toggleBrain() {
  brainVisible = !brainVisible;
  if (brainWindow && !brainWindow.isDestroyed()) {
    if (brainVisible) brainWindow.show(); else brainWindow.hide();
  }
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const allDisplays = screen.getAllDisplays();
  tray.setContextMenu(buildTrayMenu({
    onMove: moveToNextDisplay,
    onTogglePause: togglePause,
    onToggleBrain: toggleBrain,
    onAddFly: () => broadcastCmd({ name: 'addFly' }),
    onRemoveFly: () => broadcastCmd({ name: 'removeFly' }),
    onScare: () => broadcastCmd({ name: 'scareAll' }),
    onQuit: () => { app.isQuitting = true; app.quit(); },
    activeDisplayId,
    displayCount: allDisplays.length,
    paused,
    brainVisible,
  }));
}

function moveToNextDisplay() {
  const allDisplays = screen.getAllDisplays();
  if (allDisplays.length < 2) return;
  const idx = allDisplays.findIndex(d => d.id === activeDisplayId);
  const next = allDisplays[(idx + 1) % allDisplays.length];
  // Hide previous active, show new.
  windows.get(activeDisplayId)?.hide();
  windows.get(next.id)?.show();
  activeDisplayId = next.id;
  // 1) Per-monitor overlay geometry: the visible window's renderer re-anchors
  //    its camera to the new display bounds.
  for (const [id, win] of windows) {
    win.webContents.send('set-active-display', {
      id: next.id,
      bounds: next.bounds,
    });
  }
  // 2) Standard "flyToNextDisplay" cmd so the renderer's onCommand handler
  //    starts a flight to the next monitor (same wire as Windows).
  broadcastCmd({ name: 'flyToNextDisplay' });
  refreshTray();
}

// ----- Snapshot / brainshot paths (Phase 5) -----
// These are CLI-only and create a hidden offscreen window, render one
// frame, and write a PNG via capturePage().

async function runSnapshot(outPath) {
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      preload: resolve(__dirname, 'preload.mjs'),
      sandbox: false,
    },
    width: 720, height: 720,
  });
  // Pipe renderer console so we see the IIFE failure path.
  win.webContents.on('console-message', (_e, level, msg) => {
    console.log(`[renderer] ${msg}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('[renderer] gone:', d);
  });
  // Register brain-data so addFly() can resolve. (handler is global, only
  // set on first snapshot; this branch is fine for repeated runs.)
  if (!brainData) {
    try { brainData = loadBrainData(); } catch (e) {
      console.warn('[desktop-fly] no data/ for snapshot:', e.message);
    }
  }
  await win.loadFile(resolve(__dirname, 'renderer/overlay.html'));
  // Send a retarget with the window size so the ortho camera fits.
  win.webContents.send('retarget', {
    width: 720, height: 720,
    screens: [{ id: 0, x0: 0, y0: 0, x1: 720, y1: 720 }],
  });
  // Wait for the renderer's first paint AND give addFly() a few frames to land.
  await new Promise(r => setTimeout(r, 800));
  const img = await win.webContents.capturePage();
  await savePng(img, outPath);
  win.close();
  console.log(`snapshot written to ${outPath}`);
}

async function runBrainshot(outPath) {
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      preload: resolve(__dirname, 'preload.mjs'),
      sandbox: false,
    },
    width: 720, height: 560,
  });
  await win.loadFile(resolve(__dirname, 'renderer/brain.html'));
  await new Promise(r => win.webContents.once('paint', r));
  const img = await win.webContents.capturePage();
  await savePng(img, outPath);
  win.close();
  console.log(`brainshot written to ${outPath}`);
}

async function savePng(img, path) {
  // Electron's nativeImage has no fs write helper; write through Buffer.
  const buf = img.toPNG();
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path, buf);
}

// ----- Boot -----
if (typeof app.whenReady === 'function') {
  app.whenReady().then(() => {
    run().catch(e => {
      console.error('[desktop-fly] fatal:', e);
      app.exit(1);
    });
  });
}
