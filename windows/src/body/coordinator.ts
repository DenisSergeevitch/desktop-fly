// body/coordinator.ts — the render-loop hub, from main.swift:485-689.
//
// This is the one place the body<->brain loop closes. Read it top to bottom
// before changing any sense or signal:
//
//   1. senses -> sim inputs   (loom, air puff, gait proprioception, neuromod)
//   2. fixed 1 kHz stepping   (SimClock, clamped to 50 ms/frame)
//   3. rates -> commands      (SignalBuilder, shared with the diagnostic CLIs)
//   4. commands -> body       (fly #1 gets signals; the rest get null)
//
// It deliberately imports no Electron and constructs no WebGLRenderer, so the
// whole chain above is unit-testable headless. The renderer owns only the canvas
// and the IPC bridge.

import * as THREE from 'three';
import { Fly, type Bounds, type Point } from './fly.ts';
import { LIFSim } from '../core/sim.ts';
import { SignalBuilder } from '../core/signals.ts';
import { LoomTransducer } from '../core/loom.ts';
import { SimClock } from '../core/simclock.ts';
import { clampf } from '../core/mathutil.ts';
import type { BrainSignals, Ledge } from '../core/types.ts';
import type { Arena } from '../core/arena.ts';

export interface Senses {
  cursor: Point | null;
  ledges: Ledge[];
  newWindows: Array<{ center: Point; size: number }>;
  taps: Point[];
  typing: number;
  sleepy: boolean;
  tempo: number;
  activity: number;
}

export interface CoordinatorOptions {
  bounds: Bounds;
  sim: LIFSim | null;
  scene?: THREE.Scene;
  seed?: number;
  arena?: Arena;
}

const MAX_DT = 0.05;   // main.swift:649 — a frame hitch must not teleport the fly

// main.swift:17-67. Orthographic camera looking down -Z at the XY plane, so
// scene x/y map to screen x/y and node.position.z is height above the desktop.
export function buildScene(bounds: Bounds): THREE.Scene {
  const scene = new THREE.Scene();

  const camera = new THREE.OrthographicCamera(
    -bounds.width / 2, bounds.width / 2,
    bounds.height / 2, -bounds.height / 2,
    1, 600);
  camera.position.set(0, 0, 300);
  camera.name = 'camera';
  scene.add(camera);

  // intensities mirror SceneKit's 1000 key / 550 ambient (main.swift:33-49)
  const key = new THREE.DirectionalLight(0xffffff, 1.0);
  key.position.set(0, 0, 300);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  // SceneKit orients the light by euler angles; the same tilt here
  key.rotation.set(-0.35, 0.30, 0);
  scene.add(key);

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);

  // Shadow catcher: SceneKit uses a plane with colorBufferWriteMask = [] that
  // still writes depth; ShadowMaterial is the Three.js equivalent — it renders
  // only the received shadow, leaving the rest of the plane transparent.
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(6000, 6000),
    new THREE.ShadowMaterial({ opacity: 0.30 }));
  plane.position.set(0, 0, -0.6);
  plane.receiveShadow = true;
  scene.add(plane);

  return scene;
}

export class Coordinator {
  readonly scene: THREE.Scene;
  readonly flies: Fly[] = [];
  readonly sim: LIFSim | null;
  bounds: Bounds;

  private pending: Array<(c: Coordinator) => void> = [];
  private readonly signalBuilder = new SignalBuilder();
  private readonly loom = new LoomTransducer();
  private readonly clock = new SimClock();
  private readonly seed: number | undefined;
  private arena: Arena | null = null;
  private flyCount = 0;

  // senses, written from outside and read in the frame loop
  private cursor: Point | null = null;
  private terrain: Ledge[] = [];
  private typingLevel = 0;
  private sleepy = false;
  private tempo = 1;
  private activity = 1;
  private windowLoomL = 0;
  private windowLoomR = 0;
  private loomOverride = 0;
  private lastFlyPos: Point = { x: 0, y: 0 };
  private isPaused = false;

  constructor(opts: CoordinatorOptions) {
    this.bounds = opts.bounds;
    this.sim = opts.sim;
    this.seed = opts.seed;
    this.scene = opts.scene ?? buildScene(opts.bounds);
    this.arena = opts.arena ?? null;
    this.addFlyNow();
  }

