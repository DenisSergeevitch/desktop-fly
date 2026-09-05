// FlyModel.swift — procedural 3D fruit-fly body (FlyWire has no body data;
// the connectome drives behavior, the body is modeled) + per-fly behavior.
// Local frame: +Y forward, +Z up, ground at z=0.

import Cocoa
import SceneKit
import simd

let SHADOWS_ENABLED = true
let FLY_SCALE: CGFloat = 1.15
let EDGE_MARGIN: CGFloat = 50
let SCARE_RADIUS: CGFloat = 110        // legacy behavior (non-connectome flies) only
let NERVOUS_RADIUS: CGFloat = 240      // legacy behavior only

/// Reference frame rate the existing constants were tuned at.
let TUNED_HZ: CGFloat = 60
/// Heading random-walk amplitude, rad/sqrt(s). The variance of a random walk grows
/// with dt, not dt^2, so the old `rnd(-1...1) * 1.6 * dt` form made the fly
/// measurably twitchier on a 60 Hz display than on a 120 Hz one. Dividing by
/// sqrt(TUNED_HZ) reproduces the old 60 Hz spread exactly.
let WANDER_JITTER: CGFloat = 1.6 / sqrt(TUNED_HZ)
/// Same recalibration of the old ledge-walking `0.2 * dt`.
let LEDGE_JITTER: CGFloat = 0.2 / sqrt(TUNED_HZ)

// MARK: - Measured walking kinematics
//
// A walking fly does not steer continuously. It goes nearly straight and changes
// heading in discrete body saccades, with slow sub-threshold drift in between —
// Geurten, Jähde, Rosner & Egelhaaf 2014 (Front Behav Neurosci 8:365,
// 10.3389/fnbeh.2014.00365) scored 1140 saccades against 3348 slow turns in
// freely walking Canton-S at 500 fps. So the shape here is right; the numbers
// were not. The code snapped the heading by up to 86 deg in a single step.

/// Body-saccade amplitude, rad. Measured mean is ~15 deg; this range averages to
/// it. Sign is drawn separately (Geurten et al. 2014).
let SACCADE_MIN: CGFloat = 0.09   // 5 deg
let SACCADE_MAX: CGFloat = 0.44   // 25 deg
/// Body-saccade duration, s — measured 40-120 ms, median 90 (Geurten et al. 2014).
/// A 15 deg turn spent over it peaks near 170 deg/s, just under the 200 deg/s
/// those authors use as the saccade detection threshold.
let SACCADE_DUR: CGFloat = 0.09
/// Swing (leg-in-air) duration, s. Nearly constant across walking speed — it is
/// stance that scales as 1/v — Mendes, Bartos, Akay, Márka & Mann 2013
/// (eLife 2:e00231, 10.7554/eLife.00231, Table 2). The gait used a fixed 40%
/// swing fraction instead, which stretches the swing at low speed.
let SWING_DUR: CGFloat = 0.035

/// Which body geometry to build. Purely cosmetic — every form must satisfy the
/// same `FlyModel` contract, so the behavior layer never branches on it.
enum BodyForm: String {
    case fly = "fruit fly"
    case beetle = "stag beetle"
}
var BODY_FORM: BodyForm = .fly

func buildBody() -> FlyModel {
    switch BODY_FORM {
    case .fly:    return buildFlyModel()
    case .beetle: return buildBeetleModel()
    }
}

