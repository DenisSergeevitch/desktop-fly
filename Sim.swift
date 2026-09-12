// Sim.swift — loads real FlyWire v783 data and runs a leaky-integrate-and-fire
// simulation of the escape/steering circuit (LC4/LPLC2 -> DNp01 giant fiber,
// DNa02 steering, MDN backward walking) with real signed synapse weights.

import Foundation
import simd

// Membrane noise needs one draw per neuron per simulated millisecond — ~670,000
// a second. SystemRandomNumberGenerator is an AES-CTR CSPRNG, and its ccrng/
// ccaes frames were a measurable slice of the profile for what is a jitter term.
// Seed from the system generator, then run splitmix64: still uncorrelated, at a
// few instructions per draw. Seeded test runs never reach this (see TestRandom).
struct FastRandom: RandomNumberGenerator {
    private var state: UInt64
    init() {
        var system = SystemRandomNumberGenerator()
        state = system.next()
    }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

// Opt-in, repeatable test stimuli. Without reset(), every call below delegates
// to the same platform RNG used by the application before test seeding existed.
// The test stream matches windows/test/random.js: FNV-1a(label), then LCG32.
enum TestRandom {
    private static var state: UInt32?

    @discardableResult
    static func reset(_ label: String = "desktop-fly-tests") -> UInt32 {
        var seed: UInt32 = 2_166_136_261
        for character in label.utf16 { seed = (seed ^ UInt32(character)) &* 16_777_619 }
        state = seed
        return seed
    }

    private static func unit() -> Double? {
        guard let current = state else { return nil }
        let next = current &* 1_664_525 &+ 1_013_904_223
        state = next
        return Double(next) / 4_294_967_296
    }

    static func float(in range: ClosedRange<Float>) -> Float {
        guard let u = unit() else { return Float.random(in: range) }
        return range.lowerBound + (range.upperBound - range.lowerBound) * Float(u)
    }

    static func float(in range: ClosedRange<Float>, using rng: inout some RandomNumberGenerator) -> Float {
        guard let u = unit() else { return Float.random(in: range, using: &rng) }
        return range.lowerBound + (range.upperBound - range.lowerBound) * Float(u)
    }

    static func cgFloat(in range: ClosedRange<CGFloat>) -> CGFloat {
        guard let u = unit() else { return CGFloat.random(in: range) }
        return range.lowerBound + (range.upperBound - range.lowerBound) * CGFloat(u)
    }

    static func integer(in range: Range<Int>) -> Int {
        guard let u = unit() else { return Int.random(in: range) }
        return range.lowerBound + min(range.count - 1, Int(u * Double(range.count)))
    }

