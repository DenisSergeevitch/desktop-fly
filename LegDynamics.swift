// LegDynamics.swift — reduced articulated-body mechanics, NOT measured fly physics.
// Motor channels correspond to annotated muscle actions; inertia, damping, joint
// limits and the no-slip ground approximation below are explicit model choices.
import Foundation

struct LegMotorCommand {
    var protract: CGFloat = 0
    var retract: CGFloat = 0
    var lift: CGFloat = 0
    var depress: CGFloat = 0
    var flex: CGFloat = 0
    var extend: CGFloat = 0
}

struct LegFeedback {
    var hipAngle: CGFloat = 0
    var hipVelocity: CGFloat = 0
    var kneeAngle: CGFloat = 0.95
    var kneeVelocity: CGFloat = 0
    var contact = false
    var load: CGFloat = 0
    var footHeight: CGFloat = 0
    var elevationAngle: CGFloat = 0
    var elevationVelocity: CGFloat = 0
    var footX: CGFloat = 0
    var footY: CGFloat = 0
}

struct LegGeometry {
    let attachX, attachY, attachZ: CGFloat
    let baseYaw, side: CGFloat
    let femur, tibia, tarsus: CGFloat
}

struct LegBodyMotion {
    var forward: CGFloat = 0
    var lateral: CGFloat = 0
    var yaw: CGFloat = 0
}

private func limited(_ x: CGFloat, _ a: CGFloat, _ b: CGFloat) -> CGFloat {
    x.isFinite ? min(b, max(a, x)) : a
}

struct LegDynamics {
    static let hipLimit: CGFloat = 0.65
    static let kneeRange: ClosedRange<CGFloat> = 0.15...1.80
    static let elevationRange: ClosedRange<CGFloat> = -0.25...1.35
    static let restKnee: CGFloat = 0.95
    static let ankleAngle: CGFloat = 0.35
    let geometry: LegGeometry
    private(set) var feedback: LegFeedback
    private let restElevation: CGFloat

    init(geometry: LegGeometry) {
        self.geometry = geometry
        // Solve the foot/ground intersection from this body's actual segment
        // lengths; swapping to the beetle therefore keeps feet on its ground.
        restElevation = Self.groundElevation(geometry, knee: Self.restKnee)
        feedback = LegFeedback()
        feedback.elevationAngle = restElevation
        updateFoot(grounded: true)
    }

    static func groundElevation(_ g: LegGeometry, knee: CGFloat) -> CGFloat {
        let a = g.femur + g.tibia * cos(knee) + g.tarsus * cos(knee + ankleAngle)
        let b = g.tibia * sin(knee) + g.tarsus * sin(knee + ankleAngle)
        return atan2(b, a) - asin(limited(g.attachZ / max(0.001, hypot(a, b)), -1, 1))
    }

    private mutating func updateFoot(grounded: Bool) {
        let g = geometry, f = feedback
        let e = f.elevationAngle, k = f.kneeAngle
        let reach = g.femur * cos(e) + g.tibia * cos(e - k)
            + g.tarsus * cos(e - k - Self.ankleAngle)
        let yaw = g.baseYaw + g.side * f.hipAngle
        feedback.footX = g.attachX + cos(yaw) * reach
        feedback.footY = g.attachY + sin(yaw) * reach
        feedback.footHeight = g.attachZ + g.femur * sin(e) + g.tibia * sin(e - k)
            + g.tarsus * sin(e - k - Self.ankleAngle)
        feedback.contact = grounded && feedback.footHeight <= 0.015
        feedback.load = feedback.contact ? 1 : 0
    }

    mutating func resetContact(grounded: Bool) {
        updateFoot(grounded: grounded)
    }

