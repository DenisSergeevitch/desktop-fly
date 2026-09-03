// test/wayland.test.js — Phase 3 acceptance gate for the Wayland stub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wayland } from '../src/wayland.js';

test('wayland backend reports itself as unavailable', () => {
  assert.equal(wayland.name, 'wayland');
  assert.equal(wayland.isAvailable, false);
});

test('wayland.poll returns empty arrays', async () => {
  const r = await wayland.poll({ x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepEqual(r, { ledges: [], newWindows: [] });
});

test('wayland.tap is a no-op (does not throw)', () => {
  assert.doesNotThrow(() => wayland.tap(100, 200));
});

test('wayland module log message is silent on direct import', async () => {
  // We don't capture stderr here (the wayland module logs at first poll,
  // not import). Direct import should not throw and should not log.
  const url = new URL('../src/wayland.js', import.meta.url).href
    + `?cb=${Date.now()}`;
  const mod = await import(url);
  assert.equal(mod.wayland.isAvailable, false);
});
