// MaleCNS v1.0 nerve-cord circuit. Anatomy and synapse counts are measured;
// LIF parameters, rate transfer between specimens, sensory tuning and muscle
// activation are explicit modeling assumptions (see data/LOCOMOTOR_PROVENANCE.md).
import Foundation

struct LocomotorNeuronFile: Decodable {
    let id: String
    let type: String
    let role: String
    let side: String
    let leg: Int?
    let motorChannel: String?
    let sensoryKind: String?
}

struct LocomotorCircuitFile: Decodable {
    let neurons: [LocomotorNeuronFile]
    let edges: [[Float]]

    func validate() -> Bool {
        guard !neurons.isEmpty, !edges.isEmpty,
              Set(neurons.map { $0.id }).count == neurons.count else { return false }
        for nr in neurons {
            if let leg = nr.leg, !(0..<6).contains(leg) { return false }
        }
        for e in edges {
            guard e.count == 3, e.allSatisfy({ $0.isFinite }),
                  e[0] >= 0, e[1] >= 0, e[0] < Float(neurons.count),
                  e[1] < Float(neurons.count), e[0].rounded() == e[0],
                  e[1].rounded() == e[1] else { return false }
        }
        return (0..<6).allSatisfy { leg in
            ["tibia_flexor", "tibia_extensor", "trochanter_flexor", "trochanter_extensor"].allSatisfy { channel in
                neurons.contains { $0.leg == leg && $0.motorChannel == channel }
            }
        }
    }
}

struct LocomotorParameters {
    var synapticGain: Double = 2.4
    var baseline: Double = 0.022
    var adaptationKick: Double = 0.01
}

final class LocomotorSim {
    // The per-millisecond loops below run over ~1,000 neurons a thousand times a
    // second, so everything they touch is resolved to an integer index here at
    // init: a string compare, a dictionary hash, or a copy of a neuron struct
    // (six retained String fields) inside those loops costs more than the LIF
    // arithmetic it guards. Names still come from the data; only lookups change.
    static let motorChannelNames = [
        "coxa_promotor", "coxa_anterior_rotator", "coxa_remotor", "coxa_posterior_rotator",
        "trochanter_flexor", "trochanter_extensor", "tibia_flexor", "tibia_extensor",
    ]
    private enum Role: UInt8 { case other = 0, motor, sensory, descending, ascending }
    private enum SensoryKind: UInt8 { case load = 0, hairPlate, excursion }

    let circuit: LocomotorCircuitFile
    let n: Int
    private var voltage: [Double]
    private var adaptation: [Double]
    private var refractory: [Int]
    private var rates: [Double]
    private var excitatory: [Double]
    private var inhibitory: [Double]
    private var nextExcitatory: [Double]
    private var nextInhibitory: [Double]
    private var rowStart: [Int]
    private var targets: [Int]
    private var weights: [Double]
    private var drive: [Double]
    private var sensoryDrive: [Double]
    private var roleCode: [UInt8] = []
    private var commandGroupIds: [[Int]] = []
    private var commandGroupIndex: [String: Int] = [:]
    private var motorChannelIds: [[Int]] = []   // leg * motorChannelNames.count + channel
    private var sensory: [Int] = []
    private var sensoryLeg: [Int] = []          // parallel to `sensory`
    private var sensoryKind: [UInt8] = []       // parallel to `sensory`
    private(set) var commands = Array(repeating: LegMotorCommand(), count: 6)
    private(set) var totalSpikes = 0
    private(set) var motorSpikes = 0
    private(set) var sensorySpikes = 0
    private(set) var simMs = 0
    var feedback: [LegFeedback] = []
    // Lesions are diagnostic interventions, used to verify actual causal paths.
    // The set stays the API; the hot loop reads the mirrored flags instead, so a
    // normal run costs one Bool check rather than a hash per neuron per ms.
    var silenced: Set<Int> = [] {
        didSet {
            anySilenced = !silenced.isEmpty
            for i in 0..<n { silencedFlag[i] = silenced.contains(i) }
        }
    }
    private var silencedFlag: [Bool] = []
    private var anySilenced = false
    var synapsesEnabled = true
    var feedbackEnabled = true
    let parameters: LocomotorParameters

