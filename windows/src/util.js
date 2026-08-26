// util.js — the small math helpers FlyModel.swift declares at file scope.

export function rnd(lo, hi) { return lo + Math.random() * (hi - lo); }

// Reference frame rate the existing constants were tuned at.
export const TUNED_HZ = 60;

// Frame-rate-independent form of the `Math.min(1, k * dt)` idiom used
// throughout flymodel.js, for both first-order lags and per-frame event
// probabilities.
//
// `k` keeps its original meaning, so call sites are unchanged: at dt = 1/60
// this returns exactly `k/60`, the value the constants were tuned against.
// Away from 60 Hz it follows the geometric decay those constants imply instead
// of the straight line, which is what made behaviour drift with refresh rate —
// at the 50 ms dt cap in overlay.js the old form converged 27% too fast
// (0.50 vs 0.39 for k = 10).
//
// Writing it as `1 - exp(-k*dt)` would also be frame-rate independent, but it
// is a *different* continuous process: it would change the 60 Hz behaviour by
// 2-8% across the k values used here. This form is the one that leaves 60 Hz
// alone.
export function lag(k, dt) {
  const perFrame = Math.min(1, k / TUNED_HZ);
  if (perFrame >= 1) return 1;
  return 1 - Math.pow(1 - perFrame, TUNED_HZ * dt);
}

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
