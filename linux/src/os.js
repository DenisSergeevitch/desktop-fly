// src/os.js — Linux-only dispatcher: x11 | wayland | headless.
//
// Importing this module on a non-Linux platform throws — the linux/ tree
// is paired with main.js, which short-circuits before we get here on
// macOS/Windows. koffi is never required on Linux; the koffi-using win32.js
// is only reachable from windows/main.js.

import { platform } from 'node:process';
import { SENSE_KIND } from './sense-types.js';

if (platform !== 'linux') {
  throw new Error(`os.js is linux-only; got platform=${platform}`);
}

/**
 * Decide which backend to use. Detection is intentionally trivial — env vars
 * set by the user's login session. We do not shell out to loginctl; the
 * session-type env vars are set by every mainstream DE (GNOME, KDE, Sway,
 * Hyprland) and are correct 99% of the time. The 1% case is a user running
 * `npm start` over SSH with no forwarded display: we fall into the headless
 * branch and the test suites still pass.
 */
function pickBackend() {
  if (process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland') {
    return SENSE_KIND.WAYLAND;
  }
  if (process.env.DISPLAY) {
    return SENSE_KIND.X11;
  }
  return SENSE_KIND.HEADLESS;
}

let cached = null;
async function load() {
  if (cached) return cached;
  const which = pickBackend();
  let mod;
  switch (which) {
    case SENSE_KIND.X11:
      mod = await import('./x11.js');
      break;
    case SENSE_KIND.WAYLAND:
      mod = await import('./wayland.js');
      break;
    default:
      mod = { headless: headlessBackend() };
  }
  cached = { backendName: which, sense: mod[which] ?? mod.headless };
  return cached;
}

function headlessBackend() {
  return {
    name: SENSE_KIND.HEADLESS,
    isAvailable: false,
    async poll() { return { ledges: [], newWindows: [] }; },
    tap() {},
  };
}

// Eagerly resolve so the export is a real `SenseBackend`, not a Promise.
// This is what main.js consumes.
const { backendName, sense } = await load();

export { backendName, sense };
