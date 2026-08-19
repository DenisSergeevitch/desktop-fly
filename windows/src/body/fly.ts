// body/fly.ts — the fly's behavior, transliterated from FlyModel.swift:253-682.
//
// Coordinate convention, kept identical to the macOS build: x/y are scene
// coordinates with the origin at the centre of the display and y up; height
// lives in node.position.z and yaw in rotation.z, because the overlay camera
// looks down -Z at an XY plane. Every altitude and gait assertion depends on
// this, and M2b's camera is built to match.

import * as THREE from 'three';
import { buildFlyModel, type FlyModelParts } from './flyModel.ts';
import { EDGE_MARGIN, FLY_SCALE, NERVOUS_RADIUS, SCARE_RADIUS } from './constants.ts';
// angleDiff is used by updateWalk, filled in by Task 4
import { angleDiff, clampf, makeRng, rnd, smoothstep, type Rng } from '../core/mathutil.ts';
import type { BrainSignals, Ledge } from '../core/types.ts';

export type FlyState = 'walking' | 'idle' | 'grooming' | 'flying' | 'sleeping';

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  width: number;
  height: number;
}

export interface StartFlightOptions {
  bounds: Bounds;
  awayFrom?: Point | null;
  escape?: boolean;
  effort?: number;
}

export class Fly {
  readonly model: FlyModelParts;

  pos: Point;
  heading: number;
  speed = 30;
  state: FlyState = 'walking';
  stateTimer: number;
  gaitPhase: number;
  time: number;
  scareCooldown = 0;
  dartCooldown = 0;
  backwardTimer = 0;
  dartTimer = 0;
  stateAge = 0;
  terrain: Ledge[] = [];        // walkable window edges, set by the coordinator
  ledge: Ledge | null = null;   // currently attached window edge

  flightFrom: Point = { x: 0, y: 0 };
  flightTo: Point = { x: 0, y: 0 };
  flightT = 0;
  flightDur = 1;
  flightEffort = 0.6;    // set at takeoff: escape = 1, casual from arousal
  effortCurrent = 0.6;   // live: base + ongoing DNp02/04/11 + arousal
  alt = 0;               // 0 ground .. 1 max altitude
  pitch = 0;             // body pitch while climbing/descending
  flapPhase = 0;
  wingRaise = 0;         // grounded threat posture (escape-DN driven)

  private brainLive = false;
  private liveArousal = 0;
  private liveWing = 0;
  private readonly rng: Rng;

  constructor(at: Point, seed: number = (Date.now() & 0x7fffffff) || 1) {
    this.rng = makeRng(seed);
    this.model = buildFlyModel();
    this.pos = { x: at.x, y: at.y };
    this.heading = rnd(this.rng, 0, 2 * Math.PI);
    this.stateTimer = rnd(this.rng, 1.5, 4);
    this.gaitPhase = rnd(this.rng, 0, 1);
    this.time = rnd(this.rng, 0, 100);
    this.syncNode();
  }

  get node(): THREE.Object3D {
    return this.model.root;
  }

  get gaitPhasePublic(): number {
    return this.gaitPhase;
  }

  get walkingIntensity(): number {
    return this.state === 'walking'
      ? clampf(Math.abs(this.backwardTimer > 0 ? 22 : this.speed) / 60, 0, 1)
      : 0;
  }

  syncNode(): void {
    this.node.position.set(this.pos.x, this.pos.y, this.node.position.z);
    this.node.rotation.set(this.pitch, 0, this.heading - Math.PI / 2);
  }

