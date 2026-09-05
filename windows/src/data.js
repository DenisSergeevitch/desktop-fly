// data.js — Node-only data loading (fs). Kept out of sim.js so the simulation
// module imports cleanly in the Electron renderer, which has no fs: there the
// main process reads the JSON and hands it over through the preload bridge.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function findDataDir() {
  const candidates = [
    path.join(HERE, '..', '..', 'data'),   // repo root, next to windows/
    path.join(HERE, '..', 'data'),         // data copied into windows/
    path.join(process.cwd(), 'data'),
    path.join(process.cwd(), '..', 'data'),
  ];
  return candidates.find((d) => fs.existsSync(path.join(d, 'circuit.json'))) || null;
}

export function loadBrainData(dir = findDataDir()) {
  if (!dir) return null;
  let points, circuit;
  try {
    points = JSON.parse(fs.readFileSync(path.join(dir, 'brain_points.json'), 'utf8'));
    circuit = JSON.parse(fs.readFileSync(path.join(dir, 'circuit.json'), 'utf8'));
  } catch (error) {
    console.warn(`Unable to load fly data from ${dir}: ${error.message}`);
    return null;
  }
  // Older bundles remain usable. A present but invalid nerve-cord dataset
  // is a load error, never a silent switch back to scripted locomotion.
  const locomotorPath = path.join(dir, 'locomotor_circuit.json');
  let locomotor = null;
  if (fs.existsSync(locomotorPath)) {
    try { locomotor = JSON.parse(fs.readFileSync(locomotorPath, 'utf8')); }
    catch (error) { throw new Error(`Invalid locomotor dataset ${locomotorPath}: ${error.message}`); }
  }
  return { points, circuit, locomotor };
}
