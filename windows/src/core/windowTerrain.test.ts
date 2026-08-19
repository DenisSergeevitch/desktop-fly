import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WindowTerrain, type RawWindow } from './windowTerrain.ts';

// A 1920x1080 primary display at the origin: scene centre is screen (960, 540).
const DISPLAY = { x: 0, y: 0, width: 1920, height: 1080 };

function win(over: Partial<RawWindow> = {}): RawWindow {
  return {
    id: 1, x: 400, y: 300, width: 800, height: 600,
    visible: true, toolWindow: false, cloaked: false,
    hasTitle: true, ownProcess: false, ...over,
  };
}

test('a normal window top edge becomes a ledge in scene coordinates', () => {
  const t = new WindowTerrain();
  const snap = t.poll([win()], DISPLAY);
  assert.equal(snap.ledges.length, 1);
  const L = snap.ledges[0];
  // screen y 300 is 240 above the centre line (540 - 300)
  assert.equal(L.y, 240);
  // x 400..1200 in screen space is -560..240 relative to centre 960
  assert.equal(L.x0, -560);
  assert.equal(L.x1, 240);
  assert.equal(L.id, 1);
});

test('windows that must be ignored are ignored', () => {
  const t = new WindowTerrain();
  const cases: Array<[string, Partial<RawWindow>]> = [
    ['invisible', { visible: false }],
    ['tool window', { toolWindow: true }],
    ['cloaked (a background UWP app)', { cloaked: true }],
    ['untitled', { hasTitle: false }],
    ['our own overlay', { ownProcess: true }],
    ['too narrow', { width: 100 }],
    ['too short', { height: 40 }],
  ];
  for (const [why, over] of cases) {
    assert.equal(t.poll([win(over)], DISPLAY).ledges.length, 0,
      `should skip: ${why}`);
  }
});

test('windows off this display are ignored', () => {
  const t = new WindowTerrain();
  // entirely to the right of a 1920-wide display
  assert.equal(t.poll([win({ x: 2400 })], DISPLAY).ledges.length, 0);
  // and a second display's window is picked up when that display is active
  const second = { x: 1920, y: 0, width: 1920, height: 1080 };
  const snap = new WindowTerrain().poll([win({ x: 2400 })], second);
  assert.equal(snap.ledges.length, 1);
});

test('ledges are clipped to the display with a 15 pt inset', () => {
  const t = new WindowTerrain();
  // a window wider than the screen
  const snap = t.poll([win({ x: -500, width: 3000 })], DISPLAY);
  assert.equal(snap.ledges[0].x0, -1920 / 2 + 15);
  assert.equal(snap.ledges[0].x1, 1920 / 2 - 15);
});

test('edges too close to the top or bottom of the screen are skipped', () => {
  const t = new WindowTerrain();
  // top edge above the visible band (scene y >= H/2 - 8 = 532)
  assert.equal(t.poll([win({ y: 2 })], DISPLAY).ledges.length, 0);
  // and one below it
  assert.equal(t.poll([win({ y: 1078, height: 600 })], DISPLAY).ledges.length, 0);
});

test('a ledge narrower than 100 pt is not walkable', () => {
  const t = new WindowTerrain();
  assert.equal(t.poll([win({ width: 170 })], DISPLAY).ledges.length, 1);
  // 160 is the minimum window width, but after clipping a near-edge window can
  // leave under 100 pt of walkable span
  const clipped = t.poll([win({ x: 1830, width: 200 })], DISPLAY);
  assert.equal(clipped.ledges.length, 0);
});

test('at most 12 ledges are reported', () => {
  const t = new WindowTerrain();
  const many = Array.from({ length: 30 },
    (_, i) => win({ id: i + 1, y: 200 + i * 10 }));
  assert.equal(t.poll(many, DISPLAY).ledges.length, 12);
});

test('the first poll reports no new windows, later polls do', () => {
  const t = new WindowTerrain();
  // Environment.swift:58 — the first poll must not treat every existing window
  // as having just appeared, or the fly panics the moment it starts.
  assert.equal(t.poll([win({ id: 1 })], DISPLAY).newWindows.length, 0);
  assert.equal(t.poll([win({ id: 1 })], DISPLAY).newWindows.length, 0);
  const appeared = t.poll([win({ id: 1 }), win({ id: 2 })], DISPLAY);
  assert.equal(appeared.newWindows.length, 1);
  // centre in scene coordinates, and size = the longer edge
  assert.equal(appeared.newWindows[0].center.x, 400 + 400 - 960);
  assert.equal(appeared.newWindows[0].center.y, 540 - (300 + 300));
  assert.equal(appeared.newWindows[0].size, 800);
});

test('a window that closes and reopens counts as new again', () => {
  const t = new WindowTerrain();
  t.poll([win({ id: 1 }), win({ id: 2 })], DISPLAY);
  t.poll([win({ id: 1 })], DISPLAY);                    // 2 closed
  const back = t.poll([win({ id: 1 }), win({ id: 2 })], DISPLAY);
  assert.equal(back.newWindows.length, 1);
});

test('new windows are reported even when they are not walkable', () => {
  // A small dialog cannot be stood on, but it still looms.
  const t = new WindowTerrain();
  t.poll([win({ id: 1 })], DISPLAY);
  // 120x90 is under the 160x60 minimum, so it can never be a ledge
  const snap = t.poll([win({ id: 1 }), win({ id: 9, width: 120, height: 90 })],
    DISPLAY);
  assert.equal(snap.ledges.filter((l) => l.id === 9).length, 0);
  assert.equal(snap.newWindows.length, 1);
});
