// FlyModel.swift — procedural 3D fruit-fly body (FlyWire has no body data;
// the connectome drives behavior, the body is modeled) + per-fly behavior.
// Local frame: +Y forward, +Z up, ground at z=0.

import Cocoa
import SceneKit

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

func rnd(_ range: ClosedRange<CGFloat>) -> CGFloat { CGFloat.random(in: range) }
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
    let baseYaw: CGFloat
    let swingSign: CGFloat
    let phase: CGFloat
    let isFront: Bool
    var angle: CGFloat = 0
    var lift: CGFloat = 0

    init(root: SCNNode, baseYaw: CGFloat, swingSign: CGFloat, phase: CGFloat, isFront: Bool) {
        self.root = root; self.baseYaw = baseYaw; self.swingSign = swingSign
        self.phase = phase; self.isFront = isFront
    }

    func apply() {
        root.eulerAngles = SCNVector3(0, -lift, baseYaw + swingSign * angle)
    }
}

struct FlyModel {
    let root: SCNNode
    let legs: [Leg]
    let foldedWings: SCNNode
    let blurWingL: SCNNode
    let blurWingR: SCNNode
    let abdomen: SCNNode
}

func buildLeg(attach: SCNVector3, baseYaw: CGFloat, swingSign: CGFloat, phase: CGFloat,
              isFront: Bool, femur: CGFloat, tibia: CGFloat, tarsus: CGFloat) -> Leg {
    let legColor = NSColor(calibratedRed: 0.33, green: 0.24, blue: 0.14, alpha: 1)
    let root = SCNNode()
    root.position = attach

    let femurGeo = SCNCapsule(capRadius: 0.48, height: femur)
    femurGeo.materials = [mat(legColor)]
    let femurNode = SCNNode(geometry: femurGeo)
    femurNode.eulerAngles = SCNVector3(0, 0, -CGFloat.pi / 2)
    femurNode.position = SCNVector3(femur / 2, 0, 0)
    root.addChildNode(femurNode)

    let knee = SCNNode()
    knee.position = SCNVector3(femur, 0, 0)
    knee.eulerAngles = SCNVector3(0, 0.75, -0.30 * swingSign)
    root.addChildNode(knee)

    let tibiaGeo = SCNCapsule(capRadius: 0.38, height: tibia)
    tibiaGeo.materials = [mat(legColor)]
    let tibiaNode = SCNNode(geometry: tibiaGeo)
    tibiaNode.eulerAngles = SCNVector3(0, 0, -CGFloat.pi / 2)
    tibiaNode.position = SCNVector3(tibia / 2, 0, 0)
    knee.addChildNode(tibiaNode)

    let ankle = SCNNode()
    ankle.position = SCNVector3(tibia, 0, 0)
    ankle.eulerAngles = SCNVector3(0, 0.35, -0.15 * swingSign)
    knee.addChildNode(ankle)

    let tarsusGeo = SCNCapsule(capRadius: 0.24, height: tarsus)
    tarsusGeo.materials = [mat(legColor.blended(withFraction: 0.25, of: .black) ?? legColor)]
    let tarsusNode = SCNNode(geometry: tarsusGeo)
    tarsusNode.eulerAngles = SCNVector3(0, 0, -CGFloat.pi / 2)
    tarsusNode.position = SCNVector3(tarsus / 2, 0, 0)
    ankle.addChildNode(tarsusNode)

    let leg = Leg(root: root, baseYaw: baseYaw, swingSign: swingSign, phase: phase, isFront: isFront)
    leg.apply()
    return leg
}

func wingShape() -> SCNGeometry {
    let path = NSBezierPath(ovalIn: NSRect(x: -2.6, y: -15.5, width: 5.2, height: 16.5))
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
        wing.position = SCNVector3(side * 1.6, 0.5, side > 0 ? 7.7 : 7.55)
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
        n.position = SCNVector3(side * 6.0, 1.5, 8.2)
        n.scale = SCNVector3(5.5, 2.4, 0.3)
        n.eulerAngles = SCNVector3(0, 0, side * -0.45)
        n.isHidden = true
        return n
    }
    let bl = blurWing(-1), br = blurWing(1)
    root.addChildNode(bl)
    root.addChildNode(br)

    return FlyModel(root: root, legs: legs, foldedWings: foldedWings,
                    blurWingL: bl, blurWingR: br, abdomen: abdomen)
}