    static func integer(in range: ClosedRange<Int>, using rng: inout some RandomNumberGenerator) -> Int {
        guard let u = unit() else { return Int.random(in: range, using: &rng) }
        let count = range.upperBound - range.lowerBound + 1
        return range.lowerBound + min(count - 1, Int(u * Double(count)))
    }
}

// Run the entire closed loop on a fixed clock; render frequency must not change
// sensory sample/hold duration in the fast nerve-cord dynamics.
final class SimulationClock {
    static let tick: CGFloat = 1 / 120
    private var accumulator: CGFloat = 0
    func advance(_ elapsed: CGFloat, tick: (CGFloat) -> Void) {
        guard elapsed.isFinite, elapsed > 0 else { return }
        accumulator += min(0.1, elapsed)
        while accumulator + 1e-10 >= Self.tick {
            accumulator -= Self.tick
            tick(Self.tick)
        }
    }
}

// What the brain tells the body each frame.
struct BrainSignals {
    var escape = false        // giant fiber spiked -> takeoff NOW
    var nervous: CGFloat = 0  // looming-detector population rate, 0..1
    var turnBias: CGFloat = 0 // rad/s steering from DNa01/DNa02 left-right rate difference
    var backward = false      // MDN burst -> backward walking
    var walkDrive: CGFloat = 0  // DNp09 forward-walking command rate, ~0..1.5
    var groomDrive: CGFloat = 0 // DNg11 grooming command rate, ~0..1.5
    var wingDrive: CGFloat = 0  // DNp02/04/11 escape-maneuver DN rate, ~0..1.3
    var arousal: CGFloat = 0    // whole-population activity, ~0..1
    var tempo: CGFloat = 1      // thermal "temperature" scaling of locomotion
    var sleep = false           // circadian + idle -> sleep-like state
    var legCommands: [LegMotorCommand]? = nil // MaleCNS motor output, RF LF RM LM RH LH
}

struct BrainPointsFile: Decodable {
    let classes: [String]
    let points: [[Float]]     // [x, y, z, classIndex]
}
struct CircuitNeuronFile: Decodable {
    let id: String
    let type: String
    let role: String          // lc4 | lplc2 | gf | dna02 | mdn | other
    let side: String          // left | right | center
    let pos: [Float]
}
struct CircuitFile: Decodable {
    let neurons: [CircuitNeuronFile]
    let edges: [[Float]]      // [preIdx, postIdx, signedSynCount]
}

func findDataDir() -> URL? {
    let fm = FileManager.default
    let exeDir = URL(fileURLWithPath: CommandLine.arguments[0])
        .resolvingSymlinksInPath().deletingLastPathComponent()
    let candidates = [
        exeDir.appendingPathComponent("data"),
        URL(fileURLWithPath: fm.currentDirectoryPath).appendingPathComponent("data"),
    ]
    return candidates.first { fm.fileExists(atPath: $0.appendingPathComponent("circuit.json").path) }
}

func loadBrainData() -> (points: BrainPointsFile, circuit: CircuitFile, locomotor: LocomotorCircuitFile)? {
    guard let dir = findDataDir(),
          let pData = try? Data(contentsOf: dir.appendingPathComponent("brain_points.json")),
          let cData = try? Data(contentsOf: dir.appendingPathComponent("circuit.json")),
          let lData = try? Data(contentsOf: dir.appendingPathComponent("locomotor_circuit.json")),
          let points = try? JSONDecoder().decode(BrainPointsFile.self, from: pData),
          let circuit = try? JSONDecoder().decode(CircuitFile.self, from: cData),
          let locomotor = try? JSONDecoder().decode(LocomotorCircuitFile.self, from: lData),
          locomotor.validate()
    else { return nil }
    return (points, circuit, locomotor)
}

// Thread-safe spike hand-off from the sim (fly render loop) to the brain window.
final class SpikeBus {
    private let lock = NSLock()
    private var events: [(neuron: Int, isGF: Bool)] = []
    func push(_ e: [(Int, Bool)]) {
        lock.lock()
        events.append(contentsOf: e)
        if events.count > 256 { events.removeFirst(events.count - 256) }
        lock.unlock()
    }
    func popAll() -> [(neuron: Int, isGF: Bool)] {
        lock.lock(); defer { lock.unlock() }
        let e = events; events.removeAll(); return e
    }
}

final class LIFSim {
    let locomotor: LocomotorSim?
    var legFeedback: [LegFeedback] = []
    private var cordSourceGroups: [(type: String, side: String, count: Int)] = []
    private var cordSourceGroupId: [Int] = []   // parallel: resolved LocomotorSim group
    private var cordSourceOf: [Int] = []
    private var cordSourceRates: [Float] = []
    let n: Int
    let roles: [String]
    let types: [String]
    let positions: [SIMD3<Float>]

    // LIF state
    private var v: [Float]
    private var refr: [Float]
    private var baseline: [Float]        // per-neuron constant drive (heterogeneous excitability)

    // CSR adjacency, weights pre-scaled
    private var rowStart: [Int]
    private var colIdx: [Int32]
    private var w: [Float]

    // groups
    private(set) var loomLeft: [Int] = []
    private(set) var loomRight: [Int] = []
    private(set) var gf: [Int] = []
    private(set) var dnaL: [Int] = []      // DNa01 + DNa02, left
    private(set) var dnaR: [Int] = []      // DNa01 + DNa02, right
    private(set) var mdn: [Int] = []
    private(set) var fwd: [Int] = []       // DNp09
    private(set) var groom: [Int] = []     // DNg11
    private(set) var escw: [Int] = []      // DNp02/04/11 escape-maneuver (wing) DNs
    private(set) var ascend: [Int] = []    // ascending partners (leg proprioception)
    private(set) var sens: [Int] = []      // sensory partners (air-puff pathway)
    private var ascendPhase: [Float] = []  // per-ascending-neuron gait phase offset
    // Per-spike classification, resolved once. The counting switch below runs for
    // every spike of every simulated millisecond, where a String switch plus the
    // `dnaL.contains(i)` linear scan cost more than the integration it tallies.
    private enum Tally: UInt8 { case none = 0, loom, dnaLeft, dnaRight, mdn, fwd, groom, escw, gf }
    private var tally: [UInt8] = []

    // inputs (0..1), set each frame by the coordinator
    var loomL: Float = 0
    var loomR: Float = 0
    var gaitDrive: Float = 0   // body walking intensity -> ascending neurons
    var gaitPhase: Float = 0   // body gait phase 0..1 -> rhythmic proprioception
    var airPuff: Float = 0     // fast cursor motion near the fly -> sensory neurons
    var activityScale: Float = 1  // circadian / sleep neuromodulation of baseline+noise
    var sensoryGate: Float = 1    // sleep gates sensory input (raised arousal threshold)

