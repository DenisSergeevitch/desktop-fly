// What the brain tells the body each frame. Transliterated from Sim.swift:9-20.
export interface BrainSignals {
  escape: boolean;      // giant fiber spiked -> takeoff NOW
  nervous: number;      // looming-detector population rate, 0..1
  turnBias: number;     // rad/s steering from DNa01/DNa02 left-right difference
  backward: boolean;    // MDN burst -> backward walking
  walkDrive: number;    // DNp09 forward-walking command rate, ~0..1.5
  groomDrive: number;   // DNg11 grooming command rate, ~0..1.5
  wingDrive: number;    // DNp02/04/11 escape-maneuver DN rate, ~0..1.3
  arousal: number;      // whole-population activity, ~0..1
  tempo: number;        // thermal "temperature" scaling of locomotion
  sleep: boolean;       // circadian + idle -> sleep-like state
}

export function defaultSignals(): BrainSignals {
  return {
    escape: false, nervous: 0, turnBias: 0, backward: false, walkDrive: 0,
    groomDrive: 0, wingDrive: 0, arousal: 0, tempo: 1, sleep: false,
  };
}

// A walkable window top edge, in scene coordinates (origin at screen center).
// Environment.swift:9-14.
export interface Ledge {
  readonly y: number;
  readonly x0: number;
  readonly x1: number;
  readonly id: number;
}
