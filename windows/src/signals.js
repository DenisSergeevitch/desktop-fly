// signals.js — port of SignalBuilder from main.swift.
// Converts sim population rates into body commands. Shared by the app loop and
// the behavior test so both exercise the identical mapping.

import { clampf, lag } from './util.js';
import { makeSignals } from './sim.js';

export class SignalBuilder {
  constructor() { this.dnaBaseline = 0; }

  make(sim, dt) {
    const diff = sim.rateDNaL - sim.rateDNaR;
    // Slow adaptation (tau ~8 s): the connectome's persistent left/right
    // wiring asymmetry is adapted out, so steady-state walking is straight
    // and only transient DNa asymmetries (visual, stimulation) steer.
    this.dnaBaseline += (diff - this.dnaBaseline) * lag(1 / 8, dt);
    const s = makeSignals();
    s.escape = sim.consumeGF();
    s.nervous = clampf(sim.rateLoom / 80, 0, 1);
    s.turnBias = clampf((diff - this.dnaBaseline) * 0.04, -1.0, 1.0);
    s.backward = sim.rateMDN > 8;
    s.walkDrive = clampf(sim.rateFwd / 10, 0, 1.3);
    s.groomDrive = sim.rateGroom / 8;
    s.wingDrive = clampf(sim.rateEscW / 10, 0, 1.3);
    s.arousal = clampf(sim.ratePop / 20, 0, 1);
    return s;
  }
}
