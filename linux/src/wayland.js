// src/wayland.js — Wayland v1 stub.
//
// Foreign-toplevel management on Wayland requires a DBus daemon (e.g. the
// wlrobes / wlr-foreign-toplevel wrapper) that we do not ship in v1. The
// stub is a documented no-op; the planned DBus bridge is tracked in
// docs/ubuntu.md §"Future work".

import { SENSE_KIND } from './sense-types.js';

let logged = false;
function infoOnce() {
  if (logged) return;
  logged = true;
  // One-line, single-emit. main.js also surfaces this in the stderr banner.
  console.error('[desktop-fly] Wayland window list: no-op stub (planned DBus bridge; see docs/ubuntu.md)');
}

async function poll() {
  infoOnce();
  return { ledges: [], newWindows: [] };
}

function tap() {
  // Wayland deliberately withholds global pointer position from clients for
  // security. Without the DBus bridge we cannot synthesize a tap; the cursor
  // monitor inside the renderer's three.js scene handles cursor-based sense.
}

export const wayland = {
  name: SENSE_KIND.WAYLAND,
  isAvailable: false,
  poll,
  tap,
};
