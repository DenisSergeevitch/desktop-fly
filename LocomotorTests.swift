// Causal evaluation of the actual bundled graph and articulated body.
// These are software/model checks, not a validation against recorded live flies.
import Foundation
import SceneKit
import simd

struct LocomotorTrial {
    var forward: CGFloat = 0
    var lateral: CGFloat = 0
    var yaw: CGFloat = 0
    var lateDistance: CGFloat = 0
    var lateForward: CGFloat = 0
    var lateYaw: CGFloat = 0
    var contacts = Array(repeating: 0, count: 6)
    var ranges = Array(repeating: CGFloat(0), count: 6)
    var motorRates = Array(repeating: Float(0), count: 6)
    var motorSpikes = 0
    var sensorySpikes = 0
    var finite = true
    var elapsed: Double = 0
}

func evaluateLocomotor(_ circuit: LocomotorCircuitFile, forwardHz: Float = 40,
                       leftHz: Float = 0, rightHz: Float = 0,
                       backwardHz: Float = 0, onset: CGFloat = 0,
                       duration: CGFloat = 8, hz: CGFloat = 120,
                       configure: ((LocomotorSim) -> Void)? = nil) -> LocomotorTrial {
    let cord = LocomotorSim(circuit: circuit)
    configure?(cord)
    let model = buildFlyModel()
    let body = SixLegDynamics(geometries: model.legs.map(\.geometry))
    for side in ["left", "right"] {
        cord.setDescending("DNp09", side: side, rate: forwardHz)
    }
    var result = LocomotorTrial()
    var lo = Array(repeating: CGFloat.greatestFiniteMagnitude, count: 6)
    var hi = Array(repeating: -CGFloat.greatestFiniteMagnitude, count: 6)
    let dt = SimulationClock.tick
    let clock = SimulationClock()
    var tickIndex = 0
    var milliseconds: CGFloat = 0
    let started = Date()
    for _ in 0..<Int(duration * hz) {
      clock.advance(1 / hz) { _ in
        if CGFloat(tickIndex) * dt + 1e-9 >= onset {
            for side in ["left", "right"] {
                for type in ["DNa01", "DNa02"] {
                    cord.setDescending(type, side: side, rate: side == "left" ? leftHz : rightHz)
                }
                cord.setDescending("MDN", side: side, rate: backwardHz)
            }
        }
        let before = body.feedback
        cord.feedback = before
        milliseconds += dt * 1000
        let steps = Int(milliseconds + 1e-6)
        milliseconds -= CGFloat(steps)
        cord.step(steps)
        let motion = body.advance(commands: cord.commands, dt: dt)
        result.forward += motion.forward
        result.lateral += motion.lateral
        result.yaw += motion.yaw
        let late = CGFloat(tickIndex) * dt + 1e-9 >= 3
        if late {
            result.lateDistance += hypot(motion.forward, motion.lateral)
            result.lateForward += motion.forward
            result.lateYaw += motion.yaw
        }
        for (i, f) in body.feedback.enumerated() {
            if late && f.contact && !before[i].contact { result.contacts[i] += 1 }
            if late { lo[i] = min(lo[i], f.kneeAngle); hi[i] = max(hi[i], f.kneeAngle) }
            result.finite = result.finite && f.kneeAngle.isFinite && f.hipAngle.isFinite
                && f.footHeight > -0.001 && f.footHeight.isFinite
            result.motorRates[i] = max(result.motorRates[i], cord.meanRate(role: "motor", leg: i))
        }
        tickIndex += 1
      }
    }
    result.ranges = (0..<6).map { max(0, hi[$0] - lo[$0]) }
    result.motorSpikes = cord.motorSpikes
    result.sensorySpikes = cord.sensorySpikes
    result.elapsed = Date().timeIntervalSince(started)
    return result
}

