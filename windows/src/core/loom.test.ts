import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoomTransducer } from './loom.ts';

const DT = 1 / 30;   // the cursor poll runs at 30 Hz

// Drag the cursor from `from` to `to` in `steps` polls and return the last
// output — the transducer needs successive samples to estimate velocity.
function sweep(from: { x: number; y: number }, to: { x: number; y: number },
               steps: number, flyPos = { x: 0, y: 0 }, heading = 0) {
  const t = new LoomTransducer();
  let out = t.compute(flyPos, heading, from, DT);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    const p = { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k };
    out = t.compute(flyPos, heading, p, DT);
  }
  return out;
}

test('no cursor means no stimulus', () => {
  const t = new LoomTransducer();
  const out = t.compute({ x: 0, y: 0 }, 0, null, DT);
  assert.deepEqual(out, { l: 0, r: 0, puff: 0 });
});

test('a cursor lunge toward the fly produces loom', () => {
  const lunge = sweep({ x: 600, y: 0 }, { x: 120, y: 0 }, 6);
  assert.ok(lunge.l + lunge.r > 0.2,
    `closing fast should loom, got l=${lunge.l} r=${lunge.r}`);
});

test('a cursor retreating produces no loom from approach', () => {
  const away = sweep({ x: 150, y: 0 }, { x: 700, y: 0 }, 6);
  // only the proximity term can contribute, and at 700 pt it is zero
  assert.ok(away.l + away.r < 0.05, `retreat should not loom: ${away.l}, ${away.r}`);
});

test('hovering close is a big object even at zero speed', () => {
  const t = new LoomTransducer();
  let out = t.compute({ x: 0, y: 0 }, 0, { x: 60, y: 0 }, DT);
  for (let i = 0; i < 5; i++) out = t.compute({ x: 0, y: 0 }, 0, { x: 60, y: 0 }, DT);
  // (130 - 60) / 130 * 0.5 = 0.269, split between the eyes
  assert.ok(out.l + out.r > 0.15, `hover close should loom: ${out.l}, ${out.r}`);
  assert.equal(out.puff, 0, 'a still cursor makes no wind');
});

test('distance attenuates loom to nothing beyond 800 pt', () => {
  const far = sweep({ x: 1400, y: 0 }, { x: 900, y: 0 }, 6);
  assert.equal(far.l, 0);
  assert.equal(far.r, 0);
});

test('the threat is split between the eyes by bearing', () => {
  // Fly faces +x (heading 0). A threat on its left (+y) must weight the left
  // eye more; cross product z of forward x relative > 0 means left.
  const left = sweep({ x: 100, y: 600 }, { x: 20, y: 120 }, 6, { x: 0, y: 0 }, 0);
  assert.ok(left.l > left.r, `threat on the left: l=${left.l} r=${left.r}`);

  const right = sweep({ x: 100, y: -600 }, { x: 20, y: -120 }, 6, { x: 0, y: 0 }, 0);
  assert.ok(right.r > right.l, `threat on the right: l=${right.l} r=${right.r}`);
});

test('neither eye is ever fully blind and loom never exceeds 1', () => {
  const head = sweep({ x: 900, y: 0 }, { x: 25, y: 0 }, 12);
  assert.ok(head.l > 0 && head.r > 0, 'the 0.12 floor keeps both eyes driven');
  assert.ok(head.l <= 1 && head.r <= 1, `clamped: ${head.l}, ${head.r}`);
});

test('a fast whoosh nearby makes wind, a slow drift does not', () => {
  // Keep it inside 500 pt: the puff term is attenuated by 1 - dist/500, so a
  // sweep ending exactly 500 pt out would read zero however fast it was.
  const fast = sweep({ x: 100, y: 0 }, { x: 100, y: 200 }, 2);   // ~3000 pt/s
  assert.ok(fast.puff > 0.1, `fast sweep should puff: ${fast.puff}`);
  const slow = sweep({ x: 300, y: 0 }, { x: 300, y: 20 }, 6);
  assert.ok(slow.puff < 0.05, `slow drift should not puff: ${slow.puff}`);
});

test('loomOverride adds a stimulus with no cursor motion at all', () => {
  const t = new LoomTransducer();
  const out = t.compute({ x: 0, y: 0 }, 0, { x: 400, y: 0 }, DT, 0.6);
  assert.ok(out.l + out.r > 0.4, `override should drive both eyes: ${out.l}, ${out.r}`);
});

test('reset clears the velocity estimate', () => {
  const t = new LoomTransducer();
  t.compute({ x: 0, y: 0 }, 0, { x: 600, y: 0 }, DT);
  t.compute({ x: 0, y: 0 }, 0, { x: 200, y: 0 }, DT);
  t.reset();
  const out = t.compute({ x: 0, y: 0 }, 0, { x: 200, y: 0 }, DT);
  assert.equal(out.puff, 0, 'after reset there is no remembered velocity');
});
