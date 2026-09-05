// Reduced articulated-body mechanics, not measured fly physics. Mirrors
// LegDynamics.swift: muscle actions are annotated; forces, damping, joint
// limits and the rigid no-slip ground approximation are modeling assumptions.
const limited = (x, a, b) => Number.isFinite(x) ? Math.min(b, Math.max(a, x)) : a;

export function makeLegMotorCommand() {
  return { protract: 0, retract: 0, lift: 0, depress: 0, flex: 0, extend: 0 };
}

export function makeLegFeedback() {
  return { hipAngle: 0, hipVelocity: 0, kneeAngle: 0.95, kneeVelocity: 0,
    contact: false, load: 0, footHeight: 0, elevationAngle: 0,
    elevationVelocity: 0, footX: 0, footY: 0 };
}

export class LegDynamics {
  static hipLimit = 0.65;
  static kneeRange = [0.15, 1.80];
  static elevationRange = [-0.25, 1.35];
  static restKnee = 0.95;
  static ankleAngle = 0.35;

  constructor(geometry) {
    this.geometry = geometry;
    this.restElevation = LegDynamics.groundElevation(geometry, LegDynamics.restKnee);
    this.feedback = makeLegFeedback();
    this.feedback.elevationAngle = this.restElevation;
    this.updateFoot(true);
  }

  static groundElevation(g, knee) {
    const a = g.femur + g.tibia * Math.cos(knee) + g.tarsus * Math.cos(knee + this.ankleAngle);
    const b = g.tibia * Math.sin(knee) + g.tarsus * Math.sin(knee + this.ankleAngle);
    return Math.atan2(b, a) - Math.asin(limited(g.attachZ / Math.max(0.001, Math.hypot(a, b)), -1, 1));
  }

  updateFoot(grounded) {
    const g = this.geometry, f = this.feedback;
    const e = f.elevationAngle, k = f.kneeAngle;
    const reach = g.femur * Math.cos(e) + g.tibia * Math.cos(e - k)
      + g.tarsus * Math.cos(e - k - LegDynamics.ankleAngle);
    const yaw = g.baseYaw + g.side * f.hipAngle;
    f.footX = g.attachX + Math.cos(yaw) * reach;
    f.footY = g.attachY + Math.sin(yaw) * reach;
    f.footHeight = g.attachZ + g.femur * Math.sin(e) + g.tibia * Math.sin(e - k)
      + g.tarsus * Math.sin(e - k - LegDynamics.ankleAngle);
    f.contact = grounded && f.footHeight <= 0.015;
    f.load = f.contact ? 1 : 0;
  }

  resetContact(grounded) { this.updateFoot(grounded); }

  // Resume motor control from the pose that was actually displayed. The
  // observed velocities are converted from wall time to the motor clock.
  adoptPose(pose, grounded, velocityScale = 1) {
    if (![pose.hipAngle, pose.elevationAngle, pose.kneeAngle].every(Number.isFinite)) return;
    const scale = Number.isFinite(velocityScale) && velocityScale > 0 ? velocityScale : 1;
    const speed = (value, limit) => Number.isFinite(value * scale)
      ? limited(value * scale, -limit, limit) : 0;
    const f = this.feedback;
    f.hipAngle = limited(pose.hipAngle, -LegDynamics.hipLimit, LegDynamics.hipLimit);
    f.elevationAngle = limited(pose.elevationAngle, ...LegDynamics.elevationRange);
    f.kneeAngle = limited(pose.kneeAngle, ...LegDynamics.kneeRange);
    f.hipVelocity = speed(pose.hipVelocity, 20);
    f.elevationVelocity = speed(pose.elevationVelocity, 20);
    f.kneeVelocity = speed(pose.kneeVelocity, 40);
    this.updateFoot(grounded);
    f.load = 0;
  }