// MARK: - Behavior

final class Fly {
    enum State { case walking, idle, grooming, flying, sleeping }

    let model: FlyModel
    var node: SCNNode { model.root }

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
    private var brainLive = false
    private var liveArousal: CGFloat = 0
    private var liveWing: CGFloat = 0

    init(at p: CGPoint) {
        model = buildFlyModel()
        pos = p
        syncNode()
    }

    func syncNode() {
        node.position = SCNVector3(pos.x, pos.y, node.position.z)
        node.eulerAngles = SCNVector3(pitch, 0, heading - .pi / 2)
    }

    func startFlight(bounds: CGSize, awayFrom: CGPoint? = nil, escape: Bool = false,
                     effort: CGFloat? = nil) {
        state = .flying
        ledge = nil
        flightEffort = clampf(effort ?? (escape ? 1.0 : rnd(0.4...0.75)), 0.25, 1)
        effortCurrent = flightEffort
        flapPhase = 0
        wingRaise = 0
        flightFrom = pos
        let hw = bounds.width / 2 - EDGE_MARGIN, hh = bounds.height / 2 - EDGE_MARGIN
        var target = CGPoint.zero
        var chosen = false
        // casual flights often land on a window edge
        if !escape, awayFrom == nil, !terrain.isEmpty, rnd(0...1) < 0.45 {
            let L = terrain[Int.random(in: 0..<terrain.count)]
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
        state = .idle
        stateTimer = rnd(0.3...0.8)
        speed = 0
        alt = 0
        pitch = 0
        node.scale = SCNVector3(FLY_SCALE, FLY_SCALE, FLY_SCALE)
        var p = node.position; p.z = 0; node.position = p
        // refold the wings flat over the abdomen
        for (i, wing) in model.foldedWings.childNodes.enumerated() {
            let side: CGFloat = i == 0 ? -1 : 1
            wing.eulerAngles = SCNVector3(0, 0, side * 0.13)
        }
        model.blurWingL.isHidden = true
        model.blurWingR.isHidden = true
    }

    /// Queue a body saccade instead of snapping the heading. Escape turns do NOT
    /// go through this: a fleeing fly extends its legs in 3.33 ms (Card & Dickinson
    /// 2008, J Exp Biol 211:341, 10.1242/jeb.012682) and must stay instant.
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

        // live brain drives reach the wings even mid-flight
        brainLive = signals != nil
        liveArousal = signals?.arousal ?? 0
        liveWing = signals?.wingDrive ?? 0

        if state == .flying {
            saccade = 0            // airborne heading is geometric, not a walk saccade
            updateFlight(dt: dt)
        } else if let s = signals {
            stepSaccade(dt)
            brainBehavior(s, dt: dt, bounds: bounds, mouse: mouse)
            if state == .walking { updateWalk(dt: dt, bounds: bounds) }
        } else {
            if scareCooldown == 0, let m = mouse {
                // legacy distance-based fear (extra, brainless flies)
                let mouseDist = hypot(m.x - pos.x, m.y - pos.y)
                if mouseDist < SCARE_RADIUS {
                    startFlight(bounds: bounds, awayFrom: m)
                } else if mouseDist < NERVOUS_RADIUS && state != .walking {
                    setState(.walking)
                    saccade = 0        // fleeing turns are instant, not saccadic
                    heading = atan2(pos.y - m.y, pos.x - m.x) + rnd(-0.4...0.4)
                    speed = rnd(110...150)
                    stateTimer = rnd(0.4...0.9)
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

        updateLegs(dt: dt)
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
                saccade = 0        // fleeing turns are instant, not saccadic
                heading = atan2(pos.y - m.y, pos.x - m.x) + rnd(-0.4...0.4)
            } else { startSaccade() }
            speed = rnd(110...155)
            dartTimer = rnd(0.4...0.9)
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
            if dartTimer == 0 && backwardTimer == 0 {
                let target = (14 + s.walkDrive * 55) * s.tempo
                speed += (target - speed) * lag(3, dt)
            }
            if ledge == nil { heading += s.turnBias * dt }   // DNa01/DNa02 steering
        }
        // spontaneous takeoff, gated on whole-population arousal; flight
        // altitude/effort scales with how aroused the network is
        let flightChance: CGFloat = s.arousal > 0.5 ? 0.6 : 0.005
        if state == .walking && rnd(0...1) < lag(flightChance, dt) {
            startFlight(bounds: bounds, effort: 0.35 + s.arousal * 0.6)
        }
    }

    private var effectiveSpeed: CGFloat { backwardTimer > 0 ? -22 : speed }

    private func updateWalk(dt: CGFloat, bounds: CGSize) {
        // refresh the attached ledge from current terrain (windows move/close)
        if let L = ledge {
            if let cur = terrain.first(where: { $0.id == L.id }), abs(cur.y - L.y) < 40 {
                ledge = cur
            } else {
                ledge = nil
                startFlight(bounds: bounds)   // the ground vanished from under it
                return
            }
        }
        if let L = ledge {
            // walk along the window edge
            heading += rnd(-1...1) * LEDGE_JITTER * sqrt(dt)
            let along: CGFloat = cos(heading) >= 0 ? 0 : .pi
            heading += angleDiff(heading, along) * lag(6, dt)
            pos.x += cos(heading) * effectiveSpeed * dt
            pos.y += (L.y - pos.y) * lag(10, dt)
            if pos.x <= L.x0 + 6 && cos(heading) < 0 { heading = 0 }
            if pos.x >= L.x1 - 6 && cos(heading) > 0 { heading = .pi }
            pos.x = clampf(pos.x, L.x0, L.x1)
            if rnd(0...1) < lag(0.05, dt) { ledge = nil }   // wander off the edge
        } else {
            heading += rnd(-1...1) * WANDER_JITTER * sqrt(dt)
            let hw = bounds.width / 2 - EDGE_MARGIN, hh = bounds.height / 2 - EDGE_MARGIN
            if abs(pos.x) > hw || abs(pos.y) > hh {
                let toCenter = atan2(-pos.y, -pos.x)
                heading += angleDiff(heading, toCenter) * lag(4, dt)
            }
            let v = effectiveSpeed
            pos.x += cos(heading) * v * dt
            pos.y += sin(heading) * v * dt
            pos.x = clampf(pos.x, -bounds.width / 2 + 20, bounds.width / 2 - 20)
            pos.y = clampf(pos.y, -bounds.height / 2 + 20, bounds.height / 2 - 20)
            // walked onto a window edge? latch on
            for L in terrain where pos.x > L.x0 - 8 && pos.x < L.x1 + 8 && abs(pos.y - L.y) < 20 {
                if rnd(0...1) < lag(0.9, dt) {
                    ledge = L
                    heading = cos(heading) >= 0 ? 0 : .pi
                    break
                }
            }
        }
        var p = node.position
        p.z = 0.35 * abs(sin(gaitPhase * .pi * 2))
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
            pos.x = flightTo.x + sin(time * 26) * 1.2
            pos.y = flightTo.y + cos(time * 22) * 1.0
            pitch = clampf(alt * 0.4, 0, 0.35)   // gentle nose-up flare
            alt += (0 - alt) * lag(9, dt)
            applyAltitude()
            if alt < 0.035 { pos = flightTo; land() }
            return
        }
        let e = smoothstep(flightT)
        let dx = flightTo.x - flightFrom.x, dy = flightTo.y - flightFrom.y
        let len = max(1, hypot(dx, dy))
        let px = -dy / len, py = dx / len
        let wob = sin(time * 32) * 4 * sin(flightT * .pi)
        pos.x = flightFrom.x + dx * e + px * wob
        pos.y = flightFrom.y + dy * e + py * wob
        heading = atan2(dy, dx) + sin(time * 18) * 0.12
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
        pitch = clampf((target - alt) * 2.5, -0.45, 0.45)   // nose up while climbing
        alt += (target - alt) * lag(6, dt)
        // higher = closer to the viewer = bigger, and the shadow slides away
        applyAltitude()
    }