    // outputs
    private(set) var rateLoom: Float = 0   // Hz per LC neuron (EMA)
    private(set) var rateDNaL: Float = 0
    private(set) var rateDNaR: Float = 0
    private(set) var rateMDN: Float = 0
    private(set) var rateFwd: Float = 0
    private(set) var rateGroom: Float = 0
    private(set) var rateEscW: Float = 0
    private(set) var ratePop: Float = 0    // whole-population Hz per neuron
    private var gfLatch = false
    private(set) var simMs: Int = 0
    private(set) var totalSpikes: Int = 0

    // GABA/Glut synapses deliver with a few ms delay; the LC->GF electrical
    // coupling is instantaneous. This latency window is what lets the giant
    // fiber fire before feedforward inhibition arrives.
    private let inhDelayMs = 4
    private var inhQueue: [[Float]]
    // Which entries of each inhQueue slot are actually non-zero. Scanning all n
    // floats per slot per millisecond dominated the delayed-inhibition delivery
    // even though only a handful of targets are ever pending.
    private var inhTargets: [[Int32]]
    private var qHead = 0

    // params
    private let decay: Float = 0.9512     // exp(-1/20): 20 ms membrane tau, 1 ms step
    private let threshold: Float = 1.0
    private let refractoryMs: Float = 2
    private let weightScale: Float = 0.0008
    private let pNoise: Float = 0.0022
    private let noiseKick: Float = 0.42
    private let loomGain: Float = 0.30
    private let rateAlpha: Float = 1.0 / 120.0
    private var burstUntil = 0            // occasional "arousal" noise bursts
    private var burstNext = 12_000

    let spikeBus: SpikeBus?
    private var rng = FastRandom()

    // "optogenetic" stimulation from brain-window clicks (any thread)
    private struct Stim { let idx: [Int]; let strength: Float; let durationMs: Int; var untilMs = 0 }
    private var pendingStims: [Stim] = []
    private var activeStims: [Stim] = []
    private let stimLock = NSLock()

    func stimulate(_ indices: [Int], strength: Float, durationMs: Int) {
        guard !indices.isEmpty else { return }
        stimLock.lock()
        pendingStims.append(Stim(idx: indices, strength: strength, durationMs: durationMs))
        if pendingStims.count > 8 { pendingStims.removeFirst() }
        stimLock.unlock()
    }

