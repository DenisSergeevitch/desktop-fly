// renderer/brain.ts — the live brain: 23,210 real FlyWire soma positions as a
// rotating point cloud, the 668-neuron circuit highlighted on top, LIF spikes
// flashing at their true locations, and click-to-stimulate.
// Transliterated from BrainView.swift.
//
// The sim does NOT live here. It runs in the overlay renderer, so spikes arrive
// over IPC and stimulation requests go back the same way. Only visuals cross the
// process boundary; the LC->GF escape race never does.

import * as THREE from 'three';
import { roleColor, superClassColor } from '../core/brainColors.ts';
import { nearestToRay, pickCluster, regionName } from '../core/pick.ts';
import type { BrainPointsFile, CircuitFile } from '../core/data.ts';

interface SpikeEvent {
  neuron: number;
  isGF: boolean;
}

interface BrainBridge {
  getCircuit(): Promise<CircuitFile | null>;
  getPoints(): Promise<BrainPointsFile | null>;
  onSpikes(cb: (s: SpikeEvent[]) => void): void;
  stimulate(indices: number[], strength: number, durationMs: number): void;
}

declare global {
  interface Window {
    desktopflyBrain: BrainBridge;
  }
}

const FLASH_POOL = 48;

function srgb(c: readonly [number, number, number]): THREE.Color {
  return new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
}

// SceneKit sizes points in WORLD units and then clamps the result to a
// screen-space radius range (BrainView.swift:25-27: pointSize 0.05, radius
// 0.7-1.6 px for the cloud, 1.6-2.6 for the circuit). Neither of Three's
// PointsMaterial modes reproduces that:
//
//   sizeAttenuation: true  -> no floor, so sparse somas fall below a pixel and
//                             vanish; the cloud reads as scattered dust.
//   sizeAttenuation: false -> no attenuation, so the size is fixed in pixels
//                             regardless of viewport. In the real 340x280 window
//                             the same 23k points cover 4.4x fewer pixels than in
//                             a 720x560 render, additive blending saturates, and
//                             the optic lobes blow out to solid white — hiding
//                             every spike flash.
//
// So compute it properly: attenuate by depth, then clamp in device pixels.
const POINT_VERT = `
  uniform float uWorldSize;      // diameter in world units
  uniform float uPixelsPerUnit;  // (viewportHeightPx / 2) / tan(fov / 2)
  uniform float uMinPx;
  uniform float uMaxPx;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = clamp(uWorldSize * uPixelsPerUnit / -mv.z, uMinPx, uMaxPx);
    gl_Position = projectionMatrix * mv;
  }`;

// Round rather than square: a 3 px square reads as a chunky pixel, and somas are
// round. Also softens the edge so overlapping points blend instead of tiling.
const POINT_FRAG = `
  varying vec3 vColor;
  void main() {
    // Flat disc, NOT a soft falloff: at the 1.4 px floor a radial gradient throws
    // away most of each point's energy and the whole cloud goes dark.
    if (length(gl_PointCoord - vec2(0.5)) > 0.5) discard;
    gl_FragColor = vec4(vColor, 1.0);
  }`;

interface PointCloud {
  points: THREE.Points;
  material: THREE.ShaderMaterial;
}

function pointCloud(positions: Float32Array, colors: Float32Array,
                    minPx: number, maxPx: number): PointCloud {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uWorldSize: { value: 0.05 },     // SceneKit's elem.pointSize
      uPixelsPerUnit: { value: 100 },  // set per frame from the viewport
      uMinPx: { value: minPx },
      uMaxPx: { value: maxPx },
    },
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    vertexColors: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    transparent: true,
  });
  return { points: new THREE.Points(geo, material), material };
}

function emissiveSphere(radius: number, color: THREE.Color,
                       opacity: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 12, 8),
    new THREE.MeshBasicMaterial({
      color,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
      opacity,
    }));
}

