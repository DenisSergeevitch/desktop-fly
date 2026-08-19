// Small numeric helpers. `angleDiff` and `smoothstep` (FlyModel.swift:16-22)
// arrive with the body port in M2; M1 needs only these.

export function clampf(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export type Rng = () => number;

// mulberry32. Swift uses a non-deterministic SystemRandomNumberGenerator;
// a seeded PRNG makes the invariant suites reproducible. See the plan's
// "Intentional deviations" section.
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Half-open [lo, hi), matching Swift's `Float.random(in: lo..<hi)` usage.
export function rnd(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

// FlyModel.swift:16-21 — shortest signed turn from one heading to another.
export function angleDiff(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

// FlyModel.swift:22
export function smoothstep(t: number): number {
  const x = clampf(t, 0, 1);
  return x * x * (3 - 2 * x);
}
