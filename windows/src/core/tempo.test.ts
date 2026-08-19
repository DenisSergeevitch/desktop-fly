import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CpuSampler, tempoFromLoad } from './tempo.ts';

test('load maps onto the same four steps as macOS thermal state', () => {
  // Environment.swift:91-99 — nominal / fair / serious / critical.
  assert.equal(tempoFromLoad(0), 1.0);
  assert.equal(tempoFromLoad(0.1), 1.0);
  assert.equal(tempoFromLoad(0.4), 1.15);
  assert.equal(tempoFromLoad(0.7), 1.35);
  assert.equal(tempoFromLoad(0.95), 1.5);
  // out-of-range input must still land on a valid step
  assert.equal(tempoFromLoad(-1), 1.0);
  assert.equal(tempoFromLoad(99), 1.5);
});

test('tempo is monotonic in load', () => {
  let prev = 0;
  for (let x = 0; x <= 1; x += 0.02) {
    const t = tempoFromLoad(x);
    assert.ok(t >= prev, `tempo dropped at load ${x}`);
    prev = t;
  }
});

function cpus(user: number, idle: number) {
  return [{ times: { user, nice: 0, sys: 0, idle, irq: 0 } }];
}

test('the first sample has no previous reading and reports no load', () => {
  const s = new CpuSampler();
  assert.equal(s.sample(cpus(1000, 9000)), 0);
});

test('busy fraction comes from the delta between samples', () => {
  const s = new CpuSampler();
  s.sample(cpus(1000, 9000));
  // 500 ms more busy, 500 ms more idle => 50% busy
  assert.ok(Math.abs(s.sample(cpus(1500, 9500)) - 0.5) < 1e-9);
  // fully busy
  assert.ok(Math.abs(s.sample(cpus(2500, 9500)) - 1) < 1e-9);
  // fully idle
  assert.ok(Math.abs(s.sample(cpus(2500, 10500)) - 0) < 1e-9);
});

test('an identical sample reports no load rather than dividing by zero', () => {
  const s = new CpuSampler();
  const c = cpus(1000, 9000);
  s.sample(c);
  assert.equal(s.sample(c), 0);
});
