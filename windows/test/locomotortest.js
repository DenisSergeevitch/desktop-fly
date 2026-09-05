// Causal checks for the real MaleCNS graph and articulated body. Unlike the
// legacy behavior checks, every neural trial here enables the nerve cord.
import assert from 'node:assert/strict';
import { resetRandom } from './random.js';
import { loadBrainData } from '../src/data.js';
import { LocomotorSim, validateLocomotorCircuit } from '../src/locomotor.js';
import { SixLegDynamics, makeLegMotorCommand } from '../src/legdynamics.js';
import { Fly, makeSignals } from '../src/flymodel.js';
import { LIFSim, SimulationClock } from '../src/sim.js';
import { SignalBuilder } from '../src/signals.js';
import * as THREE from '../node_modules/three/build/three.module.js';

const data = loadBrainData();
assert(data?.locomotor, 'shipped MaleCNS dataset is required');
const geometries = new Fly({ x: 0, y: 0 }).model.legs.map((leg) => leg.geometry);
let failures = 0;
function check(name, run) {
  resetRandom(name);
  try { console.log(`PASS ${name}: ${run()}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}
const zeros = () => Array.from({ length: 6 }, makeLegMotorCommand);
const amplitude = (commands) => commands.flatMap(Object.values).reduce((sum, x) => sum + Math.abs(x), 0);

check('dataset validates and excludes invalid graph indices', () => {
  assert(validateLocomotorCircuit(data.locomotor));
  assert(!validateLocomotorCircuit({ ...data.locomotor, edges: [[data.locomotor.neurons.length, 0, 1]] }));
  return `${data.locomotor.neurons.length} neurons, ${data.locomotor.edges.length} observed edges`;
});

check('network silent without descending or sensory input', () => {
  const sim = new LocomotorSim(data.locomotor);
  sim.step(2000);
  assert.equal(sim.totalSpikes, 0);
  assert.equal(amplitude(sim.commands), 0);
  return 'zero spontaneous spikes and motor command';
});

check('descending recruitment requires synapses and motor neurons', () => {
  const active = new LocomotorSim(data.locomotor);
  const cut = new LocomotorSim(data.locomotor);
  const ablated = new LocomotorSim(data.locomotor);
  cut.synapsesEnabled = false;
  ablated.silenced = new Set(ablated.indices('motor'));
  for (const sim of [active, cut, ablated]) {
    for (const side of ['left', 'right']) sim.setDescending('DNp09', side, 70);
    sim.step(2000);
  }
  assert(active.motorSpikes > 0, 'DNp09 must recruit actual motor cells');
  assert.equal(cut.motorSpikes, 0);
  assert.equal(ablated.motorSpikes, 0);
  assert.equal(amplitude(cut.commands), 0);
  assert.equal(amplitude(ablated.commands), 0);
  return `motor spikes intact=${active.motorSpikes}, cut=${cut.motorSpikes}, ablated=${ablated.motorSpikes}`;
});

check('leg sensory feedback changes the actual neural network', () => {
  const active = new LocomotorSim(data.locomotor), cut = new LocomotorSim(data.locomotor);
  const feedback = new SixLegDynamics(geometries).feedback;
  feedback[0].kneeVelocity = 20;
  feedback[0].hipVelocity = 16;
  active.feedback = feedback; cut.feedback = feedback; cut.feedbackEnabled = false;
  active.step(1000); cut.step(1000);
  assert(active.sensorySpikes > 0);
  assert.equal(cut.sensorySpikes, 0);
  assert(active.meanRate('sensory', 0) > active.meanRate('sensory', 1));
  return `RF sensory spikes=${active.sensorySpikes}; no-feedback=${cut.sensorySpikes}`;
});

check('unpowered and airborne legs cannot propel the body', () => {
  const passive = new SixLegDynamics(geometries), airborne = new SixLegDynamics(geometries);
  const motors = zeros().map((c) => ({ ...c, retract: 1, depress: 1 }));
  let passiveDistance = 0, airborneDistance = 0;
  for (let i = 0; i < 120; i++) {
    const p = passive.advance(zeros(), 1 / 60);
    const a = airborne.advance(motors, 1 / 60, false);
    passiveDistance += Math.hypot(p.forward, p.lateral);
    airborneDistance += Math.hypot(a.forward, a.lateral);
  }
  assert(passiveDistance < 1e-8);
  assert.equal(airborneDistance, 0);
  assert(airborne.feedback.every((f) => !f.contact && f.load === 0));
  return 'zero ground translation for both controls';
});

check('motor mechanics provide sustained support strokes at 60 and 120 Hz', () => {
  // External test fixture isolates mechanics; the runtime has no commanded
  // gait phase. It is not evidence that the connectome generates this rhythm.
  function run(hz) {
    const body = new SixLegDynamics(geometries);
    let forward = 0, minHeight = 0;
    const transitions = Array(6).fill(0);
    let previous = body.feedback;
    for (let frame = 0; frame < 6 * hz; frame++) {
      const time = frame / hz;
      const commands = zeros().map((c, i) => {
        const swing = (time * 4 + [0, 0.5, 0.5, 0, 0, 0.5][i]) % 1 < 0.3;
        return { ...c, protract: swing ? 0.8 : 0, retract: swing ? 0 : 0.8,
          lift: swing ? 0.8 : 0, depress: swing ? 0 : 0.8,
          flex: swing ? 0 : 0.2, extend: swing ? 0.2 : 0 };
      });
      const motion = body.advance(commands, 1 / hz);
      if (time > 1) forward += motion.forward;
      const current = body.feedback;
      current.forEach((f, i) => {
        if (f.contact !== previous[i].contact) transitions[i]++;
        minHeight = Math.min(minHeight, f.footHeight);
        assert(Object.values(f).every((v) => typeof v === 'boolean' || Number.isFinite(v)));
      });
      previous = current;
    }
    assert(minHeight >= -1e-8);
    assert(transitions.every((n) => n > 10));
    assert(forward > 40);
    return forward;
  }
  const a = run(60), b = run(120);
  assert(Math.abs(a - b) / a < 0.15);
  return `late forward ${a.toFixed(1)} / ${b.toFixed(1)} units`;
});

check('active thermal wiring matches mechanics at 0.5, 1 and 2 times tempo', () => {
  for (const tempo of [0.5, 1, 2]) {
    resetRandom('thermal mechanics reference');
    const fly = new Fly({ x: 0, y: 0 });
    fly.state = 'walking'; fly.speed = 0; fly.heading = 0;
    const reference = new SixLegDynamics(fly.model.legs.map((leg) => leg.geometry));
    const signals = makeSignals(); signals.walkDrive = 1; signals.tempo = tempo;
    signals.legCommands = zeros().map((c) => ({ ...c, retract: 0.6, depress: 0.4 }));
    // A controller handoff clears support history and converts pose velocities
    // to motor time before either independent integration begins.
    reference.adoptPose(fly.legFeedback, true, 1 / tempo);
    const expected = reference.advance(signals.legCommands, SimulationClock.fixedDT * tempo);
    fly.update(SimulationClock.fixedDT, { width: 1512, height: 982 }, null, signals);
    assert.deepEqual(fly.legDynamics.feedback, reference.feedback);
    assert(Math.abs(fly.pos.x - expected.forward) < 1e-9);
    assert(Math.abs(fly.pos.y + expected.lateral) < 1e-9);
    assert(Math.abs(fly.heading - expected.yaw) < 1e-9);
  }
  return 'all three active signal paths match independent joint and body integration';
});

check('thermal tempo changes active motor-driven joint kinetics', () => {
  function run(tempo) {
    resetRandom('thermal motor fixture');
    const fly = new Fly({ x: 0, y: 0 });
    fly.state = 'walking'; fly.speed = 0; fly.heading = 0;
    const signals = makeSignals(); signals.walkDrive = 1; signals.tempo = tempo;
    signals.legCommands = zeros().map((c) => ({ ...c, retract: 0.6, depress: 0.4 }));
    fly.update(SimulationClock.fixedDT, { width: 1512, height: 982 }, null, signals);
    return Math.abs(fly.legDynamics.feedback[0].hipAngle);
  }
  const cool = run(0.5), warm = run(2);
  assert(cool > 0 && warm > cool * 2);
  return `same motor input: joint excursion ${cool.toFixed(4)} / ${warm.toFixed(4)} rad`;
});

check('rendered toes match mechanics and scalar speed cannot bypass silent motors', () => {
  const fly = new Fly({ x: 0, y: 0 });
  fly.state = 'walking'; fly.speed = 70; fly.heading = 0; fly.dartCooldown = 100;
  const signals = makeSignals(); signals.walkDrive = 1; signals.turnBias = 1; signals.legCommands = zeros();
  fly.update(1 / 60, { width: 1512, height: 982 }, null, signals);
  assert(Math.hypot(fly.pos.x, fly.pos.y) < 1e-8);
  assert(Math.abs(fly.heading) < 1e-8);
  fly.node.updateMatrixWorld(true);
  let maxError = 0;
  fly.model.legs.forEach((leg, i) => {
    const toe = new THREE.Vector3(leg.geometry.tarsus, 0, 0);
    leg.ankle.localToWorld(toe); fly.node.worldToLocal(toe);
    const f = fly.legDynamics.feedback[i];
    maxError = Math.max(maxError, Math.hypot(toe.x - f.footX, toe.y - f.footY, toe.z - f.footHeight));
  });
  assert(maxError < 1e-6);
  return `toe geometry max error ${maxError.toExponential(1)}, translation=0`;
});

function cordTrial(kind, displayHz = 60) {
  const sim = new LocomotorSim(data.locomotor), body = new SixLegDynamics(geometries);
  const clock = new SimulationClock();
  for (const side of ['left', 'right']) {
    sim.setDescending('DNp09', side, kind === 'backward' ? 0 : 30);
    if (kind === 'backward') sim.setDescending('MDN', side, 70);
  }
  let forward = 0, yaw = 0, ticks = 0, neuralMs = 0;
  for (let frame = 0; frame < displayHz * 10; frame++) {
    clock.advance(1 / displayHz, (dt) => {
      if (ticks === 360 && ['left', 'right'].includes(kind)) {
        sim.setDescending('DNa01', kind, 70);
        sim.setDescending('DNa02', kind, 70);
      }
      sim.feedback = body.feedback;
      neuralMs += dt * 1000;
      const steps = Math.floor(neuralMs); neuralMs -= steps;
      sim.step(steps);
      const movement = body.advance(sim.commands, dt);
      if (ticks >= 360) { forward += movement.forward; yaw += movement.yaw; }
      ticks++;
    });
  }
  return { forward, yaw, ticks, simMs: sim.simMs, feedback: body.feedback };
}

check('complete neural and body feedback loop is independent of display refresh', () => {
  const at60 = cordTrial('forward', 60), at120 = cordTrial('forward', 120);
  assert.deepEqual(at60, at120);
  assert.equal(at60.ticks, 1200);
  assert.equal(at60.simMs, 10000);
  return '60 Hz and 120 Hz render schedules produce identical neurons, joints, displacement and yaw';
});

check('left and right descending perturbations steer through motor mechanics', () => {
  // All three runs share an identical 3 s prefix. Compare the intervention
  // with its control: the reduced network has a documented tonic turn bias.
  const baseline = cordTrial('forward'), left = cordTrial('left'), right = cordTrial('right');
  const leftEffect = left.yaw - baseline.yaw, rightEffect = right.yaw - baseline.yaw;
  assert(leftEffect > 0.1 && rightEffect < -0.1,
    `left effect=${leftEffect.toFixed(3)}, right effect=${rightEffect.toFixed(3)} rad`);
  return `yaw baseline=${baseline.yaw.toFixed(2)}, left effect=${leftEffect.toFixed(2)}, right effect=${rightEffect.toFixed(2)} rad`;
});

check('MDN alone produces sustained physical backward motion', () => {
  const result = cordTrial('backward');
  assert(result.forward < -5, `late displacement=${result.forward.toFixed(2)} units (must be backward)`);
  return `late displacement=${result.forward.toFixed(2)} units`;
});

check('complete brain to motor to body loop sustains walking after startup', () => {
  const sim = new LIFSim(data.circuit, null, data.locomotor), builder = new SignalBuilder();
  const fly = new Fly({ x: 0, y: 0 });
  fly.state = 'walking'; fly.speed = 0; fly.heading = 0;
  // Stimulation isolates the forward pathway while suppressing unrelated
  // escape/groom decisions; motor commands remain exclusively neural outputs.
  sim.stimulate(sim.fwd, 0.15, 10000);
  let lateDistance = 0;
  const transitions = Array(6).fill(0);
  let old = fly.legFeedback;
  const clock = new SimulationClock();
  let ticks = 0, neuralMs = 0;
  for (let frame = 0; frame < 600; frame++) {
    clock.advance(1 / 60, (dt) => {
      sim.legFeedback = fly.legFeedback;
      neuralMs += dt * 1000;
      const steps = Math.floor(neuralMs); neuralMs -= steps;
      sim.step(steps);
      const signals = builder.make(sim, dt);
      signals.escape = false; signals.groomDrive = 0; signals.nervous = 0; signals.arousal = 0;
      const position = { ...fly.pos };
      fly.update(dt, { width: 1512, height: 982 }, null, signals);
      if (ticks >= 360) {
        lateDistance += Math.hypot(fly.pos.x - position.x, fly.pos.y - position.y);
        fly.legFeedback.forEach((f, i) => { if (f.contact !== old[i].contact) transitions[i]++; });
      }
      old = fly.legFeedback;
      ticks++;
    });
  }
  const detail = `late path=${lateDistance.toFixed(2)} units, contacts=${transitions.join('/')}`;
  assert(lateDistance > 20 && transitions.every((n) => n >= 4), detail);
  return detail;
});

function transitionCheck(kind, phases, expected) {
  check(`active pose continuity: ${kind}`, () => {
    const sim = new LIFSim(data.circuit, null, data.locomotor), builder = new SignalBuilder();
    const fly = new Fly({ x: 0, y: 0 });
    fly.state = 'walking'; fly.speed = 0; fly.heading = 0;
    const bounds = { width: 1512, height: 982 }, dt = SimulationClock.fixedDT;
    sim.stimulate(sim.fwd, 0.15, 20000);
    let frame = 0;
    function signals() {
      sim.legFeedback = fly.legFeedback;
      sim.step(frame % 3 === 2 ? 9 : 8);
      frame++;
      const s = builder.make(sim, dt);
      s.escape = false; s.nervous = 0; s.arousal = 0;
      s.groomDrive = 0; s.walkDrive = 1; s.backward = false;
      return s;
    }
    for (let i = 0; i < 360; i++) fly.update(dt, bounds, null, signals());
    // Spontaneous flight can occur despite low arousal. Let it finish before
    // testing a walking handoff, and assert the scenario really starts walking.
    for (let i = 0; i < 1200 && fly.state !== 'walking'; i++) {
      fly.update(dt, bounds, null, signals());
    }
    assert.equal(fly.state, 'walking', 'motor warmup must finish walking');
    if (kind === 'ledge endpoint') {
      const edge = { y: 0, x0: -40, x1: 40, id: 42 };
      fly.terrain = [edge]; fly.ledge = edge;
      fly.pos = { x: 39, y: 0 }; fly.heading = 0; fly.syncNode();
    }
    function pose() {
      fly.node.updateMatrixWorld(true);
      return {
        joints: fly.model.legs.flatMap((leg) =>
          [leg.root, leg.knee, leg.ankle].map((node) => node.quaternion.clone())),
        toes: fly.model.legs.map((leg) => fly.node.worldToLocal(
          leg.ankle.localToWorld(new THREE.Vector3(leg.geometry.tarsus, 0, 0)))),
        heading: fly.heading, pitch: fly.pitch,
      };
    }
    let previous = pose(), jointJump = 0, toeJump = 0, headingJump = 0, pitchJump = 0, tick = 0;
    const states = [fly.state];
    let endpointReversed = kind !== 'ledge endpoint', movedSupportTakeoff = kind !== 'ledge endpoint';
    let supportShift = 0;
    for (const [ticks, walk, groom, sleep] of phases) {
      for (let i = 0; i < ticks; i++) {
        const s = signals(); s.walkDrive = walk; s.groomDrive = groom; s.sleep = sleep;
        let mouse = null;
        if (tick === 0 && ['flight and landing', 'nervous turn'].includes(kind)) {
          mouse = { x: fly.pos.x + 180 * Math.cos(fly.heading),
            y: fly.pos.y + 180 * Math.sin(fly.heading) };
          s.escape = kind === 'flight and landing';
          s.nervous = kind === 'nervous turn' ? 0.9 : 0;
        }
        if (kind === 'ledge endpoint' && tick === 60) {
          endpointReversed = fly.state === 'walking'
            && Math.abs(Math.atan2(Math.sin(fly.heading), Math.cos(fly.heading))) > 0.5;
          // Move an attached support without changing its height. The fly must
          // leave it, never clamp its x position onto the dragged window.
          fly.ledge = { y: 0, x0: -40, x1: 40, id: 42 };
          fly.terrain = [{ y: 0, x0: 360, x1: 440, id: 42 }];
        }
        const oldPosition = { ...fly.pos };
        fly.update(dt, bounds, mouse, s);
        if (kind === 'ledge endpoint' && tick === 60) {
          supportShift = Math.hypot(fly.pos.x - oldPosition.x, fly.pos.y - oldPosition.y);
          movedSupportTakeoff = fly.state === 'flying' && supportShift < 1;
        }
        const next = pose();
        previous.joints.forEach((q, j) => { jointJump = Math.max(jointJump, q.angleTo(next.joints[j])); });
        previous.toes.forEach((p, j) => { toeJump = Math.max(toeJump, p.distanceTo(next.toes[j])); });
        headingJump = Math.max(headingJump, Math.abs(Math.atan2(
          Math.sin(next.heading - previous.heading), Math.cos(next.heading - previous.heading))));
        pitchJump = Math.max(pitchJump, Math.abs(next.pitch - previous.pitch));
        if (states.at(-1) !== fly.state) states.push(fly.state);
        previous = next; tick++;
      }
    }
    let reached = 0;
    for (const state of states) if (state === expected[reached]) reached++;
    const supportDetail = kind === 'ledge endpoint'
      ? `; endpoint reversed ${endpointReversed}, moved support takeoff ${movedSupportTakeoff}, position delta ${supportShift.toFixed(3)}` : '';
    const detail = `joint ${jointJump.toFixed(3)} rad, toe ${toeJump.toFixed(3)} units, `
      + `heading ${headingJump.toFixed(3)} rad, pitch ${pitchJump.toFixed(3)} rad per tick; states ${states.join(' -> ')}`
      + supportDetail;
    assert(reached === expected.length && endpointReversed && movedSupportTakeoff
      && jointJump < 0.35 && toeJump < 3 && headingJump < 0.18 && pitchJump < 0.08, detail);
    return detail;
  });
}

transitionCheck('groom and resume', [[120, 0, 1, false], [240, 1, 0, false]],
  ['walking', 'grooming', 'idle', 'walking']);
transitionCheck('idle sleep and wake', [[120, 0, 0, false], [120, 0, 0, true], [240, 1, 0, false]],
  ['walking', 'idle', 'sleeping', 'grooming', 'idle', 'walking']);
transitionCheck('flight and landing', [[480, 0, 0, false], [180, 1, 0, false]],
  ['walking', 'flying', 'idle', 'walking']);
transitionCheck('nervous turn', [[120, 1, 0, false]], ['walking']);
transitionCheck('ledge endpoint', [[120, 1, 0, false]], ['walking', 'flying']);

if (failures) process.exitCode = 1;
else console.log('ALL LOCOMOTOR TESTS PASS');