  step(command, dt, grounded) {
    const p = limited(command.protract, 0, 1), r = limited(command.retract, 0, 1);
    const l = limited(command.lift, 0, 1), d = limited(command.depress, 0, 1);
    const flex = limited(command.flex, 0, 1), extend = limited(command.extend, 0, 1);
    const old = { ...this.feedback }, f = this.feedback;
    f.hipVelocity += (300 * (p - r) - 26 * old.hipVelocity
      - (18 + 12 * Math.min(p, r)) * old.hipAngle) * dt;
    f.hipAngle = limited(old.hipAngle + f.hipVelocity * dt, -LegDynamics.hipLimit, LegDynamics.hipLimit);
    f.elevationVelocity += (800 * (l - d) - 45 * old.elevationVelocity
      - (800 + 120 * Math.min(l, d)) * (old.elevationAngle - this.restElevation) - (grounded ? 80 : 0)) * dt;
    f.elevationAngle = limited(old.elevationAngle + f.elevationVelocity * dt, ...LegDynamics.elevationRange);
    f.kneeVelocity += (1140 * (flex - extend) - 36 * old.kneeVelocity
      - (240 + 80 * Math.min(flex, extend)) * (old.kneeAngle - LegDynamics.restKnee)) * dt;
    f.kneeAngle = limited(old.kneeAngle + f.kneeVelocity * dt, ...LegDynamics.kneeRange);
    this.updateFoot(grounded);
    const attemptedElevation = f.elevationAngle;
    let reaction = 0;
    if (grounded && f.footHeight < 0) {
      f.elevationAngle = Math.max(f.elevationAngle, LegDynamics.groundElevation(this.geometry, f.kneeAngle));
      reaction = Math.max(0, f.elevationAngle - attemptedElevation) / (dt * dt);
      this.updateFoot(grounded);
    }
    f.load = f.contact ? reaction : 0;
    f.hipVelocity = (f.hipAngle - old.hipAngle) / dt;
    f.elevationVelocity = (f.elevationAngle - old.elevationAngle) / dt;
    f.kneeVelocity = (f.kneeAngle - old.kneeAngle) / dt;
  }
}

export class SixLegDynamics {
  static fixedDT = 1 / 600;
  constructor(geometries) {
    this.legs = geometries.map((geometry) => new LegDynamics(geometry));
    this.accumulator = 0;
  }
  get feedback() {
    const total = this.legs.reduce((sum, leg) => sum + (leg.feedback.contact ? leg.feedback.load : 0), 0);
    return this.legs.map(({ feedback: f }) => ({ ...f,
      load: f.contact && total > 0 ? f.load / total : 0 }));
  }
  resetContact(grounded) { for (const leg of this.legs) leg.resetContact(grounded); }

  adoptPose(poses, grounded, velocityScale = 1) {
    if (poses.length !== this.legs.length || !poses.every((p) =>
      [p.hipAngle, p.elevationAngle, p.kneeAngle].every(Number.isFinite))) return;
    this.legs.forEach((leg, i) => leg.adoptPose(poses[i], grounded, velocityScale));
    this.accumulator = 0;
  }

  advance(commands, dt, grounded = true) {
    const result = { forward: 0, lateral: 0, yaw: 0 };
    if (commands.length !== this.legs.length || !Number.isFinite(dt) || dt <= 0) return result;
    this.accumulator += Math.min(dt, 0.1);
    const h = SixLegDynamics.fixedDT;
    while (this.accumulator + 1e-10 >= h) {
      this.accumulator -= h;
      const old = this.feedback;
      this.legs.forEach((leg, i) => leg.step(commands[i], h, grounded));
      const current = this.feedback;
      const support = this.legs.map((leg, i) => i).filter((i) =>
        old[i].contact && current[i].contact && old[i].load > 1e-8 && current[i].load > 1e-8);
      if (!grounded || support.length < 2) continue;
      const weights = support.map((i) => Math.sqrt(old[i].load * current[i].load));
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);
      let mx = 0, my = 0, dx = 0, dy = 0;
      for (let slot = 0; slot < support.length; slot++) {
        const i = support[slot], now = current[i], weight = weights[slot] / totalWeight;
        mx += now.footX * weight; my += now.footY * weight;
        dx += (now.footX - old[i].footX) * weight;
        dy += (now.footY - old[i].footY) * weight;
      }
      let moment = 0, radius = 0;
      for (let slot = 0; slot < support.length; slot++) {
        const i = support[slot], now = current[i], weight = weights[slot] / totalWeight;
        const x = now.footX - mx, y = now.footY - my;
        moment += weight * (x * (now.footY - old[i].footY - dy) - y * (now.footX - old[i].footX - dx));
        radius += weight * (x * x + y * y);
      }
      const yaw = limited(-moment / Math.max(1, radius), -5 * h, 5 * h);
      const lateral = limited(-dx + yaw * my, -150 * h, 150 * h);
      const forward = limited(-dy - yaw * mx, -150 * h, 150 * h);
      result.lateral += lateral * Math.cos(result.yaw) - forward * Math.sin(result.yaw);
      result.forward += lateral * Math.sin(result.yaw) + forward * Math.cos(result.yaw);
      result.yaw += yaw;
    }
    return result;
  }
}
