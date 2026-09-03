// test/x11.test.js — Phase 3 acceptance gate for the X11 window-list sense.
//
// The whole suite is a no-op if xprop is not on PATH (CI, minimal hosts).
// Locally on Ubuntu 24.04 xprop is in x11-utils; apt install x11-utils.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { x11 } from '../src/x11.js';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const linux = resolve(here, '..');

let xpropOk = false;
try {
  await exec('which', ['xprop']);
  xpropOk = true;
} catch { /* not on PATH; tests below are skipped */ }

test('x11 backend reports its name', () => {
  assert.equal(x11.name, 'x11');
  assert.equal(typeof x11.poll, 'function');
  assert.equal(typeof x11.tap, 'function');
});

test('x11 backend isAvailable reflects helper presence', async () => {
  await x11.poll({ x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(x11.isAvailable, xpropOk,
    `isAvailable should be ${xpropOk} when xprop is ${xpropOk ? 'present' : 'absent'}`);
});

test('x11.poll returns {ledges, newWindows} shape', async () => {
  const r = await x11.poll({ x: 0, y: 0, width: 1920, height: 1080 });
  assert.ok(Array.isArray(r.ledges), 'ledges not an array');
  assert.ok(Array.isArray(r.newWindows), 'newWindows not an array');
  for (const l of r.ledges) {
    assert.equal(typeof l.y, 'number');
    assert.equal(typeof l.x0, 'number');
    assert.equal(typeof l.x1, 'number');
    assert.ok(l.x1 > l.x0, `ledge x1<=x0: ${l.x1} <= ${l.x0}`);
  }
});

test('x11.poll without xprop is a graceful no-op', async () => {
  if (xpropOk) return;   // only meaningful when xprop is missing
  const r = await x11.poll({ x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(r, { ledges: [], newWindows: [] });
  assert.equal(x11.isAvailable, false);
});

test('x11.poll does not produce newWindows on first call (cold start)', async () => {
  if (!xpropOk) return;
  // Build a fresh module so the first-poll guard is exercised.
  const url = `file://${linux}/src/x11.js?cb=${Date.now()}_${Math.random()}`;
  const mod = await import(url);
  const r = await mod.x11.poll({ x: 0, y: 0, width: 1920, height: 1080 });
  // On first poll the seen-IDs set is initialized; newWindows should be 0.
  assert.equal(r.newWindows.length, 0,
    `first poll should report no newWindows, got ${r.newWindows.length}`);
});