  enqueue(action: (c: Coordinator) => void): void {
    this.pending.push(action);
  }

  private nextSeed(): number | undefined {
    if (this.seed === undefined) return undefined;
    this.flyCount += 1;
    return this.seed + this.flyCount * 7919;   // distinct but reproducible
  }

  private addFlyNow(): void {
    const hw = this.bounds.width / 2 - 100;
    const hh = this.bounds.height / 2 - 100;
    const seed = this.nextSeed();
    let at = this.flies.length === 0
      ? { x: 0, y: 0 }
      : { x: (Math.random() * 2 - 1) * hw, y: (Math.random() * 2 - 1) * hh };
    // With an arena, the scene origin can itself be in the gap between monitors,
    // so even fly #1 has to be placed onto a real display.
    if (this.arena !== null) at = this.arena.clamp(at.x, at.y, 60);
    const fly = new Fly(at, seed);
    fly.arena = this.arena;
    this.flies.push(fly);
    this.scene.add(fly.node);
  }

  // The display layout changed: new bounding box and new covered region.
  setArena(arena: Arena): void {
    this.enqueue((c) => {
      c.arena = arena;
      for (const fly of c.flies) {
        fly.arena = arena;
        const p = arena.clamp(fly.pos.x, fly.pos.y, 40);
        fly.pos.x = p.x;
        fly.pos.y = p.y;
      }
    });
  }

  addFly(): void {
    this.enqueue((c) => c.addFlyNow());
  }

  removeFly(): void {
    this.enqueue((c) => {
      if (c.flies.length <= 1) return;   // fly #1 carries the brain
      const gone = c.flies.pop()!;
      c.scene.remove(gone.node);
    });
  }

  scareAll(): void {
    this.enqueue((c) => {
      c.loomOverride = 0.6;   // a real stimulus into the real circuit for fly #1
      for (const fly of c.flies.slice(1)) {
        if (fly.state !== 'flying') fly.startFlight({ bounds: c.bounds });
      }
    });
  }

  escapeTest(): void {
    this.enqueue((c) => { c.loomOverride = 0.6; });
  }

  get paused(): boolean {
    return this.isPaused;
  }

  // main.swift:856-861. Pausing stops the sim and the body; RESUMING must also
  // reset the clock, or the first frame back carries the whole pause as one dt.
  // The 50 ms frame clamp is not sufficient on its own — 50 ms of catch-up is
  // still a visible jump, and the accumulated fraction would drain over the
  // following frames.
  setPaused(paused: boolean): void {
    this.enqueue((c) => {
      if (c.isPaused === paused) return;
      c.isPaused = paused;
      if (!paused) {
        c.clock.reset();
        c.loom.reset();
      }
    });
  }

  setSenses(s: Partial<Senses>): void {
    if (s.cursor !== undefined) this.cursor = s.cursor;
    if (s.typing !== undefined) this.typingLevel = s.typing;
    if (s.sleepy !== undefined) this.sleepy = s.sleepy;
    if (s.tempo !== undefined) this.tempo = s.tempo;
    if (s.activity !== undefined) this.activity = s.activity;
    if (s.ledges !== undefined) {
      const ledges = s.ledges;
      this.enqueue((c) => { c.terrain = ledges; });
    }
    if (s.newWindows !== undefined) {
      const wins = s.newWindows;
      this.enqueue((c) => {
        for (const w of wins) c.injectWindowLoom(w.center, w.size);
      });
    }
    if (s.taps !== undefined) {
      const taps = s.taps;
      this.enqueue((c) => {
        for (const t of taps) c.injectTap(t);
      });
    }
  }

  // main.swift:578-589 — a window appeared near the fly: a real looming object
  private injectWindowLoom(at: Point, _size: number): void {
    const fly = this.flies[0];
    if (fly === undefined) return;
    const d = Math.hypot(at.x - this.lastFlyPos.x, at.y - this.lastFlyPos.y);
    const strength = clampf(1 - d / 480, 0, 1) * 0.75;
    if (strength <= 0.08) return;
    const relX = at.x - fly.pos.x;
    const relY = at.y - fly.pos.y;
    const dist = Math.max(1, Math.hypot(relX, relY));
    const fx = Math.cos(fly.heading);
    const fy = Math.sin(fly.heading);
    const crossZ = (fx * relY - fy * relX) / dist;
    this.windowLoomL = Math.max(this.windowLoomL,
      strength * clampf(0.5 + 0.5 * crossZ, 0.12, 1));
    this.windowLoomR = Math.max(this.windowLoomR,
      strength * clampf(0.5 - 0.5 * crossZ, 0.12, 1));
  }

