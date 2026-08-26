// flymodel.js — port of FlyModel.swift: procedural 3D fruit-fly body (FlyWire
// has no body data; the connectome drives behavior, the body is modeled) plus
// per-fly behavior. Local frame: +Y forward, +Z up, ground at z=0.
//
// SceneKit -> three.js mapping used throughout:
//   SCNNode          -> THREE.Object3D      (eulerAngles -> rotation, XYZ order
//                                            matches SceneKit's Rx*Ry*Rz)
//   SCNSphere(r)     -> SphereGeometry(r)
//   SCNCapsule(r,h)  -> CapsuleGeometry(r, h - 2r)   (both are Y-axis, centered)
//   SCNCone(t,b,h)   -> CylinderGeometry(t, b, h)
//   SCNShape(path,d) -> ExtrudeGeometry(shape, {depth:d}), re-centered on z
//   node.isHidden    -> !node.visible
//   node.opacity     -> material.opacity (per-node material clones)

// relative rather than bare so the same module resolves in Node (tests)
// and in the renderer without an inline importmap
import * as THREE from '../node_modules/three/build/three.module.js';
import { rnd, clampf, angleDiff, smoothstep, lag, TUNED_HZ } from './util.js';
import { makeSignals } from './sim.js';

export const SHADOWS_ENABLED = true;
export const FLY_SCALE = 1.15;
export const EDGE_MARGIN = 50;
// How close the fly's centre may get to the edge of the desktop while walking.
// The body is ~30 px tall at FLY_SCALE, so the macOS value of 20 let the head
// slide under the screen edge; this keeps the whole body on screen.
export const EDGE_CLAMP = 45;
export const SCARE_RADIUS = 110;     // legacy behavior (non-connectome flies) only
export const NERVOUS_RADIUS = 240;   // legacy behavior only

// Heading random-walk amplitude, rad/sqrt(s). The variance of a random walk
// grows with dt, not dt^2, so the old `rnd(-1, 1) * 1.6 * dt` form made the
// fly measurably twitchier on a 60 Hz display than on a 120 Hz one. Dividing
// by sqrt(TUNED_HZ) reproduces the old 60 Hz spread exactly.
export const WANDER_JITTER = 1.6 / Math.sqrt(TUNED_HZ);
// Same recalibration of the old ledge-walking `0.2 * dt`.
export const LEDGE_JITTER = 0.2 / Math.sqrt(TUNED_HZ);

// MARK: - Measured walking kinematics
//
// A walking fly does not steer continuously. It goes nearly straight and
// changes heading in discrete body saccades, with slow sub-threshold drift in
// between — Geurten, Jähde, Rosner & Egelhaaf 2014 (Front Behav Neurosci
// 8:365, 10.3389/fnbeh.2014.00365) scored 1140 saccades against 3348 slow
// turns in freely walking Canton-S at 500 fps. So the shape here is right;
// the numbers were not. The code snapped the heading by up to 86 deg in a
// single step.

// Body-saccade amplitude, rad. Measured mean is ~15 deg; this range averages
// to it. Sign is drawn separately (Geurten et al. 2014).
export const SACCADE_MIN = 0.09;   // 5 deg
export const SACCADE_MAX = 0.44;   // 25 deg
// Body-saccade duration, s — measured 40-120 ms, median 90 (Geurten et al.
// 2014). A 15 deg turn spent over it peaks near 170 deg/s, just under the
// 200 deg/s those authors use as the saccade detection threshold.
export const SACCADE_DUR = 0.09;
// Swing (leg-in-air) duration, s. Nearly constant across walking speed — it is
// stance that scales as 1/v — Mendes, Bartos, Akay, Márka & Mann 2013
// (eLife 2:e00231, 10.7554/eLife.00231, Table 2). The gait used a fixed 40%
// swing fraction instead, which stretches the swing at low speed.
export const SWING_DUR = 0.035;

// NSColor(calibratedRed:green:blue:) values are sRGB components.
function srgb(r, g, b) { return new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace); }
function blendBlack(c, f) { return c.clone().multiplyScalar(1 - f); }
function blendWhite(c, f) { return c.clone().lerp(new THREE.Color(1, 1, 1), f); }

export function mat(color, specular = 0.25, shininess = 0.25) {
  return new THREE.MeshPhongMaterial({
    color,
    specular: new THREE.Color(specular, specular, specular),
    shininess: shininess * 100,
  });
}

