import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignalBuilder, type RateSource } from './signals.ts';

function rates(over: Partial<RateSource> = {}): RateSource {
  return {
    rateLoom: 0, rateDNaL: 0, rateDNaR: 0, rateMDN: 0, rateFwd: 0,
    rateGroom: 0, rateEscW: 0, ratePop: 0, consumeGF: () => false, ...over,
  };
}

test('rates map onto body commands with the documented divisors', () => {
  const b = new SignalBuilder();
  const s = b.make(rates({
    rateLoom: 40, rateFwd: 5, rateGroom: 4, rateEscW: 5, ratePop: 10,
  }), 1 / 60);
  assert.equal(s.nervous, 0.5);       // 40 / 80
  assert.equal(s.walkDrive, 0.5);     // 5 / 10
  assert.equal(s.groomDrive, 0.5);    // 4 / 8
  assert.equal(s.wingDrive, 0.5);     // 5 / 10
  assert.equal(s.arousal, 0.5);       // 10 / 20
  assert.equal(s.tempo, 1);
  assert.equal(s.sleep, false);
});

test('every signal is clamped — an unclamped walkDrive once sent the fly to 1,100 pt/s', () => {
  const b = new SignalBuilder();
  const s = b.make(rates({
    rateLoom: 9999, rateFwd: 9999, rateGroom: 9999, rateEscW: 9999,
    ratePop: 9999,
  }), 1 / 60);
  assert.equal(s.nervous, 1);
  assert.equal(s.walkDrive, 1.3);
  assert.equal(s.groomDrive, 1.3);
  assert.equal(s.wingDrive, 1.3);
  assert.equal(s.arousal, 1);
});

test('the giant fiber latch passes straight through', () => {
  const b = new SignalBuilder();
  assert.equal(b.make(rates({ consumeGF: () => true }), 1 / 60).escape, true);
  assert.equal(b.make(rates(), 1 / 60).escape, false);
});

test('MDN drives backward walking only above 8 Hz', () => {
  const b = new SignalBuilder();
  assert.equal(b.make(rates({ rateMDN: 8 }), 1 / 60).backward, false);
  assert.equal(b.make(rates({ rateMDN: 8.1 }), 1 / 60).backward, true);
});

test('a transient DNa asymmetry steers; a persistent one is adapted out', () => {
  // The connectome has a standing left/right wiring asymmetry. Steady-state
  // walking must be straight, so only transients reach turnBias (tau ~8 s).
  const b = new SignalBuilder();
  const skewed = rates({ rateDNaL: 20, rateDNaR: 0 });
  const first = b.make(skewed, 1 / 60);
  assert.ok(first.turnBias > 0.5, 'the onset should steer hard');

  for (let i = 0; i < 60 * 40; i++) b.make(skewed, 1 / 60);   // 40 s
  const adapted = b.make(skewed, 1 / 60);
  assert.ok(Math.abs(adapted.turnBias) < 0.05,
    `persistent asymmetry not adapted out: ${adapted.turnBias}`);

  // and a fresh asymmetry on top of the adapted baseline still steers
  const flipped = b.make(rates({ rateDNaL: 0, rateDNaR: 20 }), 1 / 60);
  assert.ok(flipped.turnBias < -0.5, 'a new transient should still steer');
});

test('turnBias is clamped to +/-1', () => {
  const b = new SignalBuilder();
  const s = b.make(rates({ rateDNaL: 9999, rateDNaR: 0 }), 1 / 60);
  assert.equal(s.turnBias, 1);
});
