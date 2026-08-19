// body/flyModel.ts — the procedural fly body, transliterated from
// FlyModel.swift:24-249. FlyWire is a brain connectome, so no body geometry
// exists; this is all hand-built from primitives, exactly as the macOS build
// does with SceneKit.
//
// Imports `three` for scene-graph objects only. Never construct a WebGLRenderer
// here — the headless test suites depend on this file staying renderer-free.

import * as THREE from 'three';
import { FLY_SCALE } from './constants.ts';

// FlyModel.swift:24-31. SceneKit's .blinn lighting model is Phong shading with
// a Blinn-Phong specular term, which MeshPhongMaterial provides. SceneKit's
// shininess is 0..1; Three's is a specular exponent, so scale by 100.
function mat(color: number, specular = 0.25, shininess = 0.25): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    color,
    specular: new THREE.Color(specular, specular, specular),
    shininess: shininess * 100,
  });
}

function rgb(r: number, g: number, b: number): number {
  return new THREE.Color(r, g, b).getHex();
}

// FlyModel.swift:43-58 — four dark bands over a lighter base. The Swift version
// draws into an NSImage; there is no canvas headless, so write the pixels
// directly. Row 0 is the bottom, matching NSImage's y-up coordinates.
export function abdomenTexture(): THREE.DataTexture {
  const w = 64;
  const h = 128;
  const data = new Uint8Array(w * h * 4);
  const base = [184, 140, 82];        // 0.72, 0.55, 0.32
  const dark = [56, 38, 23];          // 0.22, 0.15, 0.09
  // [y, height] per NSRect, FlyModel.swift:52-55 — heights 26, 10, 10, 9.
  const bands: Array<[number, number]> = [[0, 26], [38, 10], [60, 10], [82, 9]];
  const inBand = (y: number) => bands.some(([y0, hh]) => y >= y0 && y < y0 + hh);

  for (let y = 0; y < h; y++) {
    const c = inBand(y) ? dark : base;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, w, h);
  tex.needsUpdate = true;
  return tex;
}

// FlyModel.swift:60-77
export class Leg {
  angle = 0;
  lift = 0;
  // Explicit fields, not constructor parameter properties: those need codegen,
  // which Node's strip-only TypeScript mode refuses.
  readonly root: THREE.Object3D;
  readonly baseYaw: number;
  readonly swingSign: number;
  readonly phase: number;
  readonly isFront: boolean;

  constructor(
    root: THREE.Object3D,
    baseYaw: number,
    swingSign: number,
    phase: number,
    isFront: boolean,
  ) {
    this.root = root;
    this.baseYaw = baseYaw;
    this.swingSign = swingSign;
    this.phase = phase;
    this.isFront = isFront;
  }

  apply(): void {
    this.root.rotation.set(0, -this.lift, this.baseYaw + this.swingSign * this.angle);
  }
}

export interface FlyModelParts {
  root: THREE.Object3D;
  legs: Leg[];
  foldedWings: THREE.Object3D;
  blurWingL: THREE.Object3D;
  blurWingR: THREE.Object3D;
  abdomen: THREE.Object3D;
}

// SCNCapsule's `height` is the total length including both caps; Three's
// CapsuleGeometry takes the length of the cylindrical section only.
function capsule(capRadius: number, height: number): THREE.CapsuleGeometry {
  return new THREE.CapsuleGeometry(capRadius, Math.max(0.01, height - 2 * capRadius), 6, 8);
}

// FlyModel.swift:88-128. Each segment mesh keeps its -pi/2 Z rotation (laying
// the capsule along +X) and its half-length +X offset; the knee and ankle pivots
// keep their exact Euler triples. The chain's yaw/lift pivots depend on this.
function buildLeg(
  attach: THREE.Vector3, baseYaw: number, swingSign: number, phase: number,
  isFront: boolean, femur: number, tibia: number, tarsus: number,
): Leg {
  const legColor = rgb(0.33, 0.24, 0.14);
  const root = new THREE.Object3D();
  root.position.copy(attach);

  const femurNode = new THREE.Mesh(capsule(0.48, femur), mat(legColor));
  femurNode.rotation.set(0, 0, -Math.PI / 2);
  femurNode.position.set(femur / 2, 0, 0);
  root.add(femurNode);

  const knee = new THREE.Object3D();
  knee.position.set(femur, 0, 0);
  knee.rotation.set(0, 0.75, -0.30 * swingSign);
  root.add(knee);

  const tibiaNode = new THREE.Mesh(capsule(0.38, tibia), mat(legColor));
  tibiaNode.rotation.set(0, 0, -Math.PI / 2);
  tibiaNode.position.set(tibia / 2, 0, 0);
  knee.add(tibiaNode);

  const ankle = new THREE.Object3D();
  ankle.position.set(tibia, 0, 0);
  ankle.rotation.set(0, 0.35, -0.15 * swingSign);
  knee.add(ankle);

  // legColor blended 25% toward black
  const tarsusColor = new THREE.Color(legColor).multiplyScalar(0.75).getHex();
  const tarsusNode = new THREE.Mesh(capsule(0.24, tarsus), mat(tarsusColor));
  tarsusNode.rotation.set(0, 0, -Math.PI / 2);
  tarsusNode.position.set(tarsus / 2, 0, 0);
  ankle.add(tarsusNode);

  const leg = new Leg(root, baseYaw, swingSign, phase, isFront);
  leg.apply();
  return leg;
}