    init(circuit: LocomotorCircuitFile, parameters: LocomotorParameters = LocomotorParameters()) {
        precondition(circuit.validate(), "invalid MaleCNS locomotor circuit")
        self.circuit = circuit
        self.parameters = parameters
        n = circuit.neurons.count
        voltage = .init(repeating: 0, count: n)
        adaptation = .init(repeating: 0, count: n)
        refractory = .init(repeating: 0, count: n)
        rates = .init(repeating: 0, count: n)
        excitatory = .init(repeating: 0, count: n)
        inhibitory = .init(repeating: 0, count: n)
        nextExcitatory = .init(repeating: 0, count: n)
        nextInhibitory = .init(repeating: 0, count: n)
        drive = .init(repeating: 0, count: n)
        sensoryDrive = .init(repeating: 0, count: n)
        silencedFlag = .init(repeating: false, count: n)
        roleCode = circuit.neurons.map {
            switch $0.role {
            case "motor": return Role.motor.rawValue
            case "sensory": return Role.sensory.rawValue
            case "descending": return Role.descending.rawValue
            case "ascending": return Role.ascending.rawValue
            default: return Role.other.rawValue
            }
        }
        motorChannelIds = Array(repeating: [], count: 6 * Self.motorChannelNames.count)
        var counts = Array(repeating: 0, count: n)
        var inputTotal = Array(repeating: Double(0), count: n)
        for e in circuit.edges {
            counts[Int(e[0])] += 1
            inputTotal[Int(e[1])] += abs(Double(e[2]))
        }
        rowStart = Array(repeating: 0, count: n + 1)
        for i in 0..<n { rowStart[i + 1] = rowStart[i] + counts[i] }
        targets = Array(repeating: 0, count: circuit.edges.count)
        weights = Array(repeating: 0, count: circuit.edges.count)
        var fill = rowStart
        for e in circuit.edges {
            let pre = Int(e[0]), post = Int(e[1]), slot = fill[pre]
            targets[slot] = post
            // Normalize retained input to avoid equating synapse count with a
            // measured conductance. Relative counts and transmitter signs survive.
            weights[slot] = parameters.synapticGain * Double(e[2]) / max(60, inputTotal[post])
            fill[pre] += 1
        }
        for (i, nr) in circuit.neurons.enumerated() {
            if nr.role == "descending" {
                let key = "\(nr.type):\(nr.side)"
                let group: Int
                if let existing = commandGroupIndex[key] { group = existing }
                else {
                    group = commandGroupIds.count
                    commandGroupIndex[key] = group
                    commandGroupIds.append([])
                }
                commandGroupIds[group].append(i)
            }
            if nr.role == "sensory", let leg = nr.leg {
                sensory.append(i)
                sensoryLeg.append(leg)
                // Same three-way split the step loop used to spell out with
                // string compares; the pooling rationale is unchanged.
                let kind: SensoryKind
                if nr.sensoryKind == "campaniform" || nr.sensoryKind == "contact" { kind = .load }
                else if nr.sensoryKind == "hair_plate" { kind = .hairPlate }
                else { kind = .excursion }
                sensoryKind.append(kind.rawValue)
            }
            if nr.role == "motor", let leg = nr.leg, let channel = nr.motorChannel,
               let slot = Self.motorChannelNames.firstIndex(of: channel) {
                motorChannelIds[leg * Self.motorChannelNames.count + slot].append(i)
            }
        }
    }

    // A modeled homologous population-rate interface between female FlyWire
    // and male CNS specimens. It adds current, never fabricated graph edges.
    func setDescending(_ type: String, side: String, rate: Float) {
        guard let group = commandGroupIndex["\(type):\(side)"] else { return }
        setDescending(group: group, rate: rate)
    }

    // Index form of the above, for the caller that resolves its groups once.
    func descendingGroup(_ type: String, side: String) -> Int? {
        commandGroupIndex["\(type):\(side)"]
    }

    func setDescending(group: Int, rate: Float) {
        let value = min(0.35, max(0, Double(rate)) * 0.004)
        for i in commandGroupIds[group] { drive[i] = value }
    }

    func meanRate(role: String, leg: Int? = nil) -> Float {
        let ids = indices(role: role, leg: leg)
        return Float(ids.reduce(0) { $0 + rates[$1] } / Double(max(1, ids.count)))
    }