async function main(): Promise<void> {
  const canvas = document.getElementById('b') as HTMLCanvasElement;
  const label = document.getElementById('label') as HTMLDivElement;

  const [circuit, points] = await Promise.all([
    window.desktopflyBrain.getCircuit(),
    window.desktopflyBrain.getPoints(),
  ]);
  if (circuit === null || points === null) {
    label.textContent = 'no data/ — run etl.py first';
    label.style.opacity = '1';
    return;
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = srgb([0.03, 0.035, 0.06]);   // near-black, so additive glows

  // `?shot=1` freezes the cloud at the same angle main.swift:115-116 uses for
  // --brainshot, so the render is comparable with assets/brain.png.
  const isShot = new URLSearchParams(location.search).get('shot') === '1';
  const group = new THREE.Group();
  group.rotation.x = -0.15;
  if (isShot) group.rotation.y = 0.5;
  scene.add(group);

  // --- the whole brain: 23,210 real somas ------------------------------------
  const cloudPos = new Float32Array(points.points.length * 3);
  const cloudCol = new Float32Array(points.points.length * 3);
  let kept = 0;
  for (const p of points.points) {
    if (p.length < 4) continue;
    cloudPos[3 * kept] = p[0];
    cloudPos[3 * kept + 1] = p[1];
    cloudPos[3 * kept + 2] = p[2];
    const c = srgb(superClassColor(p[3]));
    cloudCol[3 * kept] = c.r;
    cloudCol[3 * kept + 1] = c.g;
    cloudCol[3 * kept + 2] = c.b;
    kept++;
  }
  // radius 0.7-1.6 px -> diameter 1.4-3.2 device px
  const cloud = pointCloud(cloudPos.subarray(0, kept * 3),
    cloudCol.subarray(0, kept * 3), 2.0, 3.4);
  group.add(cloud.points);

  // --- the circuit, brighter and larger on top -------------------------------
  const n = circuit.neurons.length;
  const simPos = new Float32Array(n * 3);
  const simCol = new Float32Array(n * 3);
  const roles: string[] = [];
  const types: string[] = [];
  for (let i = 0; i < n; i++) {
    const nr = circuit.neurons[i];
    simPos[3 * i] = nr.pos[0];
    simPos[3 * i + 1] = nr.pos[1];
    simPos[3 * i + 2] = nr.pos[2];
    roles.push(nr.role);
    types.push(nr.type);
    const c = srgb(roleColor(nr.role));
    simCol[3 * i] = c.r;
    simCol[3 * i + 1] = c.g;
    simCol[3 * i + 2] = c.b;
  }
  // radius 1.6-2.6 px -> diameter 3.2-5.2 device px
  const circuitCloud = pointCloud(simPos, simCol, 3.2, 5.2);
  group.add(circuitCloud.points);

  // --- the two giant fibers get real glowing markers -------------------------
  for (let i = 0; i < n; i++) {
    if (roles[i] !== 'gf') continue;
    const marker = emissiveSphere(0.28, srgb([1.0, 0.85, 0.25]), 0.35);
    marker.position.set(simPos[3 * i], simPos[3 * i + 1], simPos[3 * i + 2]);
    group.add(marker);
  }

  // --- spike flash pool, reused round-robin ---------------------------------
  const flashes: THREE.Mesh[] = [];
  const flashUntil = new Float32Array(FLASH_POOL);
  const flashFor = new Float32Array(FLASH_POOL);
  for (let i = 0; i < FLASH_POOL; i++) {
    const f = emissiveSphere(0.16, srgb([0.75, 0.95, 1.0]), 0.8);
    f.visible = false;
    group.add(f);
    flashes.push(f);
  }
  let nextFlash = 0;
  let now = 0;

  function flash(neuron: number, isGF: boolean): void {
    if (neuron < 0 || neuron >= n) return;
    const f = flashes[nextFlash];
    const slot = nextFlash;
    nextFlash = (nextFlash + 1) % FLASH_POOL;
    f.position.set(simPos[3 * neuron], simPos[3 * neuron + 1], simPos[3 * neuron + 2]);
    const s = isGF ? 3.2 : 1;
    f.scale.set(s, s, s);
    f.visible = true;
    // GF flashes are bigger and linger: the escape command should be unmissable
    flashFor[slot] = isGF ? 0.6 : 0.28;
    flashUntil[slot] = now + flashFor[slot];
    (f.material as THREE.Material).opacity = isGF ? 1.0 : 0.8;
  }

  let loggedSpikes = false;
  window.desktopflyBrain.onSpikes((batch) => {
    if (!loggedSpikes && batch.length > 0) {
      loggedSpikes = true;
      console.log(`spikes flowing: first batch of ${batch.length} from the sim`);
    }
    for (const e of batch) flash(e.neuron, e.isGF);
  });

  // --- the stimulation ring -------------------------------------------------
  const ring = emissiveSphere(2.2, srgb([1.0, 0.9, 0.5]), 0.18);
  ring.visible = false;
  group.add(ring);
  let ringUntil = 0;

  const camera = new THREE.PerspectiveCamera(46,
    window.innerWidth / window.innerHeight, 1, 120);
  camera.position.set(0, 0.6, 29);

  // --- interaction ----------------------------------------------------------
  let paused = false;   // hovering holds the rotation so a target can be aimed at
  canvas.addEventListener('pointerenter', () => { paused = true; });
  canvas.addEventListener('pointerleave', () => { paused = false; });

  let labelUntil = 0;
  canvas.addEventListener('pointerdown', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);

    // The click ray is in world space; the cloud rotates, so convert into the
    // group's local space before comparing against neuron positions.
    group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const origin = ray.ray.origin.clone().applyMatrix4(inv);
    const target = ray.ray.origin.clone().add(ray.ray.direction)
      .applyMatrix4(inv);
    const dir = target.sub(origin);

    const anchor = nearestToRay(simPos, n, origin, dir);
    if (anchor < 0) return;
    const picked = pickCluster(simPos, n, anchor);
    if (picked.length === 0) return;

    window.desktopflyBrain.stimulate(picked, 0.25, 400);
    for (const i of picked.slice(0, 16)) flash(i, false);

    ring.position.set(simPos[3 * anchor], simPos[3 * anchor + 1],
      simPos[3 * anchor + 2]);
    ring.visible = true;
    ringUntil = now + 0.55;

    label.textContent = regionName(roles, types, simPos, picked);
    label.style.opacity = '1';
    labelUntil = now + 2.2;
  });

  function updatePointScale(): void {
    // device pixels per world unit at unit depth, for a perspective camera
    const heightPx = renderer.domElement.height;
    const ppu = (heightPx / 2) / Math.tan((camera.fov * Math.PI / 180) / 2);
    cloud.material.uniforms.uPixelsPerUnit.value = ppu;
    circuitCloud.material.uniforms.uPixelsPerUnit.value = ppu;
  }

  window.addEventListener('resize', () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    updatePointScale();
  });

  updatePointScale();
  console.log(`brain ready: ${kept} somas, ${n} circuit neurons, `
    + `${renderer.domElement.width}x${renderer.domElement.height} device px`);

  let last: number | null = null;
  function tick(ms: number): void {
    const t = ms / 1000;
    const dt = last === null ? 0 : Math.min(0.1, t - last);
    last = t;
    now = t;

    if (!paused && !isShot) group.rotation.y += (0.35 / 6) * dt;   // 0.35 rad / 6 s

    for (let i = 0; i < FLASH_POOL; i++) {
      if (!flashes[i].visible) continue;
      const left = flashUntil[i] - now;
      if (left <= 0) {
        flashes[i].visible = false;
      } else {
        const mat = flashes[i].material as THREE.Material;
        mat.opacity = Math.max(0, left / flashFor[i]) * 0.9;
      }
    }
    if (ring.visible) {
      const left = ringUntil - now;
      if (left <= 0) {
        ring.visible = false;
      } else {
        const k = 1 - left / 0.55;
        const s = 0.5 + 0.9 * k;
        ring.scale.set(s, s, s);
        (ring.material as THREE.Material).opacity = 0.18 * (1 - k);
      }
    }
    if (labelUntil > 0 && now > labelUntil) {
      label.style.opacity = '0';
      labelUntil = 0;
    }

    renderer.render(scene, camera);
    if (!isShot) requestAnimationFrame(tick);
  }

  if (isShot) {
    // A hidden window's requestAnimationFrame HALTS after about half a second,
    // so an offscreen capture would show a stale frame — anything injected after
    // that point (spike flashes, above all) would never be drawn. Timers keep
    // running, so shot mode is driven by one.
    setInterval(() => tick(performance.now()), 33);
  } else {
    requestAnimationFrame(tick);
  }
}

window.addEventListener('error', (e) => {
  console.error(`brain error: ${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error(`brain rejection: ${String(e.reason)}`);
});

main().catch((e: unknown) => {
  console.error(`brain failed to start: ${String(e)}`);
});
