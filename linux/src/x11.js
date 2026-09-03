// src/x11.js — X11 window-list sense, shell-out to xprop/xdotool.
//
// Returns the same {ledges, newWindows} shape the macOS port's
// CGWindowListCopyWindowInfo + the Windows port's EnumWindows produce.
// All data is plain JS objects — no native handles cross the boundary.
//
// Graceful degrade: if xprop is missing (CI box, minimal install) the
// backend returns empty arrays and isAvailable flips to false on first poll.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SENSE_KIND } from './sense-types.js';

const exec = promisify(execFile);

let helpersAvailable = null;
let warnedNoXprop = false;
let seenIDs = null;   // first-poll initialization

/** @returns {Promise<{xprop:boolean, xdotool:boolean}>} */
async function detect() {
  if (helpersAvailable) return helpersAvailable;
  const out = { xprop: false, xdotool: false };
  for (const bin of Object.keys(out)) {
    try {
      await exec('which', [bin]);
      out[bin] = true;
    } catch { /* missing */ }
  }
  helpersAvailable = out;
  return out;
}

async function warnOnce() {
  if (warnedNoXprop) return;
  warnedNoXprop = true;
  console.error('[desktop-fly] xprop not found; window ledges disabled. apt install x11-utils to enable.');
}

/**
 * Parse `xprop -root _NET_CLIENT_LIST` output.
 * Format: "_NET_CLIENT_LIST(WINDOW): window id # 0x800012, 0x800013"
 * @param {string} stdout
 * @returns {number[]} hex window ids as integers
 */
function parseClientList(stdout) {
  const ids = [];
  const re = /0x([0-9a-fA-F]+)/g;
  let m;
  while ((m = re.exec(stdout)) !== null) {
    ids.push(parseInt(m[1], 16));
  }
  return ids;
}

/**
 * Run `xprop -id <wid> <attrs>` and return trimmed stdout (or "" on failure).
 */
async function readProps(wid, ...attrs) {
  try {
    const { stdout } = await exec('xprop', ['-id', `0x${wid.toString(16)}`, ...attrs]);
    return stdout.trim();
  } catch {
    return '';
  }
}

/**
 * Skip docks, panels, menus, splash, utility windows.
 * @param {string} stdout from `xprop ... _NET_WM_WINDOW_TYPE`
 */
function isNormalWindow(stdout) {
  if (!stdout) return true;     // if the property is missing, treat as normal
  if (stdout.includes('_NET_WM_WINDOW_TYPE_NORMAL')) return true;
  return false;
}

/**
 * Parse a geometry reply from `xwininfo -id <wid>`. Returns null on failure.
 * The first lines look like:
 *   xwininfo: Window id: 0x800012 "title"
 *   Absolute upper-left X:  100
 *   Absolute upper-left Y:  200
 *   Width: 800
 *   Height: 600
 */
async function readGeometry(wid) {
  try {
    const { stdout } = await exec('xwininfo', ['-id', `0x${wid.toString(16)}`]);
    const out = { x: 0, y: 0, width: 0, height: 0 };
    for (const line of stdout.split('\n')) {
      const m = line.match(/Absolute upper-left X:\s+(-?\d+)/); if (m) out.x = +m[1];
      const m2 = line.match(/Absolute upper-left Y:\s+(-?\d+)/); if (m2) out.y = +m2[1];
      const m3 = line.match(/^Width:\s+(\d+)/); if (m3) out.width = +m3[1];
      const m4 = line.match(/^Height:\s+(\d+)/); if (m4) out.height = +m4[1];
    }
    return (out.width > 0 && out.height > 0) ? out : null;
  } catch {
    return null;
  }
}

/**
 * @param {{x:number,y:number,width:number,height:number}} display
 * @returns {Promise<import('./sense-types.js').PollResult>}
 */
async function poll(display) {
  const h = await detect();
  if (!h.xprop) {
    isAvailable = false;
    await warnOnce();
    if (seenIDs === null) seenIDs = new Set();
    return { ledges: [], newWindows: [] };
  }
  isAvailable = true;

  let clientList = '';
  try {
    const { stdout } = await exec('xprop', ['-root', '_NET_CLIENT_LIST']);
    clientList = stdout;
  } catch {
    return { ledges: [], newWindows: [] };
  }
  const ids = parseClientList(clientList);

  // First call: snapshot the current set so we don't false-alarm.
  if (seenIDs === null) seenIDs = new Set();

  const newWindows = [];
  for (const id of ids) {
    if (!seenIDs.has(id)) newWindows.push({ id, isNew: true });
  }
  // Persist for next call. The next call's "new" set will be empty unless
  // the world changed in between.
  const knownBefore = new Set(seenIDs);
  for (const id of ids) seenIDs.add(id);

  // Build ledges for normal windows on the fly's current display.
  // Origin: X11 reports top-left-of-primary, y down. We want bottom-left-of-
  // screen, y up, origin at the display center — same as the macOS port.
  const ledges = [];
  const primaryH = display.height;  // best effort; Xinerama-aware would
                                    // need xrandr; Phase 4 wires Electron's
                                    // screen.getDisplayMatching(rect) for that.
  const W = display.width, H = display.height;

  for (const id of ids) {
    const [wmType, geom] = await Promise.all([
      readProps(id, '_NET_WM_WINDOW_TYPE'),
      readGeometry(id),
    ]);
    if (!isNormalWindow(wmType)) continue;
    if (!geom) continue;
    // Filter: only windows the fly can plausibly walk on. Same constants
    // as the macOS port (Environment.swift).
    if (geom.width < 160 || geom.height < 60) continue;
    // Only windows on the fly's current display.
    const cx = geom.x + geom.width / 2;
    const cy = geom.y + geom.height / 2;
    if (cx < display.x - 50 || cx > display.x + display.width + 50) continue;
    if (cy < display.y - 50 || cy > display.y + display.height + 50) continue;
    // Scene coords: bottom-left-of-screen, y up, origin at display center.
    const topY = (primaryH - geom.y) - display.y - H / 2;
    const x0 = Math.max(geom.x - display.x - W / 2, -W / 2 + 15);
    const x1 = Math.min((geom.x + geom.width) - display.x - W / 2, W / 2 - 15);
    if (topY > H / 2 - 8 || topY < -H / 2 + 8) continue;
    if (x1 - x0 < 100) continue;
    if (ledges.length >= 12) break;
    ledges.push({ y: topY, x0, x1, id });
  }

  // newWindows: convert to {center, size} for the body layer. We exclude
  // the very first call by the seenIDs guard above.
  const out = [];
  for (const nw of newWindows) {
    const geom = await readGeometry(nw.id);
    if (!geom) continue;
    if (!knownBefore.has(nw.id)) {
      out.push({
        center: {
          x: geom.x + geom.width / 2 - display.x - display.width / 2,
          y: (primaryH - (geom.y + geom.height / 2)) - display.y - display.height / 2,
        },
        size: Math.max(geom.width, geom.height),
      });
    }
  }
  return { ledges, newWindows: out };
}

function tap(x, y) {
  // xdotool can synthesize a click at screen coordinates; the Wayland stub
  // does not, by design. We deliberately do nothing here if xdotool is
  // missing rather than fail the whole render loop.
  if (!helpersAvailable?.xdotool) return;
  exec('xdotool', ['mousemove', '--screen', '0', String(x), String(y), 'click', '1'])
    .catch(() => { /* best effort */ });
}

let isAvailable = true;

export const x11 = {
  name: SENSE_KIND.X11,
  isAvailable,
  poll,
  tap,
};