@discardableResult
func runLocomotorTests() -> Bool {
    TestRandom.reset("locomotortest")
    guard let data = loadBrainData() else { print("FAIL MaleCNS data missing or invalid"); return false }
    var failures = 0
    func check(_ name: String, _ ok: Bool, _ detail: String) {
        print("\(ok ? "PASS" : "FAIL") \(name): \(detail)")
        if !ok { failures += 1 }
    }
    let rest = evaluateLocomotor(data.locomotor, forwardHz: 0, duration: 4) { $0.feedbackEnabled = false }
    check("MaleCNS quiet without descending or sensory drive", rest.motorSpikes == 0 && rest.lateDistance < 0.001,
          "motor spikes \(rest.motorSpikes), drift \(rest.lateDistance)")
    let walking = evaluateLocomotor(data.locomotor)
    check("MaleCNS recruits motor neurons in all six legs", walking.motorRates.allSatisfy { $0 > 0.5 },
          "peak Hz \(walking.motorRates.map { String(format: "%.1f", $0) }.joined(separator: ","))")
    check("MaleCNS sustains walking after settling", walking.forward > 10 && walking.lateDistance > 10
          && walking.contacts.allSatisfy { $0 >= 2 } && walking.finite,
          String(format: "forward %.2f, late path %.2f, contacts %@, elapsed %.2fs",
                 walking.forward, walking.lateDistance, String(describing: walking.contacts), walking.elapsed))
    let disconnected = evaluateLocomotor(data.locomotor, duration: 4) { $0.synapsesEnabled = false }
    check("cutting synapses abolishes descending-to-motor response", disconnected.motorSpikes == 0
          && disconnected.lateDistance < 0.001, "motor spikes \(disconnected.motorSpikes)")
    let silenced = evaluateLocomotor(data.locomotor, duration: 4) {
        $0.silenced = Set($0.indices(role: "motor"))
    }
    check("motor lesion abolishes body propulsion", silenced.motorSpikes == 0 && silenced.lateDistance < 0.001,
          "late path \(silenced.lateDistance)")
    let straight = evaluateLocomotor(data.locomotor, forwardHz: 30, duration: 10)
    let left = evaluateLocomotor(data.locomotor, forwardHz: 30, leftHz: 70, onset: 3, duration: 10)
    let right = evaluateLocomotor(data.locomotor, forwardHz: 30, rightHz: 70, onset: 3, duration: 10)
    check("bilateral steering perturbations change motor-driven yaw", left.lateYaw - straight.lateYaw > 0.10
          && right.lateYaw - straight.lateYaw < -0.10,
          String(format: "straight %+.3f, left %+.3f, right %+.3f rad", straight.lateYaw, left.lateYaw, right.lateYaw))
    let backward = evaluateLocomotor(data.locomotor, forwardHz: 0, backwardHz: 70, duration: 10)
    check("MDN produces physical backward stepping", backward.lateForward < -5,
          String(format: "late forward %+.2f units", backward.lateForward))
    let openLoop = evaluateLocomotor(data.locomotor) { $0.feedbackEnabled = false }
    check("physical feedback changes native circuit activity", walking.sensorySpikes > 0
          && walking.motorSpikes != openLoop.motorSpikes,
          "sensory spikes \(walking.sensorySpikes), motor closed/open \(walking.motorSpikes)/\(openLoop.motorSpikes)")
    let sixtyHz = evaluateLocomotor(data.locomotor, hz: 60)
    check("coupled model is independent of 60/120 Hz display", abs(sixtyHz.forward - walking.forward) < 1e-6
          && sixtyHz.contacts == walking.contacts && sixtyHz.motorSpikes == walking.motorSpikes,
          String(format: "forward %.6f / %.6f, spikes %d / %d", sixtyHz.forward, walking.forward,
                 sixtyHz.motorSpikes, walking.motorSpikes))
    // The actual application chain, including the cross-specimen adapter and
    // rendered-body feedback. Only unrelated behavioral decisions are gated;
    // every muscle command still comes from simulated MaleCNS motor cells.
    TestRandom.reset("complete live brain-to-body chain sustains stepping")
    let sim = LIFSim(circuit: data.circuit, spikeBus: nil, locomotorCircuit: data.locomotor)
    let builder = SignalBuilder(), fly = Fly(at: .zero)
    fly.state = .walking; fly.speed = 0; fly.heading = 0
    sim.stimulate(sim.fwd, strength: 0.15, durationMs: 10_000)
    var appDistance: CGFloat = 0
    var contacts = Array(repeating: 0, count: 6)
    var previous = fly.legFeedback
    for frame in 0..<1200 {
        sim.legFeedback = fly.legFeedback
        sim.step(frame % 3 == 2 ? 9 : 8)
        var signals = builder.make(sim, dt: SimulationClock.tick)
        signals.escape = false; signals.groomDrive = 0; signals.nervous = 0; signals.arousal = 0
        let oldPosition = fly.pos
        fly.update(dt: SimulationClock.tick, bounds: CGSize(width: 1512, height: 982), mouse: nil, signals: signals)
        if frame >= 360 {
            appDistance += hypot(fly.pos.x - oldPosition.x, fly.pos.y - oldPosition.y)
            for (i, f) in fly.legFeedback.enumerated() where f.contact != previous[i].contact {
                contacts[i] += 1
            }
        }
        previous = fly.legFeedback
    }
    check("complete live brain-to-body chain sustains stepping", appDistance > 20 && contacts.allSatisfy { $0 >= 4 },
          String(format: "late path %.2f, contacts %@", appDistance, String(describing: contacts)))

    TestRandom.reset("legacy speed and turning cannot bypass motor silence")
    let unpowered = Fly(at: .zero)
    unpowered.state = .walking; unpowered.speed = 70; unpowered.heading = 0
    var zero = BrainSignals()
    zero.walkDrive = 1; zero.turnBias = 1
    zero.legCommands = Array(repeating: LegMotorCommand(), count: 6)
    unpowered.update(dt: 1 / 60, bounds: CGSize(width: 1512, height: 982), mouse: nil, signals: zero)
    check("legacy speed and turning cannot bypass motor silence", hypot(unpowered.pos.x, unpowered.pos.y) < 1e-7
          && abs(unpowered.heading) < 1e-7, "position \(unpowered.pos), heading \(unpowered.heading)")
    var toeError: CGFloat = 0
    for (i, leg) in unpowered.model.legs.enumerated() {
        let toe = leg.ankle.convertPosition(SCNVector3(leg.geometry.tarsus, 0, 0), to: unpowered.node)
        let f = unpowered.legDynamics.feedback[i]
        toeError = max(toeError, hypot(hypot(CGFloat(toe.x) - f.footX, CGFloat(toe.y) - f.footY),
                                      CGFloat(toe.z) - f.footHeight))
    }
    check("rendered toes agree with physical feedback", toeError < 0.00002,
          String(format: "maximum error %.8f units", toeError))
    var thermalError: CGFloat = 0
    for tempo: CGFloat in [0.5, 1, 2] {
        TestRandom.reset("thermal tempo reaches active motor mechanics: \(tempo)")
        let animal = Fly(at: .zero)
        animal.state = .walking; animal.speed = 0
        let reference = SixLegDynamics(geometries: animal.model.legs.map(\.geometry))
        var signals = BrainSignals()
        signals.walkDrive = 1; signals.tempo = tempo
        signals.legCommands = Array(repeating: LegMotorCommand(retract: 0.3, depress: 0.2, flex: 0.2), count: 6)
        // One production tick isolates the thermal wiring before stochastic
        // state changes can enter the comparison.
        _ = reference.advance(commands: signals.legCommands!, dt: SimulationClock.tick * tempo)
        animal.update(dt: SimulationClock.tick, bounds: CGSize(width: 1512, height: 982), mouse: nil, signals: signals)
        for (i, f) in animal.legDynamics.feedback.enumerated() {
            thermalError = max(thermalError, abs(f.kneeAngle - reference.feedback[i].kneeAngle))
        }
    }
    check("thermal tempo reaches active motor mechanics", thermalError < 1e-9,
          String(format: "joint error %.10f", thermalError))

    // State changes must preserve the current articulated pose, rather than
    // replacing it with a second gait skeleton. Behavior inputs select the
    // transition; every walking muscle command still comes from the real graph.
    func transitionCheck(_ kind: String,
                         phases: [(ticks: Int, walk: CGFloat, groom: CGFloat, sleep: Bool)],
                         expected: [Fly.State]) {
        let name = "active pose continuity: \(kind)"
        TestRandom.reset(name)
        let sim = LIFSim(circuit: data.circuit, spikeBus: nil, locomotorCircuit: data.locomotor)
        let builder = SignalBuilder(), animal = Fly(at: .zero)
        animal.state = .walking; animal.speed = 0; animal.heading = 0
        sim.stimulate(sim.fwd, strength: 0.15, durationMs: 20_000)
        var frame = 0
        func signals() -> BrainSignals {
            sim.legFeedback = animal.legFeedback
            sim.step(frame % 3 == 2 ? 9 : 8)
            frame += 1
            var s = builder.make(sim, dt: SimulationClock.tick)
            s.escape = false; s.nervous = 0; s.arousal = 0
            s.groomDrive = 0; s.walkDrive = 1; s.backward = false
            return s
        }
        let bounds = CGSize(width: 1512, height: 982)
        // Begin from a naturally evolved motor pose, never a reset/rest target.
        for _ in 0..<360 { animal.update(dt: SimulationClock.tick, bounds: bounds, mouse: nil, signals: signals()) }
        if kind == "ledge endpoint" {
            // A seeded casual flight during warmup must finish before arming
            // the endpoint; otherwise this fixture could miss the reversal.
            for _ in 0..<600 where animal.state != .walking {
                animal.update(dt: SimulationClock.tick, bounds: bounds, mouse: nil, signals: signals())
            }
            let edge = Ledge(y: 0, x0: -40, x1: 40, id: 42)
            animal.terrain = [edge]; animal.ledge = edge
            animal.pos = CGPoint(x: 39, y: 0); animal.heading = 0; animal.syncNode()
        }
        func joints() -> [simd_quatf] {
            animal.model.legs.flatMap { [$0.root.simdOrientation, $0.knee.simdOrientation, $0.ankle.simdOrientation] }
        }
        func toes() -> [SCNVector3] {
            animal.model.legs.map { $0.ankle.convertPosition(SCNVector3($0.geometry.tarsus, 0, 0), to: animal.node) }
        }
        var oldJoints = joints(), oldToes = toes(), oldHeading = animal.heading, oldPitch = animal.pitch
        var jointJump: CGFloat = 0, toeJump: CGFloat = 0, headingJump: CGFloat = 0
        var pitchJump: CGFloat = 0
        var states = [animal.state]
        var endpointReversed = kind != "ledge endpoint", movedSupportTakeoff = kind != "ledge endpoint"
        var supportShift: CGFloat = 0
        var tick = 0
        for phase in phases {
            for _ in 0..<phase.ticks {
                var s = signals()
                s.walkDrive = phase.walk; s.groomDrive = phase.groom; s.sleep = phase.sleep
                var mouse: CGPoint? = nil
                if tick == 0 && (kind == "flight and landing" || kind == "nervous turn") {
                    mouse = CGPoint(x: animal.pos.x + 180 * cos(animal.heading),
                                    y: animal.pos.y + 180 * sin(animal.heading))
                    s.escape = kind == "flight and landing"
                    s.nervous = kind == "nervous turn" ? 0.9 : 0
                }
                if kind == "ledge endpoint" && tick == 60 {
                    endpointReversed = animal.state == .walking && abs(angleDiff(0, animal.heading)) > 0.5
                    // Move an attached support at unchanged height. The fly
                    // must leave it, never clamp its x position onto the window.
                    animal.ledge = Ledge(y: 0, x0: -40, x1: 40, id: 42)
                    animal.terrain = [Ledge(y: 0, x0: 360, x1: 440, id: 42)]
                }
                let oldPosition = animal.pos
                animal.update(dt: SimulationClock.tick, bounds: bounds, mouse: mouse, signals: s)
                if kind == "ledge endpoint" && tick == 60 {
                    supportShift = hypot(animal.pos.x - oldPosition.x, animal.pos.y - oldPosition.y)
                    movedSupportTakeoff = animal.state == .flying && supportShift < 1
                }
                let nextJoints = joints(), nextToes = toes()
                for (a, b) in zip(oldJoints, nextJoints) {
                    jointJump = max(jointJump, CGFloat(2 * acos(min(1, abs(simd_dot(a.vector, b.vector))))))
                }
                for (a, b) in zip(oldToes, nextToes) {
                    toeJump = max(toeJump, hypot(hypot(CGFloat(a.x - b.x), CGFloat(a.y - b.y)), CGFloat(a.z - b.z)))
                }
                headingJump = max(headingJump, abs(angleDiff(oldHeading, animal.heading)))
                pitchJump = max(pitchJump, abs(animal.pitch - oldPitch))
                if states.last != animal.state { states.append(animal.state) }
                oldJoints = nextJoints; oldToes = nextToes; oldHeading = animal.heading; oldPitch = animal.pitch
                tick += 1
            }
        }
        var reached = 0
        for state in states where reached < expected.count {
            if state == expected[reached] { reached += 1 }
        }
        let supportDetail = kind == "ledge endpoint"
            ? String(format: "; endpoint reversed %@, moved support takeoff %@, position delta %.3f",
                     endpointReversed ? "yes" : "NO", movedSupportTakeoff ? "yes" : "NO", supportShift) : ""
        check(name, reached == expected.count && endpointReversed && movedSupportTakeoff
              && jointJump < 0.35 && toeJump < 3 && headingJump < 0.18 && pitchJump < 0.08,
              String(format: "joint %.3f rad, toe %.3f units, heading %.3f rad, pitch %.3f rad per tick; states %@",
                     jointJump, toeJump, headingJump, pitchJump, String(describing: states)) + supportDetail)
    }
    transitionCheck("groom and resume", phases: [(120, 0, 1, false), (240, 1, 0, false)],
                    expected: [.walking, .grooming, .idle, .walking])
    transitionCheck("idle sleep and wake", phases: [(120, 0, 0, false), (120, 0, 0, true), (240, 1, 0, false)],
                    expected: [.walking, .idle, .sleeping, .grooming, .idle, .walking])
    transitionCheck("flight and landing", phases: [(480, 0, 0, false), (180, 1, 0, false)],
                    expected: [.walking, .flying, .idle, .walking])
    transitionCheck("nervous turn", phases: [(120, 1, 0, false)], expected: [.walking])
    transitionCheck("ledge endpoint", phases: [(120, 1, 0, false)], expected: [.walking, .flying])
    print(failures == 0 ? "ALL LOCOMOTOR TESTS PASS" : "\(failures) LOCOMOTOR FAILURES")
    return failures == 0
}