    // Hand control back from a scripted pose without restoring an old walking
    // state. Source velocities are observed movement, not remembered motor
    // velocities; divide by thermal tempo when converting wall to model time.
    mutating func adoptPose(_ pose: LegFeedback, grounded: Bool, velocityScale: CGFloat = 1) {
        guard pose.hipAngle.isFinite, pose.elevationAngle.isFinite, pose.kneeAngle.isFinite else { return }
        let scale = velocityScale.isFinite && velocityScale > 0 ? velocityScale : 1
        func speed(_ value: CGFloat, limit: CGFloat) -> CGFloat {
            let scaled = value * scale
            return scaled.isFinite ? limited(scaled, -limit, limit) : 0
        }
        feedback.hipAngle = limited(pose.hipAngle, -Self.hipLimit, Self.hipLimit)
        feedback.elevationAngle = limited(pose.elevationAngle,
            Self.elevationRange.lowerBound, Self.elevationRange.upperBound)
        feedback.kneeAngle = limited(pose.kneeAngle, Self.kneeRange.lowerBound, Self.kneeRange.upperBound)
        feedback.hipVelocity = speed(pose.hipVelocity, limit: 20)
        feedback.elevationVelocity = speed(pose.elevationVelocity, limit: 20)
        feedback.kneeVelocity = speed(pose.kneeVelocity, limit: 40)
        // Preserve the incoming pose even at touchdown. Ground constraints are
        // resolved by the next physical step, not a teleport during adoption.
        updateFoot(grounded: grounded)
        feedback.load = 0
    }

    // Semi-implicit damped joint integration. An antagonist difference supplies
    // torque; coactivation adds stiffness rather than generating free movement.
    // No gait phase, body speed or desired foot trajectory enters this method.
    mutating func step(_ command: LegMotorCommand, dt: CGFloat, grounded: Bool) {
        let p = limited(command.protract, 0, 1), r = limited(command.retract, 0, 1)
        let l = limited(command.lift, 0, 1), d = limited(command.depress, 0, 1)
        let f = limited(command.flex, 0, 1), e = limited(command.extend, 0, 1)
        let old = feedback
        feedback.hipVelocity += (300 * (p - r) - 26 * old.hipVelocity
            - (18 + 12 * min(p, r)) * old.hipAngle) * dt
        feedback.hipAngle = limited(old.hipAngle + feedback.hipVelocity * dt,
                                    -Self.hipLimit, Self.hipLimit)
        // A small modeled body load keeps unpowered supporting legs grounded;
        // the substrate reaction below counters it without translating the fly.
        feedback.elevationVelocity += (800 * (l - d) - 45 * old.elevationVelocity
            - (800 + 120 * min(l, d)) * (old.elevationAngle - restElevation)
            - (grounded ? 80 : 0)) * dt
        feedback.elevationAngle = limited(old.elevationAngle + feedback.elevationVelocity * dt,
                                          Self.elevationRange.lowerBound, Self.elevationRange.upperBound)
        // Shared muscle/joint calibration: the tibia must respond before a
        // coactivated trochanter unloads it. The former weak, slow knee reversed
        // the MDN power stroke by flexing only after the foot was airborne.
        // These force and stiffness values are modeled, not measured anatomy.
        feedback.kneeVelocity += (1140 * (f - e) - 36 * old.kneeVelocity
            - (240 + 80 * min(f, e)) * (old.kneeAngle - Self.restKnee)) * dt
        feedback.kneeAngle = limited(old.kneeAngle + feedback.kneeVelocity * dt,
                                     Self.kneeRange.lowerBound, Self.kneeRange.upperBound)
        updateFoot(grounded: grounded)
        let attemptedElevation = feedback.elevationAngle
        var reaction: CGFloat = 0
        if grounded && feedback.footHeight < 0 {
            // Unilateral ground constraint: the substrate can push up, never
            // pull the foot down. Project elevation only when the toe penetrates.
            feedback.elevationAngle = max(feedback.elevationAngle,
                Self.groundElevation(geometry, knee: feedback.kneeAngle))
            // The acceleration removed by the constraint estimates the relative
            // support reaction. Lift reduces this before toe-off; depression
            // increases it. These are model units, not measured force in newtons.
            reaction = max(0, feedback.elevationAngle - attemptedElevation) / (dt * dt)
            updateFoot(grounded: grounded)
        }
        feedback.load = feedback.contact ? reaction : 0
        // Report realized movement after joint limits/contact, not the attempted
        // motor velocity. This is the proprioceptive signal sent back to the VNC.
        feedback.hipVelocity = (feedback.hipAngle - old.hipAngle) / dt
        feedback.elevationVelocity = (feedback.elevationAngle - old.elevationAngle) / dt
        feedback.kneeVelocity = (feedback.kneeAngle - old.kneeAngle) / dt
    }
}

