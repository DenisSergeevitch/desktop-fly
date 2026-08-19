// Converts sim population rates into body commands. Shared by the app loop and
// the diagnostic suites so both exercise the identical mapping.
//
// Takes a structural RateSource rather than a concrete LIFSim so the mapping is
// testable against a plain object — see the plan's "Intentional deviations".
// Transliterated from main.swift:459-483.

import { clampf } from './mathutil.ts';
import { defaultSignals, type BrainSignals } from './types.ts';

export interface RateSource {
  rateLoom: number;
  rateDNaL: number;
  rateDNaR: number;
  rateMDN: number;
  rateFwd: number;
  rateGroom: number;
  rateEscW: number;
  ratePop: number;
  consumeGF(): boolean;
}

export class SignalBuilder {
  private dnaBaseline = 0;

  make(sim: RateSource, dt: number): BrainSignals {
    const diff = sim.rateDNaL - sim.rateDNaR;
    // Slow adaptation (tau ~8 s): the connectome's persistent left/right
    // wiring asymmetry is adapted out, so steady-state walking is straight and
    // only transient DNa asymmetries (visual, stimulation) steer.
    this.dnaBaseline += (diff - this.dnaBaseline) * Math.min(1, dt / 8);

    const s = defaultSignals();
    s.escape = sim.consumeGF();
    s.nervous = clampf(sim.rateLoom / 80, 0, 1);
    s.turnBias = clampf((diff - this.dnaBaseline) * 0.04, -1.0, 1.0);
    s.backward = sim.rateMDN > 8;
    s.walkDrive = clampf(sim.rateFwd / 10, 0, 1.3);
    // Swift leaves groomDrive unclamped; clamped here for consistency with its
    // five siblings. Behaviorally inert — groomDrive is only compared against
    // the 0.5/0.3 hysteresis thresholds, never scaled.
    s.groomDrive = clampf(sim.rateGroom / 8, 0, 1.3);
    s.wingDrive = clampf(sim.rateEscW / 10, 0, 1.3);
    s.arousal = clampf(sim.ratePop / 20, 0, 1);
    return s;
  }
}
