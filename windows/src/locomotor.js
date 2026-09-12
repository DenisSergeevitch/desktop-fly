// MaleCNS v1.0 nerve-cord circuit. Anatomy and synapse counts are measured;
// LIF parameters, rate transfer between specimens, sensory tuning and muscle
// activation are modeling assumptions. Mirrors Locomotor.swift.
import { LegDynamics, makeLegMotorCommand } from './legdynamics.js';

export function validateLocomotorCircuit(circuit) {
  if (!circuit || !Array.isArray(circuit.neurons) || !circuit.neurons.length
      || !Array.isArray(circuit.edges) || !circuit.edges.length) return false;
  const { neurons, edges } = circuit;
  if (new Set(neurons.map((neuron) => neuron.id)).size !== neurons.length) return false;
  for (const nr of neurons) {
    if (nr.leg != null && (!Number.isInteger(nr.leg) || nr.leg < 0 || nr.leg >= 6)) return false;
  }
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 3 || !e.every(Number.isFinite)
        || !Number.isInteger(e[0]) || !Number.isInteger(e[1])
        || e[0] < 0 || e[1] < 0 || e[0] >= neurons.length || e[1] >= neurons.length) return false;
  }
  return Array.from({ length: 6 }, (_, leg) => leg).every((leg) =>
    ['tibia_flexor', 'tibia_extensor', 'trochanter_flexor', 'trochanter_extensor'].every((channel) =>
      neurons.some((nr) => nr.leg === leg && nr.motorChannel === channel)));
}

// Channel order is shared with Locomotor.swift's motorChannelNames; the step
// loop indexes it instead of hashing the names on every simulated millisecond.
const MOTOR_CHANNELS = [
  'coxa_promotor', 'coxa_anterior_rotator', 'coxa_remotor', 'coxa_posterior_rotator',
  'trochanter_flexor', 'trochanter_extensor', 'tibia_flexor', 'tibia_extensor',
];
const ROLE_OTHER = 0, ROLE_MOTOR = 1, ROLE_SENSORY = 2, ROLE_DESCENDING = 3, ROLE_ASCENDING = 4;
const SENSE_LOAD = 0, SENSE_HAIR_PLATE = 1, SENSE_EXCURSION = 2;
const ROLE_CODES = { motor: ROLE_MOTOR, sensory: ROLE_SENSORY, descending: ROLE_DESCENDING, ascending: ROLE_ASCENDING, premotor: ROLE_OTHER };

