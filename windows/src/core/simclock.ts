// core/simclock.ts — converts variable frame times into whole milliseconds of
// 1 kHz simulation, from main.swift:670-672.
//
// The 50 ms/frame ceiling is what stops the sim chasing a stalled render thread:
// after a hitch, sim time deliberately falls behind wall time rather than
// running a burst of catch-up steps.
//
// DELIBERATE DIVERGENCE from Swift: the surplus beyond the clamp is discarded
// rather than left in the accumulator. Swift banks it, so a 2 s stall would
// drain over the following 40 frames at 50 ms each — which is exactly the
// runaway the clamp exists to prevent. Discarding matches the clamp's intent.
const MAX_MS_PER_FRAME = 50;

export class SimClock {
  private accumulator = 0;

  reset(): void {
    this.accumulator = 0;
  }

  advance(dt: number): number {
    if (dt <= 0) return 0;
    this.accumulator += dt * 1000;
    const steps = Math.min(MAX_MS_PER_FRAME, Math.floor(this.accumulator));
    if (steps <= 0) return 0;
    this.accumulator -= steps;
    if (this.accumulator > MAX_MS_PER_FRAME) this.accumulator = 0;   // drop surplus
    return steps;
  }
}
