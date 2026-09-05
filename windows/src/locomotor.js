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
    this.commandGroups = new Map();
    this.motorGroups = Array.from({ length: 6 }, () => new Map());
    this.sensory = [];
    this.commands = Array.from({ length: 6 }, makeLegMotorCommand);
    this.totalSpikes = 0; this.motorSpikes = 0; this.sensorySpikes = 0; this.simMs = 0;
    this.feedback = [];
    this.silenced = new Set();
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
    function append(map, key, i) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(i);
    }
    circuit.neurons.forEach((nr, i) => {
      if (nr.role === 'descending') append(this.commandGroups, `${nr.type}:${nr.side}`, i);
      if (nr.role === 'sensory' && nr.leg != null) this.sensory.push(i);
      if (nr.role === 'motor' && nr.leg != null && nr.motorChannel) append(this.motorGroups[nr.leg], nr.motorChannel, i);
    });
  }

  setDescending(type, side, rate) {
    for (const i of this.commandGroups.get(`${type}:${side}`) || []) {
      this.drive[i] = Math.min(0.35, Math.max(0, rate) * 0.004);
    }
  }

  indices(role, leg = null) {
    return this.circuit.neurons.map((nr, i) => i).filter((i) =>
      this.circuit.neurons[i].role === role && (leg === null || this.circuit.neurons[i].leg === leg));
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
        for (const i of this.sensory) {
          const nr = this.circuit.neurons[i], f = this.feedback[nr.leg];
          const value = nr.sensoryKind === 'campaniform' || nr.sensoryKind === 'contact'
            ? (f.contact ? Math.min(1, f.load * 6) : 0)
            : nr.sensoryKind === 'hair_plate'
              ? Math.min(1, Math.abs(f.hipAngle) / LegDynamics.hipLimit + Math.abs(f.elevationVelocity) / 20)
              : Math.min(1, Math.abs(f.kneeVelocity) / 20 + Math.abs(f.hipVelocity) / 16
              + Math.abs(f.kneeAngle - LegDynamics.restKnee) * 0.35);
          this.sensoryDrive[i] = value * 0.10;
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
        if (this.silenced.has(i)) { this.voltage[i] = 0; this.rates[i] = 0; continue; }
        if (this.refractory[i] > 0) { this.refractory[i]--; continue; }
        this.voltage[i] = Math.max(-1, this.voltage[i] * 0.9512294 + this.excitatory[i] + this.inhibitory[i]
          + this.parameters.baseline + this.drive[i] + this.sensoryDrive[i] - this.adaptation[i]);
        if (this.voltage[i] >= 1) {
          this.voltage[i] = 0; this.refractory[i] = 2;
          this.adaptation[i] += this.parameters.adaptationKick;
          this.rates[i] += 95.16258;
          this.totalSpikes++;
          if (this.circuit.neurons[i].role === 'motor') this.motorSpikes++;
          if (this.circuit.neurons[i].role === 'sensory') this.sensorySpikes++;
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
      const activity = (channel) => {
        const ids = this.motorGroups[leg].get(channel) || [];
        const rate = ids.reduce((sum, i) => sum + this.rates[i], 0) / Math.max(1, ids.length);
        return rate / (rate + 50);
      };
      this.commands[leg] = { protract: Math.max(activity('coxa_promotor'), activity('coxa_anterior_rotator')),
        retract: Math.max(activity('coxa_remotor'), activity('coxa_posterior_rotator')),
        lift: activity('trochanter_flexor'), depress: activity('trochanter_extensor'),
        flex: activity('tibia_flexor'), extend: activity('tibia_extensor') };
    }
  }
}
