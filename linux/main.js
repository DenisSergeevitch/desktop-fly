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
let activeDisplayId = null;
let paused = false;
let brainVisible = true;

async function run() {
  // Snapshot / brainshot short-circuit before we touch Tray or BrowserWindow.
  if (snapshotPath) return runSnapshot(snapshotPath);
  if (brainshotPath) return runBrainshot(brainshotPath);

  const allDisplays = screen.getAllDisplays();
  activeDisplayId = screen.getPrimaryDisplay().id;

  for (const d of allDisplays) {
    windows.set(d.id, createOverlayWindow(d, __dirname, d.id !== activeDisplayId));
  }

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

function refreshTray() {
  if (!tray) return;
  const allDisplays = screen.getAllDisplays();
  tray.setContextMenu(buildTrayMenu({
    onMove: moveToNextDisplay,
    onTogglePause: () => { paused = !paused; refreshTray(); },
    onToggleBrain: () => { brainVisible = !brainVisible; refreshTray(); },
    onAddFly: () => {},
    onRemoveFly: () => {},
    onScare: () => {},
    onQuit: () => app.quit(),
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
  // Tell the renderer to re-anchor the camera to the new bounds.
  for (const [id, win] of windows) {
    win.webContents.send('set-active-display', {
      id: next.id,
      bounds: next.bounds,
    });
  }
  refreshTray();
}

// ----- Snapshot / brainshot paths (Phase 5) -----
// These are CLI-only and create a hidden offscreen window, render one
// frame, and write a PNG via capturePage().

async function runSnapshot(outPath) {
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, contextIsolation: true },
    width: 720, height: 720,
  });
  await win.loadFile(resolve(__dirname, 'renderer/overlay.html'));
  await new Promise(r => win.webContents.once('paint', r));
  const img = await win.webContents.capturePage();
  await img.toPNG();   // nativeImage has no fs API; we serialize through savePNG
  await savePng(img, outPath);
  win.close();
  console.log(`snapshot written to ${outPath}`);
}

async function runBrainshot(outPath) {
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, contextIsolation: true },
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
