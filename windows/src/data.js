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
  try {
    const points = JSON.parse(fs.readFileSync(path.join(dir, 'brain_points.json'), 'utf8'));
    const circuit = JSON.parse(fs.readFileSync(path.join(dir, 'circuit.json'), 'utf8'));
    return { points, circuit };
  } catch {
    return null;
  }
}