// 64x128 abdominal banding. NSImage draws bottom-up, canvas top-down, so the
// band rectangles are flipped to keep the dark tip at the same end.
export function abdomenTexture() {
  if (typeof document === 'undefined') return null;   // headless test runs
  const W = 64, H = 128;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgb(184, 140, 82)';    // 0.72, 0.55, 0.32
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'rgb(56, 38, 23)';      // 0.22, 0.15, 0.09
  for (const [y, h] of [[0, 26], [38, 10], [60, 10], [82, 9]]) {
    ctx.fillRect(0, H - y - h, W, h);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Leg {
  constructor(root, baseYaw, swingSign, phase, isFront) {
    this.root = root;
    this.baseYaw = baseYaw;
    this.swingSign = swingSign;
    this.phase = phase;
    this.isFront = isFront;
    this.angle = 0;
    this.lift = 0;
  }

  apply() {
    this.root.rotation.set(0, -this.lift, this.baseYaw + this.swingSign * this.angle);
  }
}

function buildLeg(attach, baseYaw, swingSign, phase, isFront, femur, tibia, tarsus) {
  const legColor = srgb(0.33, 0.24, 0.14);
  const root = new THREE.Object3D();
  root.position.set(attach[0], attach[1], attach[2]);

  const femurNode = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.48, Math.max(0.01, femur - 0.96), 4, 10), mat(legColor));
  femurNode.rotation.set(0, 0, -Math.PI / 2);
  femurNode.position.set(femur / 2, 0, 0);
  root.add(femurNode);

  const knee = new THREE.Object3D();
  knee.position.set(femur, 0, 0);
  knee.rotation.set(0, 0.75, -0.30 * swingSign);
  root.add(knee);

  const tibiaNode = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.38, Math.max(0.01, tibia - 0.76), 4, 10), mat(legColor));
  tibiaNode.rotation.set(0, 0, -Math.PI / 2);
  tibiaNode.position.set(tibia / 2, 0, 0);
  knee.add(tibiaNode);

  const ankle = new THREE.Object3D();
  ankle.position.set(tibia, 0, 0);
  ankle.rotation.set(0, 0.35, -0.15 * swingSign);
  knee.add(ankle);

  const tarsusNode = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.24, Math.max(0.01, tarsus - 0.48), 4, 8),
    mat(blendBlack(legColor, 0.25)));
  tarsusNode.rotation.set(0, 0, -Math.PI / 2);
  tarsusNode.position.set(tarsus / 2, 0, 0);
  ankle.add(tarsusNode);

  const leg = new Leg(root, baseYaw, swingSign, phase, isFront);
  leg.apply();
  return leg;
}

