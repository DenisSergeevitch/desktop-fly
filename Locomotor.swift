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
    private var commandGroups: [String: [Int]] = [:]
    private var motorGroups = Array(repeating: [String: [Int]](), count: 6)
    private var sensory: [Int] = []
    private(set) var commands = Array(repeating: LegMotorCommand(), count: 6)
    private(set) var totalSpikes = 0
    private(set) var motorSpikes = 0
    private(set) var sensorySpikes = 0
    private(set) var simMs = 0
    var feedback: [LegFeedback] = []
    // Lesions are diagnostic interventions, used to verify actual causal paths.
    var silenced: Set<Int> = []
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
                commandGroups["\(nr.type):\(nr.side)", default: []].append(i)
            }
            if nr.role == "sensory", nr.leg != nil { sensory.append(i) }
            if nr.role == "motor", let leg = nr.leg, let channel = nr.motorChannel {
                motorGroups[leg][channel, default: []].append(i)
            }
        }
    }

    // A modeled homologous population-rate interface between female FlyWire
    // and male CNS specimens. It adds current, never fabricated graph edges.
    func setDescending(_ type: String, side: String, rate: Float) {
        for i in commandGroups["\(type):\(side)"] ?? [] {
            drive[i] = min(0.35, max(0, Double(rate)) * 0.004)
        }
    }

    func meanRate(role: String, leg: Int? = nil) -> Float {
        let ids = circuit.neurons.indices.filter {
            circuit.neurons[$0].role == role && (leg == nil || circuit.neurons[$0].leg == leg)
        }
        return Float(ids.reduce(0) { $0 + rates[$1] } / Double(max(1, ids.count)))
    }

    func indices(role: String, leg: Int? = nil) -> [Int] {
        circuit.neurons.indices.filter {
            circuit.neurons[$0].role == role && (leg == nil || circuit.neurons[$0].leg == leg)
        }
    }

    func step(_ ms: Int) {
        guard ms > 0 else { return }
        for _ in 0..<ms {
            simMs += 1
            // Leg-local sensory transduction, without global gait phase or
            // neuron-ID-derived tuning. Missing direction tuning is pooled:
            // proprioceptors encode joint excursion/speed; contact sensors load.
            for i in sensory { sensoryDrive[i] = 0 }
            if feedbackEnabled && feedback.count == 6 {
                for i in sensory {
                    let nr = circuit.neurons[i], f = feedback[nr.leg!]
                    let value: CGFloat
                    if nr.sensoryKind == "campaniform" || nr.sensoryKind == "contact" {
                        value = f.contact ? min(1, f.load * 6) : 0
                    } else if nr.sensoryKind == "hair_plate" {
                        value = min(1, abs(f.hipAngle) / LegDynamics.hipLimit
                                    + abs(f.elevationVelocity) / 20)
                    } else {
                        value = min(1, abs(f.kneeVelocity) / 20 + abs(f.hipVelocity) / 16
                                      + abs(f.kneeAngle - LegDynamics.restKnee) * 0.35)
                    }
                    sensoryDrive[i] = Double(value) * 0.10
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
                if silenced.contains(i) {
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
                    if circuit.neurons[i].role == "motor" { motorSpikes += 1 }
                    if circuit.neurons[i].role == "sensory" { sensorySpikes += 1 }
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
            func activity(_ channel: String) -> CGFloat {
                let ids = motorGroups[leg][channel] ?? []
                let rate = ids.reduce(0) { $0 + rates[$1] } / Double(max(1, ids.count))
                return CGFloat(rate / (rate + 50))
            }
            commands[leg] = LegMotorCommand(
                protract: max(activity("coxa_promotor"), activity("coxa_anterior_rotator")),
                retract: max(activity("coxa_remotor"), activity("coxa_posterior_rotator")),
                lift: activity("trochanter_flexor"), depress: activity("trochanter_extensor"),
                flex: activity("tibia_flexor"), extend: activity("tibia_extensor"))
        }
    }
}
