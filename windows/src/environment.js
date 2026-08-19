// environment.js — the permission-free "senses" that are pure computation.
// The Windows-specific ones (window terrain, user idle, taps, typing) live in
// win32.js and main.js, because they need Win32 / Electron APIs.

import os from 'node:os';

// A walkable window top edge, in scene coordinates (origin at screen center).
export function makeLedge(y, x0, x1, id) { return { y, x0, x1, id }; }

// Drosophila circadian activity: morning and evening peaks, midday siesta,
// night quiescence. Returns a multiplier for the sim's baseline drive.
export function circadianActivity(hour) {
  const pts = [[0, 0.25], [5, 0.25], [8, 1.0], [10, 1.0], [13, 0.55],
               [15, 0.55], [17, 1.0], [20, 1.0], [23, 0.3], [24, 0.25]];
  for (let i = 0; i < pts.length - 1; i++) {
    if (hour >= pts[i][0] && hour <= pts[i + 1][0]) {
      const t = (hour - pts[i][0]) / Math.max(0.001, pts[i + 1][0] - pts[i][0]);
      return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
    }
  }
  return 0.25;
}

// Flies are ectotherms: a hot machine is a fast fly. macOS reads
// ProcessInfo.thermalState; Windows has no equivalent that works without
// vendor drivers, so overall CPU load stands in for "how hard is this box
// working" — the same 1.0 .. 1.5 range the Swift version produces.
export class ThermalTempo {
  constructor() { this.prev = this._sample(); this.load = 0; }

  _sample() {
    let idle = 0, total = 0;
    for (const c of os.cpus()) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    return { idle, total };
  }

  // Call at a slow, steady rate (the app polls at 30 Hz alongside the mouse).
  poll() {
    const s = this._sample();
    const dTotal = s.total - this.prev.total;
    const dIdle = s.idle - this.prev.idle;
    if (dTotal > 0) {
      const busy = Math.min(1, Math.max(0, 1 - dIdle / dTotal));
      this.load += (busy - this.load) * 0.1;   // slow, like a thermal mass
      this.prev = s;
    }
    if (this.load < 0.15) return 1.0;   // nominal
    if (this.load < 0.40) return 1.15;  // fair
    if (this.load < 0.70) return 1.35;  // serious
    return 1.5;                          // critical
  }
}