    init(circuit: CircuitFile, spikeBus: SpikeBus?, locomotorCircuit: LocomotorCircuitFile? = nil) {
        locomotor = locomotorCircuit.map { LocomotorSim(circuit: $0) }
        self.spikeBus = spikeBus
        n = circuit.neurons.count
        roles = circuit.neurons.map { $0.role }
        types = circuit.neurons.map { $0.type }
        positions = circuit.neurons.map {
            SIMD3<Float>($0.pos.count == 3 ? $0.pos[0] : 0,
                         $0.pos.count == 3 ? $0.pos[1] : 0,
                         $0.pos.count == 3 ? $0.pos[2] : 0)
        }
        v = [Float](repeating: 0, count: n)
        refr = [Float](repeating: 0, count: n)
        inhQueue = Array(repeating: [Float](repeating: 0, count: n), count: 5)
        inhTargets = Array(repeating: [], count: 5)

        for (i, nr) in circuit.neurons.enumerated() {
            switch nr.role {
            case "lc4", "lplc2":
                if nr.side == "left" { loomLeft.append(i) } else { loomRight.append(i) }
            case "gf": gf.append(i)
            case "dna01", "dna02":
                if nr.side == "left" { dnaL.append(i) } else { dnaR.append(i) }
            case "mdn": mdn.append(i)
            case "dnp09": fwd.append(i)
            case "dng11": groom.append(i)
            case "escw": escw.append(i)
            case "other":
                // partners keep their super_class as `type`
                if nr.type == "ascending" { ascend.append(i) }
                else if nr.type == "sensory" { sens.append(i) }
            default: break
            }
        }
        ascendPhase = ascend.map { _ in TestRandom.float(in: 0...(2 * Float.pi)) }

        tally = [UInt8](repeating: Tally.none.rawValue, count: n)
        for i in loomLeft + loomRight { tally[i] = Tally.loom.rawValue }
        for i in dnaL { tally[i] = Tally.dnaLeft.rawValue }
        for i in dnaR { tally[i] = Tally.dnaRight.rawValue }
        for i in mdn { tally[i] = Tally.mdn.rawValue }
        for i in fwd { tally[i] = Tally.fwd.rawValue }
        for i in groom { tally[i] = Tally.groom.rawValue }
        for i in escw { tally[i] = Tally.escw.rawValue }
        for i in gf { tally[i] = Tally.gf.rawValue }

        // Heterogeneous baseline drive: interneurons get enough to crackle at a
        // few Hz; sensory and command neurons stay quiet unless driven.
        var base = [Float](repeating: 0, count: n)
        for i in 0..<n {
            switch circuit.neurons[i].role {
            case "other": base[i] = TestRandom.float(in: 0.010...0.070)
            case "lc4", "lplc2": base[i] = 0.004
            // command DNs get deterministic, side-symmetric baselines: their
            // asymmetries and bursts must come from network dynamics, not luck
            case "dna01", "dna02", "mdn", "dng11", "escw": base[i] = 0.036
            case "dnp09": base[i] = 0.038
            default: base[i] = 0.002        // gf: quiet unless synaptically driven
            }
        }
        baseline = base
        // Keep DNa01 and DNa02 separate across the specimen interface. Their
        // combined steering readout is useful to the legacy body, but copying
        // that pooled rate into both male cell types erases cell identity.
        cordSourceOf = Array(repeating: -1, count: n)
        var groupByKey: [String: Int] = [:]
        for (i, nr) in circuit.neurons.enumerated()
            where ["DNp09", "DNa01", "DNa02", "MDN"].contains(nr.type) {
            let key = "\(nr.type):\(nr.side)"
            let group: Int
            if let existing = groupByKey[key] { group = existing }
            else {
                group = cordSourceGroups.count; groupByKey[key] = group
                cordSourceGroups.append((nr.type, nr.side, 0)); cordSourceRates.append(0)
            }
            cordSourceGroups[group].count += 1
            cordSourceOf[i] = group
        }

        // CSR
        var counts = [Int](repeating: 0, count: n)
        for e in circuit.edges { counts[Int(e[0])] += 1 }
        rowStart = [Int](repeating: 0, count: n + 1)
        for i in 0..<n { rowStart[i + 1] = rowStart[i] + counts[i] }
        colIdx = [Int32](repeating: 0, count: circuit.edges.count)
        w = [Float](repeating: 0, count: circuit.edges.count)
        // LC4/LPLC2 -> GF and the wind pathway (JO sensory) -> GF couple via
        // electrical (gap-junction) synapses, which chemical synapse counts
        // under-represent; boost that drive.
        let gapJunctionBoost: Float = 6.0
        var fill = rowStart
        for e in circuit.edges {
            let pre = Int(e[0]), post = Int(e[1])
            var weight = e[2] * weightScale
            let electrical = roles[pre] == "lc4" || roles[pre] == "lplc2"
                || (roles[pre] == "other" && types[pre] == "sensory")
            if electrical && roles[post] == "gf" {
                weight *= gapJunctionBoost
            }
            colIdx[fill[pre]] = Int32(post)
            w[fill[pre]] = weight
            fill[pre] += 1
        }

        // Resolve the homolog group names to indices once. The step loop pushes
        // these rates every simulated millisecond; building the "type:side" key
        // there meant a string interpolation and a dictionary hash 8,000 times a
        // second for eight values that never change identity.
        cordSourceGroupId = cordSourceGroups.map { g in
            locomotor?.descendingGroup(g.type, side: g.side) ?? -1
        }
    }

    func consumeGF() -> Bool {
        let s = gfLatch; gfLatch = false; return s
    }

