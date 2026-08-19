// Drosophila circadian activity: morning and evening peaks, midday siesta,
// night quiescence. Returns a multiplier for the sim's baseline drive.
// Transliterated from Environment.swift:70-80.
//
// Never apply this to LIFSim baselines linearly — neurons rest just below
// threshold, so a raw multiplier silences the network (the "siesta coma" bug).
// The coordinator compresses it toward 1 before use.
const KNOTS: Array<[number, number]> = [
  [0, 0.25], [5, 0.25], [8, 1.0], [10, 1.0], [13, 0.55],
  [15, 0.55], [17, 1.0], [20, 1.0], [23, 0.3], [24, 0.25],
];

export function circadianActivity(hour: number): number {
  for (let i = 0; i < KNOTS.length - 1; i++) {
    const [h0, a0] = KNOTS[i];
    const [h1, a1] = KNOTS[i + 1];
    if (hour >= h0 && hour <= h1) {
      const t = (hour - h0) / Math.max(0.001, h1 - h0);
      return a0 + (a1 - a0) * t;
    }
  }
  return 0.25;
}
