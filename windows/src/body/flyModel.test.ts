import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildFlyModel } from './flyModel.ts';
import { FLY_SCALE } from './constants.ts';

test('Three.js default Euler order matches SceneKit roll-yaw-pitch', () => {
  // SceneKit applies eulerAngles as roll(z) -> yaw(y) -> pitch(x), which is the
  // composition Rx*Ry*Rz. Three's default order 'XYZ' claims the same. Prove it
  // against a hand-built matrix product rather than trusting the docs.
  const n = new THREE.Object3D();
  assert.equal(n.rotation.order, 'XYZ');
  n.rotation.set(0.3, -0.7, 1.1);
  n.updateMatrix();

  const rx = new THREE.Matrix4().makeRotationX(0.3);
  const ry = new THREE.Matrix4().makeRotationY(-0.7);
  const rz = new THREE.Matrix4().makeRotationZ(1.1);
  const expected = new THREE.Matrix4().multiply(rx).multiply(ry).multiply(rz);
  for (let i = 0; i < 16; i++) {
    assert.ok(Math.abs(n.matrix.elements[i] - expected.elements[i]) < 1e-12,
      `element ${i}: ${n.matrix.elements[i]} vs ${expected.elements[i]}`);
  }
});

test('the body has six legs at the Swift attach points', () => {
  const m = buildFlyModel();
  assert.equal(m.legs.length, 6);
  // FlyModel.swift:204-211 — three pairs, mirrored in x, all at z = 4.5
  const attach = m.legs.map((l) => l.root.position);
  assert.deepEqual(attach.map((p) => Number(p.z.toFixed(2))),
    [4.5, 4.5, 4.5, 4.5, 4.5, 4.5]);
  assert.deepEqual(attach.map((p) => Number(p.x.toFixed(1))),
    [3.1, -3.1, 3.7, -3.7, 3.3, -3.3]);
  assert.deepEqual(attach.map((p) => Number(p.y.toFixed(1))),
    [5.3, 5.3, 2.0, 2.0, -1.2, -1.2]);
  // only the front pair grooms
  assert.deepEqual(m.legs.map((l) => l.isFront),
    [true, true, false, false, false, false]);
  // swingSign mirrors left/right
  assert.deepEqual(m.legs.map((l) => l.swingSign), [1, -1, 1, -1, 1, -1]);
  // tripod gait: alternating phase offsets
  assert.deepEqual(m.legs.map((l) => l.phase), [0.0, 0.5, 0.5, 0.0, 0.0, 0.5]);
});

test('each leg is a femur-knee-tibia-ankle-tarsus chain', () => {
  const m = buildFlyModel();
  for (const leg of m.legs) {
    // root -> [femurMesh, knee]; knee -> [tibiaMesh, ankle]; ankle -> [tarsus]
    const knee = leg.root.children.find((c) => c.children.length > 0);
    assert.ok(knee, 'leg root should carry a knee with descendants');
    const ankle = knee.children.find((c) => c.children.length > 0);
    assert.ok(ankle, 'knee should carry an ankle');
    assert.ok(ankle.children.length >= 1, 'ankle should carry a tarsus');
  }
});

function deepestDescendant(n: THREE.Object3D): THREE.Object3D {
  let cur = n;
  for (;;) {
    const next = cur.children.find((c) => c.children.length > 0)
      ?? cur.children[0];
    if (next === undefined) return cur;
    cur = next;
  }
}

test('leg.apply drives yaw and lift, and the foot ends up below the body', () => {
  const m = buildFlyModel();
  const leg = m.legs[0];              // right front, swingSign +1
  leg.angle = 0;
  leg.lift = 0;
  leg.apply();
  assert.ok(Math.abs(leg.root.rotation.z - leg.baseYaw) < 1e-12);
  assert.ok(Math.abs(leg.root.rotation.y) < 1e-12);   // -0 is fine

  // lift raises the leg: rotation.y = -lift (FlyModel.swift:75)
  leg.lift = 0.5;
  leg.apply();
  assert.ok(Math.abs(leg.root.rotation.y + 0.5) < 1e-12);

  // swing displaces yaw by swingSign * angle
  leg.lift = 0;
  leg.angle = 0.3;
  leg.apply();
  assert.ok(Math.abs(leg.root.rotation.z - (leg.baseYaw + 0.3)) < 1e-12);

  // and the whole chain must reach outward and downward from its attachment:
  // the foot tip is farther from the body midline than the hip, and lower.
  m.root.updateMatrixWorld(true);
  const tip = deepestDescendant(leg.root);
  const tipWorld = new THREE.Vector3().setFromMatrixPosition(tip.matrixWorld);
  const hipWorld = new THREE.Vector3().setFromMatrixPosition(leg.root.matrixWorld);
  assert.ok(Math.abs(tipWorld.x) > Math.abs(hipWorld.x),
    `foot x ${tipWorld.x} should be outboard of hip x ${hipWorld.x}`);
  assert.ok(tipWorld.z < hipWorld.z,
    `foot z ${tipWorld.z} should be below hip z ${hipWorld.z}`);
});

test('wings: two folded shapes plus two hidden blur discs', () => {
  const m = buildFlyModel();
  assert.equal(m.foldedWings.children.length, 2);
  // FlyModel.swift:221-226 — mirrored in x, slightly different z per side
  const [wl, wr] = m.foldedWings.children;
  assert.ok(wl.position.x < 0 && wr.position.x > 0);
  assert.ok(Math.abs(wl.rotation.z + 0.13) < 1e-12);
  assert.ok(Math.abs(wr.rotation.z - 0.13) < 1e-12);
  // blur discs start hidden (FlyModel.swift:240)
  assert.equal(m.blurWingL.visible, false);
  assert.equal(m.blurWingR.visible, false);
});

test('root carries FLY_SCALE and the abdomen is a distinct node', () => {
  const m = buildFlyModel();
  assert.ok(Math.abs(m.root.scale.x - FLY_SCALE) < 1e-12);
  assert.ok(Math.abs(m.root.scale.y - FLY_SCALE) < 1e-12);
  assert.ok(Math.abs(m.root.scale.z - FLY_SCALE) < 1e-12);
  // abdomen scale is set every frame for breathing (FlyModel.swift:434)
  assert.ok(m.abdomen.position.y < 0, 'abdomen sits behind the thorax');
});

test('the abdomen texture has banding, not a flat fill', () => {
  const m = buildFlyModel();
  const material = (m.abdomen as THREE.Mesh).material as THREE.MeshPhongMaterial;
  const data = (material.map!.image as { data: Uint8Array }).data;
  const rowColor = (y: number) => data[(y * 64) * 4];   // red channel, x = 0
  // FlyModel.swift:52-55 fills NSRects of HEIGHT 26, 10, 10, 9 at y 0, 38, 60,
  // 82 - so the dark rows are 0-25, 38-47, 60-69, 82-90 over a lighter base.
  // Reading those heights as end coordinates merges the last three bands; the
  // second assertion below is what catches that.
  assert.ok(rowColor(10) < rowColor(32),
    `band row ${rowColor(10)} should be darker than base row ${rowColor(32)}`);
  assert.ok(rowColor(64) < rowColor(100));
});

test('two flies do not share geometry state', () => {
  const a = buildFlyModel();
  const b = buildFlyModel();
  a.legs[0].angle = 1.2;
  a.legs[0].apply();
  b.legs[0].apply();
  assert.notEqual(a.legs[0].root.rotation.z, b.legs[0].root.rotation.z);
});