export class LocomotorSim {
  constructor(circuit, parameters = {}) {
    this.parameters = { synapticGain: 2.4, baseline: 0.022, adaptationKick: 0.01, ...parameters };
    if (!validateLocomotorCircuit(circuit)) throw new Error('Invalid MaleCNS locomotor circuit');
    this.circuit = circuit;
    this.n = circuit.neurons.length;
    const n = this.n;
    for (const field of ['voltage', 'adaptation', 'rates', 'excitatory', 'inhibitory', 'nextExcitatory', 'nextInhibitory', 'drive', 'sensoryDrive']) {
      this[field] = new Float64Array(n);
    }
    this.refractory = new Int32Array(n);
    // The loops below run over ~1,000 neurons a thousand times a second, so
    // everything they touch is reduced to an integer index here at construction:
    // a Map hash, a string compare or a neuron-object property load inside them
    // costs more than the LIF arithmetic it guards. Mirrors Locomotor.swift.
    this.commandGroupIndex = new Map();
    this.commandGroupIds = [];
    this.motorChannelIds = Array.from({ length: 6 * MOTOR_CHANNELS.length }, () => []);
    this.roleCode = new Uint8Array(n);
    this.sensory = [];
    this.sensoryLeg = [];
    this.sensoryKind = [];
    this.commands = Array.from({ length: 6 }, makeLegMotorCommand);
    this.totalSpikes = 0; this.motorSpikes = 0; this.sensorySpikes = 0; this.simMs = 0;
    this.feedback = [];
    this.silencedFlag = new Uint8Array(n);
    this.anySilenced = false;
    this._silenced = new Set();
    this.synapsesEnabled = true;
    this.feedbackEnabled = true;
    const counts = new Int32Array(n), inputTotal = new Float64Array(n);
    for (const [pre, post, weight] of circuit.edges) {
      counts[pre]++; inputTotal[post] += Math.abs(weight);
    }
    this.rowStart = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) this.rowStart[i + 1] = this.rowStart[i] + counts[i];
    this.targets = new Int32Array(circuit.edges.length);
    this.weights = new Float64Array(circuit.edges.length);
    const fill = Int32Array.from(this.rowStart);
    for (const [pre, post, weight] of circuit.edges) {
      const slot = fill[pre]++;
      this.targets[slot] = post;
      // Keep relative counts and transmitter signs; counts are not conductance.
      this.weights[slot] = this.parameters.synapticGain * weight / Math.max(60, inputTotal[post]);
    }
    circuit.neurons.forEach((nr, i) => {
      this.roleCode[i] = ROLE_CODES[nr.role] ?? ROLE_OTHER;
      if (nr.role === 'descending') {
        const key = `${nr.type}:${nr.side}`;
        if (!this.commandGroupIndex.has(key)) {
          this.commandGroupIndex.set(key, this.commandGroupIds.length);
          this.commandGroupIds.push([]);
        }
        this.commandGroupIds[this.commandGroupIndex.get(key)].push(i);
      }
      if (nr.role === 'sensory' && nr.leg != null) {
        this.sensory.push(i);
        this.sensoryLeg.push(nr.leg);
        // Same three-way split the step loop used to spell out with string
        // compares; the pooling rationale is unchanged.
        this.sensoryKind.push(nr.sensoryKind === 'campaniform' || nr.sensoryKind === 'contact'
          ? SENSE_LOAD
          : nr.sensoryKind === 'hair_plate' ? SENSE_HAIR_PLATE : SENSE_EXCURSION);
      }
      if (nr.role === 'motor' && nr.leg != null && nr.motorChannel) {
        const slot = MOTOR_CHANNELS.indexOf(nr.motorChannel);
        if (slot >= 0) this.motorChannelIds[nr.leg * MOTOR_CHANNELS.length + slot].push(i);
      }
    });
  }

  // Lesions are diagnostic interventions, used to verify actual causal paths.
  // The Set stays the API; the hot loop reads the mirrored flags instead, so a
  // normal run costs one boolean check rather than a hash per neuron per ms.
  get silenced() { return this._silenced; }

  set silenced(value) {
    this._silenced = value instanceof Set ? value : new Set(value);
    this.anySilenced = this._silenced.size > 0;
    for (let i = 0; i < this.n; i++) this.silencedFlag[i] = this._silenced.has(i) ? 1 : 0;
  }

  setDescending(type, side, rate) {
    const group = this.descendingGroup(type, side);
    if (group >= 0) this.setDescendingGroup(group, rate);
  }

  // Index form of the above, for the caller that resolves its groups once.
  descendingGroup(type, side) {
    const group = this.commandGroupIndex.get(`${type}:${side}`);
    return group === undefined ? -1 : group;
  }

  setDescendingGroup(group, rate) {
    const value = Math.min(0.35, Math.max(0, rate) * 0.004);
    for (const i of this.commandGroupIds[group]) this.drive[i] = value;
  }

  indices(role, leg = null) {
    const code = ROLE_CODES[role];
    if (code === undefined) return [];
    const out = [];
    for (let i = 0; i < this.n; i++) {
      if (this.roleCode[i] === code && (leg === null || this.circuit.neurons[i].leg === leg)) out.push(i);
    }
    return out;
  }

  meanRate(role, leg = null) {
    const ids = this.indices(role, leg);
    return ids.reduce((sum, i) => sum + this.rates[i], 0) / Math.max(1, ids.length);
  }

  step(ms) {
    if (!(ms > 0)) return;
    for (let t = 0; t < ms; t++) {
      this.simMs++;
      for (const i of this.sensory) this.sensoryDrive[i] = 0;
      if (this.feedbackEnabled && this.feedback.length === 6) {
        for (let k = 0; k < this.sensory.length; k++) {
          const f = this.feedback[this.sensoryLeg[k]];
          const kind = this.sensoryKind[k];
          const value = kind === SENSE_LOAD
            ? (f.contact ? Math.min(1, f.load * 6) : 0)
            : kind === SENSE_HAIR_PLATE
              ? Math.min(1, Math.abs(f.hipAngle) / LegDynamics.hipLimit + Math.abs(f.elevationVelocity) / 20)
              : Math.min(1, Math.abs(f.kneeVelocity) / 20 + Math.abs(f.hipVelocity) / 16
              + Math.abs(f.kneeAngle - LegDynamics.restKnee) * 0.35);
          this.sensoryDrive[this.sensory[k]] = value * 0.10;
        }
      }
      for (let i = 0; i < this.n; i++) {
        this.excitatory[i] = this.excitatory[i] * 0.8187308 + this.nextExcitatory[i];
        this.inhibitory[i] = this.inhibitory[i] * 0.9048374 + this.nextInhibitory[i];
        this.nextExcitatory[i] = 0; this.nextInhibitory[i] = 0;
      }
      for (let i = 0; i < this.n; i++) {
        this.rates[i] *= 0.9048374;
        this.adaptation[i] *= 0.9950125;
        if (this.anySilenced && this.silencedFlag[i]) { this.voltage[i] = 0; this.rates[i] = 0; continue; }
        if (this.refractory[i] > 0) { this.refractory[i]--; continue; }
        this.voltage[i] = Math.max(-1, this.voltage[i] * 0.9512294 + this.excitatory[i] + this.inhibitory[i]
          + this.parameters.baseline + this.drive[i] + this.sensoryDrive[i] - this.adaptation[i]);
        if (this.voltage[i] >= 1) {
          this.voltage[i] = 0; this.refractory[i] = 2;
          this.adaptation[i] += this.parameters.adaptationKick;
          this.rates[i] += 95.16258;
          this.totalSpikes++;
          if (this.roleCode[i] === ROLE_MOTOR) this.motorSpikes++;
          else if (this.roleCode[i] === ROLE_SENSORY) this.sensorySpikes++;
          if (this.synapsesEnabled) {
            for (let e = this.rowStart[i]; e < this.rowStart[i + 1]; e++) {
              if (this.weights[e] >= 0) this.nextExcitatory[this.targets[e]] += this.weights[e];
              else this.nextInhibitory[this.targets[e]] += this.weights[e];
            }
          }
        }
      }
    }
    for (let leg = 0; leg < 6; leg++) {
      const base = leg * MOTOR_CHANNELS.length;
      const activity = (slot) => {
        const ids = this.motorChannelIds[base + slot];
        if (!ids.length) return 0;
        const rate = ids.reduce((sum, i) => sum + this.rates[i], 0) / ids.length;
        return rate / (rate + 50);
      };
      // Slots follow MOTOR_CHANNELS: promotor, anterior rotator, remotor,
      // posterior rotator, trochanter flexor/extensor, tibia flexor/extensor.
      this.commands[leg] = { protract: Math.max(activity(0), activity(1)),
        retract: Math.max(activity(2), activity(3)),
        lift: activity(4), depress: activity(5),
        flex: activity(6), extend: activity(7) };
    }
  }
}