func rnd(_ range: ClosedRange<CGFloat>) -> CGFloat { TestRandom.cgFloat(in: range) }
/// Frame-rate-independent form of the `min(1, k * dt)` idiom used throughout this
/// file, for both first-order lags and per-frame event probabilities.
///
/// `k` keeps its original meaning, so call sites are unchanged: at dt = 1/60 this
/// returns exactly `k/60`, the value the constants were tuned against. Away from
/// 60 Hz it follows the geometric decay those constants imply instead of the
/// straight line, which is what made behaviour drift with refresh rate — at the
/// 50 ms dt cap in main.swift the old form converged 27% too fast (0.50 vs 0.39
/// for k = 10).
///
/// Writing it as `1 - exp(-k*dt)` would also be frame-rate independent, but it is
/// a *different* continuous process: it would change the 60 Hz behaviour by 2-8%
/// across the k values used here. This form is the one that leaves 60 Hz alone.
@inline(__always)
func lag(_ k: CGFloat, _ dt: CGFloat) -> CGFloat {
    let perFrame = min(1, k / TUNED_HZ)
    guard perFrame < 1 else { return 1 }
    return 1 - pow(1 - perFrame, TUNED_HZ * dt)
}
func clampf(_ v: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat { min(hi, max(lo, v)) }
func angleDiff(_ from: CGFloat, _ to: CGFloat) -> CGFloat {
    var d = (to - from).truncatingRemainder(dividingBy: 2 * .pi)
    if d > .pi { d -= 2 * .pi }
    if d < -.pi { d += 2 * .pi }
    return d
}
func smoothstep(_ t: CGFloat) -> CGFloat { let x = clampf(t, 0, 1); return x * x * (3 - 2 * x) }

func mat(_ color: NSColor, specular: CGFloat = 0.25, shininess: CGFloat = 0.25) -> SCNMaterial {
    let m = SCNMaterial()
    m.lightingModel = .blinn
    m.diffuse.contents = color
    m.specular.contents = NSColor(white: specular, alpha: 1)
    m.shininess = shininess
    return m
}

func savePNG(_ image: NSImage, to path: String) {
    guard let tiff = image.tiffRepresentation,
          let rep = NSBitmapImageRep(data: tiff),
          let data = rep.representation(using: .png, properties: [:]) else {
        fputs("snapshot: failed to encode PNG\n", stderr); exit(1)
    }
    do { try data.write(to: URL(fileURLWithPath: path)) }
    catch { fputs("snapshot: \(error)\n", stderr); exit(1) }
}

func abdomenTexture() -> NSImage {
    let size = NSSize(width: 64, height: 128)
    let img = NSImage(size: size)
    img.lockFocus()
    let base = NSColor(calibratedRed: 0.72, green: 0.55, blue: 0.32, alpha: 1)
    let dark = NSColor(calibratedRed: 0.22, green: 0.15, blue: 0.09, alpha: 1)
    base.setFill()
    NSRect(origin: .zero, size: size).fill()
    dark.setFill()
    NSRect(x: 0, y: 0, width: 64, height: 26).fill()
    NSRect(x: 0, y: 38, width: 64, height: 10).fill()
    NSRect(x: 0, y: 60, width: 64, height: 10).fill()
    NSRect(x: 0, y: 82, width: 64, height: 9).fill()
    img.unlockFocus()
    return img
}

final class Leg {
    let root: SCNNode
    let knee: SCNNode
    let ankle: SCNNode
    let geometry: LegGeometry
    let baseYaw: CGFloat
    let swingSign: CGFloat
    let phase: CGFloat
    let isFront: Bool
    var angle: CGFloat = 0
    var lift: CGFloat = 0
    var kneeAngle: CGFloat = 0.75

    init(root: SCNNode, knee: SCNNode, ankle: SCNNode, geometry: LegGeometry,
         baseYaw: CGFloat, swingSign: CGFloat, phase: CGFloat, isFront: Bool) {
        self.root = root; self.baseYaw = baseYaw; self.swingSign = swingSign
        self.phase = phase; self.isFront = isFront
        self.knee = knee; self.ankle = ankle; self.geometry = geometry
    }

    func apply() {
        // Every controller uses the same local joint axes. Changing behavior
        // must not change the skeleton's rotation convention or reset a joint.
        root.simdOrientation = simd_quatf(angle: Float(baseYaw + swingSign * angle), axis: SIMD3(0, 0, 1))
            * simd_quatf(angle: Float(-lift), axis: SIMD3(0, 1, 0))
        knee.eulerAngles = SCNVector3(0, kneeAngle, 0)
        ankle.eulerAngles = SCNVector3(0, LegDynamics.ankleAngle, 0)
    }

    func apply(_ feedback: LegFeedback) {
        angle = feedback.hipAngle
        lift = feedback.elevationAngle
        kneeAngle = feedback.kneeAngle
        apply()
    }
}

struct FlyModel {
    let root: SCNNode
    let legs: [Leg]
    let foldedWings: SCNNode
    let blurWingL: SCNNode
    let blurWingR: SCNNode
    let abdomen: SCNNode
    /// Wing cases — beetle forms only, `nil` for the fly. Display-only nodes:
    /// `updateWings` swings them open, nothing reads them back.
    var elytraL: SCNNode? = nil
    var elytraR: SCNNode? = nil
    /// Body-specific wing clearance; the beetle retains its existing stroke.
    var wingFlightSpread: CGFloat = 0.625
}

func buildLeg(attach: SCNVector3, baseYaw: CGFloat, swingSign: CGFloat, phase: CGFloat,
              isFront: Bool, femur: CGFloat, tibia: CGFloat, tarsus: CGFloat,
              color: NSColor = NSColor(calibratedRed: 0.33, green: 0.24, blue: 0.14, alpha: 1),
              thickness: CGFloat = 1) -> Leg {
    let legColor = color
    let root = SCNNode()
    root.position = attach

    let femurGeo = SCNCapsule(capRadius: 0.48 * thickness, height: femur)
    femurGeo.materials = [mat(legColor)]
    let femurNode = SCNNode(geometry: femurGeo)
    femurNode.eulerAngles = SCNVector3(0, 0, -CGFloat.pi / 2)
    femurNode.position = SCNVector3(femur / 2, 0, 0)
    root.addChildNode(femurNode)

    let knee = SCNNode()
    knee.position = SCNVector3(femur, 0, 0)
    knee.eulerAngles = SCNVector3(0, 0.75, -0.30 * swingSign)
    root.addChildNode(knee)

    let tibiaGeo = SCNCapsule(capRadius: 0.38 * thickness, height: tibia)
    tibiaGeo.materials = [mat(legColor)]
    let tibiaNode = SCNNode(geometry: tibiaGeo)
    tibiaNode.eulerAngles = SCNVector3(0, 0, -CGFloat.pi / 2)
    tibiaNode.position = SCNVector3(tibia / 2, 0, 0)
    knee.addChildNode(tibiaNode)

    let ankle = SCNNode()
    ankle.position = SCNVector3(tibia, 0, 0)
    ankle.eulerAngles = SCNVector3(0, 0.35, -0.15 * swingSign)
    knee.addChildNode(ankle)

    let tarsusGeo = SCNCapsule(capRadius: 0.24 * thickness, height: tarsus)
    tarsusGeo.materials = [mat(legColor.blended(withFraction: 0.25, of: .black) ?? legColor)]
    let tarsusNode = SCNNode(geometry: tarsusGeo)
    tarsusNode.eulerAngles = SCNVector3(0, 0, -CGFloat.pi / 2)
    tarsusNode.position = SCNVector3(tarsus / 2, 0, 0)
    ankle.addChildNode(tarsusNode)

    let geometry = LegGeometry(attachX: CGFloat(attach.x), attachY: CGFloat(attach.y),
        attachZ: CGFloat(attach.z), baseYaw: baseYaw, side: swingSign,
        femur: femur, tibia: tibia, tarsus: tarsus)
    let leg = Leg(root: root, knee: knee, ankle: ankle, geometry: geometry,
                  baseYaw: baseYaw, swingSign: swingSign, phase: phase, isFront: isFront)
    leg.apply()
    return leg
}

func wingShape() -> SCNGeometry {
    // Put the hinge at the end of the membrane, so raising a wing cannot
    // rotate a forward-projecting root through the thorax.
    let path = NSBezierPath(ovalIn: NSRect(x: -2.6, y: -16.5, width: 5.2, height: 16.5))
    path.flatness = 0.1
    let shape = SCNShape(path: path, extrusionDepth: 0.12)
    let m = SCNMaterial()
    m.lightingModel = .blinn
    m.diffuse.contents = NSColor(calibratedWhite: 0.92, alpha: 0.28)
    m.specular.contents = NSColor(white: 0.9, alpha: 1)
    m.shininess = 0.9
    m.isDoubleSided = true
    shape.materials = [m]
    return shape
}

func buildFlyModel() -> FlyModel {
    let root = SCNNode()
    root.scale = SCNVector3(FLY_SCALE, FLY_SCALE, FLY_SCALE)

    let bodyBrown = NSColor(calibratedRed: 0.50, green: 0.38, blue: 0.22, alpha: 1)

    let thoraxGeo = SCNSphere(radius: 4.6)
    thoraxGeo.materials = [mat(bodyBrown, specular: 0.35, shininess: 0.4)]
    let thorax = SCNNode(geometry: thoraxGeo)
    thorax.position = SCNVector3(0, 2.5, 6.2)
    thorax.scale = SCNVector3(0.95, 1.15, 0.85)
    root.addChildNode(thorax)

    let abdGeo = SCNSphere(radius: 5.0)
    let abdMat = SCNMaterial()
    abdMat.lightingModel = .blinn
    abdMat.diffuse.contents = abdomenTexture()
    abdMat.specular.contents = NSColor(white: 0.3, alpha: 1)
    abdMat.shininess = 0.35
    abdGeo.materials = [abdMat]
    let abdomen = SCNNode(geometry: abdGeo)
    abdomen.position = SCNVector3(0, -6.5, 5.6)
    abdomen.scale = SCNVector3(0.9, 1.5, 0.75)
    root.addChildNode(abdomen)

    let headGeo = SCNSphere(radius: 3.0)
    headGeo.materials = [mat(bodyBrown.blended(withFraction: 0.15, of: .white) ?? bodyBrown)]
    let head = SCNNode(geometry: headGeo)
    head.position = SCNVector3(0, 9.0, 6.0)
    head.scale = SCNVector3(1.0, 0.85, 0.9)
    root.addChildNode(head)

    let eyeGeo = SCNSphere(radius: 2.0)
    eyeGeo.materials = [mat(NSColor(calibratedRed: 0.62, green: 0.10, blue: 0.07, alpha: 1),
                            specular: 0.9, shininess: 0.9)]
    for side in [CGFloat(-1), 1] {
        let eye = SCNNode(geometry: eyeGeo)
        eye.position = SCNVector3(side * 2.1, 9.7, 6.4)
        eye.scale = SCNVector3(0.8, 1.0, 1.15)
        root.addChildNode(eye)
    }

    let antGeo = SCNCapsule(capRadius: 0.16, height: 2.2)
    antGeo.materials = [mat(NSColor(calibratedRed: 0.3, green: 0.22, blue: 0.13, alpha: 1))]
    for side in [CGFloat(-1), 1] {
        let ant = SCNNode(geometry: antGeo)
        ant.position = SCNVector3(side * 0.9, 11.6, 6.3)
        ant.eulerAngles = SCNVector3(-1.15, 0, side * 0.35)
        root.addChildNode(ant)
    }

    let probGeo = SCNCone(topRadius: 0.6, bottomRadius: 0.22, height: 2.4)
    probGeo.materials = [mat(NSColor(calibratedRed: 0.35, green: 0.26, blue: 0.16, alpha: 1))]
    let prob = SCNNode(geometry: probGeo)
    prob.position = SCNVector3(0, 10.4, 4.6)
    prob.eulerAngles = SCNVector3(-0.5, 0, 0)
    root.addChildNode(prob)

    var legs: [Leg] = []
    let z: CGFloat = 4.5
    let specs: [(CGFloat, SCNVector3, CGFloat, CGFloat, Bool, CGFloat, CGFloat, CGFloat)] = [
        ( 1, SCNVector3( 3.1,  5.3, z),  0.95, 0.0, true,  4.2,  4.8, 3.2),
        (-1, SCNVector3(-3.1,  5.3, z),  0.95, 0.5, true,  4.2,  4.8, 3.2),
        ( 1, SCNVector3( 3.7,  2.0, z), -0.10, 0.5, false, 4.8,  5.6, 3.8),
        (-1, SCNVector3(-3.7,  2.0, z), -0.10, 0.0, false, 4.8,  5.6, 3.8),
        ( 1, SCNVector3( 3.3, -1.2, z), -0.95, 0.0, false, 5.8,  7.0, 4.6),
        (-1, SCNVector3(-3.3, -1.2, z), -0.95, 0.5, false, 5.8,  7.0, 4.6),
    ]
    for (side, attach, yawOff, phase, isFront, f, t, ta) in specs {
        let baseYaw: CGFloat = side > 0 ? yawOff : (.pi - yawOff)
        let leg = buildLeg(attach: attach, baseYaw: baseYaw, swingSign: side, phase: phase,
                           isFront: isFront, femur: f, tibia: t, tarsus: ta)
        root.addChildNode(leg.root)
        legs.append(leg)
    }

    let foldedWings = SCNNode()
    for side in [CGFloat(-1), 1] {
        let wing = SCNNode(geometry: wingShape())
        // The folded membranes sit above the thorax and breathing abdomen.
        wing.position = SCNVector3(side * 1.6, 0.5, side > 0 ? 10.4 : 10.25)
        wing.eulerAngles = SCNVector3(0, 0, side * 0.13)
        foldedWings.addChildNode(wing)
    }
    root.addChildNode(foldedWings)

    func blurWing(_ side: CGFloat) -> SCNNode {
        let g = SCNSphere(radius: 1.0)
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = NSColor(calibratedWhite: 0.85, alpha: 0.30)
        m.isDoubleSided = true
        g.materials = [m]
        let n = SCNNode(geometry: g)
        n.position = SCNVector3(side * 8.4, -2.8, 10.65)
        n.scale = SCNVector3(5.5, 2.4, 0.3)
        n.eulerAngles = SCNVector3(0, 0, side * -0.45)
        n.isHidden = true
        return n
    }
    let bl = blurWing(-1), br = blurWing(1)
    root.addChildNode(bl)
    root.addChildNode(br)

    return FlyModel(root: root, legs: legs, foldedWings: foldedWings,
                    blurWingL: bl, blurWingR: br, abdomen: abdomen,
                    wingFlightSpread: 1.1)
}

// MARK: - Behavior

final class Fly {
    enum State { case walking, idle, grooming, flying, sleeping }

    var model: FlyModel
    var node: SCNNode { model.root }
    private(set) var legDynamics: SixLegDynamics
    private var sensedLegFeedback: [LegFeedback] = []
    var legFeedback: [LegFeedback] {
        sensedLegFeedback.count == model.legs.count ? sensedLegFeedback : legDynamics.feedback
    }
    private var motorWalking = false
    private var renderedLegState: State?
    private var renderedMotorControl = false
    private var legBlendFrom: [LegFeedback] = []
    private var legBlendTime: CGFloat = 0
    private var turnTarget: CGFloat?
    private var turnTargetTime: CGFloat = 0
    private var turnVelocity: CGFloat = 0
    private var ledgeHeading: CGFloat?
    private var wingFlightAmount: CGFloat = 0

    var pos: CGPoint
    var heading: CGFloat = rnd(0...(2 * .pi))
    var speed: CGFloat = 30
    var state: State = .walking
    var stateTimer: CGFloat = rnd(1.5...4)
    var gaitPhase: CGFloat = rnd(0...1)
    var time: CGFloat = rnd(0...100)
    var scareCooldown: CGFloat = 0
    var dartCooldown: CGFloat = 0
    var backwardTimer: CGFloat = 0
    /// Radians of body saccade not yet spent, and the rate it is spent at.
    private var saccade: CGFloat = 0
    private var saccadeRate: CGFloat = 0
    var dartTimer: CGFloat = 0
    var stateAge: CGFloat = 0
    var terrain: [Ledge] = []      // walkable window edges, set by the coordinator
    var ledge: Ledge?              // currently attached window edge

    var gaitPhasePublic: CGFloat { gaitPhase }
    var walkingIntensity: CGFloat {
        state == .walking ? clampf(abs(backwardTimer > 0 ? 22 : speed) / 60, 0, 1) : 0
    }

    var flightFrom = CGPoint.zero
    var flightTo = CGPoint.zero
    var flightT: CGFloat = 0
    var flightDur: CGFloat = 1
    var flightEffort: CGFloat = 0.6   // set at takeoff: escape=1, casual from arousal
    var effortCurrent: CGFloat = 0.6  // live effort: base + ongoing DNp02/04/11 + arousal
    var alt: CGFloat = 0              // 0 ground .. 1 max altitude
    var pitch: CGFloat = 0            // body pitch while climbing/descending
    var flapPhase: CGFloat = 0
    var wingRaise: CGFloat = 0        // grounded threat posture (escape-DN driven)
    var elytraOpen: CGFloat = 0       // display only: 0 closed .. 1 fully spread
    private var brainLive = false
    private var liveArousal: CGFloat = 0
    private var liveWing: CGFloat = 0

    init(at p: CGPoint) {
        model = buildBody()
        legDynamics = SixLegDynamics(geometries: model.legs.map(\.geometry))
        for (leg, pose) in zip(model.legs, legDynamics.feedback) { leg.apply(pose) }
        sensedLegFeedback = []
        pos = p
        syncNode()
    }

    /// Rebuild the body in the current `BODY_FORM`, in place. Behavior state
    /// (position, gait phase, flight, ledge) is untouched — only geometry swaps.
    func swapBody() {
        let old = model.root
        let parent = old.parent
        old.removeFromParentNode()
        model = buildBody()
        legDynamics = SixLegDynamics(geometries: model.legs.map(\.geometry))
        for (leg, pose) in zip(model.legs, legDynamics.feedback) { leg.apply(pose) }
        motorWalking = false; renderedLegState = nil; renderedMotorControl = false
        sensedLegFeedback = []
        model.root.position = old.position
        model.root.scale = old.scale
        model.root.eulerAngles = old.eulerAngles
        model.blurWingL.isHidden = state != .flying
        model.blurWingR.isHidden = state != .flying
        parent?.addChildNode(model.root)
        syncNode()
    }

    func syncNode() {
        node.position = SCNVector3(pos.x, pos.y, node.position.z)
        node.eulerAngles = SCNVector3(pitch, 0, heading - .pi / 2)
    }

    func startFlight(bounds: CGSize, awayFrom: CGPoint? = nil, escape: Bool = false,
                     effort: CGFloat? = nil) {
        setState(.flying)
        ledge = nil
        ledgeHeading = nil
        turnTarget = nil
        flightEffort = clampf(effort ?? (escape ? 1.0 : rnd(0.4...0.75)), 0.25, 1)
        effortCurrent = flightEffort
        flightFrom = pos
        let hw = bounds.width / 2 - EDGE_MARGIN, hh = bounds.height / 2 - EDGE_MARGIN
        var target = CGPoint.zero
        var chosen = false
        // casual flights often land on a window edge
        if !escape, awayFrom == nil, !terrain.isEmpty, rnd(0...1) < 0.45 {
            let L = terrain[TestRandom.integer(in: 0..<terrain.count)]
            if L.x1 - L.x0 > 90 {
                target = CGPoint(x: rnd((L.x0 + 25)...(L.x1 - 25)), y: L.y)
                chosen = hypot(target.x - pos.x, target.y - pos.y) > 180
            }
        }
        if !chosen {
            for _ in 0..<16 {
                target = CGPoint(x: rnd(-hw...hw), y: rnd(-hh...hh))
                let far = hypot(target.x - pos.x, target.y - pos.y) > (escape ? 350 : 260)
                if !far { continue }
                if let a = awayFrom {
                    // escape away from the threat: target must be on the far side
                    let toT = CGPoint(x: target.x - pos.x, y: target.y - pos.y)
                    let toA = CGPoint(x: a.x - pos.x, y: a.y - pos.y)
                    if toT.x * toA.x + toT.y * toA.y > 0 { continue }
                }
                break
            }
        }
        flightTo = target
        let dist = hypot(target.x - pos.x, target.y - pos.y)
        flightDur = escape ? clampf(dist / 650, 0.45, 1.2) : clampf(dist / 420, 0.7, 2.0)
        flightT = 0
        scareCooldown = escape ? 2.0 : 2.5
        // wings stay visible and beat; blur discs add the motion-smear
        model.blurWingL.isHidden = false
        model.blurWingR.isHidden = false
    }

    private func land() {
        setState(.idle)
        stateTimer = rnd(0.3...0.8)
        speed = 0
        alt = 0
        pitch = 0
        node.scale = SCNVector3(FLY_SCALE, FLY_SCALE, FLY_SCALE)
        var p = node.position; p.z = 0; node.position = p
        // Wing closure and leg settling continue from their airborne poses.
    }

    /// Queue a small spontaneous body saccade. Larger changes of direction use
    /// turnToward so fast reactions do not rotate the entire animal in one tick.
    private func startSaccade() {
        saccade = (rnd(0...1) < 0.5 ? -1 : 1) * rnd(SACCADE_MIN...SACCADE_MAX)
        saccadeRate = saccade / SACCADE_DUR
    }

    private func stepSaccade(_ dt: CGFloat) {
        guard saccade != 0 else { return }
        let step = saccadeRate * dt
        if abs(step) >= abs(saccade) {
            heading += saccade
            saccade = 0
        } else {
            heading += step
            saccade -= step
        }
    }

    private func turnToward(_ target: CGFloat, dt: CGFloat) {
        let error = angleDiff(heading, target)
        let desired = clampf(error * 16, -8, 8)
        turnVelocity += clampf(desired - turnVelocity, -60 * dt, 60 * dt)
        let step = turnVelocity * dt
        if step * error >= 0 && abs(step) >= abs(error) {
            heading += error; turnVelocity = 0
        } else { heading += step }
    }

    private func prepareMotorControl(tempo: CGFloat) {
        if !motorWalking {
            legDynamics.adoptPose(legFeedback, grounded: true, velocityScale: 1 / tempo)
        }
        motorWalking = true
    }

    private func pickNextState() {
        switch state {
        case .walking:
            let r = rnd(0...1)
            if r < 0.30 { state = .idle; stateTimer = rnd(0.8...3); speed = 0 }
            else if r < 0.55 {
                stateTimer = rnd(0.3...0.8); speed = rnd(95...150)
                startSaccade()
            } else { stateTimer = rnd(1.5...5); speed = rnd(18...45) }
        case .idle:
            let r = rnd(0...1)
            if r < 0.35 { state = .grooming; stateTimer = rnd(1.0...2.5) }
            else { state = .walking; stateTimer = rnd(1.5...5); speed = rnd(18...45)
                   startSaccade() }
        case .grooming:
            state = .idle; stateTimer = rnd(0.3...1.0)
        case .flying, .sleeping:
            break
        }
    }

    func update(dt: CGFloat, bounds: CGSize, mouse: CGPoint?, signals: BrainSignals?) {
        time += dt
        scareCooldown = max(0, scareCooldown - dt)
        dartCooldown = max(0, dartCooldown - dt)
        backwardTimer = max(0, backwardTimer - dt)

        stateAge += dt
        dartTimer = max(0, dartTimer - dt)
        turnTargetTime = max(0, turnTargetTime - dt)
        if turnTargetTime == 0 { turnTarget = nil }

        // live brain drives reach the wings even mid-flight
        brainLive = signals != nil
        liveArousal = signals?.arousal ?? 0
        liveWing = signals?.wingDrive ?? 0
        let tempo = signals?.tempo ?? 1
        // Temperature changes elapsed mechanical time, so force integration,
        // foot contact and the resulting sensory feedback all change together.
        let motorTempo = tempo.isFinite ? clampf(tempo, 0.5, 2) : 1
        let motorDT = dt * motorTempo

        if state == .flying {
            saccade = 0            // airborne heading is geometric, not a walk saccade
            updateFlight(dt: dt)
        } else if let s = signals {
            if s.legCommands == nil { stepSaccade(dt) }
            brainBehavior(s, dt: dt, bounds: bounds, mouse: mouse)
            if state == .walking {
                if let commands = s.legCommands, commands.count == model.legs.count {
                    prepareMotorControl(tempo: motorTempo)
                    saccade = 0
                    let motion = legDynamics.advance(commands: commands, dt: motorDT)
                    speed = abs(motion.forward) / max(0.001, dt)
                    updateWalk(dt: dt, bounds: bounds, motorMotion: motion)
                } else {
                    motorWalking = false
                    updateWalk(dt: dt, bounds: bounds)
                }
            }
        } else {
            if scareCooldown == 0, let m = mouse {
                // legacy distance-based fear (extra, brainless flies)
                let mouseDist = hypot(m.x - pos.x, m.y - pos.y)
                if mouseDist < SCARE_RADIUS {
                    startFlight(bounds: bounds, awayFrom: m)
                } else if mouseDist < NERVOUS_RADIUS && state != .walking {
                    setState(.walking)
                    saccade = 0
                    turnTarget = atan2(pos.y - m.y, pos.x - m.x) + rnd(-0.4...0.4)
                    speed = rnd(110...150)
                    stateTimer = rnd(0.4...0.9)
                    turnTargetTime = stateTimer
                    scareCooldown = 1.0
                }
            }
            if state != .flying {
                stepSaccade(dt)
                stateTimer -= dt
                if stateTimer <= 0 {
                    if state == .walking && rnd(0...1) < 0.10 { startFlight(bounds: bounds) }
                    else { pickNextState() }
                }
                if state == .walking { updateWalk(dt: dt, bounds: bounds) }
            }
        }

        if signals?.legCommands?.count != model.legs.count
            || (state != .walking && state != .idle && state != .sleeping) { motorWalking = false }
        if signals?.legCommands?.count == model.legs.count && (state == .idle || state == .sleeping) {
            prepareMotorControl(tempo: motorTempo)
            _ = legDynamics.advance(commands: Array(repeating: LegMotorCommand(), count: model.legs.count), dt: motorDT)
            motorWalking = true  // retain the articulated standing pose
        }
        if !motorWalking { legDynamics.resetContact(grounded: state != .flying) }
        updateLegs(dt: dt)
        sampleLegFeedback(dt: dt)
        updateWings(dt: dt)
        // slower, deeper breathing while asleep
        let breathe = state == .sleeping ? (1 + 0.05 * sin(time * 1.1))
                                         : (1 + 0.03 * sin(time * 3.0))
        model.abdomen.scale = SCNVector3(0.9, 1.5, 0.75 * breathe)
        syncNode()
    }

    private func setState(_ s: State) {
        guard s != state else { return }
        state = s
        stateAge = 0
        if s != .walking { turnTarget = nil }
    }

    // Every behavioral decision here reads a real neuron population's rate.
    private func brainBehavior(_ s: BrainSignals, dt: CGFloat, bounds: CGSize, mouse: CGPoint?) {
        // Giant fiber spike -> escape takeoff (even startles it out of sleep)
        if s.escape && scareCooldown == 0 {
            startFlight(bounds: bounds, awayFrom: mouse, escape: true)
            return
        }
        // circadian sleep: enter, hold (no walk/groom/dart while asleep), wake to grooming
        if s.sleep {
            if state != .sleeping { setState(.sleeping); speed = 0; dartTimer = 0; backwardTimer = 0 }
            return
        } else if state == .sleeping {
            setState(.grooming)   // flies groom after waking
            return
        }
        // Looming detectors hot but GF quiet -> nervous dart away
        if s.nervous > 0.40 && dartCooldown == 0 {
            ledge = nil
            setState(.walking)
            if let m = mouse {
                saccade = 0
                turnTarget = atan2(pos.y - m.y, pos.x - m.x) + rnd(-0.4...0.4)
            } else { startSaccade() }
            speed = rnd(110...155)
            dartTimer = rnd(0.4...0.9)
            turnTargetTime = dartTimer
            dartCooldown = 1.2
        }
        // DNg11 (grooming command) hysteresis
        if state != .walking || dartTimer == 0 {
            if state != .grooming, s.groomDrive > 0.5, s.nervous < 0.3, stateAge > 0.4 {
                setState(.grooming)
            } else if state == .grooming, s.groomDrive < 0.3, stateAge > 0.6 {
                setState(.idle)
            }
        }
        // DNp09 (forward-walking command) hysteresis
        if state == .idle, s.walkDrive > 0.22, stateAge > 0.4 {
            setState(.walking)
            startSaccade()
        } else if state == .walking, dartTimer == 0, s.walkDrive < 0.08, stateAge > 0.5 {
            setState(.idle)
            speed = 0
        }
        // MDN burst -> backward walk, from any grounded state
        if s.backward && backwardTimer == 0 && dartTimer == 0 {
            if state != .walking { setState(.walking); speed = 0 }
            backwardTimer = 0.5
        }
        // walking speed follows the forward command rate; tempo = temperature
        if state == .walking {
            if s.legCommands == nil && dartTimer == 0 && backwardTimer == 0 {
                let target = (14 + s.walkDrive * 55) * s.tempo
                speed += (target - speed) * lag(3, dt)
            }
            if s.legCommands == nil && ledge == nil { heading += s.turnBias * dt }
        }
        // spontaneous takeoff, gated on whole-population arousal; flight
        // altitude/effort scales with how aroused the network is
        let flightChance: CGFloat = s.arousal > 0.5 ? 0.6 : 0.005
        if state == .walking && rnd(0...1) < lag(flightChance, dt) {
            startFlight(bounds: bounds, effort: 0.35 + s.arousal * 0.6)
        }
    }

    private var effectiveSpeed: CGFloat { backwardTimer > 0 ? -22 : speed }

    private func updateWalk(dt: CGFloat, bounds: CGSize, motorMotion: LegBodyMotion? = nil) {
        // refresh the attached ledge from current terrain (windows move/close)
        if let L = ledge {
            if let cur = terrain.first(where: { $0.id == L.id }), abs(cur.y - L.y) < 40,
               pos.x >= cur.x0 - 6, pos.x <= cur.x1 + 6 {
                ledge = cur
            } else {
                ledge = nil
                startFlight(bounds: bounds)   // the ground vanished from under it
                return
            }
        }
        if let L = ledge {
            // walk along the window edge
            if motorMotion == nil { heading += rnd(-1...1) * LEDGE_JITTER * sqrt(dt) }
            if ledgeHeading == nil { ledgeHeading = cos(heading) >= 0 ? 0 : .pi }
            if pos.x <= L.x0 + 6 { ledgeHeading = 0 }
            if pos.x >= L.x1 - 6 { ledgeHeading = .pi }
            turnToward(ledgeHeading!, dt: dt)
            pos.x += cos(heading) * (motorMotion?.forward ?? (effectiveSpeed * dt))
            pos.y += (L.y - pos.y) * lag(10, dt)
            pos.x = clampf(pos.x, L.x0, L.x1)
            if rnd(0...1) < lag(0.05, dt) { ledge = nil }   // wander off the edge
        } else {
            ledgeHeading = nil
            if let target = turnTarget {
                turnToward(target, dt: dt)
                if abs(angleDiff(heading, target)) < 0.001 { turnTarget = nil }
            }
            let startHeading = heading
            if let motion = motorMotion { heading += motion.yaw }
            else { heading += rnd(-1...1) * WANDER_JITTER * sqrt(dt) }
            let hw = bounds.width / 2 - EDGE_MARGIN, hh = bounds.height / 2 - EDGE_MARGIN
            if abs(pos.x) > hw || abs(pos.y) > hh {
                let toCenter = atan2(-pos.y, -pos.x)
                heading += angleDiff(heading, toCenter) * lag(4, dt)
            }
            let forward = motorMotion?.forward ?? (effectiveSpeed * dt)
            let lateral = motorMotion?.lateral ?? 0
            // The mechanics integrates displacement in the frame at the start
            // of the tick; rotating it by the final yaw applies the turn twice.
            let translationHeading = motorMotion == nil ? heading : startHeading
            pos.x += cos(translationHeading) * forward + sin(translationHeading) * lateral
            pos.y += sin(translationHeading) * forward - cos(translationHeading) * lateral
            pos.x = clampf(pos.x, -bounds.width / 2 + 20, bounds.width / 2 - 20)
            pos.y = clampf(pos.y, -bounds.height / 2 + 20, bounds.height / 2 - 20)
            // walked onto a window edge? latch on
            for L in terrain where pos.x > L.x0 - 8 && pos.x < L.x1 + 8 && abs(pos.y - L.y) < 20 {
                if rnd(0...1) < lag(0.9, dt) {
                    ledge = L
                    ledgeHeading = cos(heading) >= 0 ? 0 : .pi
                    break
                }
            }
        }
        var p = node.position
        p.z = motorMotion == nil ? 0.35 * abs(sin(gaitPhase * .pi * 2)) : 0
        node.position = p
    }

    private func applyAltitude() {
        let s = FLY_SCALE * (1 + 0.8 * alt)
        node.scale = SCNVector3(s, s, s)
        var p = node.position
        p.z = 90 * alt
        node.position = p
    }

    private func updateFlight(dt: CGFloat) {
        flightT = min(1, flightT + dt / flightDur)
        if flightT >= 1 {
            // touchdown flare: the timer ended, but the fly lands only when it
            // has actually descended — hover over the target and settle down.
            let settle = min(1, alt / 0.2)
            pos.x = flightTo.x + sin(time * 26) * 1.2 * settle
            pos.y = flightTo.y + cos(time * 22) * settle
            pitch += (clampf(alt * 0.4, 0, 0.35) - pitch) * lag(12, dt)
            alt += (0 - alt) * lag(9, dt)
            applyAltitude()
            if alt < 0.003 { pos = flightTo; land() }
            return
        }
        let e = smoothstep(flightT)
        let dx = flightTo.x - flightFrom.x, dy = flightTo.y - flightFrom.y
        let len = max(1, hypot(dx, dy))
        let px = -dy / len, py = dx / len
        let wob = sin(time * 32) * 4 * sin(flightT * .pi)
        pos.x = flightFrom.x + dx * e + px * wob
        pos.y = flightFrom.y + dy * e + py * wob
        turnToward(atan2(dy, dx) + sin(time * 18) * 0.12, dt: dt)
        // altitude: climb, effort-scaled cruise with buzz-wobble, descend to land.
        // Effort stays live: ongoing escape-DN (DNp02/04/11) and arousal activity
        // pushes the fly to beat harder and fly higher mid-flight.
        effortCurrent = brainLive
            ? clampf(max(flightEffort,
                         flightEffort * 0.55 + liveArousal * 0.25 + liveWing * 0.6), 0.25, 1.3)
            : flightEffort
        let riseEnv = min(flightT / 0.25, 1)
        let fallEnv = min((1 - flightT) / 0.3, 1)
        let target = effortCurrent * min(riseEnv, fallEnv) * (0.85 + 0.15 * sin(time * 7))
        pitch += (clampf((target - alt) * 2.5, -0.45, 0.45) - pitch) * lag(12, dt)
        alt += (target - alt) * lag(6, dt)
        // higher = closer to the viewer = bigger, and the shadow slides away
        applyAltitude()
    }

    private func updateLegs(dt: CGFloat) {
        if motorWalking {
            for (leg, feedback) in zip(model.legs, legDynamics.feedback) { leg.apply(feedback) }
            renderedLegState = state; renderedMotorControl = true
            return
        }
        // Retarget from the displayed pose, including when another transition
        // interrupts this one. Motor control instead adopts that pose in physics.
        if renderedLegState != state || renderedMotorControl {
            legBlendFrom = model.legs.map {
                var pose = LegFeedback()
                pose.hipAngle = $0.angle; pose.elevationAngle = $0.lift; pose.kneeAngle = $0.kneeAngle
                return pose
            }
            legBlendTime = 0
        }
        renderedLegState = state; renderedMotorControl = false
        legBlendTime = min(0.18, legBlendTime + dt)
        let blend = smoothstep(legBlendTime / 0.18)
        let v = abs(effectiveSpeed)
        let walking = state == .walking && v > 1
        let amp = clampf(0.20 + v * 0.0022, 0.20, 0.50)
        let freq = clampf(v / max(5, 2 * amp * 13), 3, 11)
        if walking { gaitPhase = (gaitPhase + freq * dt).truncatingRemainder(dividingBy: 1) }
        let stanceFrac = clampf(1 - SWING_DUR * freq, 0.35, 0.9)
        for (i, leg) in model.legs.enumerated() {
            var angle: CGFloat = 0, lift: CGFloat = 0, knee: CGFloat = 0.95
            if walking {
                knee = 0.75
                let p = (gaitPhase + leg.phase).truncatingRemainder(dividingBy: 1)
                if p < stanceFrac { angle = amp * (1 - 2 * p / stanceFrac) }
                else {
                    let phase = (p - stanceFrac) / (1 - stanceFrac)
                    angle = -amp + 2 * amp * smoothstep(phase)
                    lift = sin(phase * .pi) * 0.55
                }
                if backwardTimer > 0 { angle = -angle }
            } else if state == .grooming {
                knee = 0.75
                if leg.isFront {
                    angle = 0.45 + 0.25 * sin(time * 20 + leg.swingSign * 1.3)
                    lift = 0.55 + 0.15 * sin(time * 22)
                }
            } else if state == .flying {
                angle = -0.35; lift = 0.5; knee = 0.75
            }
            angle = clampf(angle, -LegDynamics.hipLimit, LegDynamics.hipLimit)
            lift = clampf(lift, LegDynamics.elevationRange.lowerBound, LegDynamics.elevationRange.upperBound)
            if state != .flying { lift = max(lift, LegDynamics.groundElevation(leg.geometry, knee: knee)) }
            let from = legBlendFrom[i]
            leg.angle = from.hipAngle + (angle - from.hipAngle) * blend
            leg.kneeAngle = from.kneeAngle + (knee - from.kneeAngle) * blend
            leg.lift = from.elevationAngle + (lift - from.elevationAngle) * blend
            // Keep the current (possibly blended) knee above the same ground
            // used by mechanics, so a later handoff needs no position projection.
            if state != .flying {
                leg.lift = max(leg.lift, LegDynamics.groundElevation(leg.geometry, knee: leg.kneeAngle))
            }
            leg.apply()
        }
    }

    private func sampleLegFeedback(dt: CGFloat) {
        let previous = legFeedback
        let physical = legDynamics.feedback
        sensedLegFeedback = model.legs.enumerated().map { i, leg in
            let toe = leg.ankle.convertPosition(SCNVector3(leg.geometry.tarsus, 0, 0), to: node)
            var value = LegFeedback()
            value.hipAngle = leg.angle
            value.kneeAngle = CGFloat(leg.knee.eulerAngles.y)
            value.elevationAngle = leg.lift
            value.hipVelocity = (value.hipAngle - previous[i].hipAngle) / max(0.001, dt)
            value.kneeVelocity = (value.kneeAngle - previous[i].kneeAngle) / max(0.001, dt)
            value.elevationVelocity = (value.elevationAngle - previous[i].elevationAngle) / max(0.001, dt)
            value.footX = CGFloat(toe.x); value.footY = CGFloat(toe.y)
            value.footHeight = CGFloat(toe.z + node.position.z)
            value.contact = state != .flying && value.footHeight <= 0.015
            return value
        }
        let supports = max(1, sensedLegFeedback.filter(\.contact).count)
        for i in sensedLegFeedback.indices {
            sensedLegFeedback[i].load = sensedLegFeedback[i].contact
                ? (motorWalking ? physical[i].load : 1 / CGFloat(supports)) : 0
        }
    }

    private func updateWings(dt: CGFloat) {
        let flying = state == .flying
        wingFlightAmount += ((flying ? 1 : 0) - wingFlightAmount) * lag(18, dt)
        if !flying && wingFlightAmount < 0.0001 { wingFlightAmount = 0 }
        let raiseTarget: CGFloat = !flying && state != .sleeping
            && (liveWing > 0.7 || (brainLive && dartTimer > 0)) ? 1 : 0
        wingRaise += (raiseTarget - wingRaise) * lag(8, dt)
        if flying || wingFlightAmount > 0 {
            flapPhase += dt * (22 + 10 * effortCurrent)
        }
        let stroke = sin(flapPhase * 2 * .pi)
        // Spread before permitting a downstroke, and flatten before folding.
        // This also preserves the raised-hinge body clearance during transitions.
        let beat = smoothstep((wingFlightAmount - 0.8) / 0.2)
        for (i, wing) in model.foldedWings.childNodes.enumerated() {
            let side: CGFloat = i == 0 ? -1 : 1
            let groundedSpread = 0.13 + 0.3 * wingRaise
            let spread = groundedSpread + (model.wingFlightSpread - groundedSpread) * wingFlightAmount
            wing.eulerAngles = SCNVector3(-0.5 * wingRaise * (1 - wingFlightAmount) + stroke * 0.35 * beat,
                0, side * (spread + 0.175 * stroke * beat))
        }
        let flick = (0.10 + 0.14 * abs(stroke)) * wingFlightAmount
        model.blurWingL.opacity = flick; model.blurWingR.opacity = flick
        model.blurWingL.isHidden = wingFlightAmount == 0
        model.blurWingR.isHidden = wingFlightAmount == 0
        model.blurWingL.eulerAngles = SCNVector3(0, 0, 0.45 + stroke * 0.2)
        model.blurWingR.eulerAngles = SCNVector3(0, 0, -0.45 - stroke * 0.2)
        updateElytra(target: flying ? 1 : wingRaise, dt: dt)
    }

    /// Display only. The wing cases swing outward and tip up when airborne or
    /// when the grounded threat posture is on; they hold that angle rather than
    /// buzzing along with the hindwings, the way a real beetle flies.
    private func updateElytra(target: CGFloat, dt: CGFloat) {
        guard let l = model.elytraL, let r = model.elytraR else { return }
        elytraOpen += (target - elytraOpen) * lag(10, dt)
        if elytraOpen < 0.001 { elytraOpen = 0 }
        let yaw = 0.62 * elytraOpen
        let lift = 0.85 * elytraOpen
        l.eulerAngles = SCNVector3(0,  lift, -yaw)
        r.eulerAngles = SCNVector3(0, -lift,  yaw)
    }
}
