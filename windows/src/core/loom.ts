// core/loom.ts — cursor kinematics -> looming drive for each eye, plus air puff.
// Transliterated from main.swift:603-630.
//
// This is the sensory transduction step: the last non-connectome link in the
// chain. Everything downstream of the value it produces — the LC4/LPLC2
// population and all of its targets — is real FlyWire wiring.

import { clampf } from './mathutil.ts';

export interface LoomOutput {
  l: number;
  r: number;
  puff: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export class LoomTransducer {
  private prevMouse: Vec2 | null = null;
  private velX = 0;
  private velY = 0;

  reset(): void {
    this.prevMouse = null;
    this.velX = 0;
    this.velY = 0;
  }

  compute(flyPos: Vec2, heading: number, mouse: Vec2 | null, dt: number,
          loomOverride = 0): LoomOutput {
    if (mouse === null) return { l: 0, r: 0, puff: 0 };
    if (this.prevMouse !== null && dt > 0) {
      const vx = (mouse.x - this.prevMouse.x) / dt;
      const vy = (mouse.y - this.prevMouse.y) / dt;
      this.velX += (vx - this.velX) * 0.4;
      this.velY += (vy - this.velY) * 0.4;
    }
    this.prevMouse = { x: mouse.x, y: mouse.y };

    const relX = mouse.x - flyPos.x;
    const relY = mouse.y - flyPos.y;
    const dist = Math.max(20, Math.hypot(relX, relY));
    // radial approach speed (positive = cursor closing in)
    const approach = -(relX * this.velX + relY * this.velY) / dist;
    // loom ~ rate of angular expansion, attenuated with distance
    let loom = clampf(approach / dist * 6, 0, 1) * clampf(1 - dist / 800, 0, 1);
    loom += clampf((130 - dist) / 130, 0, 1) * 0.5;   // hovering close = big object
    loom = clampf(loom + loomOverride, 0, 1);
    // split between eyes by bearing relative to heading
    const fx = Math.cos(heading);
    const fy = Math.sin(heading);
    const rdx = relX / dist;
    const rdy = relY / dist;
    const crossZ = fx * rdy - fy * rdx;              // > 0: threat on the left
    const lw = clampf(0.5 + 0.5 * crossZ, 0.12, 1);
    const rw = clampf(0.5 - 0.5 * crossZ, 0.12, 1);
    const puff = clampf(Math.hypot(this.velX, this.velY) / 1500, 0, 1)
      * clampf(1 - dist / 500, 0, 1);
    return { l: loom * lw, r: loom * rw, puff };
  }
}