function wingMesh() {
  // NSBezierPath(ovalIn: NSRect(x: -2.6, y: -15.5, width: 5.2, height: 16.5))
  const shape = new THREE.Shape();
  shape.absellipse(0, -15.5 + 16.5 / 2, 2.6, 16.5 / 2, 0, 2 * Math.PI, false, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false, curveSegments: 24 });
  geo.translate(0, 0, -0.06);   // SCNShape extrudes symmetrically about z = 0
  const m = new THREE.MeshPhongMaterial({
    color: srgb(0.92, 0.92, 0.92),
    specular: new THREE.Color(0.9, 0.9, 0.9),
    shininess: 90,
    transparent: true,
    opacity: 0.28,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  return new THREE.Mesh(geo, m);
}

export function buildFlyModel() {
  const root = new THREE.Object3D();
  root.scale.set(FLY_SCALE, FLY_SCALE, FLY_SCALE);

  const bodyBrown = srgb(0.50, 0.38, 0.22);

  const thorax = new THREE.Mesh(new THREE.SphereGeometry(4.6, 28, 20),
                                mat(bodyBrown, 0.35, 0.4));
  thorax.position.set(0, 2.5, 6.2);
  thorax.scale.set(0.95, 1.15, 0.85);
  root.add(thorax);

  const abdMat = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    specular: new THREE.Color(0.3, 0.3, 0.3),
    shininess: 35,
  });
  const abdTex = abdomenTexture();
  if (abdTex) abdMat.map = abdTex;
  else abdMat.color = srgb(0.60, 0.44, 0.24);   // headless: flat body colour
  const abdomen = new THREE.Mesh(new THREE.SphereGeometry(5.0, 28, 20), abdMat);
  abdomen.position.set(0, -6.5, 5.6);
  abdomen.scale.set(0.9, 1.5, 0.75);
  root.add(abdomen);

  const head = new THREE.Mesh(new THREE.SphereGeometry(3.0, 24, 16),
                              mat(blendWhite(bodyBrown, 0.15)));
  head.position.set(0, 9.0, 6.0);
  head.scale.set(1.0, 0.85, 0.9);
  root.add(head);

  const eyeGeo = new THREE.SphereGeometry(2.0, 22, 16);
  const eyeMat = mat(srgb(0.62, 0.10, 0.07), 0.9, 0.9);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(side * 2.1, 9.7, 6.4);
    eye.scale.set(0.8, 1.0, 1.15);
    root.add(eye);
  }

  const antGeo = new THREE.CapsuleGeometry(0.16, 2.2 - 0.32, 4, 8);
  const antMat = mat(srgb(0.3, 0.22, 0.13));
  for (const side of [-1, 1]) {
    const ant = new THREE.Mesh(antGeo, antMat);
    ant.position.set(side * 0.9, 11.6, 6.3);
    ant.rotation.set(-1.15, 0, side * 0.35);
    root.add(ant);
  }

  const prob = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.22, 2.4, 16),
                              mat(srgb(0.35, 0.26, 0.16)));
  prob.position.set(0, 10.4, 4.6);
  prob.rotation.set(-0.5, 0, 0);
  root.add(prob);

  const legs = [];
  const z = 4.5;
  const specs = [
    [1, [3.1, 5.3, z], 0.95, 0.0, true, 4.2, 4.8, 3.2],
    [-1, [-3.1, 5.3, z], 0.95, 0.5, true, 4.2, 4.8, 3.2],
    [1, [3.7, 2.0, z], -0.10, 0.5, false, 4.8, 5.6, 3.8],
    [-1, [-3.7, 2.0, z], -0.10, 0.0, false, 4.8, 5.6, 3.8],
    [1, [3.3, -1.2, z], -0.95, 0.0, false, 5.8, 7.0, 4.6],
    [-1, [-3.3, -1.2, z], -0.95, 0.5, false, 5.8, 7.0, 4.6],
  ];
  for (const [side, attach, yawOff, phase, isFront, f, t, ta] of specs) {
    const baseYaw = side > 0 ? yawOff : (Math.PI - yawOff);
    const leg = buildLeg(attach, baseYaw, side, phase, isFront, f, t, ta);
    root.add(leg.root);
    legs.push(leg);
  }

  const foldedWings = new THREE.Object3D();
  for (const side of [-1, 1]) {
    const wing = wingMesh();
    wing.position.set(side * 1.6, 0.5, side > 0 ? 7.7 : 7.55);
    wing.rotation.set(0, 0, side * 0.13);
    foldedWings.add(wing);
  }
  root.add(foldedWings);

  function blurWing(side) {
    const m = new THREE.MeshBasicMaterial({
      color: srgb(0.85, 0.85, 0.85),
      transparent: true,
      opacity: 0.30,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const n = new THREE.Mesh(new THREE.SphereGeometry(1.0, 16, 12), m);
    n.position.set(side * 6.0, 1.5, 8.2);
    n.scale.set(5.5, 2.4, 0.3);
    n.rotation.set(0, 0, side * -0.45);
    n.visible = false;
    return n;
  }
  const bl = blurWing(-1), br = blurWing(1);
  root.add(bl);
  root.add(br);

  if (SHADOWS_ENABLED) {
    root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    bl.castShadow = false;
    br.castShadow = false;
  }

  return { root, legs, foldedWings, blurWingL: bl, blurWingR: br, abdomen };
}

// MARK: - Behavior

export class Fly {
  constructor(p) {
    this.model = buildFlyModel();

    this.pos = { x: p.x, y: p.y };
    this.heading = rnd(0, 2 * Math.PI);
    this.speed = 30;
    this.state = 'walking';
    this.stateTimer = rnd(1.5, 4);
    this.gaitPhase = rnd(0, 1);
    this.time = rnd(0, 100);
    this.scareCooldown = 0;
    this.dartCooldown = 0;
    this.backwardTimer = 0;
    // Radians of body saccade not yet spent, and the rate it is spent at.
    this.saccade = 0;
    this.saccadeRate = 0;
    this.dartTimer = 0;
    this.stateAge = 0;
    this.terrain = [];      // walkable window edges, set by the coordinator
    this.ledge = null;      // currently attached window edge
    // Scene-space rects of the real displays. The overlay spans the whole
    // virtual desktop, which on a multi-monitor layout is not a solid
    // rectangle — these keep the fly out of the dead corners between screens.
    this.screens = null;

    this.flightFrom = { x: 0, y: 0 };
    this.flightTo = { x: 0, y: 0 };
    this.flightT = 0;
    this.flightDur = 1;
    this.flightEffort = 0.6;   // set at takeoff: escape=1, casual from arousal
    this.effortCurrent = 0.6;  // live effort: base + ongoing DNp02/04/11 + arousal
    this.alt = 0;              // 0 ground .. 1 max altitude
    this.pitch = 0;            // body pitch while climbing/descending
    this.flapPhase = 0;
    this.wingRaise = 0;        // grounded threat posture (escape-DN driven)
    this.brainLive = false;
    this.liveArousal = 0;
    this.liveWing = 0;

    this.syncNode();
  }

  get node() { return this.model.root; }
  get gaitPhasePublic() { return this.gaitPhase; }
  get walkingIntensity() {
    return this.state === 'walking'
      ? clampf(Math.abs(this.backwardTimer > 0 ? 22 : this.speed) / 60, 0, 1) : 0;
  }
  get effectiveSpeed() { return this.backwardTimer > 0 ? -22 : this.speed; }

  onScreen(x, y, inset = 0) {
    if (!this.screens || !this.screens.length) return true;
    return this.screens.some((s) => x > s.x0 + inset && x < s.x1 - inset
      && y > s.y0 + inset && y < s.y1 - inset);
  }

  nearestScreenCenter(x, y) {
    if (!this.screens || !this.screens.length) return { x: 0, y: 0 };
    let best = this.screens[0], bestD = Infinity;
    for (const s of this.screens) {
      const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
      const d = Math.hypot(cx - x, cy - y);
      if (d < bestD) { bestD = d; best = s; }
    }
    return { x: (best.x0 + best.x1) / 2, y: (best.y0 + best.y1) / 2 };
  }

  syncNode() {
    this.node.position.set(this.pos.x, this.pos.y, this.node.position.z);
    this.node.rotation.set(this.pitch, 0, this.heading - Math.PI / 2);
  }

  startFlight(bounds, { awayFrom = null, escape = false, effort = null, target: forced = null } = {}) {
    this.state = 'flying';
    this.ledge = null;
    this.flightEffort = clampf(effort !== null ? effort : (escape ? 1.0 : rnd(0.4, 0.75)), 0.25, 1);
    this.effortCurrent = this.flightEffort;
    this.flapPhase = 0;
    this.wingRaise = 0;
    this.flightFrom = { x: this.pos.x, y: this.pos.y };
    const hw = bounds.width / 2 - EDGE_MARGIN, hh = bounds.height / 2 - EDGE_MARGIN;
    let target = { x: 0, y: 0 };
    let chosen = false;
    // casual flights often land on a window edge
    if (!escape && awayFrom === null && this.terrain.length && rnd(0, 1) < 0.45) {
      const L = this.terrain[Math.floor(Math.random() * this.terrain.length)];
      if (L.x1 - L.x0 > 90) {
        target = { x: rnd(L.x0 + 25, L.x1 - 25), y: L.y };
        chosen = Math.hypot(target.x - this.pos.x, target.y - this.pos.y) > 180;
      }
    }
    if (forced) {
      target = { x: forced.x, y: forced.y };
      chosen = true;
    }
    if (!chosen) {
      for (let k = 0; k < 16; k++) {
        target = { x: rnd(-hw, hw), y: rnd(-hh, hh) };
        // never aim into the gap between two differently sized monitors
        if (!this.onScreen(target.x, target.y, EDGE_MARGIN)) continue;
        const far = Math.hypot(target.x - this.pos.x, target.y - this.pos.y) > (escape ? 350 : 260);
        if (!far) continue;
        if (awayFrom) {
          // escape away from the threat: target must be on the far side
          const toT = { x: target.x - this.pos.x, y: target.y - this.pos.y };
          const toA = { x: awayFrom.x - this.pos.x, y: awayFrom.y - this.pos.y };
          if (toT.x * toA.x + toT.y * toA.y > 0) continue;
        }
        break;
      }
    }
    this.flightTo = target;
    const dist = Math.hypot(target.x - this.pos.x, target.y - this.pos.y);
    this.flightDur = escape ? clampf(dist / 650, 0.45, 1.2) : clampf(dist / 420, 0.7, 2.0);
    this.flightT = 0;
    this.scareCooldown = escape ? 2.0 : 2.5;
    // wings stay visible and beat; blur discs add the motion-smear
    this.model.blurWingL.visible = true;
    this.model.blurWingR.visible = true;
  }

  land() {
    this.state = 'idle';
    this.stateTimer = rnd(0.3, 0.8);
    this.speed = 0;
    this.alt = 0;
    this.pitch = 0;
    this.node.scale.set(FLY_SCALE, FLY_SCALE, FLY_SCALE);
    this.node.position.z = 0;
    // refold the wings flat over the abdomen
    this.model.foldedWings.children.forEach((wing, i) => {
      const side = i === 0 ? -1 : 1;
      wing.rotation.set(0, 0, side * 0.13);
    });
    this.model.blurWingL.visible = false;
    this.model.blurWingR.visible = false;
  }

  // Queue a body saccade instead of snapping the heading. Escape turns do NOT
  // go through this: a fleeing fly extends its legs in 3.33 ms (Card &
  // Dickinson 2008, J Exp Biol 211:341, 10.1242/jeb.012682) and must stay
  // instant.
  startSaccade() {
    this.saccade = (rnd(0, 1) < 0.5 ? -1 : 1) * rnd(SACCADE_MIN, SACCADE_MAX);
    this.saccadeRate = this.saccade / SACCADE_DUR;
  }

  stepSaccade(dt) {
    if (this.saccade === 0) return;
    const step = this.saccadeRate * dt;
    if (Math.abs(step) >= Math.abs(this.saccade)) {
      this.heading += this.saccade;
      this.saccade = 0;
    } else {
      this.heading += step;
      this.saccade -= step;
    }
  }

  pickNextState() {
    switch (this.state) {
      case 'walking': {
        const r = rnd(0, 1);
        if (r < 0.30) { this.state = 'idle'; this.stateTimer = rnd(0.8, 3); this.speed = 0; }
        else if (r < 0.55) {
          this.stateTimer = rnd(0.3, 0.8); this.speed = rnd(95, 150);
          this.startSaccade();
        } else { this.stateTimer = rnd(1.5, 5); this.speed = rnd(18, 45); }
        break;
      }
      case 'idle': {
        const r = rnd(0, 1);
        if (r < 0.35) { this.state = 'grooming'; this.stateTimer = rnd(1.0, 2.5); }
        else {
          this.state = 'walking'; this.stateTimer = rnd(1.5, 5); this.speed = rnd(18, 45);
          this.startSaccade();
        }
        break;
      }
      case 'grooming':
        this.state = 'idle'; this.stateTimer = rnd(0.3, 1.0);
        break;
      default:
        break;
    }
  }

  update(dt, bounds, mouse, signals) {
    this.time += dt;
    this.scareCooldown = Math.max(0, this.scareCooldown - dt);
    this.dartCooldown = Math.max(0, this.dartCooldown - dt);
    this.backwardTimer = Math.max(0, this.backwardTimer - dt);

    this.stateAge += dt;
    this.dartTimer = Math.max(0, this.dartTimer - dt);

    // live brain drives reach the wings even mid-flight
    this.brainLive = !!signals;
    this.liveArousal = signals ? signals.arousal : 0;
    this.liveWing = signals ? signals.wingDrive : 0;

    if (this.state === 'flying') {
      this.saccade = 0;            // airborne heading is geometric, not a walk saccade
      this.updateFlight(dt);
    } else if (signals) {
      this.stepSaccade(dt);
      this.brainBehavior(signals, dt, bounds, mouse);
      if (this.state === 'walking') this.updateWalk(dt, bounds);
    } else {
      if (this.scareCooldown === 0 && mouse) {
        // legacy distance-based fear (extra, brainless flies)
        const mouseDist = Math.hypot(mouse.x - this.pos.x, mouse.y - this.pos.y);
        if (mouseDist < SCARE_RADIUS) {
          this.startFlight(bounds, { awayFrom: mouse });
        } else if (mouseDist < NERVOUS_RADIUS && this.state !== 'walking') {
          this.setState('walking');
          this.saccade = 0;        // fleeing turns are instant, not saccadic
          this.heading = Math.atan2(this.pos.y - mouse.y, this.pos.x - mouse.x) + rnd(-0.4, 0.4);
          this.speed = rnd(110, 150);
          this.stateTimer = rnd(0.4, 0.9);
          this.scareCooldown = 1.0;
        }
      }
      if (this.state !== 'flying') {
        this.stepSaccade(dt);
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) {
          if (this.state === 'walking' && rnd(0, 1) < 0.10) this.startFlight(bounds);
          else this.pickNextState();
        }
        if (this.state === 'walking') this.updateWalk(dt, bounds);
      }
    }

    this.updateLegs(dt);
    this.updateWings(dt);
    // slower, deeper breathing while asleep
    const breathe = this.state === 'sleeping'
      ? (1 + 0.05 * Math.sin(this.time * 1.1))
      : (1 + 0.03 * Math.sin(this.time * 3.0));
    this.model.abdomen.scale.set(0.9, 1.5, 0.75 * breathe);
    this.syncNode();
  }

  setState(s) {
    if (s === this.state) return;
    this.state = s;
    this.stateAge = 0;
  }

  // Every behavioral decision here reads a real neuron population's rate.
  brainBehavior(s, dt, bounds, mouse) {
    // Giant fiber spike -> escape takeoff (even startles it out of sleep)
    if (s.escape && this.scareCooldown === 0) {
      this.startFlight(bounds, { awayFrom: mouse, escape: true });
      return;
    }
    // circadian sleep: enter, hold (no walk/groom/dart while asleep), wake to grooming
    if (s.sleep) {
      if (this.state !== 'sleeping') {
        this.setState('sleeping'); this.speed = 0; this.dartTimer = 0; this.backwardTimer = 0;
      }
      return;
    } else if (this.state === 'sleeping') {
      this.setState('grooming');   // flies groom after waking
      return;
    }
    // Looming detectors hot but GF quiet -> nervous dart away
    if (s.nervous > 0.40 && this.dartCooldown === 0) {
      this.ledge = null;
      this.setState('walking');
      if (mouse) {
        this.saccade = 0;        // fleeing turns are instant, not saccadic
        this.heading = Math.atan2(this.pos.y - mouse.y, this.pos.x - mouse.x) + rnd(-0.4, 0.4);
      } else { this.startSaccade(); }
      this.speed = rnd(110, 155);
      this.dartTimer = rnd(0.4, 0.9);
      this.dartCooldown = 1.2;
    }
    // DNg11 (grooming command) hysteresis
    if (this.state !== 'walking' || this.dartTimer === 0) {
      if (this.state !== 'grooming' && s.groomDrive > 0.5 && s.nervous < 0.3 && this.stateAge > 0.4) {
        this.setState('grooming');
      } else if (this.state === 'grooming' && s.groomDrive < 0.3 && this.stateAge > 0.6) {
        this.setState('idle');
      }
    }
    // DNp09 (forward-walking command) hysteresis
    if (this.state === 'idle' && s.walkDrive > 0.22 && this.stateAge > 0.4) {
      this.setState('walking');
      this.startSaccade();
    } else if (this.state === 'walking' && this.dartTimer === 0
               && s.walkDrive < 0.08 && this.stateAge > 0.5) {
      this.setState('idle');
      this.speed = 0;
    }
    // MDN burst -> backward walk, from any grounded state
    if (s.backward && this.backwardTimer === 0 && this.dartTimer === 0) {
      if (this.state !== 'walking') { this.setState('walking'); this.speed = 0; }
      this.backwardTimer = 0.5;
    }
    // walking speed follows the forward command rate; tempo = temperature
    if (this.state === 'walking') {
      if (this.dartTimer === 0 && this.backwardTimer === 0) {
        const target = (14 + s.walkDrive * 55) * s.tempo;
        this.speed += (target - this.speed) * lag(3, dt);
      }
      if (!this.ledge) this.heading += s.turnBias * dt;   // DNa01/DNa02 steering
    }
    // spontaneous takeoff, gated on whole-population arousal; flight
    // altitude/effort scales with how aroused the network is
    const flightChance = s.arousal > 0.5 ? 0.6 : 0.005;
    if (this.state === 'walking' && rnd(0, 1) < lag(flightChance, dt)) {
      this.startFlight(bounds, { effort: 0.35 + s.arousal * 0.6 });
    }
  }

  updateWalk(dt, bounds) {
    // refresh the attached ledge from current terrain (windows move/close)
    if (this.ledge) {
      const cur = this.terrain.find((L) => L.id === this.ledge.id);
      if (cur && Math.abs(cur.y - this.ledge.y) < 40) {
        this.ledge = cur;
      } else {
        this.ledge = null;
        this.startFlight(bounds);   // the ground vanished from under it
        return;
      }
    }
    if (this.ledge) {
      const L = this.ledge;
      // walk along the window edge
      this.heading += rnd(-1, 1) * LEDGE_JITTER * Math.sqrt(dt);
      const along = Math.cos(this.heading) >= 0 ? 0 : Math.PI;
      this.heading += angleDiff(this.heading, along) * lag(6, dt);
      this.pos.x += Math.cos(this.heading) * this.effectiveSpeed * dt;
      this.pos.y += (L.y - this.pos.y) * lag(10, dt);
      if (this.pos.x <= L.x0 + 6 && Math.cos(this.heading) < 0) this.heading = 0;
      if (this.pos.x >= L.x1 - 6 && Math.cos(this.heading) > 0) this.heading = Math.PI;
      this.pos.x = clampf(this.pos.x, L.x0, L.x1);
      if (rnd(0, 1) < lag(0.05, dt)) this.ledge = null;   // wander off the edge
    } else {
      this.heading += rnd(-1, 1) * WANDER_JITTER * Math.sqrt(dt);
      const hw = bounds.width / 2 - EDGE_MARGIN, hh = bounds.height / 2 - EDGE_MARGIN;
      if (Math.abs(this.pos.x) > hw || Math.abs(this.pos.y) > hh) {
        const toCenter = Math.atan2(-this.pos.y, -this.pos.x);
        this.heading += angleDiff(this.heading, toCenter) * lag(4, dt);
      }
      const v = this.effectiveSpeed;
      this.pos.x += Math.cos(this.heading) * v * dt;
      this.pos.y += Math.sin(this.heading) * v * dt;
      this.pos.x = clampf(this.pos.x, -bounds.width / 2 + EDGE_CLAMP, bounds.width / 2 - EDGE_CLAMP);
      this.pos.y = clampf(this.pos.y, -bounds.height / 2 + EDGE_CLAMP, bounds.height / 2 - EDGE_CLAMP);
      // walked off the edge of a monitor into unlit space: steer back
      if (!this.onScreen(this.pos.x, this.pos.y)) {
        const c = this.nearestScreenCenter(this.pos.x, this.pos.y);
        this.heading += angleDiff(this.heading, Math.atan2(c.y - this.pos.y, c.x - this.pos.x))
          * lag(5, dt);
      }
      // walked onto a window edge? latch on
      for (const L of this.terrain) {
        if (this.pos.x > L.x0 - 8 && this.pos.x < L.x1 + 8 && Math.abs(this.pos.y - L.y) < 20) {
          if (rnd(0, 1) < lag(0.9, dt)) {
            this.ledge = L;
            this.heading = Math.cos(this.heading) >= 0 ? 0 : Math.PI;
            break;
          }
        }
      }
    }
    this.node.position.z = 0.35 * Math.abs(Math.sin(this.gaitPhase * Math.PI * 2));
  }

  applyAltitude() {
    const s = FLY_SCALE * (1 + 0.8 * this.alt);
    this.node.scale.set(s, s, s);
    this.node.position.z = 90 * this.alt;
  }

  updateFlight(dt) {
    this.flightT = Math.min(1, this.flightT + dt / this.flightDur);
    if (this.flightT >= 1) {
      // touchdown flare: the timer ended, but the fly lands only when it
      // has actually descended — hover over the target and settle down.
      this.pos.x = this.flightTo.x + Math.sin(this.time * 26) * 1.2;
      this.pos.y = this.flightTo.y + Math.cos(this.time * 22) * 1.0;
      this.pitch = clampf(this.alt * 0.4, 0, 0.35);   // gentle nose-up flare
      this.alt += (0 - this.alt) * lag(9, dt);
      this.applyAltitude();
      if (this.alt < 0.035) { this.pos = { x: this.flightTo.x, y: this.flightTo.y }; this.land(); }
      return;
    }
    const e = smoothstep(this.flightT);
    const dx = this.flightTo.x - this.flightFrom.x, dy = this.flightTo.y - this.flightFrom.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const px = -dy / len, py = dx / len;
    const wob = Math.sin(this.time * 32) * 4 * Math.sin(this.flightT * Math.PI);
    this.pos.x = this.flightFrom.x + dx * e + px * wob;
    this.pos.y = this.flightFrom.y + dy * e + py * wob;
    this.heading = Math.atan2(dy, dx) + Math.sin(this.time * 18) * 0.12;
    // altitude: climb, effort-scaled cruise with buzz-wobble, descend to land.
    // Effort stays live: ongoing escape-DN (DNp02/04/11) and arousal activity
    // pushes the fly to beat harder and fly higher mid-flight.
    this.effortCurrent = this.brainLive
      ? clampf(Math.max(this.flightEffort,
                        this.flightEffort * 0.55 + this.liveArousal * 0.25 + this.liveWing * 0.6),
               0.25, 1.3)
      : this.flightEffort;
    const riseEnv = Math.min(this.flightT / 0.25, 1);
    const fallEnv = Math.min((1 - this.flightT) / 0.3, 1);
    const target = this.effortCurrent * Math.min(riseEnv, fallEnv) * (0.85 + 0.15 * Math.sin(this.time * 7));
    this.pitch = clampf((target - this.alt) * 2.5, -0.45, 0.45);   // nose up while climbing
    this.alt += (target - this.alt) * lag(6, dt);
    // higher = closer to the viewer = bigger, and the shadow slides away
    this.applyAltitude();
  }

  updateLegs(dt) {
    const v = Math.abs(this.effectiveSpeed);
    const walking = (this.state === 'walking' && v > 1);
    if (walking) {
      const amp = clampf(0.20 + v * 0.0022, 0.20, 0.50);
      const stride = Math.max(5, 2 * amp * 13);
      const freq = clampf(v / stride, 3, 11);
      this.gaitPhase = (this.gaitPhase + freq * dt) % 1;
      // Swing lasts a near-constant ~35 ms whatever the speed; it is stance
      // that shortens as the fly speeds up. A fixed fraction did the opposite.
      const stanceFrac = clampf(1 - SWING_DUR * freq, 0.35, 0.9);
      for (const leg of this.model.legs) {
        const p = (this.gaitPhase + leg.phase) % 1;
        if (p < stanceFrac) {
          leg.angle = amp * (1 - 2 * (p / stanceFrac));
          leg.lift = 0;
        } else {
          const s = (p - stanceFrac) / (1 - stanceFrac);
          leg.angle = -amp + 2 * amp * smoothstep(s);
          leg.lift = Math.sin(s * Math.PI) * 0.55;
        }
        if (this.backwardTimer > 0) leg.angle = -leg.angle;
        leg.apply();
      }
    } else if (this.state === 'grooming') {
      for (const leg of this.model.legs) {
        if (leg.isFront) {
          leg.angle = 0.45 + 0.25 * Math.sin(this.time * 20 + leg.swingSign * 1.3);
          leg.lift = 0.55 + 0.15 * Math.sin(this.time * 22);
        } else {
          leg.angle += (0 - leg.angle) * lag(8, dt);
          leg.lift += (0 - leg.lift) * lag(8, dt);
        }
        leg.apply();
      }
    } else if (this.state === 'flying') {
      for (const leg of this.model.legs) {
        leg.angle += (-0.35 - leg.angle) * lag(6, dt);
        leg.lift += (0.5 - leg.lift) * lag(6, dt);
        leg.apply();
      }
    } else {
      for (const leg of this.model.legs) {
        leg.angle += (0 - leg.angle) * lag(10, dt);
        leg.lift += (0 - leg.lift) * lag(10, dt);
        leg.apply();
      }
    }
  }

  updateWings(dt) {
    if (this.state !== 'flying') {
      // grounded threat posture: escape-DN / loom activity raises the wings
      if (this.model.foldedWings.visible) {
        const raiseTarget = (this.state !== 'sleeping'
          && (this.liveWing > 0.7 || (this.brainLive && this.dartTimer > 0))) ? 1 : 0;
        this.wingRaise += (raiseTarget - this.wingRaise) * lag(8, dt);
        if (this.wingRaise > 0.01) {
          this.model.foldedWings.children.forEach((wing, i) => {
            const side = i === 0 ? -1 : 1;
            wing.rotation.set(-0.5 * this.wingRaise, 0, side * (0.13 + 0.3 * this.wingRaise));
          });
        }
      }
      return;
    }
    // visible wing-beat: the wing shapes sweep through a stroke arc,
    // faster when the live effort is higher
    this.flapPhase = (this.flapPhase + dt * (14 + 10 * this.effortCurrent)) % 1;
    const stroke = Math.sin(this.flapPhase * 2 * Math.PI);
    this.model.foldedWings.children.forEach((wing, i) => {
      const side = i === 0 ? -1 : 1;
      wing.rotation.set(stroke * 0.35, 0, side * (0.45 + 0.35 * (0.5 + 0.5 * stroke)));
    });
    const flick = 0.10 + 0.14 * Math.abs(stroke);
    this.model.blurWingL.material.opacity = flick;
    this.model.blurWingR.material.opacity = flick;
    this.model.blurWingL.rotation.set(0, 0, 0.45 + stroke * 0.2);
    this.model.blurWingR.rotation.set(0, 0, -0.45 - stroke * 0.2);
  }
}

export { makeSignals };
