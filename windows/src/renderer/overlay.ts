// renderer/overlay.ts — the only place a WebGLRenderer exists.
//
// This process is the SceneKit render thread's counterpart: it steps the sim and
// updates the flies inside requestAnimationFrame, exactly as
// Coordinator.renderer(_:updateAtTime:) does on macOS. All the logic lives in
// body/coordinator.ts, which is why that file is testable headless.

import * as THREE from 'three';
import { Coordinator, type Senses } from '../body/coordinator.ts';
import { Arena, type SceneRect } from '../core/arena.ts';
import { LIFSim, SpikeBus } from '../core/sim.ts';
import type { CircuitFile } from '../core/data.ts';

interface ArenaMessage {
  box: { width: number; height: number };
  rects: SceneRect[];
}

interface DesktopFlyBridge {
  getCircuit(): Promise<CircuitFile | null>;
  getArena(): Promise<ArenaMessage>;
  onArena(cb: (a: ArenaMessage) => void): void;
  onSenses(cb: (s: Partial<Senses>) => void): void;
  sendSpikes(batch: Array<{ neuron: number; isGF: boolean }>): void;
  onStimulate(cb: (r: { indices: number[]; strength: number;
    durationMs: number }) => void): void;
  onCommand(cb: (c: string) => void): void;
}

declare global {
  interface Window {
    desktopfly: DesktopFlyBridge;
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  let bounds = { width: window.innerWidth, height: window.innerHeight };

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,          // keep the framebuffer transparent
    antialias: true,
  });
  renderer.setClearColor(0x000000, 0);   // fully transparent clear
  renderer.setPixelRatio(window.devicePixelRatio);
  // updateStyle MUST stay on (the default). With it suppressed the canvas has
  // no CSS size, so it lays out at its drawing-buffer size — devicePixelRatio
  // times too large — and scene coordinates stop matching screen pixels: the fly
  // then walks out of view long before reaching its scene bounds.
  renderer.setSize(bounds.width, bounds.height);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoft is deprecated

  // main reads data/ and sends it here: this process has no filesystem access,
  // and file:// blocks fetch()
  const circuit = await window.desktopfly.getCircuit();
  // The spike bus feeds the brain window. The sim stays HERE so the LC->GF
  // escape race never crosses a process boundary.
  const spikeBus = circuit === null ? null : new SpikeBus();
  const sim = circuit === null ? null : new LIFSim(circuit, spikeBus);
  if (sim === null) console.warn('no data/ — running the legacy behavior path');

  const coordinator = new Coordinator({ bounds, sim });
  console.log(`overlay ready: ${bounds.width}x${bounds.height}, `
    + `sim=${sim === null ? 'none' : `${sim.n} neurons`}`);
  // Guard the scene->pixel mapping: the canvas must occupy exactly the window in
  // CSS pixels. If these ever diverge, the fly drifts off screen. Re-checked
  // after every arena change, since that is when the window is resized.
  function checkCanvasFitsWindow(): void {
    if (canvas.clientWidth !== window.innerWidth
        || canvas.clientHeight !== window.innerHeight) {
      console.error(`canvas/window mismatch: canvas is `
        + `${canvas.clientWidth}x${canvas.clientHeight} CSS px in a `
        + `${window.innerWidth}x${window.innerHeight} window — the fly will `
        + 'appear to leave the screen');
    }
  }
  const camera = coordinator.scene.getObjectByName('camera') as THREE.Camera;

  // The overlay spans every display. The window is the rectangular bounding box;
  // the Arena is the union of the real monitor rectangles, so the fly cannot walk
  // into the gap between two differently sized or offset screens.
  function applyArena(a: ArenaMessage): void {
    // Size the canvas AND the camera from the window, not from the arena box.
    // With fractional per-monitor scaling the two differ by a pixel — a 1545 DIP
    // box is 2317.5 physical px at 150%, so the window rounds to 1546 DIP — and
    // driving them from different numbers would leave a permanent mismatch.
    bounds = { width: window.innerWidth, height: window.innerHeight };
    renderer.setSize(bounds.width, bounds.height);
    coordinator.retarget(bounds);
    coordinator.setArena(new Arena(a.rects));
    console.log(`arena: ${a.box.width}x${a.box.height} box over `
      + `${a.rects.length} display(s), window ${bounds.width}x${bounds.height}`);
    checkCanvasFitsWindow();
  }

  // PULL the initial geometry, then listen for layout changes: a push at startup
  // races the renderer's subscription (the bug that hung M2b's circuit handoff).
  let currentArena = await window.desktopfly.getArena();
  applyArena(currentArena);
  window.desktopfly.onArena((a) => {
    currentArena = a;
    applyArena(a);
  });
  // The window resize can land after the arena message, so re-apply on resize.
  window.addEventListener('resize', () => applyArena(currentArena));

  let loggedTerrain = false;
  window.desktopfly.onSenses((s) => {
    coordinator.setSenses(s);
    if (!loggedTerrain && s.ledges !== undefined && s.ledges.length > 0) {
      loggedTerrain = true;
      console.log(`terrain: ${s.ledges.length} walkable window edges`);
    }
  });

  // A click in the brain window stimulates real neurons here.
  window.desktopfly.onStimulate((req) => {
    if (sim === null) return;
    sim.stimulate(req.indices, req.strength, req.durationMs);
  });

  window.desktopfly.onCommand((c) => {
    if (c === 'resetClock') {
      coordinator.resetClock();
      last = null;
      return;
    }
    if (c === 'escapeTest') coordinator.escapeTest();
    if (c === 'addFly') coordinator.addFly();
    if (c === 'removeFly') coordinator.removeFly();
    if (c === 'scareAll') coordinator.scareAll();
  });

  let last: number | null = null;
  let lastSpikeSend = 0;
  const spikeCarry: Array<{ neuron: number; isGF: boolean }> = [];
  function tick(nowMs: number): void {
    const now = nowMs / 1000;
    // The dt clamp lives in Coordinator.frame, which is unit-tested.
    const dt = last === null ? 0 : now - last;
    last = now;
    coordinator.frame(dt);

    // Forward spikes to the brain window at ~30 Hz, capped: the flash pool is
    // only 48 deep and the bus can emit thousands of events per second.
    if (spikeBus !== null) {
      const batch = spikeBus.popAll();
      spikeCarry.push(...batch);
      if (now - lastSpikeSend > 1 / 30) {
        lastSpikeSend = now;
        if (spikeCarry.length > 0) {
          window.desktopfly.sendSpikes(spikeCarry.slice(-24));
          spikeCarry.length = 0;
        }
      }
    }

    renderer.render(coordinator.scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

window.addEventListener('error', (e) => {
  console.error(`overlay error: ${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(`overlay rejection: ${String(e.reason)}`);
});

main().catch((e: unknown) => {
  console.error(`overlay failed to start: ${String(e)}`);
});