  // FlyModel.swift:304-346
  startFlight(opts: StartFlightOptions): void {
    const { bounds } = opts;
    const escape = opts.escape ?? false;
    const awayFrom = opts.awayFrom ?? null;

    this.state = 'flying';
    this.stateAge = 0;
    this.ledge = null;
    this.flightEffort = clampf(
      opts.effort ?? (escape ? 1.0 : rnd(this.rng, 0.4, 0.75)), 0.25, 1);
    this.effortCurrent = this.flightEffort;
    this.flapPhase = 0;
    this.wingRaise = 0;
    this.flightFrom = { x: this.pos.x, y: this.pos.y };
    const hw = bounds.width / 2 - EDGE_MARGIN;
    const hh = bounds.height / 2 - EDGE_MARGIN;
    let target: Point = { x: 0, y: 0 };
    let chosen = false;
    // casual flights often land on a window edge
    if (!escape && awayFrom === null && this.terrain.length > 0
        && rnd(this.rng, 0, 1) < 0.45) {
      const L = this.terrain[Math.floor(rnd(this.rng, 0, this.terrain.length))];
      if (L.x1 - L.x0 > 90) {
        target = { x: rnd(this.rng, L.x0 + 25, L.x1 - 25), y: L.y };
        chosen = Math.hypot(target.x - this.pos.x, target.y - this.pos.y) > 180;
      }
    }
    if (!chosen) {
      for (let i = 0; i < 16; i++) {
        target = { x: rnd(this.rng, -hw, hw), y: rnd(this.rng, -hh, hh) };
        const far = Math.hypot(target.x - this.pos.x, target.y - this.pos.y)
          > (escape ? 350 : 260);
        if (!far) continue;
        if (awayFrom !== null) {
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
    this.flightDur = escape
      ? clampf(dist / 650, 0.45, 1.2)
      : clampf(dist / 420, 0.7, 2.0);
    this.flightT = 0;
    this.scareCooldown = escape ? 2.0 : 2.5;
    // wings stay visible and beat; blur discs add the motion-smear
    this.model.blurWingL.visible = true;
    this.model.blurWingR.visible = true;
  }

  // FlyModel.swift:348-363
  private land(): void {
    this.setState('idle');
    this.stateTimer = rnd(this.rng, 0.3, 0.8);
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

  // FlyModel.swift:365-384
  private pickNextState(): void {
    switch (this.state) {
      case 'walking': {
        const r = rnd(this.rng, 0, 1);
        if (r < 0.30) {
          this.setState('idle');
          this.stateTimer = rnd(this.rng, 0.8, 3);
          this.speed = 0;
        } else if (r < 0.55) {
          this.stateTimer = rnd(this.rng, 0.3, 0.8);
          this.speed = rnd(this.rng, 95, 150);
          this.heading += rnd(this.rng, -1.2, 1.2);
        } else {
          this.stateTimer = rnd(this.rng, 1.5, 5);
          this.speed = rnd(this.rng, 18, 45);
        }
        break;
      }
      case 'idle': {
        const r = rnd(this.rng, 0, 1);
        if (r < 0.35) {
          this.setState('grooming');
          this.stateTimer = rnd(this.rng, 1.0, 2.5);
        } else {
          this.setState('walking');
          this.stateTimer = rnd(this.rng, 1.5, 5);
          this.speed = rnd(this.rng, 18, 45);
          this.heading += rnd(this.rng, -1.5, 1.5);
        }
        break;
      }
      case 'grooming':
        this.setState('idle');
        this.stateTimer = rnd(this.rng, 0.3, 1.0);
        break;
      case 'flying':
      case 'sleeping':
        break;
    }
  }

  // FlyModel.swift:438-442
  private setState(s: FlyState): void {
    if (s === this.state) return;
    this.state = s;
    this.stateAge = 0;
  }

  // FlyModel.swift:386-436
  update(dt: number, bounds: Bounds, mouse: Point | null,
         signals: BrainSignals | null): void {
    this.time += dt;
    this.scareCooldown = Math.max(0, this.scareCooldown - dt);
    this.dartCooldown = Math.max(0, this.dartCooldown - dt);
    this.backwardTimer = Math.max(0, this.backwardTimer - dt);

    this.stateAge += dt;
    this.dartTimer = Math.max(0, this.dartTimer - dt);

    // live brain drives reach the wings even mid-flight
    this.brainLive = signals !== null;
    this.liveArousal = signals?.arousal ?? 0;
    this.liveWing = signals?.wingDrive ?? 0;

    if (this.state === 'flying') {
      this.updateFlight(dt);
    } else if (signals !== null) {
      this.brainBehavior(signals, dt, bounds, mouse);
      if (this.state === 'walking') this.updateWalk(dt, bounds);
    } else {
      if (this.scareCooldown === 0 && mouse !== null) {
        // legacy distance-based fear (extra, brainless flies)
        const mouseDist = Math.hypot(mouse.x - this.pos.x, mouse.y - this.pos.y);
        if (mouseDist < SCARE_RADIUS) {
          this.startFlight({ bounds, awayFrom: mouse });
        } else if (mouseDist < NERVOUS_RADIUS && this.state !== 'walking') {
          this.setState('walking');
          this.heading = Math.atan2(this.pos.y - mouse.y, this.pos.x - mouse.x)
            + rnd(this.rng, -0.4, 0.4);
          this.speed = rnd(this.rng, 110, 150);
          this.stateTimer = rnd(this.rng, 0.4, 0.9);
          this.scareCooldown = 1.0;
        }
      }
      if (this.state !== 'flying') {
        this.stateTimer -= dt;
        if (this.stateTimer <= 0) {
          if (this.state === 'walking' && rnd(this.rng, 0, 1) < 0.10) {
            this.startFlight({ bounds });
          } else {
            this.pickNextState();
          }
        }
        if (this.state === 'walking') this.updateWalk(dt, bounds);
      }
    }

    this.updateLegs(dt);
    this.updateWings(dt);
    // slower, deeper breathing while asleep
    const breathe = this.state === 'sleeping'
      ? 1 + 0.05 * Math.sin(this.time * 1.1)
      : 1 + 0.03 * Math.sin(this.time * 3.0);
    this.model.abdomen.scale.set(0.9, 1.5, 0.75 * breathe);
    this.syncNode();
  }

  // Filled in by M2a Task 5 — FlyModel.swift:444-505.
  private brainBehavior(_s: BrainSignals, _dt: number, _bounds: Bounds,
                        _mouse: Point | null): void {
    // intentionally empty until Task 5
  }

  // Filled in by M2a Task 4 — FlyModel.swift:509-555.
  private updateWalk(_dt: number, _bounds: Bounds): void {
    // intentionally empty until Task 4
  }

  private get effectiveSpeed(): number {
    return this.backwardTimer > 0 ? -22 : this.speed;
  }

  // FlyModel.swift:557-563
  private applyAltitude(): void {
    const s = FLY_SCALE * (1 + 0.8 * this.alt);
    this.node.scale.set(s, s, s);
    this.node.position.z = 90 * this.alt;
  }

  // FlyModel.swift:565-600
  private updateFlight(dt: number): void {
    this.flightT = Math.min(1, this.flightT + dt / this.flightDur);
    if (this.flightT >= 1) {
      // touchdown flare: the timer ended, but the fly lands only when it has
      // actually descended — hover over the target and settle down.
      this.pos.x = this.flightTo.x + Math.sin(this.time * 26) * 1.2;
      this.pos.y = this.flightTo.y + Math.cos(this.time * 22) * 1.0;
      this.pitch = clampf(this.alt * 0.4, 0, 0.35);   // gentle nose-up flare
      this.alt += (0 - this.alt) * Math.min(1, 9 * dt);
      this.applyAltitude();
      if (this.alt < 0.035) {
        this.pos = { x: this.flightTo.x, y: this.flightTo.y };
        this.land();
      }
      return;
    }
    const e = smoothstep(this.flightT);
    const dx = this.flightTo.x - this.flightFrom.x;
    const dy = this.flightTo.y - this.flightFrom.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const px = -dy / len;
    const py = dx / len;
    const wob = Math.sin(this.time * 32) * 4 * Math.sin(this.flightT * Math.PI);
    this.pos.x = this.flightFrom.x + dx * e + px * wob;
    this.pos.y = this.flightFrom.y + dy * e + py * wob;
    this.heading = Math.atan2(dy, dx) + Math.sin(this.time * 18) * 0.12;
    // Effort stays live: ongoing escape-DN (DNp02/04/11) and arousal activity
    // pushes the fly to beat harder and fly higher mid-flight. The max() is
    // load-bearing — a live modifier must never weaken takeoff.
    this.effortCurrent = this.brainLive
      ? clampf(Math.max(this.flightEffort,
          this.flightEffort * 0.55 + this.liveArousal * 0.25 + this.liveWing * 0.6),
        0.25, 1.3)
      : this.flightEffort;
    const riseEnv = Math.min(this.flightT / 0.25, 1);
    const fallEnv = Math.min((1 - this.flightT) / 0.3, 1);
    const target = this.effortCurrent * Math.min(riseEnv, fallEnv)
      * (0.85 + 0.15 * Math.sin(this.time * 7));
    this.pitch = clampf((target - this.alt) * 2.5, -0.45, 0.45);
    this.alt += (target - this.alt) * Math.min(1, 6 * dt);
    // higher = closer to the viewer = bigger, and the shadow slides away
    this.applyAltitude();
  }

  // FlyModel.swift:602-648
  private updateLegs(dt: number): void {
    const v = Math.abs(this.effectiveSpeed);
    const walking = this.state === 'walking' && v > 1;
    if (walking) {
      const amp = clampf(0.20 + v * 0.0022, 0.20, 0.50);
      const stride = Math.max(5, 2 * amp * 13);
      const freq = clampf(v / stride, 3, 11);
      this.gaitPhase = (this.gaitPhase + freq * dt) % 1;
      const stanceFrac = 0.6;
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
          leg.angle += (0 - leg.angle) * Math.min(1, 8 * dt);
          leg.lift += (0 - leg.lift) * Math.min(1, 8 * dt);
        }
        leg.apply();
      }
    } else if (this.state === 'flying') {
      for (const leg of this.model.legs) {
        leg.angle += (-0.35 - leg.angle) * Math.min(1, 6 * dt);
        leg.lift += (0.5 - leg.lift) * Math.min(1, 6 * dt);
        leg.apply();
      }
    } else {
      for (const leg of this.model.legs) {
        leg.angle += (0 - leg.angle) * Math.min(1, 10 * dt);
        leg.lift += (0 - leg.lift) * Math.min(1, 10 * dt);
        leg.apply();
      }
    }
  }

  // FlyModel.swift:650-681
  private updateWings(dt: number): void {
    if (this.state !== 'flying') {
      // grounded threat posture: escape-DN / loom activity raises the wings
      if (this.model.foldedWings.visible) {
        const raiseTarget = (this.state !== 'sleeping'
          && (this.liveWing > 0.7 || (this.brainLive && this.dartTimer > 0))) ? 1 : 0;
        this.wingRaise += (raiseTarget - this.wingRaise) * Math.min(1, 8 * dt);
        if (this.wingRaise > 0.01) {
          this.model.foldedWings.children.forEach((wing, i) => {
            const side = i === 0 ? -1 : 1;
            wing.rotation.set(-0.5 * this.wingRaise, 0,
              side * (0.13 + 0.3 * this.wingRaise));
          });
        }
      }
      return;
    }
    // visible wing-beat: the wing shapes sweep through a stroke arc, faster
    // when the live effort is higher
    this.flapPhase = (this.flapPhase + dt * (14 + 10 * this.effortCurrent)) % 1;
    const stroke = Math.sin(this.flapPhase * 2 * Math.PI);
    this.model.foldedWings.children.forEach((wing, i) => {
      const side = i === 0 ? -1 : 1;
      wing.rotation.set(stroke * 0.35, 0,
        side * (0.45 + 0.35 * (0.5 + 0.5 * stroke)));
    });
    const flick = 0.10 + 0.14 * Math.abs(stroke);
    const setOpacity = (n: THREE.Object3D, o: number) => {
      const m = (n as THREE.Mesh).material as THREE.Material;
      m.opacity = o;
    };
    setOpacity(this.model.blurWingL, flick);
    setOpacity(this.model.blurWingR, flick);
    this.model.blurWingL.rotation.set(0, 0, 0.45 + stroke * 0.2);
    this.model.blurWingR.rotation.set(0, 0, -0.45 - stroke * 0.2);
  }
}