    func step(_ ms: Int) {
        guard ms > 0 else { return }
        locomotor?.feedback = legFeedback
        stimLock.lock()
        for var p in pendingStims {
            p.untilMs = simMs + p.durationMs
            activeStims.append(p)
        }
        pendingStims.removeAll()
        stimLock.unlock()
        activeStims.removeAll { simMs >= $0.untilMs }

        var spikedNow: [(Int, Bool)] = []
        for _ in 0..<ms {
            simMs += 1
            if simMs >= burstNext {
                burstUntil = simMs + 400
                burstNext = simMs + TestRandom.integer(in: 15_000...40_000, using: &rng)
            }
            let p = (simMs < burstUntil ? pNoise * 6 : pNoise) * activityScale

            for i in 0..<n {
                if refr[i] > 0 { refr[i] -= 1; v[i] *= decay; continue }
                var vi = v[i] * decay + baseline[i] * activityScale
                if TestRandom.float(in: 0...1, using: &rng) < p { vi += noiseKick }
                v[i] = vi
            }
            if loomL > 0.001 { for i in loomLeft { v[i] += loomL * loomGain * sensoryGate } }
            if loomR > 0.001 { for i in loomRight { v[i] += loomR * loomGain * sensoryGate } }
            // body -> brain: gait rhythm into ascending (proprioceptive) neurons
            if locomotor == nil && gaitDrive > 0.001 {
                let ph = gaitPhase * 2 * Float.pi
                for (k, i) in ascend.enumerated() {
                    v[i] += gaitDrive * 0.09 * (0.5 + 0.5 * sin(ph + ascendPhase[k]))
                }
            }
            // fast air movement near the fly -> sensory pathway
            if airPuff > 0.001 { for i in sens { v[i] += airPuff * 0.12 * sensoryGate } }
            // brain-window click stimulation
            for s in activeStims where simMs < s.untilMs {
                for i in s.idx { v[i] += s.strength }
            }

            // deliver delayed inhibition scheduled for this millisecond
            for j32 in inhTargets[qHead] {
                let j = Int(j32)
                v[j] = max(-2, v[j] + inhQueue[qHead][j])
                inhQueue[qHead][j] = 0
            }
            inhTargets[qHead].removeAll(keepingCapacity: true)

            var spiked: [Int] = []
            for i in 0..<n where refr[i] <= 0 && v[i] >= threshold {
                v[i] = 0; refr[i] = refractoryMs
                spiked.append(i)
            }
            totalSpikes += spiked.count
            let inhSlot = (qHead + inhDelayMs) % inhQueue.count
            for i in spiked {
                for k in rowStart[i]..<rowStart[i + 1] {
                    let j = Int(colIdx[k])
                    if w[k] >= 0 { v[j] = max(-2, v[j] + w[k]) }
                    else {
                        if inhQueue[inhSlot][j] == 0 { inhTargets[inhSlot].append(Int32(j)) }
                        inhQueue[inhSlot][j] += w[k]
                    }
                }
            }
            qHead = (qHead + 1) % inhQueue.count

            // group rates (Hz per neuron, EMA)
            var cLoom = 0, cDL = 0, cDR = 0, cM = 0, cF = 0, cG = 0, cW = 0
            for i in spiked {
                switch tally[i] {
                case Tally.loom.rawValue: cLoom += 1
                case Tally.dnaLeft.rawValue: cDL += 1
                case Tally.dnaRight.rawValue: cDR += 1
                case Tally.mdn.rawValue: cM += 1
                case Tally.fwd.rawValue: cF += 1
                case Tally.groom.rawValue: cG += 1
                case Tally.escw.rawValue: cW += 1
                case Tally.gf.rawValue: gfLatch = true
                default: break
                }
            }
            let nLoom = Float(max(1, loomLeft.count + loomRight.count))
            rateLoom += (Float(cLoom) * 1000 / nLoom - rateLoom) * rateAlpha
            rateDNaL += (Float(cDL) * 1000 / Float(max(1, dnaL.count)) - rateDNaL) * rateAlpha
            rateDNaR += (Float(cDR) * 1000 / Float(max(1, dnaR.count)) - rateDNaR) * rateAlpha
            rateMDN  += (Float(cM)  * 1000 / Float(max(1, mdn.count))  - rateMDN)  * rateAlpha
            rateFwd  += (Float(cF)  * 1000 / Float(max(1, fwd.count))  - rateFwd)  * rateAlpha
            rateGroom += (Float(cG) * 1000 / Float(max(1, groom.count)) - rateGroom) * rateAlpha
            rateEscW += (Float(cW) * 1000 / Float(max(1, escw.count)) - rateEscW) * rateAlpha
            ratePop  += (Float(spiked.count) * 1000 / Float(max(1, n)) - ratePop) * rateAlpha

            if let cord = locomotor {
                for i in cordSourceRates.indices { cordSourceRates[i] *= 1 - rateAlpha }
                for i in spiked where cordSourceOf[i] >= 0 {
                    let group = cordSourceOf[i]
                    cordSourceRates[group] += 1000 * rateAlpha / Float(cordSourceGroups[group].count)
                }
                for (i, group) in cordSourceGroupId.enumerated() where group >= 0 {
                    cord.setDescending(group: group, rate: cordSourceRates[i])
                }
                cord.step(1)
            }

            if spikeBus != nil {
                let stride = max(1, spiked.count / 12)   // sample under heavy activity
                var i = 0
                while i < spiked.count {
                    spikedNow.append((spiked[i], roles[spiked[i]] == "gf"))
                    i += stride
                }
            }
        }
        spikeBus?.push(spikedNow)
    }
}