    private func updateLegs(dt: CGFloat) {
        let v = abs(effectiveSpeed)
        let walking = (state == .walking && v > 1)
        if walking {
            let amp = clampf(0.20 + v * 0.0022, 0.20, 0.50)
            let stride = max(5, 2 * amp * 13)
            let freq = clampf(v / stride, 3, 11)
            gaitPhase = (gaitPhase + freq * dt).truncatingRemainder(dividingBy: 1)
            // Swing lasts a near-constant ~35 ms whatever the speed; it is stance
            // that shortens as the fly speeds up. A fixed fraction did the opposite.
            let stanceFrac = clampf(1 - SWING_DUR * freq, 0.35, 0.9)
            for leg in model.legs {
                let p = (gaitPhase + leg.phase).truncatingRemainder(dividingBy: 1)
                if p < stanceFrac {
                    leg.angle = amp * (1 - 2 * (p / stanceFrac))
                    leg.lift = 0
                } else {
                    let s = (p - stanceFrac) / (1 - stanceFrac)
                    leg.angle = -amp + 2 * amp * smoothstep(s)
                    leg.lift = sin(s * .pi) * 0.55
                }
                if backwardTimer > 0 { leg.angle = -leg.angle }
                leg.apply()
            }
        } else if state == .grooming {
            for leg in model.legs {
                if leg.isFront {
                    leg.angle = 0.45 + 0.25 * sin(time * 20 + leg.swingSign * 1.3)
                    leg.lift = 0.55 + 0.15 * sin(time * 22)
                } else {
                    leg.angle += (0 - leg.angle) * lag(8, dt)
                    leg.lift += (0 - leg.lift) * lag(8, dt)
                }
                leg.apply()
            }
        } else if state == .flying {
            for leg in model.legs {
                leg.angle += (-0.35 - leg.angle) * lag(6, dt)
                leg.lift += (0.5 - leg.lift) * lag(6, dt)
                leg.apply()
            }
        } else {
            for leg in model.legs {
                leg.angle += (0 - leg.angle) * lag(10, dt)
                leg.lift += (0 - leg.lift) * lag(10, dt)
                leg.apply()
            }
        }
    }