  // main.swift:591-600 — a click is a tap on the fly's substrate
  private injectTap(at: Point): void {
    const fly = this.flies[0];
    if (this.sim === null || fly === undefined) return;
    const d = Math.hypot(at.x - fly.pos.x, at.y - fly.pos.y);
    const strength = clampf(1 - d / 520, 0, 1);
    if (strength > 0.05) {
      this.sim.stimulate(this.sim.sens, 0.15 + strength * 0.35, 130);
    }
  }

  // main.swift:556-570 — the fly moved to a different display
  retarget(bounds: Bounds): void {
    this.enqueue((c) => {
      c.bounds = bounds;
      c.terrain = [];   // stale until the next window poll
      const cam = c.scene.getObjectByName('camera');
      if (cam instanceof THREE.OrthographicCamera) {
        cam.left = -bounds.width / 2;
        cam.right = bounds.width / 2;
        cam.top = bounds.height / 2;
        cam.bottom = -bounds.height / 2;
        cam.updateProjectionMatrix();
      }
      // keep flies inside the new display
      for (const fly of c.flies) {
        fly.ledge = null;
        fly.pos.x = clampf(fly.pos.x, -bounds.width / 2 + 40, bounds.width / 2 - 40);
        fly.pos.y = clampf(fly.pos.y, -bounds.height / 2 + 40, bounds.height / 2 - 40);
      }
    });
  }

  flyPosition(): Point {
    return { x: this.lastFlyPos.x, y: this.lastFlyPos.y };
  }

  // main.swift:632-688
  frame(rawDt: number): void {
    const actions = this.pending;
    this.pending = [];
    for (const a of actions) a(this);

    // Paused: pending mutations still land (so unpausing works) but neither the
    // sim nor the body advances.
    if (this.isPaused) return;

    // The clamp lives here rather than in the renderer (main.swift:649) so it
    // is covered by tests; the renderer passes its raw frame delta.
    const dt = Math.min(MAX_DT, Math.max(0, rawDt));
    if (dt === 0) return;

    let signals: BrainSignals | null = null;
    const first = this.flies[0];
    if (this.sim !== null && first !== undefined) {
      const sim = this.sim;
      const sensory = this.loom.compute(first.pos, first.heading, this.cursor, dt,
        this.loomOverride);
      const decay = Math.exp(-4 * dt);
      this.windowLoomL *= decay;
      this.windowLoomR *= decay;
      sim.loomL = Math.max(sensory.l, this.windowLoomL);
      sim.loomR = Math.max(sensory.r, this.windowLoomR);
      sim.airPuff = Math.max(sensory.puff, this.typingLevel * 0.30);
      // body -> brain: leg proprioception from the current gait
      sim.gaitDrive = first.walkingIntensity;
      sim.gaitPhase = first.gaitPhasePublic;
      // Circadian + sleep neuromodulation, compressed: the LIF neurons sit just
      // below threshold, so a raw multiplier silences them entirely — siesta
      // should mean "less active", not comatose.
      sim.activityScale = (1 - (1 - this.activity) * 0.35) * (this.sleepy ? 0.75 : 1);
      sim.sensoryGate = this.sleepy ? 0.55 : 1;
      this.loomOverride = Math.max(0, this.loomOverride - dt * 1.2);
      sim.step(this.clock.advance(dt));

      const s = this.signalBuilder.make(sim, dt);
      s.tempo = this.tempo;
      s.sleep = this.sleepy;
      signals = s;
    }

    for (let i = 0; i < this.flies.length; i++) {
      const fly = this.flies[i];
      fly.terrain = this.terrain;
      fly.update(dt, this.bounds, this.cursor, i === 0 ? signals : null);
    }
    if (first !== undefined) {
      this.lastFlyPos = { x: first.pos.x, y: first.pos.y };
    }
  }

  // the renderer resets this after a machine sleep/resume
  resetClock(): void {
    this.clock.reset();
    this.loom.reset();
  }
}
