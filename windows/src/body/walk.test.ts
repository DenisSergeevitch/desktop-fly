import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fly, asFlyState } from './fly.ts';
import { defaultSignals, type Ledge } from '../core/types.ts';
import { Arena, toSceneRects } from '../core/arena.ts';

const BOUNDS = { width: 1512, height: 982 };
const DT = 1 / 60;

function walkSignals() {
  const s = defaultSignals();
  s.walkDrive = 0.6;
  return s;
}

test('the fly attaches to a window edge and follows it', () => {
  // main.swift:316-325
  const fly = new Fly({ x: 0, y: -55 }, 1);
  fly.state = asFlyState('walking');
  fly.speed = 30;
  fly.heading = 0;
  fly.terrain = [{ y: -40, x0: -300, x1: 300, id: 1 }];
  let attached = false;
  for (let i = 0; i < 240; i++) {
    fly.update(DT, BOUNDS, null, walkSignals());
    if (fly.ledge !== null && Math.abs(fly.pos.y + 40) < 8) {
      attached = true;
      break;
    }
  }
  assert.ok(attached, `state=${fly.state} y=${fly.pos.y} ledge=${fly.ledge}`);
});

test('a window closing underfoot launches a flight', () => {
  // main.swift:327-338
  const fly = new Fly({ x: 0, y: -40 }, 1);
  fly.state = asFlyState('walking');
  fly.speed = 25;
  fly.heading = 0;
  const L: Ledge = { y: -40, x0: -300, x1: 300, id: 1 };
  fly.terrain = [L];
  fly.ledge = L;
  fly.terrain = [];                 // the window vanished
  let tookOff = false;
  for (let i = 0; i < 60; i++) {
    fly.update(DT, BOUNDS, null, walkSignals());
    if (fly.state === 'flying') {
      tookOff = true;
      break;
    }
  }
  assert.ok(tookOff, `state=${fly.state}`);
});

test('walking along a ledge stays within its x range', () => {
  const fly = new Fly({ x: 0, y: -40 }, 1);
  fly.state = asFlyState('walking');
  fly.speed = 120;
  fly.heading = 0;
  const L: Ledge = { y: -40, x0: -100, x1: 100, id: 7 };
  fly.terrain = [L];
  fly.ledge = L;
  for (let i = 0; i < 600; i++) {
    fly.update(DT, BOUNDS, null, walkSignals());
    if (fly.ledge === null) break;         // wandering off is allowed
    assert.ok(fly.pos.x >= L.x0 - 1e-6 && fly.pos.x <= L.x1 + 1e-6,
      `x ${fly.pos.x} left the ledge`);
  }
});

test('a dragged window carries the fly with it', () => {
  const fly = new Fly({ x: 0, y: -40 }, 1);
  fly.state = asFlyState('walking');
  fly.speed = 10;
  fly.heading = 0;
  fly.terrain = [{ y: -40, x0: -300, x1: 300, id: 3 }];
  fly.ledge = fly.terrain[0];
  // same window id, moved up 30 pt (within the 40 pt tolerance)
  fly.terrain = [{ y: -10, x0: -300, x1: 300, id: 3 }];
  for (let i = 0; i < 60; i++) fly.update(DT, BOUNDS, null, walkSignals());
  assert.equal(fly.state, 'walking');
  assert.ok(Math.abs(fly.pos.y + 10) < 8, `y ${fly.pos.y} did not follow to -10`);
});

test('free walking stays inside the screen bounds', () => {
  const fly = new Fly({ x: 700, y: 450 }, 3);
  fly.state = asFlyState('walking');
  fly.speed = 150;
  fly.heading = 0.4;                 // aimed at the corner
  for (let i = 0; i < 900; i++) {
    fly.update(DT, BOUNDS, null, walkSignals());
    if (fly.state !== 'walking') continue;
    assert.ok(Math.abs(fly.pos.x) <= BOUNDS.width / 2 - 20 + 1e-6,
      `x ${fly.pos.x} escaped`);
    assert.ok(Math.abs(fly.pos.y) <= BOUNDS.height / 2 - 20 + 1e-6,
      `y ${fly.pos.y} escaped`);
  }
});

test('backward walking moves opposite the heading', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = asFlyState('walking');
  fly.speed = 40;
  fly.heading = 0;                   // facing +x
  fly.backwardTimer = 0.5;
  const x0 = fly.pos.x;
  for (let i = 0; i < 20; i++) fly.update(DT, BOUNDS, null, walkSignals());
  assert.ok(fly.pos.x < x0, `moved to ${fly.pos.x}, expected less than ${x0}`);
});

test('the gait bobs the body vertically while walking', () => {
  const fly = new Fly({ x: 0, y: 0 }, 1);
  fly.state = asFlyState('walking');
  fly.speed = 60;
  fly.heading = 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 60; i++) {
    fly.update(DT, BOUNDS, null, walkSignals());
    lo = Math.min(lo, fly.node.position.z);
    hi = Math.max(hi, fly.node.position.z);
  }
  assert.ok(hi - lo > 0.1, `gait bob range ${hi - lo}`);
  assert.ok(hi <= 0.35 + 1e-9, `bob peaked at ${hi}, above the 0.35 cap`);
});

test('spanning two monitors, the fly never walks into the gap between them', () => {
  // The development machine's real layout: 2560x1392 primary at the origin and a
  // 1536x912 secondary offset DOWN by 633. Their bounding box is 4096x1545, and
  // large parts of that box are on no display at all — a fly walking there would
  // simply vanish, since nothing renders it.
  const areas = [
    { x: 0, y: 0, width: 2560, height: 1392 },
    { x: 2560, y: 633, width: 1536, height: 912 },
  ];
  const arena = new Arena(toSceneRects(areas));
  const span = { width: arena.width, height: arena.height };

  const fly = new Fly({ x: -1000, y: 0 }, 4);   // on the primary
  fly.arena = arena;
  fly.state = asFlyState('walking');
  fly.speed = 150;
  assert.equal(arena.contains(fly.pos.x, fly.pos.y), true);

  // 30 s of fast walking, repeatedly aimed at the dead corners
  for (let i = 0; i < 1800; i++) {
    if (i % 300 === 0) fly.heading = [0.4, -0.4, 2.7, -2.7][(i / 300) % 4];
    fly.update(DT, span, null, walkSignals());
    if (fly.state !== 'walking') continue;
    assert.equal(arena.contains(fly.pos.x, fly.pos.y, -1e-6), true,
      `frame ${i}: fly reached ${fly.pos.x.toFixed(0)},${fly.pos.y.toFixed(0)}, `
      + 'which is on no display');
  }
});

test('flights across a spanning arena always target a real display', () => {
  const areas = [
    { x: 0, y: 0, width: 2560, height: 1392 },
    { x: 2560, y: 633, width: 1536, height: 912 },
  ];
  const arena = new Arena(toSceneRects(areas));
  const span = { width: arena.width, height: arena.height };
  for (let seed = 1; seed <= 40; seed++) {
    const fly = new Fly({ x: -1000, y: 0 }, seed);
    fly.arena = arena;
    fly.state = asFlyState('idle');
    fly.startFlight({ bounds: span });
    assert.equal(arena.contains(fly.flightTo.x, fly.flightTo.y), true,
      `seed ${seed}: flight target ${fly.flightTo.x.toFixed(0)},`
      + `${fly.flightTo.y.toFixed(0)} is on no display`);
  }
});
