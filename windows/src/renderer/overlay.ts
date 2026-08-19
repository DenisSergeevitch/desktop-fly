// renderer/overlay.ts — the only place a WebGLRenderer exists.
//
// This process is the SceneKit render thread's counterpart: it steps the sim and
// updates the flies inside requestAnimationFrame, exactly as
// Coordinator.renderer(_:updateAtTime:) does on macOS. All the logic lives in
// body/coordinator.ts, which is why that file is testable headless.

import * as THREE from 'three';
import { Coordinator } from '../body/coordinator.ts';
import { LIFSim } from '../core/sim.ts';
import type { CircuitFile } from '../core/data.ts';

interface DesktopFlyBridge {
  getCircuit(): Promise<CircuitFile | null>;
  onSenses(cb: (s: { cursor?: { x: number; y: number } | null }) => void): void;
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
  renderer.setSize(bounds.width, bounds.height, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoft is deprecated

  // main reads data/ and sends it here: this process has no filesystem access,
  // and file:// blocks fetch()
  const circuit = await window.desktopfly.getCircuit();
  const sim = circuit === null ? null : new LIFSim(circuit, null);
  if (sim === null) console.warn('no data/ — running the legacy behavior path');

  const coordinator = new Coordinator({ bounds, sim });
  console.log(`overlay ready: ${bounds.width}x${bounds.height}, `
    + `sim=${sim === null ? 'none' : `${sim.n} neurons`}`);
  const camera = coordinator.scene.getObjectByName('camera') as THREE.Camera;

  window.desktopfly.onSenses((s) => {
    if (s.cursor !== undefined) coordinator.setSenses({ cursor: s.cursor });
  });

  window.desktopfly.onCommand((c) => {
    if (c === 'resetClock') {
      coordinator.resetClock();
      last = null;
      return;
    }
    if (c.startsWith('bounds:')) {
      const [w, h] = c.slice('bounds:'.length).split('x').map(Number);
      bounds = { width: w, height: h };
      renderer.setSize(w, h, false);
      coordinator.retarget(bounds);
      return;
    }
    if (c === 'escapeTest') coordinator.escapeTest();
    if (c === 'addFly') coordinator.addFly();
    if (c === 'removeFly') coordinator.removeFly();
    if (c === 'scareAll') coordinator.scareAll();
  });

  let last: number | null = null;
  function tick(nowMs: number): void {
    const now = nowMs / 1000;
    // The dt clamp lives in Coordinator.frame, which is unit-tested.
    const dt = last === null ? 0 : now - last;
    last = now;
    coordinator.frame(dt);
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
