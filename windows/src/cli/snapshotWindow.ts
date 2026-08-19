// Renders one posed fly for --snapshot, matching runSnapshot (main.swift:80-109):
// perspective camera at (30, -58, 42) looking at the fly, fov 42, key + ambient
// light, legs posed from the fixed angle/lift table.
import * as THREE from 'three';
import { buildFlyModel } from '../body/flyModel.ts';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(720, 720, false);

const scene = new THREE.Scene();
scene.background = new THREE.Color().setRGB(0.94, 0.94, 0.94, THREE.SRGBColorSpace);

const model = buildFlyModel();
// heading pi/2 in the app maps to yaw (heading - pi/2) = 0 here
model.root.rotation.set(0, 0, 0);
const angles = [0.25, -0.2, -0.22, 0.28, 0.2, -0.25];
const lifts = [0.35, 0, 0, 0.3, 0, 0.35];
model.legs.forEach((leg, i) => {
  leg.angle = angles[i];
  leg.lift = lifts[i];
  leg.apply();
});
scene.add(model.root);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 1000);
camera.position.set(30, -58, 42);
camera.up.set(0, 0, 1);              // scene z is up
camera.lookAt(0, 0, 0);              // ~ SCNLookAtConstraint on the fly node
scene.add(camera);

const key = new THREE.DirectionalLight(0xffffff, 1.1);   // SceneKit 1100
key.position.set(40, -60, 80);
scene.add(key);
scene.add(new THREE.AmbientLight(0xffffff, 0.5));        // SceneKit 500

renderer.render(scene, camera);
document.title = 'ready';
