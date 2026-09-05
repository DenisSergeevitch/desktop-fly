# MaleCNS locomotor upgrade evaluation

Evaluated on macOS, 5 September 2026. This upgrade adds a measured neural graph
to a modeled closed loop: descending activity → interneurons → motor neurons →
articulated legs → contact and joint feedback. These checks establish working
software and causal responses within the model. They do not establish agreement
with recorded animal movement or recreate a whole fly nervous system.

## Data and anatomy

The bundled [MaleCNS v1.0](https://male-cns.janelia.org/download/) extract contains
1,045 neurons, 17,224 directed connections and 708,689 synaptic contacts. Its
roles are 16 descending, 622 premotor/interneurons, 220 motor, 153 sensory and
34 ascending neurons. All six legs have tibial and trochanteral antagonist
channels and anterior/posterior coxal rotators, assigned using explicit
anatomical annotations. The same graph is loaded on both platforms.

The extraction was reproduced byte for byte from the public tables. SHA-256:

```text
locomotor_circuit.json  8f76d94034dcf802453e3a0a8ed5342d122e57d37e2bb5ea28da66de0856f5d6
locomotor_report.json   453f2566bdb7652d9e17e2c8539c1b0f92b84f0db155f6f19738267ed337b358
```

No graph edge was invented. Raw contact counts, source hashes and transmitter
predictions are retained in [the circuit](data/locomotor_circuit.json); real
descending-to-motor paths and per-channel coverage are retained in the
[extraction report](data/locomotor_report.json). The
[provenance notes](data/LOCOMOTOR_PROVENANCE.md) explain their interpretation.
Across motor channels, this
bounded graph retains 20.9–44.8% of incoming contacts; 208 of 220 selected motor
neurons are reachable from selected descending neurons. Omitted inputs remain a
substantial limitation.

## Model changes and calibration

- The existing female FlyWire circuit supplies population activity by exact cell
  type and side to native male descending neurons. This is an explicitly modeled
  cross-specimen interface; the datasets do not provide those connecting synapses.
- MaleCNS neurons use a 1 ms LIF step with adaptation, refractory periods and
  separate excitatory/inhibitory current decay. Delivery is synchronous, so array
  order does not create extra within-step propagation. Swift Double and JavaScript
  Float64 state agree for the deterministic motor trials.
- Motor rates drive antagonistic torques at modeled hip yaw, elevation and knee
  joints. Foot geometry and unilateral ground contacts produce body displacement.
  Contact reaction loads and actual joint motion return as sensory input. No gait
  phase or target body velocity drives this active walking path.
- A complete sensing/neural/body/feedback tick runs at 120 Hz, independently of
  display refresh; mechanics use 1/600 s substeps in model time. Thermal tempo
  scales the elapsed time advanced by the active mechanics. Body displacement
  is transformed using the heading at the start of
  each step, before applying its yaw change.
- Shared knee torque, damping and restoring coefficients were calibrated to
  1140, 36 and 240 in model units, with additional coactivation stiffness. This
  allows stance flexion to occur before the leg unloads. The same coefficients
  apply to forward and backward conditions; direction does not select a second
  gait or sign-flip a prescribed velocity. These values are not measured muscle
  parameters. Named muscle-axis interpretation follows the
  [Azevedo et al. anatomical supplement](https://faculty.washington.edu/tuthill/docs/azevedo24_appendix.pdf).

## Causal checks

`./DesktopFly --locomotortest` exercises the bundled graph, actual mechanical
model and the application adapter. The JavaScript suite exercises the
corresponding production modules.

The neural trial's forward/backward displacement sums each step's longitudinal
motion in its local body frame; it is not net displacement in world coordinates.

| Check | Native model result |
|---|---|
| No descending drive, sensory feedback disabled | Zero motor spikes and zero drift |
| Bilateral DNp09 at 40 Hz, 8 s | All six motor pools respond; forward displacement 10.64 model units |
| Sustained stepping, measured after 3 s settling | Path length 60.55; contact onsets RF/LF/RM/LM/RH/LH: 20/22/19/11/16/14 |
| Remove all synapses | Zero motor spikes and no propulsion |
| Silence all motor neurons | No propulsion |
| Left/right DNa01+DNa02 perturbation after a shared 3 s prefix | Late yaw: baseline −1.248, left −0.661, right −1.459 rad |
| MDN at 70 Hz, 10 s, measured after 3 s | Backward displacement −12.66 model units |
| Close versus open sensory feedback | Motor spikes 12,868 versus 13,605; closed-loop sensory spikes 34,593 |
| Full coupled loop driven by 60 versus 120 Hz display updates | Identical contact counts and 12,868 motor spikes; displacement 10.643657 in both |
| Actual FlyWire → adapter → MaleCNS → rendered body → feedback chain | Sustained late movement and repeated contacts on every leg |
| Zero motor commands with nonzero legacy speed/turn signals | No body displacement or yaw |
| Rendered toe position versus physical feedback, unpowered fixture | Maximum error 0.00000289 model units |
| One active mechanics tick at thermal tempos 0.5, 1 and 2 | Zero joint error against the correspondingly advanced reference |

The complete application-chain check gates escape, grooming and arousal signals
to isolate walking. Its muscle commands still come from the actual neurons.
The steering check measures change relative to a common baseline because tonic
driving produces a baseline yaw bias. A straight, symmetric, quantitatively
accurate animal gait has not been established.

## Rendering and validation

Wing outlines now extend behind raised thoracic hinges. The fly has a wider
flight spread; the beetle retains its own spread. Filled fly wing geometry,
including its thickness, was checked against the head, thorax and
breathing-expanded abdomen at the folded pose, 101 raised poses and 201 flight
stroke positions, for both wings and both Euler rotation orders. Every sampled
pose cleared the body; the blur meshes also sit above the thorax. Native
top-down walking and flight snapshots and an oblique folded
snapshot were inspected after the change; the wing surfaces clear the body.
The beetle top-down snapshot was also inspected. The README fly preview was
refreshed from the motor-driven `--top --walking` render.

Required commands:

```sh
./build.sh
./DesktopFly --simtest
./DesktopFly --behaviortest
./DesktopFly --locomotortest
cd windows && npm test
```

The native build and all three native suites pass. `npm test` passes all three
JavaScript suites, including 18 locomotor checks. A workspace Electron 32.3.3 /
three.js 0.169.0 launch on macOS initialized WebGL, 668 FlyWire neurons, 1,045
MaleCNS neurons and the 120 Hz feedback clock. It continued environment polling
without a reported renderer error and was then stopped intentionally. This is
startup and polling coverage, not Windows desktop or visual verification.

The legacy suites originally used fresh system randomness: 100 baseline runs
produced 6 simtest failures and 17 behaviortest failures. Test fixtures now use
documented FNV-1a labels and LCG32 streams; normal application runs retain system
randomness. The forward-stimulation fixture suppresses competing grooming,
which could occupy nearly its entire stimulus window. Its stimulus and speed
thresholds remain unchanged, and the independent grooming response remains
covered. The initial upgrade's repeatability batch used identical seeds, so it measures test
reproducibility, not robustness across 100 different neural noise realizations.
That batch, before the transition follow-up below, completed with **0/100 failures in each of simtest,
behaviortest and locomotortest**. The simtest seed is `0x4305055b`; the locomotor
suite seed is `0x4d9a7e33`, with `0xfb2947cc` for the actual application-chain
fixture. Behavior scenarios use the unchanged test names as labels (the DNp09
fixture hashes to `0xa749f3a3`). The generator uses multiplier 1664525 and
increment 1013904223, modulo 2³². Whitespace validation with `git diff --check`
also passes.

## State-transition follow-up

The running app exposed gaps in the original steady-behavior checks. Switching
to grooming or flight changed the skeleton's rotation convention and reset its
knee/ankle pose. Returning to walking restored frozen mechanical joints. Flight,
nervous reactions and ledge reversals also assigned an arbitrary heading in one
tick. The first landing-flare tick changed pitch by as much as 0.593 rad (34°).

All controllers now use the same joint axes. Scripted state changes blend from
the current pose over 0.18 s and can be interrupted. On returning to motor
control, mechanics adopts the displayed joint angles and observed velocities,
clears stale support loads and resumes from there; the renderer directly uses
the resulting mechanics. Grounded scripted poses obey the same foot constraint.

Modeled threat, flight and ledge turns follow the shortest angle with bounded
angular speed and acceleration. Threat targets expire so they cannot keep
cancelling subsequent neural steering. Flight pitch approaches its target
continuously; wing spread and folding retain their progress across states. A
window dragged out from under the fly causes takeoff instead of clamping the
fly's position to the distant replacement edge.

Five additional cases exercise grooming/resume, sleep/wake, flight/landing,
nervous turning, and ledge reversal followed by a horizontal window drag. They
use the actual neural motor output and measure rendered joints, toe positions,
heading and pitch on every 120 Hz tick. They also require the intended state
sequence, so a fixture cannot pass by missing the transition. Before the fix,
all five failed: toe jumps reached 11.403 model units and heading jumps reached
π radians in one tick. Bounds are 0.35 rad per joint, 3 units per toe, 0.18 rad
heading and 0.08 rad pitch per tick; dragged support must cause takeoff with
less than 1 unit of displacement. These are software continuity bounds, not
measured animal-kinematics limits.

The complete native and JavaScript suites pass for this follow-up, including
all 18 locomotor checks. Native maxima after the fix are 1.031 units per toe,
0.120 rad per leg joint, 0.076 rad heading and 0.061 rad pitch per 120 Hz tick
across these fixtures. The dragged-support case takes off with zero position
jump. The
initial 100-run batches above did not include these five added cases. Native
top/oblique motion sequences are also inspected around grooming, waking and
landing; static screenshots alone cannot establish continuity between states.

## Remaining limits

Neural time constants, effective weights, sensory tuning, pooled motor
activation, joint forces and body scale are modeling choices. Unknown/modulatory
transmitters retain their anatomical edges with zero direct current. The graph
is incomplete and includes predicted neurotransmitter labels; connectivity
alone cannot determine physiology. Mean pooling also treats main and accessory
motor neurons equally within a muscle channel.

Grooming, flight, sleep and behavioral state selection still use the existing
modeled rules and animations. Extra ambient flies retain their lighter scripted
motion. The upgrade does not add measured wing aerodynamics, learning, social
behavior or a complete male CNS simulation. Live Win32 desktop sensing requires
validation on Windows; a renderer smoke run on macOS cannot validate those APIs.
