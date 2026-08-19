// util.js — the small math helpers FlyModel.swift declares at file scope.

export function rnd(lo, hi) { return lo + Math.random() * (hi - lo); }

export function clampf(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export function angleDiff(from, to) {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function smoothstep(t) {
  const x = clampf(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function hypot(x, y) { return Math.hypot(x, y); }

// Swift's truncatingRemainder keeps the sign of the dividend, like JS %.
export function fmod(a, b) { return a % b; }