// FlyModel.swift:130-142 — NSBezierPath(ovalIn:) over the rect
// (x -2.6, y -15.5, w 5.2, h 16.5): an ellipse centered at (0, -7.25) with
// radii 2.6 and 8.25, extruded 0.12.
function wingGeometry(): THREE.ExtrudeGeometry {
  const shape = new THREE.Shape();
  shape.absellipse(0, -15.5 + 16.5 / 2, 2.6, 16.5 / 2, 0, Math.PI * 2, false, 0);
  return new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: false,
    curveSegments: 24,
  });
}

function wingMaterial(): THREE.MeshPhongMaterial {
  return new THREE.MeshPhongMaterial({
    color: rgb(0.92, 0.92, 0.92),
    opacity: 0.28,
    transparent: true,
    specular: new THREE.Color(0.9, 0.9, 0.9),
    shininess: 90,
    side: THREE.DoubleSide,
  });
}

// FlyModel.swift:144-249
export function buildFlyModel(): FlyModelParts {
  const root = new THREE.Object3D();
  root.scale.set(FLY_SCALE, FLY_SCALE, FLY_SCALE);

  const bodyBrown = rgb(0.50, 0.38, 0.22);

  const thorax = new THREE.Mesh(new THREE.SphereGeometry(4.6, 24, 16),
    mat(bodyBrown, 0.35, 0.4));
  thorax.position.set(0, 2.5, 6.2);
  thorax.scale.set(0.95, 1.15, 0.85);
  root.add(thorax);

  const abdMat = new THREE.MeshPhongMaterial({
    map: abdomenTexture(),
    specular: new THREE.Color(0.3, 0.3, 0.3),
    shininess: 35,
  });
  const abdomen = new THREE.Mesh(new THREE.SphereGeometry(5.0, 24, 16), abdMat);
  abdomen.position.set(0, -6.5, 5.6);
  abdomen.scale.set(0.9, 1.5, 0.75);
  root.add(abdomen);

  // bodyBrown blended 15% toward white
  const headColor = new THREE.Color(bodyBrown).lerp(new THREE.Color(1, 1, 1), 0.15).getHex();
  const head = new THREE.Mesh(new THREE.SphereGeometry(3.0, 20, 14), mat(headColor));
  head.position.set(0, 9.0, 6.0);
  head.scale.set(1.0, 0.85, 0.9);
  root.add(head);

  const eyeMat = mat(rgb(0.62, 0.10, 0.07), 0.9, 0.9);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(2.0, 18, 12), eyeMat);
    eye.position.set(side * 2.1, 9.7, 6.4);
    eye.scale.set(0.8, 1.0, 1.15);
    root.add(eye);
  }

  const antMat = mat(rgb(0.3, 0.22, 0.13));
  for (const side of [-1, 1]) {
    const ant = new THREE.Mesh(capsule(0.16, 2.2), antMat);
    ant.position.set(side * 0.9, 11.6, 6.3);
    ant.rotation.set(-1.15, 0, side * 0.35);
    root.add(ant);
  }

  // SCNCone(topRadius:bottomRadius:height:) -> a truncated cone, which Three
  // expresses as a CylinderGeometry with two radii (ConeGeometry has only one).
  const prob = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.22, 2.4, 12),
    mat(rgb(0.35, 0.26, 0.16)));
  prob.position.set(0, 10.4, 4.6);
  prob.rotation.set(-0.5, 0, 0);
  root.add(prob);

  const legs: Leg[] = [];
  const z = 4.5;
  // side, attach, yawOff, phase, isFront, femur, tibia, tarsus
  const specs: Array<[number, [number, number, number], number, number, boolean,
    number, number, number]> = [
    [1, [3.1, 5.3, z], 0.95, 0.0, true, 4.2, 4.8, 3.2],
    [-1, [-3.1, 5.3, z], 0.95, 0.5, true, 4.2, 4.8, 3.2],
    [1, [3.7, 2.0, z], -0.10, 0.5, false, 4.8, 5.6, 3.8],
    [-1, [-3.7, 2.0, z], -0.10, 0.0, false, 4.8, 5.6, 3.8],
    [1, [3.3, -1.2, z], -0.95, 0.0, false, 5.8, 7.0, 4.6],
    [-1, [-3.3, -1.2, z], -0.95, 0.5, false, 5.8, 7.0, 4.6],
  ];
  for (const [side, attach, yawOff, phase, isFront, f, t, ta] of specs) {
    const baseYaw = side > 0 ? yawOff : Math.PI - yawOff;
    const leg = buildLeg(new THREE.Vector3(...attach), baseYaw, side, phase,
      isFront, f, t, ta);
    root.add(leg.root);
    legs.push(leg);
  }

  const foldedWings = new THREE.Object3D();
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(wingGeometry(), wingMaterial());
    wing.position.set(side * 1.6, 0.5, side > 0 ? 7.7 : 7.55);
    wing.rotation.set(0, 0, side * 0.13);
    foldedWings.add(wing);
  }
  root.add(foldedWings);

  function blurWing(side: number): THREE.Object3D {
    const m = new THREE.MeshBasicMaterial({      // .constant lighting model
      color: rgb(0.85, 0.85, 0.85),
      opacity: 0.30,
      transparent: true,
      side: THREE.DoubleSide,
    });
    const n = new THREE.Mesh(new THREE.SphereGeometry(1.0, 16, 10), m);
    n.position.set(side * 6.0, 1.5, 8.2);
    n.scale.set(5.5, 2.4, 0.3);
    n.rotation.set(0, 0, side * -0.45);
    n.visible = false;
    return n;
  }
  const bl = blurWing(-1);
  const br = blurWing(1);
  root.add(bl);
  root.add(br);

  return { root, legs, foldedWings, blurWingL: bl, blurWingR: br, abdomen };
}