    func indices(role: String, leg: Int? = nil) -> [Int] {
        guard let code = Self.roleCode(role) else { return [] }
        return (0..<n).filter {
            roleCode[$0] == code && (leg == nil || circuit.neurons[$0].leg == leg)
        }
    }

    private static func roleCode(_ role: String) -> UInt8? {
        switch role {
        case "motor": return Role.motor.rawValue
        case "sensory": return Role.sensory.rawValue
        case "descending": return Role.descending.rawValue
        case "ascending": return Role.ascending.rawValue
        case "premotor": return Role.other.rawValue
        default: return nil
        }
    }

    func step(_ ms: Int) {
        guard ms > 0 else { return }
        for _ in 0..<ms {
            simMs += 1
            // Leg-local sensory transduction, without global gait phase or
            // neuron-ID-derived tuning. Missing direction tuning is pooled:
            // proprioceptors encode joint excursion/speed; contact sensors load.
            for k in sensory.indices { sensoryDrive[sensory[k]] = 0 }
            if feedbackEnabled && feedback.count == 6 {
                for k in sensory.indices {
                    let f = feedback[sensoryLeg[k]]
                    let value: CGFloat
                    switch sensoryKind[k] {
                    case SensoryKind.load.rawValue:
                        value = f.contact ? min(1, f.load * 6) : 0
                    case SensoryKind.hairPlate.rawValue:
                        value = min(1, abs(f.hipAngle) / LegDynamics.hipLimit
                                    + abs(f.elevationVelocity) / 20)
                    default:
                        value = min(1, abs(f.kneeVelocity) / 20 + abs(f.hipVelocity) / 16
                                      + abs(f.kneeAngle - LegDynamics.restKnee) * 0.35)
                    }
                    sensoryDrive[sensory[k]] = Double(value) * 0.10
                }
            }
            for i in 0..<n {
                // Finite synaptic currents, with 5 ms excitatory and 10 ms
                // inhibitory decay. These timescales are model parameters,
                // not measured for the reconstructed specimen.
                excitatory[i] = excitatory[i] * 0.8187308 + nextExcitatory[i]
                inhibitory[i] = inhibitory[i] * 0.9048374 + nextInhibitory[i]
                nextExcitatory[i] = 0; nextInhibitory[i] = 0
            }
            for i in 0..<n {
                rates[i] *= 0.9048374 // 10 ms rate time constant for fast muscles
                adaptation[i] *= 0.9950125 // 200 ms spike-frequency adaptation
                if anySilenced && silencedFlag[i] {
                    voltage[i] = 0; rates[i] = 0; continue
                }
                if refractory[i] > 0 { refractory[i] -= 1; continue }
                // Deterministic subthreshold excitability, without autonomous
                // noise or gait oscillators. Input must recruit the real graph.
                voltage[i] = max(-1, voltage[i] * 0.9512294 + excitatory[i] + inhibitory[i]
                                     + parameters.baseline + drive[i] + sensoryDrive[i] - adaptation[i])
                if voltage[i] >= 1 {
                    voltage[i] = 0; refractory[i] = 2
                    adaptation[i] += parameters.adaptationKick
                    rates[i] += 95.16258
                    totalSpikes += 1
                    if roleCode[i] == Role.motor.rawValue { motorSpikes += 1 }
                    else if roleCode[i] == Role.sensory.rawValue { sensorySpikes += 1 }
                    if synapsesEnabled {
                        for e in rowStart[i]..<rowStart[i + 1] {
                            if weights[e] >= 0 { nextExcitatory[targets[e]] += weights[e] }
                            else { nextInhibitory[targets[e]] += weights[e] }
                        }
                    }
                }
            }
        }
        for leg in 0..<6 {
            let base = leg * Self.motorChannelNames.count
            func activity(_ slot: Int) -> CGFloat {
                let ids = motorChannelIds[base + slot]
                guard !ids.isEmpty else { return 0 }
                let rate = ids.reduce(0) { $0 + rates[$1] } / Double(ids.count)
                return CGFloat(rate / (rate + 50))
            }
            // Slots follow motorChannelNames: promotor, anterior rotator, remotor,
            // posterior rotator, trochanter flexor/extensor, tibia flexor/extensor.
            commands[leg] = LegMotorCommand(
                protract: max(activity(0), activity(1)),
                retract: max(activity(2), activity(3)),
                lift: activity(4), depress: activity(5),
                flex: activity(6), extend: activity(7))
        }
    }
}
