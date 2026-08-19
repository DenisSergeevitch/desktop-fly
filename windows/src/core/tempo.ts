// core/tempo.ts — locomotion tempo from machine load.
//
// SUBSTITUTION for ProcessInfo.thermalState (Environment.swift:91-99). Windows
// exposes no dependable thermal API — laptop ACPI thermal zones are frequently
// absent or simply wrong — so CPU busy fraction stands in, bucketed onto the
// same four steps the macOS build uses. Flies are ectotherms: on macOS a hot Mac
// is a fast fly; here a busy PC is. Document it as a substitution, never as a
// temperature reading.

export function tempoFromLoad(busy: number): number {
  if (!(busy > 0.25)) return 1.0;    // also catches NaN and negatives
  if (busy < 0.55) return 1.15;
  if (busy < 0.80) return 1.35;
  return 1.5;
}

interface CpuTimesLike {
  times: Record<string, number>;
}

export class CpuSampler {
  private prevBusy: number | null = null;
  private prevTotal = 0;

  // Pass os.cpus(). Returns the busy fraction since the previous call, or 0 for
  // the first call and for a zero-length interval.
  sample(cpus: CpuTimesLike[]): number {
    let busy = 0;
    let total = 0;
    for (const c of cpus) {
      for (const [k, v] of Object.entries(c.times)) {
        total += v;
        if (k !== 'idle') busy += v;
      }
    }
    if (this.prevBusy === null) {
      this.prevBusy = busy;
      this.prevTotal = total;
      return 0;
    }
    const dBusy = busy - this.prevBusy;
    const dTotal = total - this.prevTotal;
    this.prevBusy = busy;
    this.prevTotal = total;
    if (dTotal <= 0) return 0;
    return Math.min(1, Math.max(0, dBusy / dTotal));
  }
}