final class SixLegDynamics {
    static let fixedDT: CGFloat = 1 / 600
    private(set) var legs: [LegDynamics]
    private var accumulator: CGFloat = 0
    var feedback: [LegFeedback] {
        let totalReaction = legs.reduce(CGFloat(0)) { $0 + ($1.feedback.contact ? $1.feedback.load : 0) }
        return legs.map {
            var value = $0.feedback
            value.load = value.contact && totalReaction > 0 ? value.load / totalReaction : 0
            return value
        }
    }

    init(geometries: [LegGeometry]) {
        legs = geometries.map { LegDynamics(geometry: $0) }
    }

    func resetContact(grounded: Bool) {
        for i in legs.indices { legs[i].resetContact(grounded: grounded) }
    }

    func adoptPose(_ poses: [LegFeedback], grounded: Bool, velocityScale: CGFloat = 1) {
        // Reject an incomplete/invalid sample atomically rather than combining
        // some newly rendered joints with stale joints from the previous mode.
        guard poses.count == legs.count,
              poses.allSatisfy({ $0.hipAngle.isFinite && $0.elevationAngle.isFinite && $0.kneeAngle.isFinite })
        else { return }
        for i in legs.indices {
            legs[i].adoptPose(poses[i], grounded: grounded, velocityScale: velocityScale)
        }
        // A leftover substep or old support reaction must not become a phantom
        // stance stroke when the next neural command arrives.
        accumulator = 0
    }

    func advance(commands: [LegMotorCommand], dt: CGFloat, grounded: Bool = true) -> LegBodyMotion {
        guard commands.count == legs.count, dt.isFinite, dt > 0 else { return LegBodyMotion() }
        accumulator += min(dt, 0.1)
        var result = LegBodyMotion()
        let h = Self.fixedDT
        while accumulator + 1e-10 >= h {
            accumulator -= h
            let old = feedback
            for i in legs.indices { legs[i].step(commands[i], dt: h, grounded: grounded) }
            let current = feedback
            // Fit the rigid body displacement that keeps supporting feet still
            // on the ground. A newly landed or airborne foot supplies no thrust.
            let support = legs.indices.filter {
                old[$0].contact && current[$0].contact && old[$0].load > 1e-8 && current[$0].load > 1e-8
            }
            guard grounded, support.count >= 2 else { continue }
            let weights = support.map { sqrt(old[$0].load * current[$0].load) }
            let totalWeight = weights.reduce(0, +)
            var mx: CGFloat = 0, my: CGFloat = 0, dx: CGFloat = 0, dy: CGFloat = 0
            for (slot, i) in support.enumerated() {
                let now = current[i], weight = weights[slot] / totalWeight
                mx += now.footX * weight; my += now.footY * weight
                dx += (now.footX - old[i].footX) * weight
                dy += (now.footY - old[i].footY) * weight
            }
            var moment: CGFloat = 0, radius: CGFloat = 0
            for (slot, i) in support.enumerated() {
                let now = current[i], weight = weights[slot] / totalWeight
                let x = now.footX - mx, y = now.footY - my
                moment += weight * (x * (now.footY - old[i].footY - dy)
                    - y * (now.footX - old[i].footX - dx))
                radius += weight * (x * x + y * y)
            }
            let yaw = limited(-moment / max(1, radius), -5 * h, 5 * h)
            let lateral = limited(-dx + yaw * my, -150 * h, 150 * h)
            let forward = limited(-dy - yaw * mx, -150 * h, 150 * h)
            // Rotate each substep into the frame at the start of this update.
            result.lateral += lateral * cos(result.yaw) - forward * sin(result.yaw)
            result.forward += lateral * sin(result.yaw) + forward * cos(result.yaw)
            result.yaw += yaw
        }
        return result
    }
}