    private func updateWings(dt: CGFloat) {
        guard state == .flying else {
            // grounded threat posture: escape-DN / loom activity raises the wings
            if !model.foldedWings.isHidden {
                let raiseTarget: CGFloat = (state != .sleeping
                    && (liveWing > 0.7 || (brainLive && dartTimer > 0))) ? 1 : 0
                wingRaise += (raiseTarget - wingRaise) * lag(8, dt)
                if wingRaise > 0.01 {
                    for (i, wing) in model.foldedWings.childNodes.enumerated() {
                        let side: CGFloat = i == 0 ? -1 : 1
                        wing.eulerAngles = SCNVector3(-0.5 * wingRaise, 0,
                                                      side * (0.13 + 0.3 * wingRaise))
                    }
                }
            }
            return
        }
        // visible wing-beat: the wing shapes sweep through a stroke arc,
        // faster when the live effort is higher
        flapPhase = (flapPhase + dt * (14 + 10 * effortCurrent)).truncatingRemainder(dividingBy: 1)
        let stroke = sin(flapPhase * 2 * .pi)
        for (i, wing) in model.foldedWings.childNodes.enumerated() {
            let side: CGFloat = i == 0 ? -1 : 1
            wing.eulerAngles = SCNVector3(stroke * 0.35, 0,
                                          side * (0.45 + 0.35 * (0.5 + 0.5 * stroke)))
        }
        let flick = 0.10 + 0.14 * abs(stroke)
        model.blurWingL.opacity = flick
        model.blurWingR.opacity = flick
        model.blurWingL.eulerAngles = SCNVector3(0, 0,  0.45 + stroke * 0.2)
        model.blurWingR.eulerAngles = SCNVector3(0, 0, -0.45 - stroke * 0.2)
    }
}
