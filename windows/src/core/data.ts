import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BrainPointsFile {
  classes: string[];
  points: number[][];      // [x, y, z, classIndex]
}

export interface CircuitNeuron {
  id: string;
  type: string;            // FlyWire primary_type, or super_class for partners
  role: string;            // lc4 | lplc2 | gf | dna01 | dna02 | dnp09 |
                           // dng11 | mdn | escw | other
  side: string;            // left | right | center
  pos: number[];           // normalized [x, y, z]
}

export interface CircuitFile {
  neurons: CircuitNeuron[];
  edges: number[][];       // [preIdx, postIdx, signedSynCount]
}

// Equivalent of Sim.swift:38-47. The Windows build reads the repo's shared
// data/ in place — it is CC BY-NC 4.0 and is never copied into windows/.
export function findDataDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'data'),                        // packaged: resources/data
    resolve(here, '..', '..', 'data'),         // windows/data
    resolve(here, '..', '..', '..', 'data'),   // repo root data/
    join(process.cwd(), 'data'),
    resolve(process.cwd(), '..', 'data'),
  ];
  return candidates.find((d) => existsSync(join(d, 'circuit.json'))) ?? null;
}

export function loadBrainData():
  { points: BrainPointsFile; circuit: CircuitFile } | null {
  const dir = findDataDir();
  if (dir === null) return null;
  try {
    const points = JSON.parse(
      readFileSync(join(dir, 'brain_points.json'), 'utf8')) as BrainPointsFile;
    const circuit = JSON.parse(
      readFileSync(join(dir, 'circuit.json'), 'utf8')) as CircuitFile;
    return { points, circuit };
  } catch {
    return null;
  }
}
